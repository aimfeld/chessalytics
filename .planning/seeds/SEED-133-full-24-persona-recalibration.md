---
id: SEED-133
status: dormant
planted: 2026-08-01
planted_during: Phase 199 execution — operator deferred the run to background it across later phases
trigger_when: operator has a free multi-hour window on the 16-core box, or whenever persona ELO labels are questioned
scope: medium (one operator-supervised sweep + a fit/regen commit; no new code needed)
---

# SEED-133: Full 24-persona recalibration sweep against the post-v2.10 engine

## Why This Matters

Phase 199 measured **five** curve cells and **two** personas. Parity held, so the four
shipping calibration artifacts were deliberately left byte-identical (RECAL-02/03 stayed
conditional and untriggered, per D-04's stop-and-report rule).

That leaves the published persona ELO labels in `reports/data/persona-calibration.json`
still derived from the **2026-07-22/23 pre-195 run**. They are not known to be wrong —
Phase 199 found no detectable shift — but they have never been measured against the engine
that actually ships today. A full 24-persona pass would close that gap and is the only way
to relabel with real data rather than an assumption of continuity.

## What Phase 199 Already Established

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

## How To Run It

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

Every persona runs under `bin/preset-supervisor.sh` for wasm-OOB crash resume
(`project_calibration_harness_wasm_oob_crash`). Note Phase 199 saw **zero** crashes across
704 games, so that path remains unexercised in production.

## Open Questions

- Pin the brackets (D-02 style) or keep auto-locate? Phase 199 kept the personas unpinned to
  match how the comparison target was produced — but that is exactly what confounded two of
  its four deltas. Pinning to the July brackets would make the before/after comparison clean.
  This is the main design decision to settle before running.
- Relabelling is a **user-visible change** to bot difficulty labels. Decide up front whether a
  shift inside the ±70–90 noise floor should move a published label at all.
