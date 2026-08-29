---
phase: quick-260829-tku
plan: 01
subsystem: ui
tags: [react, typescript, sentry, engine, maia]

# Dependency graph
requires:
  - phase: 213 (engine readiness gate)
    provides: EngineReadyGate.tsx, engineAssetProgress.ts store, useEngineAssets hook
  - phase: quick-260729-sod
    provides: maiaWorkerErrors.ts's classifyMaiaWorkerError() / MaiaFailureKind
provides:
  - failureKind field threaded from maiaWorkerHost.ts through engineAssetProgress.ts and useEngineAssets.ts into EngineReadyGate.tsx
  - New 'oom' terminal variant in EngineReadyGate with free-memory copy and Retry
  - Corrected Sentry engine_failure tag ('oom' vs 'download')
affects: [maia-engine, sentry-dashboards, engine-ready-gate]

# Actuals (#2632)
actuals:
  tokens: 5243
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Store-level failureKind classification threaded through a useSyncExternalStore singleton, read as a bare snapshot field (no derivation) by the consuming hook."
    - "Terminal-variant selection centralized in one pickTerminalVariant() helper shared by both the render branch and the Sentry-capture effect, so message/tag selection can never disagree with the rendered copy."

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/hooks/useEngineAssets.ts
    - frontend/src/lib/engine/maiaWorkerHost.ts
    - frontend/src/components/bots/EngineReadyGate.tsx
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - CHANGELOG.md

key-decisions:
  - "Reused the existing MaiaFailureKind union from maiaWorkerErrors.ts (type-only import) rather than declaring a parallel type in the asset store, per the plan's key_links constraint."
  - "markEngineAssetFailed's new failureKind parameter is optional, with precedence `failureKind ?? currentFailureKind`, so a later unclassified failure (e.g. the Stockfish pool) never erases an existing oom classification."
  - "Extracted a small pickTerminalVariant() helper so the render branch and the D-17 Sentry capture effect derive the same variant from a single source of truth, rather than duplicating the status/failureKind branch logic."

patterns-established:
  - "When a snapshot-level classification field needs to reach both a render branch and a side-effect (Sentry capture) in the same component, factor the branch decision into one pure helper both call, rather than letting each recompute it independently."

requirements-completed: [TKU-01]

coverage:
  - id: D1
    description: "Maia engine failures classified as memory exhaustion render a dedicated engine-gate-oom terminal state with free-memory guidance, instead of the generic download-failure copy."
    requirement: "TKU-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#the out-of-memory terminal state (surface=bots/analysis) renders the oom testid and free-memory copy..."
        status: pass
    human_judgment: false
  - id: D2
    description: "The oom terminal state renders exactly one Retry button (btn-engine-retry) that clears the store and calls onRetry, identical to the generic failed state."
    requirement: "TKU-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#the out-of-memory terminal state (surface=%s) ... with a working Retry"
        status: pass
    human_judgment: false
  - id: D3
    description: "A generic (load, inference, or unclassified) failure still renders the pre-existing engine-gate-failed copy and Retry, byte-for-byte unchanged."
    requirement: "TKU-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#%s still renders the pre-existing engine-gate-failed testid, title, body, and Retry"
        status: pass
    human_judgment: false
  - id: D4
    description: "The Sentry terminal-failure capture reports engine_failure: 'oom' for a classified memory-exhaustion failure and keeps 'download' for every other failure, with fixed-literal messages (no interpolated variables)."
    requirement: "TKU-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#captures exactly one Sentry exception for the failed terminal state, distinct from the unsupported message"
        status: pass
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx#renders the oom testid ... with a single tagged Sentry capture"
        status: pass
    human_judgment: false
  - id: D5
    description: "markEngineAssetFailed's optional failureKind parameter records the kind, defaults to null when absent, keeps precedence across assets, and is cleared by markEngineAssetsRetrying()."
    requirement: "TKU-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#markEngineAssetFailed — Plan 04 owns this UI; Task 1 owns the transport"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts#clears a classified failure kind back to null, while the existing status/byte/seen-flag assertions in this describe still hold"
        status: pass
    human_judgment: false

# Metrics
duration: 7min
completed: 2026-08-29
status: complete
---

# Quick Task 260829-tku: Maia OOM Engine-Start UX Summary

**Threaded the existing `classifyMaiaWorkerError()` classification through the engine asset store into a new `engine-gate-oom` terminal state in `EngineReadyGate`, so a device that runs out of memory during Maia session init is told to free memory instead of being blamed for a broken download, and the Sentry `engine_failure` tag now correctly reports `'oom'` for that case.**

## Performance

- **Duration:** 7 min (git commit timestamps 21:24:02 → 21:30:52 CEST)
- **Started:** 2026-08-29T19:24:02Z
- **Completed:** 2026-08-29T19:30:52Z
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments
- Added `failureKind: MaiaFailureKind | null` at snapshot level in `engineAssetProgress.ts`, backed by an optional `markEngineAssetFailed(id, failureKind?)` parameter with `failureKind ?? currentFailureKind` precedence, and cleared on retry/test-reset.
- Threaded the field through `useEngineAssets.ts` (read straight off the snapshot; `useEngineAssetStatus()` left untouched, still a bare primitive).
- `maiaWorkerHost.ts::failAllLeasesAndDropWorker()` now classifies `err.message` via the existing `classifyMaiaWorkerError()` before calling `markEngineAssetFailed`, closing the gap where classification stopped at the Sentry tag and never reached the user-facing gate.
- Added the `oom` `TerminalVariant` to `EngineReadyGate.tsx` with dedicated copy (`engine-gate-oom` testid), sharing the single Retry button (`btn-engine-retry`) with the generic `failed` variant via `variant !== 'unsupported'`.
- Centralized the render/Sentry variant decision in one `pickTerminalVariant()` helper so the D-17 Sentry capture effect and the render branch can never disagree; added `SENTRY_MESSAGE_OOM` and `ENGINE_FAILURE_TAG_OOM`/`ENGINE_FAILURE_TAG_DOWNLOAD` named constants (no interpolated Sentry messages).
- Added an end-to-end tracer test (both `bots` and `analysis` surfaces) proving `markEngineAssetFailed('maia-model', 'oom')` renders the new copy, a working Retry, and a single correctly-tagged Sentry capture.
- Extended `engineAssetProgress.test.ts` to cover `failureKind` set/absent/precedence/retry-clear, and added a regression test in `EngineReadyGate.test.tsx` pinning that a `'load'`-classified or unclassified failure still renders the unchanged generic `engine-gate-failed` copy.
- Ran the full frontend pre-merge gate (lint, `tsc -b` + vite build, knip, full vitest suite — 248 files / 3859 tests) and appended a one-line `CHANGELOG.md` entry under `## [Unreleased]`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread the failure kind from the Maia worker host to a new oom terminal state in the gate** - `f1fdffeed` (feat)
2. **Task 2: Cover the store transitions and lock the generic-failure path against regression** - `a0969a3ce` (test)
3. **Task 3: Run the frontend pre-merge gate and record the user-facing change** - `131a9ee57` (docs)

_No separate plan-metadata commit — the orchestrator handles the docs commit for this quick task per its constraints._

## Files Created/Modified
- `frontend/src/lib/engine/engineAssetProgress.ts` - Added `failureKind` to the snapshot, optional param on `markEngineAssetFailed`, cleared on retry/test-reset.
- `frontend/src/hooks/useEngineAssets.ts` - Exposed `failureKind` on `EngineAssetsState`, `useEngineAssetStatus()` unchanged.
- `frontend/src/lib/engine/maiaWorkerHost.ts` - Classifies `err.message` via `classifyMaiaWorkerError()` before `markEngineAssetFailed`.
- `frontend/src/components/bots/EngineReadyGate.tsx` - New `oom` `TerminalVariant`, `pickTerminalVariant()` helper, updated D-17 Sentry capture.
- `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts` - `failureKind` set/absent/precedence/retry-clear coverage.
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` - oom terminal-state tracer test (both surfaces) + generic-failure regression test.
- `CHANGELOG.md` - One-line `## [Unreleased]` bullet.

## Decisions Made
- Reused `MaiaFailureKind` via type-only import rather than a parallel union, per the plan's `key_links` constraint that `classifyMaiaWorkerError()` must stay the only classifier.
- Optional-parameter + precedence design on `markEngineAssetFailed` keeps the three existing call sites (Stockfish pool, `useStockfishEngine`, and this one) compiling unchanged while never letting a later unclassified failure erase an oom classification.
- Extracted `pickTerminalVariant()` as a small pure helper (not inlined nested ternaries) so the render and the Sentry effect can never pick different variants from the same store state.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The `failureKind` transport is generic (`MaiaFailureKind | null`) and could carry future classifications (`'load'`, `'inference'`) into their own terminal variants later, but that is out of scope here — SEED-158 (upfront memory detection / ORT arena tuning / WebGPU backend selection) remains explicitly deferred and untouched by this change.
- No blockers.

---
*Phase: quick-260829-tku*
*Completed: 2026-08-29*

## Self-Check: PASSED

All 7 modified source/test files plus this SUMMARY.md verified present on disk; all 3 task commit hashes (`f1fdffeed`, `a0969a3ce`, `131a9ee57`) verified present in git log.
