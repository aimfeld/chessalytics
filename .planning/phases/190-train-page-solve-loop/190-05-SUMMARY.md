---
phase: 190-train-page-solve-loop
plan: 05
subsystem: ui
tags: [react, tanstack-query, chess.js, date-fns, train, tactic-lines]

requires:
  - phase: 190-train-page-solve-loop (Plan 02)
    provides: "PuzzleRevealResponse.pv (stored best line as SAN) — the reveal's steppable best-line data source"
  - phase: 190-train-page-solve-loop (Plan 04)
    provides: "TrainSolveScreen's guess/move/grading pipeline, useTrainSession's block-and-retry solve persistence and localStorage sessionScore, and TrainStartScreen's six landing states — this plan's reveal/score-screen work builds directly on top"
provides:
  - "TrainReveal.tsx — the auto-opening post-solve reveal panel: verdicts+points, D-11 outcome copy, D-12 comeback hint, steppable best line, opt-in tactic stepper, game card + deep link, Next"
  - "TrainLineStepper.tsx — a small purpose-built single-chain SAN stepper serving both the best-line and tactic-line data shapes (settles the ROADMAP's VariationTree-reuse-vs-lightweight-stepper spike as a lightweight build)"
  - "trainScore.ts — pure per-puzzle scorer, order-independent session aggregator, ratio-based green/yellow/red band resolver, and floored display-percentage helper with a proven band/display agreement"
  - "TrainScoreScreen.tsx + Train.tsx's session-complete transition — the score screen replaces another puzzle once the final reveal's Next is pressed and the solve response reports session_complete"
  - "Two new theme.ts token groups: TRAIN_VERDICT_CORRECT/INCORRECT and TRAIN_RATING_GREEN/YELLOW/RED"
affects: [190-06]

tech-stack:
  added: []
  patterns:
    - "A purpose-built single-chain stepper instead of embedding the analysis page's branching-tree editor — settles a plan-time reversibility question with a small component behind two call sites"
    - "All answer-adjacent fetches (reveal GET, game card, tactic-lines) gated on the solve response's presence, with the tactic-lines fetch additionally gated on an explicit user opt-in press — never a speculative pre-attempt fetch"

key-files:
  created:
    - frontend/src/components/train/TrainLineStepper.tsx
    - frontend/src/components/train/__tests__/TrainLineStepper.test.tsx
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/lib/trainScore.ts
    - frontend/src/lib/__tests__/trainScore.test.ts
    - frontend/src/components/train/TrainScoreScreen.tsx
  modified:
    - frontend/src/lib/theme.ts
    - frontend/src/pages/Train.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx

key-decisions:
  - "TrainLineStepper never mounts its own board — it drives the reveal's shared board via an onFenChange callback (D-08/D-09's 'one interactive board throughout' mandate), and its replay of stored SAN mirrors useAnalysisBoard.ts's insertPvLine idiom (new Chess(startFen), then chess.move(san) per step) rather than inventing a second replay"
  - "A one-move line hard-disables BOTH stepper controls as a deliberate special case (not general index math) — there is exactly one meaningful frame to show, so stepping is meaningless even though the general index range would otherwise leave 'next' enabled at the initial start-fen state"
  - "chess.js 1.4.0's .move() THROWS on an illegal/malformed SAN token — it does not return null/undefined, unlike the assumption baked into useAnalysisBoard.ts's insertPvLine precedent. TrainLineStepper's replay wraps the call in try/catch so the 'stop at the first illegal token, never crash' contract actually holds (verified: an initially-illegal SAN fixture crashed the component with an uncaught exception until this fix)"
  - "TrainReveal renders even when the solve response is null, as long as isSolveError is true — it 'always mounts once grading+solve have settled' rather than strictly 'once the solve succeeded', so the pre-existing 190-04 block-and-retry row (same test ids: train-solve-error, btn-train-solve-retry, disabled btn-train-next) keeps rendering exactly as it did before this plan, with zero changes needed to that already-shipped behavior"
  - "The tactic opt-in trigger's UI-SPEC copy ('Step through the {motif} line') cannot literally include the motif name before the press: PuzzleRevealResponse.has_tactic_lines is a boolean pointer only, and the motif key lives inside TacticLinesResponse — which the plan's own T-190-16 threat mitigation (asserted by a call-count test) forbids fetching before the opt-in press. Rendered as the generic 'Step through the tactic line' pre-fetch, with each stepped orientation showing its own motif heading once the (lazily fetched) data lands. Flagged as a deviation below, not silently paraphrased."
  - "D-11's miss-reveal template embeds an illustrative {consequence} clause ('...losing a rook...') that no backend field supplies (neither SolveResponse nor PuzzleRevealResponse carries a material-loss description) — rendered as 'In the game you played {playedSan}. Best was {bestSan}.', omitting the unsuppliable clause rather than fabricating one. Flagged as a deviation below."
  - "TRAIN_POINTS_PER_PUZZLE / TRAIN_PERCENTAGE_MULTIPLIER (trainScore.ts) are named constants specifically so Train.tsx's score-screen aggregate (session.puzzle_count * TRAIN_POINTS_PER_PUZZLE) never inlines the '*2' the UI-SPEC's '2N' shorthand implies"
  - "Two pre-existing tests (Train.solveLoop.test.tsx's 'zero reveal calls ever' assertion, and TrainSolveScreen.test.tsx's 'board position unchanged across grading transition' assertion) were updated because this plan's own required behavior (D-08 board-reset-on-reveal-open, SOLV-05's real reveal fetch) makes their previous assertions factually false, not because of any regression — mirrors the Plan 03 precedent for keeping a regression test truthful about the code it verifies"

patterns-established:
  - "A component that intentionally renders null in a branch (TrainReveal when verdict is null and isSolveError is false) is still typed to return ReactElement | null explicitly, rather than casting or using a fragment, so the null case is visible in the type signature"

requirements-completed: [SOLV-05, SOLV-06, SOLV-07]

coverage:
  - id: D1
    description: "Solving a puzzle automatically reveals two verdict rows (Guess/Move) with an inline points tally sourced from the server response, using the new theme-exported verdict colors — no local re-derivation of correct_guess"
    requirement: "SOLV-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#'renders both verdict rows from the response values, with a points tally matching each correct row'"
        status: pass
    human_judgment: false
  - id: D2
    description: "A miss renders the neutral-factual sentence (played move + best move, no consequence clause since no backend field supplies one) and never the herring sentence; a herring renders the herring sentence and never the miss sentence; a correct non-herring solve renders no outcome sentence at all"
    requirement: "SOLV-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#'a miss renders the neutral-factual sentence, never the herring sentence', #'a herring renders the herring sentence, never the miss sentence', #'a correct, non-herring solve renders no outcome sentence at all'"
        status: pass
    human_judgment: false
  - id: D3
    description: "A spaced-repetition item renders the '~N days' comeback line derived from due_date; a mastered item renders the plain 'Mastered — retired.' text; a herring renders no comeback line at all"
    requirement: "SOLV-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#'a spaced-repetition item renders the comeback line derived from the due date', #'a mastered item renders the plain retired text, not a celebration', #'a herring renders no comeback line at all'"
        status: pass
    human_judgment: false
  - id: D4
    description: "The reveal's best-line stepper renders only when the reveal payload carries a non-empty pv; a null pv with no tactic tag renders no stepper at all"
    requirement: "SOLV-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#'a null best line with no tactic tag renders no stepper', #'a non-null best line renders the stepper'"
        status: pass
    human_judgment: false
  - id: D5
    description: "The game card (with its analyzePly deep link) fetches only after the solve response is present — disabled while verdict is null, enabled once it lands — and is rendered with the puzzle's own ply"
    requirement: "SOLV-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#'the game-card query is disabled while the solve response is absent, and enabled once it is present', #'renders the game card with the puzzle ply as analyzePly'"
        status: pass
    human_judgment: false
  - id: D6
    description: "A tactic-tagged reveal always offers the opt-in step-through trigger; the tactic-lines fetch is NOT issued on reveal render and IS issued exactly once, only after the opt-in press (T-190-16 call-count proof)"
    requirement: "SOLV-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#'a tactic-tagged reveal offers the opt-in trigger and keeps the tactic-lines fetch disabled until pressed'"
        status: pass
    human_judgment: false
  - id: D7
    description: "TrainLineStepper: forward/backward stepping changes the derived FEN in order; prev disables at index zero and next at the last index; a one-move line hard-disables both; clicking a token derives the identical FEN to the equivalent number of next-presses (array indexing, not a character offset); the motif heading renders the shared label helper's display form, never the raw key; a long line renders every token inside the named height-capped scrolling block"
    requirement: "SOLV-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainLineStepper.test.tsx (9 tests)"
        status: pass
    human_judgment: false
  - id: D8
    description: "Per-puzzle scoring is 0/1/2 with independent guess/move points; session aggregation is an order-independent sum with max = 2x the scored-puzzle count; the green/yellow/red band resolves from the EXACT ratio with each threshold's own edge in the higher band; the displayed percentage is the floor of ratio*100 and is proven, across a full grid of session sizes, to never disagree with the awarded band; zero scored puzzles yields total=0 and a null (suppressed) percentage, never a division by zero"
    requirement: "SOLV-07"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/trainScore.test.ts (15 tests, incl. boundary/adjacency, display/band-agreement grid over 40 session sizes, empty-session, and reordering cases)"
        status: pass
    human_judgment: false
  - id: D9
    description: "The score screen renders (instead of another puzzle) once the final puzzle's solve response reports session_complete and the user presses Next; no celebration/confetti treatment is built (explicitly Phase 191's)"
    requirement: "SOLV-07"
    verification:
      - kind: other
        ref: "grep -cE 'confetti' frontend/src/components/train/TrainScoreScreen.tsx == 0; manual code-path trace of Train.tsx's handleNext -> setShowScoreScreen(true) branch"
        status: pass
    human_judgment: true
    rationale: "The full session-complete transition (multi-puzzle session reaching its last puzzle, pressing Next on the final reveal) is only exercised end-to-end by the plan's own single-puzzle tracer fixtures elsewhere in this phase, not by a dedicated multi-puzzle integration test in this plan; the pure scoring math and the score-screen's own rendering are unit-proven above, but the Train.tsx wiring itself is a short, directly-readable branch rather than one with its own automated multi-puzzle-session test. Flagging for a human spot-check at the Plan 06 checkpoint rather than asserting a coverage claim this plan's tests don't make."
  - id: D10
    description: "All verdict and rating-band colors are sourced from named theme.ts exports (TRAIN_VERDICT_CORRECT/INCORRECT, TRAIN_RATING_GREEN/YELLOW/RED) — no literal bg-green-*/text-red-* etc. Tailwind color utility appears in either component"
    verification:
      - kind: other
        ref: "grep -cE 'bg-(green|red|amber|yellow)-[0-9]|text-(green|red|amber|yellow)-[0-9]' frontend/src/components/train/TrainReveal.tsx == 0; grep -cE '0\\.75|0\\.5[^0-9]' frontend/src/components/train/TrainScoreScreen.tsx == 0"
        status: pass
    human_judgment: false
  - id: D11
    description: "Desktop-beside-board / mobile-stacked reveal layout (D-09) and the long-motif-label/deep-PV text-wrap backstop are visual/viewport concerns jsdom cannot assert"
    verification: []
    human_judgment: true
    rationale: "Explicitly authored as `backstop`-verification truths in this plan's own must_haves and explicitly routed to the Plan 06 human checkpoint in this plan's <verification> section — not a gap introduced by this plan's automated coverage."

duration: 35min
completed: 2026-07-25
status: complete
---

# Phase 190 Plan 5: Reveal, Line Stepper, and Session Score Summary

**Auto-opening post-solve reveal panel (verdicts+points, honest miss/herring copy, spaced-repetition comeback hint, steppable best line, opt-in tactic stepper, game card + deep link) built on a new purpose-built SAN stepper, plus a pure session-scoring module and score screen with proven-never-contradicting percentage/band display.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-07-25
- **Tasks:** 3 planned (all complete: Task 1 auto, Task 2 auto, Task 3 tdd — RED/GREEN/screen)
- **Files modified:** 12 (7 new, 5 modified)

## Accomplishments

- Built `TrainLineStepper.tsx`, a small single-chain SAN stepper (no branching/forking/deletion) that serves both the reveal's stored best line and the opt-in tactic line — the settled answer to the ROADMAP's plan-time "embed the analysis page's branching-tree editor vs. build a lightweight stepper" question. It never mounts a second board, replaying moves via the same chess.js idiom `useAnalysisBoard.ts`'s `insertPvLine` already uses, and caps its rendered token list to a named scrolling height (T-190-19).
- Built `TrainReveal.tsx`: the reveal auto-opens once grading and the solve POST have both landed (D-07), the board snaps back to the puzzle position as it opens (D-08), and it renders — in the D-09 locked order — the verdict rows + points tally, the D-11 miss/herring outcome copy, the D-12 spaced-repetition comeback hint, the steppable best line, an opt-in tactic stepper (SOLV-06, never auto-fetched), and the shared game card with its analysis deep link (SOLV-05). All three answer-adjacent fetches this component owns stay gated on the solve response being present, and the tactic-lines fetch is additionally gated on an explicit opt-in press — both proven via call-count tests (T-190-16).
- Added the two `theme.ts` token groups the UI-SPEC specifies (`TRAIN_VERDICT_CORRECT/INCORRECT` aliasing the WDL palette; `TRAIN_RATING_GREEN/YELLOW/RED` with a genuinely new amber) — no color repurposed from the unrelated flaw-severity taxonomy.
- Built `trainScore.ts` (pure, no React import) via a real RED→GREEN TDD cycle: a per-puzzle scorer, an order-independent session aggregator, a ratio-based green/yellow/red band resolver, and a floored display-percentage helper whose agreement with the band is proven across a 40-session-size × every-possible-score grid, not just spot-checked at the two thresholds.
- Built `TrainScoreScreen.tsx` and wired `Train.tsx`'s session-complete transition: pressing Next on the final puzzle's reveal (when its solve response reports `session_complete`) now shows the score screen instead of trying to advance to a nonexistent next puzzle.

## Task Commits

Each task was committed atomically (Task 3 followed the tdd="true" RED→GREEN→feature flow):

1. **Task 1: TrainLineStepper** — `092d6f15` (feat)
2. **Task 2: TrainReveal + theme tokens + wiring** — `1aad5892` (feat)
3. **Task 3 RED: failing trainScore tests** — `4c4769f6` (test)
4. **Task 3 GREEN: trainScore module** — `ab3237a1` (feat)
5. **Task 3: TrainScoreScreen + Train.tsx session-complete transition** — `7c58ff30` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP updates)

## Files Created/Modified

- `frontend/src/components/train/TrainLineStepper.tsx` — new: single-chain SAN stepper, `TRAIN_LINE_STEPPER_MAX_HEIGHT_PX`
- `frontend/src/components/train/__tests__/TrainLineStepper.test.tsx` — new: 9 tests
- `frontend/src/components/train/TrainReveal.tsx` — new: the reveal panel (verdicts, outcome copy, comeback hint, best line, tactic opt-in, game card, Next)
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` — new: 12 tests
- `frontend/src/lib/trainScore.ts` — new: pure scoring module, `TRAIN_RATING_GREEN_MIN`/`TRAIN_RATING_YELLOW_MIN`/`TRAIN_POINTS_PER_PUZZLE`/`TRAIN_PERCENTAGE_MULTIPLIER`
- `frontend/src/lib/__tests__/trainScore.test.ts` — new: 15 tests
- `frontend/src/components/train/TrainScoreScreen.tsx` — new: session-end score screen
- `frontend/src/lib/theme.ts` — added `TRAIN_VERDICT_CORRECT/INCORRECT`, `TRAIN_RATING_GREEN/YELLOW/RED`
- `frontend/src/pages/Train.tsx` — session-complete -> score-screen transition (`handleNext`, `showScoreScreen`)
- `frontend/src/components/train/TrainSolveScreen.tsx` — hands off the verdict/error/Next block to `TrainReveal`; D-08 board-reset effect; `onNext` prop
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` — updated one assertion for D-08 (board resets to puzzle fen once the reveal opens, not "unchanged forever"); added deterministic `trainApi.revealPuzzle`/`libraryApi.getGame`/`getTacticLines` mocks so `TrainReveal`'s own queries (now mounted here) never hit real network
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — updated the tracer's "zero reveal calls ever" assertion to "gated until the verdict lands, then called exactly once" (SOLV-05's real reveal fetch supersedes Plan 01's placeholder assumption); added the same deterministic api mocks

## Decisions Made

See `key-decisions` in frontmatter above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TrainLineStepper crashed on an illegal SAN instead of stopping the replay**
- **Found during:** Task 1/Task 2, writing `TrainReveal.test.tsx`'s best-line fixture
- **Issue:** `chess.js` 1.4.0's `.move()` THROWS on an illegal or malformed SAN token — it does not return `null`/`undefined`. The plan's own read-first guidance to mirror `insertPvLine`'s `if (!move) break` idiom assumes the null-return behavior, which this version of chess.js does not have; a mismatched-fixture PV (or any genuinely malformed stored PV) crashed the whole component with an uncaught exception instead of stopping the replay at the bad token.
- **Fix:** Wrapped `chess.move(san)` in a `try/catch` inside `replayLine`, breaking on the caught exception — restoring the "stop, never crash" contract the plan's action text requires.
- **Files modified:** `frontend/src/components/train/TrainLineStepper.tsx`
- **Verification:** Reproduced the crash with a deliberately illegal SAN fixture, confirmed the fix resolves it; `TrainReveal.test.tsx`'s best-line case (now using a legal `['e4','e5']` fixture) and all `TrainLineStepper.test.tsx` cases pass.
- **Committed in:** `092d6f15` (Task 1, before the bug was actually discovered by Task 2's test — the fix and its guarding comment landed in the Task 1 commit since that's where `replayLine` lives)

**2. [Rule 1 - Bug, pre-existing test] Two Plan 01/04 test assertions were factually superseded by this plan's own required behavior**
- **Found during:** Task 2, after wiring `TrainReveal` into `TrainSolveScreen`/`Train.tsx`
- **Issue:** `Train.solveLoop.test.tsx` asserted "zero reveal calls throughout the whole pre/post-attempt lifecycle" (written when Plan 01 explicitly deferred the reveal fetch to this plan) and `TrainSolveScreen.test.tsx` asserted "board position is unchanged across the grading transition" measured from the grading indicator all the way through verdict-landing (written before D-08's board-reset-on-reveal-open existed). Both assertions are now literally false under this plan's own locked behavior (SOLV-05's real reveal fetch; D-08's board snap-back) — not a regression, but a stale assumption the code now correctly contradicts.
- **Fix:** Updated both assertions to encode the NEW correct behavior instead of deleting the coverage: the tracer now asserts revealPuzzle is called exactly once, only after the verdict lands (T-190-16's proof, in the one place a real end-to-end fetch could be observed); the solve-screen test now asserts the board holds the played-move position through grading (no flicker DURING that window) and then explicitly snaps back to the puzzle FEN once the reveal opens (D-08). This mirrors the Plan 03 precedent (updating stale Phase 171 nav-ordering assertions its own insertion legitimately changed) rather than a new pattern.
- **Files modified:** `frontend/src/pages/__tests__/Train.solveLoop.test.tsx`, `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx`
- **Verification:** Both files pass; full frontend suite (193 files, 2631 tests) green.
- **Committed in:** `1aad5892` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 1 genuine bug in new code, 1 Rule 1 correction of pre-existing tests whose assumptions this plan's own locked behavior necessarily invalidated). No scope creep — both were required for the plan's own must-have truths (a stepper that never crashes on a malformed stored PV; a tracer/solve-screen test suite that stays truthful about D-08 and SOLV-05).

### Flagged copy adaptations (not silently paraphrased)

**A. Tactic opt-in trigger label is generic pre-fetch, not motif-named** — The UI-SPEC's locked copy is "Step through the {motif} line" (e.g. "Step through the fork line"), but the motif key is only available inside the lazily-fetched `TacticLinesResponse` — `PuzzleRevealResponse.has_tactic_lines` is a boolean pointer only. The plan's own T-190-16 threat mitigation (a call-count-tested requirement) forbids fetching that data before the user's opt-in press, so the motif genuinely cannot be known at the moment the trigger button must render. Rendered as the generic "Step through the tactic line" before the press; each stepped orientation shows its own motif heading (via the shared `tacticMotifLabel` helper) once the opt-in fetch resolves. A future backend field surfacing the motif alongside `has_tactic_lines` (out of this frontend-only plan's scope) would close this fully.

**B. D-11 miss-reveal sentence omits the illustrative {consequence} clause** — The locked template's own example ("...losing a rook...") implies a material-loss description, but neither `SolveResponse` nor `PuzzleRevealResponse` carries such a field. Rendered as "In the game you played {playedSan}. Best was {bestSan}." — the two facts the backend actually supplies, stated plainly, rather than fabricating a consequence or omitting the whole sentence.

## Issues Encountered

None beyond the two deviations above, both resolved within this plan.

## User Setup Required

None — no external service configuration required.

## Known Stubs

None. Every element in the reveal and score screen is backed by real data (the solve response, the reveal GET, the game-card fetch, the lazily-fetched tactic lines, the pure scoring module) — no hardcoded empty values or placeholder text ship as part of this plan's feature set. The two flagged copy adaptations above are real, working functionality with a narrower label/sentence than the UI-SPEC's illustrative example — not stubs.

## Threat Flags

None beyond what this plan's own `<threat_model>` already registers (T-190-16 through T-190-19, T-190-SC) and mitigates directly in the shipped code — no new surface introduced outside that register.

## Next Phase Readiness

- Plan 06 (the human-checkpoint plan) can proceed directly against this plan's shipped reveal/stepper/score-screen: the three copy-tone prohibitions (no shaming, no ability-measure framing, no "objectively correct" engine-verdict framing) and the visual/viewport backstops (D-09 desktop-vs-mobile layout, long-motif/deep-PV text wrap, zero-one-many grammar) all remain exactly where this plan's own front matter flagged them for that checkpoint — none are newly introduced gaps.
- Both flagged copy adaptations (tactic-trigger generic label, missing consequence clause) are real, load-bearing decisions a human reviewer should specifically look at during that checkpoint's copy read, since they diverge from the UI-SPEC's literal example text for genuine data-availability reasons.
- No blockers for the rest of the phase.

---
*Phase: 190-train-page-solve-loop*
*Completed: 2026-07-25*

## Self-Check: PASSED

All 12 claimed files found on disk; all 5 commit hashes (`092d6f15`, `1aad5892`, `4c4769f6`, `ab3237a1`, `7c58ff30`) found in git history.
