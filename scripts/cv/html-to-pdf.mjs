#!/usr/bin/env node
// cv/html-to-pdf.mjs — render an HTML file (produced by generate-pdf-tailored.mjs)
// to PDF using Playwright. The HTML's @page CSS already encodes the A4
// + 0.75cm/1.0cm margins, so we just print it.
//
// Usage:
//   node cv/html-to-pdf.mjs \
//     --in output/cv-drafts/APP-60-sumup/cv_ae_en.html \
//     --out output/cv-drafts/APP-60-sumup/cv_ae_en.pdf
//
// Emits a one-line JSON summary to stdout:
//   {"status":"ok","pdf_path":"...","bytes":12345,"page_count":2}

import { chromium } from 'playwright';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) out[k] = true;
      else { out[k] = v; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.in || !args.out) {
  console.error('Usage: node cv/html-to-pdf.mjs --in <file.html> --out <file.pdf>');
  process.exit(2);
}
const inPath = resolve(args.in);
const outPath = resolve(args.out);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// file:// URL so relative assets (e.g. headshot photo) resolve from the HTML's dir
await page.goto(pathToFileURL(inPath).href, { waitUntil: 'networkidle' });

await page.pdf({
  path: outPath,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});

await browser.close();

const stats = statSync(outPath);
// Real page count from the rendered PDF — count `/Type /Page` entries
// in the raw PDF stream. This is reliable across Playwright versions
// and does not require pdf-lib as a dep. The 2-page hard rule from
// modes/cv-quality-rules.md §1 is now enforced here.
const pdfBuf = readFileSync(outPath);
const pdfText = pdfBuf.toString('latin1');
// Count page objects. Match `/Type/Page` and `/Type /Page` (with optional whitespace).
// Exclude /Pages (the catalog) by requiring the next char after `Page` is not `s`.
const matches = pdfText.match(/\/Type\s*\/Page(?![\w])/g) || [];
const pageCount = matches.length || 1;

const result = {
  status: pageCount <= 2 ? 'ok' : 'over_page_limit',
  pdf_path: outPath,
  bytes: stats.size,
  page_count: pageCount,
};
console.log(JSON.stringify(result));
// Hard fail if > 2 pages so callers can react.
if (pageCount > 2) process.exit(7);
