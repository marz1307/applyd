// Router test against the two synthetic fixtures from
// cover-letter-router-test-fixtures.md. Pure unit test — no network.
'use strict';
const { route } = require('./router');

const POSTING_A = `
Analytics Engineer (m/w/d)
Meridian Versicherungsgruppe AG · München, Deutschland · Vollzeit · Referenz: MER-DE-2026-0142

Über uns
Die Meridian Versicherungsgruppe AG mit Sitz in München gehört mit rund 4.000 Mitarbeitenden zu den etablierten Komposit- und Lebensversicherern im deutschsprachigen Raum.

Deine Aufgaben
- Du entwickelst und pflegst unsere dbt-Modelle.
- Du orchestrierst Pipelines.
- Du etablierst Datenqualitäts- und Teststandards.

Dein Profil
- Sehr gute Kenntnisse in SQL und Python
- Fundierte Erfahrung mit dbt und dimensionaler Modellierung (Kimball)
- Produktionserfahrung mit Snowflake
- Deutsch mindestens auf B2-Niveau, gutes Englisch

Bewerbung
Bitte senden Sie uns Ihre vollständigen Bewerbungsunterlagen (Anschreiben, Lebenslauf und relevante Zeugnisse). Bitte geben Sie Ihre Gehaltsvorstellung sowie Ihren frühestmöglichen Eintrittstermin an.
`;

const POSTING_B = `
Analytics Engineer
Nimbus Data GmbH · Berlin, Germany · Full-time · English-speaking team

About us
Nimbus Data GmbH is a Berlin-based B2B SaaS company. Our product, Nimbus Pulse, gives revenue teams a real-time view of product usage and account health. We are ~120 people, we work in English, and we closed a €22M Series A in March 2026.

What you'll do
- Build and own dbt models across staging, intermediate, and marts on our BigQuery warehouse.
- Run and extend our Dagster orchestration; keep pipelines tested and reliable.
- Expose curated data to the product through our internal FastAPI service.

What we are looking for
- Strong SQL and Python
- Solid dbt and dimensional modelling
- Experience with Dagster or Airflow
- BigQuery a plus
- Fluent English (German not required)

How to apply
Send your CV and, if you would like, a few lines on why this role interests you. We do not require a formal cover letter. English only.
`;

const EXPECTED_A = {
  market: 'DE',
  letter_language: 'de',
  letter_form: 'din5008_de',
  cover_letter_required: true,
  salary_required: true,
  salary_convention: '12-month',
  german_language_gate: true,
  requires_native_proofread: true,
};

const EXPECTED_B = {
  market: 'DE',
  letter_language: 'en',
  letter_form: 'din5008_en',
  cover_letter_required: false,
  salary_required: false,
  salary_convention: '12-month',
  german_language_gate: false,
  requires_native_proofread: false,
};

function assertEqual(actual, expected, label) {
  const fails = [];
  for (const k of Object.keys(expected)) {
    if (actual[k] !== expected[k]) fails.push(`  ✗ ${k}: expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(actual[k])}`);
  }
  if (fails.length === 0) console.log(`✓ ${label} — all assertions pass`);
  else { console.log(`✗ ${label}`); for (const f of fails) console.log(f); }
  return fails.length === 0;
}

console.log('\n=== Fixture A: DE-German posting (RULE 1) ===');
const routeA = route({ appId: 'TEST-A-meridian', postingText: POSTING_A });
console.log(JSON.stringify(routeA, null, 2));
const okA = assertEqual(routeA, EXPECTED_A, 'Fixture A');

console.log('\n=== Fixture B: DACH-English posting (RULE 2) ===');
const routeB = route({ appId: 'TEST-B-nimbus', postingText: POSTING_B });
console.log(JSON.stringify(routeB, null, 2));
const okB = assertEqual(routeB, EXPECTED_B, 'Fixture B');

console.log('\n=== Fixture C (synthetic): UK English posting (RULE 3) ===');
const POSTING_C = `Analytics Engineer at Acme UK Ltd, London. We are looking for a strong SQL and Python data person. About us: we run dbt on Snowflake. Apply on Greenhouse.`;
const routeC = route({ appId: 'TEST-C-acme', postingText: POSTING_C, country: 'United Kingdom' });
console.log(JSON.stringify(routeC, null, 2));
// anglo_full retired 2026-07-01 — English-market letters route to din5008_en.
const okC = assertEqual(routeC, { market: 'UK', letter_language: 'en', letter_form: 'din5008_en', german_language_gate: false }, 'Fixture C');

console.log('\n=== Fixture D (synthetic): AT-German posting (RULE 1 + AT) ===');
const POSTING_D = `Data Engineer (m/w/d), Vienna, Österreich. Über uns: Wir sind ein wachsendes Unternehmen in Wien. Deine Aufgaben: Datenpipelines bauen. Dein Profil: SQL, Python, dbt. Bitte geben Sie Ihre Gehaltsvorstellung an.`;
const routeD = route({ appId: 'TEST-D-AT', postingText: POSTING_D });
console.log(JSON.stringify(routeD, null, 2));
const okD = assertEqual(routeD, { market: 'AT', letter_language: 'de', letter_form: 'din5008_de', salary_convention: '14-month', german_language_gate: true }, 'Fixture D');

if (okA && okB && okC && okD) {
  console.log('\n✓ All router fixtures pass.');
  process.exit(0);
} else {
  console.log('\n✗ Some fixtures failed.');
  process.exit(1);
}
