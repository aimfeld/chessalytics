---
phase: 206-train-warmup-sharp-filler
plan: 01
subsystem: api
tags: [fastapi, sqlalchemy, alembic, postgresql, react, typescript, train]

requires:
  - phase: 192-red-herring-position-pool
    provides: "herring_pool table, herring_stmt exhaustion contract, DrillSource, drill_solves nullable game_id/herring_pool_id shape this phase extends"
  - phase: 189-train-foundation
    provides: "drill_items/drill_sessions/drill_solves tables, compose_and_materialize_session, session composition lifecycle"
provides:
  - "DrillSource.SHARP_FILLER = 2, drill_solves.sharp_puzzle_id, ck_drill_solves_source widened to (0,1,2), drill_sessions.is_warmup column"
  - "app/services/sharp_filler.py: SharpPuzzle, SHARP_SET/SHARP_SET_BY_ID, pick_sharp_fillers, served_sharp_ids_stmt, sharp_filler_available"
  - "app/data/sharp_filler_puzzles.csv: 5-row committed CC0 seed set (200-position pass is plan 02)"
  - "_select_candidates/_SessionCandidates extraction under CLAUDE.md function-size limits"
  - "_backfill_sharp_fillers: post-reconstruction sharp-filler backfill stage (D-03)"
  - "_wire_source: single DrillSource -> wire-string mapping site"
  - "SolveResponse.source / PuzzleRevealResponse.source widened to include 'sharp_filler', PuzzleRevealResponse.motif"
  - "TrainReveal.tsx D-19 your-game predicates rewritten to verdict.source === 'sr_item'"
affects: [206-02-sharp-filler-200-position-authoring, 206-03-warmup-label]

actuals:
  tokens: 28614
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Committed data file -> module-level constant loaded once at import (mirrors app/services/opening_lookup.py's _TRIE)"
    - "Fail-closed data loader (RuntimeError on missing/empty file, never a silent empty set)"
    - "Single wire-mapping-site helper (_wire_source) instead of a hand-rolled ternary at each call site"
    - "Autouse per-test-file fixture defaulting a real committed data constant to empty, with an explicit opt-in helper for tests that need it"

key-files:
  created:
    - app/services/sharp_filler.py
    - app/data/sharp_filler_puzzles.csv
    - alembic/versions/20260807_114022_e5f71b11fa51_phase_206_sharp_filler_source.py
    - tests/services/test_sharp_filler.py
  modified:
    - app/repositories/train_repository.py
    - app/models/drill_solve.py
    - app/models/drill_session.py
    - app/schemas/train.py
    - app/routers/train.py
    - frontend/src/types/train.ts
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - tests/repositories/test_train_repository.py
    - tests/routers/test_train.py
    - tests/test_imports_router.py

key-decisions:
  - "Task 1 checkpoint: developer selected 'as-specified' — sharp_puzzle_id TEXT nullable no-FK, ck_drill_solves_source widened to (0,1,2), drill_sessions.is_warmup BOOLEAN NOT NULL, all in one Alembic revision"
  - "D-02 cap: herring cross-backfill capped at floor(n * HERRING_SHARE), never grown past it — the pre-existing 'SR short -> pull extra herrings' arm is retired"
  - "D-03: sharp filler fills every residual shortfall post-reconstruction (not gated on all-filler), via a new _backfill_sharp_fillers stage separate from _select_candidates since it runs at a different pipeline point"
  - "e0 pure-move extraction of _select_candidates committed separately from the D-02/D-03 behavior change, per CLAUDE.md's function-size limits (249 -> 169 -> 177 logic LOC)"
  - "D-19: TrainReveal.tsx's three your-game predicates now read verdict.source === 'sr_item' (landing synchronously with SolveResponse) instead of the async-timing-vulnerable puzzle_type !== 'herring' proxy"
  - "Test isolation: an autouse per-file fixture defaults SHARP_SET to empty in tests/repositories/test_train_repository.py, tests/routers/test_train.py, and tests/test_imports_router.py (one test), with an _install_sharp_fixture opt-in helper for tests exercising real sharp-filler backfill"

patterns-established:
  - "Sharp-filler data model: SharpPuzzle frozen dataclass, module constants SHARP_SET (ascending puzzle_id) / SHARP_SET_BY_ID, loaded once at import"
  - "D-14 exhaustion contract mirrored in plain Python (pick_sharp_fillers): filter to unserved, fall back to full unfiltered set on exhaustion"

requirements-completed: [WARM-03, WARM-04, WARM-06, WARM-07]

coverage:
  - id: D1
    description: "Migration lands DrillSource.SHARP_FILLER=2, drill_solves.sharp_puzzle_id, widened ck_drill_solves_source, drill_sessions.is_warmup — round-trips cleanly upgrade/downgrade/upgrade"
    requirement: WARM-04
    verification:
      - kind: integration
        ref: "alembic upgrade head && alembic downgrade -1 && alembic upgrade head"
        status: pass
    human_judgment: false
  - id: D2
    description: "Zero-SR-material session composes exactly 2 RED_HERRING + 6 SHARP_FILLER at n=8 (never 100% herrings); 3-SR case composes 3 SR + 2 herring (D-02 cap) + 3 sharp"
    requirement: WARM-03
    verification:
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_zero_sr_material_composes_two_herrings_and_six_sharp"
        status: pass
      - kind: unit
        ref: "tests/repositories/test_train_repository.py#test_three_sr_candidates_compose_three_sr_two_herring_three_sharp"
        status: pass
    human_judgment: false
  - id: D3
    description: "A SHARP_FILLER puzzle is served, solved, graded, and revealed end-to-end with no drill_items row, no game_flaws read, and correct puzzle_type/source in both the solve and reveal responses"
    requirement: WARM-04
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_solve_sharp_filler_touches_no_drill_item"
        status: pass
      - kind: integration
        ref: "tests/routers/test_train.py#test_reveal_sharp_filler_reports_sharp_filler_source"
        status: pass
    human_judgment: false
  - id: D4
    description: "TrainReveal.tsx's three D-19 your-game predicates (mastery banner, guess prose, game footer) suppress together for a sharp_filler source and render for sr_item, reading verdict.source with no async-timing gap"
    requirement: WARM-06
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#a sharp_filler verdict (puzzle_type \"sharp\", same as a real SR puzzle) suppresses the mastery banner, the game footer, and the own-game guess prose all together"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#an sr_item verdict with puzzle_type \"sharp\" (the exact literal a sharp_filler also carries) still renders all three D-19 sites — proves the predicate reads source, not puzzle_type"
        status: pass
    human_judgment: false
  - id: D5
    description: "compose_and_materialize_session is under CLAUDE.md's hard function-size limits after this plan (249 logic LOC before -> 177 after), via a behavior-preserving e0 extraction committed separately"
    verification:
      - kind: unit
        ref: "ast-based logic-LOC gate (plan's verify script), run against app/repositories/train_repository.py"
        status: pass
    human_judgment: false
  - id: D6
    description: "The sharp filler's motif is surfaced on the reveal (Task 3, D-20) — non-null for a SHARP_FILLER solve, null for SR_ITEM/RED_HERRING, rendered as a plain text-sm row with no chip/icon"
    requirement: WARM-06
    verification:
      - kind: integration
        ref: "tests/routers/test_train.py#test_reveal_sharp_filler_reports_sharp_filler_source (motif assertion)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#a non-null motif renders exactly one Motif row inside the guess card"
        status: pass
    human_judgment: false

duration: 50min
completed: 2026-08-07
status: complete
---

# Phase 206 Plan 01: Sharp-Filler Tracer Summary

**One lichess CC0 position now flows migration -> composition -> serve -> solve -> grade -> reveal -> frontend render, with `compose_and_materialize_session` under CLAUDE.md's function-size limits and a source-based (not puzzle_type-based) your-game predicate in `TrainReveal.tsx`.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-08-07T13:44Z (first commit)
- **Completed:** 2026-08-07T14:33Z (last commit)
- **Tasks:** 3 (Task 1 checkpoint pre-resolved by orchestrator; Task 2 tracer; Task 3 motif)
- **Files modified:** 15 (4 new, 11 modified)

## Accomplishments

- Landed the phase's one-way migration door exactly as the pre-resolved Task 1 decision specified: `drill_solves.sharp_puzzle_id` (TEXT, nullable, no FK), `DrillSource.SHARP_FILLER = 2` with `ck_drill_solves_source` widened to `(0, 1, 2)`, and `drill_sessions.is_warmup` (BOOLEAN NOT NULL, frozen at composition) — all in one Alembic revision, verified with a clean upgrade/downgrade/upgrade round trip.
- New `app/services/sharp_filler.py` module: a committed-data-file-to-module-constant loader (mirrors `opening_lookup.py`'s `_TRIE` precedent) that fails closed (`RuntimeError`) on a missing or zero-row file, plus `pick_sharp_fillers` implementing D-14's exhaustion contract (deterministic ascending-`puzzle_id` order, exclude-served, repeat-on-exhaustion) in plain Python.
- Composition now caps the herring cross-backfill at `floor(n * HERRING_SHARE)` (D-02) and fills every residual shortfall from the static sharp set via a new post-reconstruction `_backfill_sharp_fillers` stage (D-03) — an 8-puzzle all-filler session is now 2 herrings + 6 sharp instead of 10 herrings.
- `reveal_for_puzzle`'s four sites (join/lookup, FEN resolution, `puzzle_type`/`has_tactic_lines`, and the `source=` mapping) all gained a real three-way branch, replacing a two-way ternary that would have silently mislabeled a `SHARP_FILLER` row as `red_herring`. A new `_wire_source` helper is the single `DrillSource` -> wire-string mapping site, shared by `record_solve` and `reveal_for_puzzle`.
- `SolveResponse.source` lands synchronously with the solve mutation (mirroring `puzzle_type`), so `TrainReveal.tsx`'s three D-19 your-game predicates (mastery banner, guess prose, game footer) read `verdict.source === 'sr_item'` with no dependency on the separate, asynchronously-fetched reveal query — closing the timing gap RESEARCH Pitfall 1 identified.
- Task 3: the sharp filler's motif ("Fork", "Skewer", ...) is surfaced on the reveal as a plain `text-sm` row, read straight from the committed data file with no runtime theme-to-label mapping.
- `compose_and_materialize_session` was refactored (a pure-move `_select_candidates` extraction, committed separately before any behavior change) from 249 logic LOC / depth 5 down to 177 logic LOC, under CLAUDE.md's hard limits, before the D-02/D-03 behavior was added.
- All 6 named mutation checks (4 in Task 2, 2 in Task 3) performed and confirmed RED before restoring the production line.

## Task Commits

1. **Task 1: Confirm the one-way migration door before it is opened** — pre-resolved by the orchestrator (developer selected "as-specified"); no separate code commit, resolution recorded in Task 2's migration.
2. **Task 2: End-to-end "one lichess sharp position solved and revealed"** — `1e79c0c81` (refactor: e0 pure-move extraction), `1805ae456` (feat: the full tracer)
3. **Task 3: Surface the sharp filler's motif on the reveal (D-20)** — `799c6d4cc` (feat)

_Task 2 split into two commits per the plan's explicit e0-must-be-its-own-commit requirement: the pure-move extraction must land with zero test-file changes and a green pre-existing suite as proof it preserved behavior, separately from the D-02/D-03 behavior change that follows it._

## Files Created/Modified

- `alembic/versions/20260807_114022_e5f71b11fa51_phase_206_sharp_filler_source.py` - the one-way migration (D-07/D-10/D-17)
- `app/services/sharp_filler.py` - `SharpPuzzle`, `SHARP_SET`/`SHARP_SET_BY_ID`, `pick_sharp_fillers`, `served_sharp_ids_stmt`, `sharp_filler_available`
- `app/data/sharp_filler_puzzles.csv` - 5-row committed CC0 seed set (200-position authoring pass is plan 02)
- `app/models/drill_solve.py` - `DrillSource.SHARP_FILLER`, widened CHECK, `sharp_puzzle_id` column
- `app/models/drill_session.py` - `is_warmup` column (written/read in plan 03)
- `app/repositories/train_repository.py` - `_select_candidates`/`_SessionCandidates` extraction, `_backfill_sharp_fillers`, `_wire_source`, three-way branches in `_classify_solve_puzzle_type`/`reveal_for_puzzle`/`load_session_puzzles`, `motif` on `RevealedPuzzle`
- `app/schemas/train.py` - `SolveResponse.source`, `PuzzleRevealResponse.source` widened, `PuzzleRevealResponse.motif`
- `app/routers/train.py` - pass-through of `source`/`motif` in response construction
- `frontend/src/types/train.ts` - `SolveResponse.source`, `PuzzleRevealResponse.source`/`motif`
- `frontend/src/components/train/TrainReveal.tsx` - D-19 predicate rewrite (3 sites), motif row
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` - `source`/`motif` fixture defaults, new sharp-filler and motif test cases
- `tests/services/test_sharp_filler.py` (new) - loader fail-closed tests, D-14 contract tests
- `tests/repositories/test_train_repository.py` - autouse empty-sharp-set fixture, `_install_sharp_fixture` helper, composition-ratio tests, identity-column invariant tests, two rewritten pre-existing tests, three additional fixes for tests whose material relied on the retired cross-backfill arm
- `tests/routers/test_train.py` - autouse empty-sharp-set fixture, `_seed_session` extended for `game_id: int | None`/`sharp_puzzle_ids`, new solve/reveal sharp-filler tests, `_delete_sessions` cleanup helper
- `tests/test_imports_router.py` - one test opted the real sharp set out to preserve its original "empty session" regression guard

## Decisions Made

- Task 1 checkpoint decision (pre-resolved): "as-specified" — land all three schema/contract changes verbatim, no column renames.
- D-02/D-03 exactly as CONTEXT.md specifies: cap the herring cross-backfill, route every residual shortfall to sharp filler unconditionally (not gated on all-filler).
- `_backfill_sharp_fillers` is a separate stage from `_select_candidates`, not folded in, because it runs POST-reconstruction (it must absorb puzzles dropped for an unparseable FEN, which the pre-reconstruction slot arithmetic cannot see).
- Test isolation strategy: rather than editing every pre-existing composition/pool-entry test individually, an autouse fixture defaults the real committed `SHARP_SET` to empty for the whole test file, with an explicit `_install_sharp_fixture(monkeypatch)` opt-in for tests that exercise real sharp-filler backfill. This keeps the blast radius of D-05's "composition never returns empty" change legible per test rather than threaded through dozens of individually-patched call sites.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/behavior-scope correction] More than the plan's predicted "two tests" needed rewriting for D-02's retired cross-backfill arm**

- **Found during:** Task 2, running the full `tests/repositories/test_train_repository.py` + `tests/routers/test_train.py` suites after wiring D-02/D-03.
- **Issue:** The plan's RESEARCH/PATTERNS explicitly named exactly two pre-existing tests as invalidated by D-02 (`test_sr_shortfall_backfills_with_herrings`, `test_cap_shortened_sr_side_fills_via_herring_backfill`). In practice, the real committed (non-empty) `SHARP_SET` combined with D-03's "sharp fills every shortfall" and D-05's "composition never returns empty once material exists" invalidated several more pre-existing tests across `test_train_repository.py`, `test_train.py`, and `test_imports_router.py` — any test that relied on "zero SR + zero/insufficient herring material -> empty session" as an incidental proxy for "this flaw is excluded from the SR pool" now saw a full session composed from sharp fillers instead.
- **Fix:** Added an autouse per-test-file fixture defaulting `SHARP_SET`/`SHARP_SET_BY_ID` to empty (restoring the pre-Phase-206 "no material -> empty" behavior for every test that doesn't explicitly opt in), plus an `_install_sharp_fixture(monkeypatch)` helper for tests that need real sharp-filler backfill (the two flagged rewrites, three new composition-ratio tests, and three other pre-existing tests whose own SR-shortfall material happened to rely on the retired cross-backfill arm to reach their expected `puzzle_count`, fixed by either installing the fixture or reshaping the seeded material so no backfill was needed at all). One test in `tests/test_imports_router.py` (unrelated to Train's own test suite) also needed the same empty-set opt-out to preserve its "returns empty after delete-all" regression guard.
- **Files modified:** `tests/repositories/test_train_repository.py`, `tests/routers/test_train.py`, `tests/test_imports_router.py`
- **Verification:** Full backend suite green (4116 passed, 19 skipped) after the fix; each adjusted test's original intent re-verified against the new expected behavior (never weakened to a tautology).
- **Committed in:** `1805ae456` (Task 2 commit)

**2. [Rule 1 - Bug] Two router tests committing a real `SHARP_FILLER` row broke unrelated Alembic-downgrade migration tests in the same per-worker DB clone**

- **Found during:** Task 2, running the full backend suite (`uv run pytest -n auto`) after the router-level sharp-filler solve/reveal tests were added.
- **Issue:** `test_solve_sharp_filler_touches_no_drill_item` and `test_reveal_sharp_filler_reports_sharp_filler_source` use the real HTTP endpoint (`test_engine`, real commits, no rollback), leaving a committed `source=2` `drill_solves` row with no `game_id` to clean up via the existing `_delete_games` helper. Several unrelated migration tests (`test_migration_117.py`, `test_migration_186_user_import_settings.py`, `test_migration_91_evals_completed_at.py`) downgrade Alembic back through every revision in the same worker's DB clone and hit `ck_drill_solves_source`'s CHECK violation on the orphaned row.
- **Fix:** Added a `_delete_sessions` helper (deletes the `drill_sessions` row directly; `drill_solves` cascade-deletes with it) and wrapped both new tests in `try/finally` to call it.
- **Files modified:** `tests/routers/test_train.py`
- **Verification:** Full backend suite green (4116 passed) with no migration-test failures.
- **Committed in:** `1805ae456` (Task 2 commit)

**3. [Rule 1 - Bug] Corrected an over-broad "exactly one non-null identity column" invariant assumption in a new test**

- **Found during:** Task 2, writing `test_composed_session_rows_each_carry_exactly_one_identity_column`.
- **Issue:** A first draft asserted that for every `DrillSolve` row, exactly one of `{game_id, herring_pool_id, sharp_puzzle_id}` is non-null. This is false for `RED_HERRING` rows: `game_id` (the herring's source game, D-01 own-game herrings permitted) is legitimately non-null alongside `herring_pool_id` (the actual identity/no-repeat key) — only `SR_ITEM` and `SHARP_FILLER` have the strict "one identity column, both others null" shape.
- **Fix:** Narrowed the mutual-exclusivity check to `herring_pool_id`/`sharp_puzzle_id` only (source-exclusive across all three `DrillSource` members), and asserted `game_id`'s per-source expectation separately (`SR_ITEM` non-null, `SHARP_FILLER` null, `RED_HERRING` unconstrained) — matching the real model docstrings rather than an assumed symmetry.
- **Files modified:** `tests/repositories/test_train_repository.py`
- **Verification:** Test passes against real composed session data with all three sources present.
- **Committed in:** `1805ae456` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — behavior-scope corrections and bug fixes directly caused by this plan's own changes)
**Impact on plan:** All three are necessary consequences of implementing the locked D-02/D-03/D-05 decisions correctly at full blast radius; none represent scope creep. The plan's own must-haves (SC3 empty: "with both an empty SR side and an empty herring pool the session is 100% SHARP_FILLER and still holds exactly n puzzles") explicitly call for the behavior that invalidated the extra tests — the plan under-predicted how many pre-existing tests incidentally depended on the old "no material -> empty" behavior as a proxy for something else.

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02 (200-position authoring pass) can proceed: `app/services/sharp_filler.py`'s loader, `SharpPuzzle` shape, and the CSV column contract are all in place and exercised end-to-end by this plan's 5-row seed set — plan 02 only needs to grow the committed data file and its authoring script, no further wiring changes.
- Plan 03 (warm-up label) can proceed: `drill_sessions.is_warmup` is already a live column (written and read starting plan 03); `pool_eligible_since`'s widened stamp condition (Success Criterion 5) and the `'short'` landing-state removal remain plan 03's own scope.
- `compose_and_materialize_session` is comfortably under CLAUDE.md's function-size limits (177 logic LOC, well below the 200 hard ceiling) with headroom for plan 03's `is_warmup` computation.
- No blockers.

## Self-Check: PASSED

All 16 files listed under "Files Created/Modified" (plus this SUMMARY.md itself) verified present on disk. All 3 task commits (`1e79c0c81`, `1805ae456`, `799c6d4cc`) verified present in git history.

---
*Phase: 206-train-warmup-sharp-filler*
*Completed: 2026-08-07*
