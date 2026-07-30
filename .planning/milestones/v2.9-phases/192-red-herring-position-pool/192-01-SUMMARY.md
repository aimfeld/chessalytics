---
phase: 192-red-herring-position-pool
plan: 01
subsystem: api
tags: [postgresql, sqlalchemy, alembic, stockfish, chess-engine, train, herring-pool]

# Dependency graph
requires:
  - phase: 189-train-spaced-repetition-blunder-drills
    provides: drill_solves/drill_sessions schema, compose_and_materialize_session, herring_stmt (superseded game_best_moves source)
provides:
  - "herring_pool table + HerringPool model (surrogate id PK, D-01 SET NULL composite FK to games, D-04 no-repeat key)"
  - "EnginePool.evaluate_nodes_multipv5 + module wrapper (MultiPV-5 search reusing the existing node budget)"
  - "scripts/gen_red_herring_pool.py — real single-phase generator, --db required, ON CONFLICT top-up idempotency"
  - "herring_stmt rewritten to read herring_pool exclusively — no Game join, no game_best_moves reference"
  - "compose_and_materialize_session herring branch: FEN/arriving-move read straight off the pool row, own-game/SR collision drop"
affects: [192-02-drill-solves-nullability, 192-03-generator-completion, 192-04-query-time-gate, 192-05-reveal-frontend]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Position-scoped, identity-blind pool table (HerringPool) with a surrogate PK and a demoted natural-key UNIQUE constraint — mirrors GameBestMove's position-scoping one level further (not even user-scoped)"
    - "_ReconstructedPuzzle module-private frozen dataclass replacing a 6/7-field positional tuple in compose_and_materialize_session"

key-files:
  created:
    - app/models/herring_pool.py
    - scripts/gen_red_herring_pool.py
    - alembic/versions/20260727_214735_03df30e3c008_phase_192_herring_pool_and_drill_solve_link.py
  modified:
    - app/models/drill_solve.py
    - app/services/engine.py
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - app/routers/train.py
    - alembic/env.py
    - tests/repositories/test_train_repository.py
    - tests/services/test_train_pool.py

key-decisions:
  - "herring_pool.id is a surrogate BigInteger PK (Task 1 checkpoint, user-approved option-a); the SEED-120 (user_id, game_id, ply) triple is demoted to a UNIQUE constraint since a PK column cannot tolerate D-01's SET NULL"
  - "herring_stmt applies NO qualifier gate in this tracer beyond exclude_served — the tight query-time gate is explicitly Plan 04's job"
  - "Own-game herrings are permitted (D-10); a collision with an SR pick from the same session is resolved by dropping the herring before insert, not by an exclusion filter in herring_stmt"
  - "The nine pre-existing herring_stmt tests in test_train_pool.py are skipped (not deleted) with a reason naming Plan 04 as the replacement owner"

requirements-completed: [POOL-03]

coverage:
  - id: D1
    description: "HerringPool table + model created and pushed to the dev database, with the ladder-shape write-time CHECK, D-01 SET NULL composite FK, and D-04 drill_solves.herring_pool_id link"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_herring_fen_comes_from_pool_row_not_pgn"
        status: pass
      - kind: other
        ref: "uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head"
        status: pass
    human_judgment: false
  - id: D2
    description: "EnginePool.evaluate_nodes_multipv5 + module wrapper, reusing _NODES_BUDGET/_NODES_TIMEOUT_S verbatim (no new engine constant)"
    requirement: "POOL-03"
    verification:
      - kind: integration
        ref: "uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 5 --phase middlegame (real Stockfish MultiPV-5 search)"
        status: pass
    human_judgment: false
  - id: D3
    description: "herring_stmt rewritten to read herring_pool exclusively (no Game join, no game_best_moves reference); exclude_served keys on herring_pool_id"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py#test_herring_selects_pool_row"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_pool.py#test_herring_excludes_already_served_by_pool_id"
        status: pass
    human_judgment: false
  - id: D4
    description: "compose_and_materialize_session's herring branch reads FEN/arriving move straight off the pool row (D-03) and drops an own-game herring colliding with an SR pick (D-10)"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_herring_fen_comes_from_pool_row_not_pgn"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_own_game_herring_colliding_with_sr_pick_is_dropped"
        status: pass
    human_judgment: false
  - id: D5
    description: "scripts/gen_red_herring_pool.py generates real herring_pool rows against the dev database via a real MultiPV-5 Stockfish search"
    requirement: "POOL-03"
    verification:
      - kind: other
        ref: "uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 5 --phase middlegame; verified via psql row-count and ladder-shape/fen/mover_color CHECK queries"
        status: pass
    human_judgment: false

duration: 41min
completed: 2026-07-28
status: complete
---

# Phase 192 Plan 1: Herring pool tracer Summary

**A real `herring_pool` row, produced by a real MultiPV-5 Stockfish search, served end to end through `compose_and_materialize_session` with its own FEN and arriving move — the superseded `game_best_moves` herring source is gone from `app/services/train_pool.py`.**

## Performance

- **Duration:** 41 min
- **Started:** 2026-07-27T21:30:09Z
- **Completed:** 2026-07-27T22:11:14Z
- **Tasks:** 3 (Task 1 checkpoint:decision, Task 2 tracer, Task 3 schema push + generator proof)
- **Files modified:** 10 (3 created, 7 modified — see Files Created/Modified)

## Accomplishments

- `HerringPool` model + additive migration: surrogate `id` PK (Task 1 checkpoint, user-approved), `ondelete="SET NULL"` composite FK to `games(id, user_id)` (D-01), `uq_herring_pool_source` UNIQUE on `(user_id, game_id, ply)`, `ck_herring_pool_ladder_shape` write-time CHECK, `ladder` column `deferred=True` (mirrors `GameFlaw.missed_pv_lines`'s leak guard)
- `drill_solves.herring_pool_id` nullable FK — the herring's authoritative no-repeat key (D-04), replacing `(game_id, ply)`
- `EnginePool.evaluate_nodes_multipv5` + module-level wrapper — reuses `_NODES_BUDGET`/`_NODES_TIMEOUT_S` verbatim (D-12), no new engine budget constant
- `herring_stmt` fully rewritten: reads `herring_pool` exclusively, no `Game` join, no `game_best_moves`/`GameBestMove` reference anywhere in `train_pool.py`; identity-blind (never filters on `HerringPool.user_id`, D-10)
- `compose_and_materialize_session`'s herring branch: new `_ReconstructedPuzzle` frozen dataclass, herring FEN/arriving-move read straight off the pool row (D-03, no PGN reconstruction for herrings), own-game herrings colliding with an SR pick are dropped before insert (D-10)
- `scripts/gen_red_herring_pool.py`: real single-phase generator run against the dev database with a real Stockfish binary — see measured counts below
- Ran the full pre-merge gate: backend 3856 passed / 27 skipped, frontend lint clean + 2776 tests passed

### Generator run measurements (dev, `--n-positions 5 --phase middlegame`)

| Metric | Count |
|---|---|
| Candidate frame (LIMIT) | 100 |
| Scanned | 6 |
| Rejected — fewer than 5 legal moves / engine failure | 0 |
| Rejected — ply-mover mismatch | 0 |
| Rejected — FEN unreconstructable | 0 |
| Rejected — below `HERRING_LOOSE_BAND_ES` loose qualifying-moves band | 1 |
| Stored | 5 |
| Wall-clock | ~15.4s (mostly 5 real MultiPV-5 Stockfish searches at 1M nodes each) |

A re-run against the same dev data with the same flags stored no duplicates (`ON CONFLICT (user_id, game_id, ply) DO NOTHING` confirmed idempotent — row count stayed at 5).

These are the numbers Plan 03 consumes to re-pin `HERRING_LOOSE_BAND_ES` (currently a provisional 0.10) from a much larger run.

## Task Commits

Each task was committed atomically:

1. **Task 1: Confirm the pool row's identity model before the table is created** — checkpoint:decision, no commit (orchestrator relayed the user's `option-a` approval)
2. **Task 2: End-to-end "one pool herring served"** — `4b683888` (feat)
3. **Task 3: Push the schema, prove the tracer against a real generated pool, and green the suite** — `34874fef` (test)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `app/models/herring_pool.py` — `HerringPool` model, `herring_pool` table
- `alembic/versions/20260727_214735_03df30e3c008_phase_192_herring_pool_and_drill_solve_link.py` — additive migration (applied to dev, downgrade round-trip verified)
- `app/models/drill_solve.py` — `herring_pool_id` nullable FK column + docstring update
- `app/services/engine.py` — `EnginePool.evaluate_nodes_multipv5` + module wrapper
- `app/services/train_pool.py` — new `HERRING_*` constants, `herring_stmt` fully rewritten against `HerringPool`
- `app/repositories/train_repository.py` — `_ReconstructedPuzzle` dataclass, herring branch rewired to the pool row, `ComposedPuzzle` widened (`game_id: int | None`, `herring_pool_id`)
- `app/routers/train.py` — narrows `ComposedPuzzle.game_id` for `TrainPuzzle` construction (Plan 01 invariant: never actually None until Plan 02)
- `alembic/env.py` — registers `HerringPool` for autogenerate
- `scripts/gen_red_herring_pool.py` — new real MultiPV-5 generator script
- `tests/repositories/test_train_repository.py` — `_seed_herring_pool_row` helper, two new tests, six pre-existing composition tests re-seeded via the new helper
- `tests/services/test_train_pool.py` — `_seed_pool_row`/`_seed_bare_game`/`_seed_served_herring_by_pool_id`/`_delete_herring_pool_rows` helpers, two new tests, nine pre-existing superseded-source tests skipped with a named owner

## Decisions Made

- **`herring_pool.id` surrogate PK (Task 1 checkpoint, user-approved `option-a`):** the SEED-120 `(user_id, game_id, ply)` triple cannot be the PK because D-01 requires the composite FK to be `ondelete="SET NULL"`, and a PostgreSQL PK column cannot be NULL. The triple is now a `UniqueConstraint`, still doing generation-time dedup + `ON CONFLICT ... DO NOTHING` top-up idempotency.
- **No qualifier gate in `herring_stmt` beyond `exclude_served`:** the plan's tracer scope explicitly defers the tight, retunable query-time gate to Plan 04 — this task ships the source swap and the D-04 exclusion clause only.
- **Own-game collision resolved at composition time, not query time:** `herring_stmt` never filters on `user_id`/game ownership (D-10 identity-blind pool); the drop happens in `compose_and_materialize_session` right before the `DrillSolve` insert, comparing the herring's `(game_id, ply)` against the surviving SR picks for the same session.
- **`_seed_herring_game` (the superseded `game_best_moves` seed helper) is left in place, unused by any test now** — the plan says it "stays where it is until Plan 04 replaces that block". The six pre-existing composition tests that used to call it were switched to the new `_seed_herring_pool_row` helper instead, since `herring_stmt` no longer reads `game_best_moves` at all and those tests would otherwise silently assert on zero herring material.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Six pre-existing composition tests in `test_train_repository.py` would have silently gotten zero herring material**
- **Found during:** Task 2, while tracing `compose_and_materialize_session`'s herring branch
- **Issue:** The plan's acceptance criteria say "the existing 3 composition tests still pass," but six existing tests (`test_full_session_is_nine_sr_and_three_herrings`, `test_sr_shortfall_backfills_with_herrings`, `test_herring_shortfall_backfills_with_sr`, `test_padding_introduces_new_drill_items_recency_first`, `test_composition_on_off_day_draws_from_same_queue`, `test_frozen_order_is_stable_across_resumes`) seed herring material via `_seed_herring_game` (the superseded `game_best_moves` source). Since `herring_stmt` no longer reads that table, all six would have gotten zero herring candidates and their exact-count assertions would have failed.
- **Fix:** Added a `_seed_herring_pool_row` helper (as the plan specified, as a sibling to `_seed_herring_game`) and switched these six tests' seed calls to it. Traced the slot arithmetic for each test to confirm the expected SR/herring counts are unchanged with pool-row material.
- **Files modified:** `tests/repositories/test_train_repository.py`
- **Verification:** `uv run pytest tests/repositories/test_train_repository.py -x -q` — all 66 tests pass
- **Committed in:** `4b683888` (Task 2 commit)

**2. [Rule 3 - Blocking] `app/routers/train.py`'s `TrainPuzzle` construction failed `ty check` after widening `ComposedPuzzle.game_id`**
- **Found during:** Task 2, running `uv run ty check app/ tests/`
- **Issue:** Task 2 explicitly required widening `ComposedPuzzle.game_id` to `int | None` (forward-compat with `HerringPool.game_id`'s nullability), but `TrainPuzzle.game_id`'s own widening to `int | None` is explicitly Plan 02's job per the plan's own artifact table. This left a real type mismatch: `TrainPuzzle(game_id=p.game_id, ...)` where `p.game_id: int | None` but the schema field is `int`.
- **Fix:** Added an `assert p.game_id is not None` narrowing at the router call site, mirroring the identical narrowing already needed (and added) in `train_repository.py`'s `DrillSolve` insert — both document the same Plan 01 invariant: `drill_solves.game_id` stays NOT NULL until Plan 02, so a served puzzle's `game_id` is never actually `None` yet.
- **Files modified:** `app/routers/train.py`
- **Verification:** `uv run ty check app/ tests/` exits 0; `uv run pytest tests/routers/test_train.py -x -q` — 54 pass
- **Committed in:** `4b683888` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both were necessary consequences of the herring-source swap and the `ComposedPuzzle.game_id` widening the plan itself specified — no scope creep, no architectural change.

## Issues Encountered

- The acceptance criterion `grep -c "jsonb_typeof" app/services/train_pool.py` returns `5`, not the plan's stated `1`. Confirmed via `git diff` that zero `jsonb_typeof` usage was added or touched by this plan — the count of `5` is because `answer_key_present`'s docstring (pre-existing, untouched) mentions the term four times in prose plus once in code. The substantive requirement ("no new shape guard was added to the herring path") is satisfied; the plan's expected grep count appears to be an estimate that didn't account for the docstring's prose mentions.

## User Setup Required

None — no external service configuration required. The dev PostgreSQL container and a local Stockfish binary (already resolved via `_resolve_stockfish_path`) were the only runtime dependencies, both already in place.

## Next Phase Readiness

- The architecture question this plan set out to answer is confirmed: a `herring_pool` row carries everything `compose_and_materialize_session` needs, with zero `Game` join on the happy path.
- `HerringPool` and its constraints exist in the live dev database (migration applied, downgrade round-trip verified), and 5 real rows are already in place from the generator smoke run — Plan 03 can build on that data immediately without needing to re-run the generator from zero.
- **Blocker/note for Plan 03:** `HERRING_LOOSE_BAND_ES` (0.10), `HERRING_MIN_QUALIFYING_MOVES` (2), and `HERRING_PREFERRED_QUALIFYING_MOVES` (3) are explicitly provisional — Plan 03 must re-pin them from a larger run's measured qualifying-rate distribution, not treat this plan's 6-scanned/5-stored sample as statistically meaningful.
- **Note for Plan 02:** `drill_solves.game_id` and `ComposedPuzzle.game_id`/`TrainPuzzle.game_id` all still carry a Plan-01-added `assert ... is not None` narrowing at the two call sites this plan touched (`train_repository.py`, `train.py`). Plan 02's nullability migration should revisit both assertions — they document a Plan 01 invariant that Plan 02 is explicitly designed to relax.
- **Note for Plan 04:** the nine skipped `herring_stmt` tests in `tests/services/test_train_pool.py` (superseded-source seed helpers `_seed_herring_candidate`/`_add_herring_candidate_row`/`_seed_served_herring` still present, untouched) are this plan's named debt handoff — Plan 04 owns their full replacement against the new query-time qualifier gate.

## Self-Check: PASSED

- `FOUND: app/models/herring_pool.py`
- `FOUND: scripts/gen_red_herring_pool.py`
- `FOUND: alembic/versions/20260727_214735_03df30e3c008_phase_192_herring_pool_and_drill_solve_link.py`
- `FOUND: 4b683888` (git log)
- `FOUND: 34874fef` (git log)

---
*Phase: 192-red-herring-position-pool*
*Completed: 2026-07-28*
