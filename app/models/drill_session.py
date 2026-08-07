"""ORM model for drill_sessions — a materialized Train session header (Phase 189).

Phase 189 Plan 01 (POOL-07, D-04/D-09/D-10/D-12). One row per composed
session: `status` tracks the D-09/D-10/D-11 lifecycle (open -> completed, or
open -> expired on the arrival of the next scheduled session day), and
`expires_on` implements D-10's "open until the next scheduled session day
starts" window (computed via `app.services.train_scheduler.session_window`).

Deletion semantics (D-04, LOCKED — do not "fix" this to FK `games`):
  `drill_sessions` FKs ONLY to `users(id) ON DELETE CASCADE` — there is no
  `game_id` column and no cascade from any game-scoped delete. Session
  dates/scores are user progress (the Phase 191 weekly-streak source), not
  game-derived data, and are meant to SURVIVE a game wipe (delete-all +
  re-import, or the guest-prune job). This directly diverges from how
  `drill_items`/`drill_solves` anchor to `games` — that divergence is
  intentional, not an inconsistency to reconcile.
"""

from __future__ import annotations

import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DrillSession(Base):
    """One row per Train session (composed or resumed), user-scoped only."""

    __tablename__ = "drill_sessions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('open', 'completed', 'expired')", name="ck_drill_sessions_status"
        ),
        CheckConstraint(
            "requested_count IS NULL OR requested_count BETWEEN 1 AND 50",
            name="ck_drill_sessions_requested_count",
        ),
        # D-12: at most one OPEN session per user — enforced as a partial unique
        # index rather than a plain UniqueConstraint(user_id) so completed/expired
        # history rows are unrestricted.
        Index(
            "uq_drill_sessions_user_open",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    session_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    # TEXT + CHECK per CLAUDE.md DB rules (low-volume domain column, not a
    # high-cardinality enum) — no native ENUM.
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    puzzle_count: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    # Phase 191 Plan 06 (191-06 UAT bug fix): the `puzzles_per_session` value
    # ACTUALLY in force at composition time — bounds mirror
    # `train_settings.puzzles_per_session`'s own CHECK (D-08). NULL for rows
    # from before this column existed (and for any direct test fixture that
    # doesn't set it) — `app.repositories.train_repository
    # ._discard_if_untouched_and_resized` treats NULL as "never eligible for
    # a resize-discard", the conservative (resume-as-is) default. This is
    # DELIBERATELY separate from `puzzle_count`: a session can legitimately
    # serve FEWER puzzles than requested when the pool is short on material
    # (the D-14 "short session" state) — that must never be mistaken for a
    # stale `puzzles_per_session` that needs recomposing.
    requested_count: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    expires_on: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    started_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Phase 206 (D-06/D-07): frozen at composition, same precedent as
    # puzzle_count/requested_count above — is_warmup is computed exactly
    # once (`len(surviving_sr_keys) == 0`) at composition time and never
    # recomputed on resume, so the label provably cannot be shed mid-session
    # even if the ES lottery lands material in between. Written and read in
    # plan 03; this plan (206-01) only adds the column.
    is_warmup: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")


__all__ = ["DrillSession"]
