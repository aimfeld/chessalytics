"""phase 201 train reminder columns

Revision ID: ca8c8fbc2080
Revises: e02dc5378c12
Create Date: 2026-08-01 22:53:58.423406+00:00

REMIND-01/D-06/D-18: adds the reminder configuration to `train_settings`.
`reminder_enabled`/`reminder_hour` are user-owned settings, defaulted through
`app.repositories.train_repository.get_or_create_settings` at the application
layer (server_default here exists only for direct-INSERT parity, matching
`weekday_mask`/`puzzles_per_session`). `reminder_last_sent_on` is the D-06
"already sent today" watermark -- structurally identical to
`streak_settled_through`, written ONLY by the reminder job's claim UPDATE
(plan 201-04), never client-writable.

No backfill, no data migration: every existing row lands on the server
defaults, which is exactly the state a never-configured user should have.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ca8c8fbc2080'
down_revision: Union[str, Sequence[str], None] = 'e02dc5378c12'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "train_settings",
        sa.Column("reminder_enabled", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "train_settings",
        sa.Column("reminder_hour", sa.SmallInteger(), server_default="18", nullable=False),
    )
    # Literal bound, not an f-string off REMINDER_HOUR_MIN/MAX -- migrations
    # are frozen artifacts; the model derives the same bound from those
    # constants at import time, but this file must stand on its own forever.
    op.create_check_constraint(
        "ck_train_settings_reminder_hour", "train_settings", "reminder_hour BETWEEN 0 AND 23"
    )
    op.add_column("train_settings", sa.Column("reminder_last_sent_on", sa.Date(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("train_settings", "reminder_last_sent_on")
    op.drop_constraint("ck_train_settings_reminder_hour", "train_settings", type_="check")
    op.drop_column("train_settings", "reminder_hour")
    op.drop_column("train_settings", "reminder_enabled")
