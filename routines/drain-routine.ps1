# drain-routine.ps1
#
# Generic "fresh session per chunk" looper. Fires ONE routine repeatedly via the
# hardened wrapper (run-routine.ps1), each invocation a fresh `claude -p` with an
# empty context, until the routine's queue Stage is empty (or a hard iteration
# ceiling / no-progress guard trips). This is how routine SESSION LENGTH is
# capped: the per-run row cap in config/profile.yml keeps each session small, and
# this loop re-fires small fresh sessions so daily THROUGHPUT is unchanged.
#
# The checkpoint is Notion itself: a processed row changes Stage, so it is never
# re-selected, which makes each iteration safely resumable.
#
# Generalises the two phases of drain-pipeline.ps1 into one reusable driver so a
# single scheduled task can own a single routine (structure + timing preserved).
#
# Usage:
#   ...\drain-routine.ps1 -Routine auto-eval  -Stage "1. Discovered"
#   ...\drain-routine.ps1 -Routine auto-draft -Stage "2. Triaged"
#   ...\drain-routine.ps1 -Routine auto-eval  -Stage "1. Discovered" -DryRun   # loop logic only, fires nothing
#
# Safety (inherited from drain-pipeline.ps1):
#   - Hard iteration ceiling (default 12).
#   - Aborts if a single iteration returns exit != 0.
#   - Stops when Stage depth = 0 OR an iteration made no progress (runaway guard).
#   - Each iteration runs under the wrapper's contract-validation + timeout.

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("auto-eval","auto-draft","auto-interview-prep","referral-scout")]
    [string]$Routine,

    [Parameter(Mandatory=$true)]
    [string]$Stage,                    # Notion Stage whose depth signals "drained"

    [int]$MaxIterations = 12,
    [int]$BetweenIterationSec = 10,
    [switch]$DryRun                    # exercise the loop + depth checks; fire nothing
)

$ErrorActionPreference = "Continue"
$repo    = $PSScriptRoot | Split-Path
$wrapper = Join-Path $repo "routines\run-routine.ps1"
$logDir  = Join-Path $repo "data\routine-logs"
$drainLog = Join-Path $logDir "drain-$Routine-$(Get-Date -Format 'yyyy-MM-dd_HHmm').log"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# NOTION_TOKEN must be in Process scope so notion-query.mjs (depth check) sees it.
$tok = [System.Environment]::GetEnvironmentVariable("NOTION_TOKEN", "User")
if ([string]::IsNullOrEmpty($tok)) { "FATAL: NOTION_TOKEN not in User scope. Aborting." | Out-File $drainLog -Append; exit 5 }
[System.Environment]::SetEnvironmentVariable("NOTION_TOKEN", $tok, "Process")
Set-Location $repo

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"), $msg
    Write-Host $line
    $line | Out-File -FilePath $drainLog -Append -Encoding UTF8
}

function QueueDepth($stage) {
    $out = & node scripts/notion/notion-query.mjs --stage $stage --json 2>$null | Out-String
    try { return ([array]($out | ConvertFrom-Json)).Count } catch { return -1 }
}

function FireRoutine($routine) {
    if ($DryRun) { Log "  [DryRun] would fire $routine via wrapper"; return 0 }
    Log "  -> firing $routine via wrapper (-SkipDashboard)"
    # -SkipDashboard: suppress the wrapper's per-fire dashboard rebuild+publish;
    # the drain does it once at the end instead of once per iteration.
    # CRITICAL (`*> $null`): the child wrapper's Write-Host/stdout would otherwise
    # flow into THIS function's output stream, so `return $code` would return
    # [wrapper stdout lines…, $code] — an array/string, not the integer exit code.
    # That made `if ($code -ne 0)` in the loop trip on the first iteration
    # ("iteration exit [preflight]…0; aborting drain") and silently capped every
    # drain to one pass. The wrapper writes its own routine-log, so discarding its
    # stdout here loses nothing; $LASTEXITCODE still carries the real exit code.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper -Routine $routine -SkipDashboard *> $null
    $code = $LASTEXITCODE
    Log "  <- $routine exited $code"
    return $code
}

Log "=== drain-routine START: $Routine (Stage '$Stage')$(if ($DryRun) {' [DRY RUN]'}) ==="
$lastDepth = QueueDepth $Stage
Log "Stage '$Stage' depth at start: $lastDepth"

for ($i = 1; $i -le $MaxIterations; $i++) {
    if ($lastDepth -le 0) { Log "Queue empty; complete after $($i-1) iteration(s)."; break }
    Log ""
    Log "Iteration ${i}/${MaxIterations} - depth: ${lastDepth}"
    $code = FireRoutine $Routine
    if ($code -ne 0) { Log "iteration exit $code; aborting drain."; break }
    if ($DryRun) { Log "  [DryRun] stopping after one simulated iteration."; break }
    Start-Sleep -Seconds $BetweenIterationSec
    $newDepth = QueueDepth $Stage
    Log "depth after iteration ${i}: ${newDepth} (was ${lastDepth})"
    if ($newDepth -ge $lastDepth) { Log "no progress this iteration; stopping to avoid runaway."; break }
    $lastDepth = $newDepth
}

Log ""
Log "final depth Stage '$Stage': $(QueueDepth $Stage)"

# Dashboard rebuild + Pages publish ONCE at end-of-drain (the per-iteration fires
# ran with -SkipDashboard). Mirrors run-routine.ps1's dashboard step so the public
# GitHub Pages dashboard still updates after a drain, just once. Best-effort.
if (-not $DryRun) {
    try {
        $p = New-Object System.Diagnostics.ProcessStartInfo
        $p.FileName = "node.exe"; $p.Arguments = "scripts/dashboard/build-dashboard.mjs"; $p.WorkingDirectory = $repo
        $p.UseShellExecute = $false; $p.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($p)
        if (-not $proc.WaitForExit(30000)) { try { $proc.Kill() } catch {} }
        Log "dashboard rebuilt (exit $($proc.ExitCode))"
        # Publish to GitHub Pages (best-effort; skips silently if clone/push fails).
        $pub = New-Object System.Diagnostics.ProcessStartInfo
        $pub.FileName = "C:\Program Files\Git\bin\bash.exe"; $pub.Arguments = "-c `"./publish-dashboard.sh`""
        $pub.WorkingDirectory = $repo; $pub.UseShellExecute = $false; $pub.CreateNoWindow = $true
        $pubProc = [System.Diagnostics.Process]::Start($pub)
        if (-not $pubProc.WaitForExit(45000)) { try { $pubProc.Kill() } catch {} }
        Log "dashboard published (exit $($pubProc.ExitCode))"
    } catch { Log "dashboard rebuild/publish error: $_" }
}
Log "=== drain-routine END: $Routine ==="
