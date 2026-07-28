"""phase 192 drill_solves game_id nullable

Revision ID: 127c8bd364a6
Revises: 03df30e3c008
Create Date: 2026-07-27 23:48:44.284703+00:00

Phase 192 Plan 02 (D-05, the phase's one-way door): `drill_solves.game_id`
goes from NOT NULL + ON DELETE CASCADE to nullable + ON DELETE SET NULL. No
data backfill is needed or performed — every existing row has a non-NULL
`game_id` today; only new pool-sourced herring rows can end up NULL, and only
after their source game is later deleted.

Task 1 checkpoint decision (user-approved option-a): both halves (nullability
+ FK policy) land in this single in-place ALTER, after Task 2's three
outer-join fixes to app/repositories/train_repository.py are already
committed — landing this migration against a tree that still has any INNER
JOIN on DrillSolve.game_id would silently drop puzzles from a resumed
session (see that commit's docstring updates for the full reasoning).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "127c8bd364a6"
down_revision: Union[str, Sequence[str], None] = "03df30e3c008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("drill_solves", "game_id", existing_type=sa.INTEGER(), nullable=True)
    op.drop_constraint("drill_solves_game_id_fkey", "drill_solves", type_="foreignkey")
    op.create_foreign_key(
        "drill_solves_game_id_fkey",
        "drill_solves",
        "games",
        ["game_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    """Downgrade schema.

    LOSSY BY NECESSITY, but faithful: rows with a NULL `game_id` are deleted
    before NOT NULL is restored.

    Bug fix (found in phase-192 verification): the original downgrade() went
    straight to `ALTER COLUMN game_id SET NOT NULL` and simply documented
    that it would fail once any NULL existed. That is not merely a
    theoretical one-way door — it broke the serial test suite outright. Any
    later migration test that downgrades past this revision (e.g.
    tests/test_migration_91_evals_completed_at.py) traverses this function,
    and by then this phase's own tests have legitimately created NULL-
    `game_id` rows, so the ALTER raised
    `column "game_id" contains null values` and cascaded 16 failures.

    Deleting those rows is the CORRECT inverse, not a workaround. Before this
    phase the FK was ON DELETE CASCADE, so deleting a game removed its
    `drill_solves` rows outright — a NULL-`game_id` row is precisely a row
    the pre-migration schema could never hold. Removing them restores exactly
    the state the old schema would have been in. There is no source game left
    to recover a value from, and a pool-sourced herring has no meaning under
    the pre-phase `game_best_moves` sourcing anyway.
    """
    # Faithful inverse of SET NULL replacing CASCADE — see docstring.
    op.execute("DELETE FROM drill_solves WHERE game_id IS NULL")
    op.drop_constraint("drill_solves_game_id_fkey", "drill_solves", type_="foreignkey")
    op.create_foreign_key(
        "drill_solves_game_id_fkey",
        "drill_solves",
        "games",
        ["game_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.alter_column("drill_solves", "game_id", existing_type=sa.INTEGER(), nullable=False)
