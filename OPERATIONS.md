# Operations and troubleshooting

Day-to-day commands for a running campaign server, and the failures we have
actually hit, with what each one looks like from the outside.

Paths assume the repo at `/root/shadowpbx-campaign` and the service
`shadowpbx-campaign`.

---

## Services

```bash
systemctl status  shadowpbx-campaign        # web UI + ARI engine
systemctl restart shadowpbx-campaign
systemctl restart asterisk

systemctl is-active asterisk shadowpbx-campaign
```

The app keeps login sessions in memory, so a restart logs everyone out. If the
UI suddenly asks you to log in mid-task, the service restarted — check the
journal for a crash rather than assuming the session expired.

## Logs

```bash
journalctl -u shadowpbx-campaign -f          # live
journalctl -u shadowpbx-campaign -n 50 -f    # last 50, then follow
journalctl -u shadowpbx-campaign -S "10 min ago"
journalctl -u asterisk -f
```

Asterisk's SIP detail does not go to journald. For that:

```bash
asterisk -rvvv                  # then, at the CLI prompt:
#   pjsip set logger on         # every SIP packet in and out
#   pjsip set logger off
```

Inside the Asterisk CLI only Asterisk commands work — `ls`, `grep` and `ldd`
are shell commands and will be rejected there. `exit` leaves the CLI.

Log files land in `/var/log/asterisk/`, named `messages.log` or `full` depending
on how Asterisk was installed.

## Health checks

```bash
# ARI — the interface the campaign engine drives Asterisk through
asterisk -rx "module show like ari"      | grep -E '^res_ari\.so|^res_stasis'
PASS=$(grep '^ARI_PASS=' /root/shadowpbx-campaign/.env | cut -d= -f2-)
curl -s -o /dev/null -w "ARI: %{http_code}\n" -u campaign:"$PASS" \
  http://127.0.0.1:8088/ari/api-docs/resources.json      # want 200

# PJSIP — how every call leaves the box
asterisk -rx "module show like pjsip" | tail -2          # want ~51 modules
asterisk -rx "pjsip show endpoints"
asterisk -rx "pjsip show contacts"                       # want Avail + an RTT
asterisk -rx "pjsip show registrations"                  # empty is correct for IP auth
```

`curl` returning 200 is the only check that proves the app can place a call.
Module lists can look healthy while ARI is unreachable over HTTP.

## Stored settings

Trunks, servers and IVR settings live in `config/settings.json`, not in
`/etc/asterisk`. Reinstalling Asterisk does not lose them; saving a trunk in the
UI regenerates `/etc/asterisk/pjsip.conf` from them.

```bash
cd /root/shadowpbx-campaign
node -e 'const s=require("./config/settings.json");console.log(s.trunks.map(t=>
  ({name:t.name,host:t.host,register:t.register,hasPass:!!t.pass,cid:t.callerId})))'

# rewrite pjsip.conf from stored settings without touching the UI
node -e 'const st=require("./src/services/settings"),a=require("./src/services/asterisk");
a.applySettings(st.load()).then(r=>console.log(r))'
```

## Test calls

Three ways, in increasing distance from the real campaign path.

**1. From the UI** — Trunks tab, *Test call*. Uses ARI, exactly as campaigns do.
Place the call, press `1` when the audio plays. This is the one that matters.

**2. From the Asterisk CLI**, no app involved — proves trunk, audio and DTMF:

```bash
asterisk -rx 'channel originate PJSIP/+<number>@trunk-<id> extension s@dtmf-test'
```

Watch the result in `asterisk -rvvv`. Prints `SUCCESS - key 1 received`, or
`FAILED - got ""` when no key arrives.

**3. Audio only**, no keypress:

```bash
asterisk -rx 'channel originate PJSIP/+<number>@trunk-<id> application Playback campaign/test'
```

Endpoint syntax matters: `PJSIP/<number>@<endpoint>`. Written the other way
round, `PJSIP/<endpoint>/<number>`, Asterisk reads the number as the name of a
contact record and the call dies before any INVITE leaves.

## Audio

Sounds live in `/var/lib/asterisk/sounds/campaign/`. Asterisk wants 8 kHz mono
16-bit WAV; anything else plays as silence or noise.

```bash
sox in.wav -r 8000 -c 1 -b 16 /var/lib/asterisk/sounds/campaign/greeting.wav
ls -la /var/lib/asterisk/sounds/campaign/
```

`Playback` takes the name without the extension: `campaign/test`, not
`campaign/test.wav`.

`test.wav` is built in. It is restored on startup if deleted and cannot be
renamed or overwritten from the Audio tab, so there is always something to test
a trunk with.

---

# Failures we have hit

## Test call sticks on "Placing the call…"

The page is waiting on a status it never gets. Check the journal: if the service
restarted at that moment, the ARI client crashed the process. The cause is
always upstream of the app — ARI unreachable, or not loaded at all.

## ARI not loaded

```
Cannot reach ARI at http://127.0.0.1:8088 — the HTTP server is up but ARI is not loaded
```

Packaged Asterisk builds often ship without ARI, and there is no package to add
afterwards. `module show like ari` showing only `res_ari_model.so` is this case:
that one module loads by itself and makes a naive check pass.

Fix: build Asterisk with ARI.

```bash
sudo bash scripts/install-asterisk-source.sh
```

## PJSIP loads zero modules after a source build

```
undefined symbol: pjsip_endpt_send_request2
```

A distro package left an older `libasteriskpj.so.2` in the multiarch directory,
which the linker searches before `/usr/lib`. The new modules resolve against the
old library. `ldd` reports nothing missing, because the library is found — just
out of date.

```bash
ldconfig -p | grep -i asteriskpj        # two paths means this is it
dpkg -S libasteriskpj.so.2              # names the package that put it there
mv /usr/lib/x86_64-linux-gnu/libasteriskpj.so.2 /root/
mv /usr/lib/x86_64-linux-gnu/libasteriskpj.so   /root/
ldconfig && systemctl restart asterisk
apt-mark hold asterisk22 asterisk22-core asterisk22-configs
```

The hold matters: an `apt upgrade` restores that library and breaks PJSIP again,
with nothing to connect the breakage to the upgrade.

## "missing separator" building Asterisk

```
makeopts:235: *** missing separator.  Stop.
```

`configure` ran on a dirty tree and captured pjproject's build output into a
variable, leaving a line that is not `VAR=value`. Every make command then fails,
including `make distclean`, which is how you would try to recover.

Re-extract rather than repair:

```bash
cd /usr/src && rm -rf asterisk-22.*/ && tar xzf asterisk-22-current.tar.gz
cd asterisk-22.*/ && ./configure --with-jansson-bundled --with-pjproject-bundled
grep -n PJPROJECT_INCLUDE makeopts     # must be -I paths, not "[pjproject] Rebuilding"
```

## The server locks up while compiling

`ps` and `free` stop answering and SSH hangs. The build ran one compiler per
core and exhausted RAM. Restart from the provider's control panel, then build
with one job:

```bash
nice -n 19 make -j1 && make install && ldconfig
```

Roughly 1.5 GB per parallel job. On a 2 GB box that means `-j1`, whatever
`nproc` says. Run it inside `screen` so a dropped connection doesn't lose it.

Do not run `make samples` or `make config` on a box that already has Asterisk
configured: the first overwrites `/etc/asterisk`, the second drops an init
script next to the packaged systemd unit.

## Trunk status stays "—" and never registers

```
pjsip show registrations   →   No objects found.
```

Usually "Register with the provider" ticked on a trunk with no password.
Asterisk refuses the registration object and reports nothing at all.

An IP-authenticated account ("IP to IP") never registers. For those: untick
Register, leave the password empty, and **set the Caller ID**. Without it the
From header falls back to the account name, and IP-authenticated providers
answer `403 Forbidden` on the INVITE — long after the trunk itself looks healthy.

Also check the SIP host is the provider's hostname. A provider portal showing
your own server's IP under "host" means the IP they accept traffic from, not an
address to send to.

## Call rejected instantly (hangup cause 21) on a trunk that works elsewhere

Two causes, both of which produce an identical bare 403 within half a second,
and neither of which says anything useful in the test-call panel. Check them in
this order.

**1. The registration object was never created.** Look in the Asterisk log for:

```
ERROR res_pjsip_outbound_registration.c: An endpoint has been specified on
  outbound registration 'trunk-xxxx' without enabling line support
ERROR res_sorcery_config.c: Could not create an object of type 'registration'
```

Asterisk requires `line = yes` wherever a registration names an `endpoint`.
Without it the whole registration is discarded — no REGISTER is ever sent, so
the provider has never heard from this machine and refuses the first INVITE.
`pjsip show registrations` shows nothing for that trunk, which is the tell;
the generator now always emits `line = yes`, so if you see this the config on
disk is older than the code. Re-save the trunk in the UI.

**2. The carrier wants a different number format.** `+4917685594635`,
`4917685594635` and `004917685594635` are not interchangeable — a carrier that
wants one commonly answers the others with 403 or 404 before the call rings.
Set it per trunk on the Trunks tab, under "How the number is dialled". The
table shows each trunk's current format next to its From identity.

Check both before touching the From header: a registration that never loaded
looks exactly like an identity the provider dislikes.

## 401 then 403 on the INVITE

The carrier challenged the call and then rejected the credentials. Either the
password is wrong, or the From user does not match what that account may
present. Check `from_user` on the endpoint:

```bash
asterisk -rx "pjsip show endpoint trunk-<id>" | grep -i from_user
```

## Diagnose shows "nothing captured"

The panel reads the Asterisk log. Boxes differ on the filename (`messages.log`
vs `full`), so this can mean the log is fine and the app looked in the wrong
place. Confirm with `ls -la /var/log/asterisk/`.
