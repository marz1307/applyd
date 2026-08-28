#!/usr/bin/env node
/**
 * profile-enrich.mjs — LLM-generated CV profile paragraph, 4-sentence framework.
 *
 * Replaces the hardcoded template-driven profiles in the tailored CV renderers
 * for renders that have JD text available.
 *
 * Contract:
 *   enrichProfile({jdText, company, roleTitle, archetype, seniority, keywords,
 *                  country, lang}) → { profile | null, source, reason?, word_count? }
 *
 *   - source = 'llm-enriched' on success
 *   - source = null + reason set when any guardrail trips (caller falls back)
 *
 * Guardrails (all must pass or we return null; caller uses template fallback):
 *   1. Preamble scrub (strips "Here is..." / "Word count:..." contamination)
 *   2. Banned-content grep (em dash + configured banned employers via market-tail)
 *   3. Word count 40-100 (hard) / 50-80 (soft target)
 *   4. Numeric fact-check: every digit in the output must trace to the corpus
 *      (cv.md / cv-de.md / article-digest.md / modes/candidate-profile.md)
 *
 * Cost model: mirrors cv-qa — subscription-first via `claude -p` (no API cost),
 * with an opt-in metered API path behind CAREEROPS_QA_USE_API=1. See
 * scripts/cv/llm-client.mjs for the shared client.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MT from './market-tail.cjs';
import { callClaude as sharedCallClaude } from './llm-client.mjs';
import { loadCompany, formatCompanyContext } from './company-research-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ── Corpus for numeric fact-check ───────────────────────────────────────────
const CORPUS_PATHS = [
  resolve(REPO_ROOT, 'cv.md'),
  resolve(REPO_ROOT, 'cv-de.md'),
  resolve(REPO_ROOT, 'article-digest.md'),
  resolve(REPO_ROOT, 'modes', 'candidate-profile.md'),
];
const NUMERIC_CORPUS = CORPUS_PATHS
  .filter(existsSync)
  .map(p => readFileSync(p, 'utf8'))
  .join('\n\n');

const CANDIDATE_PROFILE_PATH = resolve(REPO_ROOT, 'modes', 'candidate-profile.md');
const CANDIDATE_PROFILE = existsSync(CANDIDATE_PROFILE_PATH)
  ? readFileSync(CANDIDATE_PROFILE_PATH, 'utf8')
  : '';

// ── Availability, resolved against today ────────────────────────────────────
// candidate-profile.md typically states an availability rule in prose ("Once
// [month year] is reached or past, 'Immediately available' replaces the date
// phrase"). The model has no clock, so prose alone is not enough — a literal
// "From [month year]" table cell can end up in sentence 4 unchanged.
// Resolving the phrase here and pinning it as a hard rule removes the guesswork.
export function resolveAvailabilityPhrase(availabilityFrom, now = new Date()) {
  const m = String(availabilityFrom || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return 'available immediately';
  const start = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  if (cur >= start) return 'available immediately';
  const month = start.toLocaleString('en-GB', { month: 'long' });
  return `available from ${month} ${m[1]}`;
}

function readAvailabilityFrom() {
  try {
    const yml = readFileSync(resolve(REPO_ROOT, 'config', 'profile.yml'), 'utf8');
    const m = yml.match(/^\s*availability_from:\s*["']?([0-9]{4}-[0-9]{2})["']?/m);
    return m ? m[1] : null;
  } catch { return null; }
}
const AVAILABILITY_PHRASE = resolveAvailabilityPhrase(readAvailabilityFrom());

// Availability is a MARKET fact before it is a calendar fact. `availability_from`
// having passed makes resolveAvailabilityPhrase answer "available immediately",
// which is true for a market where the candidate has right to work now and
// false for a market whose configured line is gated behind visa processing.
// assertNoCrossMarketLeak only guards the VISA sentence, so nothing there
// catches a mid-EU availability overclaim. The market line wins whenever it
// says something other than "immediately"; otherwise the clock still governs
// (it is the half that knows a future start date).
const IMMEDIATE_AVAIL_RE = /available\s+immediately|sofort\s+verfügbar|ab\s+sofort\s+verfügbar/i;
export function availabilityPhraseFor(market, lang) {
  const line = MT.availabilityLine(market, lang);
  if (line && !IMMEDIATE_AVAIL_RE.test(line)) return line.trim().replace(/\.$/, '');
  return AVAILABILITY_PHRASE;
}

// ── Numeric extractor + verifier (copied from cv-qa; keep in sync) ──────────
const YEAR_MIN = 1900, YEAR_MAX = 2100;
const NUMERIC_RE = /(?<![\/\w.])(~|≈)?(\d+(?:[.,]\d{3})*(?:[.,]\d+)?)([kKmMbB%+]?|\+)/g;

export function extractNumericClaims(text) {
  const t = String(text || '');
  const scrubbed = t
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[\w.+-]+@[\w.-]+\b/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ');
  const claims = [];
  let m;
  const seen = new Set();
  while ((m = NUMERIC_RE.exec(scrubbed)) !== null) {
    const raw = m[2];
    const suffix = m[3] || '';
    const digitsOnly = raw.replace(/[.,]/g, '');
    const asInt = parseInt(digitsOnly, 10);
    if (!suffix && asInt >= YEAR_MIN && asInt <= YEAR_MAX && digitsOnly.length === 4) continue;
    if (!suffix && digitsOnly.length === 1) continue;
    const token = raw + suffix;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ token, digits: raw, suffix });
  }
  return claims;
}

export function verifyNumericClaims(claims, corpus) {
  if (!corpus) return { checked: 0, unverified: [] };
  const unverified = [];
  for (const c of claims) {
    const d1 = c.digits;
    const d2 = c.digits.replace('.', ',');
    const d3 = c.digits.replace(',', '.');
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!\\d)(${escape(d1)}|${escape(d2)}|${escape(d3)})(?!\\d)`);
    if (!re.test(corpus)) unverified.push(c);
  }
  return { checked: claims.length, unverified };
}

// ── Preamble scrubber (copied from cv-qa; keep in sync) ─────────────────────
const PROFILE_PREAMBLE_RE = /^(here (is|are)|here's|below (is|are)|i'?ll|i (will|have|am going to)|the (new|rewritten|updated|revised|improved) profile[:\s]|note:|caveat:)[^.\n]{0,200}[.\n]/i;
const PROFILE_SELF_CRITIQUE_RE = /\n\n(word count:|note:|caveat:|this profile\b|this new profile\b|the above|the profile above|as requested|hope this|let me know|i've|i have)[^]*/i;

export function scrubProfilePreamble(text) {
  let t = String(text || '').trim();
  const preMatch = t.match(PROFILE_PREAMBLE_RE);
  if (preMatch) t = t.slice(preMatch[0].length).trim();
  t = t.replace(PROFILE_SELF_CRITIQUE_RE, '').trim();
  t = t.replace(/^```(?:markdown|md|text)?\s*/i, '').replace(/```\s*$/, '').trim();
  t = t.replace(/^["'"']+|["'"']+$/g, '').trim();
  return t;
}

// ── LLM client (shared) ────────────────────────────────────────────────────
// Same cost model as cv-qa (subscription-default, opt-in metered API via
// CAREEROPS_QA_USE_API=1). Local wrapper just pins the enrichment-specific
// model + max_tokens so the caller signature stays simple.
const ENRICH_MODEL = 'claude-haiku-4-5-20251001';
const FALLBACK_MODEL = 'claude-opus-4-8';

async function callClaude(systemPrompt, userMessage, timeout) {
  const { text } = await sharedCallClaude({
    systemPrompt, userMessage,
    model: ENRICH_MODEL,
    fallbackModel: FALLBACK_MODEL,
    maxTokens: 1024,
    timeout,
  });
  return text;
}

// ── Prompt builders ─────────────────────────────────────────────────────────
function buildSystemPrompt({ company, roleTitle, archetype, seniority, market, lang, availabilityPhrase = AVAILABILITY_PHRASE }) {
  const marketLine = market
    ? `Market: ${market} | CV language: ${lang || 'en'} — apply the correct market-appropriate work-rights language in sentence 4 (use whatever your target-market visa/permit line is; omit it for markets outside your covered set).`
    : `Market: (unresolved; use a neutral logistics line).`;

  // Persistent per-company research (data/company-research/{slug}.json) —
  // opt-in, no-op when the record does not exist. When present, it appends
  // company vocabulary + tech stack + values as authoritative context that
  // out-ranks the JD alone for vocabulary mirroring.
  const companyRec = loadCompany(company);
  const companyContext = companyRec ? '\n\n---\n\n' + formatCompanyContext(companyRec) : '';

  return `${CANDIDATE_PROFILE}${companyContext}

---

## Your task: Write the CV profile paragraph

You write the CV profile. Your job is to produce a 4-sentence profile paragraph
that a recruiter at ${company} — screening the CV for the "${roleTitle}" role — can read in
under 10 seconds and think: "this candidate could have written our own job spec."

### The 4 sentences — every sentence has ONE job

**Sentence 1 — Anchor.** Role title + seniority signal + domain.
- Role title MUST anchor to the JD: "${roleTitle}" is the target.
- Seniority signal:
  - Default → PROFESSIONAL framing: "[Role] with [N] years' production experience across [domain]".
    Use the honest years number from the candidate profile above.
    NEVER lead with a degree label for a professional-framing anchor.
  - ONLY when the JD explicitly signals grad/junior/trainee/werkstudent/entry-level →
    graduate framing: "[Degree] graduate (institution, class, year) with production…".
    The differentiator in that pool is "production experience"; use it.
- Domain MUST mirror the JD's own product/domain vocabulary (e.g. if JD says "payments
  infrastructure", say "payments infrastructure" — not "fintech").
- Ban list: "passionate", "results-driven", "team player", "hard-working".
- No first-person openers ("I am…", "I have always…").

**Sentence 2 — Edge.** 1-2 core strengths + 2-3 supporting tools.
- Strengths must match the JD's primary requirements — read the "you will" bullets.
- Tools must overlap with ${company}'s stack (from the JD). Cap: 3 max.
- This is expertise, not a skills dump.

**Sentence 3 — Impact.** Strong verb (shipped / delivered / built / owned) + concrete
scope + a NUMBER from the candidate's actual work.
- Every digit MUST trace back to the candidate profile above / cv.md / article-digest.md.
- Do NOT invent numbers. If you cannot verify a stat, drop it.
- NO company names — those belong in Experience. This sentence is about the shape
  of what has been shipped, not the where.
- NO weak verbs (worked on / involved with / contributed to).

**Sentence 4 — Logistics.** Degree + work rights + market line.
- Standard structure: "[Degree, institution, year]. [work-rights sentence]. [availability sentence]."
- For a professional-framing anchor (sentence 1), the degree/class lives HERE as a
  credential, not in the anchor. For a graduate-framing anchor, the degree is already
  in sentence 1 — sentence 4 can just carry the work-rights + availability.
- ${marketLine}
- AVAILABILITY (overrides anything the candidate profile above says about start
  dates — that text is static and can be out of date): the ONLY permitted phrasing
  is "${availabilityPhrase}". Never write a month or year for availability unless
  it appears in that exact phrase.

### Non-negotiable rules (every one blocks a pass)

1. Exactly 4 sentences.
2. Total word count: 50–80 words. Count before finishing.
3. Zero em dashes (U+2014). Hyphens (-) or full stops instead.
4. Zero company names in sentences 1–3.
5. No stack dump: max 3 tools in any single sentence.
6. **No metrics in the Profile paragraph.** Profile is POSITIONING — role,
   capability, stack, domain. Metrics live in Experience and Projects, never
   here. Specifically banned in this paragraph (each blocks a pass):
   - Named model-quality metrics: AUC, C-index, F1, precision, recall, accuracy.
   - Percentages of any kind.
   - Count-plus phrases and named counts.
   - Decimal scores.
   - Day/cycle counts.
   The ONLY digits allowed in this paragraph are tenure ("[N] years'
   production experience"). 4-digit years are NOT allowed either.
   Enforced deterministically by scripts/cv/market-tail.cjs
   assertNoProfileMetrics — a shipped digit outside those exceptions is
   a build failure, not a stylistic miss.
6b. **No dates, employers, universities, or non-target-country references
   in the Profile paragraph.** Profile is POSITIONING — history goes in
   Experience / Projects / Education, never here. Enforced deterministically
   by scripts/cv/market-tail.cjs assertNoProfileHistory.
7. Anchor sentence must mirror the JD's product/domain vocabulary.
8. Zero AI-tell vocabulary: "leverage" (verb), "synergize", "delve", "align with",
   "crucial", "pivotal", "transformative", "showcase", "boasts", "vibrant landscape",
   "thrilled", "excited to", "passionate about", "results-driven".
8b. Frame per archetype: use the framing the candidate profile prescribes
    for this archetype and role type; never introduce framing not evidenced
    in the candidate profile above.
9. Availability, if mentioned, reads exactly "${availabilityPhrase}".

### Archetype hint

- Archetype: ${archetype || '(unspecified — infer from JD)'}
- Seniority band: ${seniority || 'mid'}
  - "mid" or "professional" → PROFESSIONAL framing (default).
  - "graduate" or "junior" → GRADUATE framing.
  - "senior" → be selective; use professional framing with an honest tenure anchor.

### Output format

Return ONLY the profile paragraph text — one paragraph, plain text, no JSON, no
preamble, no word-count annotation, no explanation, no code fences, no leading
quotes. The first character of your response is the first letter of the anchor
sentence.`;
}

function buildUserMessage({ jdText, roleTitle, company, keywords }) {
  const kwLine = (keywords || []).length ? keywords.slice(0, 8).join(', ') : '(none extracted)';
  return `## Job Description

${jdText}

---

## Render context

- Company: ${company}
- Role title (verbatim): ${roleTitle}
- JD-derived keywords (extracted upstream): ${kwLine}

Write the profile paragraph for the role of "${roleTitle}" at ${company}.
Start immediately with the anchor sentence.`;
}

// ── Main export ─────────────────────────────────────────────────────────────
export async function enrichProfile({
  jdText, company, roleTitle, archetype, seniority, keywords,
  country, lang, timeout = 60000,
} = {}) {
  if (!jdText || !String(jdText).trim()) {
    return { profile: null, source: null, reason: 'no_jd_text' };
  }
  if (!company || !roleTitle) {
    return { profile: null, source: null, reason: 'missing_company_or_role' };
  }

  const market = MT.resolveMarket(country || '', { lang });
  const availabilityPhrase = availabilityPhraseFor(market, lang);
  const systemPrompt = buildSystemPrompt({ company, roleTitle, archetype, seniority, market, lang, availabilityPhrase });
  const userMessage = buildUserMessage({ jdText, roleTitle, company, keywords });

  let raw;
  try {
    raw = await callClaude(systemPrompt, userMessage, timeout);
  } catch (err) {
    return { profile: null, source: null, reason: `api_failure: ${String(err.message || err).slice(0, 120)}` };
  }

  let scrubbed = scrubProfilePreamble(raw);
  if (!scrubbed) {
    return { profile: null, source: null, reason: 'empty_after_scrub' };
  }
  // Deterministic net under the AVAILABILITY prompt rule. Rewriting the
  // literal "available from [Month YYYY]" here means a stale date cannot
  // ship even when the model ignores the instruction.
  scrubbed = scrubbed.replace(
    /\bavailable\s+(?:from|starting)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/gi,
    availabilityPhrase,
  );

  // Guardrail: availability must match the MARKET, not the clock. On a market
  // whose configured availability is gated behind visa processing, an
  // immediacy claim is a factual overclaim to the recruiter.
  if (!IMMEDIATE_AVAIL_RE.test(availabilityPhrase) && IMMEDIATE_AVAIL_RE.test(scrubbed)) {
    return { profile: null, source: null, reason: `availability_overclaim: market=${market} expects "${availabilityPhrase}"` };
  }

  // Guardrail: banned content (em dash + any configured banned employers).
  try {
    MT.assertNoBannedContentText(scrubbed, 'profile-enrich');
  } catch (e) {
    return { profile: null, source: null, reason: `banned_content: ${e.message.slice(0, 140)}` };
  }

  // Guardrail: metric ban on the Profile paragraph itself.
  try {
    const synthetic = `<h2>Profile</h2><p>${scrubbed}</p><h2>Experience</h2>`;
    MT.assertNoProfileMetrics(synthetic, 'profile-enrich');
  } catch (e) {
    return { profile: null, source: null, reason: `profile_metric: ${e.message.slice(0, 140)}` };
  }

  // Guardrail: date/employer/university/history-country ban.
  try {
    const synthetic = `<h2>Profile</h2><p>${scrubbed}</p><h2>Experience</h2>`;
    MT.assertNoProfileHistory(synthetic, 'profile-enrich');
  } catch (e) {
    return { profile: null, source: null, reason: `profile_history: ${e.message.slice(0, 140)}` };
  }

  // Guardrail: word count within framework tolerance (50-80 soft, 40-100 hard).
  const wc = scrubbed.trim().split(/\s+/).filter(Boolean).length;
  if (wc < 40 || wc > 100) {
    return { profile: null, source: null, reason: `word_count: ${wc} (target 50-80)` };
  }

  // Guardrail: numeric fact-check.
  if (NUMERIC_CORPUS) {
    const claims = extractNumericClaims(scrubbed);
    const { unverified } = verifyNumericClaims(claims, NUMERIC_CORPUS);
    if (unverified.length > 0) {
      const bad = unverified.slice(0, 3).map(u => u.token).join(', ');
      return { profile: null, source: null, reason: `hallucinated_numbers: ${bad}${unverified.length > 3 ? ` (+${unverified.length - 3})` : ''}` };
    }
  }

  return { profile: scrubbed, source: 'llm-enriched', word_count: wc };
}

// ── CLI entrypoint (for smoke tests) ────────────────────────────────────────
async function cli() {
  const argv = process.argv.slice(2);
  const args = { keywords: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--company') args.company = argv[++i];
    else if (a === '--role-title') args.roleTitle = argv[++i];
    else if (a === '--archetype') args.archetype = argv[++i].toUpperCase();
    else if (a === '--seniority') args.seniority = argv[++i].toLowerCase();
    else if (a === '--keywords') args.keywords = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--country') args.country = argv[++i];
    else if (a === '--lang') args.lang = argv[++i];
    else if (a === '--jd-text') args.jdText = argv[++i];
    else if (a === '--jd-file') args.jdText = readFileSync(argv[++i], 'utf8');
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/cv/profile-enrich.mjs --company X --role-title Y --archetype AE|DS|DE|DA|BI|ME [--seniority grad|mid] [--keywords a,b,c] [--country DE] [--lang en] --jd-text "..." | --jd-file path');
      process.exit(0);
    }
  }
  const result = await enrichProfile(args);
  if (result.profile) {
    console.error(`[profile-enrich] source=${result.source} words=${result.word_count}`);
    process.stdout.write(result.profile + '\n');
    process.exit(0);
  } else {
    console.error(`[profile-enrich] FAILED: ${result.reason}`);
    process.exit(2);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  cli().catch(err => {
    console.error('[profile-enrich] Fatal:', err.message);
    process.exit(1);
  });
}
