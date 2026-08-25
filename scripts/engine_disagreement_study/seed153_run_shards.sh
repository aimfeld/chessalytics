#!/usr/bin/env bash
# SEED-153 step 2 driver: sample + scan a range of shards, sequentially.
#
# Sequential by design. Each shard's Maia scan already saturates the box with
# 12 worker processes (measured: throughput plateaus at ~8 workers), so running
# two shards at once would halve each one's rate and buy nothing.
#
# Resumable: a shard whose incidence JSON already exists is skipped, so the
# driver can be re-run after a crash or an interrupt without redoing work.
#
# Usage: scripts/engine_disagreement_study/seed153_run_shards.sh FIRST LAST
set -euo pipefail

FIRST="${1:?first shard}"
LAST="${2:?last shard}"
NUM_SHARDS="${NUM_SHARDS:-160}"
WORKERS="${WORKERS:-12}"
DATA_DIR="scripts/engine_disagreement_study/data"

for shard in $(seq "$FIRST" "$LAST"); do
  if [ -f "$DATA_DIR/seed153_incidence-shard-$shard.json" ]; then
    echo "=== shard $shard already scanned, skipping ==="
    continue
  fi
  echo "=== shard $shard: sampling $(date -u +%H:%M:%S) ==="
  uv run python scripts/engine_disagreement_study/seed153_scan_sample.py \
    --db benchmark --shard "$shard" --num-shards "$NUM_SHARDS"
  echo "=== shard $shard: scanning $(date -u +%H:%M:%S) ==="
  node --import ./scripts/lib/frontend-alias-hook.mjs \
    scripts/engine_disagreement_study/seed153_scan.mjs --shard "$shard" --workers "$WORKERS"
done

echo "=== all shards $FIRST..$LAST done $(date -u +%H:%M:%S) ==="
