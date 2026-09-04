---
phase: 215-frontend-god-file-decomposition
plan: 06
subsystem: ui
tags: [react, refactor, complexity, analysis-page, eslint, mutation-testing, human-uat]

requires:
  - phase: 215-frontend-god-file-decomposition (plan 05)
    provides: "Analysis() reduced to 159/165/1454 (complexity/statements/lines) over three sibling hooks (useAnalysisBoardArrows, useAnalysisGemMarkers, useBoardStageSize); playerBar (cyclomatic 19) and the render-tree fragments left as the only remaining complexity findings"
provides:
  - "Analysis()'s render tree split into four sibling components under src/components/analysis/ (AnalysisPlayerBar, AnalysisTabs, AnalysisBoardStage, AnalysisDesktopCards); Analysis() reduced from 159/165 to 132/152 (complexity/statements), independently re-measured"
  - "playerBar (former cyclomatic 19) now inside cyclomatic 15 as PlayerBar in AnalysisPlayerBar.tsx"
  - "SC-0 and SC-1 for Analysis.tsx NOT reached — documented deviation with bisection evidence, eslint.config.js baseline entries deliberately left in place"
  - "HUMAN-UAT smoke of the Analysis page approved by the user at desktop and mobile widths, all six checklist items including opponent gem markers"
affects: [215-08]

actuals:
  tokens: 108500
  tasks: 4
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Render-fragment extraction into real components with typed Props interfaces, mirroring 215-04/215-05's hook-extraction pattern one layer up (render tree instead of hooks/data): BoardHeaderRow/VariationTreePanel/BoardControls own their own internal branch (e.g. showPlayerBars, isGameMode) rather than taking a caller-pre-resolved ternary, so the branch counts toward the new component's own complexity, not Analysis()'s — same seam 215-04/215-05 used for hook-owned branching."
    - "Shared page-level helper components (EngineToggleHeader, FlawChessInfoTooltip) privately duplicated into the consuming component file when neither of two readers is the sole reader, rather than imported back from Analysis.tsx — matches 215-05's own established duplication rule for constants with more than one page-level-and-component reader."
    - "Bisection measurement as the evidence base for a documented SC shortfall: `npx eslint --no-inline-config --rule 'complexity: [\"warn\", 15]'` run against isolated line ranges of the pre-split file to attribute the remaining complexity budget between the hooks/data section (421-2148) and the JSX-return section, rather than asserting the shortfall's cause from inspection alone."

key-files:
  created:
    - frontend/src/components/analysis/AnalysisPlayerBar.tsx
    - frontend/src/components/analysis/AnalysisTabs.tsx
    - frontend/src/components/analysis/AnalysisBoardStage.tsx
    - frontend/src/components/analysis/AnalysisDesktopCards.tsx
  modified:
    - frontend/src/pages/Analysis.tsx

key-decisions:
  - "SC-0 and SC-1 for Analysis.tsx are NOT reached; both eslint.config.js baseline override entries (the complexity files array entry and the max-statements 'off' block) are deliberately LEFT IN PLACE so npm run lint stays green. Deleting them now would break the lint gate, and the plan's own text prohibits reaching the metric by wrapping unrelated derivations purely to clear it ('Do NOT reach the number by wrapping a fragment in an arrow function called from the same place')."
  - "Bisection evidence (recorded in Task 3's commit message, 07efe7f33): of the 132 complexity points remaining in Analysis() after this plan's full render-tree split, roughly 100 come from small `const x = a && b` / `cond ? y : z` derived-value expressions scattered through the ~1700-line hooks/data section (lines 421-2148) — none of which are named as an extraction target by 215-04, 215-05, or this plan. Only ~14-20 points live in the JSX-return section this task's own fallback list named. Reaching those ~100 points safely would require the same hook-ordering analysis 215-04/215-05 applied to their own named clusters, extended to many more expressions no plan scoped — explicitly out of scope per this plan's own 'capture as a seed, do not implement' instruction."
  - "No finer per-cluster breakdown of the ~100 hooks/data-section points was captured beyond the region bisection (421-2148 vs. the JSX-return section) — Task 3's bisection measured by isolated line range, not by named sub-cluster within that range. A follow-up decision on relaxing SC-1 for page components, or on planning a further hooks/data-section split, would need a second bisection pass at finer granularity before scoping new work."
  - "HUMAN-UAT smoke approved by the user at desktop and mobile widths, all six checklist items, with item 4 (opponent gem markers) explicitly confirmed still visible — no regression."

requirements-completed: [SC-2, SC-3, SC-4]

coverage:
  - id: D1
    description: "AnalysisPlayerBar.tsx extracted (PlayerBar, EvalBarCap, EvalBarSlot, BoardHeaderRow, BoardFooterRow); playerBar's cyclomatic-19 body split via two per-source resolvers (resolveFromPastedHeaders/resolveFromGameData); Analysis() drops from 159/165 to 152/162"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Analysis.test.tsx (86 passed after task 1)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' src/components/analysis/AnalysisPlayerBar.tsx (exit 0)"
        status: pass
    human_judgment: false
  - id: D2
    description: "AnalysisTabs.tsx extracted (HumanTab, FlawChessTab, MobileEngineLines, EvalTab, MoveListHeaderContent, MovesTab, StatsTab, AnalysisTabs, plus shared fragments VariationTreePanel/BoardControls/EvalChartPanel/TagsPanel/EloSelectorPanel/FlawChessCard); Analysis() drops from 152/162 to 142/152"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Analysis.test.tsx (86 passed after task 2)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' --rule 'max-depth: [\"error\", 4]' --rule 'max-statements: [\"error\", 100]' src/components/analysis/ (exit 0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "AnalysisBoardStage.tsx (BoardRow, DesktopBoardStage) and AnalysisDesktopCards.tsx (StockfishCard, MovesCard, DesktopMaiaPanel, PasteModalNode) extracted; Analysis() drops from 142/152 to 132/152. SC-0/SC-1 NOT reached — documented deviation, eslint.config.js baseline entries left in place. Two two-way mutation proofs recorded (MovesTab, PlayerBar); testid/umami inventories byte-identical; full suite green (3887/3887); react-hooks count unchanged at 30."
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Analysis.test.tsx (86 passed after task 3); npm test -- --run (3887/3887 passed)"
        status: pass
      - kind: other
        ref: "cd frontend && diff testid/umami union inventories (empty); npm run lint && npm run build && npm run knip (all green)"
        status: pass
      - kind: unit
        ref: "Mutation proof: AnalysisTabs's MovesTab forced to render null, and PlayerBar forced to render null — both caught by the existing 85-test oracle, restored 86/86"
        status: pass
    human_judgment: true
    rationale: "This is the phase's first render-tree-changing plan; the plan's own must_haves flag every 'no behavior change' / DOM-contract prohibition as verification: manual. Automated evidence (86 tests, byte-identical testid/umami inventory, two mutation proofs) is strong but does not cover real browser layout, gem-marker visibility across viewport widths, or the paste/tactic-mode flows — the HUMAN-UAT smoke (D4) covers what automation cannot."
  - id: D4
    description: "HUMAN-UAT smoke of the Analysis page: library-game mode, paste mode, tactic mode, gem markers (including opponent gems), all analysis tabs, and mobile-specific rendering, checked at desktop AND mobile widths"
    requirement: "SC-4"
    verification:
      - kind: manual_procedural
        ref: "User approved all six checklist items at desktop and mobile widths"
        status: pass
    human_judgment: true
    rationale: "Visual/layout regression across two viewport widths and three page modes cannot be proven by the automated test suite or a DOM-contract diff; this is exactly the class of check the plan's own checkpoint exists for."

duration: 95min
completed: 2026-09-04
status: complete
---

# Phase 215 Plan 06: Analysis.tsx Render-Tree Decomposition Summary

**`Analysis()`'s render tree split into four sibling components (`AnalysisPlayerBar`, `AnalysisTabs`, `AnalysisBoardStage`, `AnalysisDesktopCards`) under `src/components/analysis/`, taking the component from 159/165 to 132/152 (complexity/statements) — SC-0 and SC-1 for this file are NOT reached, with a bisection-backed deviation write-up showing the remaining ~100 complexity points sit in the untouched hooks/data section, not the render tree this plan owned.**

## Performance

- **Duration:** ~95 min (across Tasks 1-3; Task 4 checkpoint spanned a separate session boundary)
- **Tasks:** 4 (3 code tasks + 1 HUMAN-UAT checkpoint)
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments

- `AnalysisPlayerBar.tsx` created (Task 1): `PlayerBar`, `EvalBarCap`, `EvalBarSlot`, `BoardHeaderRow`, `BoardFooterRow`, each with a typed `Props` interface. The cyclomatic-19 `playerBar` arrow is fixed via two per-source resolvers (`resolveFromPastedHeaders`/`resolveFromGameData`) rather than one helper per condition. `BoardHeaderRow` owns its `showPlayerBars` branch internally so callers pass raw props at all 7 call sites instead of a pre-resolved `ReactNode`. `Analysis()` drops from 159/165 to 152/162.
- `AnalysisTabs.tsx` created (Task 2): `HumanTab`, `FlawChessTab`, `MobileEngineLines`, `EvalTab`, `MoveListHeaderContent`, `MovesTab`, `StatsTab`, `AnalysisTabs`, plus the shared fragments `VariationTreePanel`, `BoardControls`, `EvalChartPanel`, `TagsPanel`, `EloSelectorPanel`, `FlawChessCard`. `VariationTreePanel`/`BoardControls` own their `isGameMode` branch internally, matching Task 1's `showPlayerBars` seam. `EngineToggleHeader`/`FlawChessInfoTooltip` privately duplicated (used by both this file's `FlawChessCard` and the still-local `stockfishCard`, so neither is the sole reader). `Analysis()` drops from 152/162 to 142/152.
- `AnalysisBoardStage.tsx` (`BoardRow`, `DesktopBoardStage`) and `AnalysisDesktopCards.tsx` (`StockfishCard`, `MovesCard`, `DesktopMaiaPanel`, `PasteModalNode`) created (Task 3). `Analysis()` drops from 142/152 to **132/152** (final; independently re-measured this session — see "Complexity Trajectory" below).
- Two two-way mutation proofs recorded (Task 3, step 5): `AnalysisTabs`'s `MovesTab` forced to render `null`, and `PlayerBar` forced to render `null` — both caught by the existing 85-test oracle (a subset failed as expected in each case), restored to 86/86.
- Union `data-testid`/`data-umami-event` inventories byte-identical across all three tasks (`diff` exit 0 each time, comparing `src/pages/Analysis.tsx` + `src/components/analysis/*.tsx` before and after).
- `npx vitest run src/pages/__tests__/Analysis.test.tsx`: 86 passed after every task. Full suite (`npm test -- --run`): 3887/3887 passed, 250/250 files, at Task 3's checkpoint. `npm run lint`, `npm run build`, `npm run knip` all green at every task.
- App-wide `react-hooks/exhaustive-deps` + `react-hooks/refs` count re-measured after Task 3: **30**, unchanged from 215-04/215-05's corrected baseline.
- **HUMAN-UAT smoke (Task 4): approved by the user at desktop and mobile widths, all six items**, including item 4 (opponent gem markers) explicitly confirmed still visible — `best_move_tier` is position-scoped by design, and the analysis board intentionally shows opponent gems; no regression was observed.

## Task Commits

1. **Task 1: Extract AnalysisPlayerBar, clear the cyclomatic-19 player-bar helper** — `38de87360` (feat)
2. **Task 2: Extract AnalysisTabs — engine, eval, moves and stats tab fragments** — `7ceb3218d` (feat)
3. **Task 3: Extract AnalysisBoardStage and AnalysisDesktopCards; SC-0/SC-1 not reached** — `07efe7f33` (feat)
4. **Task 4: HUMAN-UAT smoke — checkpoint, no code commit** — approved by user

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `frontend/src/components/analysis/AnalysisPlayerBar.tsx` (new, 218 lines) — player-bar family: name/rating/clock resolution split by source (pasted headers vs. game data), eval bar cap/slot, header/footer rows
- `frontend/src/components/analysis/AnalysisTabs.tsx` (new, 861 lines) — the four analysis tabs (human/Maia, FlawChess, eval, moves, stats) plus their shared fragments (variation tree, board controls, eval chart, tags panel, ELO selector, FlawChess card)
- `frontend/src/components/analysis/AnalysisBoardStage.tsx` (new, 197 lines) — the board row and desktop board stage shared by mid/desktop layouts
- `frontend/src/components/analysis/AnalysisDesktopCards.tsx` (new, 187 lines) — Stockfish card, moves card, desktop Maia panel, paste-modal node
- `frontend/src/pages/Analysis.tsx` (modified, net large reduction across three edits) — render section becomes component composition; `Analysis` keeps its name and default export

## Complexity Trajectory (`Analysis()`, complexity/statements)

Measured via `npx eslint --no-inline-config --rule 'complexity: ["warn"/"error", 15]' --rule 'max-statements: ["warn"/"error", 100]' src/pages/Analysis.tsx` at each checkpoint. Numbers before Task 1 are 215-05's own final measurement; the final number was independently re-measured this session with the CLI-override command (`error`, not `warn`).

| Point | Complexity | Statements |
|---|---|---|
| Phase base (215-01 baseline) | 176 | 213 |
| After 215-04 | 168 | 181 |
| After 215-05 | 159 | 165 |
| After Task 1 (AnalysisPlayerBar) | 152 | 162 |
| After Task 2 (AnalysisTabs) | 142 | 152 |
| After Task 3 (AnalysisBoardStage + AnalysisDesktopCards) — **final, this plan** | **132** | **152** |

Statements held flat between Task 2 and Task 3 (152 → 152) for the same reason 215-04/215-05 documented for their own flat-statement steps: `Analysis()`'s statement count is dominated by the JSX-return tree and the surviving hooks/data section, not by the render-fragment declarations this task moved out; moving a `const x = (<JSX/>)` declaration out of the function body removes one statement (the declaration) but the JSX-return's own statement footprint is unchanged, and the fragments extracted in Task 3 were comparatively statement-light relative to their complexity contribution.

`playerBar` (the plan's named cyclomatic-19 target) is confirmed inside 15 in its new home, `PlayerBar` in `AnalysisPlayerBar.tsx` (`npx eslint --no-inline-config --rule 'complexity: ["error", 15]' src/components/analysis/AnalysisPlayerBar.tsx` exits 0 across the whole file).

## SC-0 / SC-1 Shortfall — Deviation

**SC-0** (delete `Analysis.tsx`'s two `eslint.config.js` baseline override entries) and **SC-1** (`Analysis()` inside cyclomatic complexity 15 and 100 statements) are **NOT reached** for this file. Both entries — the `complexity` block's `files` array entry and the `{ files: ['src/pages/Analysis.tsx'], rules: { 'max-statements': 'off' } }` block — were **deliberately left in place** in `frontend/eslint.config.js`; `git diff` against 215-05's end state on that file is empty. Deleting them now would break `npm run lint`, since `Analysis()` still sits at 132/152 against the enforced 15/100 limits.

**Why:** Task 3's bisection measurement (recorded in commit `07efe7f33`'s message) isolated where the remaining 132 complexity points live: roughly **100 of the 132** come from small `const x = a && b` / `cond ? y : z` derived-value expressions scattered through the **~1700-line hooks/data section (lines 421-2148)** — none of which are named as an extraction target by 215-04, 215-05, or this plan. Only **~14-20 points** live in the JSX-return section, which is this task's own fallback extraction target per the plan's action text ("the JSX return itself (4248-4370) is the last candidate and can be split into a desktop and a mobile layout component").

Wrapping dozens of unrelated derivations in `useMemo`/helper functions purely to clear the metric is exactly what this plan's own text prohibits: *"Do NOT reach the number by wrapping a fragment in an arrow function called from the same place; that moves the operators into a nested scope without making anything readable, and it is explicitly prohibited by this plan."* Reaching the ~100 hooks/data-section points safely would require the same hook-ordering analysis 215-04 and 215-05 applied to their own named clusters, extended across many more expressions that no plan (including this one) scoped — this is explicitly out of scope per the plan's own "capture as a seed, do not implement" instruction for anything spotted during the split that no plan named.

**Follow-up input:** no finer per-cluster breakdown of the ~100 hooks/data-section points was captured beyond the region-level bisection (421-2148 vs. the JSX-return section) — Task 3 measured by isolated line range, not by named sub-cluster within that range. A decision on whether to relax SC-1 for page components generally, or to plan a further hooks/data-section split, would need a second, finer-grained bisection pass before scoping new work. That decision is explicitly **not made in this SUMMARY** — it is left for the user/orchestrator, per the resume instructions for this plan.

## Two-Way Mutation Proofs (Task 3, step 5)

| Component / seam | Mutation | Result | Restored result |
|---|---|---|---|
| `AnalysisTabs` — `MovesTab` | Body replaced to render `null` | Caught — a subset of the 85-test oracle failed | 86/86 passed |
| `AnalysisPlayerBar` — `PlayerBar` | Body replaced to render `null` | Caught — a subset of the 85-test oracle failed | 86/86 passed |

Both mutations were caught cleanly by the existing oracle; no new test was required (unlike 215-05's `useBoardStageSize` seam, which needed a jsdom-layout workaround test).

## HUMAN-UAT Smoke (Task 4)

**Outcome: approved by the user at desktop and mobile widths, all six items.**

1. Library-game mode: board, player bars, move list, variation tree, eval bars/chart, engine lines — confirmed.
2. Paste mode: paste modal open/close, pasted game load, pasted headers in player bars — confirmed.
3. Tactic mode: tactic overlay renders, focused line highlighted — confirmed.
4. Gem markers: gem and great-move markers appear on the board and move list, **including on opponent moves** — confirmed, no regression (intentional position-scoped `best_move_tier` behavior preserved).
5. Tabs: every analysis tab (human/Maia, FlawChess, eval, moves, stats) opens and renders — confirmed.
6. Mobile specifics: mobile engine-lines block and mobile board layout render correctly, nothing hidden behind a breakpoint — confirmed.

No item was reported as failing; the checkpoint resolved with a plain "approved" from the user.

## Decisions Made

See `key-decisions` in the frontmatter above for the full list. The two most consequential:

1. **SC-0/SC-1 shortfall is a documented, bisection-backed deviation, not a silent gap.** The remaining complexity budget was measured and attributed to a specific, unscoped region (hooks/data section, lines 421-2148) rather than asserted from inspection. The eslint baseline entries stay in place because removing them would break the lint gate against the file's actual current numbers.
2. **The shortfall-resolution policy (relax SC-1, or plan a further split) is explicitly left undecided in this SUMMARY**, per the resume instructions — this plan records facts for that decision, not the decision itself.

## Deviations from Plan

### Auto-fixed Issues

None beyond the documented SC-0/SC-1 shortfall above, which is a plan-anticipated deviation (the plan's own action text names the JSX-return split as a fallback and explicitly prohibits reaching the metric by metric-gaming) rather than a bug requiring an auto-fix under Rules 1-3.

---

**Total deviations:** 1 (SC-0/SC-1 shortfall, bisection-documented, decision pending)
**Impact on plan:** Every other acceptance criterion in Tasks 1-3 was met (testid/umami inventories, 86-test oracle, mutation proofs, react-hooks count unchanged, lint/build/knip green). The shortfall is scoped narrowly to two specific success criteria for one file, with the evidence needed to decide next steps already captured.

## Issues Encountered

None beyond the SC-0/SC-1 shortfall documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

`Analysis.tsx`'s render tree is now four named, independently-readable components under `src/components/analysis/`, joining 215-04/215-05's three hooks under `src/hooks/analysis/`. `Analysis()` itself is still over the enforced complexity/statement limits (132/152 against 15/100) — SC-0 and SC-1 for this file remain open, with the bisection evidence above as the input for a follow-up decision (relax the goal for page components, or scope a further split of the hooks/data section). 215-08 (phase-wide closeout) should carry forward the app-wide react-hooks count (30, unchanged) and this file's open SC-0/SC-1 status.

No blockers for 215-08 from this plan's own work; the render-tree split is complete and HUMAN-UAT-approved.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-04*

## Self-Check: PASSED

- FOUND: `frontend/src/components/analysis/AnalysisPlayerBar.tsx`
- FOUND: `frontend/src/components/analysis/AnalysisTabs.tsx`
- FOUND: `frontend/src/components/analysis/AnalysisBoardStage.tsx`
- FOUND: `frontend/src/components/analysis/AnalysisDesktopCards.tsx`
- FOUND commit `38de87360` (Task 1)
- FOUND commit `7ceb3218d` (Task 2)
- FOUND commit `07efe7f33` (Task 3)
- Re-ran `npx eslint --no-inline-config --rule 'complexity: ["error", 15]' --rule 'max-statements: ["error", 100]' src/pages/Analysis.tsx`: confirms 132/152, matches this SUMMARY
- Confirmed `git diff -- eslint.config.js` against 215-05's end state is empty (baseline entries intentionally untouched)
- Confirmed working tree under `frontend/` is clean (no uncommitted changes)
