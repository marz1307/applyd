// cover-letters/lib/research.js — Stage 1: Research
//
// Fetches the JD + ≤5 supporting URLs via self-hosted Firecrawl, extracts
// HIGH-CONFIDENCE concrete facts using deterministic patterns, and emits
// company_brief.json. No LLM in this stage — every fact ties to a source URL.
//
// A "concrete fact" has: specific noun + verb + scope. Vague marketing
// language ("they value data quality", "fast-growing scaleup") is rejected.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FC_URL = process.env.FIRECRAWL_API_URL || 'http://localhost:3002';
const CACHE_DIR = path.join('data', '.tmp', 'fc-cl');
const FETCH_TIMEOUT_MS = 20000;

function ensureCache() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}
function cacheKey(url) {
  return url.replace(/[^a-z0-9]/gi, '_').slice(-90);
}
function firecrawl(url, opts = {}) {
  ensureCache();
  const cache = path.join(CACHE_DIR, cacheKey(url) + '.json');
  if (fs.existsSync(cache) && !opts.fresh) {
    try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {}
  }
  try {
    const buf = execFileSync('firecrawl', ['scrape', url, '--wait-for', '4000', '--format', 'markdown,html'], {
      env: { ...process.env, FIRECRAWL_API_URL: FC_URL },
      timeout: FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
    const txt = buf.toString('utf8');
    fs.writeFileSync(cache, txt);
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

// ── Company URL derivation from JD URL ────────────────────────────
function deriveCompanyUrl(jobUrl, jdHtml = '') {
  try {
    const u = new URL(jobUrl);
    // ATS hosts: derive company from path / metadata, not host
    const ats = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|workday\.com|teamtailor\.com|recruitee\.com)/i;
    if (ats.test(u.host)) {
      // Try og:url or canonical from page HTML
      if (jdHtml) {
        const og = jdHtml.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i);
        if (og) {
          try { const o = new URL(og[1]); if (!ats.test(o.host)) return `${o.protocol}//${o.host}`; } catch {}
        }
      }
      // Heuristic: greenhouse.io/boards/<co>  →  https://<co>.com (best-effort guess; user can override)
      const m = u.pathname.match(/\/(?:boards|jobs)\/([a-z0-9-]+)/i);
      if (m) return `https://${m[1].toLowerCase().replace(/-/g, '')}.com`;
      return null;
    }
    return `${u.protocol}//${u.host}`;
  } catch { return null; }
}

// ── Discover blog / careers / about URLs ──────────────────────────
function discoverUrls(companyBase, mainHtml = '') {
  const candidates = new Set();
  if (companyBase) {
    candidates.add(`${companyBase}/careers`);
    candidates.add(`${companyBase}/jobs`);
    candidates.add(`${companyBase}/about`);
    candidates.add(`${companyBase}/about-us`);
    candidates.add(`${companyBase}/blog`);
    candidates.add(`${companyBase}/engineering`);
    try { const u = new URL(companyBase); candidates.add(`https://engineering.${u.host.replace(/^www\./, '')}`); } catch {}
  }
  // Pull links from main page if available
  if (mainHtml) {
    for (const m of [...mainHtml.matchAll(/<a[^>]+href="([^"]+)"/gi)].slice(0, 200)) {
      const href = m[1];
      if (/\/careers|\/jobs|\/about|\/blog|engineering/i.test(href)) {
        try {
          const abs = new URL(href, companyBase || 'https://example.com').href;
          if (companyBase && abs.startsWith(new URL(companyBase).origin)) candidates.add(abs);
        } catch {}
      }
    }
  }
  return [...candidates].slice(0, 6);
}

// ── Fact extraction patterns ──────────────────────────────────────
// Each pattern returns { category, fact, confidence } when matched.
// Rejects vague language.

const VAGUE_RE = /\b(passionate|fast-paced|fast-growing|world-class|industry-leading|cutting-edge|state-of-the-art|innovative|dynamic|exciting|values?|mission|culture|diverse|inclusive)\b/i;
const REJECT_FACT_RE = /(cookie|privacy|terms of service|all rights reserved|^skip to|^menu$|^home$|^contact$)/i;

function isConcrete(text) {
  if (!text || text.length < 12 || text.length > 300) return false;
  if (REJECT_FACT_RE.test(text)) return false;
  // Must contain a specific signal: number, proper noun (capitalized word > 3 chars), or known tech term
  const hasNumber = /\b\d{3,}|\b20[12]\d|\b\$\d+|\b€\d+/.test(text);
  const hasProperNoun = /\b[A-Z][a-zA-Z]{3,}\b/.test(text);
  const hasTech = /\b(AWS|GCP|Azure|Snowflake|BigQuery|dbt|Airflow|Kafka|Spark|FastAPI|React|PostgreSQL|Python|Java|Kubernetes|Docker|Postgres|MLflow|Databricks|Looker|Tableau|Redshift|Terraform|Snowpark|MCP|LLM|API)\b/.test(text);
  if (!hasNumber && !hasProperNoun && !hasTech) return false;
  // Penalise marketing language
  const vagueHits = (text.match(VAGUE_RE) || []).length;
  if (vagueHits >= 2) return false;
  return true;
}

function extractFromJD(md, html) {
  const out = [];
  // Tech stack mentions in JD body
  const stackRe = /\b(Snowflake|BigQuery|Databricks|Redshift|PostgreSQL|Postgres|MySQL|MongoDB|Redis|Kafka|Airflow|Dagster|dbt|FastAPI|Django|Flask|React|Angular|Vue|Next\.js|TypeScript|Python|Java|Go|Rust|Scala|Spark|Hadoop|Kubernetes|Docker|Terraform|Looker|Tableau|Power BI|MLflow|PyTorch|TensorFlow|Snowpark|MCP|OpenAI|Anthropic|Claude|GPT)\b/gi;
  // Case-insensitive dedup with canonical casing (the /i regex used to yield
  // "Python, Databricks, python, databricks" in one fact — APP-2602).
  const techHits = new Map();
  for (const m of (md || '').matchAll(stackRe)) {
    const key = m[1].toLowerCase();
    if (!techHits.has(key)) techHits.set(key, m[1]);
  }
  if (techHits.size) {
    out.push({
      category: 'tech_stack',
      fact: `The role names ${[...techHits.values()].slice(0, 10).join(', ')} in its stack.`,
      source: 'job_url',
      confidence: 'high',
    });
  }
  // Specific product/team names ("our X platform", "we use Y", "the Z team")
  for (const m of (md || '').matchAll(/\b(?:our|the|building|launched|shipped)\s+([A-Z][a-zA-Z]{2,20}(?:\s+[A-Z][a-zA-Z]{2,20}){0,2})\s+(platform|product|service|team|engine|API|SDK|framework)\b/g)) {
    const fact = `The role mentions ${m[1]} ${m[2]}.`;
    if (isConcrete(fact)) out.push({ category: 'product', fact, source: 'job_url', confidence: 'high' });
    if (out.length >= 6) break;
  }
  return out;
}

function extractFromAbout(md, sourceUrl) {
  const out = [];
  // Headcount, founding year, geography numbers
  const md2 = md || '';
  for (const m of md2.matchAll(/(\d{2,5}(?:,\d{3})?(?:\+)?)\s+(employees|people|engineers|customers|countries|users|markets)\b/g)) {
    const fact = `${m[1]} ${m[2]} (per about page).`;
    if (isConcrete(fact)) out.push({ category: 'company_scale', fact, source: sourceUrl, confidence: 'high' });
    if (out.length >= 3) break;
  }
  // Founded year
  const founded = md2.match(/\b(?:founded|established)\s+in\s+(20\d{2}|19\d{2})\b/i);
  if (founded) out.push({ category: 'company_history', fact: `Founded ${founded[1]}.`, source: sourceUrl, confidence: 'high' });
  return out;
}

function extractFromBlogIndex(md, sourceUrl) {
  const out = [];
  // Pull up to 10 post titles + dates from index. Heuristic: lines starting with # or ##
  const titles = [];
  // Site-chrome headings are NOT blog posts — "Find your next job", "About us"
  // etc. shipped as "engineering blog posts" in a real letter (APP-705).
  const CHROME_RE = /find your next|hire the right|about us|log ?in|sign ?up|cookie|contact|newsletter|privacy|subscribe|get started|join us|our (team|mission|values)|why (join|work)/i;
  for (const m of (md || '').matchAll(/^#{1,3}\s+([^\n]{8,140})$/gm)) {
    const t = m[1].replace(/[*`_]/g, '').trim();
    if (titles.includes(t)) continue;
    if (/blog|engineering|posts?$/i.test(t)) continue;
    if (CHROME_RE.test(t)) continue;
    titles.push(t);
    if (titles.length >= 8) break;
  }
  if (titles.length >= 2) {
    out.push({
      category: 'engineering_blog',
      fact: `Recent engineering/blog posts include: "${titles.slice(0, 4).join('", "')}".`,
      source: sourceUrl, confidence: 'high',
    });
  }
  return out;
}

function extractFromCareers(md, sourceUrl) {
  const out = [];
  // Often careers page mentions team size, tech stack, mission with specifics
  const stackRe = /\b(Snowflake|BigQuery|Databricks|dbt|Airflow|Kafka|Spark|FastAPI|React|Angular|PostgreSQL|Kubernetes|Docker|Terraform|MLflow|MCP)\b/gi;
  const techHits = new Map();
  for (const m of (md || '').matchAll(stackRe)) {
    const key = m[1].toLowerCase();
    if (!techHits.has(key)) techHits.set(key, m[1]);
  }
  if (techHits.size >= 3) {
    out.push({
      category: 'tech_stack',
      fact: `Careers page references stack: ${[...techHits.values()].slice(0, 8).join(', ')}.`,
      source: sourceUrl, confidence: 'high',
    });
  }
  // Product-name mentions on careers page
  for (const m of (md || '').matchAll(/\b(?:building|shipping|developing|powering)\s+([A-Z][a-zA-Z]{3,20})\b/g)) {
    if (out.length >= 4) break;
    const fact = `Careers page mentions building ${m[1]}.`;
    if (isConcrete(fact)) out.push({ category: 'product', fact, source: sourceUrl, confidence: 'high' });
  }
  return out;
}

// Parse a postal address from page text (Impressum / contact / about). Handles
// German format (street ending in -straße/-str./-weg/… + number, then 5-digit
// PLZ + city) and a UK postcode fallback. Returns {street, postal_code, city}
// or null. Best-effort — the DIN Anschrift builder degrades on any missing part.
function extractPostalAddress(text) {
  if (!text) return null;
  const t = String(text).replace(/\r/g, '');
  const out = {};
  const street = t.match(/\b([A-ZÄÖÜ][A-Za-zäöüß.\-]*(?:stra(?:ß|ss)e|str\.|weg|allee|platz|ring|damm|gasse|chaussee|ufer)\s+\d+[a-zA-Z]?)/);
  if (street) out.street = street[1].replace(/\s+/g, ' ').trim();
  const de = t.match(/\b(\d{5})[ \t]+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?:[ \t][A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+){0,2})/);
  if (de) { out.postal_code = de[1]; out.city = de[2].trim(); }
  if (!out.postal_code) {
    const uk = t.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
    if (uk) out.postal_code = uk[1].replace(/\s+/g, ' ').trim();
  }
  return (out.street || out.postal_code || out.city) ? out : null;
}

// ── Main research function ────────────────────────────────────────
async function research({ jobUrl, companyUrl, roleHint, appId, companyHint }) {
  const t0 = Date.now();
  const brief = {
    company: companyHint || null,
    job_title: null,
    job_url: jobUrl,
    role_hint: roleHint || null,
    fetched_at: new Date().toISOString(),
    facts: [],
    fetch_failures: [],
    categories_covered: [],
    categories_missing: [],
  };

  // 1. Fetch JD (mandatory)
  const jd = firecrawl(jobUrl);
  if (!jd || !jd.html) {
    brief.fetch_failures.push(`${jobUrl} (JD fetch failed)`);
    brief.error = 'jd_fetch_failed';
    return brief;
  }

  // Extract title — try h1, then og:title, then <title>, then first markdown ##
  const h1 = (jd.html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    // Loop-until-stable strip so nested/split tag attacks like
    // "<sc<script>ript>" fully unwind. Single-pass regex is
    // js/incomplete-multi-character-sanitization per CodeQL.
    let t = h1[1];
    let prev;
    do { prev = t; t = t.replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, ''); } while (t !== prev);
    brief.job_title = t.trim().slice(0, 200);
  }
  if (!brief.job_title) {
    const og = (jd.html || '').match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (og) brief.job_title = og[1].trim().slice(0, 200);
  }
  if (!brief.job_title) {
    const t = (jd.html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) brief.job_title = t[1].trim().slice(0, 200);
  }
  if (!brief.job_title) {
    const md = (jd.markdown || '').match(/^#{1,2}\s+(.+?)$/m);
    if (md) brief.job_title = md[1].trim().slice(0, 200);
  }
  // Normalise — strip "| Company" suffix often present in og:title and <title>
  if (brief.job_title) {
    brief.job_title = brief.job_title.replace(/\s*[\|\-—]\s*[^|\-—]+$/, '').trim();
  }
  // Garbage-title guard (added 2026-07-03 after APP-2602 shipped a letter whose
  // Re: line was "Sign in to set job alerts..." scraped off a LinkedIn login
  // wall). A wall/cookie/challenge page title is NOT a job title — null it so
  // the composer falls back to the caller-supplied role / Notion Position.
  const GARBAGE_TITLE_RE = /sign in|log ?in|job alerts?|create alert|cookies?|consent|just a moment|attention required|access denied|quick check|verify|captcha|page not found|404|logo\b|welcome to the jungle|find your next|stellenangebote?$|^jobs?\b|^careers?\b|scheduled maintenance|maintenance\b|traumjob|xing premium|premium entdecken|seite l[aä]dt|bitte warten|internet explorer|no longer supported|daily adventures|will include/i;
  if (brief.job_title && GARBAGE_TITLE_RE.test(brief.job_title)) {
    brief.fetch_failures.push(`job_title rejected as wall/garbage: "${brief.job_title.slice(0, 60)}"`);
    brief.job_title = null;
  }

  // Recipient address for the cover-letter DIN 5008 Anschrift. Prefer schema.org
  // JobPosting JSON-LD (jobLocation.address + hiringOrganization); fall back to a
  // German postal-line regex over the JD markdown. Best-effort — fields stay null
  // when the source has no address, and the Anschrift builder degrades gracefully.
  try {
    const ld = [...(jd.html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ld) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of nodes) {
        if (!node || !/JobPosting/i.test(String(node['@type'] || ''))) continue;
        const loc = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
        const addr = loc && loc.address;
        if (addr && typeof addr === 'object') {
          brief.company_address = brief.company_address || addr.streetAddress || null;
          brief.company_postal_code = brief.company_postal_code || addr.postalCode || null;
          brief.company_city = brief.company_city || addr.addressLocality || null;
          const c = addr.addressCountry;
          brief.company_country = brief.company_country || (typeof c === 'object' ? (c && c.name) : c) || null;
        }
        if (!brief.company && node.hiringOrganization) {
          brief.company = (typeof node.hiringOrganization === 'object' ? node.hiringOrganization.name : node.hiringOrganization) || brief.company;
        }
      }
    }
  } catch { /* non-fatal — address is optional */ }
  // Fallback: a German postal line ("… 12345 Stadt") if the city is still unknown.
  // GUARD (2026-07-03): on aggregator/portal pages this regex used to grab the
  // PORTAL's own footer Impressum — a real letter shipped addressed to Xing's
  // Hamburg office instead of the employer in Bonn (APP-1925). Only trust the
  // markdown fallback on company-owned domains; portals get JSON-LD or nothing.
  const PORTAL_HOST_RE = /xing\.com|stepstone\.|efinancialcareers\.|linkedin\.com|indeed\.|welcometothejungle\.com|arbeitnow\.com|glassdoor\./i;
  if (!brief.company_city && !PORTAL_HOST_RE.test(jobUrl || '')) {
    const pm = (jd.markdown || '').match(/\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?: [A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+){0,2})\b/);
    if (pm) { brief.company_postal_code = brief.company_postal_code || pm[1]; brief.company_city = pm[2].trim(); }
  }

  // Derive companyUrl if not supplied
  if (!companyUrl) companyUrl = deriveCompanyUrl(jobUrl, jd.html);

  // Stale-posting detector: if the JD body matches a known dead-page
  // pattern, treat the entire research as unreliable. The drafter then
  // falls back to the role-only opener instead of citing junk like
  // "Huch! Wir haben Sie verloren" (Stepstone session expiry) or
  // "Page not found" / "Position no longer available".
  const STALE_PATTERNS = [
    /huch.?\s+wir haben Sie verloren/i,
    /Stellenangebot (?:ist )?leider nicht mehr verf[üu]gbar/i,
    /page not found|404 not found|session expired|sitzung abgelaufen/i,
    /this (?:job|position|listing) is no longer/i,
    /diese (?:stelle|anzeige) ist nicht mehr/i,
    /access denied|zugriff verweigert|captcha|please verify/i,
    /please enable javascript|enable cookies/i,
  ];
  const probe = (brief.job_title || '') + ' ' + (jd.markdown || '').slice(0, 2000);
  const isStale = STALE_PATTERNS.some(re => re.test(probe));
  if (isStale) {
    brief.is_stale_posting = true;
    brief.fetch_failures.push(`${jobUrl} (stale/expired posting detected — facts suppressed)`);
    // Clear polluted title so the drafter uses ROLE_LABEL fallback
    brief.job_title = null;
    brief.categories_covered = [];
    brief.categories_missing = ['product', 'tech_stack', 'engineering_blog', 'company_scale', 'company_history'];
    brief.elapsed_sec = ((Date.now() - t0) / 1000).toFixed(1);
    return brief;
  }

  // Impressum lookup — DACH sites carry the legally-required full postal address.
  // Only when the street is still unknown and we have a company domain. Capped at
  // a few candidate paths, stops on first parseable address. Best-effort.
  if (!brief.company_address && companyUrl) {
    try {
      const host = new URL(companyUrl).host;
      const dachHost = /\.(de|at|ch)$/i.test(host);
      const dachSignal = dachHost
        || /^(DE|AT|CH|Germany|Deutschland|Austria|Österreich|Switzerland|Schweiz)$/i.test(brief.company_country || '');
      const paths = dachSignal
        ? ['/impressum', '/de/impressum', '/imprint', '/legal/impressum']
        : ['/imprint', '/legal/imprint', '/contact'];
      const base = companyUrl.replace(/\/$/, '');
      for (const p of paths) {
        const r = firecrawl(base + p);
        if (!r || !r.markdown) continue;
        const a = extractPostalAddress(r.markdown);
        if (a && (a.street || a.postal_code)) {
          brief.company_address = brief.company_address || a.street || null;
          brief.company_postal_code = brief.company_postal_code || a.postal_code || null;
          brief.company_city = brief.company_city || a.city || null;
          if (!brief.company_country && dachHost) {
            brief.company_country = host.endsWith('.at') ? 'Österreich' : host.endsWith('.ch') ? 'Schweiz' : 'Deutschland';
          }
          brief.company_address_source = base + p;
          break;
        }
      }
    } catch { /* non-fatal — Impressum optional */ }
  }

  // 2. Extract from JD itself
  brief.facts.push(...extractFromJD(jd.markdown, jd.html));

  // 3. Fetch supporting URLs in parallel (sequential due to CLI; cached so re-runs are fast)
  if (companyUrl) {
    const supplementalUrls = discoverUrls(companyUrl, jd.html);
    for (const url of supplementalUrls.slice(0, 5)) {
      const r = firecrawl(url);
      if (!r || !r.html) { brief.fetch_failures.push(`${url} (not reachable)`); continue; }
      if (/\/about/i.test(url)) brief.facts.push(...extractFromAbout(r.markdown, url));
      else if (/\/blog|\/engineering/i.test(url)) brief.facts.push(...extractFromBlogIndex(r.markdown, url));
      else if (/\/careers|\/jobs/i.test(url)) brief.facts.push(...extractFromCareers(r.markdown, url));
    }
  }

  // Dedup facts
  const seen = new Set();
  brief.facts = brief.facts.filter(f => {
    const k = f.fact.toLowerCase().slice(0, 80);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Coverage
  const cats = new Set(brief.facts.map(f => f.category));
  brief.categories_covered = [...cats];
  const allCats = ['product', 'tech_stack', 'engineering_blog', 'company_scale', 'company_history'];
  brief.categories_missing = allCats.filter(c => !cats.has(c));
  brief.elapsed_sec = ((Date.now() - t0) / 1000).toFixed(1);
  return brief;
}

module.exports = { research, firecrawl, isConcrete };
