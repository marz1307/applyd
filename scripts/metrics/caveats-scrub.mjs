#!/usr/bin/env node
/**
 * caveats-scrub.mjs — bulk scrub em dashes + "not just" from output/ files
 *
 * What it does:
 *   1. `# X — Y` header lines  →  `# X: Y`
 *   2. `something — Capital`   →  `something. Capital`  (end-of-sentence em dash)
 *   3. ` — ` mid-sentence       →  `, `
 *   4. ` – ` spaced en dash     →  `, `  (German Gedankenstrich / prose aside)
 *   5. `, not just `            →  `, rather than `   (negative parallelism fix)
 *   6. `not just X`             →  `more than X`     (sentence-start variant)
 *   7. UNSPACED date-range en dashes (2018–2019) are EXEMPT (only ` – ` is scrubbed)
 *
 * Usage:
 *   node caveats-scrub.mjs --root output/form-answers --dry-run
 *   node caveats-scrub.mjs --root output/cover-letters
 *   node caveats-scrub.mjs --root output            # all of output/
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);
const ROOT = arg("--root") || "output";
const DRY = has("--dry-run");
const INCLUDE_HTML = has("--include-html");  // off by default — HTML date ranges are exempt

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else {
      const ext = extname(full).toLowerCase();
      if (ext === ".md") yield full;
      else if (ext === ".html" && INCLUDE_HTML) yield full;
    }
  }
}

function scrubText(s) {
  let out = s;
  // 1) Markdown header lines `# X — Y` → `# X: Y`. Also for #### sub-headers.
  out = out.replace(/^(#{1,6} [^\n—]*?) — /gm, "$1: ");

  // 2) End-of-sentence em dash: `word — Capital` → `word. Capital`
  //    Only when next non-space char is uppercase (heuristic for sentence break)
  out = out.replace(/([A-Za-z0-9)\]]) — ([A-Z])/g, "$1. $2");

  // 3) Remaining ` — ` (mid-sentence, parenthetical) → `, `
  out = out.replace(/ — /g, ", ");

  // 4) Edge cases: `—word` no spaces, or `word—word`
  out = out.replace(/—/g, ", ");

  // 4b) Spaced en dash ` – ` (German Gedankenstrich / prose aside) → `, `.
  //     Banned in body prose per cv-quality-rules §9.7. UNSPACED date ranges
  //     like `2018–2019` are NOT matched here, so they stay exempt.
  out = out.replace(/ – /g, ", ");

  // 4c) German letter closing takes NO comma (cv-quality-rules §9.9).
  out = out.replace(/Mit freundlichen Grüßen,/g, "Mit freundlichen Grüßen");

  // 5) "not just" negative parallelism — two flavours:
  //    a) `, not just X` (parenthetical contrast) → `, rather than X`
  out = out.replace(/, not just /g, ", rather than ");
  //    b) `not just X` mid-sentence (no preceding comma) → `more than just X` reads ok
  //    Keep this minimal: only the most common pattern.
  out = out.replace(/\bnot just\b/g, "more than just");

  return out;
}

if (!existsSync(ROOT)) { console.error(`root not found: ${ROOT}`); process.exit(2); }

let changed = 0, untouched = 0;
const changedFiles = [];
for (const f of walk(ROOT)) {
  const orig = readFileSync(f, "utf8");
  const next = scrubText(orig);
  if (next !== orig) {
    const before = (orig.match(/—/g)||[]).length + (orig.match(/ – /g)||[]).length + (orig.match(/\bnot just\b/g)||[]).length;
    const after = (next.match(/—/g)||[]).length + (next.match(/ – /g)||[]).length + (next.match(/\bnot just\b/g)||[]).length;
    changedFiles.push({ file: f, before, after });
    if (!DRY) writeFileSync(f, next);
    changed++;
  } else {
    untouched++;
  }
}

console.log(`Root: ${ROOT}`);
console.log(`Mode: ${DRY ? "DRY-RUN (no writes)" : "LIVE (writes applied)"}`);
console.log(`Files changed: ${changed}`);
console.log(`Files untouched: ${untouched}`);
console.log();
if (changedFiles.length) {
  console.log("Per-file delta (violations before -> after):");
  for (const c of changedFiles.slice(0, 50)) {
    const rel = c.file.replace(/\\/g, "/").split("/").slice(-2).join("/");
    console.log(`  ${rel.padEnd(60)}  ${c.before} -> ${c.after}`);
  }
  if (changedFiles.length > 50) console.log(`  ... and ${changedFiles.length - 50} more`);
}
