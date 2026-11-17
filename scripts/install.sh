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
if ! apt-get install -y -qq asterisk >/dev/null 2>&1; then
  echo
  warn "apt could not install 'asterisk'. Diagnostics:"
  apt-cache policy asterisk || true
  echo
  die "Asterisk unavailable from the configured repositories.
     Paste the output above to Claude. Most likely fixes:
       Ubuntu : add-apt-repository universe && apt update
       Debian : check /etc/apt/sources.list has the 'main' component
     If this image has no Asterisk package at all, we switch to the
     official Sangoma repo or a source build — tell Claude."
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
sleep 2
if asterisk -rx "module show like res_ari" 2>/dev/null | grep -qi 'res_ari'; then
  echo "    ARI modules present."
else
  warn "Could not confirm res_ari modules. If the proof fails to connect to ARI,"
  warn "run: asterisk -rx \"module show like res_ari\"  and send Claude the output."
fi

say "Backing up stock Asterisk config"
BK="/etc/asterisk/backup-$(date +%F-%H%M%S)"; mkdir -p "$BK"
for f in pjsip.conf extensions.conf ari.conf http.conf rtp.conf; do
  [ -f "/etc/asterisk/$f" ] && cp "/etc/asterisk/$f" "$BK/" || true
done
echo "    saved to $BK"

say "Writing config from .env"
VARS='${TRUNK_HOST} ${TRUNK_USER} ${TRUNK_PASS} ${PBX_HOST} ${PBX_PORT} ${ARI_PASS}'
for f in pjsip.conf ari.conf http.conf extensions.conf rtp.conf; do
  envsubst "$VARS" < "asterisk/$f" > "/etc/asterisk/$f"
done
chown asterisk:asterisk /etc/asterisk/*.conf 2>/dev/null || true
chmod 640 /etc/asterisk/pjsip.conf /etc/asterisk/ari.conf 2>/dev/null || true

say "Creating sounds directory"
install -d -o asterisk -g asterisk /var/lib/asterisk/sounds/campaign 2>/dev/null || mkdir -p /var/lib/asterisk/sounds/campaign

say "Installing Node dependencies"
npm install --omit=dev --no-audit --no-fund --silent

say "Restarting Asterisk"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk
sleep 3

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

  Watch live:  asterisk -rvvv
────────────────────────────────────────────────────────────
EOF
