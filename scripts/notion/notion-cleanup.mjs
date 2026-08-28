#!/usr/bin/env node
/**
 * notion-cleanup.mjs — Aggressive cleanup of the Applications DB
 *
 * Removes rows that should never sit in Notion:
 *   A. Rows with no Stage set (orphans from older imports / failed writes)
 *   B. Rows already scored < cleanup_floor (below the retroactive triage floor)
 *      — EXCEPT rows at "3. Drafted" or beyond, or with a recorded outcome
 *      (Rejected / Withdrew). The score is a pre-application signal; once a
 *      draft exists or an application was sent, that signal has been
 *      overridden by an actual decision, and the row is the only record of it.
 *   C. Cross-portal duplicates (same job appearing on 2+ portals — keep the
 *      highest-preference portal, trash the rest)
 *   D. Out-of-band titles — Senior/Lead/Staff/Principal/Head/Director and
 *      enrolled-student roles (Werkstudent/Praktikum/Duales Studium), per
 *      `config/profile.yml -> target_roles`. Only applied to PRE-APPLICATION
 *      stages (1. Discovered, 2. Triaged) so anything already drafted or
 *      applied to is never touched.
 *
 * SENT-APPLICATION GUARD. Every category checks the row's Apply date FIRST.
 * A row with an Apply date is a sent application no matter what its Stage
 * says — those are the ones you most need to keep. Losing a duplicate is
 * cheap and reversible; losing a live employer conversation is neither.
 *
 * RETROACTIVE FLOOR SEPARATION. `cleanup_floor` is what gets applied
 * RETROACTIVELY to rows already in the DB. `score_floor` is the forward-
 * looking triage gate. They are separate because raising the triage bar
 * should not reach back and bin work that passed under the old rule. Falls
 * back to `score_floor` when `cleanup_floor` is unset (old single-number
 * behaviour).
 *
 * "Trashed" = Notion `archived: true` (the API word; row goes to Trash,
 * recoverable for 30 days, hidden from views). NOT a hard delete.
 *
 * Usage:
 *   node notion-cleanup.mjs --dry-run    # report only, no changes
 *   node notion-cleanup.mjs              # actually trash
 *   node notion-cleanup.mjs --json       # JSON-only output
 *   node notion-cleanup.mjs --no-band    # skip category D
 *   node notion-cleanup.mjs --self-test  # offline logic check (no token)
 */

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_ONLY = args.includes("--json");
const SKIP_BAND = args.includes("--no-band");
const SELF_TEST = args.includes("--self-test");

const TOKEN = process.env.NOTION_TOKEN;
// --self-test is pure logic (no network), so it must not require a token.
if (!TOKEN && !SELF_TEST) { console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set."); process.exit(5); }

function loadConfig() {
  if (!existsSync("config/profile.yml")) return {};
  try { return yaml.load(readFileSync("config/profile.yml", "utf8")) || {}; } catch { return {}; }
}
const CFG = loadConfig();
const DATABASE_ID = process.env.NOTION_DATABASE_ID || (CFG.notion && CFG.notion.applications_database_id);
if (!DATABASE_ID && !SELF_TEST) {
  console.error("ROUTINE_ABORT: No Notion database ID configured — set NOTION_DATABASE_ID env var or notion.applications_database_id in config/profile.yml");
  process.exit(5);
}
const SCORE_FLOOR = (CFG.triage && (CFG.triage.cleanup_floor ?? CFG.triage.score_floor)) || 75;
const TRIAGE_FLOOR = (CFG.triage && CFG.triage.score_floor) || SCORE_FLOOR;

const PORTAL_PREFERENCE = [
  "LinkedIn", "Company site", "Xing", "Welcome to the Jungle",
  "Stepstone", "Handshake", "Indeed", "eFinancialCareers",
  "Greenhouse", "Lever", "Other",
];
const rankOf = (p) => {
  const i = PORTAL_PREFERENCE.indexOf(p);
  return i < 0 ? -1 : PORTAL_PREFERENCE.length - i;
};

const NOTION_VERSION = "2022-06-28";

async function queryAll(filter = null) {
  const all = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Notion API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    all.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return all;
}

async function trashPage(pageId) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  if (!r.ok) throw new Error(`trash ${pageId} failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

function extractEssentials(page) {
  const p = page.properties || {};
  const get = (n, t) => {
    const x = p[n]; if (!x || x.type !== t) return null;
    if (t === "select") return x.select?.name ?? null;
    if (t === "number") return x.number;
    if (t === "url") return x.url;
    if (t === "rich_text") return x.rich_text?.map(t => t.plain_text).join("") ?? "";
    if (t === "multi_select") return x.multi_select?.map(o => o.name) ?? [];
    if (t === "date") return x.date?.start ?? null;
    return null;
  };
  const titleProp = Object.values(p).find(x => x && x.type === "title");
  return {
    id: page.id,
    archived: page.archived,
    title: titleProp ? titleProp.title.map(t => t.plain_text).join("") : "",
    application_id: p["Application ID"]?.unique_id ? `${p["Application ID"].unique_id.prefix}-${p["Application ID"].unique_id.number}` : null,
    stage: get("Stage", "select"),
    match_score: get("Match score", "number"),
    job_url: get("Job URL", "url"),
    source_portal: get("Source portal", "select"),
    fit_notes: get("Fit notes", "rich_text"),
    position: get("Position", "multi_select"),
    apply_date: get("Apply date", "date"),
  };
}

// ── Seniority band (category D) ─────────────────────────────────────────
// \b anchors matter: "lead" must not fire on "leadership", "head of" must
// not fire on "headcount".
const BAND_OUT    = /\((?:senior|sr)\)|\b(?:senior|sr\.|lead|leiter|teamleiter|staff|principal|head\s+of|director|vp|chief|cto|cdo)\b/i;
const STUDENT_OUT = /\b(?:werkstudent(?:in)?|praktikum|praktikant(?:in)?|intern|internship|duales\s+studium|ausbildung|bachelor\s+of|master\s+of)\b/i;

// Stages where trashing is safe — nothing has been drafted or sent yet.
// Deliberately excludes "3. Drafted" and everything past it: a drafted or
// applied row carries work product and outcome history worth keeping even
// if the title is out of band.
const PRE_APPLY_STAGES = new Set(["1. Discovered", "2. Triaged"]);

// Stages that represent real work product, a submitted application, or a
// recorded outcome. NOTHING in this set is ever auto-trashed, whatever the
// score says. Once an application has been drafted or sent, that signal
// has been overridden by an actual decision, and the row is the only record
// that it happened.
const PROTECTED_STAGES = new Set([
  "3. Drafted", "4. Applied", "5. Assessment/OA", "6. Phone screen",
  "7. Tech interview", "8. Onsite/Final", "9. Offer", "Signed",
  "Rejected", "Withdrew",
]);

// SENT-APPLICATION GUARD. Stage is NOT a reliable proxy for "not yet sent":
// rows can sit at earlier stages with an Apply date already set (an applied
// row whose Stage write failed would otherwise be trashed as an orphan). An
// Apply date is the durable fact: the application left the building and the
// row is the only record of it. Never trash a sent row.
const wasSent = (row) => Boolean(row.apply_date);

const isBelowFloor = (row, floor) => row.match_score !== null && row.match_score !== undefined && row.match_score < floor;
// Trashable only when below floor AND not protected by stage AND never sent.
const belowFloorTrashable = (row, floor) => isBelowFloor(row, floor) && !PROTECTED_STAGES.has(row.stage) && !wasSent(row);

// The `title` property is the COMPANY name (see the note at category C), so
// the job title has to come out of `Fit notes`, whose format is producer-
// specific. Returns null when the format is unrecognised — callers MUST
// treat null as "unknown, leave alone". Regex-matching the raw notes blob
// instead produces false positives: bd-bulk-scan stores JD body text there,
// and a JD that mentions "reporting to a senior lead" is not itself a
// senior role.
function jobTitleOf(fitNotes) {
  if (!fitNotes) return null;
  // bd-bulk-scan, two observed shapes:
  //   "[bd-bulk-scan] portal=LinkedIn title=Foo Bar posted=2 hours ago"
  //   "[bd-bulk-scan] portal=Indeed title=Foo Bar\n\nJD: ..."
  // Take to end of LINE (JD body follows on a later line), then drop any
  // trailing "key=value" fields that sit on the same line.
  const bd = fitNotes.match(/\btitle=([^\n]*)/);
  if (bd) return bd[1].replace(/\s+\w+=.*$/, "").trim() || null;
  // chrome-scan-visible: "[Job Title] [apply_url] inline-apply:..."
  const cs = fitNotes.match(/^\[([^\]]+)\]/);
  if (cs && !/^(?:bd-bulk-scan|apply_url)$/i.test(cs[1])) return cs[1].trim() || null;
  return null;
}

// Second, independent signal: the Position multi_select carries explicit
// "Senior ..." options. Catches rows whose Fit-notes format we can't parse.
const positionOutOfBand = (position) =>
  Array.isArray(position) && position.some(p => /^senior\b/i.test(p));

// Returns a reason string, or null if the row is in band / undeterminable.
function bandViolation(row) {
  if (wasSent(row)) return null;   // sent application — an out-of-band title is moot, keep the record
  if (!PRE_APPLY_STAGES.has(row.stage)) return null;
  const t = jobTitleOf(row.fit_notes);
  if (t) {
    if (STUDENT_OUT.test(t)) return `out-of-band:student("${t.slice(0, 40)}")`;
    if (BAND_OUT.test(t))    return `out-of-band:seniority("${t.slice(0, 40)}")`;
  }
  if (positionOutOfBand(row.position)) return `out-of-band:position(${row.position.filter(p => /^senior\b/i.test(p)).join(",")})`;
  return null;
}

// Query params that CARRY THE JOB IDENTITY. Dropping the whole query string
// is catastrophic on any portal that keys the job in the query rather than
// the path: every Indeed URL is `uk.indeed.com/viewjob?jk=<id>`, so stripping
// `?jk=` collapses EVERY Indeed-sourced row to the single key
// `https://uk.indeed.com/viewjob` and makes them all duplicates of each other.
const URL_ID_PARAMS = new Set([
  "jk",             // Indeed
  "currentjobid",   // LinkedIn collections
  "jobid", "job_id", "gh_jid", "gh_src",
  "positionid", "reqid", "vacancyid", "id",
]);
// Bare listing endpoints. With no identifying param these are NOT a job
// identity, and returning the bare path would recreate the collapse above.
// The caller skips falsy keys, so "" means "cannot dedup this by URL" —
// the safe answer.
const GENERIC_PATHS = new Set([
  "/viewjob", "/jobs/view", "/jobs/search", "/job", "/jobs", "/search", "/m/viewjob",
]);
function canonicalUrl(u) {
  if (!u || typeof u !== "string") return "";
  try {
    const parsed = new URL(u);
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    const base = `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
    const keep = [];
    for (const [k, v] of parsed.searchParams) {
      if (v && URL_ID_PARAMS.has(k.toLowerCase())) keep.push(`${k.toLowerCase()}=${v.toLowerCase()}`);
    }
    if (keep.length) return `${base}?${keep.sort().join("&")}`;
    if (GENERIC_PATHS.has(path)) return "";
    return base;
  } catch {
    const bare = u.toLowerCase().split("#")[0];
    const m = bare.match(/[?&](jk|currentjobid|jobid|gh_jid)=([^&]+)/);
    const stem = bare.split("?")[0].replace(/\/+$/, "");
    return m ? `${stem}?${m[1]}=${m[2]}` : stem;
  }
}

function normTitle(s) {
  if (!s) return "";
  return s.toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function normCompany(s) {
  if (!s) return "";
  return s.toLowerCase()
    .replace(/\b(gmbh|ag|se|kg|ohg|bv|ltd|inc|llc|plc|& co|co\.|sa|spa|nv)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  if (!JSON_ONLY) console.log(`Fetching all rows (excluding already-archived)...`);
  const pages = await queryAll();
  if (!JSON_ONLY) console.log(`  ${pages.length} live rows`);
  const rows = pages.map(extractEssentials).filter(r => !r.archived);

  // ── A. No-Stage orphans ───────────────────────────────────────────
  // wasSent() guard: a row with no Stage but WITH an Apply date is not an
  // orphan import, it is a sent application whose Stage write failed. Those
  // are the ones that most need keeping, and stage-based rules cannot see them.
  const orphans = rows.filter(r => !r.stage && !wasSent(r));
  const orphansSentProtected = rows.filter(r => !r.stage && wasSent(r));
  if (!JSON_ONLY && orphansSentProtected.length) {
    console.log(`  PROTECTED: ${orphansSentProtected.length} no-Stage row(s) carry an Apply date — sent applications, not orphans:`);
    for (const r of orphansSentProtected) console.log(`    ${r.application_id || r.id.slice(-8)} ${r.title} (applied ${r.apply_date})`);
  }
  // ── B. Below-floor rows (never past pre-application, never sent) ──
  const belowFloor = rows.filter(r => belowFloorTrashable(r, SCORE_FLOOR));
  // Below floor but stage-protected: reported, never trashed. These are
  // applications you sent or outcomes you recorded despite a low score.
  // Report BOTH protections: stage-based and sent-based.
  const belowFloorProtected = rows.filter(r => isBelowFloor(r, SCORE_FLOOR) && (PROTECTED_STAGES.has(r.stage) || wasSent(r)));
  // ── C. Cross-portal duplicates by canonical Job URL ───────────────
  const urlIndex = new Map();
  const dupes = [];
  const liveForDedup = rows.filter(r => r.stage && r.stage !== "Not pursuing" && r.stage !== "Withdrew" && r.stage !== "Rejected" && r.job_url);
  const dupesSentProtected = [];
  for (const r of liveForDedup) {
    const cu = canonicalUrl(r.job_url);
    if (!cu) continue;
    const existing = urlIndex.get(cu);
    if (existing) {
      // SENT-APPLICATION GUARD. A sent row always beats an unsent duplicate,
      // whatever the portal ranking says: portal rank is a data-quality
      // preference, and you cannot un-send an application. If BOTH are sent,
      // neither is trashed — two applications to one posting is a fact to
      // reconcile by hand, not to hide.
      const rSent = wasSent(r), eSent = wasSent(existing);
      if (rSent && eSent) {
        dupesSentProtected.push({ a: existing, b: r });
        continue;                                   // keep both, trash neither
      }
      if (rSent !== eSent) {
        const sent = rSent ? r : existing;
        const unsent = rSent ? existing : r;
        dupesSentProtected.push({ a: sent, b: unsent, kept: sent });
        dupes.push({ trash: unsent, kept: sent });
        urlIndex.set(cu, sent);
        continue;
      }
      if (rankOf(r.source_portal) > rankOf(existing.source_portal)) {
        dupes.push({ trash: existing, kept: r });
        urlIndex.set(cu, r);
      } else {
        dupes.push({ trash: r, kept: existing });
      }
    } else {
      urlIndex.set(cu, r);
    }
  }
  if (!JSON_ONLY && dupesSentProtected.length) {
    console.log(`  PROTECTED: ${dupesSentProtected.length} cross-portal dupe pair(s) involve a SENT application:`);
    for (const d of dupesSentProtected) {
      const tag = (x) => `${x.application_id || x.id.slice(-8)}${x.apply_date ? ` (sent ${x.apply_date})` : " (unsent)"}`;
      console.log(`    ${tag(d.a)} vs ${tag(d.b)}${d.kept ? "" : "  <- BOTH sent, neither trashed"}`);
    }
  }

  // ── D. Out-of-band titles (pre-application stages only) ───────────
  const outOfBand = SKIP_BAND ? [] : rows
    .map(r => ({ row: r, reason: bandViolation(r) }))
    .filter(x => x.reason);
  // Rows whose title we could not parse AND whose Position gives no signal:
  // reported, never trashed, so a format drift shows up as a number rather
  // than as silent under-cleaning.
  const bandUndeterminable = SKIP_BAND ? 0 : rows.filter(r =>
    PRE_APPLY_STAGES.has(r.stage) && !jobTitleOf(r.fit_notes) && !positionOutOfBand(r.position)
  ).length;

  // Compute final trash set (union of A + B + C + D). Deduplicate by id.
  const trashIds = new Map();
  for (const r of orphans)     trashIds.set(r.id, { row: r, reason: "no-stage" });
  for (const r of belowFloor)  trashIds.set(r.id, { row: r, reason: `below-floor(${r.match_score})` });
  for (const d of dupes)       trashIds.set(d.trash.id, { row: d.trash, reason: `dupe-of(${d.kept.application_id || d.kept.id.slice(0,8)} ${d.kept.source_portal})` });
  for (const b of outOfBand)   trashIds.set(b.row.id, { row: b.row, reason: b.reason });

  const plan = Array.from(trashIds.entries()).map(([id, e]) => ({
    id, app: e.row.application_id, title: e.row.title, stage: e.row.stage,
    score: e.row.match_score, portal: e.row.source_portal, reason: e.reason,
  }));

  if (JSON_ONLY) {
    console.log(JSON.stringify({
      live_in: rows.length,
      orphans_no_stage: orphans.length,
      below_floor: belowFloor.length,
      below_floor_protected: belowFloorProtected.length,
      below_floor_protected_rows: belowFloorProtected.map(r => ({ app: r.application_id, stage: r.stage, score: r.match_score, company: r.title })),
      cross_portal_dupes: dupes.length,
      out_of_band: outOfBand.length,
      band_undeterminable: bandUndeterminable,
      band_check: SKIP_BAND ? "skipped" : "on",
      total_to_trash: plan.length,
      dry_run: DRY_RUN,
      plan,
    }, null, 2));
  } else {
    console.log("");
    console.log(`Planned trash:`);
    console.log(`  no-stage orphans: ${orphans.length}`);
    console.log(`  below floor (<${SCORE_FLOOR}): ${belowFloor.length}${belowFloorProtected.length ? `  [${belowFloorProtected.length} protected by stage/sent, NOT trashed]` : ""}`);
    for (const r of belowFloorProtected) {
      console.log(`      protected: ${(r.application_id || "").padEnd(9)} ${(r.stage || "").padEnd(13)} score=${String(r.match_score).padEnd(4)} ${r.title || ""}`);
    }
    console.log(`  cross-portal dupes: ${dupes.length}`);
    console.log(`  out-of-band titles: ${outOfBand.length}${SKIP_BAND ? " (check skipped via --no-band)" : ` (pre-apply stages only; ${bandUndeterminable} rows unparseable, left alone)`}`);
    console.log(`  TOTAL (deduped by id): ${plan.length}`);
    console.log("");
    if (plan.length <= 20) {
      for (const p of plan) console.log(`  ${(p.app||'').padEnd(10)} ${(p.stage||'(none)').padEnd(18)} ${(p.title||'').padEnd(30).slice(0,30)} ${p.reason}`);
    } else {
      console.log(`  (first 10 of ${plan.length})`);
      for (const p of plan.slice(0, 10)) console.log(`  ${(p.app||'').padEnd(10)} ${(p.stage||'(none)').padEnd(18)} ${(p.title||'').padEnd(30).slice(0,30)} ${p.reason}`);
    }
  }

  if (DRY_RUN) {
    if (!JSON_ONLY) console.log(`\n(dry-run — nothing trashed. Re-run without --dry-run to apply.)`);
    return;
  }

  if (!JSON_ONLY) console.log(`\nTrashing ${plan.length} pages...`);
  let ok = 0, fail = 0;
  for (const p of plan) {
    try { await trashPage(p.id); ok++; if (!JSON_ONLY && ok % 25 === 0) console.log(`  ${ok}/${plan.length}...`); }
    catch (e) { fail++; if (!JSON_ONLY) console.error(`  x ${p.id}: ${e.message}`); }
  }

  if (!JSON_ONLY) {
    console.log("");
    console.log(`Trashed: ${ok} - Failed: ${fail}`);
    console.log("");
    console.log("--- ROUTINE_CONTRACT ---");
    console.log("ROUTINE: notion-cleanup");
    console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
    console.log(`SCORE_FLOOR: ${SCORE_FLOOR}`);
    console.log(`TRIAGE_FLOOR: ${TRIAGE_FLOOR}${TRIAGE_FLOOR !== SCORE_FLOOR ? ' (rows between the two floors are grandfathered, not trashed)' : ''}`);
    console.log(`LIVE_ROWS_BEFORE: ${rows.length}`);
    console.log(`ORPHANS_NO_STAGE: ${orphans.length}`);
    console.log(`BELOW_FLOOR: ${belowFloor.length}`);
    console.log(`BELOW_FLOOR_PROTECTED: ${belowFloorProtected.length}`);
    console.log(`CROSS_PORTAL_DUPES: ${dupes.length}`);
    console.log(`OUT_OF_BAND: ${outOfBand.length}`);
    console.log(`BAND_UNDETERMINABLE: ${bandUndeterminable}`);
    console.log(`BAND_CHECK: ${SKIP_BAND ? "skipped" : "on"}`);
    console.log(`TOTAL_TRASHED: ${ok}`);
    console.log(`TRASH_FAILURES: ${fail}`);
    console.log("--- END_ROUTINE_CONTRACT ---");
  }
}

// ── Self-test ──────────────────────────────────────────────────────────
// `node notion-cleanup.mjs --self-test` — no network, no token needed.
// Guards the two ways category D silently rots: a Fit-notes format drift
// that makes jobTitleOf() return null for everything (check quietly stops
// firing), and an over-greedy band regex (check starts eating valid rows).
// Also pins the below-floor stage/sent guards.
function selfTest() {
  const F = [
    // [fit_notes, stage, position, expectedTitle, expectViolation]
    ["[Data Engineer (m/w/d)] [apply_url] inline-apply:https://x", "1. Discovered", [], "Data Engineer (m/w/d)", false],
    ["[Senior Analytics Engineer (m/f/d)] [apply_url] x", "1. Discovered", [], "Senior Analytics Engineer (m/f/d)", true],
    ["[(Senior) Data & Cloud Engineer (m/w/d)] [apply_url] x", "1. Discovered", [], "(Senior) Data & Cloud Engineer (m/w/d)", true],
    ["[Data Science Director (f/m/d)] [apply_url] x", "1. Discovered", [], "Data Science Director (f/m/d)", true],
    ["[bd-bulk-scan] portal=Indeed title=Data Engineer\n\nJD: [indeed: title from SERP]", "1. Discovered", [], "Data Engineer", false],
    ["[bd-bulk-scan] portal=LinkedIn title=Lead Data Analyst posted=2 hours ago", "1. Discovered", [], "Lead Data Analyst", true],
    ["[bd-bulk-scan] portal=Bright Network title=Junior Data Analyst 2026\n\nJD: x", "1. Discovered", [], "Junior Data Analyst 2026", false],
    ["[Werkstudent Analytics (m/w/d)] [apply_url] x", "1. Discovered", [], "Werkstudent Analytics (m/w/d)", true],
    ["[Duales Studium BWL - Spezialisierung AI] [apply_url] x", "1. Discovered", [], "Duales Studium BWL - Spezialisierung AI", true],
    // false-positive guards — these must NOT fire
    ["[Data Engineer, leadership team] [apply_url] x", "1. Discovered", [], "Data Engineer, leadership team", false],
    ["[Data Analyst - headcount planning] [apply_url] x", "1. Discovered", [], "Data Analyst - headcount planning", false],
    // eval-overwritten notes: title unrecoverable => leave alone
    ["uk-sponsor-maybe (medium confidence). Strongest fit: the stack...", "2. Triaged", [], null, false],
    // Position multi_select as the fallback signal
    ["uk-sponsor-licensed (high)", "1. Discovered", ["Senior Data Engineer"], null, true],
    // stage guard: past pre-apply, never touched even when out of band
    ["[Senior Analytics Engineer (m/f/d)] [apply_url] x", "4. Applied", [], "Senior Analytics Engineer (m/f/d)", false],
    ["[Senior Data Engineer (f/m/d)] [apply_url] x", "3. Drafted", [], "Senior Data Engineer (f/m/d)", false],
  ];
  // Category B stage guard: [stage, score, expectTrashable]
  const B = [
    ["1. Discovered", 40, true],
    ["2. Triaged", 74, true],
    ["Not pursuing", 30, true],
    [null, 20, true],              // no-stage also caught by category A
    ["3. Drafted", 40, false],     // work product exists
    ["4. Applied", 71, false],     // sent application, outcome-bearing
    ["5. Assessment/OA", 60, false],
    ["Rejected", 70, false],       // outcome history
    ["Withdrew", 72, false],       // outcome history
    ["Signed", 50, false],
    ["1. Discovered", 75, false],  // at floor, not below
    ["1. Discovered", 90, false],
    ["1. Discovered", null, false],// unscored — category B must not fire
  ];
  let pass = 0, fail = 0;
  for (const [stage, score, wantTrash] of B) {
    const got = belowFloorTrashable({ match_score: score, stage }, 75);
    if (got === wantTrash) pass++;
    else { fail++; console.error(`FAIL below-floor stage=${stage} score=${score}: got ${got} want ${wantTrash}`); }
  }
  // Sent-application guard: an Apply date protects at any stage.
  if (belowFloorTrashable({ match_score: 50, stage: "1. Discovered", apply_date: "2026-07-01" }, 75) === false) pass++;
  else { fail++; console.error(`FAIL sent-guard: below-floor at pre-apply with apply_date must be protected`); }
  for (const [notes, stage, position, wantTitle, wantViol] of F) {
    const gotTitle = jobTitleOf(notes);
    const gotViol = !!bandViolation({ fit_notes: notes, stage, position });
    const okT = gotTitle === wantTitle, okV = gotViol === wantViol;
    if (okT && okV) { pass++; }
    else {
      fail++;
      console.error(`FAIL ${JSON.stringify(notes.slice(0, 46))} stage=${stage}`);
      if (!okT) console.error(`   title: got ${JSON.stringify(gotTitle)} want ${JSON.stringify(wantTitle)}`);
      if (!okV) console.error(`   violation: got ${gotViol} want ${wantViol}`);
    }
  }
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST) selfTest();
else main().catch(err => { console.error("ROUTINE_ABORT:", err.message); process.exit(1); });
