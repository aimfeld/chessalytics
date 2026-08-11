"""Integration tests for GET/PUT /users/me/profile endpoints.

Uses httpx.AsyncClient with ASGITransport to test the FastAPI app directly.
Each test class uses a module-scoped user so registration only happens once per module.
"""

import uuid

import httpx
import pytest
import pytest_asyncio

from app.main import app
from app.models.user import User


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def unique_email(prefix: str = "user") -> str:
    """Generate a unique email address for each test run."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def _register_and_login(client: httpx.AsyncClient, email: str, password: str) -> str:
    """Register a user and return their JWT access token."""
    await client.post("/api/auth/register", json={"email": email, "password": password})
    login_resp = await client.post(
        "/api/auth/jwt/login",
        data={"username": email, "password": password},
    )
    return login_resp.json()["access_token"]


async def _register_login_and_get_id(
    client: httpx.AsyncClient, email: str, password: str
) -> tuple[int, str]:
    """Register a user, login, and return (user_id, access_token).

    Used by BETA-01 tests that need to flip `beta_enabled` via a direct DB
    UPDATE — matches the "direct DB op only" contract from BETA-01 / T-66-04.
    """
    reg = await client.post("/api/auth/register", json={"email": email, "password": password})
    user_id = int(reg.json()["id"])
    login_resp = await client.post(
        "/api/auth/jwt/login",
        data={"username": email, "password": password},
    )
    return user_id, login_resp.json()["access_token"]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="module")
async def auth_headers() -> dict[str, str]:
    """Register a user once per module and return auth headers."""
    email = unique_email("profile")
    password = "testpassword123"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        token = await _register_and_login(client, email, password)

    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# GET /users/me/profile
# ---------------------------------------------------------------------------


class TestGetProfile:
    @pytest.mark.asyncio
    async def test_get_profile_returns_null_usernames(self, auth_headers):
        """GET /users/me/profile returns 200 with null usernames for a new user."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/users/me/profile", headers=auth_headers)

        assert resp.status_code == 200
        body = resp.json()
        assert "chess_com_username" in body
        assert "lichess_username" in body
        assert body["chess_com_username"] is None
        assert body["lichess_username"] is None

    @pytest.mark.asyncio
    async def test_get_profile_unauthenticated(self):
        """GET /users/me/profile without auth returns 401."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/users/me/profile")

        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# PUT /users/me/profile
# ---------------------------------------------------------------------------


class TestPutProfile:
    @pytest.mark.asyncio
    async def test_put_profile_updates_usernames(self):
        """PUT /users/me/profile updates both usernames and GET confirms the values."""
        email = unique_email("profile_update")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token = await _register_and_login(client, email, password)
            headers = {"Authorization": f"Bearer {token}"}

            # Update both usernames
            put_resp = await client.put(
                "/api/users/me/profile",
                json={
                    "chess_com_username": "magnus2024",
                    "lichess_username": "magnus_lichess",
                },
                headers=headers,
            )
            assert put_resp.status_code == 200
            put_body = put_resp.json()
            assert put_body["chess_com_username"] == "magnus2024"
            assert put_body["lichess_username"] == "magnus_lichess"

            # GET confirms updates persisted
            get_resp = await client.get("/api/users/me/profile", headers=headers)
            assert get_resp.status_code == 200
            get_body = get_resp.json()
            assert get_body["chess_com_username"] == "magnus2024"
            assert get_body["lichess_username"] == "magnus_lichess"

    @pytest.mark.asyncio
    async def test_put_profile_unauthenticated(self):
        """PUT /users/me/profile without auth returns 401."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.put(
                "/api/users/me/profile",
                json={"chess_com_username": "testuser"},
            )

        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# User isolation — profile returns the authenticated user's own data
# ---------------------------------------------------------------------------


class TestProfileUserIsolation:
    @pytest.mark.asyncio
    async def test_profile_returns_own_email(self):
        """Each user's GET /users/me/profile must return their own email, not another user's."""
        email_a = unique_email("iso_a")
        email_b = unique_email("iso_b")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token_a = await _register_and_login(client, email_a, password)
            token_b = await _register_and_login(client, email_b, password)

            profile_a = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token_a}"},
            )
            profile_b = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token_b}"},
            )

        assert profile_a.status_code == 200
        assert profile_b.status_code == 200
        assert profile_a.json()["email"] == email_a
        assert profile_b.json()["email"] == email_b


# ---------------------------------------------------------------------------
# BETA-01: beta_enabled flag round-trip through /users/me/profile
# ---------------------------------------------------------------------------


class TestProfileBetaEnabled:
    @pytest.mark.asyncio
    async def test_profile_returns_beta_enabled_default_false(self):
        """BETA-01: a newly registered user has beta_enabled=False by default."""
        email = unique_email("beta_default")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token = await _register_and_login(client, email, password)
            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "beta_enabled" in body
        assert body["beta_enabled"] is False

    @pytest.mark.asyncio
    async def test_profile_returns_beta_enabled_true_after_db_flip(self):
        """BETA-01: direct DB UPDATE is the only way to enable the flag — verified by round-trip."""
        from sqlalchemy import update

        from app.core.database import async_session_maker

        email = unique_email("beta_flip")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)

            # Flip beta_enabled via direct DB op (the only legitimate path per BETA-01).
            async with async_session_maker() as session:
                await session.execute(
                    update(User).where(User.id == user_id).values(beta_enabled=True)
                )
                await session.commit()

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        assert resp.json()["beta_enabled"] is True

    @pytest.mark.asyncio
    async def test_user_profile_update_does_not_change_beta_enabled(self):
        """Threat T-66-02: UserProfileUpdate must not include beta_enabled.

        PUT /users/me/profile with a payload carrying beta_enabled=false leaves the
        DB-flipped True value unchanged because Pydantic v2 silently drops unknown
        fields via its default extra="ignore".
        """
        from sqlalchemy import update

        from app.core.database import async_session_maker

        email = unique_email("beta_mass_assign")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)
            headers = {"Authorization": f"Bearer {token}"}

            # Set the flag via direct DB op (the only legitimate path per BETA-01).
            async with async_session_maker() as session:
                await session.execute(
                    update(User).where(User.id == user_id).values(beta_enabled=True)
                )
                await session.commit()

            # Attempt to disable via PUT with a malicious payload.
            put_resp = await client.put(
                "/api/users/me/profile",
                json={"chess_com_username": "legit", "beta_enabled": False},
                headers=headers,
            )
            assert put_resp.status_code == 200
            # beta_enabled stays True because UserProfileUpdate ignores unknown fields.
            assert put_resp.json()["beta_enabled"] is True

            # GET confirms persistence — the flag was not silently flipped.
            get_resp = await client.get("/api/users/me/profile", headers=headers)
            assert get_resp.status_code == 200
            assert get_resp.json()["beta_enabled"] is True


# ---------------------------------------------------------------------------
# Phase 171-02 D-07: lichess_blitz_equivalent_rating (blitz-bucket anchor)
# ---------------------------------------------------------------------------


class TestProfileLichessBlitzEquivalentRating:
    @pytest.mark.asyncio
    async def test_profile_returns_null_lichess_blitz_when_no_anchors(self):
        """A freshly registered user (no anchors at all) gets field=None, present."""
        email = unique_email("blitz_anchor_none")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token = await _register_and_login(client, email, password)
            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "lichess_blitz_equivalent_rating" in body
        assert body["lichess_blitz_equivalent_rating"] is None

    @pytest.mark.asyncio
    async def test_profile_returns_lichess_blitz_anchor_rating(self):
        """A user with a blitz-bucket anchor gets that anchor's rating."""
        from app.core.database import async_session_maker
        from app.repositories.user_rating_anchors_repository import upsert_anchor

        email = unique_email("blitz_anchor_present")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)

            async with async_session_maker() as session:
                await upsert_anchor(
                    session,
                    user_id=user_id,
                    time_control_bucket="blitz",
                    anchor_rating=1740,
                    n_chesscom_games=0,
                    n_lichess_games=25,
                    chesscom_median_native=None,
                    lichess_median_native=1740,
                )
                await session.commit()

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "lichess_blitz_equivalent_rating" in body
        assert body["lichess_blitz_equivalent_rating"] == 1740

    @pytest.mark.asyncio
    async def test_profile_returns_null_lichess_blitz_when_only_non_blitz_anchors(self):
        """A user with only rapid/classical anchors (no blitz) gets None -- the
        blitz-bucket semantic is deliberate, not a bug (D-07)."""
        from app.core.database import async_session_maker
        from app.repositories.user_rating_anchors_repository import upsert_anchor

        email = unique_email("blitz_anchor_nonblitz")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)

            async with async_session_maker() as session:
                await upsert_anchor(
                    session,
                    user_id=user_id,
                    time_control_bucket="rapid",
                    anchor_rating=1600,
                    n_chesscom_games=0,
                    n_lichess_games=20,
                    chesscom_median_native=None,
                    lichess_median_native=1600,
                )
                await upsert_anchor(
                    session,
                    user_id=user_id,
                    time_control_bucket="classical",
                    anchor_rating=1550,
                    n_chesscom_games=0,
                    n_lichess_games=15,
                    chesscom_median_native=None,
                    lichess_median_native=1550,
                )
                await session.commit()

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "lichess_blitz_equivalent_rating" in body
        assert body["lichess_blitz_equivalent_rating"] is None

    @pytest.mark.asyncio
    async def test_put_profile_returns_lichess_blitz_anchor_rating(self):
        """PUT /me/profile returns the same field with the same value as GET."""
        from app.core.database import async_session_maker
        from app.repositories.user_rating_anchors_repository import upsert_anchor

        email = unique_email("blitz_anchor_put")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)

            async with async_session_maker() as session:
                await upsert_anchor(
                    session,
                    user_id=user_id,
                    time_control_bucket="blitz",
                    anchor_rating=1680,
                    n_chesscom_games=10,
                    n_lichess_games=0,
                    chesscom_median_native=1700,
                    lichess_median_native=None,
                )
                await session.commit()

            resp = await client.put(
                "/api/users/me/profile",
                json={"chess_com_username": "someuser"},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert "lichess_blitz_equivalent_rating" in body
        assert body["lichess_blitz_equivalent_rating"] == 1680


# ---------------------------------------------------------------------------
# Phase 186 Plan 01 (IMPORT-01): GET/PATCH /users/me/import-settings
# ---------------------------------------------------------------------------


class TestGetImportSettings:
    @pytest.mark.asyncio
    async def test_import_settings_defaults_for_new_user(self):
        """D-16: a user with no settings row gets app-layer defaults on first GET
        (bullet=false, blitz/rapid/classical=true, cap=1000) -- create-on-first-touch,
        same code path for guests and registered users.
        """
        email = unique_email("import_settings_default")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token = await _register_and_login(client, email, password)
            resp = await client.get(
                "/api/users/me/import-settings",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["tc_bullet"] is False
        assert body["tc_blitz"] is True
        assert body["tc_rapid"] is True
        assert body["tc_classical"] is True
        assert body["game_cap"] == 1000
        assert body["imported_counts"] == {}


class TestImportSettingsImportedCounts:
    @pytest.mark.asyncio
    async def test_imported_counts_include_all_games_for_own_user_only(self):
        """GET returns imported_counts matching ALL of the authenticated user's
        games -- including post-signup ones -- not just the pre-anchor backlog.

        UAT follow-up to Plan 03: the chips must read as an honest breakdown of
        the total game count. The seeded set includes a post-anchor rapid game;
        the old pre-anchor backlog count would have reported rapid:1, this must
        report rapid:2.
        """
        import datetime

        from app.core.database import async_session_maker
        from app.repositories.game_repository import bulk_insert_games

        def _row(
            user_id: int,
            platform_game_id: str,
            tc_bucket: str,
            played_at: datetime.datetime,
        ) -> dict:
            return {
                "user_id": user_id,
                "platform": "chess.com",
                "platform_game_id": platform_game_id,
                "platform_url": None,
                "pgn": '[Event "Test"]\n\n1. e4 *',
                "result": "1-0",
                "user_color": "white",
                "time_control_str": "600+0",
                "time_control_bucket": tc_bucket,
                "time_control_seconds": 600,
                "rated": True,
                "white_username": "u",
                "black_username": "o",
                "white_rating": 1600,
                "black_rating": 1550,
                "opening_name": None,
                "opening_eco": None,
                "played_at": played_at,
            }

        pre_anchor = datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc)
        # Well after account creation -> excluded from the pre-anchor backlog
        # count, but MUST be included in imported_counts.
        post_anchor = datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc)

        email_a = unique_email("import_settings_imported_a")
        email_b = unique_email("import_settings_imported_b")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id_a, token_a = await _register_login_and_get_id(client, email_a, password)
            token_b = await _register_and_login(client, email_b, password)

            async with async_session_maker() as session:
                await bulk_insert_games(
                    session,
                    [
                        _row(user_id_a, f"blitz-{uuid.uuid4().hex}", "blitz", pre_anchor),
                        _row(user_id_a, f"blitz-{uuid.uuid4().hex}", "blitz", pre_anchor),
                        _row(user_id_a, f"rapid-{uuid.uuid4().hex}", "rapid", pre_anchor),
                        _row(user_id_a, f"rapid-{uuid.uuid4().hex}", "rapid", post_anchor),
                    ],
                )
                await session.commit()

            resp_a = await client.get(
                "/api/users/me/import-settings",
                headers={"Authorization": f"Bearer {token_a}"},
            )
            resp_b = await client.get(
                "/api/users/me/import-settings",
                headers={"Authorization": f"Bearer {token_b}"},
            )

        assert resp_a.status_code == 200
        assert resp_a.json()["imported_counts"] == {"chess.com": {"blitz": 2, "rapid": 2}}

        # User B has no games -- must not see user A's imported counts.
        assert resp_b.status_code == 200
        assert resp_b.json()["imported_counts"] == {}


class TestPatchImportSettings:
    @pytest.mark.asyncio
    async def test_import_settings_patch_then_get_roundtrip(self):
        """D-09 persistence contract: PATCH persists and a subsequent GET returns
        exactly those values for that user only.
        """
        email = unique_email("import_settings_roundtrip")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token = await _register_and_login(client, email, password)
            headers = {"Authorization": f"Bearer {token}"}

            patch_resp = await client.patch(
                "/api/users/me/import-settings",
                json={
                    "tc_bullet": False,
                    "tc_blitz": True,
                    "tc_rapid": True,
                    "tc_classical": True,
                    "game_cap": 3000,
                },
                headers=headers,
            )
            assert patch_resp.status_code == 200
            assert patch_resp.json()["game_cap"] == 3000

            get_resp = await client.get("/api/users/me/import-settings", headers=headers)

        assert get_resp.status_code == 200
        get_body = get_resp.json()
        assert get_body["tc_bullet"] is False
        assert get_body["tc_blitz"] is True
        assert get_body["tc_rapid"] is True
        assert get_body["tc_classical"] is True
        assert get_body["game_cap"] == 3000

    @pytest.mark.asyncio
    async def test_import_settings_patch_invalid_game_cap_returns_422(self):
        """game_cap=2500 (not in {1000,3000,5000}) is rejected by Pydantic's Literal
        before it can reach the DB.
        """
        email = unique_email("import_settings_invalid_cap")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token = await _register_and_login(client, email, password)
            resp = await client.patch(
                "/api/users/me/import-settings",
                json={
                    "tc_bullet": False,
                    "tc_blitz": True,
                    "tc_rapid": True,
                    "tc_classical": True,
                    "game_cap": 2500,
                },
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 422


class TestPatchImportSettingsCursorReset:
    """UAT-186 regression: the per-platform backfill cursor has already walked
    past months/chunks the OLD scope skipped, so a PATCH that EXPANDS scope
    (a TC turned on, or the cap raised) must reset the cursors -- otherwise a
    newly enabled TC's games in already-walked months are never fetched.
    Narrowing or no-op saves must NOT throw away walk progress.
    """

    _DEFAULTS = {
        "tc_bullet": False,
        "tc_blitz": True,
        "tc_rapid": True,
        "tc_classical": True,
        "game_cap": 1000,
    }

    async def _seed_settings_and_cursors(self, user_id: int) -> None:
        from app.core.database import async_session_maker
        from app.repositories import user_import_settings_repository

        async with async_session_maker() as session:
            await user_import_settings_repository.get_or_create_settings(session, user_id=user_id)
            await user_import_settings_repository.update_chesscom_backfill_cursor(
                session, user_id=user_id, year=2020, month=5
            )
            await user_import_settings_repository.update_lichess_backfill_cursor(
                session, user_id=user_id, until_ms=1_500_000_000_000
            )
            await session.commit()

    async def _read_cursors(self, user_id: int) -> tuple[tuple[int, int] | None, int | None]:
        from app.core.database import async_session_maker
        from app.repositories import user_import_settings_repository

        async with async_session_maker() as session:
            chesscom = await user_import_settings_repository.get_chesscom_backfill_cursor(
                session, user_id=user_id
            )
            lichess = await user_import_settings_repository.get_lichess_backfill_cursor(
                session, user_id=user_id
            )
        return chesscom, lichess

    @pytest.mark.asyncio
    async def test_enabling_a_tc_resets_backfill_cursors(self):
        email = unique_email("import_settings_cursor_tc")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)
            await self._seed_settings_and_cursors(user_id)

            resp = await client.patch(
                "/api/users/me/import-settings",
                json={**self._DEFAULTS, "tc_bullet": True},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200

        chesscom, lichess = await self._read_cursors(user_id)
        assert chesscom is None, f"chess.com cursor must reset on TC enable, got {chesscom}"
        assert lichess is None, f"lichess cursor must reset on TC enable, got {lichess}"

    @pytest.mark.asyncio
    async def test_raising_cap_resets_backfill_cursors(self):
        email = unique_email("import_settings_cursor_cap")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)
            await self._seed_settings_and_cursors(user_id)

            resp = await client.patch(
                "/api/users/me/import-settings",
                json={**self._DEFAULTS, "game_cap": 3000},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200

        chesscom, lichess = await self._read_cursors(user_id)
        assert chesscom is None, f"chess.com cursor must reset on cap raise, got {chesscom}"
        assert lichess is None, f"lichess cursor must reset on cap raise, got {lichess}"

    @pytest.mark.asyncio
    async def test_narrowing_and_noop_keep_backfill_cursors(self):
        email = unique_email("import_settings_cursor_keep")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await _register_login_and_get_id(client, email, password)
            await self._seed_settings_and_cursors(user_id)
            headers = {"Authorization": f"Bearer {token}"}

            # Narrowing: disable a TC (rapid). Nothing previously skipped
            # becomes wanted, so walk progress must survive.
            narrowed = {**self._DEFAULTS, "tc_rapid": False}
            resp = await client.patch(
                "/api/users/me/import-settings", json=narrowed, headers=headers
            )
            assert resp.status_code == 200

            chesscom, lichess = await self._read_cursors(user_id)
            assert chesscom == (2020, 5), f"cursor must survive narrowing, got {chesscom}"
            assert lichess == 1_500_000_000_000, f"cursor must survive narrowing, got {lichess}"

            # No-op save of identical settings must also keep the cursors.
            resp = await client.patch(
                "/api/users/me/import-settings", json=narrowed, headers=headers
            )
            assert resp.status_code == 200

        chesscom, lichess = await self._read_cursors(user_id)
        assert chesscom == (2020, 5), f"cursor must survive a no-op save, got {chesscom}"
        assert lichess == 1_500_000_000_000, f"cursor must survive a no-op save, got {lichess}"


class TestImportSettingsUserIsolation:
    @pytest.mark.asyncio
    async def test_import_settings_cannot_read_or_write_another_users(self):
        """T-186-01: a GET/PATCH can never read or write another user's settings."""
        email_a = unique_email("import_settings_iso_a")
        email_b = unique_email("import_settings_iso_b")
        password = "testpassword123"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            token_a = await _register_and_login(client, email_a, password)
            token_b = await _register_and_login(client, email_b, password)

            # User A sets a distinctive game_cap.
            patch_resp = await client.patch(
                "/api/users/me/import-settings",
                json={
                    "tc_bullet": True,
                    "tc_blitz": True,
                    "tc_rapid": True,
                    "tc_classical": True,
                    "game_cap": 5000,
                },
                headers={"Authorization": f"Bearer {token_a}"},
            )
            assert patch_resp.status_code == 200

            # User B's GET must still see their own defaults, not A's values.
            resp_b = await client.get(
                "/api/users/me/import-settings",
                headers={"Authorization": f"Bearer {token_b}"},
            )

        assert resp_b.status_code == 200
        body_b = resp_b.json()
        assert body_b["tc_bullet"] is False
        assert body_b["game_cap"] == 1000
