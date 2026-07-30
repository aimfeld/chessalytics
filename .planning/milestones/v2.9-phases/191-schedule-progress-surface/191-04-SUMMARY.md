---
phase: 191-schedule-progress-surface
plan: 04
subsystem: ui
tags: [react, tanstack-query, radix-toggle-group, train, scheduler, pytest]

requires:
  - phase: 191-schedule-progress-surface
    provides: "Plan 01's TrainProgressRow/useTrainProgress + TRAIN_PROGRESS_QUERY_KEY; Plan 02's settle-before-mutate on PUT /train/settings (D-18 closure)"
provides:
  - "useTrainSettings hook — GET/PUT /train/settings with TRAIN_SETTINGS_QUERY_KEY, timezone captured at call time (D-11), invalidates TRAIN_PROGRESS_QUERY_KEY on save success"
  - "TrainScheduleSettings component — 7-chip weekday ToggleGroup + 4-preset puzzles-per-session picker, debounced auto-save, no Save button (SCHD-01, D-10)"
  - "SCHD-03 regression proof: compose_and_materialize_session composes identically on a day whose weekday bit is unset (zero app/ production code)"
  - "Delete All Games dialog now discloses the Train-progress reset"
affects: []

tech-stack:
  added: []
  patterns:
    - "Local-draft-plus-debounce autosave: a component-local draft state seeded exactly once from the resolved query (guarded by a null check, never re-seeded from a later cache write), fed through useDebounce, with a hasEdited ref gating the save effect so mounting itself never fires a mutation — reusable anywhere a no-Save-button control needs debounced persistence without a race on the initial load."

key-files:
  created:
    - frontend/src/hooks/useTrainSettings.ts
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx
  modified:
    - frontend/src/components/train/TrainStartScreen.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - frontend/src/pages/Import.tsx
    - tests/repositories/test_train_repository.py

key-decisions:
  - "useTrainSettings.save is the raw useMutation.mutate reference; the component calls save(draft, { onSuccess, onError }) per-invocation rather than deriving indicator visibility from the hook's own isSaveSuccess/isSaveError booleans — this gives the 2s auto-clear timeout and the persisting error state precise per-call control without a stale-closure risk across rapid successive saves."
  - "TrainScheduleSettings.test.tsx uses REAL timers (not vi.useFakeTimers()) to advance past the 600ms debounce window: this project's vitest setup has no global `jest` shim, and @testing-library/dom's waitFor only self-advances fake timers when it detects one (dist/wait-for.js's jestFakeTimersAreEnabled requires `typeof jest !== 'undefined'`) — combining vi.useFakeTimers() with waitFor here would silently poll on a frozen clock. Real 700ms waits keep the file's total runtime well under the 5s per-test default."
  - "PUZZLES_PER_SESSION_PRESETS / WEEKDAY_CHIPS / the two *_MS constants are exported from TrainScheduleSettings.tsx (a component file) for direct test import; the two array constants needed a targeted react-refresh/only-export-components eslint-disable (existing codebase precedent: EndgameClockDiffOverTimeChart.tsx's computeYDomain) — the two scalar MS constants did not trip the rule and got no disable."

requirements-completed: [SCHD-01, SCHD-03]

coverage:
  - id: D1
    description: "Weekday picker + puzzles-per-session picker auto-save via a single debounced PUT /train/settings, no Save button anywhere; all-off (weekday_mask 0) is a valid state with no validation error"
    requirement: "SCHD-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx (10 tests: loading-disabled, populated-pressed-state, mount-zero-calls, single-call-on-chip-click, all-off-mask, preset-select, timezone-never-rendered, save-error-no-revert, save-success-indicator, query-error-no-chips)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The settings block is mounted below the Start/Resume CTA on TrainStartScreen (D-13) in every landing state that has one, plus the completed recap"
    requirement: "SCHD-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainStartScreen.test.tsx::D-13: the schedule settings block renders after the Start CTA in the fresh state"
        status: pass
    human_judgment: false
  - id: D3
    description: "SCHD-03: compose_and_materialize_session composes on a day whose weekday bit is NOT set in weekday_mask, drawing from the identical due-item + pool queue a scheduled day would use — zero new production code"
    requirement: "SCHD-03"
    verification:
      - kind: integration
        ref: "tests/repositories/test_train_repository.py::test_composition_on_off_day_draws_from_same_queue"
        status: pass
      - kind: other
        ref: "git diff --stat app/ (empty for this whole plan)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Delete All Games dialog discloses that Train progress also resets, without pushing the confirm/cancel buttons below the fold on a 320x568 viewport"
    requirement: "SCHD-01"
    verification: []
    human_judgment: true
    rationale: "191-UI-SPEC.md E11 flags the overflow/wrap checks as backstop items requiring a visual check at 320x568 — the copy-only edit (one appended sentence) was applied and reviewed for length, but no live browser screenshot was captured during this autonomous run."

duration: 20min
completed: 2026-07-27
status: complete
---

# Phase 191 Plan 04: Schedule Settings UI + SCHD-03 Regression Proof Summary

**Inline auto-saving weekday + puzzles-per-session pickers on the Train start screen (no Save button, D-09..D-12), plus a regression test proving ad-hoc off-day training already draws from the same queue and a one-sentence delete-all warning.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 2
- **Files modified:** 8 (5 created/modified frontend, 1 backend test file, 1 copy-only frontend page)

## Accomplishments

- `useTrainSettings` (new hook): `TRAIN_SETTINGS_QUERY_KEY` read query + a mutation that reads `Intl.DateTimeFormat().resolvedOptions().timeZone` at call time (D-11, never surfaced/editable), writes the fresh row into its own cache on success, and invalidates `TRAIN_PROGRESS_QUERY_KEY` (a changed `weekday_mask` can shift `current_week_required` and advance the D-18 settled snapshot).
- `TrainScheduleSettings` (new component): a 7-chip Monday-first `ToggleGroup type="multiple"` weekday picker (bit convention identical to `next_scheduled_day`/`week_start` — Monday=0..Sunday=6) and a 4-preset (`6/12/18/24`) `ToggleGroup type="single"` puzzles picker. Both pickers render fully disabled while `GET /train/settings` is in flight (closing the "early tap auto-persists a placeholder default" race that a no-Save-button UI would otherwise open). A local draft seeded exactly once from the resolved settings, debounced 600ms, fires the save only after the user has actually edited something — mounting itself never triggers a mutation. All-off (`weekday_mask: 0`, "train anytime") is a fully legal state with no validation. The autosave slot shows a `Check` + "Saved" for 2s on success, or a persistent "Couldn't save. Try again." on failure — the chip selection is never silently reverted.
- Mounted below the Start/Resume CTA on `TrainStartScreen` (D-13) — in the `fresh`/`short`/`resume` return and in the `completed` recap block, but not in `loading`/`error`/`empty`.
- `test_composition_on_off_day_draws_from_same_queue` (backend regression, SCHD-03): pins `weekday_mask` to Monday-only, composes on `_TODAY` (2026-01-15, a Thursday — an explicitly unscheduled day), and asserts the identical 9 SR / 3 herring mix `test_full_session_is_nine_sr_and_three_herrings` gets on a scheduled day. Confirms `compose_and_materialize_session`'s fresh-composition path and its D-11/D-12 guards never consult `weekday_mask` — no production code change was needed or made (`git diff --stat app/` is empty for this plan).
- `Import.tsx`'s Delete All Games dialog now reads: "This will delete all your imported games. You can import them again anytime. This also resets your Train progress." (copy-only; the known nuance that the weekly streak itself survives a game wipe per the locked Phase 189 D-04 `drill_sessions` FK is left alone, per the plan's explicit instruction not to "fix" it with a cascade).

## Task Commits

1. **Task 1: Inline auto-saving schedule settings on the Train start screen** - `2c522b3d` (feat)
2. **Task 2: Pin ad-hoc off-day composition and land the delete-all warning copy** - `49aa5b88` (test)

**Plan metadata:** (this commit)

## Files Created/Modified

- `frontend/src/hooks/useTrainSettings.ts` (new) - GET/PUT /train/settings hook, `TRAIN_SETTINGS_QUERY_KEY`
- `frontend/src/components/train/TrainScheduleSettings.tsx` (new) - the auto-saving weekday + puzzles picker
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` (new) - 10 tests
- `frontend/src/components/train/TrainStartScreen.tsx` - mounts `<TrainScheduleSettings />` below the CTA
- `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` - mocks `useTrainSettings`, asserts render order
- `frontend/src/pages/Import.tsx` - Delete All Games `DialogDescription` gains the Train-progress-reset sentence
- `tests/repositories/test_train_repository.py` - `test_composition_on_off_day_draws_from_same_queue`

## Decisions Made

- **`save` is the raw `mutate` reference; indicator state is driven by per-call `{ onSuccess, onError }` callbacks**, not the hook's own `isSaveSuccess`/`isSaveError` (which are still returned per the plan's spec but unused by the component) — this gives the "Saved" 2s auto-clear timeout precise control per invocation without relying on a status transition that could otherwise be missed or double-fire across rapid successive edits.
- **`TrainScheduleSettings.test.tsx` advances the debounce window with real timers**, not `vi.useFakeTimers()`: this project's vitest config has no global `jest` alias, and `@testing-library/dom`'s `waitFor` only self-advances a fake clock when it detects one via `typeof jest !== 'undefined'` (`dist/wait-for.js`). Combining fake timers with `waitFor` here would silently poll a frozen clock and risk a hang/timeout. Real ~700ms waits per debounce-triggering test keep the file comfortably under the 5s per-test default.
- **Two eslint-disable comments for `react-refresh/only-export-components`** on `WEEKDAY_CHIPS` and `PUZZLES_PER_SESSION_PRESETS` (exported array constants from a component file, needed by the test file) — matches the existing `EndgameClockDiffOverTimeChart.tsx` precedent. The two scalar `*_MS` constants did not trip the rule.

## Deviations from Plan

None — plan executed exactly as written; all `<behavior>` cases and acceptance criteria satisfied by named tests, and SCHD-03 confirmed with zero production code as the plan anticipated.

## Issues Encountered

None during implementation. One test-design consideration resolved before committing: an initial draft of `TrainScheduleSettings.test.tsx` combined `vi.useFakeTimers()` with `waitFor` (mirroring `TrainSolveScreen.test.tsx`'s pattern), but that file never actually relies on `waitFor` to observe a fake-timer-gated state change in the same way this test needed — verified via `@testing-library/dom`'s source that `waitFor` requires a global `jest` alias to self-advance fake time, which this project doesn't provide, and switched to real-timer waits before running the suite (no wasted debug cycle — caught by inspection).

## User Setup Required

None — no external service configuration, no migration (both tasks operate on existing tables/endpoints; SCHD-03 added a test only).

## Next Phase Readiness

- Schedule settings UI is fully wired end-to-end: `PUT /train/settings` (Plan 02's settle-before-mutate) is now reachable from a real UI, closing the loop opened by Phase 189/190.
- `useTrainSettings`/`TRAIN_SETTINGS_QUERY_KEY` are available for any future surface that needs to read or mutate the schedule.
- No blockers for the remaining Phase 191 plans (05 nav badge, 06 empty states).

## Self-Check: PASSED

All created files verified present on disk; commit hashes `2c522b3d`, `49aa5b88` verified in `git log --oneline`.

---
*Phase: 191-schedule-progress-surface*
*Completed: 2026-07-27*
