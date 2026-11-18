'use strict';
/**
 * Settings store — multi-record.
 *
 * Trunks and servers are lists, each with a name, and one of each is marked
 * active. A single hardcoded trunk was the wrong shape: you need several
 * providers saved and the ability to switch without retyping credentials.
 *
 * JSON file rather than MongoDB for now; migrates when leads/campaigns land.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.SETTINGS_FILE || path.join(__dirname, '../../config/settings.json');
const newId = () => crypto.randomBytes(6).toString('hex');

const DEFAULTS = {
  trunks: [],
  activeTrunkId: null,
  servers: [],
  activeServerId: null,
  ivr: {
    greeting: 'campaign/greeting',
    confirmKey: '1',
    optOutKey: '2',
    maxGreetings: 2,
    waitSeconds: 8,
  },
  meta: { updatedAt: null, version: 2 },
};

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`settings: ${FILE}: ${e.message}`);
    return null;
  }
}

/** v1 stored a single trunk/pbx object. Convert it to the list form. */
function migrate(raw) {
  if (!raw) return null;
  if (raw.meta && raw.meta.version >= 2) return raw;

  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (raw.ivr) Object.assign(out.ivr, raw.ivr);

  if (raw.trunk && raw.trunk.host) {
    const t = { id: newId(), name: raw.trunk.name || 'German trunk', ...raw.trunk };
    delete t.name === undefined;
    out.trunks.push(t);
    out.activeTrunkId = t.id;
  }
  if (raw.pbx && raw.pbx.host) {
    const s = {
      id: newId(), name: 'Main ShadowPBX',
      host: raw.pbx.host, port: raw.pbx.port || 5060,
      apiUrl: raw.pbx.apiUrl || '', apiKey: raw.pbx.apiKey || '',
      routeNumber: newRouteNumber([]),
    };
    out.servers.push(s);
    out.activeServerId = s.id;
  }
  out.meta.version = 2;
  return out;
}

function load() {
  const raw = migrate(readRaw());
  if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    ...raw,
    ivr: { ...DEFAULTS.ivr, ...(raw.ivr || {}) },
    trunks: raw.trunks || [],
    servers: raw.servers || [],
    meta: { ...DEFAULTS.meta, ...(raw.meta || {}) },
  };
}

function persist(s) {
  s.meta.updatedAt = new Date().toISOString();
  s.meta.version = 2;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return s;
}

// ---------------------------------------------------------------- trunks
const truthy = (v) => v === true || v === 'true' || v === 'on' || v === '1' || v === 'yes';

function saveTrunk(data) {
  const s = load();
  const clean = {
    name: (data.name || '').trim() || 'Unnamed trunk',
    host: (data.host || '').trim(),
    user: (data.user || '').trim(),
    port: parseInt(data.port, 10) || 5060,
    transport: data.transport || 'udp',
    // A checkbox sends nothing when unticked, so the form carries a hidden
    // "false" in front of it -- otherwise registration could never be turned
    // off, which is fatal for a provider that authenticates by IP. When the box
    // IS ticked the browser submits both, and the body parser hands back an
    // array, so the last value is the one that counts.
    register: truthy(Array.isArray(data.register)
      ? data.register[data.register.length - 1] : data.register),
    // Who we claim to be in the From header.
    //   auto     — account name when we authenticate, caller ID when we do not
    //   user     — always the account name
    //   callerid — always the caller ID
    // This is the single most common cause of a 403 on the INVITE from a trunk
    // that is otherwise configured correctly, and no two providers agree on
    // which they want, so it has to be settable rather than inferred.
    fromUser: ['auto', 'user', 'callerid'].includes(data.fromUser) ? data.fromUser : 'auto',
    // Extra IPs the provider sends from, when they differ from the SIP host.
    matchIps: (data.matchIps || '').trim(),
    callerId: (data.callerId || '').trim(),
  };
  const existing = data.id ? s.trunks.find((t) => t.id === data.id) : null;
  if (existing) {
    // Blank password means "unchanged" — don't wipe a stored secret.
    if ((data.pass || '').trim()) clean.pass = data.pass.trim();
    Object.assign(existing, clean);
  } else {
    clean.id = newId();
    clean.pass = (data.pass || '').trim();
    s.trunks.push(clean);
    if (!s.activeTrunkId) s.activeTrunkId = clean.id;
  }
  return persist(s);
}

function deleteTrunk(id) {
  const s = load();
  s.trunks = s.trunks.filter((t) => t.id !== id);
  if (s.activeTrunkId === id) s.activeTrunkId = s.trunks[0] ? s.trunks[0].id : null;
  return persist(s);
}

function setActiveTrunk(id) {
  const s = load();
  if (s.trunks.some((t) => t.id === id)) s.activeTrunkId = id;
  return persist(s);
}

// ---------------------------------------------------------------- servers
/**
 * A 12-digit number this module owns and the PBX routes.
 *
 * Confirmed press-1 calls are sent here; on the PBX it is an inbound route
 * pointing at the ring group or queue, which then picks the agent. Generated
 * rather than typed so two campaign servers can never share one, and so the
 * number means nothing to anyone who dials it by accident.
 */
function newRouteNumber(servers) {
  const taken = new Set((servers || []).map((x) => x.routeNumber).filter(Boolean));
  for (let i = 0; i < 50; i++) {
    // Leading digit 1-9: some dialplans treat a leading 0 as a prefix.
    const n = String(crypto.randomInt(1, 10))
      + String(crypto.randomInt(0, 1e11)).padStart(11, '0');
    if (!taken.has(n)) return n;
  }
  return String(Date.now()).slice(-12);
}

function saveServer(data) {
  const s = load();
  const clean = {
    name: (data.name || '').trim() || 'Unnamed server',
    host: (data.host || '').trim(),
    port: parseInt(data.port, 10) || 5060,
    // Agents come from the ring group or queue behind apiUrl, so there is no
    // single extension to dial any more.
    apiUrl: (data.apiUrl || '').trim(),
    // Optional: only needed when the PBX advertises a URL we cannot reach,
    // which happens behind a proxy that rewrites the host.
    wsUrl: (data.wsUrl || '').trim(),
    // How often to ask the PBX for agent availability when the WebSocket is
    // not carrying it. A busy PBX does not want a request every five seconds
    // from every campaign server, and availability that is a minute old is
    // still far better than none.
    agentPollSeconds: Math.max(5, Math.min(600, parseInt(data.agentPollSeconds, 10) || 60)),
  };
  const existing = data.id ? s.servers.find((x) => x.id === data.id) : null;
  if (existing) {
    if ((data.apiKey || '').trim()) clean.apiKey = data.apiKey.trim();
    Object.assign(existing, clean);
    // Keep the route number across edits: it is already configured on the PBX.
    if (!existing.routeNumber) existing.routeNumber = newRouteNumber(s.servers);
  } else {
    clean.id = newId();
    clean.apiKey = (data.apiKey || '').trim();
    clean.routeNumber = newRouteNumber(s.servers);
    s.servers.push(clean);
    if (!s.activeServerId) s.activeServerId = clean.id;
  }
  return persist(s);
}

/** Mint a fresh route number — only when the PBX side is being rebuilt. */
function regenerateRoute(id) {
  const s = load();
  const sv = s.servers.find((x) => x.id === id);
  if (!sv) return s;
  sv.routeNumber = newRouteNumber(s.servers.filter((x) => x.id !== id));
  return persist(s);
}

function deleteServer(id) {
  const s = load();
  s.servers = s.servers.filter((x) => x.id !== id);
  if (s.activeServerId === id) s.activeServerId = s.servers[0] ? s.servers[0].id : null;
  return persist(s);
}

function setActiveServer(id) {
  const s = load();
  if (s.servers.some((x) => x.id === id)) s.activeServerId = id;
  return persist(s);
}

function saveIvr(data) {
  const s = load();
  s.ivr = {
    greeting: (data.greeting || '').trim() || s.ivr.greeting,
    confirmKey: (data.confirmKey || '1').trim(),
    optOutKey: (data.optOutKey || '2').trim(),
    maxGreetings: Math.max(1, Math.min(5, parseInt(data.maxGreetings, 10) || 2)),
    waitSeconds: Math.max(3, Math.min(30, parseInt(data.waitSeconds, 10) || 8)),
  };
  return persist(s);
}

const activeTrunk = (s) => (s.trunks || []).find((t) => t.id === s.activeTrunkId) || null;
const activeServer = (s) => (s.servers || []).find((x) => x.id === s.activeServerId) || null;

/** What's missing before a call can be placed. */
function validate(s) {
  const missing = [];
  const t = activeTrunk(s), sv = activeServer(s);
  if (!t) missing.push('an active trunk');
  else {
    if (!t.host) missing.push('trunk host');
    if (!t.user) missing.push('trunk username');
    // An IP-authenticated trunk has no password by design -- demanding one
    // leaves "not ready to place calls" on screen forever on a trunk that is
    // working. What such a trunk does need is a caller ID: without it the From
    // header falls back to the account name and the provider answers 403.
    if (t.register && !t.pass) missing.push('trunk password');
    if (!t.register && !t.callerId) missing.push('trunk caller ID');
  }
  if (!sv) missing.push('an active server');
  else {
    if (!sv.host) missing.push('server host');
    // Without the agent API there is no way to know how many agents are free,
    // and a campaign that cannot see that is a campaign that abandons calls.
    if (!sv.apiUrl) missing.push('server agent API URL');
  }
  return missing;
}

module.exports = {
  load, persist, validate, activeTrunk, activeServer,
  saveTrunk, deleteTrunk, setActiveTrunk,
  saveServer, deleteServer, setActiveServer, regenerateRoute,
  saveIvr, DEFAULTS, FILE, newId,
};
