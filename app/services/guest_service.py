"""Guest user creation and token refresh service.

Provides functions to create anonymous guest accounts and issue/refresh
their 30-day JWT tokens. Guest accounts have sentinel emails in the form
`guest_<uuid>@guest.local` and are marked with `is_guest=True`.
"""

import asyncio
from uuid import uuid4

from fastapi_users.exceptions import UserAlreadyExists
from fastapi_users.password import PasswordHelper
from sqlalchemy import func, select
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.oauth_account import OAuthAccount
from app.models.user import User
from app.users import auth_backend, get_guest_jwt_strategy

_GUEST_EMAIL_DOMAIN = "@guest.local"

_password_helper = PasswordHelper()


async def create_guest_user(session: AsyncSession) -> tuple[User, str]:
    """Create an anonymous guest user and return (user, jwt_token).

    The guest account is created with:
    - A sentinel email: guest_<uuid>@guest.local
    - An empty hashed_password (guest accounts cannot log in with a password)
    - is_active=True, is_verified=True so the JWT is accepted by current_active_user
    - is_guest=True to distinguish from registered users

    Returns a (User, token) tuple where token is a 30-day Bearer JWT.
    """
    email = f"guest_{uuid4().hex}{_GUEST_EMAIL_DOMAIN}"
    user = User(
        email=email,
        hashed_password="",
        is_active=True,
        is_verified=True,
        is_superuser=False,
        is_guest=True,
        last_login=func.now(),
    )
    session.add(user)
    await session.flush()
    await session.commit()

    token: str = await get_guest_jwt_strategy().write_token(user)
    return user, token


async def refresh_guest_token(user: User) -> str:
    """Issue a fresh 30-day JWT for a guest user.

    Raises ValueError if the user is not a guest — callers must check is_guest
    before calling this function (or catch the error for a 403 response).
    """
    if not user.is_guest:
        raise ValueError("Not a guest user")

    token: str = await get_guest_jwt_strategy().write_token(user)
    return token


async def promote_guest_with_password(
    session: AsyncSession,
    user: User,
    email: str,
    password: str,
) -> tuple[User, str]:
    """Promote a guest account to a full email/password account in-place.

    Updates the user row: sets is_guest=False, is_verified=True, stores the new
    email and an argon2id-hashed password. Issues a standard 7-day JWT via
    auth_backend (not the guest 30-day strategy).

    Raises:
        ValueError: if the user is not a guest
        UserAlreadyExists: if the given email is already registered by another user
    """
    if not user.is_guest:
        raise ValueError("Not a guest user")

    # Check email uniqueness before updating
    result = await session.execute(
        select(User).where(User.email == email)  # ty: ignore[invalid-argument-type]  # SQLAlchemy column comparisons return ColumnElement, not bool
    )
    if result.unique().scalar_one_or_none() is not None:
        raise UserAlreadyExists()

    # SURGE-02 (Phase 209): the measured 65.9ms argon2id hash previously ran
    # synchronously on the single event loop, freezing every other request for
    # its duration. Moving it to a worker thread lets other requests proceed
    # while this one hashes. The algorithm and cost parameters are unchanged —
    # only the thread the call runs on changes.
    hashed_password = await asyncio.to_thread(_password_helper.hash, password)

    await session.execute(
        sa_update(User)
        .where(User.id == user.id)
        .values(
            email=email,
            hashed_password=hashed_password,
            is_guest=False,
            is_verified=True,
        )
    )
    await session.commit()

    # Re-fetch the updated user so callers see current field values
    # session.get returns User | None, but we just committed the update so the user exists
    updated = await session.get(User, user.id)
    assert updated is not None, f"User {user.id} not found after promotion commit"

    # Issue a standard 7-day JWT (not the guest 30-day strategy)
    strategy = auth_backend.get_strategy()
    token: str = await strategy.write_token(updated)  # ty: ignore[unresolved-attribute]  # FastAPI-Users generic typing not resolved by ty beta

    return updated, token


async def promote_guest_with_google(
    session: AsyncSession,
    user: User,
    account_id: str,
    account_email: str,
    access_token: str,
    expires_at: int | None,
    refresh_token: str | None,
) -> tuple[User, str]:
    """Promote a guest account to a Google-linked full account in-place.

    Updates the user row: sets is_guest=False, is_verified=True, stores the Google
    email, and clears hashed_password (Google users authenticate via OAuth only).
    Inserts an OAuthAccount row linking the Google account to this user's ID.
    Issues a standard 7-day JWT via auth_backend.

    Raises:
        ValueError: if the user is not a guest
        UserAlreadyExists: if account_email is already registered by another user
    """
    if not user.is_guest:
        raise ValueError("Not a guest user")

    # Check email uniqueness before updating — prevent silent account merge
    result = await session.execute(
        select(User).where(User.email == account_email)  # ty: ignore[invalid-argument-type]  # SQLAlchemy column comparisons return ColumnElement, not bool
    )
    existing = result.unique().scalar_one_or_none()
    if existing is not None and existing.id != user.id:
        raise UserAlreadyExists()

    await session.execute(
        sa_update(User)
        .where(User.id == user.id)
        .values(
            email=account_email,
            hashed_password="",  # Google users have no password
            is_guest=False,
            is_verified=True,
        )
    )

    # Link Google OAuthAccount to this user's row
    # Wrap in try/except IntegrityError to handle double-submit race condition:
    # if two promotion requests race, the second INSERT may violate an index;
    # treat it as idempotent since the user row is already promoted.
    oauth_account = OAuthAccount(
        oauth_name="google",
        access_token=access_token,
        expires_at=expires_at,
        refresh_token=refresh_token,
        account_id=account_id,
        account_email=account_email,
        user_id=user.id,
    )
    session.add(oauth_account)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # Row already exists from a concurrent request — promotion is idempotent

    # Re-fetch the updated user so callers see current field values
    updated = await session.get(User, user.id)
    assert updated is not None, f"User {user.id} not found after Google promotion commit"

    # Issue a standard 7-day JWT (not the guest 30-day strategy)
    strategy = auth_backend.get_strategy()
    token: str = await strategy.write_token(updated)  # ty: ignore[unresolved-attribute]  # FastAPI-Users generic typing not resolved by ty beta

    return updated, token
