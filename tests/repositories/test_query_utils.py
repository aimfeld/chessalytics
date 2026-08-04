"""Tests for the D-02 flawchess default-exclusion predicate (Phase 167 Plan 02).

Covers apply_game_filters' platform-None branch: a flawchess bot-practice
game must be excluded from the default population, even when opponent_type
is explicitly set to 'bot' (RESEARCH Pitfall 1 — a test using the default
opponent_type='human' view would pass even without D-02, since is_computer_game
already excludes it there). An explicit platform=['flawchess'] list must still
return the flawchess row (opt-in path, D-03's foundation).

Data isolation: uses the rollback-scoped ``db_session`` fixture — no committed
rows leak between tests.
"""

from __future__ import annotations

import pytest
from sqlalchemy import literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.repositories.query_utils import (
    DEFAULT_EXCLUDED_PLATFORMS,
    apply_game_filters,
    mover_color_expr,
    mover_is_white_at_ply,
)
from tests.conftest import ensure_test_user

_TEST_USER_ID = 92401  # unique ID for this test module


async def _seed_game(
    db_session: AsyncSession,
    *,
    platform_game_id: str,
    platform: str,
    is_computer_game: bool,
) -> int:
    game = Game(
        user_id=_TEST_USER_ID,
        platform=platform,
        platform_game_id=platform_game_id,
        pgn="1. e4 e5 1-0",
        result="1-0",
        user_color="white",
        rated=False,
        is_computer_game=is_computer_game,
    )
    db_session.add(game)
    await db_session.flush()
    return game.id


class TestDefaultExcludedPlatformsConstant:
    def test_contains_flawchess(self) -> None:
        assert "flawchess" in DEFAULT_EXCLUDED_PLATFORMS
        assert isinstance(DEFAULT_EXCLUDED_PLATFORMS, tuple)


class TestApplyGameFiltersFlawchessExclusion:
    pytestmark = pytest.mark.asyncio

    async def test_bot_opponent_type_excludes_flawchess_but_keeps_imported_bot_game(
        self, db_session: AsyncSession
    ) -> None:
        """D-02: platform=None + opponent_type='bot' hides flawchess, keeps real bot games.

        This is the case RESEARCH Pitfall 1 flags — opponent_type='human' (the
        default everywhere) would already exclude the flawchess row via
        is_computer_game alone, making a negative test with that default a false
        positive. Setting opponent_type='bot' explicitly is what actually
        exercises the D-02 platform predicate.
        """
        await ensure_test_user(db_session, _TEST_USER_ID)

        # Imported bot game (e.g. a lichess AI-level opponent) — is_computer_game=True.
        imported_bot_id = await _seed_game(
            db_session,
            platform_game_id="q-imported-bot",
            platform="lichess",
            is_computer_game=True,
        )
        # Flawchess practice game — also is_computer_game=True (D-04), but must
        # be excluded from the default (platform=None) population regardless.
        flawchess_id = await _seed_game(
            db_session,
            platform_game_id="q-flawchess",
            platform="flawchess",
            is_computer_game=True,
        )
        # Imported human game — unaffected either way, used as a control row.
        await _seed_game(
            db_session,
            platform_game_id="q-human",
            platform="lichess",
            is_computer_game=False,
        )

        stmt = select(Game.id).where(Game.user_id == _TEST_USER_ID)
        stmt = apply_game_filters(
            stmt,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="bot",
            from_date=None,
            to_date=None,
        )
        result = await db_session.execute(stmt)
        ids = {row[0] for row in result.fetchall()}

        assert imported_bot_id in ids, "imported bot game must remain visible"
        assert flawchess_id not in ids, "flawchess game must be excluded by default (D-02)"

    async def test_explicit_platform_list_including_flawchess_returns_it(
        self, db_session: AsyncSession
    ) -> None:
        """Opt-in path: platform=['flawchess'] (explicit) includes the flawchess row."""
        await ensure_test_user(db_session, _TEST_USER_ID)

        flawchess_id = await _seed_game(
            db_session,
            platform_game_id="q-flawchess-optin",
            platform="flawchess",
            is_computer_game=True,
        )

        stmt = select(Game.id).where(Game.user_id == _TEST_USER_ID)
        stmt = apply_game_filters(
            stmt,
            time_control=None,
            platform=["flawchess"],
            rated=None,
            opponent_type="bot",
            from_date=None,
            to_date=None,
        )
        result = await db_session.execute(stmt)
        ids = {row[0] for row in result.fetchall()}

        assert flawchess_id in ids

    async def test_human_opponent_type_still_excludes_flawchess(
        self, db_session: AsyncSession
    ) -> None:
        """platform=None + opponent_type='human' (the pre-existing default view) still
        excludes flawchess — unchanged behavior, since is_computer_game=True already
        filtered it out before D-02, and D-02 doesn't change that outcome.
        """
        await ensure_test_user(db_session, _TEST_USER_ID)

        flawchess_id = await _seed_game(
            db_session,
            platform_game_id="q-flawchess-human-view",
            platform="flawchess",
            is_computer_game=True,
        )

        stmt = select(Game.id).where(Game.user_id == _TEST_USER_ID)
        stmt = apply_game_filters(
            stmt,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="human",
            from_date=None,
            to_date=None,
        )
        result = await db_session.execute(stmt)
        ids = {row[0] for row in result.fetchall()}

        assert flawchess_id not in ids


class TestMoverColorExpr:
    """mover_color_expr — the SQL twin of mover_is_white_at_ply/mover_color_for_ply.

    Phase 205 (dead-band exclusion): evaluated against a real DB query for
    both ply parities, compared through the Python helper (not a hardcoded
    string) so the two sources cannot drift independently.
    """

    pytestmark = pytest.mark.asyncio

    async def _eval_mover_color(self, db_session: AsyncSession, ply: int) -> str:
        expr = mover_color_expr(literal(ply))
        result = await db_session.execute(select(expr))
        return str(result.scalar_one())

    async def test_even_ply_agrees_with_python_helper(self, db_session: AsyncSession) -> None:
        ply = 10
        expected = "white" if mover_is_white_at_ply(ply) else "black"
        assert await self._eval_mover_color(db_session, ply) == expected == "white"

    async def test_odd_ply_agrees_with_python_helper(self, db_session: AsyncSession) -> None:
        ply = 11
        expected = "white" if mover_is_white_at_ply(ply) else "black"
        assert await self._eval_mover_color(db_session, ply) == expected == "black"
