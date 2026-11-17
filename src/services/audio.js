'use strict';
/**
 * Audio library — the greetings played to leads.
 *
 * Asterisk needs 8kHz mono 16-bit PCM. Uploads are converted with sox rather
 * than trusted, because a 44.1kHz stereo file plays as silence or noise and
 * that failure is very hard to recognise from the dialler side.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = process.env.CAMPAIGN_SOUNDS || '/var/lib/asterisk/sounds/campaign';
const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,60}$/;

// Shipped with the app and managed by it: always present, cannot be deleted,
// renamed or overwritten from the UI. Lower-case, compared case-insensitively.
const BUILTIN = new Set(['test.wav']);
const isBuiltin = (file) => BUILTIN.has(String(file || '').toLowerCase());
const LOCKED = (file) => `${file} is built-in and cannot be changed or deleted`;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function list() {
  ensureDir();
  seedBundled();   // self-heal if the built-in file was removed behind our back
  try {
    return fs.readdirSync(DIR)
      .filter((f) => /\.wav$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(DIR, f));
        return {
          file: f,
          builtin: isBuiltin(f),
          name: f.replace(/\.wav$/i, ''),
          // How the IVR refers to it — Asterisk wants no extension.
          soundId: `campaign/${f.replace(/\.wav$/i, '')}`,
          bytes: st.size,
          // 8kHz mono 16-bit = 16000 bytes/sec, minus a 44-byte header.
          seconds: Math.max(0, Math.round((st.size - 44) / 16000)),
          updatedAt: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    return [];
  }
}

function safeName(name) {
  const base = String(name || '').replace(/\.wav$/i, '').trim();
  return SAFE.test(base) ? base.replace(/\s+/g, '-') : null;
}

/** Convert an uploaded file to the only format Asterisk reliably plays. */
function convert(srcPath, destName) {
  return new Promise((resolve) => {
    const name = safeName(destName);
    if (!name) {
      try { fs.unlinkSync(srcPath); } catch (e) {}
      return resolve({ ok: false, error: 'Invalid name — letters, numbers, spaces, - and _ only' });
    }
    if (isBuiltin(`${name}.wav`)) {
      try { fs.unlinkSync(srcPath); } catch (e) {}
      return resolve({ ok: false, error: `"${name}" is a built-in sound — pick another name` });
    }
    ensureDir();
    const dest = path.join(DIR, `${name}.wav`);
    execFile('sox', [srcPath, '-r', '8000', '-c', '1', '-b', '16', dest],
      { timeout: 60000 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(srcPath); } catch (e) {}
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n').slice(-2).join(' ');
          return resolve({ ok: false, error: `Conversion failed: ${msg}` });
        }
        try { fs.chmodSync(dest, 0o644); } catch (e) {}
        resolve({ ok: true, name, soundId: `campaign/${name}` });
      });
  });
}

function rename(oldFile, newName) {
  const name = safeName(newName);
  if (!name) return { ok: false, error: 'Invalid name' };
  if (!/^[^/\\]+\.wav$/i.test(oldFile)) return { ok: false, error: 'Invalid file' };
  if (isBuiltin(oldFile)) return { ok: false, error: LOCKED(oldFile) };
  if (isBuiltin(`${name}.wav`)) return { ok: false, error: `"${name}" is reserved for a built-in sound` };
  const from = path.join(DIR, oldFile);
  const to = path.join(DIR, `${name}.wav`);
  if (!fs.existsSync(from)) return { ok: false, error: 'File not found' };
  if (fs.existsSync(to) && from !== to) return { ok: false, error: 'A file with that name already exists' };
  try {
    fs.renameSync(from, to);
    return { ok: true, name, soundId: `campaign/${name}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function remove(file) {
  if (!/^[^/\\]+\.wav$/i.test(file)) return { ok: false, error: 'Invalid file' };
  if (isBuiltin(file)) return { ok: false, error: LOCKED(file) };
  try {
    fs.unlinkSync(path.join(DIR, file));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'File not found' : e.message };
  }
}

function filePath(file) {
  if (!/^[^/\\]+\.wav$/i.test(file)) return null;
  const p = path.join(DIR, file);
  return fs.existsSync(p) ? p : null;
}

/**
 * Copy the bundled test tone into the sound library on startup.
 *
 * A brand-new install has no audio at all, which makes the one thing you want
 * to do first -- prove a trunk carries a call you can hear -- impossible until
 * you have uploaded something. The file ships in the repo already at 8kHz mono
 * 16-bit, so it needs no conversion and works before sox is even installed.
 *
 * It is a built-in: restored whenever it is missing or differs from the bundled
 * copy, and the UI/API refuse to delete, rename or overwrite it.
 */
function seedBundled() {
  const src = path.join(__dirname, '../../test/test.wav');
  const dest = path.join(DIR, 'test.wav');
  try {
    if (!fs.existsSync(src)) return false;
    if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) return false;
    ensureDir();
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o644);
    return true;
  } catch (e) {
    // A missing sounds directory on a box without Asterisk yet is not worth
    // refusing to start over.
    return false;
  }
}

function haveSox() {
  return new Promise((r) => execFile('which', ['sox'], (e) => r(!e)));
}

module.exports = { DIR, isBuiltin, list, convert, rename, remove, filePath, haveSox, ensureDir, seedBundled };
