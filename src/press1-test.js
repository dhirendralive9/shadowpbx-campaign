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

require('dotenv').config();
const ari = require('ari-client');

const {
  ARI_URL = 'http://127.0.0.1:8088',
  ARI_USER = 'campaign',
  ARI_PASS,
  ARI_APP = 'shadowpbx-campaign',
  TRUNK_ENDPOINT = 'PJSIP/german-trunk',
  PBX_ENDPOINT = 'PJSIP/shadowpbx',
  CALLER_ID = '491511193838',
  AGENT_EXTEN = '2000',
  GREETING = 'sound:/var/lib/asterisk/sounds/campaign/greeting',
  CONFIRM_KEY = '1',
  OPTOUT_KEY = '2',
  MAX_GREETINGS = '2',
  WAIT_SECONDS = '8',
} = process.env;

const target = process.argv[2];
if (!target) {
  console.error('usage: node src/press1-test.js <number>   e.g. 4915237313770');
  process.exit(1);
}
if (!ARI_PASS) {
  console.error('ARI_PASS is not set — copy .env.example to .env and fill it in.');
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
      endpoint: `${TRUNK_ENDPOINT}/${target}`,
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
