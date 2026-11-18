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

LOGFILE="/var/log/shadowpbx-asterisk-build.log"

# Each parallel gcc compiling Asterisk peaks around 1-1.5 GB. `make -j$(nproc)`
# on a 2-core/2GB VPS therefore runs the box out of memory, and what that looks
# like from the terminal is not an error: the machine thrashes, `ps` and `free`
# stop answering, and the session appears to hang forever. Size the build to the
# RAM, not the core count.
build_jobs() {
  local mem_kb jobs cores
  mem_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo)
  cores=$(nproc)
  jobs=$(( mem_kb / 1500000 ))
  [ "$jobs" -lt 1 ] && jobs=1
  [ "$jobs" -gt "$cores" ] && jobs="$cores"
  echo "$jobs"
}

# Swap does not make a small box fast, but it does turn "the VPS locks up and
# you reboot it from the control panel" into "the build takes longer".
ensure_swap() {
  local mem_kb swap_kb
  mem_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo)
  swap_kb=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)
  [ "$mem_kb" -ge 3000000 ] && return 0
  [ "$swap_kb" -ge 1500000 ] && return 0
  say "Adding 2G swap (RAM is $((mem_kb / 1024))MB, swap is $((swap_kb / 1024))MB)"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null \
      || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none \
      || { warn "could not create /swapfile — continuing without it"; return 0; }
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null 2>&1 || true
  fi
  swapon /swapfile 2>/dev/null || warn "swapon failed (some VPS kernels forbid swapfiles) — continuing"
  grep -q '^/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

# A source build is ten-plus minutes of silence if every step is sent to
# /dev/null, and silence is indistinguishable from a hung download. Log
# everything, print a dot every 10s so the terminal is visibly alive, and dump
# the tail of the log when a step fails instead of just saying "failed".
run_logged() {
  local label="$1"; shift
  printf '    %s ' "$label"
  "$@" >>"$LOGFILE" 2>&1 &
  local pid=$! t=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 10; t=$((t + 10)); printf '.'
    [ $((t % 300)) -eq 0 ] && printf ' %dm ' $((t / 60))
  done
  if ! wait "$pid"; then
    printf '\n'
    warn "$label failed — last 30 lines of $LOGFILE:"
    tail -30 "$LOGFILE" | sed 's/^/      /'
    die "$label failed (full log: $LOGFILE)"
  fi
  printf ' ok (%dm%02ds)\n' $((t / 60)) $((t % 60))
}

[ "$(id -u)" -eq 0 ] || die "run as root"

# shellcheck source=scripts/lib-asterisk.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-asterisk.sh"

# `configure` on a dirty tree can capture pjproject's build chatter into a
# variable, leaving a makeopts line that is not VAR=value. Every later make --
# including `make distclean`, which is how you would try to recover -- then dies
# with "missing separator", pointing at a line nobody wrote.
check_makeopts() {
  local bad
  # Not "has no =": the stray line is pjproject's own command line, which is
  # full of --prefix=... . What marks it is that it does not START with VAR=.
  bad=$(awk 'NF && $0 !~ /^[[:space:]]/ && $0 !~ /^#/ \
             && $0 !~ /^[A-Za-z_][A-Za-z0-9_]*[+:?]?=/ \
             {print "      line "NR": "substr($0,1,90); n++} n>=3{exit}' makeopts)
  [ -z "$bad" ] && return 0
  warn "makeopts is malformed — these lines are not VAR=value:"
  printf '%s\n' "$bad"
  die "stale build tree. Re-run this script: it re-extracts the source from scratch."
}

export DEBIAN_FRONTEND=noninteractive

ensure_swap

say "Installing build dependencies"
echo "    build log: $LOGFILE"
: > "$LOGFILE"
apt-get update -qq
run_logged "apt-get install" apt-get install -y -qq \
  build-essential wget curl ca-certificates pkg-config \
  libedit-dev libssl-dev libsrtp2-dev libjansson-dev libxml2-dev \
  libsqlite3-dev uuid-dev libcurl4-openssl-dev libogg-dev libvorbis-dev \
  libspeex-dev libspeexdsp-dev subversion

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
contrib/scripts/install_prereq install >>"$LOGFILE" 2>&1 \
  || warn "install_prereq reported issues (usually optional codecs) — continuing"

say "Configuring"
# --with-pjproject-bundled downloads and builds pjproject here, which is the
# longest quiet stretch of the whole build (several minutes on a small VPS).
run_logged "configure (builds bundled pjproject — several minutes)" \
  ./configure --with-jansson-bundled --with-pjproject-bundled
check_makeopts

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

# menuselect ignores a module name it does not recognise, so confirm nothing we
# just asked for is still on the exclude list.
if grep '^MENUSELECT_RES' menuselect.makeopts | tr ' ' '\n' \
     | grep -qE '^(res_ari|res_stasis|res_pjsip)'; then
  warn "these are excluded from the build:"
  grep '^MENUSELECT_RES' menuselect.makeopts | tr ' ' '\n' \
    | grep -E '^(res_ari|res_stasis|res_pjsip)' | sed 's/^/      /'
  die "refusing to build an Asterisk the campaign engine cannot use"
fi

JOBS="$(build_jobs)"
say "Building with $JOBS parallel job(s) — $(awk '/^MemTotal/{printf "%dMB RAM", $2/1024}' /proc/meminfo), $(nproc) core(s)"
[ "$JOBS" -lt "$(nproc)" ] && warn "fewer jobs than cores on purpose: more would exhaust RAM and freeze the box"
run_logged "make -j$JOBS (10-40 minutes on a small VPS)" make -j"$JOBS"

say "Installing"
run_logged "make install" make install

# `make samples` overwrites /etc/asterisk, and `make config` drops an init
# script beside a packaged systemd unit. Both are right on a bare box and
# destructive on one that already runs Asterisk.
if [ -f /etc/asterisk/asterisk.conf ]; then
  warn "/etc/asterisk already populated — skipping 'make samples' to keep your config"
else
  run_logged "make samples" make samples
fi
if [ -f /lib/systemd/system/asterisk.service ] || [ -f /etc/systemd/system/asterisk.service ]; then
  warn "a systemd unit for asterisk exists — skipping 'make config'"
else
  run_logged "make config" make config
fi
ldconfig

say "Clearing libraries that would shadow this build"
fix_shadowed_pjproject
hold_distro_asterisk

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

say "Verifying the build actually works"
systemctl enable asterisk >/dev/null 2>&1 || true
systemctl restart asterisk || true
for _ in $(seq 1 20); do ari_modules_ok && break; sleep 1; done

if pjsip_modules_ok; then
  echo "    chan_pjsip.so is loaded."
else
  pjsip_missing_report
  die "PJSIP will not load after this build — no call can leave the box."
fi

if ari_modules_ok; then
  echo "    res_ari.so and res_stasis.so are loaded."
else
  ari_missing_report
  die "the build produced no usable ARI — check the menuselect step in $LOGFILE"
fi

say "Installed: $(asterisk -V 2>/dev/null || echo 'version unknown')"
echo "    Re-run: sudo bash scripts/install.sh   (to write the campaign config)"
