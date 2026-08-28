// letter-gates.test.js — guards on the four hiring-manager-readability gates.
// Pure unit test, no network, no LLM.
// Run: node scripts/cover-letters/lib/letter-gates.test.js
//
// The gates come from four counts on a weak generated letter; thresholds were
// calibrated over 753 real letters. See the header of letter-gates.js.
'use strict';
const { runLetterGates, analyseDeficitOrder, technicalTerms, MAX_DISTINCT_TECH } = require('./letter-gates');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}
const wrap = (body, de = false) =>
  `${de ? 'Sehr geehrte Damen und Herren,' : 'Dear Hiring Team,'}\n\n${body}\n\n${de ? 'Mit freundlichen Grüßen' : 'Best regards'}\nJane Doe`;
const codes = (r) => r.failures.map(f => f.code).sort();

// Padding so short fixtures clear the 60-word minimum without adding signal.
// It must contain NO tech term, impact phrase, why-signal, deficit or
// adaptability word, or it would contaminate the fixture it is padding.
const FILLER = 'This sentence exists purely to bring the fixture above the minimum body length that the gate requires before it will judge anything at all, and it deliberately avoids every marker the four checks look for, so that whatever the fixture is testing remains the only real signal present in the text under examination.';

// ── weak vs strong letter, anonymized ────────────────────────────────
// V1_BAD trips all four gates: many distinct tech terms, no motivation/why,
// no impact wording, and deficits led before any adaptability.
const V1_BAD = `I am writing to apply for the Data Scientist role with Example Corp in Berlin.

In a previous role I ran dbt models, pytest suites and GitHub Actions CI end to end, orchestrating pipelines on Dagster, loading a PostgreSQL warehouse, running survival analysis and gradient-boosted classification with SHAP and serving it through a FastAPI service.

Two gaps I would rather state than gloss. I have not built a RAG system, and my modelling is scikit-learn rather than PyTorch. My German is B1 and improving, below the B2 you ask for.`;

// V3_GOOD passes: leads with why the employer, states impact, keeps tech light,
// and lands the caveats last after adaptability wording.
const V3_GOOD = `I am writing to apply for the Data Scientist role with Example Corp in Berlin. I make data trustworthy, then I make it predictive.

Why Example Corp in particular: an operational scale where small data-quality problems compound quickly, and a public commitment to acting on that data. I would rather work on data that moves the operation than data that only moves reports.

In a first year I would want to take prototypes that already work and make them something operations can depend on daily.

On fit, my most recent build was one project carried from raw data to a working service, learning each layer as I reached it. My modelling has been in scikit-learn rather than PyTorch, and my German is B1 moving towards B2.

What I am looking for is a data team treated as a product team.`;

console.log('\n=== the two anonymized letters ===');
check('v1 fails all four gates', codes(runLetterGates(wrap(V1_BAD), { company: 'Example Corp' })),
  ['CL_DEFICIT_LED', 'CL_NO_IMPACT', 'CL_NO_MOTIVATION', 'CL_TOO_TECHNICAL']);
check('v3 passes', runLetterGates(wrap(V3_GOOD), { company: 'Example Corp' }).pass, true);

console.log('\n=== CL_DEFICIT_LED is about ORDER, not volume ===');
// Both paragraphs disclose the SAME two facts.
const DEFICIT_FIRST = `My modelling has been in scikit-learn rather than PyTorch and my German is below the B2 you ask for. I have not built a RAG system either. I would learn what I need. ${FILLER}`;
const ADAPT_FIRST = `My most recent build was one project carried end to end, learning each layer as I reached it. My modelling has been in scikit-learn rather than PyTorch and my German is below the B2 you ask for. ${FILLER}`;
check('deficits before adaptability -> flagged',
  codes(runLetterGates(wrap(DEFICIT_FIRST), { company: 'Example Corp' })).includes('CL_DEFICIT_LED'), true);
check('same facts, adaptability first -> clean',
  codes(runLetterGates(wrap(ADAPT_FIRST), { company: 'Example Corp' })).includes('CL_DEFICIT_LED'), false);

// Regression: the first rule counted deficits and checked only that SOME
// adaptability word existed somewhere in the paragraph. A gap paragraph with
// two deficits and the word "improving" could pass a gate written to catch it.
const ANNOUNCED = `Two gaps I would rather state than gloss. I have not built a RAG system. My German is B1 and improving. ${FILLER}`;
check('gap ANNOUNCEMENT flagged even though "improving" appears later',
  codes(runLetterGates(wrap(ANNOUNCED), { company: 'Example Corp' })).includes('CL_DEFICIT_LED'), true);

console.log('\n=== analyseDeficitOrder unit behaviour ===');
check('clean paragraph is not led', analyseDeficitOrder('I shipped models that lifted conversion by 15%.', 0).led, false);
check('announcement sets announced', analyseDeficitOrder('Two gaps I would name.', 0).announced, true);
check('single deficit alone is not enough', analyseDeficitOrder('My German is below the B2 you ask for.', 0).led, false);

console.log('\n=== CL_TOO_TECHNICAL ===');
check('counts DISTINCT terms, not repeats', technicalTerms('dbt dbt dbt dbt dbt dbt dbt dbt').length, 1);
const sixTech = `I work with dbt, Airflow, Snowflake, Python, SQL and Docker every day in a role I enjoy. ${FILLER}`;
check(`${MAX_DISTINCT_TECH} distinct terms is allowed`,
  codes(runLetterGates(wrap(sixTech), { company: 'Example Corp' })).includes('CL_TOO_TECHNICAL'), false);
const sevenTech = `I work with dbt, Airflow, Snowflake, Python, SQL, Docker and Kafka every day in a role I enjoy. ${FILLER}`;
check(`${MAX_DISTINCT_TECH + 1} distinct terms is flagged`,
  codes(runLetterGates(wrap(sevenTech), { company: 'Example Corp' })).includes('CL_TOO_TECHNICAL'), true);

console.log('\n=== CL_NO_MOTIVATION needs a reason AND the company named ===');
const whyNoCompany = `What I am looking for is a data team treated as a product team where quality matters. ${FILLER}`;
check('why-signal but company never named -> flagged',
  codes(runLetterGates(wrap(whyNoCompany), { company: 'Zalando' })).includes('CL_NO_MOTIVATION'), true);
const whyWithCompany = `What I am looking for is a data team treated as a product team, and Zalando reads that way. ${FILLER}`;
check('why-signal plus company named -> clean',
  codes(runLetterGates(wrap(whyWithCompany), { company: 'Zalando' })).includes('CL_NO_MOTIVATION'), false);
check('unknown company does not fail a check we cannot make',
  codes(runLetterGates(wrap(whyNoCompany), {})).includes('CL_NO_MOTIVATION'), false);

console.log('\n=== German letters use German markers ===');
const deGood = `Warum gerade Ihr Team: Sie behandeln Daten als Produkt. In den ersten Monaten möchte ich die Datenqualität messbar machen und mich hier einbringen. Bei Zalando reizt mich genau diese Richtung, und ich habe mich schnell eingearbeitet. ${FILLER}`;
check('German letter with why + impact passes those two',
  codes(runLetterGates(wrap(deGood, true), { company: 'Zalando' }))
    .filter(c => c === 'CL_NO_IMPACT' || c === 'CL_NO_MOTIVATION'), []);

console.log('\n=== edge cases ===');
check('no body at all', codes(runLetterGates('just some text with no salutation')), ['CL_GATE_NO_BODY']);
check('too short to judge', codes(runLetterGates(wrap('Hi.'))), ['CL_GATE_NO_BODY']);

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} letter-gates.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
