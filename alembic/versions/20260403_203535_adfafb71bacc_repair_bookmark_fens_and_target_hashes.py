"""Repair bookmark and openings table FENs and target hashes.

Replays stored moves/PGN for every bookmark and opening to produce the correct
full FEN (with side-to-move, castling, en passant metadata) and recomputes
target_hash for bookmarks.

Board-only FENs (missing metadata) caused update_match_side to produce wrong
full_hash values because polyglot zobrist hashing includes side-to-move.
The openings table (source for bookmark suggestions) also stored board-only FENs,
so bookmarks created via Suggest inherited the wrong FEN.

Revision ID: adfafb71bacc
Revises: a1b2c3d4e5f6
Create Date: 2026-04-03 20:35:35.808285+00:00
"""
from typing import Sequence, Union

import chess
import chess.pgn
import chess.polyglot
import ctypes
import io
import json

from alembic import op
import sqlalchemy as sa


revision: str = 'adfafb71bacc'
down_revision: Union[str, Sequence[str], None] = 'a1b2c3d4e5f6'
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


def upgrade() -> None:
    conn = op.get_bind()

    rows = conn.execute(
        sa.text("SELECT id, moves, match_side, color, target_hash, fen FROM position_bookmarks")
    ).fetchall()

    fen_fixed = 0
    hash_fixed = 0

    for row in rows:
        try:
            moves = json.loads(row.moves)
        except (json.JSONDecodeError, TypeError):
            continue

        board = chess.Board()
        try:
            for m in moves:
                board.push_san(m)
        except (chess.IllegalMoveError, chess.InvalidMoveError, chess.AmbiguousMoveError):
            continue

        correct_fen = board.fen()
        full_hash = ctypes.c_int64(chess.polyglot.zobrist_hash(board)).value

        # Compute correct target_hash based on match_side + color
        if row.match_side == 'mine':
            if row.color == 'white':
                correct_hash = _color_hash(board, chess.WHITE)
            else:
                correct_hash = _color_hash(board, chess.BLACK)
        elif row.match_side == 'opponent':
            if row.color == 'white':
                correct_hash = _color_hash(board, chess.BLACK)
            else:
                correct_hash = _color_hash(board, chess.WHITE)
        else:
            correct_hash = full_hash

        updates = {}
        if row.fen != correct_fen:
            updates['fen'] = correct_fen
            fen_fixed += 1
        if correct_hash != row.target_hash:
            updates['hash'] = correct_hash
            hash_fixed += 1

        if updates:
            if 'fen' in updates and 'hash' in updates:
                conn.execute(
                    sa.text("UPDATE position_bookmarks SET fen = :fen, target_hash = :hash WHERE id = :id"),
                    {"fen": updates['fen'], "hash": updates['hash'], "id": row.id},
                )
            elif 'fen' in updates:
                conn.execute(
                    sa.text("UPDATE position_bookmarks SET fen = :fen WHERE id = :id"),
                    {"fen": updates['fen'], "id": row.id},
                )
            elif 'hash' in updates:
                conn.execute(
                    sa.text("UPDATE position_bookmarks SET target_hash = :hash WHERE id = :id"),
                    {"hash": updates['hash'], "id": row.id},
                )

    if fen_fixed or hash_fixed:
        print(f"  Repaired {fen_fixed} bookmark FEN(s) and {hash_fixed} bookmark target_hash(es)")

    # Also fix openings table — board-only FENs were stored by seed_openings.py,
    # causing bookmarks created via Suggest to inherit wrong FENs.
    opening_rows = conn.execute(
        sa.text("SELECT id, pgn, fen FROM openings")
    ).fetchall()

    openings_fixed = 0
    for orow in opening_rows:
        try:
            game = chess.pgn.read_game(io.StringIO(orow.pgn))
            if game is None:
                continue
            board = game.board()
            for move in game.mainline_moves():
                board.push(move)
            correct_fen = board.fen()
            if orow.fen != correct_fen:
                conn.execute(
                    sa.text("UPDATE openings SET fen = :fen WHERE id = :id"),
                    {"fen": correct_fen, "id": orow.id},
                )
                openings_fixed += 1
        except Exception:
            continue

    if openings_fixed:
        print(f"  Repaired {openings_fixed} opening FEN(s)")


def downgrade() -> None:
    """Data-only migration — stale FENs and hashes are not recoverable."""
    pass
