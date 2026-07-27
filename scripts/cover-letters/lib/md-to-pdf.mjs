#!/usr/bin/env node
// md-to-pdf.mjs — Convert cover-letter .md files to A4 PDFs via Playwright.
//
// The existing cv/html-to-pdf.mjs expects HTML; we wrap the letter markdown
// in a minimal HTML template (matching the CV's serif/IBM-Plex visual style
// so the letter+CV feel like one package), then call out to chromium.
//
// Usage:
//   node cover-letters/lib/md-to-pdf.mjs --in <letter.md> [--out <letter.pdf>]
//   node cover-letters/lib/md-to-pdf.mjs --batch <date>   # all letters dated <date>
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LETTERS_DIR = join(ROOT, 'output', 'cover-letters');

function wrapHTML(md) {
  // Strip HTML comments (audit footer) before render
  while (md.includes('<!--')) md = md.replace(/<!--[\s\S]*?-->/g, '');
  md = md.trim();
  // Em dashes (—) read as AI-written and are banned in the house style; collapse
  // any "word — word" into "word, word". (German en-dash – is left untouched.)
  md = md.replace(/\s*—\s*/g, ', ');
  // Split into lines; first block is header, then blank line, then date, then "To the ... team", "Re: ...", then body paras.
  const lines = md.split(/\r?\n/);
  // Naive paragraph splitter
  const paras = [];
  let buf = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (buf.length) { paras.push(buf.join('\n')); buf = []; }
    } else { buf.push(line); }
  }
  if (buf.length) paras.push(buf.join('\n'));

  // Header block = first paragraph (contact info)
  const header = paras[0] || '';
  const rest = paras.slice(1);

  // Inline markdown: escape HTML first, THEN convert **bold** -> <strong>.
  // Without this the literal asterisks of a bold subject line (e.g. the German
  // "**Bewerbung als …**") render verbatim in the PDF. escapeHtml leaves '*'
  // untouched, so the markers survive to be matched here.
  // [^\n]+? (not [^*]+?) so a single inner '*' — the German gender star, e.g.
  // "**Bewerbung als Data Analyst*in Distributions**" — does not break the match
  // and leave the '**' rendering literally. Lazy quantifier keeps multiple bold
  // spans on one line independent.
  const inlineMd = (s) => escapeHtml(s).replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');

  const headerHTML = `<div class="header">${header.split('\n').map(l => `<div>${inlineMd(l)}</div>`).join('')}</div>`;
  const restHTML = rest.map(p => `<p>${inlineMd(p).replace(/\n/g, '<br>')}</p>`).join('\n');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Cover Letter</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #1a1a1a;
    --ink-muted: #555;
    --rule: #d6d3ce;
    --accent: #D4471F;
    --paper: #fff;
    --serif: "Source Serif 4", Georgia, serif;
    --sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: var(--serif); color: var(--ink); background: var(--paper); }
  body { font-size: 10.5pt; line-height: 1.4; padding: 0; }
  @page { size: A4; margin: 1.6cm 1.8cm 1.6cm 1.8cm; }
  .header { font-family: var(--sans); font-size: 9pt; color: var(--ink-muted); margin-bottom: 18pt; line-height: 1.4; }
  .header div:first-child { font-family: var(--sans); font-size: 14pt; font-weight: 600; color: var(--ink); margin-bottom: 2pt; }
  p { margin-bottom: 9pt; orphans: 2; widows: 2; }
</style>
</head><body>
${headerHTML}
${restHTML}
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderOne(mdPath, pdfPath) {
  const md = readFileSync(mdPath, 'utf8');
  const html = wrapHTML(md);
  const tmpHtml = mdPath.replace(/\.md$/, '.tmp.html');
  writeFileSync(tmpHtml, html);
  // Use the existing cv/html-to-pdf.mjs pipeline
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('node', ['scripts/cv/html-to-pdf.mjs', '--in', tmpHtml, '--out', pdfPath], {
      cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], timeout: 60000,
    });
    return true;
  } catch (e) { return false; }
  finally {
    try { require('node:fs').unlinkSync(tmpHtml); } catch {}
  }
}

if (has('--batch')) {
  const date = arg('--batch');
  // Match both letters (`*-DATE.md`) and form-answers (`*-DATE-form.md`).
  const files = readdirSync(LETTERS_DIR).filter(f => f.endsWith(`-${date}.md`) || f.endsWith(`-${date}-form.md`));
  console.error(`Rendering ${files.length} letters dated ${date}...`);
  let ok = 0, fail = 0;
  for (const f of files) {
    const mdPath = join(LETTERS_DIR, f);
    const pdfPath = mdPath.replace(/\.md$/, '.pdf');
    const success = await renderOne(mdPath, pdfPath);
    if (success) { console.error(`  ✓ ${basename(pdfPath)}`); ok++; }
    else { console.error(`  ✗ ${basename(mdPath)}`); fail++; }
  }
  console.error(`Done. ${ok} OK, ${fail} failed.`);
} else if (arg('--in')) {
  const inPath = resolve(arg('--in'));
  const outPath = arg('--out') ? resolve(arg('--out')) : inPath.replace(/\.md$/, '.pdf');
  const success = await renderOne(inPath, outPath);
  if (!success) process.exit(3);
  console.error(`Wrote ${outPath}`);
} else {
  console.error('Usage: --in <letter.md> [--out <letter.pdf>]  OR  --batch <YYYY-MM-DD>');
  process.exit(2);
}
