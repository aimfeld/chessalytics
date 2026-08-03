"""Repository for the Train reminder scheduler's SQL (Phase 201, REMIND-02..07).

All SQL for the reminder job lives HERE -- `app/services/train_reminder_service.py`
holds no statements of its own. A new module rather than more lines in
`app/repositories/train_repository.py` (already ~2450 lines).

V4 Information Disclosure mitigation: every function requires `user_id` (or
`day`/`today` scoped to a user) as a keyword-only argument. Callers MUST pass
an already-resolved user id -- from `list_reminder_candidate_user_ids`'s own
scan, never client-supplied.
"""

from __future__ import annotations

import datetime

from sqlalchemy import exists, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drill_session import DrillSession
from app.models.push_subscription import PushSubscription
from app.models.train_settings import TrainSettings
from app.models.user import User


async def list_reminder_candidate_user_ids(session: AsyncSession) -> list[int]:
    """Return user ids that MAY be due a Train reminder (D-16: SQL narrows only).

    Narrows on `reminder_enabled` + at least one live `push_subscriptions`
    row + not a guest. Returns bare ids, mirroring
    `guest_cleanup_service.get_eligible_guest_ids`, so each candidate can be
    re-loaded fresh in its own session.

    Deliberately applies NO timezone conversion and NO predicate on
    `reminder_last_sent_on`: a user's local calendar day differs from the
    database session's date by up to fourteen hours, so a SQL-side date
    comparison would both over-select (pulling in a user whose local day has
    not started) and under-select (skipping a user whose local day has
    already turned while the watermark still reads the database's today) at
    the boundary. The per-user claim UPDATE (`claim_reminder_day`), evaluated
    against that user's own already-resolved local date, is the real guard.

    Guest exclusion (REMIND-07) is defence in depth: `/train/*` already 403s
    guests, so a guest cannot reach `reminder_enabled=True` through the API
    today, but this job runs behind no request-scoped gate -- the codebase's
    convention is an explicit filter over a relied-upon upstream invariant.
    """
    subscription_exists = (
        select(PushSubscription.id)
        .where(PushSubscription.user_id == TrainSettings.user_id)
        .exists()
    )
    stmt = (
        select(TrainSettings.user_id)
        .join(User, User.id == TrainSettings.user_id)
        .where(
            TrainSettings.reminder_enabled.is_(True),
            User.is_guest.is_(False),
            subscription_exists,
        )
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def claim_reminder_day(session: AsyncSession, *, user_id: int, today: datetime.date) -> bool:
    """Atomically claim `today` as sent for `user_id` (REMIND-05, D-06/D-07).

    A conditional `UPDATE ... RETURNING`: only claims when
    `reminder_last_sent_on` is NULL or strictly before `today`. Returns
    whether THIS call won the claim -- a loser's UPDATE matches zero rows.

    Does NOT commit. The caller MUST commit this before issuing any push
    POST (D-07): a send-then-mark ordering would double-send after a crash
    between the POST and the commit, and would quietly reintroduce the retry
    semantics D-04 rejects.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The user's own already-resolved local calendar day (from
            `train_scheduler.local_today`), never a database-side date.
    """
    stmt = (
        update(TrainSettings)
        .where(
            TrainSettings.user_id == user_id,
            or_(
                TrainSettings.reminder_last_sent_on.is_(None),
                TrainSettings.reminder_last_sent_on < today,
            ),
        )
        .values(reminder_last_sent_on=today)
        .returning(TrainSettings.user_id)
    )
    claimed = (await session.execute(stmt)).scalar_one_or_none()
    return claimed is not None


async def release_reminder_claim(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> bool:
    """Undo THIS tick's claim when the fan-out delivered to nobody (Phase 204 D3).

    Released when, and only when,
    `train_reminder_service._process_candidate`'s fan-out attempted zero
    sends or every attempted send came back pruned (`attempted == 0 or
    attempted == pruned`) -- see 204-DECISIONS.md for the full reasoning and
    the rejected alternatives. `failed` never triggers this (D-15): a
    construction/encryption exception is deliberately excluded from the
    predicate.

    The `reminder_last_sent_on == today` guard is deliberately NARROWER than
    `claim_reminder_day`'s predicate above -- no `or_`, no `.is_(None)`,
    equality with `today` only (D-14). This means the release can only ever
    un-claim the day THIS tick claimed, never a later claim written by a
    second ticker, which keeps the D-07 double-send invariant structural
    rather than resting on "there is only one process". 404/410 are terminal
    statuses under RFC 8030 Sec. 7, so a pruned subscription demonstrably
    never received the message -- releasing the claim cannot therefore
    produce a second delivery of a first one that never happened.

    Does NOT commit -- same "caller commits" contract as `claim_reminder_day`.
    Returns whether THIS call actually released a row (False if the row's
    `reminder_last_sent_on` was NULL, an earlier date, or absent).

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The SAME already-resolved local calendar day the claim used --
            never re-resolved by the caller.
    """
    stmt = (
        update(TrainSettings)
        .where(
            TrainSettings.user_id == user_id,
            TrainSettings.reminder_last_sent_on == today,
        )
        .values(reminder_last_sent_on=None)
        .returning(TrainSettings.user_id)
    )
    released = (await session.execute(stmt)).scalar_one_or_none()
    return released is not None


async def has_completed_session_on(
    session: AsyncSession, *, user_id: int, day: datetime.date
) -> bool:
    """True when `user_id` has a completed `drill_sessions` row for `day` (D-09/REMIND-04).

    This is what REMIND-04 means by "already trained today" -- matches what
    the streak machine already counts. A session opened at 17:00 and
    abandoned half-done deliberately still earns the nudge (only a
    non-NULL `completed_at` suppresses).

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        day: The user's own already-resolved local calendar day.
    """
    stmt = select(
        exists().where(
            DrillSession.user_id == user_id,
            DrillSession.session_date == day,
            DrillSession.completed_at.isnot(None),
        )
    )
    return bool((await session.execute(stmt)).scalar_one())


__all__ = [
    "claim_reminder_day",
    "has_completed_session_on",
    "list_reminder_candidate_user_ids",
    "release_reminder_claim",
]
