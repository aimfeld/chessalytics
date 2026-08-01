---
phase: 200-train-solve-screen-board-legend-inline-sideline-exploration
plan: 03
subsystem: ui
tags: [react, typescript, vitest, chessboard, stockfish]

# Dependency graph
requires:
  - phase: 200-02
    provides: "toDisplayQuality presentation collapse, alsoFineMoves derivation — this plan builds the exploration state model on top of the same reveal overlay these produce"
provides:
  - "prefixUci field on TrainLineStep and TrainRevealStep, with a replay round-trip test proving it reconstructs the exact stepped position"
  - "useTrainExploration — the free-play sideline chain hook (moves/index/isExploring, start/playMove/playLine/jumpTo/reset), no content-keyed reset effect"
  - "TrainSolveScreen's post-verdict handlePieceDrop branch: starts/extends exploration validated against the live displayFen, never touching the graded/solve path"
  - "D-11 Solution visibility gate (shown only once the board departs the pristine reveal) and exploration teardown on Solution/puzzle-transition"
  - "A second, independent useStockfishEngine instance scoped to exploration.isExploring, plus the staleness-guarded explorationPvLines derivation plan 200-04 will render"
affects: [200-04]

# Actuals (#2632)
actuals:
  tokens: 12843
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Free-play chain state as two flat fields (moves + index) with a derived FEN via useMemo replay — never a content-keyed reset effect, so re-renders from the chain's own state updates can never snap the board back to the start (the exact Pitfall 2 TrainLineStepper's design would have reintroduced)"
    - "A single component-scope displayFen const (exploration.fen while exploring, else the frozen boardFen) is the ONE seam that both the rendered board and the exploration branch's own chess.js validation read — keeps the graded path's boardFen validation completely untouched"
    - "Second independent useStockfishEngine instance, mirroring Analysis.tsx's own {fen, enabled} call shape — no shared queue with the grading engine, so exploration's teardown is the hook's own existing Worker-lifecycle cleanup, not hand-rolled"

key-files:
  created:
    - frontend/src/hooks/useTrainExploration.ts
    - frontend/src/hooks/__tests__/useTrainExploration.test.ts
  modified:
    - frontend/src/components/train/TrainLineStepper.tsx
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/__tests__/TrainLineStepper.test.tsx
    - frontend/src/components/train/__tests__/TrainReveal.test.tsx
    - frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx

key-decisions:
  - "explorationPvLines is computed (with its currentFen staleness guard) but deliberately not yet consumed anywhere in this plan — it is void'd immediately after declaration with an explanatory comment to satisfy tsconfig's noUnusedLocals, since wiring it into TrainReveal's swap-in UI is plan 200-04's job and TrainReveal.tsx is outside this plan's task scope."
  - "The exploration branch validates the dropped move against a NEW displayFen const (exploration.fen while exploring, else boardFen), never against boardFen itself — boardFen stays untouched by every existing call site, so validating the sideline against it would silently re-impose a one-color restriction the moment the sideline's side to move flips (D-12)."
  - "Two pre-existing TrainSolveScreen tests asserted Solution renders unconditionally once verdict lands — updated (not just patched) to step a line first, since D-11's visibility gate is an intentional behavior change, not a regression."

patterns-established:
  - "A two-plan handoff inside one phase (state producer in 200-03, UI consumer in 200-04) is made explicit in source via a comment at the deferred value's declaration, not silently left dangling — keeps the noUnusedLocals gate honest about what is and isn't finished."

requirements-completed: [EXPLORE-01, EXPLORE-02, EXPLORE-03, EXPLORE-04, EXPLORE-05, EXPLORE-06]

coverage:
  - id: D1
    description: "A post-verdict drop starts a free-play sideline on the shared board (no mode toggle, no second board); a further drop EXTENDS the chain, never restarting it; two exploration drops issue no second grading/solve call."
    requirement: "EXPLORE-01"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useTrainExploration.test.ts#playMove from the tip appends and advances (EXPLORE-01: extends, never restarts)"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useTrainExploration.test.ts#two consecutive playMove calls extend to a 2-move chain and never reset index to 0"
        status: pass
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#a post-verdict drop starts a free-play sideline on the shared board; a further drop extends it; no second grading/solve attempt is ever issued"
        status: pass
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#a drop while grading is still pending (verdict not yet landed) is rejected and never starts exploration"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exploration started from a stepped-into line position seeds the chain with that step's full prefix in walk order; a prefix + lastMoveUci replay from puzzle.fen reproduces the exact FEN the stepper showed. Starting from the pristine reveal seeds a one-move chain."
    requirement: "EXPLORE-02"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainLineStepper.test.tsx#Phase 200 (EXPLORE-02): prefixUci has length 0 at stepper index 1, and replaying prefixUci + lastMoveUci from startFen reproduces the reported FEN at every index"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReveal.test.tsx#stepping a line reports the stepped move with its quality (first move = box quality, deeper = good/green), and back-to-start reports null"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useTrainExploration.test.ts#start with an empty prefix seeds a one-move chain (pristine-reveal exploration)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The board carries no reveal arrows and no quality badges while exploring (pure free play), keeping only the ordinary last-move highlight; both return to their reveal values after Solution."
    requirement: "EXPLORE-03"
    verification:
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#the board carries no arrows or markers while exploring, and both return to their reveal values after Solution"
        status: pass
    human_judgment: false
  - id: D4
    description: "The Solution button is visibility-gated (D-11): present only once the board has departed the pristine reveal (a line stepped, or exploration active). Pressing it does both jobs at once — exits exploration AND restores the pristine reveal (board snaps to puzzle.fen, solutionNonce bumps)."
    requirement: "EXPLORE-04"
    verification:
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#the Analyze/Next row appears below the board only once the verdict lands; Solution joins it once the board departs the pristine reveal (Phase 200 D-11)"
        status: pass
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#hides the Analyze link when the source game link is null, but Next still renders (Solution joins once a line is stepped, Phase 200 D-11)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Exploration runs on a SECOND, independent useStockfishEngine instance (distinct Worker object from the grading engine) — created only while exploring and terminated on Solution and on a puzzle transition; the grading Worker is never touched by either."
    requirement: "EXPLORE-05"
    verification:
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#exactly ONE Worker exists before exploration starts, and TWO distinct Worker objects exist after the first post-verdict drop"
        status: pass
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#pressing Solution terminates the exploration Worker while the grading Worker stays alive"
        status: pass
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#a puzzle transition while exploring terminates the exploration Worker, clears isExploring, and the next puzzle renders the pristine reveal"
        status: pass
      - kind: other
        ref: "grep -c useStockfishEngine TrainSolveScreen.tsx >= 2 (import + call); git diff --stat -- useTrainGradingEngine.ts useStockfishEngine.ts is empty (neither engine hook modified)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The Analyze deep-link href and the reveal cache payload are byte-identical to before this phase — exploration state is never persisted, and neither analysisUrl.ts, trainRevealCache.ts, nor either engine hook was modified."
    requirement: "EXPLORE-06"
    verification:
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#the Analyze link href is unchanged while exploring (EXPLORE-06)"
        status: pass
      - kind: other
        ref: "git diff --stat across the plan's three commits touches neither src/lib/analysisUrl.ts nor src/lib/trainRevealCache.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "D-12: whichever side is to move in the exploration position is playable (the sideline's side to move follows the chain, not pinned to the user's original color), turn order and legality are still fully enforced by chess.js, and no move is ever auto-played onto the board in response to an engine result."
    verification:
      - kind: integration
        ref: "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx#Phase 200 (D-12): the side to move follows the sideline, turn order stays fully enforced, and no move is ever auto-played onto the board"
        status: pass
    human_judgment: false
  - id: D8
    description: "A piece moved while an exploration search is in flight produces no stale result on the new position — explorationPvLines is guarded on explorationEngine.currentFen === explorationFen, discharging the hook's one-render currentFen lag at the consumer. Not yet rendered (plan 200-04's job)."
    verification:
      - kind: other
        ref: "source assertion: TrainSolveScreen.tsx's explorationPvLines derivation reads `explorationEngine.currentFen === explorationFen ? explorationEngine.pvLines : []`"
        status: pass
    human_judgment: false
  - id: D9
    description: "(Backstop, per this plan's must_haves) A puzzle transition that happens while exploration is active leaves the next puzzle in the pristine reveal state with no engine lines rooted at the previous position — covered by the Worker-teardown test above plus useStockfishEngine's own existing unmount lifecycle test; not independently re-asserted for the 'no stale lines' half since a torn-down Worker cannot emit further info lines."
    verification: []
    human_judgment: true
    rationale: "The mid-search interleaving case (a search literally in flight at the instant the transition effect fires) is a timing race that the existing Worker-lifecycle + generation-based discard machinery in useStockfishEngine already covers structurally (same hook that ships on the Analysis page since Phase 154-161) — this plan does not add a NEW dedicated interleaving test beyond the deterministic teardown assertion, per the plan's own A-08 flagged-assumption note."

# Metrics
duration: 45min
completed: 2026-08-01
status: complete
---

# Phase 200 Plan 03: Train Solve Screen — Inline Sideline Exploration (State + Board Wiring) Summary

**The shared Train board is now branchable after the verdict lands: any legal piece move starts a free-play sideline seeded from wherever the board already is (including a stepped-into line prefix), validated against the live position so either color stays playable, powered by its own independent Stockfish instance that tears down cleanly on Solution or a puzzle transition — and none of it can ever touch the graded/solve path.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-08-01T14:44Z (approx., first file read)
- **Completed:** 2026-08-01T15:29Z
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- `TrainLineStep.prefixUci`/`TrainRevealStep.prefixUci` land on both step interfaces with a proven replay round-trip (`prefixUci` + `lastMoveUci` applied from `startFen` reproduces exactly the reported FEN) — the mechanism that makes EXPLORE-02's stepped-prefix seeding provably correct, not just plausible-looking.
- `useTrainExploration` is a new, small hook: `moves`/`index`/`isExploring` state with `start`/`playMove`/`playLine`/`jumpTo`/`reset`, and a `fen` derived via `useMemo` replay — deliberately carrying NO content-keyed reset effect, since that is exactly the pattern (`TrainLineStepper`'s own `useEffect(() => setIndex(0), [...])`) that would have snapped the sideline back to its start on every move played.
- `handlePieceDrop` grows a post-verdict branch strictly after the existing `guess`/`moveApplied` guards (SOLV-02's own gate, untouched): it validates the dropped move against a new `displayFen` const (the live exploration position while exploring, else the frozen `boardFen`), so the sideline's side-to-move check tracks the chain instead of silently re-pinning to the user's original color once the sideline flips sides (D-12). It never calls `gradeMove`, `solvePuzzle`, or touches `moveApplied`/`lastPlayedUci`.
- The Solution button is now visibility-gated (D-11: shown only once `lineStep !== null || exploration.isExploring`) and does double duty — one press both exits exploration and restores the pristine reveal; the per-puzzle reset effect tears exploration down on every transition.
- A second, independent `useStockfishEngine` instance (mirroring `Analysis.tsx`'s own `{fen, enabled}` call shape) powers exploration, scoped to `enabled: exploration.isExploring` — a genuinely distinct `Worker` object from the session-scoped grading engine, with zero modifications to either engine hook. The board goes arrow/marker-free while exploring (EXPLORE-03), keeping only the ordinary last-move highlight.

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread the stepped-line prefix through both step interfaces** - `dfd6ba69` (feat)
2. **Task 2: useTrainExploration + the post-verdict handlePieceDrop branch, Solution exit and gate** - `fa5479d4` (feat)
3. **Task 3: Second Stockfish instance, arrow-free exploration board, and teardown coverage** - `bfaae116` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `frontend/src/hooks/useTrainExploration.ts` (new) - The free-play sideline chain hook: `moves`/`index`/`isExploring` state, `start`/`playMove`/`playLine`/`jumpTo`/`reset`, `fen` derived via a `TrainLineStepper`-style `replayLine` idiom, no content-keyed reset effect
- `frontend/src/hooks/__tests__/useTrainExploration.test.ts` (new) - 11 cases: mount state, start/extend, truncate-on-jump-back (D-13), `playLine`, `reset`, and the Pitfall 2 regression guard (a `startFen` prop change does not itself reset the chain)
- `frontend/src/components/train/TrainLineStepper.tsx` - `TrainLineStep.prefixUci: string[]`, populated as `ucis.slice(0, Math.max(0, index - 1))` in the existing step-reporting effect
- `frontend/src/components/train/TrainReveal.tsx` - `TrainRevealStep.prefixUci: string[]`, populated in `handleLineStep` as `[...step.prefixUci, step.lastMoveUci]` (the complete chain played from `puzzle.fen` to the shown position)
- `frontend/src/components/train/TrainSolveScreen.tsx` - `useTrainExploration(puzzle.fen)`; a second `useStockfishEngine` instance + staleness-guarded `explorationPvLines`; `handlePieceDrop`'s post-verdict exploration branch; `displayFen`; the D-11 Solution visibility gate; `exploration.reset()` in `handleShowSolution` and the per-puzzle reset effect; arrow/marker/last-move ternaries gain an `exploration.isExploring` arm
- `frontend/src/components/train/__tests__/TrainLineStepper.test.tsx` - Round-trip + index-1-empty-prefix test for `prefixUci`; updated the literal `onStepChange` assertions to include the new field
- `frontend/src/components/train/__tests__/TrainReveal.test.tsx` - Updated two literal `onLineStep` assertions that predated `prefixUci` (Rule 1 fix from Task 1)
- `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx` - `drop-e7e5` black-move mock button; `FakeWorker.terminated`; `stubbedWorkerInstances` instance tracking; updated two D-11-affected pre-existing tests; 8 new tests covering EXPLORE-01/02/03/05/06 and D-12's turn-order/no-auto-reply behavior

## Decisions Made

- `explorationPvLines` is computed (with its `currentFen` staleness guard) but not yet consumed — `void`'d immediately with an explanatory comment so `tsconfig`'s `noUnusedLocals` passes without pulling `TrainReveal.tsx` (out of this plan's task scope) into this plan just to give the value a temporary home.
- The exploration branch validates against a new `displayFen` const, never `boardFen` — `boardFen` and every existing `setBoardFen` call site are completely untouched by this plan, which is what keeps the graded path (SOLV-02) byte-identical.
- Two pre-existing `TrainSolveScreen.test.tsx` tests asserted the Solution button renders unconditionally once the verdict lands — genuinely updated (stepping a line first) rather than left broken, since D-11's gate is an intentional, plan-specified behavior change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two stale literal `onLineStep` assertions in `TrainReveal.test.tsx`**
- **Found during:** Task 1
- **Issue:** Adding `prefixUci` to `TrainRevealStep` broke two pre-existing tests that asserted the exact literal shape of `onLineStep`'s argument (no `objectContaining`).
- **Fix:** Added the correct `prefixUci` value to each literal expectation.
- **Files modified:** `frontend/src/components/train/__tests__/TrainReveal.test.tsx`
- **Commit:** `dfd6ba69`

**2. [Rule 1 - Bug] Two pre-existing `TrainSolveScreen.test.tsx` tests asserted Solution renders unconditionally**
- **Found during:** Task 2
- **Issue:** D-11's Solution visibility gate (shown only once the board departs the pristine reveal) is an intentional behavior change from "always shown once verdict lands", so two pre-existing tests failed against the new behavior.
- **Fix:** Updated both tests to step a line first before asserting Solution's presence/position in the row, and added an explicit pristine-reveal-absent assertion to each.
- **Files modified:** `frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx`
- **Commit:** `fa5479d4`

## Issues Encountered

None beyond the two Rule-1 test fixes above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `useTrainExploration`, the `displayFen`/post-verdict `handlePieceDrop` branch, and the second `useStockfishEngine` instance (`explorationEngine`/`explorationFen`/`explorationPvLines`) are all in place for plan 200-04 to render the actual swap-in UI (engine card + clickable move list replacing the line boxes/Also fine row, per D-10/D-13/D-14) on top of this plan's state — no further state-model work should be needed.
- `explorationPvLines`'s staleness guard is already correct and unit-provable at the source level; 200-04 needs only to consume it (and drop the `void`).
- D5 (pixel-level 375px mobile rendering) from 200-01 remains carried to the phase's end-of-phase browser check, per that plan's flagged assumption — untouched by this plan.

---
*Phase: 200-train-solve-screen-board-legend-inline-sideline-exploration*
*Completed: 2026-08-01*

## Self-Check: PASSED

All 8 created/modified key files exist on disk; all 3 task commits (`dfd6ba69`, `fa5479d4`, `bfaae116`) verified present in git log.
