"""FastAPI-Users configuration: UserManager, auth backend, and dependencies.

Phase 62 adds two JWT strategies on top of the default:

- `ImpersonationJWTStrategy` — issues + validates 1h tokens carrying
  `act_as` / `admin_id` / `is_impersonation` claims. `read_token` re-validates
  on every request that the admin is still a superuser and the target is still
  a non-superuser.
- `ClaimAwareJWTStrategy` — single wrapper strategy wired into `auth_backend`.
  Peeks at the `is_impersonation` claim and dispatches to the impersonation
  strategy; otherwise falls back to the default 7-day JWT. This keeps every
  downstream `Depends(current_active_user)` signature unchanged: the returned
  User is the impersonated target when an impersonation token is presented.
"""

import base64
import json
from collections.abc import AsyncGenerator
from typing import Any

import jwt as pyjwt
from fastapi import Depends, Request, Response
from fastapi_users import BaseUserManager, FastAPIUsers, IntegerIDMixin
from fastapi_users.authentication import AuthenticationBackend, BearerTransport, JWTStrategy
from fastapi_users.db import SQLAlchemyUserDatabase
from fastapi_users.jwt import decode_jwt, generate_jwt
from httpx_oauth.clients.google import GoogleOAuth2
from sqlalchemy import func, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import async_session_maker, get_async_session
from app.core.reset_password_rate_limiter import reset_password_limiter
from app.models.oauth_account import OAuthAccount
from app.models.user import User
from app.services import email_service


# ---------------------------------------------------------------------------
# Google OAuth2 client
# ---------------------------------------------------------------------------

google_oauth_client = GoogleOAuth2(
    client_id=settings.GOOGLE_OAUTH_CLIENT_ID,
    client_secret=settings.GOOGLE_OAUTH_CLIENT_SECRET,
)


# ---------------------------------------------------------------------------
# User database dependency
# ---------------------------------------------------------------------------


async def get_user_db(
    session: AsyncSession = Depends(get_async_session),
) -> AsyncGenerator[SQLAlchemyUserDatabase, None]:
    yield SQLAlchemyUserDatabase(session, User, OAuthAccount)


# ---------------------------------------------------------------------------
# UserManager
# ---------------------------------------------------------------------------


class UserManager(IntegerIDMixin, BaseUserManager[User, int]):
    reset_password_token_secret = settings.SECRET_KEY
    verification_token_secret = settings.SECRET_KEY

    async def on_after_register(
        self,
        user: User,
        request: Request | None = None,
    ) -> None:
        """Set last_login on email registration so it's never NULL."""
        async with async_session_maker() as session:
            await session.execute(
                sa_update(User).where(User.id == user.id).values(last_login=func.now())
            )
            await session.commit()

    async def on_after_login(
        self,
        user: User,
        request: Request | None = None,
        response: Response | None = None,
    ) -> None:
        """Update last_login timestamp on every successful login."""
        async with async_session_maker() as session:
            await session.execute(
                sa_update(User).where(User.id == user.id).values(last_login=func.now())
            )
            await session.commit()

    async def on_after_forgot_password(
        self,
        user: User,
        token: str,
        request: Request | None = None,
    ) -> None:
        """Send the reset email, gated by eligibility (RESET-05) and rate-limited (D-06).

        Runs only for a real, active user — the router already filtered
        UserNotExists/UserInactive upstream (fastapi_users router/reset.py),
        so a throttled or ineligible request here still returns the router's
        identical 202 with zero enumeration signal (RESET-02). This hook must
        NEVER raise, log, or emit a Sentry event that distinguishes which
        branch was taken — both guards below are silent no-ops, deviating
        deliberately from guest_create_limiter/feedback_limiter, which both
        reject with an HTTP "too many requests" error on rejection.
        """
        # 1. Eligibility gate (RESET-05). The predicate is credential state —
        # "does this account have a password to reset" — NOT account type
        # ("is this a Google account"). 125 of the 172 eligible prod accounts
        # hold BOTH a password and a linked Google account, so an
        # account-type reading (checking oauth_account/oauth_accounts/
        # is_guest) would strand 73% of the target population. Guests share
        # the empty hash, so no separate is_guest check is needed. Do not
        # consult user.oauth_accounts, the oauth_account table, or
        # user.is_guest here, and do not inspect the hash's algorithm prefix.
        if not user.hashed_password:
            return

        # 2. Per-email rate limit (D-06). Silent no-op on rejection — see
        # module docstring on reset_password_limiter for why this deviates
        # from the two existing limiter call sites.
        if not reset_password_limiter.is_allowed(user.email.lower()):
            return

        # 3. Reset URL — host comes only from settings.FRONTEND_URL, never
        # from the Request object (T-207-09: host-header poisoning).
        reset_url = f"{settings.FRONTEND_URL}/auth/reset-password?token={token}"

        # 4. Dispatch the send without awaiting the network (T-207-02: an
        # existing address must not cost a round-trip that a non-existent
        # address never pays). email_service.spawn_password_reset_email opens
        # its own client and fires the send as a detached task.
        email_service.spawn_password_reset_email(
            to=user.email, reset_url=reset_url, user_id=user.id
        )


async def get_user_manager(
    user_db: SQLAlchemyUserDatabase = Depends(get_user_db),
) -> AsyncGenerator[UserManager, None]:
    yield UserManager(user_db)


# ---------------------------------------------------------------------------
# Auth backend (JWT / Bearer)
# ---------------------------------------------------------------------------

bearer_transport = BearerTransport(tokenUrl="auth/jwt/login")


def get_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(secret=settings.SECRET_KEY, lifetime_seconds=604800)  # 7 days


_GUEST_JWT_LIFETIME_SECONDS = 31536000  # 365 days


def get_guest_jwt_strategy() -> JWTStrategy:
    return JWTStrategy(secret=settings.SECRET_KEY, lifetime_seconds=_GUEST_JWT_LIFETIME_SECONDS)


# D-03: 1 hour — deliberately short to minimize blast radius of a leaked
# impersonation token. No server-side revocation, TTL is the bound.
_IMPERSONATION_JWT_LIFETIME_SECONDS = 3600


class ImpersonationJWTStrategy(JWTStrategy[User, int]):
    """Issues + validates impersonation JWTs.

    Additional claims on top of the default `sub` and `aud`:
      - `act_as` — the impersonated user id (mirrors `sub` for clarity)
      - `admin_id` — the superuser who initiated the impersonation
      - `is_impersonation` — dispatch flag, must be `True` on every issued token

    `read_token` re-validates on every request that:
      - admin is still active and `is_superuser=True` (D-02)
      - target is still active and `is_superuser=False` (D-05 re-enforced)
    """

    async def write_impersonation_token(self, admin: User, target: User) -> str:
        """Issue a new impersonation JWT for `admin` to act as `target`.

        Does NOT call UserManager.on_after_login — bypasses `last_login` writes
        on both users by construction (D-06).
        """
        data: dict[str, Any] = {
            "sub": str(target.id),
            "aud": self.token_audience,
            "act_as": target.id,
            "admin_id": admin.id,
            "is_impersonation": True,
        }
        return generate_jwt(data, self.encode_key, self.lifetime_seconds, algorithm=self.algorithm)

    async def read_token(
        self,
        token: str | None,
        user_manager: BaseUserManager[User, int],
    ) -> User | None:
        if token is None:
            return None
        try:
            data = decode_jwt(
                token, self.decode_key, self.token_audience, algorithms=[self.algorithm]
            )
        except pyjwt.PyJWTError:
            return None
        if not data.get("is_impersonation"):
            # Defense in depth: should never reach here via ClaimAwareJWTStrategy,
            # but fall through to the default behavior if somehow a non-impersonation
            # token reaches this strategy directly.
            return await super().read_token(token, user_manager)

        admin_id = data.get("admin_id")
        act_as = data.get("act_as")
        if admin_id is None or act_as is None:
            return None

        # D-02: re-validate admin is still a superuser on EVERY request.
        # user_db.get returns Optional[User] for missing/deleted users.
        admin = await user_manager.user_db.get(int(admin_id))
        if admin is None or not admin.is_active or not admin.is_superuser:
            return None

        # D-05 re-enforced: target must still exist, be active, and NOT be a superuser.
        target = await user_manager.user_db.get(int(act_as))
        if target is None or not target.is_active or target.is_superuser:
            return None

        return target


def get_impersonation_jwt_strategy() -> ImpersonationJWTStrategy:
    return ImpersonationJWTStrategy(
        secret=settings.SECRET_KEY,
        lifetime_seconds=_IMPERSONATION_JWT_LIFETIME_SECONDS,
    )


def _peek_is_impersonation(token: str | None) -> bool:
    """Unverified peek at a JWT payload to choose a strategy.

    Signature validation still happens inside the chosen strategy's read_token —
    this peek is only used for claim-based dispatch. A token tampered to set
    `is_impersonation=True` without a valid signature fails later validation.
    """
    if not token:
        return False
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return False
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return bool(payload.get("is_impersonation"))
    except Exception:
        return False


class ClaimAwareJWTStrategy(JWTStrategy[User, int]):
    """Single strategy that routes per-token to ImpersonationJWTStrategy when
    the `is_impersonation` claim is present. Keeps every downstream
    `Depends(current_active_user)` unchanged — returns the impersonated target
    user transparently for impersonation tokens, and the authenticated user
    otherwise.
    """

    _impersonation = get_impersonation_jwt_strategy()

    async def read_token(
        self,
        token: str | None,
        user_manager: BaseUserManager[User, int],
    ) -> User | None:
        if _peek_is_impersonation(token):
            return await self._impersonation.read_token(token, user_manager)
        return await super().read_token(token, user_manager)


def get_claim_aware_jwt_strategy() -> ClaimAwareJWTStrategy:
    return ClaimAwareJWTStrategy(secret=settings.SECRET_KEY, lifetime_seconds=604800)


auth_backend = AuthenticationBackend(
    name="jwt",
    transport=bearer_transport,
    get_strategy=get_claim_aware_jwt_strategy,
)

# ---------------------------------------------------------------------------
# FastAPIUsers instance
# ---------------------------------------------------------------------------

fastapi_users = FastAPIUsers[User, int](get_user_manager, [auth_backend])

# ---------------------------------------------------------------------------
# Current user dependencies
# ---------------------------------------------------------------------------

current_active_user = fastapi_users.current_user(active=True)

# Optional variant: resolves to the authenticated active user when a valid Bearer
# token is present, or None when the request is anonymous (no 401). Used by the
# guest-aware /auth/google/authorize endpoint so a guest signing in via the plain
# OAuth flow is routed to in-place promotion instead of orphaning their account.
current_active_user_optional = fastapi_users.current_user(active=True, optional=True)

# Used by /admin/* endpoints (D-04/D-05 auth gate).
# Note: when the caller holds an impersonation token, ClaimAwareJWTStrategy
# returns the TARGET (non-superuser) user. The `superuser=True` dep then 403s,
# which naturally enforces D-04 (nested impersonation rejected) without any
# extra raw-token inspection in the endpoint.
current_superuser = fastapi_users.current_user(active=True, superuser=True)
