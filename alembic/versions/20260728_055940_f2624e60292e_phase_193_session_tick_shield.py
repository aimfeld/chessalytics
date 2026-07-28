"""phase 193 session tick shield

Revision ID: f2624e60292e
Revises: 127c8bd364a6
Create Date: 2026-07-28 05:59:40.524126+00:00

Phase 193 Plan 01 Task 1 checkpoint decision (user-approved option-b, verbatim
ruling: "streaks haven't shipped. do a hard reset, we lose nothing."): drop
Phase 191's `flame_state` column + its CHECK, add the `shield_level`
SmallInteger + range CHECK and the nullable `pool_eligible_since` watermark,
then hard-reset the two carry-over columns (`streak_count = 0`,
`streak_settled_through = NULL`) with NO data-backfill statement.

D-05 (Phase 191 retroactivity) waiver, recorded explicitly rather than left
as a silent regression: Phase 190 DID ship (release #280), so the ~14
existing `drill_sessions` rows this reset discards from the new tick
machine's replay are real usage, not phantom rows — but Phase 191's streak
surface (the thing being rewritten here) never reached production, and this
is the developer's own pre-production data at a volume (13 `train_settings`
rows) too small to justify the correlated-subquery backfill option-a would
have required. `pool_eligible_since` is left NULL for every row (not
NOT NULL DEFAULT today — see app/models/train_settings.py's docstring): the
lazy-stamp path is D-06's intended go-forward mechanism for every user,
existing or new, so a brand-new user importing today is judged identically
to an existing user whose watermark has not yet been stamped.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f2624e60292e'
down_revision: Union[str, Sequence[str], None] = '127c8bd364a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_constraint("ck_train_settings_flame_state", "train_settings", type_="check")
    op.drop_column("train_settings", "flame_state")
    op.add_column(
        "train_settings",
        sa.Column("shield_level", sa.SmallInteger(), server_default="0", nullable=False),
    )
    # Literal bound, not an f-string off SHIELD_CAP — migrations are frozen
    # artifacts; the model derives the same bound from SHIELD_CAP at import
    # time, but this file must stand on its own forever.
    op.create_check_constraint(
        "ck_train_settings_shield_level", "train_settings", "shield_level BETWEEN 0 AND 7"
    )
    op.add_column("train_settings", sa.Column("pool_eligible_since", sa.Date(), nullable=True))
    # Task 1 checkpoint decision (option-b): hard-reset only, no backfill.
    # NULL streak_settled_through is exactly the state that triggers a full
    # replay under tick_days once pool_eligible_since is later lazily
    # stamped — see the module docstring above for the D-05 waiver this
    # implies (no backfill means pre-migration history is not replayed).
    op.execute("UPDATE train_settings SET streak_count = 0, streak_settled_through = NULL")


def downgrade() -> None:
    """Downgrade schema.

    Schema-reversible; the data half is not. The hard-reset UPDATE cannot be
    undone (the pre-migration `streak_count`/`streak_settled_through` values
    are gone), and `flame_state` cannot be reconstructed from `shield_level`
    (no valid week-state <-> pip-count translation exists — see the Task 1
    checkpoint decision). Every existing row lands back on `flame_state`
    NULL / a zeroed snapshot, i.e. "never settled", which is the same safe
    state the upgrade itself produces.
    """
    op.drop_column("train_settings", "pool_eligible_since")
    op.drop_constraint("ck_train_settings_shield_level", "train_settings", type_="check")
    op.drop_column("train_settings", "shield_level")
    op.add_column("train_settings", sa.Column("flame_state", sa.TEXT(), autoincrement=False, nullable=True))
    op.create_check_constraint(
        "ck_train_settings_flame_state",
        "train_settings",
        "flame_state IN ('minimum', 'medium', 'maximum')",
    )
