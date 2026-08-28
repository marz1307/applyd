// net-retry.mjs — ONE definition of "retry a flaky HTTP call".
//
// Why this exists (2026-08-09). bd-bulk-scan died with an uncaught
// `TypeError: fetch failed` / `ECONNRESET` against api.notion.com and lost the
// entire run: 264 URLs across 10 portals, thrown away because one TLS
// handshake was reset. Both wrapper attempts died the same way 90s apart, and
// the same signature appears in 20 routine logs going back to 2026-06-18.
//
// The subtle part, and the reason the existing guard did not help: the call
// sites DID handle failure, but only the HTTP kind —
//
//     const r = await fetch(url, ...);
//     if (!r.ok) { ...degrade gracefully... }   // never reached
//
// A network-layer failure is not a non-ok response. It is a REJECTED PROMISE,
// so it flies straight past `if (!r.ok)` and out of the function. In a script
// with no top-level handler that is an uncaught exception and the process
// exits non-zero. Any `if (!r.ok)` guard written without a surrounding
// try/catch is only half a guard.
//
// Retries cover transient faults only: network resets, DNS blips, timeouts,
// 429, and 5xx. A 4xx other than 429 is a real answer (bad token, bad body,
// not found) and is returned immediately — retrying it just wastes the run.

// Node's fetch wraps the real error in `cause`, so the code lives one level
// down. Message-matching is the fallback for causes that carry no code.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const TRANSIENT_MSG_RE = /socket disconnected|network socket|fetch failed|timeout|terminated|other side closed|premature close/i;

export function isTransientNetworkError(err) {
  if (!err) return false;
  const code = err.code || (err.cause && err.cause.code) || '';
  if (TRANSIENT_CODES.has(code)) return true;
  const msg = `${err.message || ''} ${(err.cause && err.cause.message) || ''}`;
  return TRANSIENT_MSG_RE.test(msg);
}

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

// Honour Retry-After when the server sends one (Notion does on 429). Accepts
// both the delta-seconds and HTTP-date forms. Capped so a hostile or bogus
// header cannot park a scheduled routine for hours.
function retryAfterMs(res, capMs) {
  const raw = res && res.headers && res.headers.get && res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  let ms = Number.isFinite(secs) ? secs * 1000 : (Date.parse(raw) - Date.now());
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, capMs);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * fetch() that survives a flaky network.
 *
 * Returns the Response (including non-ok ones that are not worth retrying, so
 * callers keep their existing `if (!r.ok)` handling). Throws only when every
 * attempt failed at the network layer — by then it is a real outage, not a
 * blip, and the caller should decide whether to degrade or abort.
 *
 * @param {string} url
 * @param {object} init            passed through to fetch
 * @param {object} [opts]
 * @param {number} [opts.retries=4]        retry attempts AFTER the first try
 * @param {number} [opts.baseDelayMs=1000] first backoff; doubles each attempt
 * @param {number} [opts.maxDelayMs=30000] per-attempt backoff cap
 * @param {string} [opts.label='']         prefix for the progress lines
 * @param {function} [opts.onRetry]        (attempt, delayMs, reason) => void
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const {
    retries = 4, baseDelayMs = 1000, maxDelayMs = 30_000, label = '',
    onRetry = (attempt, delayMs, reason) =>
      console.error(`${label ? label + ': ' : ''}retry ${attempt}/${retries} in ${Math.round(delayMs / 1000)}s (${reason})`),
  } = opts;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with jitter. Jitter matters because bd-bulk-scan
      // fires several Notion calls in a burst; without it they would all
      // retry on the same tick and re-collide.
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
    try {
      const res = await fetch(url, init);
      if (isRetryableStatus(res.status) && attempt < retries) {
        const wait = retryAfterMs(res, maxDelayMs);
        onRetry(attempt + 1, wait ?? Math.min(baseDelayMs * 2 ** attempt, maxDelayMs), `HTTP ${res.status}`);
        if (wait) await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || attempt === retries) throw err;
      const code = err.code || (err.cause && err.cause.code) || 'network error';
      onRetry(attempt + 1, Math.min(baseDelayMs * 2 ** attempt, maxDelayMs), code);
    }
  }
  throw lastErr || new Error(`fetchWithRetry: exhausted ${retries} retries for ${url}`);
}

export default { fetchWithRetry, isTransientNetworkError, isRetryableStatus };
