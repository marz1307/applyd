# drain-pipeline.ps1
#
# Loop auto-eval until Stage 1 is empty, then auto-draft until Stage 2 is
# empty. Intended for an overnight close-out cycle when the normal 21:00
# / 21:30 schedule isn't enough — drives the full backlog to Stage 3 in
# one push.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo-root>\routines\drain-pipeline.ps1"
#
# Per-iteration safety:
#   - Each auto-eval / auto-draft invocation uses the hardened wrapper
#     (run-routine.ps1) so all the contract-validation + timeout logic
#     applies.
#   - Hard ceiling of 12 iterations per phase (≈ 600 eval rows / 300
#     draft rows max — well above current backlog).
#   - Aborts the phase if a single iteration returns exit != 0.
#   - Counts queue depth via notion-query.mjs between iterations; stops
#     when depth = 0 OR no progress was made.

param(
    [int]$MaxEvalIterations = 12,
    [int]$MaxDraftIterations = 12,
    [int]$BetweenIterationSec = 10
)

$ErrorActionPreference = "Continue"
$repo = $PSScriptRoot | Split-Path
$wrapper = Join-Path $repo "routines\run-routine.ps1"
$logDir = Join-Path $repo "data\routine-logs"
$drainLog = Join-Path $logDir "drain-pipeline-$(Get-Date -Format 'yyyy-MM-dd_HHmm').log"

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# Ensure NOTION_TOKEN is in Process scope so notion-query.mjs sees it
$tok = [System.Environment]::GetEnvironmentVariable("NOTION_TOKEN", "User")
if ([string]::IsNullOrEmpty($tok)) {
    "FATAL: NOTION_TOKEN not in User scope. Aborting." | Tee-Object -FilePath $drainLog -Append
    exit 5
}
[System.Environment]::SetEnvironmentVariable("NOTION_TOKEN", $tok, "Process")
Set-Location $repo

function Log {
    param([string]$msg)
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $msg
    Write-Host $line
    $line | Out-File -FilePath $drainLog -Append -Encoding UTF8
}

function QueueDepth {
    param([string]$stage)
    $out = & node scripts/notion/notion-query.mjs --stage $stage --json 2>$null | Out-String
    try {
        $data = $out | ConvertFrom-Json
        return $data.Count
    } catch { return -1 }
}

function FireRoutine {
    param([string]$routine)
    Log "→ firing $routine via wrapper"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper -Routine $routine
    $code = $LASTEXITCODE
    Log "← $routine exited $code"
    return $code
}

Log "=== drain-pipeline START ==="
Log "Repo: $repo"
Log "MaxEvalIterations: $MaxEvalIterations, MaxDraftIterations: $MaxDraftIterations"

# ── Phase 1: drain Stage 1 ──────────────────────────────────────────
Log ""
Log "── Phase 1: drain Stage 1 (auto-eval loop) ──"
$beforeEval = QueueDepth "1. Discovered"
Log "Stage 1 depth at start: $beforeEval"

$lastDepth = $beforeEval
for ($i = 1; $i -le $MaxEvalIterations; $i++) {
    if ($lastDepth -le 0) { Log "Queue empty — phase 1 complete after $($i-1) iterations"; break }
    Log ""
    Log "Iteration ${i}/${MaxEvalIterations} · Stage-1 depth: ${lastDepth}"
    $code = FireRoutine "auto-eval"
    if ($code -ne 0) { Log "auto-eval exit $code - aborting phase 1"; break }
    Start-Sleep -Seconds $BetweenIterationSec
    $newDepth = QueueDepth "1. Discovered"
    Log "Stage 1 depth after iteration ${i}: ${newDepth} (was ${lastDepth})"
    if ($newDepth -ge $lastDepth) { Log "No progress this iteration — stopping phase 1 to avoid runaway"; break }
    $lastDepth = $newDepth
}

# ── Phase 2: drain Stage 2 ──────────────────────────────────────────
Log ""
Log "── Phase 2: drain Stage 2 ≥75 (auto-draft loop) ──"
$beforeDraft = QueueDepth "2. Triaged"
Log "Stage 2 depth at start: $beforeDraft"

$lastDepth = $beforeDraft
for ($i = 1; $i -le $MaxDraftIterations; $i++) {
    if ($lastDepth -le 0) { Log "Queue empty — phase 2 complete after $($i-1) iterations"; break }
    Log ""
    Log "Iteration ${i}/${MaxDraftIterations} · Stage-2 depth: ${lastDepth}"
    $code = FireRoutine "auto-draft"
    if ($code -ne 0) { Log "auto-draft exit $code - aborting phase 2"; break }
    Start-Sleep -Seconds $BetweenIterationSec
    $newDepth = QueueDepth "2. Triaged"
    Log "Stage 2 depth after iteration ${i}: ${newDepth} (was ${lastDepth})"
    if ($newDepth -ge $lastDepth) { Log "No progress this iteration — stopping phase 2"; break }
    $lastDepth = $newDepth
}

# ── Final state ─────────────────────────────────────────────────────
Log ""
Log "── Final state ──"
$finalDiscovered = QueueDepth "1. Discovered"
$finalTriaged    = QueueDepth "2. Triaged"
$finalDrafted    = QueueDepth "3. Drafted"
Log "Stage 1 Discovered: $finalDiscovered"
Log "Stage 2 Triaged:    $finalTriaged"
Log "Stage 3 Drafted:    $finalDrafted"

# Rebuild dashboard one last time
Log ""
Log "Rebuilding dashboard…"
& node scripts/dashboard/build-dashboard.mjs *>&1 | Tee-Object -FilePath $drainLog -Append | Out-Null
Log "Dashboard rebuilt"

Log ""
Log "=== drain-pipeline END ==="
