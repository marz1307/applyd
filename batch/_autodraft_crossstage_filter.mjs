#!/usr/bin/env node
// Cross-stage branch dedup for the auto-draft selection step.
//
// WHY THIS EXISTS. `branch-dedup.mjs` enforces one-application-per-(company, city)
// but only *within* Stage 2 — it compares Triaged rows against each other. It
// does not look at rows that already advanced. Without this, top-scoring
// Stage-2 rows can collide with a Stage-3+ row at the same company and city:
// the routine drafts a SECOND application to an employer already targeted.
// Recruiters read that as scattershot.
//
// This filter is non-destructive on purpose: branch-dedup ARCHIVES losers to
// Notion Trash, and a cross-stage collision is not obviously a row to destroy
// (the Stage-3 row may yet be abandoned). So this only *skips* the row for
// tonight's selection and reports why. The row stays at Stage 2 for a human
// call.
//
// Company matching uses containment, not equality: "Immediate" vs "Immediate
// Media Co" is the same employer and would not match under exact
// normalisation.
//
// Usage: node batch/_autodraft_crossstage_filter.mjs [--json]
//   reads  data/.routine-tmp/draft-queue.json   (Stage-2, score>=floor, sentinel-missing)
//          data/.routine-tmp/all-rows.json      (full DB dump)
//   writes data/.routine-tmp/draft-queue-filtered.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readArtefactFilenames, resolveForRows } from './artefact-date.mjs';

const ROOT = process.cwd();
const TMP = path.join(ROOT, 'data', '.routine-tmp');
const readRows = (f) => {
  const q = JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8'));
  return Array.isArray(q) ? q : (q.rows || q.results || []);
};

// Stages that mean "an application to this employer is already in flight".
// Rejected / Withdrew are closed loops and do NOT block a fresh application by
// themselves — the recent-rejection gate below handles freshly closed loops.
const ACTIVE = /^(3\. Drafted|4\. Applied|5\.|6\.|7\.|8\.|9\.|Signed)/i;

// A RECENT rejection also blocks. Without this, a re-listed requisition can be
// drafted a second time within days of a rejection, and only caught later by
// recheck-collisions — one wasted draft. `Withdrew` is still ignored: those
// rows carry no apply date and no response date because the posting died
// before anything was sent, so there is nothing for a second application to
// collide with.
const REJECTED = /^Rejected$/i;
// Beyond this a closed loop is genuinely closed. Matches recheck-collisions.mjs,
// which owns the same rule at Stage 3; keep the two in step.
const REJECTION_WINDOW_DAYS = 90;

// Days between a YYYY-MM-DD string and today, or null when unknown. An unknown
// date must NOT read as "long ago": guessing stale is what lets a duplicate
// through, guessing fresh only costs a line in a report.
export function ageInDays(dateStr, today) {
  if (!dateStr) return null;
  const a = Date.parse(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(today + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Recruitment agencies and consultancies. A second vacancy through one
// consultancy is not a second application to one employer: the consultant
// places for many clients. Lives HERE rather than in recheck-collisions so both
// gates share ONE definition and cannot drift.
const AGENCY_RE = /^(harnham|burns sheehan|experis|tria\b|hays|robert half|michael page|page group|jobriver|headmatch|apsa|reed\b|adecco|randstad|hueman|oliver bernard|understanding recruitment|salt\b|la fosse|nigel frank|darwin recruitment|zealand|methods|xpert|sthree|huxley|computer futures|progressive recruitment|real staffing|morgan mckinley|solas it|xcede)/i;
export function isAgency(name) {
  return AGENCY_RE.test(String(name || '').trim());
}

// Two rows are the same OPENING only if the role matches too. The filter
// otherwise compares employer and city alone, which over-blocks: three
// distinct openings at the same employer (Data Analyst vs Data Engineer vs
// Analytics Engineer, etc.) can be reported as duplicates. Survivable while
// the filter only SKIPPED a row for one night; not survivable once a human
// reads the report and closes rows on the strength of it.
//
// `Position` is a coarse multi-select (Data Analyst / Data Engineer / Analytics
// Engineer / Data Scientist / ML Engineer / BI Engineer), so this is a cheap
// check, not a semantic one. UNKNOWN role on either side returns null, meaning
// 'cannot tell' — the caller must then fall back to the old employer+city
// behaviour rather than assume a match either way.
//
// `Position` IS OUR OWN TAG, NOT THE EMPLOYER'S TITLE, and it can disagree with
// the advert. It's ~99% reliable — good enough to STOP a block, not good enough
// to be the last word. Before anyone acts on a `different-role-keep` (closing
// a row, or standing one up as distinct), check the advert itself.
export function sameRole(aPositions, bPositions) {
  const norm = (p) => (Array.isArray(p) ? p : [p])
    .map((x) => String(x || '').toLowerCase().trim())
    .filter(Boolean);
  const a = norm(aPositions);
  const b = norm(bPositions);
  if (!a.length || !b.length) return null;          // cannot tell
  return a.some((x) => b.includes(x));
}

const LEGAL = /\b(gmbh|ag|ug|kg|se|mbh|co|kgaa|plc|ltd|limited|inc|llc|llp|bv|nv|sa|sarl|spa|aps|ab|oy|as|group|holding|deutschland|germany|uk|international|services|solutions|technologies|technology|tech)\b/g;

// Consumer brand -> legal entity, for employers the portals name inconsistently.
// Containment matching cannot bridge these: "PlayStation" shares no token with
// "Sony Interactive Entertainment". Add pairs as you meet them.
const BRAND_ALIAS = new Map([
  ['playstation', 'sony interactive entertainment'],
  ['sony interactive', 'sony interactive entertainment'],
]);

export function normCompany(name) {
  const n = String(name || '')
    .toLowerCase()
    .replace(/[&.,'’()\-\/]/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return BRAND_ALIAS.get(n) || n;
}

// A `Company` value that names no employer. Scanners write these on purpose
// when the portal hides the hiring company (better an honest placeholder than
// a wrong name), and `auto-eval`'s employer reconciliation is supposed to
// replace them from the JD's JSON-LD `hiringOrganization` before the row
// leaves Stage 2.
//
// WHY THIS IS A FIRST-CLASS CASE, not just "a name that matches nothing".
// A placeholder like "Undisclosed (Indeed)" normalises to an ordinary-looking
// token and collides with nothing, so a same-employer second application will
// pass. The filter does not fail loudly; it succeeds against a name that was
// not an employer. **You cannot dedup what you cannot name**, so an unresolved
// employer must HOLD the row, never silently pass it.
const PLACEHOLDER_COMPANY = [
  /^undisclosed\b/i,
  /^(confidential|unknown|not disclosed|n\/?a)\b/i,
  /\b(xing|linkedin|indeed|stepstone|efinancialcareers|wttj|careerbee) posting\b/i,
  /^(company|employer|arbeitgeber) (confidential|vertraulich)\b/i,
];
export function isPlaceholderCompany(name) {
  const raw = String(name || '').trim();
  if (!raw) return true;
  return PLACEHOLDER_COMPANY.some((re) => re.test(raw));
}

// The city, but '' when the `Location` field is really a fragment of the company
// name (e.g. a scanner split "Acme Analytical Software GmbH" across two fields
// and left "Software" in Location). A location that says nothing the company
// name does not already say is not a location, so return '' and let the
// caller's unreadable-city branch block.
export function readableCity(location, companyName) {
  const city = normCity(location);
  if (!city) return '';
  const company = normCompany(companyName);
  if (!company) return city;
  const companyTokens = new Set(company.split(' ').filter(Boolean));
  const cityTokens = city.split(' ').filter(Boolean);
  return cityTokens.every((t) => companyTokens.has(t)) ? '' : city;
}

// Locations that name a COUNTRY or a whole region rather than a city. The
// Notion `location` field is scanner-populated and often carries only
// "Germany" or "United Kingdom". Those must normalise to '' so the caller's
// "city we cannot read on either side" branch HARD-BLOCKS them: a
// country-level string cannot prove a different office.
const NON_CITY = new Set([
  'germany', 'deutschland', 'austria', 'osterreich', 'oesterreich', 'switzerland',
  'schweiz', 'united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales',
  'northern ireland', 'ireland', 'netherlands', 'nederland', 'spain', 'france',
  'italy', 'poland', 'portugal', 'belgium', 'denmark', 'sweden', 'norway', 'finland',
  'europe', 'eu', 'emea', 'remote', 'anywhere', 'home office', 'hybrid',
]);

// German/English exonyms for the same city. The scanner records whichever form the
// portal served, so "München" (Xing) and "Munich" (LinkedIn) are one office.
const EXONYM = new Map([
  ['muenchen', 'munich'], ['wien', 'vienna'], ['koeln', 'cologne'],
  ['zuerich', 'zurich'], ['nuernberg', 'nuremberg'], ['braunschweig', 'brunswick'],
  ['frankfurt am main', 'frankfurt'], ['frankfurt oder', 'frankfurt oder'],
  ['den haag', 'the hague'], ['lissabon', 'lisbon'], ['mailand', 'milan'],
]);

// City from the Notion `location` free-text field ("Berlin, Germany", "London, UK").
export function normCity(loc) {
  const first = String(loc || '').split(/[,|/]/)[0] || '';
  let s = first
    // Strip a UK postcode / outcode BEFORE the a-z strip: `[^a-z]` would
    // delete the digits out of the middle of the token and leave alphabetic
    // wreckage behind. "London EC4V" -> "london ec v" would never equal a
    // plain "london". Requires a preceding word so a city whose whole name
    // looks like an outcode is left alone.
    .replace(/(\S)\s+[A-Za-z]{1,2}\d[A-Za-z\d]?(\s+\d[A-Za-z]{2})?\s*$/, '$1')
    .toLowerCase()
    // Transliterate BEFORE the a-z strip. Stripping first deletes the umlaut
    // outright ("münchen" -> "mnchen"), which could never match "munich".
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Metro qualifiers describe the same market, not a separate office:
  // "London Area" / "Greater London" / "City of London" are all London.
  s = s
    .replace(/^(greater|grossraum|city of|stadt)\s+/, '')
    .replace(/\s+(area|region|metropolitan area|und umgebung|surrounding area)$/, '')
    .trim();
  if (NON_CITY.has(s)) return '';
  return EXONYM.get(s) || s;
}

// Two employer names refer to the same company when one normalised name contains
// the other as a whole-token prefix. Guarded by a 3-char floor so stubs like "AG"
// (already stripped) or a 2-letter remnant cannot swallow unrelated employers.
export function sameCompany(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long === short || long.startsWith(short + ' ');
}

// Only run the filter when invoked as a script. The normalisers above are
// imported by _autodraft_crossstage_filter.test.mjs, and an unguarded main body
// would re-run the whole sweep (and rewrite draft-queue-filtered.json) on import.
const IS_ENTRY = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_ENTRY) main();

function main() {
const queue = readRows('draft-queue.json');
const all = readRows('all-rows.json');

const today = new Date().toISOString().slice(0, 10);

// Attach the draft-artefact date so the age proxy below never has to fall back
// to `discovered_date`. Resolved HERE, not inside the decision, so the decision
// stays pure and its self-test needs no filesystem.
const artefactDates = resolveForRows(all, readArtefactFilenames(ROOT), today);
for (const r of all) {
  const a = artefactDates.get(r.application_id);
  if (a) r.artefact_date = a;
}
const inFlight = all
  .filter((r) => ACTIVE.test(String(r.stage || '')))
  .map((r) => ({
    app: r.application_id, stage: r.stage, kind: 'in-flight', age: null, position: r.position,
    company: normCompany(r.title), city: readableCity(r.location, r.title),
  }))
  .filter((r) => r.company);

// Recent rejections join the partner set. Age proxy chain, best signal first:
// most rejections carry no response date, and without the discovery-date
// backstop every one would read as undated, be treated as in-window, and block
// forever.
//
// `artefact_date` (the draft on disk) sits ahead of that backstop: discovery is
// a median ~22 days before the reply, which ages rejections out of the window
// early and silently stops them blocking. See recheck-collisions.mjs.
const recentRejections = all
  .filter((r) => REJECTED.test(String(r.stage || '')))
  .map((r) => ({
    app: r.application_id, stage: r.stage, kind: 'recent-rejection', position: r.position,
    age: ageInDays(r.response_date || r.apply_date || r.artefact_date || r.discovered_date, today),
    company: normCompany(r.title), city: readableCity(r.location, r.title),
  }))
  .filter((r) => r.company && (r.age === null || r.age <= REJECTION_WINDOW_DAYS));

const partners = inFlight.concat(recentRejections);

const kept = [];
const blocked = [];
const warned = [];
for (const row of queue) {
  const c = normCompany(row.title);
  const city = readableCity(row.location, row.title);
  // Hold before matching: an unnamed employer cannot be compared to anything,
  // so "no collision found" here means "no comparison was possible", not
  // "safe". Holding also costs nothing — a letter to an employer you cannot
  // name is not a letter worth sending.
  if (isPlaceholderCompany(row.title)) {
    blocked.push({ app: row.application_id, score: row.match_score, company: row.title, city, collides_with: null, at: null, reason: 'unresolved-employer' });
    continue;
  }
  const sameCo = partners.filter((f) => sameCompany(f.company, c));
  // Hard block: same employer, same city (or a city we cannot read on either
  // side) AND not a demonstrably different role. sameRole() returns null when
  // either side has no Position, which keeps the old employer+city behaviour
  // for rows the scanners never tagged; only an explicit role MISMATCH
  // rescues a row from the block.
  const cityMatch = (f) => !city || !f.city || f.city === city;
  const hard = sameCo.find((f) => cityMatch(f) && sameRole(row.position, f.position) !== false);
  const roleMismatch = sameCo.find((f) => cityMatch(f) && sameRole(row.position, f.position) === false);
  if (hard) {
    // An agency placing for many clients is not one employer twice. Downgrade
    // to a warn, or a Harnham row would be held against an unrelated Harnham
    // vacancy.
    if (isAgency(row.title)) {
      warned.push({ app: row.application_id, score: row.match_score, company: row.title, city, collides_with: hard.app, at: hard.stage, their_city: hard.city, reason: 'agency-collision' });
      kept.push(row);
      continue;
    }
    blocked.push({
      app: row.application_id, score: row.match_score, company: row.title, city,
      collides_with: hard.app, at: hard.stage, partner_age: hard.age,
      reason: hard.kind === 'in-flight' ? 'in-flight-collision' : 'recent-rejection-collision',
    });
    continue;
  }
  // Same employer and city, DIFFERENT role. Kept, but surfaced: it is the case
  // most easily mistaken for a duplicate by anyone reading the report.
  if (roleMismatch) {
    warned.push({
      app: row.application_id, score: row.match_score, company: row.title, city,
      collides_with: roleMismatch.app, at: roleMismatch.stage, their_city: roleMismatch.city,
      reason: 'different-role-keep',
      my_role: (row.position || []).join('/'), their_role: (roleMismatch.position || []).join('/'),
    });
    kept.push(row);
    continue;
  }
  // Soft warn: same employer, a DIFFERENT city string. Usually a genuinely
  // separate office, but sometimes the same market written differently. Too
  // ambiguous to archive automatically, so the row stays selectable and the
  // collision is surfaced for the routine's own judgement.
  if (sameCo.length) {
    warned.push({ app: row.application_id, score: row.match_score, company: row.title, city, collides_with: sameCo[0].app, at: sameCo[0].stage, their_city: sameCo[0].city });
  }
  kept.push(row);
}

kept.sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
fs.writeFileSync(path.join(TMP, 'draft-queue-filtered.json'), JSON.stringify(kept, null, 2));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ queue_depth: queue.length, kept: kept.length, blocked, warned }, null, 2));
} else {
  console.log(`queue ${queue.length} -> kept ${kept.length}, blocked ${blocked.length} on cross-stage branch collision`);
  for (const b of blocked) {
    if (b.reason === 'unresolved-employer') {
      console.log(`  HOLD  ${b.app} (${b.score}) ${b.company} / ${b.city || '?'} <= employer unresolved, cannot be deduped`);
    } else if (b.reason === 'recent-rejection-collision') {
      const age = b.partner_age === null ? 'undated' : `${b.partner_age}d ago`;
      console.log(`  BLOCK ${b.app} (${b.score}) ${b.company} / ${b.city || '?'} <= ${b.collides_with} REJECTED (${age})`);
    } else {
      console.log(`  BLOCK ${b.app} (${b.score}) ${b.company} / ${b.city || '?'} <= ${b.collides_with} already ${b.at}`);
    }
  }
  for (const w of warned) {
    if (w.reason === 'different-role-keep') {
      console.log(`  KEEP  ${w.app} (${w.score}) ${w.company} / ${w.city || '?'} <= ${w.collides_with} ${w.at} is a DIFFERENT role (${w.their_role} vs ${w.my_role})`);
    } else if (w.reason === 'agency-collision') {
      console.log(`  KEEP  ${w.app} (${w.score}) ${w.company} / ${w.city || '?'} <= ${w.collides_with} ${w.at}, agency placing for many clients`);
    } else {
      console.log(`  WARN  ${w.app} (${w.score}) ${w.company} / ${w.city || '?'} <= ${w.collides_with} already ${w.at} in "${w.their_city}"`);
    }
  }
  // The KEEP-on-role lines rest on the Position field, which is OUR tag and not
  // the employer's title. Good enough to stop a block; not good enough to act
  // on unchecked, so say so where the decision is actually read.
  if (warned.some((w) => w.reason === 'different-role-keep')) {
    console.log('  note: KEEP-on-role uses our Position tag, not the advert title.');
    console.log('        Check the posting before closing or standing up those rows.');
  }
}
}
