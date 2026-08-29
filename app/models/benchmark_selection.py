"""ORM for the benchmark_selection table (benchmark DB only).

Phase 212 BENCHLANE-01. Materializes the capped (100/user/TC), randomly-selected,
equal-footing tranche produced by `scripts/benchmark_lane.py select`. Created via
Base.metadata.create_all() against the benchmark engine -- NOT in the canonical
Alembic chain (Phase 69 INFRA-02 isolates the canonical schema; benchmark-only
tables stay out of dev/prod/test). See alembic/env.py's _AUTOGEN_TABLE_IGNORELIST
(D-08), which retroactively protects this table (and its sibling
benchmark_lichess_eval_snapshot) from a future `alembic revision --autogenerate`
emitting an accidental op.create_table against prod.

THIS TABLE IS THE REPRODUCIBILITY RECORD (D-01/D-16). Unlike a query re-run
against `games`, this table is the durable, replayable snapshot of exactly which
games were selected for the benchmark full-game-analysis lane, per TC tranche.
A data story cites this table directly, not a re-derivation of the selection
query against a moving `games` table.

The (game_id, tc_tranche) compound unique constraint makes re-running
`scripts/benchmark_lane.py select --tranche X` idempotent, and lets a game
eligible under two different TC tranches (which cannot happen today, since
tc_tranche is derived from games.time_control_bucket -- but the constraint is
future-proof against a re-bucketing) occupy one row per tranche rather than
being silently merged into one.

user_id is denormalized from games.user_id (rather than requiring a join to
games for every per-user progress query) so `scripts/benchmark_lane.py status`
can report per-user tranche progress without a join.

lichess_arm is captured at selection time from games.lichess_evals_at IS NOT
NULL (D-01/D-02/D-05) -- this is what makes the two eval-source arms (lichess-
analyzed vs never-analyzed) separable after BENCHMARK_HOMOGENIZE_EVAL_SOURCE
(212-04) overrides is_lichess_eval_game at claim time, without needing to
re-derive the arm split from a games column that homogenization does NOT touch
(games.lichess_evals_at itself is left untouched -- D-04 -- but the derived
is_lichess_eval_game boolean IS overridden by the flag, so the arm split must
be captured here at selection time, before any homogenization occurs).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.models.base import Base


class BenchmarkSelection(Base):
    """A game selected into the benchmark full-game-analysis lane for one TC tranche.

    game_id: FK to games.id, CASCADE on delete -- a selection row for a deleted
        game is meaningless (mirrors benchmark_ingest_checkpoint.py's FK precedent,
        not benchmark_selected_user.py, which has no FK at all).
    user_id: FK to users.id, CASCADE on delete, denormalized from games.user_id so
        `status` can report per-user progress without a join to games.
    tc_tranche: one of classical/rapid/blitz/bullet (TEXT + CHECK, never a native
        PostgreSQL ENUM, per CLAUDE.md's enum-column policy for low-cardinality
        domain columns).
    lichess_arm: true when games.lichess_evals_at IS NOT NULL at selection time --
        captures the D-01/D-02 arm split before BENCHMARK_HOMOGENIZE_EVAL_SOURCE
        (212-04) can override the derived is_lichess_eval_game boolean at claim
        time, so the two arms stay separable after homogenization runs.
    selected_at: when this row was inserted (selection time, not game time).
    armed: false until the tranche's lichess-eval snapshot is complete. The
        benchmark selection gate (app/services/eval_utils.py's
        selection_gate_clause) requires it, so an unarmed row is invisible to
        all five claim lanes and no worker can overwrite its evals.

        This exists because `select` and `snapshot` publish and protect in the
        wrong order. The instant `select` commits, every selected game
        satisfies the gate; `snapshot` -- the ONLY recovery path for the
        original lichess evals that BENCHMARK_HOMOGENIZE_EVAL_SOURCE
        overwrites in place -- then takes minutes. On the 2026-08-29 rapid
        tranche five lichess-arm games were processed inside that window. They
        survived only because _snapshot_source_sql is a single streaming
        SELECT whose MVCC snapshot predated them; a snapshot STARTED after
        processing began would have captured our engine's values and stored
        them as lichess's, silently, with the coverage-gap check still
        reporting zero because it counts rows rather than checking values.

        Arming is therefore gated on that coverage check (see
        arm_tranche in scripts/benchmark_lane.py): a tranche arms only when
        every lichess-arm game has snapshot rows. Note the direction of
        failure -- forget to arm and NOTHING drains, which is loud and
        harmless; the pre-armed behaviour failed the other way.

        Existing benchmark DBs need this column added by hand, since this
        table is deliberately outside the Alembic chain and create_all() does
        not alter an existing table:

            ALTER TABLE benchmark_selection
              ADD COLUMN armed boolean NOT NULL DEFAULT false;
            UPDATE benchmark_selection SET armed = true;  -- already-live tranches
    """

    __tablename__ = "benchmark_selection"
    __table_args__ = (
        UniqueConstraint(
            "game_id",
            "tc_tranche",
            name="uq_benchmark_selection_game_tranche",
        ),
        CheckConstraint(
            "tc_tranche IN ('bullet','blitz','rapid','classical')",
            name="ck_benchmark_selection_tc_tranche",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    game_id: Mapped[int] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    tc_tranche: Mapped[str] = mapped_column(String(20), nullable=False)
    lichess_arm: Mapped[bool] = mapped_column(Boolean, nullable=False)
    selected_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    armed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false"), default=False
    )
