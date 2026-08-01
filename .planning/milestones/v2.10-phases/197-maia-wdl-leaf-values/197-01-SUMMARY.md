---
phase: 197-maia-wdl-leaf-values
plan: 01
subsystem: infra
tags: [maia, wdl, mcts, expectimax, onnxruntime-web, typescript, vitest]

# Dependency graph
requires:
  - phase: 195-depth-scaled-grading-ladder
    provides: gradingLadder.ts's zero-import GRADING_DEPTH_LADDER/GRADING_DEPTH_FLOOR/gradingDepthForTreeDepth, extended in this plan with the WDL handoff depth
  - phase: 194-engine-main-thread-and-cache-hygiene
    provides: maiaPolicyCache.ts's shared fen|elo LRU cache and maiaQueue.ts's async FIFO policy queue, extended in this plan to co-locate the WDL payload
provides:
  - wdlLeafExpectedScore(wdl, leafSide, rootMover) — mover-POV WDL to root-relative expected score (leafScore.ts)
  - WDL_LEAF_HANDOFF_DEPTH + usesWdlLeaf(depthFromRoot) — the handoff predicate (gradingLadder.ts, zero-import preserved)
  - EngineProviders.wdl?(fen, elo, side) — optional provider member (types.ts)
  - getCachedWdl(fen, elo) + widened setCachedPolicy(fen, elo, policy, wdl?) — co-located cache entry (maiaPolicyCache.ts)
  - MaiaQueue.wdl(fen, elo, side) — rides policy()'s settlement paths, never a second inference (maiaQueue.ts)
  - value-at-own-expansion handoff wired identically into mctsSearch.ts's dispatchExpansion/applyExpansion AND fallbackExpectimax.ts's expandNode (ENGINE-06 mirror)
  - useMaiaEngine.ts's chart write-through populates both cache payloads for all 21 ladder rungs
affects: [198-mctssearch-continuous-dispatch, 199-bot-recalibration-sweep]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "value-at-own-expansion: a leaf's own WDL becomes its value at expansion time, and every child it creates inherits that same value verbatim (the AlphaZero-shaped value-at-node rule, distinct from the prior per-child 1-ply-lookahead Stockfish valuing)"
    - "co-located cache entry (policy + WDL in ONE fen|elo-keyed map entry) so a policy hit can never be a WDL miss for the same rung"
    - "sibling converter function (wdlLeafExpectedScore) rather than overloading/reusing leafExpectedScore, because the two source domains (WDL vector vs white-POV cp) require genuinely different frame math"

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/leafScore.ts
    - frontend/src/lib/engine/gradingLadder.ts
    - frontend/src/lib/engine/types.ts
    - frontend/src/lib/engine/maiaPolicyCache.ts
    - frontend/src/lib/engine/maiaQueue.ts
    - frontend/src/lib/engine/mctsSearch.ts
    - frontend/src/lib/engine/fallbackExpectimax.ts
    - frontend/src/lib/engine/backup.ts
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/lib/engine/__tests__/leafScore.test.ts
    - frontend/src/lib/engine/__tests__/gradingLadder.test.ts
    - frontend/src/lib/engine/__tests__/mctsSearch.test.ts
    - frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts
    - frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts
    - frontend/src/lib/engine/__tests__/maiaQueue.test.ts

key-decisions:
  - "wdlLeafExpectedScore is a SIBLING function to leafExpectedScore, not an overload or a forced-through-the-same-path reuse — leafExpectedScore bakes a white-POV-cp sign flip into one sigmoid call, and routing a WDL through it would need a lossy fake-cp round trip"
  - "WDL_LEAF_HANDOFF_DEPTH = 3 is the pre-declared first candidate (an INPUT to Plan 02's measurement), not a measured answer — its doc comment says so explicitly and cites the post-ladder baseline it must be argued against"
  - "The WDL cache lives in the SAME entry as the policy cache (co-location), not a separately-evicted sibling cache, so a policy hit can never be a WDL miss for the same (fen, elo)"
  - "MaiaQueue.wdl() rides policy()'s existing settlement paths (await policy(), then one cache re-read) rather than owning a second request/response lifecycle — never a second lease.analyze() call"

requirements-completed: [LEAF-01, LEAF-03, LEAF-05]

# Coverage metadata
coverage:
  - id: D1
    description: "A deep tree node (at or past WDL_LEAF_HANDOFF_DEPTH) is expanded with zero Stockfish grade() calls, valued from its own Maia WDL head, with every child it creates inheriting that same value"
    requirement: "LEAF-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/mctsSearch.test.ts#mctsSearch — Phase 197 LEAF-01/LEAF-03 WDL-leaf end-to-end tracer"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts#fallbackExpectimax — Phase 197 LEAF-01 WDL-leaf handoff (ENGINE-06 mirror)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The root-relative frame conversion (mover-POV WDL to root-relative expected score) is proven mirrored-not-identical by fixture, not assumed"
    requirement: "LEAF-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/leafScore.test.ts#wdlLeafExpectedScore"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both SearchRunner implementations (mctsSearch, fallbackExpectimax) agree on the leaf-value provenance decision for the same input — the ENGINE-06 parity invariant"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/fallbackExpectimax.test.ts#ENGINE-06 PARITY: mctsSearch and fallbackExpectimax pass the IDENTICAL set of FENs to grade()"
        status: pass
    human_judgment: false
  - id: D4
    description: "The policy+WDL cache co-location is structural: eviction removes both payloads together, and a chart-warmed position serves the engine both payloads from one entry"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts#getCachedWdl (Phase 197 LEAF-01 co-located WDL payload)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/maiaQueue.test.ts#createMaiaQueue.wdl (Phase 197 LEAF-01)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A missing/malformed WDL for the exact requested rung falls back to grading that node — no hanging promise, no NaN reaching practicalScore"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/mctsSearch.test.ts#a provider whose wdl resolves null produces byte-identical output to a provider with no wdl member at all"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-07-31
status: complete
---

# Phase 197 Plan 01: Maia WDL Leaf Values Summary

**Wired Maia's already-computed, previously-discarded WDL head as the leaf value for deep search nodes in both `SearchRunner` implementations, replacing per-child Stockfish grade() calls past a measured handoff depth — the "value-at-own-expansion" architecture.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3
- **Files modified:** 15 (9 source, 6 test)

## Accomplishments

- Implemented `wdlLeafExpectedScore` as a sibling to `leafExpectedScore` in `leafScore.ts`, converting Maia's mover-POV WDL into the engine's root-relative frame via `sideMatchesMover`, with the LEAF-03 root-relative invariant proven by a mirrored-not-identical fixture (never assumed).
- Added `WDL_LEAF_HANDOFF_DEPTH` (pre-declared first candidate = 3, an input to Plan 02's measurement, not its answer) and the `usesWdlLeaf` predicate to `gradingLadder.ts`, preserving its zero-import property.
- Extended `EngineProviders` with an optional `wdl?()` member (same ABORT-03 structural-assignability precedent as `grade`'s `signal`), and co-located the WDL vector in the SAME `fen|elo` cache entry as the policy in `maiaPolicyCache.ts` — a policy hit can structurally never be a WDL miss for that rung.
- Wired the handoff branch into `mctsSearch.ts`'s `dispatchExpansion`/`applyExpansion` (Task 1, the tracer) and mirrored it IDENTICALLY into `fallbackExpectimax.ts`'s `expandNode` (Task 2, ENGINE-06), proven by a cross-runner parity test that the two implementations pass the identical set of FENs to `grade()`.
- Closed the cache-economics leak in `useMaiaEngine.ts`'s chart write-through (Task 3) so a chart-warmed position serves the engine both payloads from one cache entry, with `maiaQueue.ts`'s `wdl()` degradation contract (missing rung, cold call, worker death) proven by test.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "a deep node is valued from its own Maia WDL" tracer** - `7a8061ed` (feat)
2. **Task 2: Mirror the identical handoff branch into fallbackExpectimax (ENGINE-06)** - `95bfb8ad` (feat)
3. **Task 3: Close the cache-economics leak — chart write-through carries the WDL** - `490b47a6` (feat)

## Files Created/Modified

- `frontend/src/lib/engine/leafScore.ts` - Added `wdlLeafExpectedScore` sibling converter
- `frontend/src/lib/engine/gradingLadder.ts` - Added `WDL_LEAF_HANDOFF_DEPTH` + `usesWdlLeaf`, zero-import preserved
- `frontend/src/lib/engine/types.ts` - Added optional `EngineProviders.wdl?()` member
- `frontend/src/lib/engine/maiaPolicyCache.ts` - Co-located WDL in the policy cache entry, added `getCachedWdl`, widened `setCachedPolicy`
- `frontend/src/lib/engine/maiaQueue.ts` - `handleResult` write-throughs WDL in the same pass; added `MaiaQueue.wdl()`
- `frontend/src/lib/engine/mctsSearch.ts` - `dispatchExpansion`/`applyExpansion` take the WDL-handoff branch past the handoff depth
- `frontend/src/lib/engine/fallbackExpectimax.ts` - `expandNode` mirrors the identical handoff branch (ENGINE-06)
- `frontend/src/lib/engine/backup.ts` - `BackupChild` doc comment documents the third value provenance
- `frontend/src/hooks/useMaiaEngine.ts` - `buildMaiaResult` hoists the WDL collapse above the policy write-through loop
- Six `__tests__/*.test.ts` files - new coverage for all of the above (see coverage metadata)

## Decisions Made

- `wdlLeafExpectedScore` is a sibling function, not an overload of `leafExpectedScore` — forcing a WDL through the cp-based converter would need a lossy fake-cp round trip.
- `WDL_LEAF_HANDOFF_DEPTH = 3` is explicitly documented as the pre-declared first candidate for Plan 02's measurement, not a chosen/measured answer — Plan 03 will replace it with a cited TSV row.
- The WDL cache is co-located in the policy cache's own entry rather than a separately-evicted sibling cache, closing the T-197-03 key-confusion/economics-violation risk structurally.
- `MaiaQueue.wdl()` rides `policy()`'s existing settlement paths instead of owning a second request/response lifecycle, guaranteeing it never issues a second `lease.analyze()` call.

## Deviations from Plan

None - plan executed exactly as written. All three tasks' `<action>` items were implemented as specified; all `<behavior>` test cases were written before or alongside the corresponding wiring (TDD discipline honored for Task 1 and Task 2's `tdd="true"` flag).

## Issues Encountered

None.

## Known Stubs

None - all wiring is real, no placeholder/stub data paths were introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02 can now measure the real handoff depth against `WDL_LEAF_HANDOFF_DEPTH`'s pre-declared candidate value of 3.
- Plan 03 has a committed `usesWdlLeaf`/`WDL_LEAF_HANDOFF_DEPTH` seam to replace with the measured value.
- Plan 04 has the LEAF-05 doc-comment seed (in `wdlLeafExpectedScore`'s header) to expand into the full written argument.
- D-03's exposure (the search loses its Stockfish cross-check at WDL leaves) is now live in the codebase, as intentionally created by this plan — Plan 03's Maia-blindness fixture is the falsifiability mechanism for that risk.

---
*Phase: 197-maia-wdl-leaf-values*
*Completed: 2026-07-31*

## Self-Check: PASSED

All 9 modified source files and the SUMMARY.md itself exist on disk; all 3 task commits (`7a8061ed`, `95bfb8ad`, `490b47a6`) are present in git history.
