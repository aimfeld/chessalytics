---
phase: 200-train-solve-screen-board-legend-inline-sideline-exploration
plan: 02
subsystem: ui
tags: [react, typescript, tailwind, vitest, chessboard]

# Dependency graph
requires:
  - phase: 200-01
    provides: "applyTrainSpotlight/trainGlyphColor pure exports, ArrowGlyphIcon, useIsDesktop hook, Card/CardHeader-based reveal line boxes with spotlight"
provides:
  - "toDisplayQuality — the single presentation-collapse rule (inaccuracy -> good) in trainArrows.ts"
  - "TrainRevealOverlay.alsoFineMoves — the drawn-alternatives field consumed by the sidebar row"
  - "The compact, non-Card 'Also fine' row in TrainReveal.tsx, spotlight-wired as one entry"
affects: [200-03, 200-04]

# Actuals (#2632)
actuals:
  tokens: 8873
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single presentation-collapse function (toDisplayQuality) consumed by both the pure overlay builder and a React component's CardHeader — one rule, every drawing site reads through it"
    - "Sidebar-row derivation lives in the SAME loop that pushes board arrows (buildTrainRevealOverlay's cappedFineMoves.forEach), so a derived UI list can never drift from what it describes"

key-files:
  created: []
  modified:
    - frontend/src/lib/trainArrows.ts
    - frontend/src/lib/__tests__/trainArrows.test.ts
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "Executed as two atomic commits matching the plan's task boundaries even though the CardHeader recolor (Task 1's fifth site) and the Also fine row (Task 2) both touch TrainReveal.tsx — implemented the full combined change first, verified it end to end, then split the diff by temporarily reverting Task 2's pieces, committing Task 1, and reapplying Task 2 for its own commit."
  - "The Also fine row's hover/focus handlers live on the row container (mirroring the line-box Card's whole-card hover, D-06), not on the glyph button alone — the button only carries the click/tap toggle, exactly like LineBoxHeader's glyph. This matches the plan's literal instruction list order (container gets pointer/focus/data-spotlight/ring; button gets only the stopPropagation toggle)."
  - "Constructed a custom multi-rank FakeWorker for the TrainSolveScreen.test.tsx end-to-end case — the file's existing FakeWorker/MultiRank precedents in this codebase always echo the SAME move for every MultiPV rank, which cannot produce more than one distinct fine move. The new worker emits a distinct move per rank so a soft puzzle's alsoFineMoves has 2 real entries to spotlight."

patterns-established:
  - "A pure builder's derived list-for-UI (alsoFineMoves) is pushed inside the SAME forEach that draws the corresponding board primitive, not recomputed separately — the D-03 1:1 invariant enforced structurally, not just by test."

requirements-completed: [LEGEND-01, LEGEND-03, LEGEND-04, LEGEND-05, LEGEND-06]

coverage:
  - id: D1
    description: "toDisplayQuality collapses 'inaccuracy' to 'good' and is the identity for 'best'/'good'/'mistake'/'blunder'; consumed by QUALITY_ARROW_COLOR, markerForQuality, TRAIN_STEP_HIGHLIGHT, and the fine-move arrow loop, so no arrow, badge, or step highlight on the Train reveal board renders inaccuracy's own color."
    requirement: "LEGEND-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#toDisplayQuality (Phase 200 LEGEND-03/D-05)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#an inaccuracy-level fine move renders the SAME dark-green arrow and good badge as a clean alternative"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#badges dedupe by target square with the played move winning; the played inaccuracy renders as good (D-04/D-05)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#TRAIN_STEP_HIGHLIGHT (190.1 UAT stepping / Phase 200 D-05)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The CardHeader's MoveQualityIcon (the fifth recolor site the research found, not named in CONTEXT.md) is fed toDisplayQuality(box.quality), so a played inaccuracy shows the good glyph in the header, never the yellow severity glyph, and never pairs a green arrow with a yellow badge."
    requirement: "LEGEND-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#a played inaccuracy renders the GOOD quality icon in the CardHeader, never the severity glyph — the fifth D-05 recolor site (LEGEND-03)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The collapse never leaks outside the Train reveal surface: MOVE_QUALITY_INACCURACY stays defined in theme.ts and used by at least one non-Train consumer, SEVERITY_GLYPH's inaccuracy entry and MoveQualityIcon's isSeverityQuality routing are unchanged, and a played mistake/blunder still emit their own arrow color and severity marker."
    requirement: "LEGEND-03"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#played mistake and played blunder each keep their own arrow color and a severity marker — never collapsed like inaccuracy (prohibition 2)"
        status: pass
      - kind: other
        ref: "grep gates: 0 yellow-constant references in trainArrows.ts code, >=1 MOVE_QUALITY_INACCURACY in theme.ts, >=2 non-Train consumers, isSeverityQuality count 2, severityGlyph.ts inaccuracy entry present"
        status: pass
    human_judgment: false
  - id: D4
    description: "buildTrainRevealOverlay's alsoFineMoves lists exactly the fine moves the SAME builder call drew as green arrows — never the best/played move, never beyond the puzzle-type arrow cap, empty on a sharp puzzle, and length always equal to the count of arrows whose layerKey starts with 'good-'."
    requirement: "LEGEND-04"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#a soft puzzle with five good moves returns the blue best arrow plus two green alternatives... alsoFineMoves lists exactly those two (LEGEND-04)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#alsoFineMoves.length always equals the number of arrows whose layerKey starts with 'good-' (D-03 1:1 invariant)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#a sharp puzzle with four good moves ... alsoFineMoves is empty (D-03)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#a played move matching a green alternative ... is skipped from alsoFineMoves too"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#preserves alsoFineMoves unchanged through the spotlight filter (Phase 200 LEGEND-04)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The reveal sidebar renders a compact, non-Card 'Also fine' row (data-testid train-reveal-also-fine) with a single green glyph (data-testid train-reveal-glyph-also-fine) listing the drawn alternatives' SAN, no stepper and no eval badge; hovering/focusing/tapping the glyph spotlights ALL of the row's arrows together and the row carries the same active-entry ring highlight the line-box Cards use."
    requirement: "LEGEND-04"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#renders the Also fine row listing the SAN of every entry, with a single glyph button"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#desktop: hovering the Also fine row reports ONE spotlight entry covering ALL of its UCIs together, and clears on pointer-leave"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#mobile: tapping the Also fine glyph toggles the spotlight, and the row carries data-spotlight=\"true\" while active"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#renders no Also fine row when alsoFineMoves is empty (the default)"
        status: pass
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#a soft puzzle with two drawn alternatives renders the Also fine row listing both SANs, and hovering its glyph drops the board to exactly those two arrows"
        status: pass
    human_judgment: false
  - id: D6
    description: "Both the collapse (toDisplayQuality) and the row's derivation (alsoFineMoves) live in trainArrows.ts and are unit-tested there, so a regression on either fails CI without needing a rendered board."
    requirement: "LEGEND-05"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts (46 test cases across buildTrainRevealOverlay/toDisplayQuality/TRAIN_STEP_HIGHLIGHT/applyTrainSpotlight)"
        status: pass
    human_judgment: false

# Metrics
duration: 55min
completed: 2026-08-01
status: complete
---

# Phase 200 Plan 02: Train Solve Screen Board Legend — Yellow Removal & Also Fine Row Summary

**The Train reveal board never shows yellow — inaccuracy renders identically to good everywhere, including the user's own played move and the CardHeader glyph — and the sidebar's drawn green alternatives now have their own compact, spotlight-participating "Also fine" row.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-01T14:20Z (approx., first file read)
- **Completed:** 2026-08-01T15:15Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- `toDisplayQuality` landed as the single presentation-collapse rule in `trainArrows.ts` — inaccuracy maps to good, every other tier is the identity — and every one of the five yellow-rendering sites (arrow fill, fine-move arrow loop, marker badge, step highlight, and the `TrainReveal` `CardHeader`'s `MoveQualityIcon`) reads through it, so the collapse can never drift out of sync between the board and the glyph beside it.
- The classification pipeline (`classifyTrainMoveQuality`/`classifyLiveSeverity`) and `MOVE_QUALITY_INACCURACY`/`SEVERITY_GLYPH` in `theme.ts`/`severityGlyph.ts` are untouched — verified by grep gates and unit tests — so the Analysis board, Move Stats table, and Moves-by-Rating chart keep rendering inaccuracy as its own distinct tier; only the Train reveal surface's presentation collapses.
- `TrainRevealOverlay.alsoFineMoves` is derived inside the SAME loop that pushes the drawn green arrows in `buildTrainRevealOverlay`, so the sidebar's "Also fine" row can never list a move that isn't on the board or omit one that is — the 1:1 invariant is structural, not just tested.
- `TrainReveal` renders the row as a compact, non-Card element (no stepper, no eval, `text-sm` throughout) with one glyph button that spotlights every one of the row's drawn alternatives together; `applyTrainSpotlight` now spreads `alsoFineMoves` through unfiltered so the board filter can never empty the sidebar row.
- A played mistake or blunder still gets its own arrow color and severity marker — the collapse is inaccuracy-only, proven by an explicit regression test.

## Task Commits

Each task was committed atomically:

1. **Task 1: Collapse the inaccuracy tier into good across all five reveal sites** - `5b559998` (feat)
2. **Task 2: Derive alsoFineMoves in the builder and render the compact Also fine row** - `5ff3b2ec` (feat)

_Both tasks touch `TrainReveal.tsx` (Task 1's CardHeader recolor, Task 2's new row). Implemented and verified the combined end state first, then split the diff into the two commits above by temporarily reverting Task 2's pieces (interface field, prop, JSX block, and their tests) before the Task 1 commit, and reapplying them for the Task 2 commit — so each commit's diff matches only its own task's scope._

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `frontend/src/lib/trainArrows.ts` - Adds `toDisplayQuality`; recolors `QUALITY_ARROW_COLOR.inaccuracy`, the fine-move arrow loop, `markerForQuality`, and `TRAIN_STEP_HIGHLIGHT.inaccuracy` to the good treatment; adds `alsoFineMoves` to `TrainRevealOverlay` and `buildTrainRevealOverlay`; `applyTrainSpotlight` now spreads the overlay through so `alsoFineMoves` survives filtering
- `frontend/src/lib/__tests__/trainArrows.test.ts` - Inverts the two yellow-expecting cases, adds `toDisplayQuality` coverage (5 cases), a played-mistake/played-blunder non-collapse regression, and `alsoFineMoves` cap/skip/invariant/spotlight-preservation cases (46 total cases in the file)
- `frontend/src/components/train/TrainReveal.tsx` - `LineBoxHeader` feeds `toDisplayQuality(quality)` to the `MoveQualityIcon` and `data-quality` attribute; new `alsoFineMoves` prop and the "Also fine" row render block (glyph, SAN list, spotlight wiring)
- `frontend/src/components/train/TrainSolveScreen.tsx` - Passes the unfiltered `revealOverlay.alsoFineMoves` to `<TrainReveal>`
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` - Adds the CardHeader-collapse case and 4 "Also fine" row cases (empty-default, SAN listing, desktop hover, mobile tap-toggle)
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` - Adds a custom multi-rank `FakeWorker` and an end-to-end case proving a soft puzzle's two drawn alternatives render in the row and hovering its glyph drops the shared board to exactly those two arrows

## Decisions Made

- Split the combined TrainReveal.tsx implementation into two atomic commits along the plan's task boundaries via a build-then-split approach (see Task Commits note above) rather than committing the file's full combined diff under one task.
- The Also fine row's hover/focus/tabIndex/data-spotlight/ring handlers live on the row container, mirroring the line-box Card's whole-card hover (D-06); the glyph button carries only the click/tap toggle with `stopPropagation`, mirroring `LineBoxHeader`'s glyph — kept the container and button's responsibilities symmetric with the existing line-box pattern.
- Wrote a new `MultiRankFakeWorker` for the `TrainSolveScreen.test.tsx` end-to-end case because every existing FakeWorker in the codebase echoes the same move for every MultiPV rank (sufficient for single-fine-move tests, but incapable of producing the 2 distinct alternatives this test needed).

## Deviations from Plan

None - plan executed exactly as written. The commit-splitting mechanism above is an execution-process choice (how to stage the diff), not a deviation from what was built or tested.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `toDisplayQuality` and `alsoFineMoves` are exported from `trainArrows.ts` and ready for plan 200-03 (inline sideline exploration) to build on without re-deriving quality presentation or drawn-alternatives logic.
- The reveal sidebar is now strictly 1:1 with the board (every arrow has a legend entry, every entry has an arrow) — the invariant plan 200-03's exploration swap-in must preserve when it replaces the line boxes and Also fine row with the engine card (per CONTEXT.md D-10).

---
*Phase: 200-train-solve-screen-board-legend-inline-sideline-exploration*
*Completed: 2026-08-01*

## Self-Check: PASSED
