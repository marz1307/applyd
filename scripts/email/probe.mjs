/**
 * probe.mjs — run the response-matcher over a batch of messages. WRITES NOTHING.
 *
 * Input is a JSON array of messages, which the caller supplies. Today that
 * caller is an interactive session reading the query from `queryHint()` through
 * the Gmail MCP connector; scheduled routines cannot see account-level
 * connectors (`--strict-mcp-config`), so this script deliberately does NOT
 * fetch. Keeping I/O out means the logic needs no credentials and survives a
 * change of mailbox, provider, or auth story.
 *
 * Message shape (extra keys ignored):
 *   { id, date, sender, senderName, subject, body }
 *
 * Usage:
 *   node scripts/email/probe.mjs --in data/.email-batch.json
 *   node scripts/email/probe.mjs --in <file> --json
 *   node scripts/email/probe.mjs --in <file> --apply-file data/.email-apply.json
 *
 * --apply-file writes ONLY the auto-appliable proposals (unambiguous rejections
 * and confirmations) for a separate step to act on. Everything uncertain lands
 * in the NEEDS YOU bucket instead. This script never touches Notion.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { propose, isAutoAppliable, needsAttention, isRelay, senderDomain, tokens, companyIn } from './match.mjs';
import { loadState, saveState, queryHint, filterNew, commit } from './scan-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const NOTION_QUERY = path.join(REPO, 'scripts', 'notion', 'notion-query.mjs');

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const IN = argOf('--in');
const JSON_OUT = args.includes('--json');
const APPLY_FILE = argOf('--apply-file');
const ALL = args.includes('--all');           // ignore the cursor, re-scan everything
const COMMIT = args.includes('--commit');     // advance the cursor after a successful run

if (!IN) {
  console.error('usage: node scripts/email/probe.mjs --in <messages.json> [--json] [--apply-file <path>]');
  process.exit(2);
}

const state = loadState();
const allMessages = JSON.parse(readFileSync(IN, 'utf8'));
// Incremental by default: the ID ledger is the source of truth for what has
// already been handled, so a re-supplied batch costs nothing.
const messages = ALL ? allMessages : filterNew(allMessages, state);
const skipped = allMessages.length - messages.length;
const rows = JSON.parse(
  execFileSync('node', [NOTION_QUERY, '--json'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
);

const proposals = messages.map((m) => propose(m, rows));

/* ─── measure how identifiable the employer actually is in each channel ────
 * Rather than assuming "the employer is in the FROM column", measure it
 * against every message and measure each signal separately so we learn WHICH
 * one is carrying the match.
 */
const live = rows.filter((r) => ['4. Applied', '5. Assessment/OA', '6. Phone screen',
  '7. Tech interview', '8. Onsite/Final', '9. Offer'].includes(r.stage) && r.title);
const companies = [...new Set(live.map((r) => r.title))].map((t) => ({ t, toks: tokens(t) }));

const sig = { display_name: 0, domain: 0, subject: 0, any: 0, relay: 0, none: 0 };
for (const m of messages) {
  const name = m.senderName || '';
  const dom = senderDomain(m.sender).replace(/\./g, ' ');
  const relay = isRelay(m.sender);
  if (relay) sig.relay++;
  const n = companies.some((c) => companyIn(name, c.toks));
  const d = !relay && companies.some((c) => companyIn(dom, c.toks));
  const s = companies.some((c) => companyIn(m.subject || '', c.toks));
  if (n) sig.display_name++;
  if (d) sig.domain++;
  if (s) sig.subject++;
  if (n || d || s) sig.any++; else sig.none++;
}

const byConf = {}, byKind = {};
proposals.forEach((p) => {
  byConf[p.confidence] = (byConf[p.confidence] || 0) + 1;
  byKind[p.kind] = (byKind[p.kind] || 0) + 1;
});
const auto = proposals.filter(isAutoAppliable);
const attention = proposals.filter(needsAttention);

if (APPLY_FILE) {
  writeFileSync(APPLY_FILE, JSON.stringify(auto, null, 2));
}

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: messages.length, signals: sig, by_confidence: byConf,
    by_kind: byKind, auto_appliable: auto.length, needs_attention: attention.length,
    auto, attention, proposals }, null, 2));
} else {
  const pct = (n) => messages.length ? Math.round((n / messages.length) * 100) : 0;
  console.log('');
  console.log(`  messages            ${messages.length} new${skipped ? `  (${skipped} already scanned, skipped)` : ''}`);
  console.log(`  cursor              ${state.cursor || '(none — first run)'}`);
  console.log(`  next query          ${queryHint(COMMIT ? commit(state, messages) : state)}`);
  console.log(`  live pipeline rows  ${live.length} across ${companies.length} companies`);
  console.log('');
  console.log('  employer recoverable from      count  rate');
  console.log(`    FROM display name            ${String(sig.display_name).padStart(5)}  ${pct(sig.display_name)}%`);
  console.log(`    FROM domain                  ${String(sig.domain).padStart(5)}  ${pct(sig.domain)}%`);
  console.log(`    subject line                 ${String(sig.subject).padStart(5)}  ${pct(sig.subject)}%`);
  console.log(`    any of the three             ${String(sig.any).padStart(5)}  ${pct(sig.any)}%`);
  console.log(`    none                         ${String(sig.none).padStart(5)}  ${pct(sig.none)}%`);
  console.log(`  sent via an ATS/portal relay   ${String(sig.relay).padStart(5)}  ${pct(sig.relay)}%`);
  console.log('');
  console.log('  classified as:');
  Object.entries(byKind).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));
  console.log('  confidence:');
  Object.entries(byConf).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));

  const show = (p) => {
    const who = p.candidates.map((c) => `${c.application_id} ${c.company} [${c.matched_via.join('+')}]`).join(' | ') || '(no match)';
    console.log(`    ${p.kind.padEnd(13)} -> ${String(p.proposed_stage || '-').padEnd(18)} ${who}`);
    console.log(`      "${(p.subject || '').slice(0, 72)}"  <${p.sender}>`);
  };

  console.log('');
  console.log(`  --- AUTO-APPLY (${auto.length}) — unambiguous rejections and confirmations ---`);
  auto.length ? auto.forEach(show) : console.log('    (none)');

  // The escalation bucket: an outcome was recognised but the row is uncertain,
  // or it is a kind we refuse to file without a human.
  console.log('');
  console.log(`  --- NEEDS YOU (${attention.length}) ---`);
  if (!attention.length) console.log('    (none)');
  attention.forEach((p) => {
    const why = p.confidence === 'ambiguous'
      ? `${p.candidates.length} open applications at this company — which one?`
      : p.confidence === 'unmatched' ? 'no matching row in the pipeline'
      : 'this kind is never auto-filed';
    console.log(`    [${why}]`);
    show(p);
  });

  console.log('');
  console.log('--- EMAIL_PROBE_CONTRACT ---');
  console.log(`SCANNED: ${messages.length}`);
  console.log(`MATCH_RATE_ANY_PCT: ${pct(sig.any)}`);
  console.log(`MATCH_RATE_DISPLAY_NAME_PCT: ${pct(sig.display_name)}`);
  console.log(`AUTO_APPLIABLE: ${auto.length}`);
  console.log(`NEEDS_ATTENTION: ${attention.length}`);
  console.log(`SKIPPED_ALREADY_SCANNED: ${skipped}`);
  console.log(`CURSOR_COMMITTED: ${COMMIT ? 'yes' : 'no'}`);
  console.log(`WRITES_PERFORMED: 0`);
  console.log('--- END ---');
}

// Advance the cursor only when asked, and only over what this run actually saw.
// Default is dry: re-running without --commit is always safe.
if (COMMIT) {
  saveState(commit(state, messages));
}
