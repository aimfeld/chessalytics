---
phase: 215-frontend-god-file-decomposition
plan: 08
subsystem: tooling
tags: [eslint, complexity-gate, verification, closeout, frontend]

requires:
  - phase: 215-frontend-god-file-decomposition (plan 01)
    provides: "eslint complexity/max-depth/max-statements gate; measurement infrastructure"
  - phase: 215-frontend-god-file-decomposition (plans 02-07)
    provides: "workerPool.ts, useBotGame.ts, Analysis.tsx (x3), Openings.tsx decompositions"
provides:
  - "Phase-wide measured verdict for all six ROADMAP success criteria (0-5), each backed by a runnable command and recorded number, not an eyeball"
  - "CONCERNS.md 'Large God files' entry narrowed to the six next-tier files, with the four Phase 215 files dropped and a Phase 215 history line appended"
affects: []

actuals:
  tokens: 1008
  tasks: 2
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Phase-wide closeout as a measurement-only tracer task: every criterion is a runnable command with a recorded number, never an inspection-based assertion"

key-files:
  created: []
  modified:
    - .planning/codebase/CONCERNS.md

key-decisions:
  - "The plan's own Criterion-0/1 verify command sweeps entire directories (src/components/analysis/, src/pages/openings/) rather than only the files this phase touched, so it also catches two PRE-EXISTING, out-of-scope complexity findings that predate Phase 215 entirely: VariationTree.tsx (3 findings, cyclomatic 16/17/24) and StatsTab.tsx (2 findings, cyclomatic 25/18) — both were part of 215-01's original 52-file app-wide baseline sweep, neither was touched by any Phase 215 plan, and both are named in ROADMAP's own out-of-scope 'next tier' list. Re-ran the same command scoped to exactly the four in-scope files plus every file this phase created (excluding those two untouched siblings): output is empty except the two recorded page-component residuals. Treated as a plan-script imprecision, not a phase finding."
  - "The backend pre-merge gate's ruff/ty commands (uv run ruff check ., uv run --project analysis --with ty ty check analysis/) also flag ~150-170 pre-existing errors in analysis/tilt_study/probes/streak_curve.py — this file was committed by a concurrent, unrelated session (commit 8af6d1ce5, 'docs(tilt-study): streak-curve probes and prior-work comparison') during this plan's own execution window, is untouched by any Phase 215 plan, and is explicitly out of this plan's scope per this session's own execution context. Re-ran both commands scoped to app/ tests/ scripts/ (ruff) and analysis/ excluding tilt_study/probes (ty): both fully green."
  - "useAnalysisGemMarkers.ts's own hook function measures 204 counted lines (max-lines-per-function, report-only) — over the 200 target and not enumerated in 215-05-SUMMARY.md's own per-hook table (215-03 established a per-hook line-count table for useBotGame's five siblings; 215-05 did not repeat that table for its own three). A written reasoned exemption is recorded here to close that documentation gap, per this plan's own 'a survivor with no written justification is a criterion-1 failure, not a footnote' rule."

requirements-completed: [SC-0, SC-1, SC-2, SC-3, SC-4, SC-5]

coverage:
  - id: D1
    description: "Criterion 0 (lint green, no relaxations beyond recorded residuals) and Criterion 1 (size/complexity/depth) measured: npm run lint exits 0; useBotGame.ts/workerPool.ts have zero eslint.config.js entries; the enforced-rule command scoped to the four in-scope files + every phase-created file prints nothing but the two recorded page-component residuals (Analysis complexity 132/statements 152, OpeningsPage complexity 48)"
    requirement: "SC-0, SC-1"
    verification:
      - kind: other
        ref: "cd frontend && npm run lint (exit 0)"
        status: pass
      - kind: other
        ref: "cd frontend && grep -v '^\\s*//' eslint.config.js | grep -cE 'src/hooks/useBotGame.ts|src/lib/engine/workerPool.ts' (0)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\",15]' --rule 'max-depth: [\"error\",4]' --rule 'max-statements: [\"error\",100]' <4 in-scope files + all 27 phase-created files> — empty except Analysis (132/152) and OpeningsPage (48)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Criterion 2 (full gates, additions-only tests, unchanged react-hooks count) measured: frontend lint/build/knip/test all green (3894/3894, 251/251 files); backend ruff/ty/pytest all green (4499 passed, 19 skipped) scoped away from the concurrent tilt-study session's own commit; aggregate test diff 0 deletions; app-wide react-hooks/exhaustive-deps+refs count exactly 30 (27+3), unchanged from 215-01's own corrected baseline; zero new @ts-ignore/@ts-expect-error"
    requirement: "SC-2"
    verification:
      - kind: other
        ref: "cd frontend && npm run lint && npm run build && npm run knip && npm test -- --run (3894 passed, 251 files)"
        status: pass
      - kind: other
        ref: "uv run ruff format --check app/ tests/ scripts/ && uv run ruff check app/ tests/ scripts/ && uv run ty check app/ tests/ scripts/ && uv run --project analysis --with ty ty check analysis/ (excl. tilt_study/probes) && uv run pytest -n auto -x -q (4499 passed, 19 skipped)"
        status: pass
      - kind: other
        ref: "git diff --numstat a34f0e544..HEAD -- test globs | awk deletions-sum (0)"
        status: pass
      - kind: other
        ref: "npx eslint --no-inline-config -f json . | python3 count react-hooks/exhaustive-deps+refs (30)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Criterion 3 (inventories identical, no new suppressions) measured: per-file testid/umami union inventories for Analysis.tsx and Openings.tsx (scoped to each file plus its own phase-created siblings) byte-identical to the phase base commit; useBotGame.ts/workerPool.ts families have 0 of each; suppression total across Analysis.tsx + hooks/analysis/ is 6, matching the pre-phase count; zero new @ts-ignore/@ts-expect-error; git diff --stat shows exactly the 27 new files the six plans' Artifacts sections declare"
    requirement: "SC-3"
    verification:
      - kind: other
        ref: "diff of testid/umami union sets (Analysis.tsx + its 10 phase-created siblings; Openings.tsx + its 6 phase-created siblings, template-literal-expanded) against the phase-base commit — both empty"
        status: pass
      - kind: other
        ref: "grep -c eslint-disable src/pages/Analysis.tsx src/hooks/analysis/*.ts summed (6)"
        status: pass
      - kind: other
        ref: "git diff --name-status a34f0e544..HEAD -- frontend/ | grep '^A' (27 files, matches the union of all six plans' Artifacts sections)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Criterion 4 (HUMAN-UAT) collected: both 215-06 (Analysis) and 215-07 (Openings) HUMAN-UAT smoke records, both approved by the user at desktop and mobile widths, all six checklist items each"
    requirement: "SC-4"
    verification:
      - kind: manual_procedural
        ref: "215-06-SUMMARY.md and 215-07-SUMMARY.md HUMAN-UAT sections, both status: pass, collected into one table below"
        status: pass
    human_judgment: true
    rationale: "This criterion is itself a collection of prior human judgment records (215-06/215-07's own UAT checkpoints); there is nothing further to automate here beyond confirming both records exist and record success, which this SUMMARY does."
  - id: D5
    description: "Criterion 5 (CONCERNS.md narrowed): 'Large God files' entry rewritten to list only the six next-tier files with current line counts, Issue/Fix-approach text updated to name the now-live gate, and a Phase 215 history line appended alongside the existing Phase 214 line; no neighbouring concern touched"
    requirement: "SC-5"
    verification:
      - kind: other
        ref: "grep -A10 'Large \"God files\"' CONCERNS.md | grep '^- Files:' | grep -cE 'Analysis.tsx|useBotGame.ts|workerPool.ts|Openings.tsx' (0)"
        status: pass
      - kind: other
        ref: "grep -A10 'Large \"God files\"' CONCERNS.md | grep -c 'TrainReveal.tsx' (1); grep -A12 ... | grep -c 'Phase 215' (3)"
        status: pass
      - kind: other
        ref: "git diff --stat -- .planning/codebase/CONCERNS.md (single file, single hunk, 4 insertions/4 deletions)"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-09-04
status: complete
---

# Phase 215 Plan 08: Phase-Wide Closeout Summary

**All six ROADMAP success criteria measured against the merged trunk (05c8a38fc) with recorded commands and numbers — lint green with exactly the two documented page-component residuals (Analysis 132/152, OpeningsPage 48), full frontend and backend gates green, additions-only test diff, unchanged 30-warning react-hooks baseline, byte-identical testid/umami inventories, both HUMAN-UAT records collected — and CONCERNS.md's "Large God files" entry narrowed to the six next-tier files.**

## Performance

- **Duration:** ~20 min
- **Started:** ~2026-09-04T09:22Z (approx, immediately after 215-07 landed)
- **Completed:** 2026-09-04T09:40Z
- **Tasks:** 2 (1 measurement tracer + 1 doc edit)
- **Files modified:** 1 (`.planning/codebase/CONCERNS.md`)

## Accomplishments

- **Criterion 0 (lint green, no unrecorded relaxations) MET.** `npm run lint` exits 0. `useBotGame.ts`/`workerPool.ts` have zero entries anywhere in `frontend/eslint.config.js`. Exactly 3 entries remain for `Analysis.tsx`/`Openings.tsx` (2 for `Analysis.tsx`: `complexity` + `max-statements`; 1 for `Openings.tsx`: `complexity`), each carrying a residual comment whose numbers match this SUMMARY and the owning plan's SUMMARY.
- **Criterion 1 (size/complexity/depth) MET under the 2026-09-04 relaxation.** The enforced-rule command (`complexity`/`max-depth`/`max-statements` at `error`, `--no-inline-config`), scoped to exactly the four in-scope files plus all 27 files this phase created, prints nothing but the two recorded page-component residuals: `Analysis` complexity 132 / statements 152, `OpeningsPage` complexity 48. No function in `useBotGame.ts`, `workerPool.ts`, or any of their sibling files breaches any of the three rules. The complete 100-to-200-counted-line survivor listing (10 functions) and the over-200 reasoned-exemption listing (4 functions) are both recorded below.
- **Criterion 2 (full gates, additions-only, unchanged react-hooks) MET.** Frontend: `lint`/`build`/`knip`/`test` all green — 3894/3894 tests, 251/251 files (the documented `Train.guestGate.test.tsx` flake did not reproduce this run). Backend: `ruff format --check`/`ruff check`/`ty check` (app+analysis)/`pytest -n auto -x -q` all green — 4499 passed, 19 skipped (scoped away from an unrelated concurrent commit, see Decisions below). Aggregate test diff over the phase: 0 deletions on every row (394 lines added across 3 test files: `useBotGame.test.ts` +130, `Analysis.test.tsx` +23, `Openings.render.test.tsx` +241 new). App-wide `react-hooks/exhaustive-deps` (27) + `react-hooks/refs` (3) = **30**, unchanged from 215-01's own corrected baseline (not the plan-text's stale 28). Zero new `@ts-ignore`/`@ts-expect-error`.
- **Criterion 3 (inventories identical, no new suppressions) MET.** Per-file `data-testid`/`data-umami-event` union inventories for `Analysis.tsx` (+ its 10 phase-created siblings) and `Openings.tsx` (+ its 6 phase-created siblings, template-literal-expanded) are byte-identical to the phase base commit. `useBotGame.ts`/`workerPool.ts` families: 0 of each, confirmed. Suppression-comment total across `Analysis.tsx` + `src/hooks/analysis/`: **6**, matching the pre-phase count in `Analysis.tsx` alone. Zero new TypeScript suppressions anywhere in `frontend/src/`. `git diff --stat` lists exactly the 27 new files the six plans' own "Artifacts this plan produces" sections declare, plus the 10 expected modified files (4 in-scope source files, 3 test files, `eslint.config.js`, `package.json`/`package-lock.json`, both `CLAUDE.md` files).
- **Criterion 4 (HUMAN-UAT) MET.** Both `215-06-SUMMARY.md` (Analysis) and `215-07-SUMMARY.md` (Openings) HUMAN-UAT records collected into one table below — both approved by the user at desktop and mobile widths, all six checklist items each.
- **Criterion 5 (CONCERNS.md narrowed) MET.** The "Large God files" entry now names only the six next-tier files (`TrainReveal.tsx`, `EvalChart.tsx`, `LibraryGameCard.tsx`, `TrainSolveScreen.tsx`, `VariationTree.tsx`, `App.tsx`) with current `wc -l` line counts (unchanged from the ROADMAP's own out-of-scope measurement), points its Fix approach at the now-live eslint gate and the Phase 215 baseline override region, and appends a Phase 215 history line alongside the existing Phase 214 line. No neighbouring concern touched (`git diff` shows a single hunk).

## Task Commits

1. **Task 1: Measure the phase-wide after-baseline against all six success criteria** — measurement only, no file modified, no commit (per the task's own `<files>` declaration)
2. **Task 2: Narrow the CONCERNS.md "Large God files" entry to the next tier** — `c6b64e148` (docs)

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `.planning/codebase/CONCERNS.md` — "Large God files" entry rewritten: Issue/Files/Fix-approach updated, History line appended for Phase 215

## Criterion 0/1 — Eslint Rule Before/After Tables

**App-wide `.ts`/`.tsx` residue** (`npx eslint --no-inline-config --rule '<rule>: ["warn", N]' -f json .`, excluding `frontend/public/`):

| Rule | 215-01 baseline (breaches/files) | This plan (breaches/files) | Delta |
|---|---|---|---|
| `complexity > 15` | 69 / 52 | 64 / 52 | -5 breaches, 0 file-count change (Analysis.tsx and Openings.tsx still breach — just at lower numbers — so they stay counted; the 5 fixed breaches are the individually-named arrow functions listed below) |
| `max-depth > 4` | 6 / 1 | 6 / 1 | unchanged (a test file, `reminderSlotState.test.ts`, out of Phase 215 scope) |
| `max-statements > 100` | 1 / 1 | 1 / 1 | unchanged (still only `Analysis.tsx`, now at 152 not 213) |
| `max-lines-per-function > 200` (report-only) | 66 / 62 | 66 / 62 | unchanged in total: `workerPool.ts` dropped out (createWorkerPool now 99 lines) while `useAnalysisGemMarkers.ts` (a new phase-created file) entered at 204 lines — net zero |

**Per in-scope-file complexity/statements/max-depth** (`npx eslint --no-inline-config --rule 'complexity: ["warn",15]' --rule 'max-depth: ["warn",4]' --rule 'max-statements: ["warn",100]' <file>`):

| File | Complexity before → after | Statements before → after | max-depth |
|---|---|---|---|
| `Analysis.tsx` (`Analysis()`) | 176 → **132** | 213 → **152** | 0 breaches, unchanged |
| `Openings.tsx` (`OpeningsPage()`) | 64 → **48** | never breached (100) | 0 breaches, unchanged |
| `useBotGame.ts` (`useBotGame()`) | 14 (never breached 15) | never breached | 0 breaches, unchanged |
| `workerPool.ts` (`createWorkerPool()`) | 14 (never breached 15) | never breached | 0 breaches, unchanged |

**Five originally-flagged arrow/component-level complexity breaches inside `Analysis.tsx`** (all now fixed, per 215-04/05/06's own tracking):

| Function | Baseline complexity | Status |
|---|---|---|
| `qualityBySanWithGem` | 16 | Fixed (215-04, `resolveStoredTierShortCircuit`) |
| gem-sweep `useEffect` | 19 | Fixed (215-05, `resolveGemDetailForNode`) |
| `moveListMarkers` | 27 | Fixed (215-05, three named helpers) |
| `boardSquareMarkers` | 18 | Fixed (215-05, three named helpers) |
| `playerBar` | 19 | Fixed (215-06, two per-source resolvers) |

**Enforced-rule command, scoped to exactly the four in-scope files plus all 27 files created by this phase** (baseline defeated via CLI `--rule` override, `--no-inline-config`):

```
Analysis.tsx:421:16   error  Function 'Analysis' has too many statements (152)
Analysis.tsx:421:16   error  Function 'Analysis' has a complexity of 132
Openings.tsx:86:8     error  Function 'OpeningsPage' has a complexity of 48
```

No other finding. Both are the recorded page-component residuals under the 2026-09-04 SC-0/SC-1 relaxation (ROADMAP Phase 215, commit `5687e41c7`).

**Plan-script imprecision (not a phase finding):** the plan's own literal verify command sweeps entire directories (`src/components/analysis/`, `src/pages/openings/`) rather than only the phase's own files. Run unscoped, it additionally surfaces two PRE-EXISTING, out-of-scope findings that predate this phase: `VariationTree.tsx` (`MoveListMarker` complexity 16, `FlawChip` complexity 17, one arrow complexity 24) and `StatsTab.tsx` (complexity 25 + 18, last touched Phase 111, `f1a51d27a`, per 215-07's own note). Both files were part of 215-01's original 52-file app-wide baseline sweep, neither was touched by any Phase 215 plan, and both are explicitly named in ROADMAP's "next tier" out-of-scope list. Scoped to only the in-scope files and phase-created files (the table above), the command is clean.

## Criterion 0b — Cognitive Complexity (`npm run lint:cognitive`, report-only)

| Point | App-wide breaches / files |
|---|---|
| 215-01 baseline | 42 / 35 |
| This plan | 40 / 36 |

Per in-scope file:

| File | 215-01 baseline | This plan |
|---|---|---|
| `Analysis.tsx` | 4 (lines 549, 1640, 1782, 2390) | 1 (`Analysis` itself) |
| `useBotGame.ts` | 0 | 0 |
| `workerPool.ts` | 1 (`handleLine`) | 0 (moved verbatim to `workerPoolDispatch.ts`, see below) |
| `Openings.tsx` | 1 (line 114) | 1 (`OpeningsPage` itself, complexity 25) |

Surviving breaches in phase-created sibling files (moved verbatim from the baselined original, unchanged complexity number, not new debt):

| File | Breach |
|---|---|
| `workerPoolDispatch.ts` | `handleLine`, cognitive 16 (215-02: moved verbatim, unchanged) |
| `hooks/analysis/useAnalysisGemMarkers.ts` | `flawMarkerByNodeId`, cognitive 16 (215-05: moved verbatim, unchanged) |

`FlawChessEngineLines.tsx` (1 breach) is pre-existing, unrelated, last touched in commit `31264f6f5` (a 2026-07 quick task), not part of Phase 215.

## Criterion 1 — 100-to-200-Counted-Line Survivor Listing

`npx eslint --no-inline-config --rule 'max-lines-per-function: ["warn",{"max":100,...}]'` over the four in-scope files plus all 27 phase-created files:

| Function (file) | Counted lines | Justification |
|---|---|---|
| `useAnalysisBoardArrows` | 181 | Board-overlay derivation cluster (7 fields: `sidelineNodeColors`, `pvSidelineArrows`, `qualityHoverArrows`, `nextMoveArrow`, `engineArrows`, `boardSquareMarkers`, `lastMoveTierColor`) — one cohesive concern (215-05) |
| `useAnalysisEngineLines` | 188 | 13 grading-dependent reconciliation fields, scoped by the `unionSans`-before-`grading` data-flow ordering constraint documented in 215-04 |
| `useBotGameClock` | 109 | Fully encapsulates clock/turn-timing refs plus three effects (turn-anchor mount-init, clock-tick, hidden-tab pause) to keep `react-hooks/exhaustive-deps` at zero across the boundary (215-03) |
| `useBotGameDrawOffer` | 106 | Both draw-offer directions (user-initiated + the bot's own outgoing offer) plus the resign-hysteresis counter — one cohesive concern (215-03) |
| `useBotGameEngineDispatch` | 173 | Bot-engine dispatch cluster: the D-16 honest-clock `runBotTurn` dispatcher plus all 3 `Sentry.captureException` sites (215-03) |
| `useBotGameMoves` | 148 | The move-commit path (`updateViewedPly`/`commitMove`/`attemptMove`/`viewPly`/`returnToLive`/`resign`) — one cohesive concern (215-03) |
| `OpeningsDesktopSidebar` | 181 | The entire desktop `SidebarLayout` call (filters panel, bookmarks panel, notification-dot branching owned internally) (215-07) |
| `OpeningsMobileBoardPanel` | 154 | Mobile board block (chessboard, controls, settings column, opening-name ternary, move list) — the plan's own named fallback seam, applied only where a bisection showed it was real (215-07) |
| `OpeningsMobileDrawers` | 104 | Both mobile `MobileFilterDrawer` instances (filter + bookmarks) (215-07) |
| `useOpeningsChartData` | 114 | Query-derivation cluster (`chartEnabledMap`, `boardArrows`, `chartBookmarks`, `bookmarkMetricsRequest`, `bookmarkPhaseEntryByHash`, `wdlStatsMap`) (215-07) |

## Criterion 1 — Over-200 Reasoned Exemptions

| Function (file) | Counted lines | Reasoned exemption |
|---|---|---|
| `useAnalysisGemMarkers` | 204 | 4 lines over the report-only 200 threshold; owns four cohesive sub-concerns (`flawMarkerByNodeId`, `resolveMarkerFor`, `moveListMarkers` memo, and the on-demand parent-grade resolution effect) that 215-05 kept together after an 8-field scope reduction forced by real hook-ordering deadlocks (documented in 215-05-SUMMARY.md's Decisions Made). No complexity/depth/statements/cognitive breach — the residual is line-count only. **Not enumerated in 215-05-SUMMARY.md's own per-hook table** (215-03 established a per-hook line-count table for `useBotGame`'s five siblings; 215-05 did not repeat that table for its own three) — this table closes that documentation gap. |
| `useBotGame` | 233 | 215-03's own recorded exemption: the residual is init/resume seam + refs/state, five sub-hook wiring calls (each verbose because it passes an explicit, fully-named options object per CLAUDE.md's own preference), `newGame()` (calls into all five sub-hooks' reset functions), a cross-cutting hidden-tab snapshot-write effect, and a small bot-turn-trigger effect + final return statement — none has a single-cluster home. No complexity/depth/statements/cognitive breach. |
| `Analysis` (`Analysis.tsx`) | 1264 | `max-lines-per-function` is deliberately excluded from the ENFORCED rule set (215-01's own decision) because it counts the JSX return tree, which CLAUDE.md's logic-LOC rule explicitly carves out — this raw count is not the metric that governs the page component's real logic size. The governing metrics (complexity 132, statements 152) are the recorded SC-0/SC-1 residuals above. |
| `OpeningsPage` (`Openings.tsx`) | 667 | Same rationale as `Analysis` — `max-lines-per-function` is report-only; the governing residual (complexity 48, statements never breached) is the SC-0/SC-1-relevant number. |

## Criterion 2 — Full Gates

**Frontend** (`cd frontend`): `npm run lint` (0), `npm run build` (tsc -b + vite, 0 errors), `npm run knip` (0 findings), `npm test -- --run` (**3894 passed, 251 files passed** — the documented pre-existing `Train.guestGate.test.tsx` flake did not reproduce this run).

**Backend**: `uv run ruff format --check app/ tests/ scripts/` (453 files already formatted), `uv run ty check app/ tests/ scripts/` (all checks passed), `uv run pytest -n auto -x -q` (**4499 passed, 19 skipped**).

`uv run ruff check .` and `uv run --project analysis --with ty ty check analysis/`, run unscoped, additionally report ~150-170 pre-existing errors in `analysis/tilt_study/probes/streak_curve.py`. This file was committed by a concurrent, unrelated session mid-execution-window (commit `8af6d1ce5`, "docs(tilt-study): streak-curve probes and prior-work comparison") — not part of Phase 215, not touched by any Phase 215 plan, and explicitly flagged as out of this plan's scope by this session's own execution context. Re-run scoped to `app/ tests/ scripts/` (ruff) and `analysis/` excluding `tilt_study/probes` (ty): both fully green (`All checks passed!`).

**Aggregate test diff** (`git diff --numstat a34f0e544..HEAD -- frontend/src/**/__tests__/* frontend/src/**/*.test.*`):

| File | Insertions | Deletions |
|---|---|---|
| `useBotGame.test.ts` | 130 | 0 |
| `Analysis.test.tsx` | 23 | 0 |
| `Openings.render.test.tsx` (new) | 241 | 0 |

Zero deletions on every row — additions only, matching every plan's own claim.

**App-wide `react-hooks/exhaustive-deps` + `react-hooks/refs`**: **30** (27 + 3), via the plan's own Python one-liner over `npx eslint --no-inline-config -f json .`. Matches 215-01's own directly-measured baseline exactly (215-01-SUMMARY.md: "`react-hooks/exhaustive-deps` **27**, `react-hooks/refs` **3**"), not the ROADMAP/plan-text's stale "28"/"exactly 28" — the plan text's own verify block already corrects this to 30, and 215-04/215-05/215-07 each independently re-confirmed it.

**Zero new TypeScript suppressions**: `git diff a34f0e544..HEAD -- frontend/src/ | grep -cE '^\+.*@ts-(ignore|expect-error)'` → `0`.

## Criterion 3 — Inventories and Suppressions

**Testid/umami inventories** (union comparison, phase base commit vs. now — scoped to each in-scope file plus its own phase-created siblings, since `src/components/analysis/` and `src/pages/openings/` both pre-date this phase and contain unrelated sibling components whose testids were never part of the in-scope file to begin with):

| File | testid diff | umami diff |
|---|---|---|
| `Analysis.tsx` (+ 10 phase-created siblings) | empty (byte-identical) | empty (byte-identical) |
| `Openings.tsx` (+ 6 phase-created siblings, template-literal-expanded) | empty after expanding `OpeningsFilterFields`'s `testIdSuffix` template literal (raw grep shows a spurious 8-line diff — documented by 215-07 as its own known gap) | empty (byte-identical) |
| `useBotGame.ts` family | 0 testids, 0 umami — unchanged | — |
| `workerPool.ts` family | 0 testids, 0 umami — unchanged | — |

**Suppression-comment total** (`grep -c eslint-disable src/pages/Analysis.tsx src/hooks/analysis/*.ts`, summed): **6** — matches the pre-phase count in `Analysis.tsx` alone (5 moved into `useAnalysisRouteSeeding.ts`, 1 remains in `Analysis.tsx` at the Import-tab paste-handoff effect).

**New files vs. declared artifacts**: `git diff --name-status a34f0e544..HEAD -- frontend/ | grep '^A'` returns exactly 27 files — the full union of every plan's own "Artifacts this plan produces" section (1 from 215-01, 4 from 215-02, 5 from 215-03, 3 from 215-04, 3 from 215-05, 4 from 215-06, 7 from 215-07). Modified files: the four in-scope source files, 3 test files (`useBotGame.test.ts`, `Analysis.test.tsx`, plus `Openings.render.test.tsx` counted above as new), `eslint.config.js`, `package.json`/`package-lock.json`, root `CLAUDE.md` and `frontend/CLAUDE.md` (both from 215-01's documentation task) — no unexpected file appears.

## Criterion 4 — HUMAN-UAT (collected from 215-06 and 215-07)

| Page | Outcome | Viewport widths | Checklist |
|---|---|---|---|
| **Analysis** (215-06) | Approved by the user, all 6 items | Desktop and mobile (specific pixel breakpoints not recorded in 215-06-SUMMARY.md — only qualitative desktop/mobile) | 1. Library-game mode (board, player bars, move list, variation tree, eval bars/chart, engine lines) — confirmed. 2. Paste mode (modal open/close, pasted game load, pasted headers) — confirmed. 3. Tactic mode (overlay renders, focused line highlighted) — confirmed. 4. Gem markers on board and move list, **including opponent moves** — confirmed, no regression (`best_move_tier` is intentionally position-scoped). 5. All analysis tabs open and render — confirmed. 6. Mobile specifics (mobile engine-lines block, mobile board layout) — confirmed. |
| **Openings** (215-07) | Approved by the user, all 6 items | Desktop and mobile (specific pixel breakpoints not recorded in 215-07-SUMMARY.md — only qualitative desktop/mobile) | 1. Desktop sidebar opens/closes, `FilterPanel` renders every filter, Apply commits — confirmed. 2. Mobile filter drawer, same filters, Apply commits — confirmed. 3. Bookmarks drawer opens, lists, loads a bookmark — confirmed. 4. **Filter parity**: desktop sidebar and mobile drawer produce the same result set — explicitly confirmed (the highest-risk item, exactly the duplication `OpeningsFilterFields` consolidated). 5. All four tabs (Explorer, Games, Insights, Stats) open and render — confirmed. 6. Nothing vanished behind a breakpoint at either width — confirmed. |

Neither record is missing or reports a failure — Criterion 4 is fully met.

## Decisions Made

See `key-decisions` in the frontmatter above for the full list. Summary:

1. **The plan's own directory-level verify command over-collects pre-existing, out-of-scope findings.** Re-scoped to exactly the phase's own files and confirmed clean — documented as a plan-script imprecision, not a phase finding, so a future reader doesn't mistake `VariationTree.tsx`/`StatsTab.tsx` findings for a Phase 215 regression.
2. **The backend pre-merge gate's unscoped ruff/ty commands catch an unrelated concurrent session's own commit.** Re-scoped away from `analysis/tilt_study/probes/` (committed by a different session during this plan's own execution window) and confirmed the actual gate for `app/`/`tests/`/`scripts/`/`analysis/` (Phase 215's real footprint) is fully green.
3. **`useAnalysisGemMarkers`'s 204-line residual gets a written exemption here**, closing a documentation gap 215-05 left open (it measured the hook's FILE size but never its own function's counted-line count against the report-only 200 target, unlike 215-03's explicit per-sibling-hook table).

## Deviations from Plan

None — plan executed exactly as written. All two documented "plan-script imprecision" findings above are measurement corrections applied within Task 1's own "measure, do not fix" mandate (re-running a command with a corrected scope is still measurement, not a code change), not deviations from the plan's instructions. No frontend or backend source file was modified by this plan.

## Issues Encountered

None beyond the two scoping corrections documented above (both resolved by re-running the same measurement command with a corrected file scope, not by touching any code).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Phase 215 is complete: all eight plans (215-01 through 215-08) have SUMMARYs, all six ROADMAP success criteria are measured and recorded with commands and numbers, and `CONCERNS.md`'s "Large God files" entry now names only the next tier. The phase branch `gsd/phase-215-frontend-god-file-decomposition` is ready for the full pre-merge gate (already green, per this SUMMARY) and squash-merge to `main`, followed by a `CHANGELOG.md` entry under `## [Unreleased]` per the project's git workflow.

No blockers. The next-tier frontend files (`TrainReveal.tsx`, `EvalChart.tsx`, `LibraryGameCard.tsx`, `TrainSolveScreen.tsx`, `VariationTree.tsx`, `App.tsx`) remain open debt, now baselined and gated against further growth, per CONCERNS.md.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-04*

## Self-Check: PASSED

- FOUND: `.planning/codebase/CONCERNS.md` (modified, confirmed via `git diff --stat`)
- FOUND commit `c6b64e148` (Task 2)
- Re-ran `npm run lint`: exit 0
- Re-ran the scoped enforced-rule command: only the two recorded page-component residuals
- Re-ran `git diff --stat -- .planning/codebase/CONCERNS.md`: single file, 4 insertions/4 deletions
- Re-ran the four CONCERNS.md acceptance-criteria greps: all pass (0, 1, 3, clean diff)
