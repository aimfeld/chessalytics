"""ORM model for drill_items — per-(user, flaw) spaced-repetition state (Phase 189).

Phase 189 Plan 01 (POOL-01/POOL-04/POOL-05/POOL-06). One row per (user, game,
ply) that has entered the Train drill pool: an interval-ladder "streak" state
machine tracks progress toward MASTERED (3 spaced-correct solves, POOL-05) or
PARKED (3 never-correct fails, POOL-06); `due_date` drives session composition
(POOL-04, snapped to a scheduled session day by
`app.services.train_scheduler.next_scheduled_day`).

Anchoring (D-02, LOCKED — do not "fix" this to FK `game_flaws`):
  `drill_items` FKs to `games(id) ON DELETE CASCADE` only, with PLAIN
  `(game_id, ply)` reference columns — there is NO ForeignKeyConstraint to
  `game_flaws`. Rationale: `_classify_and_fill_oracle` (app/services/
  eval_apply.py) is a diff/upsert against `game_flaws` that can legitimately
  DELETE a ply's row when a resweep/backfill/reclassification decides a ply
  no longer qualifies as a flaw. If `drill_items` FK'd to `game_flaws` with
  ON DELETE CASCADE, a routine backend maintenance pass could silently
  destroy a user's in-progress or mastered drill item the moment its source
  flaw got reclassified away. Instead, every serve-time read does an
  explicit LEFT JOIN to `game_flaws` on `(user_id, game_id, ply)` and
  tolerates a missing match (lazy eviction at composition time, never a
  DELETE from this table).

Grading-critical fields (D-01, LOCKED): `best_move`, `pv`, and the sharp/soft
classification derived from `game_flaws.missed_pv_lines` are NEVER snapshotted
onto this table — they are always live-joined from `game_positions`/
`game_flaws` at composition/serve time. Do not add a cached copy of them here.
"""

from __future__ import annotations

import datetime
from enum import IntEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DrillStatus(IntEnum):
    """SR lifecycle state for a drill_items row (POOL-04/05/06)."""

    ACTIVE = 0
    MASTERED = 1
    PARKED = 2


class DrillItem(Base):
    """One row per (user, game, ply) qualifying own-blunder pool entry.

    Composite PK `(user_id, game_id, ply)` mirrors `game_flaws`' own PK shape
    (see module docstring for the D-02 anchoring rationale).
    """

    __tablename__ = "drill_items"
    __table_args__ = (
        CheckConstraint("status IN (0, 1, 2)", name="ck_drill_items_status"),
        CheckConstraint("streak >= 0", name="ck_drill_items_streak"),
        CheckConstraint("fail_count >= 0", name="ck_drill_items_fail_count"),
        # Session-compose scan: WHERE user_id = ? AND status = ACTIVE ORDER BY due_date.
        Index("ix_drill_items_user_status_due", "user_id", "status", "due_date"),
    )

    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    # D-02: FK to games(id) only, NOT to game_flaws. (game_id, ply) are plain
    # reference columns resolved via a serve-time join — never cascaded from
    # game_flaws. See module docstring.
    game_id: Mapped[int] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), primary_key=True
    )
    ply: Mapped[int] = mapped_column(SmallInteger, primary_key=True)

    status: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    streak: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    due_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    fail_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
    ever_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


__all__ = ["DrillItem", "DrillStatus"]
