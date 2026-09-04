"""Tests for LastActivityMiddleware.

Covers:
- _extract_user_id unit tests (valid JWT, invalid JWT, missing header)
- Integration: last_activity is set on authenticated request
- Integration: throttle prevents update within 1 hour
- Integration: update fires again after throttle window expires
- Integration: impersonation tokens skip last_activity writes (D-07, phase 62)
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.main import app
from app.middleware.last_activity import _extract_user_id, _last_updated
from app.models.user import User
from app.models.user_activity import UserActivity
from app.users import auth_backend


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def unique_email(prefix: str = "activity") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def register_and_login(
    client: httpx.AsyncClient, email: str, password: str
) -> tuple[int, str]:
    """Register a user, log in, and return (user_id, access_token)."""
    reg_resp = await client.post("/api/auth/register", json={"email": email, "password": password})
    user_id: int = reg_resp.json()["id"]
    login_resp = await client.post(
        "/api/auth/jwt/login",
        data={"username": email, "password": password},
    )
    return user_id, login_resp.json()["access_token"]


# ---------------------------------------------------------------------------
# Unit tests: _extract_user_id
# ---------------------------------------------------------------------------


class TestExtractUserId:
    @pytest.mark.asyncio
    async def test_missing_auth_header_returns_none(self):
        """No Authorization header → None."""
        from starlette.requests import Request as StarletteRequest

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/health",
            "headers": [],
        }
        starlette_req = StarletteRequest(scope)
        result = _extract_user_id(starlette_req)
        assert result is None

    @pytest.mark.asyncio
    async def test_invalid_token_returns_none(self):
        """Malformed Bearer token → None (no exception raised)."""
        from starlette.requests import Request as StarletteRequest

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/openings/positions",
            "headers": [(b"authorization", b"Bearer not-a-valid-jwt")],
        }
        starlette_req = StarletteRequest(scope)
        result = _extract_user_id(starlette_req)
        assert result is None

    @pytest.mark.asyncio
    async def test_valid_token_returns_user_id(self):
        """A real JWT written by the app strategy decodes to an integer user_id."""

        # Create a mock user object with just the fields needed for write_token
        class _MockUser:
            id = 42

        strategy = auth_backend.get_strategy()
        # get_strategy()'s return type is a union across possible dependency-injection
        # shapes (ty can't narrow which branch applies here), and _MockUser is a minimal
        # duck-typed stand-in (id only) for FastAPI-Users' generic `models.UP` User
        # protocol rather than a real User instance.
        token: str = await strategy.write_token(  # ty: ignore[unresolved-attribute]
            _MockUser()  # ty: ignore[invalid-argument-type]
        )

        from starlette.requests import Request as StarletteRequest

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/api/openings/positions",
            "headers": [(b"authorization", f"Bearer {token}".encode())],
        }
        starlette_req = StarletteRequest(scope)
        result = _extract_user_id(starlette_req)
        assert result == 42


# ---------------------------------------------------------------------------
# Integration tests: full middleware flow
# ---------------------------------------------------------------------------


class TestLastActivityIntegration:
    @pytest.mark.asyncio
    async def test_last_activity_set_after_authenticated_request(self, test_engine):
        """Making an authenticated request should set last_activity on the user."""
        email = unique_email("set")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await register_and_login(client, email, "password123")
            # Hit any authenticated endpoint
            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200

        # Verify last_activity was set in DB
        from sqlalchemy.ext.asyncio import async_sessionmaker as _maker

        session_maker = _maker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            result = await session.execute(select(User.last_activity).where(User.id == user_id))
            last_activity = result.scalar_one_or_none()

        assert last_activity is not None

    @pytest.mark.asyncio
    async def test_throttle_prevents_immediate_update(self, test_engine):
        """Two rapid successive requests should not update last_activity twice."""
        email = unique_email("throttle")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await register_and_login(client, email, "password123")
            headers = {"Authorization": f"Bearer {token}"}

            # First request — sets last_activity
            resp1 = await client.get("/api/users/me/profile", headers=headers)
            assert resp1.status_code == 200

        # Read the initial last_activity
        from sqlalchemy.ext.asyncio import async_sessionmaker as _maker

        session_maker = _maker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            result = await session.execute(select(User.last_activity).where(User.id == user_id))
            first_activity = result.scalar_one_or_none()
        assert first_activity is not None

        # Second request immediately after — should NOT update (within throttle window)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.get("/api/users/me/profile", headers={"Authorization": f"Bearer {token}"})

        async with session_maker() as session:
            result = await session.execute(select(User.last_activity).where(User.id == user_id))
            second_activity = result.scalar_one_or_none()

        # Timestamps should be identical (throttled — no update)
        assert second_activity == first_activity

    @pytest.mark.asyncio
    async def test_update_fires_after_throttle_window(self, test_engine):
        """After backdating last_activity by >1h, the next request should update it."""
        email = unique_email("expired")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await register_and_login(client, email, "password123")
            # Initial request to set last_activity
            await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        # Clear in-memory throttle cache so the middleware checks the DB again
        _last_updated.pop(user_id, None)

        # Manually backdate last_activity by 2 hours
        from sqlalchemy.ext.asyncio import async_sessionmaker as _maker

        session_maker = _maker(test_engine, expire_on_commit=False)
        stale_time = datetime.now(timezone.utc) - timedelta(hours=2)
        async with session_maker() as session:
            await session.execute(
                sa_update(User).where(User.id == user_id).values(last_activity=stale_time)
            )
            await session.commit()

        # Make another authenticated request
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        # last_activity should now be newer than stale_time
        async with session_maker() as session:
            result = await session.execute(select(User.last_activity).where(User.id == user_id))
            updated_activity = result.scalar_one_or_none()

        assert updated_activity is not None
        assert updated_activity > stale_time


# ---------------------------------------------------------------------------
# D-07: impersonation tokens must skip last_activity writes (phase 62)
# ---------------------------------------------------------------------------


class TestImpersonationSkip:
    """Middleware short-circuits when the request's JWT has is_impersonation=true.

    Without this, an admin's long impersonation session would silently bump the
    target user's activity counter, exposing impersonation (target sees "active
    now" spikes) and corrupting "who's active" dashboards.
    """

    _DEFAULT_PASSWORD = "pw12345678"

    @staticmethod
    def _unique_email(prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"

    @classmethod
    async def _register(cls, client: httpx.AsyncClient, email: str) -> int:
        resp = await client.post(
            "/api/auth/register",
            json={"email": email, "password": cls._DEFAULT_PASSWORD},
        )
        assert resp.status_code in (200, 201), f"register failed: {resp.text}"
        return int(resp.json()["id"])

    @classmethod
    async def _login(cls, client: httpx.AsyncClient, email: str) -> str:
        resp = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": cls._DEFAULT_PASSWORD},
        )
        assert resp.status_code == 200, f"login failed: {resp.text}"
        return str(resp.json()["access_token"])

    @staticmethod
    async def _set_superuser(test_engine, user_id: int) -> None:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            await session.execute(
                sa_update(User).where(User.id == user_id).values(is_superuser=True)
            )
            await session.commit()

    @staticmethod
    async def _get_last_activity(test_engine, user_id: int):
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            result = await session.execute(select(User.last_activity).where(User.id == user_id))
            return result.scalar_one_or_none()

    @classmethod
    async def _impersonate(cls, client: httpx.AsyncClient, admin_token: str, target_id: int) -> str:
        """Issue and return an impersonation JWT by calling /admin/impersonate."""
        resp = await client.post(
            f"/api/admin/impersonate/{target_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert resp.status_code == 200, f"impersonate failed: {resp.text}"
        return str(resp.json()["access_token"])

    @classmethod
    async def _setup_admin_and_target(
        cls, client: httpx.AsyncClient, test_engine
    ) -> tuple[int, str, int]:
        """Register admin + target, promote admin, return (admin_id, admin_token, target_id)."""
        admin_email = cls._unique_email("imp_admin")
        target_email = cls._unique_email("imp_target")
        admin_id = await cls._register(client, admin_email)
        target_id = await cls._register(client, target_email)
        await cls._set_superuser(test_engine, admin_id)
        admin_token = await cls._login(client, admin_email)
        return admin_id, admin_token, target_id

    @pytest.mark.asyncio
    async def test_impersonation_skips_target_last_activity(self, test_engine):
        """Under impersonation, target's last_activity must NOT be updated (D-07)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            admin_id, admin_token, target_id = await self._setup_admin_and_target(
                client, test_engine
            )
            imp_token = await self._impersonate(client, admin_token, target_id)

            # Clear the throttle cache for both so the middleware would attempt
            # a write on the next call (if not short-circuited).
            _last_updated.pop(admin_id, None)
            _last_updated.pop(target_id, None)

            target_before = await self._get_last_activity(test_engine, target_id)

            # Hit an authenticated endpoint under the impersonation token.
            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {imp_token}"},
            )
            assert resp.status_code == 200

            target_after = await self._get_last_activity(test_engine, target_id)

        assert target_after == target_before, (
            "target.last_activity must NOT change during impersonation (D-07)"
        )

    @pytest.mark.asyncio
    async def test_impersonation_skips_admin_last_activity(self, test_engine):
        """Under impersonation, admin's last_activity must NOT be updated (D-08 defensive)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            admin_id, admin_token, target_id = await self._setup_admin_and_target(
                client, test_engine
            )
            imp_token = await self._impersonate(client, admin_token, target_id)

            _last_updated.pop(admin_id, None)
            _last_updated.pop(target_id, None)

            admin_before = await self._get_last_activity(test_engine, admin_id)

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {imp_token}"},
            )
            assert resp.status_code == 200

            admin_after = await self._get_last_activity(test_engine, admin_id)

        assert admin_after == admin_before, (
            "admin.last_activity must NOT change during impersonation (D-08 defensive)"
        )

    @pytest.mark.asyncio
    async def test_non_impersonation_still_writes_last_activity(self, test_engine):
        """Regression guard: regular (non-impersonation) requests STILL update last_activity."""
        email = self._unique_email("regular_act")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id = await self._register(client, email)
            token = await self._login(client, email)

            # Clear cache so the middleware performs a write.
            _last_updated.pop(user_id, None)

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200

        last_activity = await self._get_last_activity(test_engine, user_id)
        assert last_activity is not None, (
            "Regression: regular request must still write last_activity"
        )


# ---------------------------------------------------------------------------
# User activity recording tests (DDG-01)
# ---------------------------------------------------------------------------


class TestUserActivityRecording:
    """Tests for the user_activity ON CONFLICT upsert in LastActivityMiddleware.

    Covers: fresh-day insert (count=1), same-day increment (count=2, one row),
    and skip conditions (impersonated, anonymous, >=400 status).
    """

    _DEFAULT_PASSWORD = "pw12345678"

    @staticmethod
    def _unique_email(prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"

    @classmethod
    async def _register_and_login(cls, client: httpx.AsyncClient, email: str) -> tuple[int, str]:
        return await register_and_login(client, email, cls._DEFAULT_PASSWORD)

    @staticmethod
    async def _get_activity_rows(test_engine, user_id: int, activity_date) -> list[UserActivity]:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            result = await session.execute(
                select(UserActivity).where(
                    UserActivity.user_id == user_id,
                    UserActivity.activity_date == activity_date,
                )
            )
            return list(result.scalars().all())

    @pytest.mark.asyncio
    async def test_fresh_active_day_creates_row_with_count_one(self, test_engine):
        """First authenticated request on a new UTC day creates a user_activity row with count 1."""
        email = self._unique_email("ua_fresh")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await self._register_and_login(client, email)
            # Pop any cached throttle entry so the middleware definitely writes
            _last_updated.pop(user_id, None)

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200

        today = datetime.now(timezone.utc).date()
        rows = await self._get_activity_rows(test_engine, user_id, today)

        assert len(rows) == 1, f"Expected one user_activity row, got {len(rows)}"
        assert rows[0].activity_count == 1, f"Expected count 1, got {rows[0].activity_count}"

    @pytest.mark.asyncio
    async def test_same_day_second_write_increments_count(self, test_engine):
        """Second throttled write on the same UTC day increments activity_count to 2 (one row)."""
        email = self._unique_email("ua_incr")
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await self._register_and_login(client, email)
            _last_updated.pop(user_id, None)

            # First write
            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status_code == 200

        # Force past the in-memory throttle and the DB-level throttle window:
        # 1. Pop the in-memory cache entry.
        # 2. Backdate users.last_activity by >1h so the conditional UPDATE fires again.
        _last_updated.pop(user_id, None)
        stale_time = datetime.now(timezone.utc) - timedelta(hours=2)
        async with session_maker() as session:
            await session.execute(
                sa_update(User).where(User.id == user_id).values(last_activity=stale_time)
            )
            await session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp2 = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp2.status_code == 200

        today = datetime.now(timezone.utc).date()
        rows = await self._get_activity_rows(test_engine, user_id, today)

        assert len(rows) == 1, f"Expected exactly one row (unique key held), got {len(rows)}"
        assert rows[0].activity_count == 2, (
            f"Expected count 2 after ON CONFLICT, got {rows[0].activity_count}"
        )

    @pytest.mark.asyncio
    async def test_concurrent_requests_increment_count_once(self, test_engine):
        """A burst of concurrent same-user requests increments activity_count by 1, not N.

        Regression for the async check-then-act race: the throttle slot is claimed
        synchronously between the gate read and the first `await`, so concurrent
        in-flight requests (the frontend fires several parallel authenticated
        queries per page load) can't all pass the gate and each increment. Before
        the fix, count == CONCURRENCY; after, count == 1.
        """
        CONCURRENCY = 8
        email = self._unique_email("ua_race")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await self._register_and_login(client, email)
            # Empty cache so every request is eligible to write — the in-memory
            # slot-claim is the only thing that must collapse them to a single bump.
            _last_updated.pop(user_id, None)

            headers = {"Authorization": f"Bearer {token}"}
            responses = await asyncio.gather(
                *(client.get("/api/users/me/profile", headers=headers) for _ in range(CONCURRENCY))
            )
            assert all(r.status_code == 200 for r in responses)

        today = datetime.now(timezone.utc).date()
        rows = await self._get_activity_rows(test_engine, user_id, today)

        assert len(rows) == 1, f"Expected exactly one row, got {len(rows)}"
        assert rows[0].activity_count == 1, (
            f"Concurrent burst must increment once, got {rows[0].activity_count}"
        )

    @pytest.mark.asyncio
    async def test_impersonated_request_records_no_activity_row(self, test_engine):
        """Impersonated request must not create a user_activity row for the target (D-07)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            admin_id, admin_token, target_id = await TestImpersonationSkip._setup_admin_and_target(
                client, test_engine
            )
            imp_token = await TestImpersonationSkip._impersonate(client, admin_token, target_id)

            _last_updated.pop(admin_id, None)
            _last_updated.pop(target_id, None)

            resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {imp_token}"},
            )
            assert resp.status_code == 200

        today = datetime.now(timezone.utc).date()
        target_rows = await self._get_activity_rows(test_engine, target_id, today)
        assert len(target_rows) == 0, (
            f"Impersonated request must record no user_activity row for target, got {len(target_rows)}"
        )

    @pytest.mark.asyncio
    async def test_anonymous_request_records_no_activity_row(self, test_engine):
        """Unauthenticated request creates no user_activity row."""
        # Use a public health endpoint — no JWT needed
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/health")

        # The health endpoint has no user_id; just verify it succeeded and no crash
        assert resp.status_code == 200

        # No user to check — verify that the table is still consistent (no orphan rows
        # with NULL user_id, which would violate the FK). We count rows with null user_id
        # as a sanity check; it is not possible via the ORM but good to assert here.
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            result = await session.execute(
                select(UserActivity).where(UserActivity.user_id.is_(None))
            )
            null_rows = list(result.scalars().all())
        assert null_rows == [], "No user_activity row with null user_id should exist"

    @pytest.mark.asyncio
    async def test_error_response_records_no_activity_row(self, test_engine):
        """A request returning >=400 must not create a user_activity row for the user."""
        email = self._unique_email("ua_err")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            user_id, token = await self._register_and_login(client, email)
            _last_updated.pop(user_id, None)

            # Hit a protected endpoint without authentication → 401
            resp = await client.get("/api/users/me/profile")
        assert resp.status_code == 401

        today = datetime.now(timezone.utc).date()
        rows = await self._get_activity_rows(test_engine, user_id, today)
        assert len(rows) == 0, f"401 response must not produce a user_activity row, got {len(rows)}"
