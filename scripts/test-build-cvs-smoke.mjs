#!/usr/bin/env node
/**
 * test-build-cvs-smoke.mjs — Smoke test for scripts/cv/build-cvs.js, the
 * variant CV renderer that auto-draft ships through.
 *
 * Renders HTML only (no Playwright, no PDF), so it stays fast enough to live
 * in the default `npm test` chain. Page-count and typography verification
 * stay manual, because they need a real PDF and take minutes, not seconds.
 *
 * Asserts, per rendered variant:
 *   1. the renderer exits 0
 *   2. an HTML file is actually produced
 *   3. the HTML is substantial (>4KB), not a truncated shell
 *   4. core sections are present (Profile / Experience / Skills)
 *   5. layout invariants set by the widow/orphan pass are present
 *   6. effective body typography matches the CSS_BASE target
 *   7. JD-driven runs stay within the two-page project cap
 *
 * Runs against the example JSONs (cv_master.example.json + project pool)
 * that ship with the repo, so a fresh clone can execute the test without
 * any user data. Exits 0 on full pass, non-zero with itemised failures
 * otherwise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BUILDER = join(REPO_ROOT, "scripts", "cv", "build-cvs.js");

let failed = 0;
const failures = [];

function fail(label, msg) {
  failed++;
  failures.push(`${label}: ${msg}`);
  console.error(`  ✗ ${label}: ${msg}`);
}
function ok(label, msg) {
  console.log(`  ✓ ${label}: ${msg}`);
}

// One variant per language is enough to catch a broken renderer. The full
// matrix is a manual pre-release check.
const CASES = [
  { variant: "ae", lang: "en", country: "UK", file: "cv_ae_en.html" },
  { variant: "ae", lang: "de", country: "DE", file: "cv_ae_de.html" },
  // JD-driven path: covers project scoring + DACH presentation cap.
  {
    variant: "ds", lang: "en", country: "DE", file: "cv_ds_en.html",
    dachFormat: true, jd: true, roleTitle: "Data Scientist AI", maxProjects: 3,
  },
  // Same JD path WITHOUT DACH presentation: guards against someone
  // "fixing" the DACH-3 cap by tightening every render to 3.
  {
    variant: "ds", lang: "en", country: "UK", file: "cv_ds_en.html",
    jd: true, roleTitle: "Data Scientist", minProjects: 3,
  },
];

const JD_TEXT = [
  "Data Scientist (D/F/M)",
  "Python, SQL, machine learning in production. Build models and ship them.",
  "dbt, Airflow, PostgreSQL, FastAPI. Classification, forecasting, SHAP.",
  "Stakeholder workshops. Cloud platforms.",
].join("\n");

// Gates that must hold in any shipped CV. These are the same content gates
// enforced by market-tail.cjs at render time; asserting them here catches a
// regression where the guards themselves get bypassed.
const CONTENT_GATES = [
  ["em dash", /—/],
];

// Layout invariants installed by the widow/orphan pass. If someone edits the
// CSS these catch it.
const LAYOUT_INVARIANTS = [
  ["orphans", /orphans:\s*2/],
  ["widows", /widows:\s*2/],
  ["meta break-after", /\.project-meta[^}]*break-after:\s*avoid/],
];

// Effective body typography. Take the LAST body declaration, because
// CSS_DE_EXTRA re-declares body AFTER CSS_BASE for German — that is exactly
// the divergence that used to silently sit German at a smaller body while
// English was at the target size.
const BODY_PT = 8.5;
const BODY_LH = 1.34;
function effectiveBodyType(html) {
  const decls = [...html.matchAll(/body\s*\{[^}]*?font-size:\s*([\d.]+)pt[^}]*?line-height:\s*([\d.]+)/g)];
  if (!decls.length) return null;
  const last = decls[decls.length - 1];
  return { pt: parseFloat(last[1]), lh: parseFloat(last[2]), count: decls.length };
}

const tmp = mkdtempSync(join(tmpdir(), "cvsmoke-"));

try {
  for (const c of CASES) {
    // Unique label per case: two cases share variant+lang and differ only
    // by country/presentation, so without the suffix they would collide in
    // the output dir and the second would silently overwrite the first.
    const label = `${c.variant}/${c.lang}/${c.country}${c.dachFormat ? "+dach" : ""}${c.jd ? "+jd" : ""}`;
    const out = join(tmp, label.replace(/[/+]/g, "_"));

    const argv = [BUILDER, "--variant", c.variant, "--lang", c.lang, "--out", out, "--country", c.country];
    if (c.jd) {
      const jdPath = join(tmp, `${label.replace(/[/+]/g, "_")}-jd.txt`);
      writeFileSync(jdPath, JD_TEXT, "utf8");
      argv.push("--jd-file", jdPath);
      // Exercise the JD PATH without the LLM enrichment call: keeps npm
      // test fast and independent of any subscription quota. JD-driven
      // project selection still runs — the whole point of these cases.
      argv.push("--no-enrich");
      if (c.roleTitle) argv.push("--role-title", c.roleTitle);
    }
    if (c.dachFormat) argv.push("--dach-format");

    const r = spawnSync("node", argv, { encoding: "utf8", timeout: 60000, cwd: REPO_ROOT });

    if (r.status !== 0) {
      const why = (r.stderr || r.stdout || "").trim().split("\n").slice(0, 2).join(" | ");
      fail(label, `renderer exited ${r.status}: ${why.slice(0, 160)}`);
      continue;
    }
    ok(label, "renderer exited 0");

    const htmls = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".html")) : [];
    if (!htmls.length) {
      fail(label, "renderer exited 0 but produced NO html file");
      continue;
    }
    const p = join(out, c.file);
    if (!existsSync(p)) {
      fail(label, `expected ${c.file}, got: ${htmls.join(", ")}`);
      continue;
    }

    const html = readFileSync(p, "utf8");

    if (html.length < 4000) {
      fail(label, `html only ${html.length} bytes (expected >4000)`);
      continue;
    }
    ok(label, `${c.file} produced, ${Math.round(html.length / 1024)}KB`);

    const sections = c.lang === "de"
      ? ["Profil", "Berufserfahrung", "Technische"]
      : ["Profile", "Experience", "Skills"];
    const missing = sections.filter((s) => !html.includes(s));
    if (missing.length) fail(label, `missing section(s): ${missing.join(", ")}`);
    else ok(label, "core sections present");

    // Strip CSS + HTML comments before checking content gates — both
    // legitimately hold characters that never reach the page.
    const visible = html
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
    const tripped = CONTENT_GATES.filter(([, re]) => re.test(visible)).map(([n]) => n);
    if (tripped.length) fail(label, `content gate(s) tripped: ${tripped.join(", ")}`);
    else ok(label, "content gates clean");

    const lost = LAYOUT_INVARIANTS.filter(([, re]) => !re.test(html)).map(([n]) => n);
    if (lost.length) fail(label, `layout invariant(s) missing: ${lost.join(", ")}`);
    else ok(label, "layout invariants present");

    const t = effectiveBodyType(html);
    if (!t) {
      fail(label, "no body font-size/line-height declaration found");
    } else if (t.pt !== BODY_PT || t.lh !== BODY_LH) {
      fail(label, `effective body typography ${t.pt}pt/${t.lh}, expected ${BODY_PT}pt/${BODY_LH}`);
    } else {
      ok(label, `effective body typography ${t.pt}pt/${t.lh} (${t.count} declaration(s), last wins)`);
    }

    const projectCount = (html.match(/class="project-meta"/g) || []).length;
    if (c.maxProjects != null && projectCount > c.maxProjects) {
      fail(label, `${projectCount} projects rendered, DACH presentation allows at most ${c.maxProjects} (2-page rule)`);
    } else if (c.minProjects != null && projectCount < c.minProjects) {
      fail(label, `only ${projectCount} projects rendered, expected at least ${c.minProjects}`);
    } else if (c.maxProjects != null || c.minProjects != null) {
      ok(label, `${projectCount} projects (within bounds)`);
    }
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

// ---- market guard --------------------------------------------------------
// A missing country on an application render used to silently fall into the
// 'general' bucket, which emits the dual-market visa line — wrong on every
// targeted CV. Both directions are pinned: the guard must fire, and it must
// NOT fire on the published general CV.
{
  const mtMod = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'cv', 'market-tail.cjs')).href);
  const mt = mtMod.default || mtMod;
  try {
    mt.resolveMarket('', { requireCountry: true });
    failed++; failures.push('market guard: no country on an application render did NOT throw');
  } catch { /* expected */ }
  if (mt.resolveMarket('', {}) !== 'general') {
    failed++; failures.push('market guard: published general CV must still resolve to general');
  }
  if (mt.resolveMarket('UK', { requireCountry: true }) !== 'uk') {
    failed++; failures.push('market guard: a supplied country must still resolve normally');
  }
}

if (failed === 0) {
  console.log("PASS — scripts/cv/build-cvs.js renders cleanly in EN and DE.");
  process.exit(0);
} else {
  console.error(`FAIL — ${failed} check(s) failed:`);
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
