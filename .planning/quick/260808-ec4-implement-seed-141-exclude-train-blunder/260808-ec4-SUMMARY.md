---
phase: quick-260808-ec4
plan: 01
subsystem: train
tags: [sqlalchemy, postgresql, train, spaced-repetition]

# Dependency graph
requires:
  - phase: 205-train-grading-oracle-agreement
    provides: dead_band_admissible, the three SR read sites this predicate joins, mover_color_expr-based ply-parity mover derivation
provides:
  - "SECOND_BEST_WINNING_FLOOR_CP (200 cp) and second_best_not_winning_admissible in app/services/train_pool.py"
  - "The predicate wired into all three SR read sites: pool_entry_stmt, get_waiting_puzzle_count's due_count_stmt, compose_and_materialize_session's due_stmt re-serve scan"
affects: [train-pool-composition, train-drill-item-lifecycle]

actuals:
  tokens: 7900
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "SQL exclusion predicates written in positive (admissible) form with explicit IS NULL guards, never a bare NOT over a NULL-yielding comparison (mirrors dead_band_admissible's discipline)"

key-files:
  created: []
  modified:
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - tests/services/test_train_pool.py
    - tests/repositories/test_train_repository.py
    - CHANGELOG.md

key-decisions:
  - "train_repository.py's get_waiting_puzzle_count due_count_stmt (~line 1010) is a THIRD SR read site, not just the two the operator named, by the same Phase 205 D-05 argument (an excluded item must not inflate the nav badge for a session that composes without it)"
  - "forcing_line_gate.STILL_WINNING_FLOOR_CP (also 200) is a separate, independently retunable knob and was deliberately NOT reused"

patterns-established:
  - "Mover-POV sign/mate derivation via mover_color_expr(ply_col), never Game.user_color, so a predicate can serve the Game-join-free COUNT statement"

requirements-completed: [SEED-141]

coverage:
  - id: D1
    description: "Blunders whose second-best move still leaves the mover >= +200cp winning (mover POV), or facing an outright mate for the mover, are excluded from the Train pool at all three SR read sites"
    requirement: "SEED-141"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::TestSecondBestNotWinningAdmissible"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::test_still_winning_item_not_reserved_when_due"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py::test_waiting_count_excludes_still_winning_due_item"
        status: pass
    human_judgment: false

duration: ~10min
completed: 2026-08-08
status: complete
---

# Quick Task 260808-ec4: Exclude Train Blunders Whose Second-Best Still Wins Summary

**Added `SECOND_BEST_WINNING_FLOOR_CP` (+200cp) + `second_best_not_winning_admissible` to `train_pool.py`, wired into all three SR read sites so a Train blunder whose runner-up move still leaves the mover clearly winning no longer qualifies as a puzzle.**

## Performance

- **Duration:** ~10 min (commit span 10:30:02 → 10:37:06 local; research/read phase before the first commit not separately timed)
- **Tasks:** 3/3 completed
- **Files modified:** 5 (`app/services/train_pool.py`, `app/repositories/train_repository.py`, `tests/services/test_train_pool.py`, `tests/repositories/test_train_repository.py`, `CHANGELOG.md`)

## Accomplishments

- `SECOND_BEST_WINNING_FLOOR_CP: int = 200` declared next to `WINNABILITY_FLOOR_ES`/`SHARP_GAP_ES`, carrying SEED-141 provenance, the prod measurement (23.9% of pool removed, 90.7% of the cut soft, sharp share 31.9% → 38.9%, 14,704 candidates whose runner-up outright mates), the operator's +2-vs-+3 resolution, and a note not to reuse `forcing_line_gate.STILL_WINNING_FLOOR_CP`.
- `second_best_not_winning_admissible(missed_pv_lines_col, ply_col)` added immediately after `dead_band_admissible`, built on the same skeleton (mover POV via `mover_color_expr`, `Float`-cast `s`, `Integer`-cast `sm`), written in positive/admissible form with explicit `IS NULL` guards.
- Wired into all three SR read sites: `pool_entry_stmt` (Task 1), `get_waiting_puzzle_count`'s `due_count_stmt`, and `compose_and_materialize_session`'s `due_stmt` re-serve scan (Task 2).
- 9 new DB round-trip tests in `TestSecondBestNotWinningAdmissible` proving the boundary (400/200/199/-400), the black-mover sign flip, both mate branches, mate priority over cp, and the isolated `su == ""` sentinel survival — plus 2 new repository-level tests proving the re-serve/skip behavior at the other two sites (11 new tests total).
- Full pre-merge gate green: formatter clean, linter clean, `ty` zero errors, 4164 backend tests passing, 0 skipped fixture repairs needed.
- CHANGELOG `## [Unreleased]` → `### Changed` entry added.

## Task Commits

Each task was committed atomically:

1. **Task 1: Verify sign/offset conventions, add the constant + predicate, wire the entry gate** - `82e2a081f` (feat)
2. **Task 2: Prove the sign flip/mate branch/sentinel, enforce at the other two SR sites** - `0d4e0fee1` (test)
3. **Task 3: Full pre-merge gate + CHANGELOG entry** - `77b6716ad` (chore)

_TDD flow: Task 1 and Task 2 both wrote failing tests first (confirmed RED — see "Findings" below), then implemented/wired to GREEN, per plan._

## Files Created/Modified

- `app/services/train_pool.py` - `SECOND_BEST_WINNING_FLOOR_CP` constant + `second_best_not_winning_admissible` predicate + `__all__` export; wired into `pool_entry_stmt`.
- `app/repositories/train_repository.py` - predicate imported and wired into `get_waiting_puzzle_count`'s `due_count_stmt` and `compose_and_materialize_session`'s `due_stmt`.
- `tests/services/test_train_pool.py` - `TestSecondBestNotWinningAdmissible` (9 tests): boundary (400/200/199/-400), black-mover sign flip, mate-for/mate-against/mate-priority, isolated sentinel survival. Several carry both a white-mover and a black-mover assertion in one test, which is what makes the color-blindness mutation unsatisfiable.
- `tests/repositories/test_train_repository.py` - `_STILL_WINNING_PV_LINES` fixture + `test_still_winning_item_not_reserved_when_due` + `test_waiting_count_excludes_still_winning_due_item`.
- `CHANGELOG.md` - one `### Changed` bullet under `## [Unreleased]`.

## Decisions Made

- **`train_repository.py:~1010` is a third SR read site.** The operator's brief named two sites (`pool_entry_stmt` and the `due_stmt` re-serve scan) and asked whether `get_waiting_puzzle_count`'s `due_count_stmt` is a third. It is: the identical Phase 205 D-05 argument applies verbatim — an excluded item must not inflate the nav badge for a session that composes without it. Wired with the same predicate, same comment register as the Phase 205 precedent.
- **`forcing_line_gate.STILL_WINNING_FLOOR_CP` was NOT reused**, despite being numerically identical (200). It is a PV line-extension cutoff, independently retunable from this selection predicate — the coincidence is documented in the new constant's comment so a future reader doesn't "deduplicate" them.

## Findings (per the plan's `<output>` requirements)

**1. Sign convention.** Confirmed via `app/models/game_flaw.py`'s D-05 blob-shape comment and `app/services/forcing_line_gate.py`'s `PvNode` TypedDict: `s`/`sm` are WHITE-perspective, matching `b`/`bm`. Mover POV is derived from ply parity via `mover_color_expr(ply_col)` (never `Game.user_color`), exactly mirroring `dead_band_admissible` — this is what lets the same predicate serve the Game-join-free `get_waiting_puzzle_count` COUNT statement.

**2. Ply-offset finding.** Verified against `app/services/eval_apply.py`: `_build_line_blobs` sets `node0_ply = flaw_ply` for the "missed" line and reads `pos_eval.get(node0_ply)` / `second_best_map.get(node0_ply)` directly — `pos_eval` is a POSITION-keyed map (the eval OF that ply's own position). `_post_move_eval` (the single site of the eval pipeline's +1 post-move storage shift, per its own docstring) is used only when writing `game_positions` rows, and is never called inside `_build_line_blobs` or its caller `_build_flaw_multipv2_blobs`. So node 0 of `missed_pv_lines` is decision-ply-keyed: `b`/`s` are the MultiPV-1/MultiPV-2 scores AT the flaw's own decision position, exactly "if the mover plays the runner-up instead of the best move." **No offset correction was needed** — this confirms the plan's expected finding rather than contradicting it.

**3. Three-site decision.** `train_repository.py:~1010` (`get_waiting_puzzle_count`'s `due_count_stmt`) IS a third SR read site — see "Decisions Made" above.

**4. Test fixtures repaired by the new gate.** None. The full pre-merge gate ran clean on the first pass (4164 passed, 0 failed, 0 skipped-newly). The plan flagged `tests/routers/test_train.py`'s `_SHARP_PV_LINES` (`s = -200`, used at an even/white-mover ply, i.e. -200 from the mover's POV — well below the +200 floor) as expected to survive; it did, confirmed by the full suite run rather than assumed. No other fixture in the suite had a node-0 `s` at or above +200 (mover POV) at a qualifying ply, so no repairs were required.

## Deviations from Plan

None — plan executed exactly as written. No Rule 1-4 auto-fixes were needed; the investigation's expected findings (sign convention, no ply-offset correction) were both confirmed from the code rather than contradicted.

## Issues Encountered

None.

## RED-phase confirmation (TDD load-bearing check)

Per the plan's constraint, both load-bearing test classes were confirmed to fail for the right reason before the predicate/wiring existed:

- Task 1's 4 `TestSecondBestNotWinningAdmissible` boundary tests: run before the predicate was wired into `pool_entry_stmt` — the 2 `ABSENT`-expecting tests failed (`assert True is False`, i.e. the row was still admitted), the 2 `PRESENT`-expecting tests passed trivially. This confirms the tests actually exercise the new gate rather than passing regardless.
- Task 2's 2 new `train_repository.py` tests (`test_still_winning_item_not_reserved_when_due`, `test_waiting_count_excludes_still_winning_due_item`): run before the other two sites were wired — both failed (`assert count == 1` got `2`, and the re-serve scan re-admitted the still-winning item instead of skipping it), confirming those two sites were the actual gap being closed.
- The isolated `su == ""` sentinel test (`test_no_second_move_sentinel_survives_in_isolation`) is deliberately NOT a `pool_entry_stmt` round-trip — `dead_band_admissible` already excludes `su == ""` via its own clause, so a round-trip test would pass for the wrong reason regardless of any NULL-under-NOT bug in the new predicate. It queries `answer_key_present` + `second_best_not_winning_admissible` alone and asserts the row IS returned, which is what actually catches the bug the seed warns about.

## Orchestrator re-verification (independent of the executor)

The executor's RED-phase claims above were re-checked by the orchestrator with two literal
source mutations against the final committed code, since a sign bug and a NULL-under-NOT bug
are exactly the two failure modes this task was commissioned to avoid:

- **Color-blindness mutation.** `cp_sign` forced to `1.0` for both colors (`case((mover_color
  == "white", 1.0), else_=1.0)`). Result: `test_black_mover_sign_flip` failed with
  `assert True is False`, the other 8 passed. So exactly one test carries the sign proof and
  it is not satisfiable by a color-blind predicate.
- **Bare-NOT mutation.** The whole positive-form return replaced with the naive
  `not_(or_(second_cp_mover >= FLOOR, second_mate_mover > 0))` the seed warns about. Result:
  6 of 9 failed, including `test_no_second_move_sentinel_survives_in_isolation` — confirming
  the isolated sentinel test does catch the NULL-under-NOT bug rather than passing for the
  wrong reason.

Source restored byte-identically after each mutation (`git diff --stat` empty), suite re-run
green. The full gate was also re-run by the orchestrator on the final tree: ruff format
(352 files clean), ruff check clean, `ty` zero errors, `pytest -n auto` 4164 passed / 19 skipped.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- No follow-on phase required by this change; it is a self-contained selection-predicate tightening.
- SEED-141 is now implemented and can be moved to `.planning/seeds/closed/` in a future housekeeping pass (not done here — out of this quick task's scope).
- Deploy status: shipped to `main` only. Not yet promoted to `production`/deployed — a separate `main → production` PR + `bin/deploy.sh` is needed to reach prod, per this project's GitLab Flow.

## Self-Check: PASSED

- `app/services/train_pool.py` — FOUND (contains `SECOND_BEST_WINNING_FLOOR_CP`, `second_best_not_winning_admissible`)
- `app/repositories/train_repository.py` — FOUND (imports and wires the predicate at 2 sites)
- `tests/services/test_train_pool.py` — FOUND (`TestSecondBestNotWinningAdmissible`, 9 tests, all passing)
- `tests/repositories/test_train_repository.py` — FOUND (`_STILL_WINNING_PV_LINES`, 2 new tests, both passing)
- `CHANGELOG.md` — FOUND (`### Changed` entry under `## [Unreleased]`)
- Commit `82e2a081f` — FOUND in `git log --oneline --all`
- Commit `0d4e0fee1` — FOUND in `git log --oneline --all`
- Commit `77b6716ad` — FOUND in `git log --oneline --all`
- `grep -n "second_best_not_winning_admissible" app/services/train_pool.py app/repositories/train_repository.py` — shows the definition, the export, and 3 call sites (`pool_entry_stmt`, `due_count_stmt`, `due_stmt`)
- Full backend suite: 4164 passed, 19 skipped, 0 failed (`uv run pytest -n auto -q`)
- `uv run ty check app/ tests/`: All checks passed (zero errors)

---
*Quick task: 260808-ec4*
*Completed: 2026-08-08*
