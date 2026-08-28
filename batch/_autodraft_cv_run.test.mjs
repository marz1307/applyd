// Pins the pure helpers of _autodraft_cv_run.mjs.
//
// Each of these decisions has a specific damage mode:
//   pickLang / useDachFormat  — get either wrong and the wrong CV ships (a
//     German Lebenslauf for a UK role, a UK CV with no photo for a genuine
//     DACH English JD).
//   detectSeniorityAuto       — get this wrong and the CV opener claims a
//     seniority the employer did not ask for (mid framing on an ad addressed
//     to graduates, or grad framing on an ad explicitly labelled Professionals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLang, useDachFormat, isEnglishLocaleUrl, englishLocaleCountry,
  cvMarketCountry, looksGermanText, pickVariant, realCountry,
  detectSeniorityAuto, requiredYearsRange,
} from './_autodraft_cv_run.mjs';

test('pickLang: English-locale URL beats a mis-tagged DACH Country', () => {
  // A Country field wrongly set to Germany on a uk.linkedin.com posting must
  // still render an English CV, or the JD becomes a German Lebenslauf on a UK
  // role.
  assert.equal(pickLang('Germany', 'DE', 'https://uk.linkedin.com/jobs/x'), 'en');
  assert.equal(pickLang('Germany', 'German', 'https://acme.co.uk/careers/x'), 'en');
});

test('pickLang: DACH country + English JD stays English', () => {
  // The safe default for a DACH English JD is an English CV in DACH format.
  // German must be positively proven, not assumed from the country.
  assert.equal(
    pickLang('Germany', '', 'https://ashby.com/x',
             'The role requires strong SQL and Python; you will design and build pipelines with dbt.'),
    'en',
  );
});

test('pickLang: DACH country + German JD flips to German', () => {
  assert.equal(
    pickLang('Germany', '', 'https://ashby.com/x',
             'Sie werden mit dem Team an unseren Daten arbeiten, wir bieten flexible Arbeitszeiten und sehr viel Verantwortung.'),
    'de',
  );
});

test('pickLang: explicit Language field wins over JD text on DACH', () => {
  assert.equal(pickLang('Germany', 'DE', 'https://ashby.com/x', ''), 'de');
  assert.equal(pickLang('Germany', 'EN', 'https://ashby.com/x', ''), 'en');
});

test('pickLang: non-DACH default is English', () => {
  assert.equal(pickLang('France', '', 'https://acme.fr/careers/x'), 'en');
  assert.equal(pickLang('UK', 'EN', 'https://uk.linkedin.com/x'), 'en');
});

test('useDachFormat: DACH English JD gets DACH presentation', () => {
  assert.equal(useDachFormat('Germany', 'en', 'https://ashby.com/x'), true);
  assert.equal(useDachFormat('Austria', 'en', 'https://smartrecruiters.com/x'), true);
});

test('useDachFormat: an English-locale URL always suppresses DACH presentation', () => {
  // The URL wins even if the Country field is mis-tagged as DACH.
  assert.equal(useDachFormat('Germany', 'en', 'https://uk.linkedin.com/x'), false);
});

test('useDachFormat: German content renders as DE, not DACH-format-EN', () => {
  assert.equal(useDachFormat('Germany', 'de', 'https://ashby.com/x'), false);
});

test('useDachFormat: non-DACH country is never DACH-format', () => {
  assert.equal(useDachFormat('UK', 'en', 'https://uk.linkedin.com/x'), false);
  assert.equal(useDachFormat('France', 'en', 'https://ashby.com/x'), false);
});

test('cvMarketCountry: an English-locale URL overrides a mis-tagged DACH Country', () => {
  assert.equal(cvMarketCountry({ job_url: 'https://uk.linkedin.com/jobs/x' }, 'Germany'), 'UK');
  assert.equal(cvMarketCountry({ job_url: 'https://acme.ie/careers/x' }, 'Germany'), 'Ireland');
});

test('cvMarketCountry: without an override falls through to the resolved country', () => {
  assert.equal(cvMarketCountry({ job_url: 'https://ashby.com/x' }, 'Germany'), 'Germany');
  assert.equal(cvMarketCountry({ job_url: '' }, 'France'), 'France');
});

test('englishLocaleCountry: recognised English-locale hosts', () => {
  assert.equal(englishLocaleCountry('https://uk.linkedin.com/jobs/x'), 'UK');
  assert.equal(englishLocaleCountry('https://uk.indeed.com/x'), 'UK');
  assert.equal(englishLocaleCountry('https://acme.co.uk/careers/x'), 'UK');
  assert.equal(englishLocaleCountry('https://acme.gov.uk/x'), 'UK');
  assert.equal(englishLocaleCountry('https://ie.linkedin.com/x'), 'Ireland');
  assert.equal(englishLocaleCountry('https://acme.ie/careers'), 'Ireland');
  assert.equal(englishLocaleCountry('https://ashby.com/x'), null);
  assert.equal(englishLocaleCountry(''), null);
  assert.equal(englishLocaleCountry('not-a-url'), null);
});

test('isEnglishLocaleUrl mirrors englishLocaleCountry', () => {
  assert.equal(isEnglishLocaleUrl('https://uk.linkedin.com/x'), true);
  assert.equal(isEnglishLocaleUrl('https://ie.linkedin.com/x'), true);
  assert.equal(isEnglishLocaleUrl('https://ashby.com/x'), false);
});

test('looksGermanText: needs a clear German majority', () => {
  // Sparse German chrome around an English JD must not flip the verdict.
  assert.equal(
    looksGermanText('Please apply on our careers page. Impressum und Datenschutz.'),
    false,
  );
  assert.equal(
    looksGermanText('Sie werden mit dem Team an unseren Daten arbeiten, wir bieten flexible Arbeitszeiten und sehr viel Verantwortung.'),
    true,
  );
  assert.equal(looksGermanText(''), false);
  assert.equal(looksGermanText(null), false);
});

test('pickVariant: role families map to CV variants', () => {
  assert.equal(pickVariant(['Machine Learning Engineer']), 'me');
  assert.equal(pickVariant(['AI Engineer']), 'me');
  assert.equal(pickVariant(['Analytics Engineer']), 'ae');
  assert.equal(pickVariant(['Data Engineer']), 'de');
  assert.equal(pickVariant(['Data Analyst']), 'da');
  assert.equal(pickVariant('Data Scientist'), 'ds');
  assert.equal(pickVariant([]), 'master');
});

test('realCountry: eFC aggregator URL beats a mis-tagged Country field', () => {
  assert.equal(
    realCountry({ job_url: 'https://www.efinancialcareers.co.uk/jobs-united_kingdom-london-x.id1', country: 'Germany' }),
    'UK',
  );
  // Non-eFC hosts trust the Notion Country field.
  assert.equal(
    realCountry({ job_url: 'https://uk.linkedin.com/jobs/x', country: 'Germany' }),
    'Germany',
  );
});

test('detectSeniorityAuto: title carries the strongest signal', () => {
  assert.equal(detectSeniorityAuto({ role: 'Junior Data Analyst', position: [] }, ''), 'graduate');
  assert.equal(detectSeniorityAuto({ role: 'Senior Data Engineer', position: [] }, ''), 'senior');
  assert.equal(detectSeniorityAuto({ role: 'Data Engineer', position: [] }, ''), 'mid');
});

test('detectSeniorityAuto: German grad vocabulary in the body', () => {
  // Colon/asterisk/slash gender forms all reduce to the "absolvent" stem.
  assert.equal(detectSeniorityAuto({ role: 'Consultant', position: [] }, 'Absolvent:innen willkommen'), 'graduate');
  assert.equal(detectSeniorityAuto({ role: 'Consultant', position: [] }, 'Wir suchen Berufseinsteiger'), 'graduate');
  assert.equal(detectSeniorityAuto({ role: 'Consultant', position: [] }, 'Hochschulabsolventen mit Interesse an Daten'), 'graduate');
});

test('detectSeniorityAuto: seniority noise contexts are stripped', () => {
  // "junior" as the object of a mentoring verb is a senior signal, not a
  // graduate one.
  assert.equal(detectSeniorityAuto({ role: 'Data Engineer', position: [] },
    'You will mentor junior engineers on best practices.'), 'mid');
  // "senior" describing the TEAM, not the vacancy.
  assert.equal(detectSeniorityAuto({ role: 'Data Analyst', position: [] },
    'Report to a lead engineering team on progress.'), 'mid');
  // Inclusive phrasing that lists bands rather than requiring one.
  assert.equal(detectSeniorityAuto({ role: 'Data Analyst', position: [] },
    'Open to both mid-level and senior profiles with 2+ years.'), 'mid');
});

test('detectSeniorityAuto: closed bands below the mid threshold read as graduate', () => {
  assert.equal(detectSeniorityAuto({ role: 'Data Engineer', position: [] },
    'Looking for 1-2 years experience'), 'graduate');
  // A 2-3 band still names a professional band and stays mid.
  assert.equal(detectSeniorityAuto({ role: 'Data Engineer', position: [] },
    'Looking for 2-3 years experience'), 'mid');
});

test('detectSeniorityAuto: open floors never downgrade to graduate', () => {
  // "3+ years" and "at least 2 years" have no ceiling; the employer will
  // take more experience, so they cannot be a grad ad.
  assert.equal(detectSeniorityAuto({ role: 'Data Engineer', position: [] },
    '3+ years of professional experience required'), 'mid');
  assert.equal(detectSeniorityAuto({ role: 'Data Engineer', position: [] },
    'At least 2 years of relevant experience'), 'mid');
});

test('requiredYearsRange: closed bands set both ends; open floors set only min', () => {
  assert.deepEqual(requiredYearsRange('Looking for 2-4 years experience'), { min: 2, max: 4 });
  assert.deepEqual(requiredYearsRange('At least 3 years experience'), { min: 3, max: null });
  assert.deepEqual(requiredYearsRange('3+ years professional experience'), { min: 3, max: null });
  assert.deepEqual(requiredYearsRange('2 years of experience'), { min: 2, max: 2 });
  assert.deepEqual(requiredYearsRange('no numbers here'), { min: null, max: null });
});

test('requiredYearsRange: masking prevents the bare-figure pattern from stealing bounds', () => {
  // "at least 2 years experience" contains the substring "2 years
  // experience" — without masking, the bare-figure pattern would fire on
  // the leftover text and invent {min:2, max:2} instead of {min:2, max:null}.
  assert.deepEqual(requiredYearsRange('at least 2 years experience'), { min: 2, max: null });
  assert.deepEqual(requiredYearsRange('mindestens 2 Jahre Berufserfahrung'), { min: 2, max: null });
});
