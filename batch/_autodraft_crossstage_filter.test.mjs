// Pins the city/company normalisation that the cross-stage branch guard depends on.
// Every case below models a collision that could ship (or nearly ship) a SECOND
// application to an employer already in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCity, normCompany, sameCompany, isPlaceholderCompany, isAgency, ageInDays, sameRole } from './_autodraft_crossstage_filter.mjs';

test('normCity: umlauts transliterate instead of being deleted', () => {
  // "München" stripped to "mnchen" would never match the LinkedIn "Munich"
  // spelling, downgrading a same-city collision to a soft warn.
  assert.equal(normCity('München'), 'munich');
  assert.equal(normCity('Munich, Bavaria, Germany'), 'munich');
  assert.equal(normCity('Köln'), 'cologne');
  assert.equal(normCity('Zürich, Switzerland'), 'zurich');
  assert.equal(normCity('Nürnberg'), 'nuremberg');
});

test('normCity: metro qualifiers collapse to the bare market', () => {
  // "London Area" vs "London" is one market, two applications.
  assert.equal(normCity('London Area, United Kingdom'), 'london');
  assert.equal(normCity('Greater London, England, United Kingdom'), 'london');
  assert.equal(normCity('City of London'), 'london');
  assert.equal(normCity('London, England, United Kingdom'), 'london');
});

test('normCity: a country-level location is NOT a readable city', () => {
  // Must return '' so the caller hard-blocks. A location field that reads
  // "Germany" otherwise looks like a distinct office from every named city.
  assert.equal(normCity('Germany'), '');
  assert.equal(normCity('United Kingdom'), '');
  assert.equal(normCity('Deutschland'), '');
  assert.equal(normCity('Remote'), '');
  assert.equal(normCity(''), '');
});

test('normCity: real cities still survive', () => {
  assert.equal(normCity('Berlin, Germany'), 'berlin');
  assert.equal(normCity('Manchester, England, United Kingdom'), 'manchester');
  assert.equal(normCity('Frankfurt am Main'), 'frankfurt');
  assert.equal(normCity('Hamburg'), 'hamburg');
});

test('normCompany / sameCompany: legal-form noise does not split an employer', () => {
  assert.ok(sameCompany(normCompany('1KOMMA5°'), normCompany('1KOMMA5° GmbH')));
  assert.ok(sameCompany(normCompany('Immediate'), normCompany('Immediate Media Co')));
  // Unrelated employers must stay apart, and containment is prefix-only so a
  // shared trailing word cannot merge two companies.
  assert.ok(!sameCompany(normCompany('Example Retail'), normCompany('Sample Travel')));
  assert.ok(!sameCompany(normCompany('Sony Interactive'), normCompany('Interactive Brokers')));
});

test('normCompany: a consumer brand resolves to its legal entity', () => {
  // "Sony Interactive Entertainment" and "PlayStation" is one employer.
  // Containment cannot see it — the two names share no token.
  assert.ok(sameCompany(normCompany('PlayStation'), normCompany('Sony Interactive Entertainment')));
  assert.ok(sameCompany(normCompany('Sony Interactive Entertainment'), normCompany('PlayStation')));
});

test('normCity: a UK postcode does not split a city from itself', () => {
  // Indeed writes "London EC4V". The a-z strip turned that into "london ec v",
  // which never equalled the plain "london" every other portal writes.
  assert.equal(normCity('London EC4V'), 'london');
  assert.equal(normCity('London EC1A 1BB'), 'london');
  assert.equal(normCity('Manchester M1 4BT, United Kingdom'), 'manchester');
  // A city whose own name would match the outcode shape must survive: the
  // pattern requires a preceding word, so a bare token is never eaten.
  assert.equal(normCity('Bath'), 'bath');
  assert.equal(normCity('Frankfurt am Main'), 'frankfurt');
});

test('isPlaceholderCompany: an unnamed employer is not an employer', () => {
  // "Undisclosed (Indeed)" normalises to the ordinary-looking token
  // "undisclosed indeed", collides with nothing, and passes. A silent pass
  // can draft a second application to an employer already in flight.
  assert.ok(isPlaceholderCompany('Undisclosed (Indeed)'));
  assert.ok(isPlaceholderCompany('Undisclosed (Xing)'));
  assert.ok(isPlaceholderCompany('Confidential'));
  assert.ok(isPlaceholderCompany('LinkedIn posting'));
  assert.ok(isPlaceholderCompany(''));
  assert.ok(isPlaceholderCompany(null));
  // Real employers must not be swept up by it.
  assert.ok(!isPlaceholderCompany('Funding Circle'));
  assert.ok(!isPlaceholderCompany('Zalando SE'));
  assert.ok(!isPlaceholderCompany('N26'));
  assert.ok(!isPlaceholderCompany('Indeed'));            // Indeed itself hires.
  assert.ok(!isPlaceholderCompany('LinkedIn'));
});


test('isAgency: a consultancy is not one employer twice', () => {
  // An agency collision must warn, never block: one consultancy places for
  // many clients.
  assert.ok(isAgency('Harnham'));
  assert.ok(isAgency('Burns Sheehan'));
  assert.ok(isAgency('Morgan McKinley'));
  assert.ok(!isAgency('Placeholder GmbH'));
  assert.ok(!isAgency('Zalando'));
  assert.ok(!isAgency(''));
});

test('ageInDays: unknown is null, never "long ago"', () => {
  // Guessing stale is what lets a duplicate through; guessing fresh only costs
  // a line in a report. So an unknown date must be null and treated in-window.
  assert.equal(ageInDays('2026-08-21', '2026-08-28'), 7);
  assert.equal(ageInDays('2026-08-28', '2026-08-28'), 0);
  assert.equal(ageInDays(null, '2026-08-28'), null);
  assert.equal(ageInDays('', '2026-08-28'), null);
  assert.equal(ageInDays('not-a-date', '2026-08-28'), null);
});


test('sameRole: employer + city is not enough to call something a duplicate', () => {
  // Data ANALYST vs Data ENGINEER, Analytics Engineer vs Data Scientist,
  // Data Engineer vs Data Analyst — three distinct openings at one employer
  // must not read as duplicates.
  assert.equal(sameRole(['Data Analyst'], ['Data Engineer']), false);
  assert.equal(sameRole(['Analytics Engineer'], ['Data Scientist']), false);
  assert.equal(sameRole(['Data Scientist'], ['Data Scientist']), true);
  assert.equal(sameRole(['Data Analyst', 'BI Engineer'], ['BI Engineer']), true);
  // UNKNOWN must be null, not false. Returning false would rescue every
  // untagged row from the block and quietly disable the filter; the caller
  // treats null as "cannot tell" and keeps the old employer+city behaviour.
  assert.equal(sameRole([], ['Data Engineer']), null);
  assert.equal(sameRole(['Data Engineer'], []), null);
  assert.equal(sameRole(undefined, undefined), null);
  // Case and whitespace are scanner noise, not a difference of role.
  assert.equal(sameRole([' data engineer '], ['Data Engineer']), true);
});
