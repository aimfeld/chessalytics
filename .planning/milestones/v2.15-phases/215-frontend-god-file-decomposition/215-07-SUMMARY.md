---
phase: 215-frontend-god-file-decomposition
plan: 07
subsystem: ui
tags: [react, refactor, complexity, openings-page, eslint, mutation-testing, human-uat]

requires:
  - phase: 215-frontend-god-file-decomposition (plan 01)
    provides: "eslint.config.js complexity/max-depth/max-statements gate at error level, with a Phase 215 baseline override region listing pre-existing breaches (Openings.tsx at cyclomatic 64 among them)"
  - phase: 215-frontend-god-file-decomposition (plan 06)
    provides: "SC-0/SC-1 relaxed for page components (commit 5687e41c7, SEED-160): a residual complexity number with a bisection-backed justification satisfies SC-0/SC-1, rather than requiring a full drop to 15"
provides:
  - "OpeningsPage()'s first render-level characterization test (Openings.render.test.tsx, 7 tests), written and green BEFORE any markup moved — the page previously had ZERO render coverage"
  - "Desktop sidebar and mobile filter-drawer duplication consolidated behind one shared OpeningsFilterFields component (testIdSuffix prop), both testid sets intact"
  - "OpeningsDesktopSidebar.tsx, OpeningsMobileDrawers.tsx, useOpeningsChartData.ts, OpeningsMobileBoardPanel.tsx, ChessboardInfoCopy.tsx extracted under src/pages/openings/; OpeningsPage() reduced from cyclomatic 64 to 48 (complexity), 1088 to 667 lines"
  - "SC-0/SC-1 for Openings.tsx MET under the 2026-09-04 relaxed criteria: baseline entry kept with a measured, bisection-backed residual comment (48, not deleted); npm run lint stays green"
  - "HUMAN-UAT smoke of the Openings page approved by the user at desktop and mobile widths, all six checklist items including filter parity between the desktop sidebar and the mobile drawer"
affects: [215-08]

actuals:
  tokens: 22900
  tasks: 4
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Shared-fragment extraction with a suffix prop: OpeningsFilterFields takes testIdSuffix: '' | '-sidebar' so one component serves two call sites (desktop panel, mobile drawer) while both DOM-contract testid sets survive as distinct, simultaneously-mountable nodes — the pattern this plan's own PATTERNS.md named in advance rather than discovering during the split."
    - "Extracted components own their own notification-dot / conditional branching internally (OpeningsDesktopSidebar computes filtersNotificationDot/bookmarksNotificationDot from raw hint/pulse booleans) rather than taking a caller-pre-resolved ReactNode — same seam 215-04/215-05/215-06 used on Analysis.tsx, applied here to a second page."
    - "Bisection measurement (blank a JSX region wholesale, re-measure, restore) as the evidence base for both the residual eslint comment and the SUMMARY, not inspection alone — second use of the method 215-06 introduced. Task 3's bisection blanked the entire post-panel-extraction JSX return and found 35 of 55 points live in flat pre-return `&&`/`?:` derivations no plan seam names."
    - "Render-level characterization test written and run green BEFORE the first line of markup moved (Task 1's own gate), following the plan's must_haves rather than writing the test after the fact — the ROADMAP's explicit requirement for this specific file since it had zero prior render coverage."

key-files:
  created:
    - frontend/src/pages/__tests__/Openings.render.test.tsx
    - frontend/src/pages/openings/OpeningsFilterFields.tsx
    - frontend/src/pages/openings/OpeningsDesktopSidebar.tsx
    - frontend/src/pages/openings/OpeningsMobileDrawers.tsx
    - frontend/src/pages/openings/useOpeningsChartData.ts
    - frontend/src/pages/openings/OpeningsMobileBoardPanel.tsx
    - frontend/src/pages/openings/ChessboardInfoCopy.tsx
  modified:
    - frontend/src/pages/Openings.tsx
    - frontend/eslint.config.js

key-decisions:
  - "SC-0 and SC-1 for Openings.tsx ARE MET, under the 2026-09-04 relaxed criteria (commit 5687e41c7, which landed BEFORE this plan executed — unlike 215-06, which completed under the original strict wording). The baseline override entry stays in eslint.config.js, but with a reasoned residual comment (same shape as the Analysis.tsx entry) recording the measured before/after complexity (64 -> 48) and the bisection evidence for why the remainder is not a cohesive extractable cluster. npm run lint exits 0 with the entry present."
  - "Task 3's own bisection (blank the entire post-extraction JSX return, re-measure) found OpeningsPage still scored 35 of its pre-mobile-panel 55 points with ZERO JSX rendered — meaning 35 points live in flat `&&`/`?:` derivations computed BEFORE the return (mobileFiltersDot, the showXxxHint booleans, needsRedirect/needsLegacyRedirect, pieceFilterLabel, the chained activeTab ternary). None of these is named as an extraction target by this plan; per the plan's own prohibition against reaching the number by wrapping unrelated derivations in arrow functions, they were left in place and the residual was recorded instead."
  - "Of the remaining ~20 JSX-return points (after the 35 pre-return points), only ~1 point was attributable to the already-extracted desktop board+tab-content region — real complexity there had already been absorbed by OpeningsDesktopSidebar/OpeningsMobileDrawers in Task 2 — so it was left inline. ~7 points were attributable to the mobile board block, which was extracted as OpeningsMobileBoardPanel.tsx (the plan's own named fallback seam, 'a desktop and a mobile layout component,' applied only where the bisection showed it was real)."
  - "OpeningsMobileBoardPanel.tsx needed a sibling ChessboardInfoCopy.tsx (the chessboard info-popover body) so both the still-inline desktop board block and the new mobile board panel could share the copy without a circular import between Openings.tsx and the new mobile-panel file — a small, plan-adjacent extraction not named in the plan's file list but required by the named mobile-panel seam itself."
  - "The plan's own verify-command grep for `data-testid=\"[^\"]*\"` cannot see testids built via the testIdSuffix template literal (`` `filter-piece-filter${testIdSuffix}` ``); Task 1's commit documents a corrected script that also expands the template's two resolved values, confirming the true union is byte-identical to the phase-base capture. Recorded once here so 215-08 does not re-flag the raw grep's 8-line diff as a regression."
  - "The app-wide react-hooks/exhaustive-deps + react-hooks/refs count is 30, not the 28 the plan text quotes — matching 215-04/215-05's already-corrected baseline (the plan's 28 predates that correction). Not a regression; the invariant held before and after this plan's edits."
  - "The known Train.guestGate.test.tsx timeout flake (project memory: Vitest 5s testTimeout vs. testing-library 1000ms waitFor ceilings) appeared once during this plan's full-suite verification run and is unrelated to Openings.tsx or src/pages/openings/; re-run in isolation passed 6/6. Not treated as a plan defect."

requirements-completed: [SC-0, SC-1, SC-2, SC-3, SC-4]

coverage:
  - id: D1
    description: "Openings.render.test.tsx created as the page's first render-level oracle (7 tests), written and passing BEFORE any markup moved; OpeningsFilterFields.tsx created and consumed at both the desktop and mobile call sites, both testid sets (`filter-piece-filter*` and `filter-piece-filter*-sidebar`) intact"
    requirement: "SC-2, SC-3"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Openings.render.test.tsx src/pages/__tests__/Openings.statsBoard.test.tsx (23 passed, independently re-run)"
        status: pass
      - kind: other
        ref: "cd frontend && diff <(grep -oh 'data-testid=\"[^\"]*\"' src/pages/Openings.tsx src/pages/openings/*.tsx | sort) /tmp/openings-testid-union-before.txt (empty, per task-1 commit's corrected/expanded script)"
        status: pass
    human_judgment: false
  - id: D2
    description: "OpeningsDesktopSidebar.tsx and OpeningsMobileDrawers.tsx extracted; both MobileFilterDrawer instances moved out of Openings.tsx; no handler moved into or out of useOpeningsHandlers.ts; OpeningsPage() complexity 64 -> 55"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Openings.render.test.tsx src/pages/__tests__/Openings.statsBoard.test.tsx (23 passed, independently re-run)"
        status: pass
      - kind: other
        ref: "cd frontend && git diff -- src/pages/openings/useOpeningsHandlers.ts (empty, independently confirmed); grep -c 'MobileFilterDrawer' src/pages/Openings.tsx (0, independently confirmed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "useOpeningsChartData.ts, OpeningsMobileBoardPanel.tsx and ChessboardInfoCopy.tsx extracted; OpeningsPage() complexity 55 -> 48 (final); SC-0/SC-1 MET under the relaxed criteria with a bisection-backed residual comment; three two-way mutation proofs against OpeningsFilterFields, OpeningsDesktopSidebar and OpeningsMobileDrawers; union testid inventory byte-identical; react-hooks count unchanged at 30; full suite, lint, build, knip all green"
    requirement: "SC-0, SC-1"
    verification:
      - kind: unit
        ref: "cd frontend && npx vitest run src/pages/__tests__/Openings.render.test.tsx src/pages/__tests__/Openings.statsBoard.test.tsx (23 passed); npm test -- --run (3893/3894 passed — 1 unrelated pre-existing flake in Train.guestGate.test.tsx, re-run in isolation: 6/6 passed)"
        status: pass
      - kind: other
        ref: "cd frontend && npx eslint --no-inline-config --rule 'complexity: [\"error\", 15]' --rule 'max-depth: [\"error\", 4]' --rule 'max-statements: [\"error\", 100]' src/pages/Openings.tsx src/pages/openings/ (exactly 3 findings: OpeningsPage 48, StatsTab.tsx pre-existing 25 + 18, both out of scope — independently re-run); npm run lint && npm run build && npm run knip (all green, independently re-run)"
        status: pass
      - kind: unit
        ref: "Mutation proofs (independently re-run this session): OpeningsFilterFields forced to render null -> 3/7 render tests fail; OpeningsDesktopSidebar forced to render null -> 4/7 fail; OpeningsMobileDrawers forced to render null -> 3/7 fail. All three restored to 7/7 green."
        status: pass
    human_judgment: false
  - id: D4
    description: "HUMAN-UAT smoke of the Openings page: desktop sidebar, mobile filter drawer, bookmarks drawer, filter parity between desktop and mobile, all four tabs, and a check that nothing vanished — at desktop AND mobile widths"
    requirement: "SC-4"
    verification:
      - kind: manual_procedural
        ref: "User approved all six checklist items at desktop and mobile widths"
        status: pass
    human_judgment: true
    rationale: "Visual/layout regression and cross-surface filter-result parity (desktop sidebar vs. mobile drawer producing the same result set) cannot be proven by the automated test suite or a DOM-contract diff; this is exactly the class of check the plan's own checkpoint exists for, matching 215-06's D4 rationale for Analysis.tsx."

duration: 40min
completed: 2026-09-04
status: complete
---

# Phase 215 Plan 07: Openings.tsx Render Characterization + God-File Decomposition Summary

**`OpeningsPage()`'s desktop sidebar and mobile filter-drawer duplication consolidated behind one shared `OpeningsFilterFields` component, the page's first render-level characterization test added, and four more components/hooks extracted under `src/pages/openings/`, taking the page from cyclomatic 64 to 48 (SC-0/SC-1 met under the 2026-09-04 relaxed criteria with a bisection-backed residual) — HUMAN-UAT approved at desktop and mobile widths.**

## Performance

- **Duration:** ~31 min for Tasks 1-3 (10:28:56 -> 10:59:30, per task commit timestamps); Task 4's checkpoint and this SUMMARY were completed in a separate session after user approval, ~9 min of verification/authoring — combined ~40 min.
- **Tasks:** 4 (3 code tasks + 1 HUMAN-UAT checkpoint)
- **Files modified:** 9 (7 created, 2 modified)

## Accomplishments

- `Openings.render.test.tsx` created (Task 1): the page's first render-level oracle (7 tests), mounting `OpeningsPage` in the `Analysis.test.tsx` provider stack (`MemoryRouter` + `QueryClientProvider` + `TooltipProvider`), mocking ~7 data hooks plus `apiClient` with a single generic response. Written and green BEFORE any markup moved. Asserts the desktop sidebar's piece-filter testids and `FilterPanel`, the mobile filter drawer's `-sidebar`-suffixed testids, the bookmarks drawer, both tab strips, and that the two piece-filter testid sets coexist as distinct DOM nodes.
- `OpeningsFilterFields.tsx` created (Task 1): shares the `ToggleGroup` piece-filter block plus `<FilterPanel>` that was previously duplicated verbatim at the desktop and mobile call sites, parameterized by `testIdSuffix: '' | '-sidebar'`. Both testid sets survive as distinct, simultaneously-mountable DOM nodes (verified directly by the render test's 6th assertion).
- `OpeningsDesktopSidebar.tsx` and `OpeningsMobileDrawers.tsx` created (Task 2): the entire desktop `SidebarLayout` call (filters panel, bookmarks panel, notification-dot branching now owned internally) and both `MobileFilterDrawer` instances (filter + bookmarks), respectively. No handler moved into or out of `useOpeningsHandlers.ts` (`git diff` empty, independently re-confirmed). No third `<FilterPanel>` call site found. `OpeningsPage()` complexity: 64 -> 55.
- `useOpeningsChartData.ts`, `OpeningsMobileBoardPanel.tsx` and `ChessboardInfoCopy.tsx` created (Task 3): the query-derivation cluster (`chartEnabledMap` with its pre-existing `chartToggleVersion` unnecessary-dependency warning moved intact, `boardArrows`, `chartBookmarks`, `bookmarkMetricsRequest`, `bookmarkPhaseEntryByHash`, `wdlStatsMap`, plus the related query-family calls); the mobile board block (chessboard, controls, settings column, opening-name ternary, move list) as the plan's named fallback seam, applied only where a bisection showed it was real; and a small shared info-popover-copy component needed to avoid a circular import between the still-inline desktop board block and the new mobile panel. `OpeningsPage()` complexity: 55 -> 48 (final).
- SC-0/SC-1 landed under the relaxed criteria: `OpeningsPage`'s `eslint.config.js` baseline entry was KEPT (not deleted, since 48 > 15) but its comment was replaced with a reasoned residual write-up mirroring the `Analysis.tsx` entry — measured before/after (64 -> 48) plus the bisection evidence for why the remainder is not a cohesive extractable cluster. `npm run lint` exits 0.
- Three two-way mutation proofs recorded against the new oracle (independently re-run this session, see "Mutation Proofs" below): `OpeningsFilterFields`, `OpeningsDesktopSidebar`, `OpeningsMobileDrawers` — all caught, all restored green.
- Union `data-testid` inventory byte-identical across all three tasks, once the verify script is expanded for the `testIdSuffix` template literal's two resolved values (the plan's own raw `grep` cannot see template-built testids and reports a spurious 8-line diff — documented in Task 1's commit, re-confirmed this session).
- `npx vitest run src/pages/__tests__/Openings.render.test.tsx src/pages/__tests__/Openings.statsBoard.test.tsx`: 23 passed (independently re-run this session). Full suite (`npm test -- --run`): 3893/3894 passed — the 1 failure (`Train.guestGate.test.tsx`, 2 sub-failures) is the project's known timeout flake, unrelated to this plan's files, and passed 6/6 in isolation. `npm run lint`, `npm run build`, `npm run knip` all green (independently re-run).
- App-wide `react-hooks/exhaustive-deps` + `react-hooks/refs` count re-measured this session: **30**, unchanged (the plan text's "28" predates 215-04/05's baseline correction).
- `npm run lint:cognitive` for `Openings.tsx`: cognitive complexity **25** (down from the phase baseline of 35), independently re-measured this session. The two findings in `src/pages/openings/StatsTab.tsx` (complexity 25 at line 41, an arrow function at 18 at line 59) are pre-existing and out of scope — `StatsTab.tsx` was last touched in `f1a51d27a` (Phase 111, "Library UI polish"), not by this plan, confirmed via `git log`.
- **HUMAN-UAT smoke (Task 4): approved by the user at desktop and mobile widths, all six items**, including item 4 (filter parity between the desktop sidebar and the mobile drawer producing identical results) explicitly confirmed.

## Task Commits

1. **Task 1: Render characterization test + shared OpeningsFilterFields** — `e8085799e` (feat)
2. **Task 2: Extract OpeningsDesktopSidebar and OpeningsMobileDrawers** — `c51fcbf52` (feat)
3. **Task 3: Extract useOpeningsChartData + OpeningsMobileBoardPanel, land SC-0/SC-1 residual** — `491ea5b5e` (feat)
4. **Task 4: HUMAN-UAT smoke — checkpoint, no code commit** — approved by user

**Plan metadata:** this SUMMARY commit (pending)

## Files Created/Modified

- `frontend/src/pages/__tests__/Openings.render.test.tsx` (new, 241 lines) — the page's first render-level oracle: mounts `OpeningsPage`, asserts desktop sidebar, mobile drawers, both piece-filter testid sets, tab strips
- `frontend/src/pages/openings/OpeningsFilterFields.tsx` (new, 81 lines) — shared piece-filter `ToggleGroup` + `<FilterPanel>` block, `testIdSuffix: '' | '-sidebar'`
- `frontend/src/pages/openings/OpeningsDesktopSidebar.tsx` (new, 244 lines) — desktop `SidebarLayout` (filters panel, bookmarks panel, notification dots)
- `frontend/src/pages/openings/OpeningsMobileDrawers.tsx` (new, 144 lines) — both mobile `MobileFilterDrawer` instances (filter + bookmarks)
- `frontend/src/pages/openings/useOpeningsChartData.ts` (new, 203 lines) — query-derivation cluster: `chartEnabledMap`, `boardArrows`, `chartBookmarks`, `bookmarkMetricsRequest`, `bookmarkPhaseEntryByHash`, `wdlStatsMap`
- `frontend/src/pages/openings/OpeningsMobileBoardPanel.tsx` (new, 217 lines) — mobile board block (chessboard, controls, settings column, move list)
- `frontend/src/pages/openings/ChessboardInfoCopy.tsx` (new, 21 lines) — shared chessboard info-popover body, avoids a circular import between the desktop board block and the new mobile panel
- `frontend/src/pages/Openings.tsx` (modified, 1088 -> 667 lines) — `OpeningsPage` keeps its name and export; sidebar, drawers, chart-data derivation and mobile board become composition
- `frontend/eslint.config.js` (modified) — `Openings.tsx`'s baseline entry comment replaced with a reasoned residual write-up (kept, not deleted, since 48 > 15)

## Complexity Trajectory (`OpeningsPage()`, complexity / lines)

Measured via `npx eslint --no-inline-config --rule 'complexity: ["error", 15]' src/pages/Openings.tsx` at each checkpoint; the 48 figure was independently re-measured this session and matches the task-3 commit message.

| Point | Complexity | Lines (`max-lines-per-function`, report-only) |
|---|---|---|
| Phase base (215-01 baseline) | 64 | 1088 |
| After Task 1 (shared `OpeningsFilterFields`) | 64 (unchanged — see note) | — |
| After Task 2 (`OpeningsDesktopSidebar` + `OpeningsMobileDrawers`) | 55 | — |
| After Task 3, chart-data extraction only | 55 (unchanged — see note) | — |
| After Task 3, mobile board panel extraction — **final** | **48** | **667** |

Task 1 did not move `OpeningsPage`'s own complexity score: consolidating the duplicated `ToggleGroup`/`FilterPanel` markup into one shared component removed duplicated JSX but not branch-count contributors, since the underlying markup had few internal conditionals. Similarly, moving `useOpeningsChartData`'s `useMemo`/`useQuery` callback bodies into a sibling hook (Task 3, step 1) does not change `OpeningsPage`'s own score, because ESLint's `complexity` rule scores each function independently — the callback bodies' branches were already scored against their own closures, not against `OpeningsPage`.

`max-lines-per-function` (report-only, per the plan's ROADMAP exclusion): 1088 -> 667, independently re-confirmed this session (`npx eslint --no-inline-config --rule 'max-lines-per-function: ["warn", {"max": 200, "skipBlankLines": true, "skipComments": true}]' src/pages/Openings.tsx` reports exactly one warning, 667 lines).

## SC-0 / SC-1 — Met Under the 2026-09-04 Relaxed Criteria

Unlike 215-06 (which completed under the pre-relaxation strict wording and recorded SC-0/SC-1 for `Analysis.tsx` as NOT reached), this plan executed entirely after the relaxation commit (`5687e41c7`, "relax SC-0/SC-1 for page components, plant SEED-160") landed. Under the relaxed wording:

- **SC-0 (relaxed):** the baseline entry may stay if it carries a comment recording the measured residual — it does not have to be deleted. `Openings.tsx`'s entry in `frontend/eslint.config.js` is KEPT with exactly that: a reasoned residual comment mirroring the `Analysis.tsx` entry above it, recording the measured before/after (64 -> 48) and the bisection evidence below. `npm run lint` exits 0 with the entry present, independently re-confirmed this session.
- **SC-1 (relaxed):** the after-number and a justification for any residual over 15 must be recorded. Both are recorded here and in the `eslint.config.js` comment.

**Both criteria are therefore MET for this file**, not merely attempted — this is the substantive difference from 215-06's `Analysis.tsx` outcome, and is worth flagging explicitly for 215-08 (phase closeout) so the two files are not conflated.

**Bisection evidence** (Task 3's own method, mirroring 215-06's use on `Analysis.tsx`; blank a JSX region wholesale, re-measure, restore): with the ENTIRE JSX return blanked at the post-panel-extraction (Task 2 end) state, `OpeningsPage` still measured 35 of its then-55 points — meaning 35 of the 55 pre-mobile-panel-extraction points live in flat `&&`/`?:` derivations computed BEFORE the return (`mobileFiltersDot`, the `showXxxHint` booleans, `needsRedirect`/`needsLegacyRedirect`, `pieceFilterLabel`, the chained `activeTab` ternary, etc.), none of which is named as an extraction target by this plan. Of the remaining ~20 JSX-return points: the already-extracted desktop board+tab-content region (now `OpeningsDesktopSidebar`'s/`OpeningsMobileDrawers`'s children) contributed only ~1 point — its real complexity had already been absorbed by the Task 2 extraction — so it was correctly left inline rather than split purely to fit a signature; the mobile board block contributed ~7 points and was extracted as `OpeningsMobileBoardPanel.tsx`, the plan's own named fallback seam, applied only because the bisection showed it was real.

**Why the remaining 48 points are not further split:** reaching the pre-return 35 points safely would require the same hook-ordering analysis 215-04/215-05/215-06 applied to their own named clusters, extended across many more small derived-value expressions no plan (including this one) scoped. This plan's own text explicitly prohibits reaching the number by "wrapping a fragment in an arrow function called from the same place" — exactly what inventing hooks for unrelated `&&`/`?:` derivations would amount to. Per the plan's own "capture as a seed, do not implement" instruction, this is out of scope here.

## Mutation Proofs (Task 3, step 4 — independently re-run this session)

All three mutations below were re-executed this session (not merely re-stated from the task-3 commit message, which deferred the details to this SUMMARY): each component's return was forced to `null`, the render test suite was re-run, the failing assertions recorded, and the component restored with `git diff` confirmed empty before moving to the next.

| Component | Mutation | Result (of 7 render tests) | Restored result |
|---|---|---|---|
| `OpeningsFilterFields` | Body replaced to render `null` | **3 failed**: "desktop sidebar filters panel renders...", "mobile filter drawer renders the -sidebar-suffixed...", "desktop and mobile piece-filter testid sets are simultaneously distinct DOM nodes" | 7/7 passed |
| `OpeningsDesktopSidebar` | Body replaced to render `null` | **4 failed**: "desktop sidebar filters panel renders...", "desktop sidebar bookmarks panel renders...", "desktop and mobile piece-filter testid sets are simultaneously distinct DOM nodes", "closing the desktop filters panel unmounts its content..." | 7/7 passed |
| `OpeningsMobileDrawers` | Body replaced to render `null` | **3 failed**: "mobile filter drawer renders the -sidebar-suffixed...", "mobile bookmarks drawer renders", "desktop and mobile piece-filter testid sets are simultaneously distinct DOM nodes" | 7/7 passed |

No mutation left the test suite green — the new oracle genuinely guards the extracted sidebar, drawers and shared filter fields, not merely their existence. `git status --short` under `frontend/` was clean after each restore.

## HUMAN-UAT Smoke (Task 4)

**Outcome: approved by the user at desktop and mobile widths, all six items.**

1. Desktop sidebar: opens/closes, `FilterPanel` renders every filter, piece-filter toggle works, Apply commits and results update — confirmed.
2. Mobile filter drawer: opens/closes, same filters, piece-filter toggle works, Apply commits and results update — confirmed.
3. Bookmarks drawer: opens, lists bookmarks, loading a bookmark navigates to it, chart toggle and match-side controls still work — confirmed.
4. **Filter parity**: a change made in the desktop sidebar and the same change made in the mobile drawer produce the same result set — explicitly confirmed. This was the highest-risk item, since it is exactly the duplication `OpeningsFilterFields` consolidated.
5. Tabs: Explorer, Games, Insights and Stats all open and render, board renders in the layouts that show it — confirmed.
6. Nothing vanished: no control visible before the split disappeared behind a breakpoint at either width — confirmed.

The checkpoint resolved with a plain "approved" from the user, confirming all six items at both widths.

## Decisions Made

See `key-decisions` in the frontmatter above for the full list. The two most consequential:

1. **SC-0/SC-1 are MET for `Openings.tsx`** under the 2026-09-04 relaxed criteria (unlike `Analysis.tsx` in 215-06, which completed before the relaxation and recorded them as NOT reached) — the baseline entry stays with a bisection-backed residual comment rather than being deleted, and that satisfies the relaxed wording as written.
2. **`OpeningsMobileBoardPanel.tsx` needed a small sibling extraction (`ChessboardInfoCopy.tsx`)** not named in the plan's file list, to avoid a circular import between the still-inline desktop board block and the new mobile panel file — a plan-adjacent necessity of the named mobile-panel seam, not scope creep.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `ChessboardInfoCopy.tsx` extracted to unblock the named `OpeningsMobileBoardPanel` seam**
- **Found during:** Task 3 (mobile board panel extraction)
- **Issue:** The chessboard info-popover body was needed by both the still-inline desktop board block and the new `OpeningsMobileBoardPanel.tsx`; importing it directly from `Openings.tsx` into the new panel file would create a circular import (the panel file is itself imported by `Openings.tsx`).
- **Fix:** Extracted the shared copy into its own file, `ChessboardInfoCopy.tsx`, importable by both consumers without a cycle.
- **Files modified:** `frontend/src/pages/openings/ChessboardInfoCopy.tsx` (new), `frontend/src/pages/Openings.tsx`, `frontend/src/pages/openings/OpeningsMobileBoardPanel.tsx`
- **Verification:** `npm run build` (tsc -b) green, no circular-import warning from Vite/knip.
- **Committed in:** `491ea5b5e` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — small extraction required by a plan-named seam, not new scope)
**Impact on plan:** No scope creep; the extraction exists solely to let the plan's own named `OpeningsMobileBoardPanel` seam compile without a cycle.

## Issues Encountered

- **Plan's raw `grep` testid-diff command reports a spurious 8-line diff** once `OpeningsFilterFields` uses a `testIdSuffix` template literal — the plan's own verify command (`grep -oh 'data-testid="[^"]*"'`) matches literal strings only and cannot see the two values a template resolves to. Task 1's commit message documents and applies a corrected/expanded script; the true union inventory is byte-identical to the phase-base capture. Documented here so 215-08 does not re-flag it.
- **`Train.guestGate.test.tsx` timeout flake** appeared once in the full-suite run during this session's independent verification (2 sub-test failures, 5000ms Vitest timeout). Re-run in isolation: 6/6 passed. This is the project's known heavy-frontend-test timeout flake (Vitest 5s testTimeout vs. testing-library's 1000ms `waitFor` ceiling), unrelated to `Openings.tsx` or `src/pages/openings/`, and out of this plan's scope per the executor's scope-boundary rule.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

`Openings.tsx` now has a real render-level oracle for the first time and joins `Analysis.tsx` with five extracted siblings under `src/pages/openings/` (three from earlier phases — `useOpeningsHandlers`, `useSidebarState`, `useDeepLinkHighlight`, `useTabReset` plus the four tab components — and five new from this plan). `OpeningsPage()` itself is at complexity 48 against the enforced limit of 15, but **SC-0 and SC-1 for this file ARE MET** under the relaxed criteria (residual recorded, baseline entry annotated, lint green) — unlike `Analysis.tsx`, which remains open per 215-06. 215-08 (phase-wide closeout) should carry forward: the app-wide react-hooks count (30, unchanged), this file's SC-0/SC-1 MET status (contrast with `Analysis.tsx`'s NOT-reached status), and the two pre-existing/out-of-scope `StatsTab.tsx` cognitive-complexity findings (untouched, last modified in Phase 111).

No blockers for 215-08 from this plan's own work; the split is complete and HUMAN-UAT-approved.

---
*Phase: 215-frontend-god-file-decomposition*
*Completed: 2026-09-04*

## Self-Check: PASSED

- FOUND: `frontend/src/pages/__tests__/Openings.render.test.tsx`
- FOUND: `frontend/src/pages/openings/OpeningsFilterFields.tsx`
- FOUND: `frontend/src/pages/openings/OpeningsDesktopSidebar.tsx`
- FOUND: `frontend/src/pages/openings/OpeningsMobileDrawers.tsx`
- FOUND: `frontend/src/pages/openings/useOpeningsChartData.ts`
- FOUND: `frontend/src/pages/openings/OpeningsMobileBoardPanel.tsx`
- FOUND: `frontend/src/pages/openings/ChessboardInfoCopy.tsx`
- FOUND commit `e8085799e` (Task 1)
- FOUND commit `c51fcbf52` (Task 2)
- FOUND commit `491ea5b5e` (Task 3)
- Re-ran `npx eslint --no-inline-config --rule 'complexity: ["error", 15]' src/pages/Openings.tsx`: confirms 48, matches this SUMMARY
- Re-ran the enforced complexity/max-depth/max-statements command over `src/pages/Openings.tsx src/pages/openings/`: confirms exactly 3 findings (`OpeningsPage` 48, `StatsTab` 25 at line 41, an arrow at line 59 with 18), matches this SUMMARY
- Re-ran the three mutation proofs (all confirmed caught, all restored 7/7 green)
- Confirmed `npm run lint`, `npm run build`, `npm run knip` all green
- Confirmed working tree under `frontend/` is clean (no uncommitted changes) after every restore
