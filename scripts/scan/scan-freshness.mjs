#!/usr/bin/env node
/**
 * scan-freshness.mjs — "only postings newer than the last scrape" for bd-bulk-scan.
 *
 * Two layers, because no single one covers every portal:
 *
 *   1. QUERY level — the five Google-SERP portals (linkedin, wttj, indeed,
 *      csjobs, brightnetwork) accept Google's `tbs=qdr:h<N>` recency operator,
 *      so the window is applied before we pay for a single fetch.
 *   2. POST filter — portals fetched by their own URLs (stepstone, xing,
 *      careerbee, efc, sponsoredjobs) have no filter we can set safely, so
 *      their results are filtered on the posted-date text they return.
 *
 * Deliberately NOT done: inventing native age parameters for the non-Google
 * portals. A wrong param does not error, it returns an empty page — which is
 * how Xing and CareerBee sat silently dead for weeks (see the
 * portal-extraction-health-2026-07 note). Filtering on returned data fails
 * visibly instead.
 *
 * THE SAFETY RULE: a posting whose age cannot be determined is KEPT, never
 * dropped. If a portal stops emitting dates, the worst case is that it scans
 * as before; the alternative — silently yielding zero — is the failure mode
 * this repo keeps rediscovering. Kept-unknown counts are logged per portal so
 * the degradation is visible.
 *
 * The window is measured from the LAST SUCCESSFUL SCAN, not a flat 24h, so a
 * missed run widens the window instead of dropping a day of postings.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const WATERMARK_PATH = "data/scan-watermark.json";
export const DEFAULT_WINDOW_HOURS = 24;
const MIN_WINDOW_HOURS = 1;
// A long outage should not turn one run into an unbounded backfill.
const MAX_WINDOW_HOURS = 24 * 7;

// Freshness PRIORITY, not a freshness cutoff.
//
// Operator preference: keep the window at "hours since last scan" (so a
// Monday after a quiet weekend still reaches back far enough to catch
// Friday's postings), and put same-day rows FIRST in the returned list.
//
// So the WINDOW stays "hours since the last scan" (a Monday after a quiet
// weekend still reaches back far enough to catch Friday's postings — capping it
// at 24h would silently drop them). What changes is ORDER: anything posted
// inside PRIORITY_WINDOW_HOURS is processed and written FIRST.
//
// Ordering is not cosmetic here because every downstream stage is capped
// (triage.max_evaluations_per_run, max_drafts_per_run, per-run row limits). When
// a scan returns more than a cap can absorb, the cap decides what actually gets
// applied to — so without this, a 3-day-old posting could displace one from this
// morning purely by arriving earlier in the array. Same-day ads are the ones
// worth spending the quota on: applying on day one beats applying on day three.
export const PRIORITY_WINDOW_HOURS = 24;

/** Read the last successful scan time. Returns null when never scanned. */
export function readWatermark(path = WATERMARK_PATH) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && j.last_scan_iso ? j : null;
  } catch { return null; }
}

/** Record a successful scan. Called only after a run actually inserted rows. */
export function writeWatermark(nowIso, extra = {}, path = WATERMARK_PATH) {
  try { mkdirSync(dirname(path), { recursive: true }); } catch { }
  writeFileSync(path, JSON.stringify({ last_scan_iso: nowIso, ...extra }, null, 2));
}

/**
 * Hours to look back on this run: time since the last successful scan,
 * clamped to [1, 168]. Falls back to 24h the first time (no watermark).
 */
export function windowHours(nowIso, path = WATERMARK_PATH) {
  const wm = readWatermark(path);
  if (!wm) return DEFAULT_WINDOW_HOURS;
  const then = Date.parse(wm.last_scan_iso), now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now) || now <= then) return DEFAULT_WINDOW_HOURS;
  const h = Math.ceil((now - then) / 3_600_000);
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, h));
}

/** Add Google's recency operator to a google.com/search URL. */
export function withRecency(serpUrl, hours) {
  if (!serpUrl || !/^https?:\/\/(www\.)?google\.[a-z.]+\/search/i.test(serpUrl)) return serpUrl;
  const u = new URL(serpUrl);
  // qdr:h<N> is hour-granular; Google also accepts d/w but h<N> matches our window.
  u.searchParams.set("tbs", `qdr:h${Math.max(1, Math.round(hours))}`);
  return u.toString();
}

// Relative-age phrasings the portals actually emit, EN + DE. Order matters:
// "vor 2 Wochen" must match the week rule before the generic number rule.
const REL = [
  // Keyword rules use NON-capturing groups on purpose: m[1] is reserved for the
  // numeric quantity, and a captured word there parses to NaN and skips the rule.
  { re: /\b(?:just posted|heute|today|gerade eben|neu)\b/i, hours: () => 1 },
  { re: /\b(?:gestern|yesterday)\b/i, hours: () => 24 },
  { re: /(\d+)\s*\+?\s*(minute|minuten|min)\b/i, hours: (n) => n / 60 },
  { re: /(\d+)\s*\+?\s*(hour|hours|stunde|stunden|std)\b/i, hours: (n) => n },
  { re: /(\d+)\s*\+?\s*(day|days|tag|tagen|tage)\b/i, hours: (n) => n * 24 },
  { re: /(\d+)\s*\+?\s*(week|weeks|woche|wochen)\b/i, hours: (n) => n * 24 * 7 },
  { re: /(\d+)\s*\+?\s*(month|months|monat|monaten|monate)\b/i, hours: (n) => n * 24 * 30 },
];

/**
 * Age of a posting in hours from whatever date text a portal gave us.
 * Returns null when it cannot be determined — callers must treat null as
 * "keep", never as "old".
 */
export function parseAgeHours(text, nowIso) {
  const s = String(text || "").trim();
  if (!s) return null;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;

  // Absolute ISO / YYYY-MM-DD first — unambiguous when present.
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})(?:[T ][\d:]+)?/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t)) return Math.max(0, (now - t) / 3_600_000);
  }
  // Longest-unit-wins: scan week/month before day so "2 Wochen" is not 2 days.
  for (const r of [...REL].reverse()) {
    const m = s.match(r.re);
    if (!m) continue;
    const n = m[1] ? parseFloat(m[1]) : 0;
    if (m[1] && !Number.isFinite(n)) continue;
    return r.hours(n);
  }
  return null;
}

/**
 * Split jobs into {fresh, stale, unknown} against the window.
 * `dateFields` are checked in order; the first non-empty one wins.
 */
export function partitionByFreshness(jobs, hours, nowIso, dateFields = ["posted_time", "posted", "posted_date", "date_posted"]) {
  const fresh = [], stale = [], unknown = [];
  for (const j of jobs || []) {
    let raw = "";
    for (const f of dateFields) { if (j && j[f]) { raw = j[f]; break; } }
    const age = parseAgeHours(raw, nowIso);
    if (age === null) { unknown.push(j); fresh.push(j); continue; }  // unknown ⇒ keep
    (age <= hours ? fresh : stale).push(j);
  }
  // Rank the kept set youngest-first so the last 24h lead (2026-08-11). Every
  // downstream stage is capped, so ORDER decides what a cap actually spends
  // itself on. Undated rows sort AFTER dated ones inside the priority window but
  // ahead of anything older: they are kept on purpose (unknown never means
  // stale) yet must not outrank a posting known to be from this morning.
  return { fresh: prioritiseByAge(fresh, nowIso, dateFields), stale, unknown };
}

/**
 * Youngest-first ordering, stable within each band.
 * Band 1: dated, age <= PRIORITY_WINDOW_HOURS, ascending by age
 * Band 2: undated (age unknown)
 * Band 3: dated, older than the priority window, ascending by age
 */
export function prioritiseByAge(jobs, nowIso, dateFields = ["posted_time", "posted", "posted_date", "date_posted"]) {
  const withAge = (jobs || []).map((j, i) => {
    let raw = "";
    for (const f of dateFields) { if (j && j[f]) { raw = j[f]; break; } }
    const age = parseAgeHours(raw, nowIso);
    const band = age === null ? 1 : (age <= PRIORITY_WINDOW_HOURS ? 0 : 2);
    return { j, age, band, i };
  });
  withAge.sort((a, b) =>
    a.band - b.band ||
    (a.age === null || b.age === null ? 0 : a.age - b.age) ||
    a.i - b.i          // stable: preserve discovery order within a tie
  );
  return withAge.map(x => x.j);
}

// ── self-test ───────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("scan-freshness.mjs") && process.argv.includes("--self-test")) {
  const NOW = "2026-08-02T12:00:00Z";
  let pass = 0, fail = 0;
  const ck = (n, a, e) => {
    const ok = JSON.stringify(a) === JSON.stringify(e);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : ` — expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`);
    ok ? pass++ : fail++;
  };
  ck("today → 1h", parseAgeHours("Heute", NOW), 1);
  ck("yesterday → 24h", parseAgeHours("vor 1 Tag", NOW), 24);
  ck("5 days", parseAgeHours("Gepostet vor 5 Tagen", NOW), 120);
  ck("2 weeks beats day rule", parseAgeHours("vor 2 Wochen", NOW), 336);
  ck("hours", parseAgeHours("3 hours ago", NOW), 3);
  ck("30+ days", parseAgeHours("30+ days ago", NOW), 720);
  ck("ISO date", parseAgeHours("2026-08-01", NOW), 36);
  ck("unparseable → null", parseAgeHours("Festanstellung", NOW), null);
  ck("empty → null", parseAgeHours("", NOW), null);
  ck("recency param", withRecency("https://www.google.com/search?q=x", 24),
    "https://www.google.com/search?q=x&tbs=qdr%3Ah24");
  ck("non-google untouched", withRecency("https://www.xing.com/jobs/search?k=x", 24),
    "https://www.xing.com/jobs/search?k=x");
  const P = partitionByFreshness(
    [{ posted_time: "2 hours ago" }, { posted_time: "vor 5 Tagen" }, { posted_time: "" }, { title: "no date field" }],
    24, NOW);
  ck("partition fresh (incl. both unknowns)", P.fresh.length, 3);
  ck("partition stale", P.stale.length, 1);
  ck("partition unknown kept", P.unknown.length, 2);
  ck("no watermark → 24h default", windowHours(NOW, "does/not/exist.json"), DEFAULT_WINDOW_HOURS);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
