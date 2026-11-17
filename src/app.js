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
  res.render('trunks', base(req, { active: 'trunks', sub: 'trunks' })));

app.get('/servers', auth, (req, res) =>
  res.render('servers', base(req, { active: 'servers', sub: 'servers' })));

app.get('/audio', auth, async (req, res) =>
  res.render('audio', base(req, {
    active: 'audio', sub: 'audio',
    files: audio.list(), hasSox: await audio.haveSox(),
  })));

app.get('/ivr', auth, (req, res) =>
  res.render('ivr', base(req, { active: 'ivr', sub: 'ivr', files: audio.list() })));

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
    lists: leads.list(), files: audio.list(),
    defaults: { ivr: campaigns.DEFAULT_IVR, pacing: campaigns.DEFAULT_PACING },
  })));

app.get('/campaigns/:id', auth, (req, res) => {
  const c = campaigns.get(req.params.id);
  if (!c) return res.redirect('/campaigns?err=' + encodeURIComponent('Campaign not found'));
  res.render('campaign-edit', base(req, {
    active: 'campaigns', campaign: c,
    lists: leads.list(), files: audio.list(),
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
  res.redirect('/leads/' + l.id + '?msg=' + encodeURIComponent(
    `Imported ${r.imported} — ${r.dupes} duplicates, ${r.invalid} invalid. ` +
    `Detected phone column "${d.phone}"${d.name ? `, name "${d.name}"` : ''}` +
    `${d.prefix ? `, prefix "${d.prefix}"` : `, country code ${l.dialCode} applied`}.`));
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

app.post('/campaigns/:id/delete', auth, (req, res) => {
  campaigns.remove(req.params.id);
  res.redirect('/campaigns?msg=' + encodeURIComponent('Campaign deleted.'));
});

// ---------------------------------------------------------------- trunks
app.post('/trunks/save', auth, async (req, res) => {
  const s = store.saveTrunk(req.body);
  const r = await asterisk.applySettings(s);
  res.redirect(back('/trunks', r.ok ? { ok: true, message: 'Trunk saved. PJSIP reloaded.' } : r));
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
  const r = await asterisk.applySettings(s);
  res.redirect(back('/servers', r.ok ? { ok: true, message: 'Server saved. PJSIP reloaded.' } : r));
});
app.post('/servers/:id/activate', auth, async (req, res) => {
  const s = store.setActiveServer(req.params.id);
  await asterisk.applySettings(s);
  res.redirect('/servers?msg=' + encodeURIComponent('Active server switched.'));
});
app.post('/servers/:id/delete', auth, async (req, res) => {
  const s = store.deleteServer(req.params.id);
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
  store.saveIvr(req.body);
  res.redirect('/ivr?msg=' + encodeURIComponent('IVR settings saved.'));
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

app.post('/api/reload', auth, async (req, res) => {
  const r = await asterisk.applySettings(store.load());
  res.json(r);
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
    AGENT_EXTEN: ep.agentExten, CALLER_ID: ep.callerId || process.env.CALLER_ID || '',
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

app.listen(PORT, () => {
  console.log(`ShadowPBX Campaign UI on http://0.0.0.0:${PORT}  (login: ${ARI_USER})`);
  console.log(`Settings: ${store.FILE}`);
  console.log(`Audio:    ${audio.DIR}`);
});
