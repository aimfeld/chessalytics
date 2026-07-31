---
phase: 191-schedule-progress-surface
plan: 06
subsystem: ui
tags: [react, typescript, train, empty-states, uat, dev-tooling, alembic]

requires:
  - phase: 191-schedule-progress-surface
    provides: "Plan 01's useTrainProgress hook and GET /train/progress; Plan 02's pool_state / next_due_date / mastered_count fields; Plans 03-05's celebrations, schedule settings and nav badge (the assembled surface this plan gates)"
provides:
  - "TrainEmptyBody — the pool_state-driven split of TrainStartScreen's 'empty' landing branch (cold-start / exhausted / generic fallback)"
  - "ToggleChipButton — the shared filter-panel chip primitive, extracted from FilterPanel and reused by TrainScheduleSettings"
  - "useFitBoardToViewport — measured board sizing for short windows"
  - "app/core/dev_clock.py dev_now_utc dependency + TrainDevClock strip + scripts/reset_train_state.py (dev-only schedule time travel)"
  - "drill_sessions.requested_count — the persisted session size that makes a settings change recompose an untouched session"
affects: []

tech-stack:
  added: []
  patterns:
    - "Server-computed discriminant over client arithmetic: a single `pool_state` literal picks the empty-state copy, and an unresolved query falls back to neutral copy rather than inferring a state from partial counts (T-191-24)."
    - "Dev-only clock injection: an `X-Dev-Clock-Offset-Minutes` header honored solely when ENVIRONMENT == 'development', consumed through a `dev_now_utc` FastAPI dependency so calendar-shaped behavior is testable without waiting days. Any new time-dependent endpoint should take `now_utc` from this dependency rather than calling datetime.now() inline."

key-files:
  created:
    - frontend/src/components/ui/toggle-chip-button.tsx
    - frontend/src/components/train/buttonStyles.ts
    - frontend/src/hooks/useFitBoardToViewport.ts
    - frontend/src/components/train/TrainDevClock.tsx
    - frontend/src/lib/devClock.ts
    - app/core/dev_clock.py
    - scripts/reset_train_state.py
    - alembic/versions/*_phase_191_train_settings_new_defaults.py
    - alembic/versions/*_phase_191_drill_sessions_requested_count.py
    - tests/test_dev_clock.py
    - tests/scripts/test_reset_train_state.py
  modified:
    - frontend/src/components/train/TrainStartScreen.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/TrainSolveScreen.tsx
    - frontend/src/components/train/TrainReveal.tsx
    - frontend/src/components/filters/FilterPanel.tsx
    - frontend/src/hooks/useTrainGradingEngine.ts
    - frontend/src/lib/trainArrows.ts
    - frontend/src/App.tsx
    - app/models/train_settings.py
    - app/models/drill_session.py
    - app/services/train_scheduler.py
    - app/repositories/train_repository.py
    - app/routers/train.py

key-decisions:
  - "The two tailored states are selected ONLY by the server's `pool_state`; `isPending`/`isError` collapse to `undefined` and take the generic Phase-190 fallback. Guessing a state from mastered_count/waiting_count arithmetic is the exact failure the fallback exists to prevent (T-191-24)."
  - "resolveLandingState's six-branch chain was left untouched — the split lives entirely inside the existing 'empty' branch's render, honoring the 190-04 contract."
  - "UAT issue 5 was fixed on BOTH sides rather than one: the backend persists drill_sessions.requested_count so an untouched session recomposes when puzzles_per_session changes, and the frontend re-fetches the session after a settings save. Fixing only the client would have left the stale size in the DB."
  - "Train defaults changed to weekday_mask=127 (every day) and puzzles_per_session=6 — a data migration, not just a model default, so existing rows on the old defaults move too."
  - "The mistake-level tier was reverted out of the reveal's alternative arrows (b00c01d3): only clean and slightly-imprecise moves are drawn. Showing moves the grading calls mistakes as 'alternatives' contradicted the verdict."
  - "The dev clock is inert outside ENVIRONMENT == 'development' by construction — the header is read but ignored — so no production surface can be time-shifted."

requirements-completed: [PROG-05]

coverage:
  - id: D1
    description: "Empty session + pool_state 'no_material' renders the cold-start heading, the analysis subtitle and an Import games link to /library/import, with no progress row above it"
    requirement: "PROG-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainStartScreen.test.tsx — 'TrainStartScreen — PROG-05/D-16 tailored cold/exhausted empty states (191-06)' > 'no_material: renders the cold-start heading/subtitle and an Import games link to /library/import, with no progress row'"
        status: pass
    human_judgment: false
  - id: D2
    description: "Empty session + pool_state 'exhausted' renders 'All caught up!', the interpolated mastered count, a short-format 'Next review:' line when next_due_date is present and 'Nothing due right now — nice work.' when it is null, with TrainProgressRow above it"
    requirement: "PROG-05"
    verification:
      - kind: unit
        ref: "same describe block — 'exhausted: renders \"All caught up!\", the mastered count, a Next review line, and the progress row' and 'exhausted with no next-due date: renders the \"Nothing due right now\" copy and no \"Next review:\" text'"
        status: pass
    human_judgment: false
  - id: D3
    description: "A pending, errored or 'available' progress query falls back to the generic Phase-190 empty copy and neither tailored testid appears; a non-empty session renders no empty state at all"
    requirement: "PROG-05"
    verification:
      - kind: unit
        ref: "same describe block — the 'pending progress query', 'errored progress query', 'pool_state available' and 'a non-empty (fresh) session renders no empty state at all' cases"
        status: pass
    human_judgment: false
  - id: D4
    description: "The assembled Phase 191 Train surface (stats row, this-week hint, schedule settings, nav badge, confetti, mastery banner, empty states, delete-all copy) verified by hand on desktop and mobile"
    requirement: "PROG-05"
    verification:
      - kind: manual
        ref: "Human UAT round, 2026-07-27 — five issues found and fixed (commits 7a84a812, 18835f89, 6671fa60, 41509a84, 4eb551e3), followed by mobile/layout polish (81ef6b2e, 26c924d3) and a reveal-arrow correction (dd80356a, b00c01d3). Approved 2026-07-27."
        status: pass
    human_judgment: true

duration: ~5h (incl. UAT round and fixes)
completed: 2026-07-27
status: complete
---

# Phase 191 Plan 06: Cold/Exhausted Empty States + Phase Gate Summary

**Phase 190's single generic "No puzzles available yet" placeholder is replaced by two tailored states chosen purely from the server's `pool_state` discriminant, and the assembled Phase 191 Train surface passed a human UAT round that surfaced five issues — all fixed on this branch.**

## Accomplishments

### Task 1 — Two tailored empty states (PROG-05, D-16)

- `TrainStartScreen` now calls `useTrainProgress()` directly and delegates its `state.kind === 'empty'` branch to a new local `TrainEmptyBody` helper. `resolveLandingState`'s six-branch chain is untouched: the split is a render-time split, not a new landing state (190-04 contract).
- **`no_material`** (`train-empty-no-material`): heading `Import & analyze your games to start training`, subtitle `Train drills your own blunders once they're analyzed.`, and a `brand-outline` Button wrapping a react-router `Link to="/library/import"` (`btn-train-import-games`), full-width on mobile. No progress row — there is no data to show.
- **`exhausted`** (`train-empty-exhausted`): `TrainProgressRow` above (D-16: the stats row stays wherever data exists), heading `All caught up!`, subtitle `{mastered_count} mastered.` plus either `Next review: {MMM d, yyyy}.` or `Nothing due right now — nice work.` No CTA — the state is an achievement, not an error.
- **Fallback**: `available`, pending, and errored all keep the Phase-190 generic copy verbatim. `poolState` is computed as `progress.isPending || progress.isError ? undefined : progress.data?.pool_state`, so an unresolved query can never be mistaken for a resolved one (T-191-24).
- 7 new tests in `TrainStartScreen.test.tsx` covering every `<behavior>` case; all pre-existing landing-state tests still pass.

### Task 2 — Blocking human gate: 5 UAT issues found and fixed

| # | Issue | Fix |
|---|---|---|
| 1 | Desktop Train nav badge clipped by the nav item's bounds | `7a84a812` — badge positioning/overflow corrected in `App.tsx`, test pinned |
| 2 | Schedule pickers looked nothing like the rest of the app | `18835f89` — extracted `ToggleChipButton` from `FilterPanel` and reused it in `TrainScheduleSettings`, so both surfaces share one chip primitive |
| 3 | Wrong Train defaults (partial weekday mask, wrong session size) | `6671fa60` — `weekday_mask=127`, `puzzles_per_session=6` as model defaults **and** a data migration for existing rows; new frontend presets in `18835f89` |
| 4 | Train start-screen text centered instead of left-aligned | `4eb551e3` |
| 5 | Changing `puzzles_per_session` left an already-composed session at the old size | `41509a84` (backend: new `drill_sessions.requested_count` column + recompose of an untouched session) and `4eb551e3` (frontend: `onSettingsSaved` → session re-fetch) |

Follow-on polish from the same pass: bigger mobile Train buttons plus Import-matched page padding (`81ef6b2e`, new `buttonStyles.ts`), the landing capped at Import's `max-w-2xl` content column (`26c924d3`), a clearer Train tagline (`5442a775`), measured board fit on short windows via the new `useFitBoardToViewport` hook (`dd80356a`), and a revert of mistake-level moves from the reveal's alternative arrows (`b00c01d3`) — showing moves the grader calls mistakes as "alternatives" contradicted the verdict shown next to them.

### Dev tooling (unplanned, enabling)

`0ccdc169` added the dev clock: `app/core/dev_clock.py`'s `dev_now_utc` dependency shifts "now" by an `X-Dev-Clock-Offset-Minutes` header, honored **only** when `ENVIRONMENT == "development"`; a `TrainDevClock` strip (gated on `import.meta.env.DEV`) persists the offset and `api/client.ts` attaches the header; `scripts/reset_train_state.py` wipes one user's Train state back to a clean slate (refuses `--db prod`). Without this, the weekday mask, session expiry, due-date ladder and Mon-start streak weeks could not be verified in a single sitting. Documented in `CLAUDE.md`.

## Files Created/Modified

See the `key-files` frontmatter block above — 11 files created, 14 modified across both stacks, plus two additive Alembic migrations (`train_settings` new defaults, `drill_sessions.requested_count`).

## Deviations from Plan

- **Scope grew well past Task 1.** The plan anticipated a small empty-state split plus a sign-off. The UAT gate did its job and returned five real issues, two of which needed backend changes and Alembic migrations (defaults, `requested_count`). All were fixed on this branch rather than deferred, since the phase gate is blocking.
- **Dev clock tooling was not in the plan.** Verifying calendar-shaped behavior by hand required time travel; the tooling was built as part of the gate and is dev-only by construction.
- **A revert was needed.** `dd80356a` widened the reveal's candidate arrows to include mistake-level moves; `b00c01d3` reverted that specific widening after it read as contradicting the verdict. The board-fit work in the same commit was kept.

## Issues Encountered

None unresolved. Every UAT issue was fixed and covered by a test in the same pass (`bd5c0dd2` for the backend defaults + recompose, extended `TrainScheduleSettings.test.tsx` / `TrainStartScreen.test.tsx` for the frontend).

## User Setup Required

None for production. For local schedule testing: after time-travelling with the dev clock strip, run `uv run python scripts/reset_train_state.py --user-id N` to get back to a clean slate, since rows written while shifted keep the shifted dates.

## Next Phase Readiness

Phase 191 is the last phase in milestone v2.9. Next step is `/gsd-complete-milestone` and a `main → production` release PR.

---
*Phase: 191-schedule-progress-surface*
*Completed: 2026-07-27*
