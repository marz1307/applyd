#!/usr/bin/env node
/**
 * retro-clean.mjs — apply bd-bulk-scan's clean gate to existing Notion rows.
 *
 * Walks Stage 1 / Stage 2 (newest first), applies the same title + location
 * filters, archives losers to Notion Trash (recoverable 30 days). One-off
 * cleanup tool to apply post-tightening filters retroactively.
 *
 * Config: NOTION_TOKEN env var + applications_database_id in
 * config/profile.yml (or NOTION_DATABASE_ID env var). No hardcoded fallback.
 *
 * Usage:
 *   node scripts/scan/retro-clean.mjs --dry-run     # show what would be archived
 *   node scripts/scan/retro-clean.mjs --discovered 2026-05-28   # only that day
 *   node scripts/scan/retro-clean.mjs               # apply for real
 */

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import { loadTaxonomy, deriveTitleFilter } from "./role-taxonomy.mjs";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(n);
const DRY_RUN = has("--dry-run");
const DISCOVERED = arg("--discovered");  // YYYY-MM-DD

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("ROUTINE_ABORT: NOTION_TOKEN unset"); process.exit(5); }

function loadCfg() {
  if (!existsSync("config/profile.yml")) return {};
  try { return yaml.load(readFileSync("config/profile.yml", "utf8")) || {}; } catch { return {}; }
}
const CFG = loadCfg();
const DB = process.env.NOTION_DATABASE_ID || (CFG.notion && CFG.notion.applications_database_id);
if (!DB) {
  console.error("ROUTINE_ABORT: no Notion database id — set NOTION_DATABASE_ID or notion.applications_database_id in config/profile.yml");
  process.exit(5);
}
const H = { Authorization: "Bearer " + TOKEN, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

// --- Filter gates ---
// TITLE_POS is the single source of truth from config/role-taxonomy.yml
// (core + adjacent). Absent taxonomy => fall back to a conservative default set.
// TITLE_NEG stays local because its regex boundaries are deliberate; the
// substring gates below cover the German compounds that TITLE_NEG's \b misses.
const TITLE_NEG = [
  "Senior", "Sr.", "Sr ", "Lead ", "Staff ", "Principal", "Manager", "Head of", "Head Of",
  "VP", "Vice President", "Director", "CTO", "CDO", "Chief",
  "Junior", "Intern", "Trainee", "Apprentice", "Graduate",
];
const _rcTax = loadTaxonomy(".");
const _rcFilter = _rcTax ? deriveTitleFilter(_rcTax) : null;
const TITLE_POS = _rcFilter && _rcFilter.positive.length
  ? _rcFilter.positive
  : [
      "Analytics Engineer", "Data Scientist", "Data Engineer", "Data Analyst",
      "BI Engineer", "BI Analyst", "ML Engineer", "Machine Learning Engineer",
      "Business Intelligence", "Analytics Consultant", "Reporting Engineer",
      "Decision Scientist", "Applied Scientist",
      "Datenanalyst", "Dateningenieur", "Datenwissenschaftler",
    ];
const WRONG_TECH = [
  "solidity", "blockchain", "web3", "crypto",
  "salesforce admin", "salesforce developer",
  "ios developer", "android developer", "mobile developer",
  ".net developer", "c# developer", "java developer", "java engineer",
  "ruby on rails", "php developer", "wordpress developer",
  "embedded", "firmware", "fpga", "asic", "cobol", "mainframe",
  "sap basis", "oracle ebs", "oracle apps",
];
const PLACEHOLDERS = [
  "(unknown)", "(efc listing)", "(indeed listing)", "(wttj listing)",
  "(miig listing)", "(careerbee listing)", "(stepstone listing)",
  "(linkedin listing)", "(xing listing)",
];

// Substring-matched German pre-graduate terms. German compounds and inflects,
// so "Werkstudent" must catch "Werkstudentin" and "Ausbildung" must catch
// "Ausbildungsplatz". Mirrors the `match: substring` block in the taxonomy.
const TITLE_NEG_SUBSTRING = [
  "werkstudent", "praktikum", "praktikant",
  "ausbildung", "auszubildende", "azubi",
  "duales studium", "dualer student", "studentische hilfskraft",
  "umschulung", "weiterbildung",
];

// Location gate — target-market only. Adapt to your own market by editing
// this list (or lift it into config if you want it configurable).
const BLOCK_LOCS = [
  "india", "bengaluru", "bangalore", "hyderabad", "mumbai", "pune", "chennai",
  "singapore", "hong kong", "tokyo", "japan", "korea",
  "australia", "sydney", "melbourne", "perth",
  "brazil", "são paulo", "sao paulo", "argentina", "mexico city",
  "dubai", "uae", "saudi", "tel aviv", "israel",
  "san francisco", "new york", "boston", "chicago", "los angeles",
  "seattle", "atlanta", "austin", "denver", "miami",
  "us only", "us-only", "usa only", "americas only",
  "canada only", "toronto", "vancouver", "montreal",
];

function failsTitleGate(title) {
  const t = (title || "").toLowerCase().trim();
  if (!t || PLACEHOLDERS.some(p => t.includes(p))) return "placeholder";
  for (const s of TITLE_NEG_SUBSTRING) {
    if (t.includes(s)) return `seniority:${s}`;
  }
  for (const n of TITLE_NEG) {
    const re = new RegExp("\\b" + n.trim().replace(/[.+?*[\](){}|\\^$]/g, "\\$&") + "\\b", "i");
    if (re.test(t)) return `seniority:${n.trim()}`;
  }
  for (const w of WRONG_TECH) if (t.includes(w)) return `wrong_tech:${w}`;
  if (!TITLE_POS.some(p => t.includes(p.toLowerCase()))) return "no_positive_match";
  return null;
}

function failsLocationGate(loc) {
  const l = (loc || "").toLowerCase().trim();
  if (!l) return null;
  for (const b of BLOCK_LOCS) if (l.includes(b)) return `block_loc:${b}`;
  return null;
}

// Fetch all Stage 1 / Stage 2 rows
async function fetchPages() {
  const out = [];
  const filter = {
    and: [
      { or: [
        { property: "Stage", select: { equals: "1. Discovered" } },
        { property: "Stage", select: { equals: "2. Triaged" } },
      ]},
      ...(DISCOVERED ? [{ property: "Discovered date", date: { equals: DISCOVERED } }] : []),
    ],
  };
  let cursor = null;
  do {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, { method: "POST", headers: H, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Notion query ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    out.push(...data.results);
    cursor = data.next_cursor;
  } while (cursor);
  return out;
}

// SENT-APPLICATION GUARD. Last line of defence, deliberately at the write
// itself rather than in the caller's filter: re-read the page and refuse if
// it carries an Apply date. Stage is not a reliable proxy for "not yet sent"
// — rows can sit at earlier stages with an Apply date already set. Losing a
// duplicate is cheap and reversible; losing a live employer conversation is
// neither, and it is silent.
async function archive(pageId) {
  const chk = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: H });
  if (chk.ok) {
    const p = await chk.json();
    const applied = p.properties?.["Apply date"]?.date?.start;
    if (applied) {
      console.error(`  PROTECTED: ${pageId.slice(-8)} has Apply date ${applied} — sent application, refusing to archive`);
      return false;
    }
  }
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH", headers: H, body: JSON.stringify({ archived: true }),
  });
  if (!r.ok) throw new Error(`archive ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return true;
}

// --- Main ---
console.error(`retro-clean: fetching pages${DISCOVERED ? ` discovered=${DISCOVERED}` : ""}...`);
const rows = await fetchPages();
console.error(`retro-clean: ${rows.length} pages found`);

const reasons = {};
const losers = [];
for (const r of rows) {
  // Read title from Fit notes (where bd-bulk-scan writes "title=...")
  // OR from Company.title which sometimes holds the title for legacy rows.
  const fitNotes = (r.properties?.["Fit notes"]?.rich_text?.[0]?.plain_text) || "";
  // Title is in Fit notes as `title=<text>` until next ' posted='/'apps=' or end-of-line/string.
  // The companyTitle field often contains "Undisclosed (...)" placeholder, so the
  // Fit-notes title is the authoritative source for bd-bulk-scan rows.
  const fitTitleMatch = fitNotes.match(/title=(.+?)(?:\s+(?:posted=|apps=|type=|easy_apply|portal=)|[\r\n]|$)/);
  const fitTitle = fitTitleMatch ? fitTitleMatch[1].trim() : "";
  const companyTitle = (r.properties?.Company?.title?.[0]?.plain_text) || "";
  const titleCombined = fitTitle || companyTitle;

  const location = (r.properties?.Location?.rich_text?.[0]?.plain_text) || "";

  let reason = failsTitleGate(titleCombined);
  if (!reason) reason = failsLocationGate(location);
  if (reason) {
    losers.push({ id: r.id, title: titleCombined.slice(0, 80), location: location.slice(0, 40), reason });
    reasons[reason.split(":")[0]] = (reasons[reason.split(":")[0]] || 0) + 1;
  }
}

console.log();
console.log(`Total rows examined:  ${rows.length}`);
console.log(`Would archive:        ${losers.length} (${(losers.length / Math.max(rows.length, 1) * 100).toFixed(1)}%)`);
console.log();
console.log("By reason:");
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${v}`);
}
console.log();
console.log("Sample 10:");
for (const l of losers.slice(0, 10)) {
  console.log(`  [${l.reason}]  ${l.title.padEnd(45)} @ ${l.location}`);
}

if (DRY_RUN) {
  console.log("\n[dry-run] no archive operations performed");
  process.exit(0);
}

console.log();
console.log(`Archiving ${losers.length} rows...`);
let archived = 0, failed = 0;
for (const l of losers) {
  try {
    await archive(l.id);
    archived++;
  } catch (e) {
    failed++;
    console.error(`  fail ${l.id.slice(0, 8)}: ${e.message}`);
  }
}
console.log(`\nArchived: ${archived}  Failed: ${failed}`);

console.log("\n--- ROUTINE_CONTRACT ---");
console.log("ROUTINE: retro-clean");
console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
console.log(`ROWS_EXAMINED: ${rows.length}`);
console.log(`ROWS_ARCHIVED: ${archived}`);
console.log(`ROWS_FAILED: ${failed}`);
console.log(`BY_REASON: ${JSON.stringify(reasons)}`);
console.log("ERRORS: " + failed);
console.log("--- END_ROUTINE_CONTRACT ---");
