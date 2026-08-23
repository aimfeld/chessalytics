"""ORM for the benchmark_lichess_eval_snapshot table (benchmark DB only).

Phase 212 BENCHLANE-05 (D-05). Preserves the ORIGINAL lichess-provided evals
(`game_positions.eval_cp` / `.eval_mate`) for every selected lichess-arm game,
captured via `scripts/benchmark_lane.py snapshot` at tranche start -- BEFORE
BENCHMARK_HOMOGENIZE_EVAL_SOURCE (212-04) causes the drain write path to
overwrite those columns in place with our own Stockfish's values. Created via
Base.metadata.create_all() against the benchmark engine -- NOT in the
canonical Alembic chain (Phase 69 INFRA-02 isolates the canonical schema;
benchmark-only tables stay out of dev/prod/test). See alembic/env.py's
_AUTOGEN_TABLE_IGNORELIST (D-08), which protects this table (and its sibling
benchmark_selection) from a future `alembic revision --autogenerate` emitting
an accidental op.create_table against prod.

THIS TABLE IS THE ONLY RECOVERY PATH for the lichess evals that homogenization
overwrites in place. D-03's homogenization is explicitly "costly" reversibility
-- the written eval_cp values for touched games are overwritten in place, and
recovery depends on this snapshot existing. Without it, the overwrite would be
irreversible rather than merely costly; this table is what keeps it costly
(a restore + re-diff) instead of a data-loss event. 212-06's decision
checkpoint blocks the classical run until snapshot coverage is verified
against the selected lichess arm.

Captures BOTH eval_cp and eval_mate, not eval_cp alone. D-05's sketch names
only `(game_id, ply, eval_cp)`, but game_positions stores a mate-scored
position as `eval_cp IS NULL` with `eval_mate` set instead -- an eval_cp-only
snapshot would silently lose every mate ply and make both the restore path
and the paired lichess-vs-ours sanity check wrong at exactly the positions
where the two engines are most likely to disagree (a mate-in-N line is where
divergence is most interesting, not least).

The (game_id, ply) compound unique constraint makes re-running
`scripts/benchmark_lane.py snapshot --tranche X` idempotent -- a ply already
captured is skipped, never duplicated or overwritten.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    ForeignKey,
    SmallInteger,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.models.base import Base


class BenchmarkLichessEvalSnapshot(Base):
    """A preserved (game_id, ply) lichess eval, captured before homogenization runs.

    game_id: FK to games.id, CASCADE on delete -- a snapshot row for a deleted
        game is meaningless (mirrors benchmark_ingest_checkpoint.py's FK
        precedent, not benchmark_selected_user.py, which has no FK at all).
    ply: half-move number, matching game_positions.ply.
    eval_cp: the original lichess-provided centipawn eval, NULL when the
        position was mate-scored instead.
    eval_mate: the original lichess-provided mate-in-N eval, NULL when the
        position was centipawn-scored instead. See module docstring -- this
        is why the table is NOT eval_cp-only.
    captured_at: when this row was inserted (snapshot time, not game time).
    """

    __tablename__ = "benchmark_lichess_eval_snapshot"
    __table_args__ = (
        UniqueConstraint(
            "game_id",
            "ply",
            name="uq_benchmark_lichess_eval_snapshot_game_ply",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    eval_cp: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    eval_mate: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    captured_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
