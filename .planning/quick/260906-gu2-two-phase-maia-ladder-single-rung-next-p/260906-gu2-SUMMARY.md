---
status: complete
phase: quick-260906-gu2
plan: 01
subsystem: analysis-board-engines
tags: [perf, frontend, maia, flawchess-engine]
dependency_graph:
  requires: []
  provides: [maia-two-phase-ladder, maia-next-ply-prefetch, maia-policy-pending-registry]
  affects: [useMaiaEngine, maiaQueue, maiaPolicyCache, Analysis.tsx, useGemSweep]
tech_stack:
  added: []
  patterns: [single-in-flight-pipeline-planner, pending-promise-registry]
key_files:
  created:
    - frontend/src/lib/nextLineFen.ts
    - frontend/src/lib/nextLineFen.test.ts
  modified:
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/lib/engine/maiaPolicyCache.ts
    - frontend/src/lib/engine/maiaQueue.ts
    - frontend/src/pages/Analysis.tsx
    - frontend/src/hooks/useGemSweep.ts
    - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
    - frontend/src/lib/engine/__tests__/maiaPolicyCache.test.ts
    - frontend/src/lib/engine/__tests__/maiaQueue.test.ts
    - CHANGELOG.md
decisions:
  - Phase 1 requests the EXACT (un-snapped) selectedElo, not the nearest ladder rung, because the engine calls policy(fen, selectedElo) with the exact value; that is the only rung that can serve it through the shared cache.
  - perElo keeps its ladder-only, complete-or-empty contract; only wdl/expectedScore (and the policy cache) arrive early. No UI consumer changed.
  - Prefetch is one rung, issued between phase 1 and the ladder; the worker is never idle during a 400-node search, so an idle-time prefetch would starve.
  - useGemSweep passes ladderOnly: true so the sweep's cost and gem classification stay byte-identical.
  - Analysis.tsx computes prefetchFen inline (no useMemo/ternary) because the component sits exactly at its max-statements / complexity baselines.
metrics:
  duration: ~2h
  completed: "2026-09-06"
---

# Two-phase Maia ladder + single-rung next-ply prefetch

## Measured (browser, wasm backend, 16-core Linux)

| step | before | after |
|---|---|---|
| eval bar (wdl) after navigation | ~4 s (behind 21-rung ladder) | ~250 ms |
| engine root policy available | ~4 s (queued behind ladder) | ~250 ms (awaits the same inference via pending registry) |
| next-ply exact rung | fresh inference on step | prefetched (~280 ms, right after phase 1) |
| chart (full ladder) | ~4 s | ~4.5 s (+ one exact rung + one prefetch) |

Pipeline observed at the root of a line: exact rung 257 ms -> next-ply prefetch 283 ms -> ladder 4.26 s. Stepping forward issued no exact-rung request (cache hit), only the new position's ladder.

## Commits

- a90edfa66 perf(maia): let the engine's policy() await an in-flight chart inference instead of duplicating it
- b6d4cc48a perf(maia): two-phase rating ladder + single-rung next-ply prefetch on the analysis board

## Gate

`npm run lint` clean, `npm test -- --run` 254 files / 3933 tests green, `npm run build` (tsc -b) clean, `npm run knip` clean.

## Notes

- The hook's pre-existing tab-hide pause means a background tab never runs the chart pipeline (the engine has no such pause); unchanged behavior, but it is why a headless probe sees only engine calls until the tab is visible.
- The chart itself is not faster on wasm; that needs WebGPU, multi-thread wasm (blocked by D-3), or a smaller ladder.
