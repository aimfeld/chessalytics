---
phase: quick-260731-s0z
plan: 01
subsystem: frontend-engine
tags: [react-hooks, web-workers, stockfish, maia, sentry, chess.js]

requires: []
provides:
  - "useMaiaEngine.ts: worker-lease cleanup resets pendingFenRef/isAnalyzing/isReady (FIX-1)"
  - "Analysis.tsx: extraRootMoves resets to NO_EXTRA_ROOT_MOVES when either engine switch is off (FIX-2)"
  - "workerPool.ts: grade() resolves empty on a fully-dead pool via noLiveSlotRemains() (FIX-3)"
  - "workerPool.ts: STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS + armStopWatchdog/fireStopWatchdog bounding a never-answering stop (FIX-4)"
  - "useStockfishEngine.ts + useFlawChessEngine.ts: FEN-change effect stops/aborts the superseded search immediately, not up to RAPID_STEP_DEBOUNCE_MS later (FIX-5)"
  - "useStockfishEngine.ts: PV_COMMIT_THROTTLE_MS trailing-throttled pvLines commits (FIX-6)"
  - "maiaEncoding.ts: buildPolicyMoveContext(fen) + softmaxPolicyByContext(policy, ctx) — one legal-move context per FEN instead of per ELO rung (FIX-7)"
affects: [analysis-page, bots-page, maia-engine, stockfish-engine, worker-pool]

tech-stack:
  added: []
  patterns:
    - "Stop-watchdog re-arm (armStopWatchdog/fireStopWatchdog) mirroring an existing go-watchdog (fireWatchdog) at a tighter timeout, reusing the same dead-slot lifecycle field rather than adding a new one"
    - "Rung-invariant context object (PolicyMoveContext) built once and consumed per-rung, replacing N independent per-rung recomputations of the same legal-move enumeration"

key-files:
  created: []
  modified:
    - frontend/src/hooks/useMaiaEngine.ts
    - frontend/src/hooks/__tests__/useMaiaEngine.test.ts
    - frontend/src/pages/Analysis.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx
    - frontend/src/lib/engine/workerPool.ts
    - frontend/src/lib/engine/__tests__/workerPool.test.ts
    - frontend/src/hooks/useStockfishEngine.ts
    - frontend/src/hooks/__tests__/useStockfishEngine.test.ts
    - frontend/src/hooks/useFlawChessEngine.ts
    - frontend/src/hooks/__tests__/useFlawChessEngine.test.ts
    - frontend/src/lib/maiaEncoding.ts
    - frontend/src/lib/__tests__/maiaEncoding.test.ts
    - CHANGELOG.md

key-decisions:
  - "FIX-1's cleanup reset (pendingFenRef/isAnalyzing/isReady) mirrors the existing onFatal reset exactly, rather than inventing a different recovery shape, since both cases share the same root cause (in-flight bookkeeping surviving a lease teardown)."
  - "FIX-2's new step is labeled 2a and placed BEFORE the existing WR-01 staleness guard (2b) — a latched position must still reset when a side goes disabled, and the 2b guard itself is untouched (still required for the both-enabled case)."
  - "FIX-4 reuses PoolWorkerSlot.watchdogTimer for the stop-bestmove bound instead of adding a second timer field — the two bounds (go-watchdog, stop-watchdog) are mutually exclusive by slot state, so every existing exit path that already clears that field automatically disarms whichever bound was active."
  - "FIX-5/FIX-6 share one invariant across both engine hooks: the pending trailing pv commit / onSnapshot commit must be cleared by every path that supersedes or ends a search (FEN change, analyze()'s stop branch, both bestmove branches, worker cleanup) — documented inline at each clear site so a future change can't silently reintroduce the same defect by a different route."
  - "FIX-7 kept maskAndSoftmax/maskAndSoftmaxUci as the independent reference implementations the new parity tests compare against, extracting only a shared softmaxOverScores arithmetic helper (order-preserving) rather than reimplementing either on top of the new context-based path."

requirements-completed: [FIX-1, FIX-2, FIX-3, FIX-4, FIX-5, FIX-6, FIX-7]

coverage:
  - id: D1
    description: "FIX-1 — a Maia disable mid-inference followed by re-enable and navigation to an uncached FEN issues a real analyze() instead of being dropped at the single-in-flight gate"
    requirement: FIX-1
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useMaiaEngine.test.ts — 'a disable while an analyze is in flight, followed by re-enable, leaves a later uncached FEN analyzable again'"
        status: pass
    human_judgment: false
  - id: D2
    description: "FIX-2 — extraRootMoves resets to the shared NO_EXTRA_ROOT_MOVES sentinel when either engine switch is off, with identity preserved and engineEnabled in the effect deps"
    requirement: FIX-2
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Analysis.test.tsx — 'resets extraRootMoves to the sentinel when the Stockfish engine switch is turned off...' / '...FlawChess engine switch...' / 'keeps the SAME sentinel reference across an unrelated re-render while an engine side stays off'"
        status: pass
    human_judgment: false
  - id: D3
    description: "FIX-3 — grade() on a fully dead worker pool resolves with an empty Map instead of hanging forever"
    requirement: FIX-3
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts — 'a fresh signal-less grade() issued after every slot has died via onerror resolves empty rather than hanging'"
        status: pass
    human_judgment: false
  - id: D4
    description: "FIX-4 — a never-answering stop marks the slot dead within STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS with one static Sentry event; a healthy stop reports nothing; the last live slot dying drains pending requests"
    requirement: FIX-4
    verification:
      - kind: unit
        ref: "frontend/src/lib/engine/__tests__/workerPool.test.ts — the rewritten abort/stopAll stop-watchdog tests, the healthy-path no-capture test, and 'FIX-3 + FIX-4 composed: aborting one shared signal across every slot...'"
        status: pass
    human_judgment: false
  - id: D5
    description: "FIX-5 — neither useStockfishEngine nor useFlawChessEngine commits a superseded search's results after its own FEN-change clear, on the RAPID (debounced) navigation path"
    requirement: FIX-5
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useStockfishEngine.test.ts — 'FIX-5: stops the superseded search immediately on a RAPID FEN change...'; frontend/src/hooks/__tests__/useFlawChessEngine.test.ts — 'FIX-5: aborts the previous run immediately on a RAPID FEN change...'"
        status: pass
    human_judgment: false
  - id: D6
    description: "FIX-6 — useStockfishEngine commits at most one pvLines snapshot per PV_COMMIT_THROTTLE_MS, first info line still paints immediately, final bestmove flushes unconditionally"
    requirement: FIX-6
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useStockfishEngine.test.ts — 'FIX-6: commits at most one pvLines snapshot per throttle window, first paint immediate, final bestmove unconditional'"
        status: pass
    human_judgment: false
  - id: D7
    description: "FIX-7 — one legal-move context built per FEN instead of per ELO rung, numerically identical to the per-rung maskAndSoftmax/maskAndSoftmaxUci path on castling, en passant, all four promotion lanes, and black-to-move"
    requirement: FIX-7
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/maiaEncoding.test.ts — 'buildPolicyMoveContext / softmaxPolicyByContext' describe block (5 FEN cases + tricky combined FEN + batching-is-real test + checkmate test); frontend/src/hooks/__tests__/useMaiaEngine.test.ts CACHE-05 write-through tests unchanged"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-07-31
status: complete
---

# Quick Task 260731-s0z: Fix engine review findings from Phases 194-198 Summary

**Five permanent-wedge/stale-data bugs fixed (Maia disable-mid-inference lockup, a frozen root-move injection latch, a `grade()` hang on a fully dead worker pool, a silently-lost worker slot after a never-answering `stop`, and stale info-lines/bestmoves landing after a rapid FEN change) plus two CPU wins (throttled Stockfish pv commits, one Maia legal-move context built per FEN instead of per ELO rung) — all in the client-side engine stack shipped by Phases 194-198.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-31T18:24:00Z (approx)
- **Completed:** 2026-07-31T18:49:11Z
- **Tasks:** 4
- **Files modified:** 13

## Accomplishments

- **FIX-1 + FIX-2 (Task 1):** `useMaiaEngine.ts`'s worker-lease teardown now resets `pendingFenRef`/`isAnalyzing`/`isReady` on cleanup (mirroring the existing `onFatal` reset) — a disable mid-inference no longer permanently wedges the single-in-flight "drop and reissue" gate. `Analysis.tsx`'s root-injection effect now resets `extraRootMoves` to the shared `NO_EXTRA_ROOT_MOVES` sentinel (and clears the per-position latch) whenever either the Stockfish or FlawChess engine switch is off, instead of feeding a stale latched array into every subsequent position's search budget.
- **FIX-3 + FIX-4 (Task 2):** `workerPool.ts`'s `grade()` now also resolves empty when every constructed slot has since died (`noLiveSlotRemains()`), closing the gap where a signal-less `grade()` call (`useBotGame.ts`) hung unconditionally once the pool went fully dead. Aborting (or `stopAll`-ing) an in-flight request now arms a new `STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS` (10s) stop-bestmove watchdog instead of a bare `clearSlotWatchdog`, so a slot whose worker never answers `stop` with a terminating `bestmove` is bounded, marked dead, and reported to Sentry exactly once (static message, no interpolated FEN/UCI) rather than being lost silently forever.
- **FIX-5 + FIX-6 (Task 3):** Both `useStockfishEngine.ts` and `useFlawChessEngine.ts`'s FEN-change effects now stop/abort the superseded search immediately rather than up to `RAPID_STEP_DEBOUNCE_MS` later — closing the window where the old search's info lines, snapshots, or bestmove could commit after `currentFen` already pointed at the new position. `useStockfishEngine.ts` also throttles `pvLines`/`evalCp` commits to at most one per `PV_COMMIT_THROTTLE_MS` during a search (first info line still paints immediately; the final bestmove flushes unconditionally), cutting Analysis page re-renders from ~20-40 per search to a handful.
- **FIX-7 (Task 4):** `maiaEncoding.ts` gains `buildPolicyMoveContext(fen)` (one `Chess` construction, one `moves({verbose:true})` call) and `softmaxPolicyByContext(policy, ctx)` (one softmax pass returning both SAN-keyed and UCI-keyed distributions), sharing arithmetic with `maskAndSoftmax`/`maskAndSoftmaxUci` via an extracted `softmaxOverScores` helper. `useMaiaEngine.ts`'s `buildMaiaResult` now builds the context once per FEN and runs one softmax per ELO rung — removing 42 `new Chess(fen)` constructions / legal-move generations per Maia inference (21 rungs x 2), down to 1.

## Task Commits

1. **Task 1: FIX-1 + FIX-2 — Maia lease-cleanup wedge and the frozen extraRootMoves latch** - `51633ecf` (fix)
2. **Task 2: FIX-3 + FIX-4 — workerPool grade() hang on a fully dead pool, and the wedged 'stopping' slot** - `242ccaa1` (fix)
3. **Task 3: FIX-5 + FIX-6 — stale post-clear commits in both engine hooks, and per-info-line re-render throttling** - `7eaac67f` (fix)
4. **Task 4: FIX-7 — hoist the rung-invariant movegen out of the 21-rung Maia result build; final gate** - `4d1caacc` (perf)

**Plan metadata:** committed separately by the orchestrator (docs commit not included in the above).

## Files Created/Modified

- `frontend/src/hooks/useMaiaEngine.ts` - FIX-1 cleanup reset; FIX-7 rewritten `buildMaiaResult` (context built once per FEN)
- `frontend/src/hooks/__tests__/useMaiaEngine.test.ts` - FIX-1 regression test; existing CACHE-05 tests unchanged (proof FIX-7 preserves UCI write-through)
- `frontend/src/pages/Analysis.tsx` - FIX-2 new step 2a in the root-injection effect, `engineEnabled` added to deps
- `frontend/src/pages/__tests__/Analysis.test.tsx` - 3 new FIX-2 regression tests
- `frontend/src/lib/engine/workerPool.ts` - FIX-3 `noLiveSlotRemains()` guard in `grade()`; FIX-4 `STOP_BESTMOVE_WATCHDOG_TIMEOUT_MS` + `armStopWatchdog`/`fireStopWatchdog`
- `frontend/src/lib/engine/__tests__/workerPool.test.ts` - FIX-3 new tests; FIX-4 rewritten abort/stopAll tests + new healthy-path + composed tests
- `frontend/src/hooks/useStockfishEngine.ts` - FIX-5 stop-in-flight-on-FEN-change; FIX-6 `PV_COMMIT_THROTTLE_MS` trailing throttle + `clearPendingPvCommit`
- `frontend/src/hooks/__tests__/useStockfishEngine.test.ts` - FIX-5/FIX-6 new regression tests; fixed a pre-existing `document.visibilityState` test leak
- `frontend/src/hooks/useFlawChessEngine.ts` - FIX-5 abort + pending-timer clear in the FEN-change effect
- `frontend/src/hooks/__tests__/useFlawChessEngine.test.ts` - FIX-5 new regression test
- `frontend/src/lib/maiaEncoding.ts` - FIX-7 `buildPolicyMoveContext`/`softmaxPolicyByContext` + extracted `softmaxOverScores`
- `frontend/src/lib/__tests__/maiaEncoding.test.ts` - FIX-7 new `describe('buildPolicyMoveContext / softmaxPolicyByContext')` block
- `CHANGELOG.md` - one `[Unreleased]` Fixed bullet covering all seven fixes

## Decisions Made

- FIX-2's Analysis.tsx `NO_EXTRA_ROOT_MOVES` sentinel-identity contract (Analysis.tsx:1109-1118) was preserved exactly: the new step 2a reuses the SAME `prev === NO_EXTRA_ROOT_MOVES ? prev : NO_EXTRA_ROOT_MOVES` updater step 4 already uses, so a disabled-side re-render never destabilizes `useFlawChessEngine`'s search-restart deps.
- FIX-4's two rewritten `workerPool.test.ts` tests (abort, stopAll) intentionally change their asserted expectation from "no Sentry capture ever" to "no capture before the stop bound, exactly one static capture after it" — this is the plan's pre-declared semantics change, not an accidental regression; both were re-verified RED (old expectation) against the reverted code.
- Two new tests combined a re-enable step with a FEN-navigation step into a single rerender (`useMaiaEngine.test.ts`'s FIX-1 test) to avoid a genuine, unrelated same-FEN "reissue on reconnect" race that would otherwise confound the assertion — documented inline at the test site.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pre-existing test leak in useStockfishEngine.test.ts**
- **Found during:** Task 3, writing the FIX-5 regression test
- **Issue:** The existing "visibility hidden sends stop without terminating the Worker" test permanently redefines `document.visibilityState` via `Object.defineProperty` and never restores it; since vitest does not recreate jsdom's `document` between tests in the same file, this silently left `visibilityState` stuck at `'hidden'` for every test declared after it, blocking the new FIX-5 test's discard-branch reanalysis (gated on `document.visibilityState !== 'hidden'`).
- **Fix:** Added an explicit `Object.defineProperty(document, 'visibilityState', { value: 'visible', ... })` reset to the file's shared `beforeEach`.
- **Files modified:** `frontend/src/hooks/__tests__/useStockfishEngine.test.ts`
- **Verification:** Full file re-run green (17/17), including the pre-existing visibility test itself.
- **Committed in:** `7eaac67f` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — test-hygiene leak that prevented the new regression test from proving anything).
**Impact on plan:** No scope creep; the fix is test-only and does not touch production behavior.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Full frontend gate green: `npm run lint` (0 errors; only pre-existing `coverage/` generated-file warnings, out of scope), `npx tsc -b` (clean), `npm run knip` (clean — `maskAndSoftmax` keeps a live production call site via `Analysis.tsx`'s Moves-by-Rating chart path, plus test-file usage), `npm test -- --run` (2975/2975 passing across 205 files).
- Every fix carries a comment at the fix site explaining what broke, and every regression test was proven RED against the reverted source file before being confirmed GREEN with the fix applied (per-fix stash/pop cycles documented in the session, not just grep/symbol-presence).
- **Not measured by this task (explicitly out of scope per the plan's `<verification>` section):** FIX-4's real-world false-positive risk (watch Sentry for `stop-bestmove watchdog timeout` post-deploy), FIX-6's actual re-render-count reduction on `/analysis` (React DevTools profiler), and FIX-7's wall-clock win per Maia inference (the movegen-count reduction is proven, timing is not).
- Untouched per the plan's explicit scope boundary: `fallbackExpectimax`, `treeCommon`, `maiaQueue`, and anything under `reports/`.
- Four atomic commits ready to ship via the normal release flow whenever the next release is cut; this quick task does not itself deploy.

## Self-Check: PASSED

- FOUND: `frontend/src/hooks/useMaiaEngine.ts`
- FOUND: `frontend/src/pages/Analysis.tsx`
- FOUND: `frontend/src/lib/engine/workerPool.ts`
- FOUND: `frontend/src/hooks/useStockfishEngine.ts`
- FOUND: `frontend/src/hooks/useFlawChessEngine.ts`
- FOUND: `frontend/src/lib/maiaEncoding.ts`
- FOUND: commit `51633ecf`
- FOUND: commit `242ccaa1`
- FOUND: commit `7eaac67f`
- FOUND: commit `4d1caacc`

---
*Quick task: 260731-s0z*
*Completed: 2026-07-31*
