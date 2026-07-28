---
phase: 193-session-tick-streak-shield
verified: 2026-07-28T09:30:00Z
status: human_needed
score: 13/13 must-haves verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Multi-day drain and reset felt end to end (PROG-01)"
    expected: "Advancing the dev-clock day by day past several scheduled days without training drains exactly one pip per scheduled day, the count zeroes the moment the last pip goes out, the reset notice appears and SURVIVES a hard page reload, and scripts/reset_train_state.py returns the meter/count/notice to a clean slate."
    why_human: "Requires a running dev stack, the TrainDevClock time-travel strip, and a real browser reload — not assertable in jsdom/pytest. Recorded verbatim in 193-03-SUMMARY.md's 'Outstanding manual verification' as NOT run, NOT approved."
  - test: "7-pip density on a real 360px phone viewport, including the 4-digit ('1234-session streak') backstop case (PROG-01/D-01, UI-SPEC backstop)"
    expected: "The seven pips and the streak label fit without horizontal overflow, the row wraps rather than clips, and no text drops below text-sm — including at a 4-digit session count."
    why_human: "Visual viewport rendering; not testable in jsdom. Recorded as outstanding in 193-03-SUMMARY.md."
  - test: "Badge quiet on an off-day under a narrowed Mon/Wed/Fri mask, at BOTH nav sites, plus the D-10 open-session carve-out returning the badge across the Mon→Tue boundary (SCHD-02/D-09/D-10)"
    expected: "On a Tuesday under a Mon/Wed/Fri schedule with puzzles waiting, both the desktop header badge and the mobile bottom-bar badge are hidden; leaving a session open across the Mon→Tue boundary brings the badge back while the session is still open."
    why_human: "Requires live schedule-settings interaction, TrainDevClock time-travel, and visual confirmation at both badge sites. Recorded as outstanding in 193-03-SUMMARY.md."
---

# Phase 193: Session-Tick Streaks with a Depletable Shield Verification Report

**Phase Goal:** Train's streak stops measuring weeks and starts measuring sessions — one tick-per-scheduled-day mechanism with a depletable 7-level shield replaces Phase 191's weekly-fulfillment check, `required_sessions_per_week`, and the 3-rung flame ladder.

**Verified:** 2026-07-28
**Status:** human_needed
**Re-verification:** No — initial verification

## Method note

This report does not take SUMMARY.md's claims on trust. Every truth below was checked against the actual committed code (not the plan prose), the cited automated tests were run directly by the verifier (not re-quoted from the SUMMARY), and the two highest-risk correctness claims (the sparse-mask elapsed-day boundary, and the eager-completion "settle first, then layer" ordering) were independently confirmed with a live mutation test: the `settle_streak_snapshot` call inside `_apply_completion_tick` was temporarily removed, the skip-guard test was re-run and observed to genuinely FAIL (`shield_level` landed at 6 instead of the expected 4), and the code was then restored and the test re-confirmed passing. This reproduces (rather than just re-reads) the mutation check the executor's SUMMARY.md claimed to have run.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | ROADMAP SC1 — completed session on a scheduled day ticks shield (cap 7) + count immediately; missed scheduled day drains exactly one pip; shield 0 resets count; persistent state-derived reset notice | ✓ VERIFIED | `app/services/train_scheduler.py::_judge_one_day` (`"fulfilled"`/`"missed"` branches); eager write in `app/repositories/train_repository.py::_apply_completion_tick`. Ran directly: `tests/services/test_train_scheduler.py::TestJudgeOneDay` (7 tests, all pass — cap-clamp, floor-at-zero, count-reset-at-zero, no-op-at-zero all individually asserted); `tests/repositories/test_train_repository.py::TestCompletionTick::test_fulfilled_completion_ticks_count_and_shield_and_advances_settled_through` + `test_fulfilled_completion_at_cap_leaves_shield_unchanged` (pass). Reset-notice persistence confirmed structurally: `TickView.streak_reset_notice` is recomputed from scratch on every `get_progress`/`settle_streak_snapshot` call from persisted `shield_level`/`streak_count`/history — no one-shot flag exists anywhere in the write path, confirmed by reading `tick_days` and its 3 unit tests in `TestTickDaysStreakResetNotice` (all pass). |
| 2 | ROADMAP SC2 — a scheduled day earlier than `pool_eligible_since` is never judged (neutral, no drain/tick) | ✓ VERIFIED | `tick_days`'s `eligible = pool_eligible_since is not None and day >= pool_eligible_since` gate. Ran: `TestTickDays::test_watermark_neutral_strictly_before_judged_on_or_after`, `test_none_watermark_judges_every_walked_day_neutral` (pass); integration: `TestStampPoolEligibility::test_null_watermark_produces_no_shield_change_across_elapsed_scheduled_days` (pass). |
| 3 | ROADMAP SC3 — ad-hoc off-day session credits one shield pip but not the count; a session started and left unfinished past its window is a miss | ✓ VERIFIED | `_apply_completion_tick`'s `"credit_only"` branch (off-day) and the plain lazy-walk `"missed"` branch (abandoned session, D-08 needs no code — only `status='completed'` reaches the eager path). Ran: `TestCompletionTick::test_off_day_completion_credits_shield_only`, `test_abandoned_session_drains_one_pip_with_no_count_change`, `test_cap_parity_between_fulfilled_and_off_day_branches` (all pass). |
| 4 | ROADMAP SC4 — a settled day is frozen forever; a later `weekday_mask`/timezone change only re-judges days strictly after `streak_settled_through` | ✓ VERIFIED | `tick_days` starts its walk at `next_scheduled_day(settled_through + 1, mask)`. Ran: `TestTickDays::test_never_walks_a_day_at_or_before_settled_through` (pass); integration `test_settled_day_survives_mask_change` (pass). |
| 5 | ROADMAP SC5 — Train stats row renders a 7-segment pip meter + "N-session streak" label; nav badge appears only on scheduled days except an open unfinished session keeps its badge on an off-day | ✓ VERIFIED | `frontend/src/components/train/TrainProgressRow.tsx`'s `ShieldMeter`/label; server `badge_visible = waiting_count > 0 and (is_scheduled_day(...) or _open_unfinished_exists(...))` in `get_progress`; both `frontend/src/App.tsx` sites (desktop `NavHeader`, mobile `MobileBottomBar`) AND this flag in. Ran: `npx vitest run src/components/train/__tests__/TrainProgressRow.test.tsx` (16/16 pass); `npx vitest run src/App.test.tsx -t "191-05"` (11/11 pass, includes the off-day-hidden and fail-closed-on-omitted-field cases); backend `TestBadgeVisible` (6 scenarios, pass). |
| 6 | Deletion completeness — `FlameState`, `FLAME_LADDER`, `_flame_up`, `_flame_down`, `required_sessions_per_week`, `SettledStreak`, `StreakView`, `_settle_one_week`, `settle_weeks`, `flame_state` column + its CHECK, `TRAIN_STREAK_FLAME_*`, `TrainFlameState` are all gone from live code (only docstring prose explaining the replacement survives, by design) | ✓ VERIFIED | Ran a grep sweep across `app/` and `frontend/src/` for all 13 symbols/names — zero live-code hits, only two docstring-prose mentions in `app/services/train_scheduler.py`'s module docstring explaining what was replaced. |
| 7 | Untouched primitives — `local_today`, `next_scheduled_day`, `session_window`, `is_session_expired`, `apply_result`, `LADDER_DAYS`, `MASTERY_STREAK_THRESHOLD` remain in `train_scheduler.py`, unmodified in signature/semantics | ✓ VERIFIED | Read the full file: all 7 present, unchanged signatures, same docstrings (with cross-reference notes added, not behavior changes). |
| 8 | Correctness risk (a) — the elapsed-day boundary is `is_session_expired(session_window(day, weekday_mask), today)`, never `day < today` | ✓ VERIFIED | `tick_days`'s loop condition reads exactly `is_session_expired(session_window(day, weekday_mask), today)`. Ran `TestTickDays::test_sparse_mask_boundary_not_judged_before_window_closes` and `..._judged_once_window_closes` (a Mon/Wed/Fri mask: Monday NOT judged on Tuesday, IS judged on Wednesday) — both pass. |
| 9 | Correctness risk (b) — the eager completion path settles first, then layers, so a late completion cannot escape intervening drains | ✓ VERIFIED (independently mutation-tested by this verifier) | `_apply_completion_tick` calls `settle_streak_snapshot` before choosing/applying its own `DayOutcome`. Ran `TestCompletionTick::test_double_count_guard_late_completion_after_lazy_miss` and `test_skip_guard_drains_intervening_misses_before_applying_completion` (both pass as shipped). Then independently reverted the `settle_streak_snapshot` call inside `_apply_completion_tick`, re-ran the skip-guard test alone, and confirmed it genuinely FAILS (`shield_level` landed at 6, not the expected 4) — restored the code and re-confirmed the test passes again. The guard is load-bearing, not decorative. |
| 10 | Single-clamp invariant — `min(...SHIELD_CAP)` appears exactly once in `app/`, in `train_scheduler.py` | ✓ VERIFIED | Ran the exact grep script from the plan's acceptance criteria myself: `hits == ['app/services/train_scheduler.py']` — passes. |
| 11 | Project rule — no native PG ENUM for shield level (`SmallInteger` + CHECK) | ✓ VERIFIED | `app/models/train_settings.py`: `shield_level: Mapped[int] = mapped_column(SmallInteger, ...)` + `CheckConstraint(f"shield_level BETWEEN 0 AND {SHIELD_CAP}", ...)`. No `Enum(...)` import in the file. |
| 12 | Project rule — no inline `datetime.now()` in new time-dependent paths; no `asyncio.gather` on one `AsyncSession` | ✓ VERIFIED | Grepped `app/repositories/train_repository.py`, `app/services/train_scheduler.py`, `app/routers/train.py` for `datetime.now()` and `asyncio.gather` — zero live-code hits (only prose reminders in docstrings). `GET /train/progress` and `POST /train/sessions/{id}/solve` both take `now_utc: NowUtc`. |
| 13 | Project rule — `text-sm` floor honoured; pip colours are named `theme.ts` constants; BOTH `App.tsx` badge sites changed | ✓ VERIFIED | `grep -n "text-xs\|font-size" TrainProgressRow.tsx` → no match; `grep -c "oklch(" TrainProgressRow.tsx` → 0 (colours sourced from `TRAIN_SHIELD_PIP_LOW/MEDIUM/HIGH` in `theme.ts`, same oklch literals as the deleted flame constants); `frontend/src/App.tsx` gates both the desktop (`data-testid="train-notification-badge"`) and mobile (`"train-notification-badge-mobile"`) sites on `trainBadgeVisible`. |

**Score:** 13/13 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `alembic/versions/20260728_055940_f2624e60292e_phase_193_session_tick_shield.py` | Drop `flame_state`+CHECK, add `shield_level`+CHECK, add `pool_eligible_since`, hard-reset carry-over columns | ✓ VERIFIED | Matches exactly; the Task 1 checkpoint ruling (option-b, hard reset with NO backfill) is implemented and documented in the migration's own module docstring — this is the known, consciously-waived D-05 retroactivity, not a defect. |
| `app/models/train_settings.py` | `shield_level` SmallInteger+CHECK; `pool_eligible_since` nullable Date | ✓ VERIFIED | Present, matches expected shape. |
| `app/services/train_scheduler.py` | `SHIELD_CAP`, `DayOutcome`, `is_scheduled_day`, `scheduled_days_per_week`, `TickSnapshot`, `TickView`, `_judge_one_day`, `tick_days` | ✓ VERIFIED | All present with the exact documented semantics; 46/46 unit tests pass. |
| `app/repositories/train_repository.py` | `settle_streak_snapshot` rewired, `_material_flags`, `_stamp_pool_eligibility`, `_apply_completion_tick`, `_open_unfinished_exists`, `ProgressSnapshot.badge_visible` | ✓ VERIFIED | All present, wired into `get_progress`, `record_solve` (gated `claimed AND session_complete`), and `compose_and_materialize_session`. |
| `app/schemas/train.py` / `app/routers/train.py` | `TrainProgressResponse.session_streak_count/.shield_level/.streak_reset_notice/.badge_visible` | ✓ VERIFIED | Present, mapped through the router handler. |
| `frontend/src/lib/theme.ts` | `TRAIN_SHIELD_PIP_LOW/MEDIUM/HIGH` | ✓ VERIFIED | Present, identical oklch literals to the deleted flame constants. |
| `frontend/src/components/train/TrainProgressRow.tsx` | `ShieldMeter`, `pipBandColor`, `SHIELD_PIP_COUNT`, `data-testid="train-shield-meter"`/`"train-shield-pip"` | ✓ VERIFIED | Present, 16/16 rendering tests pass. |
| `frontend/src/App.tsx` | `badge_visible` AND clause at both badge sites | ✓ VERIFIED | Present at both `NavHeader` and `MobileBottomBar`. |
| `.planning/REQUIREMENTS.md` | Rewritten PROG-01/SCHD-02 text + Coverage rows crediting Phase 193 | ✓ VERIFIED | PROG-01 drops "weekly streak"/"no freeze mechanics", names the shield; SCHD-02 narrows to scheduled days, keeps "no push, no email" verbatim, names the D-10 carve-out. Coverage rows for both credit "Phase 191, Phase 193". Requirement-bullet count unchanged at 27. |
| `CHANGELOG.md` | One Phase 193 bullet under `## [Unreleased]` → `### Changed` | ✓ VERIFIED | Present, correctly scoped, no released section touched. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `GET /train/progress` / `PUT /train/settings` | `settle_streak_snapshot` | single settlement entry point | ✓ WIRED | Both callers confirmed; `_apply_completion_tick` also calls it before layering its own tick, so there is exactly one settlement entry point in the whole app. |
| `_judge_one_day` | `tick_days` (lazy) AND `_apply_completion_tick` (eager) | shared arithmetic primitive, `DayOutcome` discriminant | ✓ WIRED | Confirmed both callers route through it; single-clamp grep confirms no re-derivation anywhere else. |
| `record_solve` | `_apply_completion_tick` | gated on `claimed AND session_complete` | ✓ WIRED | Confirmed at `app/repositories/train_repository.py:2011`; the `claimed` refinement (beyond the plan's literal prose) is a genuine improvement proven by `test_resubmit_of_already_solved_final_puzzle_does_not_apply_second_tick`. |
| `is_scheduled_day` | D-07 off-day branch AND D-09 badge computation | one predicate, two call sites | ✓ WIRED | Confirmed both call sites (`train_repository.py:598` and `:1801`) call the same imported function. |
| `frontend/src/App.tsx` | `useTrainProgress` query's `badge_visible` field | no second query, no client weekday math | ✓ WIRED | Confirmed — `grep -n "useTrainSettings\|weekday_mask" App.tsx` returns no match. |

### Behavioral Spot-Checks (performed directly by this verifier, not re-quoted from SUMMARY)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Scheduler unit suite | `uv run pytest tests/services/test_train_scheduler.py -q` | 46 passed | ✓ PASS |
| Sparse-mask elapsed-day boundary (Pitfall 1) | targeted at `TestTickDays::test_sparse_mask_boundary_*` | both pass | ✓ PASS |
| Eager-tick + badge repository suite | `uv run pytest tests/repositories/test_train_repository.py::TestCompletionTick tests/repositories/test_train_repository.py::TestBadgeVisible -q` | 15 passed | ✓ PASS |
| Settled-day-frozen + watermark suite | targeted at `test_settled_day_survives_mask_change`, `TestStampPoolEligibility` | 5 passed | ✓ PASS |
| **Mutation test (independent, not from SUMMARY): settle-first ordering** | reverted `settle_streak_snapshot` call in `_apply_completion_tick`, re-ran `test_skip_guard_drains_intervening_misses_before_applying_completion` alone | test genuinely FAILED (`shield_level == 6`, expected `4`); restored, re-confirmed passing | ✓ PASS (guard proven load-bearing) |
| Shield pip meter / streak label / reset notice rendering | `npx vitest run src/components/train/__tests__/TrainProgressRow.test.tsx` | 16 passed | ✓ PASS |
| Nav badge (both sites) | `npx vitest run src/App.test.tsx -t "191-05"` | 11 passed, 27 skipped (unrelated tests in the same file) | ✓ PASS |
| Deletion completeness sweep | grep for all 13 deleted symbols across `app/` + `frontend/src/` | zero live-code hits | ✓ PASS |
| Single-clamp divergence gate | plan's own grep script, run directly | `['app/services/train_scheduler.py']` | ✓ PASS |
| Debt-marker sweep | grep `TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER` across all phase-touched files | zero hits | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| PROG-01 | 193-01, 193-02, 193-03 | Session-tick streak + depletable 7-level shield | ✓ SATISFIED | Fully implemented and tested end to end; REQUIREMENTS.md text amended to match. |
| SCHD-02 | 193-02, 193-03 | Badge visible only on scheduled session days, with D-10 open-session carve-out | ✓ SATISFIED | `badge_visible` server-computed and wired to both nav sites; REQUIREMENTS.md text amended, "no push, no email" preserved. |

No orphaned requirements found for this phase (only PROG-01/SCHD-02 are declared, matching ROADMAP's stated amend-in-place scope).

### Anti-Patterns Found

None. Swept all phase-touched files (`app/services/train_scheduler.py`, `app/models/train_settings.py`, `app/repositories/train_repository.py`, `app/schemas/train.py`, `app/routers/train.py`, the migration, `scripts/reset_train_state.py`, `app/core/dev_clock.py`, `frontend/src/lib/theme.ts`, `frontend/src/types/train.ts`, `frontend/src/components/train/TrainProgressRow.tsx`, `frontend/src/App.tsx`) for debt markers, placeholder copy, empty-return stubs, and hard-coded empty props. Zero hits.

### Known, Consciously-Accepted Deviations (not gaps)

- **Phase 191 D-05 (retroactivity) waived.** Task 1's checkpoint was resolved as option-b (hard reset, NO backfill) by explicit coordinator/user ruling ("streaks haven't shipped. do a hard reset, we lose nothing."), not option-a as the plan text recommended. `pool_eligible_since` stays nullable and is lazily stamped go-forward. Documented in the migration's module docstring and 193-01-SUMMARY.md. Verified this is what's actually in the shipped migration — it is.
- **SCHD-02 flagged assumption resolved by user ruling.** An open, unfinished, window-EXPIRED session does NOT keep its badge (`_open_unfinished_exists` checks `is_session_expired` first and returns False). Shipped as-is, per an explicit user ruling recorded in 193-03-SUMMARY.md, with the accepted trade-off (a user can still complete an expired session for a hidden +1/-1 net-zero shield recovery with no badge cueing them toward it) stated plainly.

### Human Verification Required

Three items, all explicitly flagged as outstanding (NOT run, NOT approved) in 193-03-SUMMARY.md's own "Outstanding manual verification" section, plus the one genuinely non-jsdom-testable UI-SPEC backstop (4-digit session-count viewport wrap) folded into item 2. Two of the three originally-listed UI-SPEC backstops (the `weekday_mask === 0` and `M === 1` "This week" grammaticality cases) turned out to have real wired unit-test evidence in `TrainProgressRow.test.tsx` (`'This week: 0 sessions'` and `'This week: 1 of 1 sessions'`, both passing) despite UI-SPEC's probe marking them unresolved — so only the viewport-rendering backstop remains genuinely unverifiable without a browser.

1. **Multi-day drain and reset, felt end to end.** Use the dev time-travel strip to advance past several scheduled days without training; confirm one pip drains per scheduled day, the count zeroes exactly when the last pip goes out, and the reset notice appears and survives a hard page reload.
   Expected: pip meter, count, and notice all behave as designed and the notice persists across reload.
   Why human: requires a running dev stack, `TrainDevClock`, and a real browser reload — not assertable in jsdom/pytest.

2. **7-pip density at a real 360px viewport, including the 4-digit session-count case.** Load the Train page at 360px width; confirm the meter and label fit without horizontal overflow and wrap rather than clip, including at a 4-digit count.
   Expected: no clipping, no text below `text-sm`.
   Why human: visual viewport rendering, not testable in jsdom.

3. **Badge quiet on an off-day under a narrowed Mon/Wed/Fri mask, at both nav sites, plus the D-10 carve-out.** Set a Mon/Wed/Fri schedule, time-travel to a Tuesday with puzzles waiting, confirm both badges hidden; then leave a session open across the Mon→Tue boundary and confirm the badge returns.
   Expected: badge hidden on the off-day, badge visible when an open unfinished session crosses into the off-day.
   Why human: requires live schedule-settings interaction, time-travel, and visual confirmation at both sites.

### Gaps Summary

None. Every ROADMAP success criterion, every deletion-completeness/kept-primitive check, both flagged correctness risks (one independently mutation-tested by this verifier, not just re-confirmed from SUMMARY prose), the single-clamp invariant, and every named project rule check out against the actual committed code and pass their cited automated tests when run directly. The only open items are the three UAT checks the executor itself flagged as outstanding and never ran against a live dev stack — these are legitimate human-verification needs (calendar-shaped time-travel behavior and viewport rendering), not defects, and the phase's own SUMMARY.md is honest about them ("Do not treat this plan or Phase 193 as user-verified until those three items are actually run").

---

*Verified: 2026-07-28*
*Verifier: Claude (gsd-verifier)*
