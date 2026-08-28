// Pins the liveness classifier. Every case below is a posting that was
// misclassified in the pipeline, or one that must NOT start being.
//
// The asymmetry that governs this file: a false "dead" silently deletes a real
// opportunity, and a false "alive" only wastes a draft. So the withdrawable
// codes must fire on unambiguous evidence and nothing else — which is why the
// negative cases here matter more than the positive ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiveness, isWithdrawable } from './liveness-core.mjs';

const body = (s, n = 3000) => s + ' '.repeat(0) + 'x'.repeat(n);

test('LinkedIn states expiry in the redirect, not the body', () => {
  // APP-3431 (King) sat in the pipeline as alive on a 30,705-char body. The
  // body was a normal search-results page with no expiry wording anywhere; the
  // ONLY signal was the 301 target's query string. Length checks, apply-text
  // checks and expired-phrase checks all pass on a page like this.
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.linkedin.com/jobs/senior-data-engineer-jobs?trk=expired_jd_redirect',
    bodyText: body('Senior Data Engineer jobs', 30000),
  });
  assert.equal(r.code, 'expired_url');
  assert.ok(isWithdrawable(r.code));
});

test('LinkedIn expired shell is a results page, not an advert', () => {
  // APP-4425 (Awaze), 38,367 chars. Serving MORE content than a real advert is
  // exactly why size cannot be a liveness signal.
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://www.linkedin.com/jobs/view/4441802908',
    bodyText: body("1,000+ jobs in United States. You've viewed all jobs for this search", 38000),
  });
  assert.equal(r.code, 'listing_page');
  assert.ok(isWithdrawable(r.code));
});

test('an explicit dead-advert phrase is withdrawable', () => {
  for (const phrase of [
    'This job is no longer available',
    'no longer accepting applications',
    'This position has been filled',
    'Dieses Stellenangebot existiert nicht',
  ]) {
    const r = classifyLiveness({ status: 200, finalUrl: 'https://x/y', bodyText: body(phrase) });
    assert.ok(isWithdrawable(r.code), `${phrase} -> ${r.code}`);
  }
});

test('410 and 404 are withdrawable', () => {
  assert.ok(isWithdrawable(classifyLiveness({ status: 410, finalUrl: 'https://x/y', bodyText: '' }).code));
  assert.ok(isWithdrawable(classifyLiveness({ status: 404, finalUrl: 'https://x/y', bodyText: '' }).code));
});

test('a bot-wall is never withdrawable', () => {
  // eFinancialCareers serves a 124-char "Scheduled Maintenance" shell to every
  // headless fetcher while rendering normally in a logged-in browser, and
  // Indeed answers 401. On 2026-08-23 all 13 unreadable rows in the sweep were
  // eFC, and EIGHT of them were fully live. Treating unreadable as dead would
  // have deleted eight real applications.
  const shell = classifyLiveness({ status: 200, finalUrl: 'https://www.efinancialcareers.co.uk/jobs-x.id1', bodyText: 'Scheduled Maintenance' });
  assert.equal(shell.code, 'insufficient_content');
  assert.ok(!isWithdrawable(shell.code));

  const walled = classifyLiveness({ status: 401, finalUrl: 'https://uk.indeed.com/viewjob?jk=1', bodyText: 'x'.repeat(400) });
  assert.ok(!isWithdrawable(walled.code));
});

test('a healthy advert is never withdrawable', () => {
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    bodyText: body('Analytics Engineer at Acme. We are looking for...'),
    applyControls: ['Apply now'],
  });
  assert.equal(r.result, 'active');
  assert.ok(!isWithdrawable(r.code));
});

test('a real advert that merely mentions other jobs is not a listing page', () => {
  // The listing-page patterns must key on wording that can only terminate a
  // results list. A live advert linking to a careers page must survive.
  const r = classifyLiveness({
    status: 200,
    finalUrl: 'https://careers.acme.com/jobs/1',
    bodyText: body('Data Engineer. See all our open jobs and apply below.'),
    applyControls: ['Apply'],
  });
  assert.ok(!isWithdrawable(r.code));
});
