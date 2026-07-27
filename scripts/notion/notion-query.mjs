#!/usr/bin/env node
/**
 * notion-query.mjs — Filter + paginated query of the Applications data source
 *
 * Solves the semantic-search 25-result cap that limited auto-eval to 23
 * of ~186 Stage-1 rows. Uses the official Notion REST API directly
 * (https://api.notion.com/v1) rather than the MCP, which exposes only
 * semantic search.
 *
 * Auth: NOTION_TOKEN env var (an internal integration token starting
 * with `ntn_` or `secret_`). Get one from
 * https://www.notion.com/my-integrations, then add the integration to
 * the Applications DB via the DB's ··· → Connections menu.
 *
 * Usage:
 *   node notion-query.mjs --stage "1. Discovered" --json
 *   node notion-query.mjs --stage "2. Triaged" --min-score 75 --json
 *   node notion-query.mjs --stage "1. Discovered" --limit 50
 *   node notion-query.mjs --sentinel-missing --json
 *       # rows whose Fit notes do NOT contain "[auto-draft" — useful
 *       # for auto-draft's "needs drafting" filter
 *
 * Output:
 *   --json   → array of {id, title, properties:{...essential fields}}
 *   default  → human-readable table with id+company+score+stage
 *
 * Reads data source ID from config/profile.yml → notion.applications_data_source_id.
 * Falls back to a hardcoded ID only if config is missing.
 */

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const STAGE = arg("--stage");
const MIN_SCORE = arg("--min-score") ? parseInt(arg("--min-score"), 10) : null;
const LIMIT = arg("--limit") ? parseInt(arg("--limit"), 10) : null;
const JSON_ONLY = args.includes("--json");
const SENTINEL_MISSING = args.includes("--sentinel-missing");

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set.");
  console.error("Get an internal integration token from https://www.notion.com/my-integrations,");
  console.error("add the integration to the Applications DB, then `setx NOTION_TOKEN \"ntn_...\"`.");
  process.exit(5);
}

function loadConfig() {
  const path = "config/profile.yml";
  if (!existsSync(path)) return {};
  try { return yaml.load(readFileSync(path, "utf8")) || {}; }
  catch { return {}; }
}
const CFG = loadConfig();
// /v1/databases/{id}/query expects the *database* UUID, NOT the data-source UUID.
// In this workspace they are different (see config/profile.yml notes). Falling
// back on a hardcoded database ID, not the data-source ID.
const DATABASE_ID = process.env.NOTION_DATABASE_ID || (CFG.notion && CFG.notion.applications_database_id);
if (!DATABASE_ID) {
  console.error("ROUTINE_ABORT: No Notion database ID configured — set NOTION_DATABASE_ID env var or notion.applications_database_id in config/profile.yml");
  process.exit(5);
}

const ENDPOINT = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;

async function query(filter, startCursor = null) {
  const body = { page_size: 100 };
  if (filter) body.filter = filter;
  if (startCursor) body.start_cursor = startCursor;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion API ${res.status}: ${t.slice(0, 500)}`);
  }
  return res.json();
}

function buildFilter() {
  const clauses = [];
  if (STAGE) clauses.push({ property: "Stage", select: { equals: STAGE } });
  if (MIN_SCORE !== null) clauses.push({ property: "Match score", number: { greater_than_or_equal_to: MIN_SCORE } });
  if (SENTINEL_MISSING) clauses.push({ property: "Fit notes", rich_text: { does_not_contain: "[auto-draft" } });
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return clauses[0];
  return { and: clauses };
}

function extractTitle(props) {
  const titleProp = Object.values(props).find(p => p && p.type === "title");
  if (!titleProp || !titleProp.title || titleProp.title.length === 0) return "";
  return titleProp.title.map(t => t.plain_text).join("");
}

function extractEssentials(page) {
  const p = page.properties || {};
  const get = (name, type) => {
    const x = p[name];
    if (!x || x.type !== type) return null;
    if (type === "select") return x.select?.name ?? null;
    if (type === "number") return x.number;
    if (type === "url") return x.url;
    if (type === "rich_text") return x.rich_text?.map(t => t.plain_text).join("") ?? "";
    if (type === "multi_select") return x.multi_select?.map(o => o.name) ?? [];
    if (type === "date") return x.date?.start ?? null;
    return null;
  };
  return {
    id: page.id,
    url: page.url,
    application_id: p["Application ID"]?.unique_id ? `${p["Application ID"].unique_id.prefix}-${p["Application ID"].unique_id.number}` : null,
    title: extractTitle(p),
    stage: get("Stage", "select"),
    match_score: get("Match score", "number"),
    country: get("Country", "select"),
    location: get("Location", "rich_text"),
    job_url: get("Job URL", "url"),
    position: get("Position", "multi_select"),
    source_portal: get("Source portal", "select"),
    language: get("Language", "select"),
    company_tier: get("Company tier", "select"),
    agent_run_id: get("Agent run ID", "rich_text"),
    fit_notes: get("Fit notes", "rich_text"),
    jd_snapshot: get("JD snapshot", "rich_text"),
    discovered_date: get("Discovered date", "date"),
    recruiter_sim_verdict: get("Recruiter-sim verdict", "select"),
  };
}

async function main() {
  const filter = buildFilter();
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await query(filter, cursor);
    pages++;
    for (const page of r.results) {
      all.push(extractEssentials(page));
      if (LIMIT !== null && all.length >= LIMIT) { cursor = null; break; }
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  if (JSON_ONLY) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  console.log(`query: stage=${STAGE ?? "*"} min_score=${MIN_SCORE ?? "*"} sentinel_missing=${SENTINEL_MISSING}`);
  console.log(`fetched: ${all.length} rows across ${pages} API pages`);
  console.log("");
  console.log("APP".padEnd(8), "STAGE".padEnd(18), "SCORE".padEnd(6), "COMPANY".padEnd(30), "POSITION");
  console.log("─".repeat(100));
  for (const r of all) {
    console.log(
      (r.application_id || "—").padEnd(8),
      (r.stage || "—").padEnd(18),
      (r.match_score === null ? "—" : String(r.match_score)).padEnd(6),
      (r.title || "—").slice(0, 30).padEnd(30),
      (r.position || []).join(", ").slice(0, 40),
    );
  }
}

main().catch(err => {
  console.error("ROUTINE_ABORT:", err.message);
  process.exit(1);
});
