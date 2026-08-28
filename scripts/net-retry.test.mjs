// net-retry.test.mjs — guards on the transient-failure retry layer.
// Pure unit test, no real network: global fetch is stubbed per case.
//
// Why (2026-08-09): bd-bulk-scan lost whole runs (264 URLs, 10 portals) to a
// single ECONNRESET against api.notion.com, twice in one wrapper cycle, and
// the same signature is in 20 routine logs since June. The call site DID have
// an `if (!r.ok)` degrade path, but a network fault is a rejected promise, not
// a non-ok response, so it flew straight past the guard and killed the process.
import assert from 'node:assert';
import { fetchWithRetry, isTransientNetworkError, isRetryableStatus } from './net-retry.mjs';

let pass = 0, fail = 0;
const realFetch = globalThis.fetch;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  finally { globalThis.fetch = realFetch; }
}
// Silence the retry chatter; the assertions cover behaviour.
const quiet = { baseDelayMs: 1, maxDelayMs: 2, onRetry: () => {} };

// Reproduces the exact shape Node's fetch throws on a reset TLS handshake.
function econnreset() {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
  return err;
}
const res = (status, headers = {}) => new Response('{}', { status, headers });

console.log('\n=== classification ===');
await t('the real ECONNRESET is transient', () => assert.equal(isTransientNetworkError(econnreset()), true));
await t('bare "fetch failed" is transient', () => assert.equal(isTransientNetworkError(new TypeError('fetch failed')), true));
await t('ETIMEDOUT is transient', () => assert.equal(isTransientNetworkError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true));
await t('a TypeError from our own code is NOT', () => assert.equal(isTransientNetworkError(new TypeError("cannot read 'x' of undefined")), false));
await t('null is safe', () => assert.equal(isTransientNetworkError(null), false));
await t('429 and 5xx retryable', () => assert.ok(isRetryableStatus(429) && isRetryableStatus(503) && isRetryableStatus(500)));
await t('401/404 are real answers, not retryable', () => assert.ok(!isRetryableStatus(401) && !isRetryableStatus(404)));

console.log('\n=== retry behaviour ===');
await t('recovers when a later attempt succeeds', async () => {
  let n = 0;
  globalThis.fetch = async () => { if (++n < 3) throw econnreset(); return res(200); };
  const r = await fetchWithRetry('https://api.notion.com/v1/x', {}, quiet);
  assert.equal(r.status, 200);
  assert.equal(n, 3, 'should have taken 3 attempts');
});

await t('throws only after exhausting retries', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; throw econnreset(); };
  await assert.rejects(() => fetchWithRetry('https://api.notion.com/v1/x', {}, { ...quiet, retries: 2 }));
  assert.equal(n, 3, 'first try + 2 retries');
});

await t('does NOT retry a non-transient error', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; throw new TypeError("bad property 'z'"); };
  await assert.rejects(() => fetchWithRetry('https://x', {}, quiet));
  assert.equal(n, 1, 'a code bug must fail fast, not 5x');
});

await t('retries 503 then returns success', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n < 2 ? res(503) : res(200));
  const r = await fetchWithRetry('https://x', {}, quiet);
  assert.equal(r.status, 200);
});

await t('returns 401 immediately without retrying', async () => {
  let n = 0;
  globalThis.fetch = async () => { n++; return res(401); };
  const r = await fetchWithRetry('https://x', {}, quiet);
  assert.equal(r.status, 401);
  assert.equal(n, 1, 'a bad token will never fix itself');
});

await t('returns the last non-ok response rather than throwing', async () => {
  globalThis.fetch = async () => res(500);
  const r = await fetchWithRetry('https://x', {}, { ...quiet, retries: 1 });
  assert.equal(r.status, 500, 'callers keep their own !r.ok handling');
});

await t('honours Retry-After without hanging', async () => {
  let n = 0;
  globalThis.fetch = async () => (++n < 2 ? res(429, { 'retry-after': '0' }) : res(200));
  const r = await fetchWithRetry('https://x', {}, quiet);
  assert.equal(r.status, 200);
});

console.log(`\n${fail === 0 ? '✓' : '✗'} net-retry.test.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
