#!/usr/bin/env node
/**
 * followup-cadence.mjs — Follow-up Cadence Tracker for applyd
 *
 * READS FROM NOTION. Previously parsed the pre-Notion markdown tracker
 * (`data/applications.md` + `data/follow-ups.md`), which stopped receiving
 * writes once the pipeline moved to Notion — the script kept running and kept
 * reporting an empty cohort while dozens of "4. Applied" rows in Notion sat
 * uncontacted. The cadence policy, urgency model, output shape and CLI are
 * unchanged from that version; only the data layer moved.
 *
 * Run: node scripts/metrics/followup-cadence.mjs             (JSON to stdout)
 *      node scripts/metrics/followup-cadence.mjs --summary   (human-readable dashboard)
 *      node scripts/metrics/followup-cadence.mjs --overdue-only
 *      node scripts/metrics/followup-cadence.mjs --applied-days 10
 *      node scripts/metrics/followup-cadence.mjs --self-test (offline; no Notion, no token)
 *
 * Auth: NOTION_TOKEN, same integration as notion-query.mjs.
 * Config: applications_data_source_id in config/profile.yml (under `notion:`)
 *         or the NOTION_DATA_SOURCE_ID env var. No hardcoded fallback — a
 *         missing id fails loudly rather than silently pointing at the wrong DB.
 *
 * HOW A FOLLOW-UP IS RECORDED. There is no follow-ups table in Notion, and
 * adding one would be a second source of truth. Instead a follow-up is a
 * sentinel prepended to Fit notes, exactly like every other marker the system
 * writes (`[auto-draft ...]`, `[mail-sweep ...]`, `[interview-prep ...]`):
 *
 *     [followup 2026-08-26] chased contact by email
 *
 * This script COUNTS those and reads the latest date. It never writes. Writing
 * the sentinel is a deliberate act by whoever actually sent the message —
 * a tracker that marks its own follow-ups as done is a tracker that lies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { normalizeStatus } from './metrics-core.mjs';

// scripts/metrics/ is two levels below the repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- CLI args ---
const args = process.argv.slice(2);
const summaryMode = args.includes('--summary');
const overdueOnly = args.includes('--overdue-only');
const selfTest = args.includes('--self-test');
const appliedDaysIdx = args.indexOf('--applied-days');
const APPLIED_FIRST = appliedDaysIdx !== -1 ? parseInt(args[appliedDaysIdx + 1]) || 7 : 7;

// --- Cadence config ---
const CADENCE = {
  applied_first: APPLIED_FIRST,
  applied_subsequent: 7,
  applied_max_followups: 2,
  responded_initial: 1,
  responded_subsequent: 3,
  interview_thankyou: 1,
};

// Status normalization comes from metrics-core.mjs (shared semantic layer).
// ACTIONABLE_STATUSES stays local: "which statuses deserve a follow-up" is a
// cadence policy, not a taxonomy fact.
const ACTIONABLE_STATUSES = ['applied', 'responded', 'interview'];

// --- Notion config ---
function readDataSourceId() {
  if (process.env.NOTION_DATA_SOURCE_ID) return process.env.NOTION_DATA_SOURCE_ID;
  try {
    const p = join(REPO_ROOT, 'config', 'profile.yml');
    if (!existsSync(p)) return null;
    const cfg = yaml.load(readFileSync(p, 'utf8')) || {};
    return cfg?.notion?.applications_data_source_id || null;
  } catch { return null; }
}
const DATA_SOURCE_ID = readDataSourceId();
const NOTION_VERSION = '2025-09-03';

// --- Stage -> status (the shared vocabulary normalizeStatus already speaks) ---
// Only Stage 4+ can need chasing: nothing before it has been sent. Offer and the
// terminal stages are deliberately NOT actionable — an offer needs a decision,
// not a nudge, and Rejected/Withdrew/Not pursuing are closed.
const INTERVIEW_STAGES = new Set([
  '5. Assessment/OA', '6. Phone screen', '7. Tech interview', '8. Onsite/Final',
]);
function stageToStatus(stage, responseDate) {
  const s = String(stage || '').trim();
  if (INTERVIEW_STAGES.has(s)) return 'interview';
  // A Response date on a Stage-4 row means they came back to us and the ball is
  // ours — a materially different cadence from silence. The markdown tracker
  // could not distinguish these; Notion can.
  if (s === '4. Applied') return responseDate ? 'responded' : 'applied';
  return null;
}

// --- Date helpers ---
function today() {
  return new Date(new Date().toISOString().split('T')[0]);
}
function parseDate(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).trim())) return null;
  return new Date(String(dateStr).trim());
}
function daysBetween(d1, d2) {
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}
function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().split('T')[0];
}

// --- Follow-up sentinels in Fit notes ---
// `[followup YYYY-MM-DD ...]`, case-insensitive, hyphen or space separated.
const FOLLOWUP_RE = /\[follow[\s-]?up\s+(\d{4}-\d{2}-\d{2})/gi;
export function parseFollowups(fitNotes) {
  const out = [];
  for (const m of String(fitNotes || '').matchAll(FOLLOWUP_RE)) out.push(m[1]);
  return out.sort().reverse();   // newest first
}

// --- Contacts ---
// Notion carries these as real fields, so prefer them; fall back to scraping
// Fit notes the way the markdown version had to.
export function extractContacts(recruiterName, recruiterContact, fitNotes) {
  const contacts = [];
  const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  const fieldEmails = String(recruiterContact || '').match(emailRe) || [];
  for (const email of fieldEmails) {
    contacts.push({ email, name: String(recruiterName || '').trim() || null, source: 'field' });
  }
  if (contacts.length === 0 && recruiterName) {
    contacts.push({ email: null, name: String(recruiterName).trim(), source: 'field' });
  }
  if (contacts.length === 0) {
    for (const email of String(fitNotes || '').match(emailRe) || []) {
      contacts.push({ email, name: null, source: 'fit-notes' });
    }
  }
  return contacts;
}

// --- Compute urgency ---
export function computeUrgency(status, daysSinceApp, daysSinceLastFollowup, followupCount, cadence = CADENCE) {
  if (status === 'applied') {
    if (followupCount >= cadence.applied_max_followups) return 'cold';
    if (followupCount === 0 && daysSinceApp >= cadence.applied_first) return 'overdue';
    if (followupCount > 0 && daysSinceLastFollowup !== null && daysSinceLastFollowup >= cadence.applied_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'responded') {
    if (daysSinceApp < cadence.responded_initial) return 'urgent';
    if (daysSinceApp >= cadence.responded_subsequent) return 'overdue';
    return 'waiting';
  }
  if (status === 'interview') {
    if (daysSinceApp >= cadence.interview_thankyou) return 'overdue';
    return 'waiting';
  }
  return 'waiting';
}

// --- Compute next follow-up date ---
export function computeNextFollowupDate(status, appDate, lastFollowupDate, followupCount, cadence = CADENCE) {
  if (status === 'applied') {
    if (followupCount >= cadence.applied_max_followups) return null; // cold
    if (followupCount === 0) return addDays(parseDate(appDate), cadence.applied_first);
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), cadence.applied_subsequent);
    return addDays(parseDate(appDate), cadence.applied_first);
  }
  if (status === 'responded') {
    if (lastFollowupDate) return addDays(parseDate(lastFollowupDate), cadence.responded_subsequent);
    return addDays(parseDate(appDate), cadence.responded_subsequent);
  }
  if (status === 'interview') {
    return addDays(parseDate(appDate), cadence.interview_thankyou);
  }
  return null;
}

// --- Notion fetch ---
async function fetchRows() {
  const token = process.env.NOTION_TOKEN;
  if (!token) return { error: 'NOTION_TOKEN not set — cannot read the Applications DB.' };
  if (!DATA_SOURCE_ID) return { error: 'No Notion data-source id configured — set NOTION_DATA_SOURCE_ID env var or notion.applications_data_source_id in config/profile.yml.' };
  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
  const pages = [];
  let cursor = null, guard = 0;
  do {
    const res = await fetch(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!res.ok) {
      return { error: `Notion query ${res.status}: ${(await res.text()).slice(0, 160)}` };
    }
    const j = await res.json();
    pages.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor && ++guard < 60);
  return { pages };
}

const txt = (p, k) => ((p.properties?.[k]?.rich_text || p.properties?.[k]?.title || []).map(x => x.plain_text).join(''));
const sel = (p, k) => p.properties?.[k]?.select?.name || '';
const dat = (p, k) => p.properties?.[k]?.date?.start || null;

// --- Main analysis ---
async function analyze() {
  const fetched = await fetchRows();
  if (fetched.error) return { error: fetched.error };
  const pages = fetched.pages;
  if (pages.length === 0) return { error: 'No rows returned from the Applications DB.' };

  const now = today();
  const entries = [];
  let sentCount = 0;

  for (const p of pages) {
    const applyDate = dat(p, 'Apply date');
    if (!applyDate) continue;          // never sent — nothing to chase
    sentCount++;

    const responseDate = dat(p, 'Response date');
    const status = normalizeStatus(stageToStatus(sel(p, 'Stage'), responseDate) || '');
    if (!ACTIONABLE_STATUSES.includes(status)) continue;

    const appDate = parseDate(applyDate);
    if (!appDate) continue;

    // The clock that matters differs by status. For a row they have replied to,
    // or one in an interview loop, days-since-APPLICATION is the wrong number —
    // it only grows and would mark every live process permanently overdue. Use
    // the response date where we have one. The markdown tracker had no response
    // date at all, so it could only ever use the application date.
    const clockDate = (status !== 'applied' && parseDate(responseDate)) || appDate;
    const daysSinceApp = daysBetween(clockDate, now);

    const fitNotes = txt(p, 'Fit notes');
    const followupDates = parseFollowups(fitNotes);
    const followupCount = followupDates.length;
    const lastFollowupDate = followupDates[0] || null;
    const lastDate = parseDate(lastFollowupDate);
    const daysSinceLastFollowup = lastDate ? daysBetween(lastDate, now) : null;

    const urgency = computeUrgency(status, daysSinceApp, daysSinceLastFollowup, followupCount);
    const nextFollowupDate = computeNextFollowupDate(status, applyDate, lastFollowupDate, followupCount);
    const nextDate = nextFollowupDate ? parseDate(nextFollowupDate) : null;
    const daysUntilNext = nextDate ? daysBetween(now, nextDate) : null;

    const uid = p.properties?.['Application ID']?.unique_id;

    entries.push({
      num: uid ? uid.number : null,
      appId: uid ? `${uid.prefix}-${uid.number}` : null,
      date: applyDate,
      responseDate,
      company: txt(p, 'Company'),
      role: (p.properties?.Position?.multi_select || []).map(x => x.name).join(', '),
      status,
      stage: sel(p, 'Stage'),
      score: p.properties?.['Match score']?.number ?? null,
      url: p.url,
      contacts: extractContacts(txt(p, 'Recruiter name'), txt(p, 'Recruiter contact'), fitNotes),
      daysSinceApplication: daysSinceApp,
      daysSinceLastFollowup,
      followupCount,
      urgency,
      nextFollowupDate,
      daysUntilNext,
    });
  }

  const urgencyOrder = { urgent: 0, overdue: 1, waiting: 2, cold: 3 };
  entries.sort((a, b) =>
    (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9) ||
    b.daysSinceApplication - a.daysSinceApplication);

  const filtered = overdueOnly
    ? entries.filter(e => e.urgency === 'overdue' || e.urgency === 'urgent')
    : entries;

  return {
    metadata: {
      analysisDate: now.toISOString().split('T')[0],
      source: 'notion',
      totalRows: pages.length,
      totalSent: sentCount,
      totalTracked: sentCount,
      actionable: entries.length,
      overdue: entries.filter(e => e.urgency === 'overdue').length,
      urgent: entries.filter(e => e.urgency === 'urgent').length,
      cold: entries.filter(e => e.urgency === 'cold').length,
      waiting: entries.filter(e => e.urgency === 'waiting').length,
    },
    entries: filtered,
    cadenceConfig: CADENCE,
  };
}

// --- Summary mode ---
function printSummary(result) {
  if (result.error) { console.log(`\n${result.error}\n`); return; }
  const { metadata, entries } = result;

  console.log(`\n${'='.repeat(78)}`);
  console.log(`  Follow-up Cadence Dashboard — ${metadata.analysisDate}   [source: Notion]`);
  console.log(`  ${metadata.totalSent} sent applications, ${metadata.actionable} actionable`);
  console.log(`${'='.repeat(78)}\n`);

  if (entries.length === 0) {
    console.log('  Nothing actionable. Every sent application is closed or already chased.\n');
    return;
  }

  const urgencyIcon = { urgent: 'URGENT', overdue: 'OVERDUE', waiting: 'waiting', cold: 'COLD' };
  console.log(`  ${metadata.urgent} urgent | ${metadata.overdue} overdue | ${metadata.waiting} waiting | ${metadata.cold} cold\n`);

  console.log('  ' + 'ID'.padEnd(10) + 'Company'.padEnd(24) + 'Status'.padEnd(11) + 'Days'.padEnd(6) + 'F/U'.padEnd(5) + 'Next'.padEnd(13) + 'Urgency'.padEnd(9) + 'Contact');
  console.log('  ' + '-'.repeat(94));

  for (const e of entries) {
    console.log(
      '  ' +
      String(e.appId || e.num || '-').padEnd(10) +
      String(e.company).substring(0, 23).padEnd(24) +
      e.status.padEnd(11) +
      String(e.daysSinceApplication).padEnd(6) +
      String(e.followupCount).padEnd(5) +
      String(e.nextFollowupDate || '-').padEnd(13) +
      (urgencyIcon[e.urgency] || e.urgency).padEnd(9) +
      (e.contacts[0]?.email || e.contacts[0]?.name || '-')
    );
  }
  console.log('\n  Record a chase by prepending to that row\'s Fit notes:  [followup YYYY-MM-DD] <what you sent>\n');
}

// --- Self-test (offline: pure functions only, no Notion, no token) ---
function runSelfTest() {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

  ok('stage 4 without response -> applied',      stageToStatus('4. Applied', null) === 'applied');
  ok('stage 4 with response -> responded',       stageToStatus('4. Applied', '2026-08-10') === 'responded');
  ok('phone screen -> interview',                stageToStatus('6. Phone screen', null) === 'interview');
  ok('stage 3 is not actionable',                stageToStatus('3. Drafted', null) === null);
  ok('rejected is not actionable',               stageToStatus('Rejected', '2026-08-10') === null);
  ok('offer is not actionable (needs a decision)', stageToStatus('9. Offer', null) === null);

  ok('followup sentinel parsed',                 parseFollowups('[followup 2026-08-20] chased').length === 1);
  ok('followup newest first',                    parseFollowups('[followup 2026-08-01] a\n[followup 2026-08-20] b')[0] === '2026-08-20');
  ok('follow-up spelling variants',              parseFollowups('[follow-up 2026-08-20] x [Followup 2026-08-21] y').length === 2);
  ok('no false positive on other markers',       parseFollowups('[auto-draft 2026-08-20] x').length === 0);

  ok('unchased after the window is overdue',     computeUrgency('applied', 9, null, 0) === 'overdue');
  ok('unchased inside the window waits',         computeUrgency('applied', 3, null, 0) === 'waiting');
  ok('two chases go cold',                       computeUrgency('applied', 40, 20, 2) === 'cold');
  ok('fresh response is urgent',                 computeUrgency('responded', 0, null, 0) === 'urgent');
  ok('stale response is overdue',                computeUrgency('responded', 5, null, 0) === 'overdue');

  ok('next date = apply + window',               computeNextFollowupDate('applied', '2026-08-01', null, 0) === '2026-08-08');
  ok('cold has no next date',                    computeNextFollowupDate('applied', '2026-08-01', '2026-08-20', 2) === null);

  ok('contact prefers the Notion field',         extractContacts('Alex Recruiter', 'alex@example.com', 'x')[0].source === 'field');
  ok('contact falls back to fit notes',          extractContacts('', '', 'mail sam@example.org')[0].email === 'sam@example.org');
  ok('name-only contact still surfaces',         extractContacts('Alex Recruiter', '', '')[0].name === 'Alex Recruiter');

  console.log(`\nSELF_TEST_${fail === 0 ? 'PASS' : 'FAIL'}: ${pass}/${pass + fail} cases.`);
  process.exit(fail === 0 ? 0 : 1);
}

// --- Run ---
if (selfTest) runSelfTest();

const result = await analyze();
if (summaryMode) printSummary(result);
else console.log(JSON.stringify(result, null, 2));
if (result.error) process.exit(1);
