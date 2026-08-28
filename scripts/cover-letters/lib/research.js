// cover-letters/lib/research.js — Stage 1: Research
//
// Fetches the JD + <=5 supporting URLs via self-hosted Firecrawl, extracts
// HIGH-CONFIDENCE concrete facts using deterministic patterns, and emits
// company_brief.json. No LLM in this stage — every fact ties to a source URL.
//
// A "concrete fact" has: specific noun + verb + scope. Vague marketing
// language ("they value data quality", "fast-growing scaleup") is rejected.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isPortalHost } = require('./portal-hosts');

const FC_URL = process.env.FIRECRAWL_API_URL || 'http://localhost:3002';
const CACHE_DIR = path.join('data', '.tmp', 'fc-cl');
const FETCH_TIMEOUT_MS = 20000;

// ── Extraction patterns for enriched JD fields ────────────────────────────
// reference_code: Referenznummer / Job-ID / Kennziffer / Ref: X / Requisition ID.
// Tolerates dash, slash, and mixed-case identifiers up to ~40 chars.
const REFERENCE_PATTERNS = [
  /\bReferenz(?:nummer|-Nr\.?|)[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
  /\bKennziffer[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
  /\bJob[- ]?ID[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
  /\bReq(?:uisition)?(?:[- ]?ID)?[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
  /\bStellen(?:ausschreibungs)?nummer[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
  /\bRef(?:erence)?\.?[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
  /\bPosting[- ]?ID[:\s#]+([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})/i,
];

// contact_name: German + English variants. Only match Capital-First names of
// 2-4 words. DEPT_NAME_RE below rejects department strings that would otherwise
// slip through.
const CONTACT_PATTERNS = [
  /(?:Ihre\s+)?Ansprechpartner(?:in)?[:\s]+((?:(?:Dr\.|Prof\.|Frau|Herr)\s+)?[A-ZÄÖÜ][a-zäöüßA-Z.\-']+(?:\s+[A-ZÄÖÜ][a-zäöüßA-Z.\-']+){1,3})/,
  /Ansprechpartner(?:in)?\s+ist[:\s]+((?:(?:Dr\.|Prof\.|Frau|Herr)\s+)?[A-ZÄÖÜ][a-zäöüßA-Z.\-']+(?:\s+[A-ZÄÖÜ][a-zäöüßA-Z.\-']+){1,3})/,
  /Bei\s+Fragen\s+(?:wenden\s+Sie\s+sich\s+an|kontaktieren\s+Sie)[:\s]+((?:(?:Dr\.|Prof\.|Frau|Herr)\s+)?[A-ZÄÖÜ][a-zäöüß.\-']+(?:\s+[A-ZÄÖÜ][a-zäöüß.\-']+){1,3})/,
  /Kontakt(?:person)?[:\s]+((?:(?:Dr\.|Prof\.|Frau|Herr)\s+)?[A-ZÄÖÜ][a-zäöüßA-Z.\-']+(?:\s+[A-ZÄÖÜ][a-zäöüßA-Z.\-']+){1,3})/,
  /Contact\s+(?:person|us|for questions)?[:\s]+((?:(?:Dr\.|Prof\.|Ms\.|Mr\.|Mrs\.)\s+)?[A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+){1,3})/i,
  /(?:For questions[,.]?\s+(?:contact|reach out to|please contact))\s+((?:(?:Dr\.|Prof\.|Ms\.|Mr\.|Mrs\.)\s+)?[A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+){1,3})/i,
  /(?:Recruiter|Hiring Manager|Your recruiter)[:\s]+((?:(?:Dr\.|Prof\.|Ms\.|Mr\.|Mrs\.)\s+)?[A-Z][a-zA-Z.\-']+(?:\s+[A-Z][a-zA-Z.\-']+){1,3})/,
];

// Reject department/team names that CONTACT_PATTERNS might match. A person's
// name never contains these tokens; matching them and greeting "Dear HR Team
// Recruiter" would be worse than the default "Dear Hiring Team".
const DEPT_NAME_RE = /\b(HR|Personal(?:abteilung)?|Recruit(?:ing|er|ment)?\s?Team|Talent Acquisition|People\s?(?:Operations|Team)|Human Resources|Hiring Team|Employer Branding|Personalwesen)\b/i;

// Two CONTACT_PATTERNS carry /i, which defeats the leading-capital requirement
// that makes a match look like a proper name. An equal-opportunities
// paragraph ("...please contact us at reasonableaccommodations@example.com")
// then parses as the contact "at reasonableaccommodations", and the letter
// opens "Dear at reasonableaccommodations,". A greeting is the first thing a
// recruiter reads, so validate the shape of every candidate rather than
// trusting the regex.
const NAME_STOPWORDS = /^(at|us|the|our|your|to|for|via|by|an?|and|or|is|if|please|contact|email|e-?mail|team|jobs?|careers?|info|hello|support|talent|apply|recruiting|noreply|no-reply)$/i;
function looksLikePersonName(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 80) return false;
  if (/[@_\d]/.test(s)) return false;                    // mailbox / handle fragments
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) return false;
  const HONORIFIC = /^(Dr\.?|Prof\.?|Frau|Herr|Ms\.?|Mr\.?|Mrs\.?)$/;
  const nameTokens = tokens.filter((t) => !HONORIFIC.test(t));
  if (nameTokens.length < 2) return false;
  for (const t of nameTokens) {
    if (NAME_STOPWORDS.test(t)) return false;
    if (!/^[A-ZÄÖÜ][\p{L}.\-']*$/u.test(t)) return false;
    if (t.length > 24) return false;
  }
  return true;
}

// Portal name derivation from job_url hostname. Composer weaves into DACH p1.
const PORTAL_MAP = [
  { re: /linkedin\.com/i,               name: 'LinkedIn' },
  { re: /xing\.com/i,                    name: 'Xing' },
  { re: /stepstone\./i,                  name: 'Stepstone' },
  { re: /indeed\./i,                     name: 'Indeed' },
  { re: /efinancialcareers\./i,          name: 'eFinancialCareers' },
  { re: /welcometothejungle\.com/i,      name: 'Welcome to the Jungle' },
  { re: /arbeitnow\.com/i,               name: 'Arbeitnow' },
  { re: /glassdoor\./i,                  name: 'Glassdoor' },
  { re: /handshake\.com|joinhandshake/i, name: 'Handshake' },
  { re: /monster\./i,                    name: 'Monster' },
  { re: /honeypot\.io/i,                 name: 'Honeypot' },
  { re: /otta\.com/i,                    name: 'Otta' },
  { re: /wellfound\.com|angel\.co/i,     name: 'Wellfound' },
  { re: /y-combinator\.com|workatastartup/i, name: 'Y Combinator Work at a Startup' },
  { re: /greenhouse\.io|boards\.greenhouse/i, name: 'Greenhouse' },
  { re: /lever\.co/i,                    name: 'Lever' },
  { re: /ashbyhq\.com|jobs\.ashbyhq/i,   name: 'Ashby' },
  { re: /workable\.com/i,                name: 'Workable' },
  { re: /bamboohr\.com/i,                name: 'BambooHR' },
  { re: /teamtailor\.com/i,              name: 'Teamtailor' },
  { re: /smartrecruiters\.com/i,         name: 'SmartRecruiters' },
  { re: /jobvite\.com/i,                 name: 'Jobvite' },
  { re: /wd\d*\.myworkdaysite\.com|workday\.com/i, name: 'Workday' },
  { re: /successfactors\.eu/i,           name: 'SuccessFactors' },
  { re: /taleo\.net/i,                   name: 'Taleo' },
];
function derivePortalName(jobUrl) {
  if (!jobUrl) return null;
  for (const p of PORTAL_MAP) if (p.re.test(jobUrl)) return p.name;
  try {
    const host = new URL(jobUrl).hostname.replace(/^www\./, '');
    return host || null;
  } catch { return null; }
}

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

// ── Company-domain resolution ─────────────────────────────────────
// The old code returned `${protocol}//${host}` for any non-ATS job URL. On a
// portal posting that is the PORTAL's origin, so every downstream guard
// correctly refused to scrape it — and the brief came back with
// company_address:null and 0–1 facts.
//
// A WRONG domain is strictly worse than none. Scraping the wrong company's
// Impressum ships their postal address in the letter as the employer's — a
// portal's own HQ address landing on four other employers is a real
// observed defect. So every tier below is either authoritative or
// name-verified, and a bare "companyname.com" guess is deliberately NOT one
// of them.
//
// Each tier returns provenance so callers can decide what to trust. Order is
// cheapest-and-most-authoritative first; all four are free (no extra network —
// they read the JD HTML already fetched).

// Hosts that are never an employer's own site even when linked from a JD.
const SOCIAL_CDN_RE = /(^|\.)(facebook|fb|twitter|x|instagram|linkedin|licdn|youtube|youtu|xing|tiktok|github|gitlab|medium|google|gstatic|googleapis|googletagmanager|doubleclick|cloudflare|akamai|amazonaws|cloudfront|w3|schema|gravatar|wordpress|wixstatic|typeform|calendly|bit|goo)\.[a-z.]+$/i;

// "Bikeleasing-Service GmbH & Co. KG" → "bikeleasingservice"
function normaliseCompanyToken(name) {
  return String(name || '')
    .replace(/\b(GmbH|AG|SE|KGaA|KG|OHG|mbH|Co|Ltd|Limited|plc|Inc|LLC|Corp|BV|NV|SA|SAS|AB|Oy|A\/S|S\.p\.A|Sp\. z o\.o)\b\.?/gi, ' ')
    .replace(/&/g, ' ')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// "https://www.example.de/karriere" → "example"
function domainLabel(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const parts = h.split('.');
    // co.uk / com.au / co.at — the label is one further left
    const sld = /^(co|com|org|net|gov|ac)$/i.test(parts[parts.length - 2] || '') ? parts[parts.length - 3] : parts[parts.length - 2];
    return String(sld || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  } catch { return ''; }
}

// Guards tiers that infer rather than read: the domain must plausibly BE the
// company. Substring either way (short brands live inside longer domains, and
// vice versa), or a 6-char prefix for truncated/abbreviated domains.
function companyMatchesDomain(companyName, url) {
  const c = normaliseCompanyToken(companyName), d = domainLabel(url);
  if (!c || !d) return false;
  if (c.includes(d) || d.includes(c)) return true;
  return c.length >= 6 && d.length >= 6 && c.slice(0, 6) === d.slice(0, 6);
}

const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.protocol}//${u.host}` : null; } catch { return null; } };
const usableEmployerOrigin = (url) => {
  const o = originOf(url);
  if (!o) return null;
  try { if (SOCIAL_CDN_RE.test(new URL(o).hostname)) return null; } catch { return null; }
  return isPortalHost(o) ? null : o;
};

// TIER 1 — JobPosting JSON-LD hiringOrganization.sameAs / .url.
// Authoritative: the portal is telling us the employer's own website, and most
// DACH/UK portals emit it.
function companyUrlFromJsonLd(jdHtml) {
  for (const m of [...String(jdHtml || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]) {
    let data; try { data = JSON.parse(m[1]); } catch { continue; }
    for (const node of (Array.isArray(data) ? data : (data['@graph'] || [data]))) {
      if (!node || !/JobPosting/i.test(String(node['@type'] || ''))) continue;
      const org = node.hiringOrganization;
      if (!org || typeof org !== 'object') continue;
      for (const cand of [org.url, ...(Array.isArray(org.sameAs) ? org.sameAs : [org.sameAs])]) {
        const o = usableEmployerOrigin(cand);
        if (o) return o;
      }
    }
  }
  return null;
}

// TIER 2 — og:url / rel=canonical, when they point off the portal. This is the
// old ATS-only branch, generalised: an ATS page carrying the employer's
// canonical is not special, portals do it too.
function companyUrlFromCanonical(jdHtml) {
  const html = String(jdHtml || '');
  const cands = [
    (html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i) || [])[1],
    (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1],
  ];
  for (const c of cands) { const o = usableEmployerOrigin(c); if (o) return o; }
  return null;
}

// TIER 3 — an outbound link in the JD body whose domain matches the company
// name. Name-verified, so a partner/agency/CDN link cannot win.
function companyUrlFromJdLinks(jdHtml, companyName) {
  if (!companyName) return null;
  for (const m of [...String(jdHtml || '').matchAll(/<a[^>]+href=["'](https?:\/\/[^"'#]+)["']/gi)].slice(0, 400)) {
    const o = usableEmployerOrigin(m[1]);
    if (o && companyMatchesDomain(companyName, o)) return o;
  }
  return null;
}

// Returns { url, source }. source ∈ jsonld | canonical | jd-link | job-host | null.
// `job-host` is the pre-existing behaviour and is only produced when the
// posting already lives on a non-portal host (a company careers page), which
// was always correct — the bug was applying it to portals too.
function resolveCompanyDomain(jobUrl, jdHtml = '', companyName = '') {
  const jsonld = companyUrlFromJsonLd(jdHtml);
  if (jsonld) return { url: jsonld, source: 'jsonld' };

  const selfHosted = usableEmployerOrigin(jobUrl);
  if (selfHosted) return { url: selfHosted, source: 'job-host' };

  const canonical = companyUrlFromCanonical(jdHtml);
  if (canonical) return { url: canonical, source: 'canonical' };

  const linked = companyUrlFromJdLinks(jdHtml, companyName);
  if (linked) return { url: linked, source: 'jd-link' };

  // Deliberately no "https://<company>.com" guess. An unverified domain that
  // resolves to someone else's site would put their address in the letter.
  return { url: null, source: null };
}

// Back-compat wrapper: existing callers expect a bare string or null.
function deriveCompanyUrl(jobUrl, jdHtml = '', companyName = '') {
  return resolveCompanyDomain(jobUrl, jdHtml, companyName).url;
}

// ── TIER 5: SERP fallback (opt-in, costs money) ───────────────────
// Tiers 1–4 resolve only a minority of portal postings; the rest are portal
// ads that never link the employer, where no free signal exists in the page.
// This asks a search engine instead.
//
// OFF BY DEFAULT. Enable with RESEARCH_SERP=1. Deliberately opt-in because it
// (a) spends Bright Data credit and (b) puts an external dependency in a
// letter path that is otherwise offline once the JD is fetched. Note the
// failure mode already seen with a suspended BD account: 200 with an EMPTY
// body, so "success" is not enough — we require a usable result.
//
// A search hit is a WEAKER signal than tiers 1–4: the top result for a
// company can be a news article, a Glassdoor page, or a competitor. It is
// therefore name-verified with the same companyMatchesDomain guard, and
// anything that fails verification is discarded rather than downgraded.
const SERP_CACHE = path.join('data', '.tmp', 'serp-domains.json');
const SERP_ENABLED = () => process.env.RESEARCH_SERP === '1';
const SERP_MAX = Number(process.env.RESEARCH_SERP_MAX || 10);
let serpSpent = 0;

function loadSerpCache() {
  try { return JSON.parse(fs.readFileSync(SERP_CACHE, 'utf8')); } catch { return {}; }
}
function saveSerpCache(c) {
  try { ensureCache(); fs.writeFileSync(SERP_CACHE, JSON.stringify(c, null, 1)); } catch {}
}

function domainsFromSerpHtml(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const o = usableEmployerOrigin(m[0].replace(/&amp;.*$/, ''));
    if (!o || seen.has(o)) continue;
    seen.add(o);
    out.push(o);
  }
  return out;
}

async function serpCompanyDomain(companyName, opts = {}) {
  const name = String(companyName || '').trim();
  if (!name) return { url: null, source: null };
  if (!SERP_ENABLED() && !opts.force) return { url: null, source: null };

  const cache = loadSerpCache();
  const key = normaliseCompanyToken(name);
  if (key && Object.prototype.hasOwnProperty.call(cache, key)) {
    const hit = cache[key];
    return { url: hit && hit.url ? hit.url : null, source: hit && hit.url ? 'serp' : null };
  }

  if (serpSpent >= SERP_MAX) return { url: null, source: null, capped: true };
  const BD_KEY = process.env.BRIGHTDATA_API_KEY;
  if (!BD_KEY) return { url: null, source: null, error: 'BRIGHTDATA_API_KEY not set' };

  const zone = process.env.BRIGHTDATA_SERP_ZONE || 'cli_unlocker';
  const q = `"${name}" official website`;
  const gurl = `https://www.google.com/search?q=${encodeURIComponent(q)}&num=20&hl=en`;
  let html = '';
  try {
    serpSpent++;
    const r = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone, url: gurl, format: 'raw' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return { url: null, source: null, error: `serp_${r.status}` };
    html = await r.text();
    // The suspended-account failure mode: 200 with nothing in it.
    if (!html || html.length < 500) return { url: null, source: null, error: 'serp_empty_body' };
  } catch (e) {
    return { url: null, source: null, error: `serp_fetch_failed: ${String(e.message || e).slice(0, 60)}` };
  }

  const verified = domainsFromSerpHtml(html).find(o => companyMatchesDomain(name, o)) || null;
  cache[key] = { url: verified, name, ts: new Date().toISOString().slice(0, 10) };
  saveSerpCache(cache);
  return verified ? { url: verified, source: 'serp' } : { url: null, source: null };
}

// ── Discover blog / careers / about URLs ──────────────────────────
// Harvest real same-origin links out of a page's HTML. Returns them in
// document order, deduped. Used to turn guessed paths into observed ones.
function harvestLinks(html, companyBase, limit = 400) {
  const out = [];
  if (!html || !companyBase) return out;
  let origin;
  try { origin = new URL(companyBase).origin; } catch { return out; }
  const seen = new Set();
  for (const m of [...String(html).matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].slice(0, limit)) {
    let abs;
    try { abs = new URL(m[1], companyBase).href; } catch { continue; }
    if (!abs.startsWith(origin)) continue;
    abs = abs.replace(/\/$/, '');
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

// Which topic (if any) a URL is about. Deliberately matches localised and
// extensioned shapes — /en/about-us.html, /de/ueber-uns, /company/about —
// because assuming a bare-path convention silently 404's on many sites.
const TOPIC_RE = {
  about: /\/(about|about-us|ueber-uns|über-uns|unternehmen|company|who-we-are|wer-wir-sind)(\.[a-z]{2,5})?($|[/?])/i,
  careers: /\/(careers?|jobs|stellen|stellenangebote|karriere|join-us|vacancies)(\.[a-z]{2,5})?($|[/?])/i,
  blog: /\/(blog|engineering|tech|techblog|news|newsroom|insights|presse|press)(\.[a-z]{2,5})?($|[/?])/i,
};
function topicOf(url) {
  for (const [topic, re] of Object.entries(TOPIC_RE)) if (re.test(url)) return topic;
  return null;
}

// Candidate supporting URLs for a company. Observed links win over guesses,
// and are returned first. Guesses remain as a fallback for the case where the
// homepage could not be fetched.
//
// The old version guessed six bare paths (/about, /blog, /careers …) and only
// supplemented them from `mainHtml` — which is the JD page, hosted on the
// ATS/portal, and therefore never contains a single link into the employer's
// own site. So in practice this was pure guesswork and silently 404'd on
// every site that localises or suffixes its URLs. `homeHtml` (the employer
// HOMEPAGE, fetched by the caller) is what actually carries the real nav.
function discoverUrls(companyBase, mainHtml = '', homeHtml = '') {
  if (!companyBase) return [];
  const base = companyBase.replace(/\/$/, '');
  const observed = [];
  const seenTopics = new Map();

  for (const url of [...harvestLinks(homeHtml, base), ...harvestLinks(mainHtml, base)]) {
    const topic = topicOf(url);
    if (!topic) continue;
    const n = seenTopics.get(topic) || 0;
    if (n >= 2) continue;
    seenTopics.set(topic, n + 1);
    observed.push(url);
  }

  // Guesses only for topics the homepage did NOT already give us a real link
  // for. Probing /about when /en/about-us.html was observed burns a slot in
  // the 6-probe budget that a different topic could use.
  const guesses = [
    `${base}/about`, `${base}/about-us`, `${base}/careers`,
    `${base}/jobs`, `${base}/blog`, `${base}/engineering`,
  ].filter(u => !seenTopics.has(topicOf(u)));
  try {
    const u = new URL(base);
    guesses.push(`https://engineering.${u.host.replace(/^www\./, '')}`);
  } catch { /* non-fatal */ }

  const merged = [];
  const seen = new Set();
  for (const url of [...observed, ...guesses]) {
    const k = url.replace(/\/$/, '');
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(url);
  }
  return merged.slice(0, 6);
}

// ── Soft-404 detection ────────────────────────────────────────────
// A guessed path that does not exist usually does NOT return an HTTP error.
// Large CMS sites serve a styled "page not found" shell with a 200, so the
// scrape "succeeds" and we hand a nav-and-footer page to the fact extractors.
// isConcrete() then rejects everything in it and the brief comes back empty,
// with nothing anywhere saying why.
const ERROR_PAGE_RE = /(^|\s)(404|error\s*404|page not found|seite nicht gefunden|page introuvable|nicht gefunden|not found)(\s|$|[.:!])/i;

function looksLikeErrorPage(markdown = '', html = '') {
  const head = String(markdown).slice(0, 3000);
  if (ERROR_PAGE_RE.test(head)) return true;
  if (/\/error\/404|\/404\.html|status_code=404/i.test(head)) return true;
  const title = (String(html).match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '';
  if (ERROR_PAGE_RE.test(title)) return true;
  return false;
}

// Second signal, for shells that carry no textual marker at all. When several
// probes against ONE host come back within a hair of the same length, they
// are the same shell rendered repeatedly — real /about, /careers and /blog
// pages differ substantially in size. Needs >= 3 samples before it will fire,
// and a tolerance tight enough that genuinely different pages never cluster.
function clusteredShellLengths(lengths, tolerance = 0.01) {
  if (!Array.isArray(lengths) || lengths.length < 3) return false;
  const valid = lengths.filter(n => Number.isFinite(n) && n > 0);
  if (valid.length < 3) return false;
  const min = Math.min(...valid), max = Math.max(...valid);
  return (max - min) / max <= tolerance;
}

// ── Fact extraction patterns ──────────────────────────────────────
const VAGUE_RE = /\b(passionate|fast-paced|fast-growing|world-class|industry-leading|cutting-edge|state-of-the-art|innovative|dynamic|exciting|values?|mission|culture|diverse|inclusive)\b/i;
const REJECT_FACT_RE = /(cookie|privacy|terms of service|all rights reserved|^skip to|^menu$|^home$|^contact$)/i;

function isConcrete(text) {
  if (!text || text.length < 12 || text.length > 300) return false;
  if (REJECT_FACT_RE.test(text)) return false;
  const hasNumber = /\b\d{3,}|\b20[12]\d|\b\$\d+|\b€\d+/.test(text);
  const hasProperNoun = /\b[A-Z][a-zA-Z]{3,}\b/.test(text);
  const hasTech = /\b(AWS|GCP|Azure|Snowflake|BigQuery|dbt|Airflow|Kafka|Spark|FastAPI|React|PostgreSQL|Python|Java|Kubernetes|Docker|Postgres|MLflow|Databricks|Looker|Tableau|Redshift|Terraform|Snowpark|MCP|LLM|API)\b/.test(text);
  if (!hasNumber && !hasProperNoun && !hasTech) return false;
  const vagueHits = (text.match(VAGUE_RE) || []).length;
  if (vagueHits >= 2) return false;
  return true;
}

function extractFromJD(md, html) {
  const out = [];
  const stackRe = /\b(Snowflake|BigQuery|Databricks|Redshift|PostgreSQL|Postgres|MySQL|MongoDB|Redis|Kafka|Airflow|Dagster|dbt|FastAPI|Django|Flask|React|Angular|Vue|Next\.js|TypeScript|Python|Java|Go|Rust|Scala|Spark|Hadoop|Kubernetes|Docker|Terraform|Looker|Tableau|Power BI|MLflow|PyTorch|TensorFlow|Snowpark|MCP|OpenAI|Anthropic|Claude|GPT)\b/gi;
  // Case-insensitive dedup with canonical casing.
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
  for (const m of (md || '').matchAll(/\b(?:our|the|building|launched|shipped)\s+([A-Z][a-zA-Z]{2,20}(?:\s+[A-Z][a-zA-Z]{2,20}){0,2})\s+(platform|product|service|team|engine|API|SDK|framework)\b/g)) {
    const fact = `The role mentions ${m[1]} ${m[2]}.`;
    if (isConcrete(fact)) out.push({ category: 'product', fact, source: 'job_url', confidence: 'high' });
    if (out.length >= 6) break;
  }
  return out;
}

function extractFromAbout(md, sourceUrl) {
  const out = [];
  const md2 = md || '';
  for (const m of md2.matchAll(/(\d{2,5}(?:,\d{3})?(?:\+)?)\s+(employees|people|engineers|customers|countries|users|markets)\b/g)) {
    const fact = `${m[1]} ${m[2]} (per about page).`;
    if (isConcrete(fact)) out.push({ category: 'company_scale', fact, source: sourceUrl, confidence: 'high' });
    if (out.length >= 3) break;
  }
  const founded = md2.match(/\b(?:founded|established)\s+in\s+(20\d{2}|19\d{2})\b/i);
  if (founded) out.push({ category: 'company_history', fact: `Founded ${founded[1]}.`, source: sourceUrl, confidence: 'high' });
  return out;
}

function extractFromBlogIndex(md, sourceUrl) {
  const out = [];
  const titles = [];
  // Site-chrome headings are NOT blog posts.
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
  for (const m of (md || '').matchAll(/\b(?:building|shipping|developing|powering)\s+([A-Z][a-zA-Z]{3,20})\b/g)) {
    if (out.length >= 4) break;
    const fact = `Careers page mentions building ${m[1]}.`;
    if (isConcrete(fact)) out.push({ category: 'product', fact, source: sourceUrl, confidence: 'high' });
  }
  return out;
}

// Parse a postal address out of page text.
//
// The old code ran three INDEPENDENT regexes across the whole document —
// first street anywhere, first "12345 City" anywhere, first UK postcode
// anywhere — and returned them as one address. On any page listing more than
// one office that silently fabricates a composite: e.g. a Dutch HQ street
// paired with a Middle East postal code and city (the real Dutch postcode is
// NL-format "5915 PJ", which the 5-digit German pattern cannot match, so the
// scan runs past it and takes another office's).
//
// An address is a BLOCK: a street line followed within a line or two by its
// postal+city. Match on proximity, stop at the next street (= next block),
// and never pair fields that were not found together.
function extractPostalAddress(text) {
  if (!text) return null;
  const lines = String(text).replace(/\r/g, '').split('\n').map(l => l.trim());
  const STREET = /\b([A-ZÄÖÜ][A-Za-zäöüß.\-]*(?:stra(?:ß|ss)e|str\.|weg|allee|platz|ring|damm|gasse|chaussee|ufer)\s+\d+[a-zA-Z]?)/;
  const DE_CITY = /\b(\d{5})[ \t]+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?:[ \t][A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+){0,2})/;
  const UK_PC = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/;
  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].match(STREET);
    if (!s) continue;
    const sameLine = lines[i].match(DE_CITY);
    if (sameLine) return { street: clean(s[1]), postal_code: sameLine[1], city: clean(sameLine[2]) };
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      if (!lines[j]) continue;
      const d = lines[j].match(DE_CITY);
      if (d) return { street: clean(s[1]), postal_code: d[1], city: clean(d[2]) };
      if (STREET.test(lines[j])) break;   // next block began; do not reach across it
    }
  }
  for (const l of lines) {
    const s = l.match(STREET);
    if (s) return { street: clean(s[1]) };
  }
  for (const l of lines) {
    const d = l.match(DE_CITY);
    if (d) return { postal_code: d[1], city: clean(d[2]) };
  }
  for (const l of lines) {
    const uk = l.match(UK_PC);
    if (uk) return { postal_code: clean(uk[1]) };
  }
  return null;
}

// ── Main research function ────────────────────────────────────────
async function research({ jobUrl, companyUrl, roleHint, appId, companyHint, jdText }) {
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
    // Enriched JD fields — composer weaves these into the DACH subject line,
    // envelope, greeting, and p1 opener. All null-safe.
    reference_code: null,
    contact_name: null,
    advert_date: null,
    source_portal: null,
    company_legal_form: null,
    // Resolved employer website + HOW it was resolved. Provenance matters:
    // jsonld/job-host/supplied are authoritative, canonical/jd-link are
    // inferred-but-name-verified.
    company_url: null,
    company_url_source: null,
  };

  // ── Address application: atomic, never field-by-field ─────────────
  // Three separate sites used to do `brief.company_X = brief.company_X || cand.X`
  // per field, so a street from one source could pair with a postal code and
  // city from another. A candidate is taken wholesale or not at all, and only
  // replaces what is there if it is strictly more complete. Fields never mix.
  const addrScore = (a) => (a && a.street ? 4 : 0) + (a && a.postal ? 2 : 0) + (a && a.city ? 1 : 0);
  function applyAddress(cand, source) {
    const score = addrScore(cand);
    if (!score) return false;
    const current = { street: brief.company_address, postal: brief.company_postal_code, city: brief.company_city };
    if (score <= addrScore(current)) return false;
    brief.company_address = cand.street || null;
    brief.company_postal_code = cand.postal || null;
    brief.company_city = cand.city || null;
    if (cand.country) brief.company_country = cand.country;
    brief.company_address_source = source;
    return true;
  }

  // 1. Obtain the JD. The caller usually already has the JD text on disk and
  // hands it over as `jdText`; the Firecrawl fetch is only the fallback path
  // now. A down localhost daemon must not kill letters whose JD text is
  // already available.
  let jd = firecrawl(jobUrl);
  const supplied = String(jdText || '').trim();
  if ((!jd || !jd.html) && supplied.length > 200) {
    jd = { markdown: supplied, html: '' };
    brief.jd_source = 'caller_supplied';
    brief.fetch_failures.push(`${jobUrl} (JD fetch failed; used caller-supplied JD text)`);
  }
  if (!jd || (!jd.html && !String(jd.markdown || '').trim())) {
    brief.fetch_failures.push(`${jobUrl} (JD fetch failed)`);
    brief.error = 'jd_fetch_failed';
    return brief;
  }

  // Extract title — try h1, then og:title, then <title>, then first markdown ##.
  const h1 = (jd.html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    // Loop-until-stable strip so nested/split tag attacks like
    // "<sc<script>ript>" fully unwind.
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
  if (brief.job_title) {
    brief.job_title = brief.job_title.replace(/\s*[\|\-—]\s*[^|\-—]+$/, '').trim();
  }
  // Garbage-title guard. A wall/cookie/challenge page title is NOT a job title.
  const GARBAGE_TITLE_RE = /sign in|log ?in|job alerts?|create alert|cookies?|consent|just a moment|attention required|access denied|quick check|verify|captcha|page not found|404|logo\b|welcome to the jungle|find your next|stellenangebote?$|^jobs?\b|^careers?\b|scheduled maintenance|maintenance\b|traumjob|xing premium|premium entdecken|seite l[aä]dt|bitte warten|internet explorer|no longer supported|daily adventures|will include/i;
  // Branding-as-title guard. An ATS host's own site branding gets picked up as
  // the "job title" ("DHL Consulting" on dhlconsulting.avature.net). The tell
  // is that it IS the host's brand label, or the employer's own name. A job
  // title is never either of those.
  const flatten = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (brief.job_title) {
    const flatTitle = flatten(brief.job_title);
    // ALL host labels, not just the first: an employer's name as a title on
    // job.example.com hides in the second label. Generic labels are dropped
    // so a title of "Jobs" is left to GARBAGE_TITLE_RE rather than matched
    // here.
    const GENERIC_LABEL = new Set(['www', 'job', 'jobs', 'career', 'careers', 'en', 'de', 'apply', 'jobboard', 'recruiting', 'avature', 'com', 'net', 'org']);
    let hostLabels = [];
    try {
      hostLabels = new URL(brief.job_url || jobUrl || '').hostname.split('.')
        .map(flatten).filter((l) => l.length > 2 && !GENERIC_LABEL.has(l));
    } catch { /* no url */ }
    const flatCompany = flatten(brief.company);
    // Prefix match on the company, not equality: the title is usually the
    // bare brand while the company carries a legal suffix.
    const isBrand = flatTitle.length > 2 && (
      hostLabels.includes(flatTitle) ||
      (flatCompany && (flatTitle === flatCompany || flatCompany.startsWith(flatTitle)))
    );
    if (isBrand) {
      brief.fetch_failures.push(`job_title rejected as site/company branding: "${brief.job_title.slice(0, 60)}"`);
      brief.job_title = null;
    }
  }
  if (brief.job_title && GARBAGE_TITLE_RE.test(brief.job_title)) {
    brief.fetch_failures.push(`job_title rejected as wall/garbage: "${brief.job_title.slice(0, 60)}"`);
    brief.job_title = null;
  }

  // Recipient address for the cover-letter DIN 5008 Anschrift. Prefer
  // schema.org JobPosting JSON-LD (jobLocation.address + hiringOrganization);
  // fall back to a German postal-line regex over the JD markdown. Best-effort.
  //
  // Also extracts datePosted, identifier (reference_code), contactPoint.name
  // (contact_name), and hiringOrganization legal form. The composer consumes
  // these to enrich the DACH subject line + envelope + p1 opener. Missing
  // fields degrade gracefully — composer skips whatever is null.
  try {
    const ld = [...(jd.html || '').matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ld) {
      let data; try { data = JSON.parse(m[1]); } catch { continue; }
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const node of nodes) {
        if (!node || !/JobPosting/i.test(String(node['@type'] || ''))) continue;
        // Multiple jobLocation entries = multiple offices. Take the most
        // complete ONE; never build a composite across them.
        const locs = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation];
        for (const loc of locs) {
          const addr = loc && loc.address;
          if (!addr || typeof addr !== 'object') continue;
          const c = addr.addressCountry;
          applyAddress({
            street: addr.streetAddress,
            postal: addr.postalCode,
            city: addr.addressLocality,
            country: (typeof c === 'object' ? (c && c.name) : c) || null,
          }, 'jsonld:jobLocation');
        }
        if (node.hiringOrganization) {
          const orgName = typeof node.hiringOrganization === 'object' ? node.hiringOrganization.name : node.hiringOrganization;
          if (!brief.company) brief.company = orgName || brief.company;
          if (!brief.company_legal_form && orgName) {
            const lf = String(orgName).match(/\b(GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|SE(?:\s*&\s*Co\.?\s*KGaA)?|KGaA|Ltd\.?|plc|Inc\.?|LLC|Corp\.?|SA|SAS|BV|AB|Oy|A\/S|N\.?V\.?|S\.p\.A\.|Sp\.\s?z\s?o\.\s?o\.)\s*$/);
            if (lf) brief.company_legal_form = lf[1];
          }
        }
        if (!brief.advert_date && node.datePosted) {
          const d = String(node.datePosted).match(/^\d{4}-\d{2}-\d{2}/);
          if (d) brief.advert_date = d[0];
        }
        if (!brief.reference_code) {
          const id = node.identifier;
          const val = id && (typeof id === 'object' ? (id.value || id.identifier) : id);
          if (val) brief.reference_code = String(val).trim().slice(0, 60);
        }
        // contactPoint.name — greet by name when the JD names a contact.
        // Reject department names ("Personalabteilung", "HR Team", …).
        if (!brief.contact_name) {
          const cp = node.contactPoint;
          const cpName = cp && (typeof cp === 'object' ? cp.name : (typeof cp === 'string' ? cp : null));
          if (cpName && !DEPT_NAME_RE.test(cpName)) brief.contact_name = String(cpName).trim().slice(0, 80);
        }
      }
    }
  } catch { /* non-fatal — address is optional */ }

  // Regex fallbacks for reference_code / contact_name / advert_date. Most JDs
  // don't ship JSON-LD; scrape the markdown for the same signals so even
  // portal-only postings get a reference number and a named contact when the
  // JD text carries one. All silent on miss — composer defaults hold.
  const jdMdForScan = jd.markdown || '';
  if (!brief.reference_code) {
    for (const re of REFERENCE_PATTERNS) {
      const m = jdMdForScan.match(re);
      if (m && m[1]) { brief.reference_code = m[1].trim().slice(0, 60); break; }
    }
    if (!brief.reference_code && jobUrl) {
      const urlMatch = jobUrl.match(/[?&](?:job_?id|ref_?id|req(?:uisition)?_?id|posting_?id|gh_jid)=([^&#]+)/i);
      if (urlMatch) brief.reference_code = decodeURIComponent(urlMatch[1]).slice(0, 60);
    }
  }
  if (!brief.contact_name) {
    for (const re of CONTACT_PATTERNS) {
      const m = jdMdForScan.match(re);
      if (m && m[1] && !DEPT_NAME_RE.test(m[1])) {
        const cand = m[1].trim().replace(/\s+/g, ' ');
        if (!looksLikePersonName(cand)) continue;
        brief.contact_name = cand.slice(0, 80);
        break;
      }
    }
  }
  if (!brief.advert_date) {
    const isoM = jdMdForScan.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (isoM) brief.advert_date = isoM[1];
  }

  brief.source_portal = derivePortalName(jobUrl);

  // Legal-form fallback: if JSON-LD didn't yield one, scan the JD text for a
  // company suffix appearing near the company name.
  if (brief.company && !brief.company_legal_form) {
    const nameEsc = brief.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lfRe = new RegExp(`${nameEsc}\\s+(GmbH(?:\\s*&\\s*Co\\.?\\s*KG)?|AG|SE(?:\\s*&\\s*Co\\.?\\s*KGaA)?|KGaA|Ltd\\.?|plc|Inc\\.?|LLC|Corp\\.?|SA|SAS|BV|AB|Oy|A/S|N\\.?V\\.?|S\\.p\\.A\\.|Sp\\.\\s?z\\s?o\\.\\s?o\\.)\\b`);
    const lfM = (jdMdForScan + ' ' + (jd.html || '')).match(lfRe);
    if (lfM) brief.company_legal_form = lfM[1];
  }

  // Fallback: a German postal line if the city is still unknown.
  // GUARD: on aggregator/portal pages this regex used to grab the PORTAL's
  // own footer Impressum. Only trust the markdown fallback on
  // company-owned domains; portals get JSON-LD or nothing.
  const PORTAL_HOST_RE = /xing\.com|stepstone\.|efinancialcareers\.|linkedin\.com|indeed\.|welcometothejungle\.com|arbeitnow\.com|glassdoor\./i;
  if (!brief.company_city && !PORTAL_HOST_RE.test(jobUrl || '')) {
    const pm = (jd.markdown || '').match(/\b(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+(?: [A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\-]+){0,2})\b/);
    // postal+city arrive as a matched PAIR from one line; apply them as a
    // unit so the city can never be swapped onto a postal code from a
    // different source.
    if (pm) applyAddress({ postal: pm[1], city: pm[2].trim() }, 'jd-markdown:postal-line');
  }

  // Derive companyUrl if not supplied. Runs AFTER the JSON-LD block above so
  // brief.company is populated — tier 3 needs the name to verify a candidate
  // domain actually belongs to the employer.
  if (!companyUrl) {
    const resolved = resolveCompanyDomain(jobUrl, jd.html, brief.company || '');
    companyUrl = resolved.url;
    brief.company_url = companyUrl;
    brief.company_url_source = resolved.source;
    // Tier 5, only when the free tiers found nothing and RESEARCH_SERP=1.
    if (!companyUrl) {
      const s = await serpCompanyDomain(brief.company || '');
      if (s.url) {
        companyUrl = s.url;
        brief.company_url = s.url;
        brief.company_url_source = 'serp';
      } else if (s.error) {
        brief.fetch_failures.push(`serp lookup failed: ${s.error}`);
      } else if (s.capped) {
        brief.fetch_failures.push(`serp lookup skipped: per-run cap of ${SERP_MAX} queries reached`);
      }
    }
    if (!companyUrl) {
      brief.fetch_failures.push(
        `company domain unresolved for "${brief.company || '?'}" — the posting is portal-hosted and carries no hiringOrganization.url/sameAs, canonical, or name-matching link. Address + supplemental facts will be empty.`
      );
    }
  } else {
    brief.company_url = companyUrl;
    brief.company_url_source = 'supplied';
  }

  // Stale-posting detector: if the JD body matches a known dead-page
  // pattern, treat the entire research as unreliable. The drafter then
  // falls back to the role-only opener.
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
    brief.job_title = null;
    brief.categories_covered = [];
    brief.categories_missing = ['product', 'tech_stack', 'engineering_blog', 'company_scale', 'company_history'];
    brief.elapsed_sec = ((Date.now() - t0) / 1000).toFixed(1);
    return brief;
  }

  // A job board is never the employer. When companyUrl still points at the
  // portal (common when the posting carries no company website), /impressum
  // returns the PORTAL's legally-required address and it lands in the letter
  // as the employer's. Skip the lookup entirely for these. Shared host list
  // in cover-letters/lib/portal-hosts.js — one definition; the envelope
  // carry-forward guard in generate.js reads the same module.
  const companyHostIsPortal = isPortalHost(companyUrl);
  if (companyHostIsPortal) {
    brief.fetch_failures.push(`impressum skipped: ${companyUrl} is a job portal, not the employer`);
  }
  // Employer HOMEPAGE, fetched once and reused. This is what makes the probes
  // below aim at real URLs instead of guessed ones — see discoverUrls().
  // Cached like every other fetch, so a re-run costs nothing.
  let homeHtml = '';
  if (companyUrl && !companyHostIsPortal) {
    const home = firecrawl(companyUrl);
    if (home && (home.html || home.markdown)) {
      if (looksLikeErrorPage(home.markdown, home.html)) {
        brief.fetch_failures.push(`${companyUrl} (homepage returned an error page — link discovery unavailable)`);
      } else {
        homeHtml = home.html || '';
      }
    } else {
      brief.fetch_failures.push(`${companyUrl} (homepage not reachable — link discovery unavailable)`);
    }
  }

  // Impressum lookup — DACH sites carry the legally-required full postal
  // address. Only when the street is still unknown and we have a company
  // domain. Real imprint/contact links off the homepage nav beat guessed
  // paths — DACH sites are legally required to link the Impressum from every
  // page, so when the homepage was fetched this almost always finds the true
  // URL. Best-effort.
  if (!brief.company_address && companyUrl && !companyHostIsPortal) {
    try {
      const host = new URL(companyUrl).host;
      const dachHost = /\.(de|at|ch)$/i.test(host);
      const dachSignal = dachHost
        || /^(DE|AT|CH|Germany|Deutschland|Austria|Österreich|Switzerland|Schweiz)$/i.test(brief.company_country || '');
      const guessPaths = dachSignal
        ? ['/impressum', '/de/impressum', '/imprint', '/legal/impressum']
        : ['/imprint', '/legal/imprint', '/contact'];
      const base = companyUrl.replace(/\/$/, '');
      const IMPRINT_RE = /\/(impressum|imprint|legal-?notice|kontakt|contact)(\.[a-z]{2,5})?($|[/?])/i;
      const observed = harvestLinks(homeHtml, base).filter(u => IMPRINT_RE.test(u)).slice(0, 3);
      const paths = [...observed, ...guessPaths.map(p => base + p)];
      for (const candidate of paths) {
        const r = firecrawl(candidate);
        if (!r || !r.markdown) continue;
        if (looksLikeErrorPage(r.markdown, r.html)) continue;
        const a = extractPostalAddress(r.markdown);
        if (a && (a.street || a.postal_code)) {
          const took = applyAddress({
            street: a.street, postal: a.postal_code, city: a.city,
            country: dachHost ? (host.endsWith('.at') ? 'Österreich' : host.endsWith('.ch') ? 'Schweiz' : 'Deutschland') : null,
          }, candidate);
          if (took) break;
        }
      }
    } catch { /* non-fatal — Impressum optional */ }
  }

  // 2. Extract from JD itself
  brief.facts.push(...extractFromJD(jd.markdown, jd.html));

  // 3. Fetch supporting URLs (sequential due to CLI; cached so re-runs are
  // fast). Same portal guard as the Impressum block above. Without it, a
  // portal-hosted companyUrl probes the PORTAL's own /blog and /about — a
  // job board's site chrome is never a company fact.
  if (companyUrl && companyHostIsPortal) {
    brief.fetch_failures.push(`supplemental research skipped: ${companyUrl} is a job portal, not the employer`);
  }
  if (companyUrl && !companyHostIsPortal) {
    const supplementalUrls = discoverUrls(companyUrl, jd.html, homeHtml);
    // Collected so a shell that carries no textual 404 marker can still be
    // caught by the length-clustering signal below.
    const fetched = [];
    for (const url of supplementalUrls.slice(0, 5)) {
      const r = firecrawl(url);
      if (!r || !r.html) { brief.fetch_failures.push(`${url} (not reachable)`); continue; }
      if (looksLikeErrorPage(r.markdown, r.html)) {
        brief.fetch_failures.push(`${url} (soft 404 — page does not exist; served an error shell with a 200)`);
        continue;
      }
      fetched.push({ url, markdown: r.markdown || '', len: (r.markdown || '').length });
    }
    // No textual marker anywhere, but every response the same size = one
    // shell rendered repeatedly. Drop the lot rather than mine nav chrome
    // for facts.
    if (fetched.length >= 3 && clusteredShellLengths(fetched.map(f => f.len))) {
      brief.fetch_failures.push(
        `${new URL(companyUrl).host} (${fetched.length} probes returned near-identical lengths — treated as an error shell, facts suppressed)`
      );
      fetched.length = 0;
    }
    for (const { url, markdown } of fetched) {
      const topic = topicOf(url);
      if (topic === 'about') brief.facts.push(...extractFromAbout(markdown, url));
      else if (topic === 'blog') brief.facts.push(...extractFromBlogIndex(markdown, url));
      else if (topic === 'careers') brief.facts.push(...extractFromCareers(markdown, url));
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

  // Persistent per-company research upsert. Whatever this row's research
  // surfaced about the company (product, tech-stack facts, sources) gets
  // merged into data/company-research/{slug}.json so a second JD for the
  // same company inherits it. Silent on failure — never blocks the research
  // pass. Dynamic import because company-research-store is ESM.
  if (brief.company) {
    upsertToCompanyStore(brief).catch(err => {
      console.error(`[research] company-store upsert failed (non-fatal): ${err.message}`);
    });
  }

  return brief;
}

// Extract vocabulary + tech_stack from the brief.facts array + JD title, then
// upsert into data/company-research/{slug}.json via cv/company-research-store.
async function upsertToCompanyStore(brief) {
  let upsertCompany;
  try {
    ({ upsertCompany } = await import('../../cv/company-research-store.mjs'));
  } catch {
    return;   // module absent (fresh clone); silent by design.
  }
  const factsByCat = {};
  for (const f of (brief.facts || [])) {
    (factsByCat[f.category] = factsByCat[f.category] || []).push(f);
  }
  const tech = (factsByCat.tech_stack || []).flatMap(f => {
    const m = String(f.claim || f.fact || '').match(/\b(dbt|Snowflake|BigQuery|Redshift|Databricks|Airflow|Dagster|Prefect|Kafka|Postgres|PostgreSQL|MySQL|MongoDB|Python|Java|Scala|Go\b|Rust|Kotlin|Kubernetes|Docker|AWS|GCP|Azure|Terraform|Looker|Tableau|Power BI|Metabase|Superset|dbt Cloud|Fivetran|Segment|Amplitude|Snowplow)\b/gi) || [];
    return m;
  });
  const productClaims = (factsByCat.product || []).slice(0, 2).map(f => f.claim || f.fact).filter(Boolean);
  const summary = productClaims.length ? productClaims.join(' ') : '';
  const vocab = [];
  if (brief.job_title) {
    const phrases = String(brief.job_title).toLowerCase().match(/\b[a-z]+(?: [a-z]+){1,2}\b/g) || [];
    for (const p of phrases) if (p.length >= 5 && !/^(the|and|for|with|our|your)\b/.test(p)) vocab.push(p);
  }
  const sources = [];
  if (brief.job_url) sources.push(brief.job_url);
  for (const f of (brief.facts || [])) if (f.source_url) sources.push(f.source_url);

  upsertCompany({
    name: brief.company,
    summary,
    vocabulary: [...new Set(vocab)].slice(0, 12),
    tech_stack: [...new Set(tech.map(t => t.trim()))].filter(Boolean),
    sources: [...new Set(sources)],
  });
}

module.exports = {
  research, firecrawl, isConcrete,
  // Exported for cover-letters/lib/research.test.js. These are the guards
  // that stop a guessed 404 path being mined for "company facts" — see the
  // soft-404 block above for why that mattered.
  looksLikeErrorPage, clusteredShellLengths, discoverUrls, harvestLinks, topicOf, extractPostalAddress,
  // Company-domain resolution. Exported for the tests that pin the tier
  // order and, critically, that a wrong-company domain can never win.
  resolveCompanyDomain, deriveCompanyUrl, companyMatchesDomain,
  normaliseCompanyToken, domainLabel,
  // Tier 5 (opt-in, network). serpCompanyDomain is a no-op returning null
  // unless RESEARCH_SERP=1, so importing it is always safe.
  serpCompanyDomain, domainsFromSerpHtml,
};
