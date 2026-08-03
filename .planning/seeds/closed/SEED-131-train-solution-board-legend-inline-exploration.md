---
id: SEED-131
status: implemented
planted: 2026-07-31
planted_during: /gsd-explore session on Train puzzle solution UX
trigger_when: next Train-focused milestone/phase planning round, or whenever Train solve-screen UX comes up again
scope: medium-large (one phase; frontend-only, no backend/schema changes)
---

# SEED-131: Train solution screen — board legend + inline sideline exploration

## Why This Matters

The post-solve reveal board can draw up to 5 overlapping arrows at once (blue
best move, quality-colored played move, up to 2 green/yellow alternatives, thin
white "played in game" on top), each with a corner quality badge. In practice
(see the 3-of-6 screenshot from the exploration session) the arrows cross and
the user cannot tell which move was played, which is best, and what the fine
alternatives are. Three distinct failures were confirmed: too many arrows at
once, no self-explanatory color/role vocabulary, and played-vs-best-vs-game
role confusion.

Separately, answering "why didn't my move work?" today requires the Analyze
deep-link, which exits the Train flow to the full Analysis page (browser back
to return). Sideline exploration should be possible without leaving the solve
screen.

## Locked decisions (from the /gsd-explore session, 2026-07-31)

### A. Board legibility — keep all info, fix the encoding

1. **Sidebar-as-legend**: each reveal line box (Your move / Best move / Played
   in game) gets a small arrow glyph rendered in that move's exact board-arrow
   color, placed right before the box title. No separate on-board legend strip.
2. **Hover/tap spotlight (negative highlight)**: hovering or tapping a sidebar
   arrow glyph hides ALL other arrows on the board, leaving only that box's
   move visible. Works on touch (tap) as well as hover.
3. **Inaccuracy alternatives render green**: fine-move alternatives of
   'inaccuracy' tier are colored the same green as 'good' ones. Rationale: the
   grading engine already counts them as correct answers (SOLV-03), so the
   board's language should match the verdict's language. Yellow disappears
   from the reveal board. No upstream puzzle-curation change (rejected:
   backend/pool side effects for a display-language problem). The line eval
   still discloses the small drop for anyone who digs in.
4. **"Also fine" compact row**: alternatives get a sidebar presence so the
   legend covers everything on the board — one row like "Also fine: Nc4, Rd8"
   with the green arrow glyph, participating in the spotlight interaction.
   SAN tokens only, no steppable lines, no full line boxes (rejected: sidebar
   too tall on soft puzzles).

### B. Inline sideline exploration — board always live

5. **No mode switch**: post-solve, moving a piece on the shared board starts
   exploring immediately. No explicit "explore mode" toggle to learn.
6. **Seed from stepped positions**: exploration is startable from a
   stepped-into line box position (e.g. 3 moves into "Your move", then play a
   different move). The stepped prefix moves seed the exploration move list.
   This is the core "why didn't my move work" flow.
7. **Sidebar swaps to analysis view**: the moment exploration starts, the
   reveal boxes give way to a Stockfish engine-lines card + a move list of the
   explored line. Explicitly NO Maia card and NO FlawChess engine card —
   Stockfish lines + move list only. Solution arrows clear while exploring.
8. **Solution button restores**: the existing Solution button (which already
   resets steppers via `solutionNonce`) also exits exploration and restores
   the full reveal state (boxes + arrows).
9. **Analyze deep-link stays**: the Analyze button keeps deep-linking to the
   full Analysis page unchanged — it still offers Maia, FlawChess engine, and
   whole-game context that inline exploration deliberately omits.

## Open research question (resolve during phase research)

**Which Stockfish instance powers inline exploration?** Options: reuse the
session-scoped Train grading engine (`useTrainGradingEngine`, already mounted
and warm) vs mounting the Analysis page's Stockfish hook alongside it.
Considerations:

- Memory: two concurrent WASM engines on one page; mobile OOM history (see
  Maia iOS failure populations) argues against doubling the footprint.
- The grading engine's API is search-task-shaped (gradeMove,
  startGameMoveSearch); live exploration wants continuous MultiPV eval of an
  arbitrary FEN with cancel-on-position-change semantics — check whether the
  grading engine can serve that without disturbing in-flight grading of the
  NEXT puzzle (prefetch/grading pipeline), or whether a shared single engine
  with a priority queue is needed.
- Lifecycle across puzzle transitions and Next: exploration state and any
  running search must be torn down cleanly.

## Implementation anchors (current code)

- `frontend/src/components/train/TrainReveal.tsx` — reveal panel, line boxes,
  `buildLineBoxes()` role merging (coinciding moves share one box; the legend
  glyph must handle merged roles, e.g. "Your move / Best move" = one glyph).
- `frontend/src/lib/trainArrows.ts` — pure arrow/badge overlay builder; the
  spotlight filter and green-recolor land here (unit-testable).
- `frontend/src/components/train/TrainSolveScreen.tsx` — board owner, arrow
  state, Solution/Analyze/Next row, `handleAnalyzeClick`, `solutionNonce`.
- `frontend/src/components/train/TrainLineStepper.tsx` — steppers whose
  stepped FEN would seed exploration (decision 6).
- `frontend/src/components/analysis/EngineLines.tsx` — existing Stockfish
  lines card (`replayPvLine`, `formatScore` already imported by TrainReveal);
  candidate for reuse in the swap-in analysis view.
- Mobile parity: the solve screen has a single shared board; the sidebar
  content renders below the board on mobile — spotlight must work via tap,
  and the swap-to-analysis view applies to the mobile layout too.

## Out of scope

- Backend/puzzle-pool changes of any kind (decision 3 rejected curation).
- Maia / FlawChess engine cards in the inline view (decision 7).
- Changes to the full Analysis page or the Analyze deep-link target
  (decision 9).
