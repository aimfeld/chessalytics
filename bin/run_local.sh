#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# Kill existing backend/frontend processes if running.
# Use fuser to kill anything on the ports directly — pkill -f can miss
# orphaned uvicorn child processes (--reload spawns a watcher + worker).
#
# The vite pattern is deliberately scoped to THIS checkout's node_modules
# rather than the bare string "vite". `pkill -f "vite"` matched any process
# with "vite" anywhere in its command line — a parallel-worktree dev server
# (see .claude/skills/parallel-worktree), an editor, even a grep or the
# shell running this script — and silently killed them. The real dev server
# runs as `node <repo>/frontend/node_modules/.bin/vite --host`, so anchoring
# on the absolute repo path kills exactly our own server and nothing else.
# `fuser -k 5173/tcp` below remains the backstop for anything still holding
# the port.
pkill -f "uvicorn app.main:app" 2>/dev/null || true
pkill -f "${REPO_ROOT}/frontend/node_modules/.bin/vite" 2>/dev/null || true
fuser -k 8000/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true
sleep 1

# Fail fast if a local postgres process is already holding port 5432.
# Docker's port-forward shows up as "com.docke", not "postgres", so this
# correctly distinguishes a conflicting system Postgres from Docker itself.
if lsof -ti :5432 2>/dev/null | xargs -I{} ps -p {} -o comm= 2>/dev/null | grep -qi "postgres"; then
  echo "Error: a local PostgreSQL process is already listening on port 5432."
  echo "Stop your local PostgreSQL service before running this script."
  exit 1
fi

# Ensure dev database is running
echo "Starting dev database..."
docker compose -f docker-compose.dev.yml -p flawchess-dev up -d
until docker compose -f docker-compose.dev.yml -p flawchess-dev exec db pg_isready -U postgres -q 2>/dev/null; do
  sleep 1
done

# Install backend dependencies.
# Include the isolated maia-inference group to mirror CI and the backend Dockerfile
# (both sync it). A bare `uv sync` prunes it on every start, which breaks the pre-push
# `ty check` on app/services/maia_engine.py's deferred onnxruntime/numpy imports.
echo "Installing backend dependencies..."
uv sync --group maia-inference

# Run database migrations
echo "Running migrations..."
uv run alembic upgrade head

# Seed openings if table is empty (first-time setup only — skips instantly otherwise)
OPENINGS_COUNT=$(PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d flawchess -tAc "SELECT COUNT(*) FROM openings" 2>/dev/null || echo "0")
if [ "$OPENINGS_COUNT" -eq 0 ]; then
  echo "Seeding openings table..."
  uv run python -m scripts.seed_openings
fi

# Seed cohort CDF if table is empty (first-time setup only — skips instantly otherwise)
COHORT_CDF_COUNT=$(PGPASSWORD=postgres psql -h localhost -p 5432 -U postgres -d flawchess -tAc "SELECT COUNT(*) FROM benchmark_cohort_cdf" 2>/dev/null || echo "0")
if [ "$COHORT_CDF_COUNT" -eq 0 ]; then
  echo "Seeding cohort CDF table..."
  uv run python -m scripts.seed_cohort_cdf
fi

# Stockfish binary for local dev. Prod bakes the pinned sf_18 AVX2 binary into
# the backend image (see Dockerfile); locally we install the identical binary
# to ~/.local/stockfish/sf via bin/install_stockfish.sh. The installer is
# idempotent — once the pinned version is on disk, re-runs are a no-op.
echo "Ensuring Stockfish is installed..."
bin/install_stockfish.sh
export STOCKFISH_PATH="${STOCKFISH_PATH:-$HOME/.local/stockfish/sf}"

# Start backend
echo "Starting backend..."
uv run uvicorn app.main:app --reload --port 8000 &
BACKEND_PID=$!

# Start frontend
echo "Starting frontend..."
cd frontend
npm install
npm run dev:mobile &
FRONTEND_PID=$!
cd ..

echo ""
echo "Backend:  http://localhost:8000"
echo "Frontend: http://localhost:5173"
echo ""
echo "PIDs: backend=$BACKEND_PID frontend=$FRONTEND_PID"
echo "Press Ctrl+C to stop both."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
