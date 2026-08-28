// cover-letters/lib/portal-hosts.js — ONE definition of "this host is a job
// portal, not an employer".
//
// Three separate copies of this list existed by 2026-08-02 (research.js
// PORTAL_HOSTS for the Impressum skip, generate.js PORTAL_ADDRESS_SOURCE for
// the envelope carry-forward guard, and the CUTS host regexes in
// _autodraft_split_jd.mjs) and they drifted: research.js knew handshake and
// greenhouse, generate.js knew arbeitnow, neither knew what the other did.
// Every drift is a hole the "20459 Hamburg" class of defect walks through —
// a portal's own address/blog/facts shipping in a letter as the employer's.
//
// CJS on purpose: research.js and generate.js are CJS and cannot require ESM
// synchronously. metrics-core.mjs (ESM) can import this file directly.
'use strict';

// Host suffixes (matched against hostname with any leading www. stripped).
// 2026-08-09: the six ATS hosts our own scanners hit were covered, but the
// enterprise ATSs that large employers self-host on were not. Found on
// APP-4916 (DHL), whose posting lives on dhlconsulting.avature.net: research
// took the ATS host as the EMPLOYER's site and probed /about, /about-us and
// /blog on it. Those soft-404'd, which the 08-09 detector caught — but had
// Avature served a real /about or an Impressum, its own corporate copy and
// postal address would have shipped in the letter as DHL's. That is precisely
// the "20459 Hamburg" defect (XING's own HQ posted to four other employers),
// so these belong on the list whether or not a scanner ever visits them.
// Workday/iCIMS/Taleo/SuccessFactors especially: they are the default for
// exactly the large DACH and UK employers in scope.
// 2026-08-19: pinpointhq.com added when APP-5667 (CFC) was repointed off a
// bot-walled Indeed URL onto cfc.pinpointhq.com. Every OTHER host in the
// pipeline was already covered - a sweep of all Notion job_urls found exactly
// one unmatched host, careers.allianz.com, which is the employer's own domain
// and correctly not a portal. So this hole did not exist until the repoint was
// about to open it: research would have taken the Pinpoint ATS host for CFC's
// own site and probed it for facts and a postal address. Add the ATS host in
// the same change that starts pointing at it, never after.
const PORTAL_HOST_RE = /(^|\.)(xing\.com|linkedin\.com|stepstone\.[a-z.]+|indeed\.[a-z.]+|efinancialcareers\.[a-z.]+|welcometothejungle\.com|brightnetwork\.co\.uk|glassdoor\.[a-z.]+|monster\.[a-z.]+|totaljobs\.com|reed\.co\.uk|handshake\.com|joinhandshake\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|personio\.[a-z.]+|softgarden\.[a-z.]+|smartrecruiters\.com|arbeitnow\.com|civilservicejobs\.service\.gov\.uk|sponsoredjobs\.co\.uk|careerbee\.[a-z.]+|avature\.net|myworkdayjobs\.com|myworkdaysite\.com|wd\d+\.myworkdayjobs\.com|icims\.com|taleo\.net|successfactors\.(?:com|eu)|jobvite\.com|bamboohr\.com|teamtailor\.com|recruitee\.com|pinpointhq\.com|join\.com|eightfold\.ai|phenompeople\.com|oraclecloud\.com|concludis\.de|d-vinci\.de|rexx-systems\.com)$/i;

// True when the given URL (or bare host) belongs to a job portal / ATS host.
// Unparseable input returns false — the callers treat "unknown" as "not a
// portal" and their downstream extractors carry their own vagueness guards.
function isPortalHost(urlOrHost) {
  if (!urlOrHost) return false;
  let host = String(urlOrHost).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try { host = new URL(host).host; } catch { return false; }
  } else {
    host = host.replace(/[/?#].*$/, '');
  }
  return PORTAL_HOST_RE.test(host.replace(/^www\./, ''));
}

module.exports = { PORTAL_HOST_RE, isPortalHost };
