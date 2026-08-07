"""phase 206 sharp filler source

Revision ID: e5f71b11fa51
Revises: 6e7e50844af5
Create Date: 2026-08-07 11:40:22.894826+00:00

Phase 206 Plan 01 Task 1 checkpoint decision (developer-approved
"as-specified"): three one-way schema/contract changes land together in one
revision, exactly as D-07/D-10/D-17 specify — no column-name substitutions.
`sharp_puzzle_id` is TEXT with no ForeignKey (an opaque external lichess
PuzzleId, not an enumeration — CLAUDE.md DB rule); `source` stays SMALLINT +
IntEnum + CHECK, widened additively (0,1 subset of 0,1,2) so no existing row
can violate it; `is_warmup` is a frozen-at-composition BOOLEAN NOT NULL
mirroring `puzzle_count`/`requested_count` on the same table.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5f71b11fa51'
down_revision: Union[str, Sequence[str], None] = '6e7e50844af5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("drill_solves", sa.Column("sharp_puzzle_id", sa.Text(), nullable=True))
    op.drop_constraint("ck_drill_solves_source", "drill_solves", type_="check")
    op.create_check_constraint("ck_drill_solves_source", "drill_solves", "source IN (0, 1, 2)")
    op.add_column(
        "drill_sessions",
        sa.Column("is_warmup", sa.Boolean(), server_default="false", nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema.

    Fully schema-reversible: none of the three changes has a data-loss step
    of its own beyond the columns/constraint themselves (unlike f2624e60292e's
    hard-reset UPDATE). Dropping `sharp_puzzle_id` discards any SHARP_FILLER
    identity already recorded, and restoring the narrower CHECK will raise if
    any `source = 2` row still exists — run only after removing/migrating
    such rows.
    """
    op.drop_column("drill_sessions", "is_warmup")
    op.drop_constraint("ck_drill_solves_source", "drill_solves", type_="check")
    op.create_check_constraint("ck_drill_solves_source", "drill_solves", "source IN (0, 1)")
    op.drop_column("drill_solves", "sharp_puzzle_id")
