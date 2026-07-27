"""Unit tests for app.services.train_scheduler — pure interval-ladder scheduler.

Phase 189 Plan 01 Task 2 (POOL-04/05/06). No DB fixture — every function under
test is pure (plain `datetime.date`/`int`/`bool` in, plain values out). Mirrors
tests/services/test_eval_utils.py's shape: direct import, plain asserts,
table-driven parametrized cases over the boundary conditions.

Covers:
  - apply_result: correct-move streak progression 0->1->2->MASTERED(3),
    fail_count accrual gated on ever_correct, PARKED at exactly 3 fails,
    due-date snapping via next_scheduled_day.
  - next_scheduled_day: identity on weekday_mask=0, identity when `after` is
    already on a scheduled weekday, forward scan otherwise.
  - session_window: D-10 "open until the next scheduled session day".
  - local_today: the one UTC->local conversion site, unknown-zone fallback.
  - is_session_expired: today >= expires_on boundary (inclusive).

Phase 191 Plan 01 (PROG-01, D-18) adds:
  - settle_weeks: the settled-streak snapshot settlement machine — empty/
    ordering/adjacency edges (Task 1), the full D-02 flame-ladder state
    machine plus the this-week/streak-lost derivations (Task 2).
"""

from __future__ import annotations

import datetime
import random

from app.models.drill_item import DrillStatus
from app.services.train_scheduler import (
    ALL_WEEKDAYS_MASK,
    LADDER_DAYS,
    MASTERY_STREAK_THRESHOLD,
    PARK_FAIL_THRESHOLD,
    FlameState,
    ItemState,
    SettledStreak,
    apply_result,
    is_session_expired,
    local_today,
    next_scheduled_day,
    required_sessions_per_week,
    session_window,
    settle_weeks,
    week_start,
)

_TODAY = datetime.date(2026, 7, 27)  # a Monday
_EVERY_DAY_MASK = 0  # D-07 identity mask

# Streak-test reference calendar (all Mondays, since _TODAY is a Monday):
#   _W0  = current week (2026-07-27), never settled
#   _W1  = last settled week   (2026-07-20)
#   _W2  = two weeks ago       (2026-07-13)
#   _W3  = three weeks ago     (2026-07-06)
_W0 = datetime.date(2026, 7, 27)
_W1 = datetime.date(2026, 7, 20)
_W2 = datetime.date(2026, 7, 13)
_W3 = datetime.date(2026, 7, 6)

_EMPTY = SettledStreak(streak_count=0, flame_state=None, settled_through=None)


def _fresh_state(due_date: datetime.date = _TODAY) -> ItemState:
    return ItemState(
        status=DrillStatus.ACTIVE, streak=0, due_date=due_date, fail_count=0, ever_correct=False
    )


class TestApplyResultCorrect:
    """Streak progression + mastery boundary (POOL-04/05)."""

    def test_fresh_item_correct_advances_to_streak_1(self) -> None:
        state = _fresh_state()
        result = apply_result(state, correct_move=True, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.streak == 1
        assert result.status == DrillStatus.ACTIVE
        assert result.ever_correct is True
        assert result.fail_count == 0
        assert result.due_date == next_scheduled_day(
            _TODAY + datetime.timedelta(days=LADDER_DAYS[1]), _EVERY_DAY_MASK
        )

    def test_streak_1_correct_advances_to_streak_2(self) -> None:
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=1, due_date=_TODAY, fail_count=0, ever_correct=True
        )
        result = apply_result(state, correct_move=True, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.streak == 2
        assert result.status == DrillStatus.ACTIVE
        assert result.due_date == next_scheduled_day(
            _TODAY + datetime.timedelta(days=LADDER_DAYS[2]), _EVERY_DAY_MASK
        )

    def test_streak_2_correct_masters_at_exactly_3(self) -> None:
        """The exact mastery boundary: streak 2 -> 3 masters; due_date is untouched."""
        original_due = datetime.date(2026, 7, 20)
        state = ItemState(
            status=DrillStatus.ACTIVE,
            streak=2,
            due_date=original_due,
            fail_count=0,
            ever_correct=True,
        )
        result = apply_result(state, correct_move=True, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.streak == MASTERY_STREAK_THRESHOLD
        assert result.status == DrillStatus.MASTERED
        assert result.due_date == original_due, "a mastered item is never re-scheduled"

    def test_correct_move_always_zeroes_fail_count_and_sets_ever_correct(self) -> None:
        """Regardless of prior fail_count, a correct solve resets fail_count=0, ever_correct=True."""
        for prior_fail_count in (0, 1, 2):
            state = ItemState(
                status=DrillStatus.ACTIVE,
                streak=0,
                due_date=_TODAY,
                fail_count=prior_fail_count,
                ever_correct=False,
            )
            result = apply_result(
                state, correct_move=True, today=_TODAY, weekday_mask=_EVERY_DAY_MASK
            )
            assert result.fail_count == 0
            assert result.ever_correct is True


class TestApplyResultWrong:
    """fail_count accrual + parking boundary (POOL-06)."""

    def test_fresh_item_wrong_resets_streak_and_accrues_one_fail(self) -> None:
        state = _fresh_state()
        result = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.streak == 0
        assert result.status == DrillStatus.ACTIVE
        assert result.fail_count == 1
        assert result.due_date == next_scheduled_day(_TODAY, _EVERY_DAY_MASK)

    def test_fail_count_2_ever_correct_false_parks_at_exactly_3(self) -> None:
        """The exact parking boundary: fail_count 2 -> 3 parks; due_date is untouched."""
        original_due = datetime.date(2026, 7, 20)
        state = ItemState(
            status=DrillStatus.ACTIVE,
            streak=0,
            due_date=original_due,
            fail_count=2,
            ever_correct=False,
        )
        result = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.fail_count == PARK_FAIL_THRESHOLD
        assert result.status == DrillStatus.PARKED
        assert result.due_date == original_due, "a parked item's due_date is never re-snapped"

    def test_fail_count_stays_2_below_park_threshold(self) -> None:
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=0, due_date=_TODAY, fail_count=1, ever_correct=False
        )
        result = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.fail_count == 2
        assert result.status == DrillStatus.ACTIVE

    def test_ever_correct_true_never_parks_regardless_of_fail_count(self) -> None:
        """Door B is a NEVER-solved counter — once ever_correct=True, fail_count never accrues."""
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=0, due_date=_TODAY, fail_count=0, ever_correct=True
        )
        result = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.fail_count == 0
        assert result.status == DrillStatus.ACTIVE
        assert result.ever_correct is True

    def test_ever_correct_true_repeated_wrong_never_accrues_or_parks(self) -> None:
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=0, due_date=_TODAY, fail_count=0, ever_correct=True
        )
        for _ in range(10):
            state = apply_result(
                state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK
            )
        assert state.fail_count == 0
        assert state.status == DrillStatus.ACTIVE


class TestApplyResultNoGuessParameter:
    def test_signature_has_no_guess_parameter(self) -> None:
        """Mastery is driven by move correctness alone — no guess/metacognition input."""
        import inspect

        params = inspect.signature(apply_result).parameters
        assert not any("guess" in name for name in params)


class TestNextScheduledDay:
    def test_zero_mask_is_identity_for_a_full_week(self) -> None:
        base = datetime.date(2026, 7, 20)
        for offset in range(7):
            d = base + datetime.timedelta(days=offset)
            assert next_scheduled_day(d, 0) == d

    def test_already_scheduled_day_returns_itself(self) -> None:
        # Tuesday=1, Friday=4 (Monday=0). 2026-07-28 is a Tuesday.
        tuesday = datetime.date(2026, 7, 28)
        assert tuesday.weekday() == 1
        mask_tue_fri = (1 << 1) | (1 << 4)
        assert next_scheduled_day(tuesday, mask_tue_fri) == tuesday

    def test_scans_forward_to_next_scheduled_weekday(self) -> None:
        # Wednesday 2026-07-29, schedule = Tue(1) + Fri(4) -> next is Friday 2026-07-31.
        wednesday = datetime.date(2026, 7, 29)
        assert wednesday.weekday() == 2
        mask_tue_fri = (1 << 1) | (1 << 4)
        assert next_scheduled_day(wednesday, mask_tue_fri) == datetime.date(2026, 7, 31)


class TestSessionWindow:
    def test_zero_mask_collapses_to_end_of_same_local_day(self) -> None:
        d = datetime.date(2026, 7, 27)
        assert session_window(d, 0) == d + datetime.timedelta(days=1)

    def test_tuesday_with_tue_fri_schedule_opens_until_friday(self) -> None:
        tuesday = datetime.date(2026, 7, 28)
        assert tuesday.weekday() == 1
        mask_tue_fri = (1 << 1) | (1 << 4)
        assert session_window(tuesday, mask_tue_fri) == datetime.date(2026, 7, 31)


class TestLocalToday:
    def test_new_york_just_after_midnight_utc_is_previous_local_day(self) -> None:
        # 2026-07-28T02:00:00Z is 2026-07-27 22:00 in America/New_York (UTC-4, DST).
        now_utc = datetime.datetime(2026, 7, 28, 2, 0, 0, tzinfo=datetime.timezone.utc)
        assert local_today("America/New_York", now_utc) == datetime.date(2026, 7, 27)

    def test_utc_timezone_matches_the_utc_date(self) -> None:
        now_utc = datetime.datetime(2026, 7, 28, 12, 0, 0, tzinfo=datetime.timezone.utc)
        assert local_today("UTC", now_utc) == datetime.date(2026, 7, 28)

    def test_unrecognised_zone_falls_back_to_utc_without_raising(self) -> None:
        now_utc = datetime.datetime(2026, 7, 28, 12, 0, 0, tzinfo=datetime.timezone.utc)
        result = local_today("Not/AZone", now_utc)
        assert result == datetime.date(2026, 7, 28)


class TestIsSessionExpired:
    def test_today_before_expiry_is_not_expired(self) -> None:
        expires_on = datetime.date(2026, 7, 31)
        assert is_session_expired(expires_on, datetime.date(2026, 7, 30)) is False

    def test_today_equal_to_expiry_is_expired(self) -> None:
        expires_on = datetime.date(2026, 7, 31)
        assert is_session_expired(expires_on, expires_on) is True

    def test_today_after_expiry_is_expired(self) -> None:
        expires_on = datetime.date(2026, 7, 31)
        assert is_session_expired(expires_on, datetime.date(2026, 8, 1)) is True


class TestWeekStart:
    def test_week_start_is_the_monday_of_the_week(self) -> None:
        # 2026-07-27 is a Monday, 2026-07-30 (Thursday) and 2026-08-02 (Sunday)
        # both belong to the same Mon-Sun week.
        assert week_start(datetime.date(2026, 7, 27)) == _W0
        assert week_start(datetime.date(2026, 7, 30)) == _W0
        assert week_start(datetime.date(2026, 8, 2)) == _W0

    def test_week_start_of_a_monday_is_itself(self) -> None:
        assert week_start(_W1) == _W1


class TestRequiredSessionsPerWeek:
    def test_zero_mask_requires_exactly_one_session(self) -> None:
        assert required_sessions_per_week(0) == 1

    def test_all_weekdays_mask_also_requires_exactly_one_session(self) -> None:
        # 191-06: ALL_WEEKDAYS_MASK (the new brand-new-row default, every
        # chip checked) must resolve identically to the D-07 empty mask —
        # both mean "no specific-day preference", not "commit to 7/week".
        assert required_sessions_per_week(ALL_WEEKDAYS_MASK) == 1

    def test_mask_popcount_is_the_requirement_regardless_of_which_days(self) -> None:
        # Mon+Wed+Fri = bits 0, 2, 4.
        mask = (1 << 0) | (1 << 2) | (1 << 4)
        assert required_sessions_per_week(mask) == 3


class TestSettleWeeksEmptyOrderingAdjacency:
    """Task 1 <behavior> cases: PROG-01 empty/ordering/adjacency edges + D-18
    idempotence/frozen-week guards, from an EMPTY snapshot."""

    def test_empty_snapshot_no_sessions_is_a_pure_noop(self) -> None:
        view = settle_weeks(_EMPTY, [], weekday_mask=_EVERY_DAY_MASK, today=_TODAY)
        assert view.settled == _EMPTY
        assert view.current_week_completed == 0
        assert view.streak_lost_last_week is False
        assert view.changed is False

    def test_empty_snapshot_only_current_week_sessions_stays_unsettled(self) -> None:
        view = settle_weeks(_EMPTY, [_W0, _W0], weekday_mask=_EVERY_DAY_MASK, today=_TODAY)
        assert view.settled == _EMPTY
        assert view.changed is False
        assert view.display_flame == FlameState.MINIMUM
        assert view.current_week_completed == 2

    def test_empty_snapshot_one_fulfilled_settled_week(self) -> None:
        view = settle_weeks(_EMPTY, [_W1], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 1
        assert view.settled.flame_state == FlameState.MINIMUM
        assert view.settled.settled_through == _W1
        assert view.changed is True

    def test_empty_snapshot_two_consecutive_fulfilled_settled_weeks(self) -> None:
        view = settle_weeks(_EMPTY, [_W2, _W1], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 2
        assert view.settled.flame_state == FlameState.MEDIUM
        assert view.settled.settled_through == _W1

    def test_empty_snapshot_fulfilled_then_missed_settled_week(self) -> None:
        # Only W2 has a session; W1 is a zero-activity settled gap week.
        view = settle_weeks(_EMPTY, [_W2], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 0
        assert view.settled.flame_state is None
        assert view.streak_lost_last_week is True

    def test_three_bit_mask_two_sessions_is_a_missed_week(self) -> None:
        mask = (1 << 0) | (1 << 2) | (1 << 4)  # Mon+Wed+Fri, required=3
        view = settle_weeks(
            _EMPTY,
            [_W1, _W1 + datetime.timedelta(days=1)],
            weekday_mask=mask,
            today=_TODAY,
        )
        assert view.settled.streak_count == 0
        assert view.settled.flame_state is None

    def test_already_settled_snapshot_same_sessions_is_idempotent(self) -> None:
        settled = SettledStreak(streak_count=2, flame_state=FlameState.MEDIUM, settled_through=_W1)
        view = settle_weeks(settled, [_W2, _W1], weekday_mask=0, today=_TODAY)
        assert view.settled == settled
        assert view.changed is False

    def test_already_settled_snapshot_frozen_against_a_later_mask_change(self) -> None:
        """D-18: a settled week's judgment survives a subsequent weekday_mask change."""
        settled = SettledStreak(streak_count=2, flame_state=FlameState.MEDIUM, settled_through=_W1)
        three_bit_mask = (1 << 0) | (1 << 2) | (1 << 4)
        view = settle_weeks(settled, [_W2, _W1], weekday_mask=three_bit_mask, today=_TODAY)
        assert view.settled.streak_count == settled.streak_count
        assert view.settled.flame_state == settled.flame_state
        assert view.changed is False


class TestSettleWeeksFlameLadderAndEdges:
    """Task 2 <behavior> cases: the full D-02 flame-ladder state machine plus
    the this-week/streak-lost derivations and remaining PROG-01 edges."""

    def test_maximum_flame_one_missed_week_drops_to_medium(self) -> None:
        settled = SettledStreak(streak_count=5, flame_state=FlameState.MAXIMUM, settled_through=_W2)
        view = settle_weeks(settled, [], weekday_mask=0, today=_TODAY)
        assert view.settled.flame_state == FlameState.MEDIUM
        assert view.settled.streak_count == 5
        assert view.streak_lost_last_week is False

    def test_maximum_flame_two_consecutive_missed_weeks_absorbed_to_minimum(self) -> None:
        settled = SettledStreak(streak_count=5, flame_state=FlameState.MAXIMUM, settled_through=_W3)
        view = settle_weeks(settled, [], weekday_mask=0, today=_TODAY)
        assert view.settled.flame_state == FlameState.MINIMUM
        assert view.settled.streak_count == 5

    def test_maximum_flame_three_consecutive_missed_weeks_loses_the_streak(self) -> None:
        w4 = _W3 - datetime.timedelta(days=7)
        settled = SettledStreak(streak_count=5, flame_state=FlameState.MAXIMUM, settled_through=w4)
        # w4 (a fully-elapsed past session) is only here to satisfy the
        # "at least one session predates current_start" clause of
        # streak_lost_last_week — it plays no role in the settlement walk
        # itself (which only ever starts at settled_through + 7).
        view = settle_weeks(settled, [w4], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 0
        assert view.settled.flame_state is None
        assert view.streak_lost_last_week is True

    def test_three_consecutive_fulfilled_weeks_reach_maximum_then_cap(self) -> None:
        first = settle_weeks(_EMPTY, [_W3, _W2, _W1], weekday_mask=0, today=_TODAY)
        assert first.settled.streak_count == 3
        assert first.settled.flame_state == FlameState.MAXIMUM

        # A fourth fulfilled week (today advanced one week further): flame
        # stays capped at MAXIMUM even though the streak keeps incrementing.
        today_plus_one_week = _TODAY + datetime.timedelta(days=7)
        second = settle_weeks(first.settled, [_W0], weekday_mask=0, today=today_plus_one_week)
        assert second.settled.streak_count == 4
        assert second.settled.flame_state == FlameState.MAXIMUM

    def test_missed_week_while_already_unlit_changes_nothing(self) -> None:
        settled = SettledStreak(streak_count=0, flame_state=None, settled_through=_W2)
        view = settle_weeks(settled, [], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 0
        assert view.settled.flame_state is None
        assert view.streak_lost_last_week is False

    def test_streak_lost_two_weeks_ago_then_fulfilled_clears_the_notice(self) -> None:
        # W3 fulfilled (lights the flame), W2 missed at minimum (loses the
        # streak), W1 fulfilled again (a fresh streak starts).
        view = settle_weeks(_EMPTY, [_W3, _W1], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 1
        assert view.settled.flame_state == FlameState.MINIMUM
        assert view.streak_lost_last_week is False

    def test_streak_lost_last_week_survives_a_second_no_op_read(self) -> None:
        # W2 fulfilled (lights the flame), W1 missed at minimum (loses it).
        first = settle_weeks(_EMPTY, [_W2], weekday_mask=0, today=_TODAY)
        assert first.settled.streak_count == 0
        assert first.settled.flame_state is None
        assert first.streak_lost_last_week is True

        # A second read with the SAME session list settles nothing new
        # (changed=False) — the notice must survive the reload, not flash
        # once and disappear.
        second = settle_weeks(first.settled, [_W2], weekday_mask=0, today=_TODAY)
        assert second.changed is False
        assert second.streak_lost_last_week is True

    def test_streak_lost_last_week_clears_once_the_user_trains_again(self) -> None:
        lost = settle_weeks(_EMPTY, [_W2], weekday_mask=0, today=_TODAY).settled
        assert lost.flame_state is None

        view = settle_weeks(lost, [_W2, _W0], weekday_mask=0, today=_TODAY)
        assert view.streak_lost_last_week is False
        assert view.display_flame == FlameState.MINIMUM

    def test_zero_activity_gap_week_between_two_active_weeks_is_missed(self) -> None:
        # W3 fulfilled, W2 has NO session (a gap week — must still be
        # walked and judged missed, not silently skipped), W1 fulfilled
        # again. If the gap week were skipped the result would be
        # streak_count=2/flame=MEDIUM instead of a reset-then-relit
        # streak_count=1/flame=MINIMUM.
        view = settle_weeks(_EMPTY, [_W3, _W1], weekday_mask=0, today=_TODAY)
        assert view.settled.streak_count == 1
        assert view.settled.flame_state == FlameState.MINIMUM

    def test_shuffled_input_equals_sorted_input(self) -> None:
        dates = [_W3, _W3, _W2, _W1]
        shuffled = list(dates)
        for seed in range(10):
            random.Random(f"settle_weeks-ordering-edge-{seed}").shuffle(shuffled)
            if shuffled != dates:
                break
        assert shuffled != dates  # the shuffle must actually reorder something

        sorted_view = settle_weeks(_EMPTY, sorted(dates), weekday_mask=0, today=_TODAY)
        shuffled_view = settle_weeks(_EMPTY, shuffled, weekday_mask=0, today=_TODAY)
        assert shuffled_view == sorted_view

    def test_sunday_settles_while_this_monday_is_current(self) -> None:
        # The Sunday closing out W1's week (2026-07-26) settles into W1;
        # a session dated this Monday (_W0, 2026-07-27) is the CURRENT week
        # when "today" is later in that same week (Wednesday 2026-07-29).
        last_sunday = _W1 + datetime.timedelta(days=6)
        today_wednesday = _W0 + datetime.timedelta(days=2)
        view = settle_weeks(_EMPTY, [last_sunday, _W0], weekday_mask=0, today=today_wednesday)
        assert view.settled.streak_count == 1
        assert view.settled.settled_through == _W1
        assert view.current_week_completed == 1

    def test_zero_mask_one_session_fulfils_zero_sessions_misses(self) -> None:
        fulfilled = settle_weeks(_EMPTY, [_W1], weekday_mask=0, today=_TODAY)
        assert fulfilled.settled.streak_count == 1

        missed = settle_weeks(_EMPTY, [], weekday_mask=0, today=_TODAY)
        # No sessions at all means nothing to settle (min() has no input) —
        # confirm this is a true no-op, not an accidental "missed" judgment.
        assert missed.changed is False
        assert missed.settled.streak_count == 0

    def test_three_bit_mask_three_arbitrary_days_fulfils_two_does_not(self) -> None:
        mask = (1 << 0) | (1 << 2) | (1 << 4)  # Mon+Wed+Fri, required=3
        three_arbitrary_days = [
            _W1,
            _W1 + datetime.timedelta(days=2),
            _W1 + datetime.timedelta(days=5),
        ]
        fulfilled = settle_weeks(_EMPTY, three_arbitrary_days, weekday_mask=mask, today=_TODAY)
        assert fulfilled.settled.streak_count == 1

        two_of_the_same_days = three_arbitrary_days[:2]
        missed = settle_weeks(_EMPTY, two_of_the_same_days, weekday_mask=mask, today=_TODAY)
        assert missed.settled.streak_count == 0
        assert missed.settled.flame_state is None

    def test_fully_settled_snapshot_ignores_mask_regardless_of_value(self) -> None:
        """The pure-function half of the D-18 frozen-week guarantee: a
        snapshot whose settled_through already covers every elapsed week
        returns changed=False and an identical settled dataclass no matter
        what weekday_mask is passed."""
        settled = SettledStreak(streak_count=4, flame_state=FlameState.MEDIUM, settled_through=_W1)
        five_bit_mask = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4)

        view_zero_mask = settle_weeks(settled, [], weekday_mask=0, today=_TODAY)
        view_five_bit_mask = settle_weeks(settled, [], weekday_mask=five_bit_mask, today=_TODAY)

        assert view_zero_mask.changed is False
        assert view_five_bit_mask.changed is False
        assert view_zero_mask.settled == settled
        assert view_five_bit_mask.settled == settled
