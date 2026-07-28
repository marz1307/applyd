// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.mjs.

// Bumped 10_000 -> 20_000 on 2026-05-29: Ashby's posting-api endpoint
// consistently responds in ~10.2s (verified with 3-try curl probe), so
// the previous 10s budget aborted every single Ashby company. Faster
// providers (Greenhouse, Lever) still return in <1s, so the higher cap
// only matters when a slow provider is being polled.
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; applyd/1.3)';

async function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'follow' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'user-agent': DEFAULT_USER_AGENT, ...headers },
      body,
      redirect,
      signal: controller.signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      const snippet = responseText.replace(/\s+/g, ' ').trim().slice(0, 300);
      const err = new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
      err.status = res.status;
      err.body = responseText;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  return await res.text();
}

export function makeHttpCtx() {
  return {
    transport: 'http',
    fetchJson,
    fetchText,
  };
}
