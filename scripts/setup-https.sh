#!/usr/bin/env bash
#
# Put the Campaign UI behind nginx with a Let's Encrypt certificate.
#
#   ./scripts/setup-https.sh                     # asks for the domain
#   ./scripts/setup-https.sh campaign.example.com you@example.com
#
# Safe to run again: every step checks what is already in place and only does
# what is missing. Run it again to add a renewal hook, fix a half-finished
# setup, or after moving the domain.
#
# Order matters, and the order is the safety net:
#   1. the domain must already point at this server (checked, not assumed)
#   2. nginx proxies the domain to the app, still on plain HTTP
#   3. certbot gets a certificate and switches nginx to HTTPS
#   4. only once https://domain answers does the app move to 127.0.0.1
# If any step fails, the app keeps listening where it was, so you never lose
# the way in.
#
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
ENV_FILE="$REPO/.env"
SERVICE="shadowpbx-campaign"
SITE="/etc/nginx/sites-available/shadowpbx-campaign"
SITE_LINK="/etc/nginx/sites-enabled/shadowpbx-campaign"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root (sudo $0)."
command -v apt-get >/dev/null || die "This script expects a Debian or Ubuntu server (apt-get)."
[ -f "$ENV_FILE" ] || die "No .env in $REPO — run the installer first."

# ---------------------------------------------------------------- inputs
DOMAIN="${1:-}"
EMAIL="${2:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Domain pointed at this server (e.g. campaign.example.com): " DOMAIN
fi
DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's#^https\?://##; s#/.*$##; s/[[:space:]]//g')"
# The domain goes into an nginx config and a certbot command line: only a
# plain hostname gets through.
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] \
  || die "\"$DOMAIN\" is not a valid domain name."

if [ -z "$EMAIL" ]; then
  read -rp "Email for certificate expiry notices (Enter to skip): " EMAIL || true
fi
EMAIL="$(printf '%s' "$EMAIL" | tr -d '[:space:]')"
if [ -n "$EMAIL" ] && ! [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  die "\"$EMAIL\" does not look like an email address."
fi

# Read a value from .env without sourcing it.
env_get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' || true; }
# Set or replace one key in .env, leaving everything else as it was.
env_set() {
  local key="$1" val="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    sed -i "s#^$key=.*#$key=$val#" "$ENV_FILE"
  elif grep -qE "^#[[:space:]]*$key=" "$ENV_FILE"; then
    sed -i "0,/^#[[:space:]]*$key=.*/s##$key=$val#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

PORT="$(env_get PORT)"; PORT="${PORT:-3000}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT in .env is not a number: $PORT"

# ---------------------------------------------------------------- 1. DNS
say "Checking that $DOMAIN points at this server"
command -v curl >/dev/null || { apt-get update -qq; apt-get install -y -qq curl >/dev/null; }
command -v dig  >/dev/null || apt-get install -y -qq dnsutils >/dev/null 2>&1 || true

PUBLIC_IP="$(curl -4 -fsS -m 8 https://api.ipify.org 2>/dev/null \
          || curl -4 -fsS -m 8 https://ifconfig.me 2>/dev/null || true)"
if command -v dig >/dev/null; then
  RESOLVED="$(dig +short A "$DOMAIN" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' || true)"
else
  RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
fi

TARGET_IP="${PUBLIC_IP:-the IP of this server}"
[ -n "$RESOLVED" ] || die "$DOMAIN does not resolve yet. Add an A record pointing to $TARGET_IP, wait a few minutes, and run this again."
if [ -n "$PUBLIC_IP" ] && ! printf '%s\n' "$RESOLVED" | grep -qx "$PUBLIC_IP"; then
  echo "    $DOMAIN resolves to: $(echo "$RESOLVED" | tr '\n' ' ')"
  echo "    this server is     : $PUBLIC_IP"
  # A Cloudflare-proxied record resolves to Cloudflare, not here, and the
  # HTTP challenge still works through it -- so warn rather than refuse.
  warn "They differ. If the record is proxied through Cloudflare that is expected;"
  warn "otherwise Let's Encrypt will fail. Fix the A record first if it is wrong."
  read -rp "    Continue anyway? [y/N] " a; [[ "$a" =~ ^[Yy]$ ]] || die "Stopped — fix DNS and run again."
else
  ok "$DOMAIN -> ${PUBLIC_IP:-$RESOLVED}"
fi

# ---------------------------------------------------------------- 2. packages
say "Checking nginx and certbot"
NEED=()
command -v nginx   >/dev/null || NEED+=(nginx)
command -v certbot >/dev/null || NEED+=(certbot)
dpkg -s python3-certbot-nginx >/dev/null 2>&1 || NEED+=(python3-certbot-nginx)
if [ ${#NEED[@]} -gt 0 ]; then
  echo "    installing: ${NEED[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED[@]}" >/dev/null
fi
ok "nginx $(nginx -v 2>&1 | sed 's#.*/##')"
ok "certbot $(certbot --version 2>&1 | awk '{print $2}')"

# Port 80 is needed for the certificate challenge. Something other than nginx
# holding it (Apache, another app) would make certbot fail with an unhelpful
# error, so name the culprit now.
HOLDER="$(ss -ltnpH 'sport = :80' 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | sed 's/.*"//' || true)"
if [ -n "$HOLDER" ] && [ "$HOLDER" != "nginx" ]; then
  die "Port 80 is in use by \"$HOLDER\". Stop it (or move it off port 80) and run this again."
fi
systemctl enable --now nginx >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 3. firewall
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in ufw"
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ok "80 and 443 allowed (SIP and RTP rules untouched)"
fi

# ---------------------------------------------------------------- 4. nginx site
say "Writing the nginx site for $DOMAIN"
# Listen on IPv6 only where the kernel has it. Some VPS images boot with IPv6
# disabled outright, and there `listen [::]:80` makes nginx refuse to start.
if [ -f /proc/net/if_inet6 ]; then LISTEN6="listen [::]:80;"; else LISTEN6="# no IPv6 on this host"; fi
# Keep certbot's HTTPS block if a previous run already added one: rewriting
# this file from scratch would throw the certificate config away.
if [ -f "$SITE" ] && grep -q "ssl_certificate" "$SITE" && grep -q "server_name $DOMAIN;" "$SITE"; then
  ok "existing HTTPS site for $DOMAIN kept"
else
  cat > "$SITE" <<NGINX
# Generated by scripts/setup-https.sh — the Campaign UI behind TLS.
# certbot edits this file to add the HTTPS server block.

# WebSocket upgrades pass through when asked for; ordinary requests keep-alive.
map \$http_upgrade \$spc_connection {
    default upgrade;
    ''      '';
}

server {
    listen 80;
    $LISTEN6
    server_name $DOMAIN;

    # Lead CSVs and audio uploads can be large.
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        \$spc_connection;
        # CSV exports of big lists stream for a while; do not cut them off.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX
  ok "wrote $SITE"
fi
ln -sf "$SITE" "$SITE_LINK"
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx rejected the config — nothing reloaded."; }
systemctl reload nginx
ok "nginx reloaded"

# Plain-HTTP sanity check before asking Let's Encrypt: it uses the same path.
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1/login || true)"
[ "$code" = "200" ] || [ "$code" = "302" ] || [ "$code" = "301" ] \
  || die "nginx is up but the app did not answer through it (HTTP $code). Is $SERVICE running on port $PORT?"
ok "app answers through nginx"

# ---------------------------------------------------------------- 5. certificate
say "Getting a Let's Encrypt certificate"
if certbot certificates 2>/dev/null | grep -qE "Domains:.*\b$DOMAIN\b"; then
  ok "a certificate for $DOMAIN already exists — making sure nginx uses it"
  certbot install --nginx -d "$DOMAIN" --cert-name "$DOMAIN" --redirect \
    --non-interactive >/dev/null 2>&1 || true
else
  CB=(certbot --nginx -d "$DOMAIN" --redirect --agree-tos --non-interactive)
  if [ -n "$EMAIL" ]; then CB+=(-m "$EMAIL"); else CB+=(--register-unsafely-without-email); fi
  "${CB[@]}" || die "certbot could not get a certificate. Check that $DOMAIN points here and port 80 is reachable from the internet."
  ok "certificate issued"
fi
nginx -t >/dev/null 2>&1 && systemctl reload nginx

# Renewal: certbot installs a systemd timer; make sure it runs and that nginx
# picks up each renewed certificate.
systemctl enable --now certbot.timer >/dev/null 2>&1 || true
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
ok "auto-renewal on (certbot.timer), nginx reloads after each renewal"

# ---------------------------------------------------------------- 6. verify, then lock down
say "Checking https://$DOMAIN"
code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/login" || true)"
[ "$code" = "200" ] || [ "$code" = "302" ] \
  || die "HTTPS did not answer (HTTP $code). The app is untouched and still reachable as before."
ok "https://$DOMAIN answers"

say "Moving the app behind nginx"
cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%F-%H%M%S)"
env_set HOST 127.0.0.1        # not reachable from outside except through nginx
env_set TRUST_PROXY 1         # real client IPs for the login limiter
env_set COOKIE_SECURE 1       # session cookie only ever sent over HTTPS
chmod 600 "$ENV_FILE"
systemctl restart "$SERVICE"

# Give it a moment, then prove the round trip once more before declaring done.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/login" || true)"
  [ "$code" = "200" ] && break; sleep 1
done
if [ "$code" != "200" ]; then
  # Roll back rather than leave the UI unreachable.
  warn "the app did not come back behind nginx (HTTP $code) — restoring the previous .env"
  cp "$(ls -t "$ENV_FILE".bak-* | head -1)" "$ENV_FILE"
  systemctl restart "$SERVICE"
  die "Rolled back. The UI is reachable as it was. Check: journalctl -u $SERVICE -n 50"
fi
ok "app listening on 127.0.0.1:$PORT only"

if ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q "0.0.0.0:$PORT\|\[::\]:$PORT\|\*:$PORT"; then
  warn "port $PORT still answers on all interfaces — check HOST in $ENV_FILE"
else
  ok "port $PORT is no longer reachable from the internet"
fi

say "Done"
cat <<DONE
    Open:  https://$DOMAIN

    - HTTP redirects to HTTPS; the certificate renews itself.
    - The app itself now listens on 127.0.0.1:$PORT only, so the old
      http://<ip>:$PORT address stops working. That is the point.
    - SIP (5060) and RTP (10000-20000) are not touched by any of this.
    - Your previous .env is saved next to it as .env.bak-<date>.

    To undo:  restore that backup, then systemctl restart $SERVICE
DONE
