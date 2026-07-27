#!/usr/bin/env node
/**
 * notion-cleanup.mjs — Aggressive cleanup of the Applications DB
 *
 * Removes rows that should never sit in Notion:
 *   A. Rows with no Stage set (orphans from older imports / failed writes)
 *   B. Rows already scored < 75 (below the triage floor)
 *   C. Cross-portal duplicates (same job appearing on 2+ portals — keep
 *      the highest-preference portal, trash the rest)
 *
 * "Trashed" = Notion `archived: true` (the API word; row goes to Trash,
 * recoverable for 30 days, hidden from views). NOT a hard delete.
 *
 * Usage:
 *   node notion-cleanup.mjs --dry-run    # report only, no changes
 *   node notion-cleanup.mjs              # actually trash
 *   node notion-cleanup.mjs --json       # JSON-only output
 */

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_ONLY = args.includes("--json");

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set."); process.exit(5); }

function loadConfig() {
  if (!existsSync("config/profile.yml")) return {};
  try { return yaml.load(readFileSync("config/profile.yml", "utf8")) || {}; } catch { return {}; }
}
const CFG = loadConfig();
const DATABASE_ID = process.env.NOTION_DATABASE_ID || (CFG.notion && CFG.notion.applications_database_id);
if (!DATABASE_ID) {
  console.error("ROUTINE_ABORT: No Notion database ID configured — set NOTION_DATABASE_ID env var or notion.applications_database_id in config/profile.yml");
  process.exit(5);
}
const SCORE_FLOOR = (CFG.triage && CFG.triage.score_floor) || 75;

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
  };
}

function canonicalUrl(u) {
  if (!u || typeof u !== "string") return "";
  try {
    const parsed = new URL(u);
    parsed.search = ""; parsed.hash = "";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch { return u.toLowerCase().split("?")[0].split("#")[0].replace(/\/+$/, ""); }
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
  if (!JSON_ONLY) console.log(`Fetching all rows (excluding already-archived)…`);
  const pages = await queryAll();
  if (!JSON_ONLY) console.log(`  ${pages.length} live rows`);
  const rows = pages.map(extractEssentials).filter(r => !r.archived);

  // ── A. No-Stage orphans ───────────────────────────────────────────
  const orphans = rows.filter(r => !r.stage);
  // ── B. Below-floor rows ───────────────────────────────────────────
  const belowFloor = rows.filter(r => r.match_score !== null && r.match_score < SCORE_FLOOR);
  // ── C. Cross-portal duplicates by canonical Job URL ───────────────
  // (Skip fuzzy company+title — the title property here is the company
  // name, so a fuzzy key against itself would over-match by orders of
  // magnitude. URL-canonical is reliable; fuzzy would need a separate
  // Position-text signal we don't have here.)
  const urlIndex = new Map();
  const dupes = [];
  const liveForDedup = rows.filter(r => r.stage && r.stage !== "Not pursuing" && r.stage !== "Withdrew" && r.stage !== "Rejected" && r.job_url);
  for (const r of liveForDedup) {
    const cu = canonicalUrl(r.job_url);
    if (!cu) continue;
    const existing = urlIndex.get(cu);
    if (existing) {
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

  // Compute final trash set (union of A + B + C). Deduplicate by id.
  const trashIds = new Map();
  for (const r of orphans)     trashIds.set(r.id, { row: r, reason: "no-stage" });
  for (const r of belowFloor)  trashIds.set(r.id, { row: r, reason: `below-floor(${r.match_score})` });
  for (const d of dupes)       trashIds.set(d.trash.id, { row: d.trash, reason: `dupe-of(${d.kept.application_id || d.kept.id.slice(0,8)} ${d.kept.source_portal})` });

  const plan = Array.from(trashIds.entries()).map(([id, e]) => ({
    id, app: e.row.application_id, title: e.row.title, stage: e.row.stage,
    score: e.row.match_score, portal: e.row.source_portal, reason: e.reason,
  }));

  if (JSON_ONLY) {
    console.log(JSON.stringify({
      live_in: rows.length,
      orphans_no_stage: orphans.length,
      below_floor: belowFloor.length,
      cross_portal_dupes: dupes.length,
      total_to_trash: plan.length,
      dry_run: DRY_RUN,
      plan,
    }, null, 2));
  } else {
    console.log("");
    console.log(`Planned trash:`);
    console.log(`  no-stage orphans: ${orphans.length}`);
    console.log(`  below floor (<${SCORE_FLOOR}): ${belowFloor.length}`);
    console.log(`  cross-portal dupes: ${dupes.length}`);
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

  if (!JSON_ONLY) console.log(`\nTrashing ${plan.length} pages…`);
  let ok = 0, fail = 0;
  for (const p of plan) {
    try { await trashPage(p.id); ok++; if (!JSON_ONLY && ok % 25 === 0) console.log(`  ${ok}/${plan.length}…`); }
    catch (e) { fail++; if (!JSON_ONLY) console.error(`  ✗ ${p.id}: ${e.message}`); }
  }

  if (!JSON_ONLY) {
    console.log("");
    console.log(`Trashed: ${ok} · Failed: ${fail}`);
    console.log("");
    console.log("--- ROUTINE_CONTRACT ---");
    console.log("ROUTINE: notion-cleanup");
    console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
    console.log(`SCORE_FLOOR: ${SCORE_FLOOR}`);
    console.log(`LIVE_ROWS_BEFORE: ${rows.length}`);
    console.log(`ORPHANS_NO_STAGE: ${orphans.length}`);
    console.log(`BELOW_FLOOR: ${belowFloor.length}`);
    console.log(`CROSS_PORTAL_DUPES: ${dupes.length}`);
    console.log(`TOTAL_TRASHED: ${ok}`);
    console.log(`TRASH_FAILURES: ${fail}`);
    console.log("--- END_ROUTINE_CONTRACT ---");
  }
}

main().catch(err => { console.error("ROUTINE_ABORT:", err.message); process.exit(1); });
