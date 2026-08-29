#!/usr/bin/env node
/**
 * outreach.mjs — the half of the referral system that was never built: the
 * part that records what actually went out.
 *
 * `Outreach status` had exactly one writer (`bd-referral-scout.mjs`) and it
 * only ever set `Not contacted`, at creation. No code path had ever moved a
 * contact past it. So every contact sat at `Not contacted`, and there was no
 * send count, no reply rate and no referral count anywhere in the system.
 * Every other improvement to outreach was optimising a process whose output
 * was invisible.
 *
 * This script is the writer, the reader and the follow-up clock.
 *
 *   node scripts/outreach.mjs --report                     funnel + where the contacts sit
 *   node scripts/outreach.mjs --list [--status X] [--owner Y] [--json]
 *   node scripts/outreach.mjs --due                        notes sent, unanswered, past the window
 *   node scripts/outreach.mjs --mark "Name" --status "Note sent" [--company X] [--app APP-123]
 *                     [--date YYYY-MM-DD] [--force] --apply
 *   node scripts/outreach.mjs --retire-dead [--apply]
 *   node scripts/outreach.mjs --self-test
 *
 * SAFETY. This never sends a message. `--mark` records something the operator
 * has already done in LinkedIn, by hand, under their own name. It is dry by
 * default: without `--apply` it prints the plan and writes nothing. Marking a
 * send that did not happen is worse than not marking it, because the whole
 * point of the field is to be the one honest record of what left the building.
 *
 * Auth: NOTION_TOKEN. Config: config/profile.yml -> notion.referral_database_id.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTION_QUERY = join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

// -- The state machine (LOCKED — mirrors modes/contacto.md -> Status lifecycle) --
// Notion rejects any value outside this list, so the enum is not ours to extend.
export const STATUSES = ['Not contacted', 'Note sent', 'Replied', 'Referral confirmed', 'Declined', 'No response'];

export const TRANSITIONS = {
  'Not contacted':      ['Note sent'],
  'Note sent':          ['Replied', 'No response'],
  'Replied':            ['Referral confirmed', 'Declined'],
  'No response':        ['Replied'],          // a late reply is still a reply
  'Referral confirmed': [],                    // terminal
  'Declined':           [],                    // terminal
};

/** A note went out. Everything except the creation default implies a send. */
export const isSent     = (s) => STATUSES.includes(s) && s !== 'Not contacted';
/** A human wrote back, whatever they said. */
export const isAnswered = (s) => ['Replied', 'Referral confirmed', 'Declined'].includes(s);

export function canTransition(from, to) {
  if (!STATUSES.includes(to)) return { ok: false, why: `"${to}" is not one of: ${STATUSES.join(', ')}` };
  if (from === to) return { ok: false, why: `already ${from}` };
  if (!STATUSES.includes(from)) return { ok: false, why: `current status "${from}" is not a known state` };
  if (!TRANSITIONS[from].includes(to)) {
    const legal = TRANSITIONS[from].length ? TRANSITIONS[from].join(' or ') : 'nothing — it is terminal';
    return { ok: false, why: `${from} -> ${to} is not a legal move; from ${from} you can only go to ${legal}` };
  }
  return { ok: true };
}

// -- Contact resolution ------------------------------------------------------
// Ambiguity must fail loudly. Marking the wrong person's row is a silent
// corruption of the only record of what was sent, and it also lets a second
// note go out to someone who already had one.
export function resolveContact(contacts, { name, company, app, linkedin }) {
  let pool = contacts;
  if (linkedin) {
    const want = String(linkedin).replace(/\/+$/, '').toLowerCase();
    const hit = pool.filter((c) => String(c.linkedin || '').replace(/\/+$/, '').toLowerCase() === want);
    if (hit.length === 1) return { ok: true, contact: hit[0] };
    pool = hit.length ? hit : pool;
  }
  if (company) {
    const w = company.toLowerCase();
    pool = pool.filter((c) => String(c.company || '').toLowerCase().includes(w));
  }
  if (app) {
    const w = String(app).toUpperCase();
    pool = pool.filter((c) => (c.appIds || []).some((a) => String(a).toUpperCase() === w));
  }
  if (name) {
    const w = name.toLowerCase().trim();
    const exact = pool.filter((c) => String(c.name || '').toLowerCase().trim() === w);
    pool = exact.length ? exact : pool.filter((c) => String(c.name || '').toLowerCase().includes(w));
  }
  if (pool.length === 1) return { ok: true, contact: pool[0] };
  if (pool.length === 0) return { ok: false, why: 'no contact matched', candidates: [] };
  return {
    ok: false,
    why: `${pool.length} contacts matched — narrow it with --company or --app`,
    candidates: pool.slice(0, 12),
  };
}

// -- The follow-up clock for CONTACTS (applications have their own) ----------
// contacto.md sets the window at 7 weekdays. Weekdays, not days, because a
// note sent on a Friday has not been ignored by Monday.
export function weekdaysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const a = new Date(fromISO + 'T00:00:00Z'), b = new Date(toISO + 'T00:00:00Z');
  if (Number.isNaN(+a) || Number.isNaN(+b) || b < a) return null;
  let n = 0;
  for (const d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export function dueContacts(contacts, todayISO, windowDays = 7) {
  return contacts
    .filter((c) => c.status === 'Note sent')
    .map((c) => ({ ...c, waited: weekdaysBetween(c.date, todayISO) }))
    .filter((c) => c.waited !== null && c.waited >= windowDays)
    .sort((a, b) => b.waited - a.waited);
}

// -- Summary -----------------------------------------------------------------
export function summarise(contacts) {
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const c of contacts) byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  const sent      = contacts.filter((c) => isSent(c.status)).length;
  const answered  = contacts.filter((c) => isAnswered(c.status)).length;
  const referrals = contacts.filter((c) => c.status === 'Referral confirmed').length;
  return {
    contacts: contacts.length,
    byStatus,
    sent,
    answered,
    referrals,
    answerRate:   sent ? answered / sent : null,
    referralRate: sent ? referrals / sent : null,
  };
}

/** Terminal application stages: a contact hanging off one of these is dead weight. */
export const DEAD_STAGES = /^(Withdrew|Rejected|Not pursuing)$/;

export function classifyOwner(stage) {
  const s = String(stage || '');
  if (!s) return 'unlinked';
  if (DEAD_STAGES.test(s)) return 'orphan-dead-application';
  if (s === '3. Drafted') return 'referral';
  if (/^(4\.|5\.|6\.|7\.|8\.|9\.|Signed)/.test(s)) return 'chase';
  return 'too-early';
}

// -- Retiring a contact whose application died -------------------------------
// A contact hanging off a Withdrew or Rejected row is owned by nobody:
// referral skips it (not Stage 3), chase skips it (no live application). It
// sits in the count forever looking like unfinished work.
//
// The application is dead. The PERSON is not — they are still a verified human
// at a real employer, and the next role there is worth having them for. So the
// relation is cleared and the provenance moves into the Role text. Deleting
// the row would throw away a found contact to tidy up a number.
export function provenanceRole(role, appId, stage) {
  const r = String(role || '').trim();
  const mark = `[was ${appId}, ${stage}]`;
  if (r.includes(`[was ${appId},`)) return r;          // already retired; do not stack marks
  return r ? `${mark} ${r}` : mark;
}

export function unlinkPlan(contacts) {
  return contacts
    .filter((c) => c.owner === 'orphan-dead-application')
    .map((c) => ({
      id: c.id,
      name: c.name,
      company: c.company,
      appId: c.appIds[0] || '(unknown)',
      stage: c.stage,
      role: provenanceRole(c.role, c.appIds[0] || '(unknown)', c.stage),
    }));
}

// -- Self-test ---------------------------------------------------------------
// Gated on being the entry point, NOT on argv alone. Without this, importing
// anything from here into a script that happens to be run with --self-test
// would run OUR tests and exit the parent process mid-run.
const IS_ENTRY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_ENTRY && has('--self-test')) {
  let pass = 0, fail = 0;
  const eq = (label, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n         got  ${g}\n         want ${w}`); }
  };

  // state machine
  eq('a fresh contact can be marked sent', canTransition('Not contacted', 'Note sent').ok, true);
  eq('a sent note can be answered', canTransition('Note sent', 'Replied').ok, true);
  eq('a sent note can time out', canTransition('Note sent', 'No response').ok, true);
  eq('a late reply after silence counts', canTransition('No response', 'Replied').ok, true);
  eq('cannot reply before sending', canTransition('Not contacted', 'Replied').ok, false);
  eq('cannot confirm a referral before a reply', canTransition('Note sent', 'Referral confirmed').ok, false);
  eq('a confirmed referral is terminal', canTransition('Referral confirmed', 'Declined').ok, false);
  eq('a decline is terminal', canTransition('Declined', 'Replied').ok, false);
  eq('a no-op is refused', canTransition('Note sent', 'Note sent').ok, false);
  eq('invented statuses are refused', canTransition('Not contacted', 'Ghosted').ok, false);

  // sent / answered semantics
  eq('Not contacted is not a send', isSent('Not contacted'), false);
  eq('No response IS a send', isSent('No response'), true);
  eq('a decline is an answer', isAnswered('Declined'), true);
  eq('silence is not an answer', isAnswered('No response'), false);

  // resolution — placeholders only (never real names)
  const pool = [
    { name: 'Person One',   company: 'Acme Corp',    appIds: [],           linkedin: 'https://linkedin.com/in/personone' },
    { name: 'Person Two',   company: 'Beta Ltd',     appIds: ['APP-1000'], linkedin: 'https://linkedin.com/in/persontwo' },
    { name: 'Sam Example',  company: 'Gamma AG',     appIds: ['APP-2000'], linkedin: 'https://linkedin.com/in/sam1' },
    { name: 'Sam Example',  company: 'Delta GmbH',   appIds: ['APP-3000'], linkedin: 'https://linkedin.com/in/sam2' },
  ];
  eq('a unique name resolves', resolveContact(pool, { name: 'Person One' }).contact.company, 'Acme Corp');
  eq('a duplicate name is refused, not guessed', resolveContact(pool, { name: 'Sam Example' }).ok, false);
  eq('company disambiguates a duplicate', resolveContact(pool, { name: 'Sam Example', company: 'Delta' }).contact.linkedin, 'https://linkedin.com/in/sam2');
  eq('an application id disambiguates too', resolveContact(pool, { name: 'Sam Example', app: 'APP-2000' }).contact.company, 'Gamma AG');
  eq('a linkedin url is enough on its own', resolveContact(pool, { linkedin: 'https://linkedin.com/in/persontwo/' }).contact.name, 'Person Two');
  eq('a miss is a miss', resolveContact(pool, { name: 'Nobody Here' }).ok, false);
  eq('a partial name matches', resolveContact(pool, { name: 'one' }).contact.name, 'Person One');

  // weekday clock
  eq('Mon to Mon is five weekdays', weekdaysBetween('2026-08-24', '2026-08-31'), 5);
  eq('Friday to Monday is one weekday', weekdaysBetween('2026-08-28', '2026-08-31'), 1);
  eq('the same day is zero', weekdaysBetween('2026-08-31', '2026-08-31'), 0);
  eq('a future date is not negative time', weekdaysBetween('2026-09-30', '2026-08-31'), null);
  eq('a missing date is unknowable', weekdaysBetween(null, '2026-08-31'), null);

  // due list
  const clock = [
    { name: 'waited long',  status: 'Note sent',     date: '2026-08-10' },
    { name: 'just sent',    status: 'Note sent',     date: '2026-08-28' },
    { name: 'never sent',   status: 'Not contacted', date: '2026-06-30' },
    { name: 'already back', status: 'Replied',       date: '2026-08-01' },
  ];
  eq('only unanswered sends are chased', dueContacts(clock, '2026-08-31').map((c) => c.name), ['waited long']);
  eq('a contact with no send date cannot be due', dueContacts([{ name: 'x', status: 'Note sent', date: null }], '2026-08-31').length, 0);

  // summary
  const s = summarise([
    { status: 'Not contacted' }, { status: 'Not contacted' },
    { status: 'Note sent' }, { status: 'Replied' }, { status: 'Referral confirmed' },
  ]);
  eq('sends counted', s.sent, 3);
  eq('answers counted', s.answered, 2);
  eq('referrals counted', s.referrals, 1);
  eq('the answer rate is over sends, not contacts', Number(s.answerRate.toFixed(4)), 0.6667);
  eq('nothing sent means no rate, not zero', summarise([{ status: 'Not contacted' }]).answerRate, null);

  // ownership
  eq('a drafted row belongs to referral', classifyOwner('3. Drafted'), 'referral');
  eq('an applied row belongs to chase', classifyOwner('4. Applied'), 'chase');
  eq('a phone screen still belongs to chase', classifyOwner('6. Phone screen'), 'chase');
  eq('a withdrawn row is an orphan', classifyOwner('Withdrew'), 'orphan-dead-application');
  eq('a rejected row is an orphan', classifyOwner('Rejected'), 'orphan-dead-application');
  eq('an unlinked contact is its own case', classifyOwner(''), 'unlinked');
  eq('a triaged row is too early for outreach', classifyOwner('2. Triaged'), 'too-early');

  // retiring a dead-application contact
  eq('provenance is prefixed', provenanceRole('Data Lead', 'APP-9000', 'Withdrew'), '[was APP-9000, Withdrew] Data Lead');
  eq('an empty role still records where they came from', provenanceRole('', 'APP-9000', 'Withdrew'), '[was APP-9000, Withdrew]');
  eq('retiring twice does not stack marks', provenanceRole('[was APP-9000, Withdrew] Data Lead', 'APP-9000', 'Withdrew'), '[was APP-9000, Withdrew] Data Lead');
  eq('a different application still marks', provenanceRole('[was APP-1, Rejected] X', 'APP-2', 'Withdrew'), '[was APP-2, Withdrew] [was APP-1, Rejected] X');
  eq('only dead-application contacts are retired', unlinkPlan([
    { id: '1', name: 'a', company: 'A', role: 'r', appIds: ['APP-1'], stage: 'Withdrew', owner: 'orphan-dead-application' },
    { id: '2', name: 'b', company: 'B', role: 'r', appIds: ['APP-2'], stage: '3. Drafted', owner: 'referral' },
    { id: '3', name: 'c', company: 'C', role: 'r', appIds: ['APP-3'], stage: '4. Applied', owner: 'chase' },
  ]).map((p) => p.name), ['a']);

  console.log(`\noutreach self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// -- Live data ---------------------------------------------------------------
function config() {
  const p = join(REPO_ROOT, 'config/profile.yml');
  if (!existsSync(p)) return {};
  try { return yaml.load(readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}

const TOKEN = process.env.NOTION_TOKEN;
const NH = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

const txt = (p) => (p?.rich_text || p?.title || []).map((t) => t.plain_text || t.text?.content || '').join('').trim();

async function fetchContacts(dbId) {
  const out = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST', headers: NH,
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`notion ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    for (const pg of j.results) {
      const P = pg.properties;
      out.push({
        id: pg.id,
        name: txt(P['Name']),
        company: txt(P['Company']),
        role: txt(P['Role']),
        linkedin: P['LinkedIn URL']?.url || '',
        status: P['Outreach status']?.select?.name || '',
        template: P['Note template']?.select?.name || '',
        country: P['Country']?.select?.name || '',
        date: P['Date']?.date?.start || null,
        appPageIds: (P['Linked application']?.relation || []).map((x) => x.id),
      });
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}

function fetchApplications() {
  try {
    return JSON.parse(execFileSync('node', [NOTION_QUERY, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    console.error(`OUTREACH_WARN: could not read applications: ${String(e.message).slice(0, 160)}`);
    return [];
  }
}

/** Attach the linked application's stage and id so a contact knows who owns it. */
export function joinApplications(contacts, apps) {
  const byPage = new Map(apps.map((a) => [String(a.id).replace(/-/g, ''), a]));
  return contacts.map((c) => {
    const linked = (c.appPageIds || []).map((id) => byPage.get(String(id).replace(/-/g, ''))).filter(Boolean);
    return {
      ...c,
      appIds: linked.map((a) => a.application_id),
      stages: linked.map((a) => a.stage),
      stage: linked[0]?.stage || '',
      owner: classifyOwner(linked[0]?.stage || ''),
    };
  });
}

if (IS_ENTRY) await main();

async function main() {
  if (!TOKEN) { console.error('OUTREACH_ABORT: NOTION_TOKEN not set.'); process.exit(5); }
  const cfg = config();
  const dbId = cfg?.notion?.referral_database_id;
  if (!dbId) { console.error('OUTREACH_ABORT: config/profile.yml -> notion.referral_database_id missing.'); process.exit(5); }

  const today = argOf('--today') || new Date().toISOString().slice(0, 10);
  const raw = await fetchContacts(dbId);
  const contacts = joinApplications(raw, fetchApplications());

  if (has('--mark')) return doMark(contacts, today);
  if (has('--retire-dead')) return doRetireDead(contacts);
  if (has('--due')) return doDue(contacts, today);
  if (has('--list')) return doList(contacts);
  return doReport(contacts, today);
}

async function doRetireDead(contacts) {
  const plan = unlinkPlan(contacts);
  if (!plan.length) { console.log('No contacts are hanging off a dead application.'); return; }
  const apply = has('--apply');
  console.log(`${plan.length} contact(s) on dead applications. The relation goes; the person stays.\n`);
  for (const p of plan) console.log(`  ${apply ? 'RETIRE' : 'PLAN  '}  ${String(p.appId).padEnd(9)} ${String(p.stage).padEnd(10)} ${String(p.company).slice(0, 20).padEnd(21)} ${String(p.name).padEnd(20)} role -> ${p.role.slice(0, 50)}`);
  if (!apply) { console.log('\n  Dry run. Re-run with --apply to write it.'); return; }
  let ok = 0, failed = 0;
  for (const p of plan) {
    const r = await fetch(`https://api.notion.com/v1/pages/${p.id}`, {
      method: 'PATCH', headers: NH,
      body: JSON.stringify({ properties: {
        'Linked application': { relation: [] },
        'Role': { rich_text: [{ text: { content: p.role.slice(0, 1900) } }] },
      } }),
    });
    if (r.ok) ok++; else { failed++; console.log(`    FAIL ${p.name} notion ${r.status}`); }
  }
  console.log(`\n  ${ok} retired, ${failed} failed. They now read as standalone contacts at that employer.`);
}

function doList(contacts) {
  const wantStatus = argOf('--status');
  const wantOwner = argOf('--owner');
  let rows = contacts;
  if (wantStatus) rows = rows.filter((c) => c.status === wantStatus);
  if (wantOwner) rows = rows.filter((c) => c.owner === wantOwner);
  rows.sort((a, b) => (a.company || '').localeCompare(b.company || '') || (a.name || '').localeCompare(b.name || ''));
  if (has('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const c of rows) {
    console.log(`${String(c.appIds[0] || '-').padEnd(9)} ${String(c.status).padEnd(18)} ${String(c.company).slice(0, 24).padEnd(25)} ${String(c.name).slice(0, 24).padEnd(25)} ${String(c.role).slice(0, 40)}`);
  }
  console.log(`\n${rows.length} contact(s).`);
}

function doDue(contacts, today) {
  const due = dueContacts(contacts, today);
  if (has('--json')) { console.log(JSON.stringify(due, null, 2)); return; }
  console.log(`Contacts with a note sent and no answer, past the 7-weekday window (as at ${today}):\n`);
  if (!due.length) {
    const sent = contacts.filter((c) => isSent(c.status)).length;
    console.log(sent
      ? '  none — every sent note is either inside the window or already answered.'
      : '  none, because no note has ever been logged as sent. See --report.');
    return;
  }
  for (const c of due) {
    console.log(`  ${String(c.waited).padStart(3)} weekdays  ${String(c.appIds[0] || '-').padEnd(9)} ${String(c.company).slice(0, 22).padEnd(23)} ${c.name}`);
  }
  console.log(`\n${due.length} due. One polite follow-up, then --status "No response". Never a third message.`);
}

function doReport(contacts, today) {
  const s = summarise(contacts);
  const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '-');

  console.log(`OUTREACH as at ${today}\n`);
  console.log(`  contacts on file      ${String(s.contacts).padStart(4)}`);
  console.log(`  notes sent            ${String(s.sent).padStart(4)}   ${pct(s.sent, s.contacts)} of contacts`);
  console.log(`  answered              ${String(s.answered).padStart(4)}   ${pct(s.answered, s.sent)} of sent`);
  console.log(`  referrals confirmed   ${String(s.referrals).padStart(4)}   ${pct(s.referrals, s.sent)} of sent`);

  console.log('\n  BY STATUS');
  for (const st of STATUSES) if (s.byStatus[st]) console.log(`    ${String(s.byStatus[st]).padStart(4)}  ${st}`);
  const unknown = contacts.filter((c) => !STATUSES.includes(c.status));
  if (unknown.length) console.log(`    ${String(unknown.length).padStart(4)}  (blank or unrecognised — investigate)`);

  console.log('\n  WHO OWNS THEM');
  const owners = {};
  for (const c of contacts) owners[c.owner] = (owners[c.owner] || 0) + 1;
  const label = {
    referral: 'referral skill   (linked application is Stage 3, still unsent)',
    chase: 'chase skill      (linked application already went out)',
    'orphan-dead-application': 'NOBODY           (linked application is dead — archive or clear the relation)',
    'too-early': 'nobody yet       (application is below Stage 3)',
    unlinked: 'no application   (standalone contact — networking, not a specific role)',
  };
  for (const [k, v] of Object.entries(owners).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(4)}  ${label[k] || k}`);
  }

  const dead = contacts.filter((c) => c.owner === 'orphan-dead-application');
  if (dead.length) {
    console.log('\n  ORPHANS ON DEAD APPLICATIONS');
    for (const c of dead) console.log(`    ${String(c.appIds[0] || '-').padEnd(9)} ${String(c.stage).padEnd(12)} ${String(c.company).slice(0, 22).padEnd(23)} ${c.name}`);
  }

  const due = dueContacts(contacts, today);
  if (due.length) console.log(`\n  ${due.length} sent note(s) past the follow-up window — see --due`);

  console.log('\n  MEASUREMENT');
  if (s.sent === 0) {
    console.log(`    !! ${s.contacts} contacts, and not one has ever left "Not contacted".`);
    console.log('       No send count, no reply rate, no referral count. Until a real send is');
    console.log('       logged here, nothing about this system can be judged — including');
    console.log('       whether the drafts are any good.');
    console.log('       After you send one:  node scripts/outreach.mjs --mark "Name" --status "Note sent" --apply');
  } else {
    console.log(`    ${s.sent} send(s) on record. Answer rate ${pct(s.answered, s.sent)} across them.`);
    if (s.sent < 10) console.log('    Too few to read as a rate yet — treat these as a log, not a signal.');
  }
}

async function doMark(contacts, today) {
  const name = argOf('--mark');
  const to = argOf('--status');
  const when = argOf('--date') || today;
  const apply = has('--apply');
  if (!to) { console.error(`OUTREACH_ABORT: --status is required. One of: ${STATUSES.join(', ')}`); process.exit(2); }

  const res = resolveContact(contacts, {
    name, company: argOf('--company'), app: argOf('--app'), linkedin: argOf('--linkedin'),
  });
  if (!res.ok) {
    console.error(`OUTREACH_ABORT: ${res.why}`);
    for (const c of res.candidates || []) console.error(`    ${String(c.appIds?.[0] || '-').padEnd(9)} ${String(c.company).slice(0, 22).padEnd(23)} ${c.name}  ${c.linkedin}`);
    process.exit(3);
  }
  const c = res.contact;
  const move = canTransition(c.status, to);
  if (!move.ok && !has('--force')) {
    console.error(`OUTREACH_ABORT: ${c.name} is "${c.status}" — ${move.why}.`);
    console.error('    If the record is genuinely wrong, re-run with --force.');
    process.exit(4);
  }

  console.log(`${apply ? 'MARK ' : 'PLAN '} ${c.name}  (${c.company})`);
  console.log(`        ${c.status}  ->  ${to}${move.ok ? '' : '   [FORCED]'}`);
  console.log(`        date ${when}${c.appIds[0] ? `   application ${c.appIds[0]} (${c.stage})` : ''}`);
  if (!apply) { console.log('\n  Dry run. Re-run with --apply to write it.'); return; }

  // Date carries the send date from here on. At creation it was a placeholder
  // (bd-referral-scout stamps a fixed date), so it only becomes meaningful now.
  const props = { 'Outreach status': { select: { name: to } } };
  if (to === 'Note sent') props['Date'] = { date: { start: when } };

  const r = await fetch(`https://api.notion.com/v1/pages/${c.id}`, {
    method: 'PATCH', headers: NH, body: JSON.stringify({ properties: props }),
  });
  if (!r.ok) { console.error(`OUTREACH_FAIL: notion ${r.status} ${JSON.stringify(await r.json()).slice(0, 300)}`); process.exit(1); }
  console.log('  written.');

  // A confirmed referral is the one moment `Referral?` becomes true rather
  // than hoped for, so this is the only place it is written. Without it the
  // property stays blank for ever and "referred vs cold" — the comparison the
  // whole referral effort exists to make — cannot be computed. See metrics-core
  // isReferred / referralComparison.
  if (to === 'Referral confirmed' && c.appPageIds.length) {
    for (const appId of c.appPageIds) {
      const ar = await fetch(`https://api.notion.com/v1/pages/${appId}`, {
        method: 'PATCH', headers: NH,
        body: JSON.stringify({ properties: { 'Referral?': { select: { name: 'Referred!' } } } }),
      });
      console.log(ar.ok
        ? `  application ${c.appIds[0] || appId} marked Referred!`
        : `  WARN: could not mark the application Referred! (notion ${ar.status}) — set it by hand, or the funnel will read this as a cold application`);
    }
  }
}
