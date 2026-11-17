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
