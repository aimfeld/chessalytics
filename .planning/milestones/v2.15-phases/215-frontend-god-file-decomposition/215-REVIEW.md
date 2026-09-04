---
phase: 215-frontend-god-file-decomposition
reviewed: 2026-09-04T10:00:00Z
depth: standard
files_reviewed: 34
files_reviewed_list:
  - frontend/eslint.config.js
  - frontend/eslint.config.sonarjs.mjs
  - frontend/src/components/analysis/AnalysisBoardStage.tsx
  - frontend/src/components/analysis/AnalysisDesktopCards.tsx
  - frontend/src/components/analysis/AnalysisPlayerBar.tsx
  - frontend/src/components/analysis/AnalysisTabs.tsx
  - frontend/src/hooks/analysis/useAnalysisBoardArrows.ts
  - frontend/src/hooks/analysis/useAnalysisEngineLines.ts
  - frontend/src/hooks/analysis/useAnalysisGemMarkers.ts
  - frontend/src/hooks/analysis/useAnalysisRouteParams.ts
  - frontend/src/hooks/analysis/useAnalysisRouteSeeding.ts
  - frontend/src/hooks/analysis/useBoardStageSize.ts
  - frontend/src/hooks/__tests__/useBotGame.test.ts
  - frontend/src/hooks/useBotGameClock.ts
  - frontend/src/hooks/useBotGameDrawOffer.ts
  - frontend/src/hooks/useBotGameEngineDispatch.ts
  - frontend/src/hooks/useBotGameMoves.ts
  - frontend/src/hooks/useBotGameSnapshot.ts
  - frontend/src/hooks/useBotGame.ts
  - frontend/src/lib/engine/workerPoolDispatch.ts
  - frontend/src/lib/engine/workerPoolLifecycle.ts
  - frontend/src/lib/engine/workerPoolState.ts
  - frontend/src/lib/engine/workerPool.ts
  - frontend/src/lib/engine/workerPoolWatchdog.ts
  - frontend/src/pages/Analysis.tsx
  - frontend/src/pages/openings/ChessboardInfoCopy.tsx
  - frontend/src/pages/openings/OpeningsDesktopSidebar.tsx
  - frontend/src/pages/openings/OpeningsFilterFields.tsx
  - frontend/src/pages/openings/OpeningsMobileBoardPanel.tsx
  - frontend/src/pages/openings/OpeningsMobileDrawers.tsx
  - frontend/src/pages/Openings.tsx
  - frontend/src/pages/openings/useOpeningsChartData.ts
  - frontend/src/pages/__tests__/Analysis.test.tsx
  - frontend/src/pages/__tests__/Openings.render.test.tsx
findings:
  critical: 0
  warning: 7
  info: 9
  total: 16
status: issues_found
---

# Phase 215: Code Review Report

**Reviewed:** 2026-09-04T10:00:00Z
**Depth:** standard
**Files Reviewed:** 34
**Status:** issues_found

## Summary

Phase 215 is a pure decomposition of four god files (`workerPool.ts`, `useBotGame.ts`, `Analysis.tsx`, `Openings.tsx`) into sibling modules, so the review concentrated on behavior drift introduced by moving code, then on the structural quality of the split. The pre-phase versions (`git show 00292ab4^:<path>`) were used as the oracle throughout.

**Behavior-drift verification (no drift found):**

- `workerPool` cluster: every moved function body (`sendGo`, `dispatchNext`, `handleLine`, `grade`, `replaceDeadSlot`, `drainPending`, `createSlot`, `runSpawnConstructionLoop`, `ensureSpawned`, `stopAll`, `terminate`, `warm`, all seven watchdog functions, `markPoolReady`/`markPoolFailed`/`whenReady`) was diffed against the original after normalizing the `state.`/`ops.` threading. All are identical apart from the parameter plumbing. All three `Sentry.captureException` sites survived with their static messages and `stockfish-worker-pool` tag.
- `useBotGame` cluster: every `useEffect`/`useCallback`/`useMemo` dependency array was compared old vs new. The only additions are stable refs and `useState` setters (identity never changes). Passive-effect declaration order still satisfies every documented constraint: mount-init before tick, hidden-tab pause listener registered before the snapshot-write listener, provider bring-up and `runBotTurnRef` assignment before the bot-turn trigger, and the trigger still reads `runBotTurnRef.current` (the stale-closure indirection is intact). `newGame`, `finalizeGame`, `commitMove`, the draw-resolution effect and the grade continuation perform the same operations in the same order.
- `Analysis` cluster: all 40+ memo/callback/effect dependency arrays match the original (including generic `useMemo<T>()` calls). The six route-seeding effects keep their original order and `eslint-disable` lines; `moveListMarkers`, `boardSquareMarkers` and the parent-grade resolution effect are logically identical after the named-helper split; every `data-testid` (`analysis-board`, `analysis-player-{color}`, `analysis-eval-chart`, `analysis-board-tags`, the tab and card ids) is preserved; `rowPosition` defaults to `'bottom'` as before; top/bottom player colors resolve to the same `boardFlipped` mapping at all seven call sites; `highlightedPlies` is threaded on desktop only, as before.
- `Openings` cluster: testids (`filter-piece-filter[-sidebar]`, all notification dots, `chessboard-info[-mobile]`, `position-bookmarks-info[-sidebar]`), `FilterPanel` props, toggle classes, and the desktop/mobile colour-toggle handlers match the original. `useOpeningsChartData` memo deps match.
- Mock-path hazards: `vi.mock('@/lib/engine/workerPool')` factories in `useBotGame.test.ts`, `Analysis.test.tsx`, `useGemSweep.test.ts` and `useFlawChessEngine.test.ts` replace the facade module wholesale, so the new stage modules are never evaluated under those mocks. No importer lost a mock. `npm run lint` and `npm run knip` pass; the four touched test files pass (289 tests).

**Key concerns:** the `workerPool` split created a real import cycle that its own documentation denies, plus three dead dispatch-table fields; the `Analysis` split leaned on "private duplication" to the point that `forkPlyForOrientation` now exists four times (already textually diverged) and three layout constants are copied between the page and the sizing hook that feeds it; and the ESLint complexity baseline uses `'off'` rather than a ratchet, so the "only ever shrinks" promise is unenforced.

## Warnings

### WR-01: Stage modules import from the facade they are imported by (import cycle the docs say does not exist)

**File:** `frontend/src/lib/engine/workerPoolDispatch.ts:27-36`, `frontend/src/lib/engine/workerPoolLifecycle.ts:34-39`, `frontend/src/lib/engine/workerPoolWatchdog.ts:24-33`, `frontend/src/lib/engine/workerPool.ts:36-55`, `frontend/src/lib/engine/workerPoolState.ts:23-24`
**Issue:** `workerPool.ts` imports the three stage modules, and each stage module imports value bindings back from `./workerPool` (`enqueue`, `dequeueHighestPriority`, `noLiveSlotRemains`, `sideToMove`, `WORKER_HASH_MB`, `GRADING_WATCHDOG_TIMEOUT_MS`, `MAX_SLOT_RESPAWNS`, `computePoolSize`, the watchdog constants). `workerPoolLifecycle.ts:51` even re-exports `noLiveSlotRemains` straight out of the facade. `workerPoolState.ts:23-24` claims "Late binding through one shared table is what lets sibling modules call into each other without an import cycle", which is false: the cycle is facade <-> stage, not stage <-> stage. It is runtime-safe today only because every cross-module binding is read inside a function body, not at module-evaluation time. A future top-level use of any of those constants (a `const X = GRADING_WATCHDOG_TIMEOUT_MS * 2` in a stage module, or a test importing a stage module first) hits the TDZ / `undefined` at load with no lint or type error to warn. `madge --circular` would flag this.
**Fix:** Move the shared leaf definitions out of the facade so the dependency graph is a DAG: put the tunable constants, `QueuedGradeRequest`/`PoolWorkerSlot`/`GradeCache` types, `enqueue`/`dequeueHighestPriority`, `sideToMove`, `isLowPowerDevice`/`computePoolSize` and `noLiveSlotRemains` into `workerPoolState.ts` (or a new `workerPoolCore.ts`), have the stage modules import from there, and keep `workerPool.ts` re-exporting them for existing external importers:
```ts
// workerPoolState.ts (or workerPoolCore.ts)
export const GRADING_WATCHDOG_TIMEOUT_MS = 60_000;
export function noLiveSlotRemains(state: PoolState): boolean { ... }
// workerPool.ts
export { GRADING_WATCHDOG_TIMEOUT_MS, noLiveSlotRemains, /* ... */ } from './workerPoolState';
```
Then fix the `workerPoolState.ts:14-27` header to describe the real graph and delete the `export { noLiveSlotRemains }` re-export in `workerPoolLifecycle.ts:51` (nothing imports it from there).

### WR-02: Three `PoolOps` fields are never called through `ops`

**File:** `frontend/src/lib/engine/workerPoolState.ts:98,103,105`, `frontend/src/lib/engine/workerPool.ts:867,873,874`
**Issue:** `ops.rearmGradingWatchdog`, `ops.createSlot` and `ops.drainPending` have no call site anywhere (`grep -o 'ops\.[a-zA-Z]+' src/lib/engine/workerPool*.ts` lists only nine distinct fields). The watchdog module calls its own `rearmGradingWatchdog` directly, the lifecycle module calls `createSlot(state, ops, ...)` and `drainPending(state)` directly. The dispatch table is documented as "a twelve-field dispatch table ... every field is a function one stage module may need to call into another stage's implementation", so three of the twelve are dead wiring that misleads a reader about which cross-stage calls actually exist and adds closures per pool for nothing.
**Fix:** Delete the three fields from `PoolOps` and from the `ops` literal, and update the "twelve-field" prose in `workerPoolState.ts:14-18`:
```ts
export interface PoolOps {
  markPoolReady: () => void;
  markPoolFailed: () => void;
  clearSlotWatchdog: (slot: PoolWorkerSlot) => void;
  armStopWatchdog: (slot: PoolWorkerSlot) => void;
  armInitWatchdog: (slot: PoolWorkerSlot) => void;
  dispatchNext: () => void;
  handleLine: (slot: PoolWorkerSlot, line: string) => void;
  replaceDeadSlot: (slot: PoolWorkerSlot) => void;
  ensureSpawned: () => void;
}
```

### WR-03: `EngineToggleHeader` duplicated into two component files with diverging signatures, both citing a source that no longer exists

**File:** `frontend/src/components/analysis/AnalysisTabs.tsx:61-101`, `frontend/src/components/analysis/AnalysisDesktopCards.tsx:26-63`
**Issue:** The engine-card header (Switch + accent icon + label) was copied into both files. The two copies have already diverged: `AnalysisTabs.tsx` keeps the original `icon: LucideIcon` prop, while `AnalysisDesktopCards.tsx` drops the prop and hard-codes `<Cpu>`. Both doc comments say "Private duplicate of Analysis.tsx's own module-level `EngineToggleHeader`", but `Analysis.tsx` no longer defines it (removed in this phase), so the stated "source of truth" is gone and the two cards' headers will drift independently on the next styling change (this is exactly the shape the project's "always apply changes to mobile too" rule warns about). The "private duplication" precedent from 215-04 was for page-level helpers that hooks must not import; here both readers are sibling component files, so an import is the normal thing to do.
**Fix:** Keep one exported component and import it from the other file (a dedicated `src/components/analysis/EngineToggleHeader.tsx` is cleanest, since the `analysis/**` ESLint override already permits non-component exports):
```tsx
// AnalysisDesktopCards.tsx
import { EngineToggleHeader } from '@/components/analysis/EngineToggleHeader';
<EngineToggleHeader ... icon={Cpu}>{ENGINE_NAME}...</EngineToggleHeader>
```
Delete the stale "Private duplicate of Analysis.tsx's own" comments in both files.

### WR-04: Board layout constants duplicated between `Analysis.tsx` and the sizing hook that feeds it

**File:** `frontend/src/hooks/analysis/useBoardStageSize.ts:61,66,71` vs `frontend/src/pages/Analysis.tsx:167,176,208`; consumer at `frontend/src/pages/Analysis.tsx:2148` and `frontend/src/hooks/analysis/useBoardStageSize.ts:140`
**Issue:** `BOARD_EVAL_BARS_ALLOWANCE_PX`, `EVAL_SLIDER_SLACK_PX` and `DESKTOP_BOARD_SIZE_REDUCTION_PX` now exist twice. They are not independent knobs: `useBoardStageSize` subtracts its copy of the allowance from the stage width to compute `boardWidth`, and `DesktopBoardStage` then adds `Analysis.tsx`'s copy (`boardEvalBarsAllowancePx`) back to that `boardWidth` for the group's `maxWidth`. If either copy is edited alone, the board fit and the group width silently disagree and the eval bars clip again (the exact "Bug fix" case documented at `useBoardStageSize.ts:147-154`). The same pattern applies to `LIVE_EVAL_CACHE_MAX` (`Analysis.tsx:130` / `useAnalysisGemMarkers.ts:86`): the two FIFO caches are meant to share one bound. The hook header justifies this with "hooks must not depend on page-level modules", but that rule argues for hoisting the constants to a lib module, not for copying them.
**Fix:** Move the three layout constants next to `BOARD_MAX_WIDTH`/`BOARD_MIN_WIDTH` in `src/components/board/boardSize.ts` (already imported by both files) and import them in both places; do the same for `LIVE_EVAL_CACHE_MAX` (e.g. `src/lib/gemMove.ts` or `src/lib/gemSweep.ts`). Then `DesktopBoardStage` no longer needs the `boardEvalBarsAllowancePx` prop at all:
```ts
// boardSize.ts
export const BOARD_EVAL_BARS_ALLOWANCE_PX = 56;
export const EVAL_SLIDER_SLACK_PX = 12;
export const DESKTOP_BOARD_SIZE_REDUCTION_PX = 20;
```

### WR-05: Load-bearing tactic helpers copied four times, already textually diverged

**File:** `forkPlyForOrientation`: `frontend/src/pages/Analysis.tsx:300`, `frontend/src/hooks/analysis/useAnalysisBoardArrows.ts:75`, `frontend/src/hooks/analysis/useAnalysisRouteSeeding.ts:48`, `frontend/src/components/analysis/AnalysisTabs.tsx:52`; `flawKey`: `Analysis.tsx:309`, `useAnalysisRouteSeeding.ts:53`, `AnalysisTabs.tsx:57`; `bestSanFromPv`: `Analysis.tsx:318`, `useAnalysisEngineLines.ts:82`; `FlawRef`/`OpenLine`/`TacticRef` types: `Analysis.tsx:334-335`, `useAnalysisBoardArrows.ts:66`, `useAnalysisRouteSeeding.ts:57-58`
**Issue:** `forkPlyForOrientation` decides which mainline node a tactic sideline forks from (missed = ply-1, allowed = ply). The seeding effect, the PV arrow overlay, and the tags-panel navigation each hold their own copy, and one copy is already written differently (`useAnalysisBoardArrows.ts:76` uses `orientation === 'missed' ? flawPly - 1 : flawPly`, the other three use `orientation === 'allowed' ? flawPly : flawPly - 1`). They are equivalent today, but a future fix to the fork rule (the Quick 260628-pu2 history shows this rule HAS changed before) now has to land in four files, or the board arrow, the graft point, and the tags navigation disagree about where a line starts. `flawKey` is the `openLines` Map key: three copies of a key-format function is a lookup-miss bug waiting to happen. `tsc`/knip/eslint are blind to all of this.
**Fix:** Create `src/lib/analysisTactics.ts` exporting `forkPlyForOrientation`, `flawKey`, `bestSanFromPv` and the `TacticRef`/`OpenLine` types, import it from all five files, and delete the copies. This satisfies the "hooks must not import page modules" rule (it is a lib module) and matches the existing `@/lib/tacticDepth`/`@/lib/tacticArrows` split.

### WR-06: Tap-target styling derived from the test-id suffix

**File:** `frontend/src/pages/openings/OpeningsFilterFields.tsx:41`
**Issue:** `const toggleItemClassName = testIdSuffix === '-sidebar' ? 'flex-1 min-h-11 text-sm' : 'flex-1 text-sm';` couples a visual decision (mobile 44px tap target) to the browser-automation contract. The prop is documented as a testid concern only; a reader changing testids (or adding a third call site with its own suffix) silently changes layout, and vice versa.
**Fix:** Make the layout choice an explicit prop and keep the testid suffix purely about testids:
```ts
export type OpeningsFilterFieldsProps = {
  ...
  testIdSuffix: '' | '-sidebar';
  /** Mobile drawer uses a 44px tap target (min-h-11); desktop does not. */
  tallTapTargets?: boolean;
  showDivider?: boolean;
};
const toggleItemClassName = tallTapTargets ? 'flex-1 min-h-11 text-sm' : 'flex-1 text-sm';
```
and pass `tallTapTargets` from `OpeningsMobileDrawers.tsx:76-80`.

### WR-07: Complexity baseline uses `'off'`, so baselined files can regress without limit

**File:** `frontend/eslint.config.js:72-139,143-146`
**Issue:** The Phase 215 baseline region disables `complexity` entirely for 52 files and `max-statements` for `Analysis.tsx`. The comment promises "This region only ever SHRINKS", and `frontend/CLAUDE.md:10` says "A new breach must be fixed, not baselined", but nothing enforces either: a baselined file (including the two reasoned residuals, `Analysis()` at 132 and `OpeningsPage()` at 48, plus every other file in the list) can grow by any amount and `npm run lint` stays green. A ratchet is what makes a baseline a baseline.
**Fix:** Replace `'off'` with per-file ceilings at the measured value so any growth fails lint while the recorded residual still passes. The measured numbers are already in the comments:
```js
{ files: ['src/pages/Analysis.tsx'], rules: { complexity: ['error', 132], 'max-statements': ['error', 152] } },
{ files: ['src/pages/Openings.tsx'], rules: { complexity: ['error', 48] } },
// and one measured ceiling per remaining baselined file (or a shared
// ceiling equal to the current max of that group), never 'off'.
```
Re-measure each file once with `npx eslint --no-inline-config --rule 'complexity: ["error", 15]' <path>` to fill in the numbers.

## Info

### IN-01: Orphaned JSDoc block for `replaceDeadSlot` left in the facade

**File:** `frontend/src/lib/engine/workerPool.ts:765-786`
**Issue:** A 22-line `/** Replace a slot whose worker has permanently failed ... */` doc comment sits directly above the "Lifecycle stage delegation" banner with no declaration beneath it; the function it documented moved to `workerPoolLifecycle.ts:53-75`, which already carries the same text.
**Fix:** Delete lines 765-786.

### IN-02: Unused exports hidden by knip's `ignoreExportsUsedInFile`

**File:** `frontend/src/lib/engine/workerPoolLifecycle.ts:51`, `frontend/src/components/analysis/AnalysisTabs.tsx:861`, `frontend/src/components/analysis/AnalysisPlayerBar.tsx:31-60`, `frontend/src/components/analysis/AnalysisBoardStage.tsx:31,57`
**Issue:** `export { noLiveSlotRemains }` (lifecycle), `export type { FlawMarkerEntry }` (AnalysisTabs), `EvalBarCap`/`EvalBarSlot` and their `*Props` types, and most `*Props` type exports in the new component files have no importer outside their own file. Knip does not report them because `knip.json` sets `ignoreExportsUsedInFile: true`. They widen the public surface for no reader.
**Fix:** Drop `export` from the in-file-only helpers and types, and delete the two re-exports.

### IN-03: `boardWidth: number | null` widening in `DesktopBoardStageProps`

**File:** `frontend/src/components/analysis/AnalysisBoardStage.tsx:59,137,144,148`
**Issue:** `useBoardStageSize` returns `boardWidth: number` (initialised to 0), so the `| null` in the prop type and the three `boardWidth ?? undefined` fallbacks are unreachable. The original inline JSX used `boardWidth` directly.
**Fix:** Type the prop as `number` and pass `boardWidth` straight through.

### IN-04: Pass-through wrapper components add a layer with no behavior

**File:** `frontend/src/components/analysis/AnalysisDesktopCards.tsx:154-161,165-187`, `frontend/src/pages/Analysis.tsx:2451-2456`
**Issue:** `DesktopMaiaPanel` is `(props) => <MaiaHumanPanel {...props} />` and `PasteModalNode` is a four-prop rename of `PasteModal`; `Analysis.tsx` then builds a `pasteModalNodeProps` bag just to spread it into the wrapper. None of this moves a branch out of `Analysis()`.
**Fix:** Render `<MaiaHumanPanel {...desktopMaiaPanelProps} />` and `<PasteModal open={pasteModalOpen} onOpenChange={setPasteModalOpen} onLoad={handlePasteLoad} onSaved={handlePasteSaved} />` directly and delete the two wrappers.

### IN-05: Redundant `as MoverColor` cast introduced in the move

**File:** `frontend/src/components/analysis/AnalysisTabs.tsx:616`
**Issue:** `mover={sideToMoveFromFen(position) as MoverColor}`; `sideToMoveFromFen` already returns `MoverColor` (`src/lib/liveFlaw.ts:36`), and the original `humanTab` had no cast. The cast is the only reason `MoverColor` is imported here.
**Fix:** Remove the cast and the `MoverColor` type import.

### IN-06: Eval tab content gated three times

**File:** `frontend/src/pages/Analysis.tsx:2285-2299`, `frontend/src/components/analysis/AnalysisTabs.tsx:722-723,268-306,343`
**Issue:** The call site wraps `<EvalChartPanel>` in `(evalChartReady || evalPending) &&` and `<TagsPanel>` in `evalChartReady &&`; `EvalTab` re-applies the same two guards around the props; and `EvalChartPanel`/`TagsPanel` return `null` on the same conditions themselves. Harmless, but each extra `&&` is exactly the kind of flat derivation the phase was trying to get out of `Analysis()`.
**Fix:** Pass the elements unconditionally from `Analysis.tsx` and let `EvalTab`'s existing guards (or the components' own null returns) decide.

### IN-07: Two different components named `BoardControls` in scope of the same page tree

**File:** `frontend/src/components/analysis/AnalysisTabs.tsx:11,204`
**Issue:** The new wrapper is exported as `BoardControls` while importing the real one as `BoardControlsBase`. `Analysis.tsx` now imports `BoardControls` from `AnalysisTabs`, whereas `OpeningsMobileBoardPanel.tsx` imports `BoardControls` from `@/components/board/BoardControls`: same name, different props (`isGameMode`/`onFastForwardStart` vs `onFastForward`).
**Fix:** Rename the wrapper to `AnalysisBoardControls` and import the base component under its real name.

### IN-08: Function declaration sandwiched between `import` statements

**File:** `frontend/src/pages/Openings.tsx:3-10`
**Issue:** `setChartEnabledStorage` is declared after the first `import` and before the remaining ~50 imports. The phase rewrote this block (removing `getChartEnabled` and replacing the comment) but kept the pre-existing placement. Imports are hoisted so it works, but it reads as if the imports end at line 1.
**Fix:** Move the helper below the import block (next to `PAGE_SIZE`/`TAB_INFO`).

### IN-09: Comments describing an intermediate state of the phase

**File:** `frontend/src/lib/engine/workerPoolDispatch.ts:15`, `frontend/src/hooks/analysis/useAnalysisBoardArrows.ts:19-22`, `frontend/src/pages/Analysis.tsx:1685-1686`, `frontend/src/hooks/useBotGameDrawOffer.ts:115-116`, `frontend/src/hooks/useBotGameEngineDispatch.ts:165-171`
**Issue:** Several headers narrate a plan step that has since completed: "still-inline, until Phase 215-02 task 3" (lifecycle is extracted), "`resolveMarkerFor` and `storedBestGoodByPly` are still LOCAL to `Analysis.tsx` at this point in the phase (215-06's `useAnalysisGemMarkers` extraction owns them next)" (it is now supplied by `useAnalysisGemMarkers`), "stays in `useBotGame.ts` for now — moves to the snapshot cluster in Task 3" (already moved), and "owned by `useBotGame.ts` (part of the snapshot/persistence cluster, Task 3)" (owned by `useBotGameSnapshot`).
**Fix:** Rewrite each to describe the final ownership; drop the plan-step references.

---

_Reviewed: 2026-09-04T10:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
