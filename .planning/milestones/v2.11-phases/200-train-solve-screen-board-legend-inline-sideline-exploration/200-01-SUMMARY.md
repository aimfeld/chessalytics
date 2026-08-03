---
phase: 200-train-solve-screen-board-legend-inline-sideline-exploration
plan: 01
subsystem: ui
tags: [react, typescript, tailwind, vitest, chessboard]

# Dependency graph
requires: []
provides:
  - "applyTrainSpotlight + trainGlyphColor pure exports in frontend/src/lib/trainArrows.ts"
  - "ArrowGlyphIcon component (frontend/src/components/icons/ArrowGlyphIcon.tsx)"
  - "useIsDesktop hook (frontend/src/hooks/useIsDesktop.ts), matchMedia at Tailwind's lg=1024px"
  - "Card/CardHeader-based reveal line boxes with a per-box legend glyph and hover/tap spotlight"
affects: [200-02, 200-03, 200-04]

# Actuals (#2632)
actuals:
  tokens: 13747
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure spotlight filter (applyTrainSpotlight) composed with buildTrainRevealOverlay, applied only in the pristine-reveal branch of TrainSolveScreen's board-arrows ternary"
    - "Shared LineBoxHeader component factoring CardHeader content (glyph/title/mark/quality/eval) out of the box-render loop, used by both the resolved-line branch and the standalone game-move branch"
    - "useIsDesktop matchMedia hook promoted from Bots.tsx's page-local pattern to a shared hook, pinned to Tailwind's default lg breakpoint so the JS gate never drifts from a caller's lg: CSS split"

key-files:
  created:
    - frontend/src/components/icons/ArrowGlyphIcon.tsx
    - frontend/src/hooks/useIsDesktop.ts
  modified:
    - frontend/src/lib/trainArrows.ts
    - frontend/src/lib/__tests__/trainArrows.test.ts
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/TrainLineStepper.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/components/train/__tests__/TrainLineStepper.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "The legend glyph's onClick is a real toggle in BOTH desktop and mobile modes, not gated on isDesktop — harmless on desktop since pointer-leave already clears the spotlight regardless of any click, so it satisfies D-06's 'no click-to-pin' in effect while giving mobile the tap toggle D-08 requires, per the plan's explicit instruction."
  - "LineBoxHeader factored into one shared module-scope component (not duplicated across the resolved-line and standalone-game-move branches) to keep TrainReveal's render loop within CLAUDE.md's nesting/LOC guidance."
  - "Tap-away-to-clear is a raw document pointerdown listener scoped to the panel's own effect lifetime, per the plan's explicit 'don't reach for a Radix popover or a generic click-outside utility' guidance."

patterns-established:
  - "Spotlight filtering lives in the pure trainArrows.ts module and is applied once, at the board-owner seam (TrainSolveScreen's boardArrows/boardMarkers ternary), never inline in JSX — mirrors the file's existing overlay-purity convention."

requirements-completed: [LEGEND-01, LEGEND-02, LEGEND-05, LEGEND-06]

coverage:
  - id: D1
    description: "Hovering (desktop) a reveal line box filters the shared board down to that box's own arrow(s) and badge; pointer-leave restores the full overlay. applyTrainSpotlight is a pure, unit-tested filter matching by UCI identity (not layerKey), so a merged box's stacked colored+white arrows both survive together."
    requirement: "LEGEND-02"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#applyTrainSpotlight (Phase 200 LEGEND-02/LEGEND-05)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#hovering the best-move legend box spotlights its own arrow on the shared board; pointer-leave restores the full overlay"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every reveal line box carries exactly one arrow glyph, colored via trainGlyphColor to the same theme constant its board arrow uses; a coincidence-merged box (played==best) renders exactly one glyph in the best-move blue."
    requirement: "LEGEND-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainArrows.test.ts#trainGlyphColor (Phase 200 LEGEND-01)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#a coincidence-merged played==best box renders exactly ONE glyph button, matching the single blue arrow actually drawn"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#every rendered line box exposes exactly one glyph button and one title"
        status: pass
    human_judgment: false
  - id: D3
    description: "The three reveal line boxes are real Card/CardHeader components; the header (glyph, title, verdict mark, quality icon, eval badge) moved out of TrainLineStepper into TrainReveal's CardHeader under byte-identical testids."
    requirement: "LEGEND-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx (35 cases, header/box structure)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainLineStepper.test.tsx (stepper-only coverage post header removal)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Desktop hover on the whole card (plus keyboard focus) spotlights; mobile taps the glyph specifically, toggling on repeat/switch tap and clearing on tap-away; exactly one entry is ever active; the active card carries a ring highlight (data-spotlight)."
    requirement: "LEGEND-02"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx (desktop hover/highlight + mobile toggle/switch/tap-away cases, D-09 at-most-one-active assertion)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The JS desktop/mobile gate (useIsDesktop, 1024px) visually agrees with the lg: CSS layout switch, and the spotlight/glyph interaction reads correctly on a real 375px mobile viewport (pixel-level legibility of the ring highlight and tap target, not just DOM structure)."
    verification: []
    human_judgment: true
    rationale: "jsdom unit tests prove the DOM/state machinery (matchMedia stub, data-spotlight attribute, toggle logic) but cannot prove pixel-level rendering at a real 375px viewport or real touch-target ergonomics. Carried to the phase's human-UAT list per the plan's flagged assumption A-04 (LEGEND-06's pixel half is not silently dropped, it is deferred to plan 200-04's end-of-phase browser check)."

# Metrics
duration: 55min
completed: 2026-08-01
status: complete
---

# Phase 200 Plan 01: Train Solve Screen Board Legend — Spotlight Tracer, Card Restructure, Desktop/Mobile Split Summary

**The Train reveal sidebar is now the board's own legend: every line box carries an arrow glyph in its exact board-arrow color inside a real Card/CardHeader, and hovering (desktop) or tapping the glyph (mobile) filters the shared board down to that one move.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-01T13:21Z (approx., first file read)
- **Completed:** 2026-08-01T14:16Z
- **Tasks:** 3
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments

- `applyTrainSpotlight` (board-side filter) and `trainGlyphColor` (glyph-color derivation) landed as pure, unit-tested exports in `trainArrows.ts` — the single source of truth both the board arrows and the legend glyphs read from, so they can never drift.
- `ArrowGlyphIcon` reuses the board's own `buildArrowPath` geometry, so every legend glyph is shape-identical to the real arrow it stands in for, not just color-matched.
- The spotlight is wired end to end: `TrainSolveScreen` holds one nullable spotlight entry, filters the pristine-reveal overlay through it (leaving the line-stepping overlay untouched — Pitfall 1), and threads it down to `TrainReveal`.
- The three reveal line boxes (Your move / Best move / Played in game) are now real `Card`/`CardHeader` components; the header content (glyph, title, verdict mark, quality icon, eval badge) moved out of `TrainLineStepper` into a shared `LineBoxHeader`, under byte-identical `train-line-stepper-*` testids so existing scoped test queries kept passing unchanged.
- `useIsDesktop` (new shared hook, promoted from `Bots.tsx`'s page-local pattern, pinned to Tailwind's `lg`=1024px) splits the interaction: desktop hovers the whole card (plus keyboard focus, D-06); mobile taps the glyph specifically, toggling active/switch/clear (D-08) with a scoped document-level tap-away listener (D-08) and exactly one active entry ever (D-09). The active card carries a `ring-2 ring-brand-brown` highlight plus `data-spotlight="true"` (D-07).

## Task Commits

Each task was committed atomically:

1. **Task 1 (tracer): End-to-end legend spotlight — one glyph, one hover, the board responds** - `1100f24a` (feat)
2. **Task 2: D-01 — line boxes become Card + CardHeader, header moves out of TrainLineStepper** - `127216e4` (feat)
3. **Task 3: Desktop-hover vs mobile-tap split, active-card highlight, tap-away clear** - `515d9913` (feat)

_Task 1 is `type="tracer"` — per the tracer feedback gate, the executor stopped after committing it and returned a `checkpoint:human-verify` (hover-spotlight interaction, live dev server already running). The user verified in-browser and responded "pass" before Tasks 2/3 proceeded._

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `frontend/src/lib/trainArrows.ts` - Adds `applyTrainSpotlight` (UCI-identity board filter) and `trainGlyphColor` (glyph color derivation) as flat named exports
- `frontend/src/lib/__tests__/trainArrows.test.ts` - 25 new test cases across `applyTrainSpotlight` and `trainGlyphColor`
- `frontend/src/components/icons/ArrowGlyphIcon.tsx` (new) - Inline-SVG glyph reusing `buildArrowPath`, `color` prop only, no literal colors
- `frontend/src/hooks/useIsDesktop.ts` (new) - Shared `matchMedia`-based desktop gate at 1024px, jsdom/SSR-safe
- `frontend/src/components/train/TrainReveal.tsx` - `LineBox.uci`; `LineBoxHeader` shared component; Card/CardHeader/CardBody restructure; spotlight props, handlers, and desktop/mobile split
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` - New cases for glyph-per-box, merged-box single-glyph, and the full desktop-hover/mobile-tap/tap-away spotlight interaction (10 new cases)
- `frontend/src/components/train/TrainSolveScreen.tsx` - `spotlight` state, `spotlitOverlay` memo (`applyTrainSpotlight` applied only in the pristine-reveal ternary arm), props threaded to `TrainReveal`
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` - Controllable `matchMedia` stub; end-to-end hover-spotlight case
- `frontend/src/components/train/TrainLineStepper.tsx` - Drops `title`/`evalLabel`/`quality`/`mark` props and the header block entirely; renders only the prev/next + token row
- `frontend/src/components/train/__tests__/TrainLineStepper.test.tsx` - Removes the two header-dependent test cases (title/eval, quality icon) whose coverage moved to `TrainReveal.test.tsx`

## Decisions Made

- The legend glyph's `onClick` toggles the spotlight in **both** desktop and mobile modes (not gated on `isDesktop`) — on desktop this is harmless/inert since leaving the card via `pointerLeave` always clears regardless of any click, so it satisfies D-06's "no click-to-pin" in effect while giving mobile the tap toggle D-08 requires. This follows the plan's explicit instruction verbatim.
- `LineBoxHeader` was factored into one shared module-scope component (used by both the resolved-line and standalone-game-move render branches) rather than duplicated inline, keeping `TrainReveal.tsx`'s render loop within CLAUDE.md's nesting/LOC guidance.
- Tap-away-to-clear is a raw `document` `pointerdown` listener scoped to the panel's own effect lifetime — not a generic click-outside utility or a Radix popover, per the plan's explicit guidance.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Task 3's desktop/mobile split broke the Task-1 end-to-end hover test in `TrainSolveScreen.test.tsx`, which had no `matchMedia` stub — `useIsDesktop` fell back to its jsdom-safe `false` default, so the pointer-enter/leave handlers were no longer wired. Fixed by adding the same controllable `matchMedia` stub the plan specified for `TrainReveal.test.tsx` (default `matches: true`, reset in `beforeEach`), matching the plan's own "In both TrainReveal.test.tsx and TrainSolveScreen.test.tsx" instruction.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `applyTrainSpotlight`, `trainGlyphColor`, `ArrowGlyphIcon`, `useIsDesktop`, and the Card-based reveal sidebar are all in place for plan 200-02 (yellow removal / "Also fine" row / recolor tests) to build on directly — 200-02's own recolor changes flow through the same `trainArrows.ts` module this plan extended.
- D5 (pixel-level 375px mobile rendering of the ring highlight and glyph tap target) is flagged for human verification and carried to the phase's end-of-phase browser check (plan 200-04), per the plan's flagged assumption A-04 — not silently dropped.

---
*Phase: 200-train-solve-screen-board-legend-inline-sideline-exploration*
*Completed: 2026-08-01*

## Self-Check: PASSED

All 6 created/modified key files exist on disk; all 4 commits (`1100f24a`, `127216e4`, `515d9913`, `2ab5df99`) verified present in git log.
