#!/usr/bin/env bash
# Operator runbook for the Phase 184 (CAL-04) persona-calibration overnight
# sweep: measures all 24 named bot personas (4 styles x 6 rungs) against the
# Phase-173 internal anchor ladder, WITH each persona's own style bundle
# active, then fits + regenerates the calibrated labels.
#
# BUDGET (SEED-098): ~24 persona cells x ~4 anchors x ~24 games/anchor is
# roughly the same order of game-count as the Phase-180/181 15-cell bot-curve
# sweep (which ran to completion within its own multi-hour/overnight window)
# — expect ~2 overnight runs at the default --parallel. Raise --parallel if
# the machine has headroom (see the preflight footprint estimate below);
# lower it if other work (e.g. tier-4 workers) is sharing the box.
#
# WASM-OOB CRASH MODE (Pitfall 3, project memory
# project_calibration_harness_wasm_oob_crash): every blend>0 persona (Light/
# Deep presets — most rungs 1600+) can crash ~5-6h in with an
# onnxruntime-web wasm "memory access out of bounds" in Maia policy
# inference. This is NOT optional to guard against: every persona is ALWAYS
# launched through `bin/preset-supervisor.sh` (never the bare
# `calibration-harness.mjs` driver), which auto-relaunches `--resume` on any
# crash. The harness's per-game ledger is append-mode resumable
# (calibration-harness.mjs's `openLedgerWriter`), so a resumed run is
# byte-identical to an uninterrupted one and self-heals — losing at most the
# one in-flight game per crash.
#
# STYLE THREADING: `bin/preset-supervisor.sh` stays generic over
# `<name> <blend> <elo-csv> [adopt-pid]`; this script only steers it via the
# optional `PRESET_SUPERVISOR_DIR` / `PRESET_SUPERVISOR_GAMES` env overrides
# (both default to the original Phase-180 behavior). Each persona's style
# bundle is threaded into its own supervised harness process via the
# `CALIBRATION_HARNESS_STYLE` environment variable (calibration-harness.mjs's
# `resolveStyleFromEnv`), exported in a subshell so it never leaks across
# personas. Every persona gets its OWN --out-dir (`reports/data/persona-sweep-
# <personaId>/`), so distinct personas that collide on `(botElo, blend)`
# post-retargeting (Pitfall 1 — e.g. every rung-1800 persona shares
# `botElo=2300, blend=0.5`) are NEVER measured into a shared store; each is an
# independent supervised process/ledger.
#
# Usage:
#   bin/run_persona_calibration_sweep.sh                 # all 24 personas, --parallel 4
#   bin/run_persona_calibration_sweep.sh --parallel 6    # more concurrent personas
#   bin/run_persona_calibration_sweep.sh --no-fit        # sweep only; skip combine + fit
#   bin/run_persona_calibration_sweep.sh --personas attacker-1200,wall-1800  # a subset (testing)
#
# Env overrides (optional, default preserves the original behavior):
#   PERSONA_SWEEP_DATA_DIR  base data dir for this run (default reports/data). A
#                           persona re-measurement (e.g. Phase 199's spot-check
#                           of attacker-1600/wall-1800) must NOT reuse
#                           reports/data/persona-sweep-<id>/ — that dir already
#                           holds a completed aggregate, and preset-supervisor.sh's
#                           cells_present completion check would treat the stale
#                           aggregate as "already done" and exit without playing
#                           a single game (Phase 199, first caller of this override).
#
# Resume: each persona's out-dir holds its own ledger; a killed run auto-
# resumes via the supervisor loop on the next invocation. Personas that
# already have a `-cells.tsv` (cells_present, per preset-supervisor.sh) are
# skipped on re-run.
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Defaults ────────────────────────────────────────────────────────────────
PARALLEL=4
GAMES_PER_CELL=24
RUN_FIT=1
PERSONAS_FILTER=""

DATA_DIR="${PERSONA_SWEEP_DATA_DIR:-reports/data}"
HOOK="./scripts/lib/frontend-alias-hook.mjs"
SUPERVISOR="bin/preset-supervisor.sh"
FITTER="scripts/calibration_persona_fit.py"
CODEGEN="scripts/gen_persona_calibration.py"
COMBINED_TSV="${DATA_DIR}/persona-calibration-cells.tsv"

# The 10 required fit-input columns (calibration_persona_fit.py's
# REQUIRED_COLUMNS + BEYOND_LADDER_COLUMN) — the SAME literal order the fit
# script expects, extracted by NAME (not position) from each persona's own
# harness-emitted -cells.tsv so a future harness schema reorder never breaks
# this combine step silently.
COMBINED_HEADER="persona_id\tstyle\trung\tblend\tbot_elo\tanchor\twins\tdraws\tlosses\tbeyond_ladder"

# ── Parse flags ─────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --parallel) PARALLEL="${2:?--parallel needs a value}"; shift 2 ;;
    --games) GAMES_PER_CELL="${2:?--games needs a value}"; shift 2 ;;
    --no-fit) RUN_FIT=0; shift ;;
    --personas) PERSONAS_FILTER="${2:?--personas needs a comma-separated list}"; shift 2 ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "ERROR: unknown flag '$1' (see --help)" >&2; exit 2 ;;
  esac
done

# ── Preflight ───────────────────────────────────────────────────────────────
# Guard against the duplicate-run footgun: refuse if a harness is already live.
if ps -C node -o args= 2>/dev/null | grep -q "calibration-harness\.mjs"; then
  echo "ERROR: a calibration-harness.mjs node process is already running. Only one" >&2
  echo "       sweep may write engine output at a time. Kill it or wait, then re-run." >&2
  echo "       Offenders:" >&2
  ps -C node -o pid=,args= 2>/dev/null | grep "calibration-harness\.mjs" >&2 || true
  exit 1
fi

CORES="$(nproc)"
# CPU model: within a game the bot and anchor move ALTERNATELY (never at the same
# time), and the bot's move is single-threaded Maia (wasm) which dominates move
# time — the 4-proc Stockfish pool only bursts briefly for the anchor's reply. So
# a persona averages ~1 busy core (transient peak ~4 during an anchor search),
# NOT the naive 1+4=5. Steady-state footprint therefore tracks --parallel, and
# this workload comfortably runs --parallel up to ~cores. (The earlier 5x model
# warned to LOWER --parallel and was backwards: --parallel 6 sat at ~19% CPU on
# 16 cores — the bottleneck was the batch-barrier scheduler, since replaced with
# a rolling queue, not CPU saturation.)
FOOTPRINT="$PARALLEL"
LOAD1="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo '?')"
echo "── Persona calibration sweep preflight ─────────────────────────────────"
echo "  cores=${CORES}  current 1m-load=${LOAD1}"
echo "  parallel=${PARALLEL}  games-per-cell=${GAMES_PER_CELL}"
echo "  est. avg core footprint ≈ ${FOOTPRINT} (~1 core/persona; transient peaks higher)"
if [ "$FOOTPRINT" -gt "$CORES" ]; then
  echo "  ⚠ footprint ${FOOTPRINT} > ${CORES} cores — consider --parallel ${CORES}" >&2
fi
echo "─────────────────────────────────────────────────────────────────────────"

# ── Kill children on Ctrl-C / TERM so a stray engine pool never lingers ──────
PIDS=()
cleanup() {
  echo ""; echo "Interrupted — stopping sweep processes..." >&2
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true
  done
  pkill -TERM -f "calibration-harness.mjs" 2>/dev/null || true
  exit 130
}
trap cleanup INT TERM

# ── Dump the 24 (personaId, style, rung, blend, botElo) tuples from the JS
# source of truth (never hardcoded here — avoids drift, WR-02). ─────────────
echo "Reading persona schedule (ALL_PERSONA_CELLS)..."
PERSONA_TUPLES_TSV="$(node --import "$HOOK" --input-type=module -e "
import { ALL_PERSONA_CELLS } from './scripts/lib/calibration-persona-cell-schedule.mjs';
for (const c of ALL_PERSONA_CELLS) {
  console.log([c.personaId, c.style, c.rung, c.blend, c.botElo].join('\t'));
}
")"

if [ -n "$PERSONAS_FILTER" ]; then
  PERSONA_TUPLES_TSV="$(echo "$PERSONA_TUPLES_TSV" | awk -F'\t' -v filter=",${PERSONAS_FILTER}," '
    index(filter, ","$1",") { print }
  ')"
fi

# ── Longest-first scheduling ────────────────────────────────────────────────
# Persona runtimes vary ~10x: the deepest-search cells (blend>0, high rung —
# e.g. rung-1800 blend=0.5) run ~6h while blend=0 cells finish in ~40min. Feed
# the slow ones into the rolling queue FIRST so they overlap the entire sweep
# instead of stranding a slot at the tail. Sort key: blend desc, then rung desc
# (cols 4,3). The blank-line filter keeps the launch loop's slot accounting exact.
PERSONA_TUPLES_TSV="$(printf '%s\n' "$PERSONA_TUPLES_TSV" \
  | grep -v '^[[:space:]]*$' \
  | sort -t"$(printf '\t')" -k4,4nr -k3,3nr)"

TUPLE_COUNT="$(echo "$PERSONA_TUPLES_TSV" | grep -c . || true)"
echo "  ${TUPLE_COUNT} persona cell(s) scheduled."

# ── Launch each persona through the UNMODIFIED preset-supervisor.sh ─────────
# (never the bare harness driver — Pitfall 3). CALIBRATION_HARNESS_STYLE is
# exported in a subshell per persona so it never leaks across launches.
#
# ROLLING QUEUE (not batches): keep exactly --parallel personas in flight and
# start the next one the instant any slot frees (`wait -n`). Because persona
# runtimes vary ~10x, the previous batch barrier (wait for the WHOLE batch before
# launching the next) stranded finished slots idle for hours behind a single
# straggler — the box sat at ~19% CPU on 16 cores. A rolling queue keeps every
# slot busy until the work runs out. `wait -n` (bash 4.3+) reaps whichever job
# finishes next, so there is no re-waiting on an already-reaped PID.
declare -A DIR_OF
mapfile -t PERSONA_TUPLES <<<"$PERSONA_TUPLES_TSV"

launch_persona() {
  IFS=$'\t' read -r persona_id style rung blend bot_elo <<<"$1"
  local outdir="${DATA_DIR}/persona-sweep-${persona_id}"
  DIR_OF["$persona_id"]="$outdir"
  mkdir -p "$outdir"
  echo "  [${persona_id}] launching: style=${style} rung=${rung} blend=${blend} botElo=${bot_elo} → ${outdir}/run.log"
  (
    export CALIBRATION_HARNESS_STYLE="$style"
    # preset-supervisor.sh derives its own out-dir from <name> unless told
    # otherwise; without this export it would write to `sweep-<personaId>/` while
    # we prepared `persona-sweep-<personaId>/`, and every redirect inside it would
    # fail (the harness would never launch at all).
    export PRESET_SUPERVISOR_DIR="$outdir"
    export PRESET_SUPERVISOR_GAMES="$GAMES_PER_CELL"
    exec "$SUPERVISOR" "$persona_id" "$blend" "$bot_elo"
  ) >>"${outdir}/run.log" 2>&1 &
  PIDS+=("$!")
}

FAILED=0
running=0
next=0
n=${#PERSONA_TUPLES[@]}
while [ "$next" -lt "$n" ] || [ "$running" -gt 0 ]; do
  # Top the pool back up to --parallel.
  while [ "$running" -lt "$PARALLEL" ] && [ "$next" -lt "$n" ]; do
    launch_persona "${PERSONA_TUPLES[$next]}"
    next=$(( next + 1 ))
    running=$(( running + 1 ))
  done
  # Block until ANY one persona finishes, then free its slot. `wait -n` returns
  # that job's exit status; a non-zero one flags FAILED but we keep draining the
  # rest so their ledgers still land (completed personas auto-skip on re-run).
  if [ "$running" -gt 0 ]; then
    if ! wait -n; then FAILED=1; fi
    running=$(( running - 1 ))
  fi
done
trap - INT TERM

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "ERROR: at least one persona supervisor aborted (see its run.log). Fix and" >&2
  echo "       re-run — completed personas auto-skip (cells_present); skipping combine + fit." >&2
  exit 1
fi

echo "All ${TUPLE_COUNT} persona sweeps complete."

if [ "$RUN_FIT" -eq 0 ]; then
  echo "--no-fit set: skipping combine + fit. Per-persona aggregates are in ${DATA_DIR}/persona-sweep-*/."
  exit 0
fi

# ── Combine each persona's own -cells.tsv into the persona_id-keyed aggregate ──
echo "Combining ${TUPLE_COUNT} per-persona aggregates → ${COMBINED_TSV}"
printf '%b\n' "$COMBINED_HEADER" >"$COMBINED_TSV"
while IFS=$'\t' read -r persona_id style rung blend bot_elo; do
  [ -z "$persona_id" ] && continue
  outdir="${DIR_OF[$persona_id]}"
  src="$(find "$outdir" -maxdepth 1 -name '*-cells.tsv' 2>/dev/null | sort | tail -n1)"
  if [ -z "$src" ]; then
    echo "ERROR: no -cells.tsv found for persona '${persona_id}' in ${outdir}" >&2
    exit 1
  fi
  # Column-name-indexed extraction (robust to a future harness column
  # reorder) — prefixes persona_id/style/rung, which the harness itself has
  # no notion of (Pitfall 1: it only knows botElo/blend, which collide).
  awk -F'\t' -v pid="$persona_id" -v style="$style" -v rung="$rung" '
    NR==1 { for (i=1;i<=NF;i++) col[$i]=i; next }
    { print pid"\t"style"\t"rung"\t"$col["bot_blend"]"\t"$col["bot_elo"]"\t"$col["anchor"]"\t"$col["wins"]"\t"$col["draws"]"\t"$col["losses"]"\t"$col["beyond_ladder"] }
  ' "$src" >>"$COMBINED_TSV"
done <<<"$PERSONA_TUPLES_TSV"

# ── Fit + regenerate ─────────────────────────────────────────────────────────
echo "Fitting → ${DATA_DIR}/persona-calibration.json"
uv run python "$FITTER" --input "$COMBINED_TSV" --out-json "${DATA_DIR}/persona-calibration.json"

echo "Regenerating → frontend/src/generated/personaCalibration.ts"
uv run python "$CODEGEN"

echo ""
echo "── Done ────────────────────────────────────────────────────────────────"
echo "  combined cells:   ${COMBINED_TSV}"
echo "  persona fit:      ${DATA_DIR}/persona-calibration.json"
echo "  generated TS:     frontend/src/generated/personaCalibration.ts"
echo "  Next: git diff --exit-code the two generated artifacts, then commit."
