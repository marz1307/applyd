# routines/adapters/claude.ps1
#
# Claude Code adapter for run-routine.ps1. This is the REFERENCE
# implementation: the wrapper's env stripping, subscription check,
# strict-MCP flags, and --allowedTools handling all live here.
#
# Selected by run-routine.ps1 when $env:CAREER_OPS_AGENT_CLI is unset or
# "claude" (default). Other CLIs get their own sibling adapter.
#
# Contract:
#   - Takes: -Prompt (path), -Log (path), -Timeout (int seconds),
#            optional -Model, -AllowedTools, -McpConfig, -RepoRoot.
#   - Launches `claude -p` with the prompt on stdin, stdout+stderr
#     appended to $Log, and returns the underlying CLI's exit code.
#   - Exit code 124 signals a wall-clock timeout (POSIX convention;
#     the wrapper's failure classifier treats it as TIMEOUT).
#   - The wrapper still owns log-capture setup, contract validation,
#     retries, and dashboard rebuild - only the CLI invocation is
#     swappable.

param(
    [Parameter(Mandatory=$true)][string]$Prompt,
    [Parameter(Mandatory=$true)][string]$Log,
    [Parameter(Mandatory=$true)][int]$Timeout,
    [string]$Model = "",
    [string]$AllowedTools = "",
    [string]$McpConfig = "",
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Continue"

# ── Resolve the Claude executable ────────────────────────────────────
$claudeExe = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claudeExe) { $claudeExe = Join-Path $env:USERPROFILE ".local\bin\claude.exe" }
if (-not (Test-Path $claudeExe)) {
    "ADAPTER_ERROR: claude executable not found (checked PATH + $env:USERPROFILE\.local\bin\claude.exe)" |
        Out-File -FilePath $Log -Append -Encoding UTF8
    exit 2
}

# ── BILLING ISOLATION (critical for Claude subscription users) ───────
# claude.exe switches to metered API-credit billing whenever it sees
# ANTHROPIC_API_KEY in its environment. Users on the Claude subscription
# plan want OAuth-token auth instead. Strip the key from the Process env
# here so claude.exe falls back to its subscription OAuth login. Belt-
# and-suspenders - the wrapper's job is orchestration, not billing.
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $null, "Process")

$leakedKey = [System.Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "Process")
if (-not [string]::IsNullOrEmpty($leakedKey)) {
    "ADAPTER_ERROR: BILLING LEAK - ANTHROPIC_API_KEY is still set in the process env. claude.exe would bill API credits instead of the subscription. Aborting." |
        Out-File -FilePath $Log -Append -Encoding UTF8
    exit 7
}

# Optional: confirm a Claude subscription OAuth login exists. If none is
# present AND the environment has stripped the API key, claude -p has no
# auth path at all. Users on API-credit-only plans can safely delete this
# block (they'd re-add ANTHROPIC_API_KEY above and comment out the strip).
$claudeCredsCandidates = @(
    (Join-Path $env:USERPROFILE ".claude\.credentials.json"),
    (Join-Path $env:APPDATA     "claude\.credentials.json"),
    (Join-Path $env:USERPROFILE ".config\claude\.credentials.json")
)
$subscriptionType = $null
foreach ($cand in $claudeCredsCandidates) {
    if (Test-Path $cand) {
        try {
            $creds = Get-Content $cand -Raw | ConvertFrom-Json
            if ($creds.claudeAiOauth -and $creds.claudeAiOauth.accessToken) {
                $subscriptionType = $creds.claudeAiOauth.subscriptionType
                break
            }
        } catch {}
    }
}
if ([string]::IsNullOrEmpty($subscriptionType)) {
    "ADAPTER_ERROR: NO SUBSCRIPTION LOGIN - claude.exe has no claudeAiOauth credential. With ANTHROPIC_API_KEY stripped, claude -p has no auth. Run ``claude`` interactively, log in, then retry." |
        Out-File -FilePath $Log -Append -Encoding UTF8
    exit 7
}

# ── Build the cmd.exe /c invocation ──────────────────────────────────
# Quoting note: cmd's /c parser has a rule that with MORE than two quote
# characters and any special chars, it strips the OUTER pair and parses
# the rest with embedded quotes preserved. So we wrap the whole command
# in an extra outer `"..."` pair.
$modelArg = if (-not [string]::IsNullOrEmpty($Model)) { "--model $Model " } else { "" }
$mcpArg   = if (-not [string]::IsNullOrEmpty($McpConfig)) { "--strict-mcp-config --mcp-config `"$McpConfig`" " } else { "" }
$toolsArg = if (-not [string]::IsNullOrEmpty($AllowedTools)) { "--allowedTools `"$AllowedTools`" " } else { "" }
$cmdArgs  = "/c `"`"$claudeExe`" -p --output-format text $modelArg$mcpArg$toolsArg< `"$Prompt`" >> `"$Log`" 2>&1`""

# ── Launch and enforce wall-clock timeout ────────────────────────────
$exitCode = 0
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName         = "cmd.exe"
    $psi.Arguments        = $cmdArgs
    $psi.WorkingDirectory = if ($RepoRoot) { $RepoRoot } else { $PWD.Path }
    $psi.UseShellExecute  = $false
    $psi.CreateNoWindow   = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc.WaitForExit($Timeout * 1000)) {
        try { taskkill /PID $proc.Id /T /F | Out-Null } catch {}
        try { $proc.WaitForExit(2000) | Out-Null } catch {}
        "`nADAPTER_TIMEOUT: claude -p exceeded $Timeout seconds; process tree killed" |
            Out-File -FilePath $Log -Append -Encoding UTF8
        exit 124
    }
    try { $proc.WaitForExit() } catch {}
    $exitCode = [int]$proc.ExitCode
} catch {
    "`nADAPTER_EXCEPTION: $_" | Out-File -FilePath $Log -Append -Encoding UTF8
    exit 3
}
exit $exitCode
