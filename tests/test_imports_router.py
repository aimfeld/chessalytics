"""Integration tests for the import API router.

Tests the HTTP layer only. Import service orchestration logic is mocked — see
test_import_service.py for those tests.

Uses httpx AsyncClient with ASGITransport to test the FastAPI app directly
without spinning up a real server.
"""

import datetime
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.services.import_service as import_service
from app.main import app
from app.models.drill_item import DrillItem
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve
from app.models.game import Game
from app.models.import_job import ImportJob
from app.models.train_settings import TrainSettings
from app.repositories import train_repository
from app.repositories.game_repository import bulk_insert_games
from app.services import sharp_filler


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clear_jobs():
    """Clear job registry before each test to prevent cross-test pollution."""
    import_service._jobs.clear()
    yield
    import_service._jobs.clear()


@pytest_asyncio.fixture(autouse=True)
async def clear_import_job_rows(test_engine):
    """Delete durable import_jobs rows before/after each test.

    Bug fix (Phase 149 PRUNE-05): start_import now creates the import_jobs row
    synchronously (previously only the no-op'd background task wrote it, so
    these router tests never touched the table). `auth_headers` is
    module-scoped (one real user shared across this whole test class), so a
    leftover 'pending' row from an earlier test would collide with
    uq_import_jobs_user_platform_active on the next POST /imports for the same
    platform. `clear_jobs` above only clears the in-memory registry — this
    clears the durable DB rows too.
    """
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

    async def _clear() -> None:
        async with session_maker() as session:
            await session.execute(delete(ImportJob))
            await session.commit()

    await _clear()
    yield
    await _clear()


@pytest.fixture
def no_op_run_import():
    """Patch run_import to be a no-op coroutine so background tasks don't run."""

    async def _noop(job_id: str) -> None:
        pass

    with patch("app.services.import_service.run_import", side_effect=_noop):
        yield


@pytest_asyncio.fixture(scope="module")
async def auth_headers() -> dict[str, str]:
    """Register a user once per module and return auth headers for POST /imports."""
    email = f"importer_{uuid.uuid4().hex[:8]}@example.com"
    password = "testpassword123"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        await client.post("/api/auth/register", json={"email": email, "password": password})
        login_resp = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        token = login_resp.json()["access_token"]

    return {"Authorization": f"Bearer {token}"}


async def _register_and_login() -> tuple[int, dict[str, str]]:
    """Register a fresh user and return (user_id, auth_headers).

    Used by the GET /imports/{job_id} ownership tests (code-review 2026-07-02, #1)
    that need the authenticated user's id to assert the IDOR guard (own job → 200,
    another user's job → 404).
    """
    email = f"importer_{uuid.uuid4().hex[:8]}@example.com"
    password = "testpassword123"
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
    return user_id, {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# POST /imports
# ---------------------------------------------------------------------------


class TestPostImports:
    @pytest.mark.asyncio
    async def test_post_imports_returns_201_with_job_id(self, no_op_run_import, auth_headers):
        """POST /imports should return 201 with job_id and status pending."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": "testuser"},
                headers=auth_headers,
            )

        assert resp.status_code == 201
        data = resp.json()
        assert "job_id" in data
        assert data["status"] == "pending"
        assert len(data["job_id"]) == 36  # UUID format

    @pytest.mark.asyncio
    async def test_post_imports_lichess_returns_201(self, no_op_run_import, auth_headers):
        """POST /imports should work for lichess platform too."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/imports",
                json={"platform": "lichess", "username": "bobfischer"},
                headers=auth_headers,
            )

        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "pending"

    @pytest.mark.asyncio
    async def test_duplicate_import_returns_existing_job_with_200(
        self, no_op_run_import, auth_headers
    ):
        """Second POST for same platform should return existing job with 200."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # First import
            resp1 = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": "testuser"},
                headers=auth_headers,
            )
            assert resp1.status_code == 201
            job_id_1 = resp1.json()["job_id"]

            # Second import (duplicate)
            resp2 = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": "testuser"},
                headers=auth_headers,
            )

        assert resp2.status_code == 200
        data2 = resp2.json()
        assert data2["job_id"] == job_id_1

    @pytest.mark.asyncio
    async def test_post_imports_is_immediate_non_blocking(self, no_op_run_import, auth_headers):
        """POST /imports response must come back within 1 second (import is background)."""
        start = time.monotonic()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": "testuser"},
                headers=auth_headers,
            )

        elapsed = time.monotonic() - start
        assert resp.status_code == 201
        assert elapsed < 1.0, f"Response took too long: {elapsed:.2f}s"

    @pytest.mark.asyncio
    async def test_post_imports_invalid_platform_returns_422(self, auth_headers):
        """POST /imports with invalid platform should return 422."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/imports",
                json={"platform": "invalid_platform", "username": "testuser"},
                headers=auth_headers,
            )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_post_imports_empty_username_returns_422(self, auth_headers):
        """POST /imports with empty username should return 422."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": ""},
                headers=auth_headers,
            )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_post_imports_saves_username_immediately(self, no_op_run_import, auth_headers):
        """POST /imports should save the platform username to the user profile before
        launching the background task, so it persists even if the import fails.
        """
        mock_update_username = AsyncMock()

        with patch(
            "app.routers.imports.user_repository.update_platform_username",
            mock_update_username,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post(
                    "/api/imports",
                    json={"platform": "chess.com", "username": "alice"},
                    headers=auth_headers,
                )

        assert resp.status_code == 201
        # Username must have been saved before the background task starts
        mock_update_username.assert_called_once()
        call_args = mock_update_username.call_args
        # Args: (session, user_id, platform, username) — check platform and username
        assert call_args.args[2] == "chess.com"
        assert call_args.args[3] == "alice"

    @pytest.mark.asyncio
    async def test_concurrent_duplicate_import_returns_existing_job_with_200(
        self, no_op_run_import, test_engine
    ):
        """A genuine race (not just a same-process duplicate) is rejected at the
        DB level and returns the existing job with 200 (Phase 149 PRUNE-05).

        The in-memory find_active_job pre-check cannot catch every race: two
        concurrent requests can both observe an empty in-memory registry before
        either commits its durable row. Simulates that race window directly by
        (a) seeding a durable 'pending' import_jobs row for this user+platform
        as if a concurrent request already won, and (b) forcing
        find_active_job to return None (the pre-check's view during the race
        window). start_import must then hit the partial unique index's
        IntegrityError, roll back, and return the ALREADY-WON job with 200 —
        never creating a second active row for this (user_id, platform).
        """
        from sqlalchemy import select
        from sqlalchemy.ext.asyncio import async_sessionmaker

        from app.models.import_job import ImportJob

        user_id, headers = await _register_and_login()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        winner_job_id = str(uuid.uuid4())
        async with session_maker() as session:
            session.add(
                ImportJob(
                    id=winner_job_id,
                    user_id=user_id,
                    platform="chess.com",
                    username="winner",
                    status="pending",
                    games_fetched=0,
                    games_imported=0,
                )
            )
            await session.commit()

        with patch(
            "app.routers.imports.import_service.find_active_job",
            return_value=None,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post(
                    "/api/imports",
                    json={"platform": "chess.com", "username": "loser"},
                    headers=headers,
                )

        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == winner_job_id

        async with session_maker() as session:
            rows = (
                (
                    await session.execute(
                        select(ImportJob).where(
                            ImportJob.user_id == user_id,
                            ImportJob.platform == "chess.com",
                        )
                    )
                )
                .scalars()
                .all()
            )
        active_rows = [r for r in rows if r.status in ("pending", "in_progress")]
        assert len(active_rows) == 1, (
            f"Expected exactly one active row after the race, got {len(active_rows)}: "
            f"{[(r.id, r.status) for r in active_rows]}"
        )
        assert active_rows[0].id == winner_job_id

    @pytest.mark.asyncio
    async def test_non_integrity_db_failure_discards_stuck_in_memory_job(self):
        """A non-IntegrityError DB failure (e.g. a transient outage) during the
        durable-row insert must not strand the in-memory JobState as PENDING
        forever (CR-01 code review 2026-07-04).

        Before the fix, only IntegrityError was caught, so an OperationalError
        (or any other exception) left find_active_job() reporting a phantom
        PENDING job on every subsequent request — permanently locking the user
        out of importing this platform until a backend restart.
        """
        from sqlalchemy.exc import OperationalError

        import app.services.import_service as import_service

        user_id, headers = await _register_and_login()

        with patch(
            "app.routers.imports.import_job_repository.create_import_job",
            AsyncMock(side_effect=OperationalError("insert", {}, Exception("connection lost"))),
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                with pytest.raises(OperationalError):
                    await client.post(
                        "/api/imports",
                        json={"platform": "chess.com", "username": "outage"},
                        headers=headers,
                    )

        # The stuck in-memory PENDING job must have been discarded, so a
        # retry after the outage clears is not permanently locked out.
        assert import_service.find_active_job(user_id, "chess.com") is None


# ---------------------------------------------------------------------------
# GET /imports/{job_id}
# ---------------------------------------------------------------------------


class TestGetImportStatus:
    @pytest.mark.asyncio
    async def test_get_returns_job_progress(self, no_op_run_import, auth_headers):
        """GET /imports/{job_id} should return current progress data."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Create a job first
            create_resp = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": "alice"},
                headers=auth_headers,
            )
            job_id = create_resp.json()["job_id"]

            # Poll it (as the same authenticated user who owns the job)
            status_resp = await client.get(f"/api/imports/{job_id}", headers=auth_headers)

        assert status_resp.status_code == 200
        data = status_resp.json()
        assert data["job_id"] == job_id
        assert data["platform"] == "chess.com"
        assert data["username"] == "alice"
        assert data["status"] == "pending"
        assert "games_fetched" in data
        assert "games_imported" in data

    @pytest.mark.asyncio
    async def test_get_requires_auth(self):
        """GET /imports/{job_id} with no token → 401 (code-review 2026-07-02, #1)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/imports/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_get_unknown_job_id_returns_404(self, auth_headers):
        """GET /imports/{unknown_id} should return 404 for an authenticated user."""
        # Also mock the DB fallback so we don't need a real DB
        with patch(
            "app.routers.imports.import_job_repository.get_import_job",
            new=AsyncMock(return_value=None),
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get(
                    "/api/imports/00000000-0000-0000-0000-000000000000", headers=auth_headers
                )

        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_get_cross_user_in_memory_returns_404(self, no_op_run_import):
        """A user polling another user's in-memory job → 404 IDOR guard (#1)."""
        _owner_id, owner_headers = await _register_and_login()
        _other_id, other_headers = await _register_and_login()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            create_resp = await client.post(
                "/api/imports",
                json={"platform": "chess.com", "username": "alice"},
                headers=owner_headers,
            )
            job_id = create_resp.json()["job_id"]
            # A different authenticated user must not see the job (404, not 403).
            resp = await client.get(f"/api/imports/{job_id}", headers=other_headers)

        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_get_job_reflects_updated_progress(self, no_op_run_import, auth_headers):
        """GET should reflect updated games_fetched count."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Create a job
            create_resp = await client.post(
                "/api/imports",
                json={"platform": "lichess", "username": "bob"},
                headers=auth_headers,
            )
            job_id = create_resp.json()["job_id"]

            # Simulate some progress by mutating in-memory state
            job = import_service.get_job(job_id)
            assert job is not None  # job was just created
            job.games_fetched = 42
            job.games_imported = 40

            # Poll it
            status_resp = await client.get(f"/api/imports/{job_id}", headers=auth_headers)

        assert status_resp.status_code == 200
        data = status_resp.json()
        assert data["games_fetched"] == 42
        assert data["games_imported"] == 40

    @pytest.mark.asyncio
    async def test_get_falls_back_to_db_when_not_in_memory(self):
        """GET should query DB when job not found in in-memory registry (owner)."""
        user_id, headers = await _register_and_login()
        db_job = MagicMock()
        db_job.id = "some-db-job-id"
        db_job.user_id = user_id  # owned by the requesting user → 200
        db_job.platform = "chess.com"
        db_job.username = "alice"
        db_job.status = "completed"
        db_job.games_fetched = 100
        db_job.games_imported = 98
        db_job.error_message = None

        with patch(
            "app.routers.imports.import_job_repository.get_import_job",
            new=AsyncMock(return_value=db_job),
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get("/api/imports/some-db-job-id", headers=headers)

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert data["games_fetched"] == 100

    @pytest.mark.asyncio
    async def test_get_cross_user_db_fallback_returns_404(self):
        """A DB job owned by another user → 404 IDOR guard on the DB fallback (#1)."""
        _requester_id, headers = await _register_and_login()
        db_job = MagicMock()
        db_job.id = "some-db-job-id"
        db_job.user_id = _requester_id + 999_999  # a different owner
        db_job.platform = "chess.com"
        db_job.username = "alice"
        db_job.status = "completed"
        db_job.games_fetched = 100
        db_job.games_imported = 98
        db_job.error_message = None

        with patch(
            "app.routers.imports.import_job_repository.get_import_job",
            new=AsyncMock(return_value=db_job),
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get("/api/imports/some-db-job-id", headers=headers)

        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# DELETE /imports/games -- backfill-cursor reset (Phase 186 Plan 02,
# IMPORT-03, Pitfall 4)
# ---------------------------------------------------------------------------


class TestDeleteAllGamesCursorReset:
    @pytest.mark.asyncio
    async def test_delete_and_cursor_reset_preserves_tc_and_cap(self, test_engine):
        """After DELETE /imports/games, the backfill-cursor columns are NULL
        while tc_* and game_cap retain their pre-delete values (Pitfall 4:
        the cursor is not derived from `games` rows, so it must be reset
        explicitly, but the user's preferences must survive delete-all).
        """
        user_id, headers = await _register_and_login()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Set non-default TC/cap preferences via the real settings endpoint.
            patch_resp = await client.patch(
                "/api/users/me/import-settings",
                json={
                    "tc_bullet": True,
                    "tc_blitz": True,
                    "tc_rapid": False,
                    "tc_classical": True,
                    "game_cap": 3000,
                },
                headers=headers,
            )
            assert patch_resp.status_code == 200

            # Seed backfill-cursor columns directly -- no API writes them yet;
            # in production only the internal Sync backward walk does (186-02
            # Task 2). Confirms a pre-existing cursor from a prior walk.
            async with test_engine.begin() as conn:
                await conn.execute(
                    text(
                        "UPDATE user_import_settings SET "
                        "chesscom_backfill_oldest_year = 2024, "
                        "chesscom_backfill_oldest_month = 3, "
                        "lichess_backfill_oldest_ms = 1700000000000 "
                        "WHERE user_id = :uid"
                    ),
                    {"uid": user_id},
                )

            delete_resp = await client.delete("/api/imports/games", headers=headers)

        assert delete_resp.status_code == 200

        async with test_engine.connect() as conn:
            result = await conn.execute(
                text(
                    "SELECT tc_bullet, tc_blitz, tc_rapid, tc_classical, game_cap, "
                    "chesscom_backfill_oldest_year, chesscom_backfill_oldest_month, "
                    "lichess_backfill_oldest_ms "
                    "FROM user_import_settings WHERE user_id = :uid"
                ),
                {"uid": user_id},
            )
            row = result.fetchone()

        assert row is not None, "Expected the settings row to survive delete-all"
        tc_bullet, tc_blitz, tc_rapid, tc_classical, game_cap, cc_year, cc_month, li_ms = row
        assert (tc_bullet, tc_blitz, tc_rapid, tc_classical) == (True, True, False, True), (
            f"TC toggles must survive delete-all -- only progress cursors reset, got {row}"
        )
        assert game_cap == 3000, f"game_cap must survive delete-all, got {game_cap}"
        assert cc_year is None, "chesscom_backfill_oldest_year must be NULLed by delete-all"
        assert cc_month is None, "chesscom_backfill_oldest_month must be NULLed by delete-all"
        assert li_ms is None, "lichess_backfill_oldest_ms must be NULLed by delete-all"

    @pytest.mark.asyncio
    async def test_delete_and_cursor_reset_returns_deleted_game_count(self, test_engine):
        """DELETE /imports/games still returns the correct deleted_count
        alongside the new cursor-reset behavior (no regression to the
        existing delete-count contract)."""
        import datetime

        from app.core.database import async_session_maker
        from app.repositories.game_repository import bulk_insert_games

        user_id, headers = await _register_and_login()

        async with async_session_maker() as session:
            await bulk_insert_games(
                session,
                [
                    {
                        "user_id": user_id,
                        "platform": "chess.com",
                        "platform_game_id": f"cursor-reset-{uuid.uuid4().hex}",
                        "platform_url": None,
                        "pgn": '[Event "Test"]\n\n1. e4 *',
                        "result": "1-0",
                        "user_color": "white",
                        "time_control_str": "600+0",
                        "time_control_bucket": "blitz",
                        "time_control_seconds": 600,
                        "rated": True,
                        "white_username": "u",
                        "black_username": "o",
                        "white_rating": 1600,
                        "black_rating": 1550,
                        "opening_name": None,
                        "opening_eco": None,
                        "played_at": datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
                    },
                ],
            )
            await session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            delete_resp = await client.delete("/api/imports/games", headers=headers)

        assert delete_resp.status_code == 200
        assert delete_resp.json()["deleted_count"] == 1


# ---------------------------------------------------------------------------
# DELETE /imports/games -- Train drill-table cascade + survival (Phase 189
# Plan 02, POOL-09, D-02/D-03/D-04)
# ---------------------------------------------------------------------------


def _game_row(user_id: int, platform_game_id: str) -> dict:
    """Minimal valid Game row dict for bulk_insert_games (drill-cascade tests)."""
    return {
        "user_id": user_id,
        "platform": "chess.com",
        "platform_game_id": platform_game_id,
        "platform_url": None,
        "pgn": '[Event "Test"]\n\n1. e4 *',
        "result": "1-0",
        "user_color": "white",
        "time_control_str": "600+0",
        "time_control_bucket": "blitz",
        "time_control_seconds": 600,
        "rated": True,
        "white_username": "u",
        "black_username": "o",
        "white_rating": 1600,
        "black_rating": 1550,
        "opening_name": None,
        "opening_eco": None,
        "played_at": datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc),
    }


class TestDeleteAllGamesDrillCascade:
    @pytest.mark.asyncio
    async def test_delete_games_cascades_drill_rows(self, test_engine) -> None:
        """DELETE /imports/games cascades drill_items away via the games FK
        (D-02, unchanged CASCADE), while drill_sessions and train_settings
        survive (D-04).

        Phase 192 Plan 02 (D-05): `drill_solves.game_id` is now
        `ON DELETE SET NULL`, not `CASCADE` — a global herring pool means a
        game deletion must never delete a row out of another user's
        in-flight session, and that FK policy is uniform regardless of
        which user owns the row. So both `drill_solves` rows here SURVIVE
        this delete-all with `game_id` nulled (orphaned SR items, lazily
        evicted per `load_session_puzzles`) rather than being deleted
        alongside `drill_items`.
        """
        user_id, headers = await _register_and_login()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        async with session_maker() as seed_session:
            game_ids = await bulk_insert_games(
                seed_session,
                [
                    _game_row(user_id, f"drill-cascade-1-{uuid.uuid4().hex}"),
                    _game_row(user_id, f"drill-cascade-2-{uuid.uuid4().hex}"),
                ],
            )
            game1_id, game2_id = game_ids

            drill_session = DrillSession(
                user_id=user_id,
                session_date=datetime.date(2026, 7, 25),
                puzzle_count=2,
                expires_on=datetime.date(2026, 8, 1),
            )
            seed_session.add(drill_session)
            await seed_session.flush()

            seed_session.add(
                DrillItem(
                    user_id=user_id,
                    game_id=game1_id,
                    ply=6,
                    due_date=datetime.date(2026, 7, 26),
                )
            )
            seed_session.add(
                DrillSolve(
                    session_id=drill_session.id,
                    position=0,
                    user_id=user_id,
                    game_id=game1_id,
                    ply=6,
                    source=0,
                )
            )
            seed_session.add(
                DrillSolve(
                    session_id=drill_session.id,
                    position=1,
                    user_id=user_id,
                    game_id=game2_id,
                    ply=8,
                    source=0,
                )
            )
            seed_session.add(TrainSettings(user_id=user_id))
            await seed_session.commit()

        async def _count(model, *predicates) -> int:
            async with session_maker() as s:
                result = await s.execute(select(func.count()).select_from(model).where(*predicates))
                return result.scalar_one()

        assert await _count(DrillItem, DrillItem.user_id == user_id) == 1, (
            "seed setup must produce a non-zero drill_items count before delete"
        )
        assert await _count(DrillSolve, DrillSolve.user_id == user_id) == 2, (
            "seed setup must produce a non-zero drill_solves count before delete"
        )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            delete_resp = await client.delete("/api/imports/games", headers=headers)
        assert delete_resp.status_code == 200

        assert await _count(DrillItem, DrillItem.user_id == user_id) == 0
        assert await _count(DrillSession, DrillSession.user_id == user_id) == 1, (
            "drill_sessions must survive delete-all (D-04)"
        )
        assert await _count(TrainSettings, TrainSettings.user_id == user_id) == 1, (
            "train_settings must survive delete-all (D-04)"
        )
        # D-05: both drill_solves rows survive with game_id nulled (SET
        # NULL, not CASCADE) — never deleted alongside drill_items.
        assert await _count(DrillSolve, DrillSolve.user_id == user_id) == 2
        assert (
            await _count(DrillSolve, DrillSolve.user_id == user_id, DrillSolve.game_id.is_(None))
            == 2
        )

    @pytest.mark.asyncio
    async def test_delete_single_game_leaves_sibling_drill_rows(self, test_engine) -> None:
        """Deleting one game cascades only that game's drill_items; a sibling
        game's drill_items for the same user survive untouched (POOL-09 edge probe)."""
        user_id, _headers = await _register_and_login()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        async with session_maker() as seed_session:
            game_ids = await bulk_insert_games(
                seed_session,
                [
                    _game_row(user_id, f"single-delete-1-{uuid.uuid4().hex}"),
                    _game_row(user_id, f"single-delete-2-{uuid.uuid4().hex}"),
                ],
            )
            game1_id, game2_id = game_ids

            seed_session.add(
                DrillItem(
                    user_id=user_id,
                    game_id=game1_id,
                    ply=6,
                    due_date=datetime.date(2026, 7, 26),
                )
            )
            seed_session.add(
                DrillItem(
                    user_id=user_id,
                    game_id=game2_id,
                    ply=8,
                    due_date=datetime.date(2026, 7, 28),
                    streak=2,
                )
            )
            await seed_session.commit()

        # A targeted delete through the session -- not the DELETE /games
        # endpoint -- to isolate the single-game cascade from the delete-all path.
        async with session_maker() as delete_session:
            await delete_session.execute(delete(Game).where(Game.id == game1_id))
            await delete_session.commit()

        async with session_maker() as verify_session:
            surviving = (
                await verify_session.execute(select(DrillItem).where(DrillItem.game_id == game2_id))
            ).scalar_one()
            gone = (
                await verify_session.execute(select(DrillItem).where(DrillItem.game_id == game1_id))
            ).scalar_one_or_none()

        assert gone is None, "the deleted game's drill_items row must be cascaded away"
        assert surviving.streak == 2, "sibling drill_items row's streak must be unchanged"
        assert surviving.due_date == datetime.date(2026, 7, 28), (
            "sibling drill_items row's due_date must be unchanged"
        )

    @pytest.mark.asyncio
    async def test_delete_games_no_drill_rows_is_noop(self) -> None:
        """A user with games but zero train rows deletes cleanly -- no FK/cascade error."""
        user_id, headers = await _register_and_login()

        from app.core.database import async_session_maker

        async with async_session_maker() as seed_session:
            await bulk_insert_games(
                seed_session, [_game_row(user_id, f"no-drill-{uuid.uuid4().hex}")]
            )
            await seed_session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            delete_resp = await client.delete("/api/imports/games", headers=headers)

        assert delete_resp.status_code == 200
        assert delete_resp.json()["deleted_count"] == 1

    @pytest.mark.asyncio
    async def test_delete_games_twice_is_idempotent(self, test_engine) -> None:
        """A second DELETE /imports/games call returns 200 with deleted_count 0 and
        leaves the drill tables in the same (empty) state as after the first call."""
        user_id, headers = await _register_and_login()
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        async with session_maker() as seed_session:
            game_ids = await bulk_insert_games(
                seed_session, [_game_row(user_id, f"idempotent-{uuid.uuid4().hex}")]
            )
            (game_id,) = game_ids
            seed_session.add(
                DrillItem(
                    user_id=user_id,
                    game_id=game_id,
                    ply=6,
                    due_date=datetime.date(2026, 7, 26),
                )
            )
            await seed_session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            first_resp = await client.delete("/api/imports/games", headers=headers)
            second_resp = await client.delete("/api/imports/games", headers=headers)

        assert first_resp.status_code == 200
        assert second_resp.status_code == 200
        assert second_resp.json()["deleted_count"] == 0

        async with session_maker() as verify_session:
            result = await verify_session.execute(
                select(func.count()).select_from(DrillItem).where(DrillItem.user_id == user_id)
            )
            assert result.scalar_one() == 0, (
                "drill_items count after the second call must equal the count after the first (0)"
            )

    @pytest.mark.asyncio
    async def test_compose_session_after_delete_all_returns_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """POST /train/sessions after a full delete-all returns 200 with zero
        puzzles -- not a 500 from a dangling drill_items reference.

        Phase 206 (D-05): composition no longer returns an empty session
        once real material exists in the committed sharp-filler set — this
        test's actual regression guard is "no 500 from a dangling
        drill_items reference" after the cascade, which is orthogonal to
        Phase 206's backfill; the sharp set is patched empty here so the
        original "returns empty" assertion still exercises exactly that.
        """
        monkeypatch.setattr(sharp_filler, "SHARP_SET", ())
        monkeypatch.setattr(sharp_filler, "SHARP_SET_BY_ID", {})
        monkeypatch.setattr(train_repository, "SHARP_SET_BY_ID", {})
        user_id, headers = await _register_and_login()

        from app.core.database import async_session_maker

        async with async_session_maker() as seed_session:
            await bulk_insert_games(
                seed_session,
                [_game_row(user_id, f"compose-after-delete-{uuid.uuid4().hex}")],
            )
            await seed_session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            delete_resp = await client.delete("/api/imports/games", headers=headers)
            assert delete_resp.status_code == 200

            compose_resp = await client.post("/api/train/sessions", headers=headers)

        assert compose_resp.status_code == 200
        data = compose_resp.json()
        assert data["puzzles"] == []
