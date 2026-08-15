"""phase 210 games initial fen

Revision ID: 0ac0176294fd
Revises: e5f71b11fa51
Create Date: 2026-08-15 08:47:11.530762+00:00

Phase 210 (SEED-042). Adds `games.initial_fen`, the game's starting position when
it is not the standard one, and backfills it from the already-stored PGN.

The backfill lives here rather than in a script (D-04): `games.pgn` is `Text NOT
NULL`, so every affected row can be repaired from data we already have — no
re-import — and Alembic runs automatically on backend container startup
(`deploy/entrypoint.sh`), so there is no manual production step and no window in
which the column exists but is empty. ~176 affected rows in production.

The `<> 'rnbqkbnr/...'` predicate is the SQL mirror of D-05: a `[SetUp "1"]`
naming the standard starting position is not a custom start, and such a game must
stay eligible as an opening-transition sample representative. It compares piece
placement only, which is sufficient here — the standard placement uniquely
identifies the standard start in practice, and the Python helper
(`normalization.non_standard_root_fen`) applies the stricter canonical comparison
on the import path. `tests/test_normalization.py::test_migration_sql_matches_extract_initial_fen`
pins the two against each other on shared fixtures (D-06).
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0ac0176294fd'
down_revision: Union[str, Sequence[str], None] = 'e5f71b11fa51'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Piece-placement field of the standard starting position. Kept as a module
# constant so the backfill and the agreement test read the same literal.
STANDARD_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR"

# Structural gate mirroring the Python helper's `chess.Board(fen)` validation.
# Without it the two diverge on a malformed header: python-chess raises and
# extract_initial_fen returns None, while a bare substring() would happily store
# the garbage. That matters beyond tidiness — `initial_fen` is handed to
# `new Chess(fen)` on the analysis board, and an unparseable value throws there,
# reintroducing the very crash this phase fixes from a different direction.
#
# Eight '/'-separated ranks of piece/digit characters, then the side to move.
# Deliberately structural, not a full legality check: PostgreSQL cannot count
# kings, and a syntactically valid FEN is enough for chess.js to construct a
# board. The Python path remains the stricter of the two, which is the safe
# direction — a row this admits and python-chess would reject is still a
# parseable position.
_FEN_SHAPE = r"^([1-8pnbrqkPNBRQK]+/){7}[1-8pnbrqkPNBRQK]+ [wb]( |$)"

# The backfill's extraction expression, exported so the D-06 agreement test can
# execute the exact SQL this migration ran rather than a paraphrase of it.
BACKFILL_SQL = f"""
    UPDATE games
    SET initial_fen = btrim(substring(pgn from '\\[\\s*FEN\\s+"([^"]*)"\\s*\\]'))
    WHERE pgn ~ '\\[\\s*SetUp\\s+"1"\\s*\\]'
      AND substring(pgn from '\\[\\s*FEN\\s+"([^"]*)"\\s*\\]') IS NOT NULL
      AND btrim(substring(pgn from '\\[\\s*FEN\\s+"([^"]*)"\\s*\\]')) ~ '{_FEN_SHAPE}'
      AND split_part(
              btrim(substring(pgn from '\\[\\s*FEN\\s+"([^"]*)"\\s*\\]')), ' ', 1
          ) <> '{STANDARD_PLACEMENT}'
"""


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable add — metadata-only in PostgreSQL, so no rewrite of a large table.
    op.add_column("games", sa.Column("initial_fen", sa.Text(), nullable=True))
    op.execute(sa.text(BACKFILL_SQL))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("games", "initial_fen")
