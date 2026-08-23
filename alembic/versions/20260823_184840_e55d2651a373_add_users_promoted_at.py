"""add users.promoted_at

Revision ID: e55d2651a373
Revises: 0ac0176294fd
Create Date: 2026-08-23 18:48:40.822206+00:00

Adds a nullable timestamptz recording WHEN a user row that began life as a
guest session was promoted in place to a full account. NULL means never
promoted. Both promotion paths in app/services/guest_service.py now set
promoted_at=func.now() on the same UPDATE that flips is_guest, so the
activity dashboard can count guest conversions — and chart conversion
timing / time-to-conversion — without inspecting credential state.

A boolean was considered and rejected: a promoted guest keeps its original
created_at, so a boolean can only answer "of guests created in window W, how
many ever promoted" — a censored, retroactively-changing metric. A
timestamp additionally gives a promotion-date time series and time-to-
conversion, at identical storage cost. `promoted_at IS NOT NULL` is the
flag.

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

IMPORTANT: the backfilled promoted_at is set to created_at (the row's
signup date), NOT the true historical promotion date — the actual moment a
backfilled row was promoted is unrecoverable, since nothing on the row
recorded it before this column existed. Any promotion-date time series or
time-to-conversion computed from promoted_at is therefore meaningless for
rows backfilled by this migration; only rows promoted after this column
started recording carry a real promotion timestamp.
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
# (dashboard/queries.py) — see module docstring for why both halves matter,
# and why the backfilled value is the signup date, not the true promotion
# date.
_BACKFILL_PROMOTED_AT = """
    UPDATE users
    SET promoted_at = created_at
    WHERE NOT is_guest AND hashed_password = ''
"""


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "users",
        sa.Column("promoted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(_BACKFILL_PROMOTED_AT)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("users", "promoted_at")
