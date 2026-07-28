"""SEED-125 games.blobs_completed_at

Adds `games.blobs_completed_at` — a fifth completion column, per-game rollup
of `game_flaws.allowed_pv_lines`, alongside the four documented in
.planning/notes/eval-completion-columns.md. Fixes the tier-4 blob-backfill
lottery's Stage 1 user pick (`_claim_tier4_blob` in
app/services/eval_queue_service.py), which today semi-joins `games` against
the whole `game_flaws` corpus (measured 84.8% of all prod DB time: 504h over
33 days, 2.5M calls at 727ms avg). A games-side partial index following the
existing `ix_games_bestmove_backfill_pending` idiom drops that to O(users)
instead of O(backlog) — prod EXPLAIN ANALYZE of the identical query shape
against an existing games-side index measured 340ms -> 7.5ms and 260k -> 1.8k
buffers.

One-time backfill stamps every analyzed game that has no remaining NULL-blob
flaw ply BEFORE the index is created, so the index build sees the final row
set. Games with remaining NULL-blob flaws stay NULL so the existing ~42k-game
backlog remains claimable. Guest games are NOT special-cased — they stay NULL
like everyone else (Stage 1 filters `is_guest = false`, the bloat is bounded,
and the work becomes claimable if a guest ever converts); do not "fix" this
by stamping them here.

Plain in-transaction `CREATE INDEX` — NOT `CONCURRENTLY`, following every
other partial-index migration on this table (ix_games_needs_engine_full_evals,
ix_games_lichess_pv_backfill_pending, ix_games_bestmove_backfill_pending,
e872c9deb514): migrations run against a quiescent backend at container
startup (deploy/entrypoint.sh runs `alembic upgrade head` before uvicorn
accepts traffic), and `CONCURRENTLY` cannot run inside a transaction.

`ix_games_blob_backfill_pending` is ORM-declared (app/models/game.py
__table_args__), unlike ix_game_flaws_blob_backfill — it does NOT go in
tests/test_migration_only_indexes_exist.py's MIGRATION_ONLY_INDEXES list.

Revision ID: 2c248989d979
Revises: f2624e60292e
Create Date: 2026-07-28 18:46:11.948568+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2c248989d979'
down_revision: Union[str, Sequence[str], None] = 'f2624e60292e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "games",
        sa.Column("blobs_completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    # One-time backfill: stamp every analyzed game that has no NULL-blob flaw
    # remaining. Run BEFORE the index is created so the index build sees the
    # final row set. Games with remaining NULL-blob flaws (the existing
    # backlog) stay NULL and claimable.
    op.execute(
        """
        UPDATE games g
        SET blobs_completed_at = now()
        WHERE g.full_evals_completed_at IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM game_flaws gf
              WHERE gf.game_id = g.id AND gf.allowed_pv_lines IS NULL
          )
        """
    )

    op.create_index(
        "ix_games_blob_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL"
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_games_blob_backfill_pending", table_name="games")
    op.drop_column("games", "blobs_completed_at")
