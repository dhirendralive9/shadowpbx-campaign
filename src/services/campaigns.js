'use strict';
/**
 * Campaigns — the thing that ties everything together.
 *
 * A campaign binds a trunk (who we dial through), a server (where confirmed
 * leads go), a lead list (who we call) and a full IVR flow (what they hear at
 * each step). Stored separately from settings so a campaign can be copied or
 * deleted without touching infrastructure config.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.CAMPAIGNS_DIR || path.join(__dirname, '../../data');
const FILE = path.join(DIR, 'campaigns.json');
const newId = () => crypto.randomBytes(6).toString('hex');

/**
 * The IVR flow, step by step:
 *
 *   dial -> answered -> greetingAudio ...... "press 1 if interested"
 *        -> no key, replay up to maxGreetings, then rejectAudio + hang up
 *        -> opt-out key           -> declineAudio, add to DNC, hang up
 *        -> confirm key           -> confirmAudio ("connecting you")
 *                                 -> holdAudio while the agent leg rings
 *                                 -> bridged to agent
 *        -> no agent free         -> busyAudio, lead retried later
 */
const DEFAULT_IVR = {
  greetingAudio: '',        // required — the main prompt
  confirmAudio: '',         // after pressing 1, before bridging
  holdAudio: '',            // loops while the agent's phone rings
  declineAudio: '',         // on opt-out
  rejectAudio: '',          // after the last greeting with no keypress
  busyAudio: '',            // confirmed but no agent free
  confirmKey: '1',
  optOutKey: '2',
  maxGreetings: 2,
  waitSeconds: 8,
  agentRingSeconds: 30,
};

const DEFAULT_PACING = {
  // 'power'      — one call per free agent; nobody waits, nobody is abandoned
  // 'predictive' — more calls than agents, betting most will not answer
  strategy: 'power',
  linesPerAgent: 1,         // >1 = predictive overdial
  maxConcurrent: 5,
  retryAttempts: 1,
  retryDelayMinutes: 60,
  callsPerHourCap: 0,       // 0 = uncapped
};

function ensure() { fs.mkdirSync(DIR, { recursive: true }); }

function readAll() {
  ensure();
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return []; }
}
function writeAll(list) {
  ensure();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
  return list;
}

const list = () => readAll();
const get = (id) => readAll().find((c) => c.id === id) || null;

function save(data) {
  const all = readAll();
  const clean = {
    name: (data.name || '').trim() || 'Untitled campaign',
    trunkId: data.trunkId || '',
    serverId: data.serverId || '',
    leadListId: data.leadListId || '',
    // The script lives in an IVR flow now: reusable across campaigns, and
    // edited in one place. The inline fields below are kept so campaigns saved
    // before flows existed still load.
    ivrFlowId: data.ivrFlowId || '',
    ivr: {
      ...DEFAULT_IVR,
      greetingAudio: data.greetingAudio || '',
      confirmAudio: data.confirmAudio || '',
      holdAudio: data.holdAudio || '',
      declineAudio: data.declineAudio || '',
      rejectAudio: data.rejectAudio || '',
      busyAudio: data.busyAudio || '',
      confirmKey: (data.confirmKey || '1').trim().slice(0, 1),
      optOutKey: (data.optOutKey || '2').trim().slice(0, 1),
      maxGreetings: clamp(data.maxGreetings, 1, 5, 2),
      waitSeconds: clamp(data.waitSeconds, 3, 30, 8),
      agentRingSeconds: clamp(data.agentRingSeconds, 10, 120, 30),
    },
    pacing: {
      ...DEFAULT_PACING,
      strategy: data.strategy === 'predictive' ? 'predictive' : 'power',
      // Power dialling is one line per agent by definition; letting the field
      // disagree with the strategy is how a "safe" campaign quietly overdials.
      linesPerAgent: data.strategy === 'predictive'
        ? clamp(data.linesPerAgent, 1, 10, 2) : 1,
      maxConcurrent: clamp(data.maxConcurrent, 1, 200, 5),
      retryAttempts: clamp(data.retryAttempts, 0, 5, 1),
      retryDelayMinutes: clamp(data.retryDelayMinutes, 5, 1440, 60),
      callsPerHourCap: clamp(data.callsPerHourCap, 0, 100000, 0),
    },
  };

  const existing = data.id ? all.find((c) => c.id === data.id) : null;
  if (existing) {
    Object.assign(existing, clean);
    existing.updatedAt = new Date().toISOString();
  } else {
    all.push({
      id: newId(), ...clean,
      status: 'idle',
      stats: { dialed: 0, answered: 0, heardPrompt: 0, confirmed: 0, noKeypress: 0, optedOut: 0, failed: 0 },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  writeAll(all);
  return all;
}

function clamp(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function remove(id) {
  writeAll(readAll().filter((c) => c.id !== id));
  return { ok: true };
}

/** Persist counters without rewriting the rest of the campaign. */
function saveStats(id, stats) {
  const all = readAll();
  const c = all.find((x) => x.id === id);
  if (!c) return null;
  c.stats = { ...c.stats, ...stats };
  writeAll(all);
  return c;
}

function setStatus(id, status) {
  const all = readAll();
  const c = all.find((x) => x.id === id);
  if (c) { c.status = status; c.updatedAt = new Date().toISOString(); writeAll(all); }
  return c;
}

/** What's stopping this campaign from running. */
function validate(c, settings, leadLists) {
  const out = [];
  if (!c.trunkId || !(settings.trunks || []).some((t) => t.id === c.trunkId)) out.push('a trunk');
  if (!c.serverId || !(settings.servers || []).some((s) => s.id === c.serverId)) out.push('a server');
  if (!c.leadListId || !(leadLists || []).some((l) => l.id === c.leadListId)) out.push('a lead list');
  if (!c.ivrFlowId) out.push('an IVR flow');
  const ll = (leadLists || []).find((l) => l.id === c.leadListId);
  if (ll && ll.total === 0) out.push('leads in the selected list');
  return out;
}

module.exports = {
  FILE, list, get, save, remove, setStatus, saveStats, validate,
  DEFAULT_IVR, DEFAULT_PACING,
};
