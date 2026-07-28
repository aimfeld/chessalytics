"""phase 191 train settings new defaults

Revision ID: b1724dc27de8
Revises: 4971f090ede3
Create Date: 2026-07-27 14:38:52.896320+00:00

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b1724dc27de8"
down_revision: Union[str, Sequence[str], None] = "4971f090ede3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Phase 191 Plan 06 (191-06 UAT bug fix): new-row defaults for
    `train_settings.weekday_mask` (0 -> 127, all 7 weekday bits set) and
    `puzzles_per_session` (12 -> 6). See
    `app.services.train_scheduler.DEFAULT_WEEKDAY_MASK`/
    `DEFAULT_PUZZLES_PER_SESSION` for the full rationale — in short: the old
    weekday_mask=0 default rendered every chip on the schedule picker as
    UNCHECKED, reading as "nothing configured" rather than its actual
    meaning ("any day works"). `required_sessions_per_week` now treats
    weekday_mask 0 and 127 identically (both require exactly 1 session/week,
    never 7), so this is a pure display-default change with no behavior
    difference for any account.

    Data backfill: this feature (the schedule-settings UI) has not shipped
    to production yet — every `train_settings` row that currently holds the
    OLD default values is, by construction, a row nobody has explicitly
    edited via the new UI (the debounced auto-save only fires once
    `hasEditedRef` is set by an actual chip/preset click). Rows still at
    weekday_mask=0 or puzzles_per_session=12 are backfilled to the new
    defaults so any account already touched during this phase's UAT
    (dev/staging) sees the corrected picker state immediately, rather than
    only on the next brand-new row. This backfill is safe specifically
    because the feature is pre-release; it would NOT be the correct move
    after real users have had a chance to explicitly choose 0/12.
    """
    op.execute("UPDATE train_settings SET weekday_mask = 127 WHERE weekday_mask = 0")
    op.execute("UPDATE train_settings SET puzzles_per_session = 6 WHERE puzzles_per_session = 12")
    op.alter_column(
        "train_settings",
        "weekday_mask",
        server_default="127",
        existing_type=sa.SmallInteger(),
        existing_nullable=False,
    )
    op.alter_column(
        "train_settings",
        "puzzles_per_session",
        server_default="6",
        existing_type=sa.SmallInteger(),
        existing_nullable=False,
    )


def downgrade() -> None:
    """Downgrade schema.

    Restores the old server_defaults only — does NOT reverse the one-time
    data backfill (that would silently re-narrow an already-corrected
    picker for accounts touched during this phase's UAT, which is not a
    "downgrade" any caller of this migration's rollback path would want).
    """
    op.alter_column(
        "train_settings",
        "weekday_mask",
        server_default="0",
        existing_type=sa.SmallInteger(),
        existing_nullable=False,
    )
    op.alter_column(
        "train_settings",
        "puzzles_per_session",
        server_default="12",
        existing_type=sa.SmallInteger(),
        existing_nullable=False,
    )
