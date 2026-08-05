---
phase: 205-train-grading-oracle-agreement
plan: 01
subsystem: frontend
tags: [react, typescript, stockfish, train, chess]

# Dependency graph
requires:
  - phase: 200-train-solve-screen
    provides: useTrainFreePlay, the branching free-play move tree, and the deliberate separation of the free-play Worker from the session-scoped grading engine
  - phase: 190.1-train-reveal-line-boxes
    provides: rankLineForMove, the MultiPV mount search, and the 190.1 UAT round 9 rank-match rule this plan generalizes
provides:
  - "rankLineForSquares — a from+to (promotion-tolerant) rank lookup, exported from uciParser.ts alongside the relocated rankLineForMove"
  - "GradeResult.lines — the mount search's own MultiPV ranks, threaded to the free-play board via freePlaySeedEval"
  - "useTrainFreePlay's root-only rank-match branch — the free-play board's ROOT ply is graded from the mount search's own rank line when the played move matches one"
affects: [205-02-dead-band-exclusion]

# Actuals (#2632)
actuals:
  tokens: 9006
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Rank-line lookup by squares (from+to), tolerant of a promotion suffix MoveNode doesn't store, with ties resolved by array order (lower multipv wins) — mirrors the existing isBest .slice(0,4) convention"
    - "A single load-bearing nullish default (?? []) at exactly one seam (freePlaySeedEval) absorbs a D-10 cache-restore gap, kept deliberately un-duplicated so its removal stays mutation-testable"

key-files:
  created: []
  modified:
    - frontend/src/hooks/uciParser.ts
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/hooks/useTrainFreePlay.ts
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/hooks/__tests__/uciParser.test.ts
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/lib/__tests__/trainRevealCache.test.ts

key-decisions:
  - "D-04 (inherited, applied): the root-ply short-circuit fires ONLY on a rank match — an unranked first free-play move keeps today's cross-oracle path (esBefore from the mount search, esAfter from the free-play engine)"
  - "D-10 (inherited, applied): trainRevealCache.ts itself is untouched — no cache-key bump, no deeper nested shape check. A restored pre-Phase-205 entry (no lines key) falls back to today's behavior via the single ?? [] default"
  - "rankLineForMove relocated to uciParser.ts (was module-private in useTrainGradingEngine.ts) rather than exported in place — uciParser.ts already owns PvLine and is documented React-free/Worker-free, avoiding a new hook-to-hook dependency (205-RESEARCH.md A1, accepted)"

patterns-established:
  - "ScriptedFenFakeWorker test fake: branches its scripted Stockfish response on the LAST position it was told to search, letting a test script the free-play engine's own 'oracle' to disagree with the mount search on purpose — the exact shape of SEED-137 case 2"

requirements-completed: [ORACLE-01, ORACLE-02]

coverage:
  - id: D1
    description: "Playing a mount-rank move (an 'Also fine' alternative) as the FIRST free-play move is graded from that rank's own eval, never a fresh (worse) free-play-engine search of the post-move position"
    requirement: ORACLE-01
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#ORACLE-01: playing an \"Also fine\" mount rank as the FIRST free-play move is graded from that rank's own eval, never a fresh (worse) free-play-engine search"
        status: pass
    human_judgment: false
  - id: D2
    description: "A first free-play move NOT among the mount ranks stays on today's cross-oracle path (D-04's accepted residual)"
    requirement: ORACLE-01
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#D-04 residual (deliberate): a FIRST free-play move NOT among the mount ranks still comes from the free-play engine's own (worse) search"
        status: pass
    human_judgment: false
  - id: D3
    description: "A mount-rank move replayed at a DEEPER free-play ply (not the root) is graded from the free-play engine's own parent/child pair, never the stale root rank line"
    requirement: ORACLE-02
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#ORACLE-02: a mount-rank move replayed at ply 3 (not the root) is graded from the free-play engine's own parent/child pair — a scripted bad score still badges it worse"
        status: pass
    human_judgment: false
  - id: D4
    description: "A restored pre-Phase-205 cached reveal (gradeResult with no rank-lines key) falls back to today's free-play-engine grade with no throw (D-10 graceful fallback, both at the shape-check layer and the consumption layer)"
    requirement: ORACLE-01
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainRevealCache.test.ts#D-10: a pre-Phase-205 cache entry whose gradeResult has no rank-lines key still validates and restores"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#D-10: a restored pre-Phase-205 reveal (gradeResult carrying no rank lines) grades its root free-play move from today's free-play-engine path, never throwing"
        status: pass
    human_judgment: false
  - id: D5
    description: "rankLineForSquares edge coverage — empty array, no match, promotion-suffix tolerance, tie resolved by array order/lower multipv — plus rankLineForMove pinned to NOT match on squares alone"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/uciParser.test.ts#rankLineForSquares / rankLineForMove describe blocks"
        status: pass
    human_judgment: false

# Metrics
duration: ~27min
completed: 2026-08-04
status: complete
---

# Phase 205 Plan 01: Root Free-Play Grade From the Mount Search Summary

**The free-play board's root ply now reads its badge from the settled MultiPV-4 mount search's own rank line instead of a fresh independent post-move search, closing SEED-137 case 2 (playing an "Also fine" move badging worse than the reveal claims).**

## Performance

- **Duration:** ~27 min
- **Started:** 2026-08-04T16:31:14Z (per STATE.md's "Phase 205 execution started")
- **Completed:** 2026-08-04T16:58:35Z
- **Tasks:** 3 completed
- **Files modified:** 7

## Accomplishments

- `rankLineForMove` relocated from `useTrainGradingEngine.ts` to `uciParser.ts` (now exported, body unchanged) with a new sibling `rankLineForSquares(lines, from, to)` — a promotion-tolerant, from+to rank lookup whose ties resolve by array order (lower `multipv` wins).
- `GradeResult` gains an optional `lines?: PvLine[]` field — the mount search's own MultiPV ranks, populated on every `gradeMoveInner` return path (empty array on the one defensive path with no settled search in scope).
- `TrainSolveScreen`'s `freePlaySeedEval` threads `lines` through to `useTrainFreePlay` behind the single D-10 nullish-default (`gradeResult.lines ?? []`).
- `useTrainFreePlay`'s `currentQuality` gains a root-only branch (`currentNode.parentId === null`): when the played move matches a seeded mount rank by squares, its eval is used instead of the free-play engine's own search — never below the root.
- Four automated tests added, each mutation-proved by manual revert (details below): ORACLE-01 (root rank match), the D-04 unranked-move residual, D-10's cache-restore fallback (both the shape-check layer and the consumption layer), and ORACLE-02 (the root-only boundary).

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "Also fine" root grade — one path, mount search to badge** - `5767fc955` (feat)
2. **Task 2: D-10 — a reveal restored from an older bundle's cache degrades, never throws** - `b90360be5` (test)
3. **Task 3: Root-only boundary, rank-lookup edges, and the wave gate** - `13a17d11a` (test)

_No TDD tasks in this plan (plain `type="auto"`/`type="tracer"`, not `tdd="true"`) — one commit per task._

## Files Created/Modified

- `frontend/src/hooks/uciParser.ts` - `rankLineForMove` relocated here (exported) beside the new `rankLineForSquares`
- `frontend/src/hooks/useTrainGradingEngine.ts` - `GradeResult.lines?` field, populated on all 5 `gradeMoveInner` return paths; imports `rankLineForMove` instead of defining it
- `frontend/src/hooks/useTrainFreePlay.ts` - `FreePlaySeedEval` interface, `NO_SEED_LINES` frozen constant, `currentQuality`'s root-only rank-match branch
- `frontend/src/components/train/TrainSolveScreen.tsx` - `freePlaySeedEval` extended with the `lines` field behind the single D-10 default
- `frontend/src/hooks/__tests__/uciParser.test.ts` - `rankLineForSquares` + `rankLineForMove` edge coverage
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` - `ScriptedFenFakeWorker`, a `drop-b1c3` mock button, `restoredSolve` pass-through on the test harness, and 4 new tests (ORACLE-01, D-04 residual, D-10 consumption, ORACLE-02)
- `frontend/src/lib/__tests__/trainRevealCache.test.ts` - D-10 shape-check test proving a pre-Phase-205 entry (no `lines` key) still validates

## Decisions Made

- Followed D-04 exactly as locked: only a rank-matched first free-play move short-circuits; an unranked move keeps the cross-oracle path.
- Followed D-10 exactly as locked: `trainRevealCache.ts` itself was not touched (confirmed by an empty `git diff --stat` on that file) — the graceful fallback lives entirely in the consuming code's single nullish default.
- `rankLineForSquares`'s parameter type is `readonly PvLine[]` (not `PvLine[]`) so both a mutable `GradeResult.lines` and the frozen `NO_SEED_LINES` constant satisfy it without a cast.

## Deviations from Plan

None - plan executed exactly as written.

## Mutation Test Results (Mutation Contract rows 4 and 5, plus criterion 2)

All three mutation reverts were performed by hand against the committed code, observed red, then restored and re-confirmed green. None of the mutated states were committed — only the final, correct code is in the git history.

**Row 4 (Task 1, ORACLE-01 root-rank branch):** replaced `currentQuality`'s `rootRank` computation with a hardcoded `null` (disabling the branch). Re-ran the ORACLE-01 test:
```
AssertionError: expected 'oklch(0.58 0.19 25 / 0.35)' to be 'oklch(0.55 0.16 145 / 0.35)'
```
(the blunder highlight instead of the good one) — **FAILED as expected**. Restored the branch; the test passed again.

**Row 5 (Task 2, D-10 nullish default at the `freePlaySeedEval` seam):** replaced `gradeResult.lines ?? []` with an unguarded pass-through (via a type cast, since removing the runtime guard alone still leaves the TS type optional). Re-ran the D-10 consumption test:
```
AssertionError: expected [Function] to not throw an error but 'TypeError: Cannot read properties of …' was thrown
  "TypeError: Cannot read properties of undefined (reading 'find')"
```
**FAILED as expected** (a genuine thrown error, not a soft mis-grade). Restored the default; the test passed again.

**Criterion 2 (Task 3, ORACLE-02 root-only gate):** widened the gate from `terminal === null && currentNode.parentId === null` to `terminal === null` (dropping the root-only condition). Re-ran the ORACLE-02 test:
```
Expected: "oklch(0.58 0.19 25 / 0.35)"   (blunder)
Received: "oklch(0.55 0.16 145 / 0.35)"  (good)
```
**FAILED as expected** — the ply-3 move now wrongly reported 'good' by consulting the stale root rank. Restored the gate; the test passed again.

## Scripted Eval Values (`ScriptedFenFakeWorker`)

So a later reader can distinguish a scripted score from a real engine reading:

- **Mount search (at the puzzle FEN):** 4 near-equal ranks, `e2e4` / `d2d4` / `g1f3` / `c2c4`, at `19cp` / `18cp` / `17cp` / `16cp` respectively (white-POV) — differ by 1cp per rank, well within any inaccuracy tolerance.
- **ORACLE-01 test:** the position after white's `d2d4` (rank-2 mount move) scripted to `-900cp` white-POV — catastrophic, far below `BLUNDER_DROP`.
- **D-04 residual test:** the position after white's `b1c3` (Nc3, NOT a mount rank) scripted to `-900cp` white-POV.
- **D-10 consumption test:** the position after white's `d2d4` scripted to `-900cp` white-POV (same shape as ORACLE-01, but consulted via the free-play engine's own search since the restored `gradeResult` carries no `lines`).
- **ORACLE-02 test:** the position after `1.e4 e5 2.d4` (the ROOT search's own rank-2 move, replayed at ply 3) scripted to `-900cp` white-POV; the intervening position after `1.e4 e5` uses the fake's `defaultScoreCp` (`20cp`, i.e. `0.20` pawns), not a scripted value.
- All conversions from the scripted WHITE-POV value to the mover-POV UCI wire format use `moverSign = fen.split(' ')[1] === 'b' ? -1 : 1` — the same inversion `useTrainGradingEngine.ts`'s `dispatchNow` and `useStockfishEngine.ts`'s `analyze` apply in production code.

## Confirmation: No Backend File Touched

`git status --short` across the whole plan shows only frontend files (plus `.planning/STATE.md`, updated by the executor). No file under `app/`, `alembic/`, or `tests/` (backend) appears in this plan's diff — wave 2 owns the backend and has not landed.

## Issues Encountered

- The `ORACLE-02` test's three free-play moves (root, reply, ply-3) initially raced `useStockfishEngine`'s `RAPID_STEP_DEBOUNCE_MS` (150ms) debounce: firing all three `fireEvent.click`s back-to-back with no elapsed wall-clock time let React's effect-cleanup cancel the middle position's pending debounced search outright (its `analyze()` call never fired), leaving `evalByFen` with no entry for the ply-2 parent position and `currentQuality` permanently `null`. Fixed by adding a real 250ms wait (`await new Promise((resolve) => setTimeout(resolve, 250))` inside `act`) between the ply-2 and ply-3 drops — the same pattern already used elsewhere in this repo's test suite (e.g. `TrainStartScreen.test.tsx`) for `*_DEBOUNCE_MS`-gated effects.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Wave 1 (this plan) is complete and merges cleanly: frontend build, lint, knip, and the full 3304-test suite are all green.
- Wave 2 (205-02, the backend dead-band exclusion) is unblocked — D-01 required wave 1 to land first, and it now has.
- `rankLineForSquares` and `GradeResult.lines` are new, stable public surface `useTrainFreePlay.ts` and any future free-play consumer can build on without re-deriving the rank-match logic.

---
*Phase: 205-train-grading-oracle-agreement*
*Completed: 2026-08-04*

## Self-Check: PASSED

All 8 files (7 source/test + this SUMMARY) confirmed present on disk; all 3 task commit hashes (`5767fc955`, `b90360be5`, `13a17d11a`) confirmed in `git log --oneline --all`.
