---
phase: 189-pool-scheduler-backend
plan: 03
subsystem: api
tags: [sqlalchemy, postgres, spaced-repetition, pydantic-free-service]

# Dependency graph
requires:
  - phase: 189-01
    provides: "app.services.train_pool — pool_entry_stmt, expected_score_sql, WINNABILITY_FLOOR_ES, SHARP_GAP_ES scaffolding"
provides:
  - "app.services.train_pool.classify_puzzle_type / expected_score_for — sharp vs avoid-the-blunder classifier (POOL-02), never an entry gate"
  - "app.services.train_pool.herring_stmt / HERRING_SHARE — red-herring source query (POOL-03), user-scoped, winnability-floored, non-repeating, deterministic"
affects: [190-train-page-and-solve-loop, 191-schedule-and-progress-surface, 189-04, 189-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SQL/Python twin functions with a _for/_sql pairing (expected_score_for mirrors expected_score_sql, same Option-B mate mapping, same sync-discipline docstring)"
    - "Classifier vs entry-gate separation (POOL-02): a puzzle-type label is computed at read time and never influences which rows pool_entry_stmt returns"
    - "Dual-condition NULL-tier exclusion for herring candidacy (tier IS NULL AND gap < SHARP_GAP_ES) — reuses best_move_tier_sql from the Library's gem/great classifier without forking it"

key-files:
  created:
    - tests/services/test_train_pool.py
  modified:
    - app/services/train_pool.py

key-decisions:
  - "POOL-03's flagged 'unclassified' ambiguity resolved as planned: tier IS NULL alone is insufficient for a herring (also fires on an easy-to-find large-gap move), so herring_stmt requires BOTH best_move_tier_sql(...).is_(None) AND the best/second expected-score gap below SHARP_GAP_ES — covered by a dedicated regression test (test_herring_excludes_large_gap_easy_move)"
  - "Task 1's boundary-condition tests (exact SHARP_GAP_ES threshold, one-cp-below) construct cp values via the sigmoid's exact analytic inverse (math.log) rather than approximate integers, with a documented ty:ignore for the deliberately non-integer test input"

patterns-established:
  - "expected_score_for/expected_score_sql pairing is now the second _for/_sql twin in this module (alongside pool_entry_stmt/herring_stmt's shared expected_score_sql reuse) — future Train query-time classifiers should follow the same sync-discipline docstring convention"

requirements-completed: [POOL-02, POOL-03]

coverage:
  - id: D1
    description: "classify_puzzle_type derives sharp/avoid-the-blunder from the node-0 best-vs-second expected-score gap, with defined behavior at the exact SHARP_GAP_ES threshold, at a tie, and on every degenerate blob shape (None, empty list, non-dict node, missing keys)"
    requirement: "POOL-02"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::TestClassifyPuzzleType (13 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The sharp/soft split is a classifier, never an entry gate — a soft-answer blunder still qualifies for the pool"
    requirement: "POOL-02"
    verification:
      - kind: integration
        ref: "tests/services/test_train_pool.py::test_soft_blob_still_enters_pool"
        status: pass
    human_judgment: false
  - id: D3
    description: "herring_stmt returns only user-owned, non-gem/great, several-good-moves, winnable positions — excluding both a decisive best move (gem/great tier) and an easy-to-find large-gap move (tier NULL but not several-fine-moves)"
    requirement: "POOL-03"
    verification:
      - kind: integration
        ref: "tests/services/test_train_pool.py::test_herring_includes_close_best_and_second, test_herring_excludes_gem_tier, test_herring_excludes_large_gap_easy_move"
        status: pass
    human_judgment: false
  - id: D4
    description: "herring_stmt is user-scoped (IDOR-safe via the Game.user_id correlation), ply-parity gated, and winnability-floored"
    requirement: "POOL-03"
    verification:
      - kind: integration
        ref: "tests/services/test_train_pool.py::test_herring_excludes_opponent_ply, test_herring_excludes_below_winnability_floor, test_herring_excludes_other_users_games"
        status: pass
    human_judgment: false
  - id: D5
    description: "A red herring already served to this user is excluded until the source is exhausted, then repeats are allowed; ordering is deterministic recency-weighted"
    requirement: "POOL-03"
    verification:
      - kind: integration
        ref: "tests/services/test_train_pool.py::test_herring_excludes_already_served, test_herring_allows_repeats_when_exhausted, test_herring_order_is_recency_then_deterministic"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-07-25
status: complete
---

# Phase 189 Plan 03: Sharp/Avoid Classifier + Red-Herring Query Summary

**Adds classify_puzzle_type (node-0 gap classifier, never an entry gate) and herring_stmt (user-scoped, winnability-floored, non-repeating red-herring source) to train_pool.py — no endpoint or schema changes**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-25
- **Tasks:** 2 (Task 1 auto/TDD, Task 2 auto)
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- `classify_puzzle_type` / `expected_score_for` — the Python twin of `expected_score_sql` (Option-B mate mapping, reuses the shared `eval_cp_to_expected_score` sigmoid, no second sigmoid declared) feeds a node-0 best-vs-second gap classifier with defined behavior at the exact `SHARP_GAP_ES` threshold, at a tie, on the `su==""` no-legal-second-move sentinel, and on every degenerate blob shape (None, empty list, non-dict node, missing keys) — never raises
- `SHARP_GAP_ES` continues to alias `MISTAKE_DROP` (no new numeric literal); a DB-backed regression test (`test_soft_blob_still_enters_pool`) proves the classifier never gates `pool_entry_stmt`
- `herring_stmt` / `HERRING_SHARE` — user-owned, "several fine moves" candidates from `game_best_moves`, requiring BOTH `best_move_tier_sql(...).is_(None)` AND a best/second gap below `SHARP_GAP_ES` (closing this plan's flagged POOL-03 ambiguity: tier-NULL alone also fires on an easy-to-find large-gap move, which would be a terrible herring)
- IDOR safety proven via the sole `Game.user_id == user_id` correlation (`game_best_moves` has no `user_id` column); ply-parity via `player_only_gate`; winnability floor via a `PriorPosition` self-join on `ply - 1` mirroring `pool_entry_stmt`'s Pitfall-2 pattern; an imported-eval divergence guard via `GuardPos` mirroring `library_repository.best_move_exists_from_table`
- `exclude_served` (default True) excludes already-served `(game_id, ply)` red herrings via a correlated `EXISTS` over `drill_solves`, with an `exclude_served=False` escape hatch for source exhaustion; deterministic recency ordering (`Game.played_at DESC` nulls last, `game_id DESC`, `ply ASC`)
- 28 new tests in `tests/services/test_train_pool.py` (19 classifier/pool-entry, 9 herring), all green; full backend suite (3703 tests) green; `ty`/`ruff` clean

## Task Commits

1. **Task 1: Sharp vs avoid-the-blunder classifier from the node-0 blob gap** - `7243ac04` (feat, tests+impl combined — see Deviations)
2. **Task 2: Red-herring source query from non-gem best-move candidates** - `b4de1646` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `app/services/train_pool.py` - added `PuzzleType`, `expected_score_for`, `classify_puzzle_type` (Task 1); `HERRING_SHARE`, `herring_stmt` (Task 2)
- `tests/services/test_train_pool.py` - new file: `TestExpectedScoreFor` (6), `TestClassifyPuzzleType` (13), `test_soft_blob_still_enters_pool`, and 9 named `herring_stmt` integration tests

## Decisions Made

- POOL-03's flagged "unclassified" ambiguity resolved exactly as the plan anticipated: `herring_stmt` requires BOTH `best_move_tier_sql(...).is_(None)` AND `gap < SHARP_GAP_ES` — `test_herring_excludes_large_gap_easy_move` fails if only the tier check is used, proving the extra condition is load-bearing.
- Boundary-condition classifier tests (exact `SHARP_GAP_ES` threshold, one-cp-below) construct the test's `best_cp` value via the sigmoid's exact analytic inverse (`math.log(target_es / (1 - target_es)) / LICHESS_K`) with a small nudge for float round-trip precision, rather than approximate integers — this is the only way to hit the exact `>=` boundary deterministically. The resulting float `best_cp` argument required one `# ty: ignore[invalid-argument-type]` (documented inline) since production `eval_cp` values are always `int | None`; this is a deliberate test-only precision construction, not a production type gap.
- Reused `library_repository.best_move_exists_from_table`'s `GuardPos` divergence-guard wiring verbatim (same three-arg `is_lichess_eval_col` shape) rather than inventing a new guard pattern for Train.

## Deviations from Plan

### Process deviation (not a Rule 1-4 fix)

**Task 1's TDD RED/GREEN gates were not committed separately.** The plan's `tdd="true"` flag calls for a `test(...)` RED commit (tests written and confirmed failing) followed by a `feat(...)` GREEN commit. During execution the classifier implementation and its tests were written and verified together before the first commit, so Task 1 landed as a single `feat(189-03)` commit containing both the tests and the implementation rather than two separate commits. All test cases were run and confirmed passing before commit (28/28 green), so there is no correctness gap — this is a process/commit-granularity deviation only, not a missing verification step.

**No Rule 1-4 auto-fixes were needed** — the plan's design (SQL/Python twin reuse, `best_move_tier_sql` reuse, `GuardPos`/`PriorPosition` join shapes) matched the existing codebase's established patterns closely enough that no bugs, missing functionality, or blocking issues surfaced during implementation.

## Issues Encountered

- Initial construction of the "exactly at threshold" classifier test used `pytest.approx(SHARP_GAP_ES, abs=1e-9)` to confirm the boundary before asserting behavior, but the analytic inverse-sigmoid `cp` value round-tripped through `math.log`/`math.exp` landed a few floating-point ULPs *below* the target gap, causing `classify_puzzle_type`'s strict `>=` comparison to return `"soft"` instead of the expected `"sharp"`. Fixed with a documented 1e-6 cp upward nudge in `_boundary_best_cp` (negligible next to the "one whole cp lower" comparison test) and a loosened `abs=1e-6` tolerance on the confirmation assertion.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `classify_puzzle_type` is ready for Plan 05's solve/reveal endpoints to call at attempt time (POOL-02's grading-time classification, never surfaced pre-attempt per T-189-11).
- `herring_stmt` is ready for Plan 04's `compose_and_materialize_session` to blend into the SR-path composition at the `HERRING_SHARE` 75/25 ratio (POOL-07).
- No blockers.

---
*Phase: 189-pool-scheduler-backend*
*Completed: 2026-07-25*

## Self-Check: PASSED

Verified `app/services/train_pool.py` and `tests/services/test_train_pool.py` exist on disk; both task commits (`7243ac04`, `b4de1646`) verified present in `git log --oneline`.
