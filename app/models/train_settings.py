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

Phase 193 (SEED-121) replaced Phase 191's D-18 weekly settled-streak
snapshot (`flame_state`) with a per-scheduled-day tick + a 0-7 depletable
shield: `streak_count` (KEPT, re-meaning "completed scheduled-day sessions"
rather than "settled weeks"), `shield_level` (NEW, replaces `flame_state`),
`streak_settled_through` (KEPT, re-meaning "the last judged day" rather than
"the Monday of the last settled week"), and `pool_eligible_since` (NEW, the
D-06 eligibility watermark — never judge a scheduled day earlier than the
date the user first had qualifying material). A settled day is frozen
forever — `GET /train/progress` only ever walks days strictly after
`streak_settled_through`, so a later `weekday_mask`/`timezone` change can
never re-judge a day that already settled. See
`app.services.train_scheduler.tick_days` for the pure tick logic and
`app.repositories.train_repository.settle_streak_snapshot` for the single
mutation entry point (shared by `GET /train/progress` and
`PUT /train/settings`).
"""

from __future__ import annotations

import datetime

from sqlalchemy import CheckConstraint, Date, ForeignKey, SmallInteger, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.services.train_scheduler import SHIELD_CAP


class TrainSettings(Base):
    """One row per user: Train timezone, weekday schedule, session size,
    and the per-day tick machine's persisted snapshot (Phase 193)."""

    __tablename__ = "train_settings"
    __table_args__ = (
        CheckConstraint("weekday_mask BETWEEN 0 AND 127", name="ck_train_settings_weekday_mask"),
        CheckConstraint("puzzles_per_session BETWEEN 1 AND 50", name="ck_train_settings_puzzles"),
        CheckConstraint(
            f"shield_level BETWEEN 0 AND {SHIELD_CAP}", name="ck_train_settings_shield_level"
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
    # Phase 193 per-day tick snapshot. streak_count counts completed
    # scheduled-day sessions (never an in-flight/unsettled day — see
    # tick_days). shield_level is a plain SmallInteger + range CHECK (not an
    # IntEnum/TEXT+CHECK): it is a count, not a named state, matching
    # CLAUDE.md's "SMALLINT backed by ... or TEXT+CHECK" rule for a bounded
    # non-categorical integer. streak_settled_through is the last day this
    # machine has finished judging; NULL means nothing has settled yet (the
    # all-null-equivalent snapshot every pre-existing row gets from the
    # Phase 193 migration, which is exactly what triggers a full-history
    # replay on first settlement).
    streak_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    shield_level: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    streak_settled_through: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
    # Phase 193 D-06: the eligibility watermark — never judge a scheduled day
    # earlier than the date the user first had qualifying (drillable)
    # material. NULL means never yet stamped (a brand-new user, or an
    # existing user with zero drill_items at migration time per the Task 1
    # hard-reset decision — see the migration's module docstring for the D-05
    # waiver this implies). Stamped lazily, once, by
    # `app.repositories.train_repository._stamp_pool_eligibility`.
    pool_eligible_since: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)


__all__ = ["TrainSettings"]
