"""realign ix_games_bestmove_backfill_pending predicate

Drops the trailing `AND lichess_evals_at IS NULL` clause from
ix_games_bestmove_backfill_pending's partial-index predicate so it matches
_claim_tier4_bestmove's live claim query (Phase 188/SEED-115 D-07).

Quick 260719-fsz dropped `lichess_evals_at IS NULL` from the Stage-1/Stage-2
claim predicate in eval_queue_service.py (to admit lichess-eval orphan
self-healing through the tier-4b lane), but the partial index backing that
query was never updated to match — this migration realigns the INDEX to the
QUERY (not the reverse), per D-07's locked direction.

Created non-concurrently (inside transaction), following the project's other
partial-index migrations on this table (ix_games_needs_engine_full_evals,
ix_games_pv_backfill_pending, ix_games_lichess_pv_backfill_pending): migrations
run against a quiescent backend at container startup (deploy/entrypoint.sh
runs `alembic upgrade head` before uvicorn accepts traffic), and CONCURRENTLY
cannot run inside a transaction.

Revision ID: e872c9deb514
Revises: f09f8dee4aee
Create Date: 2026-07-24 19:27:41.488772+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e872c9deb514'
down_revision: Union[str, Sequence[str], None] = 'f09f8dee4aee'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_index(
        "ix_games_bestmove_backfill_pending",
        table_name="games",
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
            " AND lichess_evals_at IS NULL"
        ),
    )
    op.create_index(
        "ix_games_bestmove_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        "ix_games_bestmove_backfill_pending",
        table_name="games",
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        ),
    )
    op.create_index(
        "ix_games_bestmove_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
            " AND lichess_evals_at IS NULL"
        ),
    )
