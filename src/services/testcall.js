'use strict';
/**
 * Per-trunk test call.
 *
 * Answers the only question that matters before a campaign is worth building:
 * does this trunk actually place a call, does the audio reach the person's ear,
 * and does a keypress come back? Each of those three has failed independently
 * in the past -- a trunk that registers but rejects the INVITE, a prompt that
 * plays as silence because the codec was wrong, a DTMF digit the carrier never
 * forwards -- and none of them is visible from a status page.
 *
 * Runs over ARI rather than `channel originate`, because the CLI can tell you
 * the call was placed and nothing more: no answer event, no playback result, no
 * digits. ARI is also what the campaign engine will use, so a passing test here
 * exercises the real path rather than an approximation of it.
 *
 * A job is kept in memory with a timeline the UI polls. Nothing is persisted:
 * these are throwaway diagnostics.
 */
const ari = require('ari-client');
const crypto = require('crypto');

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ARI_USER || 'campaign';
const ARI_PASS = process.env.ARI_PASS;
const ARI_APP = process.env.ARI_APP || 'shadowpbx-campaign';

const jobs = new Map();

/**
 * Build the dial string ARI needs for a PJSIP trunk.
 *
 * Asterisk reads `PJSIP/<endpoint>/<x>` as "endpoint, then AOR or sip: URI", so
 * `PJSIP/trunk-abc/15551234567` looks for an AOR *named* 15551234567 and the
 * call dies before any INVITE leaves. The trunk form is `PJSIP/<number>@<endpoint>`
 * -- the one `channel originate` was proven with against this carrier, E.164 with
 * a leading +.
 */
const NUMBER_PREFIX = { e164: '+', plain: '', intl: '00' };

function dialString(endpoint, number, format = 'e164') {
  const n = String(number).replace(/[^\d]/g, '');
  const m = /^PJSIP\/(.+)$/.exec(endpoint);
  if (!m) return `${endpoint}/${n}`;
  // A PSTN number needs whatever the carrier accepts -- +E.164, bare digits or
  // a 00 prefix -- and they disagree. An internal route number on the PBX must
  // go out exactly as dialled, because `+123456789012` matches no inbound
  // route, so that path passes 'plain'.
  const prefix = NUMBER_PREFIX[format] != null ? NUMBER_PREFIX[format] : '+';
  return `PJSIP/${prefix}${n}@${m[1]}`;
}
const newId = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
]);

// How many FINISHED jobs to keep for the UI to show. Live jobs are never
// counted against this.
const KEEP_FINISHED = 50;
// An unfinished job this old is not a call any more, it is a leak. Far longer
// than any real call, so a live one can never be caught by it.
const ABANDON_MS = 60 * 60 * 1000;

/**
 * Drop old jobs.
 *
 * A LIVE job must never be dropped. `onStasisStart` looks the job up by id the
 * moment the channel answers, and a missing entry makes it hang up on the lead
 * instantly -- and the dialler, finding no job behind the call, holds that
 * concurrency slot forever. This originally kept the newest 20 jobs full stop,
 * which was right when this was a one-call-at-a-time diagnostic and silently
 * wrong the moment a campaign ran more than 20 calls at once.
 */
function reap() {
  const now = Date.now();
  const done = [];
  for (const j of jobs.values()) {
    if (j.finished) done.push(j);
    else if (now - j.startedAt > ABANDON_MS) jobs.delete(j.id);
  }
  if (done.length <= KEEP_FINISHED) return;
  done.sort((a, b) => a.startedAt - b.startedAt);
  for (const j of done.slice(0, done.length - KEEP_FINISHED)) jobs.delete(j.id);
}

// ------------------------------------------------------------------ ARI
let clientP = null;

/**
 * Plain HTTP check of ARI before handing over to ari-client.
 *
 * ari-client fetches the API description with swagger-client, and when that
 * fetch fails swagger-client *throws from inside a callback*: no promise sees it,
 * nothing here can catch it, and the whole Node process dies -- which also wipes
 * the in-memory login sessions, so the UI shows a login page instead of an error.
 * Doing the same request ourselves first turns every one of those failures into
 * an ordinary message that names the thing to fix.
 */
async function preflight() {
  const auth = Buffer.from(`${ARI_USER}:${ARI_PASS}`).toString('base64');
  let r;
  try {
    r = await fetch(`${ARI_URL}/ari/api-docs/resources.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    const code = (e.cause && e.cause.code) || e.name;
    throw new Error(
      `nothing answered at ${ARI_URL} within 5s (${code}). `
      + (code === 'TimeoutError'
        ? 'Note that a timeout on a LOCALHOST request usually means this app was too busy to '
          + 'read the reply, not that Asterisk is down — check `systemctl status asterisk` and '
          + '`asterisk -rx "http show status"` before assuming the PBX is at fault. '
          + 'If both look healthy, this process was CPU-starved; lower the campaign concurrency.'
        : 'Asterisk\'s HTTP server is off or on another port: check /etc/asterisk/http.conf '
          + '(enabled=yes, bindaddr=127.0.0.1, bindport=8088), then run: '
          + 'asterisk -rx "http show status"'));
  }
  if (r.status === 401) {
    throw new Error(
      `ARI rejected the login "${ARI_USER}". ARI_PASS in .env must equal the password of `
      + `[${ARI_USER}] in /etc/asterisk/ari.conf. Check with: asterisk -rx "ari show users"`);
  }
  if (r.status === 404) {
    throw new Error(
      'the HTTP server is up but ARI is not loaded. Run: asterisk -rx "module show like res_ari" '
      + 'and make sure /etc/asterisk/ari.conf has enabled = yes.');
  }
  if (!r.ok) throw new Error(`ARI answered HTTP ${r.status} at ${ARI_URL}/ari/api-docs/resources.json`);
}

// After a connection failure, hold the error briefly instead of letting every
// waiting call re-run the preflight. At campaign concurrency a dropped ARI
// produces a hundred simultaneous connection attempts, each with its own 5s
// HTTP timeout, and the stampede keeps the event loop too busy to recover --
// the failure sustains itself.
const CONNECT_COOLDOWN_MS = 5000;
let lastFailure = null;                     // { at, error }

function connect() {
  if (!ARI_PASS) return Promise.reject(new Error('ARI_PASS is not set in .env'));
  if (clientP) return clientP;
  if (lastFailure && Date.now() - lastFailure.at < CONNECT_COOLDOWN_MS) {
    return Promise.reject(lastFailure.error);
  }
  clientP = preflight()
    .then(() => withTimeout(ari.connect(ARI_URL, ARI_USER, ARI_PASS), 15000, 'ARI did not respond within 15s'))
    .then(async (c) => {
      c.on('StasisStart', onStasisStart);
      // A dropped websocket must not leave a dead client cached, or every later
      // test fails with no way to recover short of restarting the service.
      c.on('WebSocketClose', () => { clientP = null; });
      c.on('WebSocketError', () => { clientP = null; });
      await withTimeout(c.start(ARI_APP), 15000, 'registering the ARI app timed out after 15s');
      lastFailure = null;
      return c;
    })
    .catch((e) => {
      clientP = null;
      const err = new Error(
        `Cannot reach ARI at ${ARI_URL} as "${ARI_USER}": ${e.message}. `
        + 'Check ari.conf and http.conf, and that ARI_PASS matches.'
      );
      lastFailure = { at: Date.now(), error: err };
      throw err;
    });
  return clientP;
}

function log(job, text, state) {
  if (job.finished) return;
  if (state) job.state = state;
  job.events.push({ at: Date.now() - job.startedAt, text });
  console.log(`[test ${job.id}] ${text}`);
}

function finish(job, ok, result) {
  if (job.finished) return;
  job.finished = true;
  job.finishedAt = Date.now();
  job.ok = ok;
  job.state = 'done';
  job.result = result;
  job.events.push({ at: Date.now() - job.startedAt, text: result });
  console.log(`[test ${job.id}] DONE ok=${ok}: ${result}`);
  if (job.onFinish) {
    // A throwing listener must not take the call handling with it.
    try { job.onFinish(job); } catch (e) { console.error(`[test ${job.id}] onFinish: ${e.message}`); }
  }
}

/**
 * The lead leg arrives here once the far end answers. appArgs carries the job
 * id, because several tests may be in flight and the channel is the only thing
 * tying an answer back to the request that caused it.
 */
async function onStasisStart(event, channel) {
  const client = await connect().catch(() => null);
  const args = event.args || [];

  // The agent leg of a flow test comes back into Stasis with its own args, so
  // it can be matched to the job that dialled it.
  if (args[0] === 'agent') {
    const owner = jobs.get(args[1]);
    if (!owner || owner.finished || !owner._onAgent) {
      try { await channel.hangup(); } catch (e) {}
      return;
    }
    return owner._onAgent(channel);
  }

  // The channel coming back from the AMD dialplan hop, carrying its verdict.
  if (args[0] === 'amd') {
    const owner = jobs.get(args[1]);
    if (!owner || owner.finished || !owner._onAmd) {
      try { await channel.hangup(); } catch (e) {}
      return;
    }
    return owner._onAmd(args[2] || 'NOTSURE', args[3] || '');
  }

  if (args[0] !== 'test') return;                 // not ours -- the engine's
  const job = jobs.get(args[1]);
  if (!job || job.finished) {
    try { await channel.hangup(); } catch (e) {}
    return;
  }

  job.channelId = channel.id;
  job.answeredAt = Date.now();
  log(job, 'Answered', 'answered');

  try {
    await channel.answer();
  } catch (e) {
    return finish(job, false, `Answer failed: ${e.message}`);
  }

  let handled = false;

  channel.on('ChannelDtmfReceived', async (evt) => {
    const d = evt.digit;
    log(job, `Keypress received: "${d}"`);
    job.digits.push(d);
    if (handled) return;
    if (d !== job.confirmKey && d !== job.optOutKey) return;
    handled = true;

    if (d === job.optOutKey) {
      try { await channel.hangup(); } catch (e) {}
      return finish(job, true, `Opt-out key "${d}" received. DTMF works on this trunk.`);
    }
    finish(job, true, `Confirm key "${d}" received. Trunk, audio and DTMF all work.`);
    await sleep(300);
    try { await channel.hangup(); } catch (e) {}
  });

  channel.on('ChannelDestroyed', () => {
    if (handled) return;

    // A route test asks one question: did the call reach a person? It did --
    // the channel answered. Whether they listened to the whole message is not
    // the test, and hanging up mid-prompt is what anyone does once they
    // realise it is a test call. Judging it by the trunk test's rule (audio
    // must finish) reports a working route as broken.
    if (job.mode === 'answer') {
      return finish(job, true,
        `Answered${job.label ? ` via ${job.label}` : ''}, then hung up during the message. `
        + 'The PBX accepted the call on this route and someone picked it up — press-1 transfers '
        + 'will land the same way.');
    }

    finish(job, job.heardAudio, job.heardAudio
      ? 'Call ended with no keypress. Audio played, so the trunk and sound file are fine — '
        + 'either nobody pressed a key, or this carrier is not passing DTMF through.'
      : 'Call ended before the audio finished playing.');
  });

  if (job.mode === 'flow') {
    channel.on('ChannelDtmfReceived', (evt) => {
      job.digits.push(evt.digit);
      job._queue.push(evt.digit);
    });
    handled = true;                               // the runner owns the call now

    if (job.detectMachines) {
      const verdict = await runAmd(job, channel);
      job.amdStatus = verdict;
      log(job, `Answering-machine check: ${verdict}${job.amdCause ? ` (${job.amdCause})` : ''}`);
      if (job.finished) return;                   // they hung up during analysis
      if (verdict === 'MACHINE') {
        job.path.push('machine');
        try { await channel.hangup(); } catch (e) {}
        return finish(job, false,
          'Answering machine detected — hung up without playing the prompt.');
      }
    }

    await runFlow(job, channel, client);
    return;
  }

  if (job.mode === 'echo') {
    // Hand the channel to the dialplan and get out of the way: Stasis has no
    // echo of its own, and ARI cannot loop a channel's media back to itself.
    // The job finishes here while the call carries on -- the person on the
    // agent phone is the instrument now.
    log(job, `Answered — playing ${job.sound}, then echo`, 'playing');
    try {
      // The dialplan plays this before the beep: whoever picked up hears what
      // the call is for, rather than a bare tone.
      await channel.setChannelVar({ variable: 'CAMPAIGN_PROMPT', value: job.sound });
      await channel.continueInDialplan({ context: 'campaign-echo', extension: 's', priority: 1 });
    } catch (e) {
      handled = true;
      return finish(job, false,
        `Could not start the echo test: ${e.message}. Is the campaign-echo context in `
        + '/etc/asterisk/extensions.conf? Copy asterisk/extensions.conf and run '
        + '"asterisk -rx \'dialplan reload\'".');
    }
    handled = true;
    return finish(job, true,
      'Echo running on the agent phone. Speak into it: you should hear your own voice '
      + 'come back after a short delay. If you hear yourself, audio flows both ways on '
      + 'this route. If you hear nothing, audio is one-way — check RTP between the two '
      + 'servers. Hang up when done.');
  }

  if (job.mode === 'answer') {
    // The question a route test asks is "did this reach someone", so the answer
    // event already settles it. Play the audio anyway: whoever picked up should
    // hear why their phone rang, rather than silence.
    log(job, `Playing ${job.sound} for whoever answered`, 'playing');
    try {
      const pb = await channel.play({ media: `sound:${job.sound}` });
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        pb.once('PlaybackFinished', done);
        setTimeout(done, 30000);
      });
      job.heardAudio = true;
    } catch (e) {
      log(job, `Playback failed: ${e.message}`);
    }
    handled = true;
    finish(job, true, `Answered${job.label ? ` via ${job.label}` : ''}. `
      + 'The PBX accepted the call on this route and someone picked it up — '
      + 'press-1 transfers will land the same way.');
    await sleep(200);
    try { await channel.hangup(); } catch (e) {}
    return;
  }

  // ---- greeting rounds: play, listen, replay, give up ----
  for (let round = 1; round <= job.maxGreetings && !handled && !job.finished; round++) {
    log(job, `Playing ${job.sound} (round ${round}/${job.maxGreetings})`, 'playing');
    try {
      const pb = await channel.play({ media: `sound:${job.sound}` });
      await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        pb.once('PlaybackFinished', done);
        // A playback that never reports finished means the file is unreadable
        // or the wrong format; don't hang the whole test on it.
        setTimeout(done, 60000);
      });
      job.heardAudio = true;
      log(job, 'Audio finished playing');
    } catch (e) {
      log(job, `Playback failed: ${e.message}`);
      return finish(job, false,
        `Could not play ${job.sound}: ${e.message}. Check the file exists and is 8kHz mono 16-bit.`);
    }
    if (handled || job.finished) break;
    log(job, `Waiting ${job.waitSeconds}s for a keypress`, 'awaiting-key');
    const until = Date.now() + job.waitSeconds * 1000;
    while (Date.now() < until && !handled && !job.finished) await sleep(200);
  }

  if (!handled && !job.finished) {
    finish(job, true,
      `Audio played ${job.maxGreetings}x with no keypress. The trunk and the sound file work; `
      + 'DTMF is unproven until someone presses a key during a test.');
    try { await channel.hangup(); } catch (e) {}
  }
}

// ----------------------------------------------------------------- flow
/**
 * Play a prompt, but let a keypress cut it short.
 *
 * Barge-in is not a nicety: a lead who already knows the script presses 1 over
 * the greeting, and an IVR that ignores that feels broken and costs the call.
 */
async function playInterruptible(job, channel, sound) {
  if (!sound) return;
  let pb;
  try { pb = await channel.play({ media: `sound:${sound}` }); }
  catch (e) { log(job, `Could not play ${sound}: ${e.message}`); return; }

  // Audio started on an answered channel, so somebody is listening.
  //
  // Everything downstream keys off this: `connected`, the heard-the-prompt
  // count, and whether the outcome is "no keypress" or "never connected".
  // The flow runner never set it, so every campaign call that was answered
  // but produced no keypress was filed as a call that never connected --
  // which is the opposite of what happened, and made the whole dashboard
  // read as a dead trunk.
  job.heardAudio = true;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearInterval(poll); resolve(); } };
    pb.once('PlaybackFinished', finish);
    const poll = setInterval(() => {
      if (job._queue.length || job.finished) {
        try { pb.stop(); } catch (e) {}
        finish();
      }
    }, 100);
    setTimeout(finish, 120000);                   // a prompt that never ends
  });
}

/** Wait up to ms for a digit, or null. */
async function waitForDigit(job, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && !job.finished) {
    if (job._queue.length) return job._queue.shift();
    await sleep(100);
  }
  return null;
}

/**
 * Hand the lead to an agent: ring the PBX route while hold audio plays, then
 * bridge the two legs. This is the part worth testing for real -- everything
 * before it is prompts, and prompts rarely surprise anyone.
 */
/**
 * Which PBX this keypress goes to.
 *
 * A key may name its own server, which is how one flow serves several
 * departments -- press 1 for recovery, 2 for sales, 3 for support. A key that
 * names none falls back to the campaign's server, so every flow written
 * before departments existed keeps working exactly as it did.
 *
 * A key naming a server that has since been deleted falls back too rather
 * than dropping the call: the lead already pressed a key and is waiting, and
 * reaching the wrong department beats reaching nobody.
 */
function serverFor(job, key) {
  const wanted = key && key.serverId;
  if (wanted && job.servers && job.servers[wanted]) {
    return { ...job.servers[wanted], fellBack: false };
  }
  return {
    endpoint: job.serverEndpoint,
    routeNumber: job.routeNumber,
    name: job.serverName || '',
    fellBack: !!wanted,
  };
}

async function doTransfer(job, channel, client, key) {
  const target = serverFor(job, key);
  if (!target.endpoint || !target.routeNumber) {
    finish(job, false, 'Key pressed, but this module has no server to transfer to. '
      + 'Add one on the Servers tab, and pick it on the campaign or the IVR key.');
    try { await channel.hangup(); } catch (e) {}
    return;
  }
  if (target.fellBack) {
    log(job, `The server this key named is gone — using ${target.name || 'the campaign default'}`);
  }
  log(job, `Transferring to ${target.name || 'the campaign server'} (${target.routeNumber})`);

  const bridge = client.Bridge();
  try { await bridge.create({ type: 'mixing' }); } catch (e) {
    finish(job, false, `Could not create the bridge: ${e.message}`);
    return;
  }

  let agentUp = false;

  /**
   * One leg hanging up must take the other with it.
   *
   * ARI does not do this for you: the bridge survives, and the agent sits
   * listening to nothing with the call still shown as connected on their
   * phone. On a campaign that is an agent who never becomes available again.
   */
  const teardown = async (who) => {
    if (job._torn) return;
    job._torn = true;
    clearInterval(job._watch);
    log(job, `${who} hung up — clearing the other leg`);
    for (const ch of [job._agentChan, channel]) {
      if (ch) { try { await ch.hangup(); } catch (e) {} }
    }
    try { await bridge.destroy(); } catch (e) {}
  };
  channel.once('ChannelDestroyed', () => teardown('Lead'));
  channel.once('StasisEnd', () => teardown('Lead'));

  /**
   * Watchdog, because those events are not guaranteed.
   *
   * A per-channel handler only fires if ARI delivers that event to this client.
   * A dropped websocket frame, a channel that left Stasis another way, or a
   * resource we stopped tracking all mean no event -- and a call that hangs up
   * on one side only, with an agent stuck "connected" to nobody. Asking
   * Asterisk directly every two seconds cannot miss it.
   */
  const alive = async (ch) => {
    if (!ch) return false;
    try { await client.channels.get({ channelId: ch.id }); return true; }
    catch (e) { return false; }
  };
  job._watch = setInterval(async () => {
    if (job._torn) return clearInterval(job._watch);
    const [leadUp, agentUpNow] = await Promise.all([alive(channel), alive(job._agentChan)]);
    if (!leadUp && !agentUpNow) { clearInterval(job._watch); job._torn = true; return; }
    if (job._agentChan && (!leadUp || !agentUpNow)) await teardown(leadUp ? 'Agent' : 'Lead');
  }, 2000);
  if (job._watch.unref) job._watch.unref();

  const agentReady = new Promise((resolve) => {
    job._onAgent = async (agentChan) => {
      job._agentChan = agentChan;
      agentChan.once('ChannelDestroyed', () => teardown('Agent'));
      agentChan.once('StasisEnd', () => teardown('Agent'));
      try {
        await agentChan.answer();
        await bridge.addChannel({ channel: [channel.id, agentChan.id] });
        agentUp = true;
        log(job, 'Agent answered — legs bridged', 'bridged');
      } catch (e) {
        log(job, `Could not bridge: ${e.message}`);
      }
      resolve(agentChan);
    };
  });

  log(job, `Ringing ${target.routeNumber} on ${target.name || 'the PBX'} `
    + `(up to ${job.agentRingSeconds}s)`, 'ringing-agent');
  const agent = client.Channel();
  try {
    await agent.originate({
      endpoint: dialString(target.endpoint, target.routeNumber, 'plain'),
      app: ARI_APP,
      appArgs: `agent,${job.id}`,
      // The agent must see who is calling. Without this the leg is placed with
      // no caller id and the phone shows "anonymous", which is useless on a
      // screen pop and makes a callback impossible.
      callerId: job.number,
      timeout: job.agentRingSeconds,
    });
  } catch (e) {
    finish(job, false, `Could not ring the agent: ${e.message}`);
    try { await channel.hangup(); } catch (err) {}
    return;
  }

  // Hold audio loops while it rings; the race ends when either the agent
  // answers or the ring timer runs out.
  const holdLoop = (async () => {
    while (!agentUp && !job.finished) {
      if (!key.holdAudio) { await sleep(300); continue; }
      await playInterruptible(job, channel, key.holdAudio);
      job._queue.length = 0;                      // keys pressed on hold mean nothing
    }
  })();

  const timer = sleep((key.holdSeconds || job.agentRingSeconds) * 1000);
  await Promise.race([agentReady, timer]);
  await Promise.resolve(holdLoop).catch(() => {});

  if (!agentUp) {
    try { await agent.hangup(); } catch (e) {}
    log(job, 'No agent answered');
    await playInterruptible(job, channel, job.flow.exitAudio);
    finish(job, false,
      `Nobody answered on ${target.routeNumber}${target.name ? ' (' + target.name + ')' : ''} `
      + `within ${key.holdSeconds || job.agentRingSeconds}s. `
      + 'The flow worked; the queue had no one free, or the inbound route points somewhere quiet.');
    try { await channel.hangup(); } catch (e) {}
    return;
  }

  finish(job, true,
    `Pressed ${key.key} → transferred. The lead and the agent are bridged: talk to each other, `
    + 'and hang up when you are done. That is the whole press-1 path working.');
}

/**
 * The flow itself: greeting, key, action, with the two exhaustion counters.
 */
/**
 * Ask Asterisk whether a person or a machine answered.
 *
 * Fails OPEN on purpose. If AMD is not loaded, the dialplan context is
 * missing, or the round trip takes too long, this returns something that is
 * not MACHINE and the call proceeds as normal. Hanging up on a real lead
 * because detection broke is far more expensive than talking to a voicemail
 * box for twenty seconds, so every failure mode has to land on "treat as
 * human".
 */
function runAmd(job, channel) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (done) return; done = true; job._onAmd = null; resolve(v); };
    // Longer than total_analysis_time in amd.conf, with room for the hop.
    const timer = setTimeout(() => settle('TIMEOUT'), 12000);
    job._onAmd = (status, cause) => { clearTimeout(timer); job.amdCause = cause || ''; settle(status); };

    (async () => {
      try {
        await channel.setChannelVar({ variable: 'STASIS_JOB', value: job.id });
        await channel.setChannelVar({ variable: 'STASIS_APP', value: ARI_APP });
        await channel.continueInDialplan({ context: 'amd-check', extension: 's', priority: 1 });
      } catch (e) {
        clearTimeout(timer);
        settle('ERROR');
      }
    })();
  });
}

async function runFlow(job, channel, client) {
  const f = job.flow;
  const byKey = new Map(f.keys.map((k) => [k.key, k]));
  let invalid = 0, noInput = 0;

  /**
   * Hard ceiling on the MENU portion of the call.
   *
   * The round limits bound the number of prompts, not the time: a long
   * greeting plus a 30s silence, twice over, is already past two minutes of a
   * trunk channel for somebody who pressed nothing. The counters say the call
   * is behaving; the clock says it is costing a line.
   *
   * It covers only the menu. Once a key sends the call to an agent this stops
   * applying, because cutting off a live conversation to satisfy a dialler
   * setting would be far worse than the line it saves.
   */
  const deadline = job.maxCallSeconds > 0
    ? job.startedAt + job.maxCallSeconds * 1000 : Infinity;

  while (!job.finished) {
    if (Date.now() >= deadline) {
      job.path.push('too long');
      log(job, `Ending: ${job.maxCallSeconds}s in the menu is the limit`);
      try { await channel.hangup(); } catch (e) {}
      return finish(job, false,
        `Ended after ${job.maxCallSeconds}s in the menu without a keypress — `
        + 'the per-call limit. Lower the flow\'s keypress timeout if this is common.');
    }
    job._queue.length = 0;                        // only keys pressed from here count
    log(job, `Playing greeting (${f.greetingAudio})`, 'greeting');
    await playInterruptible(job, channel, f.greetingAudio);
    if (job.finished) return;

    // Without this the state stays 'greeting' for the whole silent wait: every
    // call reads "playing prompt" however long it has been quiet, and the
    // dashboard's "waiting for a key" column can never be anything but zero.
    log(job, `Waiting ${f.timeoutSeconds}s for a keypress`, 'awaiting-key');
    const budget = Math.max(0, Math.min(
      (f.timeoutSeconds || 30) * 1000, deadline - Date.now()));
    const digit = await waitForDigit(job, budget);

    if (digit === null) {
      noInput += 1;
      job.path.push('no input');
      log(job, `No key after ${f.timeoutSeconds}s (${noInput}/${f.maxNoInput})`);
      if (noInput >= f.maxNoInput) break;
      await playInterruptible(job, channel, f.noInputAudio);
      continue;
    }

    const key = byKey.get(digit);
    if (!key) {
      invalid += 1;
      job.path.push(`invalid ${digit}`);
      log(job, `Pressed ${digit} — not in this menu (${invalid}/${f.maxInvalid})`);
      if (invalid >= f.maxInvalid) break;
      await playInterruptible(job, channel, f.invalidAudio);
      continue;
    }

    job.path.push(`${digit} → ${key.action}`);
    log(job, `Pressed ${digit} → ${key.action}${key.label ? ` (${key.label})` : ''}`, 'key');

    if (key.action === 'repeat') {
      // Counted as a wrong press on purpose: otherwise a lead leaning on the
      // replay key keeps a trunk channel open indefinitely.
      invalid += 1;
      await playInterruptible(job, channel, key.audio);
      if (invalid >= f.maxInvalid) break;
      continue;
    }

    await playInterruptible(job, channel, key.audio);

    if (key.action === 'transfer') return doTransfer(job, channel, client, key);

    const what = {
      optout: 'opted out — the number would be added to the DNC list',
      remove: 'removed — the lead would be dropped from this list',
      hangup: 'ended the call',
    }[key.action] || key.action;
    finish(job, true, `Pressed ${key.key} → ${what}. The flow behaved as configured.`);
    try { await channel.hangup(); } catch (e) {}
    return;
  }

  // Both counters end the same way: say goodbye, then hang up.
  log(job, `Giving up after ${invalid} wrong press(es) and ${noInput} silent round(s)`);
  await playInterruptible(job, channel, f.exitAudio);
  finish(job, true,
    `Ended after ${invalid} wrong press(es) and ${noInput} silent round(s), as configured. `
    + 'This is also how an answering machine ends.');
  try { await channel.hangup(); } catch (e) {}
}

// ------------------------------------------------------------------ api
/** Translate a hangup cause into something that names the actual problem. */
function causeText(code) {
  const m = {
    1: 'Unallocated number — the provider does not recognise the number dialled.',
    16: 'Normal clearing — the far end hung up.',
    17: 'Busy.',
    18: 'No user responding.',
    19: 'No answer (the phone rang out).',
    21: 'Call rejected — the provider refused the INVITE. Three usual causes: the trunk is not registered (check the status pill, and `pjsip show registrations`), the number format is one this carrier will not take, or the From identity is not one the account may present. All three are set per trunk on the Trunks tab.',
    27: 'Destination out of order.',
    28: 'Invalid number format — check the country code.',
    34: 'No circuit available.',
    38: 'Network out of order.',
    88: 'Incompatible destination — usually a codec mismatch.',
  };
  return m[code] || '';
}

function start(opts) {
  const job = {
    id: newId(),
    number: opts.number,
    trunkName: opts.trunkName,
    endpoint: opts.endpoint,
    sound: opts.sound,
    // Trunk tests dial the PSTN in whatever format that carrier accepts;
    // route tests dial a number the PBX owns and must not be rewritten.
    // `e164: false` is the older spelling of 'plain' and still honoured.
    numberFormat: opts.e164 === false ? 'plain'
      : (['e164', 'plain', 'intl'].includes(opts.numberFormat) ? opts.numberFormat : 'e164'),
    // 'dtmf'  — prove trunk + audio + a keypress coming back (outbound trunks)
    // 'answer'— prove the call reaches a human through the PBX inbound route
    // 'echo'   — prove audio flows BOTH ways on that route
    // Every mode must be listed here: an unknown one silently becomes 'dtmf',
    // which runs a different script and reports success for a test that never
    // ran.
    mode: ['answer', 'echo', 'flow'].includes(opts.mode) ? opts.mode : 'dtmf',
    label: opts.label || '',
    // The campaign engine needs to know how each call ended; a diagnostic from
    // the UI does not care and passes nothing.
    onFinish: typeof opts.onFinish === 'function' ? opts.onFinish : null,
    meta: opts.meta || null,
    // mode 'flow': the whole IVR, run for real against one number.
    flow: opts.flow || null,
    serverEndpoint: opts.serverEndpoint || '',
    routeNumber: opts.routeNumber || '',
    serverName: opts.serverName || '',
    // id -> { endpoint, routeNumber, name } for every server a key may name.
    servers: opts.servers || null,
    agentRingSeconds: Math.max(10, Math.min(120, parseInt(opts.agentRingSeconds, 10) || 30)),
    digits: [],
    path: [],                       // every step taken, for the timeline
    _queue: [],                     // digits waiting to be consumed
    callerId: opts.callerId || '',
    confirmKey: opts.confirmKey || '1',
    optOutKey: opts.optOutKey || '2',
    maxGreetings: Math.max(1, Math.min(5, parseInt(opts.maxGreetings, 10) || 2)),
    waitSeconds: Math.max(3, Math.min(30, parseInt(opts.waitSeconds, 10) || 8)),
    startedAt: Date.now(),
    answeredAt: null,               // set when the lead actually picks up
    finishedAt: null,
    hangupCause: null,              // SIP/Q.850 cause when it never connected
    hangupCauseText: '',
    // Set when the call failed for a reason that has nothing to do with the
    // person being called: our own infrastructure, or the carrier having no
    // line free. The lead was never actually dialled, so the dialler must not
    // charge them an attempt for it.
    failureKind: null,              // 'infra' | 'congestion' | null
    detectMachines: !!opts.detectMachines,
    // 0 = no ceiling. Applies to the menu only, never to a bridged call.
    maxCallSeconds: Math.max(0, parseInt(opts.maxCallSeconds, 10) || 0),
    amdStatus: '',                  // MACHINE | HUMAN | NOTSURE | TIMEOUT | ERROR
    amdCause: '',
    state: 'connecting',
    events: [],
    digits: [],
    heardAudio: false,
    finished: false,
    ok: false,
    result: '',
  };
  jobs.set(job.id, job);
  reap();
  run(job);
  return job;
}

async function run(job) {
  let client;
  try {
    client = await connect();
  } catch (e) {
    // ARI unreachable, not answering, app not registered: ours, not theirs.
    job.failureKind = 'infra';
    return finish(job, false, e.message);
  }

  log(job, `Dialling ${dialString(job.endpoint, job.number, job.numberFormat)}`, 'dialing');

  const chan = client.Channel();
  chan.on('ChannelStateChange', (evt, c) => {
    if (/ring/i.test(c.state || '')) log(job, 'Ringing', 'ringing');
  });
  chan.on('ChannelDestroyed', (evt) => {
    // Only meaningful before the call is answered; afterwards the Stasis
    // handler owns the outcome.
    if (job.finished || job.channelId) return;
    const code = evt.cause;
    // The congestion family: the carrier has no circuit free, or the route is
    // out of order. Nobody's phone rang, so this is capacity, not a bad lead.
    if ([34, 38, 42, 44, 47].includes(code)) job.failureKind = 'congestion';
    job.hangupCause = code;
    job.hangupCauseText = evt.cause_txt || '';
    const extra = causeText(code);
    finish(job, false,
      `Call never connected (hangup cause ${code}${evt.cause_txt ? ': ' + evt.cause_txt : ''}).`
      + (extra ? ` ${extra}` : ''));
  });

  try {
    await chan.originate({
      endpoint: dialString(job.endpoint, job.number, job.numberFormat),
      app: ARI_APP,
      appArgs: `test,${job.id}`,
      callerId: job.callerId || undefined,
      timeout: 45,
    });
  } catch (e) {
    // originate() rejecting means Asterisk would not even start the call:
    // endpoint missing, ARI gone, no channel available locally. The carrier
    // was never asked, so this is ours.
    job.failureKind = 'infra';
    return finish(job, false, `Could not place the call: ${e.message}`);
  }

  // Backstop, so a job can never sit "dialing" forever in the UI.
  setTimeout(() => {
    if (!job.finished) finish(job, false, 'Timed out after 150s with no answer.');
  }, 150000);
}

const get = (id) => jobs.get(id) || null;

/** Drop a call in progress — what stopping a campaign has to do. */
async function hangup(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job._torn = true;                       // stop the watchdog racing us
  for (const ch of [job._agentChan]) {
    if (ch) { try { await ch.hangup(); } catch (e) {} }
  }
  if (job.channelId) {
    try {
      const client = await connect();
      await client.channels.hangup({ channelId: job.channelId });
    } catch (e) { /* already gone */ }
  }
  if (!job.finished) finish(job, false, 'Campaign stopped — call dropped.');
  return true;
}

module.exports = { start, get, hangup };
