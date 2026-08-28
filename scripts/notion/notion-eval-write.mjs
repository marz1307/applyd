#!/usr/bin/env node
/**
 * notion-eval-write.mjs — auto-eval routine writer
 *
 * Writes Match score + Recruiter-sim verdict + Fit notes + Agent run ID to a
 * Notion Applications page, then either promotes Stage to "2. Triaged"
 * (PROMOTE) or archives the page (DEMOTE, per triage.trash_below_floor).
 *
 * Deterministic guards (all applied AT THE WRITE, so a prompt slip cannot put
 * a row through that fails a rule the prompt already stated):
 *   --years-required N       demote when JD requires >=5 years (config-driven).
 *   --floor N                override the floor read from config/profile.yml.
 *   --blocks "A=4.2,..."     append `[blocks ...]` sentinel for dimensionCalibration.
 *   --company / --current-company  employer reconciliation + placeholder tag.
 *   --skip-sponsor-check     skip the UK sponsor-licence gate (default: on).
 *
 * Auth: NOTION_TOKEN env var.
 *
 * Usage:
 *   node notion-eval-write.mjs --page <id> --score <0-100> \
 *     --verdict <INVITE|MAYBE|REJECT> --decision <promote|demote|notpursuing> \
 *     --runid <id> --notes "<fit notes text>"
 *
 * Exit 0 on success, non-zero on failure (prints WRITE_ERROR ...).
 */
import process from "node:process";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// scripts/notion/notion-eval-write.mjs -> repo root + sibling scan/ dir.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SPONSOR_CHECK_PATH = join(REPO_ROOT, "scripts", "scan", "sponsor-check.mjs");

const args = process.argv.slice(2);
function arg(n) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; }
function hasFlag(n) { return args.includes(n); }

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("WRITE_ERROR: NOTION_TOKEN not set"); process.exit(5); }

const pageId = arg("--page");
const score = parseInt(arg("--score"), 10);
const verdict = arg("--verdict");
let decision = (arg("--decision") || "").toLowerCase();
const runid = arg("--runid");
let notes = arg("--notes") || "";
const skipSponsor = hasFlag("--skip-sponsor-check");

// Years-required gate. If the JD explicitly requires 5+ years and the caller
// still asked to promote (or demote — leaving the row invisible to the funnel),
// the row is seniority-mismatched. Auto-eval's prose asks for this demotion;
// this is the deterministic guard for when the LLM misses it. The 5-year
// threshold is a common default — override by adjusting the prose gate.
const yearsRequired = arg("--years-required");
if (yearsRequired) {
  const yrs = parseInt(yearsRequired, 10);
  if (Number.isFinite(yrs) && yrs >= 5 && decision !== "notpursuing") {
    const originalDecision = decision;
    let prepended = false;
    if (!/reason:\s*seniority_mismatch/i.test(notes)) {
      const today = new Date().toISOString().slice(0, 10);
      const prefix = `[demoted ${today}] reason: seniority_mismatch | years_gate: JD requires ${yrs}+ years`;
      notes = notes ? `${prefix}\n\n${notes}` : prefix;
      prepended = true;
    }
    decision = "notpursuing";
    console.error(`YEARS_GATE: JD requires ${yrs}+ years -> overriding decision '${originalDecision}' -> 'notpursuing'${prepended ? " (seniority_mismatch reason prepended)" : " (existing seniority_mismatch tag kept)"}`);
  }
}

// Override floor. Auto-eval may promote a sub-floor row when the recruiter-sim
// says INVITE — that override is real and worth keeping. But an UNBOUNDED
// override can put rows nine or eleven points under the floor into "2. Triaged"
// unnoticed. Same deterministic-guard pattern as the years gate: auto-eval's
// prose states the bound, and this re-checks it at the write. Reads config so
// the two cannot drift.
function readNumericConfig(key, fallback) {
  try {
    const p = join(REPO_ROOT, "config", "profile.yml");
    if (!existsSync(p)) return fallback;
    const y = readFileSync(p, "utf8");
    // triage:\n  ${key}: N  OR bare top-level ${key}: N
    const m = new RegExp(`^\\s*${key}:\\s*(\\d+)`, "m").exec(y);
    if (m) return parseInt(m[1], 10);
  } catch { /* fall through */ }
  return fallback;
}
const CLI_FLOOR = parseInt(arg("--floor"), 10);
const SCORE_FLOOR = Number.isFinite(CLI_FLOOR) ? CLI_FLOOR : readNumericConfig("score_floor", 80);
const OVERRIDE_FLOOR = readNumericConfig("override_floor", 78);
// A sub-floor promote must clear BOTH tests: the override bound, and a clear
// INVITE. MAYBE never overrides — a hedge is not a recommendation, and a row
// the sim will not commit to is not one to spend a draft on.
if (decision === "promote" && Number.isFinite(score) && score < SCORE_FLOOR) {
  const belowBound = score < OVERRIDE_FLOOR;
  const notClearInvite = String(verdict || "").toUpperCase() !== "INVITE";
  if (belowBound || notClearInvite) {
    const originalDecision = decision;
    const why = belowBound
      ? `score ${score} is below the override floor of ${OVERRIDE_FLOOR}`
      : `verdict is ${verdict}, and only a clear INVITE overrides the floor`;
    if (!/reason:\s*low_score/i.test(notes)) {
      const today = new Date().toISOString().slice(0, 10);
      const prefix = `[demoted ${today}] reason: low_score | override refused: ${why}`;
      notes = notes ? `${prefix}\n\n${notes}` : prefix;
    }
    decision = "notpursuing";
    console.error(`OVERRIDE_REFUSED: ${why} -> decision '${originalDecision}' -> 'notpursuing'`);
  }
}

// Per-dimension A-G scores, e.g. --blocks "A=4.2,B=3.8,C=4.0,D=3.5,E=4.1,F=3.9,G=5".
// Appended to Fit notes as the machine-parseable sentinel line
// `[blocks A=4.2 B=3.8 ...]` — metrics-core.parseBlockScores() reads it back
// for dimensionCalibration (which A-G block actually predicts a response).
// Optional and validated leniently: bad pairs are dropped, an empty result
// skips the sentinel rather than failing the write.
const blocksArg = arg("--blocks");
if (blocksArg) {
  const pairs = blocksArg.split(/[,\s]+/).map((p) => {
    const [k, v] = p.split("=");
    const key = (k || "").trim().toUpperCase();
    const n = parseFloat(v);
    return /^[A-G]$/.test(key) && Number.isFinite(n) ? `${key}=${n}` : null;
  }).filter(Boolean);
  if (pairs.length) notes = `${notes}\n[blocks ${pairs.join(" ")}]`.trim();
}

if (!pageId || Number.isNaN(score) || !verdict || !decision) {
  console.error("WRITE_ERROR: missing required arg (--page --score --verdict --decision)");
  process.exit(2);
}
if (!["promote", "demote", "notpursuing"].includes(decision)) {
  console.error("WRITE_ERROR: --decision must be promote|demote|notpursuing"); process.exit(2);
}
if (!["INVITE", "MAYBE", "REJECT"].includes(verdict)) {
  console.error("WRITE_ERROR: --verdict must be INVITE|MAYBE|REJECT"); process.exit(2);
}

// Lines downstream parsers key off, which must survive truncation wherever
// they sit in the note. `[blocks ...]` feeds metrics-core.parseBlockScores();
// the two employer lines are the audit trail the cross-stage collision filter
// reads. Matching per-line instead of end-anchored makes the order irrelevant
// (a chopped sentinel silently drops the row from dimension calibration).
const PROTECTED_LINE_RE = /^\[(?:blocks |auto-eval employer-fix\]|employer-unresolved\])/;

function truncateKeepingSentinel(text, max) {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const isProtected = (l) => PROTECTED_LINE_RE.test(l.trim());
  const protectedLines = lines.filter(isProtected);
  if (!protectedLines.length) return text.slice(0, max);
  const tail = `\n${protectedLines.join("\n")}`;
  if (tail.length >= max) return tail.slice(0, max);
  const prose = lines.filter((l) => !isProtected(l)).join("\n");
  return `${prose.slice(0, max - tail.length).trimEnd()}${tail}`;
}

const headers = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

// Employer reconciliation, enforced at the write. If the JD's JSON-LD
// `hiringOrganization` was resolved to a real name (--company), PATCH it into
// the Notion title (a portal-placeholder like "Undisclosed (Indeed)" then
// stops leaking downstream). If it did NOT resolve, TAG the row so the
// cross-stage collision filter can see the name is unusable rather than
// merely unfamiliar — a placeholder-named row cannot be deduplicated against
// employers already in flight.
const PLACEHOLDER_COMPANY = /^(undisclosed|confidential|unknown|not disclosed|n\/?a)\b|\b(xing|linkedin|indeed|stepstone|efinancialcareers|wttj|careerbee) posting\b/i;
const resolvedCompany = (arg("--company") || "").trim();
const currentCompany = (arg("--current-company") || "").trim();
const UNRESOLVED_TAG = "[employer-unresolved]";
if (resolvedCompany) {
  if (!/\[auto-eval employer-fix\]/.test(notes) && currentCompany && currentCompany !== resolvedCompany) {
    notes = `${notes}\n[auto-eval employer-fix] Company corrected from "${currentCompany}" to "${resolvedCompany}" via JSON-LD hiringOrganization.`.trim();
  }
  notes = notes.split(UNRESOLVED_TAG).join("").replace(/\n{3,}/g, "\n\n").trim();
} else if (currentCompany && PLACEHOLDER_COMPANY.test(currentCompany) && !notes.includes(UNRESOLVED_TAG)) {
  notes = `${notes}\n${UNRESOLVED_TAG} Company is still "${currentCompany}"; JSON-LD hiringOrganization did not resolve. This row cannot be deduplicated against employers already in flight.`.trim();
  console.error(`EMPLOYER_UNRESOLVED: "${currentCompany}" — row tagged, downstream collision filter will hold it`);
}

// UK sponsor-licence gate. Deterministic guard, does NOT change the decision:
// it stamps a tag on UK rows so ranking and human review can see whether the
// employer is a licensed sponsor. Auto-eval.md is meant to run sponsor-check
// on every UK row; when it forgets, the row leaves untagged. Skip with
// --skip-sponsor-check for offline / non-UK runs.
const SPONSOR_TAG_RE = /uk-sponsor-licensed|uk-sponsor-maybe|uk-2yr-ceiling/;
const UK_COUNTRY_RE = /^(uk|gb|united kingdom|great britain|england|scotland|wales|northern ireland)$/i;

async function enforceSponsorTag() {
  if (skipSponsor) return;
  if (SPONSOR_TAG_RE.test(notes)) return;               // auto-eval already tagged it
  if (!existsSync(SPONSOR_CHECK_PATH)) return;          // sponsor-check not present
  let company = resolvedCompany || currentCompany;
  let country = "";
  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers });
    if (!res.ok) { console.error(`SPONSOR_GATE: page read ${res.status} — skipped, row left untagged`); return; }
    const page = await res.json();
    country = page.properties?.Country?.select?.name || "";
    if (!company) company = (page.properties?.Company?.title || []).map((t) => t.plain_text).join("");
  } catch (e) {
    console.error(`SPONSOR_GATE: page read error (${String(e.message || e).slice(0, 60)}) — skipped`); return;
  }
  if (!UK_COUNTRY_RE.test(String(country).trim())) return;   // non-UK: gate does not apply
  if (!company || PLACEHOLDER_COMPANY.test(company)) {
    console.error(`SPONSOR_GATE: company unusable ("${company}") — cannot query the register`); return;
  }
  let match = "", bestName = "";
  try {
    const out = execFileSync(process.execPath,
      [SPONSOR_CHECK_PATH, "--company", company, "--json"],
      { encoding: "utf8", timeout: 20000 });
    const j = JSON.parse(out);
    match = String(j.match || "").toLowerCase();
    bestName = j.best?.name || "";
  } catch (e) {
    console.error(`SPONSOR_GATE: sponsor-check failed (${String(e.message || e).slice(0, 60)}) — row left untagged`); return;
  }
  // Match->tag mapping done here from `match`, not from any recommendedTag
  // field: a medium hit is a FUZZY name match and stamping it "licensed"
  // would manufacture false confidence in exactly the case the maybe-tag
  // exists to flag for a human. High only -> licensed.
  let tag, suffix = "";
  if (match === "high") tag = "uk-sponsor-licensed";
  else if (match === "medium" || match === "low") {
    tag = "uk-sponsor-maybe";
    suffix = bestName ? ` (${match} ${bestName})` : ` (${match})`;
  } else if (match === "none") tag = "uk-2yr-ceiling";
  else { console.error(`SPONSOR_GATE: unrecognised match "${match}" — row left untagged`); return; }
  const today = new Date().toISOString().slice(0, 10);
  notes = `${tag}${suffix} [sponsor-gate ${today}]\n\n${notes}`.trim();
  console.error(`SPONSOR_GATE: "${company}" match=${match} -> prepended "${tag}" (decision unchanged)`);
}
await enforceSponsorTag();

const properties = {
  "Match score": { number: score },
  "Recruiter-sim verdict": { select: { name: verdict } },
  // Truncate the PROSE, never the trailing [blocks ...] sentinel — a chopped
  // sentinel silently drops the row from dimension calibration.
  "Fit notes": { rich_text: [{ text: { content: truncateKeepingSentinel(notes, 1900) } }] },
  "Agent run ID": { rich_text: [{ text: { content: runid || "auto-eval" } }] },
};
// "Company" is the title property of the Applications DB.
if (resolvedCompany) {
  properties["Company"] = { title: [{ text: { content: resolvedCompany.slice(0, 200) } }] };
}
if (decision === "promote") {
  properties["Stage"] = { select: { name: "2. Triaged" } };
} else if (decision === "notpursuing") {
  properties["Stage"] = { select: { name: "Not pursuing" } };
}

const body = { properties };
if (decision === "demote") body.archived = true;

let lastErr = "";
async function patchWithRetry() {
  const delays = [0, 1000, 4000, 16000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise(r => setTimeout(r, delays[i]));
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH", headers, body: JSON.stringify(body),
    });
    if (res.ok) return true;
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) { lastErr = `${res.status} ${txt}`; continue; }
    console.error(`WRITE_ERROR: ${res.status} ${txt}`); process.exit(1);
  }
  console.error(`WRITE_ERROR: retries exhausted ${lastErr || ""}`); process.exit(1);
}
await patchWithRetry();
console.log(`WRITE_OK page=${pageId} score=${score} verdict=${verdict} decision=${decision}`);
