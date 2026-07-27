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
import { applyRoleTitle } from "./jd-role-title.mjs";

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const DACH_COUNTRIES = new Set(["DE", "AT", "CH", "GERMANY", "AUSTRIA", "SWITZERLAND"]);

// ── arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log('Usage: node generate-pdf-tailored.mjs --company <name> [--archetype AE|DS|DE|BI] [--lang en|de] [--country <ISO>] [--role-title "<JD title>"] [--keywords a,b,c] [--date YYYY-MM-DD] [--with-photo|--no-photo] [--max-pages N] [--profile-text "<text>"]');
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
    else if (a === "--max-pages") args.maxPages = parseInt(argv[++i], 10);
    else if (a === "--profile-text") args.profileText = argv[++i];
    else if (a === "--role-title") args.roleTitle = argv[++i];
  }

  // Language resolution:
  //   1. explicit --lang wins
  //   2. fallback to DACH country → de, else en
  const isDachCountry = DACH_COUNTRIES.has(args.country);
  if (!args.lang) args.lang = isDachCountry ? "de" : "en";
  args.isDachCountry = isDachCountry;

  // Photo trigger is now JD-language-driven, not country-driven:
  //   - DE Lebenslauf → photo by default; --no-photo override drops it
  //   - EN CV         → no photo by default; --with-photo override adds it
  args.includePhoto = args.lang === "de" ? !args.noPhoto : args.withPhoto;

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

// JD-driven project selection (implemented 2026-07-03 — was a no-op stub).
// Scores every project in cv/project-pool.json against the JD keywords and
// the archetype, pins the dissertation first, and returns the top
// `max_projects` as a markdown block in the cv.md Projects format. The pool
// spans the 4 CV-core projects PLUS the portfolio-only inventory from
// article-digest.md (SQL Server schema design, R regression, clinical trials,
// NLP sentiment, Power BI dashboard, MCP server), so a Power-BI-heavy JD gets
// the dashboard project and an NLP JD gets the RoBERTa study. Selection
// REPLACES, never adds — max_projects (4) protects the 2-page rule.
// Falls back to the cv.md block untouched when the pool file is absent.
function reorderProjects(projectsBlock, archetype, keywords = [], lang = "en") {
  const poolPath = resolve(__dirname, "project-pool.json");
  if (!existsSync(poolPath)) return projectsBlock;
  let pool;
  try { pool = JSON.parse(readFileSync(poolPath, "utf8")); }
  catch { return projectsBlock; }

  const kw = (keywords || []).map(k => String(k).toLowerCase());
  const arch = String(archetype || "AE").toUpperCase();
  const bodyKey = lang === "de" ? "md_de" : "md_en";

  const scored = (pool.projects || [])
    .filter(p => p[bodyKey])
    .map(p => {
      let s = (p.archetypes && p.archetypes[arch]) || 0;
      for (const k of kw) {
        if ((p.keywords || []).some(pk => k.includes(pk.trim()) || pk.trim().includes(k))) s += 2;
      }
      if (p.pinned) s += 100; // dissertation always leads
      return { p, s };
    })
    .sort((a, b) => b.s - a.s);

  const maxN = pool.max_projects || 4;
  const picked = scored.slice(0, maxN).filter(x => x.s > 0);
  if (!picked.length) return projectsBlock;

  console.log(`🧩 Projects selected [${arch}, ${kw.length} kw]: ${picked.map(x => `${x.p.id}(${x.s})`).join(", ")}`);
  return picked.map(x => x.p[bodyKey]).join("\n\n");
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
  // Canonical layout: ONE paragraph with bold category labels separated by spaces,
  // mirroring cv_english.pdf where Languages / Warehousing / Transformation flow inline.
  const rows = md.split("\n").filter(l => l.trim());
  if (!rows.length) return "";
  return `<p class="skills-paragraph">${rows.map(r => mdToInlineHtml(r)).join(" ")}</p>`;
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

  const profileBody = args.profileText || sections.profile;

  const reorderedSkills = reorderSkills(sections.skills || "", args.archetype);
  const reorderedProjects = reorderProjects(sections.projects || "", args.archetype, args.keywords, args.lang);

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
  if (args.lang !== "de") {
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

  // ── Persönliche Daten section (DE only) ──
  const personalDataBlock = (args.lang === "de" && sections.personal_data)
    ? `<section class="avoid-break"><h2>${labels.personal_data}</h2>${mdTableToHtml(sections.personal_data)}</section>`
    : "";

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
    EXPERIENCE:              experienceBlockToHtml(sections.experience || ""),
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
