# routines/adapters/codex.ps1
#
# Codex CLI adapter - 'codex exec' runs a headless prompt. Approval flags
# OFF by default for safety (routines that need shell / file writes must
# opt in per-invocation; the wrapper's --allowedTools list is Claude-
# specific and is deliberately ignored here).
#
# Selected by run-routine.ps1 when $env:CAREER_OPS_AGENT_CLI = "codex".
#
# Contract (matches claude.ps1 for wrapper compatibility):
#   - Takes: -Prompt (path), -Log (path), -Timeout (int seconds),
#            optional -Model, -AllowedTools, -McpConfig, -RepoRoot.
#   - Ignores -AllowedTools and -McpConfig (Codex handles MCP via
#     ~/.codex/config.toml and permissions via its own approval-mode
#     flags - not portable across CLIs).
#   - Launches `codex exec` with the prompt on stdin, stdout+stderr
#     appended to $Log, and returns the underlying CLI's exit code.
#   - Exit code 124 signals a wall-clock timeout.
#
# NOT YET BATTLE-TESTED against every routine. Verify locally with
# `system-eval` (read-only) before scheduling anything paid or mutating.

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

$codexExe = (Get-Command codex -ErrorAction SilentlyContinue).Source
if (-not $codexExe) {
    "ADAPTER_ERROR: codex executable not found on PATH. Install via https://github.com/openai/codex" |
        Out-File -FilePath $Log -Append -Encoding UTF8
    exit 2
}

# Codex takes the prompt as a POSITIONAL arg (not stdin) in most recent
# releases. Read the prompt file and pass its contents. Fall back to
# stdin redirection if the file is very large (Codex's arg parser has a
# ~32KB limit on Windows cmd.exe).
$modelArg = if (-not [string]::IsNullOrEmpty($Model)) { "--model `"$Model`" " } else { "" }

$promptSize = (Get-Item $Prompt).Length
if ($promptSize -lt 30000) {
    # Small enough: pass via file redirection (portable across cmd versions).
    $cmdArgs = "/c `"`"$codexExe`" exec $modelArg< `"$Prompt`" >> `"$Log`" 2>&1`""
} else {
    # Large prompt: try positional arg form. Codex's exec subcommand
    # accepts a trailing prompt string.
    $promptText = Get-Content $Prompt -Raw
    $escapedPrompt = $promptText -replace '"', '\"'
    $cmdArgs = "/c `"`"$codexExe`" exec $modelArg`"$escapedPrompt`" >> `"$Log`" 2>&1`""
}

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
        "`nADAPTER_TIMEOUT: codex exec exceeded $Timeout seconds; process tree killed" |
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
