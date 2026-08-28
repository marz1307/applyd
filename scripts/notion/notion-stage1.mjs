// notion-stage1.mjs — ONE way to write a Stage-1 "Discovered" row to Notion.
//
// WHY THIS EXISTS (2026-08-11)
// morning-scan could not write to Notion AT ALL. Its own log said so every run:
//
//   "Notion Stage-1 write path (step 4) is structurally unavailable this run —
//    Notion MCP is not loaded under --strict-mcp-config (brightdata-only per
//    CLAUDE.md environment isolation), and no REST equivalent exists yet for
//    scan.mjs-sourced hits (bd-bulk-scan.mjs has its own working
//    notionCreatePage() but it's not shared)."
//
// So the routine scanned 42 ATS portals, pulled ~6,280 postings a day, and
// dropped every survivor on the floor. Across eight runs it found 0, 3, 1, 0, 0
// and 2 hits and wrote ZERO rows on every single one. The three it found on
// 08-10 are simply gone. It burned an LLM session daily to do nothing.
//
// The scanners disagreed on capability, not intent: bd-bulk-scan.mjs is a pure
// node script and talks to the Notion REST API directly, so environment
// isolation never affected it. morning-scan.md is a `claude -p` prompt and was
// told to use the Notion MCP, which that same isolation removes. Lifting the
// working REST path out of bd-bulk-scan and into a module both can call is the
// fix, and it also kills the duplication the log complained about.
//
// Country and position inference moved here VERBATIM from bd-bulk-scan.mjs so
// rows from either scanner are tagged identically. Divergence there would show
// up later as inconsistent Country facets in the tracker, which is exactly the
// class of drift [[country-from-location-not-query]] documents.
'use strict';

// scripts/notion/notion-stage1.mjs -> scripts/net-retry.mjs
import { fetchWithRetry } from '../net-retry.mjs';

// ── Country resolution (moved from bd-bulk-scan.mjs, unchanged) ─────────
export function dachCountryFromUrl(url) {
  const u = (url || "").toLowerCase();
  if (/\b(z[uü]rich|zuerich|zurich|basel|bern|genf|geneva|gen[eè]ve|lausanne|lugano|winterthur|\bzug\b)\b/.test(u)) return "Switzerland";
  if (/\b(wien|vienna|graz|linz|salzburg|innsbruck|klagenfurt)\b/.test(u)) return "Austria";
  return "Germany";
}

// Fold any country onto the canonical Notion Country select options. Anything
// not an explicit option — France, Poland, Italy, Belgium, Portugal, … — buckets
// into "EU (other)" (the exact city still lives in the Location field).
export function normCountry(c) {
  if (!c) return "Other";
  const OPT = {
    "uk": "UK", "united kingdom": "UK", "great britain": "UK", "england": "UK",
    "scotland": "UK", "wales": "UK", "northern ireland": "UK",
    "germany": "Germany", "deutschland": "Germany",
    "austria": "Austria", "switzerland": "Switzerland",
    "netherlands": "Netherlands", "holland": "Netherlands",
    "ireland": "Ireland", "spain": "Spain", "remote": "Remote", "other": "Other",
  };
  const k = String(c).toLowerCase().trim();
  return OPT[k] || "EU (other)";
}

// Derive the true country from the posting's Location string. Explicit country
// name wins; else a known city; else null (caller keeps the query country).
export function countryFromLocation(loc) {
  if (!loc) return null;
  const s = " " + String(loc).toLowerCase().replace(/_/g, " ") + " ";
  const NAMES = ["united kingdom", "great britain", "northern ireland", "netherlands", "switzerland", "germany", "deutschland", "austria", "ireland", "france", "spain", "italy", "belgium", "poland", "portugal", "sweden", "denmark", "norway", "finland", "luxembourg", "romania", "england", "scotland", "wales", "uk"];
  for (const n of NAMES) { if (new RegExp("[^a-z]" + n + "[^a-z]").test(s)) return normCountry(n); }
  const CITY = {
    Germany: ["berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln", "stuttgart", "düsseldorf", "dusseldorf", "leipzig", "dresden", "nuremberg", "nürnberg", "karlsruhe", "mannheim", "hannover"],
    UK: ["london", "manchester", "edinburgh", "leeds", "birmingham", "bristol", "cambridge", "glasgow", "reading", "oxford", "sheffield", "liverpool", "nottingham", "cardiff", "belfast", "brighton", "newcastle", "jersey", "birkenhead"],
    Netherlands: ["amsterdam", "utrecht", "rotterdam", "eindhoven", "the hague", "den haag"],
    France: ["paris", "lyon", "toulouse", "lille", "nantes", "bordeaux"],
    Ireland: ["dublin", "cork", "galway", "limerick"],
    Austria: ["vienna", "wien", "graz", "linz", "salzburg", "innsbruck"],
    Switzerland: ["zurich", "zürich", "geneva", "basel", "bern", "lausanne", "zug", "winterthur"],
    Spain: ["madrid", "barcelona", "valencia", "málaga", "malaga", "sevilla", "seville"],
    Italy: ["milan", "milano", "rome", "roma", "turin", "torino"],
    Belgium: ["brussels", "antwerp", "ghent"],
    Poland: ["warsaw", "krakow", "kraków", "wroclaw", "gdansk"],
  };
  for (const [country, cities] of Object.entries(CITY)) {
    for (const city of cities) { if (new RegExp("[^a-zà-ÿ]" + city + "[^a-zà-ÿ]").test(s)) return normCountry(country); }
  }
  if (/[^a-z]remote[^a-z]/.test(s)) return normCountry("remote");
  return null;
}

// The posting's actual LOCATION beats the search-query country: a "Germany"
// query surfacing a Dublin role must land as Ireland. DACH-exclusive boards
// (Xing / StepStone-DE) are the exception — there the URL city is authoritative.
export function resolveCountry(job) {
  const c = job._country;
  if (/xing\.com|stepstone\.de/i.test(job.url || "") && !/^(Germany|Austria|Switzerland)$/i.test(c || "")) {
    return normCountry(dachCountryFromUrl(job.url));
  }
  return normCountry(countryFromLocation(job.location) || c);
}

// ── Position inference (moved from bd-bulk-scan.mjs, unchanged) ─────────
export function inferPosition(title) {
  const t = (title || "").toLowerCase();
  const positions = [];
  if (t.includes("analytics engineer") || t.includes("analytics engineering")) positions.push("Analytics Engineer");
  if (t.includes("data scientist") || t.includes("decision scientist") || t.includes("applied scientist")) positions.push("Data Scientist");
  if (t.includes("data engineer") || t.includes("dateningenieur")) positions.push("Data Engineer");
  if (t.includes("data analyst") || t.includes("datenanalyst")) positions.push("Data Analyst");
  if (t.includes("bi engineer") || t.includes("business intelligence")) positions.push("BI Engineer");
  if (t.includes("ml engineer") || t.includes("machine learning")) positions.push("ML Engineer");
  if (positions.length === 0) positions.push("Analytics Engineer"); // safe default
  return [...new Set(positions)];
}

/**
 * Write one Stage-1 row. Throws on failure BY DESIGN — the caller counts
 * failures and a run must not silently under-report what it wrote.
 *
 * @param {object} job    { company, title, url, location, source_portal, _country, _role, ... }
 * @param {object} opts   { notionToken, databaseId, scanner, fitNote }
 *                        scanner  — 'bd-bulk-scan' | 'morning-scan' | …, used
 *                                   for the Agent run ID and the Fit-notes tag
 *                        fitNote  — optional extra text appended to Fit notes
 */
export async function createStage1Row(job, opts = {}) {
  const token = opts.notionToken || process.env.NOTION_TOKEN;
  const dbId = opts.databaseId;
  if (!token) throw new Error('NOTION_TOKEN not set');
  if (!dbId) throw new Error('databaseId not supplied');
  const scanner = opts.scanner || 'scan';
  const runId = `${scanner}-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "-")}`;

  const props = {
    "Company": { title: [{ text: { content: (job.company || "Undisclosed").slice(0, 200) } }] },
    "Position": { multi_select: inferPosition(job.title || job._role).map(name => ({ name })) },
    "Job URL": { url: String(job.url).slice(0, 1990) },
    "Country": { select: { name: resolveCountry(job) } },
    "Location": { rich_text: [{ text: { content: (job.location || "").slice(0, 200) } }] },
    "Source portal": { select: { name: job.source_portal || scanner } },
    "Stage": { select: { name: "1. Discovered" } },
    "Company tier": { select: { name: "Tier 3" } },
    "Agent run ID": { rich_text: [{ text: { content: runId } }] },
    "Discovered date": { date: { start: new Date().toISOString().slice(0, 10) } },
    "Fit notes": { rich_text: [{ text: { content:
        `[${scanner}] portal=${job.source_portal || scanner} title=${job.title || "(unknown)"}` +
        (job.posted_time ? ` posted=${job.posted_time}` : "") +
        (job.applicant_count != null ? ` apps=${job.applicant_count}` : "") +
        (job.employment_type ? ` type=${job.employment_type}` : "") +
        (job.easy_apply ? " easy_apply" : "") +
        (opts.fitNote ? `\n\n${opts.fitNote}` : "") +
        (job.jd_summary ? `\n\nJD: ${job.jd_summary.slice(0, 1500)}` : "")
    } }] },
  };

  const r = await fetchWithRetry("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({ parent: { database_id: dbId }, properties: props }),
  }, { label: `${scanner} notion-insert` });
  if (!r.ok) throw new Error(`Notion ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export default { createStage1Row, resolveCountry, inferPosition, normCountry, countryFromLocation, dachCountryFromUrl };
