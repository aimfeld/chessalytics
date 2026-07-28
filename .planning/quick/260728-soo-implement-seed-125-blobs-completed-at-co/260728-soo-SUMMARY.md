---
phase: 260728-soo
plan: 01
subsystem: database
tags: [postgresql, sqlalchemy, alembic, eval-pipeline, tier-4-lottery, partial-index]

# Dependency graph
requires: []
provides:
  - "games.blobs_completed_at completion column + ix_games_blob_backfill_pending partial index"
  - "_refresh_blobs_completed bidirectional stamp-refresh helper (app/services/eval_apply.py)"
  - "_claim_tier4_blob rewritten to a games-only O(users) predicate"
affects: [eval-queue-service, eval-remote-router, eval-apply-classify]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fifth games-side completion column following the existing evals_completed_at / full_evals_completed_at / full_pv_completed_at / best_moves_completed_at idiom"
    - "Bidirectional stamp-refresh helper (set + clear) wired into every write/reclassify path, with backstop stamps on nothing-to-do paths to prevent infinite-repick"

key-files:
  created:
    - "alembic/versions/20260728_184611_2c248989d979_seed_125_games_blobs_completed_at.py"
  modified:
    - "app/models/game.py"
    - "app/services/eval_apply.py"
    - "app/routers/eval_remote.py"
    - "app/services/eval_queue_service.py"
    - "tests/services/test_full_eval_drain.py"
    - "tests/services/test_eval_queue.py"

key-decisions:
  - "Backfill UPDATE runs BEFORE the index CREATE so the index build sees the final row set (~414k-of-456k analyzed games stamped; ~5.3k-game backlog stays NULL/claimable)"
  - "Guest games are NOT special-cased in the backfill or the predicate — they stay NULL forever (Stage 1 already filters is_guest=false), matching the seed's explicit instruction not to 'fix' this"
  - "_refresh_blobs_completed does not commit — caller owns the transaction, mirroring _batch_update_flaw_pv_lines"
  - "Backstop stamps at the lease all-sentinel/no-walkable-lines branch and the submit idempotency gate are mandatory (not optional): without them a missed stamp from a race between two concurrent blob writers would make the tier-4 lottery re-pick the game forever (SEED-073 failure mode)"

patterns-established:
  - "New games-side completion columns should follow this exact template: nullable timestamp + user_id partial index (predicate byte-identical between ORM __table_args__ and the migration's create_index), non-CONCURRENTLY CREATE INDEX (startup migration runs against a quiescent backend), one-time backfill before index creation"

requirements-completed: [SEED-125]

coverage:
  - id: D1
    description: "games.blobs_completed_at column + ix_games_blob_backfill_pending partial index + one-time backfill migration"
    requirement: "SEED-125"
    verification:
      - kind: integration
        ref: "uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head"
        status: pass
      - kind: other
        ref: "dev-DB spot-check: SELECT g.id FROM games g JOIN game_flaws gf ... WHERE g.blobs_completed_at IS NOT NULL AND gf.allowed_pv_lines IS NULL (0 rows)"
        status: pass
    human_judgment: false
  - id: D2
    description: "_refresh_blobs_completed helper maintaining the column bidirectionally, wired into all 5 write/reclassify sites"
    requirement: "SEED-125"
    verification:
      - kind: unit
        ref: "tests/services/test_full_eval_drain.py::TestAccuracyAcplHook::test_seed125_clear_direction_reclassification_nulls_blob_stamp"
        status: pass
      - kind: unit
        ref: "tests/services/test_full_eval_drain.py::TestAccuracyAcplHook::test_seed125_set_direction_refresh_stamps_blob_completed"
        status: pass
    human_judgment: false
  - id: D3
    description: "_claim_tier4_blob rewritten to the games-only predicate (no game_flaws JOIN/EXISTS in either stage)"
    requirement: "SEED-125"
    verification:
      - kind: unit
        ref: "tests/services/test_eval_queue.py::TestTier4BlobBackfill::test_tier4_stamped_game_not_picked_even_with_null_blob_flaw"
        status: pass
      - kind: unit
        ref: "tests/services/test_eval_queue.py::TestTier4BlobBackfill::test_tier4_zero_flaw_game_is_claimable_until_stamped"
        status: pass
      - kind: unit
        ref: "tests/services/test_eval_queue.py::TestTier4BlobBackfill (11 tests, full class)"
        status: pass
    human_judgment: false

# Metrics
duration: 30min
completed: 2026-07-28
status: complete
---

# Quick Task 260728-soo: SEED-125 blobs_completed_at column Summary

**Fifth `games` completion column (`blobs_completed_at`) plus a games-only partial index replace the tier-4 blob-backfill picker's whole-corpus `games`/`game_flaws` semi-join with an O(users) lookup — the query measured 84.8% of all prod DB time.**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-07-28T19:04:51Z
- **Tasks:** 3 (all completed, no checkpoints)
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- Added `games.blobs_completed_at` (nullable timestamp) + `ix_games_blob_backfill_pending` partial index (`user_id` WHERE `full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL`), plus a one-time backfill UPDATE that stamped every already-complete game before the index was built (dev DB: 5,300+ games stamped, backlog left claimable).
- Added `_refresh_blobs_completed(session, game_id)` to `app/services/eval_apply.py` — probes for any remaining NULL-blob flaw ply and stamps `games.blobs_completed_at` bidirectionally (set on completion, cleared on reclassification). Wired into all 5 required call sites: the unconditional end of `_classify_and_fill_oracle`, `/flaw-blob-lease`'s all-sentinel/forward-progress-backstop branch, its over-cap branch, `/flaw-blob-submit`'s write phase, and its idempotency-gate backstop.
- Rewrote `_claim_tier4_blob`'s Stage 1 (user pick) and Stage 2 (game pick) predicates in `app/services/eval_queue_service.py` to read `games.blobs_completed_at` directly — zero `game_flaws` JOIN/EXISTS in either stage, backed by `ix_games_blob_backfill_pending`.
- Added tests proving both directions of the bidirectional invariant (CLEAR + SET) and two new tier-4 picker tests pinning the predicate to the column rather than the flaw rows (`test_tier4_stamped_game_not_picked_even_with_null_blob_flaw`, `test_tier4_zero_flaw_game_is_claimable_until_stamped`); realigned two pre-existing tests to the real lifecycle.
- Verified the mutation-gap-closure protocol manually: reverting Stage 2's predicate to the old `EXISTS`-over-`game_flaws` shape made the new pinning test fail as expected; reverted back and confirmed green.

## Task Commits

Each task was committed atomically:

1. **Task 1: Schema — `blobs_completed_at` column, partial index, one-time backfill** - `2315cb8c` (feat)
2. **Task 2: `_refresh_blobs_completed` helper + wire into all five call sites** - `62f7b2d0` (feat)
3. **Task 3: Rewrite `_claim_tier4_blob` to the games-only predicate and realign its tests** - `19ec839b` (feat)
4. **Formatting pass (ruff format, pre-merge gate)** - `fe3c4f8c` (style)

**Plan metadata:** commit pending (orchestrator handles the docs commit)

## Files Created/Modified

- `alembic/versions/20260728_184611_2c248989d979_seed_125_games_blobs_completed_at.py` - adds column, backfill UPDATE, partial index; downgrade drops both
- `app/models/game.py` - `blobs_completed_at` mapped column + `ix_games_blob_backfill_pending` in `__table_args__`
- `app/services/eval_apply.py` - `_refresh_blobs_completed` helper + unconditional call at the end of `_classify_and_fill_oracle`
- `app/routers/eval_remote.py` - wired `_refresh_blobs_completed` into `flaw_blob_lease` (both branches) and `_apply_flaw_blob_submit` (write phase + idempotency gate)
- `app/services/eval_queue_service.py` - `_claim_tier4_blob` Stage 1 + Stage 2 predicates rewritten to the games-only shape; expanded docstring
- `tests/services/test_full_eval_drain.py` - CLEAR-direction and SET-direction tests for `_refresh_blobs_completed`/`_classify_and_fill_oracle`
- `tests/services/test_eval_queue.py` - `_insert_game` gained a `blobs_completed_at` kwarg; realigned 2 existing tests + added 2 new pinning tests; updated class docstring

## Decisions Made

- Backfill runs before index creation (plan-specified ordering) so the partial index is built against the final, post-backfill row set rather than needing a subsequent REINDEX.
- Guest games deliberately left unstamped forever (matches the seed's explicit "don't fix this" instruction) — Stage 1 already filters `is_guest = false` so the bloat never affects the lottery, and the work becomes claimable automatically if a guest ever converts.
- Used `datetime.now(timezone.utc)` (Python-side) rather than SQL `now()` for the stamp value in `_refresh_blobs_completed`, matching the file's existing convention (`_classify_and_fill_oracle` and neighbors all use `datetime.now(timezone.utc)`, not `func.now()`).
- Test gp_rows for the two new `test_full_eval_drain.py` tests needed correcting mid-execution: the plan's suggested reuse of the *interior-hole* fixture (`eval_cp=None` at ply 2) actually produces **zero** `game_flaws` rows (the NULL hole nulls out both adjacent flaw classifications), which would have made the CLEAR-direction test vacuously pass its own guard assertion. Switched to the un-holed `_blunder_eval_sequence` stored values (`[20, 30, -500, -480, 60, 30]`, real white blunder at ply 2) instead — verified via a temporary debug print before locking in the fix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture data would have produced zero flaw rows, defeating its own vacuous-pass guard**
- **Found during:** Task 2 (writing the CLEAR-direction test)
- **Issue:** The plan's literal suggestion to reuse `test_accuracy_acpl_null_on_interior_hole`'s gp_rows (which has a NULL eval at ply 2) actually classifies to zero `game_flaws` rows — the NULL hole nulls out both the ply-2 and ply-3 flaw classifications (each needs an adjacent non-NULL eval). Running the test as literally specified passed the `stamp is None` assertion for the wrong reason (no flaw was ever inserted to begin with, so nothing needed to be cleared) and would have failed the `assert null_blob_flaws` vacuous-pass guard.
- **Fix:** Used the un-holed stored eval-by-ply sequence documented in `_blunder_eval_sequence`'s own docstring (`[20, 30, -500, -480, 60, 30]`), which is proven (by that docstring's own ES-drop math) to classify to exactly one white blunder at ply 2.
- **Files modified:** `tests/services/test_full_eval_drain.py`
- **Verification:** Both new tests pass; confirmed via a temporary debug print that the corrected fixture actually inserts a `game_flaws` row before locking in the assertions.
- **Committed in:** `62f7b2d0` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix — test data correction, no production code affected)
**Impact on plan:** Test-only correction; the production code (helper + wiring) matched the plan exactly. No scope creep.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required. Migration already applied to the dev DB (`uv run alembic upgrade head`).

## Next Phase Readiness

- SEED-125 fully implemented and verified: migration, helper, rewritten picker, and tests all in place; full backend suite green (3920 passed, 18 skipped — pre-existing) and `ty check` clean.
- `blobs_completed_at IS NULL` count on dev DB confirms the pending backlog (~5.3k games) remains claimable post-backfill.
- Not deployed to production yet — this is dev-only work pending the next `main → production` release cycle. The prod query-shape win (340ms → 7.5ms measured against an analogous index) will materialize once deployed.
- SEED-125 moved to `.planning/seeds/closed/` per the plan's output spec.

---
*Quick task: 260728-soo*
*Completed: 2026-07-28*

## Self-Check: PASSED

All 9 created/modified files (migration, model, service, router, 2 test files, moved seed, this SUMMARY) confirmed present on disk. All 4 task commit hashes (`2315cb8c`, `62f7b2d0`, `19ec839b`, `fe3c4f8c`) confirmed present in git log.
