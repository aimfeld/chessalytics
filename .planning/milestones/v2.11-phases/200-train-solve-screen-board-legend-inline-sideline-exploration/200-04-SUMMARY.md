---
phase: 200-train-solve-screen-board-legend-inline-sideline-exploration
plan: 04
subsystem: ui
tags: [react, typescript, vitest, chessboard, stockfish]

# Dependency graph
requires:
  - phase: 200-03
    provides: "useTrainExploration state model, second Stockfish instance, staleness-guarded explorationPvLines — this plan renders on top of that state"
provides:
  - "TrainExplorationLine — a fully controlled single-chain SAN move list (no internal index state, index arrives as a prop)"
  - "The isExploring swap inside TrainReveal: line boxes + Also fine row give way to a Stockfish engine-lines card (EngineLines, reused verbatim) plus TrainExplorationLine, with the guess verdict/outcome/banner and game footer staying pinned outside the swap"
  - "PV click-to-play wiring: EngineLines' onMoveClick feeds exploration.playLine directly"
affects: []

# Actuals (#2632)
actuals:
  tokens: 8442
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Controlled move-list component (no internal index state) as the structural fix for a content-keyed-reset bug: TrainExplorationLine takes `index` as a prop and reports every navigation through `onJumpTo`, so it can never snap back to 0 the way TrainLineStepper's own reset effect would on every appended move"
    - "Swap-in surface extracted to its own typed render function (TrainExplorationPanel) taking `exploration: TrainExplorationState` as a required prop, called only from `isExploring && exploration ? ... : ...` — avoids depending on TypeScript's unreliable closure-narrowing of an optional prop inside nested JSX callbacks"
    - "Engine surface reused verbatim across pages: TrainReveal imports EngineLines/EngineLinesSkeleton/MAX_LINES directly from the Analysis page's own module rather than forking, so the Train exploration card and the Analysis engine card stay bit-identical"

key-files:
  created:
    - frontend/src/components/train/TrainExplorationLine.tsx
    - frontend/src/components/train/__tests__/TrainExplorationLine.test.tsx
  modified:
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "TrainExplorationPanel is a plain function component (not inline JSX) taking `exploration: TrainExplorationState` as a required, non-optional prop — the ternary `isExploring && exploration ? <TrainExplorationPanel exploration={exploration} .../> : (...)` narrows `exploration` at the call site rather than relying on TS to preserve that narrowing inside a nested `onMoveClick` arrow function, which is not guaranteed across closure boundaries."
  - "The exploration engine card's CardHeader reads plainly 'Stockfish' with no depth/toggle chrome — unlike Analysis.tsx's own engine card, this one has no on/off state (it exists exactly while `isExploring` is true), so the toggle UI has no equivalent need here."
  - "TrainReveal.test.tsx and TrainSolveScreen.test.tsx render trees are now wrapped in `TooltipProvider` (previously absent in both files) — `EngineLines`' PV-chip hover-preview `Tooltip` throws outside one, but this only surfaces once a PV line replays to a valid `previewFen`, a scenario neither file exercised before this plan's exploration-card tests."

patterns-established:
  - "A swap-in surface that reuses another page's card verbatim imports that card's exported constants (MAX_LINES) and skeleton (EngineLinesSkeleton) rather than re-deriving row counts or loading chrome locally — keeps the two surfaces visually identical by construction, not by convention."

requirements-completed: [EXPLORE-03, EXPLORE-07, LEGEND-06]

coverage:
  - id: D1
    description: "The instant exploration starts, the reveal line boxes and the Also fine row give way to a Stockfish engine-lines card plus a move list of the explored line — no Maia card and no FlawChess engine card anywhere on the Train screen."
    requirement: "EXPLORE-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#while exploring, the line boxes and Also fine row are absent and the exploration surface renders instead"
        status: pass
      - kind: other
        ref: "grep -c \"MaiaCard\\|FlawChessEngineLines\" TrainReveal.tsx == 0"
        status: pass
      - kind: other
        ref: "grep -c \"from '@/components/analysis/EngineLines'\" TrainReveal.tsx == 1 (imported, not reimplemented)"
        status: pass
      - kind: other
        ref: "git diff --quiet against merge-base -- EngineLines.tsx (unchanged — reused verbatim, not forked)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The reveal panel's header block (guess verdict, outcome copy, flaw-fixed banner) and the game footer stay pinned on screen throughout exploration; only the boxes and the Also fine row are replaced (D-10)."
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#D-10: the guess verdict and the game footer stay pinned while exploring"
        status: pass
    human_judgment: false
  - id: D3
    description: "The exploration move list is a single clickable chain (SAN tokens plus prev/next, current ply highlighted, no branching), fully controlled by its index prop with no internal index state — an appended move can never snap it back to the start."
    requirement: "EXPLORE-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainExplorationLine.test.tsx (9 cases, including the append-without-reset Pitfall 2 regression guard)"
        status: pass
      - kind: other
        ref: "grep -c useState TrainExplorationLine.tsx == 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Clicking a Stockfish PV move plays that line's prefix up to and including the clicked move into the exploration chain, truncating any tail first, and moves the shared board (D-14)."
    requirement: "EXPLORE-03"
    verification:
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#starting exploration swaps in the engine card + move list; clicking a PV move plays it into the exploration line and moves the board"
        status: pass
    human_judgment: false
  - id: D5
    description: "PV lines render in the engine's own multipv order, best line first, unchanged from the Analysis page."
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#PV lines render in the supplied multipv order (best line first)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Exploring into a position with no legal continuation (or before the first search resolves) renders the engine card's empty/loading skeleton rather than crashing, and the move list still allows stepping back."
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#shows the engine-lines skeleton when explorationPvLines is empty, and EngineLines once it is not"
        status: pass
    human_judgment: false
  - id: D7
    description: "Every interactive element added by this plan carries a kebab-case data-testid, and every icon-only control carries an aria-label."
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainExplorationLine.test.tsx#both chevron buttons carry a non-empty aria-label"
        status: pass
      - kind: other
        ref: "source assertion: btn-train-exploration-prev/-next, train-exploration-token-{i}, train-exploration-line, train-exploration-engine-card, train-reveal-exploration all carry data-testid"
        status: pass
    human_judgment: false
  - id: D8
    description: "(Backstop) Two PV lines that transiently share a first move render as two separate rows and each remains independently clickable, with no dedupe introduced."
    verification:
      - kind: other
        ref: "git diff --quiet against merge-base -- EngineLines.tsx (unchanged) — EngineLines.test.tsx's own pre-existing multi-line coverage still applies unmodified since the component this plan renders is byte-identical to the Analysis page's"
        status: pass
    human_judgment: false
  - id: D9
    description: "(Backstop) The legend spotlight, the Also fine row, and the exploration swap all render and remain operable in the mobile below-board layout at 375px."
    requirement: "EXPLORE-07 / LEGEND-06 (pixel half)"
    verification: []
    human_judgment: true
    rationale: "jsdom has no layout engine — it cannot detect overflow, measure tap targets, or verify composited font size/color at a real 375px viewport. Carried to the phase's end-of-phase 'Human Verification Required' browser pass (15 steps, desktop + 375px), which is non-blocking for execution but is a mandatory pre-squash-merge item per the plan's own instructions. Recorded as WINDOWS.md entry #3 (kind unrun-verify) so it surfaces at ship time."

# Metrics
duration: ~35min
completed: 2026-08-01
status: complete
---

# Phase 200 Plan 04: Train Solve Screen — Exploration Engine Card & Move List Summary

**The post-verdict sideline now renders a real UI: a Stockfish engine-lines card (reused verbatim from the Analysis page) plus a fully controlled `TrainExplorationLine` move list swap in for the reveal boxes the instant exploration starts, with the guess verdict and game footer staying pinned, and clicking a PV move plays it straight into the sideline.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-08-01T15:11Z (approx., first file read)
- **Completed:** 2026-08-01T15:24Z
- **Tasks:** 2
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `TrainExplorationLine` lands as a genuinely new, fully controlled component — no internal `useState` for its index — modeled on `TrainLineStepper`'s interaction shape (prev/next chevrons, clickable SAN tokens, active-token highlight) but deliberately without its content-keyed reset effect, since that effect is exactly the append-triggered snap-back Pitfall 2 warns against. 9 unit tests cover every behavior bullet, including the append-without-reset regression guard.
- `TrainReveal`'s render tree gains a single ternary — `isExploring && exploration ? <TrainExplorationPanel .../> : (...)` — that replaces ONLY the line boxes, the standalone SAN-only game box, and the Also fine row. The guess verdict, outcome copy, flaw-fixed banner, reveal-error line, and game footer sit outside the ternary and stay pinned throughout exploration (D-10), keeping the just-earned result on screen while branching.
- The exploration engine card reuses `EngineLines`/`EngineLinesSkeleton`/`MAX_LINES` verbatim from the Analysis page's own module — not forked, not edited (verified by a `git diff` gate against the phase's merge-base) — so the Train exploration card and the Analysis engine card are visually identical by construction. `onMoveClick` wires directly to `exploration.playLine`, which already carries the truncate-then-append semantics D-13/D-14 need with zero new logic.
- `TrainSolveScreen` threads the five new props (`isExploring`, `exploration`, `explorationPvLines`, `explorationIsAnalyzing`, `explorationFen`) through to `TrainReveal` and drops the interim `void explorationPvLines;` statement plan 200-03 deliberately left behind — the staleness-guarded PV lines are now actually rendered, closing that plan's documented deferral.
- No Maia card and no FlawChess engine card anywhere in the exploration swap (EXPLORE-03) — verified by a grep gate against both component names in `TrainReveal.tsx`.

## Task Commits

Each task was committed atomically:

1. **Task 1: TrainExplorationLine — a fully controlled single-chain move list** - `dd2407ae` (feat)
2. **Task 2: Swap the reveal body for the engine card + move list, wire PV click-to-play** - `a9d6d157` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `frontend/src/components/train/TrainExplorationLine.tsx` (new) - Controlled SAN move list: `moves`/`startFen`/`index`/`onJumpTo` props, no internal state, `deriveSanTokens` replay idiom mirroring `TrainLineStepper`'s `replayLine`
- `frontend/src/components/train/__tests__/TrainExplorationLine.test.tsx` (new) - 9 tests: token rendering/active-marking, prev/next disable boundaries, click-to-jump mapping, the append-without-reset regression guard, malformed-UCI break-not-crash, aria-labels
- `frontend/src/components/train/TrainReveal.tsx` - `TrainExplorationPanel` helper component; five new `TrainRevealProps` fields (`isExploring`, `exploration`, `explorationPvLines`, `explorationIsAnalyzing`, `explorationFen`); the render-tree ternary replacing sections 4/4a/4b; new imports (`EngineLines`, `EngineLinesSkeleton`, `MAX_LINES`, `TrainExplorationLine`, `TrainExplorationState`, `PvLine`)
- `frontend/src/components/train/TrainSolveScreen.tsx` - Drops the interim `void explorationPvLines;`; passes the five new props to `<TrainReveal>`
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` - `TooltipProvider` wrapping (new requirement once a PV chip's hover-preview tooltip renders); `makeExplorationState`/`makePvLine` fixtures; 4 new tests (swap presence/absence, D-10 pinned header/footer, skeleton-vs-EngineLines, multipv order)
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` - `TooltipProvider` wrapping; 1 new end-to-end test (solve → start exploration → click an engine PV chip → board and move list both advance)

## Decisions Made

- `TrainExplorationPanel` is a dedicated function component rather than inline JSX so `exploration: TrainExplorationState` can be a required prop — this sidesteps depending on TypeScript's closure-narrowing of an optional prop (`exploration?: TrainExplorationState`) inside a nested `onMoveClick` arrow function, which is not reliably preserved across closure boundaries.
- The exploration engine card's header reads plainly "Stockfish" with no depth/toggle chrome, since (unlike Analysis.tsx's own card) it has no on/off state — it exists exactly while `isExploring` is true.
- Both reveal test files now wrap their render trees in `TooltipProvider` — previously absent, but `EngineLines`' PV-chip hover-preview tooltip throws outside one, and this plan's tests are the first in either file to render a PV line with a valid `previewFen`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `TooltipProvider` wrapping to `TrainReveal.test.tsx` and `TrainSolveScreen.test.tsx`**
- **Found during:** Task 2 (writing the multipv-order test)
- **Issue:** `EngineLines`' PV move chip wraps in a Radix `Tooltip` for its hover-preview miniboard whenever a move replays to a valid FEN. Neither test file previously rendered a real PV line with a resolvable `baseFen`, so this codepath was never exercised — the first test to do so threw `Tooltip must be used within TooltipProvider`.
- **Fix:** Wrapped both `renderReveal`'s render call and every `rerender(...)` call (5 sites) in `TrainReveal.test.tsx`, and `renderScreen`'s `Harness` render in `TrainSolveScreen.test.tsx`, in `TooltipProvider` — matching `App.tsx`'s real production tree, which already wraps the whole app.
- **Files modified:** `frontend/src/components/train/__tests__/TrainReveal.test.tsx`, `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx`
- **Verification:** Both full test files pass (50/50 and 39/39); full frontend suite (3040 tests) still green.
- **Committed in:** `a9d6d157` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to exercise the new PV-click coverage at all; no scope creep — the fix only adds a context provider the real app already has.

## Issues Encountered

None beyond the `TooltipProvider` fix above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

This is the last plan of Phase 200. All four requirements this plan owns (EXPLORE-03's DOM half, EXPLORE-07's DOM half, LEGEND-06's DOM half) are automated-test green. The one item this plan cannot close itself:

- **End-of-phase browser pass (non-blocking, but mandatory pre-squash-merge):** the plan's own "Human Verification Required" section (15 steps, desktop + 375px) covers what jsdom structurally cannot — real pixel layout, hover feel, and tap-target ergonomics for LEGEND-06's spotlight and EXPLORE-07's mobile below-board exploration swap. Recorded as `WINDOWS.md` entry #3 (`kind: unrun-verify`, phase 200) so it surfaces at `/gsd-ship` time rather than being silently dropped. An operator must run it (dev server + `/train`, per the plan's 15-step checklist) and record "approved" or the issues found in the phase `VERIFICATION.md` before the phase is squash-merged to `main`.
- Full frontend gate is green: `npm run lint`, `npm run knip`, `npm run build` (tsc -b), and `npm test -- --run` (3040 tests) all pass with this plan's changes included.

---
*Phase: 200-train-solve-screen-board-legend-inline-sideline-exploration*
*Completed: 2026-08-01*

## Self-Check: PASSED

All 6 created/modified key files exist on disk; both task commits (`dd2407ae`, `a9d6d157`) verified present in git log.
