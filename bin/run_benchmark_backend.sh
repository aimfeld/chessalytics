#!/usr/bin/env bash
set -euo pipefail

# Launch the benchmark analysis backend on port 8001 (phase 212, runbook §3).
#
# This is the SECOND backend: it serves the worker fleet's fallback target while
# the ordinary dev backend keeps running on :8000 against the dev DB. Everything
# it needs that is safe to persist lives in .env; everything that is NOT safe to
# persist is set here, on the command line, by this script.
#
# WHY THE FLAGS ARE NOT IN .env — this is the whole point of the script.
# app/core/config.py loads .env for EVERY backend process, so a
# BENCHMARK_SELECTION_GATE_ENABLED or BENCHMARK_HOMOGENIZE_EVAL_SOURCE sitting
# there would silently apply to the dev backend on :8000 too, turning it into a
# selection-gated, eval-overwriting instance pointed at whatever DATABASE_URL it
# resolves. The runbook calls this out as a trap that fails silently. Putting the
# flags here gives you the one-command restart without that risk: the script IS
# the place they are written down.
#
# Usage:
#   bin/run_benchmark_backend.sh          # restart the :8001 backend
#
# Requires in .env:
#   DATABASE_URL_BENCHMARK          the write-capable benchmark DSN (port 5433)
#   EVAL_BENCHMARK_OPERATOR_TOKEN   this instance's own operator token
#
# The worker boxes present that same token as EVAL_FALLBACK_OPERATOR_TOKEN.

cd "$(dirname "$0")/.."

PORT=8001
ENV_FILE=".env"

read_env() {
  # Read one KEY=value from .env: strips surrounding quotes, a trailing \r from
  # a Windows-edited file, and nothing else. A stray \r in a token is a silent
  # 401 that looks exactly like a wrong token, so it is stripped here rather
  # than left for the operator to find.
  #
  # The `|| true` is load-bearing: under `set -euo pipefail` a grep that finds
  # nothing exits 1, failing the whole pipeline and killing the script inside the
  # command substitution -- so a MISSING key aborted silently, before the
  # explanatory error below could ever print. That is the exact case these
  # messages exist for.
  local key="$1"
  { grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null || true; } \
    | tail -1 \
    | cut -d= -f2- \
    | sed -e 's/\r$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Run from the repo root." >&2
  exit 1
fi

DB_URL="$(read_env DATABASE_URL_BENCHMARK)"
BENCH_TOKEN="$(read_env EVAL_BENCHMARK_OPERATOR_TOKEN)"

if [ -z "$DB_URL" ]; then
  echo "Error: DATABASE_URL_BENCHMARK is not set in $ENV_FILE." >&2
  exit 1
fi

if [ -z "$BENCH_TOKEN" ]; then
  cat >&2 <<'MSG'
Error: EVAL_BENCHMARK_OPERATOR_TOKEN is not set in .env.

This instance needs its OWN operator token, distinct from prod's, so a worker
pointed at prod cannot lease from it by accident. Generate one and add it:

    echo "EVAL_BENCHMARK_OPERATOR_TOKEN=$(openssl rand -hex 24)" >> .env

Then put the SAME value on every worker box as EVAL_FALLBACK_OPERATOR_TOKEN.
MSG
  exit 1
fi

# Guard: the write-capable role, never the read-only one the MCP tool uses.
# _ro fails on the first write with InsufficientPrivilegeError, minutes into a
# run rather than at startup.
case "$DB_URL" in
  *flawchess_benchmark_ro:*)
    echo "Error: DATABASE_URL_BENCHMARK uses the READ-ONLY role (flawchess_benchmark_ro)." >&2
    echo "The backend needs the write-capable flawchess_benchmark role." >&2
    exit 1
    ;;
esac

# Guard: port 5433, never 5432. A benchmark backend pointed at the dev DB would
# analyze and overwrite dev data while every log line still says "benchmark".
case "$DB_URL" in
  *:5433/*) ;;
  *)
    echo "Error: DATABASE_URL_BENCHMARK does not point at port 5433 (the benchmark DB)." >&2
    echo "Refusing to start: a benchmark backend on the dev DB would overwrite dev data." >&2
    exit 1
    ;;
esac

if ! docker compose -f docker-compose.benchmark.yml -p flawchess-benchmark ps --status running 2>/dev/null | grep -q db; then
  echo "Benchmark database is not running. Start it with:" >&2
  echo "  bin/benchmark_db.sh start" >&2
  exit 1
fi

# Free the port. A previous instance still holding :8001 would make uvicorn exit
# with "address already in use" AFTER the fleet has been reconfigured to point
# at it, which reads as a LAN problem from the worker side.
echo "Stopping anything on port ${PORT}..."
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 1

export STOCKFISH_PATH="${STOCKFISH_PATH:-$HOME/.local/stockfish/sf}"

cat <<MSG

Starting the benchmark backend on port ${PORT}.

  database          benchmark (port 5433, write-capable role)
  selection gate    ON   — the fleet can only touch benchmark_selection games
  homogenization    ON   — the lichess arm is re-analyzed by our own engine
  Stockfish pool    1    — this instance submits and runs Maia; the fleet
                          supplies Stockfish throughput (D-15)

WATCH THE STARTUP LOG FOR MAIA. A Maia-absent backend produces PV normally but
NEVER stamps best_moves_completed_at, and row counts cannot tell the two apart
afterwards. If Maia did not load, stop now rather than draining against it.

MSG

# The five mandatory flags (runbook §3), deliberately inline rather than in .env.
# DATABASE_URL — plain, never DATABASE_URL_BENCHMARK: the app and Alembic only
# read DATABASE_URL, so setting only the benchmark-specific name silently points
# this backend at the DEV database.
DATABASE_URL="$DB_URL" \
EVAL_AUTO_DRAIN_ENABLED=true \
BEST_MOVE_BACKFILL_ENABLED=true \
BENCHMARK_SELECTION_GATE_ENABLED=true \
BENCHMARK_HOMOGENIZE_EVAL_SOURCE=true \
STOCKFISH_POOL_SIZE=1 \
EVAL_OPERATOR_TOKEN="$BENCH_TOKEN" \
exec uv run uvicorn app.main:app --port "$PORT" --host 0.0.0.0
