---
phase: 191-schedule-progress-surface
plan: 03
subsystem: ui
tags: [react, typescript, canvas-confetti, chess.js, react-chessboard, train]

requires:
  - phase: 190-train-page-solve-loop
    provides: TrainScoreScreen.tsx (session-end score screen, docstring explicitly deferring celebration to Phase 191), TrainReveal.tsx (comebackHint placeholder in the comeback slot)
provides:
  - Green-session confetti burst on TrainScoreScreen mount (fire-once, reduced-motion-safe)
  - TrainFlawFixedBanner component — the "Flaw fixed!" mastery celebration with a degrading position thumbnail
  - TrainReveal now renders the banner in place of the retired D-12 comebackHint plain text
affects: [191-06-empty-states]

tech-stack:
  added: []
  patterns:
    - "Fire-once mount effect with an empty dependency array + eslint-disable-next-line react-hooks/exhaustive-deps for a one-time celebration side effect — same shape as pages/Train.tsx's startSession mount effect and useBotGame.ts's finalizeGame reduced-motion guard."
    - "Defensive Chess() try/catch FEN validation before handing a string to a board renderer, so a malformed/empty FEN degrades a decorative slot instead of throwing out of the render tree — mirrors TrainReveal.tsx's existing sanFromPlayedUci guard."

key-files:
  created:
    - frontend/src/components/train/TrainFlawFixedBanner.tsx
    - frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainFlawFixedBanner.test.tsx
  modified:
    - frontend/src/components/train/TrainScoreScreen.tsx
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx

key-decisions:
  - "TrainFlawFixedBanner imports MiniBoard directly (not LazyMiniBoard) since the reveal panel is never off-screen when the banner fires — a viewport-gated mount would only add latency inside the celebration window (UI-SPEC E7 loading), per the plan's explicit instruction."
  - "FEN validation reuses the exact defensive shape TrainReveal.tsx's sanFromPlayedUci already uses (new Chess(fen) inside try/catch) rather than a new validation helper, so the codebase has one FEN-safety idiom, not two."
  - "The old train-comeback-hint testid and its comebackHint function are deleted outright (not deprecated/kept alongside); TrainReveal.test.tsx's assertions were updated to assert the new banner testid rather than duplicating coverage for a retired code path."

requirements-completed: [PROG-02, PROG-03]

coverage:
  - id: D1
    description: "TrainScoreScreen fires fireWinConfetti exactly once on mount for a green-band session, is silenced entirely by prefersReducedMotion (with total/percentage/CTA still rendering), and never fires for yellow/red/null bands or on a same-props re-render"
    requirement: "PROG-02"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx (6 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "TrainFlawFixedBanner renders the 'Flaw fixed!' heading and 'You've mastered this position.' subline plus a MiniBoard thumbnail for a valid FEN, and degrades to heading+subline only (no thumbnail) for an empty or syntactically invalid FEN — a rendering failure never suppresses the celebration"
    requirement: "PROG-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainFlawFixedBanner.test.tsx (3 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "TrainReveal renders the banner exactly when item_status is 'mastered' (non-herring), and renders neither the banner nor the old comeback text for 'active', 'parked', or a herring (item_status null); two masteries in the same session each get their own single, un-pluralized banner"
    requirement: "PROG-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx (5 new item_status/banner tests, 33 pre-existing tests still passing)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-27
status: complete
---

# Phase 191 Plan 03: Train Celebrations Summary

**Fire-once green-session confetti on TrainScoreScreen plus a "Flaw fixed!" mastery banner with a degrading position thumbnail in TrainReveal — both reusing existing celebration primitives with zero new dependencies, endpoints, or modals.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 2
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- `TrainScoreScreen` fires `fireWinConfetti()` in a fire-once mount `useEffect` when the session's rating band resolves to green, guarded by `prefersReducedMotion()` — the identical guard shape `useBotGame.ts`'s `finalizeGame` uses for the bot-win burst. No new confetti palette, no new effect; `CONFETTI_COLORS` stays baked into `fireWinConfetti`.
- New `TrainFlawFixedBanner` component: heading "Flaw fixed!" + subline "You've mastered this position." + a 48px `MiniBoard` thumbnail, laid out horizontally with `bg-brand-brown-highlight/40`/`border-brand-brown-light/60`/`text-brand-brown-hover` brand tokens (never `FLAWCHESS_ENGINE_ACCENT`, which is reserved for the FlawChess Engine's own identity). The FEN is validated via a defensive `new Chess(fen)` try/catch before the thumbnail mounts — an empty or unparseable FEN collapses only the thumbnail slot, never the heading/subline (T-191-10).
- `TrainReveal` now renders `<TrainFlawFixedBanner fen={puzzle.fen} />` in the same panel position the retired `comebackHint`/`train-comeback-hint` plain text used to occupy, with the identical trigger condition (`verdict.puzzle_type !== 'herring' && verdict.item_status === 'mastered'`) — no change to any other reveal section, prop, or query.
- `frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx` created from scratch (no test file existed for this component before this plan — a Wave 0 gap the plan called out explicitly): 6 tests covering green/yellow/red/null bands, the reduced-motion guard (with total/percentage/CTA still rendering), and re-render idempotence.
- `TrainFlawFixedBanner.test.tsx` created (3 tests: valid FEN, empty FEN, invalid FEN). `TrainReveal.test.tsx` extended with 5 tests (mastered/active/parked/herring banner presence, plus the two-masteries-in-a-row non-pluralization case) replacing the two tests that previously asserted the retired `train-comeback-hint` behavior.

## Task Commits

1. **Task 1: Green-session confetti on the score screen** — RED `5827850a` (test), GREEN `26464b6a` (feat)
2. **Task 2: "Flaw fixed!" mastery banner in the reveal's comeback slot** — RED `be30ac46` (test), GREEN `0f9d54f8` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified

- `frontend/src/components/train/TrainScoreScreen.tsx` — fire-once mount `useEffect` calling `fireWinConfetti()` guarded on green band + `!prefersReducedMotion()`; docstring updated to point at D-15 instead of deferring to "Phase 191"
- `frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx` (new) — 6 tests
- `frontend/src/components/train/TrainFlawFixedBanner.tsx` (new) — the banner component, exports `TrainFlawFixedBanner`
- `frontend/src/components/train/__tests__/TrainFlawFixedBanner.test.tsx` (new) — 3 tests
- `frontend/src/components/train/TrainReveal.tsx` — deleted `comebackHint`, wired `<TrainFlawFixedBanner>` into the "3. Comeback hint" slot (renamed comment to "3. Flaw fixed banner")
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` — replaced the two `train-comeback-hint` assertions with 5 banner-presence tests

## Decisions Made

- **`isRenderableFen` reuses `TrainReveal.tsx`'s existing defensive `Chess()` construction shape** (`new Chess(fen)` inside `try/catch`) rather than introducing a second FEN-validation idiom — one pattern for "is this FEN safe to hand to a board renderer" across the Train components.
- **`MiniBoard` imported directly, not `LazyMiniBoard`** — the reveal panel is always mounted and visible when the banner fires (it is never off-screen/below-the-fold at that point in the solve flow), so an intersection-observer gate would only add latency to the celebration the user just earned. This was an explicit plan instruction, not an independent choice, but is recorded here since it is easy to "fix" incorrectly in a later phase without this context.
- **Deleted `comebackHint`/`train-comeback-hint` outright** rather than keeping them as a fallback — D-14 fully supersedes the D-12 plain-text comeback hint, and `npm run knip` confirms no dead export was left behind.

## Deviations from Plan

None — plan executed exactly as written, including the exact Tailwind brand tokens, `MiniBoard` (not `LazyMiniBoard`) import, and the `text-flaw-fixed-*` testid names specified in the plan.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required. Zero new npm dependencies (per the plan's threat register T-191-SC: `canvas-confetti`, `chess.js`, `react-chessboard` were all already installed).

## Next Phase Readiness

- Manual verification of the confetti burst and the reduced-motion silence in a real browser is deferred to Plan 06's checkpoint per this plan's `<verification>` section — no blocker, just not yet done.
- No blockers for Plans 04/05/06. The banner's `flipped` prop is threaded through but unused (defaults to the board's default orientation) — a flagged planner assumption, not a gap: `TrainPuzzle.side_to_move` is available if a future plan wants to flip it to the solver's perspective.

## Self-Check: PASSED

All created files verified present on disk; all task commit hashes (`5827850a`, `26464b6a`, `be30ac46`, `0f9d54f8`) verified in `git log`.

---
*Phase: 191-schedule-progress-surface*
*Completed: 2026-07-27*
