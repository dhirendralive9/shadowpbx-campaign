#!/usr/bin/env bash
#
# Install Asterisk 22 from Sangoma's official Debian repository.
#
# Asterisk was dropped from Debian before bookworm shipped, so there is no
# asterisk package in Debian 12 or 13. Sangoma (who maintain Asterisk) publish
# packages for bookworm; this installs Asterisk standalone — no FreePBX.
#
# Called automatically by install.sh when apt has no asterisk candidate.
# Falls through to a source build if this repo isn't usable.
#
set -euo pipefail

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
export DEBIAN_FRONTEND=noninteractive

. /etc/os-release
CODENAME="${VERSION_CODENAME:-bookworm}"
if [ "$CODENAME" != "bookworm" ]; then
  warn "Sangoma publishes for bookworm; this system is '$CODENAME'."
  warn "Trying bookworm packages anyway — if it fails we fall back to source."
  CODENAME=bookworm
fi

say "Creating the asterisk user"
getent group asterisk >/dev/null || addgroup --quiet asterisk
id asterisk >/dev/null 2>&1 || adduser --system --quiet --ingroup asterisk asterisk

say "Installing prerequisites"
apt-get update -qq
apt-get install -y -qq gnupg wget ca-certificates >/dev/null

say "Adding Sangoma's signing key"
TMPKEY=$(mktemp)
wget -qO "$TMPKEY" http://deb.freepbx.org/gpg/aptly-pubkey.asc \
  || die "could not fetch Sangoma GPG key"
gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/freepbx.gpg "$TMPKEY"
rm -f "$TMPKEY"

say "Adding the repository"
# Written directly rather than via add-apt-repository, which isn't always present.
echo "deb [arch=amd64] http://deb.freepbx.org/freepbx17-prod ${CODENAME} main" \
  > /etc/apt/sources.list.d/sangoma-asterisk.list

if ! apt-get update 2>&1 | tee /tmp/sangoma-apt.log | grep -qi 'freepbx'; then
  warn "Repository did not appear in apt update output:"
  grep -iE 'freepbx|EXPKEYSIG|NO_PUBKEY|not signed' /tmp/sangoma-apt.log | head -5 || true
fi
# An expired signing key is the most likely failure here; surface it clearly.
if grep -qiE 'EXPKEYSIG|KEYEXPIRED' /tmp/sangoma-apt.log; then
  rm -f /etc/apt/sources.list.d/sangoma-asterisk.list
  apt-get update -qq || true
  die "Sangoma's signing key has expired — repo removed again.
     Falling back to a source build is the right move here:
       sudo bash scripts/install-asterisk-source.sh"
fi

say "Installing Asterisk 22"
# libxslt1.1 and liburiparser1 are NOT pulled in automatically — without
# them the asterisk binary dies with "libxslt.so.1: cannot open shared
# object file" the first time you run it.
if ! apt-get install -y -qq asterisk22 asterisk22-core asterisk22-configs libxslt1.1 liburiparser1 >/dev/null 2>&1; then
  warn "Package install failed. Diagnostics:"
  apt-cache policy asterisk22 || true
  rm -f /etc/apt/sources.list.d/sangoma-asterisk.list
  apt-get update -qq || true
  die "could not install from Sangoma repo — use: sudo bash scripts/install-asterisk-source.sh"
fi

say "Checking the asterisk binary runs (catches missing shared libraries)"
if ! asterisk -V >/dev/null 2>&1; then
  warn "asterisk binary will not start:"
  asterisk -V 2>&1 | head -3 || true
  warn "installing the usual missing libraries"
  apt-get install -y -qq libxslt1.1 liburiparser1 libedit2 libjansson4 >/dev/null 2>&1 || true
  asterisk -V >/dev/null 2>&1 || die "asterisk still will not start — send Claude the output of: asterisk -V"
fi

say "Verifying ARI support"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk >/dev/null 2>&1 || true
sleep 4
# res_ari_model.so loads by itself even when the rest of ARI is absent, so
# match the two modules that actually matter rather than the name prefix.
if asterisk -rx "module show like ari" 2>/dev/null | grep -qE '^res_ari\.so[[:space:]].*Running' \
   && asterisk -rx "module show like stasis" 2>/dev/null | grep -qE '^res_stasis\.so[[:space:]].*Running'; then
  echo "    res_ari.so and res_stasis.so are loaded."
else
  warn "These packages did not provide ARI (res_ari.so / res_stasis.so). On disk:"
  ls /usr/lib/asterisk/modules/ 2>/dev/null | grep -E 'ari|stasis' | sed 's/^/      /' || echo "      (none)"
  warn "Available asterisk packages in this repo:"
  apt-cache search '^asterisk' 2>/dev/null | head -20 | sed 's/^/      /' || true
  die "Asterisk without ARI is no use here. Build one with it:
     sudo bash scripts/install-asterisk-source.sh"
fi

say "Installed: $(asterisk -V 2>/dev/null || echo 'version unknown')"
