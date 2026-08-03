---
phase: quick
plan: 260803-iv6
subsystem: ui
tags: [react, typescript, stockfish, train, chess-board, vitest]

# Dependency graph
requires:
  - phase: 200-train-solve-screen
    provides: TrainSolveScreen, TrainReveal, the reveal panel's line boxes and guess card
  - phase: 191-train-habit-loop
    provides: TrainFlawFixedBanner, the mastered-item celebration
provides:
  - A live Stockfish eval bar beside the Train board, matching the analysis board's Stockfish bar styling
  - A fix for a latent useStockfishEngine debounce bug (same-value bailout stranding the eval at neutral)
  - The "Flaw fixed!" banner as the first card in the reveal panel
  - guessFeedbackProse() — locked prose sentences explaining each guess/verdict/source combination
  - Reworded Train schedule QR-code heading
affects: [train, analysis-eval-bar-consumers]

# Actuals (#2632)
actuals:
  tokens: 11300
  tasks: 4
  commits: 6

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Nonce-tagged debounce state ({ fen, nonce }) to force effect re-firing past React's same-value setState bailout"
    - "Standalone useStockfishEngine instance gated on the same showResultRow flag the consuming panel uses, disabled during a sibling free-play engine's ownership window"

key-files:
  created: []
  modified:
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/hooks/useStockfishEngine.ts
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/lib/trainGuessLabels.ts
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx

key-decisions:
  - "Fixed the useStockfishEngine debounce same-value bug in the shared hook rather than working around it in TrainSolveScreen — the bug is real and would affect any future consumer whose FEN prop can oscillate back to a superseded value inside the 150ms debounce window (Rule 1 auto-fix)"
  - "Updated Train.solveLoop.test.tsx's shared-fakeWorker goCount assertions to account for the eval bar's own legitimate go on a restored/cached solved reveal, rather than special-casing the eval bar to skip restored puzzles"

patterns-established:
  - "A standalone useStockfishEngine instance can safely coexist with useTrainFreePlay's own instance by gating enable/disable on isExploring — exactly one FEN-driven Stockfish worker is alive at a time for the shown position"

requirements-completed: []

coverage:
  - id: D1
    description: "Live Stockfish eval bar beside the Train board — present only after the reveal opens, tracks line stepping and free play, absent before grading, board width constant across the transition"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#live Stockfish eval bar"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fixed useStockfishEngine debounce same-value bailout bug (nonce-tagged debounce state)"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useStockfishEngine.test.ts and useStockfishEngine.integration.test.ts (full suite, unchanged, still passing)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#follows the board through reveal-line stepping — the SAME FEN the ChessBoard renders drives the bar"
        status: pass
    human_judgment: false
  - id: D3
    description: "Flaw fixed! banner hoisted to the first card in the reveal panel, above Your-move and guess card, both viewports"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#the flaw-fixed banner is the FIRST card in the panel — above the Your-move box and the guess card"
        status: pass
    human_judgment: false
  - id: D4
    description: "guessFeedbackProse() renders the five locked sentences in the guess card body; null guess renders none; spotlight wiring unaffected"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#guessFeedbackProse and the six render/spotlight-isolation tests"
        status: pass
    human_judgment: false
  - id: D5
    description: "Train schedule QR heading reads 'Reminders work better with FlawChess on your phone'"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx (4 updated assertions)"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-08-03
status: complete
---

# Quick Task 260803-iv6: Puzzle Solution Screen — Eval Bar, Flaw-Fixed Card, Guess Prose Summary

**Live Stockfish eval bar on the Train solve screen (mirroring the analysis board's), plus a debounce bug fix in `useStockfishEngine`, the "Flaw fixed!" banner hoisted to the top of the reveal panel, locked prose in the guess card, and a reworded Train schedule QR heading.**

## Performance

- **Duration:** ~45 min (includes investigating and fixing a pre-existing `useStockfishEngine` debounce bug surfaced by Task 1's test scenario)
- **Completed:** 2026-08-03
- **Tasks:** 4 (Task 3 ran RED → GREEN as a two-commit TDD cycle)
- **Files modified:** 9

## Accomplishments

- A blue-framed vertical eval bar sits right of the Train board once the reveal opens (`train-eval-bar`), styled exactly like the analysis board's Stockfish bar (`STOCKFISH_ACCENT`, `w-5`, `gap-2`). It tracks `displayFen` through reveal-line stepping and reads the free-play engine's own top line while exploring (no second concurrent search). The board column reserves the bar's width from the start so the reveal never resizes the board.
- **Found and fixed a real latent bug** in `useStockfishEngine`'s adaptive debounce: when the hook's `fen` prop oscillates back to a value already held in its internal `debouncedFen` state (which happens naturally whenever a puzzle's exact-match played move coincides with the reveal line's first step — a common case), React's `Object.is` same-value bailout silently dropped the re-analysis while the eval had already been reset to `null`, leaving the bar permanently stuck at the neutral midpoint. Fixed by tagging the debounce state with a monotonic nonce (`{ fen, nonce }`) so the downstream analyze effect always re-fires on intent, not string identity.
- The "Flaw fixed!" mastery-celebration banner is now the first card in the reveal panel (above the Your-move box and the guess card, both viewports) instead of the third.
- `guessFeedbackProse()` in `trainGuessLabels.ts` derives one locked sentence explaining what the guess verdict means from `(guess, correct_guess, puzzle_type !== 'herring')`, rendered as the first line of the guess card body.
- The Train schedule card's QR-code heading now reads "Reminders work better with FlawChess on your phone" instead of "Use FlawChess on your phone".

## Task Commits

1. **Task 1: Live Stockfish eval bar beside the Train board** — `1ef7a8197` (feat) — includes the `useStockfishEngine` debounce fix and a `Train.solveLoop.test.tsx` assertion update
2. **Task 2: Hoist the "Flaw fixed!" banner to the top of the reveal panel** — `2fe708dfb` (feat)
3. **Task 3: Prose feedback in the guess-feedback card** — RED `ebfefc3c0` (test) → GREEN `2627a83d4` (feat)
4. **Task 4: Reword the QR-code heading in the Train schedule card** — `b12d98387` (feat)

## Files Created/Modified

- `frontend/src/components/train/TrainSolveScreen.tsx` — eval bar wiring, board row restructure (flex row + reserved bar column), `resolveTrainEvalBarReading()` helper, `TRAIN_EVAL_BAR_CHROME_PX`/`TRAIN_TERMINAL_EVAL_DEPTH` constants
- `frontend/src/hooks/useStockfishEngine.ts` — nonce-tagged internal debounce state (`debouncedTarget`) fixing the same-value bailout bug
- `frontend/src/components/train/TrainReveal.tsx` — banner hoisted to first child; `guessFeedbackProse()` wired into the guess card body
- `frontend/src/lib/trainGuessLabels.ts` — new `guessFeedbackProse()` export
- `frontend/src/components/train/TrainScheduleSettings.tsx` — reworded heading + stale-quote comment fix
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — 3 new eval-bar tests, 3 updated worker-count tests (eval bar's own Worker), 1 updated DOM-nesting assertion
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` — 1 new banner DOM-order test, 11 new guess-prose tests (5 unit + 6 render/spotlight)
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` — 4 updated exact-text assertions
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — 2 updated `goCount` assertions (a restored/cached solved reveal now legitimately fires one `go` from its own eval bar)

## Decisions Made

- **Fixed the `useStockfishEngine` debounce bug in the shared hook, not worked around in `TrainSolveScreen`.** The bug (same-value `setDebouncedFen` bailout stranding the eval at neutral) is a correctness defect in the hook itself, not specific to the eval bar — any future consumer whose `fen` prop revisits a superseded value within the 150ms debounce window would hit it. Rule 1 auto-fix: discovered while writing Task 1's own tests, verified by reverting the fix and confirming the stepping test times out again.
- **Updated `Train.solveLoop.test.tsx`'s `goCount` assertions rather than special-casing the eval bar to skip restored/cached puzzles.** A restored solved reveal already has a landed verdict (`showResultRow` true from mount), so per Task 1's spec the eval bar legitimately runs its own analysis there — the pre-existing test's "no mount grading search" assertion was really only ever about the *grading* engine, and the eval bar is a new, distinct consumer sharing the harness's single fake-Worker stub.
- **Placed Task 3's new tests inside `TrainReveal.test.tsx`** (both the `guessFeedbackProse()` unit tests and the render tests) rather than creating a new `trainGuessLabels.test.ts` file — the plan's `files_modified` list only names the three existing `__tests__` files, and `trainGuessLabels.ts` is a small, tightly-coupled companion module to `TrainReveal`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a same-value `setState` bailout bug in `useStockfishEngine`'s FEN debounce**
- **Found during:** Task 1, while writing the "follows the board through reveal-line stepping" test
- **Issue:** When a puzzle's played move coincides with the reveal line's own first step (the exact-match case), the eval bar's `fen` prop transitions puzzle-fen → post-move-fen → puzzle-fen → post-move-fen in quick succession right around verdict-landing. The second occurrence of a FEN value that was already the pending `debouncedFen` state hit React's `Object.is` bailout: `setDebouncedFen(fen)` became a no-op even though the SAME effect run had already reset `evalCp`/`pvLines` to `null` — permanently stranding the bar at the neutral midpoint for that position.
- **Fix:** Wrapped the internal debounce target in `{ fen, nonce }` (a fresh object literal on every fen-effect run via a stable `useCallback` setter), and changed the downstream analyze effect's dependency from the derived `debouncedFen` string to the `debouncedTarget` object, so the effect always re-fires on intent regardless of value coincidence.
- **Files modified:** `frontend/src/hooks/useStockfishEngine.ts`
- **Verification:** Reverted the fix locally and confirmed the stepping test times out (evalCp stuck null) with the old code; reinstated and confirmed pass. Full `useStockfishEngine` unit/integration suites (117 tests across the hook and its 4 other real consumers — Analysis.tsx, MovesByRatingChart, EngineLines, useTrainFreePlay) still pass unchanged.
- **Committed in:** `1ef7a8197` (Task 1 commit)

**2. [Rule 1 - Bug, test-only] Updated `Train.solveLoop.test.tsx`'s `goCount` assertions**
- **Found during:** Task 1, full-suite regression run
- **Issue:** A restored/cached solved reveal test asserted `fakeWorker.goCount === 0` ("no mount grading search"), sharing a single fake-Worker singleton across every `useStockfishEngine`/grading-engine instance in the harness. The new eval bar legitimately issues its own `go` for a restored reveal (its `showResultRow` gate is already true at mount), bumping the shared counter to 1.
- **Fix:** Updated both `goCount` assertions (1 then 2, previously 0 then 1) with a comment explaining the shared-singleton harness and the eval bar's own contribution.
- **Files modified:** `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`
- **Committed in:** `1ef7a8197` (Task 1 commit)

**3. [Rule 3 - Blocking] Reworded a pre-existing docstring comment to avoid a literal-string collision with a `grep -c` verify check**
- **Found during:** Task 1, running the plan's own `grep -c 'useStockfishEngine' src/components/train/TrainSolveScreen.tsx  # exactly 2` verify command
- **Issue:** An existing (pre-Task-1) comment in `TrainSolveScreen.tsx` about `useTrainFreePlay`'s own Worker already contained the literal string `useStockfishEngine`, making the grep count 3 (import + call site + pre-existing comment) instead of the plan's expected 2.
- **Fix:** Reworded that one pre-existing comment line ("a second, independent useStockfishEngine —" → "a second, independent engine instance —") to preserve its meaning without the literal collision.
- **Files modified:** `frontend/src/components/train/TrainSolveScreen.tsx`
- **Committed in:** `1ef7a8197` (Task 1 commit)

**4. [Rule 3 - Blocking, DOM-nesting test fix] Updated an existing DOM-ancestry assertion for the new board-row wrapper level**
- **Found during:** Task 1, full-suite regression run
- **Issue:** The board row restructure (Task 1) added one extra flex-row wrapper level around the board (to host the new eval-bar column), breaking an existing test's `boardEl.parentElement?.parentElement` chain that located the Solution/Analyze/Next button row relative to the board.
- **Fix:** Added a third `.parentElement` hop to match the new nesting depth.
- **Files modified:** `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx`
- **Committed in:** `1ef7a8197` (Task 1 commit)

**5. [Rule 1 - Bug, ESLint] Added `setDebouncedFen` to the FEN-effect's dependency array**
- **Found during:** Task 1, `npm run lint`
- **Issue:** Wrapping `setDebouncedFen` in a `useCallback` made `react-hooks/exhaustive-deps` flag it as missing from the effect's deps array (a raw `useState` setter is trusted as stable automatically; a custom `useCallback` is not).
- **Fix:** Added `setDebouncedFen` to the deps array with a comment noting it is a stable `useCallback([])`.
- **Files modified:** `frontend/src/hooks/useStockfishEngine.ts`
- **Committed in:** `1ef7a8197` (Task 1 commit)

---

**Total deviations:** 5 auto-fixed (1 real hook bug fix, 2 test-only adjustments for the eval bar's new legitimate behavior, 1 comment reword to satisfy a plan verify grep, 1 ESLint dep-array fix)
**Impact on plan:** All auto-fixes were necessary to make Task 1's own acceptance tests pass correctly and to keep the pre-existing suite green after the eval bar's introduction. No scope creep — every fix is either the eval bar's own correctness requirement or a mechanical adjustment to an existing assertion that the eval bar's new (correct) behavior legitimately changed.

## Issues Encountered

The eval bar's live-tracking `<behavior>` requirement ("The eval bar tracks the board while stepping a line inside a reveal card") turned out to exercise a genuine, previously-latent bug in the shared `useStockfishEngine` hook rather than a bug in the new wiring itself — diagnosed via a temporary debug-log trace of `evalBarFen`/`evalCp`/`currentFen` across renders, which showed the debounce effect correctly resetting `evalCp` to `null` on every FEN transition but never re-committing a fresh value once the FEN happened to revisit an earlier (superseded) string. Fixed at the hook level (see Deviation 1) rather than avoided in `TrainSolveScreen`, since a workaround scoped to the eval bar would have left the bug live for the hook's other 4 consumers.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

All four independent frontend changes are complete, committed, and verified via the full local gate (`npm run lint`, `npm test -- --run` — 219 files / 3260 tests, `npx tsc -b`, `npm run knip`), all green. No backend/API changes, no schema changes, no new dependencies. This is a `/gsd-quick` task, not a phase — no next-phase readiness beyond "ready for the operator's own manual UAT pass in the dev app" (the plan's `<verification>` block lists 6 manual browser checks — eval bar absence/presence, resize-free reveal transition, line-stepping, free-play single-search, board-flip orientation, 375px viewport — none of which were run by this executor since they require a live browser session).

---
*Quick task: 260803-iv6*
*Completed: 2026-08-03*
