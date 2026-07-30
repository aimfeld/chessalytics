---
phase: 192-red-herring-position-pool
plan: 02
subsystem: api
tags: [postgresql, sqlalchemy, alembic, train, herring-pool, one-way-migration]

# Dependency graph
requires:
  - phase: 192-01
    provides: herring_pool table + HerringPool model, herring_stmt rewritten off herring_pool, ComposedPuzzle.game_id widened to int | None
provides:
  - "drill_solves.game_id nullable + ON DELETE SET NULL (was NOT NULL + CASCADE) — the phase's one-way door landed"
  - "All three DrillSolve.game_id INNER JOINs (load_session_puzzles, _mark_session_complete_if_done, reveal_for_puzzle) converted to OUTER JOINs with tested, opposite SR-vs-herring branch semantics"
  - "reveal_for_puzzle's D-06 owner-scoped GamePosition lookup (game.user_id, not the solving user) — a cross-user herring reveals its in-game move; select list stays exactly GamePosition.move_san"
  - "TrainPuzzle.game_id and PuzzleRevealResponse.game_id widened to int | None — the backend contract Plan 05 (frontend) depends on"
affects: [192-03-generator-completion, 192-04-query-time-gate, 192-05-reveal-frontend]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two independent lazy-eviction paths with OPPOSITE outcomes keyed on DrillSolve.source: an orphaned SR row is excluded everywhere (unservable, mirrors the pre-D-05 CASCADE outcome); an orphaned herring keeps counting/serving (self-sufficient off its pool row, D-03)"
    - "A mandatory second or_() leniency clause alongside an existing one in the same WHERE, rather than merging them into one compound condition — keeps the WR-02 GameFlaw-orphan guard and the new D-05 Game-orphan guard independently readable and independently testable"

key-files:
  created:
    - alembic/versions/20260727_234844_127c8bd364a6_phase_192_drill_solves_game_id_nullable.py
  modified:
    - app/models/drill_solve.py
    - app/repositories/train_repository.py
    - app/routers/train.py
    - app/schemas/train.py
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - tests/test_guest_cleanup_service.py
    - tests/test_imports_router.py

key-decisions:
  - "Task 1 checkpoint (user-approved option-a): in-place ALTER, both halves (nullability + FK policy) in ONE migration, landed only after Task 2's three outer-join fixes were already committed — never a tree with any remaining INNER JOIN on DrillSolve.game_id at the point the schema allows NULL"
  - "_mark_session_complete_if_done gets a SECOND mandatory or_() clause (Game.id.isnot(None)), parallel to but independent from the existing WR-02 GameFlaw clause — an orphaned SR row is excluded from `remaining` (preserving WR-02's stuck-session fix, now also covering 'game row gone' not just 'flaw row gone'), while an orphaned herring is deliberately NEVER excluded by either clause"
  - "D-06: reveal_for_puzzle's GamePosition lookup resolves game.user_id (the source game's OWNER, from the outer-joined Game row) instead of the solving user_id — server-resolved, never client-supplied, so no IDOR seam opens; the select list stays exactly GamePosition.move_san (a security control, not an optimization)"
  - "The two Plan-01 'assert game_id is not None' narrowings (train_repository.py composition insert, routers/train.py TrainPuzzle construction) are REMOVED, not updated — they documented a Plan-01-only invariant that this plan's nullability widening makes legitimately false (a herring composed from an already-orphaned pool row has game_id=None even at fresh composition time)"
  - "Task 2's new tests require the ACTUAL nullable/SET NULL schema to exist (INSERT with game_id=None, and a real DB-level cascade on delete — hand-nulling the column would prove nothing about the FK policy). The model change + migration file were authored and applied to the dev DB before Task 2's tests were run, but staged and committed ONLY in the Task 3 commit — preserving the plan's git-history ordering invariant (Task 2 commit has no schema change; Task 3 commit isolates the one-way door) while still letting Task 2's tests exercise the real FK behavior rather than a simulated one"

requirements-completed: [POOL-03]

coverage:
  - id: D1
    description: "All three DrillSolve.game_id INNER JOINs converted to OUTER JOINs, with tested SR-vs-herring branch semantics (orphaned SR excluded/evicted, orphaned herring stays servable/counted)"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_resume_serves_herring_with_deleted_source_game"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_completion_ignores_orphaned_sr_row_but_counts_orphaned_herring"
        status: pass
    human_judgment: false
  - id: D2
    description: "reveal_for_puzzle resolves the D-06 owner-scoped GamePosition lookup (game.user_id) so a cross-user herring reveals its in-game move; an orphaned herring reveals with game_id=None and a non-empty pool-row FEN; an orphaned SR row returns not_found (pre-D-05 CASCADE parity)"
    requirement: "POOL-03"
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_reveal_cross_user_herring_shows_game_move_and_no_owner_scope_leak"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_reveal_survives_source_game_deletion"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_reveal_orphaned_sr_row_returns_not_found"
        status: pass
    human_judgment: false
  - id: D3
    description: "drill_solves.game_id migration landed (nullable + ON DELETE SET NULL), verified against the live dev DB catalog, downgrade round-trip verified"
    requirement: "POOL-03"
    verification:
      - kind: other
        ref: "uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head; psql information_schema.columns / pg_constraint confdeltype='n' verified"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full pre-merge gate green: backend 3861 passed / 27 skipped, frontend lint clean + 2776 tests passed, ty clean, ruff clean"
    requirement: "POOL-03"
    verification:
      - kind: other
        ref: "uv run pytest -n auto -x; uv run ty check app/ tests/; ( cd frontend && npm run lint && npm test -- --run )"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-07-28
status: complete
---

# Phase 192 Plan 2: DrillSolve.game_id nullability + D-06 reveal widening Summary

**`drill_solves.game_id` is now nullable with `ON DELETE SET NULL` (the phase's one-way door), all three code paths that assumed it was `NOT NULL` are fixed with tested opposite treatment for orphaned SR items vs orphaned herrings, and the reveal's `GamePosition` lookup resolves the source game's owner so cross-user herrings show their in-game move.**

## Performance

- **Duration:** ~50 min
- **Tasks:** 3 (Task 1 checkpoint:decision, Task 2 join fixes + reveal widening, Task 3 migration + full pre-merge gate)
- **Files modified:** 9 (1 created, 8 modified)

## Accomplishments

- **Task 1 checkpoint resolved:** option-a (in-place ALTER, both halves in one migration, landed after the join fixes) — user-approved, matching the plan's recommendation.
- **`load_session_puzzles`:** outer-joins `Game` and `HerringPool`; a herring's FEN/arriving move now come EXCLUSIVELY off its `herring_pool` row (D-03, alive game-link or not — closing a latent gap where the resume path still fell back to PGN reconstruction for herrings even after Plan 01 fixed composition); an orphaned SR row (source game deleted) is lazily evicted, never crashing.
- **`_mark_session_complete_if_done`:** outer-joins `Game`; adds a mandatory second `or_()` leniency clause parallel to the existing WR-02 `GameFlaw` clause. An orphaned SR row is excluded from `remaining` (preserving the WR-02 stuck-session fix, now covering "game row gone" in addition to "flaw row gone"); an orphaned herring is deliberately never excluded by either clause, keeping the session open until it's actually solved.
- **`reveal_for_puzzle`:** outer-joins `Game` and `HerringPool`. An orphaned SR row returns `"not_found"` AFTER the `not_attempted` gate — the exact pre-D-05 CASCADE outcome, not a new "empty reveal" state. D-06: the `GamePosition` lookup now resolves `game.user_id` (the source game's owner, from the outer-joined `Game` row) instead of the solving user — a cross-user herring reveals its in-game move instead of silently degrading to `null`; the select list stays exactly `GamePosition.move_san` (T-192-02 mitigation — a security control, not an optimization).
- **`record_solve`:** both `is_sr`-guarded calls that pass `solve_row.game_id` into `int`-typed parameters narrow explicitly (`is_sr and solve_row.game_id is not None`) — real behavior, not a `ty` appeasement: `DrillItem.game_id` stays `NOT NULL` + `CASCADE`, so an orphaned SR row's backing `drill_items` row is already gone.
- **Removed** (not updated) the two Plan-01 `assert game_id is not None` narrowings in `train_repository.py`'s composition insert and `routers/train.py`'s `TrainPuzzle` construction — both documented a Plan-01-only invariant this plan's widening makes legitimately false.
- **Schema widening:** `TrainPuzzle.game_id` and `PuzzleRevealResponse.game_id` → `int | None`; `RevealedPuzzle.game_id` (internal dataclass) likewise.
- **Migration landed:** `phase_192_drill_solves_game_id_nullable` — `drill_solves.game_id` nullable + `ON DELETE SET NULL` (was `NOT NULL` + `CASCADE`), FK constraint renamed identically (`drill_solves_game_id_fkey`) so future migrations reference it reliably. Downgrade round-trip verified against the live dev DB; downgrade carries an explicit one-way-door warning (fails once any NULL rows exist).
- Ran the full pre-merge gate: backend 3861 passed / 27 skipped, frontend lint clean + 2776 tests passed, `ty check` clean, `ruff format`/`ruff check` clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Decide the migration strategy for the one-way door** — checkpoint:decision, no commit (orchestrator relayed the user's `option-a` approval).
2. **Task 2: Fix all three Game join sites and widen the reveal to the game owner** — `8799142c` (feat)
3. **Task 3: Land the nullability migration and push the schema** — `9226faf6` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `app/repositories/train_repository.py` — three `Game`/`DrillSolve` joins converted to outer joins with SR-vs-herring branch semantics; D-06 owner-scoped reveal lookup; `record_solve` narrowing; two Plan-01 asserts removed
- `app/routers/train.py` — removed the Plan-01 `TrainPuzzle` construction assert (game_id is now legitimately nullable)
- `app/schemas/train.py` — `TrainPuzzle.game_id`/`PuzzleRevealResponse.game_id` widened to `int | None`
- `app/models/drill_solve.py` — `game_id` column widened to `Mapped[int | None]` with `ondelete="SET NULL"`; module docstring rewritten (D-05 rationale, `uq_drill_solves_session_puzzle` NULL-distinctness note)
- `alembic/versions/20260727_234844_127c8bd364a6_phase_192_drill_solves_game_id_nullable.py` — the one-way-door migration (nullable + FK policy change, named constraint, one-way downgrade warning)
- `tests/repositories/test_train_repository.py` — two new tests (`test_resume_serves_herring_with_deleted_source_game`, `test_completion_ignores_orphaned_sr_row_but_counts_orphaned_herring`)
- `tests/routers/test_train.py` — three new tests (cross-user herring reveal, orphaned-herring reveal, orphaned-SR-row reveal-404), a new `_seed_herring_pool_row`/`_delete_herring_pool_rows` helper pair, `_seed_session` extended with `herring_pool_ids`, two pre-existing tests adjusted for the D-03 FEN-sourcing narrowing (see Deviations)
- `tests/test_guest_cleanup_service.py` / `tests/test_imports_router.py` — two pre-existing tests updated: `drill_solves` now survives a game deletion with `game_id` nulled instead of being deleted alongside `drill_items` (see Deviations)

## Decisions Made

- **Task 1 checkpoint, option-a (user-approved):** in-place ALTER, both halves in one migration, landed strictly after Task 2's join fixes were committed.
- **Two independent `or_()` clauses in `_mark_session_complete_if_done`**, not one merged compound condition — keeps the pre-existing WR-02 guard and the new D-05 guard each independently readable and independently testable, per the plan's explicit instruction.
- **D-06 lookup resolves `game.user_id`**, server-side from the outer-joined `Game` row, never from request input — no new IDOR seam; `GamePosition.move_san` remains the only column selected.
- **Removed rather than updated** the two Plan-01 narrowing asserts — they encoded an invariant ("a served puzzle's `game_id` is never actually `None` yet") that stopped being true the moment this plan's widening landed; keeping them would have masked a legitimate `None` and crashed the very code path this plan exists to fix.
- **Schema-before-commit sequencing:** the model change + migration file were authored and applied to the dev DB before Task 2's tests ran (a nullable-column INSERT and a real `ON DELETE SET NULL` cascade can't be exercised against a still-`NOT NULL`/`CASCADE` schema), but staged and committed only in the Task 3 commit — so the git history still shows Task 2's join-fix commit landing before any schema change, matching the plan's explicit ordering invariant, while every new test in both commits exercises the real FK policy end-to-end rather than a hand-nulled column.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two pre-existing tests asserted the old CASCADE-delete behavior for `drill_solves`, made stale by the FK policy change**
- **Found during:** Task 3, running the full backend suite after landing the migration
- **Issue:** `test_purge_guest_cascades_drill_rows` (`tests/test_guest_cleanup_service.py`) and `test_delete_games_cascades_drill_rows` (`tests/test_imports_router.py`) both asserted `drill_solves` count == 0 after a game deletion — true under the old `CASCADE` policy, false under the new `SET NULL` policy (the row now survives with `game_id` nulled, exactly as D-05 intends).
- **Fix:** Updated both tests' assertions to confirm the row survives with `game_id IS NULL`, and updated their docstrings to explain why (a global herring pool means the FK policy must be uniform regardless of which user owns the orphaned row).
- **Files modified:** `tests/test_guest_cleanup_service.py`, `tests/test_imports_router.py`
- **Verification:** `uv run pytest -n auto -x` — 3861 passed, 27 skipped
- **Committed in:** `9226faf6` (Task 3 commit)

**2. [Rule 1 - Bug] Two pre-existing router tests relied on the pre-Plan-02 uniform PGN-based FEN reconstruction for herrings, which `load_session_puzzles`'s D-03 fix deliberately retires**
- **Found during:** Task 2, running `tests/routers/test_train.py` after implementing `load_session_puzzles`'s herring-exclusive pool-row FEN sourcing
- **Issue:** `test_ply_zero_puzzle_serialises_last_move_uci_as_null` and `test_reveal_played_in_game_move_uci_promotion` both seeded a `RED_HERRING`-source `drill_solves` row with no `herring_pool_id`, relying on the old uniform-regardless-of-source `fen_and_last_move_at_ply(game.pgn, ...)` reconstruction. Once herrings read exclusively from their `herring_pool` row (D-03, this plan's own fix), a herring row with no pool link is correctly treated as unservable/FEN-empty, breaking both tests' PGN-derived-FEN assertions — a scenario that can no longer occur in production (every real herring composed via Plan 01's `herring_stmt` carries a `herring_pool_id`).
- **Fix:** Switched both tests' source to `SR_ITEM` (the source this PGN-derived-FEN path still legitimately applies to) plus the drill_items/GameFlaw fixtures each now needs; the UCI-parsing/null-move logic under test is source-agnostic, so this preserves each test's original intent.
- **Files modified:** `tests/routers/test_train.py`
- **Verification:** `uv run pytest tests/routers/test_train.py -x -q` — all pass
- **Committed in:** `8799142c` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — bugs in pre-existing test fixtures made stale by this plan's own intentional behavior changes)
**Impact on plan:** Both were necessary, in-scope consequences of the FK-policy change and the D-03 herring-FEN-sourcing fix this plan itself specifies. No scope creep, no architectural change.

## Issues Encountered

- **Grep-count estimate mismatch (cosmetic, non-blocking):** the acceptance criterion `grep -c "Mapped\[int | None\] = mapped_column(ForeignKey(\"games.id\"" app/models/drill_solve.py` expects `1` but returns `0` — `ruff format` wraps the declaration across three lines (matching the pre-existing `herring_pool_id` column's own formatting one field below it) because the single-line form is 107 characters against the project's 100-character limit. Confirmed via `git diff` that the substantive requirement (the column is `Mapped[int | None]` with `ForeignKey("games.id", ondelete="SET NULL")`) is met exactly — this is the same class of estimate-vs-formatter mismatch Plan 01's SUMMARY noted for its `jsonb_typeof` grep count.
- **Herring pool rows leak across `test_engine`-based tests (caught before it caused a false green):** the new router tests' `_seed_herring_pool_row` helper committed rows for real (no rollback), and `HerringPool` candidacy is deliberately identity-blind (D-10, no `user_id` filter) — an uncleaned pool row from one test polluted `test_progress_returns_200_with_all_seven_fields`'s `waiting_count == 0` assertion for a brand-new account. Fixed by adding a `_delete_herring_pool_rows` cleanup helper (mirroring the identically-named helper already established in `tests/services/test_train_pool.py`) and calling it in every new test's `finally` block, before `_delete_games`.

## User Setup Required

None — no external service configuration required. The dev PostgreSQL container was the only runtime dependency, already running.

## Next Phase Readiness

- `drill_solves.game_id` is nullable with `ON DELETE SET NULL` in the live dev database; every dependent code path (resume, completion, reveal) has tested, opposite SR-vs-herring semantics.
- The backend contract Plan 05 (frontend) depends on is now live: `TrainPuzzle.game_id`/`PuzzleRevealResponse.game_id` are `int | None` over the wire, and the reveal already returns a real in-game move for a cross-user herring. Plan 05 does not need any further backend widening — only the frontend consumption (hide the Analyze deep-link when `game_id` is `null` per D-09, drop the "Game: ..." context line for herrings per D-07).
- **Note for Plan 04:** unaffected by this plan — the nine skipped `herring_stmt` tests in `tests/services/test_train_pool.py` remain untouched, still Plan 04's named debt handoff.
- **Note for Plan 03:** unaffected by this plan — `HERRING_LOOSE_BAND_ES`/`HERRING_MIN_QUALIFYING_MOVES`/`HERRING_PREFERRED_QUALIFYING_MOVES` remain Plan 01's provisional constants, still Plan 03's job to re-pin.

## Self-Check: PASSED

- `FOUND: app/models/drill_solve.py` (modified)
- `FOUND: alembic/versions/20260727_234844_127c8bd364a6_phase_192_drill_solves_game_id_nullable.py`
- `FOUND: 8799142c` (git log)
- `FOUND: 9226faf6` (git log)

---
*Phase: 192-red-herring-position-pool*
*Completed: 2026-07-28*
