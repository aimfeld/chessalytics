"""Auth router: register, JWT login/logout, Google OAuth, and guest session endpoints via FastAPI-Users."""

import json
import secrets
from typing import Annotated

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from fastapi_users import schemas as fapi_schemas
from fastapi_users.exceptions import UserAlreadyExists
from fastapi_users.jwt import decode_jwt, generate_jwt
from sqlalchemy import func, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import async_session_maker, get_async_session
from app.core.ip_rate_limiter import guest_create_limiter
from app.models.user import User
from app.schemas.auth import (
    GoogleOAuthAvailableResponse,
    GoogleOAuthAuthorizeResponse,
    GuestCreateResponse,
    GuestPromoteEmailRequest,
    GuestPromoteResponse,
    GuestRefreshResponse,
)
from app.services import guest_service
from app.users import (
    UserManager,
    auth_backend,
    current_active_user,
    current_active_user_optional,
    fastapi_users,
    get_user_manager,
    google_oauth_client,
)

router = APIRouter()

# JWT login / logout
router.include_router(
    fastapi_users.get_auth_router(auth_backend),
    prefix="/auth/jwt",
    tags=["auth"],
)

# Registration
router.include_router(
    fastapi_users.get_register_router(fapi_schemas.BaseUser[int], fapi_schemas.BaseUserCreate),
    prefix="/auth",
    tags=["auth"],
)

# Password reset (forgot-password / reset-password) — Phase 207, RESET-01.
# FastAPIUsers.get_reset_password_router() (the bound instance method) takes
# NO arguments — it already closes over self.get_user_manager internally and
# delegates to the module-level get_reset_password_router(get_user_manager).
# Deviation from RESEARCH/PATTERNS, which assumed the instance method forwards
# get_user_manager positionally like get_register_router's schema args do;
# verified against the installed fastapi-users==15.0.5 source (Rule 1/3 fix).
router.include_router(
    fastapi_users.get_reset_password_router(),
    prefix="/auth",
    tags=["auth"],
)

# ── Google OAuth ──────────────────────────────────────────────────────────────
# Custom implementation that redirects to the SPA after successful OAuth.
#
# Flow:
#   1. GET /auth/google/authorize → {"authorization_url": "..."}
#   2. Frontend redirects user to authorization_url
#   3. Google sends GET /auth/google/callback?code=...&state=...
#   4. Backend issues JWT, redirects to FRONTEND_URL/auth/callback#token=JWT
#   5. Frontend /auth/callback page reads fragment and stores token

_CALLBACK_ROUTE_NAME = "google-oauth-callback"
_OAUTH_STATE_AUDIENCE = "fastapi-users:oauth-state"
_CSRF_COOKIE = "flawchess_oauth_csrf"

_PROMOTE_CALLBACK_ROUTE_NAME = "google-oauth-promote-callback"
_OAUTH_PROMOTE_STATE_AUDIENCE = "fastapi-users:oauth-promote-state"


def _oauth_tunnel_origins() -> set[str]:
    """Parse the comma-separated OAUTH_TUNNEL_ORIGINS allowlist into a set."""
    return {o.strip() for o in settings.OAUTH_TUNNEL_ORIGINS.split(",") if o.strip()}


def _resolve_oauth_bases(origin: str | None) -> tuple[str, str]:
    """Resolve ``(backend_base, frontend_base)`` for the OAuth round-trip.

    The Google ``redirect_uri`` and the final SPA redirect must match the origin the
    user actually came from, so plain ``http://localhost:5173`` and an HTTPS dev tunnel
    (Tailscale) both work without a single static BACKEND_URL serving two hosts.

    - Default / localhost dev / prod (origin omitted or == FRONTEND_URL): keep the proven
      split — API on BACKEND_URL, SPA on FRONTEND_URL.
    - Same-origin tunnels (allowlisted): SPA and /api share one HTTPS host, so both bases
      are the origin itself.
    - Anything else: 400, to prevent an OAuth open-redirect via a forged origin.
    """
    if not origin or origin == settings.FRONTEND_URL:
        return settings.BACKEND_URL, settings.FRONTEND_URL
    if origin in _oauth_tunnel_origins():
        return origin, origin
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth origin not allowed")


@router.get("/auth/google/available", tags=["auth"], response_model=GoogleOAuthAvailableResponse)
async def google_oauth_available() -> GoogleOAuthAvailableResponse:
    """Return whether Google OAuth is configured on this server."""
    available = bool(settings.GOOGLE_OAUTH_CLIENT_ID and settings.GOOGLE_OAUTH_CLIENT_SECRET)
    return GoogleOAuthAvailableResponse(available=available)


@router.get("/auth/google/authorize", tags=["auth"], response_model=GoogleOAuthAuthorizeResponse)
async def google_authorize(
    request: Request,
    response: Response,
    user: Annotated[User | None, Depends(current_active_user_optional)],
    origin: str | None = None,
) -> GoogleOAuthAuthorizeResponse:
    """Return the Google OAuth authorization URL for the frontend to redirect to.

    ``origin`` is the SPA's ``window.location.origin``; it selects the redirect base so
    login works from both localhost and an allowlisted HTTPS dev tunnel (Tailscale).

    Server-side guest-promotion safety net: if the caller authenticates as a guest
    (a guest Bearer token reaches this endpoint — e.g. the Login-tab Google button or
    a logged-in guest), route the flow through in-place promotion exactly like
    ``/auth/google/authorize-promote`` does — promote-audience state with ``guest_user_id``
    and the ``callback-promote`` redirect. Without this, a guest who signs in via the
    plain flow gets a brand-new account from stock FastAPI-Users ``oauth_callback`` (the
    guest's ``guest_*@guest.local`` email never matches the Google email), orphaning their
    imported games (prod users 198→199, 2026-06-23).
    """
    backend_base, _frontend_base = _resolve_oauth_bases(origin)
    csrf_token = secrets.token_urlsafe(32)

    promote_guest = user is not None and user.is_guest
    if promote_guest:
        state_data = {
            "csrftoken": csrf_token,
            "guest_user_id": user.id,
            "origin": origin,
            "aud": _OAUTH_PROMOTE_STATE_AUDIENCE,
        }
        callback_path = "callback-promote"
    else:
        state_data = {"csrftoken": csrf_token, "origin": origin, "aud": _OAUTH_STATE_AUDIENCE}
        callback_path = "callback"
    state = generate_jwt(
        state_data,
        settings.SECRET_KEY,
        lifetime_seconds=600,
    )

    # Set CSRF cookie — double-submit cookie pattern (CVE-2025-68481 fix)
    # The same csrf_token is embedded in the state JWT and set as a httpOnly cookie.
    # The callback endpoint reads the cookie and compares it against the state JWT claim
    # using timing-safe comparison, preventing CSRF-based account takeover.
    response.set_cookie(
        _CSRF_COOKIE,
        csrf_token,
        max_age=600,  # matches state JWT lifetime
        httponly=True,  # not readable by JS (defense in depth)
        secure=settings.ENVIRONMENT != "development",
        samesite="lax",
    )

    # Build callback URL explicitly — request.url_for() picks up the Vite proxy host (port 5173)
    # which doesn't match Google's authorized redirect URI. backend_base is resolved from the
    # request origin (localhost vs tunnel) so the redirect_uri matches a registered Google entry.
    # callback_path is "callback-promote" for guests (in-place promotion), else "callback".
    redirect_url = f"{backend_base}/api/auth/google/{callback_path}"
    authorization_url = await google_oauth_client.get_authorization_url(
        redirect_url,
        state,
        scope=["openid", "email", "profile"],
    )

    return GoogleOAuthAuthorizeResponse(authorization_url=authorization_url)


@router.get("/auth/google/callback", name=_CALLBACK_ROUTE_NAME, tags=["auth"])
async def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    user_manager: UserManager = Depends(get_user_manager),
):
    """Handle Google OAuth callback, issue JWT, and redirect to frontend.

    Exchanges the authorization code manually using BACKEND_URL instead of
    request.url_for() — the latter builds wrong URLs behind reverse proxies
    even with X-Forwarded headers, causing redirect_uri mismatch errors.
    """
    if error is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"OAuth error: {error}")

    if code is None or state is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing code or state")

    # Validate state JWT and extract CSRF token before calling Google's token endpoint.
    # Fail fast on bad state/CSRF without wasting an external API call.
    try:
        state_data = decode_jwt(state, settings.SECRET_KEY, [_OAUTH_STATE_AUDIENCE])
    except Exception:
        sentry_sdk.set_tag("source", "auth")
        sentry_sdk.capture_exception()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state")

    # Validate CSRF double-submit cookie (CVE-2025-68481 fix)
    # The authorize endpoint set this cookie; the callback must confirm they match.
    cookie_csrf = request.cookies.get(_CSRF_COOKIE)
    state_csrf = state_data.get("csrftoken")
    if not cookie_csrf or not state_csrf or not secrets.compare_digest(cookie_csrf, state_csrf):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid CSRF token",
        )

    # Re-resolve the origin from the (signed) state so the token-exchange redirect_uri and the
    # final SPA redirect match the authorize step. Re-validates the origin against the allowlist.
    backend_base, frontend_base = _resolve_oauth_bases(state_data.get("origin"))

    # Exchange code for token using the same redirect_uri as the authorize step
    redirect_url = f"{backend_base}/api/auth/google/callback"
    token = await google_oauth_client.get_access_token(code, redirect_url)

    # Decode id_token from Google (avoids People API dependency).
    # The id_token is a JWT — we only need the payload, Google already validated it.
    id_token = token.get("id_token")
    if not id_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No id_token in Google response",
        )
    # Decode payload without verification (token was just received over TLS from Google)
    import base64

    payload_b64 = id_token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)  # pad base64
    id_claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    account_id = id_claims["sub"]
    account_email = id_claims.get("email")

    if account_email is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No email returned from Google",
        )

    try:
        user = await user_manager.oauth_callback(  # ty: ignore[invalid-argument-type]  # FastAPI-Users generic typing not resolved by ty beta
            oauth_name=google_oauth_client.name,
            access_token=token["access_token"],
            account_id=account_id,
            account_email=account_email,
            expires_at=token.get("expires_at"),
            refresh_token=token.get("refresh_token"),
            request=request,
            associate_by_email=True,
            is_verified_by_default=True,
        )
    except UserAlreadyExists:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User already exists with a different OAuth account",
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User account is not active",
        )

    # Update last_login — on_after_login is not called for OAuth flow
    async with async_session_maker() as session:
        await session.execute(
            sa_update(User).where(User.id == user.id).values(last_login=func.now())
        )
        await session.commit()

    strategy = auth_backend.get_strategy()
    access_token = await strategy.write_token(user)  # ty: ignore[unresolved-attribute]  # FastAPI-Users generic typing not resolved by ty beta

    # Redirect to frontend callback page with token in fragment
    frontend_redirect = f"{frontend_base}/auth/callback#token={access_token}"
    return RedirectResponse(url=frontend_redirect, status_code=status.HTTP_302_FOUND)


# -- Guest session endpoints ------------------------------------------------


@router.post(
    "/auth/guest/create", tags=["auth"], response_model=GuestCreateResponse, status_code=201
)
async def create_guest(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> GuestCreateResponse:
    """Create an anonymous guest user and return a 30-day Bearer JWT."""
    client_ip = request.client.host if request.client else "unknown"
    if not guest_create_limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many guest accounts created from this IP",
        )
    user, token = await guest_service.create_guest_user(session)
    return GuestCreateResponse(access_token=token, token_type="bearer", is_guest=True)


@router.post("/auth/guest/refresh", tags=["auth"], response_model=GuestRefreshResponse)
async def refresh_guest_token(
    user: Annotated[User, Depends(current_active_user)],
) -> GuestRefreshResponse:
    """Issue a fresh 30-day JWT for the authenticated guest, extending their session expiry."""
    if not user.is_guest:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a guest user",
        )
    token = await guest_service.refresh_guest_token(user)
    return GuestRefreshResponse(access_token=token, token_type="bearer")


@router.get(
    "/auth/google/authorize-promote", tags=["auth"], response_model=GoogleOAuthAuthorizeResponse
)
async def google_authorize_promote(
    response: Response,
    user: Annotated[User, Depends(current_active_user)],
    origin: str | None = None,
) -> GoogleOAuthAuthorizeResponse:
    """Return the Google OAuth authorization URL for a guest user to promote their account.

    Only accessible by authenticated guest users. Embeds the guest's user ID and a CSRF
    token in a signed state JWT so the callback can recover the guest identity after the
    browser redirect round-trip (during which the Authorization header is not sent).

    ``origin`` (the SPA's ``window.location.origin``) selects the redirect base so promotion
    works from both localhost and an allowlisted HTTPS dev tunnel (Tailscale).
    """
    if not user.is_guest:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a guest user")

    backend_base, _frontend_base = _resolve_oauth_bases(origin)
    csrf_token = secrets.token_urlsafe(32)
    state_data = {
        "csrftoken": csrf_token,
        "guest_user_id": user.id,
        "origin": origin,
        "aud": _OAUTH_PROMOTE_STATE_AUDIENCE,
    }
    state = generate_jwt(state_data, settings.SECRET_KEY, lifetime_seconds=600)

    # Set CSRF cookie — double-submit cookie pattern (same as regular authorize endpoint)
    response.set_cookie(
        _CSRF_COOKIE,
        csrf_token,
        max_age=600,
        httponly=True,
        secure=settings.ENVIRONMENT != "development",
        samesite="lax",
    )

    redirect_url = f"{backend_base}/api/auth/google/callback-promote"
    authorization_url = await google_oauth_client.get_authorization_url(
        redirect_url,
        state,
        scope=["openid", "email", "profile"],
    )
    return GoogleOAuthAuthorizeResponse(authorization_url=authorization_url)


@router.get("/auth/google/callback-promote", name=_PROMOTE_CALLBACK_ROUTE_NAME, tags=["auth"])
async def google_callback_promote(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    """Handle Google OAuth callback for guest promotion.

    NOT protected by current_active_user — the browser redirect has no Authorization header.
    Guest identity is recovered from the state JWT's guest_user_id field.

    Promotes the guest user in-place (same user ID), inserts an OAuthAccount row,
    issues a standard 7-day JWT, and redirects to FRONTEND_URL/auth/callback with
    token and promoted=1 in the fragment. On email collision, redirects with
    error=EMAIL_ALREADY_REGISTERED.
    """
    if error is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"OAuth error: {error}")

    if code is None or state is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing code or state")

    # Validate state JWT with the promote-specific audience — prevents replay of regular
    # login state JWTs against this callback (and vice versa).
    try:
        state_data = decode_jwt(state, settings.SECRET_KEY, [_OAUTH_PROMOTE_STATE_AUDIENCE])
    except Exception:
        sentry_sdk.set_tag("source", "auth")
        sentry_sdk.capture_exception()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid OAuth state")

    # Validate CSRF double-submit cookie
    cookie_csrf = request.cookies.get(_CSRF_COOKIE)
    state_csrf = state_data.get("csrftoken")
    if not cookie_csrf or not state_csrf or not secrets.compare_digest(cookie_csrf, state_csrf):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid CSRF token",
        )

    # Extract and validate guest_user_id from state JWT
    guest_user_id = state_data.get("guest_user_id")
    if guest_user_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing guest_user_id in state",
        )

    guest_user = await session.get(User, guest_user_id)
    if guest_user is None or not guest_user.is_guest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid guest user",
        )

    # Re-resolve the origin from the (signed) state so the redirect_uri and final SPA redirect
    # match the authorize step. Re-validates the origin against the allowlist.
    backend_base, frontend_base = _resolve_oauth_bases(state_data.get("origin"))

    # Exchange authorization code for tokens using the promote-specific redirect URI
    redirect_url = f"{backend_base}/api/auth/google/callback-promote"
    token = await google_oauth_client.get_access_token(code, redirect_url)

    # Decode id_token to extract Google account_id (sub) and email
    # (same pattern as existing /auth/google/callback — no signature verify needed,
    # token was received over TLS from Google)
    id_token = token.get("id_token")
    if not id_token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No id_token in Google response",
        )

    import base64

    payload_b64 = id_token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    id_claims = json.loads(base64.urlsafe_b64decode(payload_b64))
    account_id = id_claims["sub"]
    account_email = id_claims.get("email")

    if account_email is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No email returned from Google",
        )

    try:
        _updated_user, jwt_token = await guest_service.promote_guest_with_google(
            session,
            guest_user,
            account_id=account_id,
            account_email=account_email,
            access_token=token["access_token"],
            expires_at=token.get("expires_at"),
            refresh_token=token.get("refresh_token"),
        )
    except UserAlreadyExists:
        return RedirectResponse(
            url=f"{frontend_base}/auth/callback#error=EMAIL_ALREADY_REGISTERED",
            status_code=status.HTTP_302_FOUND,
        )
    except Exception:
        sentry_sdk.set_tag("source", "auth")
        sentry_sdk.capture_exception()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Promotion failed",
        )

    # Update last_login on the same session (promotion already committed it)
    await session.execute(
        sa_update(User).where(User.id == _updated_user.id).values(last_login=func.now())
    )
    await session.commit()

    # Redirect to frontend with token and promoted flag in fragment
    return RedirectResponse(
        url=f"{frontend_base}/auth/callback#token={jwt_token}&promoted=1",
        status_code=status.HTTP_302_FOUND,
    )


@router.post("/auth/guest/promote/email", tags=["auth"], response_model=GuestPromoteResponse)
async def promote_guest_email(
    body: GuestPromoteEmailRequest,
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> GuestPromoteResponse:
    """Promote a guest account to a full email/password account in-place."""
    if not user.is_guest:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a guest user")
    try:
        _updated_user, token = await guest_service.promote_guest_with_password(
            session, user, body.email, body.password
        )
    except UserAlreadyExists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="EMAIL_ALREADY_REGISTERED",
        )
    return GuestPromoteResponse(access_token=token, token_type="bearer")
