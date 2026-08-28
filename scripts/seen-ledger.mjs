#!/usr/bin/env node
/**
 * seen-ledger.mjs — shared cross-run "already discovered" URL ledger
 *
 * WHY THIS EXISTS
 * ---------------
 * Notion cannot be used as the dedup source of truth, because archiving a row
 * makes it invisible to the API. Verified 2026-08-12 against a known-archived
 * page: `/databases/{id}/query` (2022-06-28) → 0 results; `/data_sources/{id}/query`
 * (2025-09-03) → 0 results; adding `in_trash: true` → 400 "body.in_trash should
 * be not present". Only `/pages/{id}` returns an archived page, which is useless
 * for dedup since you cannot enumerate the ids.
 *
 * So: once notion-cleanup trashes a below-floor row, that job becomes
 * re-discoverable, the next scan re-adds it, auto-eval re-scores it below floor,
 * cleanup trashes it again — a loop that burns eval budget (15/run) until the ad
 * ages out of the portals' freshness window (~2 weeks).
 *
 * This ledger is the durable memory that breaks that loop. It is deliberately
 * APPEND-ONLY and never pruned: pruning would reintroduce the bug it exists to
 * prevent. At ~100 bytes/entry it stays trivial for years.
 *
 * Extracted from bd-bulk-scan.mjs (2026-08-12) so chrome-scan-visible can share
 * it. Logic is an exact move — see --self-test for the invariants that pin it.
 *
 * CRITICAL: never reimplement canonicalUrl elsewhere. Its rules are
 * portal-specific (query-string job ids for Civil Service / Indeed, Stepstone's
 * -inline.html, .html suffixes). A second, subtly different copy would produce
 * keys that never match, and dedup would fail SILENTLY — reporting 0 duplicates
 * and looking perfectly healthy while re-adding everything.
 *
 * Library:
 *   import { canonicalUrl, loadSeen, saveSeen, SEEN_PATH } from "./seen-ledger.mjs";
 *
 * CLI (run from repo root):
 *   node seen-ledger.mjs --stats
 *   node seen-ledger.mjs --filter rows.json          # → unseen rows, JSON
 *   node seen-ledger.mjs --add rows.json             # record as seen
 *   node seen-ledger.mjs --has <url>                 # exit 0 seen, 1 unseen
 *   node seen-ledger.mjs --self-test
 *
 * --filter / --add accept either ["url", …] or [{url|listing_url|job_url, …}, …]
 * and preserve the input objects, so a filtered file can be piped onward.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export const SEEN_PATH = "data/bd-seen-urls.json";

// ─── URL canonicalisation (used for dedup) ──────────────────────────────
// Different scrapers and HTML refs can emit the same job URL with:
//   - %5F-vs-underscore encoding ("Data%5FEngineer" vs "Data_Engineer")
//   - mixed case in the host
//   - tracking query strings (?utm=..., ?_l=en, &fsk=...)
//   - trailing slashes
//   - .html extension presence/absence
// The canonical form drops all of those so the dedup key is invariant.
export function canonicalUrl(u) {
  if (!u) return "";
  let s;
  try { s = decodeURIComponent(u); } catch { s = u; }   // %5F → _
  s = s.split("#")[0];                                  // strip fragment
  // The job id lives in the QUERY STRING for some portals (Civil Service
  // jobs.cgi?jcode=…, Indeed viewjob?jk=…). Capture it before dropping the query,
  // else every distinct vacancy collapses to the same base path and is deduped.
  const idMatch = s.match(/[?&](jcode|jk)=([A-Za-z0-9]+)/i);
  s = s.split("?")[0];                                  // strip the rest of the query string
  s = s.toLowerCase();                                  // host + path lower
  s = s.replace(/\/+$/, "");                            // trailing slash
  s = s.replace(/-inline\.html$/, "");                  // Stepstone -inline.html variant
  s = s.replace(/\.html$/, "");                         // any .html suffix
  if (idMatch) s += `?${idMatch[1].toLowerCase()}=${idMatch[2].toLowerCase()}`;
  return s;
}

// Stored as canonical forms so the same job from two sources/encodings
// dedups across runs.
export function loadSeen(path = SEEN_PATH) {
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    // Re-canonicalise on load: heals any legacy entries written before this fix
    return new Set(raw.map(canonicalUrl));
  } catch { return new Set(); }
}

export function saveSeen(s, path = SEEN_PATH) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify([...s], null, 2));
}

// Pull a URL off either a bare string or a row object. Producers disagree on
// the field name (scrapers use `url`, the chrome-scan routine doc says
// `listing_url`, Notion exports use `job_url`), so accept all three.
export const urlOf = (row) =>
  typeof row === "string" ? row : (row?.url || row?.listing_url || row?.job_url || "");

// ─── CLI ────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/seen-ledger.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const readRows = (p) => {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (Array.isArray(j)) return j;
    // portal-keyed shape: { LinkedIn: [...], Xing: [...] }
    return Object.values(j).flat();
  };

  if (args.includes("--self-test")) {
    const T = [
      // [input, expected] — pins the invariants a second implementation would break
      ["https://WWW.LinkedIn.com/jobs/view/12345/", "https://www.linkedin.com/jobs/view/12345"],
      ["https://www.linkedin.com/jobs/view/12345?utm_source=x", "https://www.linkedin.com/jobs/view/12345"],
      ["https://www.linkedin.com/jobs/view/12345#hero", "https://www.linkedin.com/jobs/view/12345"],
      ["https://efc.de/jobs-Germany-Data%5FEngineer.id99", "https://efc.de/jobs-germany-data_engineer.id99"],
      ["https://stepstone.de/foo-inline.html", "https://stepstone.de/foo"],
      ["https://example.com/job.html", "https://example.com/job"],
      // query-string job ids MUST survive, else distinct vacancies collapse
      ["https://indeed.com/viewjob?jk=abc123&from=serp", "https://indeed.com/viewjob?jk=abc123"],
      ["https://civilservice.gov.uk/jobs.cgi?jcode=XY9&x=1", "https://civilservice.gov.uk/jobs.cgi?jcode=xy9"],
      ["", ""],
      [null, ""],
    ];
    let pass = 0, fail = 0;
    for (const [inp, want] of T) {
      const got = canonicalUrl(inp);
      if (got === want) pass++;
      else { fail++; console.error(`FAIL ${JSON.stringify(inp)}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
    }
    // two distinct Indeed jobs must NOT collapse
    if (canonicalUrl("https://indeed.com/viewjob?jk=aaa") === canonicalUrl("https://indeed.com/viewjob?jk=bbb")) {
      fail++; console.error("FAIL distinct jk= ids collapsed to one key");
    } else pass++;
    // urlOf accepts all three field names
    for (const [row, want] of [[{ url: "a" }, "a"], [{ listing_url: "b" }, "b"], [{ job_url: "c" }, "c"], ["d", "d"], [{}, ""]]) {
      if (urlOf(row) === want) pass++;
      else { fail++; console.error(`FAIL urlOf ${JSON.stringify(row)} → ${JSON.stringify(urlOf(row))} want ${JSON.stringify(want)}`); }
    }
    console.log(`seen-ledger self-test: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const seen = loadSeen();

  if (args.includes("--stats")) {
    console.log(JSON.stringify({ path: SEEN_PATH, entries: seen.size, exists: existsSync(SEEN_PATH) }, null, 1));
  } else if (flag("--has")) {
    const hit = seen.has(canonicalUrl(flag("--has")));
    console.log(hit ? "seen" : "unseen");
    process.exit(hit ? 0 : 1);
  } else if (flag("--filter")) {
    const rows = readRows(flag("--filter"));
    const unseen = rows.filter(r => { const u = urlOf(r); return u && !seen.has(canonicalUrl(u)); });
    console.error(`seen-ledger: ${rows.length} in → ${unseen.length} unseen (${rows.length - unseen.length} already discovered; ledger ${seen.size})`);
    console.log(JSON.stringify(unseen, null, 1));
  } else if (flag("--add")) {
    const rows = readRows(flag("--add"));
    const before = seen.size;
    let skipped = 0;
    for (const r of rows) { const u = urlOf(r); if (u) seen.add(canonicalUrl(u)); else skipped++; }
    saveSeen(seen);
    console.error(`seen-ledger: +${seen.size - before} new (${rows.length} submitted, ${skipped} had no URL) → ${seen.size} total`);
  } else {
    console.error("usage: --stats | --filter <json> | --add <json> | --has <url> | --self-test");
    process.exit(2);
  }
}
