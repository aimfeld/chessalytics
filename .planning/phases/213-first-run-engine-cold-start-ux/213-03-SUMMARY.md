---
phase: 213-first-run-engine-cold-start-ux
plan: 03
subsystem: frontend-engine-readiness
tags: [web-worker, message-channel, useSyncExternalStore, bots, stockfish]

# Dependency graph
requires:
  - phase: 213-01
    provides: "engineAssetProgress.ts's N-asset registry, useEngineAssets' byte-weighted read model, EngineReadyGate.tsx, and maiaWorkerHost.ts's whenReady() shape"
provides:
  - "WorkerPool.whenReady() — the pool-level Stockfish readiness promise, resolved on the FIRST slot's readyok, mirroring maiaWorkerHost's readyWaiters shape"
  - "createSlot()'s progressPort wiring — the app-side half of the vendored Stockfish glue's existing download-progress protocol, feeding reportEngineAssetProgress('stockfish-wasm', ...)"
  - "engineGateRequired()'s general blend>0 rule — a blend>0 persona is now actually gated on BOTH engine assets, not hardcoded false"
affects: [213-04, 213-05]

# Actuals (#2632)
actuals:
  tokens: 6684
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pool-level readiness via a single markPoolReady() choke point that fires both the whenReady() promise resolution AND the asset-store transition, so the two can never diverge"
    - "MessageChannel port handoff to a classic (non-module) Worker for third-party download-progress wiring, with a typeof MessageChannel feature-detect so a missing API degrades to no progress bar rather than a broken engine spawn"
    - "A synchronous MockMessagePort/MockMessageChannel test double (mirrors MockWorker.simulateMessage) instead of relying on jsdom's real, asynchronous MessageChannel — keeps progressPort tests deterministic and fast"

key-files:
  created: []
  modified:
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/lib/engine/engineAssetProgress.ts
    - frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts
    - frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx
    - frontend/src/hooks/__tests__/useBotGame.test.ts

key-decisions:
  - "Tasks 1 and 2 (whenReady() and progressPort wiring) were committed as ONE commit rather than two, since both edit the same functions in the same file (createWorkerPool/createSlot/handleLine) with no clean seam between them — splitting would have required a discard-and-reapply detour with zero functional benefit."
  - "useBotGame.test.ts's global beforeEach now primes both engine assets as already-seen by default, since DEFAULT_SETTINGS.blend (0.5) is > HUMAN_BLEND — once the blend>0 gate went live for real, every pre-existing test in that ~2400-line file that assumed live:true from mount would otherwise fail. The engine-ready-gate describe block gets its own nested beforeEach that resets to a genuinely clean slate, since it exists specifically to exercise the gate."
  - "The EngineReadyGate D-11 subtext-switching test drives maia-model to completion first, not stockfish-wasm as the plan's prose literally described — requiredEngineAssets(blend) is a frozen Plan-01 array ['maia-model', 'stockfish-wasm'], and useEngineAssets' activeAssetLabel picks the first NOT-done id in that array order, so the label is unconditionally 'Maia model' until maia-model itself completes, regardless of stockfish-wasm's state. The test captures the actual, correct D-11 contract (subtext names the in-flight asset and changes when the first one completes) rather than the plan's specific (and array-order-inconsistent) asset choice."

requirements-completed: [D-01, D-06, D-11]

coverage:
  - id: D1
    description: "WorkerPool.whenReady() — resolves on the first slot's readyok, stays pending until then, resolves immediately once ready, re-pends after terminate()+respawn, and never waits for the other pool slots"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/workerPool.test.ts#createWorkerPool: whenReady() (Phase 213 D-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "createSlot()'s progressPort wiring — every fresh worker gets a MessageChannel port before the uci handshake (handshake still runs last), progress messages feed reportEngineAssetProgress('stockfish-wasm', ...), a missing/zero total still yields a finite percent, and a MessageChannel-less environment skips the wiring without breaking spawn"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/workerPool.test.ts#createWorkerPool: progressPort wiring (Phase 213 D-01, T-213-01/T-213-07)"
        status: pass
    human_judgment: false
  - id: D3
    description: "engineGateRequired()'s blend>0 branch — gated on a clean cache, ungated once BOTH assets are seen, still gated when only one of the two is seen"
    verification:
      - kind: unit
        ref: "src/lib/engine/__tests__/engineAssetProgress.test.ts#engineGateRequired — D-04 cache-miss predicate"
        status: pass
    human_judgment: false
  - id: D4
    description: "EngineReadyGate for a blend>0 persona — exactly ONE aggregate progress element (never per-asset rows, D-11), subtext names the in-flight asset and switches as the first one completes, Start stays disabled until both are done"
    verification:
      - kind: unit
        ref: "src/components/bots/__tests__/EngineReadyGate.test.tsx#a blend > 0 persona is gated on BOTH assets, shows exactly ONE progress element, and the subtext switches asset as the first one completes (D-11)"
        status: pass
    human_judgment: false
  - id: D5
    description: "useBotGame's live initializer for a blend>0 persona — starts false on a clean cache, true immediately once both seen flags are already written"
    verification:
      - kind: unit
        ref: "src/hooks/__tests__/useBotGame.test.ts#engine-ready-gate"
        status: pass
    human_judgment: false
  - id: D6
    description: "A 1600/1800-rung persona's real fresh game on a real cold cache waits behind the gate and starts only on Start, without ever double-fetching the Stockfish .wasm"
    verification: []
    human_judgment: true
    rationale: "213-VALIDATION.md scopes the real cold-cache/Slow-4G confirmation to a manual device pass — no test harness in this repo throttles or double-counts a real 7.3 MB Worker-internal fetch end to end."

duration: 25min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 03: Stockfish Readiness + Progress Wiring + Blend>0 Gate Summary

**`WorkerPool.whenReady()` resolved on the pool's first `readyok`, `createSlot()` wired to the vendored Stockfish glue's own `progressPort` protocol, and `engineGateRequired()`'s blend>0 branch switched from a hardcoded `false` to the real two-asset D-06 rule.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-28T12:54:42+02:00 (base commit)
- **Completed:** 2026-08-28T13:15:22+02:00
- **Tasks:** 3 completed
- **Files modified:** 6 (0 created)

## Accomplishments

- `WorkerPool` gained a pool-level `whenReady(): Promise<void>`, the Stockfish-side counterpart to `maiaWorkerHost.ts`'s own `whenReady()` — resolved the first time ANY slot completes its UCI init handshake, mirroring the "bytes downloaded and the engine usable" readiness definition D-01 requires. A single `markPoolReady()` choke point fires both the promise resolution and the `stockfish-wasm` asset-store transition, so the two paths can never diverge; `terminate()` resets readiness and settles (never hangs) any outstanding waiters (T-213-08).
- `createSlot()` now hands every fresh worker a `MessageChannel` port before the `uci` handshake, wiring the vendored `stockfish-18-lite-single.js` glue's own, already-shipped `progressPort` protocol into `reportEngineAssetProgress('stockfish-wasm', ...)` — pure wiring, no owned fetch, so the 7.3 MB `.wasm` is still downloaded exactly once by the glue itself (Pitfall 4). The store re-derives percent from raw `loaded`/`total`, discarding the glue's own `percent`/`speedBytesPerSec`/`etaText` (T-213-01), and the wiring feature-detects `MessageChannel` so its absence degrades to "no progress bar" rather than a broken engine spawn (T-213-07).
- `engineGateRequired()` dropped Plan 01's `blend > HUMAN_BLEND` early-`false` branch and now derives its answer generally from `requiredEngineAssets(blend)`: gated iff ANY required asset is neither `done` in the store nor seen in localStorage. A 1600/1800-rung persona is now genuinely gated on both Maia and Stockfish; a partially-cached device (only one of two assets seen) stays gated; a blend-0 persona's behavior is unchanged (still Maia-only, still never touches Stockfish).
- Both behaviors were mutation-tested manually: `poolReady = false` in `terminate()` was removed, the reset test observed to fail, then restored; the `progressPort`/`uci` postMessage order was swapped, the ordering test observed to fail, then restored; `useEngineAssets`' byte-weighted percent was temporarily changed to a per-asset average, the 14% assertion observed to fail (50% instead), then reverted.

## Task Commits

1. **Task 1 + 2: `WorkerPool.whenReady()` + `progressPort` wiring** - `ad354d95f` (feat) — combined into one commit; both tasks edit the same functions (`createWorkerPool`, `createSlot`, `handleLine`) in the same file with no clean seam between them.
2. **Task 3: switch on blend>0 gating + single byte-weighted bar proof** - `9779f5fca` (feat)

**Plan metadata:** commit follows (docs)

## Files Created/Modified

- `frontend/src/lib/engine/workerPool.ts` — `whenReady()` interface + implementation, `markPoolReady()`, `progressPort` wiring in `createSlot()`
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` — `MockMessagePort`/`MockMessageChannel` double, `whenReady()` describe block, `progressPort` wiring describe block
- `frontend/src/lib/engine/engineAssetProgress.ts` — `engineGateRequired()`'s general blend-derived rule
- `frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts` — blend>0 clean/both-seen/partial-seen cases
- `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx` — the D-11 single-bar/subtext-switching case for a blend>0 persona
- `frontend/src/hooks/__tests__/useBotGame.test.ts` — the two blend>0 fresh-mount `live` cases, plus a global-beforeEach priming fix (see Decisions)

## Decisions Made

- **Tasks 1+2 combined into one commit.** Splitting them would have required discarding and hand-replaying the same working, tested diff for no functional benefit — both touch `createWorkerPool`/`createSlot`/`handleLine` in `workerPool.ts` in an interleaved way.
- **`useBotGame.test.ts`'s shared `beforeEach` now primes both engine assets as already-seen.** `DEFAULT_SETTINGS.blend` is `0.5` (`> HUMAN_BLEND`), so once the blend>0 gate actually fires (this plan's whole point), every one of the ~40 pre-existing tests in that file that assumed `live: true` from mount broke. Priming both assets in the outer `beforeEach` restores that assumption everywhere except the `engine-ready-gate` describe block, which gets its own nested `beforeEach` resetting to a genuinely clean slate — exactly the block that needs to control cache state precisely.
- **The D-11 subtext test drives `maia-model` to completion, not `stockfish-wasm`**, deviating from the plan's literal prose ("driving stockfish-wasm to complete, asserting the subtext switches to the maia-model label"). `requiredEngineAssets(blend)` is a frozen Plan-01 array `['maia-model', 'stockfish-wasm']`, and `useEngineAssets`' `activeAssetLabel` always picks the first not-done id in that array order — so the subtext is unconditionally "Maia model" until maia-model itself finishes, independent of stockfish-wasm's state. The test proves the real D-11 contract (subtext names the in-flight asset, changes when the first one completes) using the asset ordering the shipped code actually has.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a stale test-authoring assumption in the D-11 subtext test's asset-completion order**
- **Found during:** Task 3 (writing the `EngineReadyGate.test.tsx` blend>0 case)
- **Issue:** The plan's action text describes driving `stockfish-wasm` to completion and asserting the subtext switches to the `maia-model` label. Given `requiredEngineAssets`' frozen `['maia-model', 'stockfish-wasm']` order and `useEngineAssets`' first-not-done-wins label selection, the subtext is "Maia model" from mount and only switches to "Stockfish engine" once maia-model itself completes — the plan's literal sequencing does not match the shipped array order.
- **Fix:** Wrote the test to drive `maia-model` to completion (not `stockfish-wasm`), asserting the subtext switches to "Stockfish engine" — the label that actually reflects "next asset in flight" given the real code.
- **Files modified:** `frontend/src/components/bots/__tests__/EngineReadyGate.test.tsx`
- **Verification:** Test passes; the full plan-level verification suite (lint/test/build/knip) is green.
- **Committed in:** `9779f5fca` (Task 3 commit)

**2. [Rule 1 - Bug] Fixed a cascading test-suite regression from turning on the blend>0 gate for real**
- **Found during:** Task 3, running `useBotGame.test.ts` after the `engineGateRequired()` change
- **Issue:** `DEFAULT_SETTINGS.blend = 0.5` (> `HUMAN_BLEND`). Before this plan, `engineGateRequired` short-circuited blend>0 to `false`, so every pre-existing test in this ~2400-line file mounted with `live: true` regardless of cache state. Once Task 3 made the gate real, 44 of 84 tests in the file failed because the global `beforeEach` resets the engine-asset store to a clean slate every test.
- **Fix:** Primed both `maia-model` and `stockfish-wasm` as already-seen in the file's shared `beforeEach` (restoring the pre-Phase-213 default of `live: true` from mount everywhere in the file), and added a nested `beforeEach` inside the `engine-ready-gate` describe block that resets to a genuinely clean slate for the tests that specifically exercise the gate.
- **Files modified:** `frontend/src/hooks/__tests__/useBotGame.test.ts`
- **Verification:** All 84 tests in the file pass; full frontend suite (3645 tests) passes.
- **Committed in:** `9779f5fca` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs — a test-authoring assumption inconsistent with the shipped code, and a cross-file test-suite regression from switching on real gating behavior).
**Impact on plan:** Both fixes were necessary to make the plan's own acceptance criteria pass; no scope creep — no production behavior changed beyond what the plan specified.

## Issues Encountered

None beyond the two deviations above, both resolved during Task 3's own execution.

## Known Stubs

None — every artifact this plan produces is production-quality, wired end to end, with no placeholder data.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `WorkerPool.whenReady()` is ready for Plan 05's `useFlawChessEngine` to consume, mirroring how it already consumes `MaiaQueue.whenReady()`.
- `engineGateRequired()`'s general rule and the byte-weighted single-bar UI are both real and tested for blend>0 personas — Plan 04 can build D-13/D-14/D-15 terminal-state UI on top of this without further readiness-surface work.
- The real cold-cache/Slow-4G manual verification for a 1600/1800-rung persona (213-VALIDATION.md) remains open, alongside Plan 01's equivalent blend-0 row — both are explicitly scoped to a real-device pass, not this plan's automated suite.

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*

## Self-Check: PASSED

- All 6 modified files verified present on disk with the expected changes (`git diff --stat` against the base commit).
- Both task commits (`ad354d95f`, `9779f5fca`) verified present in `git log --oneline --all`.
- Re-ran all acceptance-criteria greps: `whenReady`/`markPoolReady`/`markEngineAssetReady`/`progressPort` call-site counts, `postMessage('uci')` still last in `createSlot()`, `blend > HUMAN_BLEND` no longer an early-return in `engineGateRequired`, no `setTimeout`/`setInterval` in `engineAssetProgress.ts`, `git diff --stat` on the vendored glue empty, no direct `.wasm` fetch in `frontend/src`.
- Re-ran the full frontend suite after both mutation-test proofs were reverted: `npm run lint` (0 issues), `npm test -- --run` (243 files / 3645 tests passed), `npm run build` (exit 0), `npm run knip` (0 unused exports).
