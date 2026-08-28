/**
 * scan-state.mjs — incremental cursor for the email response scanner.
 *
 * Each scan must resume where the last one stopped instead of re-reading the
 * whole label. Two mechanisms, and the split matters:
 *
 *   queryHint()   a DATE cursor, used only to narrow the Gmail search so we do
 *                 not pull hundreds of old messages. Cheap, approximate.
 *   filterNew()   an ID LEDGER, the actual source of truth for "already done".
 *                 Exact, and immune to the date cursor being sloppy.
 *
 * WHY NOT USE UNREAD AS THE CURSOR. Gmail's read flag is shared with the human.
 * If the user opens a rejection in Gmail before a scan runs, an unread-driven
 * scanner would skip it forever and the row would never move. Marking scanned
 * mail as read is still worth doing as a human-facing signal of what has been
 * handled — but it is an OUTPUT of a scan, never the input that decides scope.
 *
 * The date cursor deliberately laps backwards (CURSOR_LAP_DAYS) because Gmail's
 * `after:` is day-granular and mail can arrive out of order; the ID ledger
 * absorbs the resulting overlap at zero cost.
 *
 * Usage:
 *   node scripts/email/scan-state.mjs --show
 *   node scripts/email/scan-state.mjs --reset        # forget everything, full re-scan
 *   node scripts/email/scan-state.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

export const STATE_PATH = path.join(REPO, 'data', '.email-scan-state.json');

// Gmail `after:` has day granularity, so re-ask for a day either side rather
// than risk missing a message that landed late on the cursor day.
export const CURSOR_LAP_DAYS = 1;

// Ledger entries older than this are dropped. Unlike the job seen-ledger (which
// is append-only forever, because a re-discovered job re-enters the pipeline), a
// message that fell out of the search window cannot come back — so pruning is
// safe here and keeps the file small.
export const RETAIN_DAYS = 180;

export const EMPTY = Object.freeze({ cursor: null, last_run: null, seen: {} });

export function loadState(p = STATE_PATH) {
  if (!existsSync(p)) return { ...EMPTY, seen: {} };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return { cursor: raw.cursor ?? null, last_run: raw.last_run ?? null, seen: raw.seen || {} };
  } catch {
    // A corrupt cursor must not silently mean "scan nothing". Start clean.
    return { ...EMPTY, seen: {} };
  }
}

export function saveState(state, p = STATE_PATH) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

const day = (iso) => new Date(iso).toISOString().slice(0, 10);

/**
 * The mailbox whose mail gets forwarded here. Read from the user layer rather
 * than hardcoded: config/profile.yml is gitignored and is where personal
 * identity lives, and a system-layer file must not carry an address.
 * Returns null if unreadable, which degrades to a label-only query.
 */
let _fwdCache;
export function forwardingAddress(profilePath = path.join(REPO, 'config', 'profile.yml')) {
  if (_fwdCache !== undefined) return _fwdCache;
  try {
    const cfg = yaml.load(readFileSync(profilePath, 'utf8'));
    _fwdCache = cfg?.candidate?.email || cfg?.identity?.email || null;
  } catch {
    _fwdCache = null;
  }
  return _fwdCache;
}

/**
 * Gmail search fragment that narrows a fetch to roughly-new mail.
 * Returns just the label clause on a first run, so the first scan sees
 * everything and later ones do not.
 *
 * WHY THE LABEL ALONE IS NOT ENOUGH. A Gmail filter labels on
 * `{to:|cc:|deliveredto: <address>}`, which an inbox-side redirect rule
 * satisfies. A MANUAL forward does not: it rewrites the envelope, so the
 * address survives only in the body and the message never gets the label.
 * Manual forwards are always FROM the user's own mailbox, so the union of the
 * two clauses covers both delivery shapes. Braces are Gmail OR.
 */
export function queryHint(state, label = 'inbox-forward', { forwardedFrom } = {}) {
  const addr = forwardedFrom === undefined ? forwardingAddress() : forwardedFrom;
  const base = addr ? `{label:${label} from:${addr}}` : `label:${label}`;
  if (!state?.cursor) return base;
  const from = new Date(state.cursor);
  from.setUTCDate(from.getUTCDate() - CURSOR_LAP_DAYS);
  // Gmail wants YYYY/MM/DD for after:
  return `${base} after:${day(from.toISOString()).replace(/-/g, '/')}`;
}

/** Messages this scan has not already processed. Order preserved. */
export function filterNew(messages, state) {
  const seen = state?.seen || {};
  return (messages || []).filter((m) => m && m.id && !seen[m.id]);
}

/**
 * Record messages as processed and advance the cursor.
 *
 * The cursor advances to the newest PROCESSED message, never to "now" — so if a
 * run dies halfway, the next one still picks up the unprocessed tail rather
 * than skipping past it.
 */
export function commit(state, processed, { now = new Date().toISOString() } = {}) {
  const seen = { ...(state?.seen || {}) };
  let newest = state?.cursor || null;

  for (const m of processed || []) {
    if (!m || !m.id) continue;
    seen[m.id] = m.date || now;
    if (m.date && (!newest || new Date(m.date) > new Date(newest))) newest = m.date;
  }

  // Prune anything older than the retention window.
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETAIN_DAYS);
  for (const [id, d] of Object.entries(seen)) {
    if (d && new Date(d) < cutoff) delete seen[id];
  }

  return { cursor: newest, last_run: now, seen };
}

/* ───────────────────────────────── CLI ───────────────────────────────────── */

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);

  if (args.includes('--reset')) {
    saveState({ ...EMPTY, seen: {} });
    console.log(`reset: ${STATE_PATH}`);
  } else if (args.includes('--self-test')) {
    let pass = 0, fail = 0;
    const ok = (c, l) => c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`));

    const s0 = { ...EMPTY, seen: {} };
    ok(queryHint(s0, 'inbox-forward', { forwardedFrom: null }) === 'label:inbox-forward',
       'first run scans the whole label');

    const msgs = [
      { id: 'a', date: '2026-08-14T10:00:00Z' },
      { id: 'b', date: '2026-08-16T10:00:00Z' },
    ];
    const s1 = commit(s0, msgs, { now: '2026-08-16T12:00:00Z' });
    ok(s1.cursor === '2026-08-16T10:00:00Z', 'cursor advances to the newest processed message');
    ok(queryHint(s1, 'inbox-forward', { forwardedFrom: null }) === 'label:inbox-forward after:2026/08/15',
       'cursor laps back one day for day-granular after:');
    ok(filterNew(msgs, s1).length === 0, 'already-processed messages are filtered out');
    ok(filterNew([...msgs, { id: 'c', date: '2026-08-17T10:00:00Z' }], s1).length === 1,
       'a new message survives the filter');

    // Partial failure: only one of two processed. The cursor must not jump past
    // the unprocessed one.
    const s2 = commit(s0, [msgs[0]], { now: '2026-08-16T12:00:00Z' });
    ok(filterNew(msgs, s2).map((m) => m.id).join(',') === 'b',
       'a half-finished run leaves the unprocessed message for next time');

    const old = commit({ cursor: null, last_run: null, seen: { z: '2020-01-01T00:00:00Z' } },
                       [], { now: '2026-08-16T12:00:00Z' });
    ok(!('z' in old.seen), 'entries past the retention window are pruned');

    // A manual forward never carries the label, so a label-only query cannot see
    // it. Union query covers both delivery shapes.
    ok(queryHint({ cursor: null }, 'inbox-forward', { forwardedFrom: 'me@example.com' })
         === '{label:inbox-forward from:me@example.com}',
       'the query covers labelled mail AND manual forwards');
    ok(queryHint({ cursor: '2026-08-16T10:00:00Z' }, 'inbox-forward', { forwardedFrom: 'me@example.com' })
         === '{label:inbox-forward from:me@example.com} after:2026/08/15',
       'the date clause still applies across the OR group');

    const corrupt = loadState(path.join(REPO, 'data', '.does-not-exist.json'));
    ok(corrupt.cursor === null && Object.keys(corrupt.seen).length === 0,
       'missing state file yields a clean full scan, never an empty scan');

    console.log(`\nSELF_TEST_${fail ? 'FAIL' : 'PASS'}: ${pass}/${pass + fail}`);
    process.exit(fail ? 1 : 0);
  } else {
    const s = loadState();
    console.log(JSON.stringify({
      path: STATE_PATH, exists: existsSync(STATE_PATH),
      cursor: s.cursor, last_run: s.last_run, seen_count: Object.keys(s.seen).length,
      next_query: queryHint(s),
    }, null, 2));
  }
}

export default { loadState, saveState, queryHint, filterNew, commit, STATE_PATH };
