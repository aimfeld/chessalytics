"""ORM model for push_subscriptions -- one row per browser Web Push subscription (Phase 201).

PUSH-01/PUSH-02. CASCADE-only to `users.id` (mirrors `app/models/drill_session.py`'s
FK shape) -- a subscription is pure client-supplied state, not game-derived data,
so it has no other foreign key.
"""

from __future__ import annotations

import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PushSubscription(Base):
    """One row per device-per-browser Web Push subscription (PUSH-01/PUSH-02)."""

    __tablename__ = "push_subscriptions"
    __table_args__ = (
        # A re-subscribe from the same browser/device returns the SAME endpoint
        # URL until it expires -- unique on endpoint alone (not (user_id, endpoint))
        # prevents a duplicate row on repeat subscribe calls and also prevents
        # one endpoint being claimed by two different user_ids simultaneously.
        UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
        # The FK is not auto-indexed in PostgreSQL; both the fan-out lookup and
        # the later candidate EXISTS filter (plan 201-04) key on user_id.
        Index("ix_push_subscriptions_user_id", "user_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)
    auth: Mapped[str] = mapped_column(Text, nullable=False)
    # Cheap static metadata for a future device list. NOT a last_seen_at
    # heuristic (D-05 rejected most-recently-active fan-out).
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


__all__ = ["PushSubscription"]
