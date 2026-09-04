---
phase: 212-benchmark-full-game-analysis-lane
plan: 09
subsystem: database
tags: [postgres, benchmark, sqlalchemy, asyncpg, streaming, idempotency]

requires:
  - phase: 212-08
    provides: "The end-to-end pipeline proof and the go recommendation on the 20-game smoke tranche, plus the leak baseline this plan re-measures."
  - phase: 212-05
    provides: "The `select` / `snapshot` / `status` subcommands and the operator runbook they are documented in."
  - phase: 212-04
    provides: "`benchmark_lichess_eval_snapshot` and the snapshot subcommand's idempotency contract."
provides:
  - "The real capped, randomly-selected, equal-footing classical tranche materialized in `benchmark_selection`: 50,737 games across 745 users (27,020 lichess-arm / 23,717 never-analyzed)."
  - "Full D-05 snapshot coverage for the classical lichess arm: 1,924,579 rows over all 27,020 arm games, coverage gap exactly zero."
  - "`212-09-TRANCHE-READINESS.md` — the five decision numbers, a worded disk verdict, the tranche-start leak baseline, and the pre-launch checklist, frozen for 212-10's blocking checkpoint."
  - "A fix for the snapshot subcommand's batched-commit path, which had never run before this plan."
affects: [212-10, benchmark-lane-runbook, benchmarks-skill]

actuals:
  tokens: 9200
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Separate read and write sessions when a streaming server-side cursor coexists with batched commits."

key-files:
  created:
    - .planning/phases/212-benchmark-full-game-analysis-lane/212-09-TRANCHE-READINESS.md
  modified:
    - scripts/benchmark_lane.py
    - tests/test_benchmark_lane.py

key-decisions:
  - "Ran the plan inline rather than dispatching a gsd-executor subagent, as the plan's objective instructs — the snapshot pass is a long database-bound operation and this project has recorded losing such work to subagent connection drops."
  - "Fixed the snapshot cursor/commit bug in place rather than working around it with a larger batch size or a non-streaming read: both workarounds would have discarded a property the docstring commits to (bounded write transactions, or the server-side cursor for a 1.9M-row read)."
  - "Accepted 50,737 selected games against the phase's ~54,390 planning estimate (6.7% below, same order of magnitude) rather than treating it as an anomaly — the plan's own threshold is an order of magnitude, and every structural check on the resulting set passes."

patterns-established:
  - "Batch-boundary regression tests: when a loop commits every N rows, the test must feed more than N rows, because the smoke-scale fixture never crosses the boundary."

requirements-completed: [BENCHLANE-01, BENCHLANE-06]

coverage:
  - id: D1
    description: "The real capped, randomly-selected, equal-footing classical selection is materialized in `benchmark_selection` and proven idempotent at full scale."
    requirement: BENCHLANE-01
    verification:
      - kind: integration
        ref: "uv run python scripts/benchmark_lane.py select --tranche classical --db benchmark (two passes: 50,717 inserted / 20 skipped, then 0 inserted / 50,737 skipped)"
        status: pass
      - kind: integration
        ref: "SQL: classical rows split by lichess_arm = 27,020 / 23,717 across 745 users; 20 smoke ids present exactly once; 0 orphans, 0 wrong-TC rows, 0 non-classical rows, 0 arm-flag mismatches"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every selected classical lichess-arm game has its original lichess evals preserved, so the homogenized overwrite 212-10 authorizes is recoverable."
    requirement: BENCHLANE-06
    verification:
      - kind: integration
        ref: "uv run python scripts/benchmark_lane.py snapshot --tranche classical --db benchmark (1,919,182 inserted; second pass 0 inserted / 1,924,579 skipped)"
        status: pass
      - kind: integration
        ref: "SQL: distinct covered arm games (27,020) minus selected arm games (27,020) = coverage gap 0; 0 snapshot rows outside the arm"
        status: pass
    human_judgment: false
  - id: D3
    description: "The snapshot subcommand survives its own batched commits at full scale — the streaming cursor is no longer invalidated at row 5,000."
    verification:
      - kind: unit
        ref: "tests/test_benchmark_lane.py#test_snapshot_batched_commit_does_not_invalidate_the_stream"
        status: pass
      - kind: integration
        ref: "The live 1.9M-row classical snapshot pass completed with exit 0 after the fix, having crashed at row 5,000 before it"
        status: pass
    human_judgment: false
  - id: D4
    description: "212-10's blocking decision can be presented on current, measured numbers with the disk verdict already computed."
    requirement: BENCHLANE-06
    verification:
      - kind: integration
        ref: "test -s .planning/phases/212-benchmark-full-game-analysis-lane/212-09-TRANCHE-READINESS.md && benchmark_lane.py status --tranche classical --db benchmark (file figures re-queried live and matched)"
        status: pass
    human_judgment: true
    rationale: "Whether the frozen numbers are the right ones to hang a one-way, multi-day decision on is an operator judgment; automation can confirm they are current and internally consistent, which it did, but not that they are sufficient."

duration: 12 min
completed: 2026-08-23
status: complete
---

# Phase 212 Plan 09: Classical Tranche Materialization Summary

**The real 50,737-game classical tranche is selected and its 27,020-game lichess arm is fully snapshotted (1,924,579 rows, coverage gap zero) — and the snapshot subcommand's batched-commit path, which had never executed before this plan, was found broken at row 5,000 and fixed.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-08-22T22:37Z
- **Completed:** 2026-08-22T22:49Z
- **Tasks:** 3 of 3
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- **The tranche exists.** `benchmark_selection` went from 212-01's 20-row smoke set to the real capped, seeded, equal-footing classical draw: **50,737 games across 745 users**, split 27,020 lichess-arm / 23,717 never-analyzed. The 20 smoke ids are subsumed exactly once each, not duplicated. This closes the first of BENCHLANE-06's four `missing:` items in `212-VERIFICATION.md`.
- **The one-way overwrite is now recoverable.** `benchmark_lichess_eval_snapshot` holds **1,924,579 rows** covering **all 27,020** selected lichess-arm games — a coverage gap of **exactly zero**, verified by distinct-game-id difference rather than by row count. D-05's precondition for starting the drain is satisfied.
- **Both passes proven idempotent at real scale**, not just in unit fixtures: a second `select` inserted 0 and skipped all 50,737; a second `snapshot` inserted 0 and skipped all 1,924,579.
- **A latent bug was caught before it could cost a multi-day run.** The snapshot's batched commit killed its own server-side cursor at row 5,000. Fixed, regression-tested, and the fix proven by reverting it.
- **`212-09-TRANCHE-READINESS.md` freezes everything 212-10's checkpoint needs** — the five numbers with their producing queries, a disk verdict computed in words (~450× headroom over the transient budget), the re-measured tranche-start leak baseline, the starting-line status counters, and the three-item pre-launch checklist.

## Task Commits

1. **Task 1: Materialize the real classical selection** — no code change; database state only, verified by query.
2. **Task 2: Preserve the classical lichess arm's original evals** — `8bdbfee04` (fix, the deviation below); the snapshot itself is database state.
3. **Task 3: Write the tranche readiness file** — committed together with the plan metadata below (docs).

**Plan metadata:** the `docs(212-09): complete classical tranche materialization plan` commit — the one carrying this file, so it cannot cite its own hash.

## Files Created/Modified

- `.planning/phases/212-benchmark-full-game-analysis-lane/212-09-TRANCHE-READINESS.md` — the frozen decision numbers, disk verdict, leak baseline and pre-launch checklist for 212-10.
- `scripts/benchmark_lane.py` — `snapshot_lichess_evals` now streams on a read session and writes/commits on a separate write session.
- `tests/test_benchmark_lane.py` — the stream fixture models the real cursor's lifetime rule and returns the read session; new batch-boundary regression test.

## Decisions Made

- **Inline execution over a dispatched subagent.** The plan's objective instructs this explicitly, and project history records long database-bound work being lost when an agent's connection drops mid-plan. Vindicated: the run spanned a crash, a code fix, a commit and a 100-second retry, all of which needed the orchestrator's own context.
- **50,737 selected vs the ~54,390 planning estimate — accepted, not investigated further.** The gap is 6.7%, well inside the plan's own "order of magnitude" tripwire, and every structural check on the resulting set passes (0 orphans, 0 wrong-TC, 0 arm mismatches, smoke set subsumed exactly once). The eligible set is gated on `benchmark_ingest_checkpoints.status = 'completed'` (763 users qualify for classical), so the estimate and the live draw were never guaranteed to agree to the digit.
- **Fixed the cursor bug properly rather than around it.** Raising `SNAPSHOT_COMMIT_BATCH_SIZE` past the row count, or switching the read to `.all()`, would each have made the symptom disappear while discarding a property the function's docstring commits to.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The snapshot's batched commit invalidated its own streaming cursor**

- **Found during:** Task 2 (Preserve the classical lichess arm's original evals)
- **Issue:** `snapshot_lichess_evals` read via `session.stream(...)` (a server-side cursor) and committed every `SNAPSHOT_COMMIT_BATCH_SIZE` (5,000) rows on that *same* session. The commit ends the transaction the cursor lives in, so the very next fetch died with `asyncpg.exceptions.NoActiveSQLTransactionError: cursor cannot be created outside of a transaction`. The first full-scale pass crashed at exactly row 5,000. The path had never run before: 212-06's smoke tranche produced 397 snapshot rows and never reached the threshold, and the unit fixtures fed single-row streams.
- **Fix:** Split read and write onto separate sessions — the stream stays on `read_session`, every `add` and `commit` goes to `write_session`. Both documented properties survive (server-side cursor for the ~1.9M-row read, bounded write transactions). Added a docstring note recording why the two sessions are not an accident.
- **Files modified:** `scripts/benchmark_lane.py`, `tests/test_benchmark_lane.py`
- **Verification:** New test `test_snapshot_batched_commit_does_not_invalidate_the_stream` feeds 2× the batch size + 1 rows through a fake stream that enforces the real cursor's lifetime rule, and asserts the streaming session is never committed. **Proven by reverting the fix**: the test then fails with the same error and the same `inserted=5,000` progress line as the live crash. Full file suite: 19 passed. `ruff format`/`ruff check` clean; `ty check` clean on both changed files (the 7 diagnostics in `scripts/` are pre-existing and in unrelated files). Live confirmation: the retried pass completed 1,919,182 inserts with exit 0.
- **Committed in:** `8bdbfee04`

---

**Total deviations:** 1 auto-fixed (1 × Rule 1 - Bug)
**Impact on plan:** Necessary for correctness — the plan could not complete without it, and the bug would otherwise have surfaced during 212-10's multi-day run instead. No scope creep: the fix is confined to the one function the plan exercises, plus its tests.

## Issues Encountered

**The 5,000 rows committed by the crashed pass.** The failed first pass had already committed one batch before dying. Because the subcommand dedups on `(game_id, ply)`, the retry skipped them (`skipped=5,397` = 5,000 + the 397 smoke rows) rather than double-inserting. No cleanup was needed and no rows were lost — the idempotency contract absorbed the partial failure exactly as designed.

**Selection count below the planning estimate.** Covered under Decisions Made; not treated as a blocker.

## Next Phase Readiness

**Ready for 212-10.** Its blocking decision checkpoint can now be presented immediately on the frozen numbers in `212-09-TRANCHE-READINESS.md`, with the coverage gap at zero (so `start-now` is a permitted option, which it was not on 212-06's first pass) and the disk verdict already computed.

The three remaining BENCHLANE-06 `missing:` items are all 212-10's: the fleet run against :8001, the `record` report under `reports/benchmark-lane/`, and the post-run vacuum.

Two things 212-10 must not lose sight of:

- The tranche-start leak baseline is **1,846,458**. Any climb above it during the run means fleet capacity is leaking onto unselected games — that is the abort signal, unchanged from 212-08.
- The launch still requires two secrets this session cannot read (the write-capable `flawchess_benchmark` password and both `EVAL_OPERATOR_TOKEN` values), so Task 2 of that plan remains genuinely operator-executed.

## Self-Check: PASSED

- `212-09-TRANCHE-READINESS.md` exists on disk and is non-empty.
- `git log --oneline --all --grep="212-09"` returns the fix commit and this metadata commit.
- All acceptance criteria re-run: Task 1 five criteria PASS, Task 2 four criteria PASS, Task 3 five criteria PASS.
- Plan-level `<verification>` re-run: classical selection is 50,737 across both arms and a repeat select inserts 0; coverage gap is 0 and a repeat snapshot inserts 0; the readiness file carries all five numbers, a worded disk verdict and the tranche-start baseline; zero rows exist for any tranche other than classical.
