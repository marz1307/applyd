#!/usr/bin/env node
/**
 * referral-scout-run.mjs — nightly Referral Scout writer (routines/referral-scout.md)
 *
 * Reads the Stage-3 "Drafted" queue (data/.routine-tmp/scout-queue.json, produced by
 * notion-query.mjs), builds an affiliation-first referral scouting plan for each row that
 * lacks the `[referral-scout` sentinel, and writes it back to Notion (Fit notes prepend +
 * conditional Next action). Appends a human-readable section to data/referral-scouting.md.
 *
 * Deterministic, no browsing, no outreach, no Stage change, no file properties.
 * Auth: NOTION_TOKEN. Cap: triage.max_drafts_per_run (default 25).
 *
 * Emits the ROUTINE_CONTRACT block on stdout.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";
import yaml from "js-yaml";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");        // compute + emit contract, write nothing (test/preview)
const TODAY = (argv[0] && !argv[0].startsWith("--")) ? argv[0] : new Date().toISOString().slice(0, 10);
const NOW_ISO = new Date().toISOString();
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("ROUTINE_ABORT: NOTION_TOKEN missing"); process.exit(5); }

const CFG = (() => {
  try { return yaml.load(readFileSync("config/profile.yml", "utf8")) || {}; } catch { return {}; }
})();
const capArg = argv.indexOf("--cap");                        // manual override for backfill/refresh runs
const CAP = (capArg >= 0 && Number(argv[capArg + 1]) > 0)
  ? Number(argv[capArg + 1])
  : ((CFG.triage && CFG.triage.max_drafts_per_run) || 20);

const qi = argv.indexOf("--queue");
const QUEUE_PATH = qi >= 0 && argv[qi + 1] ? argv[qi + 1] : "data/.routine-tmp/scout-queue.json";
const SCOUT_MD = "data/referral-scouting.md";
const SENTINEL = "[referral-scout";

// Self-provision the Stage-3 queue unless an explicit --queue fixture was given.
// Pure-script routine (no upstream LLM Step-1 to build it): query Notion here by
// reusing notion-query.mjs — same NOTION_TOKEN, --json prints a clean JSON array
// of flat rows ({id,title,match_score,country,position,fit_notes,...}).
if (qi < 0) {
  try {
    const out = execFileSync(process.execPath, ["scripts/notion/notion-query.mjs", "--stage", "3. Drafted", "--json"], {
      encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    mkdirSync(dirname(QUEUE_PATH), { recursive: true });
    writeFileSync(QUEUE_PATH, out);
  } catch (e) {
    console.error(`ROUTINE_ABORT: failed to build Stage-3 queue via notion-query.mjs: ${e.message}`);
    process.exit(6);
  }
}

const all = JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
const missing = all.filter(r => !((r.fit_notes || "").includes(SENTINEL)));
const QUEUE_DEPTH = missing.length;
const SKIPPED_ALREADY = all.length - missing.length;
const queue = missing.sort((a, b) => (b.match_score || 0) - (a.match_score || 0)).slice(0, CAP);

// ---- classification helpers -------------------------------------------------
// Stems (consult/recruit/staffing/resourc/talent) catch most agencies; the
// explicit brand names are pure-play tech/data recruiters whose names carry NO
// such stem (would otherwise be misclassified as end-employers and handed a
// bogus alumni/MLSA warm path). Extend this list as new agencies surface.
const STAFFING = /\b(consult|recruit|staffing|staffed|personnel|resourc|talent|hays|harnham|michael\s*page|robert\s*half|randstad|hunter|search\s*partners?|manpower|xcede|nigel\s*frank|la\s*fosse|franklin\s*fitch|austin\s*fraser|huxley|computer\s*futures|signify\s*technology|sthree|oscar\s*technology|trust\s*in\s*soda|salt\s*digital|understanding\s*recruitment)\b/i;
const UNDISCLOSED = /undisclosed|efinancialcareers/i;
const MS_ADJ = /\b(sap|siemens|microsoft)\b/i;
const ENTERPRISE = /\b(sap|siemens|goldman|abn\s*amro|allstate|delivery\s*hero|playstation|sony|booking|dkb|kreditbank|awin|nordex|jcb|aristocrat|flutter|deutsche|allianz|bank|insurance|hochbahn|affirm)\b/i;
const MODERN_STACK = /\b(pigment|aily|trade\s*republic|checkout|trivago)\b/i;

function companyOf(title) {
  return String(title || "").split(/\s+[—–-]\s+/)[0].trim();
}
function luEnc(s) { return encodeURIComponent(s); }
const ALUMNI_UNIVERSITY = (CFG.affiliations && CFG.affiliations.university) || '';
const ALUMNI_PROGRAM = (CFG.affiliations && CFG.affiliations.program) || '';

function alumniUrl(company) {
  if (!ALUMNI_UNIVERSITY) return 'n/a';
  return `https://www.linkedin.com/search/results/people/?keywords=${luEnc(`${company} "${ALUMNI_UNIVERSITY}"`)}`;
}
function mlsaUrl(company) {
  if (!ALUMNI_PROGRAM) return 'n/a';
  return `https://www.linkedin.com/search/results/people/?keywords=${luEnc(`${company} "${ALUMNI_PROGRAM}"`)}`;
}
function rankAngles(company, country) {
  const msAdj = MS_ADJ.test(company);
  const modern = MODERN_STACK.test(company);
  let primary;
  if (msAdj) primary = "mlsa";
  else if (country === "UK") primary = "alumni";
  else if (modern) primary = "community";
  else primary = "alumni";
  const pool = ["alumni", "mlsa", "community"].filter(a => a !== primary);
  return `ex-colleague > ${primary} > ${pool.join(" > ")} > 2nd-degree(Cowork)`;
}
function coldFallback(company) {
  return ENTERPRISE.test(company) ? "recruiter" : "hiring-manager";
}
// warm_path determination (referral-scout.md §2e): conservative — a genuine, plausible
// affiliation overlap, NOT a generic keyword URL. Deterministic signals: MLSA/Microsoft-
// adjacent, modern-data-stack community, or UK (Salford alumni footprint). Staffing and
// everything else → none → the weekly Layer-3 cold scout (bd-referral-scout) picks it up
// via the `no-warm-path` token in Fit notes.
function hasWarmPath(company, country, isStaffing) {
  if (isStaffing) return false;
  return MS_ADJ.test(company) || MODERN_STACK.test(company) || country === "UK";
}

// ---- Notion PATCH with retry ------------------------------------------------
const headers = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};
async function getNextAction(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers });
  if (!res.ok) return "";
  const j = await res.json();
  const na = j.properties && j.properties["Next action"];
  if (!na || na.type !== "rich_text") return "";
  return (na.rich_text || []).map(t => t.plain_text).join("");
}
async function patch(pageId, properties) {
  const delays = [0, 1000, 4000, 30000];
  let lastErr = "";
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH", headers, body: JSON.stringify({ properties }),
    });
    if (res.ok) return true;
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) { lastErr = `${res.status} ${txt.slice(0, 200)}`; continue; }
    throw new Error(`${res.status} ${txt.slice(0, 200)}`);
  }
  throw new Error(`retries exhausted ${lastErr}`);
}

// ---- main -------------------------------------------------------------------
let SCOUTED = 0, END_EMPLOYER = 0, STAFFING_INTERMEDIARY = 0, NO_WARM_PATH = 0, WRITE_FAIL = 0, ERRORS = 0;
const errDetails = [];
const mdRows = [];
let topTarget = "";

for (const row of queue) {
  const company = companyOf(row.title);
  const country = row.country || "";
  const isStaffing = STAFFING.test(company) || UNDISCLOSED.test(company);
  const warm = hasWarmPath(company, country, isStaffing);
  const cold = isStaffing ? "recruiter" : coldFallback(company);
  let block, mdRow;
  try {
    if (isStaffing) STAFFING_INTERMEDIARY++; else END_EMPLOYER++;
    if (!warm) NO_WARM_PATH++;
    if (warm) {
      const ranked = rankAngles(company, country);
      const au = alumniUrl(company);
      const mu = mlsaUrl(company);
      block =
        `[referral-scout ${TODAY}]\n` +
        `Warm path: found\n` +
        `Warm angle (ranked): ${ranked}\n` +
        `LinkedIn (alumni): ${au}\n` +
        `LinkedIn (MLSA):   ${mu}\n` +
        `2nd-degree pull: run from logged-in LinkedIn (Cowork contacto Step 0).\n` +
        `Cold fallback: ${cold}.`;
      mdRow = `- ${company} (${country || "?"}, score ${row.match_score}) — WARM: ${ranked}\n    - alumni: ${au}\n    - MLSA:   ${mu}`;
    } else {
      // warm_path=none — the `no-warm-path` token below is the machine handoff bd-referral-scout selects on.
      const why = isStaffing
        ? "Company type: staffing/intermediary — contact the posting recruiter; ask which end client."
        : "No plausible affiliation overlap (outside the alumni footprint, not MLSA/modern-stack) — handed to the Layer-3 cold scout.";
      block =
        `[referral-scout ${TODAY}]\n` +
        `Warm path: none, cold-only (no-warm-path)\n` +
        `Warm angle (ranked): none\n` +
        `LinkedIn (alumni): n/a\n` +
        `LinkedIn (MLSA):   n/a\n` +
        `2nd-degree pull: run from logged-in LinkedIn (Cowork contacto Step 0).\n` +
        `Cold fallback: ${cold}.\n` +
        why;
      mdRow = `- ${company} (${country || "?"}, score ${row.match_score}) — NO WARM PATH → cold-scout (${cold})`;
    }

    // Fit notes: prepend, preserve prior
    const prior = (row.fit_notes || "").trim();
    const newNotes = (prior ? `${block}\n\n${prior}` : block).slice(0, 1900);
    const properties = { "Fit notes": { rich_text: [{ text: { content: newNotes } }] } };

    // Next action: set only if empty or a generic apply note (never overwrite a scout note)
    const currentNA = DRY ? "" : (await getNextAction(row.id)).trim();
    const generic = currentNA === "" || (/apply/i.test(currentNA) && !/scout/i.test(currentNA));
    if (generic) {
      properties["Next action"] = { rich_text: [{ text: { content: "Scout referral (warm-mutual) before applying — see Fit notes" } }] };
    }

    if (!DRY) await patch(row.id, properties);
    SCOUTED++;
    mdRows.push(mdRow);
    if (!topTarget) {
      const pos = (row.position || [])[0] || "role";
      topTarget = `${company}-${pos.replace(/\s+/g, "-")}(${row.match_score})`;
    }
  } catch (e) {
    WRITE_FAIL++; ERRORS++;
    errDetails.push(`${company}: ${e.message}`);
  }
}

// ---- append to referral-scouting.md (idempotent per-day heading) ------------
if (mdRows.length && !DRY) {
  let md = existsSync(SCOUT_MD) ? readFileSync(SCOUT_MD, "utf8") : "# Referral Scouting Playbook\n";
  const heading = `## Auto-scout ${TODAY}`;
  if (md.includes(heading)) {
    // append rows after the existing heading's block (end of file is fine — heading is dated)
    md = md.replace(/\s*$/, "\n") + mdRows.join("\n") + "\n";
  } else {
    md = md.replace(/\s*$/, "\n") + `\n${heading}\n\n${mdRows.join("\n")}\n`;
  }
  writeFileSync(SCOUT_MD, md);
}

// ---- contract ---------------------------------------------------------------
const out = [
  "--- ROUTINE_CONTRACT ---",
  "ROUTINE: referral-scout",
  `TIMESTAMP_UTC: ${NOW_ISO}`,
  `QUEUE_DEPTH: ${QUEUE_DEPTH}`,
  `SCOUTED: ${SCOUTED}`,
  `END_EMPLOYER: ${END_EMPLOYER}`,
  `STAFFING_INTERMEDIARY: ${STAFFING_INTERMEDIARY}`,
  `NO_WARM_PATH: ${NO_WARM_PATH}`,
  `TOP_TARGET: ${topTarget || "—"}`,
  `NOTION_WRITE_FAILURES: ${WRITE_FAIL}`,
  `SKIPPED_ALREADY_SCOUTED: ${SKIPPED_ALREADY}`,
  `ERRORS: ${ERRORS}`,
  "ERROR_DETAILS: |",
  ...(errDetails.length ? errDetails.map(e => `  ${e}`) : ["  none"]),
  "--- END_ROUTINE_CONTRACT ---",
].join("\n");
console.log(out);
