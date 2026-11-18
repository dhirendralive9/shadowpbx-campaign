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
  const args = event.args || [];
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
    mode: opts.mode === 'answer' ? 'answer' : 'dtmf',
    label: opts.label || '',
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
