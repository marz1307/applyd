#!/usr/bin/env node
/**
 * cv-qa.mjs — LLM-powered post-draft QA agent (claude-sonnet-4-6 via Anthropic API)
 *
 * Usage:
 *   node cv/cv-qa.mjs \
 *     --cv    output/cv-drafts/APP-2448-munich-re/cv_da_en.html \
 *     --cl    output/cover-letters/APP-2448-munich-re-2026-06-14.md \
 *     --jd    "full JD text" \
 *     --company "Munich Re" \
 *     --role-title "BI Developer" \
 *     [--dry-run]      # evaluate but do NOT patch or write files
 *     [--json]         # emit JSON result to stdout (default: human-readable)
 *     [--max-regen N]  # max CL regeneration attempts before giving up (default: 2; 0 = disabled)
 *
 * Requires: ANTHROPIC_API_KEY in environment (set via $env:ANTHROPIC_API_KEY or careerops.env)
 *
 * Exit codes:
 *   0  — QA passed; no patches needed
 *   2  — QA flagged issues but auto-patched successfully (includes post-regen pass)
 *   3  — QA flagged issues that require manual intervention (after all regen attempts exhausted)
 *   1  — Script error (API failure, missing files, etc.)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const ARGS = parseArgs(process.argv);

const CV_PATH    = ARGS['cv']         ? resolve(ARGS['cv'])         : null;
const CL_PATH    = ARGS['cl']         ? resolve(ARGS['cl'])         : null;
const JD_TEXT    = ARGS['jd']         || '';
const COMPANY    = ARGS['company']    || 'Unknown Company';
const ROLE_TITLE = ARGS['role-title'] || '';
const DRY_RUN    = !!ARGS['dry-run'];
const JSON_MODE  = !!ARGS['json'];
const MAX_REGEN  = parseInt(ARGS['max-regen'] ?? '2', 10);

if (!CV_PATH || !CL_PATH || !JD_TEXT) {
  console.error('Usage: node cv/cv-qa.mjs --cv <path> --cl <path> --jd "<text>" --company "<name>" --role-title "<title>"');
  process.exit(1);
}
if (!existsSync(CV_PATH)) { console.error(`CV not found: ${CV_PATH}`); process.exit(1); }
if (!existsSync(CL_PATH)) { console.error(`Cover letter not found: ${CL_PATH}`); process.exit(1); }

// SUBSCRIPTION-ONLY BY DEFAULT (never bill metered API credits). The Haiku API
// path is OPT-IN via CAREEROPS_QA_USE_API=1. Unless that flag is set, cv-qa
// ignores ANTHROPIC_API_KEY entirely and QA runs on the subscription `claude -p`
// (no API cost) — even when a key is present in the env (e.g. auto-draft under
// claude -p strips it anyway; reprocess-all-qa passes it through but it is now
// ignored). Either way cv-qa works.
const ALLOW_API = process.env.CAREEROPS_QA_USE_API === '1';
const API_KEY = ALLOW_API ? (process.env.ANTHROPIC_API_KEY || null) : null;
if (!ALLOW_API && process.env.ANTHROPIC_API_KEY) {
  console.error('[cv-qa] Subscription-only mode (default): ignoring ANTHROPIC_API_KEY; QA runs on the Opus 4.8 subscription (no API cost). Set CAREEROPS_QA_USE_API=1 to opt into the metered Haiku API.');
} else if (!API_KEY) {
  console.error('[cv-qa] No API key — QA on the Opus 4.8 subscription fallback (no API cost).');
}

// ── QA model + cost guard ────────────────────────────────────────────────────
// cv-qa is the ONLY component that bills the metered Anthropic API. It runs on
// Haiku by design (cheapest). The preflight below HARD-FAILS if the model is
// ever set to Opus — Opus on the API drained the balance once (2026-06-17) and
// must never be the QA model. Sonnet is permitted (opt-in for send-quality QA);
// Opus is not.
const QA_MODEL = 'claude-haiku-4-5-20251001';
if (/opus/i.test(QA_MODEL)) {
  console.error(`[cv-qa] COST GUARD: QA_MODEL="${QA_MODEL}" is an Opus model. cv-qa must run on Haiku (or Sonnet). Aborting to protect API credits.`);
  process.exit(1);
}

// ── Subscription fallback (Opus 4.8 via Claude Max) ──────────────────────────
// When the metered Haiku API fails (credit balance depleted, 5xx, network),
// QA falls back to `claude -p` on Opus 4.8 — billed to the Claude Max
// SUBSCRIPTION, not API credits. The child env has ANTHROPIC_API_KEY stripped
// so claude.exe authenticates via its OAuth subscription login (NOT the API
// key — that would bill Opus-tier credits, the exact failure we're avoiding).
// This makes cv-qa resilient to credit exhaustion: it degrades to the free
// subscription rather than hard-failing the row.
const CLAUDE_EXE = process.env.CLAUDE_EXE || 'claude';
const FALLBACK_MODEL = 'claude-opus-4-8';

// ---------------------------------------------------------------------------
// Load files
// ---------------------------------------------------------------------------

// Load the candidate profile: prefer _profile.md (user layer), fall back to _shared.md
const PROFILE_PATH = existsSync(resolve(REPO_ROOT, 'modes', '_profile.md'))
  ? resolve(REPO_ROOT, 'modes', '_profile.md')
  : resolve(REPO_ROOT, 'modes', '_shared.md');
if (!existsSync(PROFILE_PATH)) {
  console.error(`modes/_profile.md (or _shared.md) not found — run onboarding first`);
  process.exit(1);
}

function stripHtml(html) {
  let out = '', inTag = false, skip = false;
  const lc = html.toLowerCase();
  for (let i = 0; i < html.length; i++) {
    if (!skip && lc.startsWith('<style', i)) skip = true;
    if (!skip && lc.startsWith('<script', i)) skip = true;
    if (skip && lc.startsWith('</style>', i)) { skip = false; i += 7; continue; }
    if (skip && lc.startsWith('</script>', i)) { skip = false; i += 8; continue; }
    if (skip) continue;
    if (html[i] === '<') { inTag = true; out += ' '; continue; }
    if (html[i] === '>') { inTag = false; continue; }
    if (!inTag) out += html[i];
  }
  const entities = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  out = out.replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, m => entities[m] || m);
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const profileMd = readFileSync(PROFILE_PATH, 'utf8');
const cvPlain   = stripHtml(readFileSync(CV_PATH, 'utf8'));
let   clMd      = readFileSync(CL_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function logMsg(msg) {
  if (!JSON_MODE) console.log(msg);
}

function parseJson(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  return JSON.parse(match[0]);
}

// ---------------------------------------------------------------------------
// QA system prompt (role classification + recruiter persona + 4 checks)
// ---------------------------------------------------------------------------

const QA_SYSTEM = `${profileMd}

---

## Your Role in This Evaluation

You are the **final boss recruiter** for ${COMPANY}. Your job is to determine, with
clinical honesty, whether this CV and cover letter will earn an interview at ${COMPANY}
for the role of "${ROLE_TITLE || 'the advertised role'}".

You have been given the complete candidate profile above as your ground truth. You know
exactly what this candidate has done, what is NDA-safe to say, and what the intentional
framing choices are. Your job is NOT to second-guess intentional choices — it is to catch
genuine misalignment, NDA violations, cover-letter weakness, and AI-voice pollution.

### Step 0: Classify the role (do this FIRST, before any other step)

Companies name roles arbitrarily. The JD title is a hint, not a classification.
Read the full JD and classify the role from its content using the methodology in
Section 7 of the candidate profile (Role Classification and Multi-Perspective Framing).

Determine:
- What the role **actually requires** the person to do day-to-day
- Which archetype it maps to: AE, DE, DS, BI, DA, or a hybrid (e.g., AE+DS)
- Which framing from Section 7 Step 3 to apply to this evaluation
- Whether the current CV and cover letter are using the correct framing

This classification drives every subsequent evaluation decision. If the CV is using
the wrong framing for the actual role (e.g., the role is clearly DS but the CV leads
with the AE framing), flag it as a CRITICAL issue requiring REGENERATE.

### Step 1: Infer recruiter persona
Read the JD tone, company type, sector, and seniority signals. Determine:
- formality: "high" | "medium" | "low"
- primary_lens: "business-outcomes" | "technical-depth" | "balanced"
- scrutiny: "strict" | "standard" | "relaxed"
- inferred_from: [list of signals you used]

Examples:
- Munich Re (reinsurance, formal JD, enterprise) → high / business-outcomes / strict
- Booking.com analytics → low / technical-depth / standard
- DACH Mittelstand → high / balanced / standard
- Series B fintech → medium / technical-depth / relaxed

### Step 2: Run four checks

**Check A — Role-title alignment**
Does the CV tagline/subhead match the role title as advertised? A "BI Developer" JD must
not receive a CV headlined "Data Analyst". Check: (a) the h1/header tagline in the HTML,
(b) the cover letter's stated role name.

**Check B — Employer NDA compliance**
Using the NDA rules section of the candidate profile (if present), scan every bullet
referencing NDA-covered employers in the CV and cover letter. Flag any sentence that:
- Names the employer's end-customers by name
- States the employer's own business metrics (revenue, customer counts, growth rates)
- Names specific internal tables, columns, or schema structures
- Uses internal product feature names beyond what the profile marks as SAFE
If the content uses ONLY items from the SAFE list (or no NDA section exists), mark as PASS.

**Check C — Cover letter quality**
First determine the letter's market and language by reading the JD language and the
company's country. Record this in the "letter_context" field. Then apply the correct
track from the candidate profile:
- JD in German OR company in DE / AT / CH → Section **8B (Anschreiben standards)**
- All other markets → Section **8A (English CL standards)**

The quality bar is identical on both tracks. A letter that passes the structural checks
but reads generically — as if it could apply to any company in any sector — still fails.

For ALL letters check:
1. Does the opener hook immediately, without starting with "I" or referencing the application?
2. Is the role title named exactly as advertised in the JD (not a synonym)?
3. Zero banned AI-vocabulary present (from the relevant Section 8A or 8B banned list)?
4. Does paragraph 2 contain a specific number AND state its consequence for this company?
5. Word count within range (EN: 180–280 / DE: 250–350 Wörter)?
6. Does it close with concrete availability AND salary expectation in the JD's currency?
7. Does at least one sentence prove the candidate understood what is specific about this
   role at this company (not generic company praise)?
8. Does paragraph 3 contain an industry/domain-specific connection to this company's
   sector that could NOT appear unchanged in a letter to a different industry?

For Anschreiben (Section 8B) additionally check:
9. Sie-form throughout (or du-form if the JD uses du)?
10. No bullets or numbered lists anywhere?
11. No anglicisms in prose beyond industry-standard terms present in the JD?
12. Gehaltsvorstellung stated as Jahresgehalt range in EUR?
13. Zero em/en dashes in body text?

**Check D — Above-the-fold signal strength**
What are the 3 most important requirements in this JD? Are those requirements evidenced
in the first 40% of the CV (profile paragraph + first experience block)? If the JD leads
with "dbt expertise required" and dbt doesn't appear until the second page, that's a flag.
Use the non-rejectable threshold from Section 7 Step 4 as the pass bar for this check.

### Step 3: Determine if auto-patchable
A flag is AUTO_PATCHABLE if it can be fixed with a single targeted text replacement in
the HTML or MD (e.g., fix a tagline, change a role title in the CL, remove one banned
word). It is NOT auto-patchable if it requires structural rewriting, full section
reorganisation, or a regeneration of the CV variant.

### Step 4: Return structured JSON only
Return your evaluation as a single JSON object matching this exact schema — no prose
before or after the JSON:

{
  "role_classification": {
    "jd_title": "exact title from the JD",
    "classified_as": "AE | DE | DS | BI | DA | AE+DS | etc",
    "reasoning": "One sentence: what signals in the JD drove this classification",
    "framing_applied": "which Section 7 framing was used, e.g. DS primary + AE secondary",
    "non_standard_title": true | false,
    "framing_mismatch": true | false,
    "framing_mismatch_detail": "null if no mismatch; otherwise what is wrong and severity"
  },
  "letter_context": {
    "market": "dach | global",
    "letter_language": "de | en",
    "letter_type": "anschreiben | english-cl",
    "detected_from": "jd_language | company_country | jd_signals"
  },
  "recruiter_persona": {
    "type": "enterprise-financial | scale-up | dach-mittelstand | uk-tech | consulting | other",
    "formality": "high | medium | low",
    "primary_lens": "business-outcomes | technical-depth | balanced",
    "scrutiny": "strict | standard | relaxed",
    "inferred_from": ["signal1", "signal2"]
  },
  "alignment_score": 0-100,
  "interview_likelihood": "HIGH | MEDIUM | LOW",
  "checks": {
    "role_title": "PASS | FAIL",
    "nda_compliance": "PASS | FAIL",
    "cover_letter": "PASS | FAIL | PARTIAL",
    "above_the_fold": "PASS | FAIL | PARTIAL"
  },
  "flags": [
    {
      "id": "unique_short_id",
      "check": "role_title | nda_compliance | cover_letter | above_the_fold | framing",
      "severity": "CRITICAL | MAJOR | MINOR",
      "location": "cv_tagline | cv_employer_bullet_N | cl_opener | cl_para_2 | cl_word_count | cv_framing | etc",
      "description": "What is wrong and why it matters for THIS recruiter persona at THIS company",
      "auto_patchable": true | false,
      "patch": {
        "file": "cv | cl",
        "old": "exact string to find (verbatim, for string replace)",
        "new": "replacement string"
      }
    }
  ],
  "cover_letter_word_count": 0,
  "cover_letter_verdict": "STRONG | ACCEPTABLE | WEAK | CRITICAL_FAIL",
  "cover_letter_critique": "One paragraph of specific, honest critique. What works, what fails, what would a ${COMPANY} recruiter think after reading sentence 1?",
  "overall_verdict": "PASS | PATCH_AND_PASS | REGENERATE",
  "patch_count": 0,
  "auto_patchable_count": 0
}`;

// ---------------------------------------------------------------------------
// User message builder (rebuilt after each regen with fresh CL content)
// ---------------------------------------------------------------------------

function buildUserMessage(cv, cl) {
  return `## Job Description

${JD_TEXT}

---

## CV (plain text)

\`\`\`
${cv}
\`\`\`

---

## Cover Letter (Markdown source)

\`\`\`markdown
${cl}
\`\`\`

Evaluate the above CV and cover letter against the JD for the role of "${ROLE_TITLE}" at ${COMPANY}.
Apply all checks. Return only the JSON object as described in your instructions.`;
}

// ---------------------------------------------------------------------------
// CL regeneration system prompt
// ---------------------------------------------------------------------------

function getLeadProofPoint(classification) {
  const cls = String(classification || '').toUpperCase();
  if (cls.includes('DS'))
    return 'Lead with ML metrics: C-index 0.9449 (survival), AUC 0.950 vs 0.888 baseline (XGBoost), DR-Learner causal correction of reactive-assignment selection bias. One number + one consequence.';
  if (cls.includes('AE'))
    return 'Lead with dbt/Dagster depth: 40+ dbt models, ~95% compute cut, 123 dbt tests + 82 pytest, canonical customer ID. One number + one consequence.';
  if (cls.includes('DE'))
    return 'Lead with pipeline scale: 1M+ records ingested, JSONB + GIN raw layer, idempotent bootstrap, cursor-safe restarts under 5 minutes. One number + one consequence.';
  if (cls.includes('BI'))
    return 'Lead with stakeholder impact: 7-day reporting cycle cut to live, 12+ shipped models, Power BI replacing manual spreadsheets, 95% compute cut meaning marts that never lie. One number + one consequence.';
  if (cls.includes('DA'))
    return 'Lead with outcome metrics: lead response -30%, conversion +15%, data errors -40%, or FMBN dataset accuracy +40% in 6 months. One number + one consequence.';
  return 'Lead with the single most quantified proof point from the candidate profile that maps directly to the JD\'s primary requirement.';
}

function buildRegenSystem(qaResult) {
  const cls = qaResult.role_classification || {};
  const clFlags = (qaResult.flags || []).filter(f => f.check === 'cover_letter' && !f.auto_patchable);

  const isDACH = qaResult.letter_context?.market === 'dach' ||
                 qaResult.recruiter_persona?.type === 'dach-mittelstand';
  const wordCount   = isDACH ? '250–350 Wörter' : '180–280 words';
  const trackRef    = isDACH ? 'Section 8B (Anschreiben Standards)' : 'Section 8A (English CL Standards)';
  const letterLabel = isDACH ? 'Anschreiben (German)' : 'English cover letter';

  const structureBlock = isDACH ? `
### Required structure — Anschreiben (Fließtext, 4 Absätze, keine Aufzählungszeichen)

**Absatz 1 — Einstieg (2–3 Sätze):**
Open with a specific quantified result OR frame the company's actual challenge from the JD.
Do NOT open with "Hiermit bewerbe ich mich..." or "Ich bin sehr interessiert...".
"Ich" must not be the first word. The problem or result must be named in sentence 1.
For the classified role (${cls.classified_as || 'see JD'}):
${getLeadProofPoint(cls.classified_as)}

**Absatz 2 — Primärer Beweis (3–4 Sätze):**
Single most relevant proof point with a number and a consequence. Use formal Sie-register
throughout: "In meiner Tätigkeit bei..." / "Im Rahmen meiner Dissertation...".
Avoid anglicisms in prose: "implementiert" not "deployed"; use German technical equivalents
unless the JD itself uses the English term. The consequence must explain why this
matters for this specific role at ${COMPANY}.

**Absatz 3 — Sekundärer Beweis + Unternehmensfit (2–3 Sätze):**
Second proof point for the JD's secondary requirements. Must include one specific fact
about ${COMPANY} drawn from the JD — name the actual product, challenge, or team. Generic
admiration ("Ihr Unternehmen ist bekannt für...") fails this paragraph immediately.
This paragraph must be specific enough that it could NOT appear in a letter to a different
company in a different sector.

**Absatz 4 — Abschluss (2–3 Sätze):**
State: (a) "ab Juli 2026" as Verfügbarkeit, (b) Gehaltsvorstellung as Jahresgehalt range
in EUR: "EUR XX.000–XX.000 brutto jährlich", (c) "Ich freue mich auf ein persönliches
Gespräch" or equivalent. Never translate "I look forward to hearing from you" literally.

### Non-negotiable rules (every one blocks a pass)

1. Wortanzahl: ${wordCount} — Zähle vor dem Abschicken.
2. Stellenbezeichnung muss exakt lauten: **${ROLE_TITLE}**
3. Sie-form throughout — unless the JD itself uses "du" (match the JD's register)
4. Fließtext only: no bullets, no numbered lists anywhere
5. "Ich" darf nicht das erste Wort sein
6. Keine Anglizismen in Fließtext beyond industry-standard terms present in the JD
7. Gehaltsvorstellung als Jahresgehalt-Spanne in EUR (e.g. "EUR 55.000–65.000 brutto jährlich")
8. Kein KI-Vokabular: "leistungsstarke Lösungen", "fundierte Kenntnisse" als Füllwörter,
   "innovative Ansätze", "hochmotivierten", "Synergien", "ganzheitlich", "zielorientiert"
9. Jede Behauptung muss durch Zahl, Projektname oder Tool belegt sein
10. Not öffnen mit "Hiermit bewerbe ich mich...", "Ich bin sehr interessiert...",
    or any application-reference in sentence 1
` : `
### Required structure — English cover letter (4 paragraphs)

**Paragraph 1 — Hook (2–3 sentences):**
Open with a specific result OR frame the problem this company is trying to solve.
Do NOT start with "I". Do NOT reference the application ("I am writing to apply for").
The recruiter must want to read the next sentence. The archetype must be audible from
sentence 1: AE opener = engineering discipline; DS opener = model defensibility; DE opener
= pipeline reliability. For the classified role (${cls.classified_as || 'see JD'}):
${getLeadProofPoint(cls.classified_as)}

**Paragraph 2 — Primary evidence (2–4 sentences):**
One proof point with a NUMBER and a CONSEQUENCE. The number must come from the candidate
profile (Section 2 or 3). The consequence must explain why it matters for THIS role at
${COMPANY}: not just "95% compute cut" but "95% compute cut that made Customer Success
dashboards trustworthy for the first time." Every sentence must advance the claim.

**Paragraph 3 — Secondary evidence + company domain anchor (2–3 sentences):**
Second proof point for the JD's secondary requirements. Must include one industry/domain
connection specific to ${COMPANY}'s sector, drawn from the JD: for insurance, reference
risk data or audit-defensibility; for SaaS, reference customer intelligence or churn;
for fintech, reference transaction data or regulatory modelling; for healthcare, reference
data integrity or clinical reporting accuracy. Generic company admiration fails.
Test: could this paragraph appear unchanged in a letter to a company in a different industry?
If yes, rewrite it.

**Paragraph 4 — Close (2–3 sentences):**
State: (a) availability from July 2026, (b) salary expectation in the JD's currency and
range format (e.g. "£55,000–£65,000" or "EUR 55.000–65.000"), (c) a direct forward-
looking close. Not "I look forward to hearing from you" — use active framing.

### Non-negotiable rules (every one blocks a pass)

1. Word count: ${wordCount} — count before finishing.
2. Role title must appear exactly as: **${ROLE_TITLE}** — not a synonym or paraphrase.
3. Zero banned vocabulary: leverage (verb), synergize, delve, align with, crucial,
   pivotal, key role, transformative, showcase, boasts, ensure, foster, garner,
   testament, underscore, vibrant, landscape, passionate about, results-driven,
   thrilled, excited to, I would love to. One occurrence fails.
4. Zero em dashes (—) or en dashes (–) anywhere in the body text.
5. "I" must not be the first word of the letter.
6. Every claim needs a number, project name, or named tool as evidence.
7. No "I am excited", "I am writing to apply", or any application-reference opener.
8. Paragraph 3 must be specific to ${COMPANY}'s industry — it cannot appear unchanged
   in a letter to a company in a different sector.
`;

  return `${profileMd}

---

## Your task: Rewrite the ${letterLabel}

The previous draft failed QA. Your job is to produce a new ${letterLabel} that passes
ALL criteria in ${trackRef} of the candidate profile above.

### What failed

Verdict: **${qaResult.cover_letter_verdict}**
Word count: ${qaResult.cover_letter_word_count} (target: ${wordCount})
Critique: ${qaResult.cover_letter_critique}

Specific failures (must fix every one):
${clFlags.length > 0
  ? clFlags.map(f => `- [${f.severity}] ${f.location}: ${f.description}`).join('\n')
  : '- General quality below bar — see critique above.'}

### Role context

- JD title (verbatim, must appear in letter): **${ROLE_TITLE}**
- Company: **${COMPANY}**
- Letter type: **${letterLabel}**
- Role classified as: **${cls.classified_as || 'see JD'}**
- Framing to apply: ${cls.framing_applied || 'see Section 7 of candidate profile'}
${structureBlock}
### Output format

Return ONLY the ${letterLabel} text${isDACH ? ' in German markdown' : ' in markdown'}.
No JSON. No preamble. No word-count annotation. No explanation. The letter starts on
the first line of your response.`;
}

function buildRegenUserMessage(failedCl) {
  return `## Job Description

${JD_TEXT}

---

## Failed Cover Letter (the one that did not pass QA)

\`\`\`markdown
${failedCl}
\`\`\`

Write the improved cover letter for the role of "${ROLE_TITLE}" at ${COMPANY}.
Start immediately with the letter — no preamble.`;
}

// ---------------------------------------------------------------------------
// Anthropic API call
// ---------------------------------------------------------------------------

// Try the metered Haiku API first; fall back to the Opus 4.8 subscription on
// ANY failure (credit depletion, 5xx, network, truncation, bad shape).
async function callClaude(systemPrompt, userMessage) {
  // No key → skip the API entirely, QA on the subscription (the auto-draft case).
  if (!API_KEY) {
    return callClaudeSubscription(systemPrompt, userMessage);
  }
  try {
    return await callClaudeApi(systemPrompt, userMessage);
  } catch (err) {
    console.error(`[cv-qa] Haiku API failed (${err.message.slice(0, 120)}) — falling back to Opus 4.8 on Claude Max subscription...`);
    return callClaudeSubscription(systemPrompt, userMessage);
  }
}

// Fallback: Opus 4.8 via `claude -p` on the Claude Max subscription.
// ANTHROPIC_API_KEY is stripped from the child env so claude.exe uses its
// OAuth subscription login (free), never the metered API.
function callClaudeSubscription(systemPrompt, userMessage) {
  const prompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;

  const result = spawnSync(
    CLAUDE_EXE,
    ['-p', '--model', FALLBACK_MODEL, '--output-format', 'text', '--allowedTools', ''],
    { input: prompt, encoding: 'utf8', timeout: 360000, maxBuffer: 20 * 1024 * 1024, env: childEnv },
  );

  if (result.error) {
    throw new Error(`Subscription fallback (claude -p) failed to launch: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Subscription fallback (claude -p) exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
  }
  const text = (result.stdout || '').trim();
  if (!text) {
    throw new Error('Subscription fallback (claude -p) returned empty output');
  }
  console.error(`[cv-qa] usage: subscription Opus 4.8 (Claude Max, no API cost)`);
  return text;
}

async function callClaudeApi(systemPrompt, userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: QA_MODEL,
      max_tokens: 8192,
      // Prompt caching: the system prompt (candidate profile + QA rules) is
      // byte-identical across every row, so cache it. The first call pays a
      // 1.25x write; every subsequent call within the 5-min TTL reads it at
      // ~0.1x instead of full input price. Per-row data (JD/CV/CL) stays in
      // `messages`, after the cached prefix, so it never invalidates the cache.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  if (!data.content || !data.content[0] || data.content[0].type !== 'text') {
    throw new Error(`Unexpected API response shape: ${JSON.stringify(data)}`);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Response truncated at max_tokens limit — increase max_tokens in callClaude`);
  }
  // Cache telemetry to stderr (never stdout — keeps --json output clean).
  const u = data.usage || {};
  console.error(`[cv-qa] usage: in=${u.input_tokens ?? '?'} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? '?'}`);
  return data.content[0].text;
}

// ---------------------------------------------------------------------------
// Apply patches (works on passed-in content, not module-level vars)
// ---------------------------------------------------------------------------

function applyPatches(flags, currentCv, currentCl) {
  const patchable = flags.filter(f => f.auto_patchable && f.patch);
  let cvPatched = false;
  let clPatched = false;
  let workCv = currentCv;
  let workCl = currentCl;
  const applied = [];
  const failed  = [];

  for (const flag of patchable) {
    const { file, old: oldStr, new: newStr } = flag.patch;
    if (!oldStr || !newStr || oldStr === newStr) continue;

    if (file === 'cv') {
      if (workCv.includes(oldStr)) {
        workCv = workCv.replaceAll(oldStr, newStr);
        cvPatched = true;
        applied.push(flag.id);
      } else {
        failed.push({ id: flag.id, reason: 'old string not found in CV HTML' });
      }
    } else if (file === 'cl') {
      if (workCl.includes(oldStr)) {
        workCl = workCl.replaceAll(oldStr, newStr);
        clPatched = true;
        applied.push(flag.id);
      } else {
        failed.push({ id: flag.id, reason: 'old string not found in cover letter' });
      }
    }
  }

  if (!DRY_RUN) {
    if (cvPatched) writeFileSync(CV_PATH, workCv, 'utf8');
    if (clPatched) writeFileSync(CL_PATH, workCl, 'utf8');
  }

  return { applied, failed, cvPatched, clPatched, workCv, workCl };
}

// ---------------------------------------------------------------------------
// NDA violation rewrite — surgical patch of specific sentences
// ---------------------------------------------------------------------------

function isNDAFixCandidate(result) {
  return (result.flags || []).some(
    f => f.check === 'nda_compliance' && f.severity === 'CRITICAL' && !f.auto_patchable
  );
}

function buildNDAFixSystem() {
  return `${profileMd}

---

## Your task: Fix employer NDA violations

Section 5 of the candidate profile above ("Employer NDA Rules") is your only reference.
It contains a complete SAFE list and BLOCKED list.

You will be shown specific sentences from a CV (HTML) or cover letter (markdown) that
contain NDA violations. For each violating sentence, produce a replacement that:

1. Uses ONLY language from the SAFE list in Section 5
2. Preserves the surrounding intent — the candidate still needs to demonstrate the
   same skill or achievement, just without the blocked detail
3. Reads naturally in context and could replace the original verbatim

### Output format — JSON only, no prose:

{
  "nda_patches": [
    {
      "file": "cv | cl",
      "old": "the exact violating text — must match verbatim for string replace",
      "new": "NDA-safe replacement drawn from the Section 5 SAFE list",
      "reason": "which BLOCKED item was present and which SAFE item replaces it"
    }
  ]
}`;
}

function buildNDAFixUserMessage(ndaFlags, cv, cl) {
  const violations = ndaFlags
    .map((f, i) => [
      `Violation ${i + 1}:`,
      `  File: ${f.location?.startsWith('cv') ? 'cv' : 'cl'}`,
      `  Location: ${f.location}`,
      `  Issue: ${f.description}`,
    ].join('\n'))
    .join('\n\n');

  return `## NDA Violations to Rewrite

${violations}

---

## CV (HTML — find and fix the violating text if file is "cv")

\`\`\`html
${cv}
\`\`\`

---

## Cover Letter (Markdown — find and fix the violating text if file is "cl")

\`\`\`markdown
${cl}
\`\`\`

For each violation above, locate the exact offending text in the relevant file and
produce an NDA-safe replacement using only the SAFE list from Section 5 of the
candidate profile. Return only the JSON object.`;
}

// ---------------------------------------------------------------------------
// Determine whether a REGENERATE result is CL-fixable via regen
// (not framing mismatch — that needs a different CV variant, not a new CL)
// NDA violations are handled separately above and may already be patched
// by the time this runs.
// ---------------------------------------------------------------------------

function isClRegenCandidate(result) {
  if (result.overall_verdict !== 'REGENERATE') return false;
  if (result.checks?.cover_letter === 'PASS') return false;
  // Framing mismatch means the CV variant is wrong — CL regen alone won't fix it
  if (result.role_classification?.framing_mismatch) return false;
  // There must be non-auto-patchable CL flags to justify a full regen
  const hasCLFlags = result.flags?.some(f => f.check === 'cover_letter' && !f.auto_patchable);
  return hasCLFlags;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const timestamp = new Date().toISOString();

  logMsg(`[cv-qa] ${timestamp}`);
  logMsg(`[cv-qa] CV:      ${CV_PATH}`);
  logMsg(`[cv-qa] CL:      ${CL_PATH}`);
  logMsg(`[cv-qa] Company: ${COMPANY} | Role: ${ROLE_TITLE}`);
  logMsg(`[cv-qa] max-regen: ${MAX_REGEN}`);
  logMsg(`[cv-qa] Calling claude-sonnet-4-6 (QA pass 1)...`);

  // ── Initial QA ──────────────────────────────────────────────────────────
  let currentCl = clMd;
  let rawResponse;
  try {
    rawResponse = await callClaude(QA_SYSTEM, buildUserMessage(cvPlain, currentCl));
  } catch (err) {
    console.error(`[cv-qa] API call failed: ${err.message}`);
    throw err;
  }

  let result;
  try {
    result = parseJson(rawResponse);
  } catch (err) {
    console.error(`[cv-qa] Failed to parse QA response as JSON: ${err.message}`);
    console.error('[cv-qa] Raw response:', rawResponse.slice(0, 500));
    throw err;
  }

  // ── NDA Violation Fix (surgical patch before CL regen) ─────────────────
  // If non-auto-patchable NDA violations are present, ask the agent to
  // rewrite only the offending sentences using the SAFE list from Section 5.
  // This runs once, then we re-evaluate before entering the CL regen loop.
  let ndaFixAttempted = false;
  let ndaFixApplied = 0;
  if (isNDAFixCandidate(result)) {
    ndaFixAttempted = true;
    const ndaFlags = result.flags.filter(
      f => f.check === 'nda_compliance' && f.severity === 'CRITICAL' && !f.auto_patchable
    );
    logMsg(`[cv-qa] ${ndaFlags.length} NDA violation(s) found — rewriting offending sentences...`);

    try {
      const ndaRaw = await callClaude(
        buildNDAFixSystem(),
        buildNDAFixUserMessage(ndaFlags, cvPlain, currentCl)
      );
      const ndaResult = parseJson(ndaRaw);
      const ndaPatches = ndaResult.nda_patches || [];

      if (ndaPatches.length > 0) {
        logMsg(`[cv-qa] Applying ${ndaPatches.length} NDA patch(es)...`);
        // Re-use applyPatches by constructing flag-shaped objects
        const patchFlags = ndaPatches.map((p, i) => ({
          id: `nda_fix_${i}`,
          auto_patchable: true,
          patch: { file: p.file, old: p.old, new: p.new },
        }));
        const ndaPatchResult = applyPatches(patchFlags, cvPlain, currentCl);
        // Update currentCl if the CL was patched
        if (ndaPatchResult.clPatched) currentCl = ndaPatchResult.workCl;

        ndaFixApplied = ndaPatchResult.applied.length;
        logMsg(`[cv-qa] NDA patches applied (${ndaFixApplied}/${ndaPatches.length}). Re-evaluating...`);
        try {
          rawResponse = await callClaude(QA_SYSTEM, buildUserMessage(cvPlain, currentCl));
          result = parseJson(rawResponse);
          logMsg(`[cv-qa] Post-NDA-fix verdict: ${result.overall_verdict} | NDA: ${result.checks?.nda_compliance}`);
        } catch (err) {
          logMsg(`[cv-qa] Re-QA after NDA fix failed: ${err.message} — continuing with pre-fix result`);
        }
      } else {
        logMsg(`[cv-qa] NDA fix returned no patches — violations may need manual review`);
      }
    } catch (err) {
      logMsg(`[cv-qa] NDA fix API call failed: ${err.message} — skipping NDA auto-fix`);
    }
  }

  // ── CL Regeneration Loop ────────────────────────────────────────────────
  const regenHistory = [];
  let regenCount = 0;

  while (MAX_REGEN > 0 && isClRegenCandidate(result) && regenCount < MAX_REGEN) {
    regenCount++;
    logMsg(`[cv-qa] Cover letter below bar (${result.cover_letter_verdict}, ${result.cover_letter_word_count} words). Regen attempt ${regenCount}/${MAX_REGEN}...`);

    regenHistory.push({
      attempt: regenCount,
      verdict: result.cover_letter_verdict,
      word_count: result.cover_letter_word_count,
      critique: result.cover_letter_critique,
      cl_flags: (result.flags || []).filter(f => f.check === 'cover_letter').map(f => f.id),
    });

    // Generate a new cover letter
    let newCL;
    try {
      newCL = await callClaude(buildRegenSystem(result), buildRegenUserMessage(currentCl));
    } catch (err) {
      logMsg(`[cv-qa] Regen API call failed: ${err.message} — stopping regen loop`);
      break;
    }

    if (!DRY_RUN) writeFileSync(CL_PATH, newCL, 'utf8');
    currentCl = newCL;
    logMsg(`[cv-qa] New CL written (${newCL.split(/\s+/).length} words approx). Re-evaluating...`);

    // Re-run QA against the new cover letter
    try {
      rawResponse = await callClaude(QA_SYSTEM, buildUserMessage(cvPlain, currentCl));
      result = parseJson(rawResponse);
      logMsg(`[cv-qa] Re-QA result: ${result.overall_verdict} | CL: ${result.cover_letter_verdict} (${result.cover_letter_word_count} words)`);
    } catch (err) {
      logMsg(`[cv-qa] Re-QA failed: ${err.message} — using last known result`);
      break;
    }
  }

  if (regenCount > 0) {
    logMsg(`[cv-qa] Regen complete. Attempts: ${regenCount}. Final verdict: ${result.overall_verdict}`);
  }

  // ── Apply auto-patchable flags ──────────────────────────────────────────
  let patchResult = null;
  if (result.overall_verdict !== 'PASS' && result.flags && result.flags.length > 0) {
    patchResult = applyPatches(result.flags, cvPlain, currentCl);
  }

  // Determine final overall verdict accounting for patches
  let finalVerdict = result.overall_verdict;
  if (finalVerdict === 'PATCH_AND_PASS' && patchResult && patchResult.applied.length === 0) {
    finalVerdict = 'REGENERATE'; // patches claimed but none applied
  }

  // ── Output ──────────────────────────────────────────────────────────────
  if (JSON_MODE) {
    const output = {
      ...result,
      _meta: {
        timestamp,
        cv_path: CV_PATH,
        cl_path: CL_PATH,
        company: COMPANY,
        role_title: ROLE_TITLE,
        dry_run: DRY_RUN,
        nda_auto_fixed: ndaFixAttempted ? (ndaFixApplied > 0 ? `applied:${ndaFixApplied}` : 'attempted_no_patches') : 'not_needed',
        regen_attempts: regenCount,
        regen_history: regenHistory,
        patches_applied: patchResult?.applied || [],
        patches_failed: patchResult?.failed || [],
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    const cls = result.role_classification;
    console.log('');
    console.log(`ROLE CLASSIFIED   : ${cls?.jd_title} → ${cls?.classified_as}${cls?.non_standard_title ? ' [NON-STANDARD TITLE]' : ''}`);
    console.log(`FRAMING APPLIED   : ${cls?.framing_applied}`);
    if (cls?.framing_mismatch) console.log(`FRAMING MISMATCH  : ${cls?.framing_mismatch_detail}`);
    console.log(`RECRUITER PERSONA : ${result.recruiter_persona?.type} (${result.recruiter_persona?.formality} / ${result.recruiter_persona?.primary_lens})`);
    console.log(`ALIGNMENT SCORE   : ${result.alignment_score}/100`);
    console.log(`INTERVIEW CHANCE  : ${result.interview_likelihood}`);
    console.log(`OVERALL VERDICT   : ${result.overall_verdict}`);
    if (ndaFixAttempted) console.log(`NDA AUTO-FIX      : ${ndaFixApplied > 0 ? `${ndaFixApplied} patch(es) applied` : 'attempted — no patches produced'}`);
    if (regenCount > 0) console.log(`REGEN ATTEMPTS    : ${regenCount}/${MAX_REGEN}`);
    console.log('');
    console.log('CHECKS:');
    for (const [k, v] of Object.entries(result.checks || {})) {
      console.log(`  ${k.padEnd(20)}: ${v}`);
    }
    console.log('');
    if (result.flags && result.flags.length > 0) {
      console.log(`FLAGS (${result.flags.length}):`);
      for (const flag of result.flags) {
        const patchable = flag.auto_patchable ? '[AUTO-PATCHABLE]' : '[MANUAL]';
        console.log(`  [${flag.severity}] ${flag.check} @ ${flag.location} ${patchable}`);
        console.log(`    ${flag.description}`);
        if (flag.patch && flag.auto_patchable) {
          console.log(`    OLD: ${String(flag.patch.old).slice(0, 80)}`);
          console.log(`    NEW: ${String(flag.patch.new).slice(0, 80)}`);
        }
        console.log('');
      }
    }
    console.log(`COVER LETTER      : ${result.cover_letter_verdict} (${result.cover_letter_word_count} words)`);
    console.log(`CRITIQUE          : ${result.cover_letter_critique}`);
    console.log('');
    if (patchResult) {
      console.log(`PATCHES APPLIED   : ${patchResult.applied.join(', ') || 'none'}`);
      if (patchResult.failed.length > 0) {
        console.log(`PATCHES FAILED    : ${patchResult.failed.map(f => f.id).join(', ')}`);
      }
      if (DRY_RUN) console.log('(DRY RUN — no files written)');
    }
  }

  // ── Exit code ───────────────────────────────────────────────────────────
  if (result.overall_verdict === 'PASS') process.exit(0);
  if (result.overall_verdict === 'PATCH_AND_PASS' && patchResult && patchResult.applied.length > 0) process.exit(2);
  // REGENERATE after regen — regen improved CL but didn't fully pass: still exit 2 if patches applied
  if (regenCount > 0 && patchResult && patchResult.applied.length > 0) process.exit(2);
  process.exit(3);
}

main().catch(err => {
  console.error('[cv-qa] Fatal:', err.message);
  process.exitCode = 1;
});
