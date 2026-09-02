---
phase: 260902-qf7
plan: 01
subsystem: ui
tags: [react, typescript, train, chessboard, vitest]

requires: []
provides:
  - "Pristine Train reveal board draws the played-in-game arrow and its move-quality badge by default, alongside the your-move and best-move arrows"
  - "Only the server-vetted 'Also fine' alternatives remain hover/tap-only on the reveal board"
affects: [train, trainArrows, TrainSolveScreen]

actuals:
  tokens: 2356
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/lib/trainArrows.ts
    - CHANGELOG.md

key-decisions:
  - "Reversed the Phase 200 UAT hover-only rule for the played-in-game arrow only; the 'Also fine' alternatives keep the old hover/tap-only behavior unchanged."
  - "Implemented as a one-line change (adding gameMoveUci to pristineOverlayUcis) rather than a new drawing rule, matching the plan's investigation findings that the arrow/badge machinery already existed end to end."

patterns-established: []

requirements-completed: [QUICK-QF7]

coverage:
  - id: D1
    description: "On the Train reveal board (verdict landed, nothing spotlit), the played-in-game arrow and its move-quality badge are drawn alongside the your-move and best-move arrows, with no hover/tap required; the legend card still narrows the board to that single arrow on hover/tap and pointer-leave restores all three."
    requirement: QUICK-QF7
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#the pristine board draws three arrows and three badges — your-move, best-move, AND played-in-game — with no hover; hovering the game-move box still narrows to one arrow and leaving restores three (260902-qf7 reverses Phase 200 UAT)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A puzzle with no played-in-game move (played_in_game_move_uci: null — filler puzzles) draws no extra arrow or badge; the pristine board is unchanged for those."
    requirement: QUICK-QF7
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#a puzzle with no played-in-game move draws only the your-move and best-move arrows on the pristine board (filler puzzles are unaffected by 260902-qf7)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The white played-in-game arrow (0.18 width) reads clearly over the colored your/best arrows on the real board, and three simultaneous badges don't feel crowded, on both desktop and phone-width viewports."
    verification: []
    human_judgment: true
    rationale: "Automated arrow/marker counts prove the data reaches the board but cannot judge visual clarity or crowding — requires a human to look at the actual rendered board, per the plan's Task 3 checkpoint."

duration: ~20min
completed: 2026-09-02
status: complete
---

# Quick Task 260902-qf7: Train reveal played-in-game arrow shown by default Summary

**Reversed Phase 200 UAT's hover-only rule for the Train reveal's played-in-game arrow: it and its move-quality badge now draw on the pristine board by default, alongside the your-move and best-move arrows.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 2 of 3 completed (Task 3 is a human visual-UAT checkpoint, not auto-executable)
- **Files modified:** 4

## Accomplishments
- Added `gameMoveUci` to `TrainSolveScreen`'s `pristineOverlayUcis` memo, so the un-spotlit reveal board's default active set is your-move + best-move + played-in-game move, with the memo's docblock rewritten to record the reversal and its rationale.
- Corrected the now-false sentence in `applyTrainSpotlight`'s docstring (`frontend/src/lib/trainArrows.ts`) — it now names only the "Also fine" alternatives as hover-gated and reports the default active set as the your/best/game triple. No executable code in `trainArrows.ts` changed.
- Rewrote the Phase 200 UAT regression test in `TrainSolveScreen.test.tsx` that asserted the opposite contract (pristine board = exactly 2 arrows/2 markers). It now asserts: 3 arrows with no hover, 3 markers (in a `waitFor`, since the game move's badge depends on the async reveal-time engine search), hover-to-1/leave-to-3 spotlight behavior unchanged, and added a second test proving a filler puzzle (`played_in_game_move_uci: null`) still draws exactly 2 arrows/2 markers.
- Added one `### Changed` bullet to `CHANGELOG.md` under `## [Unreleased]`.

## Task Commits

Each auto-executable task was committed atomically:

1. **Task 1: Draw the played-in-game arrow and badge on the pristine reveal board** - `417cd2233` (feat)
2. **Task 2: Changelog entry and the frontend pre-merge gate** - `57d761ca7` (docs)

_Task 3 (checkpoint:human-verify) is not committed by the executor — see "User Setup Required" below._

## Files Created/Modified
- `frontend/src/components/train/TrainSolveScreen.tsx` - `pristineOverlayUcis` now includes `gameMoveUci`; docblock rewritten
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` - Phase 200 UAT test rewritten to the new 3-arrow/3-badge contract, plus a new filler-puzzle regression test
- `frontend/src/lib/trainArrows.ts` - `applyTrainSpotlight` docstring corrected (code unchanged)
- `CHANGELOG.md` - one `### Changed` bullet under `## [Unreleased]`

## Decisions Made
- Kept the change scoped to exactly the one array literal the plan's investigation identified as the sole gate (`pristineOverlayUcis`) — no new prop, arrow color, width constant, or drawing rule was introduced, per the plan's explicit "do not" list.
- Split the original single Phase-200-UAT test into two `it()` blocks (three-arrow/badge case plus the new filler-puzzle case) rather than adding a fourth `it()` for "no game move" as a completely separate describe block, since both fixtures share the same render/click/verdict setup shape as the original test.

## Deviations from Plan

None - plan executed exactly as written for Tasks 1 and 2.

## Issues Encountered
- Full frontend suite (`npm --prefix frontend test -- --run`) shows an intermittent, pre-existing timeout flake in `src/pages/__tests__/Train.guestGate.test.tsx` (a different test fails on each of two full-suite runs, both `waitFor`/testTimeout related). Confirmed **not** caused by this change: the file was untouched by this plan, and both the isolated run (`npm --prefix frontend test -- --run Train.guestGate`, with this plan's changes present) and a `git stash`-verified run against unmodified `main` pass cleanly. Consistent with the project's known "Heavy frontend test timeout flake" pattern (two independent timeout ceilings: Vitest's 5s `testTimeout` and testing-library's 1000ms `waitFor`). Out of scope per the deviation rules' scope boundary — not fixed here.
- `analysis/README.md` had a pre-existing uncommitted modification in the working tree at task start (unrelated `tilt_study` notebook entry, not part of this plan's `files_modified`). Left untouched and uncommitted.

## User Setup Required

**Task 3 (checkpoint:human-verify) is pending.** The developer needs to:
1. Start the dev server and open `/train`.
2. Solve a puzzle that came from one of your own games (reveal shows a "Played in game" line box).
3. On the reveal board with nothing hovered, confirm: the thin white played-in-game arrow is visible alongside the your-move and best-move arrows; its move-quality icon appears on its target square (may land a moment after the arrow, once the reveal-time engine search finishes); hovering (or tapping on mobile) the "Played in game" card still narrows the board to that one arrow, and leaving restores all three; the board does not feel cluttered (or note the specific adjustment wanted — thicker/thinner arrow, dropped badge, etc.); check on a phone-width viewport too.
4. Known and intended: when the game move coincides with your move or the engine's best move, the white arrow overlays that arrow concentrically and only one badge shows (higher-precedence quality wins). "Also fine" alternatives are deliberately still hover-only.

Full instructions are in the plan's Task 3 (`260902-qf7-PLAN.md`). This quick task's overall completion is contingent on the developer's sign-off here.

## Next Phase Readiness
Automated implementation and verification (unit tests, lint, type-check/build) are complete and committed. Awaiting the developer's visual sign-off on the checkpoint above before this quick task is considered fully done.

---
*Phase: 260902-qf7*
*Completed: 2026-09-02*

## Self-Check: PASSED

All 4 modified files and both task commits (`417cd2233`, `57d761ca7`) verified present on disk / in git log.
