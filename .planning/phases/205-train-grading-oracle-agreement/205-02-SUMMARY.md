---
phase: 205-train-grading-oracle-agreement
plan: 02
subsystem: database
tags: [sqlalchemy, postgresql, jsonb, python, train]

# Dependency graph
requires:
  - phase: 205-01
    provides: the root free-play grading fix (Proposal B) — landed first per D-01, no shared files with this plan
  - phase: 189
    provides: pool_entry_stmt, classify_puzzle_type, answer_key_present, expected_score_sql, the ply-parity single-source convention
provides:
  - "mover_color_expr — the SQL twin of mover_color_for_ply, living beside is_opponent_expr in query_utils.py"
  - "dead_band_admissible — the shared selection predicate excluding [INACCURACY_DROP, BLUNDER_DROP) drops and both D-03 degenerate node-0 shapes, applied live at all three SR selection sites"
  - "the measured, documented pool cost of the band (34.80% total, 260 users, 1 newly starved, 84.7% game retention) shipped in CHANGELOG.md"
affects: []

# Actuals (#2632)
actuals:
  tokens: 9182
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SQL ply-parity mover-color twin (mover_color_expr) colocated with is_opponent_expr in query_utils.py, so a caller with a ply column but no Game join can still name the mover"
    - "A single shared selection predicate (dead_band_admissible) applied identically at three call sites (entry, re-serve, count) rather than three independently-drifting comparisons"
    - "Float-cast (not integer-cast) JSONB numeric extraction for a predicate whose boundary tests are constructed via a non-integer sigmoid inverse — an integer cast would raise on that exact input"

key-files:
  created: []
  modified:
    - app/repositories/query_utils.py
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - tests/repositories/test_query_utils.py
    - tests/services/test_train_pool.py
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - CHANGELOG.md

key-decisions:
  - "D-05/D-11 (inherited, applied): the band is enforced live at all three SR selection sites (pool_entry_stmt, due_stmt, due_count_stmt) via one shared predicate, never snapshotted onto drill_items."
  - "D-03 (inherited, applied): both classify_puzzle_type degenerate node-0 shapes (su==\"\", unreadable blob) are excluded at the selection predicate, not in the classifier, which keeps its current return contract."
  - "D-06 (inherited, applied): load_session_puzzles gains no band check — an already-materialized open session serves a banded item out untouched. Confirmed by reading, not modified."
  - "D-02 (inherited, applied): the fresh prod measurement (24.29% dead-band + 10.51% degenerate = 34.80% total; 260 users, 1 newly starved, 84.7% retention) ships as documentation in CHANGELOG.md — it does not gate the band, per D-02's measure-and-record framing."
  - "Cast b/s (centipawn keys) to a float type, not integer, per the plan's finding 2: the boundary tests construct b via the exact sigmoid inverse (non-integer), and an integer cast of that value raises in Postgres."

patterns-established:
  - "dead_band_admissible: a JSONB-node-0 selection predicate reusing expected_score_sql twice (never a second sigmoid), deriving mover color from ply parity rather than a Game join, so the same predicate serves both row-returning statements and a COUNT-only statement with no Game in scope."

requirements-completed: [ORACLE-03, ORACLE-04, ORACLE-05, ORACLE-06]

coverage:
  - id: D1
    description: "A blunder whose node-0 best-vs-second expected-score drop sits in [INACCURACY_DROP, BLUNDER_DROP) is absent from pool_entry_stmt, both boundary edges pinned exactly (closed lower / open upper), both D-03 degenerate paths excluded without raising, mover color from ply parity alone (black-mover parity flips admissibility), and the SQL/Python twin agreement proved at the exact boundary"
    requirement: ORACLE-03
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::TestDeadBandAdmissible (12 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Both classify_puzzle_type degenerate node-0 shapes (su==\"\", unreadable blob) are excluded by the selection predicate while the classifier's own return contract is unchanged"
    requirement: ORACLE-04
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::TestDeadBandAdmissible::test_no_second_move_sentinel_is_absent, test_non_dict_node_is_absent, test_node_with_no_second_move_keys_is_absent, test_json_null_node_is_absent_and_raises_nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "An already-tracked drill_items row whose backing blob is rewritten into the band stops being served by the next composition, with zero writes (status/due_date/row existence all untouched), and is excluded from the waiting-puzzle count while an admissible item still counts"
    requirement: ORACLE-05
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_banded_item_not_reserved_when_due, test_waiting_count_excludes_banded_due_item"
        status: pass
    human_judgment: false
  - id: D4
    description: "An item already materialized into an OPEN session is still served out unchanged — no mid-session eviction (D-06)"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_open_session_serves_item_after_backing_blob_moves_into_band"
        status: pass
    human_judgment: false
  - id: D5
    description: "The measured prod cost (34.80% total pool reduction, 260 users with pool material, 1 newly starved, 84.7% average distinct-game retention) ships as a documented CHANGELOG number rather than a discovery"
    requirement: ORACLE-06
    verification:
      - kind: other
        ref: "CHANGELOG.md [Unreleased] Fixed section, 2 bullets referencing Phase 205"
        status: pass
    human_judgment: false
  - id: D6
    description: "Every one of the three backend production changes this plan makes (pool_entry_stmt, due_stmt, due_count_stmt) is independently mutation-proved: reverting each clause alone turns its own named test red while the other sites' tests stay green"
    verification:
      - kind: unit
        ref: "manual revert/restore cycles, recorded below under Mutation Test Results"
        status: pass
    human_judgment: false

# Metrics
duration: ~25min
completed: 2026-08-04
status: complete
---

# Phase 205 Plan 02: Dead-Band Pool Exclusion Summary

**A shared SQLAlchemy predicate (`dead_band_admissible`) excludes drill items whose node-0 best-vs-second drop sits in `[0.05, 0.15)` at all three Train SR selection sites, live and unsnapshotted — closing SEED-137 case 1, at a measured real cost of 34.80% of the pool (not the 12% the phase was scoped on).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-04T17:00:26Z (immediately after 205-01's plan-metadata commit)
- **Completed:** 2026-08-04T17:25:24Z
- **Tasks:** 3 completed
- **Files modified:** 8

## Accomplishments

- `mover_color_expr(ply_col)` added to `app/repositories/query_utils.py`, beside `is_opponent_expr` — the SQL twin of `mover_color_for_ply`, letting a caller with a ply column but no `Game` join still name the mover.
- `dead_band_admissible(missed_pv_lines_col, ply_col)` added to `app/services/train_pool.py`, beside `answer_key_present` — excludes any node-0 whose best-vs-second expected-score gap sits in `[INACCURACY_DROP, BLUNDER_DROP)` = `[0.05, 0.15)` (lower edge closed, upper edge open), plus both D-03 degenerate node-0 shapes, reusing `expected_score_sql` twice (never a second sigmoid).
- The predicate is applied identically, live, at all three SR selection sites: `pool_entry_stmt` (entry), `compose_and_materialize_session`'s `due_stmt` (re-serve), and `get_waiting_puzzle_count`'s due-count statement (nav badge) — the last with no `Game` join added, exactly as its pre-existing "not needed for a count" design requires.
- Two pre-existing default test fixtures (`test_train_repository.py`, `test_train.py`) whose drop (~0.0643) happened to sit inside the new band were retuned to ~0.0092, preserving their prior "soft" classification; the old blob survives verbatim as `_BANDED_PV_LINES` for the in-band coverage.
- 12 new backend tests covering both boundaries, one-cp-either-side, both D-03 paths, the JSON-null-node edge, node0-only reading (a differently-classifying second node changes nothing), black-mover ply-parity flip, and the SQL/Python twin agreement at the exact boundary; plus 2 `mover_color_expr` parity tests and 3 re-serve/waiting-count/no-eviction tests.
- The measured prod cost (24.29% dead-band + 10.51% degenerate = 34.80% of the pool; 260 users with pool material, 225→224 able to fill a session; 84.7% average distinct-game retention) shipped as an explicit CHANGELOG.md number, alongside the Proposal B (205-01) fix.

## Task Commits

Each task was committed atomically:

1. **Task 1: The shared band predicate and the pool-entry gate** - `444857edf` (feat)
2. **Task 2: The two re-serve sites, and self-healing without a backfill** - `2248cfefb` (feat)
3. **Task 3: Ship the measured cost as a documented number, and close the phase gate** - `96ef6f846` (docs)

_No TDD (`tdd="true"`) RED/GREEN gate commits — the plan's tasks are `type="auto"` with tests written and verified alongside the production code in the same commit, per the plan's own task shape (not a plan-level `type: tdd`)._

## Files Created/Modified

- `app/repositories/query_utils.py` - `mover_color_expr(ply_col)`, the SQL ply-parity mover-color twin
- `app/services/train_pool.py` - `dead_band_admissible(missed_pv_lines_col, ply_col)`; wired into `pool_entry_stmt`'s WHERE list; `BLUNDER_DROP`/`Float`/`or_`/`mover_color_expr` imports; `__all__` updated
- `app/repositories/train_repository.py` - `dead_band_admissible` applied at `due_stmt` and `get_waiting_puzzle_count`'s due-count statement, both with new comment paragraphs
- `tests/repositories/test_query_utils.py` - `TestMoverColorExpr` (2 tests, DB-evaluated, compared against `mover_is_white_at_ply`)
- `tests/services/test_train_pool.py` - `_band_node`/`_pool_contains` helpers, `TestDeadBandAdmissible` (12 tests), `_seed_blunder_game` gains a `user_color` parameter
- `tests/repositories/test_train_repository.py` - `_BANDED_PV_LINES` constant, retuned `_MISSED_PV_LINES`, 3 new tests (re-serve self-heal, waiting-count exclusion, no-mid-session-eviction)
- `tests/routers/test_train.py` - retuned `_MISSED_PV_LINES` default blob + comment
- `CHANGELOG.md` - 2 `[Unreleased]` bullets under `### Fixed`, Phase 205 (Proposal B + Proposal A with the measured number)

## Decisions Made

- Followed D-05/D-11/D-03/D-06/D-02 exactly as locked in CONTEXT.md — no re-litigation, no new decision points at execution time.
- `bm`/`sm` (mate distances) stayed integer-cast; only `b`/`s` (centipawn keys) moved to a float cast, per the plan's finding 2 — mate distances are always whole numbers in practice and are only null-checked/sign-compared, never fed through the sigmoid-inverse boundary construction that motivates the float cast.
- `_material_flags`, `_pool_state`, and `load_session_puzzles` were read and confirmed to need zero edits (see "Confirmation" section below) — recorded per the plan's Task 2 action item 4 rather than silently skipped.

## Deviations from Plan

None - plan executed exactly as written. One clarification worth recording: the plan's own read_first for `train_pool.py` (`PATTERNS.md` §1) stated "there is no `__all__` list in this file" — that was incorrect (the module has one, lines 867-885 pre-existing). `dead_band_admissible` was added to it alphabetically between `compose_slots` and `expected_score_for`, which is the correct behavior regardless of the read_first note; not treated as a deviation since it doesn't change any acceptance criterion.

## D-03 Negligibility Result (its own line item, per Task 3)

D-03 required planning to **confirm** the no-second-move (`su == ""`) count was negligible rather than assume it. **It is not** — 127,419 items, 10.51% of the eligible pool, a full third of the total 34.80% exclusion. The decision to exclude those rows stands on its own reasoning regardless of the count: node 0 describes the position **before** the flaw move, so a position with exactly one legal move cannot have produced a blunder at all — these rows are a data artifact, not a real puzzle. The user's own framing during discussion: *"If there's only one legal move, it's hardly a puzzle, is it?"*

D-03's second degenerate path (an unreadable blob — non-object node 0, or either expected score resolving to NULL) is genuinely **zero rows** in prod (per `205-RESEARCH.md`'s Result 1 table). Its code path (`test_non_dict_node_is_absent`, `test_node_with_no_second_move_keys_is_absent`, `test_json_null_node_is_absent_and_raises_nothing`) is tested anyway, because correctness of a total operator does not depend on prevalence.

SEED-137's own item-level percentages (12.0% dropped, 67.6% kept-soft, 4.7% for the `[0.10, 0.15)` sub-band) did **not** reproduce against the fresh 2026-08-04 measurement (24.29%, 44.64%, 9.71% respectively — roughly double throughout, and the seed records no SQL to reconcile the discrepancy). The seed's **population and viability** conclusions reproduced **exactly**: 260 users with pool material (the seed's own denominator) and exactly one user newly starved.

## Confirmation: `_material_flags`, `_pool_state`, `load_session_puzzles` Read, Not Modified

- `_material_flags` (`train_repository.py:506-528`) derives `has_pool_candidates` from `select(pool_entry_stmt(user_id).exists())` — inherits the band transitively once `pool_entry_stmt` carries it. No edit.
- `_pool_state` (`train_repository.py:1078-1122`) derives its three-way state purely from `waiting_count` (now banded, via `get_waiting_puzzle_count`) and `has_pool_candidates`/`has_drill_items` (the former now banded, via `_material_flags`). No edit.
- `load_session_puzzles` (`train_repository.py:1125-1240`) was read in full: its eviction set is exactly two lazy-eviction reasons (missing `herring_pool` row; missing `Game` row or missing `game_flaws` row) — no band check present, and per D-06 (no mid-session eviction) none was added. Confirmed by `test_open_session_serves_item_after_backing_blob_moves_into_band`.

## Mutation Test Results (Mutation Contract rows 1, 2, 3)

All reverts were performed by hand against the committed code (via a scripted string replace + pytest run), observed red, then restored and re-confirmed green. None of the mutated states were committed — only the final, correct code is in the git history.

**Row 1 (`pool_entry_stmt`'s clause):** removed `dead_band_admissible(GameFlaw.missed_pv_lines, GameFlaw.ply)` from `pool_entry_stmt`'s WHERE list. Re-ran `tests/services/test_train_pool.py::TestDeadBandAdmissible` (12 tests): **9 tests FAILED** — every in-band-exclusion assertion flipped because the banded item reappeared in the pool (e.g. `assert True is False`). 3 tests that assert PRESENCE (not absence) stayed green, as expected. Restored the clause; all 12 passed again.

**Row 2 (`due_stmt`'s clause only, `due_count_stmt` left patched):** removed `dead_band_admissible(...)` from `due_stmt`'s WHERE list only. Re-ran the two targeted tests:
```
FAILED test_banded_item_not_reserved_when_due — AssertionError: assert 1 == 0
  (second.puzzle_count == 1, the banded item re-served)
PASSED test_waiting_count_excludes_banded_due_item
```
Confirms the two re-serve sites are covered **independently**, not transitively through one site. Restored; both passed.

**Row 3 (`due_count_stmt`'s clause only, `due_stmt` left patched):** removed `dead_band_admissible(...)` from `due_count_stmt`'s WHERE list only. Re-ran the same two tests:
```
FAILED test_waiting_count_excludes_banded_due_item — AssertionError: assert 2 == 1
  (the banded item was counted again)
PASSED test_banded_item_not_reserved_when_due
```
Restored; both passed. `git diff` confirmed empty (`git status --short`) after the final restore, and the full `tests/repositories/test_train_repository.py` suite (108 tests) re-ran green.

## Pre-Merge Gate Results (both stacks)

Per Task 3's action item 3, the full CLAUDE.md pre-merge gate was run once at the end of the plan:

| Step | Result |
|---|---|
| `uv run ruff format app/ tests/` | 348 files left unchanged |
| `uv run ruff check app/ tests/ --fix` | All checks passed |
| `uv run ty check app/ tests/` | All checks passed (zero errors) |
| `uv run pytest -n auto -x` | **4061 passed**, 19 skipped, 7 warnings (pre-existing deprecation/SAWarning noise, unrelated to this plan) |
| `cd frontend && npm run lint` | 0 errors (3 pre-existing warnings, generated `coverage/` artifacts only) |
| `cd frontend && npm test -- --run` | **3304 passed** (220 test files) |
| `cd frontend && npm run build` | Succeeded, 2 pages prerendered |

No formatting drift from any of the above steps — `git status --short` after the full gate showed only the intentional `CHANGELOG.md` edit, which was committed as Task 3's own docs commit (no separate style/chore commit was needed).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 205 is complete: both waves (205-01 Proposal B, frontend; 205-02 Proposal A, backend) are landed on `gsd/phase-205-train-grading-oracle-agreement`, full backend + frontend suites green, all 6 ROADMAP success criteria and all 5 Mutation Contract rows (2 frontend + 3 backend) satisfied.
- All 6 requirement IDs (`ORACLE-01`..`ORACLE-06`) minted across the two plans are now complete.
- Next: phase verification / squash-merge to `main` per the project's GitLab Flow (local squash-merge, no PR for `main`; `production` promotion is a separate later step).

---
*Phase: 205-train-grading-oracle-agreement*
*Completed: 2026-08-04*

## Self-Check: PASSED

All 8 modified files + this SUMMARY confirmed present on disk; all 3 task commit hashes (`444857edf`, `2248cfefb`, `96ef6f846`) confirmed in `git log --oneline --all`.
