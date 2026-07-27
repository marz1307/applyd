#!/usr/bin/env node
/**
 * caveats-audit.mjs — scan output/ for cv-quality-rules.md Section 4 violations
 *
 * Reports per-file counts of:
 *  - Em dashes (—)
 *  - En dashes (–)
 *  - Banned vocabulary
 *  - Banned constructions (copula-avoidance, negative parallelism)
 *
 * Usage: node caveats-audit.mjs [--root output/] [--json] [--top 30]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);
const ROOT = arg("--root") || "output";
const JSON_OUT = has("--json");
const TOP = parseInt(arg("--top") || "30", 10);

// Banned vocabulary — word-boundary matched
const BANNED_WORDS = [
  "leverage",         // as verb (lexical match — manual review for ambiguous noun cases)
  "synergize", "synergy", "synergies",
  "delve",
  "crucial",
  "pivotal",
  "key role",
  "interplay",
  "intricate", "intricacies",
  "tapestry",
  "testament",
  "vibrant",
  "enduring",
  "garner",
  "showcase",
  "boasts",
  "nestled",
  "in the heart of",
  "passionate about",
  "results-driven",
  "I excel at",
  "transformative",
  "groundbreaking",
  "seamless",
  "robust solution",
  "cutting-edge",
  "deep dive",
  "unwavering",
  "harness the power",
  "navigate the complexities",
];

// Banned constructions — phrase match
const BANNED_CONSTRUCTIONS = [
  "serves as",
  "stands as",
  // "represents" only flagged when followed by "a" (catches puffery, not factual)
  // skipping to avoid false positives in CV body — manual review preferred
  "not just",
  "not only",
  // Abbreviations that must never appear in candidate-facing copy (spell them out:
  // "the role" / "the job description").
  "JD",
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if ([".md", ".html", ".tex"].includes(extname(full).toLowerCase())) yield full;
  }
}

function audit(file) {
  const text = readFileSync(file, "utf8");
  const em = (text.match(/—/g) || []).length;
  const en = (text.match(/–/g) || []).length;
  const wordHits = {};
  for (const w of BANNED_WORDS) {
    const pat = new RegExp("\\b" + w.replace(/[.+?*[\](){}|\\^$]/g, "\\$&") + "\\b", "gi");
    const c = (text.match(pat) || []).length;
    if (c) wordHits[w] = c;
  }
  const constructHits = {};
  for (const c of BANNED_CONSTRUCTIONS) {
    const pat = new RegExp("\\b" + c.replace(/[.+?*[\](){}|\\^$]/g, "\\$&") + "\\b", "gi");
    const cnt = (text.match(pat) || []).length;
    if (cnt) constructHits[c] = cnt;
  }
  const total = em + en + Object.values(wordHits).reduce((a,b)=>a+b,0) + Object.values(constructHits).reduce((a,b)=>a+b,0);
  return { file, em, en, wordHits, constructHits, total };
}

if (!existsSync(ROOT)) { console.error(`root not found: ${ROOT}`); process.exit(2); }

const results = [];
for (const f of walk(ROOT)) results.push(audit(f));
results.sort((a,b) => b.total - a.total);

const dirty = results.filter(r => r.total > 0);

if (JSON_OUT) {
  console.log(JSON.stringify({ root: ROOT, total_files: results.length, dirty_files: dirty.length, results: dirty }, null, 2));
  process.exit(0);
}

console.log(`Audit root: ${ROOT}`);
console.log(`Files scanned: ${results.length}`);
console.log(`Files with at least one violation: ${dirty.length}`);
console.log();

// Aggregate counts
const aggWords = {};
const aggCon = {};
let totalEm = 0, totalEn = 0;
for (const r of dirty) {
  totalEm += r.em;
  totalEn += r.en;
  for (const [k,v] of Object.entries(r.wordHits)) aggWords[k] = (aggWords[k]||0) + v;
  for (const [k,v] of Object.entries(r.constructHits)) aggCon[k] = (aggCon[k]||0) + v;
}

console.log("=== Aggregate counts ===");
console.log(`em dashes (—): ${totalEm}`);
console.log(`en dashes (–): ${totalEn}`);
console.log("banned vocabulary:");
for (const [k,v] of Object.entries(aggWords).sort((a,b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);
console.log("banned constructions:");
for (const [k,v] of Object.entries(aggCon).sort((a,b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

console.log();
console.log(`=== Top ${TOP} files by total violations ===`);
for (const r of dirty.slice(0, TOP)) {
  const rel = r.file.replace(/\\/g, "/").replace(ROOT.replace(/\\/g,"/")+"/", "");
  const words = Object.entries(r.wordHits).map(([k,v]) => `${k}:${v}`).join(",");
  const cons = Object.entries(r.constructHits).map(([k,v]) => `${k}:${v}`).join(",");
  console.log(`  ${String(r.total).padStart(3)}  em=${r.em} en=${r.en}  ${words}${cons ? "  ||  "+cons : ""}  ${rel}`);
}
