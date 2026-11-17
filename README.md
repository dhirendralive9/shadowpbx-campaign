# ShadowPBX Campaign Module

Outbound press-1 IVR campaign engine for ShadowPBX, built on **Asterisk 20 + ARI**
and driven from Node.js. Runs on its own server; hands confirmed leads to the main
ShadowPBX over SIP.

## Why it's separate

The outbound dialer previously ran inside ShadowPBX on drachtio + rtpengine. Two
things made that unworkable:

- **DTMF.** RFC2833 only works if the carrier negotiates `telephone-event`. Ours
  didn't, and rtpengine does not detect in-band tones, so press-1 never registered.
  Asterisk's `dtmf_mode = auto` handles both.
- **Codecs.** The carrier answered with G.729, which rtpengine cannot encode a WAV
  prompt into — the greeting was silently inaudible and recordings were static.
  Here G.711 is forced on both legs.

Running it on its own box also means a runaway campaign can't starve the SIP
registrations of the agents on the main PBX.

## Architecture

```
  German trunk ──► Asterisk (this server) ──► press 1 ──► SIP ──► ShadowPBX ──► agent
                        ▲                                              │
                        │          reserve-agent API (HTTPS)           │
                        └──────────────────────────────────────────────┘
```

The campaign server asks the main PBX to **reserve** an agent at the moment the
lead presses 1, and only transfers if it gets one back — so two simultaneous
press-1s can't race for the same agent and leave someone on dead air.

## Quick start

```bash
cp .env.example .env && nano .env     # trunk + PBX details
sudo bash scripts/install.sh
# put greeting.wav (8kHz mono) in /var/lib/asterisk/sounds/campaign/
node src/press1-test.js 49XXXXXXXXXX  # call your own mobile
```

`press1-test.js` places one call, plays the greeting, waits for a key, replays,
and on `1` bridges you to extension 2000 on ShadowPBX. It prints a single
`RESULT:` line so you know exactly what happened.

## Status

- [x] Asterisk config (PJSIP, ARI, dialplan) — G.711 forced, `dtmf_mode=auto`
- [x] Step-1 proof: dial → greeting → press 1 → transfer
- [ ] Agent reserve/availability API on main ShadowPBX
- [ ] Campaign engine ported from ShadowPBX (leads, CSV import, pacing, overdial)
- [ ] Web UI
- [ ] AMD (answering-machine detection) via Asterisk `AMD()`

## Config notes

`allow = ulaw,alaw` and `dtmf_mode = auto` in `asterisk/pjsip.conf` are
load-bearing. Both were the direct cause of month-long failures. Don't relax them.
