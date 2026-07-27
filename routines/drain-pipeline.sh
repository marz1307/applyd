#!/bin/bash
# drain-pipeline.sh — bash replacement for the PowerShell drain driver.
#
# Loop auto-eval until Stage 1 is empty, then auto-draft until Stage 2 is
# empty. Bash + powershell.exe combo avoided the hidden-window /
# special-char issues that broke the .ps1 version.
#
# Usage:
#   ./routines/drain-pipeline.sh
#   nohup ./routines/drain-pipeline.sh > /tmp/drain.log 2>&1 &     # detached
#
# Safety caps: 12 iterations per phase; aborts on no-progress or
# non-zero wrapper exit.

set +e   # we handle errors per-iteration
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WRAPPER="$(cygpath -w "$REPO/routines/run-routine.ps1")"
cd "$REPO" || { echo "FATAL: cannot cd to $REPO"; exit 2; }

NOTION_TOKEN=$(powershell.exe -NoProfile -Command "[System.Environment]::GetEnvironmentVariable('NOTION_TOKEN', 'User')" | tr -d '\r')
if [ -z "$NOTION_TOKEN" ]; then echo "FATAL: NOTION_TOKEN not set in User scope"; exit 5; fi
export NOTION_TOKEN

TS=$(date +%Y-%m-%d_%H%M)
LOG="data/routine-logs/drain-pipeline-$TS.log"
exec > >(tee -a "$LOG") 2>&1

queue_depth() {
  node scripts/notion/notion-query.mjs --stage "$1" --json 2>/dev/null \
    | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null \
    || echo 0
}

fire_routine() {
  local routine="$1"
  echo "  -> firing $routine via wrapper"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$WRAPPER" -Routine "$routine"
  local code=$?
  echo "  <- $routine exited $code"
  return $code
}

phase_drain() {
  local label="$1" stage="$2" routine="$3" max_iter="$4"
  echo ""
  echo "== $label =="
  local last
  last=$(queue_depth "$stage")
  echo "Stage '$stage' depth at start: $last"
  for ((i=1; i<=max_iter; i++)); do
    if [ "$last" -le 0 ] 2>/dev/null; then
      echo "Queue empty after $((i-1)) iterations"
      return 0
    fi
    echo ""
    echo "[$label] Iteration $i / $max_iter — depth $last"
    fire_routine "$routine"
    local code=$?
    if [ $code -ne 0 ]; then
      echo "$routine exited $code — aborting phase"
      return $code
    fi
    sleep 10
    local new
    new=$(queue_depth "$stage")
    echo "[$label] depth after iter $i: $new (was $last)"
    if [ "$new" -ge "$last" ] 2>/dev/null; then
      echo "No progress — stopping phase to avoid runaway"
      return 0
    fi
    last=$new
  done
}

echo "=== drain-pipeline START $(date -Iseconds) ==="
phase_drain "Phase 1 (auto-eval, drain Stage 1)" "1. Discovered" "auto-eval"  12
phase_drain "Phase 2 (auto-draft, drain Stage 2)" "2. Triaged"   "auto-draft" 12

echo ""
echo "== Final state =="
echo "  Stage 1 Discovered: $(queue_depth '1. Discovered')"
echo "  Stage 2 Triaged:    $(queue_depth '2. Triaged')"
echo "  Stage 3 Drafted:    $(queue_depth '3. Drafted')"
echo ""
echo "Rebuilding dashboard..."
node scripts/dashboard/build-dashboard.mjs >/dev/null 2>&1 && echo "Dashboard rebuilt" || echo "Dashboard rebuild failed"
echo "=== drain-pipeline END $(date -Iseconds) ==="
