# Phase 200: Train Solve Screen — Board Legend & Inline Sideline Exploration - Context

**Gathered:** 2026-08-01
**Status:** Ready for planning

<domain>
## Phase Boundary

The post-solve reveal surface on `/train`: make the arrow overlay readable by turning
the sidebar into the board's own legend, and let the user branch off the same shared
board to answer "why didn't my move work" without leaving the solve screen.

Frontend-only. No backend endpoint, no schema, no migration, no puzzle-pool or
curation change. The Analysis page and the Analyze deep-link target are untouched.

Requirements: LEGEND-01..06, EXPLORE-01..07 (see `.planning/REQUIREMENTS.md`).

</domain>

<decisions>
## Implementation Decisions

SEED-131 already locked the shape of this phase (sidebar-as-legend, spotlight as a
negative highlight, inaccuracy→green, "Also fine" compact row, no explore-mode
toggle, exploration seeded from stepped positions, Stockfish-only swap-in card,
Solution restores, Analyze unchanged). Those are NOT restated as decisions here —
read the seed. The decisions below are what this discussion resolved on top of it.

### Legend structure

- **D-01:** The three reveal line boxes become real `Card` + `CardHeader` components
  (`@/components/ui/card`, already used by `TrainStatsCard`, `TrainStreakCard`,
  `TrainScheduleSettings`). The arrow glyph, title, verdict mark, and eval live in
  `CardHeader`; the stepper body lives below it. Today these are bare `<div>`s and
  `TrainLineStepper` renders its own title row — that header moves into `CardHeader`,
  so `TrainLineStepper` is restructured, not just wrapped.
  — **Reversibility:** costly — the header currently belongs to `TrainLineStepper`
  (title/mark/quality/eval testids live there and are asserted by
  `TrainLineStepper.test.tsx` and `TrainReveal.test.tsx`); moving it changes the
  component's public shape and both test files.

- **D-02:** The "Also fine: Nc4, Rd8" row stays a **compact row, not a Card**. It has
  no stepper and no eval, so a Card shell would be mostly chrome and would grow the
  sidebar on exactly the soft puzzles that already have the most entries (the reason
  SEED-131 locked it as a row). It still participates in the spotlight and still gets
  its own active-highlight treatment.

- **D-03:** The "Also fine" row lists **only the alternatives actually drawn as green
  arrows** — never the overflow past the arrow cap. The legend is strictly 1:1 with
  the board: every arrow has a sidebar entry, every entry has an arrow, so a
  spotlight can never resolve to nothing. Consequence: on a soft/herring puzzle the
  row shows at most the ≤2 drawn alternatives, and a 4th `fineMoves` entry from the
  MultiPV-4 grading search is deliberately never surfaced. On a sharp puzzle
  (`TRAIN_SHARP_GOOD_MOVE_ARROWS = 1`, best move only) there are no green arrows, so
  the row does not render at all.

  Note for the planner: this narrows ROADMAP success criterion 3's phrasing ("any
  alternatives beyond the drawn arrows appear in a compact Also fine row"). The row
  covers the drawn alternatives, which are the ones lacking a sidebar entry today.
  LEGEND-04's own wording ("Alternatives get a compact row … with the green arrow
  glyph that participates in the spotlight") is satisfied as written.

### Color language — yellow removal

- **D-04:** The inaccuracy→green recolor applies to the **user's played move too**,
  not only to alternatives. A played inaccuracy renders green. Rationale: SOLV-03
  already scores it as a correct answer, so the board must not contradict the verdict
  text. This is what makes "yellow disappears from the reveal board" literally true.
  The line eval still discloses the small drop.

- **D-05:** Inaccuracy-tier collapses into `good` across the **entire** reveal
  surface, not just arrow fill: green arrow, the `good` thumbs-up badge (not the
  severity NAG glyph), and the green step highlight. Concretely, in `trainArrows.ts`:
  `QUALITY_ARROW_COLOR.inaccuracy`, the `fine.quality === 'inaccuracy' ? … : …`
  ternary in the fine-move arrow loop, `markerForQuality`'s severity branch for
  `'inaccuracy'`, and `TRAIN_STEP_HIGHLIGHT.inaccuracy` all resolve to the `good`
  treatment. Accepted cost: the reveal board can no longer distinguish good from
  inaccuracy — by design.
  — **Reversibility:** reversible — `MOVE_QUALITY_INACCURACY` stays in `theme.ts` for
  the rest of the app; this is a mapping change inside one pure module.

### Spotlight interaction

- **D-06:** Desktop = **hover on the whole card** (pointer-enter spotlights,
  pointer-leave restores). Keyboard focus does the same, so it is reachable without a
  mouse. No click-to-pin.

- **D-07:** The spotlight is **two-sided**: the active card is itself highlighted, AND
  every other arrow and quality badge on the board is hidden, leaving only that card's
  move visible. The card highlight is what makes the pairing legible; the board filter
  is LEGEND-02.

- **D-08:** Mobile = **tap the glyph specifically** (not the whole card), toggling:
  tap the active glyph again or any other glyph to switch, tap the board or anywhere
  else to clear. The glyph-only target keeps a tap from being ambiguous between
  "spotlight this" and "step this line" — the card body holds the stepper's own
  controls and clickable SAN tokens.

- **D-09:** Exactly one glyph is active at a time, or none. Single piece of state.

### Swap to exploration

- **D-10:** Only the **line boxes and the "Also fine" row** are replaced by the
  engine card + move list. The reveal panel's header block — guess verdict
  (`Guess: ✓/✗`), outcome copy, and the flaw-fixed banner — stays pinned above it.
  Keeping the just-earned result on screen while branching is the point of not
  sending the user to the Analysis page.

- **D-11:** The Solution button is **visibility-gated**, not always present: shown iff
  `lineStep !== null || isExploring` — i.e. whenever the board has departed from the
  pristine reveal. Both of its jobs survive (exit exploration; one-tap reset of every
  stepped line box via `solutionNonce` plus board snap-back to `puzzle.fen`), and it
  is never on screen doing nothing. `lineStep` is already `TrainSolveScreen` state, so
  the condition costs nothing. The label stays "Solution" — no relabel, no hint line.

### Exploration mechanics

- **D-12:** **Pure free play** — the user moves both sides at will, exactly like the
  Analysis board. Nothing auto-replies. The refutation is already answered by the
  engine card: its top PV from the new position opens with the punishing reply, so
  "why didn't my move work" is readable without a move being made for the user. Both
  sides must be playable anyway, since SEED-131 decision 6 starts exploration from
  stepped positions where either side may be to move.

- **D-13:** The exploration move list is a **clickable single chain that truncates**:
  clickable SAN tokens plus prev/next, and playing a move from a jumped-back position
  discards the tail. No branching, no tree — matching `TrainLineStepper`'s own locked
  single-chain design so the two surfaces read the same way.

- **D-14:** Stockfish PV moves in the engine card are **clickable and play into the
  exploration line**: clicking a PV move plays that line's prefix up to and including
  it onto the board, appending to the exploration move list. `replayPvLine` is already
  exported from `EngineLines.tsx` and already imported by `TrainReveal.tsx`, and the
  Analysis page already does click-to-play spans — reuse, not new machinery.

### Claude's Discretion

Resolved by inference unless the planner finds a reason to differ:

- Exploration is reachable only once the verdict has landed (the `showResultRow` /
  `verdict !== null` gate). A drag during grading keeps today's behavior.
- Returning from the Analyze deep-link via browser back restores the **pristine
  reveal**, not exploration state — `saveTrainRevealCache` is not extended.
- The engine card's first-search state reuses whatever `EngineLines` already renders
  while a search is in flight; no new loading treatment.
- Points flash and result sounds are unchanged and do not re-fire on exploration.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source of locked decisions
- `.planning/seeds/SEED-131-train-solution-board-legend-inline-exploration.md` — the
  9 locked decisions (A1–A4 legibility, B5–B9 exploration), the named rejected
  alternatives (backend curation, full line boxes for alternatives, Maia/FlawChess
  cards inline), the open Stockfish-instance research question, and per-file
  implementation anchors. **This is the primary spec for the phase** — the decisions
  above are amendments layered on it, not a replacement.

### Phase scope
- `.planning/ROADMAP.md` §"Phase 200" — goal, 5 success criteria, and the explicit
  plan-time decision the phase owns (which Stockfish instance powers exploration).
- `.planning/REQUIREMENTS.md` — LEGEND-01..06, EXPLORE-01..07 verbatim.

### Project constraints
- `CLAUDE.md` §Frontend — `text-sm` floor (no `text-xs` outside opt-in tooltip
  popovers), theme constants live in `theme.ts`, `noUncheckedIndexedAccess`,
  `data-testid` on every interactive element, mobile parity ("always apply changes to
  mobile too"), Button variants (`brand-outline` = secondary), knip in CI.
- `CLAUDE.md` §Coding Guidelines — nesting depth hard limit 4, logic-LOC soft 100 /
  hard 200 excluding JSX trees, refactor-on-sight. Relevant: `TrainSolveScreen.tsx` is
  already 800 lines and `TrainReveal.tsx` 627.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `frontend/src/lib/trainArrows.ts` (293 LOC) — the pure overlay builder. Already
  exports `buildTrainRevealOverlay`, `buildTrainStepArrows`, `buildTrainStepMarkers`,
  `classifyTrainMoveQuality`, plus the color/width/cap constants. **LEGEND-05 requires
  both the spotlight filter and the green recolor to land here and be unit-tested** —
  it is already a pure module with no React dependency, so this is additive.
- `frontend/src/components/ui/card.tsx` — `Card` / `CardHeader` / `CardBody`, already
  the idiom in three sibling Train components.
- `frontend/src/components/analysis/EngineLines.tsx` (424 LOC) — the Stockfish
  lines card. Exports `MAX_LINES = 2`, `replayPvLine(baseFen, uciMoves)`, and
  `formatScore`; `replayPvLine` and `formatScore` are **already imported by
  `TrainReveal.tsx`**. Prime candidate for the swap-in card (D-14).
- `frontend/src/hooks/useStockfishEngine.ts` (529 LOC) — `{fen, enabled}` in,
  `{evalCp, evalMate, pvLines, depth, isAnalyzing, isReady, currentFen}` out. This is
  exactly the continuous-MultiPV-eval-of-an-arbitrary-FEN shape exploration wants, and
  is one candidate answer to the open engine question below.
- `frontend/src/components/train/TrainLineStepper.tsx` (334 LOC) — single-chain SAN
  stepper with prev/next chevrons and clickable `goTo(tokenIndex)` SAN tokens, plus a
  `resetNonce` prop. Its interaction model is the template for D-13's exploration move
  list, and it already proves the user can walk back without the Solution button.

### Established Patterns

- **Overlay purity**: `TrainSolveScreen` computes `boardArrows` / `boardMarkers` by
  choosing between the stepping overlay and the reveal overlay; all shape logic lives
  in `trainArrows.ts`. The spotlight must follow this — a filter argument into the
  pure builder, not a filter applied in JSX.
- **Single shared board**: one `ChessBoard` with `id="chessboard"`, driven by
  `boardFen` state that stepping, Solution, and now exploration all mutate. There is
  no second board and must not be one (EXPLORE-01).
- **Quality classification never re-derives cutoffs**: `classifyTrainMoveQuality`
  delegates to `liveFlaw`'s `classifyLiveSeverity` off the same expected-score
  pipeline as the verdict. D-04/D-05 change the *presentation* mapping only — do not
  touch the classification.
- **Verdict/puzzle pairing**: `liveVerdict` is gated on
  `trainSession.lastSolvedPosition === puzzle.position` (bug fix FLAWCHESS-64).
  Exploration teardown on puzzle transition (EXPLORE-05) must not reopen that window.

### Integration Points

- `TrainSolveScreen.tsx:handlePieceDrop` — currently returns `false` when
  `moveApplied` is true. This is the exact seam where a post-verdict drop starts
  exploration instead of being rejected (EXPLORE-01).
- `TrainSolveScreen.tsx:handleShowSolution` — bumps `solutionNonce`, resets `boardFen`
  and `lineStep`. Gains "exit exploration" (EXPLORE-04) and the D-11 visibility gate.
- `TrainSolveScreen.tsx` `lineStep` state + `onLineStep` prop — already carries the
  stepped position out of `TrainReveal`; this is what seeds the exploration move list
  per SEED-131 decision 6 / EXPLORE-02, and what D-11's gate reads.
- `TrainReveal.tsx:buildLineBoxes` — role merging (`'your' | 'best' | 'game'`,
  coinciding moves share one box). The legend glyph must render the merged case
  ("Your move / Best move") as ONE glyph matching the single arrow actually drawn
  (LEGEND-01).
- `useTrainGradingEngine.ts` `GradeResult.fineMoves: TrainFineMove[]` — the source for
  both the green arrows and the "Also fine" row (D-03 caps the row to the drawn subset).

### Open research question (owned by this phase, per ROADMAP)

**Which Stockfish instance powers inline exploration?** Reuse the session-scoped,
already-warm `useTrainGradingEngine` vs. mount `useStockfishEngine` alongside it.
Constraints any answer must satisfy:

- Two concurrent WASM engines on one page against the documented mobile OOM history
  (see the `project_maia_ios_two_failure_populations` context: real low-memory OOM is
  a distinct population from the iOS <16.4 no-SIMD one).
- `useTrainGradingEngine`'s API is search-task-shaped (`gradeMove`,
  `startGameMoveSearch`, `startGrading`/`abortGrading`) with an internal
  generation-keyed dispatch queue; exploration wants continuous MultiPV eval of an
  arbitrary FEN with cancel-on-position-change. Determine whether it can serve both
  without disturbing in-flight grading of the NEXT puzzle, or whether a shared engine
  with a priority queue is needed.
- EXPLORE-05: no search may outlive its position, and teardown must be clean on
  puzzle transition, Next, and unmount.

</code_context>

<specifics>
## Specific Ideas

- The user's own framing of the spotlight, verbatim in intent: *"Put the Your Move /
  Best Move / Played in game headings and lines into Card components with a
  CardHeader. When hovering over a card or tapping, highlight the card (spotlight) and
  its corresponding arrows by hiding the other arrows / move quality icons."* — note
  that the card highlight is as load-bearing as the board filter (D-07), and that the
  hover target is the **whole card**, not the glyph alone.
- The Solution button should not be on screen when it has nothing to do — the user
  asked for it hidden while the solution is already the active state (D-11).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

### Reviewed Todos (not folded)

Three todos keyword-matched phase 200 and were reviewed; none touch the Train solve
screen:

- `WR-01 — pt-33 is not a valid Tailwind class on the Score Y-axis label` — a
  different page's chart axis; matched only on the "frontend" area tag.
- `172-deferred-review-findings` — matched on the bare word "phase".
- `Bitboard storage for partial-position queries` — a database concern; this phase has
  no backend surface.

</deferred>

---

*Phase: 200-train-solve-screen-board-legend-inline-sideline-exploration*
*Context gathered: 2026-08-01*
