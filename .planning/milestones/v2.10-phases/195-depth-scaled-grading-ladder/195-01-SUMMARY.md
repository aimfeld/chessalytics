---
phase: 195-depth-scaled-grading-ladder
plan: 01
subsystem: engine
tags: [typescript, vitest, stockfish, mcts, worker-pool, sentry]

requires:
  - phase: 194-engine-main-thread-cache-hygiene
    provides: the AbortSignal-threaded WorkerPool.grade (Phase 194 ABORT-01/02) whose 3rd optional param this plan mirrors for the 4th
provides:
  - "gradingLadder.ts: GRADING_DEPTH_LADDER/GRADING_DEPTH_FLOOR/GRADING_ROOT_DEPTH/gradingDepthForTreeDepth/buildGradeGoCommand — a pure, zero-import leaf module importable by both the search core and any concrete provider or .mjs harness"
  - "WorkerPool.grade's optional 4th gradingDepth param, defaulting to GRADING_ROOT_DEPTH, plumbed through QueuedGradeRequest.gradingDepth into the single buildGradeGoCommand-composed go line"
  - "mctsSearch.dispatchExpansion resolving gradingDepthForTreeDepth(leaf.depth) and passing it on every grade() call"
  - "A host-side D-06 watchdog (GRADING_WATCHDOG_TIMEOUT_MS = 60s) replacing the removed GRADING_MOVETIME_SAFETY_CAP_MS wall-clock bound, settling a hung worker's request empty and reporting once to Sentry"
affects: [195-02, 195-03, 195-04, 195-05, 195-06, 196-analysis-board-stockfish-root-injection, 198-mcts-continuous-dispatch]

tech-stack:
  added: []
  patterns:
    - "Local, non-exported call-site type cast (GradeWithLadderDepth in mctsSearch.ts) to pass an extra argument through a frozen narrower interface without widening the shared contract file"
    - "Additive optional-parameter extension of a frozen provider interface (4th gradingDepth param, mirroring Phase 194's 3rd signal param)"
    - "Pure zero-import leaf module shared by the provider-agnostic core and a concrete provider (gradingLadder.ts)"

key-files:
  created:
    - frontend/src/lib/engine/gradingLadder.ts
    - frontend/src/lib/engine/__tests__/gradingLadder.test.ts
  modified:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/mctsSearch.ts
    - frontend/src/lib/engine/fallbackExpectimax.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/lib/engine/__tests__/mctsSearch.test.ts

key-decisions:
  - "Shipped the ladder provisionally flat ([14], floor 14) per LADDER-01 — this plan changes delivered grading depth by exactly zero; Plan 05's widened A/B run picks the real rungs as a one-line edit"
  - "Did not widen frozen EngineProviders.grade (types.ts byte-unchanged); dispatchExpansion instead casts providers.grade through a local, non-exported GradeWithLadderDepth type at its one call site, since TypeScript's static arity check on the 3-param interface rejects a literal 4-arg call even though a 4-optional-param implementation is structurally assignable"
  - "Reused the existing 'dead' slot lifecycle state for a watchdog fire (mirrors onerror) rather than inventing a new 'suspect' state, since a 60s grading go with no bestmove is not recoverable within this pool instance"
  - "(fen, depth) composite cache key intentionally NOT implemented here — deferred to Plan 03 per the plan's own assumption_delta_decision; this plan's cache stays fen-only-keyed"

patterns-established:
  - "gradingLadder.ts: zero-import pure leaf module pattern for values shared between mctsSearch.ts (core) and workerPool.ts (provider) without creating a core-to-provider dependency"
  - "clearSlotWatchdog(slot) single shared helper called from every one of the 5 sites that take a PoolWorkerSlot out of the thinking state, so they cannot drift apart (mirrors the LRU delete-then-reinsert pattern's 'both touch sites' discipline from Phase 194)"

requirements-completed: [LADDER-02, LADDER-04]

coverage:
  - id: D1
    description: "gradingLadder.ts pure module: depth-indexed lookup with floor fallback, buildGradeGoCommand depth-only with searchmoves last"
    requirement: LADDER-02
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/gradingLadder.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "End-to-end tracer: a real mctsSearch root expansion over a real createWorkerPool emits a go command at GRADING_ROOT_DEPTH with no wall-clock bound"
    requirement: LADDER-02
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#createWorkerPool + mctsSearch: a tree node is graded at its ladder rung (LADDER-02 end-to-end)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every providers.grade() call in dispatchExpansion carries a resolved (never undefined) grading-depth 4th argument; the omitted-argument default is GRADING_ROOT_DEPTH; no emitted go line carries a movetime token"
    requirement: LADDER-04
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/mctsSearch.test.ts#LADDER-02: every providers.grade() call receives a resolved grading-depth 4th argument, never undefined"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#createWorkerPool: gradingDepth parameter plumbing (LADDER-02/04)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Host-side D-06 watchdog: settles empty (not partial info grades) on timeout, posts stop, marks the slot dead, reports one static Sentry capture, drains pending requests once every slot has died this way, and is disarmed by a normal bestmove/abort/stopAll/terminate"
    requirement: LADDER-04
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#createWorkerPool: watchdog (D-06)"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-07-30
status: complete
---

# Phase 195 Plan 01: Depth-scaled grading ladder plumbing (tracer) Summary

**Depth-scaled Stockfish grading ladder plumbed end-to-end (pure `gradingLadder.ts`, `WorkerPool.grade`'s 4th `gradingDepth` param, `mctsSearch.dispatchExpansion`'s per-node rung resolution, and a D-06 host-side watchdog replacing the removed movetime cap) with the ladder itself shipped provisionally flat at 14, so delivered grading depth is unchanged from pre-phase.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-07-30T20:02:31+02:00
- **Completed:** 2026-07-30T20:11:20+02:00
- **Tasks:** 3
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments
- New `frontend/src/lib/engine/gradingLadder.ts`: a zero-import pure leaf module exporting `GRADING_DEPTH_LADDER` (provisional `[14]`), `GRADING_DEPTH_FLOOR` (`14`), `GRADING_ROOT_DEPTH`, `gradingDepthForTreeDepth`, and `buildGradeGoCommand` — importable by both `mctsSearch.ts` (core) and `workerPool.ts` (provider) with neither importing the other
- `WorkerPool.grade` gains an optional 4th `gradingDepth` param (mirroring Phase 194's `signal` precedent), defaulting to `GRADING_ROOT_DEPTH`; `QueuedGradeRequest` gets a distinctly-named `gradingDepth` field (never conflated with the dispatch-priority `depth` tie-break); `sendGo` composes its `go` line exclusively through `buildGradeGoCommand`
- `mctsSearch.dispatchExpansion` resolves `gradingDepthForTreeDepth(leaf.depth)` and passes it as `grade()`'s 4th argument on every call, via a local (non-exported) type cast that keeps `types.ts`'s frozen 3-param `EngineProviders.grade` interface byte-unchanged
- Removed `GRADING_TARGET_DEPTH` and `GRADING_MOVETIME_SAFETY_CAP_MS` from `workerPool.ts` (only — the identically-named gem-sweep constants in `useStockfishGradingEngine.ts`/`useGemSweep.ts` are untouched)
- New host-side D-06 watchdog (`GRADING_WATCHDOG_TIMEOUT_MS = 60_000`): a hung worker's grading request settles with a fresh empty `Map` (never the partially-accumulated `info` grades), posts `stop`, marks the slot permanently dead (mirroring `onerror`), reports exactly one static-message `Sentry.captureException` tagged `stockfish-worker-pool`, and drains any still-pending requests once every slot has died this way
- 93 new/changed test assertions across `gradingLadder.test.ts` (new), `workerPool.test.ts`, and `mctsSearch.test.ts`, including a real end-to-end tracer test driving an actual `mctsSearch()` call over an actual `createWorkerPool()`

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "a tree node is graded at its ladder rung" — one path only** - `81713a5f` (feat)
2. **Task 2: Expand rung coverage from the one tracer path to every grade call site** - `670c4a7a` (test)
3. **Task 3: Host-side watchdog replaces the removed wall-clock cap (D-06)** - `f77a83fd` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `frontend/src/lib/engine/gradingLadder.ts` - New pure leaf module: ladder table, floor, root depth, lookup, and go-command builder
- `frontend/src/lib/engine/__tests__/gradingLadder.test.ts` - New unit tests for the pure module
- `frontend/src/lib/engine/workerPool.ts` - 4th `gradingDepth` param on `grade()`, `QueuedGradeRequest.gradingDepth`, shared `go`-builder, removed old depth/movetime constants, new D-06 watchdog machinery
- `frontend/src/lib/engine/mctsSearch.ts` - `dispatchExpansion` resolves and passes the ladder-rung depth via a local call-site cast
- `frontend/src/lib/engine/fallbackExpectimax.ts` - Comment-only: documents why the ENGINE-06 independent runner intentionally does not resolve a ladder depth
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` - End-to-end tracer test, depth-plumbing assertions, 8 watchdog tests
- `frontend/src/lib/engine/__tests__/mctsSearch.test.ts` - LADDER-02 per-call depth assertion

## Decisions Made
- **Local call-site type cast instead of a hidden interface widening.** The plan and its RESEARCH/PATTERNS docs asserted `types.ts` "does not need editing" because a 4-optional-param concrete function stays structurally *assignable* to the frozen 3-param `EngineProviders.grade`. That claim is true for assignment but not for the *call*: TypeScript's arity check on a variable statically typed as the 3-param interface rejects a literal 4-argument call (`tsc` error: "Expected 2-3 arguments, but got 4"), confirmed empirically before working around it. Resolved by adding a local, non-exported `GradeWithLadderDepth` type in `mctsSearch.ts` and casting `providers.grade as GradeWithLadderDepth` at the one call site in `dispatchExpansion` — `types.ts` stays byte-unchanged (verified via `git diff --stat`) while the 4th argument still reaches any concrete provider that accepts it.
- Kept the ladder provisionally flat at `[14]`/floor `14` exactly as LADDER-01 requires — no interpolated or pilot values shipped.
- Left the `(fen, depth)` composite cache key out of this plan (still `fen`-only), per the plan's own `assumption_delta_decision` deferring that to Plan 03.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Local type cast needed at the `dispatchExpansion` call site to compile a 4-argument `providers.grade()` call**
- **Found during:** Task 1
- **Issue:** `dispatchExpansion`'s `providers` parameter is statically typed `EngineProviders` (3-param `grade`), and calling it with a literal 4th argument fails `tsc` with "Expected 2-3 arguments, but got 4" — a real compile blocker, not a false alarm. The plan's own RESEARCH.md/PATTERNS.md described the call as needing no interface change, which is correct for *assignability* but not for the *call expression* itself.
- **Fix:** Added a local, non-exported `GradeWithLadderDepth` function type in `mctsSearch.ts` and cast `providers.grade as GradeWithLadderDepth` immediately before the call. `types.ts` remains completely unedited (`git diff --stat` empty, matching the plan's explicit prohibition).
- **Files modified:** `frontend/src/lib/engine/mctsSearch.ts`
- **Verification:** `npx tsc -b` exits 0; `git diff --stat frontend/src/lib/engine/types.ts` empty; reverting the 4th argument (tested manually, then restored) makes the new LADDER-02 test fail with an `undefined` value as required.
- **Committed in:** `81713a5f` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking/Rule 3)
**Impact on plan:** Necessary to satisfy the plan's own `npx tsc -b exits 0` acceptance criterion while honoring its explicit prohibition on editing `types.ts`. No scope creep — the cast is local to the one call site and not exported.

## Issues Encountered
- Minor, non-blocking: one plan acceptance-criteria grep (`grep -c 'depth: 0' workerPool.ts` "still returns 1") assumed the string `depth: 0` appears only at the `QueuedGradeRequest` construction site. In the actual file it also appears inside two pre-existing prose comments (the module header and the priority-queue banner) that were already there before this plan and were not touched, so the grep returns 3. The code invariant itself — the `depth` tie-break field is still constructed as literal `0`, unchanged — holds; only the specific grep count in that one acceptance-criteria line doesn't match, and it is not part of the plan's scripted `<verify>` block.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The ladder plumbing (`gradingLadder.ts`, the 4th `grade()` param, `dispatchExpansion`'s per-node resolution, and the D-06 watchdog) is in place and fully wired end-to-end, with zero change to delivered grading depth or behavior — a clean foundation for Plan 03's `(fen, depth)` cache-key work and Plan 05's real-rung A/B run.
- No blockers. `useBotGame.ts`'s resign/draw-offer one-off and `fallbackExpectimax.ts` both continue to inherit `GRADING_ROOT_DEPTH` unchanged, verified via passing tests and an unchanged call-site diff.

---
*Phase: 195-depth-scaled-grading-ladder*
*Completed: 2026-07-30*

## Self-Check: PASSED

All created files verified present on disk; all three task commit hashes (`81713a5f`, `670c4a7a`, `f77a83fd`) verified present in `git log --oneline --all`.
