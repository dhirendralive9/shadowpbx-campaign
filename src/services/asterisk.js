'use strict';
/**
 * Asterisk control + status.
 *
 * Status is read through the CLI (`asterisk -rx`) rather than ARI on purpose:
 * the CLI works the moment Asterisk is running, whereas ARI needs config that
 * this very UI is used to write. A status page that goes blank because ARI
 * isn't configured yet would be useless exactly when it's needed most.
 *
 * Call control (originate, playback, DTMF, bridge) still goes over ARI — see
 * the campaign engine.
 */
const { execFile, execSync } = require('child_process');
const fs = require('fs');

const ASTERISK_ETC = process.env.ASTERISK_ETC || '/etc/asterisk';
const SOUNDS_DIR = process.env.ASTERISK_SOUNDS || '/var/lib/asterisk/sounds';

/**
 * Run one Asterisk CLI command.
 *
 * execFile, never exec. This used to build `asterisk -rx "<cmd>"` and hand it
 * to a shell; JSON.stringify's double quotes do not stop $(...) or backticks,
 * and commands here interpolate ids that arrive in URLs. As this service runs
 * as root, GET /api/trunks/$(anything)/diagnose was a root shell for any
 * logged-in user, and for anyone who could get one to follow a link.
 * With an argument array the command is one argv entry and no shell exists.
 */
function cli(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile('asterisk', ['-rx', String(cmd)], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, out: String(stderr || err.message).trim() });
      resolve({ ok: true, out: String(stdout).trim() });
    });
  });
}

async function isRunning() {
  const r = await cli('core show version', 4000);
  return r.ok && /Asterisk/i.test(r.out);
}

/** Parse `pjsip show registrations` into something renderable. */
function parseRegistrations(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\S+)\/(\S+)\s+(\S+)\s+(Registered|Rejected|Unregistered|Sent|Failed|No Auth)\b/i);
    if (m) rows.push({ name: m[1], uri: m[2], auth: m[3], status: m[4] });
  }
  return rows;
}

/** Parse `pjsip show endpoints` — only the Endpoint: lines. */
function parseEndpoints(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*Endpoint:\s+(\S+?)(?:\/(\S+))?\s+(Unavailable|Available|Not in use|In use|Busy|Unknown)\s+(\d+ of \S+)/i);
    if (m) rows.push({ name: m[1], state: m[3], channels: m[4] });
  }
  return rows;
}

/**
 * Parse `pjsip show contacts`.
 *
 * An IP-authenticated trunk never registers, so it has no row in
 * `pjsip show registrations` and would show as permanently unknown. Its real
 * health is the qualify (OPTIONS) result against its AOR, which lives here.
 */
function parseContacts(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*Contact:\s+(\S+?)\/(\S+)\s+(\S+)\s+(Avail|Unavail|Unknown|NonQual)\s*(\S+)?/i);
    if (m) rows.push({ aor: m[1], uri: m[2], status: m[4], rtt: m[5] || '' });
  }
  return rows;
}

async function status() {
  const running = await isRunning();
  if (!running) {
    return { running: false, version: null, registrations: [], endpoints: [], contacts: [], ari: { loaded: 0, ok: false }, http: '', channels: 0 };
  }
  const [ver, regs, eps, cts, ari, http, chans] = await Promise.all([
    cli('core show version'),
    cli('pjsip show registrations'),
    cli('pjsip show endpoints'),
    cli('pjsip show contacts'),
    cli('module show like res_ari'),
    cli('http show status'),
    cli('core show channels count'),
  ]);

  const ariLoaded = (ari.out.match(/^res_ari\S*\.so/gm) || []).length;
  const chanMatch = chans.out.match(/(\d+)\s+active channel/i);

  return {
    running: true,
    version: (ver.out.split('\n')[0] || '').trim(),
    registrations: parseRegistrations(regs.out),
    endpoints: parseEndpoints(eps.out),
    contacts: parseContacts(cts.out),
    // res_ari_model alone means ARI never actually started.
    ari: { loaded: ariLoaded, ok: ariLoaded > 1, raw: ari.out },
    http: http.out,
    channels: chanMatch ? parseInt(chanMatch[1], 10) : 0,
  };
}

/**
 * Render pjsip.conf from settings.
 *
 * ALL trunks and servers get endpoints so you can see each one register and
 * switch without rewriting config; the ones marked active are what the
 * dialler uses. Generated file — the UI rewrites it on every save.
 */
function renderPjsip(s) {
  const st = require('./settings');
  const aT = st.activeTrunk(s), aS = st.activeServer(s);
  /**
   * Make a value safe to place in a pjsip.conf line.
   *
   * This was the identity function. Every trunk and server field lands in a
   * config file Asterisk loads as root, and the trunk NAME goes on a comment
   * line -- so a newline in any field ended the line and started a section of
   * the author's choosing: an endpoint matching any IP, a registration sending
   * the real credentials somewhere else. Line breaks and other control
   * characters go; `;` would start a comment mid-value (truncating a password
   * that contains one), so it is escaped the way Asterisk reads it.
   */
  const esc = (v) => String(v == null ? '' : v)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/;/g, '\\;');

  let out = `;==============================================================
; GENERATED by the ShadowPBX Campaign UI — do not edit by hand.
; Saving settings rewrites this file and reloads PJSIP.
; Written: ${new Date().toISOString()}
;
; Load-bearing, do not relax:
;   allow = ulaw,alaw  -> G.711 only. G.729 made prompts inaudible.
;   dtmf_mode = auto   -> RFC2833 + in-band fallback, so a carrier that
;                         won't negotiate telephone-event can't break press-1.
;
; A trunk with Register off is IP-authenticated: no registration block is
; emitted, and the provider recognises us by source IP alone. Sending REGISTER
; to such an account earns a bare 403 with no auth challenge.
;==============================================================

[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060
`;

  /**
   * A registering trunk is matched on its account name, so From must carry it.
   * A trunk that authenticates per-INVITE usually wants the same. An
   * IP-authenticated one is matched on source IP and normally wants a real
   * number, because the account name there earns a 403.
   */
  const fromUserFor = (t, hasAuth) => {
    if (t.fromUser === 'user') return t.user;
    if (t.fromUser === 'callerid') return t.callerId || t.user;
    return (t.register || hasAuth) ? t.user : (t.callerId || t.user);
  };

  for (const t of s.trunks || []) {
    if (!t.host || !t.user) continue;
    const id = `trunk-${t.id}`;
    const active = aT && aT.id === t.id;
    out += `
;---------------- ${esc(t.name)}${active ? '   [ACTIVE]' : ''} ----------------
`;
    // With IP authentication there is nothing to authenticate against. A trunk
    // saved without a password must not get a half-filled auth section.
    const hasAuth = !!(t.user && t.pass);

    if (t.register) {
      // outbound_auth must not name a section that does not exist: Asterisk
      // refuses the whole registration object, `pjsip show registrations`
      // reports "No objects found", and the UI sits on "—" forever with no
      // visible error. A registration with no credentials is still wrong, but
      // it fails where you can see it.
      // `endpoint` on a registration REQUIRES `line = yes`. Without it Asterisk
      // logs "An endpoint has been specified on outbound registration ...
      // without enabling line support" and then REFUSES TO CREATE THE OBJECT
      // AT ALL -- no REGISTER is ever sent, `pjsip show registrations` is
      // empty, and the provider answers the first INVITE with 403 because it
      // has never heard from us. That 403 reads exactly like a From-header
      // problem, which is what made this expensive to find.
      out += `[${id}]
type = registration
transport = transport-udp
${hasAuth ? `outbound_auth = ${id}-auth` : '; no password saved for this trunk — registering without credentials'}
server_uri = sip:${esc(t.host)}
client_uri = sip:${esc(t.user)}@${esc(t.host)}
${t.lineSupport === false
  ? '; line support off — inbound is matched by the identify section instead'
  : `line = yes\nendpoint = ${id}`}
retry_interval = 60
forbidden_retry_interval = 600
expiration = 3600

`;
    }
    // A registering trunk is matched on its account name, so From must carry
    // it. An IP-authenticated one is matched on source IP and usually wants a
    // real number in From instead -- an account name there earns a 403 on the
    // INVITE even though the trunk itself is accepted.
    if (hasAuth) {
      out += `[${id}-auth]
type = auth
auth_type = userpass
username = ${esc(t.authUser || t.user)}
password = ${esc(t.pass)}

`;
    }
    out += `[${id}]
type = aor
contact = sip:${esc(t.host)}:${t.port || 5060}
qualify_frequency = 60

[${id}]
type = endpoint
transport = transport-udp
context = campaign-out
disallow = all
allow = ulaw,alaw
${hasAuth ? `outbound_auth = ${id}-auth` : '; IP-authenticated - no outbound_auth'}
aors = ${id}
from_user = ${esc(fromUserFor(t, hasAuth))}
from_domain = ${esc(t.host)}
dtmf_mode = auto
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
trust_id_outbound = yes

[${id}]
type = identify
endpoint = ${id}
match = ${Array.from(new Set([esc(t.host)].concat(String(t.matchIps || '').split(/[\s,]+/).filter(Boolean)))).join(',')}
`;
  }

  for (const sv of s.servers || []) {
    if (!sv.host) continue;
    const id = `server-${sv.id}`;
    const active = aS && aS.id === sv.id;
    out += `
;---------------- ${esc(sv.name)}${active ? '   [ACTIVE]' : ''} ----------------
[${id}]
type = aor
contact = sip:${esc(sv.host)}:${sv.port || 5060}
qualify_frequency = 60

[${id}]
type = endpoint
transport = transport-udp
context = from-pbx
disallow = all
allow = ulaw,alaw
aors = ${id}
dtmf_mode = auto
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes

[${id}]
type = identify
endpoint = ${id}
match = ${esc(sv.host)}
`;
  }
  return out;
}

/** PJSIP endpoint names for the active trunk/server, for the dialler. */
function activeEndpoints(s) {
  const st = require('./settings');
  const t = st.activeTrunk(s), sv = st.activeServer(s);
  return {
    trunk: t ? `PJSIP/trunk-${t.id}` : null,
    server: sv ? `PJSIP/server-${sv.id}` : null,
    // Transfers go to the module's own route number, which the PBX maps to a
    // ring group or queue. There is no single agent extension to dial.
    routeNumber: sv ? sv.routeNumber : null,
    callerId: t ? t.callerId : '',
  };
}

/**
 * Write pjsip.conf and reload.
 *
 * Always writes whatever is configured. A trunk with no server yet is
 * perfectly valid config -- it should still register, because the server only
 * matters at transfer time. Refusing to write until everything is filled in
 * left Asterisk reading stale config and made a saved trunk look ignored.
 * Anything still missing is reported, not used as a reason to do nothing.
 */
async function applySettings(s) {
  const target = `${ASTERISK_ETC}/pjsip.conf`;
  try {
    fs.writeFileSync(target, renderPjsip(s), { mode: 0o640 });
  } catch (e) {
    return { ok: false, message: `Could not write ${target}: ${e.message} (is the service running as root?)` };
  }

  // Written as root at 0640, so without this the asterisk user cannot read its
  // own config and every endpoint silently disappears.
  try {
    const uid = parseInt(execSync('id -u asterisk').toString().trim(), 10);
    const gid = parseInt(execSync('id -g asterisk').toString().trim(), 10);
    if (!Number.isNaN(uid) && !Number.isNaN(gid)) fs.chownSync(target, uid, gid);
  } catch (e) {
    // No asterisk user (or not root) — leave ownership alone rather than fail.
  }

  const r = await cli('pjsip reload');
  if (!r.ok) return { ok: false, message: `Config written but reload failed: ${r.out}` };

  const missing = require('./settings').validate(s);
  return {
    ok: true,
    message: 'Saved. PJSIP reloaded.' +
      (missing.length ? ` Still needed before calls can be placed: ${missing.join(', ')}.` : ''),
  };
}


// Debian packages log to messages.log; a source build's stock logger.conf
// writes messages (no extension) and only adds `full` if you enable it. Try
// every spelling rather than reporting "nothing captured" on a box that is
// logging perfectly well under a different name.
const LOG_CANDIDATES = [
  '/var/log/asterisk/full', '/var/log/asterisk/full.log',
  '/var/log/asterisk/messages', '/var/log/asterisk/messages.log',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tail the Asterisk log, newest lines last. */
function logTail(lines = 400) {
  for (const f of LOG_CANDIDATES) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      return txt.split('\n').slice(-lines).join('\n');
    } catch (e) { /* try next */ }
  }
  return '';
}

/**
 * Work out WHY a registration is being rejected.
 *
 * "Rejected" only tells you the far end said no. The reason is in the SIP
 * response, so turn the PJSIP logger on, force a REGISTER, and pull the
 * exchange back out of the log.
 */
/** Trunk ids are generated hex; anything else is not ours and goes nowhere. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
function regName(id) {
  if (!SAFE_ID.test(String(id || ''))) throw new Error('Invalid trunk id');
  return `trunk-${id}`;
}

async function diagnoseTrunk(id) {
  const reg = regName(id);
  const out = { registration: '', endpoint: '', sip: '', hint: '' };

  await cli('pjsip set logger on');
  await cli(`pjsip send register ${reg}`);
  await sleep(3500);

  out.registration = (await cli(`pjsip show registration ${reg}`)).out;
  out.endpoint = (await cli(`pjsip show endpoint ${reg}`)).out.split('\n').slice(0, 18).join('\n');

  // Keep only SIP traffic and registration lines from the tail.
  const tail = logTail(500).split('\n');
  const keep = [];
  for (const l of tail) {
    if (/REGISTER|SIP\/2\.0 \d{3}|Transmitting|Received|res_pjsip|registration/i.test(l)) keep.push(l);
  }
  out.sip = keep.slice(-60).join('\n');
  await cli('pjsip set logger off');

  // Translate the response code into something actionable.
  const m = out.sip.match(/SIP\/2\.0 (40[0-9]|4[1-9][0-9]|5\d\d|6\d\d)[^\n]*/g);
  const codes = (m || []).map((x) => x.match(/SIP\/2\.0 (\d{3})/)[1]);
  if (codes.includes('403') && !codes.includes('401') && !codes.includes('407')) {
    // No challenge before the refusal: the provider never even asked for a
    // password, so the password cannot be what it objects to.
    out.hint = '403 Forbidden with no 401 challenge first — the provider refused before asking for credentials, '
      + 'so this is policy, not a wrong password. Almost always it means the account is IP-authenticated '
      + '(“IP to IP”) and does not accept REGISTER at all: untick “Register with the provider” on this trunk '
      + 'and make sure this server’s public IP is the one on the account. The other cause is an IP that is not '
      + 'authorised yet, or an account already registered from somewhere else.';
  } else if (codes.includes('403')) out.hint = '403 Forbidden after a challenge — the credentials were read and rejected. '
    + 'Check the username and password exactly, and whether the provider expects a separate auth username. '
    + 'If the SAME account is registered somewhere else right now (the PBX, a softphone), that is the usual cause: '
    + 'many providers allow one registration per account and refuse the second. Unregister it there and retry here.';
  else if (codes.includes('401') || codes.includes('407')) out.hint = '401 after the credentials were sent — Asterisk answered the challenge and was challenged again, '
    + 'which it treats as fatal ("stopping outbound registration") and will not retry until the trunk is saved. '
    + 'Two causes: the password is not what the provider holds (blank means unchanged on this form, so a wrong one '
    + 'persists — type it in again), or the provider authenticates under a different ID than the account name, '
    + 'which goes in "Auth username". A trunk that registers elsewhere with the same account name almost always '
    + 'means one of these two differs between the two machines.';
  else if (codes.includes('404')) out.hint = '404 Not Found — the provider does not recognise this account on that host. Check the SIP host and username.';
  else if (codes.includes('408') || !out.sip.trim()) out.hint = 'No response — the REGISTER is not reaching the provider. Check outbound UDP 5060 and that the SIP host resolves.';
  else if (codes.includes('503')) out.hint = '503 Service Unavailable — provider-side problem or rate limiting.';
  else if (codes.includes('423')) out.hint = '423 Interval Too Brief — the provider wants a longer expiry than the 3600s requested.';
  else if (codes.includes('400')) out.hint = '400 Bad Request — the provider objects to the REGISTER itself rather than to the account. '
    + 'The usual culprit is the Contact header: with line support on, Asterisk appends a ;line= parameter and a strict '
    + 'registrar can refuse it. Turn off "Line support" on this trunk and try again.';
  return out;
}


/**
 * Force a registration attempt now.
 *
 * After an auth rejection PJSIP sets forbidden_retry_interval (600s) and will
 * not retry before then, so a corrected password looks like it changed
 * nothing. Unregister + register clears that wait.
 */
async function reRegister(id) {
  const reg = regName(id);
  await cli(`pjsip send unregister ${reg}`);
  await sleep(600);
  const r = await cli(`pjsip send register ${reg}`);
  await sleep(2500);
  const detail = await cli(`pjsip show registration ${reg}`);
  const status = (detail.out.match(/\b(Registered|Rejected|Unregistered|Sent|Failed|No Auth)\b/) || [])[1] || 'Unknown';
  return { ok: r.ok, status, detail: detail.out };
}

/** Sound files available for the greeting dropdown. */
function listSounds() {
  const dir = `${SOUNDS_DIR}/campaign`;
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(wav|gsm|ulaw|alaw)$/i.test(f))
      .map((f) => `campaign/${f.replace(/\.[^.]+$/, '')}`)
      .filter((v, i, a) => a.indexOf(v) === i);
  } catch (e) {
    return [];
  }
}

module.exports = { cli, status, isRunning, renderPjsip, activeEndpoints, applySettings, listSounds, diagnoseTrunk, reRegister, logTail, SOUNDS_DIR };
