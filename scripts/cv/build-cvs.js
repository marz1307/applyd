'use strict';

// =========================================================================
//  applyd CV variant renderer.
//
//  Reads CV data from scripts/cv/cv_master.json (falls back to
//  cv_master.example.json when the populated file is absent). Writes HTML
//  variants into ./scripts/cv/output/ by default, or into a per-application
//  directory when --out is passed.
//
//  CLI usage:
//    # Build every variant into ./scripts/cv/output/
//    node scripts/cv/build-cvs.js
//
//    # Build one tailored variant into a per-application directory:
//    node scripts/cv/build-cvs.js \
//      --variant ae --lang en \
//      --out output/cv-drafts/APP-60-example/ \
//      --tailor-keywords "dbt,Snowflake,fintech"
//
//  Flags:
//    --variant       master | ae | ds | de | da | me   (default: build all)
//    --lang          en | de                            (default: both)
//    --out           output directory                   (default: ./scripts/cv/output)
//    --country       posting country ISO (drives visa/availability tail)
//    --role-title    override the tagline's first token with the JD role
//    --tailor-keywords comma-separated informational tags
//    --dach-format   render an English CV in DACH presentation (photo + PD)
//    --seniority     graduate | mid | senior           (default: mid)
//    --jd-file       path to a JD text file            (drives project scoring
//                    and LLM profile enrichment)
//    --jd-text       inline JD text
//    --no-enrich     skip the LLM enrichment call (JD-driven selection still runs)
//    --export-json   write cv_master.json equivalent to disk and exit
//    --export-path   destination path for --export-json (default: cv/cv_master.json)
//
//  The CV JSON is single source of truth. Tailoring happens via variant
//  reordering (skills / projects) and archetype-keyed profile text — never
//  by inventing claims. See modes/cv-quality-rules.md for the discipline
//  that governs any human or LLM-driven tailoring on top of this.
// =========================================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- argv parser ---------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}
const ARGS = parseArgs(process.argv);

const DACH_FORMAT = !!ARGS['dach-format'];
const SENIORITY = ARGS.seniority || null;
const COUNTRY = typeof ARGS.country === 'string' ? ARGS.country : '';
const ROLE_TITLE_OVERRIDE = ARGS['role-title'] || null;

const MT = require('./market-tail.cjs');
const PS = require('./project-scoring.cjs');

// ---- load CV data --------------------------------------------------------
// The populated file is gitignored; the example ships. A missing populated
// file means "user has not personalised yet", so the example fills in.
function loadCvMaster() {
  const populated = path.resolve(__dirname, 'cv_master.json');
  const example = path.resolve(__dirname, 'cv_master.example.json');
  const p = fs.existsSync(populated) ? populated : (fs.existsSync(example) ? example : null);
  if (!p) {
    throw new Error('No cv_master.json or cv_master.example.json found under scripts/cv/. Copy cv_master.example.json to cv_master.json and populate it.');
  }
  return { data: JSON.parse(fs.readFileSync(p, 'utf8')), source: p };
}

// ---- shape the loaded JSON into the renderer's CONTENT structure ---------
// The renderer expects a nested shape with EN/DE variants for every section.
// The example ships an EN-primary JSON — we derive DE fallbacks from EN
// where the user has not authored a DE version, so the renderer never
// crashes on a missing translation.
function shapeContent(master) {
  const contact = master.contact || {};
  const employers = master.employers || [];
  const projects = Array.isArray(master.projects) ? master.projects : [];

  const projectMap = {};
  for (const p of projects) {
    projectMap[p.id] = {
      title: p.title,
      meta: p.meta,
      summary: p.summary,
      bullets: p.bullets || null,
      tags: p.tags || [],
    };
  }

  // Build a default variant order from the projects present in the JSON.
  // Individual VARIANTS below can override.
  const defaultOrder = projects.slice(0, 4).map(p => p.id);

  return {
    name: master.name || 'Candidate',
    contact,
    positioning_line: master.positioning_line || '',
    experience: {
      en: employers.map(e => ({
        role: e.role,
        meta: e.dates || e.meta || '',
        summary: e.summary,
        bullets: e.bullets || [],
        stack: e.stack || '',
      })),
      de: employers.map(e => ({
        role: e.role_de || e.role,
        meta: e.dates_de || e.dates || e.meta || '',
        summary: e.summary_de || e.summary,
        bullets: e.bullets_de || e.bullets || [],
        stack: e.stack_de || e.stack || '',
      })),
    },
    projects: {
      en: projectMap,
      de: projectMap,
    },
    projectOrder: defaultOrder,
    skills: master.skills || { production: [], skills_list_only: [], research_only: [] },
    honest_boundaries: master.honest_boundaries || [],
    salary_anchors: master.salary_anchors || {},
    availability: master.availability || '',
    target_geographies: master.target_geographies || [],
  };
}

// ---- variant profiles ----------------------------------------------------
// Profile text is intentionally generic here. Users personalise via
// scripts/cv/profile-enrich.mjs (LLM path) or the ARCHETYPE_PROFILES defaults
// in scripts/cv/generate-pdf-tailored.mjs (template path). This variant
// renderer is the batch path and stays market-neutral by default; the
// per-application path is generate-pdf-tailored.mjs.
const VARIANTS = {
  master: {
    subheadEN: 'Analytics Engineer · Data Scientist',
    subheadDE: 'Analytics Engineer · Data Scientist',
    skillsOrder: ['production', 'skills_list_only', 'research_only'],
  },
  ae: {
    subheadEN: 'Analytics Engineer · Data Platform',
    subheadDE: 'Analytics Engineer · Data Platform',
    skillsOrder: ['production', 'skills_list_only', 'research_only'],
  },
  ds: {
    subheadEN: 'Data Scientist · Analytics Engineer',
    subheadDE: 'Data Scientist · Analytics Engineer',
    skillsOrder: ['research_only', 'production', 'skills_list_only'],
  },
  de: {
    subheadEN: 'Data Engineer · Analytics Engineer',
    subheadDE: 'Data Engineer · Analytics Engineer',
    skillsOrder: ['production', 'skills_list_only', 'research_only'],
  },
  da: {
    subheadEN: 'Data Analyst · Analytics Engineer',
    subheadDE: 'Data Analyst · Analytics Engineer',
    skillsOrder: ['production', 'skills_list_only', 'research_only'],
  },
  me: {
    subheadEN: 'Machine Learning Engineer · Data Scientist',
    subheadDE: 'Machine Learning Engineer · Data Scientist',
    skillsOrder: ['research_only', 'production', 'skills_list_only'],
  },
};

const TITLE_SUFFIX = {
  master: '',
  ae: ': Analytics Engineer',
  ds: ': Data Scientist',
  de: ': Data Engineer',
  da: ': Data Analyst',
  me: ': Machine Learning Engineer',
};

// ---- role-title override -------------------------------------------------
function applyRoleTitle(subhead) {
  if (!ROLE_TITLE_OVERRIDE || !subhead.includes(' · ')) return subhead;
  const override = ROLE_TITLE_OVERRIDE.trim();
  const parts = subhead.split(' · ').map((s) => s.trim());
  if (override.toLowerCase() === parts[0].toLowerCase()) return subhead;
  const anchors = parts.slice(1).filter((s) => s.toLowerCase() !== override.toLowerCase());
  return anchors.length ? `${override} · ${anchors.join(' · ')}` : override;
}

// ---- JD reading + LLM enrichment plumbing --------------------------------
const SKIP_ENRICH = ARGS['no-enrich'] === true || ARGS['no-enrich'] === 'true';
function readJdText() {
  if (typeof ARGS['jd-text'] === 'string' && ARGS['jd-text'].trim()) return ARGS['jd-text'];
  if (typeof ARGS['jd-file'] === 'string' && ARGS['jd-file'].trim()) {
    try { return fs.readFileSync(ARGS['jd-file'], 'utf8'); }
    catch (e) { console.error(`[build-cvs] --jd-file unreadable: ${e.message}`); return ''; }
  }
  return '';
}
function computeEnrichedProfile({ archetype, seniority, keywords, roleTitle, company, country, lang, jdText }) {
  const args = [
    path.join(__dirname, 'profile-enrich.mjs'),
    '--company', company || '(unknown)',
    '--role-title', roleTitle || archetype || '(unknown)',
    '--archetype', archetype || 'AE',
    '--seniority', seniority || 'mid',
    '--lang', lang,
  ];
  if (keywords && keywords.length) args.push('--keywords', keywords.join(','));
  if (country) args.push('--country', country);
  if (jdText) args.push('--jd-text', jdText);
  const result = spawnSync('node', args, {
    encoding: 'utf8',
    timeout: 90 * 1000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout && result.stdout.trim()) {
    return { profile: result.stdout.trim(), reason: null };
  }
  const stderrTail = String(result.stderr || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] || '(no stderr)';
  return { profile: null, reason: stderrTail };
}

// ---- output dir ----------------------------------------------------------
const OUT_DIR = ARGS.out
  ? path.resolve(ARGS.out)
  : path.join(__dirname, 'output');
if (!ARGS['export-json'] && !fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// A render into output/cv-drafts/ is for ONE application, so it must know
// its country. The default ./scripts/cv/output is the published general CV,
// which legitimately has no country.
const IS_APPLICATION_RENDER = /cv-drafts/i.test(String(OUT_DIR || ''));

// ---- project selection ---------------------------------------------------
// Rules:
//   With --jd-file/--jd-text: score against the pool via
//     project-scoring.cjs, keep top-N, then use the default order to top up
//     if the JD-driven picks came up short.
//   Without JD: return the default order verbatim.
// dachPresentation caps to 3 projects on DACH renders (photo + Personal
// Details eat vertical space that a UK-format CV spends on content).
function selectProjectsForRender(projectMap, jdText, dachPresentation) {
  const fallback = Object.keys(projectMap).filter(id => projectMap[id]).slice(0, dachPresentation ? 3 : 4);
  const jd = String(jdText || '').trim();
  if (!jd) return fallback;

  const pool = PS.loadPool();
  if (!pool) return fallback;

  const arch = String(ARGS.variant || 'ae').toUpperCase();
  const ids = PS.selectProjectIds({ pool, archetype: arch, jdText: jd });
  if (!ids || !ids.length) return fallback;

  const cap = dachPresentation ? 3 : (pool.max_projects || 4);
  const seen = new Set();
  const picks = [];
  for (const id of ids) {
    if (!projectMap[id] || seen.has(id)) continue;
    picks.push(id); seen.add(id);
    if (picks.length >= cap) break;
  }
  for (const id of fallback) {
    if (picks.length >= cap) break;
    if (!seen.has(id)) { picks.push(id); seen.add(id); }
  }
  console.error(`[build-cvs] Projects [${arch}] JD-driven: ${picks.join(', ')}`);
  return picks;
}

// ---- CSS -----------------------------------------------------------------
const CSS_BASE = `
  :root {
    --ink: #1a1a1a;
    --ink-muted: #555;
    --rule: #d6d3ce;
    --accent: #D4471F;
    --paper: #fff;
    --serif: "Source Serif 4", "Source Serif Pro", Georgia, serif;
    --sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif;
    --mono: "JetBrains Mono", "Consolas", monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: var(--serif); color: var(--ink); background: var(--paper); }
  body { font-size: 8.5pt; line-height: 1.34; }
  @page { size: A4; margin: 0.75cm 1.0cm; }
  h1, h2, h3, h4 { font-family: var(--sans); color: var(--ink); }
  h1 { font-size: 15pt; font-weight: 600; letter-spacing: -0.01em; }
  h2 {
    font-size: 9pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--accent);
    border-bottom: 1px solid var(--accent);
    padding-bottom: 1px;
    margin: 5pt 0 2pt 0;
    break-after: avoid; page-break-after: avoid;
    break-inside: avoid; page-break-inside: avoid;
  }
  h3 {
    font-size: 9pt; font-weight: 600; margin-top: 4pt;
    break-after: avoid; page-break-after: avoid;
    break-inside: avoid; page-break-inside: avoid;
  }
  h4 { font-size: 8.5pt; font-weight: 500; color: var(--ink-muted); margin-top: 1pt; }
  p, li { font-size: 8.5pt; line-height: 1.34; }
  ul { padding-left: 1.05em; margin-top: 2pt; }
  li { margin-bottom: 1.5pt; }
  p, li { orphans: 2; widows: 2; }
  li { break-inside: avoid; page-break-inside: avoid; }
  a { color: var(--accent); text-decoration: none; }
  .header-tagline { font-family: var(--sans); font-size: 9.5pt; color: var(--ink-muted); margin-top: 1pt; font-weight: 500; }
  .contact { font-family: var(--sans); font-size: 8pt; margin-top: 2pt; color: var(--ink-muted); line-height: 1.4; }
  .contact a { color: var(--ink); }
  .contact .sep { color: var(--rule); margin: 0 5px; }
  .contact .lbl { color: var(--ink); font-weight: 600; }
  .role-line { font-family: var(--sans); font-size: 9pt; font-weight: 500; color: var(--ink); }
  /* break-AFTER on the meta lines is the stranded-header fix: heading stacks
   * used to sit alone at the foot of the page with body on the next. Extending
   * break-after through the meta line pushes the first legal break INTO the
   * body paragraph, where orphans:2 drags at least two lines with the heading. */
  .role-meta { font-family: var(--sans); font-size: 8pt; color: var(--ink-muted); font-weight: 500; margin-bottom: 1pt; break-before: avoid; page-break-before: avoid; break-inside: avoid; break-after: avoid; page-break-after: avoid; }
  .stack { font-family: var(--mono); font-size: 7.5pt; color: var(--ink-muted); margin-top: 1pt; }
  .stack-label { color: var(--accent); font-weight: 600; }
  .project-tags { font-family: var(--mono); font-size: 7.5pt; color: var(--ink-muted); margin-top: 1pt; }
  .project-tags .tag { display: inline-block; background: #f5f3ee; padding: 0pt 4pt; margin-right: 2pt; margin-bottom: 1pt; border-radius: 2px; font-size: 7pt; }
  .project-meta { font-family: var(--sans); font-size: 8pt; color: var(--accent); font-weight: 600; break-before: avoid; page-break-before: avoid; break-after: avoid; page-break-after: avoid; break-inside: avoid; }
  .role-line { break-after: avoid; page-break-after: avoid; }
  .skills-grid { font-size: 8.5pt; line-height: 1.35; }
  .skills-grid b { font-family: var(--sans); font-weight: 600; color: var(--ink); }
  .skills-grid p { margin-bottom: 0pt; }
  strong { font-weight: 600; }
  section { break-inside: auto; }
  .availability { font-family: var(--sans); font-size: 7.5pt; color: var(--ink-muted); margin-top: 2pt; font-style: italic; }`;

const CSS_DE_EXTRA = `
  /* German prose runs 15-20% longer than English, so structural compression
   * still applies. Body typography now matches English, since the 5/4/3 bullet
   * cut freed enough vertical space for that. Restoring FULL English parity
   * (headings and margins too) puts every German variant onto a third page. */
  body { font-size: 8.5pt; line-height: 1.34; }
  p, li { font-size: 8.5pt; line-height: 1.34; }
  h2 { margin: 2pt 0 0 0; padding-bottom: 0; font-size: 8.5pt; }
  h3 { font-size: 8.5pt; margin-top: 1pt; }
  h4 { font-size: 8pt; }
  ul { padding-left: 1em; margin-top: 0; }
  li { margin-bottom: 0; }
  .role-line, .role-meta { font-size: 8pt; }
  .stack { font-size: 7.25pt; margin-top: 0; }
  .project-tags { font-size: 7.25pt; margin-top: 0; }
  .project-meta { font-size: 7.75pt; }
  .availability { margin-top: 1pt; font-size: 7pt; }
  section { margin-bottom: 0; }
  @page { margin: 0.65cm 0.95cm; }
  .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .header-text { flex: 1; }
  .photo { width: 2.2cm; height: 2.9cm; flex-shrink: 0; object-fit: cover; object-position: center top; border: 1px solid var(--rule); }
  .pd-table { font-family: var(--sans); font-size: 7.5pt; line-height: 1.3; margin-top: 1pt; }
  .pd-table div { display: grid; grid-template-columns: 5.3em 1fr; gap: 8px; }
  .pd-table .label { color: var(--ink-muted); font-weight: 500; }
  .pd-table a { color: var(--ink); }
  .pd-h2 { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); border-bottom: 1px solid var(--accent); padding-bottom: 1px; margin: 3pt 0 1pt 0; font-family: var(--sans); }`;

const CSS_DACH_HEADER = `
  .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .header-text { flex: 1; }
  .photo { width: 2.2cm; height: 2.9cm; flex-shrink: 0; object-fit: cover; object-position: center top; border: 1px solid var(--rule); }
  .pd-table { font-family: var(--sans); font-size: 8pt; line-height: 1.35; margin-top: 2pt; }
  .pd-table div { display: grid; grid-template-columns: 6em 1fr; gap: 8px; }
  .pd-table .label { color: var(--ink-muted); font-weight: 500; }
  .pd-table a { color: var(--ink); }
  .pd-h2 { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); border-bottom: 1px solid var(--accent); padding-bottom: 1px; margin: 4pt 0 2pt 0; font-family: var(--sans); }`;

const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">\n' +
  '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">';

// ---- renderers -----------------------------------------------------------
function renderExperience(items, heading) {
  const blocks = items.map((job) => {
    const bullets = (job.bullets || []).map((b) => `    <li>${b}</li>`).join('\n');
    const stack = job.stack
      ? `\n  <p class="stack"><span class="stack-label">Stack:</span> ${job.stack}</p>`
      : '';
    return (
`  <h3>${job.role}</h3>
  <p class="role-meta">${job.meta}</p>
  <p>${job.summary || ''}</p>
  <ul>
${bullets}
  </ul>${stack}`
    );
  }).join('\n\n');
  return `<section>\n  <h2>${heading}</h2>\n\n${blocks}\n</section>`;
}

function renderProjects(projectMap, order, heading) {
  const blocks = order.map((id) => {
    const p = projectMap[id];
    if (!p) return '';
    const tags = (p.tags || []).map((t) => `<span class="tag">${t}</span>`).join('');
    const body = p.bullets
      ? `  <p>${p.summary}</p>\n  <ul>\n${p.bullets.map((b) => `    <li>${b}</li>`).join('\n')}\n  </ul>`
      : `  <p>${p.summary}</p>`;
    return (
`  <h3>${p.title}</h3>
  <p class="project-meta">${p.meta}</p>
${body}
  <p class="project-tags">${tags}</p>`
    );
  }).filter(Boolean).join('\n\n');
  return `<section>\n  <h2>${heading}</h2>\n\n${blocks}\n</section>`;
}

function renderSkills(skillsObj, order, heading) {
  const rows = order.map((key) => {
    const items = skillsObj[key];
    if (!items || !items.length) return '';
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `    <p><b>${label}:</b> ${items.join(', ')}</p>`;
  }).filter(Boolean).join('\n');
  return `<section>\n  <h2>${heading}</h2>\n  <div class="skills-grid">\n${rows}\n  </div>\n</section>`;
}

// ---- builders ------------------------------------------------------------
function buildEN(variantKey, C) {
  const v = { ...VARIANTS[variantKey] };
  v.subheadEN = applyRoleTitle(v.subheadEN);
  const market = MT.resolveMarket(COUNTRY, { dachFormat: DACH_FORMAT, lang: 'en', requireCountry: IS_APPLICATION_RENDER });
  const visa = MT.visaLine(market, 'en');

  const jdText = readJdText();
  let profile = C.positioning_line || `${v.subheadEN}.`;
  if (jdText && !SKIP_ENRICH) {
    const isGrad = SENIORITY === 'graduate' || SENIORITY === 'junior';
    const seniority = isGrad ? 'graduate' : 'mid';
    const kwArg = ARGS['tailor-keywords'];
    const keywords = typeof kwArg === 'string' ? kwArg.split(',').map(s => s.trim()).filter(Boolean) : [];
    const r = computeEnrichedProfile({
      archetype: variantKey === 'master' ? 'AE' : variantKey.toUpperCase(),
      seniority, keywords,
      roleTitle: ROLE_TITLE_OVERRIDE || v.subheadEN.split(' · ')[0],
      company: ARGS.company || '(unknown company)',
      country: COUNTRY, lang: 'en', jdText,
    });
    if (r.profile) profile = r.profile;
    else console.error(`[build-cvs] LLM enrichment failed (${r.reason}); falling back to positioning line.`);
  }
  if (visa && !profile.includes(visa)) profile = `${profile} ${visa}`;

  const headerStandard =
`<header>
  <h1>${C.name}</h1>
  <p class="header-tagline">${v.subheadEN}</p>
  <p class="contact">
    <span class="lbl">Location:</span> ${C.contact.location_en || ''}
    <span class="sep">·</span> <span class="lbl">Phone:</span> ${C.contact.phone || ''}
    <span class="sep">·</span> <span class="lbl">Email:</span> <a href="mailto:${C.contact.email || ''}">${C.contact.email || ''}</a>
    <span class="sep">·</span> <span class="lbl">LinkedIn:</span> <a href="https://${C.contact.linkedin || ''}">${C.contact.linkedin || ''}</a>
    <span class="sep">·</span> <span class="lbl">GitHub:</span> <a href="https://${C.contact.github || ''}">${C.contact.github || ''}</a>
    <span class="sep">·</span> <span class="lbl">Portfolio:</span> <a href="https://${C.contact.portfolio || ''}">${C.contact.portfolio || ''}</a>
  </p>
</header>`;
  const headerDach =
`<div class="header-row">
  <div class="header-text">
    <h1>${C.name}</h1>
    <p class="header-tagline">${v.subheadEN}</p>
    <p class="pd-h2">Personal Details</p>
    <div class="pd-table">
      <div><span class="label">Address</span><span>${C.contact.location_en || ''}</span></div>
      <div><span class="label">Phone</span><span>${C.contact.phone || ''}</span></div>
      <div><span class="label">Email</span><a href="mailto:${C.contact.email || ''}">${C.contact.email || ''}</a></div>
      <div><span class="label">LinkedIn</span><a href="https://${C.contact.linkedin || ''}">${C.contact.linkedin || ''}</a></div>
      <div><span class="label">GitHub</span><a href="https://${C.contact.github || ''}">${C.contact.github || ''}</a></div>
      <div><span class="label">Portfolio</span><a href="https://${C.contact.portfolio || ''}">${C.contact.portfolio || ''}</a></div>
    </div>
  </div>
</div>`;
  const header = DACH_FORMAT ? headerDach : headerStandard;

  const body = [
    header,
    `<section>\n  <h2>Profile</h2>\n  <p>${profile}</p>\n</section>`,
    renderExperience(C.experience.en, 'Experience'),
    renderProjects(C.projects.en, selectProjectsForRender(C.projects.en, jdText, DACH_FORMAT), 'Projects'),
    renderSkills(C.skills, v.skillsOrder, 'Technical Skills'),
    `<p class="availability">Availability: ${MT.availabilityLine(market, 'en') || C.availability || 'On request.'}</p>`,
  ].join('\n\n');

  const html =
`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${C.name} CV${TITLE_SUFFIX[variantKey]}</title>
${FONT_LINK}
<style>${CSS_BASE}${DACH_FORMAT ? '\n' + CSS_DACH_HEADER : ''}
</style>
</head>
<body>

${body}

</body></html>
`;
  MT.assertNoCrossMarketLeak(html, market, `cv_${variantKey}_en`);
  MT.assertNoBannedContent(html, `cv_${variantKey}_en`);
  MT.assertNoProfileMetrics(html, `cv_${variantKey}_en`);
  MT.assertNoProfileHistory(html, `cv_${variantKey}_en`);
  MT.assertNoAspirationalLanguage(html, `cv_${variantKey}_en`);
  return html;
}

function buildDE(variantKey, C) {
  const v = { ...VARIANTS[variantKey] };
  v.subheadDE = applyRoleTitle(v.subheadDE);
  const market = MT.resolveMarket(COUNTRY, { dachFormat: DACH_FORMAT, lang: 'de', requireCountry: IS_APPLICATION_RENDER });
  const visa = MT.visaLine(market, 'de');

  const jdText = readJdText();
  let profile = C.positioning_line || `${v.subheadDE}.`;
  if (jdText && !SKIP_ENRICH) {
    const isGrad = SENIORITY === 'graduate' || SENIORITY === 'junior';
    const seniority = isGrad ? 'graduate' : 'mid';
    const kwArg = ARGS['tailor-keywords'];
    const keywords = typeof kwArg === 'string' ? kwArg.split(',').map(s => s.trim()).filter(Boolean) : [];
    const r = computeEnrichedProfile({
      archetype: variantKey === 'master' ? 'AE' : variantKey.toUpperCase(),
      seniority, keywords,
      roleTitle: ROLE_TITLE_OVERRIDE || v.subheadDE.split(' · ')[0],
      company: ARGS.company || '(unknown company)',
      country: COUNTRY, lang: 'de', jdText,
    });
    if (r.profile) profile = r.profile;
    else console.error(`[build-cvs] LLM enrichment failed (${r.reason}); falling back to positioning line.`);
  }
  if (visa && !profile.includes(visa)) profile = `${profile} ${visa}`;

  const header =
`<div class="header-row">
  <div class="header-text">
    <h1>${C.name}</h1>
    <p class="header-tagline">${v.subheadDE}</p>

    <p class="pd-h2">Persönliche Daten</p>
    <div class="pd-table">
      <div><span class="label">Anschrift</span><span>${C.contact.location_de || C.contact.location_en || ''}</span></div>
      <div><span class="label">Telefon</span><span>${C.contact.phone || ''}</span></div>
      <div><span class="label">E-Mail</span><a href="mailto:${C.contact.email || ''}">${C.contact.email || ''}</a></div>
      <div><span class="label">LinkedIn</span><a href="https://${C.contact.linkedin || ''}">${C.contact.linkedin || ''}</a></div>
      <div><span class="label">GitHub</span><a href="https://${C.contact.github || ''}">${C.contact.github || ''}</a></div>
      <div><span class="label">Portfolio</span><a href="https://${C.contact.portfolio || ''}">${C.contact.portfolio || ''}</a></div>
    </div>
  </div>
</div>`;

  const body = [
    header,
    `<section>\n  <h2>Profil</h2>\n  <p>${profile}</p>\n</section>`,
    renderExperience(C.experience.de, 'Berufserfahrung'),
    renderProjects(C.projects.de, selectProjectsForRender(C.projects.de, jdText, true), 'Projekte'),
    renderSkills(C.skills, v.skillsOrder, 'Technische Kenntnisse'),
    `<p class="availability">Verfügbarkeit: ${MT.availabilityLine(market, 'de') || C.availability || 'Auf Anfrage.'}</p>`,
  ].join('\n\n');

  const html =
`<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8">
<title>${C.name} Lebenslauf${TITLE_SUFFIX[variantKey]}</title>
${FONT_LINK}
<style>${CSS_BASE}
${CSS_DE_EXTRA}
</style>
</head>
<body>

${body}

</body></html>
`;
  MT.assertNoCrossMarketLeak(html, market, `cv_${variantKey}_de`);
  MT.assertNoBannedContent(html, `cv_${variantKey}_de`);
  MT.assertNoProfileMetrics(html, `cv_${variantKey}_de`);
  MT.assertNoProfileHistory(html, `cv_${variantKey}_de`);
  MT.assertNoAspirationalLanguage(html, `cv_${variantKey}_de`);
  return html;
}

// ---- targets + export path -----------------------------------------------
const ALL_TARGETS = [
  { variant: 'master', lang: 'en', file: 'cv_master_en.html' },
  { variant: 'master', lang: 'de', file: 'cv_master_de.html' },
  { variant: 'ae',     lang: 'en', file: 'cv_ae_en.html' },
  { variant: 'ae',     lang: 'de', file: 'cv_ae_de.html' },
  { variant: 'ds',     lang: 'en', file: 'cv_ds_en.html' },
  { variant: 'ds',     lang: 'de', file: 'cv_ds_de.html' },
  { variant: 'de',     lang: 'en', file: 'cv_de_en.html' },
  { variant: 'de',     lang: 'de', file: 'cv_de_de.html' },
  { variant: 'da',     lang: 'en', file: 'cv_da_en.html' },
  { variant: 'da',     lang: 'de', file: 'cv_da_de.html' },
  { variant: 'me',     lang: 'en', file: 'cv_me_en.html' },
  { variant: 'me',     lang: 'de', file: 'cv_me_de.html' },
];

const TARGETS = ALL_TARGETS.filter((t) =>
  (!ARGS.variant || t.variant === ARGS.variant) &&
  (!ARGS.lang || t.lang === ARGS.lang)
);

// ---- optional JSON export ------------------------------------------------
if (ARGS['export-json']) {
  const { data } = loadCvMaster();
  const outPath = ARGS['export-path'] && typeof ARGS['export-path'] === 'string'
    ? path.resolve(ARGS['export-path'])
    : path.join(__dirname, 'cv_master.json');
  const parent = path.dirname(outPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`Wrote ${outPath}  (${fs.statSync(outPath).size} bytes)`);
  process.exit(0);
}

if (TARGETS.length === 0) {
  console.error(`No matching targets for --variant=${ARGS.variant} --lang=${ARGS.lang}`);
  console.error(`Valid variants: master, ae, ds, de, da, me  |  valid langs: en, de`);
  process.exit(2);
}

// ---- persist tailoring metadata as HTML comments -------------------------
const metaComments = [
  ROLE_TITLE_OVERRIDE ? `<!-- role-title: ${ROLE_TITLE_OVERRIDE} -->` : '',
  ARGS['tailor-keywords'] ? `<!-- tailor-keywords: ${ARGS['tailor-keywords']} -->` : '',
].filter(Boolean);
const keywordsBanner = metaComments.length
  ? `${metaComments.join('\n')}\n<!-- generated: ${new Date().toISOString()} -->\n`
  : '';

// ---- main render loop ----------------------------------------------------
const { data: master, source } = loadCvMaster();
console.error(`[build-cvs] CV data source: ${path.relative(process.cwd(), source)}`);
const C = shapeContent(master);

let count = 0;
for (const t of TARGETS) {
  let html = t.lang === 'en' ? buildEN(t.variant, C) : buildDE(t.variant, C);
  if (keywordsBanner) html = keywordsBanner + html;
  fs.writeFileSync(path.join(OUT_DIR, t.file), html, 'utf8');
  count++;
  console.log(`  written  ${t.file}  (${html.length} bytes)`);
}
console.log(`\nDone. ${count} file(s) in ${OUT_DIR}`);
