'use strict';
/**
 * Live agent availability for each PBX server.
 *
 * A campaign only knows how fast to dial if it knows how many agents are free.
 * That number lives on the main ShadowPBX, behind the API URL saved with the
 * server -- a URL that points at one ring group or queue.
 *
 * Two transports, because they fail differently. A WebSocket gives the number
 * the moment it changes, which is what pacing actually needs; polling is slower
 * but survives a socket the PBX drops at 3am. So: prefer the socket, fall back
 * to polling whenever it is not connected, and never let the dialler run on a
 * number that stopped updating -- `fresh` says whether the figure can be
 * trusted, and stale data is treated as no agents rather than as the last good
 * reading.
 */
const EventEmitter = require('events');

// Node 20 has no global WebSocket, and `ws` may not be installed yet on a box
// that has not re-run npm install. Polling alone is a fine degraded mode, so
// missing the module must not stop the app from starting.
let WS = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null;
if (!WS) { try { WS = require('ws'); } catch (e) { WS = null; } }

const POLL_MS = 5000;           // REST cadence when the socket is down
const STALE_MS = 20000;         // older than this and we stop believing it
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

const bus = new EventEmitter();
const live = new Map();         // serverId -> connection record

const now = () => Date.now();

function blank(server) {
  return {
    serverId: server.id,
    name: server.name,
    transport: 'none',          // ws | rest | none
    connected: false,
    total: 0,
    available: 0,
    agents: [],
    group: '',
    error: '',
    updatedAt: 0,
  };
}

/**
 * Normalise whatever the PBX sends into the shape the dialler uses.
 * `available` is authoritative if given; otherwise count the agent list, so a
 * PBX that only sends agents still works.
 */
function normalise(body) {
  const agents = Array.isArray(body && body.agents) ? body.agents : [];
  const freeByList = agents.filter((a) => /^(available|idle|free|ready)$/i.test(a.status || '')).length;
  const total = Number.isFinite(body && body.total) ? body.total : agents.length;
  const available = Number.isFinite(body && body.available) ? body.available : freeByList;
  return {
    group: (body && body.group) || '',
    agents,
    total: Math.max(0, total),
    available: Math.max(0, Math.min(available, Math.max(total, available))),
    wsUrl: (body && body.wsUrl) || '',
  };
}

function apply(rec, body, transport) {
  const n = normalise(body);
  Object.assign(rec.state, {
    transport,
    connected: true,
    group: n.group,
    agents: n.agents,
    total: n.total,
    available: n.available,
    error: '',
    updatedAt: now(),
  });
  if (n.wsUrl) rec.wsUrl = n.wsUrl;
  bus.emit('update', rec.state);
}

function fail(rec, transport, err) {
  rec.state.transport = transport;
  rec.state.connected = false;
  rec.state.error = String((err && err.message) || err || 'unreachable');
  bus.emit('update', rec.state);
}

// ----------------------------------------------------------------- REST
async function pollOnce(rec) {
  const { server } = rec;
  if (!server.apiUrl) return;
  try {
    const r = await fetch(server.apiUrl, {
      headers: Object.assign({ Accept: 'application/json' },
        server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) {
      return fail(rec, 'rest', r.status === 401 || r.status === 403
        ? `the PBX rejected the API key (HTTP ${r.status})`
        : `the agent API answered HTTP ${r.status}`);
    }
    apply(rec, await r.json(), rec.ws && rec.ws.readyState === 1 ? 'ws' : 'rest');
  } catch (e) {
    const code = (e.cause && e.cause.code) || e.name;
    fail(rec, 'rest', code === 'TimeoutError' || e.name === 'TimeoutError'
      ? 'the agent API did not answer within 4s'
      : `cannot reach the agent API (${code})`);
  }
}

// ------------------------------------------------------------------- WS
function wsUrlFor(rec) {
  if (rec.wsUrl) return rec.wsUrl;
  try {
    const u = new URL(rec.server.apiUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return u.toString();
  } catch (e) { return ''; }
}

function openSocket(rec) {
  if (!WS || rec.closed) return;
  const url = wsUrlFor(rec);
  if (!url) return;
  let sock;
  try {
    sock = rec.server.apiKey && WS !== globalThis.WebSocket
      ? new WS(url, { headers: { Authorization: `Bearer ${rec.server.apiKey}` } })
      : new WS(url);
  } catch (e) { return scheduleReconnect(rec); }
  rec.ws = sock;

  sock.addEventListener('open', () => {
    rec.attempt = 0;
    // Browser WebSocket cannot set headers, so authenticate in-band too. A PBX
    // that authenticates on the upgrade simply ignores this.
    if (rec.server.apiKey) {
      try { sock.send(JSON.stringify({ type: 'auth', token: rec.server.apiKey })); } catch (e) {}
    }
  });
  sock.addEventListener('message', (ev) => {
    try {
      const body = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (body && body.type === 'pong') return;
      apply(rec, body, 'ws');
    } catch (e) { /* a frame we don't understand is not a reason to drop the socket */ }
  });
  sock.addEventListener('error', () => { /* 'close' always follows */ });
  sock.addEventListener('close', () => {
    rec.ws = null;
    if (rec.closed) return;
    rec.state.transport = 'rest';
    scheduleReconnect(rec);
  });
}

function scheduleReconnect(rec) {
  if (rec.closed || rec.reconnect) return;
  const wait = BACKOFF_MS[Math.min(rec.attempt, BACKOFF_MS.length - 1)];
  rec.attempt += 1;
  rec.reconnect = setTimeout(() => { rec.reconnect = null; openSocket(rec); }, wait);
}

// ------------------------------------------------------------------ api
function startOne(server) {
  const rec = {
    server,
    state: blank(server),
    ws: null,
    wsUrl: '',
    attempt: 0,
    reconnect: null,
    closed: false,
    timer: null,
  };
  live.set(server.id, rec);
  pollOnce(rec).then(() => openSocket(rec));
  rec.timer = setInterval(() => {
    // Poll whenever the socket is not carrying data. Cheap, and it is what
    // keeps `fresh` true through a silent socket.
    if (!rec.ws || rec.ws.readyState !== 1) pollOnce(rec);
  }, POLL_MS);
  return rec;
}

function stopOne(id) {
  const rec = live.get(id);
  if (!rec) return;
  rec.closed = true;
  clearInterval(rec.timer);
  clearTimeout(rec.reconnect);
  try { if (rec.ws) rec.ws.close(); } catch (e) {}
  live.delete(id);
}

/** Keep connections in step with saved settings. Safe to call on every save. */
function sync(settings) {
  const servers = (settings && settings.servers) || [];
  const wanted = new Set(servers.map((s) => s.id));
  for (const id of [...live.keys()]) if (!wanted.has(id)) stopOne(id);
  for (const sv of servers) {
    const rec = live.get(sv.id);
    if (!rec) { if (sv.apiUrl) startOne(sv); continue; }
    // Reconnect only when something that defines the connection changed.
    if (rec.server.apiUrl !== sv.apiUrl || rec.server.apiKey !== sv.apiKey) {
      stopOne(sv.id);
      if (sv.apiUrl) startOne(sv);
    } else {
      rec.server = sv;
      rec.state.name = sv.name;
    }
  }
}

/**
 * What the dialler and the UI read. `fresh` is the one that matters: a number
 * nobody has confirmed in STALE_MS is not evidence that an agent is free.
 */
function status(id) {
  const rec = live.get(id);
  if (!rec) {
    return Object.assign(blank({ id, name: '' }),
      { fresh: false, reason: 'not configured', wsSupported: !!WS, ageMs: null });
  }
  const age = now() - rec.state.updatedAt;
  const fresh = rec.state.updatedAt > 0 && age < STALE_MS;
  return Object.assign({}, rec.state, {
    fresh,
    ageMs: rec.state.updatedAt ? age : null,
    wsSupported: !!WS,
  });
}

/** Free agents, or 0 when we cannot currently prove otherwise. */
function availableNow(id) {
  const st = status(id);
  return st.fresh ? st.available : 0;
}

module.exports = { sync, status, availableNow, stopOne, bus, STALE_MS };
