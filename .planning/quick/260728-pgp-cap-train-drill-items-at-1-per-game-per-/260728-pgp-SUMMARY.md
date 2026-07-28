---
phase: quick-260728-pgp
plan: 01
subsystem: train
tags: [train, spaced-repetition, sqlalchemy, postgres, random-seeding]

requires:
  - phase: 189-192 (Train pool/session composition)
    provides: pool_entry_stmt, herring_stmt, compose_and_materialize_session
provides:
  - "MAX_ITEMS_PER_GAME_PER_SESSION constant + pick_one_per_game() pure helper in train_pool.py"
  - "Session-wide per-game cap in compose_and_materialize_session via a shared per_game_counts Counter"
affects: [train, drill-composition]

tech-stack:
  added: []
  patterns:
    - "Namespaced random.Random(str) seeding for a second independent RNG stream (train-pool-pick: prefix, distinct from the D-09 composition shuffle)"
    - "Bounded SQL over-fetch (_DUE_OVERFETCH_FACTOR) + Python-side cap when a constraint must span two independently-queried sources"

key-files:
  created: []
  modified:
    - app/services/train_pool.py
    - app/repositories/train_repository.py
    - tests/services/test_train_pool.py
    - tests/repositories/test_train_repository.py
    - CHANGELOG.md

key-decisions:
  - "Cap the fresh pool with a pure uniform-random pick_one_per_game (seeded off user_id/session_date/game_id), never earliest-ply — earliest-ply measurably skews the phase mix (16.2/57.6/26.2 -> 32.2/59.6/8.2 opening/middlegame/endgame)"
  - "Due-side over-fetch (_DUE_OVERFETCH_FACTOR=8, bounded) + Python-applied cap, because the session-wide cap must span both SR sources and a bare SQL LIMIT would under-fill"
  - "One shared per_game_counts Counter threaded through the due loop, the sr_needed padding loop, and the herring-shortfall cross-backfill loop — the single mechanism enforcing the session-wide guarantee"
  - "Did NOT restructure compose_and_materialize_session despite it breaching CLAUDE.md's logic-LOC limit (scope_lock explicitly forbids it for this quick task) — flagged as a follow-up below"

requirements-completed: [TRAIN-CAP-1PG]

coverage:
  - id: D1
    description: "pick_one_per_game caps a game's candidates at MAX_ITEMS_PER_GAME_PER_SESSION, uniform random, deterministic, first-appearance game order preserved"
    requirement: "TRAIN-CAP-1PG"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::TestPickOnePerGame (7 tests: empty input, single candidate, cap enforcement, determinism, other-games-independence, first-appearance order, not-earliest-ply across dates)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A blunder-heavy fresh game contributes exactly one new drill_items row and one SR solve at the predicted ply"
    requirement: "TRAIN-CAP-1PG"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_blunder_heavy_game_contributes_exactly_one_pool_pick"
        status: pass
    human_judgment: false
  - id: D3
    description: "Session-wide cap on the due side: multiple ACTIVE due drill_items from one game -> only one served, others left ACTIVE with unchanged due_date"
    requirement: "TRAIN-CAP-1PG"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_multiple_due_items_same_game_serves_only_one"
        status: pass
    human_judgment: false
  - id: D4
    description: "A due item and an untracked fresh-pool blunder from the SAME game never both appear in one session; no second drill_items row is created"
    requirement: "TRAIN-CAP-1PG"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_due_and_untracked_pool_same_game_never_both_appear"
        status: pass
    human_judgment: false
  - id: D5
    description: "A cap-shortened SR side still fills the session to n via the existing herring cross-backfill, without relaxing the cap"
    requirement: "TRAIN-CAP-1PG"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_cap_shortened_sr_side_fills_via_herring_backfill"
        status: pass
    human_judgment: false
  - id: D6
    description: "All pre-existing composition tests (nine/three split, sr/herring shortfall backfills, recency-first padding) still pass unchanged — the cap is a no-op when each game seeds only one flaw"
    requirement: "TRAIN-CAP-1PG"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py full suite + tests/routers/test_train.py"
        status: pass
    human_judgment: false
  - id: D7
    description: "Full backend suite green, ty zero errors, ruff clean (pre-merge gate)"
    verification:
      - kind: other
        ref: "uv run pytest -n auto -x (3916 passed, 18 skipped); uv run ty check app/ tests/ (zero errors)"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-07-28
status: complete
---

# Quick Task 260728-pgp: Cap Train Drill Items at 1 Per Game Per Session Summary

**Session-wide 1-puzzle-per-game cap on Train composition — a shared `per_game_counts` Counter spanning due `drill_items` and fresh `pool_entry_stmt` picks, with the fresh-pool side using a seeded uniform-random within-game choice (never earliest-ply) to preserve the measured opening/middlegame/endgame phase mix.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-28
- **Tasks:** 3 (all complete)
- **Files modified:** 5 (`app/services/train_pool.py`, `app/repositories/train_repository.py`, `tests/services/test_train_pool.py`, `tests/repositories/test_train_repository.py`, `CHANGELOG.md`)

## Accomplishments

- Added `MAX_ITEMS_PER_GAME_PER_SESSION` (=1) and a pure `pick_one_per_game()` helper to `app/services/train_pool.py`: groups candidates by `game_id` in first-appearance order, samples `min(len(group), cap)` uniformly at random per game via a namespaced `random.Random(f"train-pool-pick:{user_id}:{session_date}:{game_id}")` seed (deliberately distinct from the D-09 composition shuffle's own seed stream), sorts each game's draw by ply ascending, and concatenates — preserving the caller's across-games ordering.
- Wired `pick_one_per_game` into `compose_and_materialize_session`'s fresh-pool block so a blunder-heavy game contributes at most one candidate to the SR padding pool instead of one per qualifying blunder.
- Added `_DUE_OVERFETCH_FACTOR = 8` (bounded) and changed `due_stmt`'s `.limit(sr_slots)` to `.limit(sr_slots * _DUE_OVERFETCH_FACTOR)`, then applied a Python-side per-game cap over the fetched rows — necessary because the cap must span BOTH SR sources (due + pool), which a single SQL `LIMIT` cannot express.
- Introduced one shared `per_game_counts: Counter[int]`, declared immediately before the due loop and threaded through all three SR take-sites (due loop, `sr_needed` padding loop, herring-shortfall cross-backfill loop) — this shared Counter is the session-wide guarantee: a due item and an untracked pool candidate from the same game can never both make it into one session.
- A due item deferred by the cap is skipped for that session only — `status` stays `ACTIVE`, `due_date` is untouched, nothing is deleted — mirroring the existing lazy-eviction comment voice a few lines above it in the source.
- Confirmed (Task 2 step 5, no code change) that the existing cross-backfill still fires correctly when the SR shortfall is CAP-induced rather than pool-exhaustion-induced: `len(sr_candidates) < sr_slots` is exactly true in that case, so the herring branch runs unchanged. Verified directly by `test_cap_shortened_sr_side_fills_via_herring_backfill` (12 puzzles: 2 SR + 10 herrings, one SR puzzle per game).
- Updated `compose_and_materialize_session`'s docstring step 4 to describe the session-wide cap, the skip-but-leave-untouched due behavior, and the uniform-random pool pick.
- Extended the shared `_seed_flaw_game` test fixture with an `existing_game_id` parameter (mirroring `_seed_herring_pool_row`'s) so tests can seed several blunders on one game.
- Added CHANGELOG.md bullet under `[Unreleased] > Changed`.

## Task Commits

1. **Task 1: Per-game pick — constant + pure helper, wired into the fresh pool** - `0485b5cc` (feat)
2. **Task 2: Session-wide cap — due side + the shared count** - `eff2c3dd` (feat)
3. **Task 3: Changelog + full pre-merge gate** - `e3930dc0` (style, ruff-format touch-ups) + `467500ba` (docs, CHANGELOG entry)

## Files Created/Modified

- `app/services/train_pool.py` - `MAX_ITEMS_PER_GAME_PER_SESSION` constant + `pick_one_per_game()` pure helper
- `app/repositories/train_repository.py` - `_DUE_OVERFETCH_FACTOR` constant, due-side cap skip, pool-side `pick_one_per_game` wiring, shared `per_game_counts` Counter threaded through 3 SR take-sites, docstring update
- `tests/services/test_train_pool.py` - `TestPickOnePerGame` (7 tests: empty input, single candidate, cap, determinism, other-games-independence, first-appearance order, not-earliest-ply)
- `tests/repositories/test_train_repository.py` - 4 new DB-backed composition tests (blunder-heavy game / multiple due items / due+pool collision / cap-shortened cross-backfill); `_seed_flaw_game` extended with `existing_game_id`
- `CHANGELOG.md` - one bullet under `[Unreleased] > Changed`

## Decisions Made

- Cap the fresh pool via a pure, seeded, uniform-random helper rather than earliest-ply, per the plan's measured phase-skew evidence (earliest-ply doubles the opening share and cuts the endgame share to a third).
- Applied the session-wide cap in Python (not SQL) because it must span two independently-queried sources (due `drill_items` and fresh `pool_entry_stmt`); over-fetch due rows by a bounded 8x factor rather than an unbounded scan.
- Did not extract a shared helper for the three-line per-game guard duplicated across the due loop, `sr_needed` loop, and herring-shortfall loop — the plan's `<scope_lock>` explicitly calls for the duplication over introducing a new abstraction inside `compose_and_materialize_session`.

## Deviations from Plan

None — plan executed exactly as written. No Rule 1-4 auto-fixes were needed; the implementation matched the plan's specified constants, helper signature, and wiring points on the first pass.

## Reversion Proof (mandatory, per `feedback_mutation_test_gap_closures`)

Per the plan's `<verify>` instruction, temporarily reverted the cap mechanism (removed the `per_game_counts` guards from the due loop, the `sr_needed` padding loop, and the herring-shortfall loop; reverted `sr_pool = pick_one_per_game(...)` to `sr_pool = deduped_pool`) and re-ran the three gate tests. All three failed as expected, with the actual observed output:

- **Test (a)** `test_multiple_due_items_same_game_serves_only_one`: `assert len(sr_solves) == 1` failed with **`assert 3 == 1`** — all three due items from the one game were served instead of one.
- **Test (b)** `test_blunder_heavy_game_contributes_exactly_one_pool_pick`: `assert len(tracked_items) == 1` failed with **`assert 5 == 1`** — five new `drill_items` rows were created for the blunder-heavy game instead of one.
- **Test (d)** `test_due_and_untracked_pool_same_game_never_both_appear`: `assert len(sr_solves) == 1` failed with **`assert 2 == 1`** — both the due item and the untracked pool candidate from the same game were served.

All edits were then restored exactly (verified via `grep -n "TEMP REVERSION" app/repositories/train_repository.py` returning no matches), and all four DB-backed cap tests plus the full `tests/repositories/test_train_repository.py` + `tests/routers/test_train.py` suite (154 tests) re-confirmed green, followed by the full backend suite (`uv run pytest -n auto -x`, 3916 passed / 18 skipped) and `uv run ty check app/ tests/` (zero errors).

## Issues Encountered

None.

## Follow-up Note (not done here, per scope_lock)

`compose_and_materialize_session` already breaches CLAUDE.md's logic-LOC limit (soft 100 / hard 200) before this task, and this task's changes (the `per_game_counts` Counter + three guard sites + docstring additions) grow it further. Per the plan's explicit instruction and CLAUDE.md's `/gsd-quick` guidance ("prefer a follow-up note over an unscoped refactor"), this was **not** refactored here. A future scoped phase/plan should split this function along its natural seams (e.g. `_compose_due_candidates`, `_compose_pool_candidates`, `_compose_herring_candidates`, `_cross_backfill`) — each already has a clear single responsibility and its own comment block in the current source.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Train session composition now enforces a 1-puzzle-per-game session-wide cap. No blockers. The follow-up refactor note above is the only carried-forward item; it does not block any other work.

---
*Phase: quick-260728-pgp*
*Completed: 2026-07-28*

## Self-Check: PASSED

All modified files verified present on disk; all 4 task commit hashes (0485b5cc, eff2c3dd, e3930dc0, 467500ba) verified present in git log.
