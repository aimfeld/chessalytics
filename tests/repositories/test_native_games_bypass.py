"""Red-if-removed proof: the Library opponent/rated bypass flag (SEED-163 2b).

Phase 260905-p0t. This test asserts through the real seam (apply_game_filters'
native_games_bypass_opponent_and_rated flag), not against DEFAULT_EXCLUDED_PLATFORMS
directly — reverting the OR wrapper in query_utils.apply_game_filters must make
case 2 below fail. A symbol-presence check does not satisfy this contract.

Data isolation: uses the rollback-scoped ``db_session`` fixture (mirrors
tests/repositories/test_pasted_platform_exclusion.py) — nothing is committed, so
the tier-3 eval lottery (which reads only committed rows) never observes these
rows and no explicit cleanup is needed.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.repositories.query_utils import apply_game_filters
from app.services.library_service import LIBRARY_GAMES_BASE_PLATFORMS
from tests.conftest import ensure_test_user

_TEST_USER_ID = 92404  # unique ID for this test module (distinct from other repo tests)

pytestmark = pytest.mark.asyncio


async def _seed_game(
    db_session: AsyncSession,
    *,
    platform_game_id: str,
    platform: str,
    rated: bool,
    is_computer_game: bool,
) -> int:
    game = Game(
        user_id=_TEST_USER_ID,
        platform=platform,
        platform_game_id=platform_game_id,
        pgn="1. e4 e5 1-0",
        result="1-0",
        user_color="white",
        rated=rated,
        is_computer_game=is_computer_game,
    )
    db_session.add(game)
    await db_session.flush()
    return game.id


async def _seed_three_games(db_session: AsyncSession) -> dict[str, int]:
    await ensure_test_user(db_session, _TEST_USER_ID)
    chesscom_id = await _seed_game(
        db_session,
        platform_game_id="nb-chesscom",
        platform="chess.com",
        rated=True,
        is_computer_game=False,
    )
    flawchess_id = await _seed_game(
        db_session,
        platform_game_id="nb-flawchess",
        platform="flawchess",
        rated=False,
        is_computer_game=True,
    )
    pgn_id = await _seed_game(
        db_session,
        platform_game_id="nb-pgn",
        platform="pgn",
        rated=False,
        is_computer_game=False,
    )
    return {"chess.com": chesscom_id, "flawchess": flawchess_id, "pgn": pgn_id}


async def _filtered_ids(
    db_session: AsyncSession,
    *,
    platform: list[str] | None,
    opponent_type: str,
    rated: bool | None,
    bypass: bool = False,
) -> set[int]:
    stmt = select(Game.id).where(Game.user_id == _TEST_USER_ID)
    stmt = apply_game_filters(
        stmt,
        time_control=None,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=None,
        to_date=None,
        native_games_bypass_opponent_and_rated=bypass,
    )
    result = await db_session.execute(stmt)
    return {row[0] for row in result.fetchall()}


class TestNativeGamesBypass:
    async def test_bypass_true_returns_chesscom_and_flawchess_under_human_rated(
        self, db_session: AsyncSession
    ) -> None:
        """Case 1: Library Games platform list + flag=True + Human/Rated returns both."""
        ids = await _seed_three_games(db_session)

        result_ids = await _filtered_ids(
            db_session,
            platform=list(LIBRARY_GAMES_BASE_PLATFORMS),
            opponent_type="human",
            rated=True,
            bypass=True,
        )

        assert result_ids == {ids["chess.com"], ids["flawchess"]}

    async def test_bypass_false_returns_only_chesscom_under_human_rated(
        self, db_session: AsyncSession
    ) -> None:
        """Case 2: same call with the flag at its default returns only chess.com.

        This is the assertion that goes red if the OR wrapper is removed from
        apply_game_filters.
        """
        ids = await _seed_three_games(db_session)

        result_ids = await _filtered_ids(
            db_session,
            platform=list(LIBRARY_GAMES_BASE_PLATFORMS),
            opponent_type="human",
            rated=True,
            bypass=False,
        )

        assert result_ids == {ids["chess.com"]}

    async def test_bypass_never_leaks_into_analytics_default_platform(
        self, db_session: AsyncSession
    ) -> None:
        """Case 3: platform=None (analytics default) returns only chess.com either way.

        Proves the bypass cannot widen an analytics population that never passed
        an explicit platform list — the Platform predicate above it still excludes
        DEFAULT_EXCLUDED_PLATFORMS regardless of the opponent/rated OR.
        """
        ids = await _seed_three_games(db_session)

        without_bypass = await _filtered_ids(
            db_session, platform=None, opponent_type="human", rated=True, bypass=False
        )
        with_bypass = await _filtered_ids(
            db_session, platform=None, opponent_type="human", rated=True, bypass=True
        )

        assert without_bypass == with_bypass == {ids["chess.com"]}

    async def test_bypass_returns_pgn_under_pasted_chip_platform_list(
        self, db_session: AsyncSession
    ) -> None:
        """Case 4: Library Pasted-chip platform list + flag=True returns the pgn row."""
        ids = await _seed_three_games(db_session)

        result_ids = await _filtered_ids(
            db_session,
            platform=["chess.com", "lichess", "pgn"],
            opponent_type="human",
            rated=True,
            bypass=True,
        )

        assert ids["pgn"] in result_ids

    async def test_bypass_is_unconditional_not_only_at_human_default(
        self, db_session: AsyncSession
    ) -> None:
        """Case 5: flag=True still returns the flawchess row under opponent_type='bot'.

        The bypass ORs in ALL of DEFAULT_EXCLUDED_PLATFORMS unconditionally — it is
        not gated on the specific Human+Rated combination.
        """
        ids = await _seed_three_games(db_session)

        result_ids = await _filtered_ids(
            db_session,
            platform=list(LIBRARY_GAMES_BASE_PLATFORMS),
            opponent_type="bot",
            rated=None,
            bypass=True,
        )

        assert ids["flawchess"] in result_ids
