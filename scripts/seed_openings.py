"""Idempotent seed script: populate openings table from app/data/openings.tsv.

Uses board.fen() (full FEN with side-to-move/castling metadata) so downstream
consumers (bookmark creation, stats API) get position metadata needed for
correct Zobrist hash recomputation.
Precomputes Zobrist hashes (full, white, black) from the replayed PGN board state.
Uses INSERT ... ON CONFLICT DO UPDATE to backfill hashes on existing rows.

Usage (local dev):
    uv run python -m scripts.seed_openings

Usage (production):
    The runtime image has no `uv` on the host — run inside the backend
    container using the venv's Python directly:

        ssh flawchess "cd /opt/flawchess && docker compose exec backend /app/.venv/bin/python -m scripts.seed_openings"
"""

import asyncio
import csv
import io
import logging
from pathlib import Path

import chess
import chess.pgn
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.services.zobrist import compute_hashes

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

TSV_PATH = Path(__file__).resolve().parent.parent / "app" / "data" / "openings.tsv"


def pgn_to_fen_ply_hashes(pgn_str: str) -> tuple[str, int, int, int, int]:
    """Compute full FEN, ply count, and Zobrist hashes from a PGN.

    Replays the PGN to get the correct board state (with castling rights,
    en passant, side to move) for accurate polyglot Zobrist hash computation.
    Returns (fen, ply_count, white_hash, black_hash, full_hash).

    Uses board.fen() (not board_fen()) so that side-to-move and castling metadata
    are preserved — needed when the FEN is used to reconstruct a Board for hash
    computation (e.g. bookmark match_side toggling).
    """
    game = chess.pgn.read_game(io.StringIO(pgn_str))
    if game is None:
        raise ValueError(f"Failed to parse PGN: {pgn_str!r}")
    board = game.board()
    for move in game.mainline_moves():
        board.push(move)
    white_hash, black_hash, full_hash = compute_hashes(board)
    return board.fen(), board.ply(), white_hash, black_hash, full_hash


async def seed_openings() -> int:
    """Read TSV and insert rows into openings table. Returns count of inserted rows."""
    engine = create_async_engine(settings.DATABASE_URL)
    async_session = async_sessionmaker(engine, expire_on_commit=False)

    inserted = 0
    skipped = 0
    errors = 0

    async with async_session() as session:
        with open(TSV_PATH, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row_num, row in enumerate(reader, start=2):
                eco = row["eco"]
                name = row["name"]
                pgn_str = row["pgn"]
                try:
                    fen, ply_count, white_hash, black_hash, full_hash = pgn_to_fen_ply_hashes(
                        pgn_str
                    )
                except Exception:
                    logger.warning("Row %d: failed to parse PGN %r — skipping", row_num, pgn_str)
                    errors += 1
                    continue

                result = await session.execute(
                    text(
                        "INSERT INTO openings (eco, name, pgn, ply_count, fen, full_hash, white_hash, black_hash) "
                        "VALUES (:eco, :name, :pgn, :ply_count, :fen, :full_hash, :white_hash, :black_hash) "
                        "ON CONFLICT ON CONSTRAINT uq_openings_eco_name_pgn "
                        "DO UPDATE SET fen = EXCLUDED.fen, full_hash = EXCLUDED.full_hash, "
                        "white_hash = EXCLUDED.white_hash, black_hash = EXCLUDED.black_hash"
                    ),
                    {
                        "eco": eco,
                        "name": name,
                        "pgn": pgn_str,
                        "ply_count": ply_count,
                        "fen": fen,
                        "full_hash": full_hash,
                        "white_hash": white_hash,
                        "black_hash": black_hash,
                    },
                )
                if result.rowcount > 0:  # ty: ignore[unresolved-attribute]  # SQLAlchemy DML result carries rowcount
                    # Can't distinguish insert vs update with ON CONFLICT DO UPDATE
                    inserted += 1
                else:
                    skipped += 1

        await session.commit()

    await engine.dispose()
    logger.info("Seed complete: %d upserted, %d skipped, %d errors", inserted, skipped, errors)
    return inserted


if __name__ == "__main__":
    asyncio.run(seed_openings())
