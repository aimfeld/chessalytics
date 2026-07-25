"""add worker hole counters

Quick task 260725-da3 (FLAWCHESS-8B): adds two accumulating per-worker counters to
worker_heartbeats so a per-worker hole RATE (holes_submitted / plies_leased) can be
computed from the DB.

Why they are needed: the holed-game population is entirely tier-3 idle-lottery
derived, so eval_jobs.leased_by is NULL for all of it and the Path-C Sentry event
carried no worker identity — "is it one slow worker?" was unanswerable. Both
counters are fed ONLY by the atomic-submit lane (entry-submit and flaw-blob-submit
pass the repository defaults of 0), which keeps the rate's denominator lane-pure,
unlike evals_submitted which mixes all three lanes.

server_default='0' is permanent, not a one-shot backfill shim: it lets the ~120
existing prod rows adopt NOT NULL atomically at upgrade, and it causes no
autogenerate drift because compare_server_default is not enabled in alembic/env.py
(same precedent as 20260526_000000_add_n_games_to_user_benchmark_percentiles).

Passive telemetry only — neither column gates anything or feeds an authz decision.

Revision ID: dbf963851fe0
Revises: e872c9deb514
Create Date: 2026-07-25 07:49:29.628763+00:00

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "dbf963851fe0"
down_revision: Union[str, Sequence[str], None] = "e872c9deb514"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "worker_heartbeats",
        sa.Column("holes_submitted", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "worker_heartbeats",
        sa.Column("plies_leased", sa.BigInteger(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("worker_heartbeats", "plies_leased")
    op.drop_column("worker_heartbeats", "holes_submitted")
