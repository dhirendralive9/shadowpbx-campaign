'use strict';
/**
 * Lead lists.
 *
 * Each list is named and carries a country + dial code. The dial code is what
 * makes numbers dialable: CSVs routinely hold national numbers with no country
 * code, and the old PBX importer mangled those by assuming +1 and stripping a
 * leading "1" — turning German 15732742722 into 5732742722. Here the country
 * is declared per list, so normalisation is deterministic.
 *
 * Metadata lives in data/leads/index.json; rows live one file per list so a
 * 100k-row import doesn't bloat every read.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.LEADS_DIR || path.join(__dirname, '../../data/leads');
const INDEX = path.join(DIR, 'index.json');
const newId = () => crypto.randomBytes(6).toString('hex');

const COUNTRIES = [
  { code: '49', name: 'Germany' },      { code: '43', name: 'Austria' },
  { code: '41', name: 'Switzerland' },  { code: '44', name: 'United Kingdom' },
  { code: '1',  name: 'United States' },{ code: '1',  name: 'Canada' },
  { code: '31', name: 'Netherlands' },  { code: '32', name: 'Belgium' },
  { code: '33', name: 'France' },       { code: '34', name: 'Spain' },
  { code: '39', name: 'Italy' },        { code: '351', name: 'Portugal' },
  { code: '353', name: 'Ireland' },     { code: '45', name: 'Denmark' },
  { code: '46', name: 'Sweden' },       { code: '47', name: 'Norway' },
  { code: '48', name: 'Poland' },       { code: '420', name: 'Czechia' },
  { code: '30', name: 'Greece' },       { code: '36', name: 'Hungary' },
  { code: '40', name: 'Romania' },      { code: '358', name: 'Finland' },
  { code: '61', name: 'Australia' },    { code: '64', name: 'New Zealand' },
  { code: '91', name: 'India' },        { code: '971', name: 'UAE' },
  { code: '27', name: 'South Africa' },
];

function ensure() { fs.mkdirSync(DIR, { recursive: true }); }

function readIndex() {
  ensure();
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (e) { return []; }
}
function writeIndex(list) {
  ensure();
  const tmp = `${INDEX}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, INDEX);
  return list;
}

const rowsPath = (id) => path.join(DIR, `${id}.json`);
/**
 * Rows, cached in memory.
 *
 * A running campaign asks for this list constantly: the dialler ticks every
 * two seconds, the dashboard polls `remaining()` just as often, and every
 * completed call looks up its own row more than once. Parsing a few thousand
 * rows of JSON each time turns a quiet campaign into a busy CPU, and it gets
 * worse exactly as the list gets bigger.
 *
 * The cache is invalidated by the file's own mtime and size, so anything that
 * edits the file behind this process -- a restore, another tool, a hand edit
 * -- is still picked up rather than being masked until a restart.
 */
const rowCache = new Map();                        // id -> { key, rows }

function readRows(id) {
  const file = rowsPath(id);
  let key;
  try {
    const st = fs.statSync(file);
    key = `${st.mtimeMs}:${st.size}`;
  } catch (e) {
    rowCache.delete(id);
    return [];
  }
  const hit = rowCache.get(id);
  if (hit && hit.key === key) return hit.rows;
  let rows;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
  if (!Array.isArray(rows)) rows = [];
  rowCache.set(id, { key, rows });
  return rows;
}

function writeRows(id, rows) {
  ensure();
  const tmp = `${rowsPath(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, rowsPath(id));
  // Seed the cache from what we just wrote rather than dropping it, so the
  // next read -- which during a campaign is milliseconds away -- does not
  // have to parse the file straight back in.
  try {
    const st = fs.statSync(rowsPath(id));
    rowCache.set(id, { key: `${st.mtimeMs}:${st.size}`, rows });
  } catch (e) { rowCache.delete(id); }
}

/**
 * Normalise a phone number to full international form, no plus.
 *
 * dialCode is the list's country code. The number keeps every subscriber
 * digit: only a national trunk "0" is dropped, and nothing is stripped on the
 * assumption of a country.
 */
function normalizePhone(raw, dialCode, rowPrefix) {
  if (raw == null) return '';
  const str = String(raw).trim();
  if (!str) return '';

  const intl = str.startsWith('+') || /^00\d/.test(str);
  let num = str.replace(/[^\d]/g, '');
  if (!num) return '';

  if (num.startsWith('00')) num = num.slice(2);
  else if (intl) { /* already international, digits are complete */ }

  // A per-row prefix column wins over the list default.
  const cc = String(rowPrefix || dialCode || '').replace(/[^\d]/g, '');
  if (!intl && cc && !num.startsWith(cc)) {
    num = cc + num.replace(/^0/, '');   // drop national trunk 0
  }
  return num;
}

const ALIASES = {
  phone: ['phone', 'phone_number', 'phonenumber', 'number', 'tel', 'telephone', 'mobile', 'cell', 'msisdn'],
  name:  ['name', 'full_name', 'fullname', 'full name', 'contact', 'contact_name', 'contact name'],
  first: ['first name', 'first_name', 'firstname', 'fname', 'given name', 'given_name'],
  last:  ['last name', 'last_name', 'lastname', 'lname', 'surname', 'family name', 'family_name'],
  company: ['company', 'business', 'organization', 'organisation', 'org'],
  email: ['email', 'email_address', 'e-mail', 'mail'],
  prefix: ['prefix', 'country_code', 'countrycode', 'country code', 'cc', 'dial_code', 'dialcode'],
};

function parseCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Does this file have a header row, or is it just numbers?
 *
 * A .txt export from a dialler is usually one number per line and nothing
 * else. Requiring a header there would reject a perfectly good list, and
 * worse, a header-less CSV silently loses its first number to the header
 * parser. So decide by looking at the first line: if it is a phone number,
 * there is no header.
 */
function looksLikeNumber(line) {
  const first = parseCSVLine(line)[0] || '';
  const digits = first.replace(/[^\d]/g, '');
  return digits.length >= 7 && /^[+0-9][\d\s()+.-]*$/.test(first.trim());
}

/** Import a CSV or a plain list of numbers into a new or existing list. */
function importCSV(listId, csvText, { dialCode }) {
  let text = String(csvText);
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // Excel BOM

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { ok: false, error: 'That file is empty' };

  const headerless = looksLikeNumber(lines[0]);
  if (headerless) return importNumbers(listId, lines, dialCode);
  if (lines.length < 2) {
    return { ok: false,
      error: 'That file has a header row but no data. For a plain list, put one phone number per line.' };
  }

  const headers = parseCSVLine(lines[0])
    .map((h) => h.trim().replace(/^"(.*)"$/, '$1').replace(/^﻿/, '').toLowerCase());
  const find = (keys) => headers.findIndex((h) => keys.includes(h));

  const iPhone = find(ALIASES.phone) >= 0 ? find(ALIASES.phone) : 0;
  const iName = find(ALIASES.name);
  const iFirst = find(ALIASES.first);
  const iLast = find(ALIASES.last);
  const iCompany = find(ALIASES.company);
  const iEmail = find(ALIASES.email);
  const iPrefix = find(ALIASES.prefix);

  const cell = (c, i) => (i >= 0 && c[i] != null ? c[i].trim().replace(/^"(.*)"$/, '$1') : '');

  const existing = readRows(listId);
  const seen = new Set(existing.map((r) => r.phone));
  const rows = [];
  let imported = 0, dupes = 0, invalid = 0;

  for (let i = 1; i < lines.length; i++) {
    const c = parseCSVLine(lines[i]);
    const phone = normalizePhone(cell(c, iPhone), dialCode, cell(c, iPrefix));
    if (!phone || phone.length < 7) { invalid++; continue; }
    if (seen.has(phone)) { dupes++; continue; }
    seen.add(phone);

    let name = cell(c, iName);
    if (!name) name = [cell(c, iFirst), cell(c, iLast)].filter(Boolean).join(' ').trim();

    rows.push({
      phone, name,
      company: cell(c, iCompany),
      email: cell(c, iEmail),
      status: 'pending', attempts: 0, outcome: '', lastAttempt: null,
    });
    imported++;
  }

  writeRows(listId, existing.concat(rows));
  return {
    ok: true, imported, dupes, invalid,
    read: lines.length - 1,                 // data rows, header excluded
    total: existing.length + rows.length,
    detected: {
      format: 'csv',
      phone: headers[iPhone] || '(first column)',
      name: iName >= 0 ? headers[iName] : (iFirst >= 0 ? `${headers[iFirst]}${iLast >= 0 ? ' + ' + headers[iLast] : ''}` : null),
      prefix: iPrefix >= 0 ? headers[iPrefix] : null,
    },
  };
}

/**
 * One number per line, nothing else. Also handles a single-column CSV with no
 * header, and a trailing comma or quotes, because exports are untidy.
 */
function importNumbers(listId, lines, dialCode) {
  const existing = readRows(listId);
  const seen = new Set(existing.map((r) => r.phone));
  const rows = [];
  let imported = 0, dupes = 0, invalid = 0;

  for (const line of lines) {
    const raw = (parseCSVLine(line)[0] || '').trim().replace(/^"(.*)"$/, '$1');
    const phone = normalizePhone(raw, dialCode, '');
    if (!phone || phone.length < 7) { invalid++; continue; }
    if (seen.has(phone)) { dupes++; continue; }
    seen.add(phone);
    rows.push({ phone, name: '', company: '', email: '',
      status: 'pending', attempts: 0, outcome: '', lastAttempt: null });
    imported++;
  }

  writeRows(listId, existing.concat(rows));
  return {
    ok: true, imported, dupes, invalid,
    read: lines.length,
    total: existing.length + rows.length,
    detected: { format: 'numbers', phone: '(whole line)', name: null, prefix: null },
  };
}

// ---------------------------------------------------------------- CRUD
function list() {
  return readIndex().map((l) => ({ ...l, total: readRows(l.id).length }));
}
function get(id) {
  const meta = readIndex().find((l) => l.id === id);
  return meta ? { ...meta, rows: readRows(id) } : null;
}
function create({ name, country, dialCode }) {
  const idx = readIndex();
  const rec = {
    id: newId(),
    name: (name || '').trim() || 'Untitled list',
    country: (country || '').trim(),
    dialCode: String(dialCode || '').replace(/[^\d]/g, ''),
    createdAt: new Date().toISOString(),
  };
  idx.push(rec);
  writeIndex(idx);
  writeRows(rec.id, []);
  return rec;
}
function update(id, patch) {
  const idx = readIndex();
  const rec = idx.find((l) => l.id === id);
  if (!rec) return null;
  if (patch.name != null) rec.name = String(patch.name).trim() || rec.name;
  if (patch.country != null) rec.country = String(patch.country).trim();
  if (patch.dialCode != null) rec.dialCode = String(patch.dialCode).replace(/[^\d]/g, '');
  writeIndex(idx);
  return rec;
}
function remove(id) {
  writeIndex(readIndex().filter((l) => l.id !== id));
  try { fs.unlinkSync(rowsPath(id)); } catch (e) {}
  return { ok: true };
}
function stats(id) {
  const rows = readRows(id);
  const by = {};
  for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
  return { total: rows.length, by };
}

/**
 * Leads a campaign may dial right now.
 *
 * "Right now" is doing a lot of work: never attempted, or attempted fewer
 * times than allowed and the retry delay has passed. Anything the engine is
 * already dialling is excluded by the caller, which knows what is in flight.
 */
function dueRows(listId, { retryAttempts = 1, retryDelayMinutes = 60, limit = 50, exclude = new Set() } = {}) {
  const rows = readRows(listId);
  const now = Date.now();
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (exclude.has(r.phone)) continue;
    if (r.status === 'done' || r.status === 'dnc' || r.status === 'removed') continue;
    const attempts = r.attempts || 0;
    if (attempts > retryAttempts) continue;
    if (attempts > 0) {
      const last = r.lastAttempt ? Date.parse(r.lastAttempt) : 0;
      if (now - last < retryDelayMinutes * 60000) continue;
    }
    out.push(r);
  }
  return out;
}

/** Patch one lead by phone number. Rewrites the file, so batch where you can. */
function updateRow(listId, phone, patch) {
  const rows = readRows(listId);
  const r = rows.find((x) => x.phone === phone);
  if (!r) return null;
  Object.assign(r, patch);
  writeRows(listId, rows);
  return r;
}

/** How many leads are left to try at all — what a campaign counts down. */
/**
 * When the next lead becomes dialable again, or null if none ever will.
 *
 * "Nothing to dial right now" and "nothing left to dial" are different
 * answers and the dialler has to tell them apart: one means wait, the other
 * means the campaign is finished.
 */
function nextDueAt(listId, { retryAttempts = 1, retryDelayMinutes = 60 } = {}) {
  let soonest = null;
  for (const r of readRows(listId)) {
    if (['done', 'dnc', 'removed'].includes(r.status)) continue;
    const attempts = r.attempts || 0;
    if (attempts > retryAttempts) continue;
    if (attempts === 0) return 0;                 // never tried: due now
    const last = r.lastAttempt ? Date.parse(r.lastAttempt) : 0;
    const due = last + retryDelayMinutes * 60000;
    if (soonest === null || due < soonest) soonest = due;
  }
  return soonest;
}

function remaining(listId, retryAttempts = 1) {
  return readRows(listId).filter((r) =>
    !['done', 'dnc', 'removed'].includes(r.status) && (r.attempts || 0) <= retryAttempts).length;
}

module.exports = {
  nextDueAt,
  DIR, COUNTRIES, list, get, create, update, remove, stats,
  importCSV, readRows, writeRows, normalizePhone,
  dueRows, updateRow, remaining,
};
