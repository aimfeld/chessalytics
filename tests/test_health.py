"""Tests for GET /api/health.

Covers all three paths (F-12 / SEED-161 group 5):
- Happy path: DB reachable -> 200 {"status": "ok"}
- Probe raises: the connection's execute() raises -> 503 {"status": "degraded"}
- Timeout: the probe exceeds _HEALTH_DB_TIMEOUT_S -> 503 {"status": "degraded"}

The handler takes the engine through the `get_engine` dependency and opens its own
short-lived connection inside the timeout. It deliberately does NOT use the
request-scoped `get_async_session`: that dependency commits after its `yield`, outside
the handler's try/except, so a cancelled query would be followed by an unbounded
commit() on a cancelled asyncpg connection and surface as a 500 or a hang instead of
the intended 503 (Phase 216 code review, BLOCKER). The session-scoped autouse
fixture in conftest.py overrides `get_engine` with the per-run test engine, so the
happy path runs the whole slice (HTTP -> FastAPI dependency -> fresh Postgres
connection) for real. The failure-path tests swap in a stub engine and must RESTORE
that session-level override afterwards rather than pop it, or every later test that
touches /api/health would fall through to the app's real engine.
"""

import asyncio
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest

import app.main as main_module
from app.core.database import get_engine
from app.main import app


@pytest.fixture
def stub_engine_factory() -> Iterator[Any]:
    """Install a stub engine for one test, then restore the session-level override."""
    previous = app.dependency_overrides.get(get_engine)

    def _install(execute: Any) -> None:
        app.dependency_overrides[get_engine] = lambda: _StubEngine(execute)

    try:
        yield _install
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_engine, None)
        else:
            app.dependency_overrides[get_engine] = previous


class _StubConnection:
    """Minimal stand-in for an AsyncConnection whose execute() is scripted."""

    def __init__(self, execute: Any) -> None:
        self._execute = execute

    async def execute(self, *args: object, **kwargs: object) -> None:
        await self._execute()


class _StubEngine:
    """Minimal stand-in for an AsyncEngine: connect() yields a scripted connection."""

    def __init__(self, execute: Any) -> None:
        self._execute = execute

    @asynccontextmanager
    async def connect(self) -> AsyncGenerator[_StubConnection, None]:
        yield _StubConnection(self._execute)


async def _get(client_app: Any) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=client_app), base_url="http://test"
    ) as client:
        return await client.get("/api/health")


async def test_health_check_returns_ok_when_db_reachable() -> None:
    resp = await _get(app)

    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


async def test_health_check_returns_degraded_when_probe_raises(stub_engine_factory: Any) -> None:
    """A connection whose query raises must yield a fixed, detail-free 503 body.

    The failure originates inside the probe (connect + execute), which is what the
    handler actually wraps; a raise there must not escape as an unhandled 500.
    """

    async def _raise() -> None:
        raise RuntimeError("simulated DB connection failure")

    stub_engine_factory(_raise)
    resp = await _get(app)

    assert resp.status_code == 503
    assert resp.json() == {"status": "degraded"}


async def test_health_check_returns_degraded_on_timeout(
    monkeypatch: pytest.MonkeyPatch, stub_engine_factory: Any
) -> None:
    """A probe slower than _HEALTH_DB_TIMEOUT_S must yield 503, proven fast via monkeypatch.

    With the old request-scoped session this path was followed by the dependency's
    post-yield commit() on the cancelled connection; with a bare connection there is
    no post-yield step, so the 503 is the final answer.
    """
    monkeypatch.setattr(main_module, "_HEALTH_DB_TIMEOUT_S", 0.05)

    async def _hang() -> None:
        await asyncio.sleep(0.5)

    stub_engine_factory(_hang)
    resp = await _get(app)

    assert resp.status_code == 503
    assert resp.json() == {"status": "degraded"}
