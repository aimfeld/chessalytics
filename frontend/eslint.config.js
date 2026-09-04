import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dev-dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // New in react-hooks 7.1.1 — codebase intentionally uses setState in effects
      // to derive state from server data and filter synchronisation. The patterns are
      // correct (each effect has a stable dependency array) and carry no cascading-
      // render risk at runtime. Re-evaluate if the affected hooks are refactored.
      'react-hooks/set-state-in-effect': 'off',
      // Phase 215 — mirrors the backend complexity gate (docs/dev-tooling.md, root
      // CLAUDE.md's function-size rule). Every pre-existing breach is baselined below
      // in a dedicated region; `max-statements` is the logic-LOC analog rather than a
      // JSX-return-tree-counting line-count rule, which CLAUDE.md's logic-LOC carve-out
      // explicitly excludes.
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-statements': ['error', 100],
    },
  },
  // shadcn/ui components export variants alongside components — standard pattern
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Filter components co-export types, constants, and utility functions alongside
  // components (e.g. FilterState, DEFAULT_FILTERS, FILTER_DOT_FIELDS, CALENDAR_*).
  // react-refresh 0.5 narrowed allowConstantExport to primitive literals only, so
  // computed exports like new Date() and array constants now trigger the rule. The
  // pattern is intentional — these shared values live alongside the components that
  // define and own them.
  {
    files: ['src/components/filters/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Analysis board overlay exports non-component arrow builders and orientation helpers
  // alongside the TacticModeOverlay component so Analysis.tsx can drive the shared
  // ChessBoard arrows without a separate file indirection (Phase 139).
  {
    files: ['src/components/analysis/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // --- Phase 215 baseline region -------------------------------------------------
  // Measured 2026-09-03 (215 code review WR-07, 2026-09-04: converted from a blanket
  // `'off'` to a real ratchet). Every file below gets its OWN ceiling set to its
  // measured value at baseline time, against the `**/*.{ts,tsx}` complexity/max-depth/
  // max-statements rules above. `'off'` let a baselined file regress without limit,
  // silently defeating the "this region only ever SHRINKS" promise (frontend/
  // CLAUDE.md: "a new breach must be fixed, not baselined") — a ceiling equal to the
  // measured value keeps today's residual green while any further growth fails lint.
  // An entry is deleted (not widened) by the plan that fixes its file; lowering a
  // ceiling as a file improves is encouraged but not required. Re-measure a file with
  // `npx eslint --no-inline-config --rule 'complexity: ["error", 1]' <path>` (swap the
  // rule name/threshold for max-statements/max-depth) to get its exact current value —
  // the CLI flag defeats every ceiling in this block.
  {
    files: [
      'src/components/board/BoardControls.tsx',
      'src/components/library/FlawComparisonGrid.tsx',
      'src/components/library/MoveStats.tsx',
      'src/components/train/TrainReminderButton.tsx',
      'src/hooks/useTrainGradingEngine.ts',
      'src/lib/engine/__tests__/treeCommon.test.ts',
      'src/lib/tacticComparisonMeta.ts',
      'src/lib/trainRevealCache.ts',
    ],
    rules: { complexity: ['error', 16] },
  },
  {
    files: [
      'src/components/charts/EndgameEloTimelineSection.tsx',
      'src/components/train/TrainStartScreen.tsx',
      'src/lib/engine/engineAssetCache.ts',
    ],
    rules: { complexity: ['error', 17] },
  },
  {
    files: ['src/components/results/GameCard.tsx'],
    rules: { complexity: ['error', 18] },
  },
  {
    files: [
      'src/components/library/TacticComparisonGrid.tsx',
      'src/components/move-explorer/MoveExplorer.tsx',
      'src/hooks/uciParser.ts',
      'src/hooks/useOpeningInsights.ts',
      'src/hooks/useStockfishGradingEngine.ts',
      'src/instrument.ts',
    ],
    rules: { complexity: ['error', 19] },
  },
  {
    files: [
      'src/lib/engine/mctsSearch.ts',
      'src/pages/library/GamesTab.tsx',
    ],
    rules: { complexity: ['error', 20] },
  },
  {
    files: [
      'src/App.tsx',
      'src/components/charts/WDLChartRow.tsx',
      'src/components/library/TagChip.tsx',
      'src/components/position-bookmarks/SuggestionsModal.tsx',
      'src/pages/GlobalStats.tsx',
    ],
    rules: { complexity: ['error', 21] },
  },
  {
    files: [
      'src/components/library/SeverityBadge.tsx',
      'src/hooks/useTrainFreePlay.ts',
    ],
    rules: { complexity: ['error', 23] },
  },
  {
    files: [
      'src/components/analysis/VariationTree.tsx',
      'src/components/filters/FilterPanel.tsx',
      'src/pages/Train.tsx',
      'src/pages/library/FlawsTab.tsx',
    ],
    rules: { complexity: ['error', 24] },
  },
  {
    files: [
      'src/pages/Bots.tsx',
      'src/pages/openings/StatsTab.tsx',
    ],
    rules: { complexity: ['error', 25] },
  },
  {
    files: [
      'src/components/charts/MiniBulletChart.tsx',
      'src/components/stats/OpeningStatsCard.tsx',
    ],
    rules: { complexity: ['error', 26] },
  },
  {
    files: ['src/hooks/useStats.ts'],
    rules: { complexity: ['error', 27] },
  },
  {
    files: [
      'src/components/charts/EndgameMetricsByTcCard.tsx',
      'src/components/charts/PositionResultsPanel.tsx',
      'src/pages/Import.tsx',
    ],
    rules: { complexity: ['error', 29] },
  },
  {
    files: [
      'src/components/charts/EndgameTypeCard.tsx',
      'src/components/insights/OpeningFindingCard.tsx',
    ],
    rules: { complexity: ['error', 31] },
  },
  {
    files: ['src/lib/engine/fallbackExpectimax.ts'],
    rules: { complexity: ['error', 32] },
  },
  {
    files: ['src/components/library/FlawCard.tsx'],
    rules: { complexity: ['error', 39] },
  },
  {
    files: [
      'src/components/library/TacticMotifChip.tsx',
      'src/hooks/useGameOverlay.ts',
    ],
    rules: { complexity: ['error', 41] },
  },
  // Reasoned residual (SC-1 relaxed 2026-09-04, ROADMAP Phase 215): OpeningsPage() went
  // cyclomatic 64 -> 48 across 215-07 (OpeningsFilterFields, OpeningsDesktopSidebar,
  // OpeningsMobileDrawers, useOpeningsChartData, OpeningsMobileBoardPanel). Bisection
  // (blanking JSX regions and re-measuring) shows 35 of the remaining 48 points sit in
  // flat `&&`/`?:` top-level derivations computed before the JSX return (mobileFiltersDot,
  // the showXxxHint booleans, needsRedirect/needsLegacyRedirect, pieceFilterLabel, the
  // chained activeTab ternary, etc.) that no named seam in this plan absorbs — the same
  // "unscoped hooks/data section" shape 215-06 found on Analysis.tsx (215-07 SUMMARY).
  {
    files: ['src/pages/Openings.tsx'],
    rules: { complexity: ['error', 48] },
  },
  {
    files: ['src/components/library/EvalChart.tsx'],
    rules: { complexity: ['error', 49] },
  },
  {
    files: ['src/pages/Endgames.tsx'],
    rules: { complexity: ['error', 56] },
  },
  {
    files: [
      'src/components/train/TrainReveal.tsx',
      'src/components/train/TrainSolveScreen.tsx',
    ],
    rules: { complexity: ['error', 68] },
  },
  {
    files: ['src/components/results/LibraryGameCard.tsx'],
    rules: { complexity: ['error', 78] },
  },
  // Reasoned residual (SC-1 relaxed 2026-09-04, ROADMAP Phase 215): Analysis() went
  // cyclomatic 176 -> 132 and 213 -> 152 statements across 215-04/05/06; the rest is
  // flat `&&`/`?:` derivations in the hooks section that no cohesive hook absorbs
  // (215-06 SUMMARY, SEED-160). max-statements is inside the CLAUDE.md hard logic-LOC
  // limit (200) and over the soft one.
  {
    files: ['src/pages/Analysis.tsx'],
    rules: { complexity: ['error', 132], 'max-statements': ['error', 152] },
  },
  // Only `max-depth` breach in the TypeScript tree — a test file, out of Phase 215
  // scope. Measured 2026-09-04 (215 code review WR-07): 10, converted from `'off'`.
  {
    files: ['src/lib/__tests__/reminderSlotState.test.ts'],
    rules: { 'max-depth': ['error', 10] },
  },
])
