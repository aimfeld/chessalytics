"""ORM model for drill_solves — a frozen, pre-materialized per-puzzle row (Phase 189).

Phase 189 Plan 01 (POOL-07/POOL-08, D-09/P-07). One row per puzzle selected at
session-composition time, inserted immediately with `solved_at = NULL` (P-07:
pre-materialized, not insert-on-attempt). This is what makes D-09's "frozen
list, stable '4 of 12' progress across a resumed mid-window session" cheap:
"remaining" is `WHERE session_id = ? AND solved_at IS NULL`, no re-derivation
of the original composition needed. The solve endpoint becomes an UPDATE, not
an INSERT.

Phase 192 Plan 02 (D-05, the phase's one-way door): `game_id` is now
`ON DELETE SET NULL`, NOT `CASCADE` as originally shipped in Phase 189. With
a GLOBAL herring pool (Phase 192), a *foreign* user deleting one of their own
games must never delete a row out of a STRANGER's in-flight session —
`drill_solves` rows ARE the session's frozen puzzle list (PK `(session_id,
position)`), so a CASCADE-delete here would punch a hole in the position
sequence and shift the session-score denominator for a user who did nothing.
Only a global pool (shared across users) can produce this failure mode; the
pre-Phase-192 CASCADE was correct when every herring/SR item was necessarily
the solving user's own game.

The row now survives its source game's deletion with `game_id` NULL instead
of being deleted. "Still servable" after that now means two DIFFERENT things
depending on `source` (see `app.repositories.train_repository`'s
`load_session_puzzles` / `_mark_session_complete_if_done` / `reveal_for_puzzle`
docstrings for the full branch semantics):
- A `RED_HERRING` row stays servable — its FEN/arriving move live on the
  `herring_pool` row (D-03), self-sufficient regardless of the game link.
- An `SR_ITEM` row becomes unservable (its answer key was the game's own
  PGN) and is lazily evicted — the pre-D-05 CASCADE behavior for SR items is
  preserved exactly, just via an application-level exclusion instead of a
  deleted row.

`uq_drill_solves_session_puzzle` (`session_id`, `game_id`, `ply`) no longer
protects a row whose `game_id` has nulled out — PostgreSQL treats NULLs as
distinct in a unique constraint, so two nulled rows in the same session would
not collide on this index. This is acceptable and deliberate: the
constraint's real job is to stop *composition* from inserting the same
position twice, and at composition time every row still has a non-NULL
`game_id` (composition additionally drops an own-game herring colliding with
an SR pick, Plan 01 D-10). Do NOT add a partial unique index on
`herring_pool_id` "for safety" — it would forbid the exhaustion fallback
(`herring_stmt(..., exclude_served=False)`) from ever re-serving a pool row
in a later session.

Per D-01, this table stores NO answer-key snapshot: `correct_move`/
`correct_guess`/`played_move` are the RECORDED OUTCOME of an attempt (written
by POST /train/sessions/{id}/solve, Plan 05), never a cached copy of
`best_move`/`pv`/the sharp-soft classification itself.

Phase 192 (D-04): `herring_pool_id` is the herring's authoritative no-repeat
key. Once `drill_solves.game_id`/`ply` can no longer be trusted as a stable
identity for a herring puzzle (the source game link is nullable, D-01/D-05),
`(game_id, ply)` is no longer usable for that purpose — the no-repeat
exclusion in `herring_stmt` keys on `herring_pool_id` instead. NULL for every
pre-Phase-192 row and every SR row (a herring's `herring_pool_id` is the only
non-NULL case).
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
    # Phase 192 Plan 02 (D-05, one-way door): nullable + SET NULL, was NOT
    # NULL + CASCADE in Phase 189 — see module docstring for the full
    # rationale (a global pool means a foreign user's game deletion must
    # never delete a row out of another user's session).
    game_id: Mapped[int | None] = mapped_column(
        ForeignKey("games.id", ondelete="SET NULL"), nullable=True
    )
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False)

    # Phase 192 D-04: the herring's authoritative no-repeat key. NULL for
    # every SR row and every pre-Phase-192 row (see module docstring).
    herring_pool_id: Mapped[int | None] = mapped_column(
        ForeignKey("herring_pool.id", ondelete="SET NULL"), nullable=True
    )

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
