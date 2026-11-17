#!/usr/bin/env bash
#
# ShadowPBX Campaign Module — installer (Debian 12 / Ubuntu 22.04+)
#
# Installs Asterisk + Node, writes the PJSIP/ARI config from your .env,
# and leaves you ready to run the press-1 proof.
#
#   cp .env.example .env && nano .env      # fill in trunk + PBX details
#   sudo bash scripts/install.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash scripts/install.sh)"
[ -f .env ] || die ".env not found — copy .env.example to .env and fill it in first"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

for v in TRUNK_HOST TRUNK_USER TRUNK_PASS PBX_HOST ARI_PASS; do
  [ -n "${!v:-}" ] && [ "${!v}" != "CHANGE_ME_long_random" ] || die "$v is not set in .env"
done

say "Installing Asterisk, Node.js and tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq asterisk asterisk-modules curl ca-certificates sox git >/dev/null
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
say "asterisk $(asterisk -V 2>/dev/null || echo '?') / node $(node -v)"

say "Backing up stock Asterisk config to /etc/asterisk/backup-$(date +%F)"
BK="/etc/asterisk/backup-$(date +%F-%H%M%S)"; mkdir -p "$BK"
for f in pjsip.conf extensions.conf ari.conf http.conf rtp.conf; do
  [ -f "/etc/asterisk/$f" ] && cp "/etc/asterisk/$f" "$BK/" || true
done

say "Writing config (substituting values from .env)"
# envsubst only the variables we define, so Asterisk's own ${...} survive.
VARS='${TRUNK_HOST} ${TRUNK_USER} ${TRUNK_PASS} ${PBX_HOST} ${PBX_PORT} ${ARI_PASS}'
for f in pjsip.conf ari.conf http.conf extensions.conf rtp.conf; do
  envsubst "$VARS" < "asterisk/$f" > "/etc/asterisk/$f"
done
chown asterisk:asterisk /etc/asterisk/*.conf
chmod 640 /etc/asterisk/pjsip.conf /etc/asterisk/ari.conf

say "Creating sounds directory"
install -d -o asterisk -g asterisk /var/lib/asterisk/sounds/campaign
cat <<'NOTE'
  Put your greeting at: /var/lib/asterisk/sounds/campaign/greeting.wav
  It MUST be 8kHz mono 16-bit PCM. Convert an existing file with:
      sox input.wav -r 8000 -c 1 -b 16 /var/lib/asterisk/sounds/campaign/greeting.wav
NOTE

say "Installing Node dependencies"
npm install --omit=dev --no-audit --no-fund --silent

say "Restarting Asterisk"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk
sleep 3

say "Checking trunk registration"
asterisk -rx "pjsip show registrations" 2>/dev/null || true
echo
asterisk -rx "pjsip show endpoints" 2>/dev/null | head -20 || true

cat <<EOF

────────────────────────────────────────────────────────────
Install finished.

Next:
  1. Confirm the trunk shows "Registered" above.
     If not:  asterisk -rx "pjsip show registrations"
  2. Drop your greeting at /var/lib/asterisk/sounds/campaign/greeting.wav (8kHz mono)
  3. Open the firewall to the trunk and to ShadowPBX only:
       ufw allow from ${TRUNK_HOST} to any port 5060 proto udp
       ufw allow from ${PBX_HOST} to any port 5060 proto udp
       ufw allow 10000:20000/udp
  4. Run the proof against your own mobile:
       node src/press1-test.js 49XXXXXXXXXX

  Watch what Asterisk is doing in another window:
       asterisk -rvvv
────────────────────────────────────────────────────────────
EOF
