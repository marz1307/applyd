# run-routine.ps1
#
# ASCII-ONLY STRING DISCIPLINE: keep this file free of em dashes (U+2014)
# and other non-ASCII bytes inside double-quoted "..." strings. Windows
# PowerShell 5.1 mis-parses the UTF-8 bytes of an em dash as a string
# terminator, which turns a valid file into three cryptic "Unexpected
# token" / "Missing statement block" errors far away from the real site.
# Use plain "-" (or "--") in strings. Comments are safe but keep them
# uniform anyway so a future refactor cannot silently move an em dash
# from a comment into a string.
#
# Wrapper invoked by Windows Task Scheduler to run a applyd routine
# under a headless agent CLI and capture its output to data/routine-logs/.
#
# AGENT-CLI DISPATCH (v2.3.0):
#   - Reads $env:CAREER_OPS_AGENT_CLI (default: "claude") to pick an
#     adapter under routines/adapters/${CLI}.ps1.
#   - The adapter owns the CLI-specific invocation (flags, auth, MCP);
#     the wrapper keeps log-capture, contract validation, retries,
#     dashboard rebuild, and Windows Task Scheduler integration.
#   - claude.ps1 is the reference adapter. codex.ps1 and gemini.ps1
#     ship as best-effort stubs - verify locally before scheduling.
#
# Hardened wrapper (post-2026-05-25 critique):
#   - Per-routine MCP allowlists (least privilege; M4)
#   - Hard wall-clock timeout per routine (C2; kills runaway CLI)
#   - Output-contract validation - CLI exit code is NOT trusted; log
#     MUST contain a `--- ROUTINE_CONTRACT ---` block or wrapper exits 4 (C1)
#   - BRIGHTDATA_API_KEY preflight for routines that need it (H4)
#   - Wrapper-trace lives outside the gitignored data/routine-logs/ so the
#     forensic record survives a `rm -rf data/routine-logs/` (L2)
#
# Usage (from Task Scheduler /TR):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo-root>\routines\run-routine.ps1" -Routine morning-scan
#
# Routine names (must match a file under routines/<name>.md):
#   - morning-scan     (07:00, scan.mjs against ATS APIs)
#   - lunchtime-scan   (12:30, Bright Data SERP - requires BRIGHTDATA_API_KEY)
#   - bd-bulk-scan     (05:55/13:00, Bright Data Dataset Scraper - requires BRIGHTDATA_DATASET_TOKEN)
#   - pace-check       (17:00, pace-alarm.mjs)
#   - auto-eval        (21:00, oferta evaluation for Stage 1 → 2)
#   - auto-draft       (21:30, CV PDF + cover letter for Stage 2 → 3)

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("morning-scan", "lunchtime-scan", "pace-check", "auto-eval", "auto-draft", "bd-bulk-scan", "auto-interview-prep", "system-eval", "referral-scout", "bd-referral-scout")]
    [string]$Routine,

    # Set by drain-routine.ps1 when firing a routine inside a drain loop, so the
    # dashboard is rebuilt+published ONCE at end-of-drain instead of after every
    # iteration. Single fires (all other tasks) leave this off and rebuild per run.
    [switch]$SkipDashboard
)

$ErrorActionPreference = "Continue"

# ── Paths ────────────────────────────────────────────────────────────
$repoRoot   = $PSScriptRoot | Split-Path
# Which agent CLI drives this routine. Default is "claude"; override
# by exporting CAREER_OPS_AGENT_CLI=codex|gemini|... in the environment
# before invocation. The named adapter must exist at
# routines/adapters/<cli>.ps1.
$agentCli   = if (-not [string]::IsNullOrEmpty($env:CAREER_OPS_AGENT_CLI)) {
                  $env:CAREER_OPS_AGENT_CLI.ToLower()
              } else { "claude" }
$adapterPath = Join-Path $repoRoot "routines\adapters\$agentCli.ps1"
$promptPath = Join-Path $repoRoot "routines\$Routine.md"
$logDir     = Join-Path $repoRoot "data\routine-logs"
$traceDir   = Join-Path $repoRoot "data"  # NOT gitignored at this level
$tracePath  = Join-Path $traceDir "wrapper-trace.log"
$timestamp  = Get-Date -Format "yyyy-MM-dd_HHmm"
$logPath    = Join-Path $logDir "$Routine-$timestamp.log"

# ── Wrapper-trace (proves the wrapper actually launched, regardless of
# ── what happens next; lives outside the gitignored log dir so it can be
# ── audited even if logs are nuked) ─────────────────────────────────
try {
    if (-not (Test-Path $traceDir)) { New-Item -ItemType Directory -Path $traceDir -Force | Out-Null }
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tINVOKED routine=$Routine pid=$PID cwd=$PWD user=$env:USERNAME" |
        Out-File -FilePath $tracePath -Append -Encoding UTF8
} catch {}

# ── Per-routine policy ──────────────────────────────────────────────
# Each routine declares: allowed tools (least-privilege), required env
# vars (preflight), and a wall-clock timeout. morning-scan and pace-check
# do NOT get Bright Data - only lunchtime-scan needs it.
$policy = @{
    # MODEL TIER (2026-07-06): the mechanical routines below (run a deterministic
    # node script, dedup/count rows, post at most one Notion comment, emit a
    # contract) do no deep reasoning, so they run on Sonnet, not the default Opus
    # subscription tier. The judgment-heavy routines (auto-eval scoring, auto-draft
    # CV/cover-letter writing, auto-interview-prep) deliberately OMIT Model and stay
    # on the default Opus tier. Still subscription-billed either way (API key stripped).
    "morning-scan"   = @{
        AllowedTools = "Bash,Read,Write,Edit,Glob,Grep,mcp__claude_ai_Notion__*,mcp__notion__*"
        RequiredEnv  = @()
        Model        = "sonnet"
        TimeoutSec   = 1200  # 20 min - scanner hits 30 portals
    }
    "lunchtime-scan" = @{
        AllowedTools = "Bash,Read,Write,Edit,Glob,Grep,mcp__claude_ai_Notion__*,mcp__notion__*,mcp__brightdata__*"
        RequiredEnv  = @("BRIGHTDATA_API_KEY")
        Model        = "sonnet"
        TimeoutSec   = 1800  # 30 min - Bright Data scrapes are slower
    }
    "pace-check"     = @{
        AllowedTools = "Bash,Read,Write,Edit,Glob,Grep,mcp__claude_ai_Notion__*,mcp__notion__*"
        RequiredEnv  = @()
        Model        = "sonnet"
        TimeoutSec   = 300   # 5 min - single script + one Notion comment
    }
    "auto-eval"      = @{
        # Eval needs: full queue enumeration via notion-query.mjs (NOTION_TOKEN),
        # JD fetch (WebFetch on Job URL, Bright Data fallback for bot-walls),
        # Notion writes for Match score / Stage transition.
        AllowedTools = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,mcp__claude_ai_Notion__*,mcp__notion__*,mcp__brightdata__*"
        RequiredEnv  = @("NOTION_TOKEN")
        TimeoutSec   = 3600  # 60 min - up to 50 evaluations × ~40-60s each
    }
    "auto-draft"     = @{
        # Draft needs: queue enumeration (NOTION_TOKEN), resume-writer/
        # humanizer/tech-cv-review skills, PDF generation via Bash + node,
        # Notion writes for Stage transition. No web fetching needed.
        AllowedTools = "Bash,Read,Write,Edit,Glob,Grep,mcp__claude_ai_Notion__*,mcp__notion__*"
        RequiredEnv  = @("NOTION_TOKEN")
        TimeoutSec   = 3600  # 60 min - PDF gen + LLM CL drafting × up to 20 rows
    }
    "auto-interview-prep" = @{
        # Generates the 6-doc interview prep pack for Stage 4+ rows.
        # Reads Notion, WebFetches company pages, Bright Data fallback
        # for blocked domains. Notion upload via notion-upload-file.mjs.
        AllowedTools = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,mcp__claude_ai_Notion__*,mcp__notion__*,mcp__brightdata__*"
        RequiredEnv  = @("NOTION_TOKEN")
        TimeoutSec   = 3600  # 60 min - up to 10 packs × ~5 min each (LLM-heavy)
    }
    "system-eval" = @{
        # Read-only observability + debugging. Hits Notion only
        # (no credits, no writes). No external apps.
        AllowedTools = "Bash,Read,Grep,Glob"
        RequiredEnv  = @("NOTION_TOKEN")
        TimeoutSec   = 300  # 5 min - deep mode ~90s; quick mode <5s
    }
    "bd-bulk-scan" = @{
        # Bright Data bulk pull. Sole high-volume engine post-Apify-retirement
        # (2026-05-28). Direct scrape (BD dataset): Stepstone, eFC, sponsoredjobs.
        # Firecrawl: Xing, CareerBee. SERP-zone discovery (BRIGHTDATA_API_KEY):
        # LinkedIn, WTTJ, Indeed, Civil Service Jobs. LinkedIn/WTTJ then enrich
        # via the dataset scraper. Per-URL cost; ~400 URLs/run worst case.
        #
        # PURE-SCRIPT routine (2026-05-28): the .mjs is deterministic and
        # prints its own ROUTINE_CONTRACT block, so we bypass `claude -p`
        # to avoid the LLM paraphrasing the contract and tripping
        # validation. Script is invoked directly via `node` - no MCP, no
        # AllowedTools needed.
        Script       = "scripts/scan/bd-bulk-scan.mjs"
        AllowedTools = ""
        # BRIGHTDATA_API_KEY added 2026-07-06: the SERP-discovery portals
        # (LinkedIn/WTTJ/Indeed/CSJobs = most of the yield) now route through the
        # Unlocker SERP zone. Without it they silently skip, so require it here.
        RequiredEnv  = @("NOTION_TOKEN", "BRIGHTDATA_DATASET_TOKEN", "BRIGHTDATA_API_KEY")
        # 45 min (was 30). The 2026-07-03 run was killed at 30 min mid Stage-B
        # enrichment (263 URLs). Nine portals now produce ~250-300 URLs/run and
        # the two-stage SERP->enrich path is BD-rate-limited, so 30 min was too
        # tight. 45 min covers a worst-case ~400-URL plan with margin.
        TimeoutSec   = 2700
    }
    "referral-scout" = @{
        # Affiliation-first referral scouting. PURE SCRIPT (2026-07-07): the
        # writer self-provisions the Stage-3 queue (via notion-query.mjs), then
        # classifies + writes warm-path plans back to Notion and prints its own
        # ROUTINE_CONTRACT - so we bypass `claude -p` and are immune to the
        # headless OAuth 401 that empties the LLM routines' logs. Only needs
        # NOTION_TOKEN. NO browsing, NO Bright Data, NO LLM. The 2nd-degree
        # logged-in-LinkedIn pull stays Cowork-only (contacto.md).
        Script       = "scripts/scan/referral-scout-run.mjs"
        AllowedTools = ""
        RequiredEnv  = @("NOTION_TOKEN")
        TimeoutSec   = 900   # 15 min - up to 20 rows × Notion write
    }
    "bd-referral-scout" = @{
        # Layer 3: Bright Data cold PUBLIC-profile discovery. PURE SCRIPT -
        # prints its own ROUTINE_CONTRACT, so no claude -p / AllowedTools.
        # Public data only; writes LEADS (Outreach status = Not contacted);
        # never messages, never logs into LinkedIn. Config-gated + cost-capped.
        Script       = "scripts/scan/bd-referral-scout.mjs"
        AllowedTools = ""
        RequiredEnv  = @("NOTION_TOKEN", "BRIGHTDATA_API_KEY")
        TimeoutSec   = 1800
    }
}

# Retry policy per routine - applied if first pass fails validation.
# SESSION_LIMIT is never retried (waiting won't help within the wrapper's
# wall-clock). Paid routines (bd-bulk-scan, LLM-heavy auto-draft) get
# 1 retry max so failures don't double-bill. Cheap idempotent routines
# get 2 retries with 90s backoff.
$retryPolicy = @{
    "morning-scan"        = @{ Max = 2; BackoffSec = 60 }
    "lunchtime-scan"      = @{ Max = 2; BackoffSec = 60 }
    "pace-check"          = @{ Max = 2; BackoffSec = 30 }
    "bd-bulk-scan"        = @{ Max = 1; BackoffSec = 90 }   # paid per-URL; 1 retry max
    "auto-eval"           = @{ Max = 2; BackoffSec = 90 }
    "auto-draft"          = @{ Max = 1; BackoffSec = 120 }
    "auto-interview-prep" = @{ Max = 2; BackoffSec = 90 }
    "referral-scout"      = @{ Max = 2; BackoffSec = 60 }   # cheap + idempotent (sentinel-guarded)
    "bd-referral-scout"   = @{ Max = 1; BackoffSec = 90 }   # paid per-SERP; 1 retry max
    "system-eval"         = @{ Max = 0; BackoffSec = 0  }   # never retry - observability fails loud
}
$maxRetries  = $retryPolicy[$Routine].Max
$backoffSec  = $retryPolicy[$Routine].BackoffSec
$cfg = $policy[$Routine]
$allowedTools = $cfg.AllowedTools
$timeoutSec   = $cfg.TimeoutSec
$model        = $cfg.Model   # optional: mechanical routines pin Sonnet; others use default

# ── Pre-flight ──────────────────────────────────────────────────────
function Fail($code, $msg) {
    Write-Error $msg
    try { "FAIL $msg" | Out-File -FilePath $tracePath -Append -Encoding UTF8 } catch {}
    exit $code
}

$scriptName = $cfg.Script
$isPureScript = -not [string]::IsNullOrEmpty($scriptName)

if (-not (Test-Path $repoRoot))   { Fail 2 "Repo not found: $repoRoot" }
if ($isPureScript) {
    $scriptPath = Join-Path $repoRoot $scriptName
    if (-not (Test-Path $scriptPath)) { Fail 2 "Script not found: $scriptPath" }
} else {
    if (-not (Test-Path $promptPath)) { Fail 2 "Prompt not found: $promptPath" }
    if (-not (Test-Path $adapterPath)) {
        $available = (Get-ChildItem (Join-Path $repoRoot 'routines\adapters') -Filter '*.ps1' -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName }) -join ', '
        Fail 2 "Adapter not found: $adapterPath (CAREER_OPS_AGENT_CLI=$agentCli). Available adapters: $available"
    }
}
if (-not (Test-Path $logDir))     { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# Required env-var check (H4) - fail closed if a secret is missing.
# IMPORTANT: PowerShell's child processes (cmd.exe → claude.exe) inherit
# the wrapper's PROCESS-scope env block, NOT the User-scope registry. If
# this PowerShell session was launched in a way that didn't pre-populate
# User env into Process env (some -NoProfile or remote invocations don't),
# child processes won't see vars set via `setx`. So: read User scope,
# verify presence, then COPY into Process scope so the child inherits it.
foreach ($var in $cfg.RequiredEnv) {
    $val = [System.Environment]::GetEnvironmentVariable($var, "Process")
    if ([string]::IsNullOrEmpty($val)) {
        $val = [System.Environment]::GetEnvironmentVariable($var, "User")
        if (-not [string]::IsNullOrEmpty($val)) {
            # Copy User → Process so cmd.exe / claude.exe inherit it.
            [System.Environment]::SetEnvironmentVariable($var, $val, "Process")
        }
    }
    if ([string]::IsNullOrEmpty($val)) {
        $val = [System.Environment]::GetEnvironmentVariable($var, "Machine")
        if (-not [string]::IsNullOrEmpty($val)) {
            [System.Environment]::SetEnvironmentVariable($var, $val, "Process")
        }
    }
    if ([string]::IsNullOrEmpty($val)) {
        Fail 5 "Required env var $var is not set (Process, User, or Machine scope). Set via: setx $var ""...""."
    }
}

Set-Location $repoRoot

# ── Self-healing helpers ────────────────────────────────────────────
# NTSTATUS crash exit codes we've observed from headless CLI teardown:
# 0xC0000005 access violation, 0xC0000409 stack buffer overrun, 0xC000013A
# CTRL+C, 0xC0000374 heap corruption. A hard crash outranks every log-text
# signal: an exit code is machine fact where a string match is a guess, and
# the crash can happen AFTER the routine emitted a valid contract (the work
# landed) so a "contract valid, exit 0xC0000409" run would otherwise read OK.
function Test-IsCrashExit($exitCode) {
    if ($null -eq $exitCode) { return $false }
    $u = [uint32]$exitCode
    return ($u -eq 0xC0000005 -or $u -eq 0xC0000409 -or $u -eq 0xC000013A -or $u -eq 0xC0000374)
}

function Get-FailureMode($content, $exitCode, $timedOut, $contractValid) {
    # Classify why a pass failed so we can decide retry vs skip.
    # A hard crash outranks every log-text signal - see Test-IsCrashExit.
    if ($timedOut)                                  { return "TIMEOUT" }
    if (Test-IsCrashExit $exitCode)                 { return "CRASH" }
    # Quota strings are only trusted when the run did NOT produce output.
    # $content is the WHOLE log, which includes the routine's own
    # --- ROUTINE_CONTRACT --- block. A routine that NARRATES a quota event
    # ("...then the session limit AFTER building artifacts but BEFORE
    # uploading") would otherwise be classified as having hit one - exit 0,
    # CONTRACT_VALID True, work landed, and yet FAILURE_MODE reads
    # SESSION_LIMIT. Machine fact (exit code + contract) wins over string
    # match.
    $producedOutput = $contractValid -and $exitCode -eq 0
    if (-not $producedOutput) {
        # "rate limit" is deliberately excluded - that one IS transient and
        # should keep its retries.
        if ($content -match "weekly limit")                             { return "WEEKLY_LIMIT" }
        if ($content -match "session limit|usage limit|5-hour limit")   { return "SESSION_LIMIT" }
    }
    if ([string]::IsNullOrWhiteSpace($content) -or $content.Length -lt 1500) { return "EMPTY_LOG" }
    if (-not $contractValid -and $exitCode -ne 0)   { return "RUNTIME_ERROR" }
    if (-not $contractValid)                        { return "NO_CONTRACT" }
    # Backstop: a routine that emitted a good contract and exited non-zero is
    # NOT healthy. Without this, any exit code short of an NTSTATUS crash
    # still reads as OK.
    if ($exitCode -ne 0)                            { return "RUNTIME_ERROR" }
    return "OK"
}

function Should-Retry($mode) {
    # Quota limits are external - retrying within the wrapper window won't
    # help (quota resets on a fixed schedule, not on demand).
    if ($mode -eq "SESSION_LIMIT") { return $false }
    if ($mode -eq "WEEKLY_LIMIT")  { return $false }
    if ($mode -eq "OK")            { return $false }
    # CRASH is deliberately non-retriable. Observed crashes fire during
    # teardown, AFTER the routine emitted its contract - meaning the work
    # (scrape, Notion writes) already landed. Retrying would duplicate side
    # effects to buy nothing, since the fault is deterministic. Alert
    # instead, and let a human read the log.
    if ($mode -eq "CRASH")         { return $false }
    return $true
}

function Test-NeedsManualAttention($routine, $mode) {
    # Notify ONLY when wrapper has exhausted automatic recovery options.
    # Rules:
    #   - SESSION_LIMIT: only manual when the routine won't fire again
    #     today (i.e. compressed Tue/Wed/Thu morning - one shot). On
    #     normal weekdays, AutoDraft re-fires next night at 21:30 so the
    #     wrapper stays silent and lets the schedule retry organically.
    #   - WEEKLY_LIMIT / CRASH / TIMEOUT / EMPTY_LOG / RUNTIME_ERROR /
    #     NO_CONTRACT: always manual once retries are exhausted - these
    #     don't auto-recover. A weekly quota outlasts every fire on the
    #     schedule; a CRASH is a deterministic native fault that repeats on
    #     every fire until the code is fixed.
    if ($mode -eq "SESSION_LIMIT") {
        $dow = (Get-Date).DayOfWeek
        $hour = (Get-Date).Hour
        # Compressed morning pipeline runs Tue/Wed/Thu 05:30-09:45.
        # If we hit SESSION_LIMIT in that window, today's submission
        # day is at risk → notify.
        $isCompressedMorning = ($dow -in @("Tuesday","Wednesday","Thursday")) -and ($hour -lt 12)
        return $isCompressedMorning
    }
    # All other permanent failures need a human.
    return $true
}

function Write-Alert($routine, $mode, $exitCode, $logPath, $attempts, $finalState) {
    $alertDir = Join-Path $repoRoot "data\.alerts"
    if (-not (Test-Path $alertDir)) { New-Item -ItemType Directory -Path $alertDir -Force | Out-Null }
    $alertFile = Join-Path $alertDir "$routine-$timestamp.json"
    $tail = ""
    try { $tail = (Get-Content $logPath -Tail 40 -ErrorAction Stop) -join "`n" } catch {}
    $needsAttention = Test-NeedsManualAttention $routine $mode
    $payload = @{
        routine                  = $routine
        timestamp_utc            = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        failure_mode             = $mode
        attempts                 = $attempts
        max_attempts             = $maxRetries + 1
        final_state              = $finalState
        exit_code                = $exitCode
        log_path                 = $logPath
        needs_manual_attention   = $needsAttention
        suggested_fix  = switch ($mode) {
            "SESSION_LIMIT" {
                if ($needsAttention) {
                    "Hit session quota during compressed morning window. Today's submission pipeline is at risk. Re-run manually after quota resets (~3:50am next cycle), or check provider account."
                } else {
                    "Wait for session quota reset. Routine will retry on next natural fire - no action needed."
                }
            }
            "WEEKLY_LIMIT" {
                # Unlike SESSION_LIMIT this outlasts every fire on the schedule, so it
                # can never be left to recover organically - always manual.
                "Hit weekly quota. Cannot auto-recover within this week's schedule. Check provider account or wait for weekly reset before re-running."
            }
            "CRASH" {
                # Native fault at process teardown, AFTER the routine emitted its
                # contract - retrying would duplicate side effects to buy nothing,
                # since the fault is deterministic. Human reads the log.
                "Routine crashed at teardown (native fault). The work likely landed before the crash - inspect log tail before re-running to avoid duplicate side effects."
            }
            "TIMEOUT"       { "Routine exceeded $timeoutSec sec. Investigate: hung agent CLI? Stuck MCP? Re-run manually with --verbose." }
            "EMPTY_LOG"     { "Routine produced no stdout (agent CLI missing MCP or pure-script node failure). Check trace + re-run manually." }
            "RUNTIME_ERROR" { "Routine ran but exited non-zero. Check tail of log for stack trace or error message." }
            "NO_CONTRACT"   { "Routine ran but emitted no --- ROUTINE_CONTRACT --- block. Likely silent failure in routine logic. Inspect log + routine.md." }
            default         { "Inspect log: $logPath" }
        }
        log_tail = $tail
    }
    $payload | ConvertTo-Json -Depth 6 | Out-File -FilePath $alertFile -Encoding UTF8

    # Windows toast - ONLY when manual attention required
    if ($needsAttention) {
        try {
            $title = "applyd: $routine needs you"
            $msg   = "$mode after $attempts attempt(s). See data\.alerts\"
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
            $bal = New-Object System.Windows.Forms.NotifyIcon
            $bal.Icon = [System.Drawing.SystemIcons]::Warning
            $bal.Visible = $true
            $bal.ShowBalloonTip(10000, $title, $msg, [System.Windows.Forms.ToolTipIcon]::Warning)
            Start-Sleep -Seconds 2
            $bal.Dispose()
        } catch {}
    } else {
        # Silent - alert still written for SystemEval to surface later, but
        # no toast to interrupt the user during normal auto-recovery cycles.
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tSILENT_ALERT routine=$routine mode=$mode (auto-recovers)" |
            Out-File -FilePath $tracePath -Append -Encoding UTF8
    }
    return $alertFile
}

# ── Header ──────────────────────────────────────────────────────────
$launcherLabel = if ($isPureScript) { "node $scriptName (pure-script, no LLM)" } else { "agent-cli:$agentCli (adapter: $adapterPath)" }
$header = @"
================================================================================
ROUTINE_START: $Routine
TIMESTAMP_LOCAL: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
TIMESTAMP_UTC: $((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
REPO: $repoRoot
PROMPT: $promptPath
LOG: $logPath
LAUNCHER: $launcherLabel
MODEL: $(if ($model) { $model } else { 'default (subscription tier)' })
MCP: $(if ($isPureScript) { 'n/a (pure script)' } else { 'strict: .mcp.json (brightdata only)' })
ALLOWED_TOOLS: $allowedTools
TIMEOUT_SEC: $timeoutSec
MAX_RETRIES: $maxRetries
BACKOFF_SEC: $backoffSec
================================================================================

--- STDOUT + STDERR ---
"@
$header | Out-File -FilePath $logPath -Encoding UTF8

# ── Build launch command ─────────────────────────────────────────────
# Use System.Diagnostics.Process directly: PowerShell's Start-Process
# double-quotes -ArgumentList items, which corrupts cmd.exe's /c parser
# when the inner command itself contains quoted paths.
#
# Two launch paths:
#   1. Pure-script routines invoke `node <script>` directly - no LLM,
#      no MCP, no adapter. Deterministic; script owns its ROUTINE_CONTRACT.
#   2. Prompt routines dispatch to the agent-CLI adapter selected by
#      $env:CAREER_OPS_AGENT_CLI (default: claude). The adapter owns
#      the CLI-specific flags, auth, and MCP config; the wrapper stays
#      neutral.
if ($isPureScript) {
    # Pure-script path: invoke `node <script>` directly. The script is
    # expected to print its own ROUTINE_CONTRACT block to stdout, which the
    # validator below greps for verbatim.
    $cmdArgs = "/c node `"$scriptName`" >> `"$logPath`" 2>&1"
} else {
    # Adapter path: hand off to routines/adapters/<cli>.ps1 with a
    # neutral param set. Claude-specific concerns (ANTHROPIC_API_KEY
    # stripping, subscription-OAuth check, --strict-mcp-config, model
    # pinning, --allowedTools) live inside claude.ps1. Other adapters
    # implement whatever their CLI needs.
    $mcpConfig    = Join-Path $repoRoot ".mcp.json"
    $adapterQuoted = "`"$adapterPath`""
    $modelArg     = if (-not [string]::IsNullOrEmpty($model)) { "-Model `"$model`" " } else { "" }
    $toolsArg     = if (-not [string]::IsNullOrEmpty($allowedTools)) { "-AllowedTools `"$allowedTools`" " } else { "" }
    # Invoke via powershell.exe so the adapter runs in its own process,
    # then redirect its stdout+stderr to the same log the wrapper reads.
    # -NoProfile keeps startup fast and avoids user-shell surprises.
    $cmdArgs = "/c powershell.exe -NoProfile -ExecutionPolicy Bypass -File $adapterQuoted -Prompt `"$promptPath`" -Log `"$logPath`" -Timeout $timeoutSec $modelArg$toolsArg-McpConfig `"$mcpConfig`" -RepoRoot `"$repoRoot`""
    Write-Host "[dispatch] routine '$Routine' -> adapter '$agentCli' (timeout ${timeoutSec}s)"
}

$exitCode      = 0
$timedOut      = $false
$contractFound = $false
$contractValid = $false
$failureMode   = "OK"
$attempt       = 0
$totalAttempts = $maxRetries + 1

# ── Self-healing retry loop ─────────────────────────────────────────
:attemptLoop while ($attempt -lt $totalAttempts) {
    $attempt++
    if ($attempt -gt 1) {
        "`n--- RETRY ATTEMPT $attempt / $totalAttempts (after $backoffSec s backoff; prev failure: $failureMode) ---`n" |
            Out-File -FilePath $logPath -Append -Encoding UTF8
        Start-Sleep -Seconds $backoffSec
    }
    $exitCode = 0
    $timedOut = $false
    $proc     = $null
    try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName         = "cmd.exe"
    $psi.Arguments        = $cmdArgs
    $psi.WorkingDirectory = $repoRoot   # Set-Location only updates PS's location,
                                        # not the .NET process cwd - child claude
                                        # would otherwise inherit Task Scheduler's
                                        # C:\Windows\system32 default and abort
                                        # on the "not in repo root" pre-flight.
    $psi.UseShellExecute  = $false
    $psi.CreateNoWindow   = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    # Give the adapter's own kill loop (if any) an extra 30s to shut
    # down cleanly and report 124 in the log before the wrapper's kill
    # fires. For pure-script routines this is a no-op (the wrapper's
    # timer is the only one).
    $outerTimeoutMs = ($timeoutSec + 30) * 1000
    if (-not $proc.WaitForExit($outerTimeoutMs)) {
        # Timeout - kill the process tree and mark timeout.
        $timedOut = $true
        try { taskkill /PID $proc.Id /T /F | Out-Null } catch {}
        try { $proc.WaitForExit(2000) | Out-Null } catch {}
        $exitCode = 124  # POSIX-ish timeout convention
        "`nROUTINE_TIMEOUT: routine exceeded $timeoutSec seconds (outer wrapper timer); process tree killed" |
            Out-File -FilePath $logPath -Append -Encoding UTF8
    } else {
        # WaitForExit($ms) does NOT guarantee ExitCode is materialised; the
        # zero-arg form does. Call it to flush async state.
        try { $proc.WaitForExit() } catch {}
        $exitCode = [int]$proc.ExitCode
        # Adapter's own timer may have fired first and returned 124.
        # Treat that as a timeout too so the failure classifier and
        # the log footer stay accurate.
        if ($exitCode -eq 124) { $timedOut = $true }
    }
} catch {
    "`nROUTINE_EXCEPTION: $_" | Out-File -FilePath $logPath -Append -Encoding UTF8
    $exitCode = 3
}

# ── Output-contract validation (C1) ─────────────────────────────────
    # `claude -p` can exit 0 with zero useful output (e.g. when an MCP it
    # needs is missing from --allowedTools). We require the log to contain
    # a `--- ROUTINE_CONTRACT ---` block; if absent, override the exit code.
    $logContent = ""
    try { $logContent = Get-Content $logPath -Raw -ErrorAction Stop } catch {}

    $contractFound = $false
    $contractValid = $false
    # Accept either the default ROUTINE_CONTRACT marker OR a routine-
    # specific contract name (e.g. SYSTEM_EVAL_CONTRACT for system-eval).
    # The minimum sanity check is still that the routine name appears
    # somewhere inside the block as ROUTINE: <name>.
    if ($logContent -match "---\s*(ROUTINE_CONTRACT|SYSTEM_EVAL_CONTRACT|[A-Z_]+_CONTRACT)\s*---") {
        $contractFound = $true
        if ($logContent -match "ROUTINE:\s*$Routine") {
            $contractValid = $true
        }
    }

    if (-not $timedOut -and -not $contractValid) {
        "`nROUTINE_VALIDATION_FAIL (attempt $attempt/$totalAttempts): log is missing a valid `--- ROUTINE_CONTRACT ---` block for routine '$Routine' (claude -p exit was $exitCode)." |
            Out-File -FilePath $logPath -Append -Encoding UTF8
        if ($exitCode -eq 0) { $exitCode = 4 }
    }

    # Classify outcome of THIS attempt and decide retry vs exit
    $failureMode = Get-FailureMode $logContent $exitCode $timedOut $contractValid
    if ($failureMode -eq "OK") { break attemptLoop }
    if (-not (Should-Retry $failureMode)) {
        "`nROUTINE_NO_RETRY: failure mode '$failureMode' is non-retriable in-wrapper. Will exit." |
            Out-File -FilePath $logPath -Append -Encoding UTF8
        break attemptLoop
    }
    if ($attempt -ge $totalAttempts) {
        "`nROUTINE_RETRIES_EXHAUSTED: $attempt/$totalAttempts attempts all failed with '$failureMode'." |
            Out-File -FilePath $logPath -Append -Encoding UTF8
        break attemptLoop
    }
}  # end retry loop

# ── On failure: write structured alert + Windows toast ──────────────
$finalState = if ($failureMode -eq "OK") { "success" } else { "failed" }
if ($finalState -eq "failed") {
    $alertPath = Write-Alert $Routine $failureMode $exitCode $logPath $attempt $finalState
    "`nROUTINE_ALERT_WRITTEN: $alertPath" | Out-File -FilePath $logPath -Append -Encoding UTF8
}

# ── Footer ──────────────────────────────────────────────────────────
$footer = @"

================================================================================
ROUTINE_END: $Routine
EXIT_CODE: $exitCode
TIMED_OUT: $timedOut
CONTRACT_FOUND: $contractFound
CONTRACT_VALID: $contractValid
FAILURE_MODE: $failureMode
ATTEMPTS: $attempt / $totalAttempts
FINAL_STATE: $finalState
TIMESTAMP_UTC: $((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
================================================================================
"@
$footer | Out-File -FilePath $logPath -Append -Encoding UTF8

try {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tEXIT routine=$Routine exit=$exitCode timeout=$timedOut contract_valid=$contractValid" |
        Out-File -FilePath $tracePath -Append -Encoding UTF8
} catch {}

# ── Deterministic writing-caveats scrub (em/en dashes, "not just") ──
# The §4/§9 humanizer rules are ENFORCED here by code, not by the LLM's
# self-check inside auto-draft.md (309 em dashes shipped historically when
# it was instruction-only). After any routine that writes cover letters /
# form-answers, scrub the source .md deterministically. 20s soft cap.
if ($Routine -eq "auto-draft") {
    foreach ($scrubRoot in @("output/cover-letters", "output/form-answers")) {
        try {
            $scrubPsi = New-Object System.Diagnostics.ProcessStartInfo
            $scrubPsi.FileName         = "node.exe"
            $scrubPsi.Arguments        = "scripts/metrics/caveats-scrub.mjs --root $scrubRoot"
            $scrubPsi.WorkingDirectory = $repoRoot
            $scrubPsi.UseShellExecute  = $false
            $scrubPsi.CreateNoWindow   = $true
            $scrubPsi.RedirectStandardOutput = $true
            $scrubPsi.RedirectStandardError  = $true
            $scrubProc = [System.Diagnostics.Process]::Start($scrubPsi)
            if (-not $scrubProc.WaitForExit(20000)) { try { $scrubProc.Kill() } catch {} }
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tCAVEATS_SCRUBBED routine=$Routine root=$scrubRoot exit=$($scrubProc.ExitCode)" |
                Out-File -FilePath $tracePath -Append -Encoding UTF8
        } catch {
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tCAVEATS_SCRUB_ERROR routine=$Routine root=$scrubRoot" |
                Out-File -FilePath $tracePath -Append -Encoding UTF8
        }
    }
}

# ── Auto-rebuild dashboard ──────────────────────────────────────────
# Refresh dashboard.html + data/dashboard.json after every routine so
# the local dashboard (served on :7300) always reflects the latest
# Notion state. Skipped for system-eval (it doesn't mutate Notion, so
# nothing to refresh). 30s soft cap so a Notion outage can't block
# the wrapper's exit. Skipped inside a drain loop ($SkipDashboard) - the
# drain driver rebuilds + publishes once at the end instead of per iteration.
if ($Routine -ne "system-eval" -and -not $SkipDashboard) {
    try {
        $dashPsi = New-Object System.Diagnostics.ProcessStartInfo
        $dashPsi.FileName         = "node.exe"
        $dashPsi.Arguments        = "scripts/dashboard/build-dashboard.mjs"
        $dashPsi.WorkingDirectory = $repoRoot
        $dashPsi.UseShellExecute  = $false
        $dashPsi.CreateNoWindow   = $true
        $dashPsi.RedirectStandardOutput = $true
        $dashPsi.RedirectStandardError  = $true
        $dashProc = [System.Diagnostics.Process]::Start($dashPsi)
        if (-not $dashProc.WaitForExit(30000)) {
            try { $dashProc.Kill() } catch {}
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tDASHBOARD_REBUILD_TIMEOUT routine=$Routine" |
                Out-File -FilePath $tracePath -Append -Encoding UTF8
        } else {
            "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tDASHBOARD_REBUILT routine=$Routine exit=$($dashProc.ExitCode)" |
                Out-File -FilePath $tracePath -Append -Encoding UTF8

            # Publish to GitHub Pages (dashboard repo, if configured).
            # Best-effort: skips silently if clone missing or push fails.
            try {
                $pubPsi = New-Object System.Diagnostics.ProcessStartInfo
                $pubPsi.FileName         = "C:\Program Files\Git\bin\bash.exe"
                $pubPsi.Arguments        = "-c `"./publish-dashboard.sh`""
                $pubPsi.WorkingDirectory = $repoRoot
                $pubPsi.UseShellExecute  = $false
                $pubPsi.CreateNoWindow   = $true
                $pubProc = [System.Diagnostics.Process]::Start($pubPsi)
                if (-not $pubProc.WaitForExit(45000)) {
                    try { $pubProc.Kill() } catch {}
                    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tDASHBOARD_PUBLISH_TIMEOUT routine=$Routine" |
                        Out-File -FilePath $tracePath -Append -Encoding UTF8
                } else {
                    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tDASHBOARD_PUBLISHED routine=$Routine exit=$($pubProc.ExitCode)" |
                        Out-File -FilePath $tracePath -Append -Encoding UTF8
                }
            } catch {
                "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tDASHBOARD_PUBLISH_ERROR routine=$Routine error=$_" |
                    Out-File -FilePath $tracePath -Append -Encoding UTF8
            }
        }
    } catch {
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`tDASHBOARD_REBUILD_ERROR routine=$Routine error=$_" |
            Out-File -FilePath $tracePath -Append -Encoding UTF8
    }
}

exit $exitCode
