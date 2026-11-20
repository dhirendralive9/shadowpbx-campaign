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
const calls = require('./calls');

const TICK_MS = 2000;
// Consecutive calls that never reached anyone before the campaign gives up.
// Low on purpose: these arrive within seconds of each other and every one is
// a call that did not happen.
const INFRA_FAIL_LIMIT = 10;

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
  const entry = rt.calls.get(phone);
  rt.calls.delete(phone);

  /**
   * A call that never happened must not cost the lead an attempt.
   *
   * The attempt is counted before dialling, deliberately, so a crash mid-call
   * cannot leave a number being redialled forever. The cost of that choice is
   * this: when the failure is OURS (ARI down, endpoint missing) or the
   * carrier's capacity (hangup cause 34 and friends), nobody's phone rang,
   * and charging the lead for it quietly destroys the list. ARI down for five
   * minutes at this concurrency burns thousands of numbers to their retry
   * limit, and they are then skipped forever.
   */
  if (job.failureKind) {
    if (entry) {
      leads.updateRow(c.leadListId, phone, {
        status: 'pending',
        attempts: entry.prevAttempts || 0,
        lastAttempt: entry.prevLastAttempt || null,
        outcome: '',
      });
    }
    const st = { ...c.stats };
    st.blocked = (st.blocked || 0) + 1;
    // Undo the optimistic increment too: it was not a dial.
    st.dialed = Math.max(0, (st.dialed || 0) - 1);
    st.lastFailure = job.result || '';
    campaigns.saveStats(c.id, st);

    rt.infraFails = (rt.infraFails || 0) + 1;
    rt.lastError = `${job.failureKind === 'infra' ? 'Infrastructure' : 'Carrier capacity'}: `
      + `${job.result || 'call could not be placed'} — the lead was not charged an attempt.`;

    // Stop rather than spin. At full concurrency a dead ARI produces hundreds
    // of these a minute, each one a log line and a wasted tick, and the
    // campaign looks busy while placing no calls at all.
    if (rt.infraFails >= INFRA_FAIL_LIMIT) {
      campaigns.setStatus(c.id, 'paused');
      rt.lastError = `Paused after ${rt.infraFails} calls failed before reaching anyone. `
        + `Last reason: ${job.result || 'unknown'}. No leads were charged an attempt. `
        + 'Fix the cause, then press Start.';
    }
    calls.record({
      startedAt: new Date(job.startedAt).toISOString(),
      endedAt: new Date(job.finishedAt || Date.now()).toISOString(),
      campaignId: c.id, campaignName: c.name, phone,
      outcome: 'blocked', connected: false,
      totalSeconds: ((job.finishedAt || Date.now()) - job.startedAt) / 1000,
      trunk: cfgTrunkName(c), attempt: (entry && entry.prevAttempts) || 0,
      hangupCause: job.hangupCause, result: job.result || '', jobId: job.id,
    });
    return;
  }
  // A real conversation resets the breaker.
  rt.infraFails = 0;

  const path = (job.path || []).join(' → ');
  const transferred = path.includes('transfer') && job.ok;
  const optedOut = path.includes('optout');
  const machine = path.includes('machine');
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

  // Classify by what actually happened on the call. Lumping failures in with
  // "no keypress" hides the difference between a campaign nobody is
  // interested in and a campaign whose calls are not connecting at all --
  // which look identical on a dashboard and could not be more different.
  const st = { ...c.stats };
  // Answered is the honest test of "connected": the channel entered Stasis,
  // so the far end picked up. Audio and keypresses are evidence too, but they
  // come later and can fail for their own reasons -- a call where the prompt
  // could not be played still reached a person.
  const connected = !!(job.answeredAt || job.heardAudio || (job.digits && job.digits.length));
  if (job.heardAudio) st.heardPrompt = (st.heardPrompt || 0) + 1;

  if (transferred) st.confirmed = (st.confirmed || 0) + 1;
  else if (machine) st.machines = (st.machines || 0) + 1;
  else if (optedOut) st.optedOut = (st.optedOut || 0) + 1;
  else if (!connected) st.failed = (st.failed || 0) + 1;
  else if (job.digits && job.digits.length) st.answered = (st.answered || 0) + 1;
  else st.noKeypress = (st.noKeypress || 0) + 1;

  // Keep the reason for the last few failures: "50 failed" is not actionable,
  // "50 failed: hangup cause 21, call rejected" is.
  if (!connected && !machine) {
    st.lastFailure = job.result || '';
    leads.updateRow(c.leadListId, phone, { outcome: job.result || 'did not connect' });
  }
  campaigns.saveStats(c.id, st);

  // One line in the campaign's CDR. The aggregate above says how the campaign
  // is doing; this says what happened to THIS number, which is the only thing
  // that can answer a dispute or explain an afternoon of failures.
  const outcome = transferred ? 'transferred'
    : machine ? 'machine'
    : optedOut ? 'opted-out'
    : removed ? 'removed'
    : path.includes('noagent') || path.includes('busy') ? 'no-agent'
    : !job.answeredAt ? (job.hangupCause ? 'failed' : 'no-answer')
    : connected ? 'no-keypress'
    : 'failed';

  const endMs = job.finishedAt || Date.now();
  calls.record({
    startedAt: new Date(job.startedAt).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    campaignId: c.id,
    campaignName: c.name,
    phone,
    outcome,
    connected,
    heardAudio: !!job.heardAudio,
    transferred,
    digits: job.digits || [],
    // Talk time starts when the lead picks up; ring time is not talk time and
    // conflating them makes every report overstate engagement.
    talkSeconds: job.answeredAt ? (endMs - job.answeredAt) / 1000 : 0,
    totalSeconds: (endMs - job.startedAt) / 1000,
    trunk: cfgTrunkName(c),
    route: job.routeNumber || '',
    attempt: (leads.readRows(c.leadListId).find((r) => r.phone === phone) || {}).attempts || 1,
    hangupCause: job.hangupCause,
    result: job.result || '',
    path: job.path || [],
    jobId: job.id,
  });
}

/** Trunk name for the record, without blowing up if settings moved underneath. */
function cfgTrunkName(c) {
  try {
    const t = (store.load().trunks || []).find((x) => x.id === c.trunkId);
    return t ? t.name : '';
  } catch (e) { return ''; }
}

function placeCall(c, rt, lead, cfg, delayMs = 0) {
  // Reserve the slot NOW even when the dial itself is held back for pacing.
  // The next tick excludes whatever is in rt.calls; a lead that is scheduled
  // but not yet reserved would be picked up again and dialled twice.
  rt.calls.set(lead.phone, {
    state: delayMs > 0 ? 'queued' : 'dialing',
    // Reserved now; the clock starts when it actually dials. Timing them from
    // reservation made every call in a batch report an identical age, which
    // hid whether the pacing was doing anything at all.
    queuedAt: nowSec(),
    startedAt: delayMs > 0 ? null : nowSec(),
    jobId: null,
  });

  if (delayMs > 0) {
    setTimeout(() => {
      // Conditions change while a call waits its turn: the campaign may have
      // been paused or stopped, or the slot released by a sweep.
      const live = campaigns.get(c.id);
      if (!live || live.status !== 'running' || !rt.calls.has(lead.phone)) {
        rt.calls.delete(lead.phone);
        return;
      }
      const e = rt.calls.get(lead.phone);
      if (e) { e.state = 'dialing'; e.startedAt = nowSec(); }
      dialNow(live, rt, lead, cfg);
    }, delayMs);
    return;
  }
  dialNow(c, rt, lead, cfg);
}

function dialNow(c, rt, lead, cfg) {
  rt.hourWindow.push(nowSec());
  // Keep the last few seconds of dial times so the dashboard can report the
  // rate actually achieved, not the one configured.
  if (!rt.dialLog) rt.dialLog = [];
  rt.dialLog.push(Date.now());
  if (rt.dialLog.length > 200) rt.dialLog = rt.dialLog.slice(-100);

  // Count the attempt before the call, not after: a crash mid-call must not
  // leave a lead that gets dialled forever.
  const row = leads.readRows(c.leadListId).find((r) => r.phone === lead.phone);
  const prevAttempts = (row && row.attempts) || 0;
  const prevLastAttempt = (row && row.lastAttempt) || null;
  leads.updateRow(c.leadListId, lead.phone, {
    status: 'calling',
    attempts: prevAttempts + 1,
    lastAttempt: new Date().toISOString(),
  });
  // Kept so the attempt can be handed back if the call turns out never to
  // have been placed -- see recordOutcome.
  const held = rt.calls.get(lead.phone);
  if (held) { held.prevAttempts = prevAttempts; held.prevLastAttempt = prevLastAttempt; }
  // Persist immediately: recordOutcome re-reads the campaign from disk, so an
  // increment held only in this copy is thrown away when the call ends. That
  // is how a dashboard ends up reporting 0 dialled and 50 outcomes.
  campaigns.saveStats(c.id, { dialed: (c.stats.dialed || 0) + 1 });
  c.stats.dialed = (c.stats.dialed || 0) + 1;

  try {
    const job = testcall.start({
      number: lead.phone,
      endpoint: `PJSIP/trunk-${cfg.trunk.id}`,
      numberFormat: cfg.trunk.numberFormat,
      callerId: (cfg.trunk.callerId || '').replace(/[^\d]/g, ''),
      mode: 'flow',
      flow: cfg.flow,
      label: c.name,
      serverEndpoint: `PJSIP/server-${cfg.server.id}`,
      routeNumber: cfg.server.routeNumber,
      agentRingSeconds: c.ivr.agentRingSeconds,
      detectMachines: !!c.ivr.detectMachines,
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
    // No job behind the call at all: it was reaped, or the service restarted
    // mid-call. Either way nothing will ever report an outcome for it, so the
    // slot has to be released or concurrency bleeds away one call at a time
    // until the campaign dials nothing and reports no error.
    if (!job) {
      if (entry.jobId && Date.now() - (entry.startedAt || 0) > 5000) rt.calls.delete(phone);
      continue;
    }
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
  /**
   * Spread the batch across time instead of firing it in one instant.
   *
   * A tick could previously place its whole allowance at once -- forty calls
   * in the same millisecond. Carriers rate-limit on calls per SECOND, so a
   * burst like that blows through a 10 CPS allowance four times over and the
   * surplus comes back 503 / hangup cause 34. From this side that is
   * indistinguishable from congestion or a broken trunk, which is exactly how
   * it was being read.
   *
   * Slots are handed out from a running cursor so the spacing holds ACROSS
   * ticks too, not just within one: ten calls at the end of one tick and ten
   * at the start of the next is still twenty in a second.
   */
  // A missing value must mean "the default", not "uncapped": reading an absent
  // limit as no limit is how a rate limit quietly stops existing.
  const cps = c.pacing.callsPerSecond == null
    ? campaigns.DEFAULT_PACING.callsPerSecond : c.pacing.callsPerSecond;
  const spacing = cps > 0 ? 1000 / cps : 0;
  const now = Date.now();
  if (rt.nextSlotAt == null || rt.nextSlotAt < now) rt.nextSlotAt = now;

  for (const lead of due) {
    if (!spacing) { placeCall(c, rt, lead, cfg); continue; }
    const at = rt.nextSlotAt;
    rt.nextSlotAt = at + spacing;
    placeCall(c, rt, lead, cfg, Math.max(0, at - now));
  }
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
    // Which numbers are up right now and what each one is doing. The counters
    // say how many; watching a campaign means wanting to see which.
    liveCalls: [...rt.calls.entries()].map(([phone, e]) => ({
      phone,
      state: e.state || 'dialing',
      seconds: Math.max(0, Math.round(
        (Date.now() - (e.startedAt || e.queuedAt || Date.now())) / 1000)),
    })).sort((a, b) => b.seconds - a.seconds),
    // So the configured rate can be checked against reality rather than
    // assumed, which is what let a silently-ignored limit run for a day.
    cps: c ? (c.pacing.callsPerSecond == null
      ? campaigns.DEFAULT_PACING.callsPerSecond : c.pacing.callsPerSecond) : 0,
    dialedLastSecond: rt.dialLog
      ? rt.dialLog.filter((t) => Date.now() - t < 1000).length : 0,
    placedThisHour: placedThisHour(rt),
    agentsAvailable: ag && ag.fresh ? ag.available : 0,
    agentsTotal: ag ? ag.total : 0,
    agentsFresh: !!(ag && ag.fresh),
    agentsOnCall: ag && ag.agents ? ag.agents.filter((a) => a.status === 'busy').length : 0,
    remaining: c && c.leadListId ? leads.remaining(c.leadListId, c.pacing.retryAttempts) : 0,
    stats: c ? c.stats : null,
    // The dashboard needs the PBX's own words when the feed goes quiet;
    // "no agents free" and "the API key was rejected" are not the same problem.
    note: rt.lastError || '',
    agentNote: ag && !ag.fresh ? (ag.error || ag.reason || 'no data from the PBX yet') : '',
    agentAgeMs: ag ? ag.ageMs : null,
    agentTransport: ag ? ag.transport : 'none',
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
