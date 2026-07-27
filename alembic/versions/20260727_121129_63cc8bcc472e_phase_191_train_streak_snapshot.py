"""phase 191 train streak snapshot

Revision ID: 63cc8bcc472e
Revises: 10335efafdb4
Create Date: 2026-07-27 12:11:29.839564+00:00

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "63cc8bcc472e"
down_revision: Union[str, Sequence[str], None] = "10335efafdb4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Phase 191 Plan 01 (D-18): the settled-streak snapshot on train_settings.
    Additive only — three add_column calls with server defaults plus one
    check constraint, no UPDATE, no data backfill, no FK change. Existing
    rows get streak_count=0 (server default) and NULL for the other two
    columns, which is exactly the all-null snapshot that triggers a full-
    history replay on first settlement (D-05 retroactivity preserved).
    """
    op.add_column(
        "train_settings",
        sa.Column("streak_count", sa.SmallInteger(), server_default="0", nullable=False),
    )
    op.add_column("train_settings", sa.Column("flame_state", sa.Text(), nullable=True))
    op.add_column("train_settings", sa.Column("streak_settled_through", sa.Date(), nullable=True))
    op.create_check_constraint(
        "ck_train_settings_flame_state",
        "train_settings",
        "flame_state IN ('minimum', 'medium', 'maximum')",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("ck_train_settings_flame_state", "train_settings", type_="check")
    op.drop_column("train_settings", "streak_settled_through")
    op.drop_column("train_settings", "flame_state")
    op.drop_column("train_settings", "streak_count")
