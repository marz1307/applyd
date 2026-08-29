// research.test.js — guards on the soft-404 / path-discovery layer.
// Pure unit test, no network. Run: node cover-letters/lib/research.test.js
//
// Why this file exists (2026-08-09): research.js probed bare extensionless
// paths (/about, /imprint, /careers) and had no way to notice when they came
// back as a styled "page not found" shell with an HTTP 200. On APP-4916 all
// eight group.dhl.com probes hit that shell — DHL serves /en/about-us.html —
// and the brief came back empty with nothing recording why. Measured across
// the probe cache, 20% of real-employer probes were error shells.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {
  looksLikeErrorPage, clusteredShellLengths, discoverUrls, harvestLinks, topicOf,
  extractPostalAddress,
  resolveCompanyDomain, deriveCompanyUrl, companyMatchesDomain,
  normaliseCompanyToken, domainLabel,
  serpCompanyDomain, domainsFromSerpHtml,
} = require('./research');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}

console.log('\n=== looksLikeErrorPage ===');
check('plain 404 heading', looksLikeErrorPage('# 404\n\nThe page you want is gone.'), true);
check('english "page not found"', looksLikeErrorPage('Nav\n\nPage not found\n\nFooter'), true);
check('german "Seite nicht gefunden"', looksLikeErrorPage('Navigation\n\nSeite nicht gefunden'), true);
check('self-referential /error/404 link', looksLikeErrorPage('[DE](https://group.dhl.com/de/error/404.html)'), true);
check('<title> carries the marker', looksLikeErrorPage('body copy', '<title>404 - Not Found</title>'), true);
check('real about page is not an error', looksLikeErrorPage(
  'DHL Group employs around 600,000 people in over 220 countries and territories. Revenue in 2024 was EUR 84.2 billion.'), false);
// Regression: "404" deep in a legitimate article must not trip the check —
// only the HEAD of the document is inspected.
check('404 mentioned far down a real page', looksLikeErrorPage(
  'Engineering blog. '.repeat(400) + ' we return a 404 when the record is absent'), false);

console.log('\n=== clusteredShellLengths ===');
// The real group.dhl.com numbers from data/.tmp/fc-cl/ — a 0.02% spread.
check('DHL shell lengths cluster', clusteredShellLengths([34351, 34357, 34349, 34355, 34355]), true);
check('genuinely different pages do not', clusteredShellLengths([4200, 18300, 9100, 31000]), false);
check('needs at least 3 samples', clusteredShellLengths([34351, 34357]), false);
check('empty input is safe', clusteredShellLengths([]), false);
check('non-array is safe', clusteredShellLengths(null), false);

console.log('\n=== topicOf: localised and extensioned URL shapes ===');
// Each of these 404'd under the old bare-path assumption.
check('/en/about-us.html', topicOf('https://group.dhl.com/en/about-us.html'), 'about');
check('/de/ueber-uns', topicOf('https://x.de/de/ueber-uns'), 'about');
check('/karriere', topicOf('https://x.de/karriere'), 'careers');
check('/stellenangebote', topicOf('https://x.de/stellenangebote'), 'careers');
check('/newsroom', topicOf('https://x.com/newsroom'), 'blog');
check('bare /about still works', topicOf('https://x.com/about'), 'about');
check('unrelated path is null', topicOf('https://x.com/pricing'), null);

console.log('\n=== harvestLinks ===');
const HOME = `
  <a href="/en/about-us.html">About us</a>
  <a href="/en/careers.html">Careers</a>
  <a href="https://other-domain.com/about">Offsite</a>
  <a href="/en/about-us.html">Duplicate</a>
  <a href="#anchor">Anchor</a>
`;
check('same-origin only, deduped, anchors dropped',
  harvestLinks(HOME, 'https://group.dhl.com'),
  ['https://group.dhl.com/en/about-us.html', 'https://group.dhl.com/en/careers.html']);
check('no html returns empty', harvestLinks('', 'https://group.dhl.com'), []);
check('no base returns empty', harvestLinks(HOME, ''), []);

console.log('\n=== discoverUrls: observed links beat guesses ===');
const found = discoverUrls('https://group.dhl.com', '', HOME);
check('real /en/about-us.html is discovered', found.includes('https://group.dhl.com/en/about-us.html'), true);
// Stronger than "observed ranks first": once a real about page is known, the
// guessed /about is dropped outright. Probing it would be the exact 404 this
// rewrite exists to prevent, and it would burn a slot in the 6-probe budget.
// Array-element equality via .some(===) rather than .includes() so CodeQL does
// not read these fixture URLs as an incomplete URL-substring sanitizer — `found`
// is Array<string> and each check is exact whole-URL match, not substring.
check('redundant /about guess is dropped, not just outranked', found.some(u => u === 'https://group.dhl.com/about'), false);
check('redundant /careers guess is dropped too', found.some(u => u === 'https://group.dhl.com/careers'), false);
check('uncovered topics still get a guess', found.some(u => u === 'https://group.dhl.com/blog'), true);
check('observed links come first', found[0], 'https://group.dhl.com/en/about-us.html');
check('budget still capped at 6', found.length <= 6, true);

// The bug in one assertion: the JD page lives on the ATS host, so harvesting
// links from it can never find the employer's nav. Without homeHtml we are
// back to pure guessing.
const jdOnly = discoverUrls('https://group.dhl.com', '<a href="https://dhlconsulting.avature.net/careers">Jobs</a>', '');
check('ATS links on the JD page are not treated as employer links',
  jdOnly.some(u => u.includes('avature')), false);

check('no companyBase returns empty', discoverUrls('', '', ''), []);

// ── Company-domain resolution (2026-08-12) ──────────────────────────────
// Before this, deriveCompanyUrl returned the JOB URL's own origin for anything
// non-ATS. On a portal posting that is the portal's origin, every downstream
// guard then refused to scrape it, and the brief came back company_address:null
// with 0–1 facts — 7 of 7 rows on the 2026-08-12 auto-draft run.
//
// The dangerous direction is the opposite one: resolving to the WRONG company
// puts their Impressum address in the letter as the employer's. The refusal
// cases below matter more than the success cases.
console.log('\n=== normaliseCompanyToken / domainLabel ===');
check('legal forms stripped', normaliseCompanyToken('Bikeleasing-Service GmbH & Co. KG'), 'bikeleasingservice');
check('umlaut company keeps its letters dropped to alnum', normaliseCompanyToken('HORVÁTH & PARTNERS'), 'horvthpartners');
check('plain sld', domainLabel('https://www.bikeleasing.de/karriere'), 'bikeleasing');
check('co.uk is not the label', domainLabel('https://www.crewclothing.co.uk/jobs'), 'crewclothing');
check('bare host works', domainLabel('https://n26.com'), 'n26');

console.log('\n=== companyMatchesDomain ===');
check('exact', companyMatchesDomain('Statista', 'https://www.statista.com'), true);
check('legal form ignored', companyMatchesDomain('Statista GmbH', 'https://statista.com'), true);
check('brand inside longer domain', companyMatchesDomain('Wise', 'https://wise.com'), true);
check('hyphenated name vs joined domain', companyMatchesDomain('Bikeleasing-Service GmbH', 'https://bikeleasing.de'), true);
// The whole point: a different employer must not match.
check('different company refused', companyMatchesDomain('Statista', 'https://www.zalando.de'), false);
check('agency link refused', companyMatchesDomain('Michael Page', 'https://www.some-client.de'), false);
check('empty name refused', companyMatchesDomain('', 'https://statista.com'), false);

console.log('\n=== resolveCompanyDomain: tier order ===');
const LD = (org) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', hiringOrganization: org })}</script>`;

check('tier 1 jsonld url beats everything',
  resolveCompanyDomain('https://www.xing.com/jobs/berlin-data-engineer-123', LD({ name: 'Statista', url: 'https://www.statista.com/about' }), 'Statista'),
  { url: 'https://www.statista.com', source: 'jsonld' });
check('tier 1 accepts sameAs when url is absent',
  resolveCompanyDomain('https://www.xing.com/jobs/x-1', LD({ name: 'N26', sameAs: ['https://n26.com'] }), 'N26'),
  { url: 'https://n26.com', source: 'jsonld' });
// A portal that names ITSELF as the hiring org must not win.
check('tier 1 rejects a portal self-reference',
  resolveCompanyDomain('https://www.xing.com/jobs/x-1', LD({ name: 'XING', url: 'https://www.xing.com' }), 'XING').source,
  null);
check('tier 1 rejects a social profile',
  resolveCompanyDomain('https://www.xing.com/jobs/x-1', LD({ name: 'Acme', sameAs: ['https://www.linkedin.com/company/acme'] }), 'Acme').source,
  null);

check('tier 2 job-host: a company careers page is its own employer',
  resolveCompanyDomain('https://careers.statista.com/jobs/123', '', 'Statista'),
  { url: 'https://careers.statista.com', source: 'job-host' });

check('tier 3 canonical off the portal',
  resolveCompanyDomain('https://www.stepstone.de/stelle/x-1', '<link rel="canonical" href="https://www.devk.de/karriere/stelle"/>', 'DEVK'),
  { url: 'https://www.devk.de', source: 'canonical' });

check('tier 4 name-matching link in the JD body',
  resolveCompanyDomain('https://www.xing.com/jobs/x-1', '<a href="https://www.gema.de/karriere">Unsere Website</a>', 'GEMA'),
  { url: 'https://www.gema.de', source: 'jd-link' });
// The guard that stops tier 4 grabbing a partner/agency/CDN link.
check('tier 4 refuses a link that is not the company',
  resolveCompanyDomain('https://www.xing.com/jobs/x-1', '<a href="https://www.aws.amazon.com/partners">Our cloud partner</a>', 'GEMA').source,
  null);

console.log('\n=== resolveCompanyDomain: refuses to guess ===');
// The critical regression. A portal posting with no employer signal must
// return null, NOT "https://gema.com" — an unverified guess can resolve to a
// stranger's site and ship their postal address as the employer's.
check('portal posting with no signal resolves to nothing',
  resolveCompanyDomain('https://www.xing.com/jobs/muenchen-data-engineer-156134317', '<html><body>Apply now</body></html>', 'HIBA GmbH'),
  { url: null, source: null });
check('linkedin posting with no signal resolves to nothing',
  resolveCompanyDomain('https://www.linkedin.com/jobs/view/4441960667', '', 'N26'),
  { url: null, source: null });
check('efc posting with no signal resolves to nothing',
  resolveCompanyDomain('https://www.efinancialcareers.co.uk/jobs-UK-London-Data_Analyst.id123', '', 'Wise').source,
  null);
check('ATS host is never the employer',
  resolveCompanyDomain('https://dhlconsulting.avature.net/careers/JobDetail/123', '', 'DHL').source,
  null);
check('deriveCompanyUrl back-compat returns a bare string',
  deriveCompanyUrl('https://careers.statista.com/jobs/1', '', 'Statista'),
  'https://careers.statista.com');
check('deriveCompanyUrl back-compat returns null when unresolved',
  deriveCompanyUrl('https://www.xing.com/jobs/x-1', '', 'Acme'),
  null);

// ── Tier 5: SERP fallback (opt-in) ──────────────────────────────────────
// No network in this file. These pin the extraction, the verification guard,
// and — most importantly — that the tier stays OFF unless asked for, so a
// letter run can never start spending Bright Data credit by accident.
console.log('\n=== domainsFromSerpHtml ===');
const SERP_HTML = `
  <a href="https://www.gstatic.com/x.png">img</a>
  <a href="https://www.linkedin.com/company/zattoo">LinkedIn</a>
  <a href="https://www.glassdoor.de/Overview/zattoo.htm">Glassdoor</a>
  <a href="https://zattoo.com/de/karriere">Zattoo — Official Site</a>
  <a href="https://www.google.com/search?q=more">More</a>`;
const cands = domainsFromSerpHtml(SERP_HTML);
// Array-element equality via .some(===) rather than .includes() (same reason
// as the block above): exact whole-URL match on Array<string>, not substring.
check('CDN/social/portal results are stripped out', cands.some(u => u === 'https://www.gstatic.com'), false);
check('linkedin result stripped', cands.some(u => /linkedin/.test(u)), false);
check('glassdoor result stripped', cands.some(u => /glassdoor/.test(u)), false);
check('the real employer domain survives', cands.some(u => u === 'https://zattoo.com'), true);
check('empty html yields nothing', domainsFromSerpHtml(''), []);

// The verification guard is what stops a news article or a competitor's page
// becoming the "employer" — same rule tiers 3/4 use.
console.log('\n=== SERP results are name-verified ===');
check('a plausible but wrong result is refused',
  companyMatchesDomain('Zattoo Deutschland GmbH', 'https://www.heise.de/news/zattoo'), false);
check('the right one passes', companyMatchesDomain('Zattoo Deutschland GmbH', 'https://zattoo.com'), true);

// ── Address application is atomic (2026-08-12) ──────────────────────────
// Three sites used to fill company_address / _postal_code / _city one field at
// a time, each taking whatever source offered it first. Magna Tyres Group came
// back as "Kroonweg 12" (Netherlands HQ) + postal 11271 + city "Sur" (Middle
// East office) — one plausible-looking address assembled from two, headed for a
// DIN envelope. Same class as "20459 Hamburg".
//
// applyAddress is a closure over `brief` inside research(), so it is not
// exported; these tests pin the RULE it implements against a local twin. If you
// change the rule in research.js, change it here — a divergence means this file
// is guarding nothing.
// ── extractPostalAddress: blocks, not loose fields ──────────────────────
// THE REGRESSION, verbatim in shape from magnatyres.com/contact. Three
// independent whole-document regexes used to return Kroonweg 12 (NL) with
// postal 11271 + city Sur (Oman) as one address. The Dutch postcode is
// NL-format so the German 5-digit pattern skips it and the scan runs on into
// the next office.
console.log('\n=== extractPostalAddress: multi-office pages ===');
const MULTI_OFFICE = [
  'Magna Tyres Group', '', 'Kroonweg 12', '5915 PJ Venlo', 'The Netherlands', '',
  'Magna Tyres Middle East', '', 'Al Ainiya', '11271 Sur', 'Oman',
].join('\n');
const multi = extractPostalAddress(MULTI_OFFICE);
check('a street never pairs with another office\'s postal code', multi.postal_code, undefined);
check('nor with another office\'s city', multi.city, undefined);
check('the street itself is still returned', multi.street, 'Kroonweg 12');

// A single coherent German block must still resolve fully.
const single = extractPostalAddress(['PubliCare GmbH', 'Sachsenring 69', '50677 Köln', 'Deutschland'].join('\n'));
check('a coherent block returns all three fields',
  [single.street, single.postal_code, single.city], ['Sachsenring 69', '50677', 'Köln']);

const sameLine = extractPostalAddress('Anschrift: Hauptstraße 12, 10115 Berlin');
check('street and postal on one line still pair',
  [sameLine.street, sameLine.postal_code, sameLine.city], ['Hauptstraße 12', '10115', 'Berlin']);

// Impressum with the postal line two lines below (blank line between).
const gapped = extractPostalAddress(['Musterweg 3', '', '20459 Hamburg'].join('\n'));
check('a blank line between street and postal is tolerated',
  [gapped.street, gapped.postal_code, gapped.city], ['Musterweg 3', '20459', 'Hamburg']);

// Degradations must be partial, never fabricated.
check('postal+city with no street is returned alone',
  extractPostalAddress('Some page\n50829 Köln\nmore text'), { postal_code: '50829', city: 'Köln' });
check('street with no postal anywhere is returned alone',
  extractPostalAddress('Findusstraße 7\nno postcode here'), { street: 'Findusstraße 7' });
check('a UK postcode alone still resolves', extractPostalAddress('London EC2A 4NE').postal_code, 'EC2A 4NE');
check('nothing address-shaped returns null', extractPostalAddress('We are hiring engineers.'), null);
check('empty input returns null', extractPostalAddress(''), null);

console.log('\n=== address application: atomic, most-complete-wins ===');
const addrScore = (a) => (a && a.street ? 4 : 0) + (a && a.postal ? 2 : 0) + (a && a.city ? 1 : 0);
function makeApply() {
  const b = { street: null, postal: null, city: null, source: null };
  return {
    b,
    apply(cand, source) {
      const s = addrScore(cand);
      if (!s) return false;
      if (s <= addrScore(b)) return false;
      b.street = cand.street || null; b.postal = cand.postal || null; b.city = cand.city || null;
      b.source = source;
      return true;
    },
  };
}
// THE REGRESSION: the exact Magna Tyres shape. Two offices, applied in order.
const magna = makeApply();
magna.apply({ street: 'Kroonweg 12' }, 'office-NL');           // street only, score 4
magna.apply({ postal: '11271', city: 'Sur' }, 'office-OM');    // postal+city, score 3 → refused
check('a second office cannot graft its postal/city onto the first street',
  [magna.b.street, magna.b.postal, magna.b.city], ['Kroonweg 12', null, null]);
check('and the source stays the office the address came from', magna.b.source, 'office-NL');

// A strictly more complete candidate replaces wholesale, never merges.
const upgrade = makeApply();
upgrade.apply({ postal: '50829', city: 'Köln' }, 'jd-markdown');
upgrade.apply({ street: 'Sachsenring 69', postal: '50677', city: 'Köln' }, 'impressum');
check('a complete address replaces a partial one wholesale',
  [upgrade.b.street, upgrade.b.postal, upgrade.b.city], ['Sachsenring 69', '50677', 'Köln']);
check('replacement takes the new source', upgrade.b.source, 'impressum');

// A weaker candidate must not overwrite a stronger one.
const keep = makeApply();
keep.apply({ street: 'Sachsenring 69', postal: '50677', city: 'Köln' }, 'impressum');
keep.apply({ city: 'Berlin' }, 'jd-markdown');
check('a weaker candidate is refused entirely',
  [keep.b.street, keep.b.postal, keep.b.city], ['Sachsenring 69', '50677', 'Köln']);

const empty = makeApply();
check('an empty candidate changes nothing', empty.apply({}, 'x'), false);
check('scoring ranks street+postal+city above postal+city',
  addrScore({ street: 'a', postal: 'b', city: 'c' }) > addrScore({ postal: 'b', city: 'c' }), true);

// serpCompanyDomain is async, and this file is CJS — no top-level await.
(async () => {
  console.log('\n=== serpCompanyDomain: off unless opted in ===');
  const priorEnv = process.env.RESEARCH_SERP;
  delete process.env.RESEARCH_SERP;
  check('disabled by default returns null without touching the network',
    await serpCompanyDomain('Zattoo Deutschland GmbH'), { url: null, source: null });
  check('empty company name is a no-op even when forced',
    await serpCompanyDomain('', { force: true }), { url: null, source: null });
  if (priorEnv === undefined) delete process.env.RESEARCH_SERP; else process.env.RESEARCH_SERP = priorEnv;

  console.log(`\n${fail === 0 ? '✓' : '✗'} research.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
