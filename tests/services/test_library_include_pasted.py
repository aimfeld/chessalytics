"""Tests for resolve_library_platforms and the include_pasted wire param (Phase 208).

Plan 208-04 (PASTE-05/09, D-11/D-12). Covers:
- Pure unit tests over resolve_library_platforms for every <behavior> bullet.
- Two integration tests through the router (GET /library/games, GET /library/flaws)
  proving the end-to-end wiring, not just the resolver in isolation.

Data isolation: the two integration tests register their own users and commit
Game/GameFlaw rows (the router path commits via override_get_async_session), so
every inserted non-guest Game row is deleted in a `finally` block to avoid
leaking into the global tier-3 eval lottery (project_eval_lottery_test_isolation).
"""

from __future__ import annotations

import datetime
import uuid
from typing import Any

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.main import app
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.repositories.query_utils import ANALYTICS_INCLUDED_PLATFORMS
from app.services.library_service import (
    LIBRARY_GAMES_BASE_PLATFORMS,
    resolve_library_platforms,
)

# ---------------------------------------------------------------------------
# Pure unit tests — resolve_library_platforms
# ---------------------------------------------------------------------------


class TestResolveLibraryPlatforms:
    def test_games_default_unchanged_when_pasted_off(self) -> None:
        """No explicit platform, include_pasted=False, surface="games": today's default."""
        result = resolve_library_platforms(None, include_pasted=False, surface="games")

        assert result == list(LIBRARY_GAMES_BASE_PLATFORMS)
        assert result == ["chess.com", "lichess", "flawchess"]

    def test_games_additive_when_pasted_on(self) -> None:
        """include_pasted=True adds "pgn" on top of the Games default — bot games stay."""
        result = resolve_library_platforms(None, include_pasted=True, surface="games")

        assert result == ["chess.com", "lichess", "flawchess", "pgn"]

    def test_analytics_default_equals_analytics_included_platforms(self) -> None:
        """No explicit platform, include_pasted=False, surface="analytics": the explicit-list
        equivalent of the platform=None default (Plan 02's invariant)."""
        result = resolve_library_platforms(None, include_pasted=False, surface="analytics")

        assert result == list(ANALYTICS_INCLUDED_PLATFORMS)
        assert result == ["chess.com", "lichess"]

    def test_analytics_additive_pasted_excludes_flawchess(self) -> None:
        """include_pasted=True on the analytics surface adds "pgn" but never "flawchess"."""
        result = resolve_library_platforms(None, include_pasted=True, surface="analytics")

        assert result == ["chess.com", "lichess", "pgn"]
        assert "flawchess" not in result

    def test_explicit_platform_list_is_extended_not_replaced_games(self) -> None:
        """An explicit caller selection is preserved and only extended (surface="games")."""
        result = resolve_library_platforms(["lichess"], include_pasted=True, surface="games")

        assert result == ["lichess", "pgn"]

    def test_explicit_platform_list_is_extended_not_replaced_analytics(self) -> None:
        """Same extension behavior on the analytics surface."""
        result = resolve_library_platforms(["lichess"], include_pasted=True, surface="analytics")

        assert result == ["lichess", "pgn"]

    def test_pgn_never_added_twice(self) -> None:
        """An explicit list already containing "pgn" is not extended a second time."""
        result = resolve_library_platforms(["pgn"], include_pasted=True, surface="games")

        assert result == ["pgn"]
        assert result.count("pgn") == 1

    def test_include_pasted_false_returns_explicit_list_unchanged(self) -> None:
        """include_pasted=False never appends "pgn", even to an explicit list."""
        result = resolve_library_platforms(
            ["lichess", "chess.com"], include_pasted=False, surface="games"
        )

        assert result == ["lichess", "chess.com"]

    def test_input_list_not_mutated(self) -> None:
        """resolve_library_platforms returns a new list — the caller's list is untouched."""
        original = ["lichess"]

        result = resolve_library_platforms(original, include_pasted=True, surface="games")

        assert original == ["lichess"]
        assert result == ["lichess", "pgn"]
        assert result is not original

    def test_library_games_base_platforms_never_contains_pgn(self) -> None:
        """D-11: the Library Games tab's default list must never gain "pgn"."""
        assert "pgn" not in LIBRARY_GAMES_BASE_PLATFORMS


# ---------------------------------------------------------------------------
# Integration tests — through the router
# ---------------------------------------------------------------------------


async def _register_and_login(
    email: str, password: str = "testpassword123"
) -> tuple[dict[str, str], int]:
    """Register a user and return (auth_headers, user_id)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        reg_resp = await client.post(
            "/api/auth/register", json={"email": email, "password": password}
        )
        user_id = int(reg_resp.json()["id"])
        login_resp = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        token = login_resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, user_id


async def _seed_game(
    session_maker: async_sessionmaker[AsyncSession],
    *,
    user_id: int,
    platform: str,
) -> int:
    """Insert and commit a minimal Game row for the given platform, returning its ID."""
    async with session_maker() as session:
        game = Game(
            user_id=user_id,
            platform=platform,
            platform_game_id=f"lip-{platform}-{uuid.uuid4().hex[:8]}",
            pgn="1. e4 e5 1-0",
            result="1-0",
            user_color="white",
            rated=False,
            is_computer_game=False,
            played_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
        )
        session.add(game)
        await session.commit()
        await session.refresh(game)
        return game.id


async def _seed_flaw(
    session_maker: async_sessionmaker[AsyncSession],
    *,
    user_id: int,
    game_id: int,
    ply: int,
) -> None:
    """Insert and commit a minimal blunder GameFlaw row."""
    async with session_maker() as session:
        flaw = GameFlaw(
            user_id=user_id,
            game_id=game_id,
            ply=ply,
            severity=2,  # blunder
            phase=1,  # middlegame
            is_miss=False,
            is_lucky=False,
            is_reversed=False,
            is_squandered=False,
            fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1",
        )
        session.add(flaw)
        await session.commit()


@pytest.mark.asyncio
class TestIncludePastedThroughRouter:
    async def test_library_games_hides_then_reveals_pasted(self, test_engine: Any) -> None:
        """/library/games: default excludes the pgn row; include_pasted=true includes all three."""
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        suffix = uuid.uuid4().hex[:8]
        headers, user_id = await _register_and_login(f"lip_games_{suffix}@example.com")

        game_ids: dict[str, int] = {}
        try:
            game_ids["chess.com"] = await _seed_game(
                session_maker, user_id=user_id, platform="chess.com"
            )
            game_ids["flawchess"] = await _seed_game(
                session_maker, user_id=user_id, platform="flawchess"
            )
            game_ids["pgn"] = await _seed_game(session_maker, user_id=user_id, platform="pgn")

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp_default = await client.get(
                    "/api/library/games", headers=headers, params={"limit": 100}
                )
                resp_pasted = await client.get(
                    "/api/library/games",
                    headers=headers,
                    params={"limit": 100, "include_pasted": "true"},
                )

            assert resp_default.status_code == 200
            assert resp_pasted.status_code == 200
            default_ids = {g["game_id"] for g in resp_default.json()["games"]}
            pasted_ids = {g["game_id"] for g in resp_pasted.json()["games"]}

            assert game_ids["chess.com"] in default_ids
            assert game_ids["flawchess"] in default_ids
            assert game_ids["pgn"] not in default_ids

            assert game_ids["chess.com"] in pasted_ids
            assert game_ids["flawchess"] in pasted_ids
            assert game_ids["pgn"] in pasted_ids
        finally:
            async with session_maker() as session:
                await session.execute(delete(Game).where(Game.user_id == user_id))
                await session.commit()

    async def test_library_flaws_pasted_opt_in_excludes_flawchess(self, test_engine: Any) -> None:
        """/library/flaws: include_pasted=true reveals the pgn flaw but never flawchess's."""
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        suffix = uuid.uuid4().hex[:8]
        headers, user_id = await _register_and_login(f"lip_flaws_{suffix}@example.com")

        game_ids: dict[str, int] = {}
        try:
            game_ids["flawchess"] = await _seed_game(
                session_maker, user_id=user_id, platform="flawchess"
            )
            game_ids["pgn"] = await _seed_game(session_maker, user_id=user_id, platform="pgn")
            await _seed_flaw(session_maker, user_id=user_id, game_id=game_ids["flawchess"], ply=4)
            await _seed_flaw(session_maker, user_id=user_id, game_id=game_ids["pgn"], ply=6)

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp_default = await client.get(
                    "/api/library/flaws", headers=headers, params={"limit": 100}
                )
                resp_pasted = await client.get(
                    "/api/library/flaws",
                    headers=headers,
                    params={"limit": 100, "include_pasted": "true"},
                )

            assert resp_default.status_code == 200
            assert resp_pasted.status_code == 200
            default_game_ids = {f["game_id"] for f in resp_default.json()["flaws"]}
            pasted_game_ids = {f["game_id"] for f in resp_pasted.json()["flaws"]}

            # Default (surface="analytics" base = chess.com/lichess) excludes both
            # flawchess and pgn — neither shows without the opt-in.
            assert game_ids["flawchess"] not in default_game_ids
            assert game_ids["pgn"] not in default_game_ids

            # include_pasted=true reveals the pgn flaw but NEVER newly admits
            # flawchess — the analytics surface's own default excludes bot games
            # regardless of the pasted opt-in (D-11/D-12).
            assert game_ids["pgn"] in pasted_game_ids
            assert game_ids["flawchess"] not in pasted_game_ids
        finally:
            async with session_maker() as session:
                await session.execute(delete(GameFlaw).where(GameFlaw.user_id == user_id))
                await session.execute(delete(Game).where(Game.user_id == user_id))
                await session.commit()
