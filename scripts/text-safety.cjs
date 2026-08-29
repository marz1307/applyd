'use strict';

// =========================================================================
// text-safety.cjs — shared HTML → visible-text sanitiser.
//
// CodeQL's `js/bad-tag-filter` rule rejects regex-based tag stripping
// outright — even the loop-until-stable pattern was flagged (see the
// alerts on writing-eval.mjs:156, market-tail.cjs:256, _fetch-chain.mjs:152).
// The accepted fix is a proper state-machine parser. The version below is
// the one CodeQL accepted for scripts/cv/cv-qa.mjs (v2.3), extracted here
// so every call site shares ONE implementation.
//
// This is a CJS module on purpose: market-tail.cjs is CJS and needs
// require(); ESM callers (writing-eval.mjs, _fetch-chain.mjs, cv-qa.mjs)
// can `import { stripHtml } from '../text-safety.cjs'` via Node's ESM
// named-export detection for `module.exports = { … }`.
// =========================================================================

/**
 * Strip HTML tags, `<script>` / `<style>` blocks, and HTML comments from
 * `html`, returning the visible text. Uses a single-pass state-machine
 * parser (no regex tag-strip loop) so it is not vulnerable to the nested/
 * split tag attacks CodeQL's `js/bad-tag-filter` and
 * `js/incomplete-multi-character-sanitization` rules flag.
 *
 * Common HTML entities (&nbsp; &lt; &gt; &quot; &#39; &amp;) are decoded
 * in a single regex pass — the regex only matches once per entity, so
 * decoding `&amp;lt;` yields `&lt;` (not `<`) and no double-decode issue.
 *
 * Post-processing collapses runs of spaces/tabs to one space and runs of
 * blank lines to two, then trims. Callers that need aggressive whitespace
 * collapsing can still apply their own `\s+ → ' '` on the return value.
 *
 * @param {string} html
 * @returns {string}
 */
function stripHtml(html) {
  const src = String(html || '');
  const lc = src.toLowerCase();
  let out = '';
  let inTag = false;
  let skip = false;      // inside <script> or <style>
  let inComment = false; // inside <!-- ... -->
  for (let i = 0; i < src.length; i++) {
    if (inComment) {
      if (src.startsWith('-->', i)) { inComment = false; i += 2; }
      continue;
    }
    if (!skip && lc.startsWith('<!--', i)) { inComment = true; i += 3; continue; }
    if (!skip && lc.startsWith('<style', i)) skip = 'style';
    else if (!skip && lc.startsWith('<script', i)) skip = 'script';
    if (skip === 'style' && lc.startsWith('</style>', i)) { skip = false; i += 7; continue; }
    if (skip === 'script' && lc.startsWith('</script>', i)) { skip = false; i += 8; continue; }
    if (skip) continue;
    if (src[i] === '<') { inTag = true; out += ' '; continue; }
    if (src[i] === '>') { inTag = false; continue; }
    if (!inTag) out += src[i];
  }
  const entities = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  out = out.replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, m => entities[m] || m);
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { stripHtml };
