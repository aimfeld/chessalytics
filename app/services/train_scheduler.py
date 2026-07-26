"""Pure interval-ladder scheduler for Train (Phase 189).

No I/O, no DB, stdlib only. Every function here is a pure transform over
plain `datetime.date`/`int`/`bool` values — no SQLAlchemy, no session, no
network. Fully unit-testable in isolation; see
tests/services/test_train_scheduler.py.

Phase 189 Plan 01 adds the constants and the two day-boundary functions
(`local_today`, `next_scheduled_day`). Plan 01 Task 2 adds the ladder
transition (`apply_result`), the session window (`session_window`), and the
expiry predicate (`is_session_expired`).

Day-boundary convention (D-06, LOCKED): `local_today` is THE ONE conversion
site from a UTC instant to a user's local calendar day, via the stored IANA
timezone string on `train_settings`. Every other Train day computation
(due-date snapping, session windows, Phase 191's streak math) reuses this and
never re-derives `.date()` from a naive UTC datetime elsewhere.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.models.drill_item import DrillStatus

# ---------------------------------------------------------------------------
# Named constants (CLAUDE.md: no magic numbers)
# ---------------------------------------------------------------------------

# streak -> day offset from the solve day. streak 0 means "the next scheduled
# session" (offset 0, i.e. as soon as possible); streak 1 -> 3 days out;
# streak 2 -> 10 days out (P-05, planner discretion within the seed's ~3d/~10d
# guidance).
LADDER_DAYS: dict[int, int] = {0: 0, 1: 3, 2: 10}

# 3 consecutive spaced-correct solves masters an item (POOL-05).
MASTERY_STREAK_THRESHOLD: int = 3

# 3 fails with zero ever-correct solves parks an item (POOL-06).
PARK_FAIL_THRESHOLD: int = 3

# D-06 default timezone for a brand-new train_settings row.
DEFAULT_TIMEZONE: str = "UTC"

# D-07: empty weekday set = "train anytime" (every day is a session day).
DEFAULT_WEEKDAY_MASK: int = 0

# D-08: default puzzles per session (9 SR + 3 herrings at the 75/25 split).
DEFAULT_PUZZLES_PER_SESSION: int = 12

# Number of days in a week — the search bound for next_scheduled_day's
# forward scan (a full week always contains a scheduled day when the mask is
# non-zero).
_DAYS_IN_WEEK: int = 7


def local_today(tz_name: str, now_utc: datetime.datetime) -> datetime.date:
    """Convert a UTC instant to a user's local calendar day (D-06).

    THE ONE conversion site from a UTC instant to a local calendar day for
    all of Train's day-boundary math. Every other function in this module
    (and Phase 191's streak logic) must call this rather than re-deriving
    `.date()` from a naive/aware UTC datetime elsewhere.

    Args:
        tz_name: An IANA timezone string (e.g. "America/New_York"), as
            stored on `train_settings.timezone`. An unrecognised name falls
            back to DEFAULT_TIMEZONE rather than raising, so a stale/typo'd
            stored value never crashes composition.
        now_utc: The current UTC instant.

    Returns:
        The local calendar date at `now_utc` in the given timezone.

    Sign/timezone convention matches session_window and next_scheduled_day
    (both consume a date already resolved via this function, never a raw
    UTC datetime).
    """
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(DEFAULT_TIMEZONE)
    return now_utc.astimezone(zone).date()


def next_scheduled_day(after: datetime.date, weekday_mask: int) -> datetime.date:
    """Return the first day >= `after` whose weekday bit is set in `weekday_mask`.

    Args:
        after: The earliest acceptable date (inclusive).
        weekday_mask: A 7-bit mask, bit `date.weekday()` (Monday=0 .. Sunday=6)
            set means that weekday is scheduled. `weekday_mask == 0` is the
            D-07 empty-schedule bootstrap case — every day is scheduled, so
            this returns `after` unchanged (identity).

    Returns:
        The first scheduled date >= `after`.

    Cross-reference: `session_window` calls this to compute D-10's "open
    until the next scheduled session day" window; `apply_result` (Task 2)
    calls this to snap a ladder-computed ideal due date onto a real session
    day.
    """
    if weekday_mask == 0:
        return after
    for offset in range(_DAYS_IN_WEEK):
        candidate = after + datetime.timedelta(days=offset)
        if weekday_mask & (1 << candidate.weekday()):
            return candidate
    # Unreachable: weekday_mask != 0 guarantees at least one bit is set within
    # any 7-day window, per the CHECK constraint bounding weekday_mask to
    # [0, 127] (7 weekday bits).
    raise ValueError(f"weekday_mask={weekday_mask!r} has no scheduled day in a 7-day window")


@dataclass(frozen=True)
class ItemState:
    """The SR-relevant fields of a `drill_items` row, as a pure value type.

    `status` is `app.models.drill_item.DrillStatus` — imported, not
    redeclared, so the enum has exactly one definition across the model and
    scheduler layers.
    """

    status: DrillStatus
    streak: int
    due_date: datetime.date
    fail_count: int
    ever_correct: bool


def apply_result(
    state: ItemState, *, correct_move: bool, today: datetime.date, weekday_mask: int
) -> ItemState:
    """Advance a drill_items row's SR state after one solve (POOL-04/05/06).

    Args:
        state: The item's state before this solve.
        correct_move: Whether the played move matched the puzzle's answer.
            There is deliberately NO `guess` parameter — mastery/parking is
            driven by move correctness alone. The metacognition "critical vs
            several" guess (P-02) is graded and recorded separately
            (`drill_solves.correct_guess`) and can never advance or reset a
            streak; folding it in here would let scoring leak into SR
            mechanics, which the seed's design explicitly forbids.
        today: The local session day this solve happened on (from
            `local_today`), used as the base for due-date snapping.
        weekday_mask: The user's scheduled-day bitmask, passed through to
            `next_scheduled_day` for the re-snap.

    Returns:
        The item's new state.

    Correct-move branch: `streak + 1`; at MASTERY_STREAK_THRESHOLD the item
    becomes MASTERED with `due_date` left UNTOUCHED (a mastered item is never
    re-scheduled); otherwise ACTIVE with a due date snapped via
    `next_scheduled_day(today + LADDER_DAYS[new_streak] days, weekday_mask)`.
    Either way `fail_count` resets to 0 and `ever_correct` becomes True.

    Wrong-move branch: `streak` resets to 0. `fail_count` increments ONLY
    while `ever_correct` is False (Door B is a NEVER-solved counter, not a
    rolling one — once a user has ever solved the item correctly, wrong
    answers can no longer park it). The park check runs BEFORE the re-snap:
    at PARK_FAIL_THRESHOLD with `ever_correct` False, the item becomes PARKED
    with `due_date` left UNTOUCHED; otherwise ACTIVE with
    `due_date = next_scheduled_day(today, weekday_mask)`.

    Cross-reference: `next_scheduled_day` is the sibling this function must
    agree with on every due-date snap; `session_window` is the sibling for
    the *session's* (not the item's) open-window boundary.
    """
    if correct_move:
        new_streak = state.streak + 1
        if new_streak >= MASTERY_STREAK_THRESHOLD:
            return ItemState(
                status=DrillStatus.MASTERED,
                streak=new_streak,
                due_date=state.due_date,
                fail_count=0,
                ever_correct=True,
            )
        ideal_due = today + datetime.timedelta(days=LADDER_DAYS[new_streak])
        return ItemState(
            status=DrillStatus.ACTIVE,
            streak=new_streak,
            due_date=next_scheduled_day(ideal_due, weekday_mask),
            fail_count=0,
            ever_correct=True,
        )

    new_fail_count = state.fail_count if state.ever_correct else state.fail_count + 1
    if not state.ever_correct and new_fail_count >= PARK_FAIL_THRESHOLD:
        return ItemState(
            status=DrillStatus.PARKED,
            streak=0,
            due_date=state.due_date,
            fail_count=new_fail_count,
            ever_correct=False,
        )
    return ItemState(
        status=DrillStatus.ACTIVE,
        streak=0,
        due_date=next_scheduled_day(today, weekday_mask),
        fail_count=new_fail_count,
        ever_correct=state.ever_correct,
    )


def session_window(session_date: datetime.date, weekday_mask: int) -> datetime.date:
    """D-10: a session stays open until the NEXT scheduled session day starts.

    Args:
        session_date: The local date the session was composed on.
        weekday_mask: The user's scheduled-day bitmask.

    Returns:
        The first scheduled day strictly after `session_date` — the moment
        the session expires.

    With the D-07 default mask of 0 (every day scheduled), the window
    collapses to "end of the same local day": `session_date + 1 day`, NOT a
    multi-day grace window like the Tue/Fri example in 189-CONTEXT.md.
    Cross-reference: shares its forward-scan logic with `next_scheduled_day`,
    which this function calls directly rather than re-implementing the scan.
    """
    day_after = session_date + datetime.timedelta(days=1)
    return next_scheduled_day(day_after, weekday_mask)


def is_session_expired(expires_on: datetime.date, today: datetime.date) -> bool:
    """Whether a `drill_sessions` row has expired (D-10/D-11).

    Args:
        expires_on: The session's `expires_on` date, from `session_window`.
        today: The local date to check against (from `local_today`).

    Returns:
        True when `today >= expires_on` — the boundary is INCLUSIVE on the
        expiry date: the arrival of the next scheduled day ends the window,
        it does not merely start counting down.

    Cross-reference: `expires_on` must always be a value previously produced
    by `session_window`, so this predicate and that function agree on what
    "expired" means.
    """
    return today >= expires_on


__all__ = [
    "DEFAULT_PUZZLES_PER_SESSION",
    "DEFAULT_TIMEZONE",
    "DEFAULT_WEEKDAY_MASK",
    "LADDER_DAYS",
    "MASTERY_STREAK_THRESHOLD",
    "PARK_FAIL_THRESHOLD",
    "ItemState",
    "apply_result",
    "is_session_expired",
    "local_today",
    "next_scheduled_day",
    "session_window",
]
