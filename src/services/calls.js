'use strict';
/**
 * Per-call records — the campaign's CDR.
 *
 * Aggregate stats answer "how is this campaign doing"; they cannot answer
 * "what happened to this number", which is the question asked when a client
 * disputes a transfer or a whole afternoon of calls fails for one reason.
 *
 * Storage is append-only NDJSON, one file per campaign per DAY:
 *
 *     data/calls/<campaignId>/2026-11-18.ndjson
 *
 * One line per call. Deliberately not a JSON array: appending to an array
 * means read-parse-rewrite of the entire file for every call, which at
 * campaign concurrency is both slow and a corruption risk -- a crash halfway
 * through the rewrite loses the whole day. A line append is a single write,
 * and a torn final line costs exactly one record, which the reader skips.
 *
 * Splitting by day is what makes "download last Tuesday" cheap: it reads one
 * file instead of filtering everything the campaign has ever done.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.CALLS_DIR || path.join(__dirname, '../../data/calls');

const pad = (n) => String(n).padStart(2, '0');
/** Local calendar day, not UTC: a campaign run in the evening IST must not land on tomorrow. */
function dayOf(d) {
  const t = d instanceof Date ? d : new Date(d || Date.now());
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
const todayStr = () => dayOf(new Date());

function dirFor(campaignId) {
  return path.join(DIR, String(campaignId).replace(/[^a-zA-Z0-9_-]/g, ''));
}
function fileFor(campaignId, day) {
  return path.join(dirFor(campaignId), `${day}.ndjson`);
}

/**
 * Human-readable outcome. This is the column people actually read, so it is
 * stored rather than derived at display time -- the rules for deriving it will
 * change, and a report run next year must still say what we meant today.
 */
const OUTCOMES = {
  transferred: 'Transferred to agent',
  'opted-out': 'Opted out',
  removed: 'Asked for removal',
  'no-keypress': 'Heard prompt, no keypress',
  'no-answer': 'No answer',
  failed: 'Failed to connect',
  'no-agent': 'Pressed 1 but no agent free',
  blocked: 'Not dialled — system or carrier',
  machine: 'Answering machine',
};
const outcomeLabel = (k) => OUTCOMES[k] || k || '';

/** Append one call record. Never throws into the call path. */
function record(entry) {
  try {
    const started = entry.startedAt ? new Date(entry.startedAt) : new Date();
    const row = {
      at: started.toISOString(),
      endedAt: entry.endedAt || new Date().toISOString(),
      campaignId: entry.campaignId || '',
      campaignName: entry.campaignName || '',
      phone: entry.phone || '',
      outcome: entry.outcome || '',
      outcomeLabel: outcomeLabel(entry.outcome),
      connected: !!entry.connected,
      heardAudio: !!entry.heardAudio,
      transferred: !!entry.transferred,
      digits: Array.isArray(entry.digits) ? entry.digits.join('') : (entry.digits || ''),
      talkSeconds: Math.max(0, Math.round(entry.talkSeconds || 0)),
      totalSeconds: Math.max(0, Math.round(entry.totalSeconds || 0)),
      trunk: entry.trunk || '',
      server: entry.server || '',
      route: entry.route || '',
      attempt: entry.attempt || 1,
      hangupCause: entry.hangupCause == null ? '' : String(entry.hangupCause),
      result: entry.result || '',
      path: Array.isArray(entry.path) ? entry.path.join(' > ') : (entry.path || ''),
      jobId: entry.jobId || '',
    };
    const dir = dirFor(row.campaignId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fileFor(row.campaignId, dayOf(started)), JSON.stringify(row) + '\n');
    return row;
  } catch (e) {
    // A call log that can throw would hang up live calls. Losing a record is
    // bad; dropping the call it describes is worse.
    return null;
  }
}

/** Days this campaign has records for, newest first. */
function days(campaignId) {
  try {
    return fs.readdirSync(dirFor(campaignId))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
      .map((f) => f.replace('.ndjson', ''))
      .sort().reverse();
  } catch (e) { return []; }
}

function readDay(campaignId, day) {
  let txt;
  try { txt = fs.readFileSync(fileFor(campaignId, day), 'utf8'); }
  catch (e) { return []; }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    // A torn last line from a crash mid-append costs one record, not the file.
    try { out.push(JSON.parse(line)); } catch (e) {}
  }
  return out;
}

/**
 * Rows for one campaign over a date range, newest first.
 * `from`/`to` are YYYY-MM-DD and inclusive; omit both for everything.
 */
function read(campaignId, opts = {}) {
  const from = opts.from || '';
  const to = opts.to || '';
  let rows = [];
  for (const day of days(campaignId)) {
    if (from && day < from) continue;
    if (to && day > to) continue;
    rows = rows.concat(readDay(campaignId, day));
  }
  if (opts.outcome) rows = rows.filter((r) => r.outcome === opts.outcome);
  if (opts.phone) {
    const q = String(opts.phone).replace(/[^\d]/g, '');
    if (q) rows = rows.filter((r) => String(r.phone).replace(/[^\d]/g, '').includes(q));
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (opts.limit) rows = rows.slice(0, opts.limit);
  return rows;
}

/**
 * Read roughly the last `want` lines of a file without reading the file.
 *
 * Seeks to the end and takes a window back from there. The first line in the
 * window is almost certainly cut in half by the offset, so it is dropped
 * unless the window happens to start at byte zero.
 */
function tailLines(file, want) {
  if (want <= 0) return [];
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return [];
    // A record is a few hundred bytes; 1 KiB each is generous.
    const span = Math.min(size, Math.max(64 * 1024, want * 1024));
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    let txt = buf.toString('utf8');
    if (span < size) txt = txt.slice(txt.indexOf('\n') + 1);
    return txt.split('\n').filter((l) => l.trim());
  } catch (e) {
    return [];
  } finally { try { fs.closeSync(fd); } catch (e) {} }
}

/**
 * The newest N records, cheaply.
 *
 * `read()` with a limit still parses every day the campaign has, sorts the
 * lot and throws nearly all of it away. The dashboard polls for this every
 * two seconds, so that cost lands on the server continuously and grows for
 * the whole life of the campaign -- a campaign a few thousand calls in will
 * re-parse every one of them, thirty times a minute, to show fifteen rows.
 *
 * This walks days newest-first, reads only the tail of each file, and stops
 * as soon as it has enough.
 */
function recent(campaignId, n = 15) {
  const out = [];
  for (const day of days(campaignId)) {            // already newest-first
    const lines = tailLines(fileFor(campaignId, day), n - out.length);
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try { out.push(JSON.parse(lines[i])); } catch (e) {}
    }
    if (out.length >= n) break;
  }
  // File order is append order, which is chronological -- but at campaign
  // concurrency a dozen calls finish within the same second, so sort rather
  // than trusting the order they happened to be written in. Fifteen items.
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out;
}

/** Counts for the header of a report. */
function summary(rows) {
  const s = {
    total: rows.length, connected: 0, transferred: 0, optedOut: 0,
    noKeypress: 0, failed: 0, talkSeconds: 0, byOutcome: {},
  };
  for (const r of rows) {
    s.byOutcome[r.outcome] = (s.byOutcome[r.outcome] || 0) + 1;
    if (r.connected) s.connected++;
    if (r.transferred) s.transferred++;
    if (r.outcome === 'opted-out') s.optedOut++;
    if (r.outcome === 'no-keypress') s.noKeypress++;
    if (r.outcome === 'failed' || r.outcome === 'no-answer') s.failed++;
    s.talkSeconds += r.talkSeconds || 0;
  }
  s.connectRate = rows.length ? Math.round((s.connected / rows.length) * 100) : 0;
  s.transferRate = rows.length ? Math.round((s.transferred / rows.length) * 100) : 0;
  return s;
}

const CSV_COLUMNS = [
  ['at', 'Started'], ['endedAt', 'Ended'], ['campaignName', 'Campaign'],
  ['phone', 'Number'], ['outcomeLabel', 'Outcome'], ['outcome', 'Outcome code'],
  ['digits', 'Keys pressed'], ['talkSeconds', 'Talk seconds'],
  ['totalSeconds', 'Total seconds'], ['attempt', 'Attempt'],
  ['trunk', 'Trunk'], ['route', 'Agent route'],
  ['hangupCause', 'Hangup cause'], ['result', 'Detail'], ['path', 'Path'],
];

/**
 * CSV for Excel. Fields are quoted and embedded quotes doubled; a leading
 * apostrophe keeps Excel from eating the + on an E.164 number and from
 * reading a long number as a float.
 */
function toCsv(rows) {
  // See leads.writeCsv: a leading = + - @ is a formula to a spreadsheet.
  const esc = (v) => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const lines = [CSV_COLUMNS.map((c) => esc(c[1])).join(',')];
  for (const r of rows) {
    lines.push(CSV_COLUMNS.map(([k]) => {
      let v = r[k];
      if (k === 'phone') v = `'${v}`;
      return esc(v);
    }).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Delete a campaign's whole call history (used when the campaign is deleted). */
function removeAll(campaignId) {
  try { fs.rmSync(dirFor(campaignId), { recursive: true, force: true }); } catch (e) {}
}

module.exports = {
  DIR, OUTCOMES, outcomeLabel, record, days, read, readDay, recent,
  summary, toCsv, removeAll, dayOf, todayStr,
};
