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

Phase 191 Plan 01 (D-18) adds the settled-streak snapshot: `streak_count`,
`flame_state`, `streak_settled_through`. A settled week is frozen forever —
`GET /train/progress` only ever walks weeks strictly after
`streak_settled_through`, so a later `weekday_mask`/`timezone` change can
never re-judge a week that has already settled. See
`app.services.train_scheduler.settle_weeks` for the pure settlement logic
and `app.repositories.train_repository.settle_streak_snapshot` for the
single mutation entry point (shared by `GET /train/progress` here and
`PUT /train/settings` in Plan 04).
"""

from __future__ import annotations

import datetime

from sqlalchemy import CheckConstraint, Date, ForeignKey, SmallInteger, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TrainSettings(Base):
    """One row per user: Train timezone, weekday schedule, session size,
    and the D-18 settled-streak snapshot."""

    __tablename__ = "train_settings"
    __table_args__ = (
        CheckConstraint("weekday_mask BETWEEN 0 AND 127", name="ck_train_settings_weekday_mask"),
        CheckConstraint("puzzles_per_session BETWEEN 1 AND 50", name="ck_train_settings_puzzles"),
        CheckConstraint(
            "flame_state IN ('minimum', 'medium', 'maximum')", name="ck_train_settings_flame_state"
        ),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default="UTC")
    # 191-06 UAT: defaults changed from 0/12 to 127/6 — see
    # app.services.train_scheduler.DEFAULT_WEEKDAY_MASK/
    # DEFAULT_PUZZLES_PER_SESSION for the full rationale (both are also the
    # single source of truth the repository/app layer actually applies on
    # first touch; these server_defaults exist for direct-INSERT parity).
    weekday_mask: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="127")
    puzzles_per_session: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="6"
    )
    # D-18 settled-streak snapshot. streak_count counts SETTLED weeks only
    # (never the in-progress current week — see settle_weeks). flame_state
    # is TEXT + CHECK (not SMALLINT + IntEnum): this is a low-volume domain
    # column (one row per user), matching the drill_sessions.status
    # precedent, not the high-cardinality drill_items.status one.
    # NULL means "never lit". streak_settled_through is the Monday of the
    # most recently settled Mon-Sun week; NULL means nothing has settled yet
    # (the all-null snapshot every pre-existing row gets from this migration,
    # which is exactly what triggers a full-history replay on first
    # settlement — D-05 Phase-190 retroactivity, preserved under D-18).
    streak_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    flame_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    streak_settled_through: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)


__all__ = ["TrainSettings"]
