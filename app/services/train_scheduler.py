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
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from enum import StrEnum
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

# All 7 weekday bits set (Monday=0..Sunday=6) — the complementary "every day
# scheduled" representation to the D-07 empty mask (see DEFAULT_WEEKDAY_MASK
# below and required_sessions_per_week's special-casing of both).
ALL_WEEKDAYS_MASK: int = 0b1111111

# 191-06 UAT bug fix (SCHD-01): the D-07 empty mask (`0`, "train anytime")
# rendered the weekday picker with every chip UNCHECKED, which read as "no
# schedule configured" rather than its actual meaning ("any day works").
# Defaulting brand-new rows to ALL_WEEKDAYS_MASK instead shows every chip
# CHECKED out of the box — the same "any day works" meaning, spelled out
# explicitly rather than via the empty-set identity case.
# required_sessions_per_week treats `0` and `ALL_WEEKDAYS_MASK` identically
# (both still require only 1 session/week, never 7) so this is a pure
# display-default change: no session/streak behavior differs from before.
DEFAULT_WEEKDAY_MASK: int = ALL_WEEKDAYS_MASK

# D-08: default puzzles per session. 191-06 UAT: changed from 12 to the
# middle of the new 3/6/9/12/15 preset ladder (was 6/12/18/24) — 6 is a
# gentler first-touch default than 12 (5 SR + 1 herring per compose_slots'
# 75/25 split at n=6).
DEFAULT_PUZZLES_PER_SESSION: int = 6

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

    With every day scheduled (either the D-07 empty mask `0`, or the 191-06
    default `ALL_WEEKDAYS_MASK`), the window collapses to "end of the same
    local day": `session_date + 1 day`, NOT a multi-day grace window like the
    Tue/Fri example in 189-CONTEXT.md.
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


# ---------------------------------------------------------------------------
# Phase 191 Plan 01 (PROG-01, D-18): the settled-streak snapshot machine.
#
# A settled week is frozen FOREVER once judged: settle_weeks only ever walks
# weeks strictly after `snapshot.settled_through`, so a later weekday_mask or
# timezone change can never re-judge a week that already settled (D-18). The
# CURRENT week alone is judged live against the current mask every call — a
# mid-week schedule change prospectively re-judges only that in-progress
# week (accepted D-18 semantics).
# ---------------------------------------------------------------------------


def week_start(d: datetime.date) -> datetime.date:
    """Return the Monday of the Mon-Sun week containing `d`.

    Uses `date.weekday()` (Monday=0..Sunday=6) — the IDENTICAL convention
    `next_scheduled_day` uses for `weekday_mask` bits, so week boundaries and
    the schedule bitmask never disagree.
    """
    return d - datetime.timedelta(days=d.weekday())


class FlameState(StrEnum):
    """The D-02 three-state flame ladder.

    A `StrEnum` so the in-memory value, the `train_settings.flame_state` TEXT
    column value, and the wire literal are byte-identical — no mapping table
    needed in either direction.
    """

    MINIMUM = "minimum"
    MEDIUM = "medium"
    MAXIMUM = "maximum"


# The explicit ordered ladder the D-02 notch arithmetic reads off — never
# integer adjacency. Index 0 is the lowest lit state (lighting up from None
# always lands here); the last index is the cap.
FLAME_LADDER: tuple[FlameState, ...] = (FlameState.MINIMUM, FlameState.MEDIUM, FlameState.MAXIMUM)


def _flame_up(flame: FlameState | None) -> FlameState:
    """Step the flame UP one FLAME_LADDER notch (D-02 fulfilled-week rule).

    An unlit (`None`) flame lights at the ladder's first (lowest) rung;
    `FLAME_LADDER[-1]` (maximum) is the cap.
    """
    if flame is None:
        return FLAME_LADDER[0]
    index = FLAME_LADDER.index(flame)
    return FLAME_LADDER[min(index + 1, len(FLAME_LADDER) - 1)]


def _flame_down(flame: FlameState) -> FlameState | None:
    """Step the flame DOWN one FLAME_LADDER notch (D-02 missed-week rule).

    Only called when `flame` is not `None` — the missed-week branch in
    `settle_weeks` handles the `None` (nothing running) and the
    `FLAME_LADDER[0]` (lose the streak) cases itself before ever calling this.
    """
    index = FLAME_LADDER.index(flame)
    if index == 0:
        return None
    return FLAME_LADDER[index - 1]


def required_sessions_per_week(weekday_mask: int) -> int:
    """D-01: the count of scheduled days a week must clear to be fulfilled.

    Both "day-agnostic" masks require exactly 1 completed session, not the
    general popcount expression:
    - `weekday_mask == 0` (D-07 "train anytime", reachable by explicitly
      deselecting every chip): `popcount(0) == 0` would demand nothing, so
      this is a deliberate override making the empty schedule still count as
      "showed up".
    - `weekday_mask == ALL_WEEKDAYS_MASK` (191-06: the new brand-new-row
      default, every chip checked): `popcount(127) == 7` would demand a
      session every single day, which is far too strict a requirement to
      spring on a user who never touched the picker. Since every day is
      already schedulable either way, "all 7 checked" and "0 checked" are the
      two ends of the same "no specific-day preference" spectrum and must
      resolve to the same requirement — otherwise flipping the very LAST
      remaining chip off (127 -> a 6-bit mask -> 0) would make the
      requirement jump 1 -> 6 -> 1, an incoherent non-monotonic cliff for a
      user who is only trying to say "I don't care which days".
    Any OTHER mask requires the number of scheduled days
    (`bin(weekday_mask).count("1")`), never WHICH specific days a session
    landed on (D-01's "regardless of which days they happened on") — a user
    who deliberately narrows to a proper subset of days IS making a real
    day-count commitment.
    """
    if weekday_mask in (0, ALL_WEEKDAYS_MASK):
        return 1
    return bin(weekday_mask).count("1")


@dataclass(frozen=True)
class SettledStreak:
    """The D-18 settled-streak snapshot — exactly what persists on
    `train_settings` (`streak_count`, `flame_state`, `streak_settled_through`).
    """

    streak_count: int
    flame_state: FlameState | None
    settled_through: datetime.date | None


@dataclass(frozen=True)
class StreakView:
    """The full result of one `settle_weeks` call.

    `settled` is the (possibly advanced) snapshot to persist when `changed`
    is True. `display_flame` is the D-03 presentation-only overlay — it is
    NEVER persisted, so an unsettled in-progress week can never corrupt the
    frozen snapshot. `streak_lost_last_week` is derived from the resulting
    state (not from "did this call settle the reset"), so it survives a page
    reload within the same week.
    """

    settled: SettledStreak
    display_flame: FlameState | None
    current_week_completed: int
    streak_lost_last_week: bool
    changed: bool


def _settle_one_week(
    snapshot: SettledStreak, *, fulfilled: bool, week: datetime.date
) -> SettledStreak:
    """Apply the D-02 fulfilled/missed transition for exactly one settled week."""
    if fulfilled:
        return SettledStreak(
            streak_count=snapshot.streak_count + 1,
            flame_state=_flame_up(snapshot.flame_state),
            settled_through=week,
        )
    # Missed week.
    if snapshot.flame_state is None:
        # No streak running — a missed week changes nothing.
        return SettledStreak(
            streak_count=snapshot.streak_count,
            flame_state=None,
            settled_through=week,
        )
    if snapshot.flame_state == FLAME_LADDER[0]:
        # At the lowest rung: the streak is lost, reset to 0.
        return SettledStreak(streak_count=0, flame_state=None, settled_through=week)
    # Absorbed: flame drops one notch, streak_count is frozen (not reset).
    return SettledStreak(
        streak_count=snapshot.streak_count,
        flame_state=_flame_down(snapshot.flame_state),
        settled_through=week,
    )


def settle_weeks(
    snapshot: SettledStreak,
    completed_session_dates: Sequence[datetime.date],
    *,
    weekday_mask: int,
    today: datetime.date,
) -> StreakView:
    """Advance the D-18 settled-streak snapshot over every fully-elapsed week.

    Args:
        snapshot: The persisted `SettledStreak` before this call (the
            all-null `SettledStreak(0, None, None)` for a brand-new row —
            this is what triggers the D-05 full-history replay on first
            settlement).
        completed_session_dates: Every `drill_sessions.session_date` with
            `status='completed'` for this user (D-06/D-07/D-08 tz already
            resolved — plain local dates, never re-converted). Order-
            insensitive by construction (bucketed, not scanned) — no sort
            assumption beyond `min()`.
        weekday_mask: The user's CURRENT scheduled-day bitmask. Only ever
            applied to weeks strictly after `snapshot.settled_through` (a
            settled week is frozen forever, D-18) and to the live current
            week.
        today: The local calendar day (from `local_today`).

    Returns:
        A `StreakView` with the advanced (or unchanged) snapshot, the D-03
        display overlay, this week's raw count, and the streak-lost notice.

    A settled week is frozen forever (D-18): a later `weekday_mask` or
    timezone change cannot re-judge it, because settlement only ever walks
    weeks strictly after `settled_through`. The current week alone is judged
    live against the current mask every call, so a mid-week schedule change
    prospectively re-judges only the in-progress week — accepted D-18
    semantics.
    """
    week_counts: Counter[datetime.date] = Counter(week_start(d) for d in completed_session_dates)
    current_start = week_start(today)
    current_week_completed = week_counts.get(current_start, 0)

    if snapshot.settled_through is None:
        # First settlement: replay the ENTIRE pre-existing history so prior
        # (Phase-190) sessions still count with no backfill migration (D-05).
        past_weeks = [w for w in week_counts if w < current_start]
        first_week = min(past_weeks) if past_weeks else None
    else:
        first_week = snapshot.settled_through + datetime.timedelta(days=7)

    settled = snapshot
    if first_week is not None:
        required = required_sessions_per_week(weekday_mask)
        week = first_week
        while week < current_start:
            fulfilled = week_counts.get(week, 0) >= required
            settled = _settle_one_week(settled, fulfilled=fulfilled, week=week)
            week += datetime.timedelta(days=7)

    changed = settled != snapshot

    display_flame = settled.flame_state
    if display_flame is None and current_week_completed > 0:
        # D-03: the minimum flame lights immediately after the very first
        # completed session, while the persisted snapshot stays None until
        # that week actually settles.
        display_flame = FLAME_LADDER[0]

    streak_lost_last_week = (
        settled.settled_through == current_start - datetime.timedelta(days=7)
        and settled.streak_count == 0
        and settled.flame_state is None
        and current_week_completed == 0
        and any(d < current_start for d in completed_session_dates)
    )

    return StreakView(
        settled=settled,
        display_flame=display_flame,
        current_week_completed=current_week_completed,
        streak_lost_last_week=streak_lost_last_week,
        changed=changed,
    )


__all__ = [
    "ALL_WEEKDAYS_MASK",
    "DEFAULT_PUZZLES_PER_SESSION",
    "DEFAULT_TIMEZONE",
    "DEFAULT_WEEKDAY_MASK",
    "FLAME_LADDER",
    "LADDER_DAYS",
    "MASTERY_STREAK_THRESHOLD",
    "PARK_FAIL_THRESHOLD",
    "FlameState",
    "ItemState",
    "SettledStreak",
    "StreakView",
    "apply_result",
    "is_session_expired",
    "local_today",
    "next_scheduled_day",
    "required_sessions_per_week",
    "session_window",
    "settle_weeks",
    "week_start",
]
