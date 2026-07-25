"""ORM model for train_settings table (Phase 189).

Phase 189 Plan 01 (POOL-04, D-06/D-07/D-08). One settings row per user
controlling the Train schedule: the D-06 IANA timezone string used for every
"session day" boundary computation (`app.services.train_scheduler.local_today`),
the D-07 weekday bitmask (0 = empty set = "train anytime", the identity case
for `next_scheduled_day`), and the D-08 puzzles-per-session count.

Mirrors `app/models/user_import_settings.py`'s create-on-first-touch shape
exactly: PK = `user_id`, no migration-time backfill for new users, defaults
(`app.services.train_scheduler.DEFAULT_TIMEZONE` /
`DEFAULT_WEEKDAY_MASK` / `DEFAULT_PUZZLES_PER_SESSION`) applied at the
application layer on first GET/PUT via
`app.repositories.train_repository.get_or_create_settings`.
"""

from __future__ import annotations

from sqlalchemy import CheckConstraint, ForeignKey, SmallInteger, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TrainSettings(Base):
    """One row per user: Train timezone, weekday schedule, session size."""

    __tablename__ = "train_settings"
    __table_args__ = (
        CheckConstraint("weekday_mask BETWEEN 0 AND 127", name="ck_train_settings_weekday_mask"),
        CheckConstraint("puzzles_per_session BETWEEN 1 AND 50", name="ck_train_settings_puzzles"),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default="UTC")
    weekday_mask: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    puzzles_per_session: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="12"
    )


__all__ = ["TrainSettings"]
