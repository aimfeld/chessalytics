---
phase: 214-backend-god-file-decomposition
plan: 05
subsystem: services
tags: [ruff, complexipy, eval-apply, transactional-pipeline-split, refactor]

# Dependency graph
requires:
  - phase: 214-01
    provides: "ruff C901/PLR0912/PLR0915 enabled with a baselined per-file-ignores table; scripts/check_function_size.py"
  - phase: 214-03
    provides: "Split-and-prove method (tracer task verified end-to-end, mutation proof, delete ignore entry) applied a second time"
provides:
  - "app/services/eval_apply.py's two largest functions (_classify_and_fill_oracle, _build_best_move_candidates) split into named async/sync stage helpers along their own author-commented stage boundaries"
  - "The stale 'delete-then-insert reclassification' end-of-function comment on _classify_and_fill_oracle corrected to describe the actual 4-way diff/upsert (Phase 150 R3)"
affects: [214-06, 214-07, 214-08]

# Actuals (#2632)
actuals:
  tokens: 7557
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Orchestrator early-return guards expressed as a sentinel check against a stage's return value (None / \"reason\" in result / False) rather than an inline condition, so a stage boundary can absorb a guard's DB/compute work without moving the actual `return` statement out of the orchestrator."
    - "A hazardous read-before-write ordering (existing_plies / already_blobbed_plies read before a DELETE) is enforced by moving the reads into the orchestrator, ahead of the stage call that performs the write -- the stage receives the already-read values as plain arguments instead of re-deriving them."
    - "A stage whose body has no `await` (pure Python: candidate identification, gate + Maia inference + row assembly) stays a sync `def`, not an `async def` -- only stages issuing DB/engine I/O are async, avoiding meaningless async wrapping."

key-files:
  modified:
    - app/services/eval_apply.py
    - pyproject.toml

key-decisions:
  - "_write_oracle_counts (stage 4) bundles both count_game_severities calls AND the UPDATE games write (per the plan's literal action text), rather than splitting the guard check out to the orchestrator. The orchestrator's '"reason" in counts' guard becomes 'if not oracle_counts_written: return' -- the stage returns False (skipping its own UPDATE) when either color's counts carry a reason key, and the orchestrator's return statement still fires on that signal. This mirrors the existing stage-1 pattern (tuple | None -> 'if loaded is None: return') so all three orchestrator guards follow one consistent shape."
  - "existing_plies and already_blobbed_plies stay two SELECTs issued directly in the orchestrator (not inside a helper), matching the plan's explicit instruction that _diff_upsert_flaw_rows 'RECEIVES' them as arguments already read by the caller. This makes the read-before-delete ordering hazard visible at the orchestrator level rather than buried inside the stage that performs the delete."
  - "_build_best_move_candidates' five stages use plain-argument signatures (up to 10 params for _assemble_candidate_rows) rather than a threaded context object -- the plan explicitly prohibits a shared mutable context dataclass here, and each stage's inputs are already narrow/independent enough that a context object would only exist to shorten a signature (the exact anti-pattern CLAUDE.md forbids)."
  - "Kept the previous session's expanded `from app.services.flaws_service import (..., GameFlawsResult, ...)` import (added as the first, uncommitted step of the interrupted Task 2) and used it as the return-type annotation for `_classify_flaw_rows` -- resolves the F401 unused-import warning it left behind rather than reverting it."

patterns-established:
  - "Pipeline orchestrator -> one function per numbered stage, applied a third time in this phase (after endgame_service.py in 214-03) on the file's own highest-risk function -- confirms the pattern generalizes to a function with THREE separate early-return guards gating different stage boundaries, not just a single accumulate-then-build pipeline."

requirements-completed: []

coverage:
  - id: D1
    description: "_classify_and_fill_oracle becomes a thin orchestrator over four new async stage helpers (_load_game_and_positions, _classify_flaw_rows, _diff_upsert_flaw_rows, _write_oracle_counts) plus the pre-existing _write_flaw_pvs (Task 1) and _refresh_blobs_completed, with the read-before-delete ordering, blob-column preservation-by-omission, and all three early-return guards intact"
    verification:
      - kind: unit
        ref: "uv run pytest -n auto tests/services/test_eval_apply.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py tests/services/test_sentry_capture_gaps.py -q (226 passed)"
        status: pass
      - kind: unit
        ref: "uv run pytest -n auto tests/services/write_path_golden_scenarios.py tests/services/test_eval_utils.py -q (22 passed)"
        status: pass
      - kind: other
        ref: "grep -c 'diff/upsert' app/services/eval_apply.py (12, includes the corrected end-of-function comment)"
        status: pass
    human_judgment: false
  - id: D2
    description: "_build_best_move_candidates split into five named stage helpers (_out_of_book_ply_count, _identify_candidate_targets, _fetch_multipv2_fallback, _fetch_rating_metadata, _assemble_candidate_rows); the rating-metadata read session still closes before any Maia inference call, and both Sentry sites (the fallback set_tag/set_context pair, the outer try/except capture_exception) stay with their original branches"
    verification:
      - kind: unit
        ref: "uv run pytest -n auto tests/services/test_eval_apply.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py tests/services/test_sentry_capture_gaps.py -q (226 passed, unchanged from Task 2 baseline)"
        status: pass
      - kind: other
        ref: "grep -v '^\\s*#' app/services/eval_apply.py | grep -c 'sentry_sdk\\.capture_exception(' (5, unchanged)"
        status: pass
    human_judgment: false
  - id: D3
    description: "app/services/eval_apply.py's per-file-ignores entry deleted from pyproject.toml; ruff check . and the file-scoped check (with and without the ignore table) all exit 0; check_function_size reports no breach over 200 logic LOC or nesting depth 4"
    verification:
      - kind: other
        ref: "uv run ruff check app/services/eval_apply.py && uv run ruff check app/services/eval_apply.py --config 'lint.per-file-ignores = {}' && uv run ruff check . (all clean)"
        status: pass
      - kind: other
        ref: "uv run python scripts/check_function_size.py app/services/eval_apply.py --fail-over-depth 4 --fail-over-loc 200 (OK: 51 functions scanned, no breaches)"
        status: pass
      - kind: unit
        ref: "uv run pytest -n auto -x -q (4496 passed, 19 skipped -- full backend suite, unchanged baseline)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Mutation proof on _write_oracle_counts: temporarily short-circuiting the stage to skip its UPDATE games call turns a real subset of the oracle red; restoring returns it to green"
    verification:
      - kind: unit
        ref: "tests/services/test_full_eval_drain.py -- 3 failed with stub (TestAccuracyAcplHook x2, TestOracleCounts x1), 226 passed restored"
        status: pass
    human_judgment: false

duration: ~55min (Task 1, prior interrupted session, per its own commit) + ~20min (Tasks 2-3, this continuation session)
completed: 2026-09-03
status: complete
---

# Phase 214 Plan 05: eval_apply.py Transactional Pipeline Split Summary

**`_classify_and_fill_oracle` (the phase's highest-risk function -- a 6-stage write pipeline sharing one `AsyncSession`, with three project memory notes bearing on it) and `_build_best_move_candidates` are now stage pipelines of named helpers, the file's ruff complexity exemption is gone, and the stale "delete-then-insert" comment now says "diff/upsert".**

This plan was interrupted by a rate limit at the very start of Task 2; a continuation executor verified Task 1's committed extraction was sound before resuming.

## Performance

- **Task 1:** committed `11d748a0d` in a prior session, 2026-09-02T22:55:56+02:00.
- **Tasks 2-3 (this continuation):** ~20 min active work, completed 2026-09-03T05:49:01+02:00.
- **Tasks:** 3 (1 tracer + 2 auto)
- **Files modified:** 2 (`app/services/eval_apply.py`, `pyproject.toml`)

## Accomplishments

- `_classify_and_fill_oracle`'s remaining five stages (after Task 1's `_write_flaw_pvs`) are now four named async helpers -- `_load_game_and_positions`, `_classify_flaw_rows`, `_diff_upsert_flaw_rows`, `_write_oracle_counts` -- called sequentially from a thin orchestrator that keeps only its docstring and its three early-return guards. `logic_loc` dropped from a pre-split ~250+ lines to 51 (`check_function_size.py`).
- The 4-way diff/upsert's read-before-delete ordering hazard is preserved by construction: `existing_plies`/`already_blobbed_plies` are read in the orchestrator and passed as plain arguments to `_diff_upsert_flaw_rows`, which is the only function that issues the DELETE.
- `_build_best_move_candidates` split into its own five numbered stages -- `_out_of_book_ply_count`, `_identify_candidate_targets`, `_fetch_multipv2_fallback`, `_fetch_rating_metadata`, `_assemble_candidate_rows` -- with the session-discipline invariant (rating-metadata session CLOSED before any Maia inference) intact and both Sentry sites (fallback tag/context pair, outer catch-all capture) unmoved from their guarding branches.
- The stale "delete-then-insert reclassification above" comment near the end of `_classify_and_fill_oracle` now reads "diff/upsert reclassification above" with a note that it was corrected in 214-05 Task 2.
- `pyproject.toml`'s `app/services/eval_apply.py` per-file-ignores entry (`["C901", "PLR0912"]`) deleted -- the file needs no complexity exemption; `ruff check .` stays green project-wide.
- Sentry capture count stays exactly 5; `asyncio.gather` count stays exactly 11 (unrelated call sites elsewhere in the file, unchanged).

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract the flaw-PV write stage, Sentry sites and all** -- `11d748a0d` (feat) -- committed in the prior, rate-limit-interrupted session; verified sound at the start of this continuation (226-test oracle green, Sentry count 5, `ruff format --check`/`ty check` clean).
2. **Task 2: Finish the _classify_and_fill_oracle pipeline and correct its stale stage comment** -- `2029b168e` (feat)
3. **Task 3: Split _build_best_move_candidates, prove the invariants, delete the ignore entry** -- `37f53fbfa` (fix)

**Plan metadata:** committed together with STATE.md/ROADMAP.md updates (see below).

## Files Created/Modified

- `app/services/eval_apply.py` -- `_load_game_and_positions`, `_classify_flaw_rows`, `_diff_upsert_flaw_rows`, `_write_oracle_counts` (Task 2, all `async def`); `_out_of_book_ply_count`, `_identify_candidate_targets` (sync), `_fetch_multipv2_fallback`, `_fetch_rating_metadata` (async), `_assemble_candidate_rows` (sync) (Task 3) added. `_classify_and_fill_oracle` and `_build_best_move_candidates` bodies reduced to orchestration over the new helpers. `_write_flaw_pvs` (Task 1, unchanged this session), `_collect_full_ply_targets`, `_fetch_dedup_evals`, `apply_full_eval`, `score_move`, `async_session_maker` all stay module attributes at their original names/locations, still importable/monkeypatchable exactly as before.
- `pyproject.toml` -- deleted the `app/services/eval_apply.py` per-file-ignores entry.

## Decisions Made

See `key-decisions` in frontmatter -- four decisions: (1) `_write_oracle_counts` bundles both count calls and the UPDATE per the plan's literal action text, with the orchestrator's guard re-expressed as `if not oracle_counts_written: return`; (2) the two diff/upsert read queries stay in the orchestrator itself, not inside a helper, to keep the read-before-delete hazard visible at the call site that matters; (3) `_build_best_move_candidates`' five stages use plain arguments (no context dataclass) even where a helper's signature grows to 10 params, per the plan's explicit prohibition; (4) kept and used the prior session's uncommitted `GameFlawsResult` import rather than reverting it.

## Deviations from Plan

None -- plan executed exactly as written across all three tasks. The one substantive design call not spelled out verbatim in the plan's action text (how `_write_oracle_counts`'s "reason" guard surfaces back to the orchestrator) is documented above as a key decision, not a deviation -- it satisfies the plan's own acceptance criterion ("`_classify_and_fill_oracle` retains its name, signature and its three early-return guards") rather than contradicting it.

## Issues Encountered

None. The interrupted-session handoff (Task 1 committed, one uncommitted import edit pending) was resolved cleanly: Task 1's oracle, Sentry count, `ruff format --check`, and `ty check` were all re-verified green before Task 2 began, and the pending `GameFlawsResult` import was consumed by Task 2's own return-type annotation rather than reverted.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `app/services/eval_apply.py` carries no complexity exemption in `pyproject.toml`; `ruff check .` stays green project-wide with three fewer baselined files (`tactic_detector.py` from 214-02, `endgame_service.py` from 214-03, `library_repository.py` from 214-04, `eval_apply.py` from this plan).
- The "pipeline orchestrator -> one function per stage, guard-preserving sentinel returns" pattern is now proven on a function with THREE separate early-return guards across six stages (not just one accumulate-then-build pipeline as in 214-03) -- 214-06/214-07/214-08 can reuse this when a candidate split has multiple distinct early-return conditions gating different points in the pipeline.
- Ready for the next wave-2 plan; no blockers.

## Self-Check: PASSED

- `app/services/eval_apply.py` -- FOUND on disk
- `pyproject.toml` -- FOUND on disk, `eval_apply.py` per-file-ignores entry confirmed absent (`grep -c "eval_apply.py" pyproject.toml` -> 0)
- Commits `11d748a0d`, `2029b168e`, `37f53fbfa` -- all FOUND in `git log --oneline --all`
- Re-ran plan-level `<verification>`: `uv run pytest -n auto tests/services/test_eval_apply.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py tests/services/test_sentry_capture_gaps.py -q` (226 passed), `uv run pytest -n auto tests/services/write_path_golden_scenarios.py tests/services/test_eval_utils.py -q` (22 passed), `uv run ruff check app/services/eval_apply.py` + `--config 'lint.per-file-ignores = {}'` + `uv run ruff check .` (all clean), `uv run python scripts/check_function_size.py app/services/eval_apply.py --fail-over-depth 4 --fail-over-loc 200` (OK, exit 0), `grep -v '^\s*#' app/services/eval_apply.py | grep -c 'sentry_sdk\.capture_exception('` (5), `grep -c 'asyncio.gather' app/services/eval_apply.py` (11, unchanged from base), `uv run ty check app/ tests/ scripts/` (zero errors), `uv run ruff format --check app/ tests/ scripts/` (clean, 453 files), `uv run pytest -n auto -x -q` (4496 passed, 19 skipped)

---
*Phase: 214-backend-god-file-decomposition*
*Completed: 2026-09-03*
