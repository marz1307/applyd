#!/usr/bin/env node
/**
 * branch-dedup.mjs — one application per (company, city, role) branch
 *
 * Why: applying to the SAME role at the same Berlin SAP office via two
 * portals reads as scattershot. We keep ONLY the highest-scoring row per
 * (company, city, role) and archive (Notion Trash, recoverable 30 days)
 * the rest — they never appear in the queue again. Genuinely DIFFERENT
 * roles at the same company+city (e.g. home24 Berlin Data Scientist vs
 * Junior Data Engineer) are distinct branches and BOTH survive.
 *
 * Grouping key: (normalised_company, city, normRole). Different cities of
 * the same company are different branches (Berlin SAP ≠ Walldorf SAP), and
 * different roles are different branches too. Withdrew / Not pursuing /
 * Applied are out of scope (only Stage 2 + Stage 3 are considered), so an
 * expired sibling never suppresses a live application.
 *
 * Winner selection within a group:
 *   1. Highest Match score
 *   2. If tied: most recent Discovered date
 *   3. If still tied: most permissive remote (Remote > Hybrid > Onsite)
 *   4. If still tied: lowest APP-id (stable ordering)
 *
 * Effect on Notion:
 *   - Winner row: untouched (no marker needed — it's the only survivor)
 *   - Loser rows: PATCH archived:true (moves to Notion Trash, 30-day
 *     restore window if you change your mind)
 *
 * Idempotent: re-running on a queue with no multi-row groups is a no-op.
 *
 * Usage:
 *   node branch-dedup.mjs --dry-run    # show plan, no writes
 *   node branch-dedup.mjs              # apply (archive losers)
 *   node branch-dedup.mjs --json       # JSON summary
 *
 * Scope: Stage 2 (Triaged) and Stage 3 (Drafted) rows. Stage 1 is
 * pre-eval (no score yet, dedup is premature), Stage 4+ has already
 * been submitted (too late to dedup).
 */

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JSON_OUT = args.includes("--json");

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set.");
  process.exit(5);
}

function loadConfig() {
  const path = "config/profile.yml";
  if (!existsSync(path)) return {};
  try { return yaml.load(readFileSync(path, "utf8")) || {}; } catch { return {}; }
}
const CFG = loadConfig();
const DATABASE_ID = process.env.NOTION_DATABASE_ID
  || (CFG.notion && CFG.notion.applications_database_id);
if (!DATABASE_ID) {
  console.error("ROUTINE_ABORT: No Notion database ID configured — set NOTION_DATABASE_ID env var or notion.applications_database_id in config/profile.yml");
  process.exit(5);
}
const ENDPOINT = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;

// ─── Helpers ──────────────────────────────────────────────────────────────
const NOTION_HEADERS = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

async function fetchWithRetry(url, opts, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, opts);
    if (r.ok) return r;
    last = r;
    // Retry on 429 + 5xx; bail on 4xx (except 429)
    if (r.status < 500 && r.status !== 429) break;
    const backoffMs = 800 * Math.pow(2, i); // 0.8, 1.6, 3.2, 6.4s
    await new Promise(res => setTimeout(res, backoffMs));
  }
  const body = await last.text().catch(() => "");
  throw new Error(`Notion ${last.status} after ${tries} tries: ${body.slice(0, 200)}`);
}

async function queryAll(filter) {
  const all = [];
  let cursor = null;
  while (true) {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    const r = await fetchWithRetry(ENDPOINT, {
      method: "POST", headers: NOTION_HEADERS, body: JSON.stringify(body),
    });
    const data = await r.json();
    all.push(...data.results);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return all;
}

function getProp(page, name, kind) {
  const p = page.properties && page.properties[name];
  if (!p) return null;
  switch (kind) {
    case "title":      return p.title?.[0]?.plain_text || "";
    case "rich_text":  return (p.rich_text || []).map(t => t.plain_text).join("");
    case "number":     return p.number;
    case "select":     return p.select?.name || null;
    case "multi_select": return (p.multi_select || []).map(s => s.name);
    case "date":       return p.date?.start || null;
    case "url":        return p.url || null;
    default: return null;
  }
}

// Normalise company name for grouping — lowercase + strip legal suffixes
// + collapse whitespace + strip punctuation.
function normCompany(raw) {
  if (!raw) return "";
  let s = String(raw).toLowerCase().trim();
  s = s.replace(/[®©™]/g, "");
  // strip legal suffixes (greedy across multiple if chained)
  const suffixes = /\b(gmbh|ag|se|kg|kgaa|co\.?\s*kg|gmbh\s*&\s*co|inc|incorporated|llc|ltd|limited|plc|s\.?a\.?|b\.?v\.?|n\.?v\.?|sàrl|sarl|sp\.?\s*z\.?\s*o\.?\s*o\.?|oy|ab|as|aps|spa|srl|s\.?p\.?a\.?|s\.?l\.?|sas|s\.?a\.?s\.?|holding|group|international)\b/gi;
  s = s.replace(suffixes, "");
  s = s.replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(/\s+/g, " ");
  return s;
}

// City extraction: prefer `Location` if it's a single token; else parse
// from `Country, City` or "City, Country" patterns; remote → "remote".
function normCity(locationText, countryText) {
  if (!locationText) return countryText ? `${countryText.toLowerCase()}-remote` : "unknown";
  const t = String(locationText).toLowerCase();
  if (/\b(remote|home[\s-]office|fully remote|anywhere)\b/.test(t)) {
    return countryText ? `${countryText.toLowerCase()}-remote` : "remote";
  }
  // Take first comma-separated segment as the city.
  const first = t.split(",")[0].trim();
  return first.replace(/\s+/g, " ");
}

// Remote tier: 0=Onsite, 1=Hybrid, 2=Remote (higher wins ties).
function remoteTier(locationText, positionTags) {
  const t = ((locationText || "") + " " + (positionTags || []).join(" ")).toLowerCase();
  if (/\b(fully\s*remote|100%\s*remote|remote-only|anywhere)\b/.test(t)) return 2;
  if (/\bremote\b/.test(t)) return 2;
  if (/\bhybrid|some\s*remote|few\s*days\s*home\b/.test(t)) return 1;
  return 0;
}

// Normalised role key from the Position multi-select. Genuinely different roles
// at the same company+city stay SEPARATE branches (both survive); the same role
// posted across portals (same tags) still collapses. Empty position -> "any".
function normRole(positionTags) {
  if (!positionTags || !positionTags.length) return "any";
  return positionTags.map((s) => String(s).toLowerCase().trim()).filter(Boolean).sort().join("+");
}

async function archivePage(pageId) {
  // Notion API: PATCH /v1/pages/{id} with { archived: true } moves
  // the page to Trash (recoverable for 30 days).
  const r = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: NOTION_HEADERS,
    body: JSON.stringify({ archived: true }),
  });
  return await r.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────
const filter = {
  or: [
    { property: "Stage", select: { equals: "2. Triaged" } },
    { property: "Stage", select: { equals: "3. Drafted" } },
  ],
};

const pages = await queryAll(filter);

// Build groups keyed by (normCompany, normCity, normRole) — different roles at
// the same company+city are distinct branches and both survive.
const groups = new Map();
for (const p of pages) {
  const company    = getProp(p, "Company", "title") || getProp(p, "Company", "rich_text");
  const location   = getProp(p, "Location", "rich_text");
  const country    = getProp(p, "Country", "select");
  const score      = getProp(p, "Match score", "number") || 0;
  const discovered = getProp(p, "Discovered date", "date");
  const position   = getProp(p, "Position", "multi_select");
  const fitNotes   = getProp(p, "Fit notes", "rich_text");
  const appId      = getProp(p, "App ID", "rich_text") || p.id.slice(-8);

  const key = `${normCompany(company)}|${normCity(location, country)}|${normRole(position)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
    pageId: p.id,
    appId,
    company,
    location,
    score,
    discovered,
    remoteTier: remoteTier(location, position),
    fitNotes,
  });
}

// For each group with >1 row, pick winner + plan losers for archive
const plan = { winners: [], losers: [], single_member_groups: 0 };
for (const [key, members] of groups) {
  if (members.length === 1) { plan.single_member_groups++; continue; }

  // Sort: score DESC, discovered DESC, remoteTier DESC, appId ASC
  members.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ad = a.discovered || "0";
    const bd = b.discovered || "0";
    if (bd !== ad) return bd.localeCompare(ad);
    if (b.remoteTier !== a.remoteTier) return b.remoteTier - a.remoteTier;
    return String(a.appId).localeCompare(String(b.appId));
  });
  const winner = members[0];
  const losers = members.slice(1);

  plan.winners.push({
    appId: winner.appId,
    company: winner.company,
    city: key.split("|")[1],
    score: winner.score,
    group_size: members.length,
  });
  for (const l of losers) {
    plan.losers.push({
      appId: l.appId,
      pageId: l.pageId,
      company: l.company,
      city: key.split("|")[1],
      score: l.score,
      winner_appId: winner.appId,
    });
  }
}

if (DRY_RUN || JSON_OUT) {
  if (JSON_OUT) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`Branch-dedup dry-run plan:`);
    console.log(`  multi-row groups:    ${groups.size - plan.single_member_groups}`);
    console.log(`  single-member groups: ${plan.single_member_groups}`);
    console.log(`  winners (kept):       ${plan.winners.length}`);
    console.log(`  losers (to archive):  ${plan.losers.length}`);
    if (plan.losers.length) {
      console.log(`\n  Archive detail:`);
      for (const l of plan.losers.slice(0, 20)) {
        console.log(`    - ${l.appId} (${l.company}, ${l.city}, score=${l.score}) → ARCHIVE, winner ${l.winner_appId}`);
      }
      if (plan.losers.length > 20) console.log(`    ... and ${plan.losers.length - 20} more`);
    }
  }
  process.exit(0);
}

// Apply — archive losers only; winners stay untouched
let archived = 0, failed = 0;
for (const l of plan.losers) {
  try {
    await archivePage(l.pageId);
    archived++;
  } catch (e) { failed++; console.error(`  ARCHIVE fail ${l.appId}: ${e.message}`); }
}

console.log(`\nbranch-dedup applied:`);
console.log(`  groups deduped:    ${plan.winners.length}`);
console.log(`  rows archived:     ${archived}`);
console.log(`  failures:          ${failed}`);
process.exit(failed > 0 ? 1 : 0);
