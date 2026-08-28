/**
 * llm-client.mjs — shared Anthropic-API-plus-subscription-fallback client.
 *
 * Extracted from cv-qa.mjs + profile-enrich.mjs, which each had near-identical
 * callApi / callSubscription / callClaude implementations. One home now.
 *
 * Cost model (identical for both callers):
 *   - Default: subscription-only via `claude -p` on Claude Max (zero API cost).
 *     ANTHROPIC_API_KEY is IGNORED in this mode even when set.
 *   - Opt-in: CAREEROPS_QA_USE_API=1 enables the metered Anthropic API path
 *     (Haiku by default). Kept behind an env var because it bills real credits
 *     and an unintended Opus-tier drain is easy to trigger.
 *
 * Both auth paths fall through: API failure (credit depletion, 5xx, network,
 * timeout, truncation) → automatic fallback to subscription. Callers see
 * ONE async call() that always returns text.
 *
 * Cost accounting stays PER-CALLER — cv-qa keeps its qaCost accumulator, this
 * module just returns usage counters from the API path so callers can add them
 * to whatever aggregate they maintain. Subscription calls have no counters.
 *
 * Usage:
 *   import { callClaude } from './llm-client.mjs';
 *   const { text, usage, source } = await callClaude({
 *     systemPrompt, userMessage,
 *     model: 'claude-haiku-4-5-20251001',
 *     fallbackModel: 'claude-opus-4-8',
 *     maxTokens: 8192,
 *     timeout: 360000,
 *   });
 *   // source is 'api' | 'subscription'
 *   // usage is { input_tokens, cache_write_tokens, cache_read_tokens, output_tokens } (API) or null (subscription)
 */

import { spawnSync } from 'node:child_process';

const ALLOW_API = process.env.CAREEROPS_QA_USE_API === '1';
const API_KEY = ALLOW_API ? (process.env.ANTHROPIC_API_KEY || null) : null;
// Path to the `claude` CLI for the subscription fallback. Configure via
// CLAUDE_EXE when it is not on PATH.
const CLAUDE_EXE = process.env.CLAUDE_EXE || 'claude';

// Cost guard — a mistaken Opus API call has drained accounts. This module
// bans Opus on the metered API path: throw before dialling. Opus is only
// reachable via the subscription fallback.
function assertNotOpusApi(model) {
  if (/opus/i.test(model)) {
    throw new Error(`[llm-client] COST GUARD: model="${model}" is an Opus model. Opus is banned on the metered API. Use Haiku (or Sonnet) for the API path; Opus is only reachable via the subscription fallback.`);
  }
}

async function callApi({ systemPrompt, userMessage, model, maxTokens }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // Prompt caching: the system prompt is byte-identical across every row
      // for a given caller (cv-qa: audit rubric; enrich: framework rules), so
      // cache it. First call pays 1.25x write; subsequent calls within the
      // 5-min TTL read at ~0.1x. Per-row data stays in `messages` after the
      // cached prefix so it never invalidates.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  if (!data.content?.[0] || data.content[0].type !== 'text') {
    throw new Error(`Unexpected API response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Response truncated at max_tokens=${maxTokens}. Caller should raise the limit.`);
  }
  const u = data.usage || {};
  return {
    text: data.content[0].text,
    source: 'api',
    usage: {
      input_tokens:        u.input_tokens              ?? 0,
      cache_write_tokens:  u.cache_creation_input_tokens ?? 0,
      cache_read_tokens:   u.cache_read_input_tokens   ?? 0,
      output_tokens:       u.output_tokens             ?? 0,
    },
  };
}

function callSubscription({ systemPrompt, userMessage, fallbackModel, timeout }) {
  const prompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
  // Strip ANTHROPIC_API_KEY from the child env so the CLI uses its OAuth
  // subscription login (free), never the metered API. Without this, a
  // subscribed user with a key set would pay Opus-tier API costs for the
  // fallback — the exact failure this fallback exists to prevent.
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  const result = spawnSync(
    CLAUDE_EXE,
    ['-p', '--model', fallbackModel, '--output-format', 'text', '--allowedTools', ''],
    { input: prompt, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024, env: childEnv },
  );
  if (result.error) throw new Error(`claude -p launch failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`claude -p exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
  }
  const text = (result.stdout || '').trim();
  if (!text) throw new Error('claude -p returned empty output');
  return { text, source: 'subscription', usage: null };
}

/**
 * Call Claude with automatic API-to-subscription fallback.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt      System prompt (cached in API path).
 * @param {string} opts.userMessage       Per-row user message.
 * @param {string} opts.model             API model (e.g. 'claude-haiku-4-5-20251001'). Opus is rejected.
 * @param {string} opts.fallbackModel     Subscription model (e.g. 'claude-opus-4-8').
 * @param {number} [opts.maxTokens=8192]  API max_tokens.
 * @param {number} [opts.timeout=360000]  Subscription timeout in ms.
 * @returns {Promise<{text: string, source: 'api'|'subscription', usage: object|null}>}
 */
export async function callClaude({
  systemPrompt, userMessage, model, fallbackModel,
  maxTokens = 8192, timeout = 360000,
}) {
  assertNotOpusApi(model);
  if (!API_KEY) {
    return callSubscription({ systemPrompt, userMessage, fallbackModel, timeout });
  }
  try {
    return await callApi({ systemPrompt, userMessage, model, maxTokens });
  } catch (err) {
    console.error(`[llm-client] API failed (${String(err.message).slice(0, 120)}) — falling back to ${fallbackModel} on Claude Max subscription`);
    return callSubscription({ systemPrompt, userMessage, fallbackModel, timeout });
  }
}

// Export the mode-check so callers can log which path they will take on the
// first call (cv-qa does this to help debug env-var issues).
export const clientMode = {
  api_enabled: !!API_KEY,
  opt_in_flag_set: ALLOW_API,
  key_present: !!process.env.ANTHROPIC_API_KEY,
};
