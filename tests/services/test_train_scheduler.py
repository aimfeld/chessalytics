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
"""

from __future__ import annotations

import datetime

from app.models.drill_item import DrillStatus
from app.services.train_scheduler import (
    LADDER_DAYS,
    MASTERY_STREAK_THRESHOLD,
    PARK_FAIL_THRESHOLD,
    ItemState,
    apply_result,
    is_session_expired,
    local_today,
    next_scheduled_day,
    session_window,
)

_TODAY = datetime.date(2026, 7, 27)  # a Monday
_EVERY_DAY_MASK = 0  # D-07 identity mask


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
