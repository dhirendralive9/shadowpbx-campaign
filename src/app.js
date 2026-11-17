#!/usr/bin/env node
'use strict';
/**
 * ShadowPBX Campaign Module — web UI.
 *
 * Login uses ARI_USER / ARI_PASS from .env, so there is one credential for the
 * box rather than a separate user store to manage.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const { exec } = require('child_process');

const settingsStore = require('./services/settings');
const asterisk = require('./services/asterisk');

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
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || ARI_PASS,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 },
}));

const requireAuth = (req, res, next) =>
  req.session && req.session.user ? next() : res.redirect('/login');

// ---------------------------------------------------------------- auth
app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ARI_USER && password === ARI_PASS) {
    req.session.user = username;
    return res.redirect('/');
  }
  // Same delay either way so a wrong username isn't distinguishable.
  setTimeout(() => res.status(401).render('login', { error: 'Invalid credentials' }), 400);
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------------------------------------------------------------- pages
app.get('/', requireAuth, async (req, res) => {
  const s = settingsStore.load();
  res.render('dashboard', {
    page: 'dashboard',
    settings: s,
    missing: settingsStore.validate(s),
    flash: req.query.msg || null,
    flashErr: req.query.err || null,
  });
});

app.get('/settings', requireAuth, (req, res) => {
  const s = settingsStore.load();
  res.render('settings', {
    page: 'settings',
    settings: s,
    sounds: asterisk.listSounds(),
    flash: req.query.msg || null,
    flashErr: req.query.err || null,
  });
});

app.post('/settings', requireAuth, async (req, res) => {
  const b = req.body;
  const patch = {
    trunk: {
      host: (b.trunk_host || '').trim(),
      user: (b.trunk_user || '').trim(),
      port: parseInt(b.trunk_port, 10) || 5060,
      transport: b.trunk_transport || 'udp',
      register: b.trunk_register === 'on',
      callerId: (b.caller_id || '').trim(),
    },
    pbx: {
      host: (b.pbx_host || '').trim(),
      port: parseInt(b.pbx_port, 10) || 5060,
      agentExten: (b.agent_exten || '').trim(),
      apiUrl: (b.api_url || '').trim(),
    },
    ivr: {
      greeting: (b.greeting || '').trim(),
      confirmKey: (b.confirm_key || '1').trim(),
      optOutKey: (b.optout_key || '2').trim(),
      maxGreetings: Math.max(1, parseInt(b.max_greetings, 10) || 2),
      waitSeconds: Math.max(3, parseInt(b.wait_seconds, 10) || 8),
    },
  };
  // Blank password/key fields mean "leave unchanged" — so the stored secret
  // isn't wiped just because the form doesn't echo it back.
  if ((b.trunk_pass || '').trim()) patch.trunk.pass = b.trunk_pass.trim();
  if ((b.api_key || '').trim()) patch.pbx.apiKey = b.api_key.trim();

  const saved = settingsStore.save(patch);
  const result = await asterisk.applySettings(saved);
  const q = result.ok
    ? `?msg=${encodeURIComponent(result.message)}`
    : `?err=${encodeURIComponent(result.message)}`;
  res.redirect('/settings' + q);
});

// ---------------------------------------------------------------- api
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const st = await asterisk.status();
    const s = settingsStore.load();
    res.json({ ok: true, status: st, missing: settingsStore.validate(s) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/reload', requireAuth, async (req, res) => {
  const result = await asterisk.applySettings(settingsStore.load());
  res.json(result);
});

// Place a single test call through the press-1 flow.
app.post('/api/test-call', requireAuth, (req, res) => {
  const number = String(req.body.number || '').replace(/[^\d+]/g, '');
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  const script = path.join(__dirname, 'press1-test.js');
  exec(`node ${JSON.stringify(script)} ${JSON.stringify(number)}`,
    { timeout: 150000, cwd: path.join(__dirname, '..') },
    (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      const result = (out.match(/RESULT:.*/) || ['no RESULT line — see output'])[0];
      res.json({ ok: !err || /RESULT:/.test(out), result, output: out.slice(-4000) });
    });
});

app.listen(PORT, () => {
  console.log(`ShadowPBX Campaign UI on http://0.0.0.0:${PORT}  (login: ${ARI_USER})`);
  console.log(`Settings file: ${settingsStore.FILE}`);
});
