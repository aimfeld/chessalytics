---
phase: 260809-jzz
plan: 01
subsystem: ui
tags: [react, typescript, chess.js, lucide-react, vitest, material-display]

requires: []
provides:
  - "computeMaterialDiff: pure per-piece-type net material computation from a FEN"
  - "MaterialDisplay: shared icon+number presentational component"
  - "PlayerBar fen prop (Analysis board material rows)"
  - "ClockDisplay fen/side props (Bots play page material rows)"
affects: [analysis-board, bots-page]

actuals:
  tokens: 5852
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "MaterialDisplay is the single shared renderer for both PlayerBar (Analysis) and ClockDisplay (Bots) — neither page re-implements the icon row"
    - "computeMaterialDiff is pure/React-free; components call it inside useMemo keyed on the FEN"

key-files:
  created:
    - frontend/src/lib/materialDiff.ts
    - frontend/src/lib/materialDiff.test.ts
    - frontend/src/components/board/MaterialDisplay.tsx
    - frontend/src/components/board/__tests__/MaterialDisplay.test.tsx
  modified:
    - frontend/src/components/board/PlayerBar.tsx
    - frontend/src/components/board/__tests__/PlayerBar.test.tsx
    - frontend/src/components/bots/ClockDisplay.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/pages/Bots.tsx

key-decisions:
  - "Per-type net material diff (D-01): trades cancel out and promotions count correctly without a special case"
  - "Only the leading side carries the +N number (D-06); both sides can still show icons on an equal-value imbalance"
  - "Icon group hidden below sm, number always visible (D-04)"
  - "Same-type icons overlap via a named negative-margin constant; different-type sub-groups stay separated by the container gap (D-07)"
  - "Malformed FEN fails closed to the zeroed structure instead of throwing (T-260809-jzz-01)"

patterns-established:
  - "New optional fen prop on a player-info component means 'no material display' when omitted — every existing call site is unaffected by default"

requirements-completed: [QUICK-JZZ]

coverage:
  - id: D1
    description: "computeMaterialDiff computes per-type net material surplus + point totals from a FEN, kings excluded, ascending piece-value ordering, malformed FEN fails closed"
    requirement: QUICK-JZZ
    verification:
      - kind: unit
        ref: "frontend/src/lib/materialDiff.test.ts (9 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "MaterialDisplay renders icons (hidden below sm) + a +N number (leading side only) for a given fen/side, and fails closed on a malformed FEN"
    requirement: QUICK-JZZ
    verification:
      - kind: unit
        ref: "frontend/src/components/board/__tests__/MaterialDisplay.test.tsx (5 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Analysis PlayerBar rows (game mode + pasted PGN) show material between name and clock, driven by the board's own FEN, behind the existing showPlayerBars gate; free play unchanged"
    requirement: QUICK-JZZ
    verification:
      - kind: unit
        ref: "frontend/src/components/board/__tests__/PlayerBar.test.tsx (2 new tests: fen -> +9, no-fen -> no material text)"
        status: pass
    human_judgment: true
    rationale: "Automated tests cover the prop contract; visually confirming the material row sits correctly between name and clock across game mode, pasted PGN, and free play in the running app needs human UAT per the plan's verification section"
  - id: D4
    description: "Bots play page clock rows (both persona-avatar and compact text-only cards) show material driven by the viewed-ply FEN, tracking board-control navigation"
    requirement: QUICK-JZZ
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/ClockDisplay.test.tsx (3 pre-existing tests, unaffected)"
        status: pass
    human_judgment: true
    rationale: "No new ClockDisplay-specific material test was added (plan's verify step reuses the existing test file); the live queen-capture/step-back/mobile-width behavior needs human UAT per the plan's verification section"

duration: 25min
completed: 2026-08-09
status: complete
---

# Quick 260809-jzz: Material Display (Net Material Difference) Summary

**Lichess-style net material difference (per-piece-type, kings excluded) computed client-side from the board FEN via chess.js, rendered as overlapping piece icons + a `+N` point total shared by the Bots clock rows and the Analysis PlayerBar rows.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3 (all completed)
- **Files modified:** 9 (4 created, 5 modified)

## Accomplishments

- `computeMaterialDiff(fen)` — pure, React-free per-piece-type material tally with ascending piece-value surplus ordering, kings excluded, and a fail-closed malformed-FEN path
- `MaterialDisplay` — the single shared icon+number component (D-05), consumed by both `PlayerBar` and `ClockDisplay`
- Analysis board: White/Black `PlayerBar` rows in game mode and pasted-PGN mode now show each side's material surplus between the name and the clock, driven by the exact FEN `ChessBoard` renders
- Bots play page: both clock cards (bot + user, persona-avatar and compact variants) show material surplus driven by `game.position` (the viewed-ply FEN), so it tracks board-control navigation, not just the live ply
- Mobile (`<sm`): icon group hidden, only the `+N` number renders (D-04)

## Task Commits

Each task was committed atomically, following the RED/GREEN TDD cycle where specified:

1. **Task 1: computeMaterialDiff** (tracer, tdd=true)
   - `e41d69921` test(260809-jzz): add failing test for computeMaterialDiff (D-01/D-06)
   - `9c31518b5` feat(260809-jzz): implement computeMaterialDiff (D-01/D-06)
2. **Task 2: MaterialDisplay + Analysis PlayerBar integration** (tdd=true)
   - `1dbd5e8cf` test(260809-jzz): add failing tests for MaterialDisplay + PlayerBar fen prop (D-04/D-05/D-06)
   - `8e6f997c2` feat(260809-jzz): MaterialDisplay component + Analysis PlayerBar integration (D-02/D-04/D-05/D-06/D-07)
3. **Task 3: Bots play page clock rows**
   - `267927b2c` feat(260809-jzz): Bots play page clock rows show material surplus (D-02/D-05/D-08)

**Plan metadata:** committed separately by the orchestrator (docs commit not included here per this quick task's constraints).

## Files Created/Modified

- `frontend/src/lib/materialDiff.ts` — pure per-type material computation (created)
- `frontend/src/lib/materialDiff.test.ts` — 9 Vitest cases (created)
- `frontend/src/components/board/MaterialDisplay.tsx` — shared icon+number component (created)
- `frontend/src/components/board/__tests__/MaterialDisplay.test.tsx` — 5 Vitest cases (created)
- `frontend/src/components/board/PlayerBar.tsx` — new optional `fen` prop, wraps name span + `MaterialDisplay` in a left group
- `frontend/src/components/board/__tests__/PlayerBar.test.tsx` — 2 new cases (fen -> +9, no-fen -> no material text)
- `frontend/src/components/bots/ClockDisplay.tsx` — new optional `fen`/`side` props, left-group restructure for both the persona-avatar and compact card branches
- `frontend/src/pages/Analysis.tsx` — `playerBar()` helper feeds `fen={position}` through (unchanged `showPlayerBars` gate)
- `frontend/src/pages/Bots.tsx` — both `ClockDisplay` instances pass `fen={game.position}` and their respective `side`

## Decisions Made

None beyond the plan's locked decisions (D-01 through D-08) — followed as specified. One small implementation-level addition not called out explicitly in the plan: `MaterialDisplay` also carries an inner `data-testid="material-{side}-icons"` on the icon sub-group (in addition to the required outer `material-{side}` testid) so the sm-breakpoint-hidden assertion in `MaterialDisplay.test.tsx` has a stable DOM hook; this is a test-scaffolding detail, not a behavior change.

## Deviations from Plan

None — plan executed exactly as written. One mechanical gotcha handled inline (not a deviation): the plan's Task 2 verify step greps `playerBar(` in `Analysis.tsx` expecting a count of 7; my first comment above the new `fen={position}` prop line contained the literal substring `playerBar(` (in prose), which bumped the grep to 8. Reworded the comment to avoid the substring — no functional change, count now matches the plan's expected 7.

## Issues Encountered

- The worktree had no `node_modules` (fresh checkout) — ran `npm install` before any test/lint/build command. Not a deviation, just required setup.

## User Setup Required

None — no external service configuration required.

## Human UAT (from the plan's `<verification>` section — not self-approved)

1. Bots page — play a game, win a queen: the user's clock card shows a queen icon and `+9`, the bot's card shows nothing. Trade evenly: both clear.
2. Bots page — step back through the move list with the board controls; the material follows the viewed position, not the live one.
3. Analysis in game mode — open an imported game, scrub the move list; both player rows track the board. Analysis with a pasted PGN — same.
4. Analysis free play — no material anywhere.
5. At 375px width both pages show the `+N` number with no piece icons.

All automated verification (unit tests, lint, knip, `tsc -b`) is green; the above five items require a human to actually look at the running app and were NOT exercised in this session.

## Next Phase Readiness

Feature is self-contained and complete. No blockers. `computeMaterialDiff` and `MaterialDisplay` are now available for any future surface (e.g. a game-review summary) that wants the same material display without re-implementing it.

---
*Phase: 260809-jzz*
*Completed: 2026-08-09*

## Self-Check: PASSED

All 8 created/modified files verified present; all 5 task commits (e41d69921, 9c31518b5, 1dbd5e8cf, 8e6f997c2, 267927b2c) verified in git log.
