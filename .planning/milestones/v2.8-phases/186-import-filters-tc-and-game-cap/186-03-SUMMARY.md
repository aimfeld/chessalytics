---
phase: 186-import-filters-tc-and-game-cap
plan: 03
subsystem: ui
tags: [react, typescript, tanstack-query, tailwind, radix-ui, import]

# Dependency graph
requires:
  - phase: 186-01
    provides: "GET/PATCH /users/me/import-settings endpoints, backlog_counts response field"
provides:
  - "useImportSettings/useUpdateImportSettings hooks (query + optimistic-update mutation)"
  - "ImportFilterCard component (TC multiselect + backlog-cap select + auto-save)"
  - "Per-(platform,TC) budget-chip rows on the Import tab"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Auto-save-on-toggle mutation with optimistic update + rollback (no Save button, no dirty state)"
    - "Reuse of FilterPanel's raw-button toggle idiom + shadcn ToggleGroup for a new settings surface"

key-files:
  created:
    - frontend/src/hooks/useImportSettings.ts
    - frontend/src/components/filters/ImportFilterCard.tsx
    - frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx
  modified:
    - frontend/src/pages/Import.tsx
    - frontend/src/pages/__tests__/Import.stateMachine.test.tsx

key-decisions:
  - "isError handling for the settings GET lives once, inside ImportFilterCard (Task 1) — removed a duplicate page-level error branch added during Task 2 to avoid two identical error messages rendering simultaneously; the card is always mounted directly above the platform rows so the error is still visibly surfaced."
  - "tcSettingsKey's return type narrowed to a `tc_${TimeControl}` template literal (not the broader ImportSettingsUpdate keyof) so indexed access resolves to boolean, not boolean|number — avoids an unsafe cast."

requirements-completed: [IMPORT-01, IMPORT-04]

coverage:
  - id: D1
    description: "Import filters card renders above the platform cards with a TC multiselect row and a cap single-select row (D-08)"
    requirement: "IMPORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#renders the TC grid and cap ToggleGroup with expected data-testids and aria-pressed states"
        status: pass
    human_judgment: false
  - id: D2
    description: "Toggling a TC or cap auto-saves via an immediate mutation call, no Save button, no dirty state (D-09)"
    requirement: "IMPORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#toggling an inactive TC calls the update mutation with the new TC set (auto-save)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#selecting a different cap calls the mutation with the new game_cap"
        status: pass
    human_judgment: false
  - id: D3
    description: "Deselecting the last remaining active TC is a no-op (last-one-standing guard) — at least one TC always enabled"
    requirement: "IMPORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#last-one-standing guard: deselecting the final active TC is a no-op (no mutation)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Budget chips render only for currently-selected TCs; a full/over-cap chip reads as complete (text-foreground font-semibold), never destructive (D-11/D-12)"
    requirement: "IMPORT-04"
    verification:
      - kind: manual_procedural
        ref: "Code review of BudgetChipRow (frontend/src/pages/Import.tsx) — filters TIME_CONTROLS by isTcActive before rendering; isFull = count >= game_cap gates text-foreground/font-semibold vs text-muted-foreground, no destructive class used"
        status: pass
    human_judgment: true
    rationale: "No automated test exercises BudgetChipRow directly (it isn't independently exported/testable without threading real backend backlog_counts data); the ImportFilterCard test suite covers the sibling TC-state logic it reuses (isTcActive), but visual confirmation of the chip row's full/over-cap font-weight treatment at runtime is left to /gsd-verify-work per the plan's deferred manual UAT."
  - id: D5
    description: "Inline helper copy is the exact locked D-10 string, with an InfoPopover carrying the three-sentence rule"
    requirement: "IMPORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#renders the locked inline helper copy and the InfoPopover trigger"
        status: pass
    human_judgment: false
  - id: D6
    description: "GET failure shows the CLAUDE.md-mandated isError copy; guests see the identical UI with no isGuest branch (D-16)"
    requirement: "IMPORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#renders the CLAUDE.md-mandated isError copy on settings-fetch failure"
        status: pass
    human_judgment: false
  - id: D7
    description: "PATCH failure surfaces an inline text-destructive error near the toggled control (not a modal), alongside the existing optimistic rollback; clears on the next mutation attempt (verification-gap fix)"
    requirement: "IMPORT-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#shows an inline text-destructive save error when the PATCH mutation fails (verification gap)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#does not show the save error when the last mutation succeeded (default state)"
        status: pass
      - kind: unit
        ref: "frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx#clears the save error once a subsequent mutation attempt starts"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-07-24
status: complete
---

# Phase 186 Plan 03: Import Filter UI Summary

**Import-tab "Import filters" card (TC multiselect + backlog-cap select, auto-save, last-one-standing guard) plus per-(platform,TC) budget-chip rows reading `backlog_counts` from Plan 01's settings endpoint.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-24T05:39Z
- **Completed:** 2026-07-24T05:53Z
- **Tasks:** 3
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `useImportSettings.ts`: `useImportSettings()` query + `useUpdateImportSettings()` mutation against `/users/me/import-settings`, with optimistic cache update on `onMutate` and rollback on `onError` (D-09 auto-save contract).
- `ImportFilterCard.tsx`: TC multiselect (4-button grid, `FilterPanel`'s raw-button idiom, last-one-standing guard) + backlog-cap `ToggleGroup` (1000/3000/5000) + locked inline copy + `InfoPopover` with the three-sentence rule; no `isGuest` prop (D-16, one code path for guests and registered users).
- Mounted `ImportFilterCard` above the two platform rows in `Import.tsx` (D-08); added `BudgetChipRow` rendering one chip per currently-selected TC below each platform's game-count line, with full/over-cap chips reading as complete (`text-foreground font-semibold`) rather than destructive (D-11/D-12).
- `ImportFilterCard.test.tsx`: 11 RTL tests covering TC/cap data-testids + `aria-pressed`, auto-save-on-toggle, the last-one-standing guard, cap-select mutation, locked copy/popover presence, the `isError` copy, the no-skeleton loading state, and the PATCH-failure inline save-error (render, absence-by-default, clear-on-retry).
- Fixed a pre-existing test file (`Import.stateMachine.test.tsx`) broken by this plan's change: `ImportPage` now depends on the real `useImportSettings`/`useUpdateImportSettings` (backed by TanStack Query), so the QueryClient-less render started throwing "No QueryClient set" — added a hook mock (via `importActual` to keep `tcSettingsKey`) alongside the file's existing per-hook mocks.
- Closed a post-plan verification gap: `useUpdateImportSettings()`'s rollback-on-error had no visible UI signal. `ImportFilterCard` now surfaces an inline `text-destructive` save-error line on PATCH failure (UI-SPEC error-state row), clearing automatically on the next mutation attempt.

## Task Commits

Each task was committed atomically:

1. **Task 1: useImportSettings hook + ImportFilterCard component** - `48a2680f` (feat)
2. **Task 2: Mount ImportFilterCard + per-(platform,TC) budget chips in Import.tsx** - `80b7a098` (feat)
3. **Task 3: ImportFilterCard component test** - `48aedbe1` (test)
4. **Deviation fix: mock useImportSettings in Import.stateMachine.test.tsx** - `ef3c6515` (fix)
5. **Deviation fix: remove duplicate isError copy in Import.tsx** - `1b72ac21` (fix)
6. **Verification-gap fix: inline error on import-settings PATCH failure** - `d9376549` (fix)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP update)

## Files Created/Modified
- `frontend/src/hooks/useImportSettings.ts` — `ImportSettings`/`ImportSettingsUpdate`/`GameCap`/`TcSettingsKey` types, `tcSettingsKey`, `useImportSettings()`, `useUpdateImportSettings()`.
- `frontend/src/components/filters/ImportFilterCard.tsx` — the "Import filters" card; exports `TIME_CONTROLS`/`TIME_CONTROL_LABELS`/`isTcActive` for reuse by `Import.tsx`'s budget-chip row.
- `frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx` (new) — RTL component test, hook module mocked via `importActual`.
- `frontend/src/pages/Import.tsx` — mounts `ImportFilterCard`; adds `BudgetChipRow` inside both platform rows.
- `frontend/src/pages/__tests__/Import.stateMachine.test.tsx` — added a `useImportSettings` mock so the existing QueryClient-less render keeps working.

## Decisions Made
- Settings-fetch `isError` handling lives once, inside `ImportFilterCard` — a duplicate page-level error branch was added during Task 2's action per the plan's literal wording, then removed once it produced two identical error messages on screen simultaneously (both components share the same `['import-settings']` query, so both saw `isError: true` at once). `ImportFilterCard` is always mounted directly above the platform rows in the same render branch, so the error remains visibly surfaced; `BudgetChipRow` simply doesn't render (no chips, no crash) when `importSettings` is undefined, which reads correctly next to the visible error above it.
- Narrowed `tcSettingsKey`'s return type to a `tc_${TimeControl}` template-literal union (`TcSettingsKey`) instead of the broader `keyof ImportSettingsUpdate` — the latter includes `game_cap` (a `GameCap` number-literal field), so `settings[key]` resolved to `boolean | number` and failed `tsc -b` at the `isTcActive` call site. The narrower type keeps indexed access typed as `boolean` with no cast.
- `TIME_CONTROLS`/`TIME_CONTROL_LABELS`/`isTcActive` exported from `ImportFilterCard.tsx` rather than duplicated in `Import.tsx` (the existing codebase pattern for these constants is per-file duplication, e.g. `RatingChart.tsx` vs `FilterPanel.tsx` — this phase instead shares one source of truth between the card and its budget-chip consumer so both always agree on TC order/labels and active-TC state).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Import.stateMachine.test.tsx broken by ImportFilterCard mount**
- **Found during:** Task 2/3 full-suite verification (`npm test -- --run`)
- **Issue:** `ImportPage` now mounts `ImportFilterCard`, which calls the real `useImportSettings`/`useUpdateImportSettings` (backed by `@tanstack/react-query`'s `useQuery`/`useMutation`). `Import.stateMachine.test.tsx` renders `ImportPage` without a `QueryClientProvider` (it mocks every other data hook individually), so 5 of its 7 tests started failing with `Error: No QueryClient set, use QueryClientProvider to set one`.
- **Fix:** Added a `vi.mock('@/hooks/useImportSettings', ...)` block (using `importActual` to preserve the real `tcSettingsKey` helper that `ImportFilterCard`'s `isTcActive` still calls), matching the file's existing per-hook mock pattern.
- **Files modified:** `frontend/src/pages/__tests__/Import.stateMachine.test.tsx`
- **Verification:** All 7 tests in the file pass; full frontend suite green (186 files, 2546 tests).
- **Committed in:** `ef3c6515`

**2. [Rule 1 - Bug] Removed duplicate isError message on Import.tsx**
- **Found during:** Task 2 self-review, before commit
- **Issue:** Task 2's action instructed adding "the CLAUDE.md-mandated isError branch for the settings query" directly in `Import.tsx`. `ImportFilterCard` (Task 1) already renders that exact copy internally for the same query. Since both components call `useImportSettings()` on the same `['import-settings']` queryKey, both would see `isError: true` simultaneously and render the identical message twice on the page.
- **Fix:** Removed the page-level error paragraph and the now-unused `isError` destructure from `Import.tsx`; kept only `ImportFilterCard`'s internal error rendering (already covered by a Task 1/3 test). `BudgetChipRow` degrades gracefully (no chips, no crash) when settings data is unavailable.
- **Files modified:** `frontend/src/pages/Import.tsx`
- **Verification:** `tsc -b`, `npm run lint`, full frontend suite (186 files, 2546 tests) all green after the change.
- **Committed in:** `1b72ac21`

**3. [Verification gap - Rule 2] Silent PATCH failure with no user feedback**
- **Found during:** Post-plan verification pass (phase verifier)
- **Issue:** `useUpdateImportSettings()`'s `onError` already rolled back the optimistic update via TanStack Query's snapshot/rollback, but no component read the mutation's `isError`/`error` state. A failed settings PATCH silently reverted the toggle with zero visible feedback — violating the UI-SPEC Copywriting Contract's error-state row, which requires a small inline `text-destructive text-sm` line near the toggled control (not a modal).
- **Fix:** `ImportFilterCard` now reads `isError` off `useUpdateImportSettings()` and renders `"Couldn't save your import settings. Your change was undone — please try again."` (`data-testid="import-filter-save-error"`) below the filter controls whenever the last mutation attempt failed. No extra state/reset logic needed — TanStack Query resets a mutation's `isError`/`error` the moment the next `mutate()` call dispatches, so the message clears automatically on retry.
- **Files modified:** `frontend/src/components/filters/ImportFilterCard.tsx`, `frontend/src/components/filters/__tests__/ImportFilterCard.test.tsx`
- **Verification:** 3 new regression tests (error line renders on PATCH failure; absent by default; clears once a subsequent mutation attempt starts) — 11/11 tests pass in the file; `tsc -b`, `npm run lint`, full frontend suite (186 files, 2549 tests) all green.
- **Committed in:** `d9376549`

---

**Total deviations:** 3 auto-fixed (2 Rule 1 bugs from this plan's own changes, 1 Rule 2 missing-critical-functionality closed post-verification)
**Impact on plan:** All three were necessary — the first two to keep the full frontend suite green and avoid a duplicate-error UI regression, the third to close a genuine UX gap (silent settings-save failure) flagged by the phase verifier. No functionality beyond the plan's stated scope (plus this required fix) was added.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None. All rendered data (`backlog_counts`, `game_cap`, TC toggles) is wired to the live `/users/me/import-settings` endpoint delivered by Plan 01 — no hardcoded/placeholder values.

## Next Phase Readiness
- This was the final plan (03 of 03) in Phase 186. The Import tab now exposes the full TC-filter + backlog-cap UI end to end: settings persist via Plan 01's API, forward-sync respects the TC filter (Plan 01), backward-fetch respects the backlog cap (Plan 02), and the UI (this plan) lets users configure and observe both.
- The PATCH-failure inline error + optimistic rollback (originally a deferred-to-manual-UAT `backstop` truth) is now covered by an automated test (D7) after the post-plan verification-gap fix. Manual UAT still deferred per the plan's `<verification>` section for the remaining `backstop` truth: confirm at 375px width that the budget-chip row wraps via `flex-wrap` without truncating a count.
- Full backend suite unaffected (no backend files touched by this plan). Frontend: `tsc -b` clean, `npm run lint` clean, `npm test -- --run` green (186 files, 2549 tests, including the 11-test `ImportFilterCard.test.tsx`).

## Self-Check: PASSED

All 5 created/modified files confirmed present on disk; all 6 commit hashes
(`48a2680f`, `80b7a098`, `48aedbe1`, `ef3c6515`, `1b72ac21`, `d9376549`)
confirmed present in git history.

---
*Phase: 186-import-filters-tc-and-game-cap*
*Completed: 2026-07-24*
