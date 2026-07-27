#!/usr/bin/env node
/**
 * cross-portal-dedup.mjs — De-duplicate job ads across portal scrape results
 *
 * Input shape (stdin OR --in <path>): JSON object keyed by portal name,
 * each value an array of ads:
 *   {
 *     "Xing":     [{ company, title, location, url, ... }, ...],
 *     "LinkedIn": [...],
 *     "Stepstone":[...],
 *     ...
 *   }
 *
 * Dedup signals, in confidence order (higher signals win):
 *   1. Exact `url` match
 *   2. Canonical url (strip query string + fragment + trailing slash)
 *   3. Company + title fuzzy match (lowercased, whitespace-collapsed,
 *      strip "(m/w/d)", "(all genders)", emoji, location parens)
 *
 * Portal preference (which copy of a duplicate we keep): determined by
 * portal_preference (default order below; override via --prefs path to
 * config/profile.yml apply.channel_preference for a specific segment).
 *
 * Output:
 *   {
 *     "kept": { portal: [ads...], ... },           // dedup'd
 *     "dropped": [{ ad, dropped_in_favor_of: { portal, url } }, ...],
 *     "replacements_needed": { portal: N, ... },   // per-portal shortfall vs target
 *     "stats": {
 *       "total_in": N, "total_kept": N, "total_dropped": N,
 *       "by_portal_in": { portal: N }, "by_portal_kept": { portal: N }
 *     }
 *   }
 *
 * Usage:
 *   cat scrape-results.json | node cross-portal-dedup.mjs --target 30 --json
 *   node cross-portal-dedup.mjs --in results.json --target 30 --json
 *
 * The --target flag (default 30) is what each portal is expected to
 * contribute AFTER dedup. If a portal loses N rows to dedup with
 * other portals, `replacements_needed[portal] = N`, signalling that
 * a follow-up scrape of just that portal should pull N more.
 */

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const IN_PATH = arg("--in");
const TARGET = parseInt(arg("--target") ?? "30", 10);
const JSON_ONLY = args.includes("--json");

// Default portal preference: which copy to keep when the same job
// appears on multiple portals. Higher = preferred. Reflects
// "DACH-tech-startup" channel preference from config/profile.yml.
const DEFAULT_PREFERENCE = [
  "LinkedIn",
  "Company site",
  "Xing",
  "Welcome to the Jungle",
  "Stepstone",
  "Handshake",
  "Indeed",
  "eFinancialCareers",
  "Greenhouse",
  "Lever",
  "Other",
];

function readInput() {
  if (IN_PATH) return readFileSync(IN_PATH, "utf8");
  // stdin
  return readFileSync(0, "utf8");
}

// ── normalisation helpers ───────────────────────────────────────────
function canonicalUrl(u) {
  if (!u || typeof u !== "string") return "";
  // Job id lives in the query for some portals (Indeed viewjob?jk=…, Civil
  // Service jobs.cgi?jcode=…) — keep it or distinct vacancies collapse.
  const idMatch = u.match(/[?&](jcode|jk)=([A-Za-z0-9]+)/i);
  const idSuffix = idMatch ? `?${idMatch[1].toLowerCase()}=${idMatch[2].toLowerCase()}` : "";
  try {
    const parsed = new URL(u);
    parsed.search = "";
    parsed.hash = "";
    let pathname = parsed.pathname.replace(/\/+$/, "");
    // Stepstone, Xing append IDs; LinkedIn jobs have /view/{id}
    return `${parsed.protocol}//${parsed.host}${pathname}`.toLowerCase() + idSuffix;
  } catch {
    return u.toLowerCase().split("?")[0].split("#")[0].replace(/\/+$/, "") + idSuffix;
  }
}

function normTitle(s) {
  if (!s) return "";
  return s.toLowerCase()
    .replace(/\([^)]*\)/g, " ")            // strip parens content: (m/w/d), (Berlin), (all genders)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ") // strip emoji
    .replace(/\b(m\/?w\/?d|all genders|gn)\b/g, " ") // safety net for non-paren'd forms
    .replace(/[^\p{L}\p{N}\s]/gu, " ")     // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function normCompany(s) {
  if (!s) return "";
  return s.toLowerCase()
    .replace(/\b(gmbh|ag|se|kg|ohg|bv|ltd|inc|llc|plc|& co|co\.|sa|spa|nv)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fuzzyKey(ad) {
  return `${normCompany(ad.company)}::${normTitle(ad.title)}`;
}

// ── main dedup ──────────────────────────────────────────────────────
function dedup(input, preference = DEFAULT_PREFERENCE) {
  // Flatten to a single list, keeping the portal label.
  const all = [];
  const byPortalIn = {};
  for (const [portal, ads] of Object.entries(input)) {
    if (!Array.isArray(ads)) continue;
    byPortalIn[portal] = ads.length;
    for (const ad of ads) {
      all.push({ ...ad, _portal: portal });
    }
  }

  // Build preference index (higher number = more preferred).
  const prefRank = Object.fromEntries(preference.map((p, i) => [p, preference.length - i]));
  const rankOf = (portal) => prefRank[portal] ?? -1;

  // Index by exact URL, canonical URL, and fuzzy key. For each
  // dedup-bucket we keep the highest-ranked portal's copy.
  const exactUrl = new Map();
  const canonUrl = new Map();
  const fuzzy = new Map();

  const kept = [];
  const dropped = [];

  function decideKeeper(existingAd, newAd) {
    const er = rankOf(existingAd._portal);
    const nr = rankOf(newAd._portal);
    return nr > er ? newAd : existingAd;
  }

  for (const ad of all) {
    const eu = (ad.url || "").toLowerCase().trim();
    const cu = canonicalUrl(ad.url);
    const fu = fuzzyKey(ad);

    const matchExact = eu && exactUrl.get(eu);
    const matchCanon = cu && canonUrl.get(cu);
    const matchFuzzy = fu && fu !== "::" && fuzzy.get(fu);
    const existing = matchExact || matchCanon || matchFuzzy;

    if (existing) {
      const winner = decideKeeper(existing, ad);
      const loser  = winner === existing ? ad : existing;
      dropped.push({
        ad: { company: loser.company, title: loser.title, url: loser.url, portal: loser._portal },
        dropped_in_favor_of: { portal: winner._portal, url: winner.url },
      });
      if (winner !== existing) {
        // Replace the kept entry with the new winner.
        const idx = kept.indexOf(existing);
        if (idx >= 0) kept.splice(idx, 1, winner);
        // Rebuild indexes for the winner
        if (eu) exactUrl.set(eu, winner);
        if (cu) canonUrl.set(cu, winner);
        if (fu && fu !== "::") fuzzy.set(fu, winner);
      }
      continue;
    }

    kept.push(ad);
    if (eu) exactUrl.set(eu, ad);
    if (cu) canonUrl.set(cu, ad);
    if (fu && fu !== "::") fuzzy.set(fu, ad);
  }

  // Re-group kept by portal.
  const byPortalKept = {};
  const keptOut = {};
  for (const ad of kept) {
    const p = ad._portal;
    keptOut[p] = keptOut[p] || [];
    const { _portal, ...clean } = ad;
    keptOut[p].push(clean);
    byPortalKept[p] = (byPortalKept[p] || 0) + 1;
  }

  // Replacements needed = target − kept per portal (floor 0).
  const replacementsNeeded = {};
  for (const portal of Object.keys(input)) {
    const haveKept = byPortalKept[portal] || 0;
    replacementsNeeded[portal] = Math.max(0, TARGET - haveKept);
  }

  return {
    kept: keptOut,
    dropped,
    replacements_needed: replacementsNeeded,
    stats: {
      target_per_portal: TARGET,
      total_in: all.length,
      total_kept: kept.length,
      total_dropped: dropped.length,
      by_portal_in: byPortalIn,
      by_portal_kept: byPortalKept,
    },
  };
}

// ── self-test mode ──────────────────────────────────────────────────
if (args.includes("--self-test")) {
  const fixture = {
    "Xing": [
      { company: "Eraneos GmbH", title: "Analytics Engineer (m/w/d)", location: "Hamburg", url: "https://www.xing.com/jobs/hamburg-analytics-engineer-all-genders-154397540?ijt=jb_70" },
      { company: "SAP SE", title: "Data Engineer 🚀", location: "Berlin", url: "https://www.xing.com/jobs/sap-data-engineer-9999" },
    ],
    "LinkedIn": [
      // Same Eraneos job as on Xing — should dedup. LinkedIn wins (higher rank).
      { company: "Eraneos", title: "Analytics Engineer", location: "Hamburg, Germany", url: "https://www.linkedin.com/jobs/view/eraneos-ae-hamburg-1234567" },
      { company: "Trade Republic", title: "Analytics Engineer (Paris)", location: "Paris", url: "https://www.linkedin.com/jobs/view/trade-republic-ae-paris-9876" },
    ],
    "Stepstone": [
      // Same SAP job as on Xing — should dedup. Xing wins (higher rank than Stepstone).
      { company: "SAP", title: "Data Engineer", location: "Berlin", url: "https://www.stepstone.de/stellenangebote--sap-data-engineer-9999.html" },
    ],
  };
  const result = dedup(fixture);
  console.log("--- SELF TEST ---");
  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(`Eraneos: kept under "${Object.keys(result.kept).find(p => result.kept[p].some(a => a.company.toLowerCase().includes("eraneos")))}" → should be LinkedIn`);
  console.log(`SAP: kept under "${Object.keys(result.kept).find(p => result.kept[p].some(a => a.company.toLowerCase().includes("sap")))}" → should be Xing (higher than Stepstone)`);
  console.log(`Replacements needed: Xing=${result.replacements_needed.Xing}, LinkedIn=${result.replacements_needed.LinkedIn}, Stepstone=${result.replacements_needed.Stepstone}`);
  process.exit(0);
}

// ── main ────────────────────────────────────────────────────────────
try {
  const raw = readInput();
  const input = JSON.parse(raw);
  const result = dedup(input);
  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const s = result.stats;
    console.log(`Cross-portal dedup — target ${s.target_per_portal}/portal`);
    console.log(`  in:      ${s.total_in} ads across ${Object.keys(s.by_portal_in).length} portals`);
    console.log(`  kept:    ${s.total_kept}`);
    console.log(`  dropped: ${s.total_dropped}`);
    console.log(``);
    console.log(`By portal (in → kept, replacements needed):`);
    for (const p of Object.keys(s.by_portal_in)) {
      console.log(`  ${p.padEnd(25)} ${(s.by_portal_in[p] || 0).toString().padStart(3)} → ${(s.by_portal_kept[p] || 0).toString().padStart(3)}   (+${result.replacements_needed[p]} needed)`);
    }
  }
} catch (err) {
  console.error("ROUTINE_ABORT:", err.message);
  process.exit(1);
}
