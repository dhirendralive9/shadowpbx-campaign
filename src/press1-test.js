#!/usr/bin/env node
/**
 * ShadowPBX Campaign — step-1 proof.
 *
 * Dials ONE number, plays the greeting, waits for a keypress, and on the
 * confirm key bridges the call to an extension on the main ShadowPBX over
 * SIP. This is deliberately a single call with no pacing, no database and
 * no UI: it exists to prove the part that has never worked — that a real
 * person hears the prompt and that pressing 1 reaches an agent.
 *
 *   node src/press1-test.js 4915237313770
 *
 * Everything else (lead lists, overdial, stats) is ported from ShadowPBX
 * once this passes.
 */
'use strict';

/**
 * Build the dial string ARI needs for a PJSIP trunk.
 *
 * Asterisk reads `PJSIP/<endpoint>/<x>` as "endpoint, then AOR or sip: URI", so
 * `PJSIP/trunk-abc/15551234567` looks for an AOR *named* 15551234567 and the
 * call dies before any INVITE leaves. The trunk form is `PJSIP/<number>@<endpoint>`
 * -- the one `channel originate` was proven with against this carrier, E.164 with
 * a leading +.
 */
function dialString(endpoint, number) {
  const n = String(number).replace(/[^\d]/g, '');
  const m = /^PJSIP\/(.+)$/.exec(endpoint);
  return m ? `PJSIP/+${n}@${m[1]}` : `${endpoint}/${n}`;
}

require('dotenv').config();
const ari = require('ari-client');

/**
 * Endpoint names come from the saved settings, not from .env.
 *
 * The app writes PJSIP endpoints named after trunk and server ids, and renames
 * them whenever one is added or removed. A hand-edited .env goes stale the
 * first time you touch the Trunks tab, and the symptom is obscure: ARI answers
 * "Allocation failed", which reads like a resource problem rather than
 * "PJSIP/german-trunk does not exist". So .env is now only a fallback for a
 * box with no settings file yet.
 */
function fromSettings() {
  try {
    const store = require('./services/settings');
    const asterisk = require('./services/asterisk');
    const s = store.load();
    const ep = asterisk.activeEndpoints(s);
    return {
      TRUNK_ENDPOINT: ep.trunk || undefined,
      PBX_ENDPOINT: ep.server || undefined,
      AGENT_EXTEN: ep.routeNumber || undefined,
      CALLER_ID: ep.callerId || undefined,
      GREETING: s.ivr && s.ivr.greeting ? `sound:${s.ivr.greeting}` : undefined,
      CONFIRM_KEY: s.ivr && s.ivr.confirmKey,
      OPTOUT_KEY: s.ivr && s.ivr.optOutKey,
      MAX_GREETINGS: s.ivr && String(s.ivr.maxGreetings),
      WAIT_SECONDS: s.ivr && String(s.ivr.waitSeconds),
    };
  } catch (e) {
    return {};
  }
}
const saved = fromSettings();
const pick = (key, fallback) => process.env[key] || saved[key] || fallback;

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ARI_USER || 'campaign';
const ARI_PASS = process.env.ARI_PASS;
const ARI_APP = process.env.ARI_APP || 'shadowpbx-campaign';
const TRUNK_ENDPOINT = pick('TRUNK_ENDPOINT', '');
const PBX_ENDPOINT = pick('PBX_ENDPOINT', '');
const CALLER_ID = pick('CALLER_ID', '');
const AGENT_EXTEN = pick('AGENT_EXTEN', '');
const GREETING = pick('GREETING', 'sound:campaign/test');
const CONFIRM_KEY = pick('CONFIRM_KEY', '1');
const OPTOUT_KEY = pick('OPTOUT_KEY', '2');
const MAX_GREETINGS = pick('MAX_GREETINGS', '2');
const WAIT_SECONDS = pick('WAIT_SECONDS', '8');

const target = process.argv[2];
if (!target) {
  console.error('usage: node src/press1-test.js <number>   e.g. 4915237313770');
  process.exit(1);
}
if (!ARI_PASS) {
  console.error('ARI_PASS is not set — copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!TRUNK_ENDPOINT) {
  console.error('No active trunk. Add one on the Trunks tab, or set TRUNK_ENDPOINT in .env.');
  process.exit(1);
}
if (!PBX_ENDPOINT || !AGENT_EXTEN) {
  console.error('No active server or route number. Add a server on the Servers tab '
    + '(press 1 has nowhere to transfer to without it).');
  process.exit(1);
}

const maxGreetings = Math.max(1, parseInt(MAX_GREETINGS, 10) || 1);
const waitMs = (parseInt(WAIT_SECONDS, 10) || 8) * 1000;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await ari.connect(ARI_URL, ARI_USER, ARI_PASS);
  log(`connected to ARI at ${ARI_URL}`);

  let finished = false;
  const done = (code, msg) => {
    if (finished) return;
    finished = true;
    log(msg);
    setTimeout(() => process.exit(code), 400);
  };

  client.on('StasisStart', async (event, channel) => {
    // The agent leg re-enters Stasis too; it carries a marker in appArgs
    // so we don't run the IVR down the agent's ear.
    if ((event.args || []).includes('agent-leg')) return;

    log(`answered by ${target} — channel ${channel.id}`);
    try {
      await channel.answer();
    } catch (e) {
      return done(1, `answer failed: ${e.message}`);
    }

    let handled = false;   // a confirm/opt-out key arrived — stop replaying
    let pressed = null;

    channel.on('ChannelDtmfReceived', async (evt) => {
      const digit = evt.digit;
      log(`DTMF received: "${digit}"`);
      if (digit !== CONFIRM_KEY && digit !== OPTOUT_KEY) return; // ignore others
      if (handled) return;
      handled = true;
      pressed = digit;

      if (digit === OPTOUT_KEY) {
        log('opt-out pressed — hanging up');
        try { await channel.hangup(); } catch (e) {}
        return done(0, 'RESULT: opted out');
      }

      // ---- confirm pressed: bridge to the agent on the main PBX ----
      log(`confirm pressed — dialing ${AGENT_EXTEN} on ShadowPBX`);
      try {
        const bridge = await client.bridges.create({ type: 'mixing' });
        await bridge.addChannel({ channel: channel.id });

        const agent = client.Channel();
        agent.on('StasisStart', async () => {
          log('agent answered — bridging');
          await bridge.addChannel({ channel: agent.id });
          done(0, 'RESULT: CONFIRMED — lead bridged to agent. Press-1 works.');
        });
        agent.on('ChannelDestroyed', () => {
          if (!finished) done(1, 'RESULT: agent leg ended before bridging');
        });

        await agent.originate({
          endpoint: `${PBX_ENDPOINT}/${AGENT_EXTEN}`,
          app: ARI_APP,
          appArgs: 'agent-leg',
          callerId: `"Lead ${target}" <${target}>`,
          timeout: 30,
          // Lead context the agent's PBX can read off the INVITE.
          variables: {
            'PJSIP_HEADER(add,X-Lead-Number)': target,
            'PJSIP_HEADER(add,X-Campaign)': 'press1-test',
          },
        });
      } catch (e) {
        done(1, `bridge/originate failed: ${e.message}`);
      }
    });

    channel.on('ChannelDestroyed', () => {
      if (!finished) {
        done(0, pressed ? 'RESULT: call ended' : 'RESULT: lead hung up before pressing a key');
      }
    });

    // ---- greeting loop: play, listen, replay, then give up ----
    for (let round = 1; round <= maxGreetings && !handled && !finished; round++) {
      log(`playing greeting (round ${round}/${maxGreetings})`);
      try {
        await channel.play({ media: GREETING });
      } catch (e) {
        log(`playback failed: ${e.message} — check the sound file exists and is 8kHz mono`);
      }
      const until = Date.now() + waitMs;
      while (Date.now() < until && !handled && !finished) await sleep(200);
    }

    if (!handled && !finished) {
      log(`no keypress after ${maxGreetings} greeting(s) — rejecting`);
      try { await channel.hangup(); } catch (e) {}
      done(0, 'RESULT: no keypress (this is how a voicemail ends up)');
    }
  });

  await client.start(ARI_APP);

  // Place the call. It lands in Stasis via the StasisStart handler above.
  log(`dialing ${target} via ${TRUNK_ENDPOINT} ...`);
  try {
    await client.channels.originate({
      endpoint: dialString(TRUNK_ENDPOINT, target),
      app: ARI_APP,
      callerId: CALLER_ID,
      timeout: 45,
    });
  } catch (e) {
    done(1, `originate failed: ${e.message}`);
  }

  setTimeout(() => done(1, 'RESULT: timed out after 120s'), 120000);
})().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
