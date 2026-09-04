---
phase: 212-benchmark-full-game-analysis-lane
plan: 08
subsystem: infra
tags: [benchmark-db, eval-pipeline, maia, stockfish, logging, gap-closure, smoke-test]

# Dependency graph
requires:
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-07: the entry-ply lane selection gate, the fifth and last ungated lottery/claim lane"
  - phase: 212-benchmark-full-game-analysis-lane
    provides: "212-02: BENCHMARK_SELECTION_GATE_ENABLED applied to the tier-3/tier-4/tier-4b claims"
provides:
  - "212-08-SMOKE-RECORD.md: Before/After tables with deltas, the named proven game id, the leak-recurrence proof, and an explicit NO-GO recommendation for 212-09/212-10"
  - "BENCHLANE-04's end-to-end pipeline proof on a named, checkable selected game (72320)"
  - "the leak-recurrence proof 212-06 made necessary: corpus-wide evals_completed_at delta of exactly zero across a real fleet claim"
  - "startup success log lines for the Stockfish pool and the Maia ONNX session, plus a logging configuration that makes app.* INFO records actually reach a handler"
  - "a blocking finding: the lichess arm is stamped full_pv_completed_at and best_moves_completed_at after exactly one analyzed ply per game"
affects: [212-09, 212-10]

# Actuals (#2632)
actuals:
  tokens: 47000
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Confirm a startup precondition by excluding every failure path in an identical process, not by reading a log for a line that may not exist. Absence of an error line is not a positive signal."
    - "Raising a logger's level is not sufficient to make its records visible: without a handler anywhere on the propagation chain, records fall through to logging.lastResort, which emits at WARNING."

key-files:
  created:
    - .planning/phases/212-benchmark-full-game-analysis-lane/212-08-SMOKE-RECORD.md
  modified:
    - app/main.py
    - app/services/engine.py
    - app/services/maia_engine.py

key-decisions:
  - "Executed inline rather than via a dispatched gsd-executor. The plan carries a mid-plan checkpoint:human-action, and GSD's checkpoint protocol spawns a FRESH continuation agent rather than resuming: under worktree isolation that agent would fork a new worktree and never see Task 1's commit or the SMOKE-RECORD holding the operator's launch command. Single-plan wave, so no parallelism was lost. Confirmed with the user before proceeding."
  - "Recorded the result as an explicit NO-GO rather than a qualified pass. BENCHLANE-04's literal requirement is met and the leak is provably closed, but the lichess arm is stamped complete after one analyzed ply, and the plan's own acceptance criteria forbid softening a partial result into a pass."
  - "Did not guess at a root cause for the lichess-arm finding. The record states the observation, its blast radius, and the natural next question for 212-09 instead of asserting a mechanism that was not established."
  - "Fixed the app-wide logging gap rather than only adding the two success lines. Adding the lines alone would not have made them visible: app.* loggers inherited root's WARNING and no handler existed on the chain, which is also why maia_engine's onnxruntime-absent diagnostic could never have printed. Scope was widened at explicit user request."
  - "Left the runbook §4 fix to 212-10, which owns docs/benchmark-lane-runbook.md, rather than editing it from this plan."

requirements-completed: [BENCHLANE-04]

coverage:
  - id: D1
    description: "For at least one game in benchmark_selection, the benchmark DB holds all four pipeline outputs produced by the local backend and the fleet on the gated build."
    requirement: BENCHLANE-04
    verification:
      - kind: other
        ref: "game 72320: 130 game_positions rows with non-NULL best_move, 33 with non-NULL pv, 20 game_flaws rows, 13 game_best_moves rows; six selected games clear all four"
        status: pass
    human_judgment: false
  - id: D2
    description: "The gated build does not repeat 212-06's leak: the count of games with a non-NULL evals_completed_at is identical before and after, by exact COUNT(*)."
    requirement: BENCHLANE-04
    verification:
      - kind: other
        ref: "1,846,458 before (20:26:00Z) and 1,846,458 after (22:29:53Z) — delta exactly zero across a real fleet claim"
        status: pass
    human_judgment: false
  - id: D3
    description: "Maia was confirmed loaded before any worker was pointed at the backend, so an empty game_best_moves result would read as a pipeline failure rather than the silent Maia-absent signature."
    requirement: BENCHLANE-04
    verification:
      - kind: other
        ref: "all four start_maia() failure paths excluded in an identical process (onnxruntime 1.20.1 imports, model present, SHA matches, InferenceSession constructs, is_maia_available() True); corroborated after the fact by 18 games reaching non-zero best_moves_done"
        status: pass
    human_judgment: true
    rationale: "start_maia() logs only on failure and returns silently on success, so the runbook's log-line check was unperformable. The confirmation is a same-venv, same-repo-state proxy for the running :8001 process rather than an in-process probe — no endpoint exposes is_maia_available(). It holds because :8001 was launched via uv run uvicorn from this working tree. Judgment call on proxy sufficiency, recorded as such."
  - id: D4
    description: "The lichess-arm smoke games' original evals are recoverable: the snapshot covered every selected lichess-arm game before the homogenized drain started, verified by count."
    requirement: BENCHLANE-04
    verification:
      - kind: other
        ref: "9 selected lichess-arm games, 9 covered, coverage gap exactly 0 before the run and unchanged after; 397 snapshot rows"
        status: pass
    human_judgment: false
  - id: D5
    description: "The run's baseline and outcome survive a context clear: both written to a durable record file in the phase directory."
    requirement: BENCHLANE-04
    verification:
      - kind: other
        ref: ".planning/phases/212-benchmark-full-game-analysis-lane/212-08-SMOKE-RECORD.md — Before table, After table with a delta column, named proven game id, stop conditions, and the NO-GO recommendation"
        status: pass
    human_judgment: false

duration: ~2h (including operator-run smoke drain)
completed: 2026-08-22
status: complete
---

# Phase 212 Plan 08: Gated Smoke Drain Summary

**Proved the full analysis pipeline end to end on the 20-game classical smoke tranche against the gated build, proved 212-06's leak did not recur (corpus-wide completion delta exactly zero), and found a blocking defect that makes committing fleet time to the real tranche premature: the lichess arm is stamped complete after exactly one analyzed ply per game.**

## What happened

Task 1 froze the pre-run state of the benchmark database into a durable record and confirmed all three stop conditions clear (snapshot coverage gap 0, `eval_jobs` depth 0, selection size 20). Task 2 was the operator's own run of a `:8001` backend and one worker. Task 3 re-measured everything and turned the run into evidence.

One worker took the tranche from 0% to 90% in roughly six minutes, so throughput is not the constraint on the real tranche.

## Results

**BENCHLANE-04 — PASS.** Game `72320` (classical, engine arm, in `benchmark_selection`) carries all four required outputs: 130 `game_positions` rows with a non-NULL `best_move`, 33 with a non-NULL `pv`, 20 `game_flaws` rows, and 13 `game_best_moves` rows. Six selected games clear all four. The Maia-absent signature (PV present, best-move rows absent) is ruled out.

**The leak is closed — PASS.** Corpus-wide `games` with a non-NULL `evals_completed_at`: **1,846,458 before, 1,846,458 after, delta exactly 0** across a real fleet claim. This is the assertion 212-06's failure made necessary, and 212-07's gate held.

**Homogenization and D-04 both work — PASS.** Three lichess-arm games have a ply whose stored eval now differs from its preserved snapshot value while `lichess_evals_at` is still set: the overwrite reaches the lichess arm, the snapshot is the intact recovery path, and `benchmark_selection` remains the split key.

## ⛔ Blocking finding

Every lichess-arm game got **exactly one** `best_move` cell and **zero** `pv` cells — independent of game length, from a 20-ply game to a 78-ply game — and was then stamped **both** `full_pv_completed_at` and `best_moves_completed_at`. The engine arm meanwhile got `best_move` on essentially every ply (130/134, 99/104, 27/29, 19/21).

A stamped game is one the pipeline considers finished and will not revisit, so this is not an early stop. It is the lichess arm being marked done while holding no analysis, and `status` reports that state as success (`full_pv_done=8 best_moves_done=8`).

Carried into 212-09/212-10 unchanged, roughly half the tranche — the arm that carries the whole paired eval-source comparison — would be recorded as analyzed while holding one analyzed ply per game, and every count in `record` would look complete.

Root cause is deliberately not guessed at. The natural next question is why the tier-3 branch (b) lane reports completion after one ply on games where `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` has forced `is_lichess_eval_game` to False.

## Deviations from the plan

- **Executed inline, not via a dispatched executor.** The plan's mid-plan `checkpoint:human-action` is incompatible with GSD's fresh-continuation-agent protocol under worktree isolation. Confirmed with the user first.
- **Scope widened at user request** to fix the startup logging. `start_engine()` and `start_maia()` both logged only on failure and returned silently on success, making the runbook's Maia check unperformable. Adding the lines was not enough on its own: `app.*` loggers inherited root's `WARNING` and no handler existed on the chain, so every `logger.info` under `app/` was discarded in every environment — including `maia_engine: onnxruntime not installed`, the exact diagnostic for the failure this plan needed to see. The lifespan now raises the `app` tree to INFO and attaches one handler. Gate: ruff clean, ty clean, 4424 passed / 19 skipped.
- **Runbook §4 left unfixed here.** It instructs the operator to confirm a startup line that did not exist. `docs/benchmark-lane-runbook.md` is in 212-10's `files_modified`, so the fix belongs there; flagged in the record.

## Recommendation

**NO-GO for 212-09/212-10 as things stand.** The pipeline is proven and the leak is closed, but the tranche the pipeline would currently produce is not worth the fleet days for the lichess half. Resolve the stamping finding, re-run this same 20-row smoke to confirm the lichess arm reaches engine-arm density, then let 212-09 materialize the real selection. That ordering costs minutes; discovering it after the tranche costs the tranche.

## Notes for a later reader

- One diagnostic `/atomic-lease?scope=idle` probe was issued from this session to establish that the server-side lane worked. It leased game `72367` to worker id `diag-probe` and never submitted; the lease simply expires, and `full_eval_attempts` is incremented on submit rather than on lease, so no counter was touched and no cleanup is required.
- Several engine-arm games have very few `game_positions` rows in total (72377: 4 plies, 72338: 6, 72335: 10). Not chased down; worth a glance at real selection scale.
- The operator token for the `:8001` instance was visible in the process list during diagnosis. Local-only, but worth rotating.

## Self-Check: PASSED
