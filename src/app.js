#!/usr/bin/env node
'use strict';
/**
 * ShadowPBX Campaign Module — web UI.
 * Login uses ARI_USER / ARI_PASS from .env.
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { exec } = require('child_process');

const store = require('./services/settings');
const asterisk = require('./services/asterisk');
const audio = require('./services/audio');
const leads = require('./services/leads');
const campaigns = require('./services/campaigns');
const testcall = require('./services/testcall');
const ivr = require('./services/ivr');
const dialer = require('./services/dialer');
const calls = require('./services/calls');
const agents = require('./services/agents');

// swagger-client (inside ari-client) throws from a callback when ARI cannot be
// read, which no promise can catch. Losing the whole UI -- and every login
// session with it -- over a diagnosable ARI problem is the wrong trade, so log
// that one specific failure and keep serving. Anything else still kills the
// process, so real bugs are not hidden.
process.on('uncaughtException', (err) => {
  const msg = String((err && err.message) || err);
  if (/Can't read swagger JSON/i.test(msg)) {
    console.error(`[ari] ${msg} -- ARI is not reachable; the test call will report it.`);
    return;
  }
  console.error(err);
  process.exit(1);
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const ARI_USER = process.env.ARI_USER || 'campaign';
const ARI_PASS = process.env.ARI_PASS;

if (!ARI_PASS || ARI_PASS === 'CHANGE_ME_long_random') {
  console.error('ARI_PASS is not set in .env — it is also the UI login password. Refusing to start.');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use(session({
  secret: process.env.SESSION_SECRET || ARI_PASS,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 },
}));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const auth = (req, res, next) =>
  req.session && req.session.user ? next() : res.redirect('/login');

// Shared template vars so every page renders the same chrome.
function base(req, extra = {}) {
  const s = store.load();
  return {
    user: req.session.user, role: 'admin',
    settings: s, missing: store.validate(s),
    flash: req.query.msg || null, flashErr: req.query.err || null,
    ...extra,
  };
}
const back = (to, r) =>
  `${to}?${r.ok ? 'msg' : 'err'}=${encodeURIComponent(r.message || r.error || '')}`;

// ---------------------------------------------------------------- auth
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  if (req.body.username === ARI_USER && req.body.password === ARI_PASS) {
    req.session.user = req.body.username;
    return res.redirect('/');
  }
  setTimeout(() => res.status(401).render('login', { error: 'Invalid credentials' }), 400);
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------------------------------------------------------------- pages
app.get('/', auth, (req, res) =>
  res.render('dashboard', base(req, { active: 'dashboard' })));

app.get('/trunks', auth, (req, res) =>
  res.render('trunks', base(req, { active: 'trunks', sub: 'trunks', sounds: audio.list() })));

app.get('/servers', auth, (req, res) =>
  res.render('servers', base(req, { active: 'servers', sub: 'servers', sounds: audio.list() })));

app.get('/audio', auth, async (req, res) =>
  res.render('audio', base(req, {
    active: 'audio', sub: 'audio',
    files: audio.list(), hasSox: await audio.haveSox(),
    // A sound referenced anywhere in any IVR flow is in use; the old check
    // only knew about one default greeting.
    inUse: new Set(ivr.list().flatMap((f) => [
      f.greetingAudio, f.invalidAudio, f.noInputAudio, f.exitAudio,
      ...f.keys.flatMap((k) => [k.audio, k.holdAudio]),
    ]).filter(Boolean)),
  })));

app.get('/ivr', auth, (req, res) =>
  res.render('ivr', base(req, {
    active: 'ivr', sub: 'ivr',
    files: audio.list(), flows: ivr.list(), actions: ivr.ACTIONS,
    editing: req.query.edit ? ivr.get(req.query.edit) : null,
  })));

app.get('/leads', auth, (req, res) =>
  res.render('leads', base(req, { active: 'leads', lists: leads.list(), countries: leads.COUNTRIES })));

app.get('/leads/:id', auth, (req, res) => {
  const l = leads.get(req.params.id);
  if (!l) return res.redirect('/leads?err=' + encodeURIComponent('List not found'));
  res.render('lead-detail', base(req, {
    active: 'leads', list: l,
    rows: l.rows.slice(0, 200), stats: leads.stats(l.id), countries: leads.COUNTRIES,
  }));
});

app.get('/campaigns', auth, (req, res) =>
  res.render('campaigns', base(req, {
    active: 'campaigns', campaigns: campaigns.list(),
    lists: leads.list(), files: audio.list(),
  })));

app.get('/campaigns/new', auth, (req, res) =>
  res.render('campaign-edit', base(req, {
    active: 'campaigns', campaign: null,
    lists: leads.list(), files: audio.list(), flows: ivr.list(), actions: ivr.ACTIONS,
    defaults: { ivr: campaigns.DEFAULT_IVR, pacing: campaigns.DEFAULT_PACING },
  })));

app.get('/campaigns/:id', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.redirect('/campaigns?err=' + encodeURIComponent('Campaign not found'));
  res.render('campaign-edit', base(req, {
    active: 'campaigns', campaign: c,
    lists: leads.list(), files: audio.list(), flows: ivr.list(), actions: ivr.ACTIONS,
    defaults: { ivr: campaigns.DEFAULT_IVR, pacing: campaigns.DEFAULT_PACING },
  }));
});

// ---------------------------------------------------------------- leads
app.post('/leads/create', auth, (req, res) => {
  const cc = (req.body.country || '').split('|');
  const rec = leads.create({ name: req.body.name, country: cc[1] || '', dialCode: cc[0] || '' });
  res.redirect('/leads/' + rec.id + '?msg=' + encodeURIComponent('List created — now upload a CSV.'));
});

app.post('/leads/:id/upload', auth, upload.single('file'), (req, res) => {
  const l = leads.get(req.params.id);
  if (!l) return res.redirect('/leads?err=' + encodeURIComponent('List not found'));
  if (!req.file) return res.redirect('/leads/' + l.id + '?err=' + encodeURIComponent('No file selected'));
  let text = '';
  try { text = require('fs').readFileSync(req.file.path, 'utf8'); }
  catch (e) { return res.redirect('/leads/' + l.id + '?err=' + encodeURIComponent(e.message)); }
  finally { try { require('fs').unlinkSync(req.file.path); } catch (e) {} }

  const r = leads.importCSV(l.id, text, { dialCode: l.dialCode });
  if (!r.ok) return res.redirect('/leads/' + l.id + '?err=' + encodeURIComponent(r.error));
  const d = r.detected;
  // Same four counts for both formats, so an import can be reconciled against
  // whatever produced the file: lines read in, and where each one went.
  const counts = `Read ${r.read} line${r.read === 1 ? '' : 's'} — `
    + `imported ${r.imported}, ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'}, `
    + `${r.invalid} invalid. List now holds ${r.total}.`;
  const how = d.format === 'numbers'
    ? ` Plain number list: one number per line, country code ${l.dialCode} applied where missing.`
    : ` CSV: phone column "${d.phone}"${d.name ? `, name "${d.name}"` : ''}`
      + `${d.prefix ? `, prefix "${d.prefix}"` : `, country code ${l.dialCode} applied`}.`;
  res.redirect('/leads/' + l.id + '?msg=' + encodeURIComponent(counts + how));
});

app.post('/leads/:id/update', auth, (req, res) => {
  const cc = (req.body.country || '').split('|');
  leads.update(req.params.id, { name: req.body.name, country: cc[1], dialCode: cc[0] });
  res.redirect('/leads/' + req.params.id + '?msg=' + encodeURIComponent('List updated.'));
});

app.post('/leads/:id/delete', auth, (req, res) => {
  leads.remove(req.params.id);
  res.redirect('/leads?msg=' + encodeURIComponent('List deleted.'));
});

// ---------------------------------------------------------------- campaigns
app.post('/campaigns/save', auth, (req, res) => {
  campaigns.save(req.body);
  res.redirect('/campaigns?msg=' + encodeURIComponent('Campaign saved.'));
});

app.post('/campaigns/:id/start', auth, (req, res) => {
  const r = dialer.start(req.params.id);
  res.redirect(back('/campaigns', r.ok ? { ok: true, message: r.message } : r));
});
app.post('/campaigns/:id/pause', auth, (req, res) => {
  const r = dialer.pause(req.params.id);
  res.redirect(back('/campaigns', r));
});
app.post('/campaigns/:id/stop', auth, async (req, res) => {
  const r = await dialer.stop(req.params.id);
  res.redirect(back('/campaigns', r));
});

/** Live counters for the campaign dashboard. */
app.get('/api/campaigns/:id/live', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'No such campaign' });
  res.json({
    ok: true,
    ...dialer.status(req.params.id),
    // A rolling tail of what just happened. Live counters say how many calls
    // are up; this says which numbers and how they ended, which is what
    // someone watching a campaign actually wants to see.
    recent: calls.read(req.params.id, { limit: 15 }).map((r) => ({
      phone: r.phone, outcome: r.outcome, label: r.outcomeLabel,
      at: r.at, seconds: r.talkSeconds, result: r.result,
    })),
  });
});

/**
 * Per-call report for one campaign.
 *
 * Defaults to today. The date inputs are the whole filter -- a campaign that
 * ran for three weeks should not dump three weeks into the browser because
 * someone clicked "Report".
 */
app.get('/campaigns/:id/report', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.redirect('/campaigns?err=' + encodeURIComponent('Campaign not found'));
  const available = calls.days(c.id);
  const from = req.query.from || available[0] || calls.todayStr();
  const to = req.query.to || from;
  const rows = calls.read(c.id, {
    from, to, outcome: req.query.outcome || '', phone: req.query.phone || '', limit: 2000,
  });
  res.render('campaign-report', base(req, {
    active: 'campaigns', campaign: c, rows, available,
    summary: calls.summary(rows), outcomes: calls.OUTCOMES,
    filter: { from, to, outcome: req.query.outcome || '', phone: req.query.phone || '' },
    // The table is capped so a huge day cannot hang the browser; the CSV is
    // not, so there is always a way to get everything.
    capped: rows.length >= 2000,
  }));
});

app.get('/campaigns/:id/report.csv', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.status(404).send('No such campaign');
  const from = req.query.from || '';
  const to = req.query.to || '';
  const rows = calls.read(c.id, {
    from, to, outcome: req.query.outcome || '', phone: req.query.phone || '',
  });
  const slug = String(c.name || 'campaign').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const span = from === to ? (from || 'all') : `${from || 'start'}_${to || 'end'}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-${span}.csv"`);
  res.send(calls.toCsv(rows));
});

app.post('/campaigns/:id/delete', auth, (req, res) => {
  campaigns.remove(req.params.id);
  res.redirect('/campaigns?msg=' + encodeURIComponent('Campaign deleted.'));
});

// ---------------------------------------------------------------- trunks
/**
 * Flag trunk settings that cannot work, rather than writing a config that
 * fails silently. "Register" with no password is the one that cost real time:
 * Asterisk refuses the registration object, `pjsip show registrations` reports
 * nothing at all, and the UI shows an empty status forever with no error
 * anywhere. An IP-authenticated trunk with no caller ID is the other: From
 * falls back to the account name and the provider answers 403 on the INVITE,
 * long after the trunk itself looks healthy.
 */
function trunkWarnings(t) {
  if (!t) return [];
  const w = [];
  if (t.register && !t.pass) {
    w.push('registration needs a password — if this provider authenticates by IP, untick "Register with the provider"');
  }
  if (!t.register && !t.callerId) {
    w.push('no caller ID, so calls will present the account name in From; IP-authenticated providers usually reject that with a 403');
  }
  return w;
}

app.post('/trunks/save', auth, async (req, res) => {
  const s = store.saveTrunk(req.body);
  const r = await asterisk.applySettings(s);
  if (!r.ok) return res.redirect(back('/trunks', r));
  const saved = (s.trunks || []).find((t) => t.name === (req.body.name || '').trim())
    || (s.trunks || [])[s.trunks.length - 1];
  const warn = trunkWarnings(saved);
  res.redirect(back('/trunks', {
    ok: true,
    message: 'Trunk saved. PJSIP reloaded.' + (warn.length ? ` Check: ${warn.join('; ')}.` : ''),
  }));
});
app.post('/trunks/:id/activate', auth, async (req, res) => {
  const s = store.setActiveTrunk(req.params.id);
  await asterisk.applySettings(s);
  res.redirect('/trunks?msg=' + encodeURIComponent('Active trunk switched.'));
});
app.post('/trunks/:id/delete', auth, async (req, res) => {
  const s = store.deleteTrunk(req.params.id);
  await asterisk.applySettings(s);
  res.redirect('/trunks?msg=' + encodeURIComponent('Trunk deleted.'));
});

// ---------------------------------------------------------------- servers
app.post('/servers/save', auth, async (req, res) => {
  const s = store.saveServer(req.body);
  agents.sync(s);
  const r = await asterisk.applySettings(s);
  if (!r.ok) return res.redirect(back('/servers', r));
  const sv = (s.servers || []).find((x) => x.name === (req.body.name || '').trim())
    || (s.servers || [])[s.servers.length - 1];
  res.redirect(back('/servers', {
    ok: true,
    message: `Server saved. Add ${sv && sv.routeNumber} as an inbound route on `
      + 'this PBX, pointing at the ring group or queue that serves this campaign.',
  }));
});

app.post('/servers/:id/regenerate-route', auth, async (req, res) => {
  const s = store.regenerateRoute(req.params.id);
  const sv = (s.servers || []).find((x) => x.id === req.params.id);
  await asterisk.applySettings(s);
  res.redirect(back('/servers', {
    ok: true,
    message: `New route number ${sv && sv.routeNumber}. The old one stops working `
      + 'as soon as you repoint the inbound route on the PBX.',
  }));
});
app.post('/servers/:id/activate', auth, async (req, res) => {
  const s = store.setActiveServer(req.params.id);
  agents.sync(s);
  await asterisk.applySettings(s);
  res.redirect('/servers?msg=' + encodeURIComponent('Active server switched.'));
});
app.post('/servers/:id/delete', auth, async (req, res) => {
  const s = store.deleteServer(req.params.id);
  agents.sync(s);
  await asterisk.applySettings(s);
  res.redirect('/servers?msg=' + encodeURIComponent('Server deleted.'));
});

// ---------------------------------------------------------------- audio
app.post('/audio/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.redirect('/audio?err=' + encodeURIComponent('No file selected'));
  const name = (req.body.name || '').trim() || req.file.originalname.replace(/\.[^.]+$/, '');
  const r = await audio.convert(req.file.path, name);
  res.redirect(back('/audio', r.ok
    ? { ok: true, message: `Uploaded and converted to 8kHz mono: ${r.name}` } : r));
});
app.post('/audio/rename', auth, (req, res) =>
  res.redirect(back('/audio', (() => {
    const r = audio.rename(req.body.file, req.body.name);
    return r.ok ? { ok: true, message: `Renamed to ${r.name}` } : r;
  })())));
app.post('/audio/:file/delete', auth, (req, res) =>
  res.redirect(back('/audio', (() => {
    const r = audio.remove(req.params.file);
    return r.ok ? { ok: true, message: 'Deleted.' } : r;
  })())));
app.get('/audio/:file/play', auth, (req, res) => {
  const p = audio.filePath(req.params.file);
  if (!p) return res.status(404).send('not found');
  res.type('audio/wav').sendFile(p);
});

// ---------------------------------------------------------------- ivr
app.post('/ivr/save', auth, (req, res) => {
  const all = ivr.save(req.body);
  const saved = all.find((f) => f.id === req.body.id)
    || all[all.length - 1];
  // Say what is still missing rather than letting it fail on a live call.
  const gaps = ivr.validate(saved);
  res.redirect('/ivr?msg=' + encodeURIComponent(
    `Saved "${saved.name}".` + (gaps.length ? ` Still needs: ${gaps.join('; ')}.` : '')));
});

app.post('/ivr/:id/duplicate', auth, (req, res) => {
  ivr.duplicate(req.params.id);
  res.redirect('/ivr?msg=' + encodeURIComponent('Copied — edit the copy below.'));
});

app.post('/ivr/:id/delete', auth, (req, res) => {
  const used = campaigns.list().filter((c) => c.ivrFlowId === req.params.id);
  if (used.length) {
    return res.redirect('/ivr?err=' + encodeURIComponent(
      `In use by ${used.map((c) => c.name).join(', ')} — point those at another flow first.`));
  }
  ivr.remove(req.params.id);
  res.redirect('/ivr?msg=' + encodeURIComponent('IVR flow deleted.'));
});

// ---------------------------------------------------------------- api
app.get('/api/status', auth, async (req, res) => {
  try {
    const s = store.load();
    res.json({ ok: true, status: await asterisk.status(), missing: store.validate(s) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/trunks/:id/reregister', auth, async (req, res) => {
  try { res.json({ ok: true, ...(await asterisk.reRegister(req.params.id)) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/trunks/:id/diagnose', auth, async (req, res) => {
  try { res.json({ ok: true, ...(await asterisk.diagnoseTrunk(req.params.id)) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/reload', auth, async (req, res) => {
  const r = await asterisk.applySettings(store.load());
  res.json(r);
});

/**
 * Place a test call down one specific trunk with one specific sound file.
 *
 * Deliberately independent of campaign config: a trunk has to be provable on
 * its own, before there is a server, a lead list or anything else to go wrong.
 */
app.post('/api/trunks/:id/test-call', auth, (req, res) => {
  const s = store.load();
  const trunk = (s.trunks || []).find((t) => t.id === req.params.id);
  if (!trunk) return res.status(404).json({ ok: false, error: 'No such trunk' });

  const number = String(req.body.number || '').replace(/[^\d]/g, '');
  if (number.length < 7) {
    return res.status(400).json({ ok: false, error: 'Enter the full number including country code, digits only.' });
  }
  const sound = String(req.body.sound || '').trim();
  if (!sound) return res.status(400).json({ ok: false, error: 'Pick an audio file to play.' });

  console.log(`[test] request: trunk=${trunk.id} number=${number} sound=${sound}`);
  try {
    const job = testcall.start({
      number,
      trunkName: trunk.name,
      endpoint: `PJSIP/trunk-${trunk.id}`,
      numberFormat: trunk.numberFormat,
      sound,
      callerId: (trunk.callerId || '').replace(/[^\d]/g, ''),
      confirmKey: req.body.confirmKey || s.ivr.confirmKey,
      optOutKey: s.ivr.optOutKey,
      maxGreetings: req.body.maxGreetings || s.ivr.maxGreetings,
      waitSeconds: req.body.waitSeconds || s.ivr.waitSeconds,
    });
    res.json({ ok: true, jobId: job.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Ask the PBX now, instead of waiting for the next poll. */
app.post('/api/servers/:id/agents/refresh', auth, async (req, res) => {
  const s = store.load();
  const sv = (s.servers || []).find((x) => x.id === req.params.id);
  if (!sv) return res.status(404).json({ ok: false, error: 'No such server' });
  res.json(await agents.refresh(sv.id));
});

/** Counters accumulate across runs; this is how you start a clean test. */
app.post('/campaigns/:id/reset-stats', auth, (req, res) => {
  campaigns.saveStats(req.params.id, {
    dialed: 0, answered: 0, heardPrompt: 0, confirmed: 0,
    noKeypress: 0, optedOut: 0, failed: 0, lastFailure: '',
  });
  res.redirect('/campaigns?msg=' + encodeURIComponent('Counters reset.'));
});

/** Live agent availability for one server — what pacing will read. */
app.get('/api/servers/:id/agents', auth, (req, res) => {
  const s = store.load();
  const sv = (s.servers || []).find((x) => x.id === req.params.id);
  if (!sv) return res.status(404).json({ ok: false, error: 'No such server' });
  res.json({ ok: true, routeNumber: sv.routeNumber || '', ...agents.status(sv.id) });
});

/**
 * Prove the hand-off path, the mirror of the per-trunk test.
 *
 * Dials this module's own route number at the PBX, which means it exercises the
 * SIP leg, the inbound route you added there, and the queue behind it. If an
 * agent's phone rings, a confirmed press-1 will reach them the same way.
 */
app.post('/api/servers/:id/test-call', auth, (req, res) => {
  const s = store.load();
  const sv = (s.servers || []).find((x) => x.id === req.params.id);
  if (!sv) return res.status(404).json({ ok: false, error: 'No such server' });
  if (!sv.routeNumber) {
    return res.status(400).json({ ok: false, error: 'This server has no route number — save it again.' });
  }
  const sound = String(req.body.sound || '').trim() || s.ivr.greeting || 'campaign/test';
  // 'echo' proves audio in both directions; 'answer' only proves it arrives.
  const mode = req.body.mode === 'echo' ? 'echo' : 'answer';
  try {
    const job = testcall.start({
      number: sv.routeNumber,
      endpoint: `PJSIP/server-${sv.id}`,
      e164: false,
      mode,
      label: `${sv.name} → ${sv.routeNumber}`,
      sound,
      maxGreetings: 1,
      waitSeconds: 5,
    });
    res.json({ ok: true, jobId: job.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Run a whole IVR flow against one number, over the active trunk.
 *
 * The same code path a campaign will use: greeting, keypress, the action on
 * that key, the invalid and no-input counters, and a real transfer to the PBX
 * route. Testing a menu by reading it back to yourself finds nothing; dialling
 * it finds the prompt that was never uploaded and the key that does nothing.
 */
app.post('/api/ivr/:id/test-call', auth, (req, res) => {
  const s = store.load();
  const flow = ivr.get(req.params.id);
  if (!flow) return res.status(404).json({ ok: false, error: 'No such IVR flow' });

  const gaps = ivr.validate(flow);
  if (gaps.length) {
    return res.status(400).json({ ok: false,
      error: `This flow still needs: ${gaps.join('; ')}.` });
  }

  const trunk = store.activeTrunk(s);
  if (!trunk) return res.status(400).json({ ok: false, error: 'No active trunk — set one on the Trunks tab.' });
  const server = store.activeServer(s);

  const number = String(req.body.number || '').replace(/[^\d]/g, '');
  if (number.length < 7) {
    return res.status(400).json({ ok: false, error: 'Enter the full number including country code, digits only.' });
  }

  try {
    const job = testcall.start({
      number,
      endpoint: `PJSIP/trunk-${trunk.id}`,
      numberFormat: trunk.numberFormat,
      callerId: (trunk.callerId || '').replace(/[^\d]/g, ''),
      mode: 'flow',
      flow,
      label: flow.name,
      serverEndpoint: server ? `PJSIP/server-${server.id}` : '',
      routeNumber: server ? server.routeNumber : '',
      agentRingSeconds: req.body.agentRingSeconds,
      sound: flow.greetingAudio,
    });
    res.json({ ok: true, jobId: job.id, trunk: trunk.name,
      server: server ? server.name : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/test-call/:jobId', auth, (req, res) => {
  const job = testcall.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Unknown or expired test' });
  res.json({
    ok: true,
    state: job.state, finished: job.finished, passed: job.ok, result: job.result,
    number: job.number, sound: job.sound, digits: job.digits,
    path: job.path || [], events: job.events,
  });
});

app.post('/api/test-call', auth, (req, res) => {
  const number = String(req.body.number || '').replace(/[^\d+]/g, '');
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  const s = store.load();
  const missing = store.validate(s);
  if (missing.length) return res.json({ ok: false, result: `Not configured: ${missing.join(', ')}` });

  const ep = asterisk.activeEndpoints(s);
  const env = {
    ...process.env,
    TRUNK_ENDPOINT: ep.trunk, PBX_ENDPOINT: ep.server,
    AGENT_EXTEN: ep.routeNumber, CALLER_ID: ep.callerId || process.env.CALLER_ID || '',
    GREETING: `sound:${s.ivr.greeting}`,
    CONFIRM_KEY: s.ivr.confirmKey, OPTOUT_KEY: s.ivr.optOutKey,
    MAX_GREETINGS: String(s.ivr.maxGreetings), WAIT_SECONDS: String(s.ivr.waitSeconds),
  };
  exec(`node ${JSON.stringify(path.join(__dirname, 'press1-test.js'))} ${JSON.stringify(number)}`,
    { timeout: 150000, cwd: path.join(__dirname, '..'), env },
    (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      const result = (out.match(/RESULT:.*/) || ['no RESULT line — see output'])[0];
      res.json({ ok: /RESULT:/.test(out), result, output: out.slice(-4000) });
    });
});

if (audio.seedBundled()) console.log('Installed the bundled test tone as campaign/test.');

// Start watching agent availability straight away: the dialler reads it, and a
// socket that only connects on first use connects during the first campaign.
agents.sync(store.load());

// Nothing resumes by itself after a restart: a dialler that starts calling on
// its own after a deploy is a dialler nobody trusts.
dialer.haltAll();

app.listen(PORT, () => {
  console.log(`ShadowPBX Campaign UI on http://0.0.0.0:${PORT}  (login: ${ARI_USER})`);
  console.log(`Settings: ${store.FILE}`);
  console.log(`Audio:    ${audio.DIR}`);
});
