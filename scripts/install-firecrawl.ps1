# scripts/install-firecrawl.ps1
#
# Windows-native counterpart to install-firecrawl.sh. Same exit codes,
# same behaviour, runs under PowerShell 5+ / 7+.
#
# Usage:
#   .\install-firecrawl.ps1                          # install + start
#   .\install-firecrawl.ps1 -Workspace C:\workspace  # also writes to that .env
#   .\install-firecrawl.ps1 -Status                  # only checks current state
#   .\install-firecrawl.ps1 -Stop                    # docker compose down
#
# Exit codes:
#   0  Firecrawl is up and responding on :3002
#   2  Docker missing (caller should offer Cloud/Skip)
#   3  Firecrawl container failed to start
#   4  Health check timed out

param(
    [string]$Workspace = "",
    [switch]$Status,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$FirecrawlDir  = if ($env:FIRECRAWL_DIR) { $env:FIRECRAWL_DIR } else { Join-Path $env:USERPROFILE ".applyd\firecrawl" }
$FirecrawlRepo = "https://github.com/firecrawl/firecrawl.git"
$Port          = 3002
$HealthTimeout = 60

# ── helpers ─────────────────────────────────────────────────────────────

function Have-Cmd($cmd) {
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Check-Docker {
    if (-not (Have-Cmd 'docker')) {
        Write-Host "✗ Docker not installed. Install Docker Desktop from https://docker.com or pick the Cloud / Skip option." -ForegroundColor Red
        exit 2
    }
    try { docker info | Out-Null } catch {
        Write-Host "✗ Docker is installed but not running. Start Docker Desktop and retry." -ForegroundColor Red
        exit 2
    }
    try { docker compose version | Out-Null } catch {
        Write-Host "✗ docker compose plugin missing. Update Docker Desktop." -ForegroundColor Red
        exit 2
    }
}

function Wait-Healthy {
    Write-Host -NoNewline "Waiting for Firecrawl /health on :$Port "
    $elapsed = 0
    while ($elapsed -lt $HealthTimeout) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { Write-Host " ✓" -ForegroundColor Green; return $true }
        } catch {}
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
    Write-Host " ✗ (timed out after ${HealthTimeout}s)" -ForegroundColor Red
    return $false
}

function Write-WorkspaceEnv {
    if (-not $Workspace) { return }
    $envFile = Join-Path $Workspace ".env"
    if (-not (Test-Path $Workspace)) { New-Item -ItemType Directory -Force -Path $Workspace | Out-Null }
    if (-not (Test-Path $envFile)) { New-Item -ItemType File -Force -Path $envFile | Out-Null }
    $lines = Get-Content $envFile
    if ($lines -match '^FIRECRAWL_URL=') {
        $lines = $lines -replace '^FIRECRAWL_URL=.*', "FIRECRAWL_URL=http://localhost:$Port"
    } else {
        $lines += "FIRECRAWL_URL=http://localhost:$Port"
    }
    Set-Content -Path $envFile -Value $lines
    Write-Host "✓ Wrote FIRECRAWL_URL to $envFile" -ForegroundColor Green
}

# ── status ─────────────────────────────────────────────────────────────

if ($Status) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            Write-Host "✓ Firecrawl is up on http://localhost:$Port" -ForegroundColor Green
            exit 0
        }
    } catch {}
    Write-Host "✗ Firecrawl is not responding on :$Port" -ForegroundColor Red
    exit 4
}

# ── stop ───────────────────────────────────────────────────────────────

if ($Stop) {
    Check-Docker
    if (Test-Path $FirecrawlDir) {
        Push-Location $FirecrawlDir
        docker compose down
        Pop-Location
        Write-Host "✓ Firecrawl stopped" -ForegroundColor Green
    } else {
        Write-Host "No Firecrawl install at $FirecrawlDir — nothing to stop."
    }
    exit 0
}

# ── install / start ────────────────────────────────────────────────────

Check-Docker

if (-not (Test-Path (Join-Path $FirecrawlDir ".git"))) {
    Write-Host "Cloning Firecrawl into $FirecrawlDir…"
    New-Item -ItemType Directory -Force -Path (Split-Path $FirecrawlDir -Parent) | Out-Null
    git clone --depth 1 $FirecrawlRepo $FirecrawlDir
} else {
    Write-Host "Updating existing Firecrawl checkout at $FirecrawlDir…"
    Push-Location $FirecrawlDir
    git fetch --depth 1 origin main
    git reset --hard origin/main
    Pop-Location
}

Push-Location $FirecrawlDir

if (-not (Test-Path .env)) {
    $bull = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(8)).TrimEnd('=').Replace('/','').Replace('+','')
    @"
PORT=$Port
HOST=0.0.0.0
BULL_AUTH_KEY=$bull
"@ | Set-Content -Path .env
    Write-Host "✓ Wrote $FirecrawlDir\.env" -ForegroundColor Green
}

Write-Host "Building Firecrawl Docker images (first run takes a few minutes)…"
docker compose build | Select-Object -Last 5

Write-Host "Starting Firecrawl…"
docker compose up -d

if (-not (Wait-Healthy)) {
    Write-Host "✗ Firecrawl container didn't pass health check. Try:" -ForegroundColor Red
    Write-Host "    cd $FirecrawlDir; docker compose logs --tail 50"
    Pop-Location
    exit 4
}

Pop-Location

Write-WorkspaceEnv

Write-Host ""
Write-Host "✓ Firecrawl is up at http://localhost:$Port" -ForegroundColor Green
Write-Host "  Admin queues UI: http://localhost:$Port/admin/CHANGEME/queues"
Write-Host "  Stop:   .\install-firecrawl.ps1 -Stop"
Write-Host "  Status: .\install-firecrawl.ps1 -Status"
