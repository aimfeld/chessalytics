# Phase 199 — 5-cell parity sweep runbook

Operator procedure for launching the 5 pinned-bracket parity cells (D-02, D-05). Every
command below is copy-pasteable from the repo root. Read this whole file before running
anything — the preflight section gates the launch blocks, and the launch blocks gate the
observation/crash-recovery sections.

## 0. Preflight

Run all four checks. All must pass before any cell is launched.

```bash
# (a) Confirm core count on the execution box — informs the parallelism decision in §2.
nproc

# (b) Confirm no calibration-harness.mjs process is already live. A second writer would
#     corrupt the measurement (two processes racing the same out-dir, or an unrelated run
#     still occupying the box's CPU budget assumed by §2).
ps -C node -o pid=,args= 2>/dev/null | grep calibration-harness.mjs && \
  echo "STOP: a harness is already running — kill it or wait" || \
  echo "OK: no live calibration-harness.mjs process"

# (c) Confirm the pre-registration is committed (Task 2's gate — this runbook assumes it
#     already cleared; if either git log is empty, STOP and resolve Task 2 first).
git log --oneline -- reports/bot-parity-199/accept-rule.md scripts/calibration_parity_verdict.py
git status --porcelain reports/bot-parity-199/accept-rule.md scripts/calibration_parity_verdict.py

# (d) Confirm the ledger schema check is green (D-08 columns present, --resume round-trips).
node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/calibration-ledger-schema.check.mjs
```

Expected: `nproc` reports 16 on the reference execution box (recompute on the operator's
actual box — do not assume 16 elsewhere); no live harness process; at least one commit for
each pre-registration path with a clean `git status --porcelain`; the schema check prints six
`PASS:` lines ending `OK: calibration-ledger-schema.check.mjs — all D-08 ledger schema
invariants pinned.` and exits 0.

## 1. The five launch blocks

Each block pins its own historic 4-anchor bracket via `PRESET_SUPERVISOR_ANCHORS` (plan 03's
threading into `bin/preset-supervisor.sh`) and writes to its own `PRESET_SUPERVISOR_DIR`.
`PRESET_SUPERVISOR_GAMES` is left at the supervisor's default of 24 games per (cell, anchor) —
stated here rather than relied on implicitly. Every invocation runs under
`bin/preset-supervisor.sh`, never the bare harness driver, so a wasm out-of-bounds crash
resumes from the ledger instead of restarting from zero (RECAL-04). Every block is
backgrounded under `nohup` so the run survives the session ending.

**Do NOT omit `PRESET_SUPERVISOR_ANCHORS` on any of these.** A cell launched without it
silently falls back to the harness's default 10-anchor pool, which re-invokes the full
locate-then-measure schedule and can re-bracket onto different anchors than the historic ones
— corrupting exactly the comparison D-02 exists to protect.

### Cell 1 — null control (elo 1100, blend 0)

Validity gate. Historically ran with `beyond_ladder=true` and carries the widest committed CI
of the five — its role is a validity gate, not a pooled contributor.

```bash
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-human1100 \
PRESET_SUPERVISOR_ANCHORS=maia700,maia1100,sf0,sf3 \
nohup bin/preset-supervisor.sh cell1-human1100 0 1100 \
  >> reports/data/sweep-199-human1100/supervisor-launch.log 2>&1 &
disown
```

### Cell 2 — light dip (elo 1300, blend 0.05)

The measured non-monotone dip.

```bash
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-light1300 \
PRESET_SUPERVISOR_ANCHORS=maia1100,maia1500,sf3,sf5 \
nohup bin/preset-supervisor.sh cell2-light1300 0.05 1300 \
  >> reports/data/sweep-199-light1300/supervisor-launch.log 2>&1 &
disown
```

### Cell 3 — light top end (elo 1900, blend 0.05)

Light preset's top end; twins persona `attacker-1600`.

```bash
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-light1900 \
PRESET_SUPERVISOR_ANCHORS=maia1100,maia1500,sf3,sf5 \
nohup bin/preset-supervisor.sh cell3-light1900 0.05 1900 \
  >> reports/data/sweep-199-light1900/supervisor-launch.log 2>&1 &
disown
```

### Cell 4 — deep low end (elo 1500, blend 0.5)

Deep preset's low end.

```bash
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-deep1500 \
PRESET_SUPERVISOR_ANCHORS=maia1500,maia1900,sf3,sf5 \
nohup bin/preset-supervisor.sh cell4-deep1500 0.5 1500 \
  >> reports/data/sweep-199-deep1500/supervisor-launch.log 2>&1 &
disown
```

### Cell 5 — shared rung-1800 cell (elo 2300, blend 0.5)

The cell all four rung-1800 personas share post-retargeting; twins persona `wall-1800`.

```bash
PRESET_SUPERVISOR_DIR=reports/data/sweep-199-deep2300 \
PRESET_SUPERVISOR_ANCHORS=maia1500,maia1900,sf3,sf5 \
nohup bin/preset-supervisor.sh cell5-deep2300 0.5 2300 \
  >> reports/data/sweep-199-deep2300/supervisor-launch.log 2>&1 &
disown
```

## 2. Parallelism decision

**Launch all five concurrently.** Within a game the bot and its anchor opponent move
alternately, never simultaneously, and the bot's own move (Maia policy, wasm, single-thread)
dominates move time — the `--stockfish-procs 4` pool only bursts briefly during an anchor's
reply. So each concurrent harness averages roughly **one busy core**, with only transient
bursts up toward its Stockfish-proc count during an anchor search (the corrected model in
`bin/run_persona_calibration_sweep.sh` lines 95-105, superseding the older `1 + procs` model
`bin/run_bot_curves_sweep.sh` used). Five concurrent runs therefore sit comfortably inside a
16-core box, and the wall clock collapses from the *sum* of the five cells to roughly the
*longest* cell instead.

**Fallback:** if `nproc` on the actual execution box is materially below 16, launch in two
groups instead of all five at once — deep cells first (cells 4 and 5), since they are the
long pole (Deep preset's heavier search dominates wall clock), then cells 1–3 once a slot
frees up.

## 3. Expectations (no single-point ETA)

Do not expect a single number. The old-engine, per-cell wall-clock figures below (from
199-RESEARCH.md's "CPU model and wall-clock estimate" section, measured from this machine's
local `sweep-{human,light,deep}/run.log` files) are an **upper bound**, not a prediction:

| Cell | Old-engine isolated wall clock (upper bound) |
|---|---|
| 1100/0 (null) | ~36 min |
| 1300/0.05 | ~7.3h |
| 1900/0.05 | ~7.2h |
| 1500/0.5 | ~7.9h |
| 2300/0.5 | ~6.2h |

These numbers include the old two-pass locate-then-measure schedule's locate-pass spend
(~16 wasted games per exposed cell, ~14% of that cell's old game count) and predate Phase
195's ladder. D-02's pinned bracket removes the locate-pass spend entirely for this run, and
the ladder itself measured a 1.35–1.4x wall-clock speedup on its 12-position fixture — so the
new numbers should come in lower than the table above. **The exact new-engine number is not
predictable in advance; do not present a single-point ETA to the operator.** The ledger's own
per-game `elapsed_ms`/`mean_move_ms` columns (D-08) are the answer once the run starts —
watch them, don't estimate them.

## 4. Observation — "start it and observe early results"

This run is meant to be watched, not just launched and forgotten.

**Tail a cell's supervisor log:**
```bash
tail -f reports/data/sweep-199-<cellname>/run.log
```

**Count completed games from the raw ledger while a cell is in flight** (the raw ledger is
append-mode and updates live; the aggregate does not — see below):
```bash
wc -l reports/data/sweep-199-<cellname>/calibration-harness-*.tsv
# subtract 1 for the header row to get the completed-game count
```

**Standing warning:** the per-cell aggregate (`*-cells.tsv`) is written ONCE, at the very end
of a clean completion, from the in-memory store — never incrementally. Its absence while a
cell is still running is expected and is NOT a fault. Do not go looking for a partial
aggregate mid-run.

**Completion signal:** the appearance of `*-cells.tsv` in a cell's out-dir is the single
completion signal for that cell — the same check `bin/preset-supervisor.sh`'s own
`cells_present()` uses to decide the supervisor loop is done. A cell is complete when (and
only when) that file exists.

## 5. Crash recovery

Every cell is launched under `bin/preset-supervisor.sh`, which relaunches with `--resume`
automatically the moment the harness process dies — losing at most the one game that was
in flight at crash time. This is the known wasm out-of-bounds fault mode: onnxruntime-web's
linear heap faults on long-lived Maia inference runs, typically ~5-6h into a blend>0 cell. A
fresh process clears the fault; the ledger is append-mode resumable, so nothing before the
crash is lost.

The supervisor also carries a **fast-crash guard**: if the harness dies less than 180 seconds
after launch, three times in a row, the supervisor aborts loudly instead of hot-looping
forever, because that pattern means a real defect, not the slow wasm leak. If that abort
fires (`ABORT — 3 fast crashes` in the run log), **do not relaunch blindly** — read
`reports/data/sweep-199-<cellname>/run.log` first to find the actual failure.

## 6. What must NOT happen

- Do NOT launch any cell with the default 10-anchor pool (i.e. without
  `PRESET_SUPERVISOR_ANCHORS` set). That silently re-invokes the locate-and-bracket schedule
  and can re-bracket onto different anchors precisely when strength has shifted — corrupting
  the comparison D-02 exists to protect.
- Do NOT re-bracket, and do NOT run the two-pass locate-then-measure schedule for these cells.
- Do NOT launch the bare `calibration-harness.mjs` driver directly for the real cells — the
  crash supervisor (`bin/preset-supervisor.sh`) is mandatory.
- Do NOT run the persona spot-check (`grinder-1600`, `wall-1800`) concurrently with these
  five curve cells (P-07).
- Do NOT edit the threshold constants in `scripts/calibration_parity_verdict.py` or
  `reports/bot-parity-199/accept-rule.md` after Task 2's checkpoint clears.
