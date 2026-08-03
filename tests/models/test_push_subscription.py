"""DB round-trip + constraint tests for the push_subscriptions table (Phase 201).

Proves the PUSH-01/PUSH-02 must-have truths:
1. Deleting the owning user CASCADE-deletes every one of that user's
   push_subscriptions rows.
2. A second row with an `endpoint` that already exists raises an
   IntegrityError at the DB level (the unique constraint).
3. Going through `push_repository.upsert_subscription` instead updates the
   existing row in place and leaves the row count at 1 (the re-subscribe
   path never errors).

Uses the per-run DB clone via the rolled-back db_session fixture (mirrors
tests/models/test_game_best_move.py). No dev DB reset (CLAUDE.md).
"""

from __future__ import annotations

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.push_subscription import PushSubscription
from app.models.user import User
from app.repositories import push_repository

_ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
_P256DH = "p256dh-value"
_AUTH = "auth-value"


async def _seed_user(session: AsyncSession, *, email: str) -> User:
    user = User(email=email, hashed_password="fakehash")
    session.add(user)
    await session.flush()
    return user


@pytest.mark.asyncio
async def test_cascade_deletes_subscriptions_on_user_delete(db_session: AsyncSession) -> None:
    """Deleting the owning user CASCADE-deletes their push_subscriptions rows (PUSH-01)."""
    user = await _seed_user(db_session, email="push-cascade@example.com")
    db_session.add(
        PushSubscription(user_id=user.id, endpoint=_ENDPOINT, p256dh=_P256DH, auth=_AUTH)
    )
    await db_session.flush()

    await db_session.execute(delete(User).where(User.id == user.id))
    await db_session.flush()
    db_session.expire_all()

    remaining = (
        (
            await db_session.execute(
                select(PushSubscription).where(PushSubscription.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


@pytest.mark.asyncio
async def test_duplicate_endpoint_rejected_at_db_level(db_session: AsyncSession) -> None:
    """A second row with an already-existing `endpoint` violates the unique constraint."""
    user_a = await _seed_user(db_session, email="push-dup-a@example.com")
    user_b = await _seed_user(db_session, email="push-dup-b@example.com")
    db_session.add(
        PushSubscription(user_id=user_a.id, endpoint=_ENDPOINT, p256dh=_P256DH, auth=_AUTH)
    )
    await db_session.flush()

    db_session.add(
        PushSubscription(user_id=user_b.id, endpoint=_ENDPOINT, p256dh="other", auth="other")
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_upsert_subscription_on_duplicate_endpoint_updates_in_place(
    db_session: AsyncSession,
) -> None:
    """Re-subscribing with the same endpoint updates the row, never raises, count stays 1."""
    user = await _seed_user(db_session, email="push-upsert@example.com")
    first_id = await push_repository.upsert_subscription(
        db_session,
        user_id=user.id,
        endpoint=_ENDPOINT,
        p256dh=_P256DH,
        auth=_AUTH,
        user_agent="ua-1",
    )
    await db_session.flush()

    second_id = await push_repository.upsert_subscription(
        db_session,
        user_id=user.id,
        endpoint=_ENDPOINT,
        p256dh="new-p256dh",
        auth="new-auth",
        user_agent="ua-2",
    )
    await db_session.flush()

    assert second_id == first_id
    count = (
        await db_session.execute(
            select(func.count())
            .select_from(PushSubscription)
            .where(PushSubscription.endpoint == _ENDPOINT)
        )
    ).scalar_one()
    assert count == 1

    row = (
        await db_session.execute(
            select(PushSubscription).where(PushSubscription.endpoint == _ENDPOINT)
        )
    ).scalar_one()
    assert row.p256dh == "new-p256dh"
    assert row.auth == "new-auth"
