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
# Safety:
#   - Hard iteration ceiling (per-routine defaults below; overrideable).
#   - Per-routine lock file with stale-lock detection (PID identity, not just PID number).
#   - Aborts if a single iteration returns exit != 0.
#   - Stops when Stage depth = 0 OR an iteration made no progress (runaway guard).
#   - "No progress" checks TWO signals (net depth AND routine-reported count) so
#     a working iteration is not stopped just because upstream is refilling as
#     fast as this drains.
#   - Each iteration runs under the wrapper's contract-validation + timeout.
#   - CAPPED banner on the log if the ceiling truncated the burst with rows still
#     waiting (otherwise a capped burst reads identically to a fully drained one).

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("auto-eval","auto-draft","auto-interview-prep","referral-scout")]
    [string]$Routine,

    [Parameter(Mandatory=$true)]
    [string]$Stage,                    # Notion Stage whose depth signals "drained"

    [int]$MaxIterations = 0,           # 0 = use the per-routine default below
    [int]$BetweenIterationSec = 10,
    [switch]$DryRun                    # exercise the loop + depth checks; fire nothing
)

$ErrorActionPreference = "Continue"

# ── Per-routine iteration ceiling per burst ─────────────────────────
# All routines share ONE Claude session quota (a rolling ~5-hour window). The
# routines fire as a chain — auto-eval, then auto-draft, then interview-prep —
# so whatever runs FIRST can starve everything after it. auto-eval is therefore
# capped tighter than the others: it is the head of the chain and its queue
# (Stage 1) is by far the deepest, so left at the higher ceiling it will happily
# consume the whole quota by itself. If Stage-1 depth starts climbing again,
# investigate what other work is burning the shared quota BEFORE raising this
# number — a higher ceiling here trades a visible backlog for an invisible
# quota failure downstream.
$defaultMaxIterations = @{
    "auto-eval"           = 6
    "auto-draft"          = 12
    "auto-interview-prep" = 12
    "referral-scout"      = 12
}
if ($MaxIterations -le 0) {
    $MaxIterations = if ($defaultMaxIterations.ContainsKey($Routine)) { $defaultMaxIterations[$Routine] } else { 12 }
}

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

# ── Single-writer lock (per-routine) ────────────────────────────────
# A scheduled task and a manual `drain-routine.ps1` kickoff can fire
# concurrently. Both races write to data\.routine-tmp\*.json (assess.json,
# upload-plan.json, letter .md files), which produces mid-edit reversions.
# Per-routine key so drain-auto-draft and drain-auto-eval can still run in
# parallel. PID + liveness check so a crashed prior run does not wedge
# the lock forever.
$LockDir = Join-Path $repo "data\.routine-tmp"
if (-not (Test-Path $LockDir)) { New-Item -ItemType Directory -Path $LockDir -Force | Out-Null }
$LockFile = Join-Path $LockDir "drain-$Routine.lock"
if (Test-Path $LockFile) {
    $prior = $null
    try { $prior = Get-Content $LockFile -Raw | ConvertFrom-Json } catch { }
    if ($prior -and $prior.pid) {
        # A PID alone does NOT identify a process. Windows recycles PIDs, so a
        # stale lock holding a long-dead drain's PID can end up matching the
        # desktop window manager (or any other unrelated process) and every
        # scheduled fire since then aborts at this line claiming a rival drain
        # is running, leaves NO log (the abort happens before the log file is
        # opened), and the queue silently grows.
        # So compare identity, not existence: a reclaimed PID will not match on
        # both process name and start time.
        $alive = Get-Process -Id $prior.pid -ErrorAction SilentlyContinue
        $sameProcess = $false
        if ($alive) {
            $nameOk = (-not $prior.procName) -or ($alive.ProcessName -eq $prior.procName)
            $startOk = $true
            if ($prior.procStart) {
                try { $startOk = ([datetime]$prior.procStart - $alive.StartTime).Duration().TotalSeconds -lt 2 } catch { $startOk = $false }
            }
            # A lock written before this fix carries neither field. Fall back to
            # the old behaviour ONLY when the process looks like a shell, so a
            # recycled PID belonging to some unrelated app can never wedge us.
            if (-not $prior.procName -and -not $prior.procStart) {
                $sameProcess = $alive.ProcessName -match '^(powershell|pwsh|claude|node|cmd)$'
                if (-not $sameProcess) {
                    Write-Host "  [lock] PID $($prior.pid) was recycled by '$($alive.ProcessName)'; treating lock as stale"
                }
            } else {
                $sameProcess = $nameOk -and $startOk
                if (-not $sameProcess) {
                    Write-Host "  [lock] PID $($prior.pid) no longer matches the recorded process; treating lock as stale"
                }
            }
        }
        if ($sameProcess) {
            Write-Host "ROUTINE_ABORT: drain-$Routine already running (PID $($prior.pid), started $($prior.startedAt))"
            exit 3
        }
        if (-not $alive) { Write-Host "  [lock] stale lock from dead PID $($prior.pid); reclaiming" }
    } else {
        Write-Host "  [lock] unparseable stale lock; reclaiming"
    }
    Remove-Item $LockFile -Force
}
# Record enough to IDENTIFY the process later, not merely to name a PID.
$me = Get-Process -Id $PID
@{ pid=$PID; procName=$me.ProcessName; procStart=$me.StartTime.ToString('o');
   startedAt=(Get-Date).ToString('o'); computer=$env:COMPUTERNAME; routine=$Routine } |
    ConvertTo-Json -Compress | Set-Content $LockFile -Encoding UTF8

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
    # Announce OUR pid to the child. Without this, an auto-draft iteration that
    # inspects the running process tree can find its own parent drain, mistake it
    # for a competing writer, and abort with ABORTED_CONCURRENT_OWNER after
    # already building CVs. With this set, the child can tell the two apart.
    $env:APPLYD_DRAIN_OWNER_PID = "$PID"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper -Routine $routine -SkipDashboard *> $null
    $code = $LASTEXITCODE
    Log "  <- $routine exited $code"
    return $code
}

try {

Log "=== drain-routine START: $Routine (Stage '$Stage')$(if ($DryRun) {' [DRY RUN]'}) ==="
Log "  [lock] holding drain-$Routine.lock (PID $PID)"
Log "iteration ceiling this burst: $MaxIterations"

# ── Pre-flight: semantic dedup + collision re-check (auto-draft only) ───────
# Runs BEFORE the first iteration so auto-draft's Stage-2 query naturally
# skips rows the deduper archives. Zero LLM cost — pure Notion query +
# targeted PATCH calls.
# Reason to gate on auto-draft only: auto-eval runs BEFORE any dedup would be
# useful (the Match score is what dedup uses to pick a keeper in pre-apply
# clusters). interview-prep runs on Stage 4+ where each row is already an
# accepted application. Only auto-draft benefits from the pre-flight.
if ($Routine -eq "auto-draft" -and -not $DryRun) {
    # ── Pre-flight 1: sync stages for applications already sent ────────────
    # Human submits by hand and sets the Apply date; nothing advances the
    # Stage. That can leave sent applications sitting at "3. Drafted". This
    # runs FIRST because the two pre-flights below both read the Stage: the
    # collision re-check treats Stage 4+ as "in flight", so a sent-but-stale
    # row is invisible as a collision partner and a genuine second application
    # to that employer would pass. Zero LLM cost.
    if (Test-Path (Join-Path $repo "batch\stage-sync-applied.mjs")) {
        Log "pre-flight: batch/stage-sync-applied.mjs --apply"
        $syncOut = node "batch/stage-sync-applied.mjs" --apply 2>&1
        $syncCode = $LASTEXITCODE
        # Grep the contract line, never the exit code: the Notion writes can all
        # succeed and the process still die on the known libuv teardown assertion.
        $syncSum = ($syncOut | Select-String -Pattern "^STAGE_SYNC:" | Select-Object -First 1)
        if ($syncSum) { Log "  <- stage sync exited $syncCode; $($syncSum.Line.Trim())" }
        else { Log "  <- stage sync exited $syncCode (NO CONTRACT LINE - treat as failed)" }

        # Second contract line from the same run. The Apply date is the day the
        # Stage select was flipped to "4. Applied" by hand, and nothing else
        # records it, so this guard stamps rows it sees newly undated at Stage 4.
        # Without logging the line there is NO evidence in the drain log that the
        # rescue ran at all — a silent no-op and a silent crash would look
        # identical.
        $rescue = ($syncOut | Select-String -Pattern "^APPLY_DATE_RESCUE:" | Select-Object -First 1)
        if ($rescue) { Log "  <- $($rescue.Line.Trim())" }
        else { Log "  <- NO APPLY_DATE_RESCUE LINE - the date guard did not report" }
    } else {
        Log "pre-flight: batch/stage-sync-applied.mjs not present; skipping"
    }

    if (Test-Path (Join-Path $repo "scripts\cv\notion-semantic-dedup.mjs")) {
        Log "pre-flight: scripts/cv/notion-semantic-dedup.mjs --auto-archive"
        $dedupOut = node "scripts/cv/notion-semantic-dedup.mjs" --auto-archive 2>&1
        $dedupCode = $LASTEXITCODE
        # Grep the summary line so the drain log gets a one-liner receipt without
        # dumping the full cluster report.
        $touched = ($dedupOut | Select-String -Pattern "APPLIED:\s*(\d+)\s*archived" | Select-Object -First 1)
        if ($touched) { Log "  <- dedup pre-flight exited $dedupCode; $($touched.Line.Trim())" }
        else { Log "  <- dedup pre-flight exited $dedupCode (no summary line matched)" }
    } else {
        Log "pre-flight: scripts/cv/notion-semantic-dedup.mjs not present; skipping"
    }

    # ── Pre-flight 3: one application per (company, city, role) ─────────────
    # auto-draft.md mandates this in the prompt, but a rule in a prompt is a
    # rule an LLM can skip under budget pressure. Deterministic here, every
    # drain. Runs AFTER semantic-dedup so branch-dedup groups only what
    # actually survived. Zero LLM cost.
    # SAFETY: branch-dedup ARCHIVES losers. It refuses to archive any row
    # carrying an Apply date and logs PROTECTED instead — that guard is why
    # this is safe to run unattended. The PROTECTED lines are surfaced below
    # so the drain log shows what it declined to touch.
    if (Test-Path (Join-Path $repo "scripts\tracker\branch-dedup.mjs")) {
        Log "pre-flight: scripts/tracker/branch-dedup.mjs (one application per company+city+role)"
        $bdOut = node "scripts/tracker/branch-dedup.mjs" 2>&1
        $bdCode = $LASTEXITCODE
        $bdSum = ($bdOut | Select-String -Pattern "^\s*rows archived:" | Select-Object -First 1)
        if ($bdSum) { Log "  <- branch-dedup exited $bdCode;$($bdSum.Line.TrimEnd())" }
        else { Log "  <- branch-dedup exited $bdCode (no summary line matched)" }
        foreach ($p in ($bdOut | Select-String -Pattern "PROTECTED:")) { Log "  <- $($p.Line.Trim())" }
    } else {
        Log "pre-flight: scripts/tracker/branch-dedup.mjs not present; skipping"
    }

    # ── Pre-flight 4: re-check Stage 3 against live collisions ──────────────
    # The Stage-2 cross-stage filter sees each row exactly once, under whatever
    # its `Company` field said that night. Placeholder names ("Undisclosed
    # (Indeed)") get resolved AFTER that, so a row can pass the filter under a
    # name that is not an employer and never be looked at again. That is how
    # rows become second or third applications to a company that had already
    # rejected the same requisition.
    # Stage 3 is the last point where that is still fixable, so re-ask the
    # question here, every drain, against live Notion state. Zero LLM cost.
    if (Test-Path (Join-Path $repo "batch\recheck-collisions.mjs")) {
        Log "pre-flight: batch/recheck-collisions.mjs --apply"
        $reOut = node "batch/recheck-collisions.mjs" --apply 2>&1
        $reCode = $LASTEXITCODE
        $reSum = ($reOut | Select-String -Pattern "^APPLIED:\s*\d+ held" | Select-Object -First 1)
        if ($reSum) { Log "  <- collision re-check exited $reCode; $($reSum.Line.Trim())" }
        else { Log "  <- collision re-check exited $reCode (no summary line matched)" }
    } else {
        Log "pre-flight: batch/recheck-collisions.mjs not present; skipping"
    }
}

$lastDepth = QueueDepth $Stage
Log "Stage '$Stage' depth at start: $lastDepth"

$ceilingHit = $false
for ($i = 1; $i -le $MaxIterations; $i++) {
    if ($lastDepth -le 0) { Log "Queue empty; complete after $($i-1) iteration(s)."; break }
    Log ""
    Log "Iteration ${i}/${MaxIterations} - depth: ${lastDepth}"
    $code = FireRoutine $Routine
    if ($code -ne 0) { Log "iteration exit $code; aborting drain."; break }
    if ($DryRun) { Log "  [DryRun] stopping after one simulated iteration."; break }
    Start-Sleep -Seconds $BetweenIterationSec
    $newDepth = QueueDepth $Stage

    # Net depth ALONE is not a progress signal. Another routine can be filling
    # this queue while we drain it: e.g. auto-draft can move N rows out of
    # Stage 2 (contract DRAFTED: N, NOTION_WRITE_FAILURES: 0) while auto-eval's
    # own drain loop triages roughly as many in, so depth reads the same both
    # sides and the guard stops a loop that was working perfectly. The guard is
    # still wanted — it is the only thing standing between a broken routine and
    # 12 pointless iterations — so keep it, and give it the second signal it
    # was missing: what the routine SAYS it did.
    $didWork = $null
    $wrapLog = Get-ChildItem -Path $logDir -Filter "$Routine-*.log" -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($wrapLog) {
        $m = Select-String -Path $wrapLog.FullName -Pattern '^(DRAFTED|EVALUATED|PACKS_WRITTEN|ROWS_WRITTEN):\s*(\d+)' -ErrorAction SilentlyContinue |
             Select-Object -Last 1
        if ($m) { $didWork = [int]$m.Matches[0].Groups[2].Value }
    }

    $drained  = $newDepth -lt $lastDepth
    $reported = ($null -ne $didWork -and $didWork -gt 0)
    Log "depth after iteration ${i}: ${newDepth} (was ${lastDepth}); routine reported $(if ($null -eq $didWork) { 'no count' } else { "$didWork done" })"

    if (-not $drained -and -not $reported) {
        Log "no progress this iteration (depth flat AND routine reported nothing); stopping to avoid runaway."
        break
    }
    if (-not $drained -and $reported) {
        # Working, but something upstream is refilling as fast as we drain.
        # Say so plainly rather than reporting a clean drain.
        Log "  depth flat but routine did $didWork - queue is being refilled concurrently; continuing."
    }
    $lastDepth = $newDepth
    # Only a burst that actually ran every allotted iteration was capped. Every
    # other exit above (empty queue, error, no-progress, dry run) logs its own
    # reason and must NOT be reported as a cap.
    if ($i -eq $MaxIterations) { $ceilingHit = $true }
}

Log ""
$finalDepth = QueueDepth $Stage
Log "final depth Stage '$Stage': $finalDepth"
# Never let the ceiling truncate silently — a capped burst that still has rows
# waiting must say so, or the log reads identically to a fully drained queue.
if ($ceilingHit -and $finalDepth -gt 0) {
    # ASCII ONLY in this string. Task Scheduler runs these scripts under
    # powershell.exe (Windows PowerShell 5.1), which reads a UTF-8 file with no
    # BOM as CP1252: an em dash (E2 80 94) becomes 'a-EUR-"' whose trailing 0x94
    # is a smart right-quote that PowerShell honours as a string delimiter. That
    # silently ends the string mid-sentence and the file no longer parses. pwsh
    # 7 decodes it fine, so this class of bug is invisible unless you parse with
    # powershell.exe specifically.
    Log "CAPPED: hit the $MaxIterations-iteration ceiling for '$Routine' with $finalDepth row(s) still at Stage '$Stage'. They wait for the next scheduled fire (by design - the ceiling protects the shared Claude session quota for the routines downstream). Override with -MaxIterations to drain by hand."
}

# Dashboard rebuild ONCE at end-of-drain (the per-iteration fires ran with
# -SkipDashboard). Mirrors run-routine.ps1's dashboard step so a downstream
# dashboard viewer still refreshes after a drain, just once. Best-effort.
# GitHub Pages publish step from run-routine.ps1 is intentionally NOT mirrored
# here: users who want to publish their dashboard can enable it in that path.
if (-not $DryRun) {
    try {
        $p = New-Object System.Diagnostics.ProcessStartInfo
        $p.FileName = "node.exe"; $p.Arguments = "scripts/dashboard/build-dashboard.mjs"; $p.WorkingDirectory = $repo
        $p.UseShellExecute = $false; $p.CreateNoWindow = $true
        $proc = [System.Diagnostics.Process]::Start($p)
        # 30s -> 120s: build-dashboard.mjs runtime scales with row count and a
        # 30s cap left almost no margin on a full tracker. Both this and the
        # copy in run-routine.ps1 must move together or the drain path keeps
        # timing out after the wrapper path was fixed.
        if (-not $proc.WaitForExit(120000)) { try { $proc.Kill() } catch {} }
        Log "dashboard rebuilt (exit $($proc.ExitCode))"
    } catch { Log "dashboard rebuild error: $_" }
}
Log "=== drain-routine END: $Routine ==="

} finally {
    if (Test-Path $LockFile) {
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }
}
