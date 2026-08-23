"""add users.is_promoted

Revision ID: e55d2651a373
Revises: 0ac0176294fd
Create Date: 2026-08-23 18:48:40.822206+00:00

Adds a stored flag marking a user row that began life as a guest session and
was promoted in place to a full account. Both promotion paths in
app/services/guest_service.py now set is_promoted=True on the same UPDATE
that flips is_guest, so the activity dashboard can count guest conversions
without inspecting credential state.

The backfill below recovers history for existing rows using the SQL twin of
the dashboard's *old* detection rule (not a guest, empty password hash), so
the published conversion number does not jump the day this column ships —
it is restated exactly, not corrected. Two facts a later reader would
otherwise have to re-derive:

  (a) A direct Google signup that was never a guest gets a generated random
      password hash from FastAPI-Users' `oauth_callback`, so it is correctly
      excluded by the empty-hash half of the predicate.
  (b) Guests themselves also carry the empty hash (see create_guest_user),
      which is why the "not a guest" half of the predicate is load-bearing —
      without it every still-guest row would be miscounted as promoted.

This backfill can only recover Google promotions: an email/password
promotion predating this column left no distinguishing mark on the row, so
those conversions are unrecoverable. That gap is exactly why the dashboard
keeps a "floor, not the true rate" caveat for the pre-flag period.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e55d2651a373'
down_revision: Union[str, Sequence[str], None] = '0ac0176294fd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# SQL twin of the dashboard's pre-change _PROMOTED_GUEST predicate
# (dashboard/queries.py) — see module docstring for why both halves matter.
_BACKFILL_IS_PROMOTED = """
    UPDATE users
    SET is_promoted = true
    WHERE NOT is_guest AND hashed_password = ''
"""


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "users",
        sa.Column("is_promoted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.execute(_BACKFILL_IS_PROMOTED)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("users", "is_promoted")
