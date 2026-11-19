#!/usr/bin/env bash
#
# ShadowPBX Campaign Module — installer (Debian 12 / Ubuntu 22.04+)
#
#   cp .env.example .env && nano .env      # bootstrap values only
#   sudo bash scripts/install.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash scripts/install.sh)"
[ -f .env ] || die ".env not found — copy .env.example to .env and fill it in first"

# ast_module_dir / ari_modules_ok / pjsip_modules_ok / fix_shadowed_pjproject ...
# shellcheck source=scripts/lib-asterisk.sh
. "$HERE/scripts/lib-asterisk.sh"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

for v in ARI_PASS; do
  [ -n "${!v:-}" ] && [ "${!v}" != "CHANGE_ME_long_random" ] || die "$v is not set in .env"
done

# ---------------------------------------------------------------
# Work out the distro. Asterisk lives in different repo components
# depending on it, which is what "no installation candidate" means:
# the package name is known but no enabled repo offers a version.
# ---------------------------------------------------------------
. /etc/os-release
say "Detected: ${PRETTY_NAME:-unknown} (${ID:-?} ${VERSION_ID:-?}, $(uname -m))"

export DEBIAN_FRONTEND=noninteractive

case "${ID:-}" in
  ubuntu)
    say "Enabling the 'universe' component (Asterisk lives there on Ubuntu)"
    apt-get update -qq || true
    apt-get install -y -qq software-properties-common >/dev/null 2>&1 || true
    add-apt-repository -y universe >/dev/null 2>&1 || warn "add-apt-repository failed; continuing"
    ;;
  debian)
    say "Debian detected — Asterisk is in main, no extra component needed"
    ;;
  *)
    warn "Unrecognised distro '${ID:-?}'. Trying anyway; if Asterisk won't install,"
    warn "tell Claude the output of: cat /etc/os-release"
    ;;
esac

say "Updating package lists"
apt-get update -qq

# ---------------------------------------------------------------
# Install Asterisk. asterisk-modules exists on Debian but NOT on
# Ubuntu, so it is optional — never let it fail the whole install.
# ---------------------------------------------------------------
say "Installing Asterisk"
# Already present and runnable? Nothing to do. Re-running the installer
# to rewrite config should not redo the repo/package dance.
if command -v asterisk >/dev/null 2>&1 && asterisk -V >/dev/null 2>&1; then
  echo "    Already installed: $(asterisk -V)"
elif ! apt-get install -y -qq asterisk >/dev/null 2>&1; then
  echo
  warn "apt could not install 'asterisk'. Diagnostics:"
  apt-cache policy asterisk || true
  echo
  warn "No asterisk package available from apt."
  warn "Asterisk has been REMOVED from Debian's repositories (and is being"
  warn "removed from Ubuntu), so on Debian 13+ there is nothing to install."
  say "Trying Sangoma's official Asterisk repository first"
  if bash "$HERE/scripts/install-asterisk-sangoma.sh"; then
    say "Asterisk installed from Sangoma packages"
  else
    warn "Sangoma repo unusable — building from source instead (several minutes)"
    bash "$HERE/scripts/install-asterisk-source.sh" \
      || die "source build failed — send Claude the output above"
  fi
fi

# Optional extras: present on Debian, absent on Ubuntu. Ignore failures.
apt-get install -y -qq asterisk-modules >/dev/null 2>&1 || warn "asterisk-modules not available here (normal on Ubuntu) — skipping"

say "Installing supporting tools"
apt-get install -y -qq curl ca-certificates gettext-base sox git >/dev/null

if ! command -v node >/dev/null 2>&1; then
  say "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi

say "Versions: asterisk $(asterisk -V 2>/dev/null | awk '{print $2}' || echo '?') / node $(node -v)"

# ---------------------------------------------------------------
# ARI modules must exist or nothing else works. Check early.
# ---------------------------------------------------------------
say "Verifying ARI support is present"
systemctl start asterisk >/dev/null 2>&1 || true
# Asterisk needs a moment after start before the CLI answers.
for _ in $(seq 1 15); do ari_modules_ok && break; sleep 1; done

if ari_modules_ok; then
  echo "    res_ari.so and res_stasis.so are loaded."
else
  # Packaged Asterisk builds ship without ARI more often than not, and there is
  # no package to add afterwards -- the fix is a build that includes it. Do that
  # here rather than ending the install with homework.
  ari_missing_report
  say "No ARI in this Asterisk — rebuilding from source with it enabled"
  warn "this takes 10-40 minutes; everything after it depends on ARI"
  bash "$HERE/scripts/install-asterisk-source.sh" \
    || die "source build failed — the build log is /var/log/shadowpbx-asterisk-build.log"
  systemctl restart asterisk >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do ari_modules_ok && break; sleep 1; done
  if ! ari_modules_ok; then
    ari_missing_report
    die "still no ARI after a source build — send Claude the output above."
  fi
  echo "    ARI present after rebuild."
fi

# PJSIP is how every call leaves this box. It breaks in one specific way after a
# source build over a packaged one, so check it here and repair it in place.
say "Verifying PJSIP is loaded"
if pjsip_modules_ok; then
  echo "    chan_pjsip.so is loaded."
else
  fix_shadowed_pjproject
  systemctl restart asterisk >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pjsip_modules_ok && break; sleep 1; done
  if pjsip_modules_ok; then
    echo "    chan_pjsip.so loaded after clearing a shadowed pjproject library."
  else
    pjsip_missing_report
    die "PJSIP will not load — no trunk can work until it does."
  fi
fi

say "Backing up stock Asterisk config"
BK="/etc/asterisk/backup-$(date +%F-%H%M%S)"; mkdir -p "$BK"
for f in pjsip.conf extensions.conf ari.conf http.conf rtp.conf amd.conf; do
  [ -f "/etc/asterisk/$f" ] && cp "/etc/asterisk/$f" "$BK/" || true
done
echo "    saved to $BK"

say "Writing config from .env"
VARS='${TRUNK_HOST} ${TRUNK_USER} ${TRUNK_PASS} ${PBX_HOST} ${PBX_PORT} ${ARI_PASS}'
for f in pjsip.conf ari.conf http.conf extensions.conf rtp.conf amd.conf; do
  envsubst "$VARS" < "asterisk/$f" > "/etc/asterisk/$f"
done
chown asterisk:asterisk /etc/asterisk/*.conf 2>/dev/null || true
chmod 640 /etc/asterisk/pjsip.conf /etc/asterisk/ari.conf 2>/dev/null || true

say "Creating sounds directory"
install -d -o asterisk -g asterisk /var/lib/asterisk/sounds/campaign 2>/dev/null || mkdir -p /var/lib/asterisk/sounds/campaign
# Built-in test tone (already 8kHz mono 16-bit). The app also restores it on start.
install -m 644 -o asterisk -g asterisk test/test.wav /var/lib/asterisk/sounds/campaign/test.wav 2>/dev/null \
  || install -m 644 test/test.wav /var/lib/asterisk/sounds/campaign/test.wav

say "Installing Node dependencies"
npm install --omit=dev --no-audit --no-fund --silent

say "Restarting Asterisk"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk
sleep 3

say "Checking ARI answers over HTTP"
# The modules can be loaded and ARI still unreachable: http.conf disabled, a
# different port, or ARI_PASS not matching ari.conf. One request settles it.
ARI_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -u "${ARI_USER:-campaign}:${ARI_PASS}" \
  "http://127.0.0.1:${ARI_PORT:-8088}/ari/api-docs/resources.json" || echo 000)
case "$ARI_CODE" in
  200) echo "    ARI responded 200 — the app can drive calls." ;;
  401) die "ARI rejected the login \"${ARI_USER:-campaign}\". ARI_PASS in .env must match the
     password for that user in /etc/asterisk/ari.conf (asterisk -rx \"ari show users\")." ;;
  404) die "ARI is not enabled: /etc/asterisk/ari.conf needs enabled = yes (then: asterisk -rx \"module reload res_ari.so\")." ;;
  000) die "Nothing answered on 127.0.0.1:${ARI_PORT:-8088}. Asterisk's HTTP server is off:
     check /etc/asterisk/http.conf, then: asterisk -rx \"http show status\"" ;;
  *)   warn "ARI answered HTTP $ARI_CODE — the test call will report the detail." ;;
esac

say "Trunk registration"
asterisk -rx "pjsip show registrations" 2>/dev/null || warn "could not query Asterisk"
echo
say "Endpoints"
asterisk -rx "pjsip show endpoints" 2>/dev/null | head -20 || true

cat <<EOF

────────────────────────────────────────────────────────────
Install finished.

  1. Trunk should show "Registered" above.
  2. Greeting -> /var/lib/asterisk/sounds/campaign/greeting.wav (8kHz mono):
       sox in.wav -r 8000 -c 1 -b 16 /var/lib/asterisk/sounds/campaign/greeting.wav
  3. Firewall (trunk + PBX only, not the world):
       ufw allow from <TRUNK_IP> to any port 5060 proto udp
       ufw allow from ${PBX_HOST:-<PBX_IP>} to any port 5060 proto udp
       ufw allow 10000:20000/udp
  4. Prove press-1 against your own mobile:
       node src/press1-test.js 49XXXXXXXXXX
     or from the Asterisk CLI, without the app (press 1 when it plays):
       asterisk -rx "channel originate PJSIP/+49XXXXXXXXXX@trunk-<id> extension s@dtmf-test"

  Watch live:  asterisk -rvvv
────────────────────────────────────────────────────────────
EOF
