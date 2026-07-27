#!/usr/bin/env node
// cv/backfill-role-title-headers.mjs
//
// Remediate EXISTING draft CVs whose job-title header reverted to a generic
// variant default (the regression fixed forward in batch/_autodraft_cv_run.mjs).
//
// UPGRADE-ONLY. It replaces a header lead ONLY when the current lead is a bare
// generic variant default AND the verbatim advertised title (from the shared
// extractor) is strictly more specific. It NEVER downgrades an already-specific
// header (e.g. it will not rewrite "Product Data Analyst" → "Data Analyst"),
// because an older draft path may have set a better title than a URL slug yields.
//
// Local + reversible: rewrites HTML (+PDF unless --html-only) in place. Does NOT
// touch Notion — pushing corrected PDFs is a separate, human-confirmed step.
//
// Usage:
//   node notion-query.mjs --stage "3. Drafted" --json > data/.routine-tmp/stage3-backfill.json
//   node cv/backfill-role-title-headers.mjs --rows data/.routine-tmp/stage3-backfill.json --dry-run
//   node cv/backfill-role-title-headers.mjs --rows data/.routine-tmp/stage3-backfill.json
//
// Flags: --rows <json>  --dry-run  --html-only
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractJdRoleTitleVerbose } from './jd-role-title.mjs';

const ROOT = process.cwd();
const argv = process.argv.slice(2);

// Read candidate name from profile.yml for output filenames
function getCandidateNameSlug() {
  try {
    const yml = fs.readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8');
    const m = yml.match(/full_name\s*:\s*['"]?([^'"\n]+)['"]?/);
    if (m) return m[1].trim().replace(/\s+/g, '-');
  } catch {}
  return 'CV';
}
const NAME_SLUG = getCandidateNameSlug();
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROWS_FILE = arg('--rows', 'data/.routine-tmp/stage3-backfill.json');
const DRY = argv.includes('--dry-run');
const HTML_ONLY = argv.includes('--html-only');
const OUT_ROOT = path.join(ROOT, 'output', 'cv-drafts');

// Mirrors batch/_autodraft_cv_run.mjs KEYWORDS (kept in sync manually).
const KEYWORDS = {
  de: 'Airflow,Kafka,Spark,Dagster,dbt,Snowflake,BigQuery,Python,SQL,CDC,Terraform',
  ae: 'dbt,Kimball,Snowflake,Databricks,BigQuery,ELT,Python,SQL',
  da: 'SQL,Power BI,Tableau,Looker,Excel,DAX,Python,dashboards,stakeholder reporting',
  ds: 'Python,scikit-learn,XGBoost,SHAP,MLflow,Airflow,AWS Sagemaker',
  me: 'Python,scikit-learn,XGBoost,SHAP,MLflow,FastAPI,Docker,model serving,MCP',
  master: 'Python,SQL,dbt,Snowflake,Airflow,Power BI,scikit-learn,Docker',
};

// Bare variant-default / family leads that are safe to REPLACE (not JD-specific).
const GENERIC = new Set(['analytics engineer', 'data scientist', 'data engineer', 'data analyst',
  'machine learning engineer', 'business intelligence', 'bi engineer', 'data professional']);

const rows = JSON.parse(fs.readFileSync(path.resolve(ROOT, ROWS_FILE), 'utf8'));
const byId = new Map(rows.map((r) => [r.application_id, r]));

const dirs = fs.existsSync(OUT_ROOT)
  ? fs.readdirSync(OUT_ROOT).filter((d) => { try { return fs.statSync(path.join(OUT_ROOT, d)).isDirectory(); } catch { return false; } })
  : [];

let upgraded = 0, skipped = 0, noRow = 0, failed = 0;
const changes = [];
for (const dir of dirs) {
  const m = dir.match(/^(APP-\d+)-(.+)$/);
  if (!m) continue;
  const [, appId, slug] = m;
  const row = byId.get(appId);
  if (!row) { noRow++; continue; }              // outside the queried set — leave untouched

  const { title: newTitle, source } = extractJdRoleTitleVerbose(row);
  const htmls = fs.readdirSync(path.join(OUT_ROOT, dir)).filter((f) => /^cv_[a-z]+_[a-z]{2}\.html$/.test(f));
  for (const html of htmls) {
    const [, variant, lang] = html.match(/^cv_([a-z]+)_([a-z]{2})\.html$/);
    const cur = fs.readFileSync(path.join(OUT_ROOT, dir, html), 'utf8');
    const curTag = (cur.match(/<p class="header-tagline">([^<]*)<\/p>/) || [])[1] || '';
    const curLead = curTag.split(' · ')[0].trim();

    const existingIsGeneric = GENERIC.has(curLead.toLowerCase());
    const newIsSpecific = !GENERIC.has(newTitle.toLowerCase());
    const wouldChange = newTitle.toLowerCase() !== curLead.toLowerCase();
    // UPGRADE-ONLY: generic existing → strictly-more-specific verbatim title.
    if (!(existingIsGeneric && newIsSpecific && wouldChange && source !== 'position')) { skipped++; continue; }

    changes.push(`${appId} [${variant}/${lang}] "${curLead}" -> "${newTitle}" (${source})`);
    upgraded++;
    if (DRY) continue;
    try {
      const kw = KEYWORDS[variant] || KEYWORDS.master;
      execFileSync('node', ['scripts/cv/generate-pdf-tailored.mjs',
        '--archetype', variant.toUpperCase(), '--lang', lang,
        '--company', slug, '--keywords', kw, '--role-title', newTitle],
        { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
      if (!HTML_ONLY) {
        execFileSync('node', ['scripts/cv/html-to-pdf.mjs', '--in', path.join(OUT_ROOT, dir, html),
          '--out', path.join(OUT_ROOT, dir, `${NAME_SLUG}-CV-${slug}.pdf`)],
          { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 90000 });
      }
    } catch (e) {
      failed++;
      changes[changes.length - 1] += `  ✗ ${String(e.message || e).slice(0, 80)}`;
    }
  }
}

console.log(`\nbackfill${DRY ? ' (DRY-RUN)' : ''}: ${upgraded} header(s) upgraded, ${skipped} left as-is, ${failed} failed. (${noRow} dirs outside the row set — untouched)`);
for (const c of changes) console.log('  ' + c);
