---
id: SEED-133
status: closed
planted: 2026-08-01
planted_during: Phase 199 execution — operator deferred the run to background it across later phases
closed: 2026-08-05
closed_because: sweep ran to completion 2026-08-01/02; measured no systematic shift, operator declined to relabel
---

# SEED-133: Full 24-persona recalibration sweep against the post-v2.10 engine

## Outcome (2026-08-05) — measured, not promoted

The full sweep ran overnight 2026-08-01 → 2026-08-02 and **all 24 personas completed**:
3040 games, 10 anchors per persona, 104–112 games each, zero supervisor aborts. Wall
clock ~7h at `--parallel 12` on the 16-core box (well under the 11–14h budget).

**Result: no systematic shift.** Across the 24 personas the `approx_blitz` delta vs the
July fit came in at **mean +11.2, median +0.0, sd 81.7** (range −254 … +178). That is
centered on zero, and the spread lands exactly on the ±70–90 resolution floor this design
was already known to have. 9 of 24 fits were bit-identical (mostly the 800/1000 rungs,
where the score saturates against the anchor ladder so the MLE returns the same point).

**Decision: promote nothing.** The four shipping calibration artifacts stay byte-identical
to the pre-195 2026-07-22/23 fit. Rationale:

- The aggregate says parity, consistent with Phase 199's 5-cell check. There is no engine
  drift to correct for.
- 10 of 24 published labels *would* have moved, but most of those moves are artifacts of
  D-03's round-to-nearest-50 rather than measured differences. The clearest case:
  `wall-1000` moved **11 ELO** (1027 → 1017) and its label flips `~1050` → `~1000` purely
  because the two values straddle the 1025 rounding boundary.
- Conversely `trickster-1800` posted the largest raw move in the run (−254, 2036 → 1782)
  and its label does not change at all, because the D-07 1800 ceiling absorbs it. The
  label surface is not a faithful readout of the measurement at either end.
- Only 4 label changes survive a ±85 noise-floor gate (`attacker-1600` −113,
  `trickster-1400` +121, `grinder-1000` +178, `wall-1600` +88), and they cannot be
  promoted on their own — see the PAVA constraint below.

The one result worth remembering: **`attacker-1600` is the single corroborated persona.**
Phase 199's clean spot-check put it at −71 (z ≈ 1.0); this run puts it at −113 on the Maia
side. Same direction, larger, independent sample. If persona labels are ever revisited,
that is the one to look at first.

### Facts learned that outlive this seed

- **You cannot cherry-pick label changes.** `gen_persona_calibration.py` runs PAVA
  monotonicity pooling across all 6 rungs of a style column and CI drift-checks the
  generated TS (`--check` + `git diff --exit-code`). Promotion is all-or-nothing per fit;
  hand-editing an individual label fails the gate.
- **The fitter overwrites, it does not accumulate.** `load_persona_cells` does
  `acc.wdl_vs_maia[anchor] = wdl` — an assignment. Concatenating two runs' cells TSVs
  silently drops the earlier run's rows instead of pooling them. Pooling July + August
  into one ~48-games/anchor fit (which would drop the noise floor to roughly ±60, the only
  option here that actually buys precision) needs a pre-sum step that groups both TSVs by
  `(persona_id, anchor)` before the fitter sees them. No change to the fitter itself.
- **`--parallel 12` OOM-killed the box.** Kernel OOM kills at 01:39–01:47 UTC produced ~23
  crash-resumes, concentrated entirely on the blend>0 rung-1600/1800 personas (2–3 each);
  every rung 800–1400 persona ran clean bar one. This is *not* the ~5–6h wasm-OOB signature
  from `project_calibration_harness_wasm_oob_crash` — these are silent kernel kills with no
  wasm error in the logs. The `remote_eval_worker` (8 Stockfish workers) was running
  concurrently. **The supervisor absorbed all of it**: append-mode ledgers, zero aborts,
  every persona reached a clean `-cells.tsv`. The resume path Phase 199 left unexercised is
  now proven under load.
- The bracket-pinning question below was never settled and **could not be** through this
  script: `run_persona_calibration_sweep.sh` passes only `(personaId, blend, botElo)` to the
  supervisor, so anchors are always auto-located. Pinning would need the
  `PRESET_SUPERVISOR_ANCHORS` override threaded through the sweep script.

### Where the data lives

`reports/data/persona-recal-199/` — per-persona ledgers, the combined
`persona-calibration-cells.tsv`, and the fitted `persona-calibration.json`. **Gitignored**
(`reports/data/persona-recal-*/`), so it survives `git clean -fd` but NOT `git clean -fdx`.
Nothing from it was committed.

---

## Original seed (for reference)

### Why This Matters

Phase 199 measured **five** curve cells and **two** personas. Parity held, so the four
shipping calibration artifacts were deliberately left byte-identical (RECAL-02/03 stayed
conditional and untriggered, per D-04's stop-and-report rule).

That leaves the published persona ELO labels in `reports/data/persona-calibration.json`
still derived from the **2026-07-22/23 pre-195 run**. They are not known to be wrong —
Phase 199 found no detectable shift — but they have never been measured against the engine
that actually ships today. A full 24-persona pass would close that gap and is the only way
to relabel with real data rather than an assumption of continuity.

### What Phase 199 Already Established

- **Parity holds** on the curve cells: Maia pooled shift −57.7 (SE 40.4) vs ±85.0 threshold;
  SF pooled −9.9 vs ±50.0. Null control clear, shape guard did not fire.
- **No detectable persona ELO change** in the two spot-checked personas — but the check was
  weak, and two of its four family-level deltas were **confounded by auto-locate picking
  different anchor brackets between runs**, so they are not interpretable as ELO changes at
  all. The one clean comparison (`attacker-1600` SF, same 4 anchors, 64 games each run) came
  in at −71.1 ELO, z ≈ 1.0. `wall-1800` Maia was an exact null (identical 43.0/48 total score
  both runs; with fixed anchor ratings the MLE depends only on the total).
- **Resolution floor:** at 24 games/anchor this design cannot resolve below roughly ±70–90 ELO.
  A full sweep does not fix that per-persona — it buys coverage (24 personas instead of 2),
  not precision. If precision is the goal, raise `--games`.
- The persona fitter emits **point estimates only, no CIs**.

### How To Run It

The operator-confirmed parameter is `--parallel 12`. Two silent-no-op traps, both real —
see memory `project_full_persona_recalibration_traps`:

1. **All 24 `reports/data/persona-sweep-<id>/` dirs already hold a `*-cells.tsv`** from the
   July run. `cells_present()` skips any persona whose aggregate exists, so a default-`DATA_DIR`
   invocation plays **zero games** and fits stale data while printing
   "All 24 persona sweeps complete." Defeat with a fresh `PERSONA_SWEEP_DATA_DIR`.
2. **`scripts/gen_persona_calibration.py` hard-codes `_INPUT = reports/data/persona-calibration.json`.**
   Under a custom data dir the fitter writes `${DATA_DIR}/persona-calibration.json`, but the
   script's own codegen step then regenerates the TS from the **stale canonical** json. Promote
   the fresh fit to the canonical path *before* regenerating.

```bash
# preflight — the script refuses to launch while any harness is live (P-07)
pgrep -af 'calibration-harness.mjs'

# ~2300 games (24 personas x ~4 anchors x 24). Budget ~11-14h at --parallel 12.
PERSONA_SWEEP_DATA_DIR=reports/data/persona-recal-199 \
setsid nohup bin/run_persona_calibration_sweep.sh --parallel 12 --games 24 --no-fit \
  >> reports/data/persona-recal-199-launch.log 2>&1 &

# then, once all 24 aggregates exist: combine + fit, promote, regenerate, review the diff
cp reports/data/persona-recal-199/persona-calibration.json reports/data/persona-calibration.json
uv run python scripts/gen_persona_calibration.py
git diff --stat reports/data/persona-calibration.json frontend/src/generated/personaCalibration.ts
```

> Correction from the actual run: `--no-fit` exits before the combine+fit, so the
> `${DATA_DIR}/persona-calibration.json` this block copies is never written. Re-run the
> same command **without** `--no-fit` first — every persona auto-skips via `cells_present`
> and only the combine+fit executes.

Every persona runs under `bin/preset-supervisor.sh` for wasm-OOB crash resume
(`project_calibration_harness_wasm_oob_crash`). Note Phase 199 saw **zero** crashes across
704 games, so that path remains unexercised in production.

### Open Questions

- Pin the brackets (D-02 style) or keep auto-locate? Phase 199 kept the personas unpinned to
  match how the comparison target was produced — but that is exactly what confounded two of
  its four deltas. Pinning to the July brackets would make the before/after comparison clean.
  This is the main design decision to settle before running.
- Relabelling is a **user-visible change** to bot difficulty labels. Decide up front whether a
  shift inside the ±70–90 noise floor should move a published label at all.
