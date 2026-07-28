#!/usr/bin/env bash
# scripts/install-firecrawl.sh
#
# Idempotent self-hosted Firecrawl installer for applyd Step −1
# (URL ↔ JD coherence). Run once during onboarding when the user picks
# "Self-host (Docker required, no keys)" — re-running is safe.
#
# Behaviour:
#   1. Check Docker + docker compose are present. If missing, exit code 2
#      so the calling skill can fall back to the Cloud / Skip prompts.
#   2. Clone (or fast-forward) the Firecrawl repo to ~/.applyd/firecrawl.
#   3. docker compose build && docker compose up -d.
#   4. Wait up to 60s for the /health endpoint on http://localhost:3002.
#   5. Write FIRECRAWL_URL into the workspace .env (if --workspace is given).
#
# Usage:
#   ./install-firecrawl.sh                       # install + start
#   ./install-firecrawl.sh --workspace ~/career  # also writes to that .env
#   ./install-firecrawl.sh --status              # only checks current state
#   ./install-firecrawl.sh --stop                # docker compose down
#
# Exit codes:
#   0  Firecrawl is up and responding on :3002
#   2  Docker missing (caller should offer Cloud/Skip)
#   3  Firecrawl container failed to start
#   4  Health check timed out

set -euo pipefail

FIRECRAWL_DIR="${FIRECRAWL_DIR:-$HOME/.applyd/firecrawl}"
FIRECRAWL_REPO="https://github.com/firecrawl/firecrawl.git"
FIRECRAWL_PORT=3002
HEALTH_TIMEOUT=60

cmd="install"
workspace=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) workspace="$2"; shift 2 ;;
    --status) cmd="status"; shift ;;
    --stop) cmd="stop"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── helpers ─────────────────────────────────────────────────────────────

have() { command -v "$1" >/dev/null 2>&1; }

check_docker() {
  if ! have docker; then
    echo "✗ Docker not installed. Install from https://docker.com or pick the Cloud / Skip option."
    exit 2
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "✗ Docker is installed but not running. Start Docker Desktop (or the dockerd service) and retry."
    exit 2
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "✗ docker compose plugin missing. Update Docker Desktop, or install the docker-compose-plugin package."
    exit 2
  fi
}

wait_healthy() {
  local elapsed=0
  echo -n "Waiting for Firecrawl /health on :${FIRECRAWL_PORT} "
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    if curl -sf "http://localhost:${FIRECRAWL_PORT}/health" >/dev/null 2>&1; then
      echo " ✓"
      return 0
    fi
    echo -n "."
    sleep 2
    elapsed=$((elapsed + 2))
  done
  echo " ✗ (timed out after ${HEALTH_TIMEOUT}s)"
  return 1
}

write_env() {
  [[ -z "$workspace" ]] && return 0
  local envfile="${workspace%/}/.env"
  mkdir -p "$workspace"
  touch "$envfile"
  # Replace existing FIRECRAWL_URL line or append.
  if grep -qE '^FIRECRAWL_URL=' "$envfile"; then
    # Portable sed inline edit.
    sed -i.bak -E "s|^FIRECRAWL_URL=.*|FIRECRAWL_URL=http://localhost:${FIRECRAWL_PORT}|" "$envfile" && rm -f "${envfile}.bak"
  else
    echo "FIRECRAWL_URL=http://localhost:${FIRECRAWL_PORT}" >> "$envfile"
  fi
  echo "✓ Wrote FIRECRAWL_URL to ${envfile}"
}

# ── status ─────────────────────────────────────────────────────────────

if [[ "$cmd" == "status" ]]; then
  if curl -sf "http://localhost:${FIRECRAWL_PORT}/health" >/dev/null 2>&1; then
    echo "✓ Firecrawl is up on http://localhost:${FIRECRAWL_PORT}"
    exit 0
  fi
  echo "✗ Firecrawl is not responding on :${FIRECRAWL_PORT}"
  exit 4
fi

# ── stop ───────────────────────────────────────────────────────────────

if [[ "$cmd" == "stop" ]]; then
  check_docker
  if [[ -d "$FIRECRAWL_DIR" ]]; then
    (cd "$FIRECRAWL_DIR" && docker compose down)
    echo "✓ Firecrawl stopped"
  else
    echo "No Firecrawl install at $FIRECRAWL_DIR — nothing to stop."
  fi
  exit 0
fi

# ── install / start ────────────────────────────────────────────────────

check_docker

if [[ ! -d "$FIRECRAWL_DIR/.git" ]]; then
  echo "Cloning Firecrawl into $FIRECRAWL_DIR…"
  mkdir -p "$(dirname "$FIRECRAWL_DIR")"
  git clone --depth 1 "$FIRECRAWL_REPO" "$FIRECRAWL_DIR"
else
  echo "Updating existing Firecrawl checkout at $FIRECRAWL_DIR…"
  (cd "$FIRECRAWL_DIR" && git fetch --depth 1 origin main && git reset --hard origin/main)
fi

cd "$FIRECRAWL_DIR"

# Minimal .env for the Firecrawl OSS stack — PORT + HOST are the only
# required vars per SELF_HOST.md. All other features (LLM extract, proxies,
# auth, search) stay opt-in and are off by default.
if [[ ! -f .env ]]; then
  cat > .env <<EOF
PORT=${FIRECRAWL_PORT}
HOST=0.0.0.0
BULL_AUTH_KEY=$(date +%s)-$(head -c 8 /dev/urandom 2>/dev/null | base64 | tr -d '/+=' || echo "applyd")
EOF
  echo "✓ Wrote $FIRECRAWL_DIR/.env"
fi

echo "Building Firecrawl Docker images (first run takes a few minutes)…"
docker compose build 2>&1 | tail -5

echo "Starting Firecrawl…"
docker compose up -d

if ! wait_healthy; then
  echo "✗ Firecrawl container didn't pass health check. Try:"
  echo "    cd $FIRECRAWL_DIR && docker compose logs --tail 50"
  exit 4
fi

write_env

echo
echo "✓ Firecrawl is up at http://localhost:${FIRECRAWL_PORT}"
echo "  Admin queues UI: http://localhost:${FIRECRAWL_PORT}/admin/CHANGEME/queues"
echo "  Stop:  bash $(realpath "$0") --stop"
echo "  Status: bash $(realpath "$0") --status"
