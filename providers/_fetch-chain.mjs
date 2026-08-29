// providers/_fetch-chain.mjs — Step −1 coherence-check fetch orchestrator.
//
// Tries each available fetcher in order. First success wins. Each tier is
// keyless-or-not based on the user's onboarding choices; missing config
// causes a graceful skip to the next tier, never an error.
//
// Order:
//   1. Firecrawl (self-host or cloud)   — opt-in via FIRECRAWL_URL/KEY
//   2. Bright Data Web Unlocker         — opt-in via BRIGHTDATA_API_KEY
//   3. Playwright (interactive only)    — always available when run via Claude Code
//   4. WebFetch (batch / headless)      — always available as last-resort
//
// Used by modes/oferta.md Step −1 (URL ↔ JD coherence) and by any other
// mode that needs to verify what a URL actually resolves to before recording
// the user-claimed identity.
//
// Files prefixed with _ are shared helpers, never loaded as scan-providers.

import { scrape as firecrawlScrape } from './firecrawl.mjs';
import { stripHtml } from '../scripts/text-safety.cjs';

/**
 * @typedef {object} FetchResult
 * @property {string} finalUrl   URL after redirects
 * @property {string} title      Page title or H1
 * @property {string} company    Best-effort company (may be "")
 * @property {string} body       Main markdown / text content
 * @property {boolean} isAlive   Heuristic: body ≥ 500 chars and no dead-page markers
 * @property {string} source     Which tier produced the result
 */

/**
 * Run the fetch chain for a single URL. Returns the first successful
 * fetcher's normalised result, or throws AggregateError if every tier fails.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.interactive=true]   If false, skip Playwright (batch mode).
 * @returns {Promise<FetchResult>}
 */
export async function fetchForCoherence(url, opts = {}) {
  const interactive = opts.interactive !== false;
  const errors = [];

  // 1. Firecrawl
  try {
    const r = await firecrawlScrape(url);
    return r;
  } catch (e) {
    errors.push({ tier: 'firecrawl', error: e.message, code: e.code });
  }

  // 2. Bright Data — only attempted if a key is configured.
  if ((process.env.BRIGHTDATA_API_KEY || '').trim()) {
    try {
      const r = await brightDataScrape(url);
      return r;
    } catch (e) {
      errors.push({ tier: 'bright-data', error: e.message });
    }
  } else {
    errors.push({ tier: 'bright-data', error: 'BRIGHTDATA_API_KEY not set' });
  }

  // 3. Playwright — runtime-injected by the agent in interactive mode.
  // This stub is intentionally a no-op; the agent reads modes/oferta.md
  // Step −1 and calls `browser_navigate` + `browser_snapshot` directly.
  // We surface a marker error so the agent knows to take over.
  if (interactive) {
    const err = new Error('Fetch chain exhausted automated tiers; agent should fall back to Playwright (browser_navigate + browser_snapshot).');
    err.code = 'agent-playwright-fallback';
    err.priorErrors = errors;
    throw err;
  }

  // 4. WebFetch fallback for batch / headless mode.
  try {
    const r = await webFetchFallback(url);
    return r;
  } catch (e) {
    errors.push({ tier: 'webfetch', error: e.message });
  }

  const agg = new Error(`All fetch tiers failed for ${url}`);
  agg.tiers = errors;
  throw agg;
}

// ── Bright Data Web Unlocker ─────────────────────────────────────────────

async function brightDataScrape(url) {
  // Web Unlocker endpoint — proxies the request through Bright Data's
  // residential network with bot-detection bypass. Returns HTML.
  const key = process.env.BRIGHTDATA_API_KEY.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res;
  try {
    res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, zone: process.env.BRIGHTDATA_ZONE || 'web_unlocker', format: 'raw' }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Bright Data ${res.status}`);
  const html = await res.text();
  return parseHtmlForCoherence(html, url, 'bright-data');
}

// ── WebFetch (batch / last-resort) ────────────────────────────────────────

async function webFetchFallback(url) {
  // No-auth, no-proxy plain fetch. Works on portals that don't gate by
  // bot detection (most company careers pages, ATS-hosted boards).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; applyd/1.3 +https://github.com/marz1307/applyd)' },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`WebFetch ${res.status}`);
  const finalUrl = res.url || url;
  const html = await res.text();
  return parseHtmlForCoherence(html, finalUrl, 'webfetch');
}

// ── Shared HTML parser ────────────────────────────────────────────────────

function parseHtmlForCoherence(html, finalUrl, source) {
  // Light, dependency-free HTML scrape. Good enough for ATS / company-careers
  // pages; Firecrawl is preferred for cleaner output.
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
  const ogSite = (html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] || '').trim();
  // Crude body extraction: strip tags from <body>...</body>. Uses the shared
  // state-machine parser (scripts/text-safety.cjs) — CodeQL rejects regex
  // tag-stripping outright, even the loop-until-stable variant
  // (js/bad-tag-filter + js/incomplete-multi-character-sanitization).
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let bodyText = '';
  if (bodyMatch) {
    bodyText = stripHtml(bodyMatch[1]).replace(/\s+/g, ' ').trim();
  }
  const dead = /(this job is no longer available|page not found|404|access denied|expired|filled position)/i;
  const isAlive = bodyText.length >= 500 && !dead.test(bodyText.slice(0, 2000));
  return { finalUrl, title, company: ogSite, body: bodyText.slice(0, 5000), isAlive, source };
}
