'use strict';
/**
 * Login captcha — Cap (https://trycap.dev), embedded in this process.
 *
 * Proof-of-work: the browser burns a couple of seconds of CPU before it may
 * try a password. Invisible to a person, expensive for anything trying
 * passwords at scale. It sits on top of the per-IP login limiter, not in
 * place of it.
 *
 * Why embedded rather than Cap's standalone server: this box is a small VPS
 * already running Asterisk, and a second service (plus the Valkey it wants)
 * is memory it does not have. The trade-off is honest: the embedded library
 * does proof-of-work only, while the standalone server can add browser
 * instrumentation as a second layer. For a login page with a lockout behind
 * it, proof-of-work is the part that matters.
 *
 * Nothing here talks to a third party. By default the widget fetches its
 * solver from cdn.jsdelivr.net; that would make every login depend on a CDN
 * and fail on any network that blocks it, so all four browser files are
 * served from this app out of node_modules.
 *
 * Off unless LOGIN_CAPTCHA=on, so existing installs and IP-only servers are
 * unchanged. scripts/setup-https.sh turns it on for domain installs. If it
 * ever misbehaves, set LOGIN_CAPTCHA=off and restart: the login works
 * exactly as before, so it can never lock you out of your own server.
 */
const path = require('path');

const enabled = () =>
  ['on', '1', 'true', 'yes'].includes(String(process.env.LOGIN_CAPTCHA || 'off').toLowerCase());

let cap = null;
function instance() {
  if (cap) return cap;
  const Cap = require('@cap.js/server');
  // noFSState: challenges and tokens live in memory. They last minutes, and
  // writing them to a file in the working directory buys nothing.
  cap = new Cap({ noFSState: true });
  return cap;
}

/**
 * Challenge issuing is unauthenticated by necessity, and each challenge is
 * held in memory until it expires. Without a cap, anyone could fill memory by
 * asking for challenges in a loop. Per IP for the ordinary case, and a global
 * ceiling for a flood spread across many addresses.
 */
const PER_IP = 30, PER_IP_WINDOW = 10 * 60 * 1000;
const GLOBAL_PER_MIN = 600;
const perIp = new Map();
let globalWindow = { start: 0, n: 0 };
function allowChallenge(ip) {
  const now = Date.now();
  if (now - globalWindow.start > 60000) globalWindow = { start: now, n: 0 };
  if (++globalWindow.n > GLOBAL_PER_MIN) return false;
  const rec = perIp.get(ip);
  if (!rec || rec.until < now) { perIp.set(ip, { n: 1, until: now + PER_IP_WINDOW }); }
  else if (++rec.n > PER_IP) return false;
  if (perIp.size > 20000) perIp.clear();         // bounded under a flood
  return true;
}

/** Where a package's files live, wherever npm decided to put it. */
function pkgDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`));
}

function mount(app) {
  if (!enabled()) return false;
  // Fail now, at startup, if a dependency is missing -- not on the first
  // login, when the only way to find out is being locked out.
  instance();
  const files = {
    'cap.min.js': path.join(pkgDir('@cap.js/widget'), 'cap.min.js'),
    'cap_wasm_bg.wasm': path.join(pkgDir('@cap.js/wasm'), 'browser', 'cap_wasm_bg.wasm'),
    'hashwx.wasm': path.join(pkgDir('@cap.js/wasm'), 'browser', 'hashwx.wasm'),
    'pako_inflate.min.js': path.join(pkgDir('pako'), 'dist', 'pako_inflate.min.js'),
  };
  // Exactly these four files, by name: nothing else from node_modules is
  // reachable, whatever the path asked for.
  app.get('/cap-assets/:file', (req, res) => {
    const f = files[req.params.file];
    if (!f) return res.status(404).end();
    if (req.params.file.endsWith('.wasm')) res.type('application/wasm');
    res.sendFile(f, { maxAge: '7d' });
  });

  app.post('/cap/challenge', async (req, res) => {
    if (!allowChallenge(req.ip || 'unknown')) {
      return res.status(429).json({ error: 'Too many verification requests. Wait a few minutes.' });
    }
    try { res.json(await instance().createChallenge()); }
    catch (e) { res.status(500).json({ error: 'Could not create a challenge' }); }
  });

  app.post('/cap/redeem', async (req, res) => {
    const { token, solutions } = req.body || {};
    // Shape-check before handing anything to the library: this endpoint is
    // public, and its input is whatever someone chose to send.
    if (typeof token !== 'string' || token.length > 512 || !Array.isArray(solutions)
        || solutions.length > 1000 || !solutions.every((n) => Number.isInteger(n))) {
      return res.status(400).json({ success: false, message: 'Malformed solution' });
    }
    try { res.json(await instance().redeemChallenge({ token, solutions })); }
    catch (e) { res.status(400).json({ success: false, message: 'Invalid solution' }); }
  });
  return true;
}

/**
 * Check the token the widget put in the login form. Single use: the library
 * deletes a token as it validates it, so a solved challenge buys exactly one
 * password attempt and cannot be replayed.
 */
async function verify(token) {
  if (!enabled()) return { ok: true };
  if (typeof token !== 'string' || !token || token.length > 512) {
    return { ok: false, error: 'Please wait for the verification check to finish, then sign in.' };
  }
  try {
    const r = await instance().validateToken(token);
    return r && r.success ? { ok: true }
      : { ok: false, error: 'Verification expired or was already used. Wait for the check to finish and try again.' };
  } catch (e) {
    return { ok: false, error: 'The verification could not be checked. Try again.' };
  }
}

module.exports = { enabled, mount, verify };
