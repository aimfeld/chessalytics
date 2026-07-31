---
phase: 192-red-herring-position-pool
plan: 05
subsystem: ui
tags: [react, typescript, tanstack-query, train, herring-pool, reveal]

# Dependency graph
requires:
  - phase: 192-02
    provides: "TrainPuzzle.game_id / PuzzleRevealResponse.game_id widened to int | None server-side; reveal_for_puzzle's D-06 owner-scoped GamePosition lookup so a cross-user herring's in-game move resolves"
  - phase: 192-04
    provides: "herring_stmt's real query-time gate and its rewritten (pre-verified-clean) docstring — nothing this plan reads or amends further"
provides:
  - "frontend/src/types/train.ts: TrainPuzzle.game_id and PuzzleRevealResponse.game_id widened to number | null, mirroring the backend contract"
  - "TrainReveal's game footer (and its error branch) gated on puzzle_type !== 'herring' (D-07) — a herring never shows a 'vs <opponent>' line with no referent, and never renders a spurious game-load error for a useLibraryGame query that never fired"
  - "TrainSolveScreen's Analyze deep-link hidden (not disabled) when game_id is null (D-09) — Solution and Next render unconditionally"
  - "POOL-03 amended in place (sourcing clause + Traceability row now name the precomputed pool and Phase 192); POOL-09's Traceability row extended to Phase 192; PROJECT.md's feature bullet and ROADMAP's Phase 189 success criterion #2 no longer describe the superseded game_best_moves sourcing anywhere in the three planning artifacts"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Gate BOTH the success and error branches of a query-conditional UI block on the same discriminator (puzzle_type !== 'herring'), not just the success branch — otherwise a query that intentionally never fires (game_id === null) or is simply irrelevant to the puzzle type can still surface a spurious error state"
    - "Wait for a TanStack Query's real settled state via queryClient.getQueryState(key)?.status in a component test, rather than a DOM testid, when the assertion is specifically about a query having resolved/rejected before checking an ABSENCE (a null/negative assertion checked too early passes trivially)"

key-files:
  created: []
  modified:
    - frontend/src/types/train.ts
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - .planning/REQUIREMENTS.md
    - .planning/PROJECT.md
    - .planning/ROADMAP.md

key-decisions:
  - "D-07's gate wraps BOTH the gameQuery.isError branch and the game !== null branch in one `verdict.puzzle_type !== 'herring'` conditional, rather than adding a second independent condition to each — a null-linked or otherwise-irrelevant herring's query is disabled at the source (useLibraryGame(null)), but the error branch still needed the same gate for defense in depth against a herring with a non-null game_id whose game row genuinely fails to load (D-08 keeps the in-game move regardless of the game row's fetchability)"
  - "The acceptance criterion's grep for the literal phrase \"non-gem `game_best_moves`\" is scoped to the WHOLE of REQUIREMENTS.md/PROJECT.md/ROADMAP.md, not just the plan's named line numbers — so beyond POOL-03 (line 13), PROJECT.md line 28, and ROADMAP's Phase 189 SC2 (all named in the plan), two more historical-narrative occurrences (PROJECT.md's Phase 189 completion log and the milestone-open footer) and one occurrence in Phase 192's own ROADMAP entry also needed rewording to avoid the exact flagged phrase, while preserving the historical record (each reworded mention still names `game_best_moves` plainly and adds a 'superseded by Phase 192' note rather than erasing what actually happened)"
  - "herring_stmt's docstring (app/services/train_pool.py) was verified, not touched — Plan 04 already rewrote it to state the amended POOL-03 contract with no trace of the superseded tier/gap reasoning; no Plan 04 defect found, so this plan makes no code change to that file (grep -c \"game_best_moves\" app/services/train_pool.py stayed 0 throughout)"

requirements-completed: [POOL-03]

coverage:
  - id: D1
    description: "TrainPuzzle.game_id / PuzzleRevealResponse.game_id widened to number | null in the frontend types, verified with a full TypeScript build (not just lint/tests, which do not type-check)"
    requirement: "POOL-03"
    verification:
      - kind: other
        ref: "cd frontend && npx tsc -b"
        status: pass
    human_judgment: false
  - id: D2
    description: "A herring reveal renders no game footer and no spurious train-gamecard-error even when the (now-gated) game query would have errored; an SR reveal's footer is unaffected (positive control)"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#renders no game footer for a herring reveal"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#renders no game-load error for a herring reveal"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#still renders the game footer for an SR reveal (positive control)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The Analyze deep-link is hidden (not disabled) in TrainSolveScreen when puzzle.game_id is null; Solution and Next still render; a non-null game_id renders Analyze unchanged (positive control)"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#hides the Analyze link when the source game link is null, but Solution and Next still render"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#renders the Analyze link when the source game is present"
        status: pass
    human_judgment: false
  - id: D4
    description: "POOL-03 amended in place (no new requirement ID) naming the precomputed pool sourcing; its and POOL-09's Traceability rows extended to Phase 192; PROJECT.md and ROADMAP's Phase 189 success criterion #2 no longer describe the superseded game_best_moves sourcing; herring_stmt's docstring verified clean"
    requirement: "POOL-03"
    verification:
      - kind: other
        ref: "grep -rn \"non-gem \\`game_best_moves\\`\" .planning/REQUIREMENTS.md .planning/PROJECT.md .planning/ROADMAP.md (no matches)"
        status: pass
      - kind: other
        ref: "grep -c \"game_best_moves\" app/services/train_pool.py (returns 0)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full pre-merge gate green across both stacks: backend 3878 passed / 18 skipped, ty clean, ruff clean; frontend lint clean + 2781 tests passed, tsc -b clean, knip clean"
    requirement: "POOL-03"
    verification:
      - kind: other
        ref: "uv run pytest -n auto -x; uv run ty check app/ tests/; uv run ruff format --check app/ tests/ scripts/; uv run ruff check app/ tests/ scripts/; ( cd frontend && npm run lint && npm test -- --run && npx tsc -b && npm run knip )"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-07-28
status: complete
---

# Phase 192 Plan 5: Cross-user herring reveal gates + spec amendments Summary

**The Train reveal drops its game info line for herrings and hides the Analyze link when the source game link is null, and POOL-03/POOL-09/PROJECT.md/ROADMAP no longer describe the structurally-broken `game_best_moves` sourcing this phase replaced.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3 (Task 1: type widening + reveal gates, Task 2: component tests, Task 3: spec amendments)
- **Files modified:** 8 (0 created, 8 modified)

## Accomplishments

- **`frontend/src/types/train.ts`**: `TrainPuzzle.game_id` and `PuzzleRevealResponse.game_id` widened to `number | null`, mirroring Plan 02's backend `int | None` contract. Verified with `npx tsc -b` (not just lint/tests, which strip types) — clean, no downstream call-site breakage anywhere in the frontend.
- **`TrainReveal.tsx` D-07 gate**: both the `gameQuery.isError` branch (renders `train-gamecard-error`) and the `game !== null` branch (renders `train-reveal-footer`) now sit behind a single `verdict.puzzle_type !== 'herring'` conditional — a herring never shows a "vs \<opponent\>" line with no referent, and never renders a spurious "Failed to load the game" for a query that (for a null `game_id`, per D-09) never fired, or that's simply irrelevant to a herring reveal regardless of fetch outcome.
- **`TrainSolveScreen.tsx` D-09 gate**: the Analyze `<Button asChild>` block is now wrapped in `puzzle.game_id !== null &&` — removed from the DOM, not disabled, when there's no source game to analyze. Solution and Next render unconditionally; the two remaining buttons' existing `flex-1` classes absorb the freed row width with no special-casing needed. Single action row (no separate desktop/mobile duplicate to update).
- **Component tests**: `TrainReveal.test.tsx` gained two herring-negative tests (no footer, no spurious error) plus an SR positive control that would catch an over-broad gate; `TrainSolveScreen.test.tsx` gained a null-`game_id` negative test (Analyze absent, Solution/Next present) plus a positive control for a present `game_id`. The negative-assertion tests wait on the TanStack Query's real settled state (`client.getQueryState(['library-game', 100])?.status`) rather than a DOM testid, so the absence assertion can't pass trivially before the query has resolved.
- **Spec amendments**: POOL-03 (`REQUIREMENTS.md` line 13) rewritten in place — same `[x]` marker, same unchanged non-sourcing clauses, sourcing clause now names the precomputed/MultiPV-5/phase-balanced pool with a parenthetical noting the Phase 192 amendment. POOL-03's and POOL-09's Traceability rows both extended to `Phase 189, Phase 192`. `PROJECT.md`'s "Pool + scheduler backend" bullet and ROADMAP's Phase 189 success criterion #2 rewritten to name the pool instead of `game_best_moves`, each with an inline note that Phase 192 superseded the original sourcing. Two further historical-narrative mentions in `PROJECT.md` (the Phase 189 completion log and the milestone-open footer) and Phase 192's own ROADMAP "Requirements" line also needed rewording to clear the acceptance criterion's whole-file grep for the exact flagged phrase — reworded to keep the historical record intact (still naming `game_best_moves` plainly) while adding a "superseded by Phase 192" note rather than erasing what was actually built.
- **`herring_stmt`'s docstring** (`app/services/train_pool.py`, owned by Plan 04): verified, not modified — it already states the amended POOL-03 contract with no trace of the superseded tier/gap reasoning. No Plan 04 defect found.
- Ran the full pre-merge gate: backend 3878 passed / 18 skipped (two unrelated parallel-run flakes — `test_migration_186_user_import_settings` and `test_migration_117` — each passed on immediate rerun and are not caused by this plan's doc-only Task 3 changes), `ruff format --check`/`ruff check`/`ty check` all clean; frontend lint clean, 2781 tests passed, `tsc -b` clean, `knip` clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Widen the frontend types and gate the reveal's game surfaces (D-07, D-08, D-09)** — `3a418250` (feat)
2. **Task 2: Component tests for the two reveal gates** — `8555c4b6` (test)
3. **Task 3: Amend the four artifacts that still describe the superseded sourcing** — `0a75d034` (docs)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `frontend/src/types/train.ts` — `TrainPuzzle.game_id` / `PuzzleRevealResponse.game_id` widened to `number | null`, with docstring notes on the D-05/D-09 nullability rationale
- `frontend/src/components/train/TrainReveal.tsx` — D-07 game-footer gate (both success and error branches) behind `puzzle_type !== 'herring'`
- `frontend/src/components/train/TrainSolveScreen.tsx` — D-09 Analyze-visibility gate behind `puzzle.game_id !== null`
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` — three new tests (herring no-footer, herring no-error, SR positive control)
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — two new tests (null-`game_id` Analyze-hidden, positive control)
- `.planning/REQUIREMENTS.md` — POOL-03 sourcing clause amended in place; POOL-03 and POOL-09 Traceability rows extended to Phase 192
- `.planning/PROJECT.md` — "Pool + scheduler backend" bullet, Phase 189 completion log, and milestone-open footer reworded off `game_best_moves`
- `.planning/ROADMAP.md` — Phase 189 success criterion #2 and Phase 192's own "Requirements" line reworded off `game_best_moves`

## Decisions Made

- **Single shared gate for both footer branches** (D-07): rather than adding `puzzle_type !== 'herring'` independently to the error branch and the success branch, both sit inside one wrapping conditional — simpler to read, and structurally guarantees the two branches can never drift out of sync on the discriminator.
- **Reworded (not deleted) the extra historical mentions** of `game_best_moves` in `PROJECT.md`/`ROADMAP.md` beyond the plan's four named targets — the acceptance criterion's grep is scoped to the whole file, and erasing historically-true narrative would be worse than adding a two-clause "superseded by Phase 192" note that keeps both the history and the correction visible.
- **No change to `herring_stmt`'s docstring** — verified clean per the plan's explicit instruction not to patch a file this plan doesn't own; no defect to report.

## Deviations from Plan

None — plan executed exactly as written. The additional two `PROJECT.md` historical-narrative rewordings and the one extra `ROADMAP.md` "Requirements" line rewording were required by the plan's own acceptance criterion (a whole-file grep for the exact flagged phrase across all three artifacts), not a deviation from the plan's intent — the plan's `must_haves.truths` entry already states the goal as "no artifact remains that would let a later audit mark the superseded definition green," and the strict acceptance criterion is how that goal is checked.

## Issues Encountered

- **Two unrelated parallel-run test flakes**: `tests/test_migration_186_user_import_settings.py::test_grandfathers_existing_user_to_all_tcs_and_cap_5000` (during Task 2's backend run) and `tests/test_migration_117.py::test_downgrade_removes_all_migration_artifacts` (during Task 3's backend run) each failed once under `-n auto` and passed immediately on rerun (and in isolation). Neither test touches Train/herring code, and this plan makes no backend code changes — consistent with this project's documented `project_serial_ci_caplog_alembic`/isolation-flake pattern for migration tests under parallel execution, not a regression introduced here.

## User Setup Required

None — no external service configuration required. No backend migrations, no environment variables, no dashboard configuration. Frontend-only code changes plus planning-doc amendments.

## Next Phase Readiness

- This is the final plan in Phase 192. All five plans (schema/table + `herring_stmt` rewrite in 01, `drill_solves.game_id` nullability + D-06 reveal widening in 02, generator constant-pinning in 03, the query-time qualifying gate in 04, and this plan's frontend reveal gates + spec amendments in 05) are complete and green.
- ROADMAP SC5 ("A red herring drawn from another user's game reveals with its in-game move and board arrow ... and with no game info line; the herring source no longer reads `game_best_moves` anywhere, and POOL-03 / Phase 189 criterion #2 / `PROJECT.md` / `herring_stmt`'s docstring no longer describe the superseded sourcing") is fully satisfied by this plan.
- No outstanding debt handed to a later plan. `scripts/gen_red_herring_pool.py` (Plan 01/03) still needs to be run against dev/prod per D-13/D-14's one-shot-with-manual-top-up rollout plan — that is an operational step (D-11: run locally over `bin/prod_db_tunnel.sh`), not further code work, and out of this plan's scope.

## Self-Check: PASSED

- `FOUND: frontend/src/types/train.ts` (modified)
- `FOUND: frontend/src/components/train/TrainReveal.tsx` (modified)
- `FOUND: frontend/src/components/train/TrainSolveScreen.tsx` (modified)
- `FOUND: frontend/src/components/train/__tests__/TrainReveal.test.tsx` (modified)
- `FOUND: frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` (modified)
- `FOUND: .planning/REQUIREMENTS.md` (modified)
- `FOUND: .planning/PROJECT.md` (modified)
- `FOUND: .planning/ROADMAP.md` (modified)
- `FOUND: 3a418250` (git log)
- `FOUND: 8555c4b6` (git log)
- `FOUND: 0a75d034` (git log)

---
*Phase: 192-red-herring-position-pool*
*Completed: 2026-07-28*
