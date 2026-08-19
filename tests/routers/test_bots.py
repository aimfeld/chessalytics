"""Integration tests for POST /api/bots/games (Phase 167 STORE-01/02/05/06).

Covers:
- STORE-01: valid bot PGN -> 200, created:true, exactly one platform='flawchess'
  games row, visible via GET /api/library/games?platform=flawchess.
- STORE-02: missing [%clk] / unparseable PGN -> 422.
- STORE-05: re-POSTing the same game_uuid -> 200, created:false, same game_id,
  still exactly one games row.
- STORE-06: a stored non-guest game has evals_completed_at IS NULL (drain-eligible).
- Auth: unauthenticated request -> 401.

Uses httpx AsyncClient with ASGITransport, mirroring
tests/routers/test_imports_eval_coverage.py's conventions (real HTTP round-trip
through app.main.app; DB rows seeded/verified via a committed session against
the test engine, since HTTP requests use their own session, not the
rollback-scoped db_session fixture).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.main import app
from app.models.game import Game

BOTS_ENDPOINT = "/api/bots/games"
LIBRARY_GAMES_ENDPOINT = "/api/library/games"
PERSONA_WINS_ENDPOINT = "/api/bots/persona-wins"

# Scholar's Mate PGN with per-move [%clk] on both colors.
_PGN_CHECKMATE = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} "
    "2. Bc4 {[%clk 0:02:58]} Nc6 {[%clk 0:02:58]} "
    "3. Qh5 {[%clk 0:02:56]} Nf6 {[%clk 0:02:56]} "
    "4. Qxf7# {[%clk 0:02:54]} 1-0\n"
)

# A 40-ply game (both-color [%clk]) — long enough to have midgame entry plies,
# so Stage 5c's "covered" gate (RESEARCH Pitfall 6) does NOT fire and
# evals_completed_at stays NULL (drain-eligible, STORE-06). A pathologically
# short game (like _PGN_CHECKMATE above) has no entry plies at all and gets
# marked covered immediately — correct existing behavior, but the wrong fixture
# for asserting STORE-06's "left pending for the cold drain" claim.
_PGN_LONG_GAME = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n\n'
    "1. Na3 {[%clk 0:02:58.9]} d6 {[%clk 0:02:57.5]} 2. Nf3 {[%clk 0:02:55.0]} g5 {[%clk 0:02:52.5]} "
    "3. g4 {[%clk 0:02:51.3]} h6 {[%clk 0:02:50.3]} 4. Nh4 {[%clk 0:02:48.8]} b6 {[%clk 0:02:46.6]} "
    "5. f4 {[%clk 0:02:45.2]} h5 {[%clk 0:02:42.8]} 6. fxg5 {[%clk 0:02:41.4]} f6 {[%clk 0:02:39.8]} "
    "7. Ng6 {[%clk 0:02:37.3]} Kf7 {[%clk 0:02:34.9]} 8. Bh3 {[%clk 0:02:33.4]} Nd7 {[%clk 0:02:30.4]} "
    "9. Nb1 {[%clk 0:02:29.2]} Ke6 {[%clk 0:02:28.0]} 10. Kf1 {[%clk 0:02:25.8]} Rh6 {[%clk 0:02:23.4]} "
    "11. gxh5+ {[%clk 0:02:22.1]} Kd5 {[%clk 0:02:21.0]} 12. Bg4 {[%clk 0:02:18.3]} c6 {[%clk 0:02:15.5]} "
    "13. d3 {[%clk 0:02:13.4]} a5 {[%clk 0:02:12.2]} 14. Kg1 {[%clk 0:02:09.7]} Qc7 {[%clk 0:02:07.0]} "
    "15. Bxd7 {[%clk 0:02:05.2]} Rxg6 {[%clk 0:02:03.0]} 16. e3 {[%clk 0:02:01.6]} Qxd7 {[%clk 0:02:00.2]} "
    "17. Qe1 {[%clk 0:01:57.8]} Ke5 {[%clk 0:01:55.5]} 18. e4 {[%clk 0:01:53.2]} Rg7 {[%clk 0:01:50.8]} "
    "19. Qb4 {[%clk 0:01:48.9]} Rg6 {[%clk 0:01:45.9]} 20. Kf2 {[%clk 0:01:43.5]} c5 {[%clk 0:01:41.0]} 1-0\n"
)

# Missing black's [%clk] annotations (STORE-02).
_PGN_MISSING_CLOCK = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 "
    "2. Bc4 {[%clk 0:02:58]} Nc6 "
    "3. Qh5 {[%clk 0:02:56]} Nf6 "
    "4. Qxf7# {[%clk 0:02:54]} 1-0\n"
)

_PGN_UNPARSEABLE = "this is not a pgn at all"

_TEST_BOT_ELO = 1400
_TEST_TC_PRESET = "180+2"


def _make_bot_game_payload(
    *, game_uuid: str | None = None, pgn: str = _PGN_CHECKMATE, persona_id: str | None = None
) -> dict:
    payload = {
        "game_uuid": game_uuid or str(uuid.uuid4()),
        "pgn": pgn,
        "user_color": "white",
        "bot_elo": _TEST_BOT_ELO,
        "play_style_blend": 0.5,
        "tc_preset": _TEST_TC_PRESET,
    }
    if persona_id is not None:
        payload["persona_id"] = persona_id
    return payload


async def _register_and_login(email: str, password: str = "testpassword123") -> tuple[int, str]:
    """Register a user via HTTP and return (user_id, auth_token)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        reg_resp = await client.post(
            "/api/auth/register", json={"email": email, "password": password}
        )
        assert reg_resp.status_code in (200, 201), f"register failed: {reg_resp.text}"
        user_id = int(reg_resp.json()["id"])

        login_resp = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        assert login_resp.status_code == 200, f"login failed: {login_resp.text}"
        token = str(login_resp.json()["access_token"])

    return user_id, token


async def _delete_games_for_user(test_engine, user_id: int) -> None:
    from sqlalchemy import delete

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.user_id == user_id))
        await session.commit()


@pytest_asyncio.fixture
async def bots_user_client(test_engine) -> AsyncGenerator[tuple[int, str], None]:
    """Register a fresh user and return (user_id, token). Cleanup games on teardown."""
    email = f"bots_test_{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    yield user_id, token
    await _delete_games_for_user(test_engine, user_id)


@pytest.mark.asyncio
async def test_store_bot_game_requires_auth() -> None:
    """Unauthenticated POST /api/bots/games -> 401."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(BOTS_ENDPOINT, json=_make_bot_game_payload())
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_store_bot_game_creates_flawchess_game(
    bots_user_client: tuple[int, str], test_engine
) -> None:
    """STORE-01: valid bot PGN -> 200, created:true, one platform='flawchess' row,
    visible via GET /library/games?platform=flawchess.
    """
    user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            BOTS_ENDPOINT, json=_make_bot_game_payload(pgn=_PGN_LONG_GAME), headers=headers
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["created"] is True
        game_id = body["game_id"]

        library_resp = await client.get(
            LIBRARY_GAMES_ENDPOINT,
            params={"platform": "flawchess", "opponent_type": "bot"},
            headers=headers,
        )
        assert library_resp.status_code == 200, library_resp.text
        library_body = library_resp.json()
        game_ids = [g["game_id"] for g in library_body["games"]]
        assert game_id in game_ids

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        rows = (
            (
                await session.execute(
                    select(Game).where(
                        Game.user_id == user_id,
                        Game.platform == "flawchess",
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        # STORE-06: fresh non-guest bot game is drain-eligible (evals pending).
        assert rows[0].evals_completed_at is None


@pytest.mark.asyncio
async def test_store_bot_game_missing_clock_returns_422(
    bots_user_client: tuple[int, str],
) -> None:
    """STORE-02: PGN missing [%clk] on one color -> 422."""
    _user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            BOTS_ENDPOINT,
            json=_make_bot_game_payload(pgn=_PGN_MISSING_CLOCK),
            headers=headers,
        )
    assert response.status_code == 422
    # The reason code is what makes a client-side Sentry 422 diagnosable at all
    # (FLAWCHESS-64): before it, every rejection body was the same prose.
    assert response.json()["detail"]["reason"] == "missing_clk"


@pytest.mark.asyncio
async def test_store_bot_game_unparseable_pgn_returns_422(
    bots_user_client: tuple[int, str],
) -> None:
    """STORE-02: unparseable PGN -> 422, not 500."""
    _user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            BOTS_ENDPOINT,
            json=_make_bot_game_payload(pgn=_PGN_UNPARSEABLE),
            headers=headers,
        )
    assert response.status_code == 422
    # python-chess parses free text into a Game with an empty mainline rather
    # than failing outright, so the honest reason here is "no_moves".
    assert response.json()["detail"]["reason"] == "no_moves"


@pytest.mark.asyncio
async def test_store_bot_game_idempotent_resubmit(
    bots_user_client: tuple[int, str], test_engine
) -> None:
    """STORE-05: re-POSTing the same game_uuid -> 200, created:false, same game_id,
    still exactly one games row.
    """
    user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}
    payload = _make_bot_game_payload()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post(BOTS_ENDPOINT, json=payload, headers=headers)
        assert first.status_code == 200, first.text
        first_body = first.json()
        assert first_body["created"] is True

        second = await client.post(BOTS_ENDPOINT, json=payload, headers=headers)
        assert second.status_code == 200, second.text
        second_body = second.json()
        assert second_body["created"] is False
        assert second_body["game_id"] == first_body["game_id"]

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        rows = (
            (
                await session.execute(
                    select(Game).where(
                        Game.user_id == user_id,
                        Game.platform == "flawchess",
                        Game.platform_game_id == payload["game_uuid"],
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1


@pytest.mark.asyncio
async def test_persona_win_round_trips_to_persona_wins_endpoint(
    bots_user_client: tuple[int, str],
) -> None:
    """Phase 185 tracer: a persona game's win persists to games.persona_id and
    is reflected by GET /bots/persona-wins for the submitting user.
    """
    _user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}
    persona_id = "attacker-1200"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        store_resp = await client.post(
            BOTS_ENDPOINT,
            json=_make_bot_game_payload(pgn=_PGN_CHECKMATE, persona_id=persona_id),
            headers=headers,
        )
        assert store_resp.status_code == 200, store_resp.text
        assert store_resp.json()["created"] is True

        wins_resp = await client.get(PERSONA_WINS_ENDPOINT, headers=headers)
        assert wins_resp.status_code == 200, wins_resp.text
        assert wins_resp.json() == {persona_id: 1}


@pytest.mark.asyncio
async def test_persona_id_persisted_on_create(
    bots_user_client: tuple[int, str], test_engine
) -> None:
    """persona_id is written to the games row on create."""
    user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}
    payload = _make_bot_game_payload(persona_id="grinder-1600")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(BOTS_ENDPOINT, json=payload, headers=headers)
        assert response.status_code == 200, response.text
        assert response.json()["created"] is True

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        row = (
            await session.execute(
                select(Game).where(
                    Game.user_id == user_id,
                    Game.platform == "flawchess",
                    Game.platform_game_id == payload["game_uuid"],
                )
            )
        ).scalar_one()
        assert row.persona_id == "grinder-1600"


@pytest.mark.asyncio
async def test_persona_id_unchanged_on_idempotent_resubmit(
    bots_user_client: tuple[int, str], test_engine
) -> None:
    """D-11: re-POSTing the same game_uuid does not re-write persona_id."""
    user_id, token = bots_user_client
    headers = {"Authorization": f"Bearer {token}"}
    payload = _make_bot_game_payload(persona_id="wall-800")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        first = await client.post(BOTS_ENDPOINT, json=payload, headers=headers)
        assert first.status_code == 200, first.text
        assert first.json()["created"] is True

        # Resubmit with a DIFFERENT persona_id — since created=False on this
        # duplicate, the original persona_id must be preserved unchanged.
        second_payload = dict(payload)
        second_payload["persona_id"] = "trickster-1400"
        second = await client.post(BOTS_ENDPOINT, json=second_payload, headers=headers)
        assert second.status_code == 200, second.text
        assert second.json()["created"] is False

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        row = (
            await session.execute(
                select(Game).where(
                    Game.user_id == user_id,
                    Game.platform == "flawchess",
                    Game.platform_game_id == payload["game_uuid"],
                )
            )
        ).scalar_one()
        assert row.persona_id == "wall-800"


@pytest.mark.asyncio
async def test_persona_wins_requires_auth() -> None:
    """T-185-02: unauthenticated GET /bots/persona-wins -> 401."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(PERSONA_WINS_ENDPOINT)
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_persona_wins_scoped_to_authenticated_user(
    bots_user_client: tuple[int, str], test_engine
) -> None:
    """T-185-02: user B cannot read user A's persona wins (no cross-user leakage)."""
    _user_a_id, token_a = bots_user_client
    email_b = f"bots_test_{uuid.uuid4().hex[:8]}@example.com"
    user_b_id, token_b = await _register_and_login(email_b)

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            headers_a = {"Authorization": f"Bearer {token_a}"}
            store_resp = await client.post(
                BOTS_ENDPOINT,
                json=_make_bot_game_payload(persona_id="solid-wall-1000"),
                headers=headers_a,
            )
            assert store_resp.status_code == 200, store_resp.text
            assert store_resp.json()["created"] is True

            headers_b = {"Authorization": f"Bearer {token_b}"}
            wins_resp_b = await client.get(PERSONA_WINS_ENDPOINT, headers=headers_b)
            assert wins_resp_b.status_code == 200, wins_resp_b.text
            assert wins_resp_b.json() == {}

            wins_resp_a = await client.get(PERSONA_WINS_ENDPOINT, headers=headers_a)
            assert wins_resp_a.status_code == 200, wins_resp_a.text
            assert wins_resp_a.json() == {"solid-wall-1000": 1}
    finally:
        await _delete_games_for_user(test_engine, user_b_id)
