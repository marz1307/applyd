# routines/adapters/gemini.ps1
#
# Gemini adapter - best-effort; test locally before scheduling.
#
# Selected by run-routine.ps1 when $env:CAREER_OPS_AGENT_CLI = "gemini".
#
# Contract (matches claude.ps1 for wrapper compatibility):
#   - Takes: -Prompt (path), -Log (path), -Timeout (int seconds),
#            optional -Model, -AllowedTools, -McpConfig, -RepoRoot.
#   - Ignores -AllowedTools and -McpConfig (Gemini CLI configures MCP
#     through ~/.gemini/settings.json - not portable across CLIs).
#   - Launches `gemini -p` with the prompt on stdin, stdout+stderr
#     appended to $Log, and returns the underlying CLI's exit code.
#   - Exit code 124 signals a wall-clock timeout.
#
# STUB - verified only against `--help` at check-in. Try `system-eval`
# (read-only) first, then a paid routine only after you've watched a
# manual run succeed end-to-end.

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

$geminiExe = (Get-Command gemini -ErrorAction SilentlyContinue).Source
if (-not $geminiExe) {
    "ADAPTER_ERROR: gemini executable not found on PATH. Install via https://github.com/google-gemini/gemini-cli" |
        Out-File -FilePath $Log -Append -Encoding UTF8
    exit 2
}

$modelArg = if (-not [string]::IsNullOrEmpty($Model)) { "--model `"$Model`" " } else { "" }
$cmdArgs  = "/c `"`"$geminiExe`" -p $modelArg< `"$Prompt`" >> `"$Log`" 2>&1`""

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
        "`nADAPTER_TIMEOUT: gemini -p exceeded $Timeout seconds; process tree killed" |
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
