---
phase: 213-first-run-engine-cold-start-ux
plan: 05
subsystem: frontend-engine-readiness
tags: [react, useSyncExternalStore, web-worker, analysis-board]

# Dependency graph
requires:
  - phase: 213-01
    provides: "engineAssetProgress.ts's N-asset registry, useEngineAssets' byte-weighted read model, and the D-10 progress primitive"
  - phase: 213-03
    provides: "WorkerPool.whenReady() and the progressPort wiring pattern in createSlot()"
provides:
  - "useFlawChessEngine.isReady backed by real asset readiness (both providers' whenReady()), consumed by Analysis.tsx's flawChessLoading"
  - "EngineLinesSkeleton's assetProgress prop and formatAssetProgressReadout() helper, reused by MovesByRatingChart's MaiaChartSkeleton"
  - "the standalone Stockfish worker's stockfish-wasm progress reporting, mirroring workerPool.ts's progressPort wiring"
  - "all three analysis-board EngineLinesSkeleton mount sites plus the Maia chart skeleton wired to live download progress"
affects: []

# Actuals (#2632)
actuals:
  tokens: 12405
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Progress markup REPLACES (never appends to) a skeleton's pulsing rows inside the same fixed-height container, preserving the no-jump invariant — proven by a mutation test (append vs replace) for both EngineLinesSkeleton and MaiaChartSkeleton"
    - "A hook call that must run unconditionally (rules of hooks) is extracted into its own tiny component instead of living behind the caller's conditional early return (MaiaChartSkeleton vs MovesByRatingChart's perElo.length === 0 branch)"
    - "Shared UI-copy formatting (\"{label} — {percent}%\") hoisted into one exported helper (formatAssetProgressReadout) so two independent render sites cannot drift in wording"

key-files:
  created: []
  modified:
    - frontend/src/hooks/useFlawChessEngine.ts
    - frontend/src/hooks/useStockfishEngine.ts
    - frontend/src/components/analysis/EngineLines.tsx
    - frontend/src/components/analysis/MovesByRatingChart.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/hooks/__tests__/useFlawChessEngine.test.ts
    - frontend/src/hooks/__tests__/useStockfishEngine.test.ts
    - frontend/src/components/analysis/__tests__/EngineLines.test.tsx
    - frontend/src/components/analysis/__tests__/MovesByRatingChart.test.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "Rewired useFlawChessEngine's isReady in place rather than adding a parallel assetsReady value, per the plan's explicit resolution of 213-RESEARCH.md's Open Question 1 (isReady has exactly one consumer, Analysis.tsx's flawChessLoading)."
  - "The Analysis.test.tsx D-12 tests split into a desktop case (default test matchMedia = desktop layout) and a mobile case (forced matchMedia + fireEvent.mouseDown on the Eval tab trigger) instead of asserting both slots in one render, because useAnalysisLayoutMode renders EXACTLY ONE of mobile/mid/desktop per mount — they structurally cannot coexist in the same DOM."
  - "Radix Tabs activates on mousedown, not click — fireEvent.click(tabTrigger) silently does nothing in jsdom (no @testing-library/user-event in this project's deps). Used fireEvent.mouseDown instead, matching Radix's actual event contract."

patterns-established:
  - "EngineLinesSkeleton.assetProgress / MaiaChartSkeleton's inline readout are the canonical shape for future 'live progress inside an existing skeleton slot' surfaces — replace, never append, and reuse formatAssetProgressReadout for wording."

requirements-completed: [D-01, D-12]

coverage:
  - id: D1
    description: "useFlawChessEngine.isReady is true only once BOTH queue.whenReady() and pool.whenReady() resolve; a rejection captures once to Sentry and still flips isReady true; no state update fires after unmount/disable (cancelled guard, mutation-tested)"
    requirement: "D-01"
    verification:
      - kind: unit
        ref: "src/hooks/__tests__/useFlawChessEngine.test.ts#D-01: isReady reflects real asset readiness"
        status: pass
    human_judgment: false
  - id: D2
    description: "EngineLinesSkeleton renders exactly today's pulsing rows when assetProgress is absent/null/label-null, and REPLACES them with a Progress bar + \"{label} — {percent}%\" when present, inside the identical fixed-height container (no-jump invariant, mutation-tested)"
    requirement: "D-12"
    verification:
      - kind: unit
        ref: "src/components/analysis/__tests__/EngineLines.test.tsx#EngineLinesSkeleton"
        status: pass
    human_judgment: false
  - id: D3
    description: "MovesByRatingChart's perElo-empty skeleton (extracted into MaiaChartSkeleton) shows the same readout while maia-model is downloading, else the original pulsing block, with its hook call never behind a conditional early return"
    requirement: "D-12"
    verification:
      - kind: unit
        ref: "src/components/analysis/__tests__/MovesByRatingChart.test.tsx#while the Maia model asset is downloading"
        status: pass
    human_judgment: false
  - id: D4
    description: "The standalone Stockfish worker (useStockfishEngine) wires the vendored glue's progressPort protocol, reports to the shared store under stockfish-wasm, and marks it ready on readyok"
    requirement: "D-01"
    verification:
      - kind: unit
        ref: "src/hooks/__tests__/useStockfishEngine.test.ts#D-01: reports download progress and marks stockfish-wasm ready"
        status: pass
    human_judgment: false
  - id: D5
    description: "All three EngineLinesSkeleton mount sites in Analysis.tsx (FlawChess card, mobile Stockfish slot, desktop Stockfish slot) receive live assetProgress; desktop and mobile show identical readouts under the same store state, proven independent by mutation (removing the desktop prop breaks only the desktop test)"
    requirement: "D-12"
    verification:
      - kind: unit
        ref: "src/pages/__tests__/Analysis.test.tsx#Analysis page: engine asset download progress (D-12)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The analysis board has no start gate — the board stays fully interactive throughout every loading/downloading state; progress is informational only"
    verification: []
    human_judgment: true
    rationale: "Absence of a gate is a negative/structural property (no new blocking UI was added) rather than something a unit test asserts directly — confirmed by code review (no new conditional wraps board interactivity) and the plan's own threat model, which records no gate on this surface."

duration: 45min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 05: Analysis Board Cold-Start Progress + Honest FlawChess Readiness Summary

**`useFlawChessEngine.isReady` now means both Maia and Stockfish are actually loaded (not merely constructed), and all three analysis-board loading skeletons plus the Maia chart's own skeleton show a live "asset — percent%" download readout, replacing the pulsing rows in place with zero layout jump.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-08-28T13:28:00+02:00 (approx, first verification run)
- **Completed:** 2026-08-28T14:13:00+02:00
- **Tasks:** 3 completed
- **Files modified:** 12 (0 created)

## Accomplishments

- `useFlawChessEngine`'s provider-lifecycle effect now awaits `Promise.all([queue.whenReady(), pool.whenReady()])` before flipping `isReady` true, guarded by a `cancelled` flag set in the effect's cleanup so no state update ever fires after unmount or disable. A rejected `whenReady()` (worker death) captures once to Sentry with `tags: { source: 'flawchess-engine' }` and still sets `isReady` true so the card degrades to its normal empty rendering instead of a permanent skeleton.
- `EngineLinesSkeleton` gained an optional `assetProgress` prop (`{ percent, label }`) that REPLACES (never appends to) the pulsing placeholder rows inside the exact same fixed-height container, preserving the documented no-jump invariant. Absent/null/label-null renders byte-identical to before. A new `formatAssetProgressReadout()` helper hoists the `"{label} — {percent}%"` wording so this skeleton and the D-09 gate Dialog cannot drift apart.
- `MovesByRatingChart`'s `perElo.length === 0` early return was extracted into a `MaiaChartSkeleton` component so its `useEngineAssets()` hook call is never behind a conditional (rules of hooks); it shows the same Progress + readout while the Maia model is downloading, else today's pulsing block unchanged.
- The standalone Stockfish worker (`useStockfishEngine`) now wires the vendored glue's already-shipped `progressPort` `MessageChannel` protocol — copied verbatim from `workerPool.ts::createSlot()` — reporting `stockfish-wasm` download bytes to the shared store, and calls `markEngineAssetReady('stockfish-wasm')` on the `readyok` line.
- `Analysis.tsx` derives `flawChessAssetProgress`/`stockfishAssetProgress` via `useEngineAssets` over two module-level stable asset arrays and passes `assetProgress` into all THREE `EngineLinesSkeleton` mount sites (the shared FlawChess card slot, the mobile Stockfish slot, and the desktop Stockfish slot) — desktop and mobile stay in lockstep, proven independent by a mutation test (removing the desktop site's prop breaks only the desktop-layout test, not the mobile one).

## Task Commits

1. **Task 1: Make useFlawChessEngine.isReady mean real asset readiness** - `5fc9f1545` (feat)
2. **Task 2: Progress-aware EngineLinesSkeleton and Maia chart skeleton** - `0bd537ef8` (feat)
3. **Task 3: Wire all three skeleton slots plus the standalone Stockfish worker** - `8e340d628` (feat)

**Plan metadata:** commit follows (docs)

## Files Created/Modified

- `frontend/src/hooks/useFlawChessEngine.ts` - `isReady` rewired to await both providers' `whenReady()`
- `frontend/src/hooks/useStockfishEngine.ts` - `progressPort` wiring + `markEngineAssetReady('stockfish-wasm')`
- `frontend/src/components/analysis/EngineLines.tsx` - `assetProgress` prop + `formatAssetProgressReadout()`
- `frontend/src/components/analysis/MovesByRatingChart.tsx` - `MaiaChartSkeleton` extraction
- `frontend/src/pages/Analysis.tsx` - `useEngineAssets` wiring at all three skeleton mount sites
- Six test files extended (`useFlawChessEngine.test.ts`, `useStockfishEngine.test.ts`, `EngineLines.test.tsx`, `MovesByRatingChart.test.tsx`, `Analysis.test.tsx`)
- Two unrelated Train test files' `FakeWorker` mocks fixed (`Train.solveLoop.test.tsx`, `TrainSolveScreen.test.tsx`) — see Deviations

## Decisions Made

- Rewired `isReady` in place per the plan's explicit resolution of 213-RESEARCH.md's Open Question 1, rather than adding a parallel `assetsReady` signal — the field has exactly one consumer.
- Split the Analysis.tsx D-12 desktop/mobile parity test into two separate render passes (default matchMedia = desktop, forced matchMedia = mobile) rather than asserting both slots in one render, because `useAnalysisLayoutMode` renders EXACTLY ONE of mobile/mid/desktop per mount — they cannot structurally coexist in the DOM. The mutation-test proof (removing the desktop site's `assetProgress`) still demonstrates the two sites are wired independently.
- Discovered mid-task that Radix Tabs activates on `mousedown`, not `click` — `fireEvent.click` on a `TabsTrigger` is a silent no-op in this project (no `@testing-library/user-event` dependency). Used `fireEvent.mouseDown` instead for the new mobile-layout test.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed two Train test files' FakeWorker mocks that crashed on the new progressPort handoff**
- **Found during:** Task 3, running the full frontend test suite as part of the plan-level `<verification>` gate
- **Issue:** `useStockfishEngine.ts`'s new `progressPort` wiring calls `worker.postMessage({ progressPort: port2 }, [port2])` before the `uci` handshake. Two pre-existing test files (`Train.solveLoop.test.tsx`, `TrainSolveScreen.test.tsx`, including its `MultiRankFakeWorker`/`ScriptedFenFakeWorker` variants) define their own `FakeWorker` classes typed `postMessage(msg: string)` that call `msg.startsWith(...)` unconditionally — a non-string payload threw `TypeError: msg.startsWith is not a function`, crashing 54 tests across the two files.
- **Fix:** Widened each `postMessage` signature to `string | { progressPort: unknown }` and added an early `if (typeof msg !== 'string') return;` guard, mirroring the ignore-non-string convention already established by `workerPool.test.ts`'s own mock.
- **Files modified:** `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`, `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx`
- **Verification:** Both files' full suites pass (72 tests); mutation reverted to confirm the fix, not a coincidental pass.
- **Committed in:** `8e340d628` (Task 3 commit)

**2. [Rule 1 - Bug] Cleared localStorage in Train.solveLoop.test.tsx's afterEach**
- **Found during:** Task 3, same full-suite run
- **Issue:** `markEngineAssetReady('stockfish-wasm')` (called on `readyok`, Task 3's own new code) writes a real `flawchess.engineAsset.seen.stockfish-wasm` key to `localStorage`. `Train.solveLoop.test.tsx`'s `afterEach` already cleared `sessionStorage` but never `localStorage`, so the flag written by an earlier test in the file leaked into a later test's `expect(localStorage.length).toBe(0)` assertion (a pre-existing regression-proof for an unrelated bug, 260728-tgc).
- **Fix:** Added `localStorage.clear()` alongside the existing `sessionStorage.clear()` in the file's `afterEach`.
- **Files modified:** `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`
- **Verification:** The affected test passes; full file (7 tests) green.
- **Committed in:** `8e340d628` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs — both test-only regressions from Task 3's own new production code, caught by the plan's mandated full-suite verification gate).
**Impact on plan:** No production-code scope creep; both fixes are test-file-only and necessary for the plan's own `<verification>` requirement (full frontend suite green) to hold. Neither touches a file owned by the concurrent 213-04 sibling agent.

## Issues Encountered

- **Pre-existing flaky test, unrelated to this plan:** `Train.guestGate.test.tsx`'s "REGRESSION (260728-tgc)"-adjacent case (`btn-signup-for-train` `waitFor`) fails under the full parallel `npm test -- --run` but passes standalone. Verified NOT caused by this plan's changes: stashed all Task 3 diffs and re-ran the full suite twice against the unmodified base — the identical failure reproduced both times. Matches the project's documented "Heavy frontend test timeout flake" memory note (two independent timeout ceilings under load). Left untouched — out of this plan's scope, and fixing a flake unrelated to Task 3's own files would be scope creep.

## Known Stubs

None — every artifact this plan produces is production-quality, wired end to end, with no placeholder data.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All three `EngineLinesSkeleton` mount sites plus the Maia chart skeleton are live-wired to the shared `engineAssetProgress` store; no further Phase 213 plan needs to touch these render sites.
- `useFlawChessEngine.isReady` and `useStockfishEngine`'s `stockfish-wasm` reporting are both real end to end — no known follow-up work in this phase.
- The manual/real-device verification rows already logged in `213-VALIDATION.md` (Slow-4G cold-cache passes for blend-0/blend>0 personas) remain the only open items in this phase, and are explicitly out of this plan's scope (Bots page, not Analysis).

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*

## Self-Check: PASSED

- All 12 modified files verified present via `git diff --stat` against the base commit (no accidental deletions).
- All three task commits (`5fc9f1545`, `0bd537ef8`, `8e340d628`) verified present in `git log --oneline --all`.
- Re-ran acceptance-criteria greps: `grep -c "assetProgress=" frontend/src/pages/Analysis.tsx` → `3`; `grep -n "setIsReady(true)"`/`"whenReady"` in `useFlawChessEngine.ts` confirm the guarded-Promise.all shape; `progressPort`/`postMessage('uci')` ordering confirmed in `useStockfishEngine.ts`.
- `git diff --stat` against base for `engineAssetProgress.ts`, `useEngineAssets.ts`, and the vendored `stockfish-18-lite-single.js` — all empty (no cross-plan collisions with the concurrent 213-04 sibling agent).
- Mutation-test proofs performed and reverted for: the `cancelled` guard in `useFlawChessEngine.ts` (disable-then-resolve no longer flips `isReady`), the replace-vs-append invariant in both `EngineLinesSkeleton` and the Analysis.tsx desktop/mobile parity wiring.
- Full frontend suite: `npm run lint` (0 issues), `npm run build` (exit 0), `npm run knip` (0 unused exports), `npm test -- --run` (242/243 files, 3662/3664 tests — the sole failure, `Train.guestGate.test.tsx`, reproduced identically against the unmodified base commit, confirming it predates this plan).
