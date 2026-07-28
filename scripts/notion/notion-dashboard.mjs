#!/usr/bin/env node

/**
 * notion-dashboard.mjs — Create / verify the applyd Notion dashboard.
 *
 * Creates the Applications database with the canonical schema (per
 * modes/notion-tracker.md), plus a child "📊 Dashboard" page with three
 * linked-database blocks the user configures into Pipeline / By score /
 * Active interviews views in the Notion UI.
 *
 * Uses the official Notion REST API directly (no MCP dependency) so it
 * runs from any shell: bash, Git Bash, PowerShell, Windows CMD.
 *
 * Auth: NOTION_TOKEN env var (internal-integration token starting with
 * `ntn_`). The token must be shared with the parent page in Notion:
 *   parent page → ··· → Connections → Add → your integration.
 *
 * Usage:
 *   # From your workspace folder, with NOTION_TOKEN set in .env:
 *   node ~/.claude/skills/applyd/notion-dashboard.mjs --parent-page <page-id-or-url>
 *
 * Optional flags:
 *   --title "Custom title"        Override default "🎯 Applications"
 *   --check                       Verify an existing DB matches the schema
 *   --skip-dashboard              Only create the DB, no dashboard page
 *   --workspace <path>            Use this folder (defaults to cwd)
 *
 * Writes the new DB id + data source id into <workspace>/config/profile.yml
 * under the notion: block, so subsequent /applyd modes pick it up
 * automatically.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { config as dotenvConfig } from "dotenv";
import yaml from "js-yaml";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

// ── arg parse ────────────────────────────────────────────────────────────

const args = { workspace: process.cwd() };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--parent-page") args.parent = process.argv[++i];
  else if (a === "--title") args.title = process.argv[++i];
  else if (a === "--check") args.check = true;
  else if (a === "--skip-dashboard") args.skipDashboard = true;
  else if (a === "--workspace") args.workspace = resolve(process.argv[++i]);
  else if (a === "--help" || a === "-h") {
    console.log(usage());
    process.exit(0);
  }
}

function usage() {
  return `notion-dashboard.mjs — create or verify the applyd Notion dashboard

Usage:
  node notion-dashboard.mjs --parent-page <page-id-or-url> [options]

Options:
  --parent-page <id|url>   Notion page to create the DB inside (required for create)
  --title <string>         DB title (default: "🎯 Applications")
  --check                  Verify the configured DB matches the canonical schema
  --skip-dashboard         Don't create the dashboard child page
  --workspace <path>       Workspace folder (default: cwd)
  --help                   This help

Environment:
  NOTION_TOKEN             Internal integration token, starting with ntn_

The token must be shared with the parent page in Notion:
  parent page → ··· → Connections → Add → your integration`;
}

// ── load env + profile ────────────────────────────────────────────────────

const workspace = args.workspace;
const envPath = join(workspace, ".env");
if (existsSync(envPath)) dotenvConfig({ path: envPath });
const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error(`✗ NOTION_TOKEN is not set.\nCreate an integration at https://www.notion.com/profile/integrations and add it to ${envPath}.`);
  process.exit(2);
}

const profilePath = join(workspace, "config", "profile.yml");
let profile = {};
if (existsSync(profilePath)) {
  profile = yaml.load(readFileSync(profilePath, "utf8")) || {};
}

// ── helpers ──────────────────────────────────────────────────────────────

function extractPageId(input) {
  if (!input) return null;
  // Accept raw IDs (32 hex, with or without dashes) or full URLs.
  const cleaned = String(input).replace(/-/g, "").toLowerCase();
  const m = cleaned.match(/([a-f0-9]{32})/);
  if (!m) return null;
  const id = m[1];
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

async function notion(path, opts = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Notion ${opts.method || "GET"} ${path} → ${res.status} ${body.code || ""}: ${body.message || ""}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function writeProfileNotionBlock({ dbId, dataSourceId, parentPageId }) {
  profile.notion = {
    applications_db_id: dbId.replace(/-/g, ""),
    applications_data_source_id: dataSourceId,
    parent_page_id: parentPageId.replace(/-/g, ""),
  };
  const yamlOut = yaml.dump(profile, { lineWidth: 100, noRefs: true });
  writeFileSync(profilePath, yamlOut, "utf8");
  console.log(`✓ Wrote notion.* IDs to ${profilePath}`);
}

// ── canonical schema (mirrors modes/notion-tracker.md) ───────────────────

const STAGES = [
  "1. Discovered", "2. Triaged", "3. Drafted", "4. Applied",
  "5. Assessment/OA", "6. Phone screen", "7. Tech interview",
  "8. Onsite/Final", "9. Offer", "Signed",
  "Rejected", "Withdrew", "Not pursuing",
];

const SOURCE_PORTALS = [
  "LinkedIn", "Indeed", "Glassdoor",
  "Monster", "Monster UK", "eFinancialCareers UK",
  "Welcome to the Jungle", "Handshake",
  "Greenhouse", "Ashby", "Lever", "Workable",
  "Reed UK", "Hays UK", "Company site", "Other",
];

const SCHEMA = {
  "Company":               { title: {} },
  "Job URL":               { url: {} },
  "Position":              { multi_select: { options: [] } },
  "Source portal":         { select: { options: SOURCE_PORTALS.map(name => ({ name })) } },
  "Country":               { select: { options: [] } },
  "Location":              { rich_text: {} },
  "Language":              { select: { options: [{ name: "English" }, { name: "Other" }] } },
  "Work model":            { select: { options: ["Remote", "Hybrid", "On-site"].map(name => ({ name })) } },
  "Company tier":          { select: { options: ["Tier 1", "Tier 2", "Tier 3"].map(name => ({ name })) } },
  "Industry":              { select: { options: ["SaaS", "Fintech", "Healthcare", "E-commerce", "Marketplace", "Consulting", "Other"].map(name => ({ name })) } },
  "Seniority":             { select: { options: ["Mid", "Senior", "Lead", "Staff", "Principal", "Head"].map(name => ({ name })) } },
  "Recruiter-sim verdict": { select: { options: ["INVITE", "MAYBE", "REJECT"].map(name => ({ name })) } },
  "Match score":           { number: { format: "number" } },
  "Fit notes":             { rich_text: {} },
  "JD snapshot":           { rich_text: {} },
  "Stage":                 { select: { options: STAGES.map(name => ({ name })) } },
  "CV variant":            { select: { options: [{ name: "General" }] } },
  "CL variant":            { select: { options: ["General", "Cover Letter", "Skipped"].map(name => ({ name })) } },
  "Discovered date":       { date: {} },
  "Apply date":            { date: {} },
  "Response date":         { date: {} },
  "Next action":           { rich_text: {} },
  "Next action date":      { date: {} },
  "Recruiter name":        { rich_text: {} },
  "Recruiter contact":     { rich_text: {} },
  "Salary band":           { rich_text: {} },
  "Visa/sponsorship":      { select: { options: ["Required", "Not required", "Unclear"].map(name => ({ name })) } },
  "Resume":                { files: {} },
  "Cover Letter":          { files: {} },
  "Referral?":             { checkbox: {} },
  "Application ID":        { unique_id: { prefix: "APP" } },
  "Agent run ID":          { rich_text: {} },
};

// ── main ─────────────────────────────────────────────────────────────────

async function checkExisting() {
  const dbId = profile?.notion?.applications_db_id;
  if (!dbId) {
    console.error("✗ No notion.applications_db_id in config/profile.yml — nothing to check.");
    process.exit(1);
  }
  console.log(`Checking database ${dbId}…`);
  const db = await notion(`/databases/${dbId}`);
  const have = Object.keys(db.properties || {});
  const want = Object.keys(SCHEMA);
  const missing = want.filter(k => !have.includes(k));
  const extra = have.filter(k => !want.includes(k));
  console.log(`  Title:       ${db.title?.[0]?.plain_text || "(untitled)"}`);
  console.log(`  Properties:  ${have.length} present (${want.length} canonical)`);
  if (missing.length) console.log(`  Missing:     ${missing.join(", ")}`);
  if (extra.length)   console.log(`  Custom:      ${extra.join(", ")}`);
  if (!missing.length) console.log("✓ Schema matches canonical.");
  else console.log("⚠ Schema is missing canonical properties. Re-run without --check to recreate.");
  return missing.length === 0 ? 0 : 1;
}

async function createDatabase() {
  const parentId = extractPageId(args.parent || profile?.notion?.parent_page_id);
  if (!parentId) {
    console.error("✗ --parent-page is required.\nPass a Notion page ID or full page URL (e.g. https://www.notion.so/MyPage-abc123…).");
    process.exit(1);
  }

  const title = args.title || "🎯 Applications";
  console.log(`Creating database "${title}" inside parent page ${parentId}…`);

  const body = {
    parent: { type: "page_id", page_id: parentId },
    title: [{ type: "text", text: { content: title } }],
    properties: SCHEMA,
  };

  const db = await notion("/databases", { method: "POST", body: JSON.stringify(body) });
  const dbId = db.id;
  const dataSourceId = db.data_sources?.[0]?.id || dbId;
  console.log(`✓ Database created: ${db.url}`);
  console.log(`  database_id:    ${dbId}`);
  console.log(`  data_source_id: ${dataSourceId}`);

  writeProfileNotionBlock({ dbId, dataSourceId, parentPageId: parentId });

  if (!args.skipDashboard) await createDashboardPage({ parentId, dbId, title });

  return db;
}

async function createDashboardPage({ parentId, dbId, title }) {
  console.log("Creating dashboard child page with three linked-database blocks…");
  const body = {
    parent: { type: "page_id", page_id: parentId },
    properties: {
      title: { title: [{ type: "text", text: { content: "📊 Dashboard" } }] },
    },
    children: [
      {
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: `${title} dashboard` } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content:
            "Three views of the same Applications database. Open each linked-database block below and switch its layout in the Notion UI (View options → Layout). Recommended:" } }],
        },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Pipeline — Board grouped by Stage" } }] },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: "By score — Table sorted by Match score DESC, filtered to Stages 2–3" } }] },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: "Active interviews — Board grouped by Stage, filtered to Stages 5–9" } }] },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "Pipeline" } }] },
      },
      { object: "block", type: "link_to_page", link_to_page: { type: "database_id", database_id: dbId } },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "By score" } }] },
      },
      { object: "block", type: "link_to_page", link_to_page: { type: "database_id", database_id: dbId } },
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "Active interviews" } }] },
      },
      { object: "block", type: "link_to_page", link_to_page: { type: "database_id", database_id: dbId } },
    ],
  };

  const page = await notion("/pages", { method: "POST", body: JSON.stringify(body) });
  console.log(`✓ Dashboard page created: ${page.url}`);
  console.log("\n  Note: the Notion public REST API can't preconfigure view filters / layouts.");
  console.log("  Open each linked-database block once and set its layout + filter (one-time, ~1 minute total).");
}

// ── run ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    const code = args.check ? await checkExisting() : (await createDatabase(), 0);
    process.exit(code);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    if (err.body) console.error(`  ${JSON.stringify(err.body)}`);
    process.exit(1);
  }
})();
