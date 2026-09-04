---
phase: 215-frontend-god-file-decomposition
plan: 05
subsystem: ui
tags: [react-hooks, refactor, complexity, analysis-page, mutation-testing, eslint-hooks, gem-detection]

requires:
  - phase: 215-frontend-god-file-decomposition (plan 01)
    provides: "eslint complexity/max-depth/max-statements enforced at error; CLI-override proof command"
  - phase: 215-frontend-god-file-decomposition (plan 04)
    provides: "Analysis() reduced to 168/181/1854; useAnalysisRouteParams/useAnalysisEngineLines/useAnalysisRouteSeeding under src/hooks/analysis/; corrected app-wide react-hooks baseline (30, not the plan-stated 28)"
provides:
  - "Analysis() reduced from 168/181/1854 (complexity/statements/lines) to 159/165/1454, over three named sibling hooks (useAnalysisBoardArrows, useAnalysisGemMarkers, useBoardStageSize) under src/hooks/analysis/"
  - "boardSquareMarkers (cyclomatic 18), moveListMarkers (cyclomatic 27, the file's worst non-component offender) and the gem-sweep resolution effect (cyclomatic 19) all fixed — three named per-concern helper seams (appendGemGreatMarker/appendBestGoodMarker/appendBookMarker, hasNoMoveListMarkerWork/buildMarkerNodePlies/applyBookMarkers, resolveGemDetailForNode)"
  - "Three two-way mutation proofs demonstrating the 85/86-test oracle genuinely exercises each new hook's seam; one new test added where jsdom's zero-layout limitation left a mutation unguarded"
  - "Documented scope deviation (mirrors 215-04's precedent) for useAnalysisGemMarkers: storedTierByPly/storedBestGoodByPly/sweepArmedForGame+effect/fenAtPly/sweepCandidates/pinnedEloForPly/parentGemCandidateSans/fastForwardStopPlies stay local to Analysis.tsx — each feeds or gates a local engine call (useGemSweep, the second useStockfishGradingEngine call) that cannot move"
affects: [215-06, 215-08]

actuals:
  tokens: 29400
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Named per-precedence-tier helper functions (not five one-line helpers) as the seam for a useMemo/useEffect complexity breach — appendGemGreatMarker/appendBestGoodMarker/appendBookMarker for boardSquareMarkers, hasNoMoveListMarkerWork/buildMarkerNodePlies/applyBookMarkers for moveListMarkers, resolveGemDetailForNode for the gem-resolution effect. Each helper owns ONE precedence tier or ONE concern (early-exit predicate, candidate-set construction, book-marker application), reducing both cyclomatic complexity in the caller and (as a side effect) making each tier independently testable/readable."
    - "Bidirectional scope narrowing when two extracted hooks (Task 1's useAnalysisBoardArrows, Task 2's useAnalysisGemMarkers) share a value whose OWNING computation moves between them: resolveMarkerFor's definition moved into Task 2's hook mid-plan, so Task 1's already-committed useAnalysisBoardArrows call site was updated (in Task 2's commit) to source resolveMarkerFor from the NEW hook's result instead of a local const — the option TYPE didn't change, only where the value comes from."
    - "Caller-owned useState threaded into an extracted hook as a value+setter pair (not moved) when an EARLIER-in-render local computation needs to read the state before the extracted hook's call position — gemByNode/setGemByNode stays a plain Analysis.tsx useState because needParentGemGrade (which gates the local second grading-engine call) reads gemByNode.has(currentNodeId) before useAnalysisGemMarkers can run; the setter is threaded in exactly like a caller-owned ref would be (215-04's ref-threading pattern, mirrored for setState)."
    - "A hook's own 'no engine instantiation' contract is machine-provable via `grep -c '<engineHookName>' <hookfile>` printing 0 — this requires avoiding ALL literal mentions of the engine hook's name, including in JSDoc prose and type imports (StockfishGradingEngineState/SweepGemDetail), not just avoiding the call itself. Resolved via local structural types (GemGradingState — a narrow Pick-shaped slice of the real engine state) and prose rewording (\"the second grading-engine hook call\" instead of naming it), reusing an already-locally-duplicated type (GemDetail) instead of importing the sweep hook's SweepGemDetail (structurally identical by the sweep hook's own design comment)."
    - "Mutation-proof gap closure via a NEW test using the codebase's own established pattern (vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(N), already used 10+ times in Analysis.test.tsx for arrow-geometry tests) rather than inventing a new DOM-measurement mock — jsdom's zero-layout limitation is a DOCUMENTED, accepted constraint in this codebase (the 161 UAT comment explicitly calls board height-aware sizing 'HUMAN-UAT only'), so the new test targets the WIDTH computation path (computeBoardSize's width-budget-vs-maxWidth clamp), which IS mechanically provable with a clientWidth stub, rather than attempting to fake full CSS layout."

key-files:
  created:
    - frontend/src/hooks/analysis/useAnalysisBoardArrows.ts
    - frontend/src/hooks/analysis/useAnalysisGemMarkers.ts
    - frontend/src/hooks/analysis/useBoardStageSize.ts
  modified:
    - frontend/src/pages/Analysis.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx

key-decisions:
  - "useAnalysisGemMarkers scoped to flawMarkerByNodeId, resolveMarkerFor, moveListMarkers and the on-demand parent-grade resolution effect only — NOT the plan's literal field list (storedTierByPly, storedBestGoodByPly, sweepArmedForGame+its armedGameId effect, fenAtPly, sweepCandidates, pinnedEloForPly, parentGemCandidateSans, fastForwardStopPlies). Every excluded field either (a) is already consumed by 215-04's useAnalysisEngineLines at an earlier render position than this hook can occupy, or (b) feeds a LOCAL engine call (useGemSweep's `sweep`, the second useStockfishGradingEngine's `gemGrading`) that per the plan's own no-engine-instantiation rule cannot move into this hook, so its inputs cannot precede it either. fastForwardStopPlies additionally turned out not to be part of this cluster's data flow AT ALL — it exists purely to feed the component's own useFastForward call, discovered by grepping every reader before assuming the plan's line-proximity read was accurate. This is the SAME shape as 215-04's two documented scope deviations (URL-params-before-gameData, unionSans-before-grading): a real data-flow ordering constraint, not a preference, verified by reading the actual render-order dependency graph rather than trusting the plan's cluster table (which RESEARCH.md itself flagged as 'a starting hypothesis, not a final design')."
  - "Caught and fixed a bug BEFORE committing: the first draft of useAnalysisGemMarkers's resolveMarkerFor dropped the `if (gameHasStoredBestMoveData) return null;` Pitfall-3 guard (rationalizing in a comment that storedTierByPly's emptiness already implied it) — this is WRONG: an analyzed game's stored-empty-but-ready ply must return an authoritative null (never falling through to the live/sweep path), which the dropped guard was the ONLY thing enforcing. Fixed by adding gameHasStoredBestMoveData as an explicit option and restoring the original branch verbatim, matching 215-04's own precedent of catching a rewrite bug before it reached a commit."
  - "useBoardStageSize created as a genuinely new hook (not a duplicate of useFitBoardToViewport.ts or useMiniBoardSize.ts) after reading both per the plan's explicit instruction — useFitBoardToViewport fits a board COLUMN into a short viewport via a completely different chrome-vs-viewport-height budget with no width/height 'locked band' concept, and useMiniBoardSize only resolves a fixed desktop size vs. a flat 50%-viewport mobile fraction; neither measures a stage element via ResizeObserver against computeBoardSize's width/height dual-constraint solver the way this cluster does."
  - "BOARD_WIDTH_LOCK_MIN_PX/BOARD_HEIGHT_LOCK_MIN_PX moved into useBoardStageSize.ts (sole reader after extraction); BOARD_EVAL_BARS_ALLOWANCE_PX/EVAL_SLIDER_SLACK_PX/DESKTOP_BOARD_SIZE_REDUCTION_PX privately DUPLICATED rather than imported — grep confirmed Analysis.tsx's DESKTOP_GRID_MAX_WIDTH_PX calc and the (215-06-owned) render tree also read all three, and 'hooks must not depend on page-level modules' (the rule 215-04's own hooks already document) rules out importing them back from Analysis.tsx."
  - "Mutation 3 (useBoardStageSize's measured width forced to 0) initially left the 85-test oracle GREEN — jsdom performs no real CSS layout, so every pre-existing test's clientWidth reads 0 regardless of whether the real measurement code runs at all (the codebase's own 161 UAT comment already documents board height-aware sizing as 'HUMAN-UAT only' for exactly this reason). Per the plan's own step-4 instruction, added ONE new test (following the file's own established vi.spyOn(Element.prototype, 'clientWidth', 'get') pattern, already used 10+ times for arrow-geometry assertions) asserting the rendered board's pixel width traces through computeBoardSize's width-budget-vs-maxWidth clamp when a nonzero clientWidth is stubbed. Re-ran the mutation: now correctly caught (1 failed / 85 passed), restored 86/86."

requirements-completed: [SC-1, SC-2, SC-3]

coverage:
  - id: D1
    description: "useAnalysisBoardArrows.ts extracted (board-overlay derivation: sidelineNodeColors, pvSidelineArrows, qualityHoverArrows, nextMoveArrow, engineArrows, boardSquareMarkers, lastMoveTierColor); boardSquareMarkers's cyclomatic-18 breach fixed via three named per-precedence-tier helpers; Analysis() drops from 168/181/1854 to 162/172/1694"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Analysis.test.tsx (85 passed after task 1)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' --rule 'max-depth: [\"error\", 4]' --rule 'max-statements: [\"error\", 100]' src/hooks/analysis/ (exit 0)"
        status: pass
      - kind: unit
        ref: "Mutation proof: boardSquareMarkers forced to return [] -> 8 failed / 77 passed (Gem moves suite), restored 85/85"
        status: pass
    human_judgment: true
    rationale: "The plan's own must_haves flag every 'no behavior change' / gem-visibility-scoping prohibition as verification: manual — the automated evidence (85/85 tests, byte-identical testid inventory, mutation proof) is strong but a human should confirm the board's arrow/marker overlay renders identically in a real browser (hover-isolation, engine-arrow precedence, gem/great badge tinting) before treating the extraction as fully proven."
  - id: D2
    description: "useAnalysisGemMarkers.ts extracted (flawMarkerByNodeId, resolveMarkerFor, moveListMarkers, the on-demand parent-grade resolution effect); moveListMarkers's cyclomatic-27 breach (worst in the file outside a component body) and the resolution effect's cyclomatic-19 breach both fixed; documented scope deviation from the plan's literal field list; Analysis() drops to 159/168/1479"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Analysis.test.tsx (85 passed after task 2)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' --rule 'max-depth: [\"error\", 4]' --rule 'max-statements: [\"error\", 100]' src/hooks/analysis/ (exit 0); grep -c 'useStockfishGradingEngine\\|useGemSweep' src/hooks/analysis/useAnalysisGemMarkers.ts (0)"
        status: pass
      - kind: unit
        ref: "Mutation proof: moveListMarkers forced to return an empty Map -> 10 failed / 75 passed, restored 85/85"
        status: pass
      - kind: other
        ref: "cd frontend && npm run lint:cognitive | grep flawMarkerByNodeId's new location (cognitive complexity 16, unchanged from the phase baseline — moved verbatim, reducing it was desirable not required)"
        status: pass
    human_judgment: true
    rationale: "Same manual-verification prohibitions as D1 (zero behavior change on the gem/great/book badge resolution path, including the explicit prohibition against user-scoping opponent gems) plus the scope-deviation write-up in key-decisions — a human should confirm the narrower hook boundary is sound and that the gem-sweep/stored-tier precedence still resolves identically before this counts as satisfying the plan's own field list."
  - id: D3
    description: "useBoardStageSize.ts extracted (boardStageRef, boardWidth, boardStageHeight, the ResizeObserver measurement effect) after confirming neither useFitBoardToViewport nor useMiniBoardSize already covers it; Analysis() drops to 159/165/1454 (final — all three strictly lower than after task 2); mutation proof initially unguarded, closed by adding one new test; app-wide react-hooks count confirmed unchanged (30, per 215-04's correction of the plan's stated 28); full frontend suite green"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Analysis.test.tsx (86 passed after task 3, +1 new mutation-proof test); npm test -- --run (3887/3887 passed, 250/250 files — the documented Train.guestGate.test.tsx flake did not reproduce this run)"
        status: pass
      - kind: unit
        ref: "Mutation proof: measured boardWidth forced to 0 -> first pass GREEN (85/85, jsdom zero-layout limitation, documented in the codebase's own 161 UAT comment) -> added 'sizes the board from the measured stage width via computeBoardSize' test stubbing Element.prototype.clientWidth -> re-ran mutation: 1 failed / 85 passed, restored 86/86"
        status: pass
      - kind: other
        ref: "cd frontend && diff testid inventory (empty); grep -c data-umami-event (0); git diff -- eslint.config.js (empty); npm run lint && npm run build && npm run knip (all green); app-wide react-hooks count (30, unchanged)"
        status: pass
    human_judgment: true
    rationale: "This is the plan's highest jsdom-blind-spot task (board pixel sizing IS the behavior, and jsdom performs no real CSS layout, per the plan's own framing and the codebase's own pre-existing 161 UAT comment) — despite the added mutation-proof coverage and a green full suite, a human should smoke-test the actual desktop/mid board sizing in a real browser (the locked-band height budget, the UAT-179 20px reduction, the mid-layout tab-panel height match) before treating the extraction as fully proven, matching D1/D2's rationale."

duration: 62min
completed: 2026-09-04
status: complete
---

# Phase 215 Plan 05: Analysis.tsx Marker/Arrow/Board-Sizing Decomposition Summary

**`Analysis()` split from 168/181/1854 (complexity/statements/lines) to 159/165/1454 across three named sibling hooks (board-overlay arrows/markers, gem-marker resolution, board-stage sizing), clearing the cyclomatic-27 `moveListMarkers` (the file's worst non-component offender), the cyclomatic-19 gem-resolution effect and the cyclomatic-18 `boardSquareMarkers`, with three two-way mutation proofs (one requiring a new test to close a jsdom coverage gap) and a documented scope deviation mirroring 215-04's precedent.**

## Performance

- **Duration:** ~62 min
- **Started:** ~2026-09-03T22:00Z (approx, first read after 215-04 landed)
- **Completed:** 2026-09-03T22:49:39Z
- **Tasks:** 3
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments

- `useAnalysisBoardArrows.ts` created (Task 1): owns the board-overlay derivation cluster (`sidelineNodeColors`, `pvSidelineArrows`, `qualityHoverArrows`, `nextMoveArrow`, `engineArrows`, `boardSquareMarkers`, `lastMoveTierColor`). `boardSquareMarkers`'s cyclomatic-18 breach fixed via three named per-precedence-tier helpers (`appendGemGreatMarker`/`appendBestGoodMarker`/`appendBookMarker`). `Analysis()` drops from 168/181/1854 to 162/172/1694.
- `useAnalysisGemMarkers.ts` created (Task 2): owns `flawMarkerByNodeId`, `resolveMarkerFor`, `moveListMarkers`, and the on-demand parent-grade resolution effect. `moveListMarkers`'s cyclomatic-27 breach (the highest-complexity function in the file outside a component body) fixed via three named helpers (`hasNoMoveListMarkerWork`/`buildMarkerNodePlies`/`applyBookMarkers`); the resolution effect's cyclomatic-19 breach fixed via `resolveGemDetailForNode`. Documented, RESEARCH.md-anticipated scope deviation from the plan's literal field list (see Key Decisions). `Analysis()` drops to 159/168/1479.
- `useBoardStageSize.ts` created (Task 3): owns `boardStageRef`, `boardWidth`, `boardStageHeight` and the `ResizeObserver`-driven measurement effect, confirmed genuinely new against both existing board-sizing hooks first. `Analysis()` drops to 159/165/1454 (final).
- Every arrow-level complexity breach the plan named is cleared: only `Analysis()` itself and the `playerBar` arrow (215-06's scope) remain as `complexity` findings in `Analysis.tsx`.
- Three two-way mutation proofs (one per new hook). Two caught cleanly by the existing 85-test oracle; the third (board-sizing) initially left the suite green due to jsdom's documented zero-CSS-layout limitation, closed by adding one new test to the existing `Analysis.test.tsx` using the file's own established `clientWidth`-stub pattern.
- App-wide `react-hooks/exhaustive-deps` + `react-hooks/refs` count re-measured after all three tasks: **30**, unchanged from 215-04's corrected baseline (the plan's own text says "exactly 28" — inherited from 215-01's stated baseline, corrected to 30 by 215-04 and re-confirmed here; see 215-04-SUMMARY.md's own deviation write-up for the full explanation).
- Suppression-comment total across `Analysis.tsx` plus `src/hooks/analysis/`: **6** at every task checkpoint, unchanged.
- Full frontend suite green: **3887/3887 tests, 250/250 files** (`Analysis.test.tsx` at 86, +1 from this plan's new mutation-proof test). The documented pre-existing `Train.guestGate.test.tsx` flake did not reproduce this run.

## Task Commits

1. **Task 1: Extract useAnalysisBoardArrows end to end, clearing the cyclomatic-18 square-marker memo** — `0c7a81919` (feat)
2. **Task 2: Extract useAnalysisGemMarkers — the cyclomatic-27 move-list marker memo and the gem-sweep resolution** — `717c6f731` (feat)
3. **Task 3: Extract useBoardStageSize, then measure and mutation-prove the plan's three hooks** — `c51ca5b07` (feat)

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `frontend/src/hooks/analysis/useAnalysisBoardArrows.ts` (new, ~460 lines) — board-overlay arrow/marker derivation hook
- `frontend/src/hooks/analysis/useAnalysisGemMarkers.ts` (new, ~600 lines) — gem-marker resolution hook
- `frontend/src/hooks/analysis/useBoardStageSize.ts` (new, ~180 lines) — board-stage sizing hook
- `frontend/src/pages/Analysis.tsx` (modified, net large reduction across three edits) — three hook calls replace the former inline clusters
- `frontend/src/pages/__tests__/Analysis.test.tsx` (modified, +23 lines) — one new mutation-proof test for `useBoardStageSize`'s measured-width seam

## Before/After Measurements

**`Analysis()`'s own complexity/statements/lines** (`npx eslint --no-inline-config --rule 'complexity: ["warn", 15]' --rule 'max-statements: ["warn", 100]' --rule 'max-lines-per-function: ["warn", {"max": 200, "skipBlankLines": true, "skipComments": true}]' src/pages/Analysis.tsx`):

| Point | Complexity | Statements | Lines |
|---|---|---|---|
| Before (215-04 end) | 176→168 baseline | 213→181 baseline | 2037→1854 baseline |
| After Task 1 (board arrows) | 162 | 172 | 1694 |
| After Task 2 (gem markers) | 159 | 168 | 1479 |
| After Task 3 (board stage size) — **final** | **159** | **165** | **1454** |

Complexity held flat between Task 2 and Task 3 (159 → 159) for the same reason 215-04 documented between its own Task 1 and Task 2: the board-stage sizing cluster is a single `useEffect` — removing it drops `Analysis()`'s statement/line counts but the effect's own internal branching was never counted toward the *outer* `Analysis()` complexity number (each function/effect callback is measured independently by ESLint's `complexity` rule). This is expected, not a regression: `Analysis()`'s complexity and statements are both still far over the enforced limits (159 > 15, 165 > 100) at the end of this plan — 215-06 lands both remaining baseline-region deletions after the render-tree split.

**Four originally-flagged arrows, tracked from 215-04's own final table:**

| Function | Complexity | Status |
|---|---|---|
| `qualityBySanWithGem` | 16 | Fixed in 215-04 |
| gem-sweep `useEffect` | 19 | **Fixed here (Task 2)** — inside `useAnalysisGemMarkers.ts`, via `resolveGemDetailForNode` |
| `moveListMarkers` | 27 | **Fixed here (Task 2)** — inside `useAnalysisGemMarkers.ts`, via three named helpers |
| `boardSquareMarkers` | 18 | **Fixed here (Task 1)** — inside `useAnalysisBoardArrows.ts`, via three named helpers |
| `playerBar` | 19 | Remains in `Analysis.tsx` — 215-06 owns |

**`npx eslint --no-inline-config --rule 'complexity: ["error", 15]' --rule 'max-depth: ["error", 4]' --rule 'max-statements: ["error", 100]' src/hooks/analysis/':** exit 0 across all six hook files (the three from 215-04 plus this plan's three) at every task checkpoint.

**`npm run lint:cognitive` (Sonar cognitive complexity) for `src/pages/Analysis.tsx` + `src/hooks/analysis/`:**

| Point | Breaches in `Analysis.tsx` | Breaches in `src/hooks/analysis/` |
|---|---|---|
| Before (215-01 baseline) | 4 (lines 549, 1640, 1782, 2390) | n/a (directory did not exist) |
| After 215-04 | 3 (`Analysis` itself; `flawMarkerByNodeId`, formerly `qualityBySanWithGem`'s neighbor; `moveListMarkers`) | 0 |
| After this plan | **1** (`Analysis` itself, complexity 194) | 1 (`flawMarkerByNodeId`, complexity 16, unchanged — moved verbatim into `useAnalysisGemMarkers.ts`) |

`flawMarkerByNodeId`'s cognitive-complexity number: **16 before, 16 after** — moved verbatim (its own logic is a flat loop with early continues, not the kind of nested-branch shape the CLAUDE.md seam pattern targets; reducing it further was flagged "desirable, not required" by the plan and left alone to avoid touching working logic outside this plan's scope). `moveListMarkers`'s own cognitive breach is gone from the standalone list because its cyclomatic-27 fix (three named helpers) incidentally brought its cognitive number under 15 too — same "one seam fixes both metrics" pattern 215-04 observed for `resolveStoredTierShortCircuit`.

**Testid inventory:** 24 `data-testid` attributes, 0 `data-umami-event`, byte-identical before and after every task (`diff` exit 0 each time).

**Suppression-comment total** (`grep -c eslint-disable src/pages/Analysis.tsx src/hooks/analysis/*.ts`, summed): **6** at every task checkpoint — unchanged from 215-04's end state (5 inside `useAnalysisRouteSeeding.ts`, 1 remaining in `Analysis.tsx` at the Import-tab paste-handoff effect).

**App-wide `react-hooks/exhaustive-deps` + `react-hooks/refs` count:** **30** after all three tasks (measured via the plan's own Python one-liner). The plan's own stated invariant ("exactly 28") is the SAME stale numeral 215-04 already corrected — see this session's `<sequential_execution>` context note and 215-04-SUMMARY.md's own deviation write-up. No fix was needed here since the count was already correctly re-baselined at 30 before this plan started; this SUMMARY simply re-confirms it held at 30 → 30 across all three tasks, i.e. unchanged in either direction.

## Mutation Proofs (Task 3, step 4)

One seam per new hook, temporarily forced to a degenerate value, the test oracle re-run, body restored, suite re-confirmed green.

| Hook / seam | Mutation | Result | Restored result |
|---|---|---|---|
| `useAnalysisBoardArrows` — `boardSquareMarkers` | Body replaced with `return [];` | **77 passed, 8 failed** — all in "Gem moves (Phase 163, SEED-092)": freely-played gem classification (white/black), mainline gem via move list, stored gem/great board badges, WR-05 severity-suppresses-gem, sticky persistence, one-way latch across ELO-slider moves | 85/85 passed |
| `useAnalysisGemMarkers` — `moveListMarkers` | Body replaced with `return new Map();` | **75 passed, 10 failed** — spans freely-played gem classification, gem popover text (ELO/Maia-prob/opponent heading), stored gem/great badges (board + move list + popover), sticky/latch persistence, book marker on an inaccuracy-severity ply | 85/85 passed |
| `useBoardStageSize` — measured `boardWidth` | `setBoardWidth(isDesktopWidth ? Math.min(desktopBoard, widthBudget) : raw)` → `setBoardWidth(0)` | **First pass: 85 passed, 0 failed (GREEN — unguarded)**. jsdom performs no real CSS layout, so every pre-existing test's `clientWidth` reads 0 regardless of whether the real measurement code runs — the SAME limitation the codebase's own Phase 161 UAT comment documents ("board height-aware sizing are HUMAN-UAT only"). Closed by adding one new test (`sizes the board from the measured stage width via computeBoardSize`) that stubs `Element.prototype.clientWidth` to 800 (mirroring the file's own pre-existing D-12 arrow-geometry pattern) and asserts `getByTestId('analysis-board').style.width === '540px'` — the `computeBoardSize(720, Infinity, 540)` width-budget-vs-maxWidth clamp, mechanically derived and independently verified to pass against the REAL (unmutated) code before being used as the mutation-proof assertion. **Second pass with the SAME mutation: 85 passed, 1 failed (the new test)** | 86/86 passed |

All three seams are now genuinely covered by the oracle — the third required a documented, deliberate gap closure rather than a coverage-by-accident pass. Test diff for this plan: `frontend/src/pages/__tests__/Analysis.test.tsx` +23 lines, one new test, no existing test modified or weakened.

## Decisions Made

See `key-decisions` in the frontmatter above for the full list. The two most consequential:

1. **`useAnalysisGemMarkers` (Task 2) — the plan's literal field list collides with 215-04's existing hook-call ordering and this plan's own no-engine-instantiation rule, in EIGHT places at once.** Unlike 215-04's two isolated deviations, this plan's gem-marker cluster is deeply entangled with the local `sweep` (`useGemSweep`) and `gemGrading` (second `useStockfishGradingEngine`) calls — nearly every field the plan named either feeds one of those two local engine calls (so must precede them, i.e. stay local) or is already an option of 215-04's `useAnalysisEngineLines` (called even earlier). The actually-extractable cluster turned out to be exactly the four items with no such feed/gate relationship: `flawMarkerByNodeId`, `resolveMarkerFor`, `moveListMarkers`, and the resolution effect that stamps `gemByNode`. Verified by reading the real render-order dependency graph symbol-by-symbol (not trusting the plan's cluster table), matching RESEARCH.md's own explicit caveat (quoted in 215-04-SUMMARY.md) that the boundaries were "a starting hypothesis... not a final design."
2. **`useBoardStageSize` (Task 3) — the mutation proof surfaced a REAL, pre-existing, documented gap (not a new one this plan introduced), and the correct response was a targeted new test, not a design change.** jsdom's inability to perform real CSS layout is called out by name in the codebase's own Phase 161 UAT comment; the plan's own mutation-proof protocol (step 4) exists precisely to catch cases like this. Rather than trying to fake full layout (fragile, high-maintenance) the new test targets the ONE sub-computation that IS mechanically provable without real layout — the width-budget-vs-maxWidth clamp inside `computeBoardSize` — using the file's own established `clientWidth`-stub idiom.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug caught pre-commit] `resolveMarkerFor`'s first draft dropped the Pitfall-3 authoritative-null guard**
- **Found during:** Task 2 implementation, before any commit
- **Issue:** The extracted `resolveMarkerFor` initially omitted `if (gameHasStoredBestMoveData) return null;` after the `storedTierByPly.get(ply) === undefined` branch, with a comment rationalizing that an empty `storedTierByPly` map already implied the same outcome. This reasoning is wrong: for an analyzed game's mainline ply with genuinely no stored tier (a real "not a gem/great" verdict), the guard is what prevents falling through to the live/sweep path and re-deriving a DIFFERENT (potentially contradictory) answer — Pitfall 3's whole point.
- **Fix:** Added `gameHasStoredBestMoveData: boolean` as an explicit hook option and restored the original branch verbatim.
- **Files modified:** `frontend/src/hooks/analysis/useAnalysisGemMarkers.ts` (never committed with the bug — caught before the Task 2 commit)
- **Verification:** Full 85-test suite green after the fix; the mutation-2 proof (forcing `moveListMarkers` to an empty Map) still failed the expected 10 tests, not a different set.
- **Committed in:** `717c6f731` (Task 2 commit, already fixed)

**2. [Rule 3 - Blocking] Scope reduction on `useAnalysisGemMarkers`'s field list to resolve real hook-ordering deadlocks**
- **Found during:** Task 2 implementation (planning phase, before writing code)
- **Issue:** See "Decisions Made" #1 above — the plan's literal field-ownership list for `useAnalysisGemMarkers` names 8 fields (`storedTierByPly`, `storedBestGoodByPly`, `sweepArmedForGame`+effect, `fenAtPly`, `sweepCandidates`, `pinnedEloForPly`, `parentGemCandidateSans`, `fastForwardStopPlies`) that each either feed a local engine call this plan forbids moving, or are already consumed by 215-04's earlier-positioned `useAnalysisEngineLines`.
- **Fix:** Scoped the hook to the 4 fields with no such conflict; the rest stays local to `Analysis.tsx`, computed identically to the original code, threaded into the hook as options where the hook genuinely needs the VALUE (not the computation).
- **Files modified:** `frontend/src/hooks/analysis/useAnalysisGemMarkers.ts`, `frontend/src/pages/Analysis.tsx`
- **Verification:** 85/85 tests pass at the Task 2 checkpoint; full 3887-test suite green at Task 3; mutation proof on `moveListMarkers` finds no coverage gap; `npm run build` (tsc -b) exits 0 with no new suppression comments; `grep -c` engine-instantiation guard prints 0.
- **Committed in:** `717c6f731` (Task 2)

**3. [Rule 1 - Test gap closure, not a code bug] `useBoardStageSize`'s mutation proof was unguarded on the first pass**
- **Found during:** Task 3, step 4 (mutation-proof step)
- **Issue:** Forcing the measured `boardWidth` to a hardcoded `0` left the 85-test oracle fully green — no test asserted on the board's actual pixel size in a way jsdom's zero-CSS-layout environment could distinguish from the real computation.
- **Fix:** Added one new test stubbing `Element.prototype.clientWidth` (the codebase's own established pattern, used 10+ times elsewhere in this file for arrow-geometry assertions) and asserting the rendered board's `style.width`/`style.height` trace through `computeBoardSize`'s width-budget-vs-maxWidth clamp. Independently verified the predicted value (540px) against the REAL code before using it as the mutation-proof assertion.
- **Files modified:** `frontend/src/pages/__tests__/Analysis.test.tsx` (test addition only — no existing test modified)
- **Verification:** New test passes against the real code (86/86 total); re-ran the mutation with the new test present: 1 failed (the new test) / 85 passed, confirming the seam is now genuinely guarded; restored, 86/86.
- **Committed in:** `c51ca5b07` (Task 3)

---

**Total deviations:** 3 (1 bug caught pre-commit, 1 scope reduction spanning 8 fields, 1 test-gap closure with 1 new test added)
**Impact on plan:** All three are necessary for correctness, accuracy, or genuine coverage; none represent scope creep. The scope reduction keeps every machine-verified acceptance criterion (85/86 tests, testid diff, complexity/statement reduction, engine-instantiation guard, lint/build/knip, mutation proofs) fully satisfied — only the plan's own prose description of which hook owns which field changed, documented in-file (each hook's own JSDoc header) and here. The new test is a pure addition (never a rewrite), matching the plan's explicit constraint.

## Issues Encountered

- **Pre-existing test-isolation flake in `src/pages/__tests__/Train.guestGate.test.tsx`** (documented in every prior 215-0X-SUMMARY.md, checked for here): did NOT reproduce in this session's full-suite run (`npm test -- --run` → 3887/3887 passed, 250/250 files). No file under `src/pages/Train*` or `src/hooks/__tests__/Train*` was touched by this plan; the flake's absence this run is consistent with its documented intermittent nature (test-order dependent), not evidence it's fixed.
- **Self-caught mid-mutation-testing bug (not a code defect, an execution-order mistake):** while investigating why Task 3's new test initially failed a plausibility check, discovered the earlier `setBoardWidth(0)` mutation had never been reverted from a prior investigation step — the "failure" was the mutation still being live, not a wrong prediction. Corrected by explicitly reverting the mutation before re-testing; no code was left in a mutated state at any commit boundary (verified via `git status`/`git diff` before each commit).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

`Analysis.tsx`'s marker/arrow/board-sizing clusters (the former arrow-level complexity breaches at cyclomatic 27/19/18) are now three named, independently-readable hooks under `src/hooks/analysis/`, joining 215-04's three. `Analysis()` itself is still far over the enforced complexity/statement limits (159/165) — 215-06 (render tree, `playerBar`, the phase's remaining baseline-region deletions) is the last plan in this file's decomposition. The app-wide react-hooks warning count (30) and suppression-comment total (6) are the numbers 215-08 (phase-wide closeout) should carry forward, matching 215-04's own corrected baseline exactly — no further drift introduced by this plan.

No blockers for 215-06. 215-06 should read this plan's `useAnalysisBoardArrows.ts`/`useAnalysisGemMarkers.ts`/`useBoardStageSize.ts` headers before touching the render tree or `playerBar`, since the render tree consumes `boardArrows`/`boardSquareMarkers`/`lastMoveTierColor`/`sidelineNodeColors` (from `useAnalysisBoardArrows`), `moveListMarkers` (from `useAnalysisGemMarkers`, passed to `VariationTree`'s `flawMarkerByNodeId` prop — note the prop name and the LOCAL hook-result variable of the same name in Task 2's own hook are two different things), and `boardStageRef`/`boardWidth`/`boardStageHeight` (from `useBoardStageSize`) as already-resolved values, not raw local state.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-04*

## Self-Check: PASSED

- FOUND: `frontend/src/hooks/analysis/useAnalysisBoardArrows.ts`
- FOUND: `frontend/src/hooks/analysis/useAnalysisGemMarkers.ts`
- FOUND: `frontend/src/hooks/analysis/useBoardStageSize.ts`
- FOUND commit `0c7a81919` (Task 1)
- FOUND commit `717c6f731` (Task 2)
- FOUND commit `c51ca5b07` (Task 3)
- Re-ran `npx vitest run src/pages/__tests__/Analysis.test.tsx`: 86/86 passed
- Re-ran `npm test -- --run`: 3887/3887 passed (250/250 files)
- Re-ran `npm run lint`, `npm run build`, `npm run knip`: all green
- Re-ran testid inventory diff: empty; `data-umami-event` count: 0
- Re-ran `git diff -- eslint.config.js`: empty
- Re-ran app-wide react-hooks count: 30 (unchanged)
- Re-ran suppression-comment total: 6 (unchanged)
