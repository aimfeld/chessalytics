"""phase 203 reminder intent

Revision ID: 6e7e50844af5
Revises: ca8c8fbc2080
Create Date: 2026-08-02 17:47:33.093501+00:00

OFFER-03/OFFER-05 (D-02/D-15): adds `reminder_intent_at`, a client-writable
nullable timestamp on `train_settings`, stamped when the user expresses
install intent from the iOS install-affordance tap. Unlike
`reminder_last_sent_on` (server-write-only, absent from both schemas),
`reminder_intent_at` is threaded through both `TrainSettingsResponse` and
`TrainSettingsUpdate` -- the full-replace PUT contract's client-writable side.

No backfill, no data migration: every existing row lands on NULL, meaning
"no install intent expressed yet."
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '6e7e50844af5'
down_revision: Union[str, Sequence[str], None] = 'ca8c8fbc2080'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "train_settings", sa.Column("reminder_intent_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("train_settings", "reminder_intent_at")
