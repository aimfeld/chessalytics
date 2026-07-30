---
phase: 191-schedule-progress-surface
verified: 2026-07-27T20:20:00Z
status: passed
score: 5/5 phase success criteria verified (SCHD-01..03, PROG-01..05)
behavior_unverified: 0
overrides_applied: 0
---

# Phase 191: Schedule + Progress Surface Verification Report

**Phase Goal:** Users configure a weekly training schedule and see it surfaced in-app (nav
badge / dashboard card), can start an ad-hoc session anytime, and get an honest progress
picture (weekly streak, mastered/parked counts, celebrations, cold/empty states) — turning
the mechanics built in Phases 189–190 into a habit loop.

**Verified:** 2026-07-27
**Status:** passed
**Re-verification:** No — initial verification
**Recording note:** this report was written retroactively at ship time. The human UAT it
records was run live by the operator on 2026-07-27 against the dev stack; its evidence is
the five-issue fix trail on this branch (`7a84a812`, `18835f89`, `6671fa60`, `41509a84`,
`4eb551e3`) plus the follow-on polish commits, not a contemporaneous checkpoint transcript.

**Requirements:** SCHD-01, SCHD-02, SCHD-03, PROG-01, PROG-02, PROG-03, PROG-04, PROG-05

## Goal Achievement

### Success Criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | A user sets a weekday picker + N-puzzles-per-session schedule; on scheduled session days a nav badge and/or dashboard card surfaces the waiting session; an ad-hoc "train now" session is available any day and draws the same queue | ✓ VERIFIED | **Settings (SCHD-01):** `TrainScheduleSettings.tsx` — inline auto-saving weekday chips + puzzles-per-session presets, no Save button, `Saved` flash (Plan 04). Restyled during UAT onto the shared `ToggleChipButton` primitive extracted from `FilterPanel` (`18835f89`), and defaults moved to `weekday_mask=127` / `puzzles_per_session=6` in both the model and a data migration (`6671fa60`). **Badge (SCHD-02):** `App.tsx` `NavHeader`/`MobileBottomBar` render `train-notification-badge`/`-mobile` from `useTrainProgress().data?.waiting_count`, capped at `NAV_BADGE_MAX_DISPLAY = 99`, gated off for guests/locked nav; the Phase-190 first-visit dot is fully removed (Plan 05, 9 tests in `App.test.tsx`); clipping fixed in UAT (`7a84a812`). No dashboard card was built — the criterion is "and/or". **Ad-hoc (SCHD-03):** proven with zero production code by `test_composition_on_off_day_draws_from_same_queue`, which composes on an explicitly unscheduled weekday and asserts the identical 9 SR / 3 herring mix a scheduled day gets — `compose_and_materialize_session` never consults `weekday_mask` (Plan 04). |
| 2 | A weekly streak counter reflects consecutive weeks with every scheduled session completed, with no freeze-token mechanics | ✓ VERIFIED | `app/models/train_settings.py` carries the D-18 settled-streak snapshot (`streak_count`, `flame_state`, `streak_settled_through`, one additive migration). Settled weeks are frozen forever — settlement judges each elapsed week by the mask/timezone that was actually in force, so a later settings change cannot rewrite history (`settle_weeks`; `settle-before-mutate` on `PUT /train/settings`, Plan 02 `055aca39`). `streak_count` counts **settled** weeks only, never the in-progress week. `TrainProgressRow` renders the flame + `{N}-week streak` (suppressed at zero per D-03, no literal "0-week streak") and a self-clearing `Streak reset — start a new one this week.` notice. No freeze/token/grace mechanic exists anywhere in the model or scheduler. Covered by `test_first_settlement_replays_pre_existing_history`, `test_progress_read_is_idempotent`, `test_settled_week_survives_mask_change` and the exhaustive D-02 flame-ladder tests (`cf98f232`). |
| 3 | A green-rated session ends with a `prefers-reduced-motion`-safe confetti burst, and an item hitting 3/3 mastery triggers a distinct "Flaw fixed!" celebration with the position thumbnail | ✓ VERIFIED | **Confetti (PROG-02):** `TrainScoreScreen.tsx` fires `fireWinConfetti()` once per mount behind the existing `prefersReducedMotion()` guard — the same shape bot games already use, not a new implementation (Plan 03, `26464b6a`). **Mastery banner (PROG-03):** `TrainFlawFixedBanner.tsx` renders the `Flaw fixed!` headline with the position thumbnail; `TrainReveal.tsx:512` mounts it in place of the D-12 plain notice (Plan 03, `0f9d54f8`). Both landed test-first (`5827850a`, `be30ac46`). |
| 4 | The progress surface shows mastered and parked counts honestly, never framed as failure | ✓ VERIFIED (with copy deviation, see Gaps) | `TrainProgressRow.tsx` renders `{N} mastered` and `{N} parked` as neutral stat chips. Nothing on the surface uses "failed", "lost", or any loss-aversion or shaming framing; the parked count is a plain state label. **Deviation:** the UI-SPEC's exact suffix `— too hard for now` was deliberately dropped in the UAT round (`81ef6b2e`, "copy tweaks"), with the test updated in the same commit. The framing requirement (never failure) still holds; the specific example string from PROG-04 no longer renders. Recorded as advisory 1 below rather than claimed as matched. |
| 5 | Cold/empty states never show a dead screen: no analyzed games points to import/analysis, and an exhausted pool shows a celebratory state | ✓ VERIFIED | `TrainStartScreen.tsx`'s new `TrainEmptyBody` splits the `empty` branch purely on the server's `pool_state`: `no_material` → `Import & analyze your games to start training` + a `brand-outline` `Link to="/library/import"` (`btn-train-import-games`), no progress row; `exhausted` → `TrainProgressRow` above `All caught up!` with `{N} mastered.` plus `Next review: {MMM d, yyyy}.` or `Nothing due right now — nice work.`, no CTA. `available`, pending and errored all fall back to the Phase-190 generic copy — `poolState` is forced to `undefined` when `isPending || isError`, so an unresolved query can never be mistaken for a resolved one (T-191-24). `resolveLandingState`'s six-branch chain is untouched. 7 named tests in `TrainStartScreen.test.tsx` cover every branch including the non-empty-session control. |

**Score:** 5/5 criteria verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `GET /train/progress` + `TrainProgressResponse` | ✓ VERIFIED | Settled streak, flame state, this-week tally, mastered/parked/waiting counts, `pool_state`, `next_due_date` (Plans 01, 02) |
| `app/models/train_settings.py` (D-18 snapshot) | ✓ VERIFIED | `streak_count`, `flame_state` (CHECK-constrained), `streak_settled_through`; one additive migration |
| `frontend/src/components/train/TrainProgressRow.tsx` | ✓ VERIFIED | Flame + streak / mastered / parked chips, this-week hint, streak-reset notice, loading + `isError` branches |
| `frontend/src/components/train/TrainScheduleSettings.tsx` | ✓ VERIFIED | Inline auto-save weekday + session-size pickers on the shared `ToggleChipButton` |
| `frontend/src/components/ui/toggle-chip-button.tsx` | ✓ VERIFIED | Chip primitive extracted from `FilterPanel` during UAT, now shared by both surfaces |
| `frontend/src/hooks/useTrainProgress.ts` | ✓ VERIFIED | Shared query key + `enabled` gate; one cache entry across row, badge and empty states |
| `frontend/src/App.tsx` nav badge | ✓ VERIFIED | `train-notification-badge` / `-mobile`, 99+ cap, old dot chain removed |
| `frontend/src/components/train/TrainFlawFixedBanner.tsx` | ✓ VERIFIED | Mastery celebration with position thumbnail |
| `frontend/src/components/train/TrainStartScreen.tsx` (`TrainEmptyBody`) | ✓ VERIFIED | The two tailored empty states + generic fallback |
| `app/core/dev_clock.py` + `scripts/reset_train_state.py` | ✓ VERIFIED | Dev-only schedule time travel; inert unless `ENVIRONMENT == "development"`; documented in `CLAUDE.md` |
| Six plan SUMMARY files | ✓ VERIFIED | `191-01`..`191-06-SUMMARY.md` all present |

### Plan Completion

| Plan | Status | Commits |
|------|--------|---------|
| 191-01 progress read-model tracer | ✓ Complete | `81b5a429`, `cf98f232`, `f1181242`, `2d252e35`, `d65fc13d` |
| 191-02 waiting count, pool state, settle-before-mutate | ✓ Complete | `266c5bb0`, `29e2860e`, `055aca39`, `57072a4c` |
| 191-03 celebrations | ✓ Complete | `5827850a`, `26464b6a`, `be30ac46`, `0f9d54f8`, `3a021a70` |
| 191-04 schedule settings UI + SCHD-03 proof | ✓ Complete | `2c522b3d`, `49aa5b88`, `cb9e6ffd` |
| 191-05 nav waiting-count badge | ✓ Complete | `9ea6eecc`, `a5cd437b` |
| 191-06 empty states + blocking phase gate | ✓ Complete | `a3e2deb4`, `9cb5c8d2`, then the UAT trail `7a84a812`, `41509a84`, `6671fa60`, `bd5c0dd2`, `18835f89`, `4eb551e3`, `81ef6b2e`, `26c924d3`, `5442a775`, `0ccdc169`, `dd80356a`, `b00c01d3` |

## Verification Method

- **Automated (full pre-merge gate, run at ship time 2026-07-27):**
  - `uv run ruff format app/ tests/` — clean, no files changed
  - `uv run ruff check app/ tests/ --fix` — clean
  - `uv run ty check app/ tests/` — zero errors
  - `uv run pytest -n auto -x` — **3861 passed, 18 skipped** in 65s
  - `cd frontend && npm run lint` — 0 errors (3 pre-existing warnings, all in generated `coverage/` artifacts)
  - `npm run knip` — clean
  - `npx tsc -b` — clean
  - `npm test -- --run` — **2776 passed across 200 files**
- **Manual:** operator UAT on the assembled Train surface (desktop + mobile) against the dev
  stack, using the dev-clock strip to reach scheduled/off days and expiry without waiting.
  Five issues found and fixed in-branch (see table below); follow-on layout and copy polish
  applied in the same pass.
- **Static:** direct inspection of the shipped source for each criterion (symbols and files
  cited in the tables above).

### UAT issues found and fixed

| # | Issue | Fix |
|---|-------|-----|
| 1 | Desktop Train nav badge clipped | `7a84a812` |
| 2 | Schedule pickers inconsistent with the rest of the app | `18835f89` (shared `ToggleChipButton`) |
| 3 | Wrong Train defaults | `6671fa60` (model + data migration) + `18835f89` (frontend presets) |
| 4 | Start-screen text centered, not left-aligned | `4eb551e3` |
| 5 | Session kept the old size after `puzzles_per_session` changed | `41509a84` (backend `drill_sessions.requested_count` + recompose) + `4eb551e3` (frontend re-fetch) |

## Gaps / Advisory

None blocking. Four notes for the record:

1. **PROG-04's example copy no longer renders.** The parked chip shipped as `{N} parked`
   after the UAT round dropped the `— too hard for now` suffix (`81ef6b2e`). The
   requirement's substance — parked is never framed as failure — is intact, and the
   UI-SPEC's overflow reasoning (that suffix was the longest chip at 320px) is now moot. If
   the shorter chip later reads as ambiguous, restoring the suffix or moving it into a
   tooltip is a copy-only change. `191-UI-SPEC.md:106` and `:135` still document the old
   string and are now stale.

2. **No dashboard card.** Criterion 1 offers "nav badge and/or dashboard card"; only the nav
   badge was built. Deliberate, and sufficient for the criterion as written.

3. **Scope grew during the gate.** The dev clock (`app/core/dev_clock.py`, `TrainDevClock`,
   `scripts/reset_train_state.py`), measured board fit (`useFitBoardToViewport`), mobile
   button sizing (`buttonStyles.ts`) and the Import-matched page column were all built
   during the UAT round, not planned. Two additive Alembic migrations rode along
   (`train_settings` defaults, `drill_sessions.requested_count`). All are tested and green.

4. **One in-phase revert.** `dd80356a` widened the reveal's candidate-move arrows to include
   mistake-level moves; `b00c01d3` reverted that specific widening because drawing moves the
   grader calls mistakes as "alternatives" contradicted the verdict shown beside them. The
   board-fit work from the same commit was kept. The `[Unreleased]` changelog bullet was
   corrected in both commits and now describes the shipped behavior.

`191-VALIDATION.md` keeps `status: draft` — its per-task verification map was never filled,
so `/gsd-validate-phase` was not run. Per-plan coverage lives in each SUMMARY's `coverage`
block instead; every row there is discharged.

## Conclusion

**PASSED.** All five phase success criteria are verified in the shipped code, the full
pre-merge gate is green on both stacks, and the blocking human gate did its job: it returned
five real defects — two of them backend bugs needing migrations — rather than rubber-stamping
the surface. The one deviation is a deliberate copy shortening on the parked chip, recorded
above rather than papered over.
