"""ORM model for drill_solves — a frozen, pre-materialized per-puzzle row (Phase 189).

Phase 189 Plan 01 (POOL-07/POOL-08, D-09/P-07). One row per puzzle selected at
session-composition time, inserted immediately with `solved_at = NULL` (P-07:
pre-materialized, not insert-on-attempt). This is what makes D-09's "frozen
list, stable '4 of 12' progress across a resumed mid-window session" cheap:
"remaining" is `WHERE session_id = ? AND solved_at IS NULL`, no re-derivation
of the original composition needed. The solve endpoint becomes an UPDATE, not
an INSERT.

`game_id`/`ply` FK/reference to `games(id) ON DELETE CASCADE` (mirroring
`drill_items`' D-02 anchoring): a mid-window game deletion cascades this row
away for free, which is exactly D-09's "items evicted underneath mid-window"
behavior with zero extra application code.

Per D-01, this table stores NO answer-key snapshot: `correct_move`/
`correct_guess`/`played_move` are the RECORDED OUTCOME of an attempt (written
by POST /train/sessions/{id}/solve, Plan 05), never a cached copy of
`best_move`/`pv`/the sharp-soft classification itself.
"""

from __future__ import annotations

import datetime
from enum import IntEnum

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class DrillSource(IntEnum):
    """Which pool a puzzle was drawn from (POOL-07 75/25 mix)."""

    SR_ITEM = 0
    RED_HERRING = 1


class DrillGuess(IntEnum):
    """The user's pre-attempt "is this critical or several fine" guess (P-02)."""

    SEVERAL = 0
    CRITICAL = 1


class DrillMoveQuality(IntEnum):
    """Tiered move-quality grade for the played move (SEED-119).

    Members are ordered so the member value equals the move points awarded
    (0/1/2 of the 2 move points in the 1-guess + 2-move = 3 total scoring
    scheme). This is a readability convenience only — the actual scoring
    formula lives client-side in `frontend/src/lib/trainScore.ts`, which is
    the single source of truth; nothing here should be used to compute a
    score directly.
    """

    WRONG = 0
    INACCURACY = 1
    GOOD = 2


class DrillSolve(Base):
    """One row per puzzle in a frozen session, pre-inserted at composition time."""

    __tablename__ = "drill_solves"
    __table_args__ = (
        CheckConstraint("source IN (0, 1)", name="ck_drill_solves_source"),
        CheckConstraint("guess IS NULL OR guess IN (0, 1)", name="ck_drill_solves_guess"),
        CheckConstraint(
            "move_quality IS NULL OR move_quality IN (0, 1, 2)",
            name="ck_drill_solves_move_quality",
        ),
        UniqueConstraint("session_id", "game_id", "ply", name="uq_drill_solves_session_puzzle"),
    )

    session_id: Mapped[int] = mapped_column(
        ForeignKey("drill_sessions.id", ondelete="CASCADE"), primary_key=True
    )
    # 0-based frozen order within the session — the "4 of 12" position.
    position: Mapped[int] = mapped_column(SmallInteger, primary_key=True)

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    # D-02-mirrored anchoring: FK to games(id) only, plain ply reference column.
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    source: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    # P-02: the user's raw pre-attempt guess, submitted by the client. NULL
    # until attempted.
    guess: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    correct_guess: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    correct_move: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Tiered move-quality grade (SEED-119): 0=wrong, 1=inaccuracy, 2=good, per
    # DrillMoveQuality. NULL means this row was recorded before SEED-119
    # shipped (go-forward only, no backfill) — `correct_move` above still
    # carries that legacy row's boolean outcome.
    move_quality: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    played_move: Mapped[str | None] = mapped_column(String(5), nullable=True)
    # NULL = not yet attempted (P-07). Non-NULL = this puzzle's recorded outcome.
    solved_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


__all__ = ["DrillGuess", "DrillMoveQuality", "DrillSolve", "DrillSource"]
