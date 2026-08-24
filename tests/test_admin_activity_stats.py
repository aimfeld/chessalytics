"""Integration tests for GET /api/admin/activity/stats (Quick 260824-qaz, Task 1).

Covers D-1 (SPA route, hard gate lives on this endpoint alone), D-2 (401 /
403 / 403-impersonation / 200 auth ladder), D-4 (dedicated read-only engine),
and D-5 (300s cache shared across requests, ?refresh=1 forces a rebuild).

Helper patterns are duplicated lightweight versions of test_admin_users_search.py
/ test_impersonation.py's helpers — project convention (see those files'
module docstrings): each test file's fixtures stay self-contained rather than
sharing a helpers module that has to serve every caller's slightly different
needs.
"""

import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import httpx
import pytest
from sqlalchemy import text
from sqlalchemy import update as sa_update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.main import app
from app.models.user import User
from app.routers import admin_activity
from dashboard import queries
from dashboard.stats import StatsCache, build_readonly_engine

_DEFAULT_PASSWORD = "pw12345678"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def unique_email(prefix: str = "activity") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def register(client: httpx.AsyncClient, email: str, password: str = _DEFAULT_PASSWORD) -> int:
    resp = await client.post("/api/auth/register", json={"email": email, "password": password})
    assert resp.status_code in (200, 201), f"register failed: {resp.status_code} {resp.text}"
    return int(resp.json()["id"])


async def login(client: httpx.AsyncClient, email: str, password: str = _DEFAULT_PASSWORD) -> str:
    resp = await client.post(
        "/api/auth/jwt/login",
        data={"username": email, "password": password},
    )
    assert resp.status_code == 200, f"login failed: {resp.status_code} {resp.text}"
    return str(resp.json()["access_token"])


async def register_and_login(
    client: httpx.AsyncClient, email: str, password: str = _DEFAULT_PASSWORD
) -> tuple[int, str]:
    user_id = await register(client, email, password)
    token = await login(client, email, password)
    return user_id, token


async def set_superuser(test_engine, user_id: int, is_superuser: bool) -> None:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        await session.execute(
            sa_update(User).where(User.id == user_id).values(is_superuser=is_superuser)
        )
        await session.commit()


async def make_superuser(client: httpx.AsyncClient, test_engine) -> tuple[int, str]:
    """Register + promote + re-login a superuser. Returns (id, token)."""
    email = unique_email("admin")
    user_id = await register(client, email)
    await set_superuser(test_engine, user_id, True)
    token = await login(client, email)
    return user_id, token


async def touch_user_activity(client: httpx.AsyncClient, token: str) -> None:
    """Trigger one authenticated request so LastActivityMiddleware writes a
    user_activity row for `token`'s owner.

    dashboard.queries.fetch_day_range runs `SELECT min(activity_date)` /
    `max(activity_date)` through `_scalar_date`, which asserts the result is a
    `datetime.date` — on a fresh test DB with zero user_activity rows that
    assert fails (min() of an empty set is NULL), so the 200-path tests below
    need at least one row before build_payload can run for real.
    """
    resp = await client.get("/api/users/me/profile", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, f"{resp.status_code} {resp.text}"


@asynccontextmanager
async def cache_override(cache: StatsCache) -> AsyncGenerator[None, None]:
    """Point GET /admin/activity/stats at `cache` for the duration of the block.

    Mirrors conftest.py's override_get_async_session pattern: the dependency
    seam (admin_activity.get_activity_cache) is exactly what Task 1's action
    item 3 added so tests never touch settings.DATABASE_URL / the developer's
    dev DB, and each test controls its own cache instance and TTL.
    """

    async def _dep() -> StatsCache:
        return cache

    app.dependency_overrides[admin_activity.get_activity_cache] = _dep
    try:
        yield
    finally:
        app.dependency_overrides.pop(admin_activity.get_activity_cache, None)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stats_requires_authentication(test_engine):  # noqa: ARG001
    """Anonymous GET /api/admin/activity/stats -> 401."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/admin/activity/stats")

    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_stats_requires_superuser(test_engine):
    """Authenticated non-superuser caller -> 403."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        _, regular_token = await register_and_login(client, unique_email("regular"))

        resp = await client.get(
            "/api/admin/activity/stats",
            headers={"Authorization": f"Bearer {regular_token}"},
        )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_stats_superuser_gets_full_payload(test_engine):
    """Superuser -> 200, body has every key of queries.Payload."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        _, admin_token = await make_superuser(client, test_engine)
        await touch_user_activity(client, admin_token)

        cache = StatsCache(test_engine, ttl_seconds=300)
        async with cache_override(cache):
            resp = await client.get(
                "/api/admin/activity/stats",
                headers={"Authorization": f"Bearer {admin_token}"},
            )

    assert resp.status_code == 200, f"{resp.status_code} {resp.text}"
    assert resp.headers.get("cache-control") == "no-store"
    body = resp.json()
    expected_keys = set(queries.Payload.__annotations__)
    assert expected_keys <= set(body.keys()), f"missing keys: {expected_keys - set(body.keys())}"


@pytest.mark.asyncio
async def test_stats_rejects_impersonation_token(test_engine):
    """An impersonation token minted for a non-superuser target -> 403 (D-04 re-enforced)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        _, admin_token = await make_superuser(client, test_engine)
        target_id, _ = await register_and_login(client, unique_email("target"))

        impersonate_resp = await client.post(
            f"/api/admin/impersonate/{target_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert impersonate_resp.status_code == 200, (
            f"{impersonate_resp.status_code} {impersonate_resp.text}"
        )
        impersonation_token = impersonate_resp.json()["access_token"]

        resp = await client.get(
            "/api/admin/activity/stats",
            headers={"Authorization": f"Bearer {impersonation_token}"},
        )

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_stats_cached_for_ttl_then_refresh_forces_rebuild(test_engine, monkeypatch):
    """Two successive GETs inside the TTL build the payload once; ?refresh=1 rebuilds (D-5)."""
    build_calls = 0
    fake_payload = queries.Payload(
        generated_at="2026-01-01T00:00:00+00:00",
        launch_date="2026-07-23",
        promoted_since="2026-08-23",
        poll_interval_seconds=60,
        days=["2026-01-01"],
        last_complete_index=0,
        activity=[],
        signups=[],
        bot=[],
        train=[],
        solves=[],
        imports=[],
        persona=[],
        bot_players=0,
        elo=[],
        funnel=[],
        tti=[],
        stick=[],
        conversion={},
        conversion_compare=[],
    )

    async def fake_build_payload(_engine):
        nonlocal build_calls
        build_calls += 1
        return fake_payload

    # StatsCache.get() calls the module-level `build_payload` name inside
    # dashboard/stats.py, so patching that module attribute (not the imported
    # binding here) is what actually intercepts the call.
    monkeypatch.setattr("dashboard.stats.build_payload", fake_build_payload)

    cache = StatsCache(test_engine, ttl_seconds=300)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        _, admin_token = await make_superuser(client, test_engine)

        async with cache_override(cache):
            resp1 = await client.get(
                "/api/admin/activity/stats", headers={"Authorization": f"Bearer {admin_token}"}
            )
            resp2 = await client.get(
                "/api/admin/activity/stats", headers={"Authorization": f"Bearer {admin_token}"}
            )
            assert resp1.status_code == 200, f"{resp1.status_code} {resp1.text}"
            assert resp2.status_code == 200, f"{resp2.status_code} {resp2.text}"
            assert build_calls == 1, "two successive GETs inside the TTL must build only once"

            resp3 = await client.get(
                "/api/admin/activity/stats",
                params={"refresh": "1"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            assert resp3.status_code == 200, f"{resp3.status_code} {resp3.text}"
            assert build_calls == 2, "?refresh=1 must bypass the cache and rebuild"


@pytest.mark.asyncio
async def test_readonly_engine_refuses_writes(test_engine):
    """build_readonly_engine's connect_args enforce a genuinely read-only session (D-4).

    End-to-end variant (plan-sanctioned alternative to introspecting
    connect_args directly): open a connection through the SAME factory the
    endpoint uses, against the test database, and prove Postgres itself
    refuses a write — default_transaction_read_only is a server setting, so
    even a CREATE TEMP TABLE (which still writes to system catalogs) fails.
    """
    url = test_engine.url.render_as_string(hide_password=False)
    engine = build_readonly_engine(url, "flawchess-test-readonly")
    try:
        async with engine.connect() as conn:
            with pytest.raises(DBAPIError):
                await conn.execute(
                    text("CREATE TEMP TABLE t_admin_activity_readonly_probe (id int)")
                )
    finally:
        await engine.dispose()
