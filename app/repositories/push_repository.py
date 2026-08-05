"""Repository for the push_subscriptions table (Phase 201, PUSH-01/PUSH-02).

V4 Information Disclosure mitigation: every function requires `user_id` as a
keyword-only argument. Callers MUST pass the authenticated user's ID (from the
FastAPI-Users `current_active_user` dependency); never accept `user_id` as a
query/path parameter from the client. Mirrors
`app/repositories/train_repository.py`.

No business logic here, no `httpx`, no config reads -- pure CRUD over
push_subscriptions.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.push_subscription import PushSubscription


@dataclass(frozen=True)
class PushSubscriptionRow:
    """A read-only projection of one push_subscriptions row."""

    id: int
    endpoint: str
    p256dh: str
    auth: str
    user_agent: str | None


async def upsert_subscription(
    session: AsyncSession,
    *,
    user_id: int,
    endpoint: str,
    p256dh: str,
    auth: str,
    user_agent: str | None,
) -> int:
    """Insert a new subscription, or update an existing one in place by endpoint.

    A browser returns the SAME endpoint URL on re-subscribe, so `endpoint` is
    the natural key (PUSH-01) -- a re-subscribe from the same browser (e.g.
    after a browser reinstall rotated its push keys) updates the existing row
    rather than raising on the unique constraint, and also re-claims the
    endpoint for the calling user if it had somehow been orphaned to another.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        endpoint: The browser-supplied push service endpoint URL.
        p256dh: The subscription's P-256 Diffie-Hellman public key (base64url).
        auth: The subscription's authentication secret (base64url).
        user_agent: The request's User-Agent header, or None.

    Returns:
        The subscription's id (new or existing).
    """
    stmt = (
        pg_insert(PushSubscription)
        .values(
            user_id=user_id,
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            user_agent=user_agent,
        )
        .on_conflict_do_update(
            index_elements=["endpoint"],
            set_={
                "user_id": user_id,
                "p256dh": p256dh,
                "auth": auth,
                "user_agent": user_agent,
            },
        )
        .returning(PushSubscription.id)
    )
    result = await session.execute(stmt)
    return int(result.scalar_one())


async def list_subscriptions(session: AsyncSession, *, user_id: int) -> list[PushSubscriptionRow]:
    """Return every live subscription for a user.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
    """
    result = await session.execute(
        select(
            PushSubscription.id,
            PushSubscription.endpoint,
            PushSubscription.p256dh,
            PushSubscription.auth,
            PushSubscription.user_agent,
        )
        .where(PushSubscription.user_id == user_id)
        .order_by(PushSubscription.id)
    )
    return [
        PushSubscriptionRow(
            id=row.id,
            endpoint=row.endpoint,
            p256dh=row.p256dh,
            auth=row.auth,
            user_agent=row.user_agent,
        )
        for row in result.all()
    ]


async def delete_subscription_by_endpoint(
    session: AsyncSession, *, user_id: int, endpoint: str
) -> int:
    """Delete a subscription owned by `user_id` matching `endpoint`. Scoped to the owner.

    Deleting another user's endpoint matches zero rows -- this is the
    unsubscribe path's V4/IDOR guard.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        endpoint: The subscription endpoint URL to remove.

    Returns:
        The number of rows deleted (0 or 1).
    """
    result = await session.execute(
        delete(PushSubscription).where(
            PushSubscription.user_id == user_id, PushSubscription.endpoint == endpoint
        )
    )
    return int(result.rowcount or 0)  # ty: ignore[unresolved-attribute]  # SQLAlchemy DML result carries rowcount


async def delete_subscription_by_id(session: AsyncSession, *, subscription_id: int) -> None:
    """Delete one subscription by id -- the prune-on-410/404 path (PUSH-02).

    A delete of an already-deleted id is a no-op, which is what makes pruning
    idempotent under two concurrent send passes over the same dead endpoint.

    Args:
        session: AsyncSession. Caller commits.
        subscription_id: The row id to remove.
    """
    await session.execute(delete(PushSubscription).where(PushSubscription.id == subscription_id))


__all__ = [
    "PushSubscriptionRow",
    "upsert_subscription",
    "list_subscriptions",
    "delete_subscription_by_endpoint",
    "delete_subscription_by_id",
]
