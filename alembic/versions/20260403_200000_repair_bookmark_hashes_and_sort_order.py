"""Repair bookmark target_hash and sort_order.

Recomputes target_hash for all bookmarks by replaying stored moves through
python-chess and selecting the correct hash based on match_side + color.
Also fixes duplicate sort_orders within a user.

Revision ID: a1b2c3d4e5f6
Revises: fb1fad671a94
Create Date: 2026-04-03 20:00:00.000000+00:00
"""
from typing import Sequence, Union

import chess
import chess.polyglot
import ctypes
from alembic import op
import sqlalchemy as sa

revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'fb1fad671a94'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _color_hash(board: chess.Board, color: chess.Color) -> int:
    """Compute Zobrist hash for pieces of a single color (mirrors app.services.zobrist)."""
    color_pivot = 0 if color == chess.WHITE else 1
    h: int = 0
    for square in chess.scan_forward(board.occupied_co[color]):
        piece = board.piece_at(square)
        if piece is None:
            continue
        index = 64 * ((piece.piece_type - 1) * 2 + color_pivot) + square
        h ^= chess.polyglot.POLYGLOT_RANDOM_ARRAY[index]
    return ctypes.c_int64(h).value


def _compute_target_hash(moves_json: str, match_side: str, color: str | None) -> int | None:
    """Replay moves and compute the correct target_hash for the bookmark."""
    import json
    try:
        moves = json.loads(moves_json)
    except (json.JSONDecodeError, TypeError):
        return None

    board = chess.Board()
    for m in moves:
        try:
            board.push_san(m)
        except (chess.IllegalMoveError, chess.InvalidMoveError, chess.AmbiguousMoveError):
            return None

    # Select the right hash based on match_side + color
    if match_side == 'both':
        return ctypes.c_int64(chess.polyglot.zobrist_hash(board)).value
    elif match_side == 'mine':
        if color == 'white':
            return _color_hash(board, chess.WHITE)
        else:
            return _color_hash(board, chess.BLACK)
    elif match_side == 'opponent':
        if color == 'white':
            return _color_hash(board, chess.BLACK)
        else:
            return _color_hash(board, chess.WHITE)
    return None


def upgrade() -> None:
    conn = op.get_bind()

    # 1. Recompute target_hash for all bookmarks
    rows = conn.execute(
        sa.text("SELECT id, moves, match_side, color, target_hash FROM position_bookmarks")
    ).fetchall()

    updated = 0
    for row in rows:
        correct_hash = _compute_target_hash(row.moves, row.match_side, row.color)
        if correct_hash is not None and correct_hash != row.target_hash:
            conn.execute(
                sa.text("UPDATE position_bookmarks SET target_hash = :hash WHERE id = :id"),
                {"hash": correct_hash, "id": row.id},
            )
            updated += 1

    if updated:
        print(f"  Repaired target_hash for {updated} bookmark(s)")

    # 2. Fix duplicate sort_orders: re-number per user starting from 0
    users = conn.execute(
        sa.text("SELECT DISTINCT user_id FROM position_bookmarks")
    ).fetchall()

    sort_fixed = 0
    for (user_id,) in users:
        bookmarks = conn.execute(
            sa.text(
                "SELECT id, sort_order FROM position_bookmarks "
                "WHERE user_id = :uid ORDER BY sort_order, id"
            ),
            {"uid": user_id},
        ).fetchall()

        for i, bkm in enumerate(bookmarks):
            if bkm.sort_order != i:
                conn.execute(
                    sa.text("UPDATE position_bookmarks SET sort_order = :order WHERE id = :id"),
                    {"order": i, "id": bkm.id},
                )
                sort_fixed += 1

    if sort_fixed:
        print(f"  Renumbered sort_order for {sort_fixed} bookmark(s)")


def downgrade() -> None:
    """Data-only migration — no schema to revert. Stale hashes are not recoverable."""
    pass
