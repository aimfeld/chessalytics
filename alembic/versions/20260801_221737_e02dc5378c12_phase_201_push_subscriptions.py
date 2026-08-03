"""phase 201 push subscriptions

Revision ID: e02dc5378c12
Revises: 2c248989d979
Create Date: 2026-08-01 22:17:37.387130+00:00

PUSH-01/PUSH-02: one row per browser Web Push subscription. CASCADE-only to
users.id (mirrors drill_sessions' FK shape). Unique on `endpoint` alone (not
(user_id, endpoint)) -- a browser returns the same endpoint URL on
re-subscribe, so that is the natural key, and it also stops one endpoint
being claimed by two user ids. `ix_push_subscriptions_user_id` is added
explicitly because PostgreSQL does not auto-index a FK column, and both the
fan-out lookup and the later candidate query key on it.

Does NOT touch train_settings -- the reminder_enabled/reminder_hour/
reminder_last_sent_on columns are plan 201-03's own migration.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e02dc5378c12'
down_revision: Union[str, Sequence[str], None] = '2c248989d979'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("endpoint", name="uq_push_subscriptions_endpoint"),
    )
    op.create_index(
        "ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_push_subscriptions_user_id", table_name="push_subscriptions")
    op.drop_table("push_subscriptions")
