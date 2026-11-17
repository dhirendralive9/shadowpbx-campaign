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
      agentExten: raw.pbx.agentExten || '2000',
      apiUrl: raw.pbx.apiUrl || '', apiKey: raw.pbx.apiKey || '',
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
function saveTrunk(data) {
  const s = load();
  const clean = {
    name: (data.name || '').trim() || 'Unnamed trunk',
    host: (data.host || '').trim(),
    user: (data.user || '').trim(),
    port: parseInt(data.port, 10) || 5060,
    transport: data.transport || 'udp',
    // A checkbox sends nothing when unticked, so 'absent' must mean false --
    // otherwise registration can never be turned off, which is fatal for a
    // provider that authenticates by IP and rejects REGISTER outright.
    register: data.register === true || data.register === 'true'
              || data.register === 'on' || data.register === '1',
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
function saveServer(data) {
  const s = load();
  const clean = {
    name: (data.name || '').trim() || 'Unnamed server',
    host: (data.host || '').trim(),
    port: parseInt(data.port, 10) || 5060,
    agentExten: (data.agentExten || '').trim(),
    apiUrl: (data.apiUrl || '').trim(),
  };
  const existing = data.id ? s.servers.find((x) => x.id === data.id) : null;
  if (existing) {
    if ((data.apiKey || '').trim()) clean.apiKey = data.apiKey.trim();
    Object.assign(existing, clean);
  } else {
    clean.id = newId();
    clean.apiKey = (data.apiKey || '').trim();
    s.servers.push(clean);
    if (!s.activeServerId) s.activeServerId = clean.id;
  }
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
    if (!t.pass) missing.push('trunk password');
  }
  if (!sv) missing.push('an active server');
  else {
    if (!sv.host) missing.push('server host');
    if (!sv.agentExten) missing.push('agent extension');
  }
  return missing;
}

module.exports = {
  load, persist, validate, activeTrunk, activeServer,
  saveTrunk, deleteTrunk, setActiveTrunk,
  saveServer, deleteServer, setActiveServer,
  saveIvr, DEFAULTS, FILE, newId,
};
