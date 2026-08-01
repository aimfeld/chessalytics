# Phase 200: Train Solve Screen — Board Legend & Inline Sideline Exploration - Research

**Researched:** 2026-08-01
**Domain:** React/TypeScript frontend — pure overlay-builder refactor + a second in-browser Stockfish WASM engine instance, no backend
**Confidence:** HIGH (every claim below is either read directly from the current source this session or a locked decision copied from CONTEXT.md)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

SEED-131 already locked the shape of this phase (sidebar-as-legend, spotlight as a
negative highlight, inaccuracy→green, "Also fine" compact row, no explore-mode
toggle, exploration seeded from stepped positions, Stockfish-only swap-in card,
Solution restores, Analyze unchanged). Those are NOT restated as decisions here —
read the seed. The decisions below are what the discussion resolved on top of it.

**Legend structure**
- **D-01:** The three reveal line boxes become real `Card` + `CardHeader` components
  (`@/components/ui/card`, already used by `TrainStatsCard`, `TrainStreakCard`,
  `TrainScheduleSettings`). The arrow glyph, title, verdict mark, and eval live in
  `CardHeader`; the stepper body lives below it. Today these are bare `<div>`s and
  `TrainLineStepper` renders its own title row — that header moves into `CardHeader`,
  so `TrainLineStepper` is restructured, not just wrapped.
  Reversibility: costly — the header currently belongs to `TrainLineStepper`
  (title/mark/quality/eval testids live there and are asserted by
  `TrainLineStepper.test.tsx` and `TrainReveal.test.tsx`); moving it changes the
  component's public shape and both test files.
- **D-02:** The "Also fine: Nc4, Rd8" row stays a **compact row, not a Card**. No
  stepper, no eval — a Card shell would be mostly chrome. Still participates in the
  spotlight and gets its own active-highlight treatment.
- **D-03:** The "Also fine" row lists **only the alternatives actually drawn as green
  arrows** — never the overflow past the arrow cap. The legend is strictly 1:1 with
  the board: every arrow has a sidebar entry, every entry has an arrow, so a
  spotlight can never resolve to nothing. A 4th `fineMoves` entry from the
  MultiPV-4 grading search is deliberately never surfaced. On a sharp puzzle
  (`TRAIN_SHARP_GOOD_MOVE_ARROWS = 1`) there are no green arrows, so the row does
  not render at all.

**Color language — yellow removal**
- **D-04:** The inaccuracy→green recolor applies to the **user's played move too**,
  not only alternatives. A played inaccuracy renders green (SOLV-03 already scores
  it correct). The line eval still discloses the small drop.
- **D-05:** Inaccuracy-tier collapses into `good` across the **entire** reveal
  surface: green arrow, the `good` thumbs-up badge (not the severity NAG glyph), and
  the green step highlight. Concretely, in `trainArrows.ts`:
  `QUALITY_ARROW_COLOR.inaccuracy`, the `fine.quality === 'inaccuracy' ? … : …`
  ternary in the fine-move arrow loop, `markerForQuality`'s severity branch for
  `'inaccuracy'`, and `TRAIN_STEP_HIGHLIGHT.inaccuracy` all resolve to the `good`
  treatment. Accepted cost: the board can no longer distinguish good from
  inaccuracy — by design. Reversible — `MOVE_QUALITY_INACCURACY` stays in
  `theme.ts` for the rest of the app.

**Spotlight interaction**
- **D-06:** Desktop = **hover on the whole card** (pointer-enter spotlights,
  pointer-leave restores). Keyboard focus does the same. No click-to-pin.
- **D-07:** The spotlight is **two-sided**: the active card is itself highlighted,
  AND every other arrow/badge on the board is hidden, leaving only that card's move.
- **D-08:** Mobile = **tap the glyph specifically** (not the whole card), toggling:
  tap the active glyph again or any other glyph to switch, tap the board or
  anywhere else to clear. Keeps a tap from being ambiguous between "spotlight this"
  and "step this line" — the card body holds the stepper's own controls.
- **D-09:** Exactly one glyph is active at a time, or none. Single piece of state.

**Swap to exploration**
- **D-10:** Only the **line boxes and the "Also fine" row** are replaced by the
  engine card + move list. The header block (guess verdict, outcome copy,
  flaw-fixed banner) stays pinned above it.
- **D-11:** The Solution button is **visibility-gated**: shown iff
  `lineStep !== null || isExploring`. Label stays "Solution".

**Exploration mechanics**
- **D-12:** **Pure free play** — both sides moveable, nothing auto-replies. The
  refutation is readable from the engine card's top PV.
- **D-13:** The exploration move list is a **clickable single chain that
  truncates**: clickable SAN tokens plus prev/next, playing a move from a jumped-
  back position discards the tail. No branching, no tree.
- **D-14:** Stockfish PV moves in the engine card are **clickable and play into the
  exploration line** — `replayPvLine` is already exported from `EngineLines.tsx`
  and imported by `TrainReveal.tsx`.

### Claude's Discretion

- Exploration is reachable only once the verdict has landed (the `showResultRow` /
  `verdict !== null` gate). A drag during grading keeps today's behavior.
- Returning from the Analyze deep-link via browser back restores the **pristine
  reveal**, not exploration state — `saveTrainRevealCache` is not extended.
- The engine card's first-search state reuses whatever `EngineLines` already
  renders while a search is in flight; no new loading treatment.
- Points flash and result sounds are unchanged and do not re-fire on exploration.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope. Three keyword-matched todos were
reviewed and confirmed unrelated (`WR-01` Tailwind axis label, `172-deferred-
review-findings`, bitboard storage) — none touch the Train solve screen.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LEGEND-01 | Arrow glyph per line box, matching the drawn arrow color, merged box = one glyph | See "Legend glyph" in Architecture Patterns — glyph color must be derived from the SAME `QUALITY_ARROW_COLOR`/`NEXT_MOVE_ARROW` values the board arrow uses, never a fresh literal |
| LEGEND-02 | Hover/tap spotlight hides every other arrow+badge | New pure `applyTrainSpotlight` function spec in "Don't Hand-Roll" / Code Examples; `useIsDesktop`-style breakpoint gate cited from `Bots.tsx` |
| LEGEND-03 | No yellow — inaccuracy renders as good everywhere | D-05's 4 named `trainArrows.ts` call sites, PLUS a 5th site this research found (CardHeader's `MoveQualityIcon`) that CONTEXT.md doesn't name |
| LEGEND-04 | "Also fine" row lists only drawn green alternatives | Recommend `TrainRevealOverlay` grows an `alsoFineMoves` field so the row is DERIVED from, not duplicated alongside, the arrow-selection logic |
| LEGEND-05 | Spotlight + recolor live in pure `trainArrows.ts`, unit-tested | `applyTrainSpotlight` design + `trainArrows.test.ts`'s established test shape |
| LEGEND-06 | Works in mobile below-board layout at 375px | Existing `lg:flex-row` / mobile-stacked layout already in `TrainSolveScreen.tsx`; D-08's glyph-only tap target avoids the stepper's own click targets |
| EXPLORE-01 | Any board move post-verdict starts exploration, one board | `handlePieceDrop` seam (already identified in CONTEXT.md) — exact code change spec below |
| EXPLORE-02 | Exploration seeded from a stepped line's prefix | **Gap found**: neither `TrainLineStep` nor `TrainRevealStep` currently carries the full prefix — only the last move. Must be extended. |
| EXPLORE-03 | Swap to Stockfish-only engine card + move list, arrows clear | **Priority research answer** below: reuse `EngineLines.tsx` + a new `useStockfishEngine` instance |
| EXPLORE-04 | Solution exits exploration, restores reveal + `solutionNonce` | `handleShowSolution` seam — add `setIsExploring(false)` + clear exploration state |
| EXPLORE-05 | Clean teardown on transition/Next/unmount, no cross-puzzle interference | **Priority research answer**: a SECOND, independent Worker means teardown is structural (the hook's own `enabled`-toggle cleanup), not a manually-coded interlock |
| EXPLORE-06 | Analyze deep-link unchanged | No code touches `buildGameAnalysisUrl`/the Analyze button — verified by reading `TrainSolveScreen.tsx:661-673` |
| EXPLORE-07 | Mobile below-board layout at 375px for the swap | Same layout container as LEGEND-06 — the swap only replaces `TrainReveal`'s body content, not the outer `flex-col`/`lg:flex-row` shell |
</phase_requirements>

## Summary

This phase touches exactly five existing files (`trainArrows.ts`, `TrainReveal.tsx`,
`TrainSolveScreen.tsx`, `TrainLineStepper.tsx`, and `TrainLineStepper.test.tsx` /
`TrainReveal.test.tsx` / `TrainSolveScreen.test.tsx` / `trainArrows.test.ts`) plus
1-2 new small files (an arrow-glyph icon, an exploration move-list state hook).
No backend, no new npm package, no schema. Everything needed already exists in the
codebase in a directly reusable shape: `Card`/`CardHeader` (`ui/card.tsx`), the
PV-line renderer (`EngineLines.tsx`, already imported by `TrainReveal.tsx` for
`replayPvLine`/`formatScore`), and a second Stockfish hook
(`useStockfishEngine.ts`) that already implements exactly the "continuous MultiPV
eval with cancel-on-position-change" semantics EXPLORE-06 asks for — it is the
same hook the Analysis page uses today.

The **priority research question** (which engine powers exploration) resolves
cleanly: **mount a second, independent `useStockfishEngine` instance, scoped
`enabled: isExploring`.** Do not try to repurpose `useTrainGradingEngine` for
this — its public API (`startGrading`/`gradeMove`/`startGameMoveSearch`,
`useTrainGradingEngine.ts:207-246`) is a one-shot, generation-keyed dispatch
queue for discrete search TASKS, not a continuously-streaming analyzer. Building
continuous re-analysis on top of it would mean re-implementing
`useStockfishEngine`'s debounce/stale-discard machinery a second time inside a
hook that was explicitly designed around a different contract. `useStockfishEngine`
already IS that machinery, already ships in production on the Analysis page, and
already tears down cleanly via its own `enabled` effect dependency
(`useStockfishEngine.ts:467-487`) — which structurally satisfies EXPLORE-05
without any new interlock code, because it is a SEPARATE Worker object from the
grading engine's. There is no shared state to corrupt.

The mobile-OOM concern this question was flagged against does not actually apply
to two Stockfish instances: the Analysis page already runs `MOBILE_POOL_SIZE = 2`
FlawChessEngine workers (`workerPool.ts:76`) **plus** its own `useStockfishEngine`
**plus** a Maia ONNX worker — 4 concurrent WASM/ONNX workers on the same
"mobile" device class Train would run on, already shipped since Phase 154-161. The
documented Maia OOM history is specifically about the ~44 MB ONNX model +
onnxruntime-web's WASM heap on iOS, not about running more than one lite
single-thread Stockfish instance (`stockfish-18-lite-single.js`, ~7 MB, the same
literal `ENGINE_PATH` string in `useStockfishEngine.ts:24`,
`useTrainGradingEngine.ts:43`, and `workerPool.ts:42`). Train's exploration adds
at most 2 total Stockfish workers (1 idle grading + 1 active exploring) — half of
what Analysis already sustains, and zero Maia/ONNX involvement (EXPLORE-03
explicitly excludes the Maia card).

Two real implementation gaps this research surfaced that CONTEXT.md does not
name: (1) neither `TrainLineStep` (`TrainLineStepper.tsx:55-60`) nor
`TrainRevealStep` (`TrainReveal.tsx:110-118`) carries the full move prefix up to
the current step — only the single last move — so EXPLORE-02's "stepped prefix
seeds the exploration list" cannot be implemented without extending both
interfaces with a `prefixUci: string[]` field; and (2) the inaccuracy→good
presentation collapse (D-05) is scoped in CONTEXT.md to four `trainArrows.ts`
call sites, but the new CardHeader's quality glyph (currently rendered via
`MoveQualityIcon`, imported at `TrainLineStepper.tsx:31`) reads the SAME raw
`TrainMoveQuality` value and would still show the yellow "?!" severity glyph for
a played inaccuracy unless the presentation collapse is applied there too — a
new fifth site.

**Primary recommendation:** implement the legend as a pure-function extension of
`trainArrows.ts` (spotlight filter + `alsoFineMoves` derivation + a
`toDisplayQuality` collapse helper used by both the board and the new
`CardHeader`), restructure `TrainLineStepper` to drop its own header (moving
title/mark/quality/eval rendering into `TrainReveal`'s new `Card`/`CardHeader`
wrapper), and implement exploration as a second `useStockfishEngine` instance
feeding the existing `EngineLines` component, with a small bespoke
move-list/state model for the exploration chain (do NOT literally reuse
`TrainLineStepper` for the exploration list — its reset-on-content-change effect
at `TrainLineStepper.tsx:182-184` would snap back to move 0 every time a move is
appended).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Arrow/badge overlay computation (legend colors, spotlight filter) | Browser / Client (pure lib, `trainArrows.ts`) | — | Already a pure, dependency-free module (`trainArrows.ts:1-18` docstring); no React, no fetch — the correct home for LEGEND-03/04/05's testable logic |
| Board rendering + interaction (drag/drop, click-to-step) | Browser / Client (`ChessBoard.tsx`, `TrainSolveScreen.tsx`) | — | One shared `<ChessBoard id="chessboard">` instance already owns all board state (`TrainSolveScreen.tsx:610-621`); EXPLORE-01 forbids a second board |
| Grading (already-solved puzzle verdict) | Browser / Client (`useTrainGradingEngine`, session-scoped Worker) | — | Existing, untouched by this phase — no change to grading semantics |
| Exploration engine (continuous MultiPV eval of arbitrary FEN) | Browser / Client (new `useStockfishEngine` instance, scoped `enabled: isExploring`) | — | Same tier and same hook the Analysis page already uses; no backend involvement, no new server load |
| Exploration UI (engine-lines card + move list) | Browser / Client (`EngineLines.tsx` reused + new small move-list component) | — | `EngineLines` is presentation-only, already decoupled from Analysis-page state |
| API / Backend | — (untouched) | — | Locked: "Frontend-only. No backend endpoint, no schema, no migration" (CONTEXT.md `<domain>`) |
| Database / Storage | — (untouched) | — | No persistence anywhere in this phase |

## Standard Stack

No new library is introduced by this phase. Every dependency used is already in
`frontend/package.json` and already exercised by sibling Train/Analysis
components read this session.

### Core (existing, reused)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react-chessboard (via `ChessBoard.tsx`) | already pinned | The single shared board | Existing app-wide board primitive; do not fork |
| chess.js | already pinned | Move legality/SAN/UCI conversion for exploration free-play | Already used identically by `TrainSolveScreen.handlePieceDrop` (`TrainSolveScreen.tsx:367-374`) and `TrainLineStepper.replayLine` (`TrainLineStepper.tsx:134-150`) |
| vitest + @testing-library/react | already pinned | Unit tests for `trainArrows.ts`, component tests for `TrainReveal`/`TrainSolveScreen` | Established pattern (`trainArrows.test.ts`, `TrainSolveScreen.test.tsx` with a `MockWorker` fake, `useStockfishEngine.test.ts:23-42`) |

### Supporting (existing, reused)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@/components/ui/card` (`Card`/`CardHeader`/`CardBody`) | in-repo | D-01's new line-box shell | Already the idiom for `TrainStatsCard`/`TrainStreakCard`/`TrainScheduleSettings` per CONTEXT.md |
| `@/components/analysis/EngineLines` (`EngineLines`, `replayPvLine`, `formatScore`, `MAX_LINES`) | in-repo | Exploration's Stockfish-lines card | Already imported by `TrainReveal.tsx:45`; reuse verbatim, do not fork a Train-specific copy |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| A second `useStockfishEngine` instance for exploration | Extend `useTrainGradingEngine` with a continuous-eval mode | Rejected — would duplicate `useStockfishEngine`'s debounce/stale-discard state machine inside a hook whose public contract (`startGrading`/`gradeMove`, generation-keyed one-shot dispatch) is architecturally a different shape; higher risk of breaking the grading fast-path (D-06 in that file) for zero benefit |
| A second `useStockfishEngine` instance | A single shared engine + priority queue arbitrating grading vs. exploration requests | Rejected — unnecessary complexity given the two never actually contend: grading is idle throughout the entire reveal/exploration window (it only re-fires on the NEXT puzzle, at which point exploration has already torn down); a priority queue solves a race condition that cannot occur in the current UI flow |
| Literal reuse of `TrainLineStepper` for the exploration move list | A new bespoke move-list/state hook | `TrainLineStepper`'s reset effect (`TrainLineStepper.tsx:182-184`) fires on ANY change to its `moves` array content (`movesKey`), which is exactly the append operation exploration needs to do on every move — reusing it verbatim would reset the stepper to index 0 every time a move is played, defeating the whole feature |

**Installation:** none — no new packages.

**Version verification:** N/A — no new external dependency to verify against a registry.

## Package Legitimacy Audit

Not applicable. This phase installs no external packages (frontend-only,
reuses existing in-repo modules and already-pinned npm dependencies). No
`npm view`/legitimacy check was run because there is nothing to check.

**Packages removed due to [SLOP] verdict:** none — no packages proposed.
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
                      ┌─────────────────────────────────────────┐
                      │        TrainSolveScreen (owns board)     │
                      │                                           │
  piece drop  ───────►│  handlePieceDrop(source,target)          │
                      │    ├─ guess===null?           reject      │
                      │    ├─ !moveApplied?  grade+solve (existing)│
                      │    ├─ verdict===null? reject (pending)     │
                      │    └─ verdict!==null:                      │
                      │         legal on boardFen?                 │
                      │           NO → reject                      │
                      │           YES → isExploring=true,          │
                      │                 seed/append explorationUci │
                      │                 (EXPLORE-01/02)            │
                      │                                           │
                      │  boardArrows/boardMarkers = one of:        │
                      │    isExploring        → []  (EXPLORE-03)   │
                      │    lineStep!==null    → step overlay       │
                      │    else               → applyTrainSpotlight│
                      │                          (revealOverlay,   │
                      │                           spotlightKey)    │
                      └───────────────┬───────────────────────────┘
                                      │ verdict!==null
                                      ▼
                      ┌─────────────────────────────────────────┐
                      │              TrainReveal                 │
                      │  (header stays pinned: guess verdict,     │
                      │   outcome copy, flaw-fixed banner — D-10) │
                      │                                           │
                      │  isExploring === false:                   │
                      │    3x <Card onMouseEnter/Leave/tap-glyph> │
                      │       <CardHeader> glyph+title+mark+      │
                      │         quality+eval </CardHeader>        │
                      │       <CardBody><TrainLineStepper .../>   │
                      │    "Also fine: Nc4, Rd8" compact row       │
                      │       (from overlay.alsoFineMoves)         │
                      │                                           │
                      │  isExploring === true:                     │
                      │    <EngineLines pvLines=... baseFen=...    │
                      │       onMoveClick={playPvIntoExploration}/>│
                      │    <ExplorationMoveList .../> (D-13)       │
                      └───────────────┬───────────────────────────┘
                                      │ fen (continuous, isExploring gate)
                                      ▼
                      ┌─────────────────────────────────────────┐
                      │  NEW: useStockfishEngine (2nd instance)   │
                      │  { fen: explorationFen, enabled:          │
                      │    isExploring }                          │
                      │  — SEPARATE Worker from the session's     │
                      │    grading engine; own debounce + stale-  │
                      │    eval discard (already built, no new    │
                      │    code) — EXPLORE-05/06                  │
                      └─────────────────────────────────────────┘

  (unchanged, session-scoped, idle during reveal/exploration)
  ┌─────────────────────────────────────────┐
  │  useTrainGradingEngine (1 Worker/session) │
  │  startGrading/gradeMove/startGameMoveSearch│
  │  — only re-fires on the NEXT puzzle        │
  └─────────────────────────────────────────┘
```

### Recommended Project Structure

No new directories. New/changed files:
```
frontend/src/lib/
├── trainArrows.ts                # + applyTrainSpotlight, + alsoFineMoves in
│                                  #   TrainRevealOverlay, + toDisplayQuality,
│                                  #   D-05 recolor of 4 existing call sites
├── __tests__/trainArrows.test.ts # + spotlight + alsoFineMoves + recolor cases

frontend/src/components/
├── icons/
│   └── ArrowGlyphIcon.tsx        # NEW — small colored arrow glyph (LEGEND-01),
│                                  #   built from arrowGeometry.ts's buildArrowPath
├── train/
│   ├── TrainLineStepper.tsx      # header stripped out (D-01) — body only
│   ├── TrainReveal.tsx           # Card/CardHeader wrapping, spotlight wiring,
│   │                              #   alsoFineMoves row, exploration swap render
│   ├── TrainSolveScreen.tsx      # handlePieceDrop branch, isExploring state,
│   │                              #   2nd useStockfishEngine instance,
│   │                              #   handleShowSolution exit-exploration
│   ├── TrainExplorationLine.tsx  # NEW (or a hook) — D-13's clickable/truncating
│   │                              #   move-list state, NOT TrainLineStepper reuse
│   └── __tests__/*.test.tsx      # extend existing 3 suites
```

### Legend glyph (LEGEND-01)

There is no existing "small arrow glyph" icon component in the codebase — grep
confirmed no `ArrowIcon`/arrow-glyph SVG exists outside the board's own arrow
renderer. `[VERIFIED: frontend/src/components/board/arrowGeometry.ts:71-107]`
`buildArrowPath(x1,y1,x2,y2,shaftHalf,headHalf,headLen)` is the exact geometry
the board itself uses to draw an arrow `<path>` — build a tiny new
`ArrowGlyphIcon` component that calls this SAME function with fixed coordinates
(e.g. a horizontal arrow inside a small `viewBox`) and a `color` prop, so the
glyph is visually identical in *shape* to the board arrows, not just matching
color. This keeps LEGEND-01's "small arrow glyph in that move's exact
board-arrow color" honest at the geometry level, not just the color level.

Glyph color per box:
- Box includes the `'best'` role → color = `TRAIN_BEST_MOVE_ARROW` (blue) —
  `[VERIFIED: frontend/src/lib/trainArrows.ts:88, 559]`
  `TRAIN_BEST_MOVE_ARROW: best: TRAIN_BEST_MOVE_ARROW` and
  `export const TRAIN_BEST_MOVE_ARROW = BEST_MOVE_ARROW;` (theme.ts:559).
- Box includes `'your'` only (not merged with best) → color =
  `QUALITY_ARROW_COLOR[displayQuality]` where `displayQuality` collapses
  `'inaccuracy'` to `'good'` (D-04/D-05) — i.e. `MOVE_QUALITY_GOOD` for
  good-or-inaccuracy, `MOVE_QUALITY_MISTAKE`/`MOVE_QUALITY_BLUNDER` otherwise.
- Standalone `'game'` box (game move ≠ played, ≠ best) → color =
  `NEXT_MOVE_ARROW` (`'rgba(255, 255, 255, 0.9)'`,
  `[VERIFIED: frontend/src/lib/theme.ts:426]`) — the thin WHITE arrow, matching
  what is actually drawn for a standalone game-move box, NOT the game move's own
  quality-tier color (`buildTrainRevealOverlay` always draws the game arrow in
  `NEXT_MOVE_ARROW`, `[VERIFIED: frontend/src/lib/trainArrows.ts:281-290]`,
  quoted: `color: NEXT_MOVE_ARROW, width: TRAIN_GAME_MOVE_ARROW_WIDTH, onTop: true, layerKey: 'game'`).
- "Also fine" row → always `DARK_GREEN` (`'#1E6B1E'`,
  `[VERIFIED: frontend/src/lib/arrowColor.ts:30]`) post-D-05, since the yellow
  branch is removed.

### Legend spotlight (LEGEND-02, LEGEND-05)

Add a new pure function to `trainArrows.ts`:

```typescript
// Source: new function, pattern matches buildTrainRevealOverlay's own
// squaresFromUci helper already in this file (trainArrows.ts:178-181)
export function applyTrainSpotlight(
  overlay: TrainRevealOverlay,
  activeUcis: readonly string[] | null,
): TrainRevealOverlay {
  if (activeUcis === null || activeUcis.length === 0) return overlay;
  const activeSquarePairs = activeUcis
    .map((uci) => squaresFromUci(uci))
    .filter((s): s is { startSquare: string; endSquare: string } => s !== null);
  const isActiveArrow = (a: BoardArrow): boolean =>
    activeSquarePairs.some((s) => s.startSquare === a.startSquare && s.endSquare === a.endSquare);
  const activeEndSquares = new Set(activeSquarePairs.map((s) => s.endSquare));
  return {
    arrows: overlay.arrows.filter(isActiveArrow),
    markers: overlay.markers.filter((m) => activeEndSquares.has(m.square)),
  };
}
```

Design notes:
- Takes an **array of UCIs**, not a single one, because the "Also fine" row's
  single glyph represents potentially TWO arrows at once (D-02/D-04: up to
  `TRAIN_SOFT_GOOD_MOVE_ARROWS - 1 = 2` alternatives share one row and one
  glyph — there is no per-SAN-token spotlight granularity since D-02 says the
  row has "no steppable lines" and LEGEND-04 speaks of "the green arrow glyph"
  singular for the whole row). A merged line box still passes a 1-element array.
- Matches by **UCI move identity (start+end square)**, not by `layerKey` string.
  This matters because a merged box (e.g. "Your move / Played in game") can draw
  TWO stacked arrows for the SAME move — the quality-colored arrow (`layerKey:
  'played'` or `'best'`) plus the thin white `layerKey: 'game'` hint arrow drawn
  `onTop` (`trainArrows.ts:281-290`). Filtering by UCI keeps BOTH arrows when
  that box is spotlighted (they are visually "one arrow" per LEGEND-01's own
  framing); filtering by `layerKey` would incorrectly drop the white hint layer.
- Gate spotlight computation OFF whenever `lineStep !== null` or `isExploring`
  is true — those two modes already replace `boardArrows`/`boardMarkers` with
  their own overlays (`TrainSolveScreen.tsx:493-505`), so a stray hover on a
  card while stepping/exploring should have no additional effect. Simplest
  implementation: only apply `applyTrainSpotlight` in the branch that already
  returns `revealOverlay.arrows`/`revealOverlay.markers` today.

**Desktop vs. mobile interaction gate:** the codebase already has a reusable
`matchMedia`-based breakpoint hook idiom —
`[VERIFIED: frontend/src/pages/Bots.tsx:101-113]`, quoted:
```
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    const update = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isDesktop;
}
```
Bots.tsx's own constant is `DESKTOP_BREAKPOINT_PX = 800` (page-specific), but
Train's existing desktop/mobile layout split already uses Tailwind's `lg:`
utilities throughout `TrainSolveScreen.tsx` (e.g. `lg:flex-row lg:items-start
lg:justify-center lg:gap-8`, `TrainSolveScreen.tsx:581`). `[VERIFIED:
frontend/src/index.css:16-17]` — the project's `@theme` block only overrides
`--breakpoint-desk3col: 1200px`, no `lg` override, so Tailwind v4's default `lg`
= 1024px applies. Recommend copying the `useIsDesktop` idiom into a small Train-
local hook (or a shared one) with `1024` as the threshold, so the JS-driven
hover/tap gate agrees exactly with the CSS-driven `lg:` layout switch already in
place — never diverge the two.

### CardHeader restructuring (D-01) and the presentation-collapse gap (LEGEND-03)

`[VERIFIED: frontend/src/components/train/TrainLineStepper.tsx:243-276]` — the
existing header block to extract, quoted (trimmed to structure):
```tsx
{title != null && (
  <div className="flex items-center justify-between gap-2">
    <p ... data-testid="train-line-stepper-title">
      {title}
      {mark != null && (<span data-testid="train-line-stepper-mark" ...>{mark === 'correct' ? '✓' : '✗'}</span>)}
    </p>
    <span className="flex shrink-0 items-center gap-1.5">
      {quality != null && (<span data-testid="train-line-stepper-quality" data-quality={quality}><MoveQualityIcon quality={quality} .../></span>)}
      {evalLabel != null && (<span data-testid="train-line-stepper-eval" ...>{evalLabel}</span>)}
    </span>
  </div>
)}
```
Move this block (keeping the SAME `data-testid` strings, so no other test or
E2E script that greps for `train-line-stepper-title`/`-mark`/`-quality`/`-eval`
needs to change) into `TrainReveal.tsx`, wrapped in `<CardHeader>`, with the
new glyph prepended. `TrainLineStepper.tsx` then drops the `title`/`evalLabel`/
`quality`/`mark` props entirely (or keeps them typed but unused/removed —
recommend removing, since `title != null` is currently also what GATES rendering
the header at all; with the header gone, `TrainLineStepper`'s only job is the
prev/next + token row).

**The gap this research found:** the `quality` value fed to
`MoveQualityIcon` (imported `[VERIFIED: frontend/src/components/train/TrainLineStepper.tsx:31]`
`import { MoveQualityIcon } from '@/components/icons/MoveQualityIcon';`) is the
RAW `TrainMoveQuality` (`'best' | 'good' | FlawSeverity`,
`[VERIFIED: frontend/src/lib/trainArrows.ts:46]`) — for an `'inaccuracy'` value,
`MoveQualityIcon` renders `SeverityQualityIcon` with the yellow severity glyph
(`[VERIFIED: frontend/src/components/icons/MoveQualityIcon.tsx:37-64]`, the
`fill={glyph.color}` circle with the "?!"-style symbol from `SEVERITY_GLYPH`).
D-05 enumerates exactly 4 `trainArrows.ts` call sites to recolor but does NOT
mention this CardHeader icon call site — left untouched, a played inaccuracy
would show a GREEN arrow next to a YELLOW glyph in the same header, exactly the
"mixed-signal problem the recolor set out to remove" (per the Discussion Log's
"Yellow removal — badge and step highlight" section). **Recommend**: export a
`toDisplayQuality(quality: TrainMoveQuality): TrainMoveQuality` helper from
`trainArrows.ts` that maps `'inaccuracy' → 'good'` and is the identity
otherwise, and use it at BOTH the (already-named) badge/arrow/highlight sites
AND the new CardHeader's `<MoveQualityIcon quality={toDisplayQuality(box.quality)} />`
call. This makes the collapse a single source of truth instead of a
convention every call site must remember to apply.

### The EXPLORE-02 prefix gap

`[VERIFIED: frontend/src/components/train/TrainLineStepper.tsx:55-60]`, quoted:
```typescript
export interface TrainLineStep {
  fen: string;
  index: number;
  lastMoveUci: string | null;
  nextMoveUci: string | null;
}
```
`[VERIFIED: frontend/src/components/train/TrainReveal.tsx:110-118]`, quoted:
```typescript
export interface TrainRevealStep {
  lastMoveUci: string;
  quality: TrainMoveQuality | null;
  nextMoveUci: string | null;
  isFirstMove: boolean;
}
```
Neither interface carries the full sequence of moves from the line's start to
the current step — only the single move that led to the CURRENT position. But
`TrainLineStepper` internally already computes the full ordered list:
`[VERIFIED: frontend/src/components/train/TrainLineStepper.tsx:130-150]`, the
`replayLine` function returns `{ fens, ucis, sounds }` where `ucis` is the
complete ordered UCI list for the whole line — the step-reporting effect
`[VERIFIED: frontend/src/components/train/TrainLineStepper.tsx:186-196]` already
has `ucis` and `index` in scope when it fires `onStepChange`, so exposing the
prefix is a one-line addition: `ucis.slice(0, index)`.

**Required change:** add a `prefixUci: string[]` field to `TrainLineStep`
(computed as `ucis.slice(0, index)`) and thread it through
`TrainRevealStep` (`TrainReveal.tsx`'s `handleLineStep` wrapper,
`[VERIFIED: frontend/src/components/train/TrainReveal.tsx:334-348]`) up to
`TrainSolveScreen`'s `lineStep` state. Without this, EXPLORE-02 ("the stepped
prefix moves seed the exploration move list") has no data to seed from beyond
the single last move — which is wrong whenever the user is more than one move
into a stepped line before dropping a free-play piece.

### Exploration seam: `handlePieceDrop` (EXPLORE-01, EXPLORE-02)

`[VERIFIED: frontend/src/components/train/TrainSolveScreen.tsx:361-382]`, current
code, quoted:
```typescript
function handlePieceDrop(source: string, target: string): boolean {
  // D-05: board locked until the binary guess is committed.
  if (guess === null) return false;
  // SOLV-02: exactly one attempt per puzzle.
  if (moveApplied) return false;

  const chess = new Chess(boardFen);
  let move: Move;
  try {
    move = chess.move({ from: source, to: target, promotion: 'q' }); // auto-queen
  } catch {
    return false;
  }
  if (!move) return false;

  setMoveApplied(true);
  setBoardFen(chess.fen());
  const playedUci = `${move.from}${move.to}${move.promotion ?? ''}`;
  setLastPlayedUci(playedUci);
  void gradeAndSolve(guess, playedUci);
  return true;
}
```
The `if (moveApplied) return false;` line is the exact rejection point CONTEXT.md
already flags. The required branch, in order:
1. `guess === null` → unchanged, reject (pre-guess lock).
2. `!moveApplied` → unchanged, existing single-attempt grade+solve flow.
3. `moveApplied && verdict === null` → still reject (solve/grading still pending
   — never start exploration before the puzzle is actually solved, matching the
   documented discretion call "reachable only once the verdict has landed").
4. `moveApplied && verdict !== null` (post-reveal) → NEW: attempt the move via
   `new Chess(boardFen)` (same idiom, `boardFen` already reflects a stepped-into
   line position when `lineStep !== null`, satisfying EXPLORE-02's "start from a
   stepped-into position" for free); on success, either seed exploration (if
   `!isExploring`, using `lineStep?.prefixUci ?? []` plus the new move) or append
   to the existing exploration chain (if `isExploring`, via the exploration
   state's own truncate-then-append operation, D-13); clear `lineStep`; set
   `boardFen` to the resulting position; return `true`.

### Exploration engine (EXPLORE-03, EXPLORE-05, EXPLORE-06) — priority research question

**Decision: mount a second `useStockfishEngine` instance, `enabled: isExploring`,
`fen: explorationFen`. Do not reuse `useTrainGradingEngine` for this and do not
build a shared-engine priority queue.**

Evidence for the API-shape mismatch:
- `[VERIFIED: frontend/src/hooks/useTrainGradingEngine.ts:207-246]` — the public
  `TrainGradingEngine` interface is `startGrading(fen)`, `abortGrading()`,
  `restartEngine()`, `gradeMove(fen, playedMoveUci): Promise<GradeResult>`,
  `startGameMoveSearch(puzzleFen, gameMoveUci): Promise<TrainEngineLine>` — every
  one of these resolves ONCE per call, keyed by an internal `generationRef`
  (`useTrainGradingEngine.ts:377`) that exists specifically to discard a
  superseded search's result when a NEW puzzle starts
  (`useTrainGradingEngine.ts:374-376`, quoted: "Bumped by startGrading/
  abortGrading; used to discard a superseded search's result (Pitfall 3 — a
  stale verdict must never leak into the next puzzle's state)"). There is no
  concept of "the caller wants a running search that keeps re-firing as the FEN
  changes and streams intermediate results" — every method here is a
  request/response task.
- `[VERIFIED: frontend/src/hooks/useStockfishEngine.ts:54-59]`, quoted:
  ```typescript
  export interface UseStockfishEngineOptions {
    /** Current board position. null keeps the engine idle (no go sent). */
    fen: string | null;
    /** When false the Worker is not created and analysis does not run. */
    enabled: boolean;
  }
  ```
  This is EXACTLY "continuous MultiPV eval of an arbitrary FEN" — feed it a new
  `fen` on every board change and it re-searches automatically.
- Cancel-on-position-change is already fully implemented, no new code needed:
  `[VERIFIED: frontend/src/hooks/useStockfishEngine.ts:199-256]` — on every `fen`
  change the effect (a) sends `stop` to the Worker if a search is `'thinking'`
  (quoted: "Stop a still-thinking search for the PREVIOUS position BEFORE this
  effect's own state clears below"), (b) immediately clears `pvLines`/`evalCp`/
  `evalMate`/`depth` state so no orphaned arrow/eval from the old position is
  visible, and (c) the Layer B discard in the `bestmove` handler
  (`useStockfishEngine.ts:433-448`) throws away a stale termination `bestmove`
  and re-analyzes whatever `currentFenRef.current` now holds. This is precisely
  "no search outlives its position" (EXPLORE-05's own wording) — already proven
  in production on the Analysis page.
- Teardown is structural, not a new interlock: `[VERIFIED:
  frontend/src/hooks/useStockfishEngine.ts:467-487]`, the Worker-lifecycle
  effect's cleanup (`worker.postMessage('stop'); worker.terminate();
  workerRef.current = null; ...`) fires automatically whenever `enabled` flips
  false OR the component unmounts — so wiring `enabled: isExploring` means
  Solution-exit, puzzle transition (Next), and component unmount all tear the
  exploration engine down via the SAME, already-tested mechanism, with zero new
  cleanup code to write or get wrong.
- Because the exploration engine is a **separate `Worker` object** from the
  grading engine's Worker (`useTrainGradingEngine.ts:498`, `const worker = new
  Worker(ENGINE_PATH);` vs. `useStockfishEngine.ts:328`, the same call in a
  DIFFERENT hook instance), there is no shared dispatch queue, no shared
  `generationRef`, and structurally no way for an exploration search to "disturb
  grading of the next puzzle" (EXPLORE-05's other clause) — they cannot
  interfere because they are different objects. A single-shared-engine +
  priority-queue design (option c) would have to manufacture this isolation by
  hand; two independent Workers get it for free.

Evidence the mobile-OOM concern does not block this:
- `[VERIFIED: frontend/src/lib/engine/workerPool.ts:42, 64-79]`, quoted:
  ```typescript
  export const ENGINE_PATH = '/engine/stockfish-18-lite-single.js';
  ...
  export const WORKER_HASH_MB = 8;
  export const DESKTOP_POOL_MIN = 2;
  export const DESKTOP_POOL_MAX = 4;
  export const DESKTOP_HEADROOM_CORES = 2;
  export const MOBILE_POOL_SIZE = 2;
  /** `hardwareConcurrency` at or below this counts as "mobile" (D-01). */
  export const MOBILE_CORE_THRESHOLD = 4;
  ```
  This is the Analysis page's FlawChessEngine pool — on a device classified
  "mobile" (`hardwareConcurrency <= 4`), it ALREADY runs 2 concurrent Stockfish
  workers from this pool alone, on top of the Analysis page's own single
  `useStockfishEngine` display instance and a separate Maia ONNX worker — 4
  total WASM/ONNX workers concurrently, using the literal SAME `ENGINE_PATH`
  constant Train's grading and exploration engines use. This has shipped since
  Phase 154-161 (v2.0, per `.planning/STATE.md`'s milestone log) with no
  reported OOM regression for the Stockfish side specifically.
- `[VERIFIED: .planning/STATE.md]` (Key Context section), quoted: "v1.29 WASM
  engine: stockfish-18-lite-single.{js,wasm} (~7 MB)... v1.29 D-3 locked:
  single-thread WASM only; no COOP/COEP headers site-wide; multi-thread
  explicitly deferred (D-3)." Both the grading engine and any new exploration
  engine use this exact single-thread lite build — the smallest-memory-
  footprint Stockfish build the project has, chosen specifically for this
  reason.
- The documented Maia iOS OOM history (`project_maia_ios_two_failure_populations`
  memory note) is specifically about onnxruntime-web's WASM heap plus the ~44 MB
  `maia3_simplified.onnx` model on iOS Safari — an order of magnitude larger
  single-asset footprint than a second 7 MB Stockfish instance, and EXPLORE-03
  explicitly excludes Maia from the exploration card ("no Maia card, no
  FlawChess engine card"), so this phase never touches the ONNX runtime at all.
- Train's worst case is 2 Stockfish workers total (1 idle grading + 1 active
  exploring) — strictly fewer than what Analysis already runs concurrently on
  the same device class today.

**Wiring in `TrainSolveScreen.tsx`:**
```typescript
// New local state (alongside the existing lineStep/solutionNonce state,
// TrainSolveScreen.tsx:187-208):
const [isExploring, setIsExploring] = useState(false);
const [explorationUci, setExplorationUci] = useState<string[]>([]); // full chain from puzzle.fen
const [explorationIndex, setExplorationIndex] = useState(0); // D-13: current position in the chain

// Derive the FEN the exploration engine analyzes — replay explorationUci up to
// explorationIndex from puzzle.fen (same replay idiom as TrainLineStepper's
// replayLine / TrainReveal's replayPvLine — reuse, don't reinvent).
const explorationFen = isExploring ? replayToIndex(puzzle.fen, explorationUci, explorationIndex) : null;

const explorationEngine = useStockfishEngine({ fen: explorationFen, enabled: isExploring });
```
`EngineLines` then renders directly off `explorationEngine.pvLines`/
`isAnalyzing`, with `baseFen={explorationFen ?? undefined}` and an
`onMoveClick` that appends the clicked PV prefix to `explorationUci`
(truncating at `explorationIndex` first per D-13) — this is the SAME prop shape
`EngineLines` already exposes (`[VERIFIED:
frontend/src/components/analysis/EngineLines.tsx:195-224]`, quoted: "Called
when the user clicks a PV move chip with the UCI moves from the start of the
line up to (and including) the clicked move").

Recommend NOT reusing `TrainLineStepper` for the exploration move list itself —
build a small dedicated component/hook (`TrainExplorationLine` or a
`useExplorationLine` hook) that owns `{ moves, index }` state directly and
exposes `playMove(uci)` (truncate at `index`, append, advance `index`) and
`jumpTo(i)` (navigate without truncating) — matching D-13's "clickable single
chain that truncates" INTERACTION model without inheriting
`TrainLineStepper`'s reset-on-content-change behavior (`TrainLineStepper.tsx:
182-184`, `useEffect(() => setIndex(0), [movesKey, startFen, resetNonce])`),
which resets to index 0 on ANY content change — correct for a puzzle's fixed
reveal line, wrong for an appendable exploration chain.

### Also-fine row derivation (LEGEND-03, LEGEND-04)

`[VERIFIED: frontend/src/lib/trainArrows.ts:266-279]`, the exact selection/skip
logic to mirror, quoted:
```typescript
cappedFineMoves.forEach((fine, index) => {
  if (fine.uci === bestMoveUci || fine.uci === playedMove?.uci) return;
  const squares = squaresFromUci(fine.uci);
  if (squares === null) return;
  arrows.push({
    ...squares,
    color: fine.quality === 'inaccuracy' ? MOVE_QUALITY_INACCURACY : DARK_GREEN,
    width: TRAIN_GOOD_MOVE_ARROW_WIDTH,
    layerKey: `good-${index}`,
  });
});
```
D-05 changes the `color:` line to always `DARK_GREEN` (remove the ternary).
D-03's "the row lists only alternatives ACTUALLY drawn as green arrows" is
exactly the set produced by this loop (after the `bestMoveUci`/`playedMove`
skip). **Recommend**: rather than have the UI layer (`TrainReveal.tsx`)
independently recompute this same cap+skip logic (risking drift from what's
actually drawn — the precise bug LEGEND-03/D-03 exists to prevent), extend
`TrainRevealOverlay`'s return shape with a new field:
```typescript
export interface TrainRevealOverlay {
  arrows: BoardArrow[];
  markers: SquareMarker[];
  alsoFineMoves: TrainFineMove[]; // NEW — exactly the fine moves this call actually drew as arrows
}
```
populated inside the SAME loop shown above (push to `alsoFineMoves` alongside
`arrows`), so the sidebar row is structurally guaranteed 1:1 with the board —
the invariant D-03 wants — rather than relying on two independent call sites
staying in sync by convention.

### Anti-Patterns to Avoid
- **Re-deriving the fine-move cap/skip logic in the UI layer**: would risk the
  "Also fine" row showing a move that isn't actually drawn (or vice versa),
  exactly the 1:1 invariant D-03 locks. Derive it from the overlay builder.
- **Filtering the spotlight by `layerKey` string instead of UCI move identity**:
  breaks the merged-box case where two arrows (colored + thin white game hint)
  share one UCI but have different `layerKey`s.
- **Reusing `TrainLineStepper` verbatim for the exploration list**: its
  `movesKey`-triggered reset-to-index-0 effect actively fights an appendable
  move list.
- **Building a shared-engine priority queue for grading vs. exploration**: no
  contention exists in the actual UI flow (grading is idle during the entire
  reveal/exploration window); this is solving a problem the architecture
  doesn't have.
- **Applying the inaccuracy→good collapse only inside `trainArrows.ts`**: leaves
  the CardHeader's `MoveQualityIcon` showing yellow — see the LEGEND-03 gap
  above.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Continuous MultiPV eval of an arbitrary FEN with cancel-on-position-change | A new engine hook, or a continuous-eval mode bolted onto `useTrainGradingEngine` | The existing `useStockfishEngine` hook, mounted a second time | Already implements debounce, stale-search discard, and clean teardown — proven in production on Analysis |
| Stockfish PV line rendering + click-to-play | A Train-specific PV renderer | `EngineLines` (`replayPvLine`, `formatScore`, `MAX_LINES`), already imported by `TrainReveal.tsx` | Single source of truth for PV rendering across Analysis and Train; `onMoveClick` already gives the exact prefix-to-click semantics D-14 wants |
| "Click outside to dismiss" for the mobile tap-spotlight | A generic `useClickOutside` hook (none exists in this codebase — grep confirmed) | A small local `document` `pointerdown`/`click` listener scoped to the reveal panel's lifetime, active only while a mobile spotlight is set | The codebase has no existing click-outside utility to reuse (Radix `Popover`'s dismiss-on-outside-interaction is designed around actual popover panels, not a spotlight-a-list-item pattern — forcing it here would be a worse fit than a 10-line effect) |
| Card hover/active highlight styling | A new visual treatment invented from scratch | Reuse the existing "active" token convention: `bg-brand-brown`/`text-white` already marks the active SAN token in `TrainLineStepper.tsx:308-313`; recommend a `ring-2 ring-brand-brown`-style treatment for the spotlighted card for visual family resemblance | `[ASSUMED]` — no existing "active card" ring pattern was found elsewhere in the codebase to cite as precedent; this is a recommendation, not a verified existing convention, and the exact Tailwind utility is a plan/executor-time visual choice |

**Key insight:** every piece of new *mechanism* this phase needs (continuous
engine eval, PV rendering, click-to-play, Card/CardHeader shell) already exists
in the codebase in a directly reusable shape. The actual new work is (1) a pure
overlay-filter function, (2) a small glyph icon, (3) a small
append/truncate move-list state model, and (4) wiring — not new infrastructure.

## Common Pitfalls

### Pitfall 1: Spotlight computed on the wrong overlay branch
**What goes wrong:** Applying `applyTrainSpotlight` inside the `lineStep !== null`
or `isExploring` branches of the `boardArrows`/`boardMarkers` computation
(`TrainSolveScreen.tsx:493-499`) instead of only the `revealOverlay` (pristine)
branch — causes a stray sidebar hover during line-stepping or exploration to
unexpectedly hide the step-overlay's single blue next-move arrow.
**Why it happens:** The three overlay modes (pristine reveal / stepping / exploring)
are computed in one ternary chain today; it's easy to thread a new filter through
all three branches by habit.
**How to avoid:** Only wrap the `else` (pristine `revealOverlay`) branch.
**Warning signs:** A stepped line's next-move arrow disappears when the mouse
happens to be resting over a (now-hidden, since `showResultRow` still renders
`TrainReveal`) sidebar card.

### Pitfall 2: `movesKey`-triggered reset clobbering exploration
**What goes wrong:** If the exploration move list is implemented by simply
passing a growing array into `TrainLineStepper`, every appended move changes
`movesKey` (`moves.join(' ')`), which re-fires the reset effect
(`TrainLineStepper.tsx:182-184`) and snaps `index` back to 0 — the board jumps
back to the exploration's start position every time a move is played.
**Why it happens:** `TrainLineStepper` was designed for a FIXED line (only
`resetNonce`/`startFen` legitimately change); nothing in its contract
anticipates a caller mutating `moves` in place.
**How to avoid:** Build a separate small state model for exploration (see
Architecture Patterns above) rather than reusing `TrainLineStepper`.
**Warning signs:** Manual UAT: play any exploration move and watch the board
snap back to the position before that move.

### Pitfall 3: `handlePieceDrop`'s guard order regresses SOLV-02
**What goes wrong:** Adding the new post-verdict branch ABOVE the existing
`if (moveApplied) return false;` check (rather than after it, gated on `verdict
!== null`) could accidentally let a SECOND grading attempt slip through before
the first one's solve POST has landed, double-submitting a solve.
**Why it happens:** The new branch and the existing "exactly one attempt" gate
both key off `moveApplied`, inviting an off-by-one reordering mistake.
**How to avoid:** Preserve the EXACT existing guard order (`guess === null` →
`!moveApplied` unchanged flow) and add the new branch strictly AFTER, gated on
`moveApplied && verdict !== null`.
**Warning signs:** A double `solvePuzzle` mutation firing, or an exploration
move being graded as if it were the puzzle attempt.

### Pitfall 4: Forgetting to reset `isExploring` on puzzle transition
**What goes wrong:** If `isExploring`/`explorationUci`/`explorationIndex` are
not added to the existing per-puzzle reset block
(`TrainSolveScreen.tsx:271-283`, the effect keyed on `puzzle.fen`), a NEW puzzle
could mount with the PREVIOUS puzzle's exploration state still active, showing
stale engine lines rooted at the wrong FEN before EXPLORE-05's teardown even
has a chance to matter.
**Why it happens:** That reset block already lists ~8 pieces of per-puzzle state
explicitly (`setGuess`, `setBoardFen`, `setMoveApplied`, ... `setLineStep(null)`,
`setPointsFlash(null)`) — a new state triple is easy to omit by not scrolling to
the end of an already-long list.
**How to avoid:** Add `setIsExploring(false)`, `setExplorationUci([])`,
`setExplorationIndex(0)` to that SAME reset block, not a separate effect.
**Warning signs:** The `useStockfishEngine({enabled: isExploring})` instance's
own `enabled` effect re-fires (tearing down/recreating a Worker) on every puzzle
transition even when the user never explored — a symptom of state genuinely
carrying over rather than being cleanly reset first.

## Code Examples

### Pure spotlight builder — test shape to extend

`trainArrows.test.ts` already establishes the exact test idiom to follow for the
new `applyTrainSpotlight` function:
```typescript
// Source: frontend/src/lib/__tests__/trainArrows.test.ts:29-41 (existing pattern)
describe('applyTrainSpotlight', () => {
  it('returns the overlay unchanged when activeUcis is null', () => {
    const overlay = buildTrainRevealOverlay('soft', good('e2e4', 'd2d4'), 'e2e4', null, null, true);
    expect(applyTrainSpotlight(overlay, null)).toEqual(overlay);
  });

  it('keeps only the arrows/markers matching the active UCI, including a stacked onTop arrow on the same move', () => {
    // build an overlay where a game move coincides with the played move (D-03
    // merged-box shape), assert BOTH the colored arrow and the thin white
    // `layerKey: 'game'` arrow survive when spotlighting that UCI.
  });
});
```

### Reusing `EngineLines` for the exploration card

```tsx
// Source: pattern already established at frontend/src/components/train/TrainReveal.tsx:45
// (replayPvLine/formatScore already imported here) — EngineLines itself:
// frontend/src/components/analysis/EngineLines.tsx:380-424
<EngineLines
  pvLines={explorationEngine.pvLines}
  isAnalyzing={explorationEngine.isAnalyzing}
  baseFen={explorationFen ?? undefined}
  flipped={puzzle.side_to_move === 'black'}
  onMoveClick={(uciMoves) => appendPvLineToExploration(uciMoves)}
/>
```

## State of the Art

Not applicable in the "library upgrade" sense — this phase makes no framework or
library version change. The one relevant "state of the art" note is internal:
the Analysis page's engine architecture (Phase 136-161) is the ALREADY-CURRENT
pattern for "a Stockfish instance analyzing a live-changing FEN"; this phase
brings that same pattern to Train rather than inventing a new one.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The "Also fine" row's single glyph spotlights ALL of its (up to 2) drawn alternative arrows together, not one SAN token individually | Architecture Patterns / Legend spotlight | If the planner instead wants per-token spotlight granularity, `applyTrainSpotlight`'s array-based signature already supports it (pass a 1-element array per token) — low risk, but the row's SAN tokens are not individually clickable/hoverable in the current design (D-02: "no steppable lines"), so a per-token spotlight target would need new sub-glyphs or hover zones not implied by LEGEND-04's wording |
| A2 | A `ring-2 ring-brand-brown`-style Tailwind treatment is an acceptable visual language for the spotlighted card's active-highlight (D-07) | Don't Hand-Roll table | No existing "active card" ring convention was found in this codebase to cite as precedent; this is purely a suggested starting point, not a locked visual spec — `--skip-ui` means no UI-SPEC.md exists to consult, and the planner/executor should treat the exact styling as free within CLAUDE.md's Button/theme constraints |
| A3 | `useStockfishEngine`'s existing debounce (`RAPID_STEP_DEBOUNCE_MS = 150`) and throttle (`PV_COMMIT_THROTTLE_MS = 150`) constants are appropriate as-is for exploration's UX, with no Train-specific tuning needed | Priority research answer | Low risk — these values were tuned for the Analysis page's identical "drag through positions" interaction pattern, which exploration's free-play board drop-by-drop interaction closely resembles; if perceived latency feels off in UAT, these are simple constant tweaks, not architecture changes |
| A4 | Tailwind's default `lg` breakpoint (1024px) is unmodified in this project, confirmed only by the absence of an override in `index.css`'s `@theme` block, not by inspecting Tailwind's own resolved config output | Legend spotlight desktop/mobile gate | If some other mechanism silently changes `lg`, the JS `matchMedia` gate (recommended at 1024px) could disagree with the CSS-driven `lg:` layout split; low risk since `index.css:16-17` is the only `@theme` block in the file and was read directly this session |

**If this table is empty:** N/A — see above.

## Open Questions (RESOLVED)

Both questions below were carried into planning and dispositioned there as flagged
planner assumptions. Neither remains open.

1. **Exact visual treatment of the spotlighted card and the arrow glyph's exact
   pixel size/placement.**
   - What we know: D-07 requires a two-sided effect (card itself highlighted +
     board filtered); the glyph must precede the title (LEGEND-01).
   - What's unclear: `--skip-ui` means no UI-SPEC.md exists to pin exact
     Tailwind classes, glyph dimensions, or the precise ring/border treatment.
   - Recommendation: treat as executor-time visual polish within CLAUDE.md's
     `text-sm` floor and theme-constant constraints — not a plan-blocking gap.
   - **RESOLVED** by assumption A-01 in `200-01-PLAN.md`: `data-spotlight` is the
     test contract; the Tailwind ring class is executor-adjustable polish. Also
     bounded by CONTEXT.md D-06/D-07.

2. **Whether the exploration board should show ANY engine arrow, or stay
   arrow-free (matching "solution arrows clear").**
   - What we know: EXPLORE-03 only mandates the engine-lines CARD + move list;
     Claude's Discretion section is silent on board arrows during exploration.
   - What's unclear: whether an Analysis-page-style best-move arrow adds value
     here or clutters what's meant to be a clean free-play board.
   - Recommendation: default to NO board arrow during exploration (empty
     `boardArrows`/`boardMarkers`), consistent with "no mode toggle... pure free
     play" — the engine card already surfaces the refutation. Flag for the
     planner to confirm rather than silently deciding.
   - **RESOLVED** by assumption A-02 in `200-03-PLAN.md`: exploration board is
     arrow-free; the last-move highlight is kept for orientation.

## Environment Availability

Skipped — this phase has no external tool/service/runtime dependency beyond
what is already vendored in the repo (`public/engine/stockfish-18-lite-single.
{js,wasm}`, already present and already loaded twice per session on the
Analysis page today). No new environment probe is needed.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (existing, `@testing-library/react`) |
| Config file | existing `frontend/vitest.config.ts` (unchanged by this phase) |
| Quick run command | `cd frontend && npx vitest run src/lib/__tests__/trainArrows.test.ts` |
| Full suite command | `cd frontend && npm test -- --run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LEGEND-03 | Inaccuracy tier renders as `good` (arrow/badge/highlight) everywhere, including a played inaccuracy | unit | `npx vitest run src/lib/__tests__/trainArrows.test.ts` | ✅ (extend existing) |
| LEGEND-04 | `alsoFineMoves` matches exactly the drawn green arrows, capped by puzzle type | unit | same file | ✅ (extend existing) |
| LEGEND-05 | `applyTrainSpotlight` filters arrows+markers by UCI, preserving stacked onTop arrows on a merged move | unit | same file | ✅ (extend existing) |
| LEGEND-01/02/06 | Glyph renders per box, hover/tap toggles spotlight, works in the mobile (below-board) DOM order | component | `npx vitest run src/components/train/__tests__/TrainReveal.test.tsx` | ✅ (extend existing 744-line suite) |
| EXPLORE-01/02 | Post-verdict drop starts exploration; a stepped-line drop seeds the prefix | component | `npx vitest run src/components/train/__tests__/TrainSolveScreen.test.tsx` | ✅ (extend existing, already runs `useTrainGradingEngine` "for real" against a fake `Worker` — mirror that pattern for the new `useStockfishEngine` instance, reusing the `MockWorker` shape from `useStockfishEngine.test.ts:23-42`) |
| EXPLORE-03/04/05/06 | Engine card swap-in, Solution exits, teardown on transition/Next/unmount, Analyze unchanged | component | same file | ✅ (extend existing) |
| EXPLORE-07/LEGEND-06 | Mobile layout at 375px | component (jsdom has no real viewport, so this asserts DOM structure/class presence, not pixel layout) | same file | ✅ — genuine pixel-level 375px verification is a manual/browser check, flag as such |

### Sampling Rate
- **Per task commit:** `npx vitest run <changed test file>`
- **Per wave merge:** `npm test -- --run` (frontend full suite) + `npm run lint` +
  `npx tsc -b` (per CLAUDE.md's "run tsc -b when changing shared types or
  property access" — this phase changes `TrainRevealOverlay`, `TrainLineStep`,
  `TrainRevealStep` shared interfaces, so this is NOT optional here)
- **Phase gate:** Full suite green before `/gsd-verify-work`; a manual 375px
  browser check for the spotlight tap-target and the exploration swap layout
  (jsdom cannot verify actual pixel layout)

### Wave 0 Gaps
None — existing test infrastructure (`trainArrows.test.ts`, `TrainReveal.test.tsx`,
`TrainSolveScreen.test.tsx`, `TrainLineStepper.test.tsx`, `useStockfishEngine.test.ts`'s
`MockWorker` fake) covers every test type this phase needs; no new framework or
fixture is required.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Unchanged — this phase touches no auth surface |
| V3 Session Management | no | Unchanged |
| V4 Access Control | no | Unchanged — no new endpoint, no new data exposure |
| V5 Input Validation | yes | Every UCI/SAN move the exploration free-play board accepts is validated through `chess.js`'s `move()` call inside a `try/catch` (the SAME idiom already used at `TrainSolveScreen.tsx:367-374` and `TrainLineStepper.tsx:140-144`) — an illegal/malformed drop is rejected (`return false`), never silently coerced |
| V6 Cryptography | no | Not applicable — no new secret, token, or crypto operation |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Engine string (SAN/PV move labels) rendered unescaped | Tampering/Info Disclosure (XSS) | Already covered by React's default auto-escaping of string children — `EngineLines.tsx`'s own module docstring already notes "All engine strings are rendered as React children (auto-escaped, T-137-03 mitigated)" (`EngineLines.tsx:19`); this phase adds no `dangerouslySetInnerHTML` anywhere |
| A malicious/malformed FEN reaching the new `useStockfishEngine` instance | Tampering | `explorationFen` is always derived from `puzzle.fen` (server-trusted, already validated at import time) replayed through `chess.js` moves the user made ON THE BOARD — never a raw user-supplied FEN string; no new attack surface beyond what the existing board drop handler already guards |
| Runaway/never-terminating exploration search draining battery/CPU | Denial of Service (self-inflicted, not attacker-driven) | `useStockfishEngine`'s existing `MOVETIME_MS = 1500` / `MAX_NODES = 2000000` search caps (`useStockfishEngine.ts:27-30`) already bound every search; EXPLORE-05's teardown-on-unmount/transition further bounds total exposure |

## Sources

### Primary (HIGH confidence — read directly this session)
- `frontend/src/lib/trainArrows.ts` — full file read, overlay builder, color maps
- `frontend/src/hooks/useTrainGradingEngine.ts` — full file read, imperative API,
  generation-keyed dispatch queue
- `frontend/src/hooks/useStockfishEngine.ts` — full file read, continuous
  debounced re-analysis, stale-search discard, Worker lifecycle
- `frontend/src/components/analysis/EngineLines.tsx` — full file read,
  `replayPvLine`, `formatScore`, `onMoveClick`, `MAX_LINES`
- `frontend/src/components/train/TrainReveal.tsx` — full file read, `LineBox`/
  `TrainRevealStep`/`buildLineBoxes`/`handleLineStep`
- `frontend/src/components/train/TrainSolveScreen.tsx` — full file read,
  `handlePieceDrop`, `handleShowSolution`, overlay branching, per-puzzle reset
- `frontend/src/components/train/TrainLineStepper.tsx` — full file read, header
  render block, `replayLine`, reset effect
- `frontend/src/components/ui/card.tsx` — full file read, `Card`/`CardHeader`/
  `CardBody`
- `frontend/src/pages/Train.tsx` — full file read, page-level layout/state
- `frontend/src/components/board/arrowGeometry.ts` — full file read,
  `buildArrowPath`, `dedupeArrowsByMove`
- `frontend/src/components/icons/MoveQualityIcon.tsx` — full file read
- `frontend/src/lib/engine/workerPool.ts` (grepped: `ENGINE_PATH`, pool-size
  constants, `isLowPowerDevice`/`computePoolSize`)
- `frontend/src/lib/theme.ts` (grepped: all color constants cited)
- `frontend/src/lib/arrowColor.ts` (grepped: `DARK_GREEN`/`DARK_BLUE`)
- `frontend/src/types/train.ts` (grepped: `TrainPuzzle`/`SolveResponse`/
  `PuzzleRevealResponse`)
- `frontend/src/lib/trainScore.ts` (grepped: `TrainMoveTier`, `moveTierFromSeverity`)
- `frontend/src/types/library.ts` (grepped: `FlawSeverity`)
- `frontend/src/pages/Bots.tsx` (grepped: `useIsDesktop`/`DESKTOP_BREAKPOINT_PX`)
- `frontend/src/index.css` (grepped: `@theme` block, breakpoint overrides)
- `frontend/src/lib/__tests__/trainArrows.test.ts` — read (excerpt), established
  test idiom
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — read
  (excerpt), `MockWorker`/`ChessBoard` mock idiom
- `frontend/src/hooks/__tests__/useStockfishEngine.test.ts` (grepped:
  `MockWorker` class)
- `.planning/phases/200-train-solve-screen-board-legend-inline-sideline-exploration/200-CONTEXT.md`
  and `200-DISCUSSION-LOG.md` — full read, locked decisions
- `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/config.json` —
  full/partial read, requirement text, milestone history, workflow flags
- `CLAUDE.md` (project root) — full read, project constraints

### Secondary (MEDIUM confidence)
None — no external documentation lookup was needed; every claim traces to a
file read this session or a locked decision copied verbatim from CONTEXT.md.

### Tertiary (LOW confidence)
None — see Assumptions Log for the handful of inferred/recommended (not
verified-as-existing) design choices, each explicitly tagged there.

## Project Constraints (from CLAUDE.md)

- No `text-xs` outside hover/tap-activated info-tooltip popovers — the new
  glyph/CardHeader/exploration-card UI must stay at `text-sm` or larger.
- Theme colors only from `frontend/src/lib/theme.ts` (plus `arrowColor.ts`'s
  `DARK_GREEN`, already the established secondary source for arrow colors) —
  never a fresh hex/oklch literal for the glyph or spotlight highlight.
- `noUncheckedIndexedAccess` is on — any new array indexing (e.g. into
  `explorationUci`, `pvLines`) must be narrowed before use, matching the
  existing `visibleLines[lineIndex]` narrowing pattern in `EngineLines.tsx:404-407`.
- `data-testid` on every new interactive element — the new arrow glyph
  (hoverable/tappable), the Card wrapper, and any new exploration move-list
  tokens all need kebab-case, component-prefixed testids per the naming
  convention (`btn-{action}`, `{component}-{element}-{id?}`).
- Mobile parity — every change (glyph, spotlight, Card restructuring,
  exploration swap) must be verified in BOTH the desktop (`lg:` sidebar) and
  mobile (below-board, stacked) DOM paths — they share the SAME `TrainReveal`
  render tree (no separate desktop/mobile markup exists in this component
  today, `TrainReveal.tsx:489`'s single `<div className="... lg:mt-[46px]
  lg:max-w-sm">` wrapper), so most parity risk here is interaction-model
  (hover vs. tap), not duplicated-markup risk.
- Nesting depth (soft 3/hard 4) and logic-LOC (soft 100/hard 200) limits —
  CONTEXT.md already flags `TrainSolveScreen.tsx` (800 LOC) and `TrainReveal.tsx`
  (627 LOC) as already-large files; this phase's additions (isExploring
  branch, second engine hook, spotlight state) should be extracted into helper
  functions/a small hook rather than inlined further into
  `TrainSolveScreen`'s body if they would push it past the limit — refactor-
  on-sight applies if a touched function already breaches the limit.
- Primary vs. secondary button variants (`variant="default"` vs.
  `variant="brand-outline"`) — not directly relevant here (no new buttons beyond
  the existing Solution/Analyze/Next row), but if the exploration card needs a
  "Solution" affordance duplicated, reuse the SAME visibility-gated button
  already in `TrainSolveScreen.tsx:645-694`, do not add a second one.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new library, every reused module read directly this session
- Architecture: HIGH — every integration seam (handlePieceDrop, handleShowSolution,
  overlay branching, engine hooks) cited with file:line and verbatim quotes
- Pitfalls: HIGH — each pitfall derives from a specific, quoted code behavior
  (the reset effect, the guard order, the reset-block completeness) rather than
  general chess-app folklore

**Research date:** 2026-08-01
**Valid until:** 30 days (stable internal codebase, no external API drift risk)
