"""Unit tests for app.services.train_scheduler — pure interval-ladder scheduler.

Phase 189 Plan 01 Task 2 (POOL-04/05/06). No DB fixture — every function under
test is pure (plain `datetime.date`/`int`/`bool` in, plain values out). Mirrors
tests/services/test_eval_utils.py's shape: direct import, plain asserts,
table-driven parametrized cases over the boundary conditions.

Covers:
  - apply_result: correct-move streak progression 0->1->2->MASTERED(3),
    fail_count as a lifetime lapse counter never reset by a correct solve
    (SEED-154), PARKED via Door A (never-solved, 3 lifetime lapses) or Door B
    (6 lifetime lapses regardless of ever_correct), due-date snapping via
    next_scheduled_day.
  - next_scheduled_day: identity on weekday_mask=0, identity when `after` is
    already on a scheduled weekday, forward scan otherwise.
  - session_window: D-10 "open until the next scheduled session day".
  - local_today: the one UTC->local conversion site, unknown-zone fallback.
  - is_session_expired: today >= expires_on boundary (inclusive).

Phase 193 (PROG-01, SEED-121) replaces Phase 191's weekly settlement machine
(the deleted 3-state flame enum + its week-bucketed settle function) with a
per-scheduled-day tick + a 0-7 depletable shield:
  - is_scheduled_day / scheduled_days_per_week: the two small pure helpers.
  - _judge_one_day: the shared arithmetic primitive (neutral/fulfilled/
    missed/credit_only), including the SHIELD_CAP clamp-parity gate.
  - tick_days: the day-walk, including the sparse-mask elapsed-day boundary
    (RESEARCH.md Pitfall 1 — the phase's single highest-risk correctness
    finding), the frozen-forever guarantee, the D-06 watermark, and the
    streak_reset_notice derivation.
"""

from __future__ import annotations

import datetime
import random

from app.models.drill_item import DrillStatus
from app.services.train_scheduler import (
    ALL_WEEKDAYS_MASK,
    LADDER_DAYS,
    LEECH_FAIL_THRESHOLD,
    MASTERY_STREAK_THRESHOLD,
    PARK_FAIL_THRESHOLD,
    SHIELD_CAP,
    ItemState,
    TickSnapshot,
    _judge_one_day,
    apply_result,
    is_scheduled_day,
    is_session_expired,
    local_hour,
    local_today,
    next_scheduled_day,
    scheduled_days_per_week,
    seconds_until_end_of_local_day,
    session_window,
    tick_days,
    week_start,
)

_TODAY = datetime.date(2026, 7, 27)  # a Monday
_EVERY_DAY_MASK = 0  # D-07 identity mask

# Streak-test reference calendar (all Mondays, since _TODAY is a Monday):
#   _W0  = current week (2026-07-27)
#   _W1  = last week    (2026-07-20)
#   _W2  = two weeks ago (2026-07-13)
_W0 = datetime.date(2026, 7, 27)
_W1 = datetime.date(2026, 7, 20)
_W2 = datetime.date(2026, 7, 13)

# Two arbitrary reference days for the pure _judge_one_day tests (no
# particular weekday relationship required — the function does no mask
# math itself).
_D0 = datetime.date(2026, 7, 20)
_D1 = datetime.date(2026, 7, 27)

_EMPTY_TICK = TickSnapshot(streak_count=0, shield_level=0, settled_through=None)


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

    def test_correct_move_preserves_fail_count_and_sets_ever_correct(self) -> None:
        """SEED-154: fail_count is a lifetime lapse counter — a correct solve
        never resets it, only ever_correct flips to True."""
        for prior_fail_count in (0, 1, 2, 5):
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
            assert result.fail_count == prior_fail_count
            assert result.ever_correct is True

    def test_five_lapses_then_three_in_a_row_masters_not_parks(self) -> None:
        """SEED-154: an item the SR system is successfully teaching is not
        retired — 5 lifetime lapses followed by 3 consecutive correct solves
        reaches MASTERED with the lapse count preserved, never PARKED."""
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=0, due_date=_TODAY, fail_count=5, ever_correct=True
        )
        for _ in range(MASTERY_STREAK_THRESHOLD):
            state = apply_result(state, correct_move=True, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert state.status == DrillStatus.MASTERED
        assert state.fail_count == 5


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

    def test_ever_correct_true_now_accrues_a_lapse(self) -> None:
        """SEED-154: fail_count accrues unconditionally now — ever_correct no
        longer gates the increment, only which park door can fire."""
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=0, due_date=_TODAY, fail_count=0, ever_correct=True
        )
        result = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.fail_count == 1
        assert result.status == DrillStatus.ACTIVE
        assert result.ever_correct is True

    def test_ever_correct_true_repeated_wrong_parks_at_leech_threshold(self) -> None:
        """SEED-154 Door B: once ever_correct is True, Door A can never fire,
        but repeated wrong solves still park the item at LEECH_FAIL_THRESHOLD."""
        state = ItemState(
            status=DrillStatus.ACTIVE, streak=0, due_date=_TODAY, fail_count=0, ever_correct=True
        )
        for attempt in range(1, 11):
            state = apply_result(
                state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK
            )
            if attempt < LEECH_FAIL_THRESHOLD:
                assert state.status == DrillStatus.ACTIVE, f"parked too early at attempt {attempt}"
            else:
                assert state.status == DrillStatus.PARKED, (
                    f"must have parked by attempt {attempt}"
                )
                break
        assert state.status == DrillStatus.PARKED
        assert state.fail_count == LEECH_FAIL_THRESHOLD
        assert state.ever_correct is True

    def test_never_solved_still_parks_at_door_a(self) -> None:
        """Door A regression guard: three wrong solves from a fresh state
        still park at exactly PARK_FAIL_THRESHOLD with ever_correct False."""
        assert PARK_FAIL_THRESHOLD < LEECH_FAIL_THRESHOLD, (
            "Door A must fire strictly before Door B, or a future threshold "
            "edit could invert the doors silently"
        )
        state = _fresh_state()
        for _ in range(PARK_FAIL_THRESHOLD):
            state = apply_result(
                state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK
            )
        assert state.status == DrillStatus.PARKED
        assert state.fail_count == PARK_FAIL_THRESHOLD
        assert state.ever_correct is False

    def test_lapse_count_survives_a_correct_answer(self) -> None:
        """wrong, wrong, correct, wrong from a fresh state leaves lapse count
        3 and status ACTIVE — Door A cannot fire once ever_correct is True,
        and Door B needs 6."""
        state = _fresh_state()
        state = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        state = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        state = apply_result(state, correct_move=True, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        state = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert state.fail_count == 3
        assert state.status == DrillStatus.ACTIVE
        assert state.ever_correct is True

    def test_leech_park_preserves_ever_correct_true(self) -> None:
        """SEED-154 silent-corruption guard: the PARKED return must propagate
        ever_correct from the incoming state, not hardcode False — Door B can
        fire on an item that HAS been solved."""
        original_due = datetime.date(2026, 7, 20)
        state = ItemState(
            status=DrillStatus.ACTIVE,
            streak=0,
            due_date=original_due,
            fail_count=LEECH_FAIL_THRESHOLD - 1,
            ever_correct=True,
        )
        result = apply_result(state, correct_move=False, today=_TODAY, weekday_mask=_EVERY_DAY_MASK)
        assert result.status == DrillStatus.PARKED
        assert result.fail_count == LEECH_FAIL_THRESHOLD
        assert result.ever_correct is True
        assert result.due_date == original_due


class TestApplyResultAlternatingLeech:
    """SEED-154's motivating case: an item alternately solved and failed must
    still eventually leave the pool via Door B."""

    def test_alternating_solve_and_fail_eventually_parks(self) -> None:
        state = _fresh_state()
        # Strict alternation: correct, wrong, correct, wrong, ... The streak
        # never reaches MASTERY_STREAK_THRESHOLD (capped at 1 by alternation),
        # so the only way out is Door B at LEECH_FAIL_THRESHOLD lifetime lapses.
        wrong_count = 0
        for attempt in range(1, 13):
            correct_move = attempt % 2 == 1
            state = apply_result(
                state, correct_move=correct_move, today=_TODAY, weekday_mask=_EVERY_DAY_MASK
            )
            assert state.status != DrillStatus.MASTERED, (
                f"alternation must never reach MASTERED (attempt {attempt})"
            )
            if not correct_move:
                wrong_count += 1
                if wrong_count >= LEECH_FAIL_THRESHOLD:
                    assert state.status == DrillStatus.PARKED
                    break
                assert state.status == DrillStatus.ACTIVE
        assert state.status == DrillStatus.PARKED
        assert wrong_count == LEECH_FAIL_THRESHOLD


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


class TestLocalHour:
    """local_hour: the companion UTC->local-hour conversion (Phase 201, REMIND-02).

    The three fractional-offset zones are exactly what REMIND-02's >=15-minute
    tick exists to serve -- a coarser tick could skip a user's hour entirely.
    """

    def test_local_hour_kolkata_plus_5_30_offset(self) -> None:
        now_utc = datetime.datetime(2026, 7, 28, 10, 0, 0, tzinfo=datetime.timezone.utc)
        assert local_hour("Asia/Kolkata", now_utc) == 15

    def test_local_hour_kathmandu_plus_5_45_offset(self) -> None:
        now_utc = datetime.datetime(2026, 7, 28, 10, 0, 0, tzinfo=datetime.timezone.utc)
        assert local_hour("Asia/Kathmandu", now_utc) == 15

    def test_local_hour_chatham_plus_12_45_offset(self) -> None:
        # Winter (no NZ DST) so Chatham sits at the plain +12:45 standard offset.
        now_utc = datetime.datetime(2026, 7, 28, 10, 0, 0, tzinfo=datetime.timezone.utc)
        assert local_hour("Pacific/Chatham", now_utc) == 22

    def test_local_hour_unrecognised_zone_falls_back_to_utc_without_raising(self) -> None:
        now_utc = datetime.datetime(2026, 7, 28, 12, 0, 0, tzinfo=datetime.timezone.utc)
        assert local_hour("Not/AZone", now_utc) == 12


class TestSecondsUntilEndOfLocalDay:
    """seconds_until_end_of_local_day: Phase 204 D-01/D-03. The push TTL bound.

    No floor, no cap -- a near-end-of-day instant returning a small exact
    count IS the no-floor proof (a hardcoded minimum would fail these).
    """

    def test_seconds_until_end_of_local_day_mid_day_kolkata_plus_5_30_offset_exact_count(
        self,
    ) -> None:
        # 2026-07-28T10:00:00Z is 2026-07-28 15:30:00 in Asia/Kolkata (+05:30).
        # 23:59:59 - 15:30:00 = 8:29:59 = 30599 seconds.
        now_utc = datetime.datetime(2026, 7, 28, 10, 0, 0, tzinfo=datetime.timezone.utc)
        assert seconds_until_end_of_local_day("Asia/Kolkata", now_utc) == 30599

    def test_seconds_until_end_of_local_day_near_end_of_day_utc_small_exact_count_no_floor(
        self,
    ) -> None:
        # 23:52:00 local -> 23:59:59 - 23:52:00 = 0:07:59 = 479 seconds. A
        # small exact number under 1000, never a clamped minimum.
        now_utc = datetime.datetime(2026, 7, 28, 23, 52, 0, tzinfo=datetime.timezone.utc)
        assert seconds_until_end_of_local_day("UTC", now_utc) == 479

    def test_seconds_until_end_of_local_day_fractional_offset_kathmandu_plus_5_45_uses_local_conversion(
        self,
    ) -> None:
        # 2026-07-28T10:00:00Z is 2026-07-28 15:45:00 in Asia/Kathmandu (+05:45).
        # 23:59:59 - 15:45:00 = 8:14:59 = 29699 seconds. A UTC-only
        # implementation (Pitfall: skipping astimezone) would instead compute
        # against 10:00:00, giving a different (wrong) result.
        now_utc = datetime.datetime(2026, 7, 28, 10, 0, 0, tzinfo=datetime.timezone.utc)
        assert seconds_until_end_of_local_day("Asia/Kathmandu", now_utc) == 29699

    def test_seconds_until_end_of_local_day_unrecognised_zone_falls_back_to_default_timezone(
        self,
    ) -> None:
        # DEFAULT_TIMEZONE is "UTC". 23:59:59 - 12:00:00 = 11:59:59 = 43199s.
        now_utc = datetime.datetime(2026, 7, 28, 12, 0, 0, tzinfo=datetime.timezone.utc)
        assert seconds_until_end_of_local_day("Not/AZone", now_utc) == 43199


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


class TestIsScheduledDay:
    def test_zero_mask_every_day_is_scheduled(self) -> None:
        monday = datetime.date(2026, 7, 27)
        for offset in range(7):
            assert is_scheduled_day(monday + datetime.timedelta(days=offset), 0) is True

    def test_mirrors_the_weekday_bit_test(self) -> None:
        # Mon+Wed+Fri = bits 0, 2, 4.
        mask = (1 << 0) | (1 << 2) | (1 << 4)
        monday = datetime.date(2026, 7, 27)
        tuesday = monday + datetime.timedelta(days=1)
        wednesday = monday + datetime.timedelta(days=2)
        assert is_scheduled_day(monday, mask) is True
        assert is_scheduled_day(tuesday, mask) is False
        assert is_scheduled_day(wednesday, mask) is True


class TestScheduledDaysPerWeek:
    def test_zero_mask_returns_none(self) -> None:
        assert scheduled_days_per_week(0) is None

    def test_all_weekdays_mask_returns_seven(self) -> None:
        # Unlike the deleted required_sessions_per_week, ALL_WEEKDAYS_MASK is
        # NOT special-cased down to 1 any more — nothing gates on this value
        # any more (the weekly-fulfillment requirement is deleted).
        assert scheduled_days_per_week(ALL_WEEKDAYS_MASK) == 7

    def test_popcount_for_an_arbitrary_mask(self) -> None:
        mask = (1 << 0) | (1 << 2) | (1 << 4)  # Mon+Wed+Fri
        assert scheduled_days_per_week(mask) == 3


class TestJudgeOneDay:
    """The shared arithmetic primitive — every shield/count transition in
    the whole app/ tree happens here, and only here."""

    def test_neutral_changes_neither_count_nor_shield_but_advances_settled_through(self) -> None:
        snapshot = TickSnapshot(streak_count=9, shield_level=4, settled_through=_D0)
        result = _judge_one_day(snapshot, day=_D1, outcome="neutral")
        assert result.streak_count == 9
        assert result.shield_level == 4
        assert result.settled_through == _D1

    def test_fulfilled_increments_count_and_shield_and_advances_settled_through(self) -> None:
        snapshot = TickSnapshot(streak_count=9, shield_level=4, settled_through=_D0)
        result = _judge_one_day(snapshot, day=_D1, outcome="fulfilled")
        assert result.streak_count == 10
        assert result.shield_level == 5
        assert result.settled_through == _D1

    def test_fulfilled_at_shield_cap_stays_capped_but_count_still_increments(self) -> None:
        snapshot = TickSnapshot(streak_count=40, shield_level=SHIELD_CAP, settled_through=_D0)
        result = _judge_one_day(snapshot, day=_D1, outcome="fulfilled")
        assert result.shield_level == SHIELD_CAP
        assert result.streak_count == 41
        assert result.settled_through == _D1

    def test_missed_drains_one_pip_floored_at_zero_and_resets_count_at_zero(self) -> None:
        absorbed = _judge_one_day(
            TickSnapshot(streak_count=17, shield_level=1, settled_through=_D0),
            day=_D1,
            outcome="missed",
        )
        assert absorbed.shield_level == 0
        assert absorbed.streak_count == 0

        frozen_count = _judge_one_day(
            TickSnapshot(streak_count=17, shield_level=3, settled_through=_D0),
            day=_D1,
            outcome="missed",
        )
        assert frozen_count.shield_level == 2
        assert frozen_count.streak_count == 17

    def test_missed_at_zero_shield_and_zero_count_is_a_no_op_on_both_values(self) -> None:
        snapshot = TickSnapshot(streak_count=0, shield_level=0, settled_through=_D0)
        result = _judge_one_day(snapshot, day=_D1, outcome="missed")
        assert result.shield_level == 0
        assert result.streak_count == 0
        assert result.settled_through == _D1

    def test_credit_only_raises_shield_but_leaves_count_and_settled_through_untouched(self) -> None:
        snapshot = TickSnapshot(streak_count=40, shield_level=3, settled_through=_D0)
        result = _judge_one_day(snapshot, day=_D1, outcome="credit_only")
        assert result.shield_level == 4
        assert result.streak_count == 40
        assert result.settled_through == _D0, "credit_only must never move the settled boundary"

    def test_credit_only_and_fulfilled_clamp_identically_at_the_cap(self) -> None:
        base_at_six = TickSnapshot(streak_count=0, shield_level=SHIELD_CAP - 1, settled_through=_D0)
        base_at_cap = TickSnapshot(streak_count=0, shield_level=SHIELD_CAP, settled_through=_D0)

        assert (
            _judge_one_day(base_at_six, day=_D1, outcome="credit_only").shield_level == SHIELD_CAP
        )
        assert _judge_one_day(base_at_six, day=_D1, outcome="fulfilled").shield_level == SHIELD_CAP
        assert (
            _judge_one_day(base_at_cap, day=_D1, outcome="credit_only").shield_level == SHIELD_CAP
        )
        assert _judge_one_day(base_at_cap, day=_D1, outcome="fulfilled").shield_level == SHIELD_CAP


class TestTickDays:
    """The day-walk: elapsed-day boundary, frozen-forever guarantee, D-06
    watermark, and no-op behavior."""

    def test_empty_snapshot_no_sessions_is_a_pure_noop(self) -> None:
        view = tick_days(
            _EMPTY_TICK, [], weekday_mask=_EVERY_DAY_MASK, today=_TODAY, pool_eligible_since=None
        )
        assert view.settled == _EMPTY_TICK
        assert view.current_week_completed == 0
        assert view.streak_reset_notice is False
        assert view.changed is False

    def test_no_op_when_nothing_has_elapsed_yet(self) -> None:
        snapshot = TickSnapshot(streak_count=5, shield_level=6, settled_through=_TODAY)
        view = tick_days(snapshot, [], weekday_mask=0, today=_TODAY, pool_eligible_since=_TODAY)
        assert view.changed is False
        assert view.settled == snapshot

    def test_never_walks_a_day_at_or_before_settled_through(self) -> None:
        """Frozen forever: a 'completed' session dated ON the already-settled
        day must never be re-judged, even though it would otherwise look
        fulfilled."""
        frozen_day = _TODAY - datetime.timedelta(days=5)
        snapshot = TickSnapshot(streak_count=2, shield_level=3, settled_through=frozen_day)
        view = tick_days(
            snapshot,
            [frozen_day],
            weekday_mask=0,
            today=frozen_day + datetime.timedelta(days=1),
            pool_eligible_since=frozen_day,
        )
        assert view.changed is False
        assert view.settled == snapshot

    def test_none_watermark_judges_every_walked_day_neutral(self) -> None:
        snapshot = TickSnapshot(
            streak_count=3, shield_level=4, settled_through=_TODAY - datetime.timedelta(days=2)
        )
        # This date would look "fulfilled" if the walk were eligible — it
        # is not, since pool_eligible_since is None.
        completed = [_TODAY - datetime.timedelta(days=1)]
        view = tick_days(
            snapshot, completed, weekday_mask=0, today=_TODAY, pool_eligible_since=None
        )
        assert view.settled.streak_count == 3
        assert view.settled.shield_level == 4
        assert view.changed is True
        assert view.settled.settled_through == _TODAY - datetime.timedelta(days=1)

    def test_watermark_neutral_strictly_before_judged_on_or_after(self) -> None:
        watermark = _TODAY - datetime.timedelta(days=1)
        snapshot = TickSnapshot(
            streak_count=0,
            shield_level=SHIELD_CAP,
            settled_through=_TODAY - datetime.timedelta(days=3),
        )
        view = tick_days(snapshot, [], weekday_mask=0, today=_TODAY, pool_eligible_since=watermark)
        # Two days walked: _TODAY-2 (before watermark -> neutral, no drain)
        # and _TODAY-1 (on watermark -> missed, drains exactly one pip).
        assert view.settled.shield_level == SHIELD_CAP - 1
        assert view.settled.settled_through == _TODAY - datetime.timedelta(days=1)

    def test_sparse_mask_boundary_not_judged_before_window_closes(self) -> None:
        """RESEARCH.md Pitfall 1 — THE highest-risk correctness case. Under a
        Mon/Wed/Fri mask, a Monday scheduled day must NOT be judged on
        Tuesday (its window is still open until Wednesday)."""
        mask = 0b0010101  # Mon(0) + Wed(2) + Fri(4)
        prior_friday = _TODAY - datetime.timedelta(days=3)  # 2026-07-24
        tuesday = _TODAY + datetime.timedelta(days=1)  # 2026-07-28
        snapshot = TickSnapshot(streak_count=1, shield_level=4, settled_through=prior_friday)
        view = tick_days(
            snapshot, [], weekday_mask=mask, today=tuesday, pool_eligible_since=prior_friday
        )
        assert view.changed is False
        assert view.settled == snapshot

    def test_sparse_mask_boundary_judged_once_window_closes(self) -> None:
        """Sibling of the case above: on Wednesday, the Monday's window HAS
        closed and it drains by exactly one pip — no more."""
        mask = 0b0010101  # Mon(0) + Wed(2) + Fri(4)
        prior_friday = _TODAY - datetime.timedelta(days=3)  # 2026-07-24
        wednesday = _TODAY + datetime.timedelta(days=2)  # 2026-07-29
        snapshot = TickSnapshot(streak_count=1, shield_level=4, settled_through=prior_friday)
        view = tick_days(
            snapshot, [], weekday_mask=mask, today=wednesday, pool_eligible_since=prior_friday
        )
        assert view.changed is True
        assert view.settled.shield_level == 3
        assert view.settled.settled_through == _TODAY  # the Monday, judged missed

    def test_shuffled_completed_dates_equal_sorted_input(self) -> None:
        dates = [_W2, _W1, _W0]
        shuffled = list(dates)
        for seed in range(10):
            random.Random(f"tick-days-ordering-edge-{seed}").shuffle(shuffled)
            if shuffled != dates:
                break
        assert shuffled != dates  # the shuffle must actually reorder something

        sorted_view = tick_days(
            _EMPTY_TICK, sorted(dates), weekday_mask=0, today=_TODAY, pool_eligible_since=_W2
        )
        shuffled_view = tick_days(
            _EMPTY_TICK, shuffled, weekday_mask=0, today=_TODAY, pool_eligible_since=_W2
        )
        assert shuffled_view == sorted_view


class TestTickDaysStreakResetNotice:
    def test_true_only_when_shield_and_count_are_zero_and_history_exists(self) -> None:
        snapshot = TickSnapshot(
            streak_count=0, shield_level=1, settled_through=_TODAY - datetime.timedelta(days=2)
        )
        # History exists (len > 0) but is unrelated to the walked day, so
        # the walked day still resolves "missed".
        completed = [_TODAY - datetime.timedelta(days=10)]
        view = tick_days(
            snapshot,
            completed,
            weekday_mask=0,
            today=_TODAY,
            pool_eligible_since=_TODAY - datetime.timedelta(days=10),
        )
        assert view.settled.shield_level == 0
        assert view.settled.streak_count == 0
        assert view.streak_reset_notice is True

    def test_false_when_shield_and_count_are_zero_but_no_history(self) -> None:
        snapshot = TickSnapshot(streak_count=0, shield_level=0, settled_through=_TODAY)
        view = tick_days(snapshot, [], weekday_mask=0, today=_TODAY, pool_eligible_since=_TODAY)
        assert view.streak_reset_notice is False

    def test_false_when_shield_is_nonzero(self) -> None:
        snapshot = TickSnapshot(streak_count=0, shield_level=2, settled_through=_TODAY)
        view = tick_days(
            snapshot,
            [_TODAY - datetime.timedelta(days=1)],
            weekday_mask=0,
            today=_TODAY,
            pool_eligible_since=_TODAY,
        )
        assert view.streak_reset_notice is False
