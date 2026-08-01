---
phase: 195-depth-scaled-grading-ladder
plan: 03
subsystem: engine
tags: [typescript, vitest, stockfish, worker-pool, cache, mutation-testing]

requires:
  - phase: 195-01
    provides: "WorkerPool.grade's optional 4th gradingDepth param (defaulting to GRADING_ROOT_DEPTH), plumbed through QueuedGradeRequest.gradingDepth into buildGradeGoCommand — this plan's rekey reads that same resolved depth"
provides:
  - "workerPool.ts's grade cache rekeyed from fen-only to the composite (fen, gradingDepth), via one private cacheKey(fen, gradingDepth) helper that is the ONLY place a cache key is built"
  - "A depth-14 cached grade never satisfies a depth-10 request and vice versa, proven in both visit orders by go-message count, closing the LADDER-03/ENGINE-07 transposition-order determinism hole before Plan 05's rungs stop being flat"
  - "Both Phase 194 WR-01 LRU touch sites (read-hit in grade(), write-side in cacheGrades) re-verified under the composite key, each pinned by a dedicated regression test that fails when its delete-then-reinsert is removed"
affects: [195-04, 195-05, 195-06, 196-analysis-board-stockfish-root-injection, 198-mcts-continuous-dispatch]

tech-stack:
  added: []
  patterns:
    - "Composite string-template cache key (`${fen}|${gradingDepth}`) built through exactly one private helper function, mirroring maiaPolicyCache.ts's existing fen|elo composite-key idiom — every read/delete/write site routes through the same helper so the key space cannot silently split"

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts

key-decisions:
  - "Followed the maiaPolicyCache.ts fen|elo idiom exactly (private cacheKey() helper, pipe-joined template string) rather than a nested Map keyed by fen then depth — keeps the flat single-Map LRU eviction mechanism (GRADE_CACHE_MAX, cache.keys().next().value) completely unchanged, per the plan's explicit prohibition on introducing a nested structure"
  - "Wrote both new LRU regression tests (Task 2) as direct-await-on-hit assertions (no roundTrip fed) matching the established convention in the pre-existing CACHE-01/02 tests, even though this means a broken touch manifests as the test's own 15s timeout rather than a clean assertion failure — verified this is still a legitimate, deterministic failure signal by actually removing each pinned line and observing the timeout"

requirements-completed: [LADDER-03]

coverage:
  - id: D1
    description: "All four cache sites (cacheGrades' get/delete/set, grade()'s read gate, and the read-hit LRU touch) route through one private cacheKey(fen, gradingDepth) helper; no bare-FEN key expression remains"
    requirement: LADDER-03
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts — full grade-cache describe block (65 tests)"
        status: pass
      - kind: other
        ref: "grep -cE 'cache\\.(get|set|delete)\\(' workerPool.ts == 7; grep -c '${fen}|' workerPool.ts == 1; grep -c 'cacheGrades(' workerPool.ts == 2"
        status: pass
    human_judgment: false
  - id: D2
    description: "A depth-14 cached grade never satisfies a depth-10 request and vice versa, asserted in both visit orders by go-message count; mutation-verified by reverting the key helper to a bare FEN and observing both cross-satisfaction tests fail with a hit where a miss was expected"
    requirement: LADDER-03
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a depth-14 cached grade never satisfies a depth-10 request... — depth-14-first (LADDER-03)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#a depth-10 cached grade never satisfies a depth-14 request... — depth-10-first (LADDER-03)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both Phase 194 WR-01 LRU touch sites (read-hit and cacheGrades write) survive the rekey, each pinned by a dedicated regression test verified by actually deleting the line, observing the failure (a 15s timeout — the established convention for a broken cache-hit assumption in this file), and restoring it; a third test documents that two depths of the same FEN are independent eviction slots"
    requirement: LADDER-03
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#LRU regression (Task 2, read-side)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#LRU regression (Task 2, write-side)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts#two entries for the SAME FEN at two different grading depths are independent cache slots"
        status: pass
    human_judgment: false
  - id: D4
    description: "CACHE-03 merge semantics, CACHE-04 all-or-nothing reads, GRADE_CACHE_MAX (1024), and the flat single-Map eviction mechanism are unchanged in substance, now scoped within one (fen, depth) entry"
    requirement: LADDER-03
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts — pre-existing CACHE-01..04 tests, unmodified, still pass (62/65 total before Task 2's additions)"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-07-30
status: complete
---

# Phase 195 Plan 03: Rekey the grade cache to composite (fen, depth) Summary

**The Stockfish grade cache moved from `fen`-only keying to the composite `(fen, gradingDepth)`, through one private helper that is the sole place a cache key is built, so a transposed position can no longer be graded at one ladder rung and silently served at another — proven in both visit orders and with both Phase 194 LRU touch sites re-pinned under the new key.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-07-30T20:26:xx+02:00
- **Completed:** 2026-07-30T20:38:23+02:00
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- New private `cacheKey(fen, gradingDepth)` helper in `createWorkerPool`'s closure — the ONLY place a cache-key string is composed, mirroring `maiaPolicyCache.ts`'s existing `fen|elo` idiom
- `cacheGrades` now takes the resolved depth as an explicit parameter and routes its `get`/`delete`/`set` trio through the helper; still called from exactly one site (`handleLine`'s `bestmove` branch), now with a comment recording that abort/stopAll/terminate/onerror settle without writing
- `grade()`'s read gate and both halves of the read-hit LRU touch build the composite key once and reuse it, keeping CACHE-04's all-or-nothing semantics and the WR-01 write-being-a-use reasoning intact (reworded from "FEN" to "entry")
- 5 new LADDER-03 tests proving cross-depth non-satisfaction in both visit orders (depth-14-then-10 and depth-10-then-14), same-FEN-same-depth independence, the all-or-nothing gate at an explicit depth, and that an aborted grade writes nothing to the cache
- 3 new Task 2 regression tests pinning both Phase 194 LRU touch sites under the composite key (read-side, write-side) plus a same-FEN-two-depths independent-eviction-slots case
- Every new assertion was mutation-verified: the key helper reverted to a bare FEN, and each of the two `cache.delete(key)` lines individually removed, each time observing the expected test failure before restoring the code

## Task Commits

Each task was committed atomically:

1. **Task 1: Rekey the grade cache to (fen, depth) at all four sites** - `56aefd25` (feat)
2. **Task 2: Prove the Phase 194 LRU fix survives the rekey** - `76c272df` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `frontend/src/lib/engine/workerPool.ts` - New `cacheKey()` helper; `cacheGrades` signature gains a `gradingDepth` param; `grade()`'s read gate and read-hit LRU touch build and reuse the composite key once
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` - 8 new tests in the "grade cache" describe block (5 LADDER-03 cross-satisfaction/gate/abort cases, 3 Task 2 LRU-touch regressions), plus a one-line comment fix removing a now-stale "cache is keyed by fen only" note in the gradingDepth-plumbing describe block

## Decisions Made
- Followed `maiaPolicyCache.ts`'s existing `fen|elo` composite-key convention exactly rather than inventing a new shape, keeping the flat single-`Map` LRU eviction mechanism (`GRADE_CACHE_MAX`, `cache.keys().next().value`) completely untouched, per the plan's explicit prohibition on a nested structure.
- The two Task 2 LRU regression tests assert survival by directly `await`-ing a `pool.grade()` call expected to be a cache hit, without feeding the mock worker a response — the same convention the pre-existing CACHE-01/02 tests already use. A broken touch therefore manifests as the test's own 15s per-test timeout (an unresolved promise, since the mutated code path makes it a miss the test never answers) rather than a clean synchronous assertion failure. Verified this is still a deterministic, reproducible failure signal by actually removing each pinned `cache.delete(key)` line and observing the timeout twice (once per site), then restoring the code.

## Deviations from Plan

None - plan executed exactly as written. The one incidental edit outside the plan's literal four cache sites was a one-line comment fix in the pre-existing "gradingDepth parameter plumbing" describe block (`workerPool.test.ts`), which asserted "cache is keyed by fen only in this plan — the (fen,depth) composite key lands in Plan 03" — now stale since this plan is Plan 03. Reworded to reference the new "grade cache" describe block instead of asserting the removed fen-only behavior. This is a comment-only correction with no logic or assertion change, kept in Task 1's commit alongside the rest of the rekey.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The grade cache is now correctly composite-keyed, so Plan 05's widened A/B run (which will make `GRADING_DEPTH_LADDER` a real multi-rung table instead of the provisional flat `[14]`) cannot silently reintroduce a transposition-order-dependent grading bug — the exact hole this plan exists to close before it could ever be exercised in practice.
- Both Phase 194 LRU touch sites are independently pinned under the new key, so a future edit to either `grade()`'s read-hit branch or `cacheGrades`'s write path that drops the `delete`-then-`reinsert` touch will be caught immediately rather than silently reverting the cache to FIFO.
- No blockers for Plan 04/05/06. `GRADE_CACHE_MAX` (1024) was deliberately left untouched — a depth-keyed entry-count retune is explicitly a measurement question for a later phase, not this one.

---
*Phase: 195-depth-scaled-grading-ladder*
*Completed: 2026-07-30*

## Self-Check: PASSED

All modified files verified present on disk (`frontend/src/lib/engine/workerPool.ts`,
`frontend/src/lib/engine/__tests__/workerPool.test.ts`); both task commit hashes
(`56aefd25`, `76c272df`) verified present in `git log --oneline --all`.
