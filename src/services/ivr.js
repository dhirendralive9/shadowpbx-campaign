'use strict';
/**
 * IVR flows — what a lead hears, and what each key does.
 *
 * Stored as named flows rather than settings on a campaign, because the menu
 * is the part you iterate on: two campaigns dialling different lists usually
 * want the same script, and a script that performs gets reused for months
 * after the campaign that produced it is gone.
 *
 * A flow is deliberately a flat list of keys rather than a tree. Outbound
 * press-1 menus are one level deep in practice — the lead is doing something
 * else and will not navigate a sub-menu — and a tree makes every screen and
 * every engine path harder for no gain. `repeat` covers the one nesting case
 * that matters.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.CAMPAIGNS_DIR || path.join(__dirname, '../../data');
const FILE = path.join(DIR, 'ivr-flows.json');
const newId = () => crypto.randomBytes(6).toString('hex');

/**
 * What a key can do when pressed.
 *
 * Every one of these ends the IVR except `repeat`, which is the only way back
 * to the menu. That is intentional: a menu you cannot leave is a menu that
 * burns trunk minutes.
 */
const ACTIONS = {
  transfer: {
    label: 'Transfer to an agent',
    help: 'Sends the call to the active server’s route number; the queue picks the agent.',
    hold: true,          // uses hold audio + how long to wait
  },
  optout: {
    label: 'Opt out (add to DNC)',
    help: 'Never dial this number again, on any campaign.',
  },
  remove: {
    label: 'Remove from this list',
    help: 'Drops the lead from this list only. Other campaigns may still reach them.',
  },
  hangup: {
    label: 'Play audio and hang up',
    help: 'For “not interested” or an information-only option.',
  },
  repeat: {
    label: 'Replay the menu',
    help: 'Counts towards the invalid-press limit, so it cannot loop forever.',
  },
};

const DEFAULT_FLOW = {
  name: '',
  description: '',
  greetingAudio: '',
  keys: [],
  invalidAudio: '',          // "that was not a valid option"
  maxInvalid: 3,             // wrong presses allowed before giving up
  // Nobody who intends to press 1 takes thirty seconds to do it, and every
  // second of silence is a trunk channel held open. Existing flows keep
  // whatever they were saved with.
  timeoutSeconds: 8,         // silence after the menu before it counts as no input
  noInputAudio: '',          // played when the timeout expires
  maxNoInput: 2,             // how many silent rounds before giving up
  exitAudio: '',             // the last thing they hear before the hangup
};

const DEFAULT_KEY = {
  key: '',
  label: '',
  audio: '',
  action: 'hangup',
  holdAudio: '',
  holdSeconds: 30,
};

function ensure() { fs.mkdirSync(DIR, { recursive: true }); }

function readAll() {
  ensure();
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return []; }
}

function writeAll(listArr) {
  ensure();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(listArr, null, 2));
  fs.renameSync(tmp, FILE);
  return listArr;
}

const list = () => readAll();
const get = (id) => readAll().find((f) => f.id === id) || null;

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Keys arrive from the form as parallel arrays (key[], audio[], action[]...),
 * which is how a browser posts a repeating row. Rows with no digit are blank
 * rows the user added and never filled in; drop them rather than erroring.
 */
function parseKeys(data) {
  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const digits = asArray(data['key[]'] || data.key);
  const labels = asArray(data['keyLabel[]'] || data.keyLabel);
  const audios = asArray(data['keyAudio[]'] || data.keyAudio);
  const actions = asArray(data['keyAction[]'] || data.keyAction);
  const holdA = asArray(data['keyHoldAudio[]'] || data.keyHoldAudio);
  const holdS = asArray(data['keyHoldSeconds[]'] || data.keyHoldSeconds);

  const out = [];
  const seen = new Set();
  for (let i = 0; i < digits.length; i++) {
    const key = String(digits[i] || '').trim().slice(0, 1);
    if (!key) continue;
    if (seen.has(key)) continue;              // last one wins would hide a mistake
    seen.add(key);
    const action = ACTIONS[actions[i]] ? actions[i] : 'hangup';
    out.push({
      ...DEFAULT_KEY,
      key,
      label: String(labels[i] || '').trim().slice(0, 40),
      audio: String(audios[i] || '').trim(),
      action,
      holdAudio: action === 'transfer' ? String(holdA[i] || '').trim() : '',
      holdSeconds: action === 'transfer' ? clamp(holdS[i], 5, 300, 30) : 30,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function save(data) {
  const all = readAll();
  const clean = {
    name: String(data.name || '').trim() || 'Untitled IVR',
    description: String(data.description || '').trim().slice(0, 200),
    greetingAudio: String(data.greetingAudio || '').trim(),
    keys: parseKeys(data),
    invalidAudio: String(data.invalidAudio || '').trim(),
    maxInvalid: clamp(data.maxInvalid, 1, 10, 3),
    timeoutSeconds: clamp(data.timeoutSeconds, 5, 120, 8),
    noInputAudio: String(data.noInputAudio || '').trim(),
    maxNoInput: clamp(data.maxNoInput, 1, 5, 2),
    exitAudio: String(data.exitAudio || '').trim(),
  };

  const existing = data.id ? all.find((f) => f.id === data.id) : null;
  if (existing) {
    Object.assign(existing, clean);
    existing.updatedAt = new Date().toISOString();
  } else {
    all.push({
      id: newId(), ...clean,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  writeAll(all);
  return all;
}

function remove(id) {
  writeAll(readAll().filter((f) => f.id !== id));
  return readAll();
}

/** Copy a flow — the usual way a second script starts. */
function duplicate(id) {
  const all = readAll();
  const src = all.find((f) => f.id === id);
  if (!src) return all;
  all.push({
    ...JSON.parse(JSON.stringify(src)),
    id: newId(),
    name: `${src.name} (copy)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return writeAll(all);
}

/**
 * Problems that would show up as a silent or looping call, named before the
 * flow is ever dialled.
 */
function validate(flow) {
  const out = [];
  if (!flow) return ['no IVR flow'];
  if (!flow.greetingAudio) out.push('a greeting — the menu itself');
  if (!flow.keys.length) out.push('at least one key');

  const transfers = flow.keys.filter((k) => k.action === 'transfer');
  if (flow.keys.length && !transfers.length) {
    out.push('a key that transfers to an agent (otherwise no lead can ever reach one)');
  }
  for (const k of flow.keys) {
    if (!k.audio && k.action !== 'repeat') {
      out.push(`audio for key ${k.key} — the lead would hear silence after pressing it`);
    }
  }
  if (flow.keys.every((k) => k.action === 'repeat')) {
    out.push('a key that ends the call — every key replays the menu');
  }
  if (!flow.exitAudio) out.push('exit audio, played before hanging up');
  return out;
}

/** One-line summary for the list view: "1 transfer · 2 opt out · 9 replay". */
function summarize(flow) {
  if (!flow.keys.length) return 'no keys';
  return flow.keys.map((k) => `${k.key} ${ACTIONS[k.action] ? ACTIONS[k.action].label.toLowerCase() : k.action}`)
    .join(' · ');
}

module.exports = {
  FILE, ACTIONS, DEFAULT_FLOW, DEFAULT_KEY,
  list, get, save, remove, duplicate, validate, summarize, parseKeys,
};
