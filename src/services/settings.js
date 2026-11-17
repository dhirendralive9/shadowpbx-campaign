'use strict';
/**
 * Settings store.
 *
 * Everything that used to live in .env and be edited over SSH now lives here
 * and is edited in the UI. .env keeps only bootstrap values — the things
 * needed before the app can serve a page (port, session secret, ARI
 * credentials, which double as the login).
 *
 * Deliberately a JSON file rather than MongoDB: this is ~20 fields, and Mongo
 * is not in Debian's repositories either. When leads and campaigns arrive they
 * bring Mongo with them and these settings migrate in minutes.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.SETTINGS_FILE || path.join(__dirname, '../../config/settings.json');

const DEFAULTS = {
  trunk: {
    name: 'german-trunk',
    host: '',
    user: '',
    pass: '',
    port: 5060,
    transport: 'udp',
    register: true,
    callerId: '',
  },
  pbx: {
    host: '',
    port: 5060,
    agentExten: '2000',
    apiUrl: '',
    apiKey: '',
  },
  ivr: {
    greeting: 'campaign/greeting',   // relative to /var/lib/asterisk/sounds
    confirmKey: '1',
    optOutKey: '2',
    maxGreetings: 2,
    waitSeconds: 8,
  },
  meta: { updatedAt: null },
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`settings: could not read ${FILE}: ${e.message} — using defaults`);
    }
    // First run: seed from .env so an existing install keeps working.
    return deepMerge(DEFAULTS, seedFromEnv());
  }
}

function seedFromEnv() {
  const e = process.env;
  const seed = { trunk: {}, pbx: {}, ivr: {} };
  if (e.TRUNK_HOST && !/yourprovider/.test(e.TRUNK_HOST)) seed.trunk.host = e.TRUNK_HOST;
  if (e.TRUNK_USER && !/your_sip/.test(e.TRUNK_USER)) seed.trunk.user = e.TRUNK_USER;
  if (e.TRUNK_PASS && !/your_sip/.test(e.TRUNK_PASS)) seed.trunk.pass = e.TRUNK_PASS;
  if (e.CALLER_ID) seed.trunk.callerId = e.CALLER_ID;
  if (e.PBX_HOST) seed.pbx.host = e.PBX_HOST;
  if (e.PBX_PORT) seed.pbx.port = parseInt(e.PBX_PORT, 10) || 5060;
  if (e.AGENT_EXTEN) seed.pbx.agentExten = e.AGENT_EXTEN;
  if (e.PBX_API_URL) seed.pbx.apiUrl = e.PBX_API_URL;
  if (e.CONFIRM_KEY) seed.ivr.confirmKey = e.CONFIRM_KEY;
  if (e.OPTOUT_KEY) seed.ivr.optOutKey = e.OPTOUT_KEY;
  if (e.MAX_GREETINGS) seed.ivr.maxGreetings = parseInt(e.MAX_GREETINGS, 10) || 2;
  if (e.WAIT_SECONDS) seed.ivr.waitSeconds = parseInt(e.WAIT_SECONDS, 10) || 8;
  return seed;
}

function save(patch) {
  const merged = deepMerge(load(), patch);
  merged.meta.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Write via a temp file so a crash mid-write can't leave truncated settings.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  return merged;
}

/** Fields that must be set before a call can be placed. */
function validate(s) {
  const missing = [];
  if (!s.trunk.host) missing.push('Trunk host');
  if (!s.trunk.user) missing.push('Trunk username');
  if (!s.trunk.pass) missing.push('Trunk password');
  if (!s.pbx.host) missing.push('ShadowPBX host');
  if (!s.pbx.agentExten) missing.push('Agent extension');
  return missing;
}

module.exports = { load, save, validate, DEFAULTS, FILE };
