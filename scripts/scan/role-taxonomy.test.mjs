// role-taxonomy.test.mjs — matchNegative() semantics + deriveTitleFilter.
//
// WHY THIS EXISTS
// Two independent scanner defects motivated matchNegative():
//   1. Some pre-graduate German titles were absent from the exclusion list,
//      so nothing was blocking them.
//   2. The two scanners disagreed on HOW to match. One word-bounded every
//      term, so German inflections like "Werkstudentin" and compounds like
//      "Ausbildungsplatz" leaked (a trailing \b cannot end mid-compound).
//      The other substring-matched every term, so "International Data
//      Analyst" was dropped as an "Intern" hit.
// matchNegative() is the shared fix; these cases pin both directions.
//
// The test builds its own in-memory taxonomy fixture so it does NOT depend
// on config/role-taxonomy.yml existing in the repo (which is opt-in and
// user-authored). The example config at config/role-taxonomy.example.yml
// documents the shape; this test pins the MECHANISM.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { deriveTitleFilter, matchNegative } from './role-taxonomy.mjs';

// Minimal fixture: only the exclusions matter for these tests. The `roles`
// array satisfies loadTaxonomy's shape guard when someone reuses the fixture.
const TAX = {
  version: 1,
  roles: [
    { name: 'Data Engineer', archetype: 'DE', tier: 'core', lang: 'en' },
  ],
  exclusions: [
    // Word-bounded (English, avoids compound false-positives)
    { name: 'Senior', reason: 'seniority' },
    { name: 'Lead', reason: 'seniority' },
    { name: 'Principal', reason: 'seniority' },
    { name: 'Intern', reason: 'seniority' },
    { name: 'Internship', reason: 'seniority' },
    // Substring (German compounds and inflections)
    { name: 'Werkstudent', reason: 'seniority', match: 'substring' },
    { name: 'Ausbildung', reason: 'seniority', match: 'substring' },
    { name: 'Auszubildende', reason: 'seniority', match: 'substring' },
    { name: 'Azubi', reason: 'seniority', match: 'substring' },
    { name: 'Duales Studium', reason: 'seniority', match: 'substring' },
    { name: 'Dualer Student', reason: 'seniority', match: 'substring' },
    { name: 'Studentische Hilfskraft', reason: 'seniority', match: 'substring' },
    { name: 'Praktikum', reason: 'seniority', match: 'substring' },
    { name: 'Praktikant', reason: 'seniority', match: 'substring' },
    { name: 'Umschulung', reason: 'seniority', match: 'substring' },
    { name: 'Weiterbildung', reason: 'seniority', match: 'substring' },
  ],
};
const spec = deriveTitleFilter(TAX);

// Titles that must NEVER reach the tracker. The German ones are the point of
// the exercise: every one of them is a compound or inflection that
// word-boundary matching alone misses.
const MUST_BLOCK = [
  'Werkstudent Data Analytics (m/w/d)',
  'Werkstudentin Data Science',
  'Werkstudent*in Data Engineering',
  'Ausbildung zum Fachinformatiker Datenanalyse',
  'Ausbildungsplatz Data Analyst 2027',
  'Ausbildungsstelle Data Engineer',
  'Auszubildende:r Data Science',
  'Azubi Datenverarbeitung',
  'Duales Studium Data Science (B.Sc.)',
  'Dualer Student Data Engineering',
  'Studentische Hilfskraft Data Analytics',
  'Praktikum Data Engineering',
  'Praktikant Business Intelligence',
  'Umschulung zum Data Analyst',
  'Weiterbildung Data Science',
  'Data Analyst Internship',
  'Senior Data Engineer',
];

// Titles that must SURVIVE. The "International" cases are the regression that
// substring-matching "Intern" used to cause.
const MUST_PASS = [
  'International Data Analyst',
  'Internal Reporting Analyst',
  'International Graduate Data Engineer',
  'Data Engineer (m/w/d)',
  'Datenanalyst (m/w/d)',
];

test('deriveTitleFilter separates word-bounded and substring exclusions', () => {
  assert.ok(spec.negative.includes('Senior'), 'word-bounded terms live in negative');
  assert.ok(spec.negativeSubstring.includes('Werkstudent'), 'substring terms live in negativeSubstring');
});

test('blacklisted pre-graduate titles are blocked, including German compounds', () => {
  for (const title of MUST_BLOCK) {
    const hit = matchNegative(title, spec);
    assert.ok(hit, `should be blocked but passed: ${title}`);
  }
});

test('in-scope titles survive the negative gate', () => {
  for (const title of MUST_PASS) {
    const hit = matchNegative(title, spec);
    assert.equal(hit, null, `should have passed but was blocked by "${hit}": ${title}`);
  }
});

test('matchNegative returns the term that matched, for logging', () => {
  // Substring match returns the lowercased substring term.
  assert.equal(matchNegative('Ausbildungsplatz Data Analyst', spec), 'ausbildung');
  // Word-bounded match returns the original-cased term.
  assert.equal(matchNegative('Senior Data Engineer', spec), 'Senior');
  assert.equal(matchNegative('', spec), null);
  assert.equal(matchNegative(null, spec), null);
});
