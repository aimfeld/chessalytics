"""Tests for scripts/backfill_accuracy_acpl.py (Phase 178 Plan 04).

Covers the plan's two acceptance scenarios via a single `run_backfill` call
against an injected session_maker (no real engine/`--db` target is created,
no `bin/prod_db_tunnel.sh` involved):

  - A complete (hole-free) analyzed game has its four canonical columns
    filled with the compute's exact result — pinned against the same
    checkmating-final-move fixture already proven in
    tests/services/test_accuracy_acpl.py::TestEdgeCases
    (white_acpl=2, black_acpl=0), so this test also proves the backfill's
    write keying is correct, not just "some non-NULL value landed".
  - A game with an interior eval hole (both eval_cp/eval_mate NULL on a
    non-terminal, non-final-move ply) is left NULL on all four columns —
    the Complete-Sequence Gate inside `compute_game_accuracy_acpl` is
    authoritative regardless of the `white_blunders` "analyzed" sentinel.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Any

import pytest_asyncio
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Bootstrap project root so `scripts.*` and `app.*` imports resolve from the tests dir.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from app.models.game import Game  # noqa: E402
from app.models.game_position import GamePosition  # noqa: E402
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401 (registers FK table)
from app.models.user import User  # noqa: E402

from scripts.archive.backfill_accuracy_acpl import run_backfill  # noqa: E402

# Unique test-module user ID to avoid PK collisions with other test files.
_TEST_USER_ID: int = 99206


@pytest_asyncio.fixture(scope="module")
async def baa_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """async_sessionmaker bound to the per-run test DB engine."""
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(scope="module")
async def baa_user(baa_session_maker: async_sessionmaker[AsyncSession]) -> int:
    """Ensure the module's test user exists (committed)."""
    async with baa_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID,
                    email=f"backfill-accuracy-acpl-{_TEST_USER_ID}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID


async def _insert_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
) -> int:
    """Insert a minimal analyzed Game row (white_blunders set, canonical accuracy/acpl
    NULL) and return its id."""
    async with session_maker() as session:
        g = Game(
            user_id=user_id,
            platform="chess.com",
            platform_game_id=f"backfill-acc-acpl-{uuid.uuid4().hex}",
            pgn="*",
            result="1-0",
            user_color="white",
            rated=True,
            is_computer_game=False,
            white_blunders=0,
            black_blunders=0,
            white_inaccuracies=0,
            black_inaccuracies=0,
            white_mistakes=0,
            black_mistakes=0,
        )
        session.add(g)
        await session.flush()
        game_id = g.id
        await session.commit()
    return game_id


async def _insert_positions(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    rows: list[dict[str, Any]],
) -> None:
    """Insert GamePosition rows carrying eval_cp/eval_mate exactly as stored
    (post-move-shifted, SEED-044). Each dict: {"ply", "eval_cp", "eval_mate"}."""
    async with session_maker() as session:
        for r in rows:
            session.add(
                GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=r["ply"],
                    full_hash=r["ply"],
                    white_hash=0,
                    black_hash=0,
                    eval_cp=r.get("eval_cp"),
                    eval_mate=r.get("eval_mate"),
                )
            )
        await session.commit()


async def _delete_game(session_maker: async_sessionmaker[AsyncSession], game_id: int) -> None:
    """Delete a game (CASCADE removes its game_positions rows)."""
    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.id == game_id))
        await session.commit()


async def _fetch_accuracy_acpl(
    session_maker: async_sessionmaker[AsyncSession], game_id: int
) -> tuple[float | None, float | None, int | None, int | None]:
    async with session_maker() as session:
        row = (
            await session.execute(
                select(
                    Game.white_accuracy, Game.black_accuracy, Game.white_acpl, Game.black_acpl
                ).where(Game.id == game_id)
            )
        ).one()
    return row.white_accuracy, row.black_accuracy, row.white_acpl, row.black_acpl


class TestBackfillFillsCompleteGameAndHonorsHoleGate:
    """D-06: the backfill fills canonical columns for a complete game and
    respects the Complete-Sequence Gate on a holed game."""

    async def test_run_backfill(
        self,
        baa_session_maker: async_sessionmaker[AsyncSession],
        baa_user: int,
    ) -> None:
        # Complete (hole-free) game: matches
        # test_accuracy_acpl.py::TestEdgeCases::test_checkmating_final_move_handled_without_error
        # exactly (white_acpl=2, black_acpl=0) — pins the backfill's write keying, not
        # just "some non-NULL value landed".
        complete_game_id = await _insert_game(baa_session_maker, baa_user)
        await _insert_positions(
            baa_session_maker,
            baa_user,
            complete_game_id,
            [
                {"ply": 0, "eval_cp": 11},
                {"ply": 1, "eval_cp": -5},
                {"ply": 2, "eval_cp": None, "eval_mate": None},  # last move's row: NULL
                {"ply": 3, "eval_cp": None, "eval_mate": None},  # terminal
            ],
        )

        # Holed game: ply=1's row is an interior hole (both eval_cp/eval_mate NULL) —
        # simultaneously the "after" of move 1 and the "before" of move 2. Mirrors
        # test_accuracy_acpl.py::TestIncompleteSequenceReturnsNone::test_interior_hole_returns_none.
        holed_game_id = await _insert_game(baa_session_maker, baa_user)
        await _insert_positions(
            baa_session_maker,
            baa_user,
            holed_game_id,
            [
                {"ply": 0, "eval_cp": 10},
                {"ply": 1, "eval_cp": None, "eval_mate": None},  # interior hole
                {"ply": 2, "eval_cp": 5},
                {"ply": 3, "eval_cp": -5},
                {"ply": 4, "eval_cp": None, "eval_mate": None},  # terminal, not a hole
            ],
        )

        try:
            await run_backfill(
                db="dev",  # unused when _session_maker is injected
                user_id=baa_user,
                dry_run=False,
                limit=None,
                _session_maker=baa_session_maker,
            )

            complete_result = await _fetch_accuracy_acpl(baa_session_maker, complete_game_id)
            white_acc, black_acc, white_acpl, black_acpl = complete_result
            assert white_acc is not None and 0.0 <= white_acc <= 100.0
            assert black_acc is not None and 0.0 <= black_acc <= 100.0
            assert white_acpl == 2
            assert black_acpl == 0

            holed_result = await _fetch_accuracy_acpl(baa_session_maker, holed_game_id)
            assert holed_result == (None, None, None, None)
        finally:
            await _delete_game(baa_session_maker, complete_game_id)
            await _delete_game(baa_session_maker, holed_game_id)
