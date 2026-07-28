// providers/firecrawl.mjs — Firecrawl-backed page fetch for Step −1 coherence.
//
// Used by providers/_fetch-chain.mjs as the preferred fetcher. Works in two
// modes depending on env:
//
//   FIRECRAWL_URL=http://localhost:3002          → self-hosted Firecrawl OSS
//   FIRECRAWL_API_KEY=fc-...                     → Firecrawl Cloud
//
// If both are set, self-hosted wins (no per-scrape cost).
// If neither is set, scrape() throws an Error tagged with code='no-firecrawl'
// so the fetch-chain falls through to the next provider.
//
// Files prefixed with _ are never loaded as scan-providers; this file is NOT
// prefixed because it is also used directly by the coherence-check pipeline.

const FIRECRAWL_PUBLIC_API = 'https://api.firecrawl.dev';
const TIMEOUT_MS = 30_000;

/**
 * Fetch a page through Firecrawl and return a normalised shape suitable for
 * Step −1 URL ↔ JD coherence checks.
 *
 * @param {string} url
 * @returns {Promise<{finalUrl:string, title:string, company:string, body:string, isAlive:boolean, source:'firecrawl'}>}
 */
export async function scrape(url) {
  const localUrl = (process.env.FIRECRAWL_URL || '').trim();
  const apiKey = (process.env.FIRECRAWL_API_KEY || '').trim();

  if (!localUrl && !apiKey) {
    const err = new Error('Firecrawl not configured (neither FIRECRAWL_URL nor FIRECRAWL_API_KEY set)');
    err.code = 'no-firecrawl';
    throw err;
  }

  const base = localUrl || FIRECRAWL_PUBLIC_API;
  const headers = { 'Content-Type': 'application/json' };
  if (!localUrl && apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/v1/scrape`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Firecrawl ${res.status}: ${text.slice(0, 200)}`);
    err.code = 'firecrawl-http';
    err.status = res.status;
    throw err;
  }

  const payload = await res.json();
  const data = payload?.data || payload;

  const finalUrl = data?.metadata?.sourceURL || data?.metadata?.url || url;
  const title = (data?.metadata?.title || '').trim();
  const description = (data?.metadata?.description || '').trim();
  const body = (data?.markdown || '').trim();

  // Company extraction is best-effort. Firecrawl's metadata sometimes exposes
  // og:site_name; otherwise we leave it empty and let the caller compare
  // against the user-named company by title-substring + URL-host.
  const company = (
    data?.metadata?.ogSiteName ||
    data?.metadata?.['og:site_name'] ||
    data?.metadata?.author ||
    ''
  ).trim();

  // isAlive heuristic: body has at least 500 chars of substantive content
  // and doesn't match known dead-page templates.
  const dead = /(this job is no longer available|page not found|404|access denied|expired|filled position)/i;
  const isAlive = body.length >= 500 && !dead.test(body.slice(0, 2000));

  return { finalUrl, title, company, body, isAlive, description, source: 'firecrawl' };
}

/**
 * Best-effort liveness ping. Returns true if Firecrawl is reachable and
 * responsive at the configured endpoint. Used by /applyd doctor and by
 * the install script's post-install verification.
 *
 * @returns {Promise<{ok:boolean, mode:'self-host'|'cloud'|'none', detail:string}>}
 */
export async function health() {
  const localUrl = (process.env.FIRECRAWL_URL || '').trim();
  const apiKey = (process.env.FIRECRAWL_API_KEY || '').trim();
  if (!localUrl && !apiKey) {
    return { ok: false, mode: 'none', detail: 'No FIRECRAWL_URL or FIRECRAWL_API_KEY in env' };
  }
  const base = localUrl || FIRECRAWL_PUBLIC_API;
  const mode = localUrl ? 'self-host' : 'cloud';
  try {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (res.ok) return { ok: true, mode, detail: `${base} healthy` };
    return { ok: false, mode, detail: `${base} returned ${res.status}` };
  } catch (e) {
    return { ok: false, mode, detail: `${base} unreachable: ${e.message}` };
  }
}
