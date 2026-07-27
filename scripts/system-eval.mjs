#!/usr/bin/env node
/**
 * system-eval.mjs — single-pass observability + debugging collector for career-ops
 *
 * Collects:
 *   1. Routine health     — last-run timestamp, exit-code, contract-pass per routine (from data/routine-logs/)
 *   2. Notion DB state    — row counts per Stage, score histogram, stale rows, sentinel coverage
 *   3. Output artifacts   — counts under output/cv-drafts/, output/cover-letters/, output/form-answers/
 *   4. Config integrity   — required env vars, profile.yml shape, key files present
 *   5. Integration reach  — Notion API, Bright Data API (cheap ping, no credits)
 *   6. Pipeline metrics   — Stage-N→Stage-N+1 conversion rates over the last 7 days
 *   7. Quality metrics    — predicted-REJECT count, recruiter-sim verdict distribution
 *
 * Modes:
 *   --quick   no network polling; just FS + logs (under 5s)
 *   --deep    polls Notion + Bright Data reachability (default; 30-90s)
 *
 * Output:
 *   --json    machine-readable JSON to stdout
 *   default   human-readable diagnostic report + SYSTEM_EVAL_CONTRACT block at end
 *
 * Usage:
 *   node system-eval.mjs                # deep + human
 *   node system-eval.mjs --quick        # quick + human
 *   node system-eval.mjs --json         # deep + JSON
 *   node system-eval.mjs --quick --json
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dirname || '.', '..');
const ARGS = new Set(process.argv.slice(2));
const QUICK = ARGS.has('--quick');
const JSON_OUT = ARGS.has('--json');

// ----- helpers -------------------------------------------------------------
const now = new Date();
const todayISO = now.toISOString();
const sevenDaysAgo = new Date(now.getTime() - 7 * 86400_000);

function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

function readFileSafe(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function listDir(p) {
  return safe(() => readdirSync(p), []);
}

function mtime(p) {
  return safe(() => statSync(p).mtime, null);
}

// ----- 1. Routine health ---------------------------------------------------

// Per-routine expected cadence. Drives holiday/weekend-aware staleness so the
// watchdog stops false-alarming on Mondays and post-bank-holiday Tuesdays, and
// so the weekly referral scout is not judged by a daily yardstick.
//   'weekday'  — fires Mon–Fri daily (should run within ~30h on a working day)
//   'weekly:N' — fires weekly on weekday N (0=Sun..6=Sat); tolerate ~8 days
//   'manual'   — Cowork-side / not Task-Scheduler-driven; never stale-flagged
const ROUTINE_CADENCE = {
  'morning-scan':        'weekday',
  'lunchtime-scan':      'weekday',
  'pace-check':          'weekday',
  'bd-bulk-scan':        'weekday',
  'auto-eval':           'weekday',
  'auto-draft':          'weekday',
  'auto-interview-prep': 'weekly:3',   // actually Wed 21:30 + Thu 09:00 (2×/wk, low-volume Stage-5+). Weekly ~8d tolerance matches the ~6-day real max gap; 'weekday' false-alarmed Mon/Tue/Fri.
  'referral-scout':      'weekday',    // 21:45 weekdays (was unmonitored)
  'bd-referral-scout':   'weekly:1',   // Mon 13:30 weekly (was unmonitored)
  'chrome-scan-visible': 'manual',     // Cowork-side, not scheduled here
};
const ROUTINES = Object.keys(ROUTINE_CADENCE);

// UK (England & Wales) bank holidays, computed — no maintained list to rot.
// Anonymous Gregorian computus for Easter; the rest are fixed dates or
// n-th-Monday rules, with the standard weekend "substitute day" bump.
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);   // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
function nthMonday(year, month, n) {          // month 0-based; n>=1
  const first = new Date(year, month, 1);
  const offset = (8 - first.getDay()) % 7;    // days until first Monday
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}
function lastMonday(year, month) {            // month 0-based
  const last = new Date(year, month + 1, 0);  // last day of month
  return new Date(year, month, last.getDate() - ((last.getDay() + 6) % 7));
}
function ymd(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function substitute(d) {                      // bump weekend fixed holidays
  const wd = d.getDay();
  if (wd === 6) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 2);
  if (wd === 0) return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return d;
}
const _holidayCache = {};
function ukHolidays(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const easter = easterSunday(year);
  const goodFriday   = new Date(year, easter.getMonth(), easter.getDate() - 2);
  const easterMonday = new Date(year, easter.getMonth(), easter.getDate() + 1);
  const set = new Set([
    ymd(substitute(new Date(year, 0, 1))),    // New Year's Day
    ymd(goodFriday),
    ymd(easterMonday),
    ymd(nthMonday(year, 4, 1)),               // Early May (first Mon May)
    ymd(lastMonday(year, 4)),                 // Spring (last Mon May)
    ymd(lastMonday(year, 7)),                 // Summer (last Mon Aug)
    ymd(substitute(new Date(year, 11, 25))),  // Christmas
    ymd(substitute(new Date(year, 11, 26))),  // Boxing Day
  ]);
  _holidayCache[year] = set;
  return set;
}
function isNonWorkingDay(d) {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return true;
  return ukHolidays(d.getFullYear()).has(ymd(d));
}

// Hours of legitimately-skipped time immediately behind `ref`: today's elapsed
// portion if today is itself non-working, plus 24h per contiguous prior
// non-working day. Normal weekday → 0; Monday → ~48h (Sat+Sun); the Tuesday
// after a bank-holiday Monday → ~72h. Added to the base grace below.
function nonRunGapHours(ref) {
  let gap = 0;
  const day = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  if (isNonWorkingDay(day)) gap += (ref - day) / 3_600_000;
  const cursor = new Date(day);
  cursor.setDate(cursor.getDate() - 1);
  while (isNonWorkingDay(cursor)) {
    gap += 24;
    cursor.setDate(cursor.getDate() - 1);
  }
  return gap;
}

// Max tolerated age (hours) before a routine is STALE, given its cadence and
// the non-working days immediately behind `ref`. null => never stale (manual).
function maxAgeHours(cadence, ref) {
  if (cadence === 'manual') return null;
  const base = cadence.startsWith('weekly') ? 24 * 8 : 30;
  return Math.round(base + nonRunGapHours(ref));
}

function routineHealth() {
  const logsDir = join(ROOT, 'data', 'routine-logs');
  const files = listDir(logsDir);
  const out = {};

  for (const r of ROUTINES) {
    const matching = files.filter((f) => f.startsWith(r + '-')).sort();
    if (matching.length === 0) {
      // Manual (Cowork-side) routines aren't scheduled here, so absence is not
      // a fault — mark MANUAL (grey, non-alerting) rather than NEVER_RUN.
      const absent = ROUTINE_CADENCE[r] === 'manual' ? 'MANUAL' : 'NEVER_RUN';
      out[r] = {
        last_run: null, age_hours: null, max_age_h: null,
        cadence: ROUTINE_CADENCE[r], status: absent, contract_pass: null,
        errors: null, session_limit: false,
      };
      continue;
    }
    const latest = matching[matching.length - 1];
    const fullPath = join(logsDir, latest);
    const content = readFileSafe(fullPath) || '';
    // Contract is "passed" if the wrapper recorded CONTRACT_VALID: True
    // (most reliable — wrapper sees the actual claude -p stream) OR
    // the routine emitted the literal --- END... --- marker.
    const wrapperOk = /CONTRACT_VALID:\s*True/i.test(content);
    const literalOk = content.includes('--- END_ROUTINE_CONTRACT ---') ||
                      content.includes('--- END SYSTEM_EVAL_CONTRACT ---');
    const sessionLimit = /session limit/i.test(content);
    const emptyOutput = content.length < 1500 && !wrapperOk && !literalOk;
    const contractPass = wrapperOk || literalOk;
    const errMatch = content.match(/^ERRORS:\s*(\d+)/m);
    const errorCount = errMatch ? parseInt(errMatch[1], 10) : null;
    const ts = mtime(fullPath);
    const ageH = ts ? (now - ts) / 3_600_000 : null;
    let status = 'OK';
    if (sessionLimit) status = 'SESSION_LIMIT';
    else if (emptyOutput) status = 'EMPTY_LOG';
    else if (!contractPass) status = 'NO_CONTRACT';
    else if (errorCount && errorCount > 0) status = 'WITH_ERRORS';
    // STALE only overrides a clean run: a NO_CONTRACT / SESSION_LIMIT last run
    // is the more important signal and must not be masked by age. Threshold is
    // cadence- and holiday-aware (see maxAgeHours), not a flat 48h.
    const maxAge = maxAgeHours(ROUTINE_CADENCE[r], now);
    if (status === 'OK' && ageH !== null && maxAge !== null && ageH > maxAge) status = 'STALE';

    out[r] = {
      last_run: ts ? ts.toISOString() : null,
      age_hours: ageH ? Math.round(ageH * 10) / 10 : null,
      max_age_h: maxAge,
      cadence: ROUTINE_CADENCE[r],
      status,
      contract_pass: contractPass,
      errors: errorCount,
      session_limit: sessionLimit,
      log: latest,
    };
  }
  return out;
}

// ----- 2. Notion DB state --------------------------------------------------
function notionState() {
  if (QUICK) return { skipped: 'quick-mode' };
  const stages = [
    '1. Discovered', '2. Triaged', '3. Drafted', '4. Applied',
    '5. Assessment/OA', '6. Phone screen', '7. Tech interview',
    '8. Onsite/Final', '9. Offer',
  ];
  const counts = {};
  let total = 0;
  for (const s of stages) {
    try {
      const out = execSync(
        `node scripts/notion/notion-query.mjs --stage "${s}" --json`,
        { cwd: ROOT, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const arr = JSON.parse(out);
      counts[s] = Array.isArray(arr) ? arr.length : 0;
      total += counts[s];
    } catch (e) {
      counts[s] = { error: String(e.message || e).slice(0, 100) };
    }
  }

  // Sentinel coverage on Stage 2/3 (proxy for auto-draft progress)
  let stage2NeedsDraft = null;
  try {
    const out = execSync(
      `node scripts/notion/notion-query.mjs --stage "2. Triaged" --sentinel-missing --json`,
      { cwd: ROOT, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    stage2NeedsDraft = JSON.parse(out).length;
  } catch (e) {
    stage2NeedsDraft = { error: String(e.message || e).slice(0, 100) };
  }

  return { counts, total, stage2_needing_draft: stage2NeedsDraft };
}

// ----- 3. Output artifacts -------------------------------------------------
function artifactCounts() {
  const dirs = {
    cv_drafts: 'output/cv-drafts',
    cover_letters: 'output/cover-letters',
    form_answers: 'output/form-answers',
    interview_prep: 'interview-prep',
  };
  const out = {};
  for (const [k, d] of Object.entries(dirs)) {
    const p = join(ROOT, d);
    if (!existsSync(p)) { out[k] = 0; continue; }
    out[k] = listDir(p).filter((e) => !e.startsWith('.')).length;
  }
  // Total disk usage of output/
  out.disk_kb = safe(() => {
    let bytes = 0;
    const walk = (dir) => {
      for (const e of listDir(dir)) {
        const fp = join(dir, e);
        const st = safe(() => statSync(fp), null);
        if (!st) continue;
        if (st.isDirectory()) walk(fp);
        else bytes += st.size;
      }
    };
    walk(join(ROOT, 'output'));
    return Math.round(bytes / 1024);
  }, 0);
  return out;
}

// ----- 4. Config integrity -------------------------------------------------
function configCheck() {
  const out = {};
  out.NOTION_TOKEN_set = !!process.env.NOTION_TOKEN;
  out.BRIGHTDATA_API_KEY_set = !!process.env.BRIGHTDATA_API_KEY;
  out.BRIGHTDATA_DATASET_TOKEN_set = !!process.env.BRIGHTDATA_DATASET_TOKEN;
  const profile = readFileSafe(join(ROOT, 'config', 'profile.yml'));
  out.profile_yml_present = !!profile;
  out.profile_yml_lines   = profile ? profile.split('\n').length : 0;
  out.profile_has_queries = !!profile && profile.includes('queries:');
  out.profile_has_score_floor = !!profile && /score_floor:\s*\d+/.test(profile);
  // Key files
  const keyFiles = [
    'routines/run-routine.ps1',
    'routines/auto-eval.md',
    'routines/auto-draft.md',
    'routines/auto-interview-prep.md',
    'modes/cv-quality-rules.md',
    'scripts/cv/generate-pdf-tailored.mjs',
    'scripts/cv/html-to-pdf.mjs',
    'scripts/notion/notion-query.mjs',
    'scripts/notion/notion-upload-file.mjs',
    'scripts/scan/cross-portal-dedup.mjs',
  ];
  out.key_files_missing = keyFiles.filter((f) => !existsSync(join(ROOT, f)));
  return out;
}

// ----- 5. Integration reachability -----------------------------------------
function reachability() {
  if (QUICK) return { skipped: 'quick-mode' };
  const out = {};
  // Notion
  try {
    const r = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}',
      '-H', `Authorization: Bearer ${process.env.NOTION_TOKEN || ''}`,
      '-H', 'Notion-Version: 2022-06-28', 'https://api.notion.com/v1/users/me'],
      { encoding: 'utf8', timeout: 8000 }
    );
    out.notion = { http: r.trim(), ok: r.trim() === '200' };
  } catch (e) { out.notion = { error: String(e.message).slice(0, 80) }; }
  // Bright Data — cheap reachability ping (does not consume credits)
  try {
    const r = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}',
      '-H', `Authorization: Bearer ${process.env.BRIGHTDATA_DATASET_TOKEN || ''}`,
      'https://api.brightdata.com/datasets/v3/list'],
      { encoding: 'utf8', timeout: 8000 }
    );
    out.brightdata = { http: r.trim(), ok: r.trim() === '200' };
  } catch (e) { out.brightdata = { error: String(e.message).slice(0, 80) }; }
  return out;
}

// ----- 6. Pipeline metrics (7-day window) ----------------------------------
function pipelineMetrics() {
  if (QUICK) return { skipped: 'quick-mode' };
  // Read recent routine logs and count writes/transitions
  const logsDir = join(ROOT, 'data', 'routine-logs');
  const recent = listDir(logsDir).filter((f) => {
    const ts = mtime(join(logsDir, f));
    return ts && ts >= sevenDaysAgo;
  });
  let writes = 0, evals = 0, drafts = 0, applies = 0;
  for (const f of recent) {
    const c = readFileSafe(join(logsDir, f)) || '';
    // Keys match what the routines actually emit (verified against
    // auto-eval.md and auto-draft.md output-contract specs):
    //   morning-scan / lunchtime-scan / bd-bulk-scan → NOTION_ROWS_WRITTEN
    //   auto-eval     → PROMOTED_TO_TRIAGED   (Stage 1 → 2 count)
    //   auto-draft    → DRAFTED               (Stage 2 → 3 count)
    //   auto-interview-prep → PACKS_GENERATED
    const w = c.match(/NOTION_ROWS_WRITTEN:\s*(\d+)/);    if (w) writes  += +w[1];
    const e = c.match(/PROMOTED_TO_TRIAGED:\s*(\d+)/);    if (e) evals   += +e[1];
    const d = c.match(/^DRAFTED:\s*(\d+)/m);              if (d) drafts  += +d[1];
    const a = c.match(/PACKS_GENERATED:\s*(\d+)/);        if (a) applies += +a[1];
  }
  return { window_days: 7, rows_written: writes, rows_evaluated: evals, drafts_produced: drafts, interview_packs: applies };
}

// ----- 7. Quality metrics --------------------------------------------------
function qualityMetrics() {
  if (QUICK) return { skipped: 'quick-mode' };
  // Greps Notion responses for known sentinels recorded by auto-draft / auto-eval.
  // Since we'd need full DB pull, we approximate from logs.
  const logsDir = join(ROOT, 'data', 'routine-logs');
  const recent = listDir(logsDir).filter((f) => {
    const ts = mtime(join(logsDir, f));
    return ts && ts >= sevenDaysAgo;
  });
  let predictedReject = 0, recruiterInvite = 0, recruiterMaybe = 0, recruiterReject = 0;
  for (const f of recent) {
    const c = readFileSafe(join(logsDir, f)) || '';
    predictedReject += (c.match(/PREDICTED_REJECT/g) || []).length;
    recruiterInvite += (c.match(/recruiter-sim[^A-Z]*INVITE/gi) || []).length;
    recruiterMaybe  += (c.match(/recruiter-sim[^A-Z]*MAYBE/gi) || []).length;
    recruiterReject += (c.match(/recruiter-sim[^A-Z]*REJECT/gi) || []).length;
  }
  return { predicted_reject: predictedReject, recruiter_invite: recruiterInvite, recruiter_maybe: recruiterMaybe, recruiter_reject: recruiterReject };
}

// ----- assemble + classify -------------------------------------------------
// ----- 8. Recent failure alerts (from wrapper auto-debug) ------------------
function recentAlerts() {
  const alertDir = join(ROOT, 'data', '.alerts');
  if (!existsSync(alertDir)) return [];
  const out = [];
  for (const f of listDir(alertDir)) {
    if (!f.endsWith('.json')) continue;
    const ts = mtime(join(alertDir, f));
    if (!ts || ts < sevenDaysAgo) continue;
    try {
      const data = JSON.parse(readFileSafe(join(alertDir, f)));
      out.push({
        file: f,
        routine: data.routine,
        failure_mode: data.failure_mode,
        attempts: data.attempts,
        suggested_fix: data.suggested_fix,
        needs_manual_attention: data.needs_manual_attention ?? true,
        when: data.timestamp_utc,
      });
    } catch {}
  }
  return out.sort((a, b) => b.when.localeCompare(a.when)).slice(0, 10);
}

// ----- 7. Pre-emptive token-expiry check ------------------------------------
// Watches ~/.claude/.credentials.json for staleness as a proxy for the
// refresh token's age. The accessToken inside cycles every few hours
// (auto-refreshed by Claude Code), bumping the file's mtime. If the
// file hasn't been touched for >25 days, the refresh token is approaching
// its typical 30-60 day lifetime and we should prompt re-auth before the
// next cascade hits.
//
// Implementation note: we read mtime + (if present) accessToken.expiresAt.
// We DO NOT read or log either token value.
function tokenStaleness() {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(credPath)) return { present: false };
  const st = safe(() => statSync(credPath), null);
  if (!st) return { present: false };
  const ageMs = now - st.mtime.getTime();
  const ageDays = ageMs / 86_400_000;
  let accessTokenExpiresInH = null;
  try {
    const raw = JSON.parse(readFileSafe(credPath) || '{}');
    const exp = raw?.claudeAiOauth?.expiresAt;
    if (typeof exp === 'number') accessTokenExpiresInH = (exp - now) / 3_600_000;
  } catch {}
  return {
    present: true,
    file_mtime: st.mtime.toISOString(),
    file_age_days: Math.round(ageDays * 10) / 10,
    access_token_expires_in_hours: accessTokenExpiresInH !== null ? Math.round(accessTokenExpiresInH * 10) / 10 : null,
    // Refresh token life is typically 30-60 days; warn at 25 (yellow) / 50 (red)
    warn_yellow: ageDays >= 25 && ageDays < 50,
    warn_red: ageDays >= 50,
  };
}

// ----- 8. Auth-cascade detector ---------------------------------------------
// Detects the failure mode observed 2026-06-02: Claude Code's OAuth token
// expired silently, causing every `claude -p`-driven routine to fail with
// HTTP 401 "Invalid authentication credentials". Pure-script routines
// (bd-bulk-scan post-BD-9) survived; everything else cascaded.
//
// Heuristic: ≥3 routines in the last 24h failed with EMPTY_LOG / NO_CONTRACT
// status AND at least one of their log files contains "401" or "Invalid
// authentication credentials". When true, emit a top-line RED with a
// concrete next step ("Run `claude auth login`").
function detectAuthCascade() {
  const logsDir = join(ROOT, 'data', 'routine-logs');
  if (!existsSync(logsDir)) return { triggered: false, evidence: [] };
  const cutoff = now - 24 * 3_600_000;
  const failing = [];
  let authMarker = null;
  for (const f of listDir(logsDir)) {
    const fullPath = join(logsDir, f);
    const ts = mtime(fullPath);
    if (!ts || ts.getTime() < cutoff) continue;
    const content = readFileSafe(fullPath) || '';
    const wrapperFailed = /CONTRACT_VALID:\s*False/i.test(content) ||
                         /ROUTINE_RETRIES_EXHAUSTED/i.test(content);
    const emptyOutput = content.length < 1500 && !content.includes('--- END_ROUTINE_CONTRACT ---');
    if (!wrapperFailed && !emptyOutput) continue;
    const has401 = /API Error:\s*401|Invalid authentication credentials/i.test(content);
    if (has401 && !authMarker) authMarker = f;
    if (wrapperFailed || emptyOutput) failing.push({ file: f, has401 });
  }
  // Cascade = 3+ failing routines AND at least one with explicit 401 marker
  const triggered = failing.length >= 3 && authMarker !== null;
  return {
    triggered,
    failing_count: failing.length,
    auth_evidence_file: authMarker,
    evidence: failing.slice(0, 8).map(f => f.file),
  };
}

const report = {
  ts_utc: todayISO,
  mode: QUICK ? 'quick' : 'deep',
  routines: routineHealth(),
  token_staleness: tokenStaleness(),
  auth_cascade: detectAuthCascade(),
  alerts_7d: recentAlerts(),
  notion: notionState(),
  artifacts: artifactCounts(),
  config: configCheck(),
  reachability: reachability(),
  pipeline_7d: pipelineMetrics(),
  quality_7d: qualityMetrics(),
};

// Triage
const green = [], yellow = [], red = [];

// Top-line: pre-emptive token staleness (refresh-token proxy)
const ts = report.token_staleness;
if (ts.present) {
  if (ts.warn_red) {
    red.push(`⚡ Claude credentials file is ${ts.file_age_days} days old (>50). Refresh token almost certainly expired. Run \`claude auth login\` BEFORE the next scheduled fire to prevent a cascade.`);
  } else if (ts.warn_yellow) {
    yellow.push(`Claude credentials file is ${ts.file_age_days} days old (>25). Refresh token approaching its 30-60 day lifetime. Consider running \`claude auth login\` proactively this week to avoid a cascade.`);
  }
}

// Top-line: auth-cascade check (the 2026-06-02 failure mode)
if (report.auth_cascade.triggered) {
  red.push(
    `⚡ AUTH CASCADE DETECTED — ${report.auth_cascade.failing_count} routines failed in last 24h with 401 / "Invalid authentication credentials" in ${report.auth_cascade.auth_evidence_file}. ` +
    `Claude Code OAuth token is likely expired. Run \`claude auth login\` to re-authenticate, then re-fire affected routines via run-routine.ps1. ` +
    `Pure-script routines (bd-bulk-scan) survive but every LLM-driven routine fails immediately. ` +
    `See data/routine-logs/${report.auth_cascade.auth_evidence_file} for the 401 evidence.`
  );
}

for (const [name, r] of Object.entries(report.routines)) {
  if (r.status === 'MANUAL') { /* Cowork-side, not scheduled here — no signal */ }
  else if (r.status === 'NEVER_RUN') yellow.push(`routine "${name}" has never run`);
  else if (r.status === 'STALE') red.push(`routine "${name}" last ran ${r.age_hours}h ago (max ${r.max_age_h}h for its ${r.cadence} cadence)`);
  else if (r.status === 'SESSION_LIMIT') yellow.push(`routine "${name}" hit Claude session limit (external, not a code issue) — will retry on next fire`);
  else if (r.status === 'EMPTY_LOG') yellow.push(`routine "${name}" last log is empty (likely manual re-run that aborted before producing output)`);
  else if (r.status === 'WITH_ERRORS') yellow.push(`routine "${name}" reported ${r.errors} error(s) in last run`);
  else if (r.status === 'NO_CONTRACT') red.push(`routine "${name}" last log has no contract block (silent failure?)`);
  else green.push(`routine "${name}" healthy`);
}
if (report.config.key_files_missing.length) red.push(`missing key files: ${report.config.key_files_missing.join(', ')}`);
if (!report.config.NOTION_TOKEN_set) red.push('NOTION_TOKEN not set in current shell');
if (!report.config.BRIGHTDATA_DATASET_TOKEN_set) red.push('BRIGHTDATA_DATASET_TOKEN not set in current shell');
if (report.reachability.notion && report.reachability.notion.ok === false) red.push(`Notion API unreachable (HTTP ${report.reachability.notion.http})`);
if (report.reachability.brightdata && report.reachability.brightdata.ok === false) red.push(`Bright Data API unreachable (HTTP ${report.reachability.brightdata.http})`);
if (report.notion.counts) {
  const s1 = report.notion.counts['1. Discovered'];
  if (typeof s1 === 'number' && s1 > 300) yellow.push(`Stage-1 backlog: ${s1} rows pending eval`);
  const s2nd = report.notion.stage2_needing_draft;
  if (typeof s2nd === 'number' && s2nd > 30) yellow.push(`${s2nd} Stage-2 rows missing draft sentinel`);
}
if (report.quality_7d.predicted_reject > 5) yellow.push(`${report.quality_7d.predicted_reject} PREDICTED_REJECT entries in last 7d — review CV/JD alignment`);
if (report.alerts_7d.length > 0) {
  const recent24 = report.alerts_7d.filter((a) => new Date(a.when) >= new Date(Date.now() - 24 * 3600_000));
  const recentAttn = recent24.filter((a) => a.needs_manual_attention);
  if (recentAttn.length > 0) red.push(`${recentAttn.length} alert(s) in last 24h need manual attention — see Recent alerts section`);
  const silent24 = recent24.length - recentAttn.length;
  if (silent24 > 0) yellow.push(`${silent24} silent alert(s) in last 24h (auto-recovering, informational)`);
}

// ----- output --------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify({ ...report, triage: { green: green.length, yellow, red } }, null, 2));
  process.exit(red.length > 0 ? 1 : 0);
}

// Human-readable
const fmtRoutine = (name, r) => {
  const yellow = new Set(['WITH_ERRORS', 'SESSION_LIMIT', 'EMPTY_LOG']);
  const grey   = new Set(['NEVER_RUN', 'MANUAL']);
  const emoji = r.status === 'OK' ? '🟢' : yellow.has(r.status) ? '🟡' : grey.has(r.status) ? '⚪' : '🔴';
  return `  ${emoji} ${name.padEnd(22)} status=${r.status.padEnd(13)} age=${r.age_hours ?? '?'}h  errors=${r.errors ?? '?'}`;
};

console.log(`\n=== career-ops system eval (${report.mode} mode) — ${todayISO} ===\n`);
console.log('## Routines');
for (const [n, r] of Object.entries(report.routines)) console.log(fmtRoutine(n, r));

console.log('\n## Notion DB stages');
if (report.notion.counts) {
  for (const [s, c] of Object.entries(report.notion.counts)) console.log(`  ${s.padEnd(20)} ${typeof c === 'number' ? c : 'ERR'}`);
  console.log(`  ${'TOTAL'.padEnd(20)} ${report.notion.total}`);
  console.log(`  Stage-2 missing draft sentinel: ${report.notion.stage2_needing_draft}`);
}

console.log('\n## Output artifacts');
for (const [k, v] of Object.entries(report.artifacts)) console.log(`  ${k.padEnd(20)} ${v}`);

console.log('\n## Config + env');
for (const [k, v] of Object.entries(report.config)) console.log(`  ${k.padEnd(28)} ${Array.isArray(v) ? `[${v.length}]` : v}`);

console.log('\n## Reachability');
if (report.reachability.notion) console.log(`  notion api    ${report.reachability.notion.ok ? '🟢' : '🔴'} ${JSON.stringify(report.reachability.notion)}`);
if (report.reachability.brightdata) console.log(`  bd api        ${report.reachability.brightdata.ok ? '🟢' : '🔴'} ${JSON.stringify(report.reachability.brightdata)}`);

console.log('\n## Pipeline (last 7 days)');
for (const [k, v] of Object.entries(report.pipeline_7d)) console.log(`  ${k.padEnd(22)} ${v}`);

console.log('\n## Quality (last 7 days)');
for (const [k, v] of Object.entries(report.quality_7d)) console.log(`  ${k.padEnd(22)} ${v}`);

console.log('\n## Recent alerts (last 7 days, auto-debug payloads)');
if (report.alerts_7d.length === 0) {
  console.log('  (none)');
} else {
  for (const a of report.alerts_7d) {
    const icon = a.needs_manual_attention ? '🔔' : '💤';
    const tag  = a.needs_manual_attention ? '' : ' [silent — auto-recovers]';
    console.log(`  ${icon} ${a.when}  ${a.routine}  mode=${a.failure_mode}  attempts=${a.attempts}${tag}`);
    console.log(`     → ${a.suggested_fix}`);
  }
}

console.log('\n## Triage');
console.log(`  🟢 ${green.length} healthy`);
for (const w of yellow) console.log(`  🟡 ${w}`);
for (const r of red)    console.log(`  🔴 ${r}`);

// Contract block
console.log('\n--- SYSTEM_EVAL_CONTRACT ---');
console.log(`ROUTINE: system-eval`);
console.log(`TIMESTAMP_UTC: ${todayISO}`);
console.log(`MODE: ${report.mode}`);
console.log(`ROUTINES_HEALTHY: ${green.length}`);
console.log(`ROUTINES_DEGRADED: ${yellow.length}`);
console.log(`ROUTINES_CRITICAL: ${red.length}`);
console.log(`NOTION_TOTAL_ROWS: ${report.notion.total ?? 'n/a'}`);
console.log(`STAGE_1_BACKLOG: ${report.notion.counts?.['1. Discovered'] ?? 'n/a'}`);
console.log(`STAGE_2_NEEDING_DRAFT: ${report.notion.stage2_needing_draft ?? 'n/a'}`);
console.log(`KEY_FILES_MISSING: ${report.config.key_files_missing.length}`);
console.log(`NOTION_API_OK: ${report.reachability.notion?.ok ?? 'n/a'}`);
console.log(`BD_API_OK: ${report.reachability.brightdata?.ok ?? 'n/a'}`);
console.log(`PIPELINE_7D_WRITES: ${report.pipeline_7d.rows_written ?? 'n/a'}`);
console.log(`PIPELINE_7D_EVALS: ${report.pipeline_7d.rows_evaluated ?? 'n/a'}`);
console.log(`PIPELINE_7D_DRAFTS: ${report.pipeline_7d.drafts_produced ?? 'n/a'}`);
console.log(`PREDICTED_REJECT_7D: ${report.quality_7d.predicted_reject ?? 'n/a'}`);
console.log(`ERRORS: ${red.length}`);
if (red.length) {
  console.log(`ERROR_DETAILS: |`);
  for (const r of red) console.log(`  ${r}`);
}
console.log('--- END SYSTEM_EVAL_CONTRACT ---');

process.exit(red.length > 0 ? 1 : 0);
