#!/usr/bin/env node
/**
 * notion-upload-file.mjs — Upload a local file to Notion and attach it to a page property
 *
 * Solves the auto-draft "Resume file" attachment problem: Notion's MCP
 * exposes `notion-update-page` but not the file-upload flow. The REST
 * API does, via a three-step dance:
 *
 *   1. POST /v1/file_uploads           — create an upload, get {id, upload_url}
 *   2. POST {upload_url} (multipart)   — send the file bytes
 *   3. PATCH /v1/pages/{pageId}        — attach the uploaded file to a `file` property
 *
 * Auth: NOTION_TOKEN env var (same internal integration as notion-query.mjs).
 *
 * Usage:
 *   node notion-upload-file.mjs \
 *     --file output/Candidate_CV_Eraneos_2026-05-26.pdf \
 *     --page <notion-page-id> \
 *     --property "Resume"
 *
 *   Optional:
 *     --name "Candidate_CV_Eraneos.pdf"   # display name in Notion (defaults to basename)
 *     --append                          # add to existing files instead of replacing
 *     --json                            # JSON-only output for routines
 *
 * Notion file limits: 5 MB (Free plan) / 5 GB (Plus+). Our PDFs are ~300 KB.
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const FILE = arg("--file");
const PAGE = arg("--page");
const PROPERTY = arg("--property");
const NAME_OVERRIDE = arg("--name");
const APPEND = args.includes("--append");
const JSON_ONLY = args.includes("--json");

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set.");
  process.exit(5);
}
for (const [n, v] of [["--file", FILE], ["--page", PAGE], ["--property", PROPERTY]]) {
  if (!v) { console.error(`Required: ${n}`); process.exit(2); }
}
if (!existsSync(FILE)) { console.error(`File not found: ${FILE}`); process.exit(2); }

const SIZE = statSync(FILE).size;
const DISPLAY_NAME = NAME_OVERRIDE || basename(FILE);
const NOTION_VERSION = "2022-06-28";

// Heuristic content-type. Notion only really cares for image previews;
// for PDFs and txt it stores the bytes either way.
function contentType(name) {
  const ext = name.toLowerCase().split(".").pop();
  return {
    pdf: "application/pdf",
    md: "text/markdown",
    txt: "text/plain",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  }[ext] || "application/octet-stream";
}

async function step1_createUpload() {
  // Notion's file_uploads supports `single_part` (<5MB) or `multi_part`. Ours is single-part.
  const body = {
    mode: "single_part",
    filename: DISPLAY_NAME,
    content_type: contentType(DISPLAY_NAME),
  };
  const r = await fetch("https://api.notion.com/v1/file_uploads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`step 1 (create upload) ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();   // { id, upload_url, ... }
}

async function step2_sendBytes(uploadUrl) {
  // Notion expects multipart/form-data with a `file` field.
  const fileBytes = readFileSync(FILE);
  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: contentType(DISPLAY_NAME) }), DISPLAY_NAME);
  const r = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      // DO NOT set Content-Type; the fetch implementation sets a multipart boundary.
    },
    body: form,
  });
  if (!r.ok) throw new Error(`step 2 (send bytes) ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();   // { id, status: "uploaded", ... }
}

async function step3_attach(fileUploadId) {
  // First, if --append, fetch the current page to read existing files.
  let existing = [];
  if (APPEND) {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${PAGE}`, {
      headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION },
    });
    if (!pageRes.ok) throw new Error(`step 3a (fetch page) ${pageRes.status}: ${(await pageRes.text()).slice(0, 400)}`);
    const page = await pageRes.json();
    const propVal = page.properties?.[PROPERTY];
    if (propVal?.type === "files" && Array.isArray(propVal.files)) existing = propVal.files;
  }

  const fileEntry = {
    name: DISPLAY_NAME,
    type: "file_upload",
    file_upload: { id: fileUploadId },
  };
  const body = {
    properties: {
      [PROPERTY]: { files: APPEND ? [...existing, fileEntry] : [fileEntry] },
    },
  };
  const r = await fetch(`https://api.notion.com/v1/pages/${PAGE}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`step 3b (patch page) ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

async function main() {
  if (!JSON_ONLY) console.log(`Uploading ${FILE} (${(SIZE / 1024).toFixed(1)} KB) → ${PAGE}.${PROPERTY}`);
  const upload = await step1_createUpload();
  if (!JSON_ONLY) console.log(`  1/3 ✓ upload created: ${upload.id}`);
  await step2_sendBytes(upload.upload_url);
  if (!JSON_ONLY) console.log(`  2/3 ✓ bytes sent`);
  const page = await step3_attach(upload.id);
  if (!JSON_ONLY) console.log(`  3/3 ✓ attached to ${PROPERTY}`);

  const result = {
    page_id: PAGE,
    page_url: page.url,
    property: PROPERTY,
    uploaded_file: {
      id: upload.id,
      name: DISPLAY_NAME,
      size_bytes: SIZE,
      content_type: contentType(DISPLAY_NAME),
    },
    append_mode: APPEND,
  };
  if (JSON_ONLY) console.log(JSON.stringify(result, null, 2));
  else { console.log(""); console.log(`Open the page: ${page.url}`); }
}

main().catch(err => {
  console.error("ROUTINE_ABORT:", err.message);
  process.exit(1);
});
