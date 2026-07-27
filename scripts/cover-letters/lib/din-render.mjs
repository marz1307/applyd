#!/usr/bin/env node
/**
 * din-render.mjs — render a cover-letter .md as a DIN 5008-style HTML document.
 *
 * DACH HR expects the formal German business-letter grid: sender block top-right,
 * recipient Anschriftfeld left, city+date right, bold Betreffzeile, then body.
 * The plain md-to-pdf.mjs layout (single header block + paragraphs) does not.
 *
 * The .md must be blank-line separated in this order:
 *   [0] sender (name + contact lines)
 *   [1] recipient (company + address lines)
 *   [2] city, date
 *   [3] **Betreff line**
 *   [4..] salutation, body paragraphs, closing, attachments
 *
 * Usage: node cover-letters/lib/din-render.mjs --in <letter.md> --out <letter.html>
 * Then render to PDF with cv/html-to-pdf.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const inPath = arg('--in'), outPath = arg('--out');
if (!inPath || !outPath) { console.error('Usage: --in <md> --out <html>'); process.exit(2); }

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inlineMd = (s) => escapeHtml(s).replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');

let md = readFileSync(inPath, 'utf8');
while (md.includes('<!--')) md = md.replace(/<!--[\s\S]*?-->/g, '');
md = md.trim();
// Em dashes (—) read as AI-written; collapse "word — word" to "word, word".
// German en-dash Gedankenstrich (–) is correct typography and left untouched.
md = md.replace(/\s*—\s*/g, ', ');
const blocks = md.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);

const sender = blocks[0] || '';
const recipient = blocks[1] || '';
const date = blocks[2] || '';
const betreff = blocks[3] || '';
const rest = blocks.slice(4);

const lines = (b) => b.split(/\n/).map(l => inlineMd(l)).join('<br>');
const senderHTML = `<div class="sender">${lines(sender)}</div>`;
const recipientHTML = `<div class="recipient">${lines(recipient)}</div>`;
const dateHTML = `<div class="date">${inlineMd(date)}</div>`;
const betreffHTML = `<div class="betreff">${inlineMd(betreff)}</div>`;
const restHTML = rest.map(p => `<p>${inlineMd(p).replace(/\n/g, '<br>')}</p>`).join('\n');

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>Cover Letter</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<style>
  :root { --ink:#1a1a1a; --ink-muted:#555; --accent:#D4471F; --serif:"Source Serif 4",Georgia,serif; --sans:"IBM Plex Sans",-apple-system,sans-serif; }
  * { box-sizing:border-box; margin:0; padding:0; }
  html, body { font-family:var(--serif); color:var(--ink); background:#fff; }
  body { font-size:10.5pt; line-height:1.4; }
  /* DIN 5008: 2.5cm left margin, 2cm right, comfortable top. */
  @page { size:A4; margin:2cm 2cm 2cm 2.5cm; }
  .sender { font-family:var(--sans); font-size:9pt; color:var(--ink-muted); text-align:right; line-height:1.4; margin-bottom:16pt; }
  .recipient { font-family:var(--sans); font-size:10.5pt; color:var(--ink); text-align:left; line-height:1.35; margin-bottom:18pt; }
  .date { text-align:right; font-size:10.5pt; margin-bottom:16pt; }
  .betreff { font-weight:600; font-size:10.5pt; margin-bottom:14pt; }
  p { margin-bottom:9pt; orphans:2; widows:2; }
</style>
</head><body>
${senderHTML}
${recipientHTML}
${dateHTML}
${betreffHTML}
${restHTML}
</body></html>`;

writeFileSync(outPath, html);
console.error(`Wrote ${outPath}`);
