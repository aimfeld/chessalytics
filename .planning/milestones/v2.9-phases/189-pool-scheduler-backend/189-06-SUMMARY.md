---
phase: 189-pool-scheduler-backend
plan: 06
subsystem: api
tags: [sqlalchemy, postgresql, jsonb, fastapi, gap-closure]

requires:
  - phase: 189-pool-scheduler-backend
    provides: pool_entry_stmt, blob_pending_stmt, due_stmt, the D-06 eval-pipeline empty-array sentinel this plan closes the gate against
provides:
  - answer_key_present / answer_key_pending named predicate helpers in app/services/train_pool.py
  - pool_entry_stmt and blob_pending_stmt wired to the total-operator answer-key predicates
  - train_repository.py's due_stmt re-serve scan reusing answer_key_present (189-REVIEW.md WR-04 closure)
  - POOL-01 flipped to complete in REQUIREMENTS.md (checkbox + traceability)
affects: [189-frontend-plans, any future Train pool-entry or re-serve-path change]

tech-stack:
  added: []
  patterns:
    - "Named, exported SQL predicate helpers instead of inline WHERE-clause conditions, so an entry gate and a re-serve scan can be proven to use the same standard by a grep, not by re-reading two files"
    - "Total-operator JSONB predicates (IS NOT NULL / jsonb_typeof / <>) instead of jsonb_array_length, because Postgres does not guarantee AND-clause evaluation order and a length check on a non-array can raise mid-query"

key-files:
  created: []
  modified:
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - tests/services/test_train_pool.py
    - tests/routers/test_train.py
    - tests/repositories/test_train_repository.py
    - .planning/REQUIREMENTS.md

key-decisions:
  - "D-GAP-01 (from the plan): the D-06 empty-array sentinel counts toward NEITHER pool_entry_stmt NOR blob_pending_count. It is terminal (the eval pipeline writes it specifically to stop the tier-4 lottery from re-picking that flaw), so counting it as 'pending' would pin the client's 'still analyzing' signal at a permanently non-zero floor that never resolves. Implemented as answer_key_pending deliberately NOT being the boolean negation of answer_key_present, with the rationale in its docstring."
  - "Used col: Any (not ColumnElement[Any]) as the two predicate helpers' parameter type, matching expected_score_sql's existing convention in this module — ColumnElement[Any] rejected SQLAlchemy's InstrumentedAttribute[list[Any] | None] under ty check, and CLAUDE.md's ty-zero-errors requirement takes precedence over the plan's literal type-hint text."
  - "Reworded answer_key_present's docstring to explain the AND-clause-ordering hazard without the literal substring 'jsonb_array_length', to satisfy both the plan's explicit instruction to document the reason (so a future reader doesn't 'simplify' it back into a crash) and its own acceptance criterion that greps for that string returning no match."

requirements-completed: [POOL-01]

coverage:
  - id: D1
    description: "A qualifying own blunder whose missed_pv_lines is [] (D-06 sentinel) is excluded from pool_entry_stmt exactly like SQL NULL"
    requirement: "POOL-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py#test_empty_blob_excluded_from_pool_entry"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_empty_blob_excluded"
        status: pass
    human_judgment: false
  - id: D2
    description: "blob_pending_count counts only true-NULL blobs; the [] sentinel is counted in neither population (D-GAP-01)"
    requirement: "POOL-01"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py#test_empty_blob_not_counted_as_blob_pending"
        status: pass
    human_judgment: false
  - id: D3
    description: "An already-tracked drill_items row whose backing answer key becomes [] is skipped by due_stmt's re-serve scan, not re-served, and stays ACTIVE"
    requirement: "POOL-01"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py#test_emptied_blob_item_not_reserved_when_due"
        status: pass
    human_judgment: false
  - id: D4
    description: "Predicate is total (never raises) across the four adjacent regression tests confirming existing behavior (NULL exclusion, soft-blob entry, blob-pending count) is unchanged"
    verification:
      - kind: unit
        ref: "uv run pytest tests/services/test_train_pool.py tests/services/test_train_scheduler.py tests/repositories/test_train_repository.py tests/routers/test_train.py tests/test_imports_router.py tests/test_guest_cleanup_service.py -q"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-07-25
status: complete
---

# Phase 189 Plan 06: Close the empty-array missed_pv_lines pool-entry gap Summary

**Named `answer_key_present`/`answer_key_pending` SQL predicates close the D-06 empty-array `missed_pv_lines` sentinel bypass in `pool_entry_stmt`, `blob_pending_stmt`, and `due_stmt`, closing POOL-01.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-25T15:20:45Z (approx, from STATE.md session start)
- **Completed:** 2026-07-25T15:32:37Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- `pool_entry_stmt` and `blob_pending_stmt` now use the total-operator `answer_key_present`/`answer_key_pending` predicates instead of a bare `IS NOT NULL`/`IS NULL` test, so a non-NULL EMPTY `missed_pv_lines` array (the eval pipeline's D-06 un-fillable-line sentinel) never enters the drill pool and is never miscounted as "pending" either.
- `due_stmt` in `train_repository.py` reuses the same `answer_key_present` predicate, closing `189-REVIEW.md`'s WR-04 finding: an already-tracked `drill_items` row whose backing flaw's blob was reset to `[]` after a reclassify is now skipped on the next due-scan (stays ACTIVE, resurfaces if a later re-analysis restores a real blob) instead of being re-served with a degenerate answer key.
- POOL-01 flipped to complete in `.planning/REQUIREMENTS.md` — the last pending POOL requirement, closing ROADMAP Success Criterion 1.

## Task Commits

Each task was committed atomically:

1. **Task 1: Name the answer-key predicates and close the entry gate end-to-end** - `1cde8b23` (feat)
2. **Task 2: Harden the re-serve path with the same predicate and close POOL-01** - `b785fd7a` (feat)

_Both tasks were TDD (`tdd="true"`): tests were written and confirmed failing against the pre-fix predicates before the production wiring landed, matching the plan's `<behavior>` requirement._

## Files Created/Modified
- `app/services/train_pool.py` — added `answer_key_present`/`answer_key_pending` predicate helpers (exported in `__all__`), wired into `pool_entry_stmt` and `blob_pending_stmt`, corrected the module docstring's clause (c) and `blob_pending_stmt`'s docstring.
- `app/repositories/train_repository.py` — `due_stmt`'s WHERE clause now includes `answer_key_present(GameFlaw.missed_pv_lines)`, with an inline comment recording why (WR-04 / lazy-eviction interaction).
- `tests/services/test_train_pool.py` — `test_empty_blob_excluded_from_pool_entry`, `test_empty_blob_not_counted_as_blob_pending`.
- `tests/routers/test_train.py` — `test_empty_blob_excluded` (HTTP counterpart to `test_null_blob_excluded`).
- `tests/repositories/test_train_repository.py` — `test_emptied_blob_item_not_reserved_when_due` (isolates the `due_stmt` re-serve path specifically, distinct from the `pool_entry_stmt` padding scan).
- `.planning/REQUIREMENTS.md` — POOL-01 checkbox and traceability row flipped to complete (exactly 2 lines changed).

## Decisions Made

**D-GAP-01 (as specified in the plan, confirmed implemented as written):** the `[]` empty-array sentinel counts toward NEITHER `pool_entry_stmt` NOR `blob_pending_count`. `answer_key_pending` is documented in its own docstring as deliberately NOT the boolean negation of `answer_key_present` — a true-NULL blob self-heals through the tier-4 lottery (`allowed_pv_lines IS NULL` claim predicate); the `[]` sentinel is written specifically to clear that predicate and never self-heals. Counting it as "pending" would pin `blob_pending_count` at a permanently non-zero floor. Accepted consequence: a user whose entire flaw set is `[]`-sentineled sees `puzzle_count = 0, blob_pending_count = 0` ("caught up", not "analyzing") — the honest signal, per the plan's rationale.

**Type-annotation deviation (Rule 1 — bug/tool-compliance fix):** the plan's `<artifacts_this_phase_produces>` spec wrote the helpers' signature as `col: ColumnElement[Any]`. That signature failed `uv run ty check` — `GameFlaw.missed_pv_lines` resolves to `InstrumentedAttribute[list[Any] | None]`, which `ty` does not accept where `ColumnElement[Any]` is declared. Changed both helpers to `col: Any`, matching `expected_score_sql`'s existing convention in the same module (`cp_col: Any`, `mate_col: Any`, `user_color_col: Any`). CLAUDE.md requires `ty check app/ tests/` to pass with zero errors; this takes precedence over the plan's literal type-hint text, and the runtime behavior of both helpers is unaffected.

**Docstring wording deviation (Rule 1 — acceptance-criteria self-conflict):** the plan's Task 1 `<action>` explicitly instructs documenting the reason `func.jsonb_array_length(...) > 0` was rejected ("a future reader will otherwise 'simplify' it back into a crash"), while Task 1's `<acceptance_criteria>` separately requires `grep -n "jsonb_array_length" app/services/train_pool.py` to return no match. Both cannot be satisfied if the docstring names the function literally. Resolved by explaining the same AND-clause-ordering hazard and its exact error message (`cannot get array length of a scalar`) without the literal substring "jsonb_array_length", pointing to `189-06-PLAN.md`'s `<gap_reference>` Fact 2 for the exact reproduction. Both the substantive warning and the grep now pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `col: ColumnElement[Any]` parameter type failed `ty check`**
- **Found during:** Task 1 (verification step, `uv run ty check app/ tests/`)
- **Issue:** The plan's literal artifact spec declared both predicate helpers as `col: ColumnElement[Any]`. `ty` rejected `GameFlaw.missed_pv_lines` (an `InstrumentedAttribute[list[Any] | None]`) as an invalid argument for that parameter type at both call sites (`pool_entry_stmt`, `blob_pending_stmt`).
- **Fix:** Changed both helpers' parameter type to `col: Any`, matching the existing `expected_score_sql` convention in the same module. Return type (`ColumnElement[bool]`) unchanged.
- **Files modified:** `app/services/train_pool.py`
- **Verification:** `uv run ty check app/ tests/` — 0 errors.
- **Committed in:** `1cde8b23` (Task 1 commit)

**2. [Rule 1 - Bug] Docstring text conflicted with its own acceptance-criteria grep**
- **Found during:** Task 1 (post-write acceptance-criteria check)
- **Issue:** The plan required both naming `jsonb_array_length` in the docstring (to warn future readers off the crash-prone form) AND a grep for that exact string returning zero matches — mutually exclusive as literally worded.
- **Fix:** Reworded the docstring to describe the hazard (Postgres AND-clause reordering, the `cannot get array length of a scalar` error) without the literal function name, referencing `189-06-PLAN.md`'s `<gap_reference>` Fact 2 for the exact function/reproduction.
- **Files modified:** `app/services/train_pool.py`
- **Verification:** `grep -n "jsonb_array_length" app/services/train_pool.py` — no match; `grep -n "jsonb_typeof" app/services/train_pool.py` — matches inside `answer_key_present`.
- **Committed in:** `1cde8b23` (Task 1 commit)

**3. [Rule 3 - Blocking, scope guard] Reverted unrelated `ruff format` drift in two out-of-scope test files**
- **Found during:** Task 2 verification (`uv run ruff format app/ tests/`)
- **Issue:** Running the project-wide formatter (per the plan's own `<verify>` step) reformatted `tests/test_guest_cleanup_service.py` and `tests/test_imports_router.py` — pre-existing formatting drift unrelated to this plan's `missed_pv_lines` predicate change.
- **Fix:** `git checkout --` those two files after confirming `train_pool.py`/`train_repository.py` and their test files needed no reformatting, keeping `git diff --stat` scoped to exactly the six files the plan lists in `files_modified`.
- **Files modified:** none (reverted, not committed)
- **Verification:** `git diff --stat` after the revert shows only the plan's six named files across both commits; `uv run ruff check app/ tests/` and `uv run ty check app/ tests/` both still report zero issues.
- **Committed in:** N/A (not committed — reverted before staging)

---

**Total deviations:** 3 auto-fixed (2 Rule 1 tool-compliance fixes, 1 Rule 3 scope guard)
**Impact on plan:** All three are mechanical corrections required to satisfy CLAUDE.md's ty/ruff gates and the plan's own `<verification>` scope-discipline clause. No behavioral change beyond what the plan specified, no scope creep.

## Mutation-Check Evidence (per `feedback_mutation_test_gap_closures`)

**Task 1 (`pool_entry_stmt`'s entry gate):** temporarily reverted `pool_entry_stmt`'s WHERE clause from `answer_key_present(GameFlaw.missed_pv_lines)` back to the bare `GameFlaw.missed_pv_lines.isnot(None)`. Ran the two new tests against the mutated code:
```
tests/services/test_train_pool.py::test_empty_blob_excluded_from_pool_entry FAILED (rows == [(flaw, game)], expected [])
tests/routers/test_train.py::test_empty_blob_excluded FAILED (assert 1 == 0, puzzle_count)
```
Restored `answer_key_present(GameFlaw.missed_pv_lines)`; re-ran — both PASSED, along with the full `test_train_pool.py`/`test_train.py` suite (68 passed).

**Task 2 (`due_stmt`'s re-serve scan):** temporarily removed the `answer_key_present(GameFlaw.missed_pv_lines)` clause from `due_stmt`'s WHERE list (leaving the WR-04 explanatory comment in place). Ran the new test:
```
tests/repositories/test_train_repository.py::test_emptied_blob_item_not_reserved_when_due FAILED
  AssertionError: assert 1 == 0 (second.puzzle_count — item was re-served with the empty blob)
```
Restored the clause; re-ran — PASSED, along with the full `test_train_repository.py` suite (35 passed).

Symbol-presence greps alone were never treated as sufficient evidence — both fix sites were proven load-bearing by reverting them and observing the exact named test fail with the exact expected wrong value.

## Issues Encountered
None beyond the two documented type-checker/acceptance-criteria conflicts above, both resolved without changing runtime behavior.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- Phase 189 (Pool + Scheduler Backend) is now fully closed: all 4 ROADMAP success criteria hold, all 10 POOL-* requirements are complete, full backend suite is green (3770 passed / 18 skipped, up from the 3766/18 baseline recorded in `189-VERIFICATION.md`), and `ty`/`ruff` are clean.
- No blockers for downstream Train frontend phases. `189-REVIEW.md`'s remaining findings (WR-01 Sentry capture, WR-02 function-size, WR-03 mid-window eviction, IN-01..03) remain open as legitimate non-blocking follow-ups, unchanged by this plan's deliberately narrow scope.

---
*Phase: 189-pool-scheduler-backend*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 7 claimed files confirmed present (`app/services/train_pool.py`, `app/repositories/train_repository.py`, `tests/services/test_train_pool.py`, `tests/routers/test_train.py`, `tests/repositories/test_train_repository.py`, `.planning/REQUIREMENTS.md`, this SUMMARY). All 3 claimed commit hashes (`1cde8b23`, `b785fd7a`, `2487a799`) confirmed present in `git log --oneline --all`.
