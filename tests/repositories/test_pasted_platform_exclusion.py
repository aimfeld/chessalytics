"""Red-if-removed proof: platform='pgn' is excluded through apply_game_filters (SC-5).

Phase 208 (PASTE-05). This test asserts through the real seam
(apply_game_filters), not against the DEFAULT_EXCLUDED_PLATFORMS constant
directly — reverting the tuple to ("flawchess",) must make this test fail.
A symbol-presence check (e.g. `assert "pgn" in DEFAULT_EXCLUDED_PLATFORMS`)
does not satisfy SC-5; this file is the end-to-end proof.

Data isolation: uses the rollback-scoped ``db_session`` fixture (mirrors
tests/repositories/test_query_utils.py) — nothing is committed, so the
tier-3 eval lottery (which reads only committed rows) never observes these
rows and no explicit cleanup is needed.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.repositories.query_utils import ANALYTICS_INCLUDED_PLATFORMS, apply_game_filters
from tests.conftest import ensure_test_user

_TEST_USER_ID = 92402  # unique ID for this test module (distinct from test_query_utils.py)

pytestmark = pytest.mark.asyncio


async def _seed_game(db_session: AsyncSession, *, platform_game_id: str, platform: str) -> int:
    game = Game(
        user_id=_TEST_USER_ID,
        platform=platform,
        platform_game_id=platform_game_id,
        pgn="1. e4 e5 1-0",
        result="1-0",
        user_color="white",
        rated=False,
        is_computer_game=False,
    )
    db_session.add(game)
    await db_session.flush()
    return game.id


async def _seed_three_platforms(db_session: AsyncSession) -> dict[str, int]:
    await ensure_test_user(db_session, _TEST_USER_ID)
    chesscom_id = await _seed_game(db_session, platform_game_id="pe-chesscom", platform="chess.com")
    flawchess_id = await _seed_game(
        db_session, platform_game_id="pe-flawchess", platform="flawchess"
    )
    pgn_id = await _seed_game(db_session, platform_game_id="pe-pgn", platform="pgn")
    return {"chess.com": chesscom_id, "flawchess": flawchess_id, "pgn": pgn_id}


async def _filtered_ids(db_session: AsyncSession, platform: list[str] | None) -> set[int]:
    stmt = select(Game.id).where(Game.user_id == _TEST_USER_ID)
    stmt = apply_game_filters(
        stmt,
        time_control=None,
        platform=platform,
        rated=None,
        opponent_type="all",
        from_date=None,
        to_date=None,
    )
    result = await db_session.execute(stmt)
    return {row[0] for row in result.fetchall()}


class TestPastedPlatformExclusion:
    async def test_default_population_excludes_pgn_and_flawchess(
        self, db_session: AsyncSession
    ) -> None:
        """platform=None: only the chess.com row is returned.

        This is the assertion that goes red if "pgn" is dropped from
        DEFAULT_EXCLUDED_PLATFORMS.
        """
        ids = await _seed_three_platforms(db_session)

        result_ids = await _filtered_ids(db_session, platform=None)

        assert result_ids == {ids["chess.com"]}

    async def test_analytics_included_platforms_list_equals_default(
        self, db_session: AsyncSession
    ) -> None:
        """Explicit platform=list(ANALYTICS_INCLUDED_PLATFORMS) == platform=None.

        Pins the equivalence Plan 04's Library "Pasted" opt-in chip depends on.
        """
        ids = await _seed_three_platforms(db_session)

        default_ids = await _filtered_ids(db_session, platform=None)
        explicit_ids = await _filtered_ids(db_session, platform=list(ANALYTICS_INCLUDED_PLATFORMS))

        assert explicit_ids == default_ids == {ids["chess.com"]}

    async def test_explicit_opt_in_includes_pgn_but_not_flawchess(
        self, db_session: AsyncSession
    ) -> None:
        """platform=[*ANALYTICS_INCLUDED_PLATFORMS, "pgn"]: chess.com + pgn, not flawchess."""
        ids = await _seed_three_platforms(db_session)

        result_ids = await _filtered_ids(
            db_session, platform=[*ANALYTICS_INCLUDED_PLATFORMS, "pgn"]
        )

        assert result_ids == {ids["chess.com"], ids["pgn"]}
        assert ids["flawchess"] not in result_ids

    async def test_explicit_pgn_only_returns_only_pgn(self, db_session: AsyncSession) -> None:
        """platform=["pgn"]: only the pgn row is returned."""
        ids = await _seed_three_platforms(db_session)

        result_ids = await _filtered_ids(db_session, platform=["pgn"])

        assert result_ids == {ids["pgn"]}
