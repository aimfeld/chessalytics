"""Integration tests for the self-serve password reset flow (Phase 207).

Tests cover: end-to-end forgot -> reset -> login (Task 1 tracer), rate
limiting / non-blocking dispatch / Sentry contract (Task 2), and eligibility
by credential state (Task 3).

Follows tests/test_auth.py's conventions: no rollback fixture, unique emails
via uuid4, ASGITransport client.
"""

import asyncio
import time as time_module
import urllib.parse
import uuid

import httpx
import pytest
from fastapi_users.password import PasswordHelper
from sqlalchemy import select
from sqlalchemy import update as sa_update

from app.core.reset_password_rate_limiter import _RESET_PASSWORD_MAX_REQUESTS
from app.main import app
from app.models.oauth_account import OAuthAccount
from app.models.user import User
from app.services import email_service

_password_helper = PasswordHelper()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def unique_email(prefix: str = "test") -> str:
    """Generate a unique email address for each test invocation."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def register_user(client: httpx.AsyncClient, email: str, password: str) -> httpx.Response:
    return await client.post(
        "/api/auth/register",
        json={"email": email, "password": password},
    )


async def login_user(client: httpx.AsyncClient, email: str, password: str) -> httpx.Response:
    return await client.post(
        "/api/auth/jwt/login",
        data={"username": email, "password": password},
    )


async def forgot_password(client: httpx.AsyncClient, email: str) -> httpx.Response:
    return await client.post("/api/auth/forgot-password", json={"email": email})


async def reset_password(client: httpx.AsyncClient, token: str, password: str) -> httpx.Response:
    return await client.post(
        "/api/auth/reset-password", json={"token": token, "password": password}
    )


def _counting_fake_send(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Monkeypatch email_service.send_password_reset_email with a call recorder."""
    calls: list[str] = []

    async def _fake_send(
        client: httpx.AsyncClient, *, to: str, reset_url: str, user_id: int
    ) -> bool:
        calls.append(to)
        return True

    monkeypatch.setattr(email_service, "send_password_reset_email", _fake_send)
    return calls


async def _create_direct_user(email: str, *, password: str | None, with_oauth: bool) -> User:
    """Build a user row directly against the DB, mirroring guest_service.py's field
    sets, for the three eligibility fixtures (Task 3):

    - dual: password set + one oauth_account row
    - pure: password set + no oauth_account row
    - google_only: hashed_password="" + one oauth_account row

    `password=None` mirrors guest_service.py:156's "Google users have no
    password" — stores hashed_password="" directly, never hashed.
    """
    from app.core.database import async_session_maker

    hashed_password = "" if password is None else _password_helper.hash(password)
    async with async_session_maker() as session:
        user = User(
            email=email,
            hashed_password=hashed_password,
            is_active=True,
            is_verified=True,
            is_superuser=False,
            is_guest=False,
        )
        session.add(user)
        await session.flush()
        if with_oauth:
            oauth_account = OAuthAccount(
                oauth_name="google",
                access_token="fake-access-token",
                expires_at=None,
                refresh_token=None,
                account_id=f"google-{uuid.uuid4().hex}",
                account_email=email,
                user_id=user.id,
            )
            session.add(oauth_account)
        await session.commit()
        await session.refresh(user)
        return user


async def _oauth_account_exists(user_id: int) -> bool:
    from app.core.database import async_session_maker

    async with async_session_maker() as session:
        result = await session.execute(select(OAuthAccount).where(OAuthAccount.user_id == user_id))
        return result.scalars().first() is not None


async def _get_hashed_password(email: str) -> str:
    from app.core.database import async_session_maker

    async with async_session_maker() as session:
        result = await session.execute(
            select(User).where(User.email == email)  # ty: ignore[invalid-argument-type]  # SQLAlchemy column comparisons return ColumnElement, not bool
        )
        user = result.unique().scalar_one()
        return user.hashed_password


async def _set_user_active(email: str, *, active: bool) -> None:
    from app.core.database import async_session_maker

    async with async_session_maker() as session:
        await session.execute(
            sa_update(User)
            .where(User.email == email)  # ty: ignore[invalid-argument-type]  # SQLAlchemy column comparisons return ColumnElement, not bool
            .values(is_active=active)
        )
        await session.commit()


# ---------------------------------------------------------------------------
# Task 1: end-to-end tracer
# ---------------------------------------------------------------------------


class TestPasswordResetFlow:
    @pytest.mark.asyncio
    async def test_forgot_reset_login_end_to_end(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Register -> forgot-password -> capture token from reset_url -> reset -> login."""
        recorded: dict[str, object] = {}

        async def _fake_send(
            client: httpx.AsyncClient, *, to: str, reset_url: str, user_id: int
        ) -> bool:
            recorded["to"] = to
            recorded["reset_url"] = reset_url
            recorded["user_id"] = user_id
            return True

        monkeypatch.setattr(email_service, "send_password_reset_email", _fake_send)

        email = unique_email("resetflow")
        old_password = "old-password-123"
        new_password = "new-password-456"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            reg_resp = await register_user(client, email, old_password)
            assert reg_resp.status_code == 201

            forgot_resp = await forgot_password(client, email)
            assert forgot_resp.status_code == 202
            # The router handler returns None with no response_model, which
            # FastAPI's default JSONResponse serializes as the literal `null`
            # (4 bytes), not a truly empty body. Both cases return this same
            # body — the tuple (202, b"null") is what RESET-02 indistinguishability
            # is captured against (see TestForgotPasswordIndistinguishability).
            assert forgot_resp.content == b"null"

            # The send is dispatched as a detached task (T-207-02, non-blocking
            # dispatch) — drain it before reading `recorded`.
            await email_service.drain_pending_sends()

            assert "reset_url" in recorded
            reset_url = str(recorded["reset_url"])

            from app.core.config import settings

            expected_prefix = f"{settings.FRONTEND_URL}/auth/reset-password?token="
            assert reset_url.startswith(expected_prefix)

            parsed = urllib.parse.urlparse(reset_url)
            token = urllib.parse.parse_qs(parsed.query)["token"][0]

            reset_resp = await reset_password(client, token, new_password)
            assert reset_resp.status_code == 200

            # New password logs in.
            login_resp = await login_user(client, email, new_password)
            assert login_resp.status_code == 200
            assert "access_token" in login_resp.json()

            # Old password no longer works.
            old_login_resp = await login_user(client, email, old_password)
            assert old_login_resp.status_code == 400


# ---------------------------------------------------------------------------
# Task 2: rate limit, non-blocking dispatch, Sentry contract
# ---------------------------------------------------------------------------


class TestForgotPasswordRateLimit:
    @pytest.mark.asyncio
    async def test_boundary_nth_dispatches_n_plus_1th_does_not(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 7: N sequential forgot-password calls dispatch N sends; the N+1th dispatches none."""
        calls = _counting_fake_send(monkeypatch)
        email = unique_email("boundary")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")

            for _ in range(_RESET_PASSWORD_MAX_REQUESTS + 1):
                resp = await forgot_password(client, email)
                assert resp.status_code == 202

            await email_service.drain_pending_sends()

        assert len(calls) == _RESET_PASSWORD_MAX_REQUESTS

    @pytest.mark.asyncio
    async def test_precision_window_eviction_is_half_open(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 8: once the window has fully elapsed, a blocked address dispatches again.

        Monkeypatches time.monotonic (never a real sleep) so a previously-blocked
        address can dispatch again after the sliding window fully elapses.
        """
        from app.core import ip_rate_limiter

        clock = {"t": time_module.monotonic()}

        def fake_monotonic() -> float:
            return clock["t"]

        monkeypatch.setattr(ip_rate_limiter.time, "monotonic", fake_monotonic)

        calls = _counting_fake_send(monkeypatch)
        email = unique_email("precision")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")

            for _ in range(_RESET_PASSWORD_MAX_REQUESTS):
                resp = await forgot_password(client, email)
                assert resp.status_code == 202
            await email_service.drain_pending_sends()
            assert len(calls) == _RESET_PASSWORD_MAX_REQUESTS

            # Still within the window — no additional dispatch.
            resp = await forgot_password(client, email)
            assert resp.status_code == 202
            await email_service.drain_pending_sends()
            assert len(calls) == _RESET_PASSWORD_MAX_REQUESTS

            # Advance the fake clock past the window.
            from app.core.reset_password_rate_limiter import _RESET_PASSWORD_WINDOW_SECONDS

            clock["t"] += _RESET_PASSWORD_WINDOW_SECONDS + 1

            resp = await forgot_password(client, email)
            assert resp.status_code == 202
            await email_service.drain_pending_sends()
            assert len(calls) == _RESET_PASSWORD_MAX_REQUESTS + 1

    @pytest.mark.asyncio
    async def test_concurrency_caps_dispatch_at_max(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 9: N+3 concurrent requests for one address dispatch at most N sends."""
        calls = _counting_fake_send(monkeypatch)
        email = unique_email("concurrent")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")

            responses = await asyncio.gather(
                *[forgot_password(client, email) for _ in range(_RESET_PASSWORD_MAX_REQUESTS + 3)]
            )
            await email_service.drain_pending_sends()

        assert all(r.status_code == 202 for r in responses)
        assert len(calls) <= _RESET_PASSWORD_MAX_REQUESTS

    @pytest.mark.asyncio
    async def test_case_equality_shares_one_bucket(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 10: case variants of one address share a single limiter bucket."""
        calls = _counting_fake_send(monkeypatch)
        base_email = unique_email("caseeq")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, base_email, "password123")

            variants = [
                base_email,
                base_email.upper(),
                base_email.swapcase(),
            ] * (_RESET_PASSWORD_MAX_REQUESTS)  # far more attempts than the cap

            for variant in variants:
                resp = await forgot_password(client, variant)
                assert resp.status_code == 202
            await email_service.drain_pending_sends()

        assert len(calls) == _RESET_PASSWORD_MAX_REQUESTS


class TestForgotPasswordIndistinguishability:
    @pytest.mark.asyncio
    async def test_registered_unregistered_inactive_ratelimited_identical(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 11: registered / unregistered / inactive / rate-limited all return an
        identical (status, body) tuple."""
        _counting_fake_send(monkeypatch)

        registered_email = unique_email("indist-reg")
        unregistered_email = unique_email("indist-none")
        inactive_email = unique_email("indist-inactive")
        limited_email = unique_email("indist-limited")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, registered_email, "password123")
            await register_user(client, inactive_email, "password123")
            await register_user(client, limited_email, "password123")

            await _set_user_active(inactive_email, active=False)

            # Exhaust the limiter for `limited_email`.
            for _ in range(_RESET_PASSWORD_MAX_REQUESTS):
                await forgot_password(client, limited_email)
            await email_service.drain_pending_sends()

            registered_resp = await forgot_password(client, registered_email)
            unregistered_resp = await forgot_password(client, unregistered_email)
            inactive_resp = await forgot_password(client, inactive_email)
            limited_resp = await forgot_password(client, limited_email)
            await email_service.drain_pending_sends()

        registered_tuple = (registered_resp.status_code, registered_resp.content)
        for resp in (unregistered_resp, inactive_resp, limited_resp):
            assert (resp.status_code, resp.content) == registered_tuple


class TestNonBlockingDispatch:
    @pytest.mark.asyncio
    async def test_202_returned_before_send_completes(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 12: POST /forgot-password returns 202 while the send is still pending.

        Reverting spawn_password_reset_email to an awaited send makes this test
        time out and fail.
        """
        release_event = asyncio.Event()

        async def _blocking_send(
            client: httpx.AsyncClient, *, to: str, reset_url: str, user_id: int
        ) -> bool:
            await release_event.wait()
            return True

        monkeypatch.setattr(email_service, "send_password_reset_email", _blocking_send)

        email = unique_email("nonblocking")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")

            resp = await asyncio.wait_for(forgot_password(client, email), timeout=2.0)
            assert resp.status_code == 202

            release_event.set()
            await email_service.drain_pending_sends()


class TestForgotPasswordEmptyInvalidInput:
    @pytest.mark.asyncio
    async def test_empty_whitespace_missing_email_return_422(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 13: empty-string, whitespace-only, and missing email all return 422 with zero dispatches."""
        calls = _counting_fake_send(monkeypatch)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp_empty = await client.post("/api/auth/forgot-password", json={"email": ""})
            resp_whitespace = await client.post("/api/auth/forgot-password", json={"email": "   "})
            resp_missing = await client.post("/api/auth/forgot-password", json={})
            await email_service.drain_pending_sends()

        assert resp_empty.status_code == 422
        assert resp_whitespace.status_code == 422
        assert resp_missing.status_code == 422
        assert len(calls) == 0

    @pytest.mark.asyncio
    async def test_null_absent_token_or_password_return_422(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp_no_token = await client.post(
                "/api/auth/reset-password", json={"password": "somepassword123"}
            )
            resp_no_password = await client.post(
                "/api/auth/reset-password", json={"token": "sometoken"}
            )
        assert resp_no_token.status_code == 422
        assert resp_no_password.status_code == 422


class TestPasswordResetAdjacency:
    @pytest.mark.asyncio
    async def test_two_tokens_first_use_invalidates_second(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 14: two reset tokens issued for the same user are each individually
        valid; using either one to change the password invalidates the other."""
        recorded_urls: list[str] = []

        async def _fake_send(
            client: httpx.AsyncClient, *, to: str, reset_url: str, user_id: int
        ) -> bool:
            recorded_urls.append(reset_url)
            return True

        monkeypatch.setattr(email_service, "send_password_reset_email", _fake_send)

        email = unique_email("adjacency")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")

            await forgot_password(client, email)
            await email_service.drain_pending_sends()

            # Reset the limiter window isn't the concern here — two requests are
            # both within the default cap — but we need two DISTINCT tokens for
            # the same user, so issue a second forgot-password request.
            await forgot_password(client, email)
            await email_service.drain_pending_sends()

            assert len(recorded_urls) == 2
            token_1 = urllib.parse.parse_qs(urllib.parse.urlparse(recorded_urls[0]).query)["token"][
                0
            ]
            token_2 = urllib.parse.parse_qs(urllib.parse.urlparse(recorded_urls[1]).query)["token"][
                0
            ]
            assert token_1 != token_2

            first_reset_resp = await reset_password(client, token_1, "new-password-1")
            assert first_reset_resp.status_code == 200

            second_reset_resp = await reset_password(client, token_2, "new-password-2")
            assert second_reset_resp.status_code == 400
            assert second_reset_resp.json()["detail"] == "RESET_PASSWORD_BAD_TOKEN"


# ---------------------------------------------------------------------------
# Task 3: eligibility is credential state (RESET-05)
# ---------------------------------------------------------------------------


class TestPasswordResetEligibility:
    @pytest.mark.asyncio
    async def test_dual_password_and_google_completes_flow(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 15 (the 125-account case — the highest-value test in this plan).

        A user with a real stored password AND a linked oauth_account row
        completes forgot -> reset -> login with the new password. The
        oauth_account row must survive untouched — Google sign-in is not
        collaterally detached.
        """
        recorded_urls: list[str] = []

        async def _fake_send(
            client: httpx.AsyncClient, *, to: str, reset_url: str, user_id: int
        ) -> bool:
            recorded_urls.append(reset_url)
            return True

        monkeypatch.setattr(email_service, "send_password_reset_email", _fake_send)

        email = unique_email("dual")
        old_password = "old-dual-password-1"
        new_password = "new-dual-password-2"
        user = await _create_direct_user(email, password=old_password, with_oauth=True)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            forgot_resp = await forgot_password(client, email)
            await email_service.drain_pending_sends()
            assert forgot_resp.status_code == 202
            assert len(recorded_urls) == 1

            token = urllib.parse.parse_qs(urllib.parse.urlparse(recorded_urls[0]).query)["token"][0]
            reset_resp = await reset_password(client, token, new_password)
            assert reset_resp.status_code == 200

            login_resp = await login_user(client, email, new_password)
            assert login_resp.status_code == 200
            assert "access_token" in login_resp.json()

            old_login_resp = await login_user(client, email, old_password)
            assert old_login_resp.status_code == 400

        assert await _oauth_account_exists(user.id) is True

    @pytest.mark.asyncio
    async def test_pure_password_no_google_completes_flow(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 16 (pure password, the other 47): completes identically — the
        control isolating that the oauth_account row changed nothing."""
        recorded_urls: list[str] = []

        async def _fake_send(
            client: httpx.AsyncClient, *, to: str, reset_url: str, user_id: int
        ) -> bool:
            recorded_urls.append(reset_url)
            return True

        monkeypatch.setattr(email_service, "send_password_reset_email", _fake_send)

        email = unique_email("pure")
        old_password = "old-pure-password-1"
        new_password = "new-pure-password-2"
        await _create_direct_user(email, password=old_password, with_oauth=False)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            forgot_resp = await forgot_password(client, email)
            await email_service.drain_pending_sends()
            assert forgot_resp.status_code == 202
            assert len(recorded_urls) == 1

            token = urllib.parse.parse_qs(urllib.parse.urlparse(recorded_urls[0]).query)["token"][0]
            reset_resp = await reset_password(client, token, new_password)
            assert reset_resp.status_code == 200

            login_resp = await login_user(client, email, new_password)
            assert login_resp.status_code == 200
            assert "access_token" in login_resp.json()

    @pytest.mark.asyncio
    async def test_google_only_dispatches_zero_sends_indistinguishable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test 17 (Google-only, 44): a user with an empty stored password and an
        oauth_account row dispatches ZERO sends. Its (status, body) response tuple
        equals a captured eligible response's tuple, not a hard-coded 202.
        """
        calls = _counting_fake_send(monkeypatch)

        eligible_email = unique_email("eligible-control")
        await _create_direct_user(eligible_email, password="control-password-1", with_oauth=False)

        google_only_email = unique_email("google-only")
        await _create_direct_user(google_only_email, password=None, with_oauth=True)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            eligible_resp = await forgot_password(client, eligible_email)
            await email_service.drain_pending_sends()
            eligible_tuple = (eligible_resp.status_code, eligible_resp.content)
            assert len(calls) == 1

            ineligible_resp = await forgot_password(client, google_only_email)
            await email_service.drain_pending_sends()

        assert (ineligible_resp.status_code, ineligible_resp.content) == eligible_tuple
        assert len(calls) == 1  # no additional dispatch for the ineligible request

    @pytest.mark.asyncio
    async def test_google_only_no_side_channel(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 18 (no side channel): after the ineligible request, no Sentry
        capture occurred and the stored password is still empty (no partial
        state mutation)."""
        _counting_fake_send(monkeypatch)

        google_only_email = unique_email("google-only-silent")
        await _create_direct_user(google_only_email, password=None, with_oauth=True)

        from unittest.mock import patch

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            with (
                patch("app.services.email_service.sentry_sdk.capture_exception") as mock_capture,
                patch("app.services.email_service.sentry_sdk.capture_message") as mock_capture_msg,
            ):
                resp = await forgot_password(client, google_only_email)
                await email_service.drain_pending_sends()

        assert resp.status_code == 202
        assert mock_capture.call_count == 0
        assert mock_capture_msg.call_count == 0
        assert await _get_hashed_password(google_only_email) == ""
