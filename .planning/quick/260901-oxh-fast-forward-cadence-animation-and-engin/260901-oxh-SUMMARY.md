---
phase: quick-260901-oxh
plan: 01
subsystem: frontend-analysis-board
tags: [fast-forward, react-chessboard, animation, engine-suppression, eval-bar]
status: complete

requires:
  - quick-260831-s4y (the fast-forward replay this fixes)
provides:
  - FAST_FORWARD_ANIMATION_MS (derived run-scoped board animation duration)
  - useFastForward.onRunningChange (run-state push callback)
  - ChessBoardProps.animationDurationInMs (react-chessboard passthrough)
affects:
  - frontend/src/pages/Analysis.tsx (four live engine hooks, gem sweep, left eval bar)

tech-stack:
  added: []
  patterns:
    - "Derive a paired timing constant from its partner rather than writing two literals — drift between them WAS the bug."
    - "Suppress an engine via its `fen` input, never its `enabled` flag, when `enabled` owns Worker/provider lifecycle."
    - "Push run state upward through a callback when the producing hook is declared below its consumers and hooks cannot be reordered."

key-files:
  created: []
  modified:
    - frontend/src/hooks/useFastForward.ts
    - frontend/src/hooks/__tests__/useFastForward.test.ts
    - frontend/src/components/board/ChessBoard.tsx
    - frontend/src/pages/Analysis.tsx

decisions:
  - "FAST_FORWARD_ANIMATION_MS is an expression over FAST_FORWARD_STEP_MS (minus a 30ms headroom constant), not a second literal, so the animation can never again outlast the cadence."
  - "Engine suppression uses the `fen` input at all four call sites; every `enabled:` argument is byte-identical to main (DEV-1)."
  - "useStockfishGradingEngine is included as a fourth engine (DEV-2)."
  - "The gem sweep uses its `enabled` gate — unlike the live engines it has no position input of its own, and `enabled` is the only gate that also halts an already-in-flight candidate."
  - "The left eval bar holds its last LIVE fraction continuously (not a rising-edge snapshot), with terminalWhiteFraction still first in the precedence chain."
  - "The hold is stored in useState, not useRef: it is read during render and the react-hooks/refs lint rule rejects reading ref.current there (deviation D-1 below)."

metrics:
  duration: ~30 min
  completed: 2026-09-01

actuals:
  tokens: 9000
  tasks: 3
  commits: 3
---

# Quick 260901-oxh: Fast-Forward Cadence, Animation and Engine Suppression Summary

Raised the fast-forward replay to a 200ms cadence with a derived 170ms run-scoped board animation, made the first step synchronous, suppressed all four live engines plus the background gem sweep for the duration of a run, and froze the left eval bar at its last live value instead of letting it drop to the sigmoid midpoint.

## What Was Built

**Task 1 — `useFastForward` (commit `e7a54f188`)**

- `FAST_FORWARD_STEP_MS` 150 → 200. The old value was exactly half react-chessboard v5's 300ms default `animationDurationInMs`; the library's position effect is keyed on `[position]` only, so a new position arriving mid-slide snapped `currentPosition` to the still-pending `waitingForAnimationPosition` and restarted — aborting every intermediate slide at roughly half travel. That is the "skipped moves" symptom.
- Added `FAST_FORWARD_ANIMATION_MS = FAST_FORWARD_STEP_MS - FAST_FORWARD_ANIMATION_HEADROOM_MS` (headroom 30ms, module-private). Written as an expression so the "animation < step" invariant cannot silently break again.
- `start()` now calls `tick()` directly instead of scheduling it, removing the full step of dead time at the head of a run. All four pre-existing invariants (`runningRef` double-click guard, `expectedNodeIdRef` cancellation seed, `planRef` snapshot, `landed` early stop) survive because each assignment still precedes the `tick()` call; this is documented at the reordered site.
- Added optional `onRunningChange`, held in an `onRunningChangeRef` refreshed by a bare `useEffect` (mirroring the existing `tickRef` precedent) so `stop`'s identity — which feeds `tick`'s deps and the cancellation effect's deps — stays stable. `stop()` reads `runningRef` before clearing it, so `false` fires exactly once per run on every exit path.
- Tests reworked for the new call/advance ledger (each case needs one fewer advance, and the first `goToNode` assertion moved to immediately after `start()`), plus new coverage for: the synchronous first step, the `FAST_FORWARD_ANIMATION_MS < FAST_FORWARD_STEP_MS` relation (asserted as a relation, not literals), and the `onRunningChange` true/false sequence on both the landing and the cancellation exit. The re-entrant-`start()` case now also asserts that no second synchronous `goToNode` fires inside the same commit. 17 tests pass.

**Task 2 — run-scoped board animation (commit `1747d7a90`)**

- `ChessBoardProps.animationDurationInMs?: number`, forwarded verbatim into the `options` useMemo and added to its dependency array. Omitting it keeps the library's 300ms default (applied as a destructuring default in `ChessboardProvider`, which fires on `undefined`).
- `fastForwardRunning` lifted into Analysis beside the engine switch states, with a comment recording why it is lifted (the `useFastForward` call sits ~1,000 lines below the engine hooks that must read it, and hooks cannot be reordered) and why it is neither a circular dependency nor a render loop.
- `onRunningChange: setFastForwardRunning` wired into the existing `useFastForward({...})` call; `fastForward.start` / `fastForward.canFastForward` left exactly as they were on `BoardControls`.
- The single `<ChessBoard>` call site passes `animationDurationInMs={fastForwardRunning ? FAST_FORWARD_ANIMATION_MS : undefined}`, with the `undefined` branch and the 300ms-landing accepted cost both commented.

**Task 3 — engine suppression, sweep guard, eval-bar freeze (commit `fa1684a5a`)**

- All four live engines take a null `fen` while a run is in flight: `useStockfishEngine`, `useMaiaEngine`, `useFlawChessEngine`, `useStockfishGradingEngine`. One shared FAST-FORWARD SUPPRESSION comment block at the first site records the 150ms `RAPID_STEP_DEBOUNCE_MS` resonance (at a 200ms cadence `sinceLast` always exceeds the window, so the fire-immediately branch wins on every replayed ply, deterministically), the DEV-1 reason the lever is `fen` and not `enabled`, and the DEV-2 reason grading is included. The other three sites cross-reference it.
- `useGemSweep` gains `&& !fastForwardRunning` on its `enabled` condition, closing the trap where suppressing the live engines drives `liveEnginesBusy` false and thereby hands the sweep permission to run.
- Left eval bar: `maiaWhiteFraction` and `fcWhiteFraction` now return `null` instead of collapsing to the midpoint, `liveLeftWhiteFraction` derives the active one, and the precedence chain is `terminalWhiteFraction ?? (fastForwardRunning ? held : null) ?? live ?? EVAL_BAR_NEUTRAL_FRACTION`. The hold is updated from an effect keyed on `[fastForwardRunning, liveLeftWhiteFraction]`, writing only when NOT running and the live value is non-null. `EVAL_BAR_NEUTRAL_FRACTION` replaces the repeated bare `0.5`, including in `terminalWhiteFraction`'s draw case.
- `gemGrading` left alone as instructed (its `fen` is already gated on `needParentGemGrade`, which derives from live Maia output and should go idle transitively).

## Deviations from Plan

### D-1 [Rule 3 - Blocking] The left-bar hold is `useState`, not `useRef`

- **Found during:** Task 3, at the `npm run lint` gate.
- **Issue:** The plan specifies `useRef<number | null>(null)` for the held fraction. ESLint's `react-hooks/refs` rule rejects that outright: *"Cannot access refs during render"* — and the held fraction must be read during render, because it feeds `leftEvalBarWhiteFraction`. Four lint errors (the block itself plus the three `leftEvalBarNode()` render sites that transitively read it).
- **Fix:** `useState<number | null>(null)` with the identical effect-driven write. Every property the plan required is preserved: the hold is continuous (not a rising-edge snapshot), it is written from an effect rather than during render, and nothing releases it on landing.
- **Cost:** one extra render pass when the live fraction actually changes (React bails out on an `Object.is`-equal write, so it is not per-render), a handful of times per position and never during a run. Documented at the site.
- **Files modified:** `frontend/src/pages/Analysis.tsx`
- **Commit:** `fa1684a5a`

### D-2 [Rule 1 - Inaccurate justification] Corrected the gem-sweep comment's stated reason

- **Found during:** Task 3, while verifying `useGemSweep`'s `enabled` semantics before writing the comment.
- **Issue:** The plan directs the guard onto `useGemSweep`'s `enabled` on the grounds that *"`enabled` on `useGemSweep` is a dispatch gate, not a Worker-lifecycle gate, so DEV-1 does not apply here."* That justification is factually wrong: `enabled` flows into `effectiveEnabled && hasWork` → `engineEnabled`, which is the `enabled` argument of the sweep's own dedicated `useMaiaEngine` and `useStockfishGradingEngine` instances (`useGemSweep.ts:269, :290`). Turning it off does recycle those two workers.
- **Fix:** The **behaviour is exactly as planned** — no code deviation. Only the comment's reasoning was corrected, so the next reader is not misled. The comment now records the accurate reason `enabled` is nonetheless the right lever here: this hook has no position input of its own to null (its dispatch is driven internally from `enabled`); recycling those two dedicated workers is already its normal steady-state behaviour (`hasWork` tears them down the moment the last candidate resolves, per WR-02); it touches none of the live engines; and it is the only gate that also halts a candidate already in flight, whereas `liveBusy` alone would block the next dispatch but let the in-flight one run through the replay.
- **Files modified:** `frontend/src/pages/Analysis.tsx`
- **Commit:** `fa1684a5a`
- **Note for the developer:** if the once-per-run teardown/re-create of the sweep's dedicated Maia ONNX + Stockfish WASM workers ever shows up as a hitch after a landing on an unanalyzed game, the lower-impact alternative is `liveBusy: liveEnginesBusy || fastForwardRunning` (keeps both workers warm, blocks the next dispatch, lets one in-flight candidate finish). Not applied — the plan's lever is the stronger stop and the sweep is inert for analyzed games.

Everything else executed exactly as written. No architectural changes, no packages added or removed.

## Verification

```
cd frontend && npm run lint      # clean
cd frontend && npm test -- --run # see the pre-existing flake below
cd frontend && npm run build     # clean, type-checks the new optional prop across every ChessBoard caller
```

Plan `<verification>` readback, all confirmed by diff against the pre-task commit `7b15f1364`:

- The `enabled:` arguments of `useStockfishEngine`, `useFlawChessEngine` and `useStockfishGradingEngine` are byte-identical. `useMaiaEngine`'s was reformatted from a single line to multi-line but its **value** (`enabled: maiaEnabled`) is unchanged. The only semantic `enabled:` change on the page is the intended gem-sweep guard.
- `RAPID_STEP_DEBOUNCE_MS` is unchanged in all four engine hooks — those four files are untouched (empty `git diff --stat`).
- `HorizontalMoveList.tsx` is untouched.
- `FAST_FORWARD_ANIMATION_MS` is an expression over `FAST_FORWARD_STEP_MS`, not a second literal.
- `terminalWhiteFraction` is the FIRST term of the `leftEvalBarWhiteFraction` chain, ahead of the held fraction.
- The right-bar block (`rightEvalBarEvalCp`/`Mate`/`Depth`) is byte-identical to main (empty grep on the diff).

## Pre-existing Failure (NOT fixed, NOT silenced)

`src/pages/__tests__/Train.guestGate.test.tsx` — 2 of its 6 tests fail **intermittently** in the full-suite run on this machine:

```
FAIL > guest: zero /train/* requests, CTA renders, TrainStartScreen does not
  Error: Test timed out in 5000ms.
FAIL > guest: pressing the sign-up button calls logoutForPromotion() then navigates to /login?tab=register
  TestingLibraryElementError: Found multiple elements by: [data-testid="btn-signup-for-train"]
```

Established as unrelated and pre-existing:

- It **passes in isolation** (`npm test -- --run src/pages/__tests__/Train.guestGate.test.tsx` → 6/6).
- It **reproduces with this task's Analysis.tsx changes reverted** (stashed, full suite re-run → same 2 failures).
- It is **intermittent**: of four full-suite runs, one was fully green (3879/3879) and three showed these two failures.
- The Train page shares no code with the three files this task touched (`useFastForward`, `ChessBoard`, `Analysis`).

Single root cause, cascading: test 1 hits Vitest's 5000ms `testTimeout` under load, so its `afterEach(cleanup)` never runs and its DOM leaks into test 2, which then finds two copies of the button. This is the known heavy-frontend-test timeout flake pattern (two independent ceilings: Vitest's 5s `testTimeout` and testing-library's 1000ms `waitFor`). Machine load during these runs was high (transform ~50s, import ~270s). Not touched.

## Human UAT (not gating, not yet run)

On `/analysis?game_id=…` for an analyzed game with several flaws, press fast-forward from the root: a piece should move at once, every intermediate piece should visibly arrive on its destination square, and the move sounds should land on an even beat. Watch the LEFT (brown FlawChess) eval bar across the whole run — it should sit still at its pre-run level, not jump to the middle. Then fast-forward into a game that ends in checkmate and confirm the left bar fills to the winner on arrival rather than holding the stale level. Repeat on an UNANALYZED game (empty stop set, so the run travels to the final ply) and confirm the rhythm holds there too — that is the case the gem-sweep guard exists for.

## Known Stubs

None.

## Threat Flags

None. Every change is client-side render/timer/animation state inside an already-authenticated page: no new network call, no new user input parsing, no new persisted state, no backend file touched, no package added or removed.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `e7a54f188` | 200ms cadence, derived animation constant, synchronous first step, `onRunningChange` |
| 2 | `1747d7a90` | run-scoped board animation duration through ChessBoard |
| 3 | `fa1684a5a` | engine + gem-sweep suppression, left eval bar freeze |

## Self-Check: PASSED

- `frontend/src/hooks/useFastForward.ts` — FOUND
- `frontend/src/hooks/__tests__/useFastForward.test.ts` — FOUND
- `frontend/src/components/board/ChessBoard.tsx` — FOUND
- `frontend/src/pages/Analysis.tsx` — FOUND
- commit `e7a54f188` — FOUND
- commit `1747d7a90` — FOUND
- commit `fa1684a5a` — FOUND
