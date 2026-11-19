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

## "Cannot reach ARI" while a campaign is running

Asterisk's HTTP server is not answering. The campaign engine cannot place
calls without it, so the campaign pauses itself after ten consecutive
failures rather than spinning.

Work through these in order:

```
systemctl status asterisk                 # is it even running?
asterisk -rx "http show status"           # is the HTTP server up, on 8088?
asterisk -rx "ari show users"             # does the campaign user exist?
dmesg -T | grep -i -e oom -e "killed process"
```

The usual causes:

**Asterisk died.** On a small VPS, high concurrency plus an OOM kill is the
common one — `dmesg` will say so outright. By default a source-built Asterisk
has no restart policy, so it stays down. Fix that once:

```
./scripts/asterisk-resilience.sh
```

That adds a systemd drop-in: restart always, no start-limit give-up, 65535
file descriptors, and an OOM score that makes the kernel look elsewhere
first.

**http.conf was changed and never reloaded.** Copying the file is not enough;
`update.sh` now reloads ARI and the HTTP server when either file changes.

**ARI_PASS does not match.** `.env` and `/etc/asterisk/ari.conf` have to
agree. `update.sh` refuses to write the Asterisk config at all when
`ARI_PASS` is unset, because envsubst would otherwise write a blank password
that breaks ARI at the next restart — hours later, far from the deploy that
caused it.

### What happens to the leads

Nothing. A call that never reached anyone does not cost that lead an
attempt — the attempt is refunded and the number goes straight back in the
queue. This covers both infrastructure failures and carrier congestion
(hangup cause 34 and its family). They are recorded with outcome `blocked`
so the report shows how many calls did not happen, and they are counted
separately from `failed`, which means the call was placed and the carrier or
the lead ended it.

This matters more than it sounds. The attempt is counted *before* dialling,
so that a crash mid-call cannot leave a number being redialled forever.
Without the refund, ARI down for five minutes at high concurrency would
charge thousands of numbers an attempt they never received, park each one for
the retry delay, and eventually exhaust their retries — destroying a list
without a single phone ringing.

## Updating a running server

```
cd /root/shadowpbx-campaign && ./scripts/update.sh
```

`git pull` on its own is not enough. Asterisk reads `/etc/asterisk`, not the
repo, so a new dialplan context or amd.conf sits in the working tree doing
nothing until it is copied and reloaded; and Node holds the old code until
the service restarts. The script does the pull, installs dependencies only if
package.json moved, copies any changed Asterisk config (keeping a timestamped
backup of what it replaced), reloads the dialplan, restarts the service and
checks it came back up.

**It never copies pjsip.conf.** That file is generated by the UI from your
saved trunks; the copy in the repo is an empty placeholder, so copying it
would delete every trunk you have. Trunk config goes live by pressing Save on
the Trunks tab.

Nothing under `data/` or `config/` is touched, so trunks, flows, campaigns,
lead lists and call records all survive an update.

## Answering-machine detection

Off by default. Switch it on per campaign: **Edit campaign -> Hang up on
answering machines**.

ARI has no AMD of its own, so the channel takes a short trip out of Stasis
into the `[amd-check]` dialplan context, `AMD()` listens to the first few
seconds, and the channel comes straight back carrying the verdict. If it says
MACHINE the call is dropped before the prompt plays and the record is stored
as outcome `machine`.

Tuning lives in `/etc/asterisk/amd.conf`. `total_analysis_time` is the dial
that matters: every second of it is a second of silence a real person hears
before the prompt starts.

**It fails open on purpose.** AMD not loaded, context missing, round trip too
slow — all of them return something that is not MACHINE and the call proceeds
normally. Dropping a real lead because detection broke costs more than
talking to a voicemail box.

Check it is actually available before trusting the setting:

```
asterisk -rx "module show like amd"
```

`app_amd.so` must be loaded. Then watch the **Machines** column against your
connect rate for a run or two. A machine count that climbs while transfers
fall means the thresholds are too aggressive and it is hanging up on people.

Worth switching on mainly when the trunk has a channel limit, since a machine
otherwise holds a line for the entire menu.

### The bigger lever: the flow's own timeout

A machine that is not detected costs:

    greeting + timeoutSeconds + no-input prompt + greeting + timeoutSeconds

With the default `timeoutSeconds` of 30 and `maxNoInput` of 2, that is roughly
two minutes of a trunk channel per voicemail box. On a trunk with a small
channel allowance this is what produces hangup cause 34 across the campaign.

Nobody who intends to press 1 takes 30 seconds to do it. Set the flow's
timeout to 6-8 seconds on the IVR tab and the same call costs about 25
seconds instead. Do this before reaching for AMD; it is a larger saving, it
is exact rather than a guess, and it cannot drop a live lead.

## Call reports

Every finished campaign call writes one line to

```
data/calls/<campaignId>/<YYYY-MM-DD>.ndjson
```

Append-only, one file per campaign per day. The format is deliberate: writing
to a JSON array means read-parse-rewrite of the whole file per call, which at
campaign concurrency is slow and loses the entire day if the process dies
mid-write. A line append is one write, and a torn final line costs one record.

In the UI: **Campaigns -> Report** on any campaign. Filter by date range,
outcome or part of a number, then **Download CSV**. The on-screen table is
capped at 2000 rows; the CSV is not, so there is always a way to get
everything.

Outcome codes, as stored:

| code | meaning |
|---|---|
| `transferred` | pressed the confirm key and reached an agent |
| `opted-out` | pressed the opt-out key |
| `removed` | asked to be removed |
| `no-agent` | pressed 1 but no agent was free |
| `no-keypress` | heard the prompt, pressed nothing |
| `no-answer` | never picked up |
| `failed` | the call did not connect — `hangupCause` says why |

Records survive deleting a campaign, on purpose: a report is the evidence of
what was dialled, and deleting the campaign should not quietly destroy it. To
remove them, delete the campaign's folder under `data/calls/`.

Back them up with the rest of `data/`. Nothing prunes them.

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
