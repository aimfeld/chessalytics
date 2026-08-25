---
phase: 260825-v8g
plan: 01
subsystem: database
tags: [postgresql, advisory-lock, eval-apply, deadlock, sentry, asyncio]

# Dependency graph
requires: []
provides:
  - "apply_full_eval acquires a per-game pg_advisory_xact_lock as its first statement"
  - "_game_write_lock_key(game_id) namespace-packed advisory key helper"
  - "TestSameGameWriteLock real-DB test proving the lock blocks/serializes concurrent same-game writers"
affects: [eval-pipeline, eval-remote-worker, eval-drain]

# Actuals (#2632)
actuals:
  tokens: 3900
  tasks: 2
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Transaction-scoped PostgreSQL advisory lock (pg_advisory_xact_lock) as a per-entity write serialization primitive, taken as the first statement of a shared write-session function so it covers every caller lane automatically."
    - "Namespaced 64-bit advisory key packing (namespace << 32 | id & mask) to keep multiple advisory-lock users' key spaces provably disjoint."

key-files:
  created: []
  modified:
    - app/services/eval_apply.py
    - tests/services/test_eval_apply.py

key-decisions:
  - "Lock lives inside apply_full_eval (not in either caller) so both live write lanes (router's _apply_atomic_submit and the drain's _full_drain_tick) are covered by one change, per Phase 150 R7's shared-function design."
  - "pg_advisory_xact_lock (transaction-scoped), not pg_advisory_lock (session-scoped) — apply_full_eval does not own the session, so only the xact-scoped form releases correctly on the caller's COMMIT/ROLLBACK with no explicit unlock and no leak path."
  - "Advisory key derived via a named helper (_game_write_lock_key) imported into the test rather than hardcoding the key computation, so a future namespace change cannot silently decouple test and production key derivation."

requirements-completed: [QUICK-V8G]

coverage:
  - id: D1
    description: "apply_full_eval takes a transaction-scoped advisory lock keyed on game_id as the first statement of its body"
    requirement: "QUICK-V8G"
    verification:
      - kind: unit
        ref: "tests/services/test_eval_apply.py::TestSameGameWriteLock::test_apply_full_eval_blocks_while_game_lock_held"
        status: pass
      - kind: unit
        ref: "tests/services/test_eval_apply.py::TestSameGameWriteLock::test_concurrent_same_game_apply_full_eval_serializes"
        status: pass
    human_judgment: false
  - id: D2
    description: "Deleting the lock statement makes the blocking test fail (revert-the-fix proof), proving the test actually exercises the lock"
    requirement: "QUICK-V8G"
    verification:
      - kind: unit
        ref: "tests/services/test_eval_apply.py::TestSameGameWriteLock::test_apply_full_eval_blocks_while_game_lock_held (run with the lock statement commented out)"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-08-25
status: complete
---

# Quick Task 260825-v8g: Serialize Concurrent Same-Game Eval Writes Summary

**`apply_full_eval` now takes a namespaced, transaction-scoped `pg_advisory_xact_lock(game_id)` as its first statement, serializing all same-game writers across both live write lanes, proven by a real-database test that fails when the lock is removed.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-25
- **Tasks:** 2/2 completed
- **Files modified:** 2 (`app/services/eval_apply.py`, `tests/services/test_eval_apply.py`)

## Accomplishments

- Added `_GAME_WRITE_LOCK_NAMESPACE` / `_GAME_WRITE_LOCK_MASK` module constants and a `_game_write_lock_key(game_id: int) -> int` helper in `app/services/eval_apply.py`, packing the "FLAW" namespace into the high 32 bits and `game_id` into the low 32 bits of a bigint advisory key — disjoint from `tests/conftest.py`'s existing `_TEMPLATE_ADVISORY_LOCK_KEY = 7_777_777_777` key space.
- Inserted `await write_session.execute(sa.text("SELECT pg_advisory_xact_lock(:lock_key)"), {"lock_key": _game_write_lock_key(game_id)})` as the literal first statement of `apply_full_eval`'s body (immediately after the docstring, before `_apply_full_eval_results` runs) — a bound parameter, never an f-string.
- Extended `apply_full_eval`'s docstring with a dedicated paragraph naming FLAWCHESS-9F / FLAWCHESS-8G, the 2026-08-23 deadlock, the two overlapping `UPDATE game_positions ... FROM (VALUES ...)` statements, the `_classify_and_fill_oracle` same-game correctness hazard, why the lock lives here (Phase 150 R7 — both lanes funnel through this one function) rather than in the router, and why it is transaction-scoped rather than session-scoped.
- Added `TestSameGameWriteLock` to `tests/services/test_eval_apply.py` with two real-database tests: one proves a concurrent `apply_full_eval` call blocks while another session holds the same advisory key (and completes once that holder rolls back), the other proves two concurrent same-game `apply_full_eval` calls both complete without raising (catching a session-scoped-lock mistake, which would hang).
- Neither `app/routers/eval_remote.py` nor `app/services/eval_drain.py` was touched — confirmed by the plan's own `git diff` guard.

## Task Commits

Task 1 (tracer, implementation + tests) and Task 2 (revert-the-fix proof + gates) landed as a single commit because Task 2 introduced no net code change — its revert-then-restore round-trip left the file byte-identical to what Task 1 had already committed (confirmed via `git diff --stat` returning empty after restoration, before the commit below).

1. **`0422e095e`** — `feat(eval): take per-game advisory lock in apply_full_eval, proven by real-DB test`

**Plan metadata:** commit handled by the orchestrator after this SUMMARY is written (per the execution contract — quick-task docs commits are not made by the executor).

## Files Created/Modified

- `app/services/eval_apply.py` — namespace constants, `_game_write_lock_key` helper, the `pg_advisory_xact_lock` call as the first statement of `apply_full_eval`, and an added docstring paragraph explaining the bug and the fix.
- `tests/services/test_eval_apply.py` — `TestSameGameWriteLock` class (2 tests), duration constants, a game-seeding helper, an `apply_full_eval` probe helper, and a `pg_locks`-polling helper with the mandatory `database = current_database()` filter.

## Decisions Made

- Placed the lock inside `apply_full_eval` rather than either caller, per the plan's explicit `key_links` guidance — this is the only placement that covers both the router lane and the drain lane without touching either file.
- Computed `pg_locks` probe `classid`/`objid` by bit-shifting the actual `_game_write_lock_key(game_id)` return value (`key >> 32`, `key & 0xFFFFFFFF`) rather than importing the namespace/mask constants separately into the test — this ties the probe directly to the real key layout instead of a parallel re-derivation.
- Task 1 (tracer) was committed immediately per the tracer execution protocol (implementation + real tests + atomic commit), then the tracer's own `<verify>` was re-run and passed before proceeding — satisfying the tracer feedback gate before Task 2's work.

## Deviations from Plan

### Auto-fixed Issues

None — no Rule 1/2/3 auto-fixes were needed; the implementation matched the plan's `<action>` specification directly.

### Process note (not a Rule 1-4 deviation)

**Commit type prefix:** the plan's Task 2 instructs "Commit both files together with a `fix(eval)` prefix." Because Task 1 is `type="tracer"` and the tracer execution protocol requires committing immediately after implementation + verification (before any expansion/proof task runs), the single commit that ended up covering all of this work was made at Task 1 time using a `feat(eval)` prefix (new lock-protection code, not yet proven against the failure mode it fixes). Task 2's revert-the-fix proof and gate run introduced zero net file changes (confirmed via `git diff --stat` returning empty both before and after the revert/restore round-trip), so there was nothing left to commit under a `fix(eval)` prefix without creating an empty commit — which git refuses, and which the git-safety protocol's ban on `git commit --amend` (absent explicit user request) rules out as a correction path. The commit body still names both Sentry IDs and states the serialization behavior change, satisfying the substance of the requirement; only the literal `feat`/`fix` prefix token differs from the plan's instruction.

---

**Total deviations:** 0 auto-fixed; 1 process note (commit-type prefix, cosmetic only, documented above).
**Impact on plan:** None on functionality, scope, or verification — all `must_haves` and gates are met.

## Issues Encountered

None. The revert-the-fix proof (Task 2, load-bearing) was performed exactly as specified:

1. The `await write_session.execute(sa.text("SELECT pg_advisory_xact_lock(...)"), ...)` statement was commented out (not deleted) in `apply_full_eval`.
2. `uv run pytest tests/services/test_eval_apply.py -q -k "test_apply_full_eval_blocks_while_game_lock_held"` was run and **failed**, exactly on the `not task.done()` assertion, with this verbatim message:

   ```
   AssertionError: apply_full_eval completed while another session held the per-game advisory lock -- the lock is not being taken
   assert not True
    +  where True = <built-in method done of _asyncio.Task object at 0x7769bc9f2410>()
    +    where <built-in method done of _asyncio.Task object at 0x7769bc9f2410> = <Task finished name='Task-23' coro=<_apply_full_eval_lock_probe() done, defined at /home/aimfeld/Projects/Python/flawchess/tests/services/test_eval_apply.py:1065> result=None>.done
   ```

   (Teardown also logged `sqlalchemy.exc.MissingGreenlet` warnings while closing the still-open holder connection after the failed assertion aborted the test body before its `finally` block could roll it back cleanly — expected noise from a deliberately-failed test, not a new defect; it did not recur once the lock was restored.)
3. The statement was restored to its exact original form and the same test was re-run: passed (`1 passed, 28 deselected`), and `git diff --stat` on the touched files returned empty, confirming byte-identical restoration.

## Verification Gates (all run and green)

- `uv run ruff format app/services/eval_apply.py tests/services/test_eval_apply.py` — "2 files left unchanged"
- `uv run ruff check . --fix` — "All checks passed!"
- `uv run ty check app/ tests/ scripts/` — "All checks passed!"
- `uv run pytest tests/services/test_eval_apply.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py -q` — "187 passed" (6 pre-existing, unrelated Starlette `HTTP_422_UNPROCESSABLE_ENTITY` deprecation warnings)
- `uv run ruff format --check app/services/eval_apply.py tests/services/test_eval_apply.py` — "2 files already formatted"
- `git status --porcelain -- app/services/eval_apply.py tests/services/test_eval_apply.py` — empty (nothing uncommitted)
- `grep -q "pg_advisory_xact_lock" app/services/eval_apply.py` — matched
- `git diff --name-only | grep -qE 'eval_remote\.py|eval_drain\.py'` — no match (neither caller file modified)

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The fix is self-contained and does not require any follow-up work in this milestone.
- Both live write lanes (`_apply_atomic_submit` in `app/routers/eval_remote.py` and `_full_drain_tick` in `app/services/eval_drain.py`) are covered without modification, per the plan's design.
- Deferred by explicit plan decision (not part of this task, not a blocker): lease-ownership checks on `_apply_atomic_submit`, VALUES-list sorting, retry-on-deadlock wrappers, and any change to the lease/lottery model.

## Self-Check: PASSED

- FOUND: app/services/eval_apply.py
- FOUND: tests/services/test_eval_apply.py
- FOUND: .planning/quick/260825-v8g-serialize-concurrent-same-game-eval-writ/260825-v8g-SUMMARY.md
- FOUND: commit 0422e095e in `git log --oneline --all`

---

*Phase: 260825-v8g*
*Completed: 2026-08-25*
