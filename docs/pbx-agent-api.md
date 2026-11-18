# Agent API — what ShadowPBX must expose

The campaign module paces dialling on one number: how many agents on a ring
group or queue are free right now. ShadowPBX provides that, per group, at the
URL you paste into the Servers tab.

Two sides to it:

| Direction | What | Why |
|---|---|---|
| Campaign → PBX | `GET <apiUrl>` | the baseline, and the fallback whenever the socket is down |
| PBX → Campaign | WebSocket pushes | availability the moment it changes, which is what pacing needs |
| Campaign → PBX | a SIP call to the 12-digit route number | where a confirmed press-1 is sent |

## 1. REST

```
GET https://pbx.example/api/campaign/queues/sales
Authorization: Bearer <api key>
Accept: application/json
```

```json
{
  "group": "Sales queue",
  "total": 8,
  "available": 3,
  "wsUrl": "wss://pbx.example/api/campaign/queues/sales/ws",
  "agents": [
    { "id": "2001", "name": "Asha",  "status": "available" },
    { "id": "2002", "name": "Ravi",  "status": "busy" },
    { "id": "2003", "name": "Mo",    "status": "offline" }
  ]
}
```

- `available` wins when present. Without it, agents whose `status` is
  `available`, `idle`, `free` or `ready` are counted — so a PBX that only sends
  the agent list still works.
- `total` defaults to the length of `agents`.
- `wsUrl` is optional. Without it the module swaps the scheme on `apiUrl`
  (`https` → `wss`) and connects there.
- `401` or `403` is reported in the UI as a rejected API key, not as an
  unreachable PBX. Worth getting right — it is the difference between "fix the
  key" and "check the network".

Polled every 5s whenever the WebSocket is not connected.

## 2. WebSocket

Same JSON, pushed whenever availability changes. Send the whole snapshot, not a
delta: the module replaces its state with each frame, so a missed frame cannot
leave it believing something stale.

Authentication, in order of preference:

1. the `Authorization: Bearer <key>` header on the upgrade request, which the
   module sends, or
2. the first frame the module sends after connect:
   `{"type":"auth","token":"<key>"}`

Frames of `{"type":"pong"}` are ignored, so a keepalive scheme is harmless.

On disconnect the module retries at 1s, 2s, 5s, 10s, then every 30s, and polls
REST throughout.

## 3. Staleness

A figure nobody has confirmed within 20 seconds is not treated as the last good
reading — it is treated as **no agents free**. A dialler that keeps calling
because the number it last saw was 3 is a dialler that abandons calls.

So: if the PBX goes quiet, dialling stops. Keep the socket alive, or let the
REST poll succeed.

## 4. The route number

Saving a server generates a 12-digit number, shown on the Servers tab. Add it
on ShadowPBX under `/routes` as an **inbound route** pointing at the ring group
or queue that this campaign feeds.

**The PBX must trust this server's IP**, or the call never reaches the route.
ShadowPBX classifies an INVITE by source IP: trusted trunk sources are matched
against inbound routes, anything else can only ring an extension — never a ring
group or queue. An untrusted source gets hangup cause 1, *unallocated number*,
which looks like a wrong DID and costs an hour in the wrong place.

On the PBX, in `/opt/shadowpbx/.env`:

```bash
TRUNK_TRUSTED_IPS=<this server's public IP>   # comma-separated, CIDR allowed
systemctl restart shadowpbx
```

When a lead presses 1, the campaign module sends the call to that number over
the SIP leg to the PBX; the queue picks the agent. The campaign module does not
choose an agent and does not reserve one — it only decides whether to dial at
all, from the free count above.

Use **Test call** on the Servers tab to prove it: the module dials its own route
number, an agent's phone should ring, and answering plays the test audio. That
exercises the SIP leg, the inbound route and the queue in one go.

Regenerating the number invalidates the old one as soon as you repoint the
inbound route on the PBX.
