# system-eval-plain.ps1 — the health WATCHDOG, off the LLM.
#
# Runs the mechanical health collector `node scripts/system-eval.mjs` DIRECTLY
# under Windows Task Scheduler. No `claude -p`, no LLM. The collector already
# produces the full 🟢/🟡/🔴 report plus a SYSTEM_EVAL_CONTRACT block; the
# wrapper it used to run under added nothing mechanical.
#
# Writes: data/routine-logs/system-eval-<yyyy-MM-dd_HHmm>.log (human report +
#         JSON), and appends a one-line WATCHDOG summary to
#         data/system-eval-watchdog.log. Emits WATCHDOG_ALERT lines when the
#         collector reports overall status other than healthy, a routine that
#         is stale for its cadence, or a routine whose scraper backend was
#         down for the last run.
#
# Scheduled via a Task Scheduler task (name is user-picked; e.g. `Applyd_SystemEval`).

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
# with { status, age_hours, max_age_h, cadence, errors, session_limit,
# firecrawl_down, firecrawl_engine_down, apply_date_rescue_missing,
# apply_date_rescue_failed, failure_mode }.
#
# Staleness + failure classification lives in system-eval.mjs and is cadence-
# and bank-holiday-aware (weekday vs weekly routines; weekend and holiday gaps
# folded into each routine's max age). The watchdog no longer re-derives a
# weekday threshold here; it simply surfaces any routine whose status is not
# clean. This also closes the prior gap where NO_CONTRACT / EMPTY_LOG runs
# (detected by the collector) never raised a watchdog alert.
#
# TIMEOUT / CRASH / RUNTIME_ERROR: system-eval reads the wrapper's own
# FAILURE_MODE instead of flattening everything it cannot parse into
# NO_CONTRACT. Without them here, those three would be collected by the
# collector and then silently dropped by this watchdog.
#
# Retired routines are handled inside system-eval.mjs (cadence: 'manual' or a
# retired flag in ROUTINE_CADENCE) — they never carry a STALE status, so no
# special-case is needed on this side.
$badStatuses = @('STALE','SESSION_LIMIT','EMPTY_LOG','NO_CONTRACT','WITH_ERRORS','NEVER_RUN','TIMEOUT','CRASH','RUNTIME_ERROR')
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
                    'SESSION_LIMIT' {
                        if ($r.failure_mode -eq 'WEEKLY_LIMIT') {
                            "hit the LLM WEEKLY limit (external capacity, not a code issue; retries once the quota resets)"
                        } else {
                            "hit an LLM session limit (external, retries on next fire)"
                        }
                    }
                    'TIMEOUT'       { "TIMED OUT (hung claude -p or stuck MCP; re-run manually with --verbose)" }
                    'CRASH'         { "CRASHED natively (not auto-retried; check whether its writes landed before re-firing)" }
                    'RUNTIME_ERROR' { "exited non-zero (real code failure; check the log tail for a stack trace)" }
                    'NEVER_RUN'     { "has never run" }
                    default         { $r.status }
                }
                $alerts += "routine '$($p.Name)' $detail"
            }
            # Firecrawl check runs INDEPENDENTLY of status. A bulk-scan run can
            # emit a valid contract and look healthy while having silently
            # dropped every Firecrawl-backed portal (e.g. Xing, CareerBee).
            # That is how those portals can stay dead for weeks with no alert.
            # Do not fold this into $badStatuses; it must fire even when the
            # run is otherwise OK.
            #
            # KEEP THESE STRINGS ASCII. This file has no BOM, so Windows
            # PowerShell 5.1 reads it as CP1252. A UTF-8 em dash (E2 80 94)
            # then decodes byte 0x94 as a RIGHT CURLY QUOTE, which PowerShell
            # honours as a string terminator - the literal ends mid-sentence
            # and the file fails to parse. Comments survive mangling (they are
            # still comments); string literals do not.
            if ($r.firecrawl_down) {
                $fcDetail = if ($r.firecrawl_engine_down) {
                    "ran with NO Docker engine: Firecrawl-backed portals produced ZERO rows. Docker Desktop is sign-in-scoped, so the run fired while signed out."
                } else {
                    "ran with Firecrawl unreachable: Firecrawl-backed portals produced ZERO rows this run"
                }
                $alerts += "routine '$($p.Name)' $fcDetail"
            }

            # Same independence, same reason. The Apply date exists only at the
            # instant the Stage select is flipped to "4. Applied" by hand;
            # nothing else records it and it cannot be reconstructed after the
            # fact. If the guard stops reporting, dates vanish again while the
            # drain keeps emitting a valid contract and the run keeps looking
            # healthy.
            #
            # KEEP THESE STRINGS ASCII, per the note above.
            if ($r.apply_date_rescue_missing) {
                $alerts += "routine '$($p.Name)' drain log has NO APPLY_DATE_RESCUE line - the apply-date guard did not report; Apply dates are being lost again"
            } elseif ($r.apply_date_rescue_failed -gt 0) {
                $alerts += "routine '$($p.Name)' apply-date rescue failed to write $($r.apply_date_rescue_failed) row(s); those flip dates are unrecoverable once the ledger prunes them"
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
