// draft-gates.test.js — the contract between the composer and the gates.
//
// letter-gates.test.js proves the gates work. This proves draft-v2.js actually
// SATISFIES them, which is a different claim and the one that decays: any edit
// to the angle catalogue, the opener or the mapping can quietly push generated
// letters back over the technical-density budget or drop the motivation
// paragraph, and nothing else would notice until a recruiter did.
//
// Runs against the REAL brief/match pairs in cover-letters/{briefs,matches}
// (739 of them), because synthetic fixtures would not have caught any of the
// four bugs found on 2026-08-09. No network, no LLM.
//
// Baseline when this was written: 0% of composed letters passed the gates.
// After the composer changes: 94%. The floor below is set under that with
// deliberate slack, so ordinary content edits do not trip it but a structural
// regression does.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { compose } = require('./draft-v2');
const { route } = require('./router');
const { runLetterGates, letterBody } = require('./letter-gates');

// scripts/cover-letters/lib/ -> repo root (cover-letters/briefs and cv/
// live at the root; either may be absent in a fresh clone — the guard below
// short-circuits in that case).
const ROOT = path.resolve(__dirname, '..', '..', '..');
const BRIEFS = path.join(ROOT, 'cover-letters', 'briefs');
const MATCHES = path.join(ROOT, 'cover-letters', 'matches');
const CV_MASTER = path.join(ROOT, 'cv', 'cv_master.json');

let failed = 0;
const bad = [];
function check(name, ok, detail) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failed++; bad.push(`${name}: ${detail}`); console.log(`  ✗ ${name}\n      ${detail}`); }
}

if (!fs.existsSync(BRIEFS) || !fs.existsSync(CV_MASTER)) {
  console.log('  ⚠ skipped — briefs/ or cv_master.json absent (fresh clone)');
  process.exit(0);
}

const cvMaster = JSON.parse(fs.readFileSync(CV_MASTER, 'utf8'));
const names = fs.readdirSync(BRIEFS).filter(n => n.endsWith('.json') && fs.existsSync(path.join(MATCHES, n)));

// The GERMAN track has to be forced. Most saved briefs carry no jd_text, so
// route() falls back to English for effectively all of them — the first
// version of this test composed 739 letters and 0 of them were German, which
// looked like full coverage and verified half the composer. DACH is the
// primary market, so a silently untested German path is the worse half to miss.
const DE_ROUTE = { letter_language: 'de', letter_form: 'din5008_de', market: 'DE', salary_required: false };

const stats = { en: { n: 0, pass: 0 }, de: { n: 0, pass: 0 } };
let abbrev = 0;
const tally = {};
const composeErrors = [];

function runOne(brief, mb, rt, lang) {
  let md;
  try {
    md = compose({
      brief, matchBrief: mb, cvMaster,
      jobUrl: brief.job_url || 'https://example.com/job',
      today: '2026-08-10', route: rt,
    });
  } catch (e) { composeErrors.push(`${lang}/${brief.company || '?'}: ${String(e.message).slice(0, 60)}`); return; }
  const g = runLetterGates(md, { company: brief.company });
  stats[lang].n++;
  if (g.pass) stats[lang].pass++;
  for (const f of g.failures) tally[f.code] = (tally[f.code] || 0) + 1;
  // "JD" is a legitimate token when the EMPLOYER is JD.COM; everything else is
  // the insider-abbreviation leak that came in through the fact scaffolds.
  if (/\b(JD|JDs|CLs?|ATS)\b/.test(letterBody(md)) && !/JD\.COM/i.test(brief.company || '')) abbrev++;
}

for (const name of names) {
  const brief = JSON.parse(fs.readFileSync(path.join(BRIEFS, name), 'utf8'));
  const mb = JSON.parse(fs.readFileSync(path.join(MATCHES, name), 'utf8'));
  runOne(brief, mb, route({ appId: mb.application_id || 'APP-0', postingText: brief.jd_text || '' }), 'en');
  runOne(brief, mb, DE_ROUTE, 'de');
}

const n = stats.en.n + stats.de.n;
const pass = stats.en.pass + stats.de.pass;
console.log(`\n=== composed ${n} real letters (${pass} pass, ${Math.round(pass / n * 100)}%) ===`);
for (const k of ['en', 'de']) {
  const s = stats[k];
  console.log(`  ${k.toUpperCase()}: ${s.pass}/${s.n} (${s.n ? Math.round(s.pass / s.n * 100) : 0}%)`);
}
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);

check('the German track is actually exercised', stats.de.n > 0, 'zero German letters composed — route() defaulted everything to English');

check('composer does not throw', composeErrors.length === 0, composeErrors.slice(0, 3).join(' | '));

// Every letter must answer "why you" and "what would you do here". These went
// from 30/30 and 6/30 FAILING to zero, and there is no legitimate reason for a
// generated letter to omit either — both are unconditional in the spine now.
check('no letter omits motivation', !tally.CL_NO_MOTIVATION, `${tally.CL_NO_MOTIVATION} letters have no why-this-employer content`);
check('no letter omits impact', !tally.CL_NO_IMPACT, `${tally.CL_NO_IMPACT} letters never say what he would do in the role`);
check('no letter leads with its deficits', !tally.CL_DEFICIT_LED, `${tally.CL_DEFICIT_LED} letters stack non-match statements before anything that transfers`);

// Density is JD-driven in part: a posting that names a dozen tools will push
// some through the mapping. 85% is comfortably under the measured 94% so that
// wording tweaks do not trip it, while a structural regression (an angle lead
// re-acquiring a tool list, the JD-term cap going back to 4) drops it far below.
const rate = pass / n;
check('at least 85% of generated letters clear all four gates',
  rate >= 0.85, `only ${Math.round(rate * 100)}% pass`);

// The fact scaffolds ("JD names tech stack: …", "JD mentions … team.") shipped
// verbatim in 32 of the first 60 letters before cleanFactText existed.
check('no insider abbreviation leaks from fact scaffolds', abbrev === 0, `${abbrev} letters contain JD/CL/ATS`);

console.log(`\n${failed === 0 ? '✓' : '✗'} draft-gates.test.js: ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
