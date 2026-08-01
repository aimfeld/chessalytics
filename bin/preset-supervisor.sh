#!/usr/bin/env bash
# Self-healing supervisor for a Phase-180 bot-curves preset (light or deep).
#
# WHY: both blend>0 presets crashed after ~5.5-6h with an onnxruntime-web wasm
# "memory access out of bounds" in Maia policy inference (nodePolicy ->
# InferenceSession.run, calibration-providers.mjs:125). The wasm linear heap
# faults on long-lived runs; a fresh process clears it. The harness ledger is
# append-mode resumable (calibration-harness.mjs:1578/1594), so a resume
# re-reads every logged game and continues, losing at most the one in-flight
# game per crash. This supervisor relaunches --resume on any crash until the
# harness writes its final -cells.tsv (clean completion). nohup => survives a
# session end.
#
# FAST-CRASH GUARD: if the harness dies < MIN_HEALTHY_SECS after launch
# FAST_FAIL_LIMIT times in a row, this is a real bug (not the slow wasm leak),
# so the supervisor exits loudly instead of hot-looping. A healthy run (>=
# MIN_HEALTHY_SECS) resets the counter.
#
# Usage: preset-supervisor.sh <name> <blend> <elo-csv> [adopt-pid]
#
# Env overrides (all optional, defaults preserve the original Phase-180 behavior):
#   PRESET_SUPERVISOR_DIR      out-dir for this run (default reports/data/sweep-<name>)
#   PRESET_SUPERVISOR_GAMES    --games-per-cell for the harness (default 24)
#   PRESET_SUPERVISOR_ANCHORS  comma-separated --anchors token list for a pinned
#                              bracket (default: unset, harness uses its default
#                              10-anchor pool). Example (Phase 199, D-02 pinned
#                              bracket under the crash supervisor):
#                                PRESET_SUPERVISOR_DIR=reports/data/199-cell-a \
#                                PRESET_SUPERVISOR_ANCHORS=maia1300,maia1600,sf2 \
#                                bin/preset-supervisor.sh 199-cell-a 0.5 1700
set -uo pipefail
cd "$(dirname "$0")/.."   # bin/ -> repo root

NAME="${1:?need preset name}"; BLEND="${2:?need blend}"; ELO="${3:?need elo csv}"
ADOPT_PID="${4:-}"

# Overridable so a caller that owns its own out-dir layout (e.g. the Phase-184
# persona sweep, which needs one dir per PersonaId) does not have to match this
# script's `sweep-<name>` convention. Bug: run_persona_calibration_sweep.sh
# created `persona-sweep-<id>/` while this script wrote to `sweep-<id>/`, so
# every log/nohup redirect below failed, the harness never launched, and the
# fast-crash guard aborted after three 0-second "runs".
DIR="${PRESET_SUPERVISOR_DIR:-reports/data/sweep-${NAME}}"
GAMES_PER_CELL="${PRESET_SUPERVISOR_GAMES:-24}"
# D-02 pinned brackets vs RECAL-04 resume-on-crash (Phase 199): empty by
# default, so an unset override reproduces today's behavior exactly (the
# harness's own default 10-anchor pool).
ANCHORS="${PRESET_SUPERVISOR_ANCHORS:-}"
LOG="${DIR}/run.log"
HOOK="./scripts/lib/frontend-alias-hook.mjs"
HARNESS="scripts/calibration-harness.mjs"
MIN_HEALTHY_SECS=180
FAST_FAIL_LIMIT=3

mkdir -p "$DIR"

log() { echo "[supervisor:${NAME} $(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
find_ledger() { find "$DIR" -maxdepth 1 -name 'calibration-harness-*.tsv' ! -name '*-cells.tsv' ! -name '*-summary.tsv' 2>/dev/null | sort | tail -1; }
cells_present() { find "$DIR" -maxdepth 1 -name '*-cells.tsv' 2>/dev/null | grep -q .; }

launch() {
  local ledger; ledger="$(find_ledger)"
  # Bug: this unconditionally passed `--resume "$ledger"`, but on a COLD start
  # there is no prior ledger and the harness rejects an empty --resume with
  # "expected a .tsv file". Phase 180 only ever ran this supervisor in
  # adopt-pid mode (attached to an already-running harness that had created its
  # ledger), so the cold-start path was never exercised. Only pass --resume
  # when a ledger actually exists.
  local resume_args=()
  [ -n "$ledger" ] && resume_args=(--resume "$ledger")
  # Threaded here (not only on the cold-start branch) because launch() is the
  # SINGLE code path for both the cold start and every crash-resume relaunch —
  # the harness refuses to resume a ledger whose recorded anchor is absent
  # from the current anchor pool (calibration-harness.mjs's applyPriorLedgerRows),
  # so a pinned bracket must re-present the same pinned pool on every relaunch,
  # not just the first one. Empty by default so an unset override matches
  # today's command line exactly (no --anchors flag, default 10-anchor pool).
  local anchor_args=()
  [ -n "$ANCHORS" ] && anchor_args=(--anchors "$ANCHORS")
  nohup node --import "$HOOK" "$HARNESS" \
    --blends "$BLEND" --elo "$ELO" \
    --games-per-cell "$GAMES_PER_CELL" --stockfish-procs 4 \
    --seed 1 --out-dir "$DIR" \
    "${resume_args[@]}" "${anchor_args[@]}" >> "$LOG" 2>&1 &
  echo $!
}

pid="$ADOPT_PID"
fast_fails=0
start=$SECONDS   # measured from adoption for an adopted pid; reset per launch below
[ -n "$pid" ] && log "adopting already-running PID ${pid}"
while true; do
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    if cells_present; then log "COMPLETE — -cells.tsv present. supervisor exiting 0."; exit 0; fi
    if [ "$fast_fails" -ge "$FAST_FAIL_LIMIT" ]; then
      log "ABORT — ${fast_fails} fast crashes (< ${MIN_HEALTHY_SECS}s each). Likely a real bug, not the wasm leak. NOT resuming; investigate ${LOG}."
      exit 1
    fi
    log "resuming from $(find_ledger) (consecutive fast-fails so far: ${fast_fails})"
    start=$SECONDS
    pid="$(launch)"
    log "resumed as PID ${pid}"
    echo "$pid" > "${DIR}/current.pid"
  fi
  # Watch until it exits.
  while kill -0 "$pid" 2>/dev/null; do sleep 15; done
  ran=$(( SECONDS - ${start:-SECONDS} ))
  log "PID ${pid} exited after ${ran}s"
  if [ "$ran" -lt "$MIN_HEALTHY_SECS" ]; then fast_fails=$((fast_fails + 1)); else fast_fails=0; fi
  pid=""
done
