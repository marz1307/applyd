$ErrorActionPreference = "Continue"
$repo = $PSScriptRoot | Split-Path
$lockFile = Join-Path $repo "data\dashboard-heartbeat.lock"
$logFile = Join-Path $repo "data\dashboard-heartbeat.log"

if (Test-Path $lockFile) {
    $oldPid = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($proc) {
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Add-Content -Path $logFile -Value "$ts SKIP previous heartbeat still running pid $oldPid"
            exit 0
        }
    }
}
$PID | Out-File -FilePath $lockFile -Encoding UTF8 -Force
Set-Location $repo

$tok = [System.Environment]::GetEnvironmentVariable("NOTION_TOKEN", "User")
if ([string]::IsNullOrEmpty($tok)) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "$ts SKIP NOTION_TOKEN unset"
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    exit 0
}
[System.Environment]::SetEnvironmentVariable("NOTION_TOKEN", $tok, "Process")

$buildPsi = New-Object System.Diagnostics.ProcessStartInfo
$buildPsi.FileName = "node.exe"
$buildPsi.Arguments = "scripts/dashboard/build-dashboard.mjs"
$buildPsi.WorkingDirectory = $repo
$buildPsi.UseShellExecute = $false
$buildPsi.CreateNoWindow = $true
$buildPsi.RedirectStandardOutput = $true
$buildPsi.RedirectStandardError = $true
$buildProc = [System.Diagnostics.Process]::Start($buildPsi)
$buildOk = $buildProc.WaitForExit(90000)
$buildExit = if ($buildOk) { $buildProc.ExitCode } else { -1 }
if (-not $buildOk) { try { $buildProc.Kill() } catch {} }

# GitHub Pages publish DISABLED 2026-06-24 — dashboard is now LOCAL-ONLY.
# build-dashboard.mjs writes a self-contained dashboard.html (data embedded,
# opens from file://) on this same heartbeat schedule. Nothing is pushed to
# the public repo. To re-enable a public push, run: node scripts/dashboard/build-dashboard.mjs --publish
$pubExit = "disabled"

$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $logFile -Value "$ts build_exit=$buildExit publish_exit=$pubExit"
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
