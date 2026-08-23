"""Tests for Google SSO guest promotion.

Tests cover:
- Service unit tests for promote_guest_with_google
- Integration tests for GET /auth/google/authorize-promote
- Integration tests for GET /auth/google/callback-promote

NOTE: Service tests write real users to PostgreSQL (no rollback fixture).
"""

import base64
import json
import uuid
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.main import app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def unique_email(prefix: str = "test") -> str:
    """Generate a unique email address for each test invocation."""
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def register_user(client: httpx.AsyncClient, email: str, password: str) -> httpx.Response:
    resp = await client.post(
        "/api/auth/register",
        json={"email": email, "password": password},
    )
    return resp


async def login_user(client: httpx.AsyncClient, email: str, password: str) -> httpx.Response:
    resp = await client.post(
        "/api/auth/jwt/login",
        data={"username": email, "password": password},
    )
    return resp


def make_fake_id_token(sub: str = "google_sub_123", email: str = "user@gmail.com") -> str:
    """Build a minimal fake id_token JWT (header.payload.signature) for mocking."""
    payload = {"sub": sub, "email": email}
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"header.{payload_b64}.signature"


def make_fake_token_response(
    sub: str = "google_sub_123",
    email: str = "user@gmail.com",
) -> dict[str, Any]:
    """Build a fake token response dict as returned by google_oauth_client.get_access_token."""
    return {
        "access_token": "fake_access_token",
        "id_token": make_fake_id_token(sub, email),
        "expires_at": None,
        "refresh_token": None,
    }


# ---------------------------------------------------------------------------
# promote_guest_with_google service unit tests (TDD RED)
# ---------------------------------------------------------------------------


class TestPromoteGuestWithGoogle:
    @pytest.mark.asyncio
    async def test_promotion_updates_user_fields(self, db_session):
        """promote_guest_with_google sets is_guest=False, updates email, is_verified=True, hashed_password=''."""
        from app.services.guest_service import create_guest_user, promote_guest_with_google

        user, _token = await create_guest_user(db_session)
        account_email = unique_email("gpromo")
        updated_user, _new_token = await promote_guest_with_google(
            db_session,
            user,
            account_id="google_sub_001",
            account_email=account_email,
            access_token="fake_access",
            expires_at=None,
            refresh_token=None,
        )

        assert updated_user.is_guest is False
        assert updated_user.email == account_email
        assert updated_user.is_verified is True
        assert updated_user.hashed_password == ""
        assert updated_user.promoted_at is not None

    @pytest.mark.asyncio
    async def test_promotion_sets_promoted_at_in_database(self, db_session):
        """promoted_at is persisted as a sane recent timestamp, not just present
        on the returned ORM object.

        Reads back via a Core select rather than the returned user, since the
        latter can be served from the identity map instead of proving the write.
        Also checked against a tolerance window (not in the future, not stale)
        rather than merely non-NULL, since a wrong-but-non-NULL value would
        otherwise pass silently.
        """
        from datetime import datetime, timedelta, timezone

        from sqlalchemy import select

        from app.models.user import User
        from app.services.guest_service import create_guest_user, promote_guest_with_google

        user, _token = await create_guest_user(db_session)
        account_email = unique_email("gpromo_dbread")
        before = datetime.now(timezone.utc)
        await promote_guest_with_google(
            db_session,
            user,
            account_id="google_sub_dbread",
            account_email=account_email,
            access_token="fake_access",
            expires_at=None,
            refresh_token=None,
        )
        after = datetime.now(timezone.utc)

        result = await db_session.execute(select(User.promoted_at).where(User.id == user.id))
        promoted_at = result.scalar_one()
        assert promoted_at is not None
        assert before - timedelta(seconds=5) <= promoted_at <= after + timedelta(seconds=5)

    @pytest.mark.asyncio
    async def test_promotion_creates_oauth_account(self, db_session):
        """promote_guest_with_google creates an OAuthAccount row with oauth_name='google'."""
        from sqlalchemy import select

        from app.models.oauth_account import OAuthAccount
        from app.services.guest_service import create_guest_user, promote_guest_with_google

        user, _token = await create_guest_user(db_session)
        account_id = f"sub_{uuid.uuid4().hex}"
        account_email = unique_email("oauth_acc")

        updated_user, _new_token = await promote_guest_with_google(
            db_session,
            user,
            account_id=account_id,
            account_email=account_email,
            access_token="fake_access",
            expires_at=None,
            refresh_token=None,
        )

        result = await db_session.execute(
            select(OAuthAccount).where(
                OAuthAccount.user_id == updated_user.id  # SQLAlchemy column comparison
            )
        )
        oauth_row = result.scalar_one_or_none()
        assert oauth_row is not None
        assert oauth_row.oauth_name == "google"
        assert oauth_row.account_id == account_id
        assert oauth_row.user_id == user.id

    @pytest.mark.asyncio
    async def test_promotion_preserves_user_id(self, db_session):
        """promote_guest_with_google performs an in-place UPDATE — user.id is unchanged."""
        from app.services.guest_service import create_guest_user, promote_guest_with_google

        user, _token = await create_guest_user(db_session)
        original_id = user.id

        updated_user, _new_token = await promote_guest_with_google(
            db_session,
            user,
            account_id="sub_preserve",
            account_email=unique_email("preserve"),
            access_token="fake_access",
            expires_at=None,
            refresh_token=None,
        )

        assert updated_user.id == original_id

    @pytest.mark.asyncio
    async def test_promotion_returns_7day_jwt(self, db_session):
        """promote_guest_with_google returns a non-empty JWT string."""
        from app.services.guest_service import create_guest_user, promote_guest_with_google

        user, _token = await create_guest_user(db_session)
        _updated_user, new_token = await promote_guest_with_google(
            db_session,
            user,
            account_id="sub_jwt",
            account_email=unique_email("jwttest"),
            access_token="fake_access",
            expires_at=None,
            refresh_token=None,
        )

        assert isinstance(new_token, str)
        assert len(new_token) > 0

    @pytest.mark.asyncio
    async def test_raises_value_error_for_non_guest(self, db_session):
        """promote_guest_with_google raises ValueError('Not a guest user') for non-guest input."""
        from app.models.user import User
        from app.services.guest_service import promote_guest_with_google

        regular_user = User(
            email=unique_email("nonguestgoogle"),
            hashed_password="fakehash",
            is_active=True,
            is_verified=True,
            is_guest=False,
        )
        db_session.add(regular_user)
        await db_session.flush()

        with pytest.raises(ValueError, match="Not a guest user"):
            await promote_guest_with_google(
                db_session,
                regular_user,
                account_id="sub_nongst",
                account_email=unique_email("nongst_target"),
                access_token="fake_access",
                expires_at=None,
                refresh_token=None,
            )

    @pytest.mark.asyncio
    async def test_raises_user_already_exists_on_email_conflict(self, db_session):
        """promote_guest_with_google raises UserAlreadyExists when account_email is taken."""
        from fastapi_users.exceptions import UserAlreadyExists

        from app.models.user import User
        from app.services.guest_service import create_guest_user, promote_guest_with_google

        existing_email = unique_email("existing_google")
        existing_user = User(
            email=existing_email,
            hashed_password="fakehash",
            is_active=True,
            is_verified=True,
            is_guest=False,
        )
        db_session.add(existing_user)
        await db_session.flush()

        guest_user, _token = await create_guest_user(db_session)

        with pytest.raises(UserAlreadyExists):
            await promote_guest_with_google(
                db_session,
                guest_user,
                account_id="sub_collision",
                account_email=existing_email,
                access_token="fake_access",
                expires_at=None,
                refresh_token=None,
            )


# ---------------------------------------------------------------------------
# GET /auth/google/authorize-promote integration tests
# ---------------------------------------------------------------------------


class TestAuthorizePromote:
    def setup_method(self) -> None:
        """Reset rate limiter before each test to prevent cross-test 429 errors."""
        from app.core.ip_rate_limiter import guest_create_limiter

        guest_create_limiter._timestamps.clear()

    @pytest.mark.asyncio
    async def test_authorize_promote_returns_url_for_guest(self):
        """GET /auth/google/authorize-promote with guest Bearer token returns 200 with authorization_url."""
        fake_auth_url = "https://accounts.google.com/o/oauth2/v2/auth?fake=1"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            guest_resp = await client.post("/api/auth/guest/create")
            assert guest_resp.status_code == 201
            guest_token = guest_resp.json()["access_token"]

            with patch(
                "app.users.google_oauth_client.get_authorization_url",
                new=AsyncMock(return_value=fake_auth_url),
            ):
                resp = await client.get(
                    "/api/auth/google/authorize-promote",
                    headers={"Authorization": f"Bearer {guest_token}"},
                )

        assert resp.status_code == 200
        data = resp.json()
        assert "authorization_url" in data
        assert "accounts.google.com" in data["authorization_url"]

    @pytest.mark.asyncio
    async def test_authorize_promote_rejects_non_guest(self):
        """GET /auth/google/authorize-promote with a regular user's Bearer token returns 403."""
        email = unique_email("nonguestauth")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")
            login_resp = await login_user(client, email, "password123")
            token = login_resp.json()["access_token"]

            resp = await client.get(
                "/api/auth/google/authorize-promote",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_authorize_promote_requires_auth(self):
        """GET /auth/google/authorize-promote without Authorization header returns 401."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/auth/google/authorize-promote")

        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /auth/google/authorize — server-side guest-promotion safety net
# ---------------------------------------------------------------------------


class TestAuthorizeGuestPromotion:
    """The plain /auth/google/authorize endpoint must route an authenticated guest
    through in-place promotion (promote-audience state + callback-promote redirect),
    so a guest signing in via ANY Google entry point is never orphaned."""

    def setup_method(self) -> None:
        from app.core.ip_rate_limiter import guest_create_limiter

        guest_create_limiter._timestamps.clear()

    def _decode_user_id_from_token(self, token: str) -> int:
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        return int(claims["sub"])

    @pytest.mark.asyncio
    async def test_guest_authorize_routes_to_promotion(self):
        """A guest Bearer token → callback-promote redirect_uri + promote-audience state with guest_user_id."""
        from fastapi_users.jwt import decode_jwt

        from app.core.config import settings
        from app.routers.auth import _OAUTH_PROMOTE_STATE_AUDIENCE

        fake_auth_url = "https://accounts.google.com/o/oauth2/v2/auth?fake=1"
        mock = AsyncMock(return_value=fake_auth_url)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            guest_resp = await client.post("/api/auth/guest/create")
            assert guest_resp.status_code == 201
            guest_token = guest_resp.json()["access_token"]
            guest_user_id = self._decode_user_id_from_token(guest_token)

            with patch("app.users.google_oauth_client.get_authorization_url", new=mock):
                resp = await client.get(
                    "/api/auth/google/authorize",
                    headers={"Authorization": f"Bearer {guest_token}"},
                )

        assert resp.status_code == 200
        # First positional arg is the redirect_url, second is the state JWT.
        redirect_url, state = mock.call_args.args[0], mock.call_args.args[1]
        assert redirect_url.endswith("/api/auth/google/callback-promote")

        state_data = decode_jwt(state, settings.SECRET_KEY, [_OAUTH_PROMOTE_STATE_AUDIENCE])
        assert state_data["guest_user_id"] == guest_user_id

    @pytest.mark.asyncio
    async def test_anonymous_authorize_uses_plain_flow(self):
        """No auth → plain callback redirect_uri + plain oauth-state audience (unchanged behavior)."""
        from fastapi_users.jwt import decode_jwt

        from app.core.config import settings
        from app.routers.auth import _OAUTH_STATE_AUDIENCE

        fake_auth_url = "https://accounts.google.com/o/oauth2/v2/auth?fake=1"
        mock = AsyncMock(return_value=fake_auth_url)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            with patch("app.users.google_oauth_client.get_authorization_url", new=mock):
                resp = await client.get("/api/auth/google/authorize")

        assert resp.status_code == 200
        redirect_url, state = mock.call_args.args[0], mock.call_args.args[1]
        assert redirect_url.endswith("/api/auth/google/callback")

        state_data = decode_jwt(state, settings.SECRET_KEY, [_OAUTH_STATE_AUDIENCE])
        assert "guest_user_id" not in state_data

    @pytest.mark.asyncio
    async def test_registered_user_authorize_uses_plain_flow(self):
        """A non-guest registered user's token → plain flow (only guests get promoted)."""
        from fastapi_users.jwt import decode_jwt

        from app.core.config import settings
        from app.routers.auth import _OAUTH_STATE_AUDIENCE

        fake_auth_url = "https://accounts.google.com/o/oauth2/v2/auth?fake=1"
        mock = AsyncMock(return_value=fake_auth_url)
        email = unique_email("plainauth")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")
            token = (await login_user(client, email, "password123")).json()["access_token"]

            with patch("app.users.google_oauth_client.get_authorization_url", new=mock):
                resp = await client.get(
                    "/api/auth/google/authorize",
                    headers={"Authorization": f"Bearer {token}"},
                )

        assert resp.status_code == 200
        redirect_url, state = mock.call_args.args[0], mock.call_args.args[1]
        assert redirect_url.endswith("/api/auth/google/callback")
        state_data = decode_jwt(state, settings.SECRET_KEY, [_OAUTH_STATE_AUDIENCE])
        assert "guest_user_id" not in state_data


# ---------------------------------------------------------------------------
# GET /auth/google/callback-promote integration tests
# ---------------------------------------------------------------------------


class TestCallbackPromote:
    def setup_method(self) -> None:
        """Reset rate limiter before each test to prevent cross-test 429 errors."""
        from app.core.ip_rate_limiter import guest_create_limiter

        guest_create_limiter._timestamps.clear()

    def _make_valid_state_jwt(self, guest_user_id: int, csrf_token: str) -> str:
        """Build a valid state JWT with promote audience for tests."""
        from fastapi_users.jwt import generate_jwt

        from app.core.config import settings
        from app.routers.auth import _OAUTH_PROMOTE_STATE_AUDIENCE

        state_data = {
            "csrftoken": csrf_token,
            "guest_user_id": guest_user_id,
            "aud": _OAUTH_PROMOTE_STATE_AUDIENCE,
        }
        return generate_jwt(state_data, settings.SECRET_KEY, lifetime_seconds=600)

    def _decode_user_id_from_token(self, token: str) -> int:
        """Decode the user ID (sub claim) from a FastAPI-Users JWT."""
        import base64
        import json

        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        return int(claims["sub"])

    @pytest.mark.asyncio
    async def test_callback_promote_with_mocked_google(self):
        """Callback with valid state+code promotes the guest and redirects with token&promoted=1."""
        from app.routers.auth import _CSRF_COOKIE

        csrf_token = "test_csrf_token_abc123"
        account_sub = f"google_sub_{uuid.uuid4().hex}"
        account_email = unique_email("cbpromoted")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: csrf_token},
        ) as client:
            # Create a guest user
            guest_resp = await client.post("/api/auth/guest/create")
            assert guest_resp.status_code == 201
            guest_token = guest_resp.json()["access_token"]

            # Extract guest user_id from JWT sub claim
            guest_user_id = self._decode_user_id_from_token(guest_token)

            # Build state JWT with guest_user_id embedded
            state = self._make_valid_state_jwt(guest_user_id, csrf_token)

            fake_token_resp = make_fake_token_response(sub=account_sub, email=account_email)

            with patch(
                "app.routers.auth.google_oauth_client.get_access_token",
                new=AsyncMock(return_value=fake_token_resp),
            ):
                resp = await client.get(
                    "/api/auth/google/callback-promote",
                    params={"code": "fake_code", "state": state},
                    follow_redirects=False,
                )

        assert resp.status_code == 302
        location = resp.headers["location"]
        assert "token=" in location
        assert "promoted=1" in location

        # Verify the user was promoted (token in fragment should work for profile)
        fragment = location.split("#", 1)[1] if "#" in location else ""
        params = dict(pair.split("=", 1) for pair in fragment.split("&") if "=" in pair)
        new_token = params.get("token", "")
        assert new_token != ""

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client2:
            profile_resp2 = await client2.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {new_token}"},
            )
        assert profile_resp2.status_code == 200
        profile = profile_resp2.json()
        assert profile["is_guest"] is False

    @pytest.mark.asyncio
    async def test_callback_promote_email_collision(self):
        """Callback returns 302 redirect with error=EMAIL_ALREADY_REGISTERED when email is taken."""
        from app.routers.auth import _CSRF_COOKIE

        csrf_token = "test_csrf_collision_xyz"
        existing_email = unique_email("collision_target")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: csrf_token},
        ) as client:
            # Register the email on a different account first
            await register_user(client, existing_email, "password123")

            # Create a guest user
            guest_resp = await client.post("/api/auth/guest/create")
            assert guest_resp.status_code == 201
            guest_token = guest_resp.json()["access_token"]

            guest_user_id = self._decode_user_id_from_token(guest_token)
            state = self._make_valid_state_jwt(guest_user_id, csrf_token)

            fake_token_resp = make_fake_token_response(
                sub="sub_collision_test", email=existing_email
            )

            with patch(
                "app.routers.auth.google_oauth_client.get_access_token",
                new=AsyncMock(return_value=fake_token_resp),
            ):
                resp = await client.get(
                    "/api/auth/google/callback-promote",
                    params={"code": "fake_code", "state": state},
                    follow_redirects=False,
                )

        assert resp.status_code == 302
        location = resp.headers["location"]
        assert "EMAIL_ALREADY_REGISTERED" in location

    @pytest.mark.asyncio
    async def test_callback_promote_invalid_csrf(self):
        """Callback with mismatched CSRF cookie returns 400."""
        from app.routers.auth import _CSRF_COOKIE

        csrf_in_state = "csrf_in_state_value"
        csrf_in_cookie = "csrf_different_value"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: csrf_in_cookie},
        ) as client:
            # Create a guest user for a valid guest_user_id
            guest_resp = await client.post("/api/auth/guest/create")
            guest_token = guest_resp.json()["access_token"]
            guest_user_id = self._decode_user_id_from_token(guest_token)

            # State JWT has csrf_in_state but cookie has csrf_in_cookie
            state = self._make_valid_state_jwt(guest_user_id, csrf_in_state)

            resp = await client.get(
                "/api/auth/google/callback-promote",
                params={"code": "fake_code", "state": state},
                follow_redirects=False,
            )

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_callback_promote_invalid_state_audience(self):
        """Callback with a state JWT signed with the regular oauth-state audience returns 400."""
        from fastapi_users.jwt import generate_jwt

        from app.core.config import settings
        from app.routers.auth import _CSRF_COOKIE, _OAUTH_STATE_AUDIENCE

        csrf_token = "csrf_wrong_audience"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: csrf_token},
        ) as client:
            guest_resp = await client.post("/api/auth/guest/create")
            guest_token = guest_resp.json()["access_token"]
            guest_user_id = self._decode_user_id_from_token(guest_token)

            # Build a state JWT with the WRONG audience (regular oauth-state, not promote)
            wrong_state_data = {
                "csrftoken": csrf_token,
                "guest_user_id": guest_user_id,
                "aud": _OAUTH_STATE_AUDIENCE,  # regular OAuth state audience, not promote
            }
            wrong_state = generate_jwt(wrong_state_data, settings.SECRET_KEY, lifetime_seconds=600)

            resp = await client.get(
                "/api/auth/google/callback-promote",
                params={"code": "fake_code", "state": wrong_state},
                follow_redirects=False,
            )

        assert resp.status_code == 400
