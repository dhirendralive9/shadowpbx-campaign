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
 * `PJSIP/trunk-abc/919778988634` looks for an AOR *named* 919778988634 and the
 * call dies before any INVITE leaves. The trunk form is `PJSIP/<number>@<endpoint>`
 * -- the one `channel originate` was proven with against this carrier, E.164 with
 * a leading +.
 */
function dialString(endpoint, number, e164 = true) {
  const n = String(number).replace(/[^\d]/g, '');
  const m = /^PJSIP\/(.+)$/.exec(endpoint);
  if (!m) return `${endpoint}/${n}`;
  // A PSTN number needs E.164; an internal route number on the PBX must go out
  // exactly as dialled, because `+123456789012` matches no inbound route.
  return `PJSIP/${e164 ? '+' : ''}${n}@${m[1]}`;
}
const newId = () => crypto.randomBytes(5).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
]);

// Keep the last few jobs only -- this is a diagnostic, not a call log.
function reap() {
  if (jobs.size <= 20) return;
  const old = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, jobs.size - 20);
  for (const j of old) jobs.delete(j.id);
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
      `nothing answered at ${ARI_URL} (${code}). Asterisk's HTTP server is off or on another port: `
      + 'check /etc/asterisk/http.conf (enabled=yes, bindaddr=127.0.0.1, bindport=8088), '
      + 'then run: asterisk -rx "http show status"');
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

function connect() {
  if (!ARI_PASS) return Promise.reject(new Error('ARI_PASS is not set in .env'));
  if (clientP) return clientP;
  clientP = preflight()
    .then(() => withTimeout(ari.connect(ARI_URL, ARI_USER, ARI_PASS), 15000, 'ARI did not respond within 15s'))
    .then(async (c) => {
      c.on('StasisStart', onStasisStart);
      // A dropped websocket must not leave a dead client cached, or every later
      // test fails with no way to recover short of restarting the service.
      c.on('WebSocketClose', () => { clientP = null; });
      c.on('WebSocketError', () => { clientP = null; });
      await withTimeout(c.start(ARI_APP), 15000, 'registering the ARI app timed out after 15s');
      return c;
    })
    .catch((e) => {
      clientP = null;
      throw new Error(
        `Cannot reach ARI at ${ARI_URL} as "${ARI_USER}": ${e.message}. `
        + 'Check ari.conf and http.conf, and that ARI_PASS matches.'
      );
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
  job.ok = ok;
  job.state = 'done';
  job.result = result;
  job.events.push({ at: Date.now() - job.startedAt, text: result });
  console.log(`[test ${job.id}] DONE ok=${ok}: ${result}`);
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

  if (args[0] !== 'test') return;                 // not ours -- the engine's
  const job = jobs.get(args[1]);
  if (!job || job.finished) {
    try { await channel.hangup(); } catch (e) {}
    return;
  }

  job.channelId = channel.id;
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
async function doTransfer(job, channel, client, key) {
  if (!job.serverEndpoint || !job.routeNumber) {
    finish(job, false, 'Key pressed, but this module has no active server to transfer to. '
      + 'Add one on the Servers tab.');
    try { await channel.hangup(); } catch (e) {}
    return;
  }

  const bridge = client.Bridge();
  try { await bridge.create({ type: 'mixing' }); } catch (e) {
    finish(job, false, `Could not create the bridge: ${e.message}`);
    return;
  }

  let agentUp = false;
  const agentReady = new Promise((resolve) => {
    job._onAgent = async (agentChan) => {
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

  log(job, `Ringing ${job.routeNumber} on the PBX (up to ${job.agentRingSeconds}s)`, 'ringing-agent');
  const agent = client.Channel();
  try {
    await agent.originate({
      endpoint: dialString(job.serverEndpoint, job.routeNumber, false),
      app: ARI_APP,
      appArgs: `agent,${job.id}`,
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
      `Nobody answered on ${job.routeNumber} within ${key.holdSeconds || job.agentRingSeconds}s. `
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
async function runFlow(job, channel, client) {
  const f = job.flow;
  const byKey = new Map(f.keys.map((k) => [k.key, k]));
  let invalid = 0, noInput = 0;

  while (!job.finished) {
    job._queue.length = 0;                        // only keys pressed from here count
    log(job, `Playing greeting (${f.greetingAudio})`, 'greeting');
    await playInterruptible(job, channel, f.greetingAudio);
    if (job.finished) return;

    const digit = await waitForDigit(job, (f.timeoutSeconds || 30) * 1000);

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
    21: 'Call rejected — the provider refused the INVITE. With IP auth this usually means the From number is not one the account is allowed to present.',
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
    // Trunk tests dial the PSTN; route tests dial a number the PBX owns.
    e164: opts.e164 !== false,
    // 'dtmf'  — prove trunk + audio + a keypress coming back (outbound trunks)
    // 'answer'— prove the call reaches a human through the PBX inbound route
    // 'echo'   — prove audio flows BOTH ways on that route
    // Every mode must be listed here: an unknown one silently becomes 'dtmf',
    // which runs a different script and reports success for a test that never
    // ran.
    mode: ['answer', 'echo', 'flow'].includes(opts.mode) ? opts.mode : 'dtmf',
    label: opts.label || '',
    // mode 'flow': the whole IVR, run for real against one number.
    flow: opts.flow || null,
    serverEndpoint: opts.serverEndpoint || '',
    routeNumber: opts.routeNumber || '',
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
    return finish(job, false, e.message);
  }

  log(job, `Dialling ${dialString(job.endpoint, job.number, job.e164)}`, 'dialing');

  const chan = client.Channel();
  chan.on('ChannelStateChange', (evt, c) => {
    if (/ring/i.test(c.state || '')) log(job, 'Ringing', 'ringing');
  });
  chan.on('ChannelDestroyed', (evt) => {
    // Only meaningful before the call is answered; afterwards the Stasis
    // handler owns the outcome.
    if (job.finished || job.channelId) return;
    const code = evt.cause;
    const extra = causeText(code);
    finish(job, false,
      `Call never connected (hangup cause ${code}${evt.cause_txt ? ': ' + evt.cause_txt : ''}).`
      + (extra ? ` ${extra}` : ''));
  });

  try {
    await chan.originate({
      endpoint: dialString(job.endpoint, job.number, job.e164),
      app: ARI_APP,
      appArgs: `test,${job.id}`,
      callerId: job.callerId || undefined,
      timeout: 45,
    });
  } catch (e) {
    return finish(job, false, `Could not place the call: ${e.message}`);
  }

  // Backstop, so a job can never sit "dialing" forever in the UI.
  setTimeout(() => {
    if (!job.finished) finish(job, false, 'Timed out after 150s with no answer.');
  }, 150000);
}

const get = (id) => jobs.get(id) || null;

module.exports = { start, get };
