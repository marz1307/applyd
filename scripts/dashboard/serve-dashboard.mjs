#!/usr/bin/env node
/**
 * serve-dashboard.mjs — Tiny static HTTP server for the career-ops dashboard
 *
 * Why: Chrome blocks file:// navigation via extensions and `<meta refresh>`
 * across origins, so the dashboard needs a real http:// URL. This serves
 * `dashboard.html` and `data/dashboard.json` from port 7300 (configurable
 * via PORT env var). Optionally watches the repo and auto-runs
 * `build-dashboard.mjs` when Notion polling-interval elapses.
 *
 * Open at:  http://localhost:7300/
 *
 * Also exposes the JSON snapshot at:
 *   http://localhost:7300/data/dashboard.json
 * so a Cowork artifact (HTML / React) embedded in a Cowork conversation
 * can `fetch()` it directly.
 *
 * Usage:
 *   node serve-dashboard.mjs                # serve, no auto-rebuild
 *   node serve-dashboard.mjs --auto-rebuild # poll Notion every 5 min and regenerate
 *   PORT=8080 node serve-dashboard.mjs
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, extname, join } from "node:path";

const PORT = parseInt(process.env.PORT || "7300", 10);
const ROOT = process.cwd();
const AUTO_REBUILD = process.argv.includes("--auto-rebuild");
const REBUILD_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".pdf":  "application/pdf",
};

function safePath(urlPath) {
  // Strip query, normalise, prevent ../ traversal
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\/+/g, "/");
  if (clean === "/" || clean === "") return resolve(ROOT, "dashboard.html");
  const candidate = resolve(ROOT, "." + clean);
  if (!candidate.startsWith(ROOT)) return null;   // attempted traversal
  return candidate;
}

const server = createServer((req, res) => {
  // CORS so a Cowork artifact (hosted on claude.ai) can fetch the JSON
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "GET") { res.writeHead(405); res.end("Method not allowed"); return; }

  const target = safePath(req.url);
  if (!target || !existsSync(target)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found: " + req.url);
    return;
  }
  const st = statSync(target);
  if (st.isDirectory()) { res.writeHead(403); res.end("Directory listing disabled"); return; }
  const type = MIME[extname(target)] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": st.size,
    "Cache-Control": "no-store",   // dashboard refreshes; don't cache
  });
  res.end(readFileSync(target));
});

server.listen(PORT, () => {
  console.log(`Serving career-ops dashboard at http://localhost:${PORT}/`);
  console.log(`  dashboard.html → http://localhost:${PORT}/dashboard.html`);
  console.log(`  JSON snapshot  → http://localhost:${PORT}/data/dashboard.json`);
  console.log(`  ROOT: ${ROOT}`);
  console.log(`  Auto-rebuild: ${AUTO_REBUILD ? "every " + (REBUILD_INTERVAL_MS / 60000) + " min" : "off (regen manually via build-dashboard.mjs)"}`);
  console.log(`\nStop with Ctrl+C.`);
});

if (AUTO_REBUILD) {
  const rebuild = () => {
    console.log(`[${new Date().toISOString()}] Rebuilding dashboard…`);
    const proc = spawn("node", ["scripts/dashboard/build-dashboard.mjs"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => out += d.toString());
    proc.on("exit", code => {
      const tail = out.trim().split("\n").slice(-5).join("\n");
      console.log(`[${new Date().toISOString()}] rebuild exit ${code}\n  ${tail.replace(/\n/g, "\n  ")}`);
    });
  };
  rebuild();
  setInterval(rebuild, REBUILD_INTERVAL_MS);
}

process.on("SIGINT", () => { console.log("\nStopping."); server.close(() => process.exit(0)); });
