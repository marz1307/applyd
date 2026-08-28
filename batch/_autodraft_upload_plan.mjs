#!/usr/bin/env node
// Build the Resume / Cover Letter / Form answers upload plan for the nightly
// auto-draft run, and prove every file exists BEFORE any upload starts.
//
// The CV path comes from cv-manifest.json (absolute, written by the CV driver).
// The cover-letter and form-answer basenames do NOT always match the CV dir
// slug — the cover-letter generator slugifies the company independently and
// truncates differently, so they are resolved by scanning for the {num}-*-{date}
// prefix rather than reconstructed from the slug.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
// Default to TODAY, not a frozen literal. A hardcoded date left over from a
// prior run matches no cover letter on any later night and reports every row
// incomplete. Pass DRAFT_DATE explicitly when a run straddles midnight: the
// letters carry the date they were generated, which is not necessarily today's.
const DATE = process.env.DRAFT_DATE || new Date().toISOString().slice(0, 10);
const manifest = JSON.parse(fs.readFileSync('data/.routine-tmp/cv-manifest.json', 'utf8'));

// Letters are named either `{num}-{slug}-{date}.pdf` (older runs) or
// `APP-{num}-{slug}-{date}.pdf` (current generate.js). Matching only the bare
// `{num}-` form silently reports NO-CL for every row once the generator adopts
// the APP- prefix, so the whole run looks incomplete and nothing uploads even
// though the letters are on disk.
function findByPrefix(dir, num, suffix) {
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir).filter(
    (f) => (f.startsWith(`${num}-`) || f.startsWith(`APP-${num}-`)) &&
      f.includes(DATE) && f.endsWith(suffix),
  );
  return hits.length ? path.join(dir, hits[0]) : null;
}

const plan = [];
for (const e of manifest) {
  if (e.status !== 'ok') continue;
  const num = e.app_id.replace('APP-', '');
  const cv = e.pdf_path;
  const cl = findByPrefix('output/cover-letters', num, '.pdf');
  const fa = findByPrefix('output/form-answers', num, '-form.pdf');
  plan.push({
    app: e.app_id,
    page: e.page_id,
    cv, cl, fa,
    cv_ok: !!cv && fs.existsSync(cv),
    cl_ok: !!cl && fs.existsSync(cl),
    fa_ok: !!fa && fs.existsSync(fa),
  });
}

fs.writeFileSync('data/.routine-tmp/upload-plan.json', JSON.stringify(plan, null, 2));
for (const p of plan) {
  console.log(
    `${p.app}  CV${p.cv_ok ? '+' : '!'}  CL${p.cl_ok ? '+' : '!'}  FA${p.fa_ok ? '+' : '!'}  ` +
    `${p.cl ? path.basename(p.cl) : 'NO-CL'} | ${p.fa ? path.basename(p.fa) : 'NO-FA'}`,
  );
}
const bad = plan.filter((p) => !p.cv_ok || !p.cl_ok);
console.log(`\nplan rows=${plan.length} incomplete=${bad.length}`);
if (bad.length) process.exitCode = 1;
