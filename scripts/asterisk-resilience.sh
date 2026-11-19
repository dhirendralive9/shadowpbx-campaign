#!/usr/bin/env bash
#
# Make Asterisk come back on its own.
#
# A source-built Asterisk often ships a unit with no restart policy, so a
# crash or an OOM kill leaves it down until someone notices. The campaign
# engine then reports "Cannot reach ARI" and stops, which is correct but not
# much comfort at 3am.
#
# This adds a drop-in that restarts Asterisk automatically, and raises the
# file-descriptor limit, which a few hundred concurrent calls will otherwise
# run into.
#
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run this as root."; exit 1; }

DIR=/etc/systemd/system/asterisk.service.d
mkdir -p "$DIR"
cat > "$DIR/override.conf" <<'CONF'
[Service]
# Come back from a crash or an OOM kill without waiting for a human.
Restart=always
RestartSec=5
# Do not give up after the default 5 attempts: a box that is briefly out of
# memory will exceed that and then stay down permanently.
StartLimitIntervalSec=0

# Each concurrent call costs several descriptors between SIP, RTP and ARI.
LimitNOFILE=65535

# The kernel should reach for something else first when memory runs short.
OOMScoreAdjust=-500
CONF

systemctl daemon-reload
systemctl restart asterisk || true
sleep 2
systemctl is-active --quiet asterisk \
  && echo "asterisk is running, and will now restart itself if it dies" \
  || { echo "asterisk did not start:"; journalctl -u asterisk -n 20 --no-pager; exit 1; }

echo
echo "Current policy:"
systemctl show asterisk -p Restart -p RestartSec -p LimitNOFILE -p OOMScoreAdjust
