'use strict';
/**
 * The dialler — the loop that turns a configured campaign into calls.
 *
 * Pacing is the whole job, and it is governed by one number that does not come
 * from here: how many agents are free on the PBX right now. Dial more than
 * that and leads press 1 to reach nobody; dial fewer and the agents sit idle.
 *
 * Two rules the rest of the design follows from:
 *
 *   1. Stale agent data means stop. agents.availableNow() returns 0 when the
 *      figure is older than its freshness window, so a PBX that goes quiet
 *      pauses the campaign instead of letting it run blind.
 *   2. In-flight calls are counted, never inferred. Every call this engine
 *      places is tracked until it ends, because "how many are live" decided
 *      from statistics rather than facts is how diallers abandon calls.
 */
const campaigns = require('./campaigns');
const leads = require('./leads');
const ivrFlows = require('./ivr');
const store = require('./settings');
const agents = require('./agents');
const testcall = require('./testcall');

const TICK_MS = 2000;

// campaignId -> runtime state. Nothing here survives a restart: a campaign is
// resumed deliberately, not silently, because nobody wants a dialler that
// starts calling on its own after a deploy.
const live = new Map();

function runtime(id) {
  if (!live.has(id)) {
    live.set(id, {
      calls: new Map(),          // phone -> { state, startedAt, jobId }
      hourWindow: [],            // timestamps, for the per-hour cap
      lastError: '',
      startedAt: null,
      timer: null,
    });
  }
  return live.get(id);
}

const nowSec = () => Date.now();

/** Calls placed in the last hour — the cap is a rolling window, not a clock hour. */
function placedThisHour(rt) {
  const cutoff = nowSec() - 3600000;
  rt.hourWindow = rt.hourWindow.filter((t) => t > cutoff);
  return rt.hourWindow.length;
}

function countByState(rt, state) {
  let n = 0;
  for (const c of rt.calls.values()) if (c.state === state) n += 1;
  return n;
}

/**
 * How many new calls may be placed this tick.
 *
 * linesPerAgent above 1 is overdial: deliberately calling more people than
 * there are agents, betting that most will not answer. It is also exactly how
 * a campaign ends up with a confirmed lead and no one to take them, so the
 * engine still refuses to exceed maxConcurrent.
 */
function capacity(c, rt) {
  const free = agents.availableNow(c.serverId);
  if (!free) return { n: 0, why: 'no agents free (or the PBX stopped reporting)' };

  const allowed = Math.max(0, Math.min(
    free * (c.pacing.linesPerAgent || 1),
    c.pacing.maxConcurrent || 1,
  ) - rt.calls.size);

  if (!allowed) return { n: 0, why: `at capacity (${rt.calls.size} live)` };

  const cap = c.pacing.callsPerHourCap || 0;
  if (cap) {
    const room = cap - placedThisHour(rt);
    if (room <= 0) return { n: 0, why: `hourly cap of ${cap} reached` };
    return { n: Math.min(allowed, room), why: '' };
  }
  return { n: allowed, why: '' };
}

/** What a finished call means for the lead and the campaign's counters. */
function recordOutcome(c, rt, phone, job) {
  rt.calls.delete(phone);

  const path = (job.path || []).join(' → ');
  const transferred = path.includes('transfer') && job.ok;
  const optedOut = path.includes('optout');
  const removed = path.includes('remove');

  let status = 'called';
  if (transferred) status = 'done';
  else if (optedOut) status = 'dnc';
  else if (removed) status = 'removed';

  leads.updateRow(c.leadListId, phone, {
    status,
    attempts: (leads.readRows(c.leadListId).find((r) => r.phone === phone) || {}).attempts || 1,
    outcome: job.result || '',
    lastAttempt: new Date().toISOString(),
  });

  const st = c.stats;
  if (job.heardAudio) st.heardPrompt += 1;
  if (transferred) st.confirmed += 1;
  else if (optedOut) st.optedOut += 1;
  else if (job.digits && job.digits.length) st.answered += 1;
  else st.noKeypress += 1;
  campaigns.saveStats(c.id, st);
}

function placeCall(c, rt, lead, cfg) {
  rt.calls.set(lead.phone, { state: 'dialing', startedAt: nowSec(), jobId: null });
  rt.hourWindow.push(nowSec());

  // Count the attempt before the call, not after: a crash mid-call must not
  // leave a lead that gets dialled forever.
  const row = leads.readRows(c.leadListId).find((r) => r.phone === lead.phone);
  leads.updateRow(c.leadListId, lead.phone, {
    status: 'calling',
    attempts: ((row && row.attempts) || 0) + 1,
    lastAttempt: new Date().toISOString(),
  });
  c.stats.dialed += 1;

  try {
    const job = testcall.start({
      number: lead.phone,
      endpoint: `PJSIP/trunk-${cfg.trunk.id}`,
      callerId: (cfg.trunk.callerId || '').replace(/[^\d]/g, ''),
      mode: 'flow',
      flow: cfg.flow,
      label: c.name,
      serverEndpoint: `PJSIP/server-${cfg.server.id}`,
      routeNumber: cfg.server.routeNumber,
      agentRingSeconds: c.ivr.agentRingSeconds,
      sound: cfg.flow.greetingAudio,
      meta: { campaignId: c.id, phone: lead.phone },
      onFinish: (finished) => {
        const current = campaigns.get(c.id) || c;
        recordOutcome(current, rt, lead.phone, finished);
      },
    });
    const entry = rt.calls.get(lead.phone);
    if (entry) entry.jobId = job.id;
  } catch (e) {
    rt.calls.delete(lead.phone);
    rt.lastError = e.message;
  }
}

/** Everything a campaign needs before it can dial, or why it cannot. */
function resolve(c) {
  const s = store.load();
  const trunk = (s.trunks || []).find((t) => t.id === c.trunkId);
  const server = (s.servers || []).find((x) => x.id === c.serverId);
  const flow = c.ivrFlowId ? ivrFlows.get(c.ivrFlowId) : null;
  const problems = [];
  if (!trunk) problems.push('its trunk is gone');
  if (!server) problems.push('its server is gone');
  if (!flow) problems.push('its IVR flow is gone');
  if (!c.leadListId || !leads.get(c.leadListId)) problems.push('its lead list is gone');
  if (flow) {
    const gaps = ivrFlows.validate(flow);
    if (gaps.length) problems.push(`the IVR flow still needs ${gaps.join('; ')}`);
  }
  if (!server || !server.routeNumber) problems.push('the server has no route number');
  return { trunk, server, flow, problems };
}

function tick(id) {
  const c = campaigns.get(id);
  const rt = runtime(id);
  if (!c || c.status !== 'running') return;

  const cfg = resolve(c);
  if (cfg.problems.length) {
    rt.lastError = `Paused: ${cfg.problems.join(', ')}.`;
    campaigns.setStatus(id, 'paused');
    return;
  }

  // Sync live-call states from the jobs themselves, so the dashboard shows
  // what is actually happening rather than what we last assumed.
  for (const [phone, entry] of rt.calls) {
    const job = entry.jobId ? testcall.get(entry.jobId) : null;
    if (!job) continue;
    entry.state = job.finished ? 'done' : (job.state || entry.state);
    // A job that finished without onFinish firing (process restart, say)
    // would otherwise hold a slot forever.
    if (job.finished && Date.now() - job.startedAt > 5000) rt.calls.delete(phone);
  }

  const { n, why } = capacity(c, rt);
  rt.lastError = why;
  if (n <= 0) return;

  const due = leads.dueRows(c.leadListId, {
    retryAttempts: c.pacing.retryAttempts,
    retryDelayMinutes: c.pacing.retryDelayMinutes,
    limit: n,
    exclude: new Set(rt.calls.keys()),
  });

  if (!due.length) {
    if (!rt.calls.size) {
      rt.lastError = 'No leads left to dial.';
      campaigns.setStatus(id, 'done');
    }
    return;
  }
  for (const lead of due) placeCall(c, rt, lead, cfg);
}

// ------------------------------------------------------------------ api
function start(id) {
  const c = campaigns.get(id);
  if (!c) return { ok: false, error: 'No such campaign' };
  const cfg = resolve(c);
  if (cfg.problems.length) {
    return { ok: false, error: `Cannot start: ${cfg.problems.join(', ')}.` };
  }
  const rt = runtime(id);
  rt.startedAt = rt.startedAt || new Date().toISOString();
  rt.lastError = '';
  campaigns.setStatus(id, 'running');
  if (!rt.timer) rt.timer = setInterval(() => tick(id), TICK_MS);
  tick(id);
  return { ok: true, message: `${c.name} is running.` };
}

/** Pause: place no new calls, let the ones in progress finish. */
function pause(id) {
  const rt = runtime(id);
  if (rt.timer) { clearInterval(rt.timer); rt.timer = null; }
  campaigns.setStatus(id, 'paused');
  return { ok: true, message: 'Paused — calls already in progress will finish.' };
}

/** Stop: pause, and hang up everything still live. */
async function stop(id) {
  const rt = runtime(id);
  if (rt.timer) { clearInterval(rt.timer); rt.timer = null; }
  campaigns.setStatus(id, 'stopped');
  let dropped = 0;
  for (const [phone, entry] of rt.calls) {
    const job = entry.jobId ? testcall.get(entry.jobId) : null;
    if (job && !job.finished) { await testcall.hangup(job.id).catch(() => {}); dropped += 1; }
    rt.calls.delete(phone);
  }
  return { ok: true, message: dropped ? `Stopped — ${dropped} call(s) dropped.` : 'Stopped.' };
}

/** What the dashboard reads. */
function status(id) {
  const c = campaigns.get(id);
  const rt = runtime(id);
  const ag = c ? agents.status(c.serverId) : null;
  const byState = {};
  for (const call of rt.calls.values()) byState[call.state] = (byState[call.state] || 0) + 1;

  return {
    id,
    status: c ? c.status : 'missing',
    live: rt.calls.size,
    dialing: countByState(rt, 'dialing') + countByState(rt, 'ringing'),
    greeting: countByState(rt, 'greeting') + countByState(rt, 'playing'),
    awaitingKey: countByState(rt, 'awaiting-key') + countByState(rt, 'key'),
    ringingAgent: countByState(rt, 'ringing-agent'),
    bridged: countByState(rt, 'bridged'),
    byState,
    placedThisHour: placedThisHour(rt),
    agentsAvailable: ag && ag.fresh ? ag.available : 0,
    agentsTotal: ag ? ag.total : 0,
    agentsFresh: !!(ag && ag.fresh),
    agentsOnCall: ag && ag.agents ? ag.agents.filter((a) => a.status === 'busy').length : 0,
    remaining: c && c.leadListId ? leads.remaining(c.leadListId, c.pacing.retryAttempts) : 0,
    stats: c ? c.stats : null,
    note: rt.lastError || '',
    startedAt: rt.startedAt,
  };
}

/** Called at boot: nothing resumes by itself. */
function haltAll() {
  for (const [id, rt] of live) {
    if (rt.timer) clearInterval(rt.timer);
    rt.timer = null;
    const c = campaigns.get(id);
    if (c && c.status === 'running') campaigns.setStatus(id, 'paused');
  }
}

module.exports = { start, pause, stop, status, resolve, capacity, haltAll };
