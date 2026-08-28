// Pins the portal-chrome stripper and, through it, gap detection.
//
// WHY THIS FILE EXISTS. Full-page LinkedIn scrapes append a "Similar jobs"
// footer that lists OTHER adverts. A word-boundary hit on a tech name from a
// neighbouring listing was becoming a gap disclosed in THIS letter — the
// generated cover letter would confess a Scala gap against a posting that
// never mentioned Scala. Volunteering a gap the employer never asked about is
// pure downside, which is why this is a test and not a comment.
//
// This is NOT a substring bug (e.g. Scala inside "scalable"). termHit fixed
// that separately and still handles it — pinned below so a future change
// cannot quietly undo one while fixing the other. Word-boundary matching is
// the right tool and it cannot help when the text does not belong to the
// advert.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { stripPortalChrome, scoreMatch } = require('./match');

// scripts/cover-letters/lib/ -> repo root. cv_master.json lives at
// scripts/cv/cv_master.json when present; a fresh clone may not have it, in
// which case this test short-circuits rather than fabricating a fixture.
const CV_MASTER = path.resolve(__dirname, '..', '..', 'cv', 'cv_master.json');
if (!fs.existsSync(CV_MASTER)) {
  console.log('  ⚠ skipped — cv_master.json absent (fresh clone)');
  process.exit(0);
}
const cvMaster = JSON.parse(fs.readFileSync(CV_MASTER, 'utf8'));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// Long enough to clear MIN_BODY_CHARS, so the cut is allowed to happen.
const BODY = 'We are hiring a Data Analyst. '.repeat(12)
  + 'You will use SQL and Python daily and build dashboards for stakeholders.';
const FOOTER = '\n\n### Similar jobs nearby\n\nScala Developer at Acme\n'
  + 'Kafka Engineer at Beta\nRust Systems Engineer at Gamma\n';

console.log('\n=== portal chrome is removed before matching ===');
check('polluted advert yields NO invented gaps',
  scoreMatch(BODY + FOOTER, cvMaster).gaps.map(g => g.jd_term), []);
check('footer content is gone', /Scala Developer/.test(stripPortalChrome(BODY + FOOTER)), false);
check('advert body survives', /dashboards for stakeholders/.test(stripPortalChrome(BODY + FOOTER)), true);
check('earliest marker wins when several appear',
  /Kafka/.test(stripPortalChrome(BODY + '\n\nPeople also viewed\nKafka Engineer\n\nMore searches\nScala Dev')), false);

console.log('\n=== each marker variant ===');
for (const [label, marker] of [
  ['People also viewed', '\n\nPeople also viewed\n\nKafka Engineer at Beta'],
  ['More searches', '\n\nMore searches\n\nKafka Engineer at Beta'],
  ['Referrals increase', '\n\nReferrals increase your chances\n\nKafka Engineer at Beta'],
  ['Get notified about new', '\n\nGet notified about new Kafka Engineer jobs'],
  ['Recommended for you', '\n\nRecommended for you\n\nKafka Engineer at Beta'],
  ['More jobs from', '\n\nMore jobs from Beta\n\nKafka Engineer'],
]) check(label, /Kafka/.test(stripPortalChrome(BODY + marker)), false);

console.log('\n=== the stripper must not damage a real advert ===');
// A genuine requirement still has to surface. Silencing real gaps would be a
// worse failure than the one being fixed: the candidate would find out at
// interview.
check('a REAL Scala requirement is still disclosed',
  scoreMatch(BODY + ' You must know Scala.', cvMaster).gaps.map(g => g.jd_term), ['Scala']);
check('a REAL Kafka requirement is still disclosed',
  scoreMatch(BODY + ' Kafka experience required.', cvMaster).gaps.map(g => g.jd_term), ['Kafka']);
check('text with no marker is returned unchanged', stripPortalChrome(BODY) === BODY, true);
check('empty input does not throw', stripPortalChrome('') === '', true);
check('null input does not throw', stripPortalChrome(null) === '', true);

// A marker in the first 200 characters means a bad scrape or a false positive.
// Cutting there would turn a real advert into an empty one, which fails silently
// and is worse than the pollution it would prevent.
check('marker inside the first 200 chars does NOT truncate',
  stripPortalChrome('Similar jobs\nReal advert text follows and is long enough to matter.').length > 40, true);

console.log('\n=== substring regressions stay fixed ===');
check('"scalable" is not a Scala gap',
  scoreMatch(BODY + ' Build scalable transformation layers.', cvMaster).gaps.map(g => g.jd_term), []);
check('"robustness" is not a Rust gap',
  scoreMatch(BODY + ' We value robustness.', cvMaster).gaps.map(g => g.jd_term), []);

console.log(`\n${failures ? '✗' : '✓'} match.test.js: ${failures} failure(s)\n`);
process.exit(failures ? 1 : 0);
