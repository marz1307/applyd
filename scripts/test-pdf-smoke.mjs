#!/usr/bin/env node
/**
 * test-pdf-smoke.mjs — End-to-end smoke test for generate-pdf-tailored.mjs
 *
 * Renders the EN and DE happy-path CV variants and asserts:
 *   1. Both PDFs were written.
 *   2. The summary JSON reports status: "ok".
 *   3. page_count === 2 (golden rule per modes/_profile.md).
 *   4. EN has photo_embedded: false, DE has photo_embedded: true.
 *
 * Exits 0 on pass, non-zero on any failure. Wire into `npm test` so the
 * 25KB template + tailoring rewrite stays under regression cover.
 *
 * Usage:
 *   node test-pdf-smoke.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const ART_DIR = "output";
const COMPANY = "PdfSmokeTest";
const DATE = new Date().toISOString().slice(0, 10);

const variants = [
  {
    label: "EN",
    args: ["--archetype", "AE", "--company", COMPANY, "--country", "DE", "--lang", "en", "--date", DATE],
    expect: {
      filenameContains: "_CV_",
      photo_embedded: false,
    },
  },
  {
    label: "DE",
    args: ["--archetype", "AE", "--company", COMPANY, "--country", "DE", "--lang", "de", "--date", DATE],
    expect: {
      filenameContains: "_Lebenslauf_",
      photo_embedded: true,
    },
  },
];

let failed = 0;
const failures = [];

function fail(label, msg) {
  failed++;
  failures.push(`[${label}] ${msg}`);
  console.error(`  ✗ ${label}: ${msg}`);
}

function pass(label, msg) {
  console.log(`  ✓ ${label}: ${msg}`);
}

console.log(`PDF smoke test — ${DATE}`);
console.log("━".repeat(60));

for (const v of variants) {
  console.log(`\n→ Variant ${v.label}: ${v.args.join(" ")}`);
  const r = spawnSync("node", ["scripts/cv/generate-pdf-tailored.mjs", ...v.args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (r.status !== 0) {
    fail(v.label, `generate-pdf-tailored.mjs exited ${r.status}. stderr: ${(r.stderr || "").slice(0, 400)}`);
    continue;
  }

  // The script emits a summary JSON block after `--- summary JSON ---`.
  const stdout = r.stdout || "";
  const marker = stdout.indexOf("--- summary JSON ---");
  if (marker < 0) {
    fail(v.label, "summary JSON marker not found in stdout");
    continue;
  }
  const jsonText = stdout.slice(marker).split("\n").slice(1).join("\n").trim();
  let summary;
  try {
    summary = JSON.parse(jsonText);
  } catch (e) {
    fail(v.label, `summary JSON unparseable: ${e.message}`);
    continue;
  }

  if (summary.status !== "ok") {
    fail(v.label, `status was ${summary.status}, expected "ok"`);
    continue;
  }
  pass(v.label, `status ok`);

  if (!summary.pdf_path || !existsSync(summary.pdf_path)) {
    fail(v.label, `pdf_path missing or file not on disk: ${summary.pdf_path}`);
    continue;
  }
  pass(v.label, `pdf exists: ${summary.pdf_path}`);

  if (!summary.pdf_path.includes(v.expect.filenameContains)) {
    fail(v.label, `pdf filename should contain "${v.expect.filenameContains}", got ${summary.pdf_path}`);
  } else {
    pass(v.label, `filename pattern matches`);
  }

  if (summary.page_count !== 2) {
    fail(v.label, `page_count was ${summary.page_count}, expected 2 (golden rule)`);
  } else {
    pass(v.label, `page_count === 2`);
  }

  if (summary.photo_embedded !== v.expect.photo_embedded) {
    fail(v.label, `photo_embedded was ${summary.photo_embedded}, expected ${v.expect.photo_embedded}`);
  } else {
    pass(v.label, `photo_embedded === ${v.expect.photo_embedded}`);
  }

  // Clean up the artifact so the test doesn't leave noise in output/.
  try {
    unlinkSync(summary.pdf_path);
    pass(v.label, `artifact cleaned up`);
  } catch (e) {
    // Non-fatal — surface but don't fail the test.
    console.warn(`  ! ${v.label}: could not clean up ${summary.pdf_path}: ${e.message}`);
  }
}

console.log("\n" + "━".repeat(60));
if (failed === 0) {
  console.log(`PASS — ${variants.length} variants verified.`);
  process.exit(0);
} else {
  console.error(`FAIL — ${failed} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
