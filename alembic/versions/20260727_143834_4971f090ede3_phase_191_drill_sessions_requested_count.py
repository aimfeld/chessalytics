"""phase 191 drill sessions requested count

Revision ID: 4971f090ede3
Revises: 63cc8bcc472e
Create Date: 2026-07-27 14:38:34.606556+00:00

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "4971f090ede3"
down_revision: Union[str, Sequence[str], None] = "63cc8bcc472e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Phase 191 Plan 06 (191-06 UAT bug fix): adds `requested_count` to
    `drill_sessions` — the `puzzles_per_session` value actually in force at
    composition time, distinct from `puzzle_count` (how many puzzles the
    pool actually had material for). Additive, nullable, no backfill:
    existing rows get NULL, which
    `app.repositories.train_repository._discard_if_untouched_and_resized`
    treats as "never eligible for a resize-discard" (the conservative
    resume-as-is default) — there is no way to reconstruct what a
    pre-migration session's actual requested count was.
    """
    op.add_column(
        "drill_sessions",
        sa.Column("requested_count", sa.SmallInteger(), nullable=True),
    )
    op.create_check_constraint(
        "ck_drill_sessions_requested_count",
        "drill_sessions",
        "requested_count IS NULL OR requested_count BETWEEN 1 AND 50",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("ck_drill_sessions_requested_count", "drill_sessions", type_="check")
    op.drop_column("drill_sessions", "requested_count")
