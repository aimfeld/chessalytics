"""End-to-end router tests for POST /api/insights/endgame (Phase 65).

Tests the HTTP layer using httpx AsyncClient with ASGITransport. All LLM calls
are mocked via the fake_insights_agent fixture (TestModel) or monkeypatched
FunctionModel. No real provider calls are made (D-42).

URL: POST /api/insights/endgame
     (insights_router prefix="/insights" + @router.post("/endgame"), mounted under /api)
"""

import datetime
import uuid
from decimal import Decimal
from typing import Any

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.main import app
from app.models.llm_log import LlmLog
from app.models.user import User
from app.schemas.insights import (
    EndgameInsightsReport,
    EndgameTabFindings,
    FilterContext,
    SectionInsight,
)
from app.services import insights_llm


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

INSIGHTS_ENDPOINT = "/api/insights/endgame"


def _sample_report(overview: str = "FlawChess played solidly overall.") -> EndgameInsightsReport:
    return EndgameInsightsReport(
        player_profile="Player around 1500 rapid, range 1200-1600 over 2 years.",
        overview=overview,
        recommendations=["Try drilling pawn endings.", "Review losses on time."],
        sections=[
            SectionInsight(
                section_id="overall",
                headline="Score Gap typical",
                bullets=["+4.2pp last 3mo"],
            )
        ],
        model_used="test",
        prompt_version="endgame_v16",
    )


async def _fake_compute_findings(
    filter_context: FilterContext,
    session: AsyncSession,
    user_id: int,
    findings_hash: str = "b" * 64,
) -> EndgameTabFindings:
    """Stub for compute_findings — returns minimal valid findings without hitting the DB."""
    return EndgameTabFindings(
        as_of=datetime.datetime.now(datetime.UTC),
        filters=filter_context,
        findings=[],
        findings_hash=findings_hash,
    )


def _make_row(
    user_id: int,
    *,
    created_at: datetime.datetime | None = None,
    error: str | None = None,
    response_json: dict[str, Any] | None = None,
    cache_hit: bool = False,
    prompt_version: str = "endgame_v1",
    model: str = "test",
    findings_hash: str = "a" * 64,
    opponent_strength: str = "any",
) -> LlmLog:
    """Build a minimal-valid LlmLog row for seeding rate-limit tests."""
    kwargs: dict[str, Any] = dict(
        user_id=user_id,
        endpoint="insights.endgame",
        model=model,
        prompt_version=prompt_version,
        findings_hash=findings_hash,
        filter_context={"opponent_strength": opponent_strength},
        user_prompt="user",
        response_json=response_json,
        input_tokens=100,
        output_tokens=50,
        latency_ms=500,
        cache_hit=cache_hit,
        error=error,
        cost_usd=Decimal("0"),
    )
    if created_at is not None:
        kwargs["created_at"] = created_at
    return LlmLog(**kwargs)


async def _seed(session: AsyncSession, *rows: LlmLog) -> None:
    for row in rows:
        session.add(row)
    await session.commit()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def auth_headers(test_engine: AsyncEngine) -> dict[str, str]:
    """Register a fresh user and return auth headers for the test."""
    email = f"insights_router_test_{uuid.uuid4().hex[:8]}@example.com"
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


@pytest_asyncio.fixture
async def authed_user_with_session(
    test_engine: AsyncEngine,
) -> tuple[dict[str, str], User]:
    """Register a user, return (auth_headers, User ORM object) for seeding rows."""
    email = f"insights_ratelimit_{uuid.uuid4().hex[:8]}@example.com"
    password = "testpassword123"
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        await client.post("/api/auth/register", json={"email": email, "password": password})
        login_resp = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        token = login_resp.json()["access_token"]

    # Fetch the user from the DB so we can seed rows against their real ID.
    async with session_maker() as session:
        result = await session.execute(
            select(User).where(User.email == email)  # ty: ignore[invalid-argument-type]
        )
        user = result.unique().scalar_one()

    headers = {"Authorization": f"Bearer {token}"}
    return headers, user


# ---------------------------------------------------------------------------
# TestAuth
# ---------------------------------------------------------------------------


class TestAuth:
    @pytest.mark.asyncio
    async def test_unauthenticated_returns_401(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT)
        assert response.status_code == 401


# ---------------------------------------------------------------------------
# TestHappyPath
# ---------------------------------------------------------------------------


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_fresh_miss_returns_200(
        self,
        auth_headers: dict[str, str],
        fake_insights_agent: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Fresh cache miss with TestModel returns 200 with status='fresh'."""
        fake_insights_agent(_sample_report())
        monkeypatch.setattr("app.services.insights_llm.compute_findings", _fake_compute_findings)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT, headers=auth_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "fresh"
        assert body["report"]["overview"] == "FlawChess played solidly overall."
        assert body["report"]["sections"][0]["section_id"] == "overall"

    @pytest.mark.asyncio
    async def test_cache_hit_returns_200(
        self,
        authed_user_with_session: tuple[dict[str, str], User],
        fake_insights_agent: Any,
        monkeypatch: pytest.MonkeyPatch,
        test_engine: AsyncEngine,
    ) -> None:
        """Pre-seeded cache row with matching findings_hash returns status='cache_hit'.

        create_llm_log appends '; cost_unknown:test' to the error column for the
        'test' provider, so get_latest_log_by_hash (which filters error IS NULL) cannot
        find the fresh-miss row written by the first HTTP call. We therefore seed a
        pre-existing row with error=None directly — same pattern used in Plan 05 tests
        (deviation #3 documented in 65-05-SUMMARY.md).
        """
        headers, user = authed_user_with_session
        fake_insights_agent(_sample_report())

        # Stub compute_findings with a known hash so our seeded row matches
        async def _compute_with_known_hash(
            fc: FilterContext, session: AsyncSession, uid: int
        ) -> EndgameTabFindings:
            return EndgameTabFindings(
                as_of=datetime.datetime.now(datetime.UTC),
                filters=fc,
                findings=[],
                findings_hash="m" * 64,
            )

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _compute_with_known_hash)

        # Seed a row that get_latest_log_by_hash will find (error=None, matching hash)
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        valid_report = _sample_report()
        async with session_maker() as session:
            await _seed(
                session,
                _make_row(
                    user.id,
                    response_json=valid_report.model_dump(),
                    findings_hash="m" * 64,
                    error=None,
                    model="test",
                    prompt_version=insights_llm._PROMPT_VERSION,
                ),
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT, headers=headers)

        assert response.status_code == 200
        assert response.json()["status"] == "cache_hit"


# ---------------------------------------------------------------------------
# TestErrors
# ---------------------------------------------------------------------------


class TestErrors:
    @pytest.mark.asyncio
    async def test_provider_error_returns_502(
        self,
        auth_headers: dict[str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When _run_agent returns a provider_error marker, router returns 502."""
        from pydantic_ai import Agent
        from pydantic_ai.exceptions import ModelHTTPError
        from pydantic_ai.models.function import FunctionModel
        from app.schemas.insights import EndgameInsightsReport

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _fake_compute_findings)

        async def _failing_model(messages: Any, info: Any) -> Any:
            raise ModelHTTPError(
                status_code=500, model_name="test", body="simulated provider error"
            )

        monkeypatch.setattr(
            "app.services.insights_llm.get_insights_agent",
            lambda: Agent(FunctionModel(_failing_model), output_type=EndgameInsightsReport),
        )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT, headers=auth_headers)

        assert response.status_code == 502
        body = response.json()
        assert body["error"] == "provider_error"
        assert "retry_after_seconds" not in body

    @pytest.mark.asyncio
    async def test_validation_failure_returns_502(
        self,
        auth_headers: dict[str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When structured-output validation fails after retries, router returns 502."""
        from pydantic_ai import Agent
        from pydantic_ai.exceptions import UnexpectedModelBehavior
        from pydantic_ai.models.function import FunctionModel
        from app.schemas.insights import EndgameInsightsReport

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _fake_compute_findings)

        async def _validation_fail_model(messages: Any, info: Any) -> Any:
            raise UnexpectedModelBehavior("forced validation failure")

        monkeypatch.setattr(
            "app.services.insights_llm.get_insights_agent",
            lambda: Agent(FunctionModel(_validation_fail_model), output_type=EndgameInsightsReport),
        )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT, headers=auth_headers)

        assert response.status_code == 502
        body = response.json()
        assert body["error"] == "validation_failure"
        assert "retry_after_seconds" not in body


# ---------------------------------------------------------------------------
# TestHideOverview
# ---------------------------------------------------------------------------


class TestHideOverview:
    @pytest.mark.asyncio
    async def test_hide_overview_strips_overview(
        self,
        auth_headers: dict[str, str],
        fake_insights_agent: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """When INSIGHTS_HIDE_OVERVIEW=True, overview is empty string in response."""
        fake_insights_agent(_sample_report())
        monkeypatch.setattr("app.services.insights_llm.compute_findings", _fake_compute_findings)

        from app.services import insights_llm

        monkeypatch.setattr(insights_llm.settings, "INSIGHTS_HIDE_OVERVIEW", True)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT, headers=auth_headers)

        assert response.status_code == 200
        body = response.json()
        assert body["report"]["overview"] == ""


# ---------------------------------------------------------------------------
# TestFilterPassing
# ---------------------------------------------------------------------------


class TestFilterPassing:
    @pytest.mark.asyncio
    async def test_query_params_flow_through(
        self,
        authed_user_with_session: tuple[dict[str, str], User],
        fake_insights_agent: Any,
        monkeypatch: pytest.MonkeyPatch,
        test_engine: AsyncEngine,
    ) -> None:
        """opponent_gap_min/max → derived preset on FilterContext (v8: the only
        non-default filter the router accepts)."""
        headers, user = authed_user_with_session
        fake_insights_agent(_sample_report())

        captured_filter: dict[str, Any] = {}

        async def _capture_compute_findings(
            fc: FilterContext, session: AsyncSession, uid: int
        ) -> EndgameTabFindings:
            captured_filter.update(fc.model_dump())
            return EndgameTabFindings(
                as_of=datetime.datetime.now(datetime.UTC),
                filters=fc,
                findings=[],
                findings_hash="z" * 64,
            )

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _capture_compute_findings)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                INSIGHTS_ENDPOINT,
                params={"opponent_gap_min": 50},
                headers=headers,
            )

        assert response.status_code == 200
        assert captured_filter["opponent_strength"] == "stronger"
        assert captured_filter["time_controls"] == []
        assert captured_filter["platforms"] == []

    @pytest.mark.asyncio
    async def test_rejects_non_default_filters(
        self,
        authed_user_with_session: tuple[dict[str, str], User],
        test_engine: AsyncEngine,
    ) -> None:
        """v8: router returns 400 when any filter other than opponent_strength
        is non-default. Frontend already gates the button; the server check is
        the defensive safety net.

        Each case asserts its own `blocking` reason, not just the error code:
        FLAWCHESS-AG was a wrong *default* (rated), so a test that only checked
        for `filters_not_supported` would have stayed green while every request
        was rejected for the wrong reason.
        """
        headers, _user = authed_user_with_session

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            cases = [
                ({"time_control": "blitz"}, "Remove Time control filter"),
                ({"platform": "chess.com"}, "Remove Platform filter"),
                ({"from_date": "2026-01-01"}, "Clear Custom date range filter"),
                # rated-only is the DEFAULT population (SEED-163 2a), so it is
                # the casual/all selection that truncates the dataset.
                ({"rated": "false"}, "Set the Rated filter to Rated"),
            ]
            for params, blocking in cases:
                response = await client.post(INSIGHTS_ENDPOINT, params=params, headers=headers)
                assert response.status_code == 400, f"expected 400 for params={params}"
                body = response.json()
                assert body["detail"]["error"] == "filters_not_supported"
                assert blocking in body["detail"]["blocking"], (
                    f"expected {blocking!r} in blocking for params={params}"
                )

    @pytest.mark.parametrize("params", [{"rated": "true"}, {}], ids=["explicit", "omitted"])
    @pytest.mark.asyncio
    async def test_default_filters_are_accepted(
        self,
        params: dict[str, str],
        authed_user_with_session: tuple[dict[str, str], User],
        fake_insights_agent: Any,
        monkeypatch: pytest.MonkeyPatch,
        test_engine: AsyncEngine,
    ) -> None:
        """FLAWCHESS-AG regression: the frontend's DEFAULT_FILTERS must pass.

        `DEFAULT_FILTERS.rated` flipped null -> true (SEED-163 2a) while the
        router still rejected `rated=true`, so the Generate Insights button —
        gated on those same defaults, and therefore left enabled — 400'd for
        every user on a filter they had never touched. Both the explicit
        `rated=true` the frontend sends and an omitted `rated` must be accepted
        AND must reach compute_findings as rated-only, since the LLM cache key
        carries no filter and so cannot distinguish two populations.
        """
        headers, _user = authed_user_with_session
        fake_insights_agent(_sample_report())

        captured_filter: dict[str, Any] = {}

        async def _capture_compute_findings(
            fc: FilterContext, session: AsyncSession, uid: int
        ) -> EndgameTabFindings:
            captured_filter.update(fc.model_dump())
            return EndgameTabFindings(
                as_of=datetime.datetime.now(datetime.UTC),
                filters=fc,
                findings=[],
                findings_hash="z" * 64,
            )

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _capture_compute_findings)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(INSIGHTS_ENDPOINT, params=params, headers=headers)

        assert response.status_code == 200, f"expected 200 for params={params}: {response.text}"
        assert captured_filter["rated_only"] is True


# ---------------------------------------------------------------------------
# TestCachedEndpoint — GET /api/insights/endgame/cached (260508-q1z)
# ---------------------------------------------------------------------------


CACHED_ENDPOINT = "/api/insights/endgame/cached"


class TestCachedEndpoint:
    @pytest.mark.asyncio
    async def test_unauthenticated_returns_401(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(CACHED_ENDPOINT)
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_cache_hit_returns_200(
        self,
        authed_user_with_session: tuple[dict[str, str], User],
        monkeypatch: pytest.MonkeyPatch,
        test_engine: AsyncEngine,
    ) -> None:
        """Fresh cache row → 200 with status='cache_hit'. LLM never invoked."""
        headers, user = authed_user_with_session

        # Spy on compute_findings + LLM agent — they must NOT be called.
        compute_calls = {"n": 0}

        async def _spy_compute(
            fc: FilterContext, session: AsyncSession, uid: int
        ) -> EndgameTabFindings:
            compute_calls["n"] += 1
            return EndgameTabFindings(
                as_of=datetime.datetime.now(datetime.UTC),
                filters=fc,
                findings=[],
                findings_hash="x" * 64,
            )

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _spy_compute)

        # Seed a fresh cache row matching default opponent_strength="any".
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        valid_report = _sample_report()
        async with session_maker() as session:
            await _seed(
                session,
                _make_row(
                    user.id,
                    response_json=valid_report.model_dump(),
                    error=None,
                    model=insights_llm.settings.PYDANTIC_AI_MODEL_INSIGHTS,
                    prompt_version=insights_llm._PROMPT_VERSION,
                    opponent_strength="any",
                ),
            )

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(CACHED_ENDPOINT, headers=headers)

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "cache_hit"
        assert body["report"]["overview"] == "FlawChess played solidly overall."
        # Cache-only path must never run compute_findings or invoke the LLM.
        assert compute_calls["n"] == 0

    @pytest.mark.asyncio
    async def test_cache_miss_returns_404(
        self,
        auth_headers: dict[str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """No cache row → 404. compute_findings not called."""
        compute_calls = {"n": 0}

        async def _spy_compute(
            fc: FilterContext, session: AsyncSession, uid: int
        ) -> EndgameTabFindings:
            compute_calls["n"] += 1
            return EndgameTabFindings(
                as_of=datetime.datetime.now(datetime.UTC),
                filters=fc,
                findings=[],
                findings_hash="x" * 64,
            )

        monkeypatch.setattr("app.services.insights_llm.compute_findings", _spy_compute)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(CACHED_ENDPOINT, headers=auth_headers)

        assert response.status_code == 404
        assert compute_calls["n"] == 0

    @pytest.mark.asyncio
    async def test_non_default_filter_returns_404_silently(
        self,
        auth_headers: dict[str, str],
    ) -> None:
        """Non-default filters do NOT 400 here — they 404 because the cache
        is keyed only on opponent_strength, so other filters cannot match a row."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                CACHED_ENDPOINT,
                params={"time_control": "blitz", "from_date": "2026-01-01"},
                headers=auth_headers,
            )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_custom_opponent_gap_returns_404(
        self,
        auth_headers: dict[str, str],
    ) -> None:
        """Custom (non-preset) opponent gap → 404 (cache miss), not 400."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(
                CACHED_ENDPOINT,
                params={"opponent_gap_min": 13, "opponent_gap_max": 27},
                headers=auth_headers,
            )
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_invalidated_by_recent_import(
        self,
        authed_user_with_session: tuple[dict[str, str], User],
        test_engine: AsyncEngine,
    ) -> None:
        """Cache row is invalidated when an import with games > 0 lands after
        the row was written. Endpoint returns 404 in that case."""
        from app.models.import_job import ImportJob

        headers, user = authed_user_with_session
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        valid_report = _sample_report()

        cache_written_at = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=2)
        import_completed_at = datetime.datetime.now(datetime.UTC) - datetime.timedelta(hours=1)

        async with session_maker() as session:
            await _seed(
                session,
                _make_row(
                    user.id,
                    created_at=cache_written_at,
                    response_json=valid_report.model_dump(),
                    error=None,
                    model=insights_llm.settings.PYDANTIC_AI_MODEL_INSIGHTS,
                    prompt_version=insights_llm._PROMPT_VERSION,
                    opponent_strength="any",
                ),
            )
            session.add(
                ImportJob(
                    id=str(uuid.uuid4()),
                    user_id=user.id,
                    platform="lichess",
                    username="someone",
                    status="completed",
                    games_imported=5,
                    completed_at=import_completed_at,
                )
            )
            await session.commit()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get(CACHED_ENDPOINT, headers=headers)

        assert response.status_code == 404
