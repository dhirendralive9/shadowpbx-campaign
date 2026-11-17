#!/usr/bin/env bash
#
# Build and install Asterisk from source.
#
# Asterisk has been removed from Debian's repositories (and is being removed
# from Ubuntu), so on Debian 13+ there is no package to install. This builds
# the current LTS instead. Called automatically by install.sh when apt has no
# asterisk candidate, or run on its own:
#
#   sudo bash scripts/install-asterisk-source.sh
#
set -euo pipefail

ASTERISK_MAJOR="${ASTERISK_MAJOR:-22}"   # current LTS
SRC_DIR=/usr/src

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"

export DEBIAN_FRONTEND=noninteractive

say "Installing build dependencies"
apt-get update -qq
apt-get install -y -qq \
  build-essential wget curl ca-certificates pkg-config \
  libedit-dev libssl-dev libsrtp2-dev libjansson-dev libxml2-dev \
  libsqlite3-dev uuid-dev libcurl4-openssl-dev libogg-dev libvorbis-dev \
  libspeex-dev libspeexdsp-dev subversion >/dev/null

say "Fetching Asterisk ${ASTERISK_MAJOR} (current LTS)"
cd "$SRC_DIR"
TARBALL="asterisk-${ASTERISK_MAJOR}-current.tar.gz"
rm -rf asterisk-${ASTERISK_MAJOR}.* "$TARBALL"
wget -q "https://downloads.asterisk.org/pub/telephony/asterisk/${TARBALL}" \
  || die "download failed — check outbound network"
tar xzf "$TARBALL"
cd asterisk-${ASTERISK_MAJOR}.*/

say "Resolving prerequisites"
# Non-interactive; it may still report optional items as missing, which is fine.
contrib/scripts/install_prereq install >/dev/null 2>&1 || warn "install_prereq reported issues (usually optional codecs) — continuing"

say "Configuring"
./configure --with-jansson-bundled --with-pjproject-bundled >/dev/null

say "Selecting modules (ARI + the codecs we actually use)"
make menuselect.makeopts >/dev/null
# ARI is what the campaign engine drives Asterisk through — it is useless without these.
menuselect/menuselect \
  --enable res_ari --enable res_ari_applications --enable res_ari_asterisk \
  --enable res_ari_bridges --enable res_ari_channels --enable res_ari_endpoints \
  --enable res_ari_events --enable res_ari_playbacks --enable res_ari_recordings \
  --enable res_ari_sounds --enable res_stasis --enable res_stasis_playback \
  --enable res_stasis_recording --enable res_stasis_snoop \
  --enable res_http_websocket --enable res_pjsip --enable chan_pjsip \
  --enable format_wav --enable format_pcm \
  --enable codec_alaw --enable codec_ulaw \
  menuselect.makeopts

say "Building (this is the slow part — several minutes)"
make -j"$(nproc)" >/dev/null

say "Installing"
make install >/dev/null
make samples >/dev/null      # stock configs; install.sh overwrites the ones we manage
make config >/dev/null       # systemd unit
ldconfig

say "Creating asterisk user"
if ! id asterisk >/dev/null 2>&1; then
  groupadd -r asterisk 2>/dev/null || true
  useradd -r -d /var/lib/asterisk -g asterisk -s /sbin/nologin asterisk 2>/dev/null || true
fi
sed -i 's/^;\?runuser\s*=.*/runuser = asterisk/'   /etc/asterisk/asterisk.conf 2>/dev/null || true
sed -i 's/^;\?rungroup\s*=.*/rungroup = asterisk/' /etc/asterisk/asterisk.conf 2>/dev/null || true
for d in /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk /etc/asterisk; do
  [ -d "$d" ] && chown -R asterisk:asterisk "$d" || true
done

say "Verifying ARI support"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk || true
sleep 4
# res_ari_model.so loads by itself even when the rest of ARI is absent, so
# match the two modules that actually matter rather than the name prefix.
if asterisk -rx "module show like ari" 2>/dev/null | grep -qE '^res_ari\.so[[:space:]].*Running' \
   && asterisk -rx "module show like stasis" 2>/dev/null | grep -qE '^res_stasis\.so[[:space:]].*Running'; then
  echo "    res_ari.so and res_stasis.so are loaded."
else
  warn "res_ari.so / res_stasis.so did not load. Modules on disk:"
  ls /usr/lib/asterisk/modules/ 2>/dev/null | grep -E 'ari|stasis' | sed 's/^/      /' || echo "      (none)"
  die "the build produced no ARI — re-run this script, or check the menuselect step above"
fi

say "Installed: $(asterisk -V 2>/dev/null || echo 'version unknown')"
echo "    Re-run: sudo bash scripts/install.sh   (to write the campaign config)"
