# normalise-schedule.example.ps1 — collapse per-day duplicate Windows Task
# Scheduler tasks (e.g. shadow Tue/Wed/Thu entries at different times) into
# ONE task per routine, firing at the SAME time every weekday.
#
# COPY THIS FILE to `normalise-schedule.ps1` and replace <APPLYD_TASK_PREFIX>
# below with the prefix your installation uses (e.g. `Applyd_`, `CareerOps_`,
# or whatever you registered your scheduled tasks under). Task Scheduler
# prefixes are user-specific, so this file ships as an .example.ps1 rather
# than a working script.
#
# WHY THIS EXISTS
# Task Scheduler schedules can drift into per-day duplicates with different
# times (e.g. `<prefix>MorningScan` fires Mon/Fri at 07:00 and
# `<prefix>MorningScan_Tue`/`_Wed`/`_Thu` fires at a different time). That
# turns four separate tasks into four separate chances to drift out of sync.
# Some routines already use the right shape — a single task with
# DaysOfWeek=Mon-Fri — so this brings the rest into line rather than
# inventing a new convention.
#
# BEFORE RUNNING: back up every affected task's XML to
#   data\.taskscheduler-backup-<date>-xml\<TaskName>.xml
# via `Export-ScheduledTask -TaskName <n> | Out-File <path>.xml -Encoding UTF8`
# so you can restore with `Register-ScheduledTask -Xml (Get-Content <file> -Raw)
# -TaskName <n>` if a collapse loses behaviour you wanted.
#
# WHY IT IS A SCRIPT AND NOT INLINE COMMANDS
#  1. Set-ScheduledTask on these tasks needs ELEVATION. They are S4U ("run
#     whether user is logged on or not") and modifying an S4U definition is
#     privileged; unelevated it fails with "Access is denied". Disable works
#     unelevated, Set does not.
#  2. If your repo has a guard that blocks Unregister-ScheduledTask and
#     `schtasks /delete|/change` (a sensible safety, so an autonomous routine
#     cannot delete its own scheduling), running this file by hand is the
#     sanctioned path.
#
# RUN AS ADMINISTRATOR:
#   powershell -NoProfile -ExecutionPolicy Bypass -File routines\normalise-schedule.ps1
#
# Idempotent: safe to re-run. Already-correct tasks are reported as OK and left
# alone; already-deleted ones are skipped.

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

# Replace <APPLYD_TASK_PREFIX> with your Task Scheduler prefix. Every task name
# below assumes tasks are registered as `<PREFIX>MorningScan`, etc.
$PREFIX = '<APPLYD_TASK_PREFIX>'
if ($PREFIX -like '*<APPLYD_TASK_PREFIX>*') {
    Write-Host "ERROR: Replace <APPLYD_TASK_PREFIX> in this file with your Task Scheduler prefix (e.g. 'Applyd_') before running." -ForegroundColor Red
    exit 2
}

$WEEKDAYS = [DayOfWeek]::Monday, [DayOfWeek]::Tuesday, [DayOfWeek]::Wednesday,
            [DayOfWeek]::Thursday, [DayOfWeek]::Friday

# Times follow a scan -> bulk-scan -> pace -> eval -> draft -> referral ->
# interview-prep flow. Each stage feeds the next, so the ordering is
# load-bearing, not cosmetic. Adjust the times to match your own pipeline.
$UNIFORM = @(
  @{ Task = "${PREFIX}MorningScan";   Time = '07:00'; Drop = @("${PREFIX}MorningScan_Tue","${PREFIX}MorningScan_Wed","${PREFIX}MorningScan_Thu") }
  @{ Task = "${PREFIX}BdBulkScan";    Time = '11:30'; Drop = @("${PREFIX}BdBulkScan_Tue","${PREFIX}BdBulkScan_Thu") }
  @{ Task = "${PREFIX}PaceCheck";     Time = '17:00'; Drop = @() }
  @{ Task = "${PREFIX}AutoEval";      Time = '21:00'; Drop = @("${PREFIX}AutoEval_Tue","${PREFIX}AutoEval_Wed","${PREFIX}AutoEval_Thu") }
  @{ Task = "${PREFIX}AutoDraft";     Time = '21:30'; Drop = @("${PREFIX}AutoDraft_Tue","${PREFIX}AutoDraft_Wed","${PREFIX}AutoDraft_Thu") }
  @{ Task = "${PREFIX}ReferralScout"; Time = '21:45'; Drop = @() }
)

# Populate with names of tasks you retired (kept in Task Scheduler as Disabled
# rather than deleted). Leaving them around is exactly the ambiguity being
# cleaned up here — a disabled task still shows in every listing and gets
# re-questioned at each audit.
$RETIRED = @()

Write-Host "`n=== 1. uniform weekday triggers ===" -ForegroundColor Cyan
foreach ($u in $UNIFORM) {
  $t = Get-ScheduledTask -TaskName $u.Task -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host ("  MISSING  {0}" -f $u.Task) -ForegroundColor Yellow; continue }
  Set-ScheduledTask -TaskName $u.Task -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $WEEKDAYS -At $u.Time) | Out-Null
  Write-Host ("  SET      {0,-30} {1}  Mon-Fri" -f $u.Task, $u.Time) -ForegroundColor Green
}

# Optional: interview-prep can deliberately stay on a two-day cadence (Wed+Thu)
# rather than every weekday, because it is often the most LLM-expensive
# routine and promoting it to five fires a week risks starving the rest of
# the pipeline. Uncomment if that applies to your setup.
# Write-Host "`n=== 2. interview-prep: unify time, keep Wed+Thu cadence ===" -ForegroundColor Cyan
# foreach ($p in @(@{T="${PREFIX}AutoInterviewPrep_WedPM";D='Wednesday'}, @{T="${PREFIX}AutoInterviewPrep_Thu";D='Thursday'})) {
#   if (Get-ScheduledTask -TaskName $p.T -ErrorAction SilentlyContinue) {
#     Set-ScheduledTask -TaskName $p.T -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $p.D -At '22:00') | Out-Null
#     Write-Host ("  SET      {0,-34} 22:00  {1}" -f $p.T, $p.D) -ForegroundColor Green
#   }
# }

Write-Host "`n=== 3. delete redundant per-day duplicates ===" -ForegroundColor Cyan
foreach ($u in $UNIFORM) {
  foreach ($d in $u.Drop) {
    if (Get-ScheduledTask -TaskName $d -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $d -Confirm:$false
      Write-Host ("  DELETED  {0}" -f $d) -ForegroundColor Green
    } else { Write-Host ("  gone     {0}" -f $d) -ForegroundColor DarkGray }
  }
}

Write-Host "`n=== 4. delete retired routines ===" -ForegroundColor Cyan
foreach ($r in $RETIRED) {
  if (Get-ScheduledTask -TaskName $r -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $r -Confirm:$false
    Write-Host ("  DELETED  {0}  (retired)" -f $r) -ForegroundColor Green
  } else { Write-Host ("  gone     {0}" -f $r) -ForegroundColor DarkGray }
}

# Task Scheduler defaults DisallowStartIfOnBatteries to true, so on a laptop
# the action silently no-ops while /Run still reports success. Re-applied here
# because Set-ScheduledTask -Trigger can reset settings.
Write-Host "`n=== 5. re-apply battery/availability settings ===" -ForegroundColor Cyan
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                                         -StartWhenAvailable -MultipleInstances IgnoreNew
foreach ($t in Get-ScheduledTask -TaskName "${PREFIX}*") {
  try { Set-ScheduledTask -TaskName $t.TaskName -Settings $settings | Out-Null }
  catch { Write-Host ("  WARN {0}: {1}" -f $t.TaskName, $_.Exception.Message) -ForegroundColor Yellow }
}
Write-Host ("  applied to all {0}* tasks" -f $PREFIX) -ForegroundColor Green

Write-Host "`n=== 6. verification ===" -ForegroundColor Cyan
Get-ScheduledTask -TaskName "${PREFIX}*" | ForEach-Object {
  $t = $_
  foreach ($trg in $t.Triggers) {
    [PSCustomObject]@{
      Task  = $t.TaskName
      State = "$($t.State)"
      Time  = if ($trg.StartBoundary) { ([datetime]$trg.StartBoundary).ToString('HH:mm') } else { '-' }
      Days  = if ($trg.DaysOfWeek) { $trg.DaysOfWeek } else { 'daily' }
    }
  }
} | Sort-Object Time, Task | Format-Table -AutoSize

$n = (Get-ScheduledTask -TaskName "${PREFIX}*").Count
Write-Host ("task count: {0}" -f $n) -ForegroundColor Cyan
Write-Host "Days=62 means Mon-Fri. Anything still showing a day-of-week bitmask like 34/4/8/16 did not collapse.`n"
