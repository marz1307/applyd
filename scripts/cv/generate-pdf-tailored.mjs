#!/usr/bin/env node

/**
 * generate-pdf-tailored.mjs — Tailored CV PDF generator
 *
 * Mirrors the canonical published CV format
 * (cv_english.pdf / lebenslauf_deutsch.pdf): Source Serif 4 body,
 * IBM Plex Sans headings, JetBrains Mono tech tags, orange
 * (#D4471F) section underlines.
 *
 * Trigger (per modes/_profile.md → "CV format by JD language"):
 *   --lang de  → cv-de.md, DE Lebenslauf, photo embedded, filename Lebenslauf_*
 *   --lang en  → cv.md, English CV, NO photo, filename CV_*
 *   (no --lang) → falls back to --country: DACH country → de, else en
 *
 * Overrides (rare):
 *   --with-photo  → force photo onto an EN CV (DACH recruiter asked)
 *   --no-photo    → drop photo from a DE Lebenslauf (recruiter asked)
 *
 * Golden rule: --max-pages 2 (default). Generator exits 2 if exceeded.
 *
 * Usage:
 *   node generate-pdf-tailored.mjs \
 *     --archetype AE --company Eraneos --country DE --lang de --date 2026-05-24
 */

import { readFile, writeFile, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { applyRoleTitle } from "./jd-role-title.mjs";
import { enrichProfile } from "./profile-enrich.mjs";
import { logProfileSource } from "./profile-source-log.mjs";
const require = createRequire(import.meta.url);
const MT = require("./market-tail.cjs");
const PS = require("./project-scoring.cjs");

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const DACH_COUNTRIES = new Set(["DE", "AT", "CH", "GERMANY", "AUSTRIA", "SWITZERLAND"]);

// ── arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log('Usage: node generate-pdf-tailored.mjs --company <name> [--archetype AE|DS|DE|BI] [--lang en|de] [--country <ISO>] [--role-title "<JD title>"] [--keywords a,b,c] [--date YYYY-MM-DD] [--with-photo|--no-photo] [--dach-format|--no-dach-format] [--max-pages N] [--profile-text "<text>"] [--seniority mid|graduate|senior] [--jd-file <path>] [--jd-text "<text>"]');
    process.exit(0);
  }
  const args = {
    keywords: [],
    lang: null,
    profileText: "",
    country: "",
    noPhoto: false,
    withPhoto: false,
    langExplicit: false,
    maxPages: 2,  // GOLDEN RULE per modes/_profile.md
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cv") args.cv = argv[++i];
    else if (a === "--archetype") args.archetype = argv[++i].toUpperCase();
    else if (a === "--company") args.company = argv[++i];
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--country") args.country = argv[++i].toUpperCase();
    else if (a === "--keywords") args.keywords = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--lang") { args.lang = argv[++i].toLowerCase(); args.langExplicit = true; }
    else if (a === "--no-photo") args.noPhoto = true;
    else if (a === "--with-photo") args.withPhoto = true;
    else if (a === "--dach-format") args.dachFormatExplicit = true;
    else if (a === "--no-dach-format") args.noDachFormat = true;
    else if (a === "--max-pages") args.maxPages = parseInt(argv[++i], 10);
    else if (a === "--profile-text") args.profileText = argv[++i];
    else if (a === "--role-title") args.roleTitle = argv[++i];
    else if (a === "--seniority") args.seniority = argv[++i].toLowerCase();
    else if (a === "--job-url") args.jobUrl = argv[++i];
    else if (a === "--jd-text") args.jdText = argv[++i];
    else if (a === "--jd-file") {
      const p = argv[++i];
      try { args.jdText = readFileSync(p, "utf8"); }
      catch (e) { console.warn(`⚠ --jd-file ${p} unreadable: ${e.message}`); }
    }
  }

  // Language resolution:
  //   1. explicit --lang wins
  //   2. fallback to DACH country → de, else en
  const isDachCountry = DACH_COUNTRIES.has(args.country);
  if (!args.lang) args.lang = isDachCountry ? "de" : "en";
  args.isDachCountry = isDachCountry;

  // DACH presentation for an ENGLISH CV (photo + Personal Details, the format
  // a German-market recruiter expects). Auto-ON when country is DACH and JD
  // language is English. --dach-format forces it on, --no-dach-format forces
  // it off.
  args.dachFormat = args.noDachFormat
    ? false
    : (!!args.dachFormatExplicit || (isDachCountry && args.lang === "en"));

  // Photo trigger is JD-language-driven, plus DACH presentation:
  //   - DE Lebenslauf   → photo by default; --no-photo override drops it
  //   - EN + DACH format → photo by default; --no-photo override drops it
  //   - EN otherwise    → no photo by default; --with-photo override adds it
  args.includePhoto = args.lang === "de"
    ? !args.noPhoto
    : (args.withPhoto || (args.dachFormat && !args.noPhoto));

  if (!args.cv) args.cv = args.lang === "de" ? "cv-de.md" : "cv.md";
  if (!args.archetype) args.archetype = "AE";
  if (!args.date) args.date = new Date().toISOString().slice(0, 10);
  if (!args.company) {
    console.error("--company is required");
    process.exit(1);
  }
  return args;
}

// ── cv.md parser ─────────────────────────────────────────────────────────
function parseCvMd(text) {
  const sections = {};
  const lines = text.split("\n");
  let current = "header";
  sections[current] = [];

  for (const line of lines) {
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      current = normaliseSectionKey(h2[1]);
      sections[current] = [];
      continue;
    }
    sections[current].push(line);
  }
  for (const k of Object.keys(sections)) {
    sections[k] = sections[k].join("\n").trim();
  }
  return sections;
}

function normaliseSectionKey(heading) {
  const h = heading.toLowerCase();
  if (h.includes("persönliche daten") || h.includes("personliche daten") || h.includes("personal data")) return "personal_data";
  if (h.includes("profil")) return "profile";
  if (h.includes("experience") || h.includes("berufserfahrung")) return "experience";
  if (h.includes("education") || h.includes("ausbildung")) return "education";
  if (h.includes("project") || h.includes("projekt")) return "projects";
  if (h.includes("technical skill") || h.includes("skill") || h.includes("technische kenntnis")) return "skills";
  if (h.includes("language") || h.includes("sprache")) return "languages";
  if (h.includes("certification") || h.includes("zertifikat")) return "certifications";
  if (h.includes("community") || h.includes("engagement") || h.includes("leadership")) return "community";
  if (h.includes("additional")) return "additional";
  return heading.toLowerCase().replace(/\s+/g, "-");
}

// Markdown table → HTML <table>. Skips ---/-:- divider rows and fully-empty rows.
function mdTableToHtml(md) {
  const rows = md
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("|") && l.endsWith("|"));
  if (rows.length === 0) return "";
  const cells = rows
    .map(r => r.slice(1, -1).split("|").map(c => c.trim()))
    .filter(r => !r.every(c => /^[-:]+$/.test(c)))
    .filter(r => !r.every(c => c === ""));
  const html = cells
    .map(r => `<tr>${r.map((c, i) => `<td class="pd-${i === 0 ? "label" : "value"}">${mdToInlineHtml(c)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table class="personal-data">${html}</table>`;
}

// Pull the role tagline (first **bold** line) from the cv.md header block.
function extractRoleTagline(headerBlock) {
  if (!headerBlock) return "";
  const m = headerBlock.match(/^\*\*([^*]+)\*\*/m);
  return m ? m[1].trim() : "";
}

// ── archetype-driven section reordering ─────────────────────────────────
const ARCHETYPE_SKILL_ORDER = {
  AE: ["Languages", "Warehousing", "Transformation & Orchestration", "Service Layer", "ML & Statistics", "Agentic AI", "BI & Visualisation", "Cloud", "Source Control & CI"],
  DS: ["ML & Statistics", "Agentic AI", "Languages", "Warehousing", "Transformation & Orchestration", "Service Layer", "BI & Visualisation", "Cloud", "Source Control & CI"],
  DE: ["Languages", "Transformation & Orchestration", "Warehousing", "Service Layer", "Cloud", "ML & Statistics", "Agentic AI", "BI & Visualisation", "Source Control & CI"],
  BI: ["BI & Visualisation", "Languages", "Warehousing", "Transformation & Orchestration", "ML & Statistics", "Service Layer", "Cloud", "Agentic AI", "Source Control & CI"],
};

function reorderSkills(skillsBlock, archetype) {
  const order = ARCHETYPE_SKILL_ORDER[archetype] || ARCHETYPE_SKILL_ORDER.AE;
  const rowRe = /^\*\*([^:]+):\*\*\s*(.+)$/gm;
  const rows = {};
  let m;
  while ((m = rowRe.exec(skillsBlock)) !== null) {
    rows[m[1].trim()] = m[2].trim();
  }
  const seen = new Set();
  const ordered = [];
  for (const key of order) {
    if (rows[key]) {
      ordered.push(`**${key}:** ${rows[key]}`);
      seen.add(key);
    }
  }
  for (const key of Object.keys(rows)) {
    if (!seen.has(key)) ordered.push(`**${key}:** ${rows[key]}`);
  }
  return ordered.join("\n");
}

// JD-driven project selection. Delegates to the shared deterministic scorer
// (project-scoring.cjs) so this file and build-cvs.js agree on rankings.
// Scoring: archetype fit * 10 + strong_kw * 3 * section_weight + weak_kw
// + impact - anti_kw * 100 + (pinned ? 1000 : 0). See project-scoring.cjs
// for the full formula. Selection REPLACES, never adds — max_projects
// protects the 2-page rule. Falls back to the cv.md block when the pool
// file is absent.
function reorderProjects(projectsBlock, archetype, keywords = [], lang = "en", jdText = "") {
  const pool = PS.loadPool();
  if (!pool) return projectsBlock;

  const arch = String(archetype || "AE").toUpperCase();
  const bodyKey = lang === "de" ? "md_de" : "md_en";
  // Prefer full JD text when available; fall back to keyword blob otherwise.
  const scoringText = (jdText && String(jdText).trim())
    || (keywords || []).map(String).join(" ");

  const ids = PS.selectProjectIds({ pool, archetype: arch, jdText: scoringText });
  if (!ids || !ids.length) return projectsBlock;

  const byId = new Map(pool.projects.map(p => [p.id, p]));
  const archKey = arch.toLowerCase();
  const variantsKey = "variants_" + lang;
  const bodyFor = (p) => (p[variantsKey] && p[variantsKey][archKey]) || p[bodyKey];

  const picks = ids.map(id => byId.get(id)).filter(Boolean).filter(p => p[bodyKey]);
  if (!picks.length) return projectsBlock;

  console.log(`🧩 Projects selected [${arch}, JD ${scoringText.length}ch]: ${picks.map(p => `${p.id}${(p[variantsKey] && p[variantsKey][archKey]) ? "*" : ""}`).join(", ")}${picks.some(p => p[variantsKey] && p[variantsKey][archKey]) ? "  (* = archetype variant)" : ""}`);
  return picks.map(p => bodyFor(p)).join("\n\n");
}

// Per-archetype experience block override (experience-pool.json). For each
// role block in the cv.md experience section, look up a matching entry by
// slug / cv_header_match; if a variant for this archetype+lang exists,
// replace the whole role block. Falls back to the cv.md block untouched when
// no override matches or the pool is absent.
function reorderExperience(experienceBlock, archetype, lang = "en") {
  const populated = resolve(__dirname, "experience-pool.json");
  const example = resolve(__dirname, "experience-pool.example.json");
  const poolPath = existsSync(populated) ? populated : (existsSync(example) ? example : null);
  if (!poolPath) return experienceBlock;
  let pool;
  try { pool = JSON.parse(readFileSync(poolPath, "utf8")); }
  catch { return experienceBlock; }

  const arch = String(archetype || "AE").toUpperCase();
  const archKey = arch.toLowerCase();
  const variantsKey = "variants_" + lang;
  const overrides = pool.experiences || [];

  const parts = experienceBlock.split(/^### /m);
  const preamble = parts[0];
  const roles = parts.slice(1);

  const swapped = [];
  for (const role of roles) {
    const header = role.split("\n", 1)[0] || "";
    const match = overrides.find((o) => {
      const needle = String(o.cv_header_match || o.slug || "").toLowerCase();
      return needle && header.toLowerCase().includes(needle);
    });
    const variant = match && match[variantsKey] && match[variantsKey][archKey];
    if (variant) {
      // Variant is a FULL role block starting with "### ...". Strip the
      // leading "### " and ensure a trailing "\n\n" so /^### /m still splits
      // consecutive roles cleanly.
      let stripped = variant.replace(/^###\s+/, "");
      if (!stripped.endsWith("\n\n")) stripped = stripped.replace(/\n*$/, "\n\n");
      swapped.push(stripped);
      console.log(`👔 Experience swap [${arch}/${lang}]: ${match.slug} → archetype variant`);
    } else {
      swapped.push(role);
    }
  }
  return preamble + swapped.map((r) => "### " + r).join("");
}

// ── HTML rendering ──────────────────────────────────────────────────────
function mdToInlineHtml(md) {
  return md
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function blockToParagraphs(md) {
  return md
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p>${mdToInlineHtml(p.replace(/\n/g, " "))}</p>`)
    .join("\n");
}

// Render an experience block to canonical .role markup.
// Each role: ### Title · Company · ... · Dates
//            optional intro paragraph
//            - bullets
//            **Stack:** ...   →   <p class="stack"><span class="stack-label">Stack:</span> ...</p>
function experienceBlockToHtml(md) {
  const out = [];
  const roles = md.split(/^### /m).filter(Boolean);
  for (const role of roles) {
    const lines = role.split("\n");
    const title = lines[0];
    const body = lines.slice(1).join("\n").trim();

    // Split body into intro paragraph(s), bullets, and stack line.
    const parts = body.split("\n");
    const introLines = [];
    const bulletLines = [];
    let stackLine = "";
    for (const line of parts) {
      const trim = line.trim();
      if (trim.startsWith("- ")) bulletLines.push(trim);
      else if (/^\*\*Stack:\*\*/i.test(trim)) stackLine = trim;
      else introLines.push(line);
    }

    const intro = introLines.join("\n").trim();
    const introHtml = intro ? `<p>${mdToInlineHtml(intro.replace(/\n/g, " "))}</p>` : "";
    const bulletsHtml = bulletLines.length
      ? `<ul>\n${bulletLines.map(b => `<li>${mdToInlineHtml(b.replace(/^-\s*/, ""))}</li>`).join("\n")}\n</ul>`
      : "";

    let stackHtml = "";
    if (stackLine) {
      const stackText = stackLine.replace(/^\*\*Stack:\*\*\s*/i, "");
      stackHtml = `<p class="stack"><span class="stack-label">Stack:</span> ${mdToInlineHtml(stackText)}</p>`;
    }

    out.push(`<div class="role">\n<h3>${mdToInlineHtml(title)}</h3>\n${introHtml}\n${bulletsHtml}\n${stackHtml}\n</div>`);
  }
  return out.join("\n");
}

// Render projects matching the canonical style: bold title (with optional inline
// metadata after the first ·), description paragraph, then a monospace tag run
// at the end.
//
// Supports BOTH markdown formats:
//   `### Project Title · Meta · ...`   (cv-de.md style)
//   `**Project Title** · Meta · ...`   (cv.md style)
function projectsBlockToHtml(md) {
  const out = [];
  // Split on either a line starting with "### " OR a line starting with "**Title**" preceded by blank line.
  const projects = md.split(/\n(?=### |^\*\*[^*]+\*\*\s*·)/m);
  for (const proj of projects) {
    const raw = proj.trim();
    if (!raw) continue;

    const lines = raw.split("\n");
    let titleLine = lines[0] || "";
    const rest = lines.slice(1).join("\n").trim();

    // Strip a leading "### " so the rendered title doesn't show the markdown sigil.
    titleLine = titleLine.replace(/^###\s+/, "");

    // Detect a trailing backtick-wrapped tag line and split it off.
    let body = rest;
    let tagLine = "";
    const restLines = rest.split("\n");
    const lastIdx = (() => {
      for (let i = restLines.length - 1; i >= 0; i--) {
        if (restLines[i].trim()) return i;
      }
      return -1;
    })();
    if (lastIdx >= 0 && /`[^`]+`/.test(restLines[lastIdx])) {
      tagLine = restLines[lastIdx].trim();
      body = restLines.slice(0, lastIdx).join("\n").trim();
    }

    const bodyHtml = body ? blockToParagraphs(body) : "";
    const tagsHtml = tagLine
      ? `<p class="project-tags">${tagLine.replace(/`/g, "")}</p>`
      : "";

    out.push(`<div class="project">\n<p class="project-title">${mdToInlineHtml(titleLine)}</p>\n${bodyHtml}\n${tagsHtml}\n</div>`);
  }
  return out.join("\n");
}

function skillsBlockToHtml(md) {
  // One tier per line — each `**Label:** items` becomes its own paragraph so
  // a specific technology can be spotted at a scan. The old wall-of-text
  // layout hid single technologies inside a dense block.
  const rows = md.split("\n").filter(l => l.trim());
  if (!rows.length) return "";
  return rows.map(r => `<p class="skills-paragraph">${mdToInlineHtml(r)}</p>`).join("\n");
}

function competenciesToHtml(keywords) {
  if (!keywords || keywords.length === 0) return "";
  return keywords.map(k => `<span class="competency-tag">${k}</span>`).join("\n");
}

// ── 2-page hard rule ──────────────────────────────────────────────────────
// Pure-Node so it works on Windows (Task Scheduler) without poppler-utils.
function countPdfPages(pdfPath) {
  try {
    const buf = readFileSync(pdfPath);
    const text = buf.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page(?!s)/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

// ── Dynamic profile generation ──────────────────────────────────────────
// Build a JD-specific profile paragraph from archetype + keywords + seniority
// instead of using the static cv.md profile. The profile is the first thing a
// recruiter reads — it must draw a direct line from the candidate to THIS
// role. Templates are intentionally generic and metric-free (Profile is
// positioning, numbers live in Experience and Projects). Downstream editors
// should replace the archetype-specific text via config or --profile-text
// rather than editing this file per-user.
const GRAD_SIGNALS_CV = /\b(graduate|grad\b|entry[- ]level|junior|trainee|werkstudent|praktikant|apprentice|new grad|recent grad|class of|programme 202|program 202|early career)\b/i;

const ARCHETYPE_PROFILES = {
  AE: {
    graduate: (kw) => `Analytics Engineering graduate with production pipeline exposure: dbt models in dimensional design, CI-gated data quality, and a deterministic entity spine resolved out of messy source data.${kw.length ? ` Hands-on with ${kw.slice(0, 3).join(', ')}.` : ''} Looking for a structured environment to grow this foundation at scale.`,
    mid: (kw) => `Analytics Engineer with production experience across B2B SaaS analytics. Specialist in dbt dimensional modelling and CI-gated data quality, in Python and SQL.${kw.length ? ` Working across ${kw.slice(0, 3).join(', ')}.` : ''} Shipped end-to-end customer data layers on deduplicated entity spines under a test-gated release process.`,
  },
  DS: {
    graduate: (kw) => `Data Science graduate combining applied ML with production data engineering: gradient-boosted classification with model explanations, plus deployment into a live warehouse rather than a sandbox.${kw.length ? ` Skills include ${kw.slice(0, 3).join(', ')}.` : ''} Seeking a role that pairs mentorship with real analytical ownership.`,
    mid: (kw) => `Data Scientist with applied ML and analytics experience in B2B SaaS. Specialist in explainable ML and production-shape modelling, in Python and scikit-learn.${kw.length ? ` Working across ${kw.slice(0, 3).join(', ')}.` : ''} Shipped classification and forecasting models on data layers built end to end.`,
  },
  DE: {
    graduate: (kw) => `Data Engineering graduate with production pipeline experience: Python extractors, orchestrated workflows, containerised deployment, and CI-gated transformations running to a schedule.${kw.length ? ` Hands-on with ${kw.slice(0, 3).join(', ')}.` : ''} Looking for a team where I can deepen my engineering practice.`,
    mid: (kw) => `Data Engineer with production pipeline experience across ingestion and dimensional modelling. Specialist in orchestration and infrastructure, in Python and SQL.${kw.length ? ` Working across ${kw.slice(0, 3).join(', ')}.` : ''} Shipped an extractor + transformation stack under CI, deployed on managed cloud.`,
  },
  DA: {
    graduate: (kw) => `Data Analytics graduate with hands-on delivery across BI tools, Python, and SQL, plus production data-layer experience in dbt dimensional modelling.${kw.length ? ` Skills include ${kw.slice(0, 3).join(', ')}.` : ''} Comfortable owning a question end to end, from the warehouse model to the dashboard a stakeholder reads.`,
    mid: (kw) => `Data Analyst with production experience in B2B SaaS analytics and stakeholder-facing reporting. Specialist in BI dashboards, in SQL and Python.${kw.length ? ` Working across ${kw.slice(0, 3).join(', ')}.` : ''} Delivered dashboards that replaced manual reporting cycles with live self-serve numbers.`,
  },
  BI: {
    graduate: (kw) => `BI graduate with production delivery: dashboards that replaced a manual reporting cycle with live figures, built on dimensional models in classic warehouse design.${kw.length ? ` Hands-on with ${kw.slice(0, 3).join(', ')}.` : ''} Seeking a BI role with mentorship.`,
    mid: (kw) => `BI Developer with production experience across analytics and reporting. Specialist in dashboards and dimensional modelling, in DAX and SQL.${kw.length ? ` Working across ${kw.slice(0, 3).join(', ')}.` : ''} Shipped modelled marts and dashboards that cut multi-day reporting cycles to live.`,
  },
  ME: {
    graduate: (kw) => `ML Engineering graduate with model-serving experience: an API service with authentication and Row-Level Security serving classification and forecasting models in production.${kw.length ? ` Skills include ${kw.slice(0, 3).join(', ')}.` : ''} Seeking a structured ML engineering role.`,
    mid: (kw) => `ML Engineer with experience serving predictive models on production data platforms in B2B SaaS. Specialist in model serving and explainability.${kw.length ? ` Working across ${kw.slice(0, 3).join(', ')}.` : ''} Deployed classification and survival models with model-explanation attached, on production data layers built end to end.`,
  },
};

function detectSeniorityFromJd(jdText, roleTitle, explicit) {
  if (explicit) return explicit;
  const t = (jdText || '') + ' ' + (roleTitle || '');
  if (GRAD_SIGNALS_CV.test(t)) return 'graduate';
  if (/\b(senior|staff|principal|lead|head of|director|vp)\b/i.test(t)) return 'senior';
  return 'mid';
}

function generateDynamicProfile(archetype, keywords, seniority) {
  const arch = ARCHETYPE_PROFILES[archetype] || ARCHETYPE_PROFILES.AE;
  const band = (seniority === 'graduate' || seniority === 'junior') ? 'graduate' : 'mid';
  return arch[band](keywords || []);
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`📄 CV source: ${args.cv}`);
  console.log(`🏷  Archetype: ${args.archetype}`);
  console.log(`🏢 Company:   ${args.company}`);
  console.log(`📅 Date:      ${args.date}`);
  console.log(`🌐 Language:  ${args.lang}`);
  if (args.country) console.log(`🌍 Country:   ${args.country}${args.isDachCountry ? " (DACH)" : ""}`);
  if (args.includePhoto) console.log(`📷 Photo:     embedded (35mm × 45mm Bewerbungsfoto)`);
  if (args.keywords.length) console.log(`🔑 Keywords:  ${args.keywords.join(", ")}`);

  const cvText = await readFileAsync(resolve(REPO_ROOT, args.cv), "utf8");
  const templateText = await readFileAsync(resolve(REPO_ROOT, "templates/cv-template.html"), "utf8");
  const profileYml = await readFileAsync(resolve(REPO_ROOT, "config/profile.yml"), "utf8");

  const sections = parseCvMd(cvText);

  const headerLines = sections.header.split("\n").filter(Boolean);

  const profileGet = (key) => {
    const m = profileYml.match(new RegExp(`^\\s*${key}\\s*:\\s*['"]?([^'"\n]+)['"]?`, "m"));
    return m ? m[1].trim() : "";
  };

  const name = headerLines[0]?.replace(/^#\s+/, "") || profileGet("full_name") || profileGet("name") || "Candidate";
  const email = profileGet("email");
  const phone = profileGet("phone");
  const location = profileGet("location");
  const linkedin = profileGet("linkedin");
  const portfolio = profileGet("portfolio_url");
  const github = profileGet("github") || "";

  // Profile priority:
  //   1. explicit --profile-text (author override) — wins unconditionally
  //   2. LLM enrichment via profile-enrich.mjs — when JD text is available
  //      AND APPLYD_PROFILE_ENRICH != '0'; falls back on any guardrail fail
  //   3. Hardcoded ARCHETYPE_PROFILES template — when JD/keywords/seniority
  //      is known but the LLM path is unavailable
  //   4. Static cv.md profile — final fallback
  const seniority = detectSeniorityFromJd(args.jdText || '', args.roleTitle || '', args.seniority);
  let profileBody;
  let profileSource;
  if (args.profileText) {
    profileBody = args.profileText;
    profileSource = 'explicit-profile-text';
  } else if (args.jdText && process.env.APPLYD_PROFILE_ENRICH !== '0') {
    console.log(`📝 Attempting LLM profile enrichment (JD ${args.jdText.length} chars, ${args.archetype}/${seniority})...`);
    try {
      const enriched = await enrichProfile({
        jdText: args.jdText,
        company: args.company,
        roleTitle: args.roleTitle,
        archetype: args.archetype,
        seniority,
        keywords: args.keywords,
        country: args.country,
        lang: args.lang,
      });
      if (enriched && enriched.profile) {
        profileBody = enriched.profile;
        profileSource = `llm-enriched (${enriched.word_count} words)`;
        console.log(`📝 LLM profile: "${profileBody.slice(0, 90)}..."`);
      } else {
        const reason = enriched ? enriched.reason : 'no-result';
        console.warn(`⚠ LLM enrichment failed (${reason}); falling back to template.`);
        profileBody = generateDynamicProfile(args.archetype, args.keywords, seniority);
        profileSource = `template-fallback (${reason})`;
      }
    } catch (e) {
      console.warn(`⚠ LLM enrichment crashed (${e.message}); falling back to template.`);
      profileBody = generateDynamicProfile(args.archetype, args.keywords, seniority);
      profileSource = `template-fallback (crash)`;
    }
  } else if (args.keywords.length || args.seniority || args.jdText) {
    profileBody = generateDynamicProfile(args.archetype, args.keywords, seniority);
    profileSource = 'template';
    console.log(`📝 Template profile (${seniority}/${args.archetype}): "${profileBody.slice(0, 80)}..."`);
  } else {
    profileBody = sections.profile;
    profileSource = 'static-cv.md';
  }
  console.log(`🎯 Profile source: ${profileSource}`);

  // A/B tracking: every render appends a row so response-rate by profile
  // source can be analysed downstream (see cv/qa-outcomes.mjs).
  try {
    logProfileSource({
      company: args.company,
      role_title: args.roleTitle || null,
      archetype: args.archetype || null,
      seniority,
      lang: args.lang,
      country: args.country || null,
      source: profileSource,
      word_count: profileBody.split(/\s+/).filter(Boolean).length,
      jd_present: !!args.jdText,
      renderer: 'generate-pdf-tailored',
    });
  } catch { /* logging is best-effort; never fail a render on it */ }

  // ── Market-aware visa tail ──
  // One market per CV: strip any pre-existing visa/right-to-work sentence,
  // then append the line for THIS posting's market. Missing --country on an
  // application render is a caller bug.
  const market = MT.resolveMarket(args.country, { dachFormat: args.dachFormat, lang: args.lang, requireCountry: false });
  profileBody = MT.stripVisaSentences(profileBody);
  const marketVisaLine = MT.visaLine(market, args.lang);
  if (marketVisaLine) profileBody = `${profileBody} ${marketVisaLine}`;
  console.log(`🌍 Market tail: ${market}${marketVisaLine ? "" : " (no visa line by design)"}`);

  // 10-second-rule guard: warn when the profile balloons past a scannable
  // length. Recruiters spend ~10 seconds on the profile before deciding
  // whether to keep reading.
  const PROFILE_LINE_WIDTH_CHARS = 130;
  const PROFILE_SOFT_LINES = 6;
  const PROFILE_HARD_LINES = 8;
  const profileEstLines = Math.ceil(profileBody.length / PROFILE_LINE_WIDTH_CHARS);
  if (profileEstLines > PROFILE_HARD_LINES) {
    console.error(`\n❌ PROFILE_TOO_LONG: estimated ${profileEstLines} lines (~${profileBody.length} chars) exceeds the ${PROFILE_HARD_LINES}-line hard cap.`);
    console.error(`   Tighten --profile-text (or the archetype default in generateDynamicProfile) to <=${PROFILE_SOFT_LINES} lines / ~${PROFILE_SOFT_LINES * PROFILE_LINE_WIDTH_CHARS} chars, then retry.`);
    process.exit(2);
  }
  if (profileEstLines > PROFILE_SOFT_LINES) {
    console.warn(`⚠  Profile ~${profileEstLines} lines (${profileBody.length} chars). Target <=${PROFILE_SOFT_LINES} lines for the 10-second scan; consider tightening.`);
  }

  const reorderedSkills = reorderSkills(sections.skills || "", args.archetype);
  const reorderedProjects = reorderProjects(sections.projects || "", args.archetype, args.keywords, args.lang, args.jdText || "");
  const reorderedExperience = reorderExperience(sections.experience || "", args.archetype, args.lang);

  const labels = args.lang === "de"
    ? {
        docLabel:        "Lebenslauf",
        summary:         "Profil",
        competencies:    "Kernkompetenzen",
        experience:      "Berufserfahrung",
        projects:        "Ausgewählte Projekte",
        education:       "Ausbildung",
        certifications: "Zertifikate",
        skills:          "Technische Kenntnisse",
        languages:       "Sprachen",
        personal_data:   "Persönliche Daten",
      }
    : {
        docLabel:        "CV",
        summary:         "Profile",
        competencies:    "Core Competencies",
        experience:      "Experience",
        projects:        "Selected Projects",
        education:       "Education",
        certifications: "Certifications",
        skills:          "Technical Skills",
        languages:       "Languages",
        personal_data:   "Personal Details",
      };

  // Job-title header: LEAD with the JD's verbatim advertised role (--role-title),
  // keeping the CV's role anchor. Without --role-title the header stays generic —
  // which violates the "tagline = JD's exact advertised role" rule, so warn loudly.
  let tagline = extractRoleTagline(sections.header) || "Analytics Engineer · Data Scientist";
  if (args.roleTitle) {
    tagline = applyRoleTitle(tagline, args.roleTitle);
    console.log(`🎯 Header role: "${tagline}" (from --role-title "${args.roleTitle}")`);
  } else {
    console.warn(`⚠ No --role-title passed — header stays "${tagline}" and will NOT match the JD's advertised role.`);
  }

  // ── DE Lebenslauf: embed Bewerbungsfoto (base64 so HTML is self-contained) ──
  let photoBlock = "";
  if (args.includePhoto) {
    const photoPath = resolve(REPO_ROOT, "assets", "candidate-photo.jpg");
    if (existsSync(photoPath)) {
      const photoB64 = readFileSync(photoPath).toString("base64");
      photoBlock = `<div class="header-photo"><img src="data:image/jpeg;base64,${photoB64}" alt="${name}" /></div>`;
    } else {
      console.warn(`⚠ Photo requested but assets/candidate-photo.jpg not found — proceeding without photo`);
    }
  }

  // ── Header subtitle: EN gets the canonical .contact row; DE gets empty (Persönliche Daten replaces it) ──
  const linkedinUrl = linkedin.startsWith("http") ? linkedin : `https://${linkedin}`;
  const portfolioUrl = portfolio.startsWith("http") ? portfolio : `https://${portfolio}`;
  const linkedinDisp = linkedin.replace(/^https?:\/\//, "");
  const portfolioDisp = portfolio.replace(/^https?:\/\//, "");
  const githubDisp = github.replace(/^https?:\/\//, "");

  let headerSubtitle = "";
  if (args.lang !== "de" && !args.dachFormat) {
    headerSubtitle =
      '<p class="contact">' +
        `${location}` +
        '<span class="sep">·</span> ' + `${phone}` +
        '<span class="sep">·</span> ' + `<a href="mailto:${email}">${email}</a>` +
        '<span class="sep">·</span> ' + `<a href="${linkedinUrl}">${linkedinDisp}</a>` +
        '<span class="sep">·</span> ' + `<a href="https://${githubDisp}">${githubDisp}</a>` +
        '<span class="sep">·</span> ' + `<a href="${portfolioUrl}">${portfolioDisp}</a>` +
      '</p>';
  }

  // ── Personal Details section ──
  // DE Lebenslauf: reads from cv-de.md's own table. EN + DACH format:
  // synthesised from profile.yml so an English CV for a DACH employer
  // carries the presentation a German-market recruiter expects.
  let personalDataBlock = "";
  if (args.lang === "de" && sections.personal_data) {
    personalDataBlock = `<section class="avoid-break"><h2>${labels.personal_data}</h2>${mdTableToHtml(sections.personal_data)}</section>`;
  } else if (args.lang === "en" && args.dachFormat) {
    const pdMd = [
      "| | |",
      "|---|---|",
      `| **Address** | ${location} |`,
      `| **Email** | ${email} |`,
      `| **Phone** | ${phone} |`,
      `| **LinkedIn** | ${linkedinDisp} |`,
      `| **GitHub** | ${githubDisp} |`,
      `| **Portfolio** | ${portfolioDisp} |`,
    ].join("\n");
    personalDataBlock = `<section class="avoid-break"><h2>${labels.personal_data}</h2>${mdTableToHtml(pdMd)}</section>`;
  }

  // ── Competencies section (only when keywords present) ──
  const competenciesBlock = args.keywords.length
    ? `<section class="avoid-break"><h2>${labels.competencies}</h2><div class="competencies-grid">${competenciesToHtml(args.keywords)}</div></section>`
    : "";

  // ── Languages section (read from sections.languages if present, else from profile.yml inline) ──
  const languagesHtml = sections.languages
    ? blockToParagraphs(sections.languages)
    : `<p>${args.lang === "de" ? "<strong>Englisch:</strong> Muttersprachlich · <strong>Deutsch:</strong> B1 (Mittelstufe, in Vorbereitung auf B2)" : "<strong>English:</strong> Native or bilingual proficiency · <strong>German:</strong> B1 (intermediate, working toward B2)"}</p>`;

  const subs = {
    LANG:                    args.lang,
    DOC_LABEL:               labels.docLabel,
    NAME:                    name,
    TAGLINE:                 tagline,
    HEADER_SUBTITLE:         headerSubtitle,
    PHOTO_BLOCK:             photoBlock,
    PERSONAL_DATA_BLOCK:     personalDataBlock,
    SECTION_SUMMARY:         labels.summary,
    SUMMARY_TEXT:            mdToInlineHtml(profileBody),
    COMPETENCIES_BLOCK:      competenciesBlock,
    SECTION_EXPERIENCE:      labels.experience,
    EXPERIENCE:              experienceBlockToHtml(reorderedExperience),
    SECTION_PROJECTS:        labels.projects,
    PROJECTS:                projectsBlockToHtml(reorderedProjects),
    SECTION_EDUCATION:       labels.education,
    EDUCATION:               blockToParagraphs(sections.education || ""),
    SECTION_SKILLS:          labels.skills,
    SKILLS:                  skillsBlockToHtml(reorderedSkills),
    SECTION_LANGUAGES:       labels.languages,
    LANGUAGES:               languagesHtml,
    SECTION_CERTIFICATIONS:  labels.certifications,
    CERTIFICATIONS:          blockToParagraphs(sections.certifications || ""),
  };

  let html = templateText;
  for (const [key, val] of Object.entries(subs)) {
    html = html.replaceAll(`{{${key}}}`, val);
  }

  // Cross-market drift guard: a DACH/EU CV must never carry the UK visa
  // story, a UK CV must never carry the Blue Card story. Throws → exit 1.
  MT.assertNoCrossMarketLeak(html, market, `${args.company} (${args.lang})`);
  // Banned-content grep gate: any repo-configured banned phrases (see
  // market-tail.cjs). Throws → exit 1.
  MT.assertNoBannedContent(html, `${args.company} (${args.lang})`);
  // Profile-metric ban: named model-quality metrics, percentages, count-plus
  // phrases, and decimal scores must not appear in the Profile section.
  // Metrics live in Experience and Projects. Throws → exit 1.
  MT.assertNoProfileMetrics(html, `${args.company} (${args.lang})`);
  // Profile-history ban: dates, employer names, universities, and
  // non-target-country references must not appear in the Profile section.
  // Throws → exit 1.
  MT.assertNoProfileHistory(html, `${args.company} (${args.lang})`);

  const slug = args.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const namePart = name.replace(/\s+/g, '_');
  const baseName = args.lang === "de"
    ? `${namePart}_Lebenslauf_${capitalise(slug)}_${args.date}`
    : `${namePart}_CV_${capitalise(slug)}_${args.date}`;

  const tmpHtml = `/tmp/${baseName}.html`;
  await writeFileAsync(tmpHtml, html, "utf8");
  console.log(`📝 Tailored HTML written to: ${tmpHtml}`);

  mkdirSync(resolve(REPO_ROOT, "output"), { recursive: true });
  const outputPdf = resolve(REPO_ROOT, "output", `${baseName}.pdf`);

  console.log("🎨 Rendering PDF via generate-pdf.mjs...");
  await new Promise((resolveP, rejectP) => {
    const child = spawn("node", [resolve(__dirname, "generate-pdf.mjs"), tmpHtml, outputPdf, "--format=a4"], {
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`generate-pdf.mjs exited ${code}`));
    });
  });

  // ── GOLDEN RULE: refuse to ship a PDF longer than args.maxPages ──
  const pageCount = countPdfPages(outputPdf);
  console.log(`📊 Pages rendered: ${pageCount} (limit: ${args.maxPages})`);
  if (pageCount > args.maxPages) {
    console.error("");
    console.error(`❌ GOLDEN RULE VIOLATION: ${pageCount} pages > ${args.maxPages}-page limit.`);
    console.error("   Either trim cv-de.md / cv.md (drop oldest role, merge into 'Earlier Experience', cut Projects/Certifications),");
    console.error("   or pass --max-pages 3 ONLY for an explicit one-off where a recruiter asked for a longer document.");
    console.error(`   Offending file: ${outputPdf}`);
    process.exit(2);
  }

  const summary = {
    status:           "ok",
    pdf_path:         outputPdf,
    html_path:        tmpHtml,
    archetype:        args.archetype,
    tailoring_variant: args.archetype,
    source_cv:        args.cv,
    company:          args.company,
    country:          args.country || null,
    date:             args.date,
    keyword_count:    args.keywords.length,
    lang:             args.lang,
    photo_embedded:   args.includePhoto,
    is_dach_country:  args.isDachCountry,
    dach_format:      args.dachFormat,
    market:           market,
    page_count:       pageCount,
    max_pages:        args.maxPages,
  };
  console.log("\n--- summary JSON ---");
  console.log(JSON.stringify(summary, null, 2));
}

function capitalise(s) {
  return s.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("-");
}

main().catch((err) => {
  console.error("❌ Tailored PDF generation failed:", err.message);
  process.exit(1);
});
