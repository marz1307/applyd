# system-eval-plain.ps1 — the health WATCHDOG, off Claude (2026-07-06).
#
# Runs the mechanical health collector `node scripts/system-eval.mjs` DIRECTLY under
# Windows Task Scheduler. No `claude -p`, no LLM. The collector already produces
# the full 🟢/🟡/🔴 report plus a SYSTEM_EVAL_CONTRACT block; the Claude wrapper
# it used to run under added nothing mechanical.
#
# Writes: data/routine-logs/system-eval-<yyyy-MM-dd_HHmm>.log (human report +
#         JSON), and appends a one-line WATCHDOG summary to
#         data/system-eval-watchdog.log. Emits WATCHDOG_ALERT lines when the
#         collector reports overall status other than healthy, or a routine that
#         has not run in >48h (a schedule/battery stall).
#
# Scheduled via Task Scheduler task CareerOps_SystemEval.

$ErrorActionPreference = "Continue"
$repo    = $PSScriptRoot | Split-Path
$logDir  = Join-Path $repo "data\routine-logs"
$wdLog   = Join-Path $repo "data\system-eval-watchdog.log"
Set-Location $repo
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$ts    = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$outFile = Join-Path $logDir "system-eval-$stamp.log"

# NOTION_TOKEN enables --deep (Notion stage counts). Without it, fall back to
# --quick (pure filesystem + log inspection), which still catches stale routines.
$tok = [System.Environment]::GetEnvironmentVariable("NOTION_TOKEN", "User")
$mode = "--quick"
if (-not [string]::IsNullOrEmpty($tok)) {
    [System.Environment]::SetEnvironmentVariable("NOTION_TOKEN", $tok, "Process")
    $mode = "--deep"
}

# Run the collector twice: human-readable report (for the log file) + JSON (for
# machine parsing of the overall status).
$node = "node.exe"
& $node "scripts/system-eval.mjs" $mode        *>  $outFile
$jsonRaw = & $node "scripts/system-eval.mjs" $mode "--json" 2>$null
$jsonRaw | Out-File -FilePath $outFile -Encoding UTF8 -Append

# Parse the JSON: system-eval reports per-routine health under j.routines, each
# with { status, age_hours, max_age_h, cadence, errors, session_limit }.
#
# Staleness + failure classification now lives in system-eval.mjs and is
# cadence- and UK-bank-holiday-aware (weekday vs weekly routines; weekend and
# holiday gaps folded into each routine's max age). The watchdog no longer
# re-derives a weekday threshold here; it simply surfaces any routine whose
# status is not clean. This also closes the prior gap where NO_CONTRACT /
# EMPTY_LOG runs (detected by the collector) never raised a watchdog alert.
$badStatuses = @('STALE','SESSION_LIMIT','EMPTY_LOG','NO_CONTRACT','WITH_ERRORS','NEVER_RUN')
$status = "unknown"; $alerts = @()
try {
    $j = $jsonRaw | Out-String | ConvertFrom-Json
    if ($j.routines) {
        foreach ($p in $j.routines.PSObject.Properties) {
            $r = $p.Value
            if ($badStatuses -contains $r.status) {
                $detail = switch ($r.status) {
                    'STALE'         { "STALE (last ran $($r.age_hours)h ago, max $($r.max_age_h)h for its $($r.cadence) cadence)" }
                    'WITH_ERRORS'   { "reported $($r.errors) error(s) in last run" }
                    'NO_CONTRACT'   { "last run emitted no contract block (silent failure?)" }
                    'EMPTY_LOG'     { "last log is empty (aborted before producing output)" }
                    'SESSION_LIMIT' { "hit a Claude session limit (external, retries on next fire)" }
                    'NEVER_RUN'     { "has never run" }
                    default         { $r.status }
                }
                $alerts += "routine '$($p.Name)' $detail"
            }
        }
        $status = if ($alerts.Count -eq 0) { "healthy" } else { "degraded" }
    }
} catch {
    $alerts += "watchdog: could not parse system-eval JSON ($($_.Exception.Message))"
    $status = "parse-error"
}

# One-line watchdog summary + explicit ALERT lines when unhealthy.
$summary = "$ts status=$status mode=$mode alerts=$($alerts.Count) log=system-eval-$stamp.log"
Add-Content -Path $wdLog -Value $summary
if ($status -notin @("healthy", "ok", "green") -or $alerts.Count -gt 0) {
    Add-Content -Path $wdLog -Value "$ts WATCHDOG_ALERT status=$status"
    foreach ($a in $alerts) { Add-Content -Path $wdLog -Value "$ts WATCHDOG_ALERT $a" }
}
Write-Output $summary
