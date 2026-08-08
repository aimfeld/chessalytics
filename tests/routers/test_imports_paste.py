"""Integration tests for POST /api/imports/paste (Phase 208, PASTE-04/06/07).

Covers, through the app client (not the service directly):
- Security: server-derived owner (T-208-10), per-user isolation (T-208-11),
  auth required, guest QUEUE-08 carve-out, PGN length bound (T-208-12), and
  an over-long crafted [Termination] header not producing a 500 (CR-02 class).
- Idempotency (PASTE-06): same game_id + one row on re-paste, in-place
  user_color flip, header-spelling-independent identity (D-16).
- Eval eligibility (PASTE-07): the eval-jobs-or-analyzed invariant, no
  re-enqueue on an already-analyzed re-paste, already_queued on a second
  concurrent-ish post.
- The SC-7 post-commit enqueue-failure window: a 200 with
  eval_status="enqueue_failed" instead of a 500 over a durably-saved row,
  and healing on resubmit — for both a regular account and a guest.

Uses httpx AsyncClient with ASGITransport, mirroring
tests/routers/test_imports_tier1_enqueue.py's fixture shape. Game rows are
committed through the app's own session path (get_async_session dependency
override commits per-request, see tests/conftest.py), so no rollback-scope
mismatch with enqueue_tier1_game's own session.
"""

from __future__ import annotations

import datetime
import uuid
from collections.abc import AsyncGenerator
from unittest.mock import AsyncMock, patch

import httpx
import pytest_asyncio
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.main import app
from app.models.eval_jobs import EvalJob
from app.models.game import Game

PASTE_URL = "/api/imports/paste"

# Constants (no magic numbers)
_VALID_PASSWORD = "testpassword123"

_PGN_SCHOLARS_MATE = (
    '[Event "Casual game"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n'
    "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n"
)

# Same mainline (Scholar's Mate, 1-0), wildly different header spellings
# (D-16 corpus evidence: one player spelled twelve ways) — must resolve to
# the SAME identity hash since headers are excluded from it.
_PGN_HEADER_VARIANT_A = (
    '[White "Noël, Studer"]\n[Black "Some Opponent"]\n[Event "Club Ch"]\n'
    '[Site "Basel"]\n[Date "2024.01.01"]\n[Result "1-0"]\n\n'
    "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n"
)
_PGN_HEADER_VARIANT_B = (
    '[White "IM Studer Noel 2438 (SUI)"]\n[Black "opponent, some"]\n'
    '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Result "1-0"]\n\n'
    "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n"
)

# CR-02 defect class: an over-long/unrecognized [Termination] header must
# never crash the INSERT. normalize_pasted_game always derives termination
# from the board (Plan 02), so this must resolve to a normal 200.
_PGN_LONG_TERMINATION_HEADER = (
    '[Event "Casual game"]\n[Result "1-0"]\n'
    f'[Termination "{"x" * 500}"]\n\n'
    "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _register_and_login(email: str, password: str = _VALID_PASSWORD) -> tuple[int, str]:
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


async def _create_guest(test_engine) -> tuple[int, str]:
    """Create a guest session and return (user_id, token) — mirrors
    test_imports_tier1_enqueue.py's helper."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/auth/guest/create")
    assert resp.status_code == 201, f"guest/create failed: {resp.text}"
    token = str(resp.json()["access_token"])

    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        row = await session.execute(
            text("SELECT id FROM users WHERE is_guest = true ORDER BY created_at DESC LIMIT 1")
        )
        user_id = int(row.scalar_one())
    return user_id, token


async def _delete_games_and_jobs(test_engine, user_id: int) -> None:
    """Delete all seeded/inserted games (cascade-deletes eval_jobs) for cleanup."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.user_id == user_id))
        await session.commit()


async def _count_pgn_games(test_engine, user_id: int) -> int:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        result = await session.execute(
            select(func.count())
            .select_from(Game)
            .where(Game.user_id == user_id, Game.platform == "pgn")
        )
        return result.scalar_one()


async def _count_eval_jobs_for_game(test_engine, game_id: int) -> int:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        result = await session.execute(
            select(func.count()).select_from(EvalJob).where(EvalJob.game_id == game_id)
        )
        return result.scalar_one()


async def _get_game(test_engine, game_id: int) -> Game | None:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        return await session.get(Game, game_id)


async def _stamp_fully_analyzed(test_engine, game_id: int) -> None:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        await session.execute(
            update(Game)
            .where(Game.id == game_id)
            .values(full_evals_completed_at=datetime.datetime.now(datetime.timezone.utc))
        )
        await session.commit()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def user_client(test_engine) -> AsyncGenerator[tuple[int, str], None]:
    email = f"paste_owner_{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    yield user_id, token
    await _delete_games_and_jobs(test_engine, user_id)


@pytest_asyncio.fixture
async def other_user_client(test_engine) -> AsyncGenerator[tuple[int, str], None]:
    email = f"paste_other_{uuid.uuid4().hex[:8]}@example.com"
    user_id, token = await _register_and_login(email)
    yield user_id, token
    await _delete_games_and_jobs(test_engine, user_id)


@pytest_asyncio.fixture
async def guest_client(test_engine) -> AsyncGenerator[tuple[int, str], None]:
    user_id, token = await _create_guest(test_engine)
    yield user_id, token
    await _delete_games_and_jobs(test_engine, user_id)


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _post_paste(
    token: str, pgn: str = _PGN_SCHOLARS_MATE, user_color: str = "white"
) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post(
            PASTE_URL,
            headers=_headers(token),
            json={"pgn": pgn, "user_color": user_color},
        )


# ---------------------------------------------------------------------------
# Security
# ---------------------------------------------------------------------------


class TestSecurity:
    async def test_requires_auth(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                PASTE_URL, json={"pgn": _PGN_SCHOLARS_MATE, "user_color": "white"}
            )
        assert response.status_code == 401

    async def test_foreign_owner_field_in_body_is_ignored(
        self, user_client: tuple[int, str], other_user_client: tuple[int, str], test_engine
    ) -> None:
        """A body carrying a foreign owner-shaped field does not change the
        persisted row's owner — the principal is server-derived (T-208-10)."""
        user_id, token = user_client
        other_user_id, _other_token = other_user_client

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                PASTE_URL,
                headers=_headers(token),
                json={
                    "pgn": _PGN_SCHOLARS_MATE,
                    "user_color": "white",
                    "user_id": other_user_id,
                },
            )
        assert response.status_code == 200
        game_id = response.json()["game_id"]

        game = await _get_game(test_engine, game_id)
        assert game is not None
        assert game.user_id == user_id
        assert game.user_id != other_user_id

    async def test_two_users_posting_same_pgn_get_isolated_rows(
        self, user_client: tuple[int, str], other_user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token_a = user_client
        _other_id, token_b = other_user_client

        resp_a = await _post_paste(token_a)
        resp_b = await _post_paste(token_b)

        assert resp_a.status_code == 200
        assert resp_b.status_code == 200
        game_id_a = resp_a.json()["game_id"]
        game_id_b = resp_b.json()["game_id"]
        assert game_id_a != game_id_b

        game_a = await _get_game(test_engine, game_id_a)
        assert game_a is not None
        assert game_a.user_color == "white"

    async def test_guest_can_save_and_enqueue_own_pasted_game(
        self, guest_client: tuple[int, str], test_engine
    ) -> None:
        guest_id, token = guest_client
        response = await _post_paste(token)
        assert response.status_code == 200
        body = response.json()
        assert body["eval_status"] == "enqueued"

        game = await _get_game(test_engine, body["game_id"])
        assert game is not None
        assert game.user_id == guest_id

    async def test_pgn_over_length_limit_rejected_422(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token = user_client
        from app.schemas.imports import MAX_PASTED_PGN_LENGTH

        too_long_pgn = "x" * (MAX_PASTED_PGN_LENGTH + 1)
        response = await _post_paste(token, pgn=too_long_pgn)
        assert response.status_code == 422

        user_id, _ = user_client
        assert await _count_pgn_games(test_engine, user_id) == 0

    async def test_over_long_termination_header_does_not_500(
        self, user_client: tuple[int, str]
    ) -> None:
        """CR-02 defect class: normalize_pasted_game always derives
        termination from the board, never the header — an over-long/
        unrecognized [Termination] header must not crash the INSERT."""
        _user_id, token = user_client
        response = await _post_paste(token, pgn=_PGN_LONG_TERMINATION_HEADER)
        assert response.status_code in (200, 422)
        assert response.status_code != 500


# ---------------------------------------------------------------------------
# Idempotency (PASTE-06)
# ---------------------------------------------------------------------------


class TestIdempotency:
    async def test_identical_pgn_posted_twice_same_game_id_one_row(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        user_id, token = user_client
        resp1 = await _post_paste(token)
        resp2 = await _post_paste(token)

        assert resp1.status_code == 200
        assert resp2.status_code == 200
        body1 = resp1.json()
        body2 = resp2.json()
        assert body1["created"] is True
        assert body2["created"] is False
        assert body1["game_id"] == body2["game_id"]
        assert await _count_pgn_games(test_engine, user_id) == 1

    async def test_other_user_color_flips_in_place_one_row(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        user_id, token = user_client
        resp1 = await _post_paste(token, user_color="white")
        resp2 = await _post_paste(token, user_color="black")

        assert resp1.status_code == 200
        assert resp2.status_code == 200
        assert resp1.json()["game_id"] == resp2.json()["game_id"]
        assert resp2.json()["created"] is False

        game = await _get_game(test_engine, resp2.json()["game_id"])
        assert game is not None
        assert game.user_color == "black"
        assert await _count_pgn_games(test_engine, user_id) == 1

    async def test_header_spelling_variants_resolve_to_same_game_id(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        user_id, token = user_client
        resp_a = await _post_paste(token, pgn=_PGN_HEADER_VARIANT_A)
        resp_b = await _post_paste(token, pgn=_PGN_HEADER_VARIANT_B)

        assert resp_a.status_code == 200
        assert resp_b.status_code == 200
        assert resp_a.json()["game_id"] == resp_b.json()["game_id"]
        assert await _count_pgn_games(test_engine, user_id) == 1


# ---------------------------------------------------------------------------
# Eval eligibility (PASTE-07)
# ---------------------------------------------------------------------------


class TestEvalEligibility:
    async def test_successful_save_satisfies_eval_invariant(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token = user_client
        response = await _post_paste(token)
        assert response.status_code == 200
        body = response.json()
        assert body["eval_status"] == "enqueued"

        game = await _get_game(test_engine, body["game_id"])
        assert game is not None
        job_count = await _count_eval_jobs_for_game(test_engine, body["game_id"])
        assert game.full_evals_completed_at is not None or job_count >= 1

    async def test_already_analyzed_repost_does_not_reenqueue(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token = user_client
        first = await _post_paste(token)
        assert first.status_code == 200
        game_id = first.json()["game_id"]

        await _stamp_fully_analyzed(test_engine, game_id)
        jobs_before = await _count_eval_jobs_for_game(test_engine, game_id)

        second = await _post_paste(token)
        assert second.status_code == 200
        body2 = second.json()
        assert body2["eval_status"] == "already_analyzed"
        assert body2["game_id"] == game_id

        jobs_after = await _count_eval_jobs_for_game(test_engine, game_id)
        assert jobs_after == jobs_before

    async def test_second_post_while_first_pending_returns_already_queued(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token = user_client
        first = await _post_paste(token)
        second = await _post_paste(token)

        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["game_id"] == second.json()["game_id"]
        assert second.json()["eval_status"] == "already_queued"

        job_count = await _count_eval_jobs_for_game(test_engine, first.json()["game_id"])
        assert job_count == 1


# ---------------------------------------------------------------------------
# Post-commit enqueue failure (PASTE-07, SC-7 window)
# ---------------------------------------------------------------------------


class TestPostCommitEnqueueFailure:
    async def test_enqueue_failure_returns_200_and_survives(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token = user_client
        with patch(
            "app.services.store_paste_game_service.enqueue_tier1_game",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            response = await _post_paste(token)

        assert response.status_code == 200
        body = response.json()
        assert body["eval_status"] == "enqueue_failed"

        game = await _get_game(test_engine, body["game_id"])
        assert game is not None
        assert await _count_pgn_games(test_engine, _user_id) == 1

    async def test_enqueue_failure_heals_on_resubmit(
        self, user_client: tuple[int, str], test_engine
    ) -> None:
        _user_id, token = user_client
        with patch(
            "app.services.store_paste_game_service.enqueue_tier1_game",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            first = await _post_paste(token)
        assert first.status_code == 200
        assert first.json()["eval_status"] == "enqueue_failed"
        game_id = first.json()["game_id"]

        # Un-patched resubmit: resolves to the same row and heals.
        second = await _post_paste(token)
        assert second.status_code == 200
        body2 = second.json()
        assert body2["game_id"] == game_id
        assert body2["created"] is False
        assert body2["eval_status"] == "enqueued"

        job_count = await _count_eval_jobs_for_game(test_engine, game_id)
        assert job_count >= 1
        assert await _count_pgn_games(test_engine, _user_id) == 1

    async def test_enqueue_failure_heals_on_resubmit_for_guest(
        self, guest_client: tuple[int, str], test_engine
    ) -> None:
        """The guest case has NO background heal at all (tier-3 branch (a)
        excludes guests, branch (b) requires a non-null lichess_evals_at) —
        the user-driven retry is its only recovery."""
        guest_id, token = guest_client
        with patch(
            "app.services.store_paste_game_service.enqueue_tier1_game",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            first = await _post_paste(token)
        assert first.status_code == 200
        assert first.json()["eval_status"] == "enqueue_failed"
        game_id = first.json()["game_id"]

        game = await _get_game(test_engine, game_id)
        assert game is not None
        assert game.user_id == guest_id

        second = await _post_paste(token)
        assert second.status_code == 200
        body2 = second.json()
        assert body2["game_id"] == game_id
        assert body2["eval_status"] == "enqueued"

        job_count = await _count_eval_jobs_for_game(test_engine, game_id)
        assert job_count >= 1
