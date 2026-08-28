#!/usr/bin/env node
/**
 * profile-enrich.test.mjs — guardrail coverage for the LLM profile-enrichment
 * feature. Exercises the PURE logic only — no LLM call is made, so this runs
 * fast and deterministically in test-all.
 *
 * Covers:
 *   - scripts/cv/profile-enrich.mjs : scrubProfilePreamble, extractNumericClaims,
 *                                     verifyNumericClaims, and enrichProfile's
 *                                     pre-LLM early-return guardrails.
 *   - scripts/cv/llm-client.mjs     : Opus-on-API cost guard, clientMode shape.
 *   - scripts/cv/market-tail.cjs    : assertNoBannedContent + assertNoBannedContentText
 *                                     (em-dash gate).
 *
 * The post-LLM guardrails (word-count, banned-content, numeric fact-check) that
 * enrichProfile applies to a real completion are covered transitively: the same
 * helper functions tested here are the ones enrichProfile calls.
 */

import {
  scrubProfilePreamble,
  extractNumericClaims,
  verifyNumericClaims,
  enrichProfile,
} from './profile-enrich.mjs';
import { callClaude, clientMode } from './llm-client.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MT = require('./market-tail.cjs');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}
async function throwsAsync(fn) {
  try { await fn(); return false; } catch { return true; }
}
function throwsSync(fn) {
  try { fn(); return false; } catch { return true; }
}

const EM = '—'; // real em dash — banned

console.log('profile-enrich / llm-client / market-tail guardrails');
console.log('━'.repeat(56));

// ── 1. scrubProfilePreamble ──────────────────────────────────────────────────
console.log('\n1. scrubProfilePreamble');
{
  const body = 'Analytics Engineer with three years of production experience.';
  ok(scrubProfilePreamble(`Here is the rewritten profile:\n\n${body}`) === body,
     'strips a leading "Here is the ... profile:" preamble');
  ok(scrubProfilePreamble(`${body}\n\nWord count: 9 words. Hope this helps.`) === body,
     'strips trailing self-critique ("Word count: ...")');
  ok(scrubProfilePreamble('```markdown\n' + body + '\n```') === body,
     'strips surrounding code fences');
  ok(scrubProfilePreamble(`"${body}"`) === body,
     'strips wrapping quotes');
  ok(scrubProfilePreamble(body) === body,
     'leaves a clean paragraph untouched');
}

// ── 2. extractNumericClaims ──────────────────────────────────────────────────
console.log('\n2. extractNumericClaims');
{
  const tokens = extractNumericClaims('Shipped 40 dbt models and 123 tests, cutting compute by 95% since 2026.')
    .map(c => c.token);
  ok(tokens.includes('40') && tokens.includes('123'), 'captures plain integers (40, 123)');
  ok(tokens.includes('95%'), 'captures a percentage with its suffix (95%)');
  ok(!tokens.includes('2026'), 'excludes a 4-digit year in range (2026)');
  ok(extractNumericClaims('one 7 alone').every(c => c.token !== '7'),
     'excludes a bare single digit (7)');
}

// ── 3. verifyNumericClaims ───────────────────────────────────────────────────
console.log('\n3. verifyNumericClaims');
{
  const corpus = 'Built 40 dbt models with 123 CI-gated tests; cut daily compute by 95%.';
  const good = verifyNumericClaims(extractNumericClaims('40 models, 123 tests, 95% saved'), corpus);
  ok(good.unverified.length === 0, 'numbers present in the corpus verify clean');
  const bad = verifyNumericClaims(extractNumericClaims('cut compute by 777%'), corpus);
  ok(bad.unverified.some(u => u.token === '777%'), 'an invented number (777%) is flagged unverified');
  ok(verifyNumericClaims([{ digits: '5', token: '5' }], '').checked === 0,
     'empty corpus disables the check (returns checked=0)');
}

// ── 4. enrichProfile pre-LLM early returns (no LLM call) ─────────────────────
console.log('\n4. enrichProfile early-return guardrails');
{
  const r1 = await enrichProfile({ company: 'X', roleTitle: 'AE', jdText: '' });
  ok(r1.profile === null && r1.reason === 'no_jd_text', 'empty JD → no_jd_text, profile null');
  const r2 = await enrichProfile({ jdText: 'a real JD', roleTitle: 'AE' });
  ok(r2.profile === null && r2.reason === 'missing_company_or_role',
     'missing company → missing_company_or_role, profile null');
}

// ── 5. llm-client cost guard + mode ──────────────────────────────────────────
console.log('\n5. llm-client Opus-on-API cost guard');
{
  ok(await throwsAsync(() => callClaude({
        systemPrompt: 's', userMessage: 'u',
        model: 'claude-opus-4-8', fallbackModel: 'claude-opus-4-8',
     })),
     'callClaude rejects an Opus API model (cost guard fires before dialling)');
  ok(typeof clientMode === 'object'
     && 'api_enabled' in clientMode && 'opt_in_flag_set' in clientMode && 'key_present' in clientMode,
     'clientMode exposes { api_enabled, opt_in_flag_set, key_present }');
}

// ── 6. market-tail banned-content gate ───────────────────────────────────────
console.log('\n6. market-tail banned-content gate');
{
  ok(!throwsSync(() => MT.assertNoBannedContent('<p>Clean CV body, 40 dbt models.</p>')),
     'clean HTML passes assertNoBannedContent');
  ok(throwsSync(() => MT.assertNoBannedContent(`<p>Data${EM}driven engineer.</p>`)),
     'em dash (U+2014) in CV body throws');
  ok(throwsSync(() => MT.assertNoBannedContentText(`Data${EM}driven cover letter body.`)),
     'em dash (U+2014) in cover-letter text throws');
  ok(!throwsSync(() => MT.assertNoBannedContentText('Available 2026–2027.')),
     'en dash (U+2013) in a date range is allowed');
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '━'.repeat(56));
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
