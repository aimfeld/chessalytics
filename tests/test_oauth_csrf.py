"""Tests verifying the Google OAuth CSRF double-submit cookie fix (CVE-2025-68481).

Tests cover:
- Authorize endpoint sets the flawchess_oauth_csrf cookie with correct attributes
- Callback rejects requests with a missing CSRF cookie (returns 400)
- Callback rejects requests with a mismatched CSRF cookie (returns 400)
- Callback rejects requests with an invalid state JWT (returns 400)

NOTE: The authorize test requires valid Google OAuth credentials to reach the cookie-set
      code path (get_authorization_url must succeed). If credentials are not configured,
      the test is skipped.

NOTE: The callback tests do NOT require Google credentials — they exercise the state JWT
      and CSRF validation logic before any Google API calls happen.
"""

import httpx
import pytest
from fastapi import HTTPException
from fastapi_users.jwt import generate_jwt

from app.core.config import settings
from app.main import app
from app.routers.auth import _resolve_oauth_bases

_CSRF_COOKIE = "flawchess_oauth_csrf"
_OAUTH_STATE_AUDIENCE = "fastapi-users:oauth-state"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_state_jwt(csrftoken: str, lifetime_seconds: int = 600) -> str:
    """Build a valid OAuth state JWT embedding the given CSRF token."""
    state_data = {"csrftoken": csrftoken, "aud": _OAUTH_STATE_AUDIENCE}
    return generate_jwt(state_data, settings.SECRET_KEY, lifetime_seconds=lifetime_seconds)


# ---------------------------------------------------------------------------
# Per-origin redirect base resolution (allowlist boundary)
# ---------------------------------------------------------------------------


class TestResolveOAuthBases:
    def test_none_origin_uses_configured_defaults(self):
        """No origin → the proven localhost/prod split (BACKEND_URL, FRONTEND_URL)."""
        assert _resolve_oauth_bases(None) == (settings.BACKEND_URL, settings.FRONTEND_URL)

    def test_frontend_url_origin_uses_configured_defaults(self):
        """Origin == FRONTEND_URL → same split (covers localhost dev and prod)."""
        assert _resolve_oauth_bases(settings.FRONTEND_URL) == (
            settings.BACKEND_URL,
            settings.FRONTEND_URL,
        )

    def test_allowlisted_tunnel_origin_is_same_origin(self, monkeypatch):
        """An allowlisted tunnel origin resolves both bases to the origin itself."""
        tunnel = "https://ai-slim.tailb91388.ts.net"
        monkeypatch.setattr(settings, "OAUTH_TUNNEL_ORIGINS", f"{tunnel},https://other.ts.net")
        assert _resolve_oauth_bases(tunnel) == (tunnel, tunnel)

    def test_allowlist_wins_when_tunnel_is_also_frontend_url(self, monkeypatch):
        """Tunnel origin that is ALSO FRONTEND_URL must stay same-origin.

        Regression (2026-08-08): the FRONTEND_URL branch ran first, so setting
        FRONTEND_URL to the tunnel (for password-reset links) sent Google's
        redirect_uri to BACKEND_URL while the CSRF cookie sat on the tunnel host —
        the callback died with "Invalid CSRF token".
        """
        tunnel = "https://ai-slim.tailb91388.ts.net"
        monkeypatch.setattr(settings, "FRONTEND_URL", tunnel)
        monkeypatch.setattr(settings, "OAUTH_TUNNEL_ORIGINS", tunnel)
        assert _resolve_oauth_bases(tunnel) == (tunnel, tunnel)

    def test_unknown_origin_is_rejected(self, monkeypatch):
        """A non-allowlisted origin raises 400 (OAuth open-redirect guard)."""
        monkeypatch.setattr(settings, "OAUTH_TUNNEL_ORIGINS", "")
        with pytest.raises(HTTPException) as exc_info:
            _resolve_oauth_bases("https://evil.example")
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_authorize_rejects_unknown_origin(self, monkeypatch):
        """GET /auth/google/authorize?origin=<evil> returns 400 before any Google call."""
        monkeypatch.setattr(settings, "OAUTH_TUNNEL_ORIGINS", "")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/auth/google/authorize", params={"origin": "https://evil.example"}
            )
        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
        assert "OAuth origin not allowed" in resp.text


# ---------------------------------------------------------------------------
# Authorize endpoint
# ---------------------------------------------------------------------------


class TestOAuthCSRFAuthorize:
    @pytest.mark.asyncio
    async def test_authorize_sets_csrf_cookie(self):
        """GET /auth/google/authorize sets a flawchess_oauth_csrf httpOnly cookie.

        Skipped when Google OAuth credentials are not configured (empty client ID)
        because get_authorization_url will raise before the cookie is set.
        """
        if not settings.GOOGLE_OAUTH_CLIENT_ID:
            pytest.skip("Google OAuth credentials not configured in test environment")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/auth/google/authorize")

        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

        # Verify the CSRF cookie is present in Set-Cookie
        set_cookie = resp.headers.get("set-cookie", "")
        assert _CSRF_COOKIE in set_cookie, (
            f"Expected '{_CSRF_COOKIE}' in Set-Cookie header, got: {set_cookie!r}"
        )
        assert "httponly" in set_cookie.lower(), (
            f"Expected httponly flag in Set-Cookie, got: {set_cookie!r}"
        )
        assert "samesite=lax" in set_cookie.lower(), (
            f"Expected samesite=lax in Set-Cookie, got: {set_cookie!r}"
        )

    @pytest.mark.asyncio
    async def test_authorize_endpoint_reachable(self):
        """GET /auth/google/authorize endpoint exists (not 404/405).

        This verifies the route is registered regardless of OAuth credentials.
        When credentials are absent the endpoint returns 500 from httpx_oauth,
        but crucially it is reachable and not a 404 (route not found).
        """
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/auth/google/authorize")

        assert resp.status_code != 404, "Authorize endpoint should be registered (not 404)"
        assert resp.status_code != 405, "Authorize endpoint should accept GET (not 405)"


# ---------------------------------------------------------------------------
# Callback endpoint — CSRF validation (no Google credentials required)
# ---------------------------------------------------------------------------


class TestOAuthCSRFCallback:
    @pytest.mark.asyncio
    async def test_callback_rejects_missing_csrf_cookie(self):
        """Callback returns 400 when the CSRF cookie is absent.

        A valid state JWT is provided but no cookie — the double-submit check fails.
        """
        state = make_state_jwt("test_csrf_token_abc123")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/auth/google/callback",
                params={"code": "fakecode", "state": state},
                # No CSRF cookie sent
            )

        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
        assert "Invalid CSRF token" in resp.text, (
            f"Expected 'Invalid CSRF token' in response body, got: {resp.text!r}"
        )

    @pytest.mark.asyncio
    async def test_callback_rejects_mismatched_csrf_cookie(self):
        """Callback returns 400 when the CSRF cookie does not match the state JWT.

        State JWT contains token_a; cookie contains token_b — compare_digest returns False.
        """
        state = make_state_jwt("token_a")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: "token_b"},
        ) as client:
            resp = await client.get(
                "/api/auth/google/callback",
                params={"code": "fakecode", "state": state},
            )

        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
        assert "Invalid CSRF token" in resp.text, (
            f"Expected 'Invalid CSRF token' in response body, got: {resp.text!r}"
        )

    @pytest.mark.asyncio
    async def test_callback_rejects_invalid_state_jwt(self):
        """Callback returns 400 when the state parameter is not a valid JWT.

        CSRF validation is not reached — the JWT decode fails first.
        """
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: "any_cookie_value"},
        ) as client:
            resp = await client.get(
                "/api/auth/google/callback",
                params={"code": "fakecode", "state": "this.is.garbage"},
            )

        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
        assert "Invalid OAuth state" in resp.text, (
            f"Expected 'Invalid OAuth state' in response body, got: {resp.text!r}"
        )

    @pytest.mark.asyncio
    async def test_callback_rejects_expired_state_jwt(self):
        """Callback returns 400 when the state JWT has expired.

        lifetime_seconds=-1 causes the exp claim to be in the past,
        so decode_jwt raises an expiry error.
        """
        # Generate a JWT with negative lifetime — exp is already in the past
        state = make_state_jwt("expired_token", lifetime_seconds=-1)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://test",
            cookies={_CSRF_COOKIE: "expired_token"},
        ) as client:
            resp = await client.get(
                "/api/auth/google/callback",
                params={"code": "fakecode", "state": state},
            )

        assert resp.status_code == 400, f"Expected 400, got {resp.status_code}: {resp.text}"
        # Expired JWT fails decode → "Invalid OAuth state"
        assert "Invalid OAuth state" in resp.text, (
            f"Expected 'Invalid OAuth state' in response body, got: {resp.text!r}"
        )
