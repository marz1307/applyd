#!/usr/bin/env node
// Fetch JD pages for the auto-draft candidate rows via the Bright Data Web
// Unlocker REST zone, and emit one raw-markdown blob per URL in the same shape
// `_autodraft_split_jd.mjs` already consumes: [{status, value:{url, content}}].
//
// WHY THIS EXISTS. The routine's documented fetch path is the Bright Data MCP's
// scrape_batch. When the brightdata MCP server does not connect, no scrape tool
// is exposed at all. BRIGHTDATA_API_KEY is set, though, and the bulk scanner
// already proves the REST unblocker path (`api.brightdata.com/request` with the
// `cli_unlocker` zone) reaches LinkedIn/XING where a plain fetch is bot-walled.
// This is that same call, minus the SERP-specific `brd_json` flag: for a
// direct page we want the rendered document, not Google's parsed result set.
//
// Output stays raw on purpose. Chrome-stripping is `_autodraft_split_jd.mjs`'s
// job and it keys off the portals' literal furniture text, so trimming here
// would only move the markers out from under it.
//
// TWO FAILURE MODES THIS HANDLES:
//   1. SILENT EMPTY. When the Bright Data account is suspended, the unblocker
//      answers HTTP 200 with an EMPTY body and puts the real error only in the
//      `x-brd-err-code` / `proxy-status` headers. `r.ok` is true, so naive
//      code would record "ok 0 chars" for every row and the routine would
//      draft blind: no JD text means pickLang() and the seniority detector
//      guess from metadata and the cover-letter research layer has nothing to
//      ground on. An empty or error-flagged body is an ERROR.
//   2. BD DOWN ENTIRELY. A self-hosted Firecrawl at localhost:3002 (the same
//      daemon bd-bulk-scan uses for XING/CareerBee) reaches LinkedIn,
//      Stepstone and XING too. It is the automatic fallback per URL, so a
//      suspended billing page does not cost a whole night's drafting.
//
// Usage: node batch/_autodraft_fetch_jds.mjs <APP-ID> [<APP-ID> ...]
//        node batch/_autodraft_fetch_jds.mjs --all-filtered --limit 12
import fs from 'node:fs';
import path from 'node:path';
import { fetchWithRetry } from "../scripts/net-retry.mjs";  // survive transient ECONNRESET

const ROOT = process.cwd();
const TMP = path.join(ROOT, 'data', '.routine-tmp');
const QUEUE = path.join(TMP, 'draft-queue-filtered.json');
const OUT = path.join(TMP, 'jd-batch-result.json');

const BD_KEY = process.env.BRIGHTDATA_API_KEY;
const ZONE = process.env.BRIGHTDATA_UNLOCKER_ZONE || 'cli_unlocker';
const FIRECRAWL_URL = process.env.FIRECRAWL_API_URL || 'http://localhost:3002';
// A page that renders to less than this is portal chrome or a block page, not
// a posting. The shortest real JD in a working corpus is ~1.5k chars of
// markdown; anything under ~1.2k is chrome.
const MIN_CONTENT = 1200;

// Some block pages are long enough to clear MIN_CONTENT, so check the body
// for the interstitials' own furniture too. These strings never appear in a
// posting.
const BLOCK_SIGNATURES = [
  /Additional Verification Required/i,
  /\bRay ID\b/i,
  /Just a moment\.\.\./i,
  /Enable JavaScript and cookies to continue/i,
  /Consent Management Platform/i,
  /Axeptio consent/i,
  /Attention Required!\s*\|\s*Cloudflare/i,
  /Please verify you are a human/i,
  // EXPIRED POSTINGS, not blocks — same handling because the failure is
  // identical: a page with no posting on it. These portals answer HTTP 200
  // with an "ad is gone" shell whose surrounding nav/footer is well over
  // MIN_CONTENT, so the length gate passes it.
  /This job ad isn't available/i,
  /Das gesuchte Stellenangebot ist leider nicht mehr verfügbar/i,
  /The page you.{0,3}re looking for can.{0,3}t be found/i,
  /no longer accepting applications/i,
];

function blockSignature(text) {
  const head = String(text).slice(0, 4000);
  const hit = BLOCK_SIGNATURES.find((re) => re.test(head));
  return hit ? hit.source : null;
}

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const ids = args.filter((a) => /^APP-\d+$/.test(a));

const rows = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const picked = ids.length
  ? ids.map((id) => rows.find((r) => r.application_id === id)).filter(Boolean)
  : rows.slice(0, LIMIT);

// Unlocker returns the rendered document. `data_format: 'markdown'` asks BD to
// do the HTML->markdown conversion server-side, which is what the MCP's
// scrape_as_markdown does under the hood and what split_jd's markers expect.
async function fetchBrightData(url) {
  if (!BD_KEY) throw new Error('BRIGHTDATA_API_KEY missing');
  const r = await fetchWithRetry('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: ZONE, url, format: 'raw', data_format: 'markdown' }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  // The suspended-account / blocked-request answer is 200 + empty body + headers.
  const brdErr = r.headers.get('x-brd-err-msg') || r.headers.get('x-brd-err-code');
  if (brdErr) throw new Error(`brightdata: ${String(brdErr).slice(0, 160)}`);
  if (text.trim().length < MIN_CONTENT) {
    throw new Error(`brightdata returned ${text.trim().length} chars (empty/blocked)`);
  }
  const sig = blockSignature(text);
  if (sig) throw new Error(`brightdata returned a block page (/${sig}/)`);
  return text;
}

// Self-hosted Firecrawl. Same daemon bd-bulk-scan self-heals and uses for the
// portals BD cannot reach cheaply; here it is the availability backstop.
async function fetchFirecrawl(url) {
  const r = await fetchWithRetry(`${FIRECRAWL_URL}/v1/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`firecrawl HTTP ${r.status}: ${text.slice(0, 200)}`);
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('firecrawl: non-JSON response'); }
  const md = body?.data?.markdown || '';
  if (!body.success || md.trim().length < MIN_CONTENT) {
    throw new Error(`firecrawl returned ${md.trim().length} chars (empty/blocked)`);
  }
  const sig = blockSignature(md);
  if (sig) throw new Error(`firecrawl returned a block page (/${sig}/)`);
  return md;
}

async function fetchOne(url) {
  const problems = [];
  for (const [name, fn] of [['brightdata', fetchBrightData], ['firecrawl', fetchFirecrawl]]) {
    try {
      return { content: await fn(url), via: name };
    } catch (e) {
      problems.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(problems.join(' | '));
}

const CONCURRENCY = 4;
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < picked.length) {
    const row = picked[cursor++];
    const url = String(row.job_url || '').trim();
    if (!url) { results.push({ status: 'rejected', app: row.application_id, reason: 'no job_url' }); continue; }
    try {
      const { content, via } = await fetchOne(url);
      results.push({ status: 'fulfilled', app: row.application_id, via, value: { url, content } });
      console.error(`  ok    ${row.application_id} ${content.length} chars via ${via}  ${row.title}`);
    } catch (e) {
      results.push({ status: 'rejected', app: row.application_id, url, reason: String(e.message || e) });
      console.error(`  FAIL  ${row.application_id} ${row.title}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker));

fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
const ok = results.filter((r) => r.status === 'fulfilled').length;
const byVia = results.filter((r) => r.status === 'fulfilled')
  .reduce((m, r) => (m[r.via] = (m[r.via] || 0) + 1, m), {});
console.error(`\nfetched ${ok}/${picked.length} (${JSON.stringify(byVia)}) -> ${OUT}`);
if (!ok) process.exit(4);
