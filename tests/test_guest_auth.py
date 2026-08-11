"""Integration and unit tests for guest session authentication.

Tests cover:
- Rate limiter unit tests (sliding window, window expiry)
- Guest service unit tests (create_guest_user, refresh_guest_token)
- Guest creation endpoint (201, token auth, rate limiting)
- Guest refresh endpoint (200, rejects non-guests, requires auth)
- Rate limit blocking after 5 requests

NOTE: Guest creation tests write real users to PostgreSQL (no rollback fixture).
      Rate limit test resets the limiter singleton before running to avoid
      pollution from other tests.
"""

import uuid
from unittest.mock import patch

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


# ---------------------------------------------------------------------------
# Rate limiter unit tests
# ---------------------------------------------------------------------------


class TestSlidingWindowRateLimiter:
    def test_allows_up_to_max_requests(self):
        """Rate limiter allows exactly max_requests from the same IP."""
        from app.core.ip_rate_limiter import _SlidingWindowRateLimiter

        limiter = _SlidingWindowRateLimiter(max_requests=5, window_seconds=3600)
        ip = "1.2.3.4"
        for _ in range(5):
            assert limiter.is_allowed(ip) is True
        # 6th request in the same window should be blocked
        assert limiter.is_allowed(ip) is False

    def test_allows_requests_after_window_expiry(self):
        """Rate limiter allows requests again after the sliding window expires."""
        from app.core.ip_rate_limiter import _SlidingWindowRateLimiter

        limiter = _SlidingWindowRateLimiter(max_requests=5, window_seconds=3600)
        ip = "2.3.4.5"

        # Fill up the window by patching time to a fixed moment
        fixed_time = 1000.0
        with patch("app.core.ip_rate_limiter.time") as mock_time:
            mock_time.monotonic.return_value = fixed_time
            for _ in range(5):
                assert limiter.is_allowed(ip) is True
            # Still blocked inside the window
            assert limiter.is_allowed(ip) is False

            # Advance time past the window (3601 seconds later)
            mock_time.monotonic.return_value = fixed_time + 3601
            # Now should be allowed again
            assert limiter.is_allowed(ip) is True


# ---------------------------------------------------------------------------
# Guest service unit tests
# ---------------------------------------------------------------------------


class TestGuestService:
    @pytest.mark.asyncio
    async def test_create_guest_user_returns_user_and_token(self, db_session):
        """create_guest_user returns (User, str) where user.is_guest is True."""
        from app.services.guest_service import create_guest_user

        user, token = await create_guest_user(db_session)
        assert user.is_guest is True
        assert user.email.endswith("@guest.local")
        assert isinstance(token, str)
        assert len(token) > 0

    @pytest.mark.asyncio
    async def test_refresh_guest_token_returns_token(self, db_session):
        """refresh_guest_token returns a non-empty token string for guest users."""
        from app.services.guest_service import create_guest_user, refresh_guest_token

        user, _original_token = await create_guest_user(db_session)
        token = await refresh_guest_token(user)
        assert isinstance(token, str)
        assert len(token) > 0

    @pytest.mark.asyncio
    async def test_refresh_guest_token_rejects_non_guest(self, db_session):
        """refresh_guest_token raises ValueError for non-guest users."""
        from app.services.guest_service import refresh_guest_token
        from app.models.user import User

        regular_user = User(
            email=unique_email("nonguesttest"),
            hashed_password="fakehash",
            is_active=True,
            is_verified=True,
            is_guest=False,
        )
        db_session.add(regular_user)
        await db_session.flush()

        with pytest.raises(ValueError, match="Not a guest user"):
            await refresh_guest_token(regular_user)


# ---------------------------------------------------------------------------
# Guest creation endpoint tests
# ---------------------------------------------------------------------------


class TestGuestCreate:
    @pytest.mark.asyncio
    async def test_create_guest_returns_201_with_token(self):
        """POST /auth/guest/create returns 201 with access_token, token_type, is_guest."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/auth/guest/create")

        assert resp.status_code == 201
        data = resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["is_guest"] is True

    @pytest.mark.asyncio
    async def test_guest_token_authenticates_openings(self):
        """Guest token is accepted by POST /openings/positions (GUEST-03)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            create_resp = await client.post("/api/auth/guest/create")
            token = create_resp.json()["access_token"]

            resp = await client.post(
                "/api/openings/positions",
                json={"target_hash": 0},
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_guest_token_authenticates_imports(self):
        """Guest token is accepted by GET /imports (GUEST-03)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            create_resp = await client.post("/api/auth/guest/create")
            token = create_resp.json()["access_token"]

            resp = await client.get(
                "/api/imports",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_guest_token_authenticates_endgame(self):
        """Guest token is accepted by GET /stats/endgame-types (GUEST-03)."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            create_resp = await client.post("/api/auth/guest/create")
            token = create_resp.json()["access_token"]

            resp = await client.get(
                "/api/stats/endgame-types",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code != 401


# ---------------------------------------------------------------------------
# Guest refresh endpoint tests
# ---------------------------------------------------------------------------


class TestGuestRefresh:
    @pytest.mark.asyncio
    async def test_refresh_returns_new_token(self):
        """POST /auth/guest/refresh with guest JWT returns 200 with a fresh access_token."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            create_resp = await client.post("/api/auth/guest/create")
            original_token = create_resp.json()["access_token"]

            # Wait a moment so exp timestamps differ (JWTs are issued at iat=now)
            # Note: we don't sleep — we just check the response, not equality
            refresh_resp = await client.post(
                "/api/auth/guest/refresh",
                headers={"Authorization": f"Bearer {original_token}"},
            )

        assert refresh_resp.status_code == 200
        data = refresh_resp.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"

    @pytest.mark.asyncio
    async def test_refresh_rejects_non_guest_user(self):
        """POST /auth/guest/refresh with a regular user token returns 403."""
        email = unique_email("nonguestrefresh")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")
            login_resp = await login_user(client, email, "password123")
            token = login_resp.json()["access_token"]

            resp = await client.post(
                "/api/auth/guest/refresh",
                headers={"Authorization": f"Bearer {token}"},
            )

        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_refresh_requires_auth(self):
        """POST /auth/guest/refresh without Authorization header returns 401."""
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/auth/guest/refresh")

        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Rate limiting integration tests
# ---------------------------------------------------------------------------


class TestGuestRateLimit:
    @pytest.mark.asyncio
    async def test_rate_limit_blocks_after_5_creates(self):
        """POST /auth/guest/create returns 429 on the 6th request from the same IP."""
        from app.core.ip_rate_limiter import guest_create_limiter

        # Reset limiter state to avoid pollution from other tests
        guest_create_limiter._timestamps.clear()

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            results = []
            for _ in range(6):
                resp = await client.post("/api/auth/guest/create")
                results.append(resp.status_code)

        # First 5 should succeed, 6th should be rate limited
        assert results[:5] == [201, 201, 201, 201, 201]
        assert results[5] == 429


# ---------------------------------------------------------------------------
# promote_guest_with_password service unit tests (TDD RED)
# ---------------------------------------------------------------------------


class TestPromoteGuestWithPassword:
    @pytest.mark.asyncio
    async def test_promotion_updates_user_fields(self, db_session):
        """promote_guest_with_password updates is_guest, email, is_verified in DB."""
        from app.services.guest_service import create_guest_user, promote_guest_with_password

        user, _token = await create_guest_user(db_session)
        new_email = unique_email("promoted")
        updated_user, _new_token = await promote_guest_with_password(
            db_session, user, new_email, "SecurePass1!"
        )

        assert updated_user.is_guest is False
        assert updated_user.email == new_email
        assert updated_user.is_verified is True

    @pytest.mark.asyncio
    async def test_promotion_hashes_password(self, db_session):
        """promote_guest_with_password stores a non-empty hashed_password (not plaintext)."""
        from app.services.guest_service import create_guest_user, promote_guest_with_password

        user, _token = await create_guest_user(db_session)
        new_email = unique_email("hashtest")
        updated_user, _new_token = await promote_guest_with_password(
            db_session, user, new_email, "SecurePass1!"
        )

        assert updated_user.hashed_password != ""
        assert updated_user.hashed_password != "SecurePass1!"

    @pytest.mark.asyncio
    async def test_promotion_returns_7day_jwt(self, db_session):
        """promote_guest_with_password returns a non-empty JWT string."""
        from app.services.guest_service import create_guest_user, promote_guest_with_password

        user, _token = await create_guest_user(db_session)
        new_email = unique_email("jwttest")
        _updated_user, new_token = await promote_guest_with_password(
            db_session, user, new_email, "SecurePass1!"
        )

        assert isinstance(new_token, str)
        assert len(new_token) > 0

    @pytest.mark.asyncio
    async def test_promotion_raises_user_already_exists_on_email_conflict(self, db_session):
        """promote_guest_with_password raises UserAlreadyExists when email is taken."""
        from fastapi_users.exceptions import UserAlreadyExists

        from app.models.user import User
        from app.services.guest_service import create_guest_user, promote_guest_with_password

        existing_email = unique_email("existing")
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
            await promote_guest_with_password(
                db_session, guest_user, existing_email, "SecurePass1!"
            )

    @pytest.mark.asyncio
    async def test_promotion_raises_value_error_for_non_guest(self, db_session):
        """promote_guest_with_password raises ValueError for non-guest users."""
        from app.models.user import User
        from app.services.guest_service import promote_guest_with_password

        regular_user = User(
            email=unique_email("nonguestpromote"),
            hashed_password="fakehash",
            is_active=True,
            is_verified=True,
            is_guest=False,
        )
        db_session.add(regular_user)
        await db_session.flush()

        with pytest.raises(ValueError, match="Not a guest user"):
            await promote_guest_with_password(
                db_session, regular_user, unique_email("target"), "SecurePass1!"
            )

    @pytest.mark.asyncio
    async def test_promotion_hashes_off_the_event_loop_thread(self, db_session, monkeypatch):
        """SURGE-02: the argon2 hash call runs on a worker thread, not the event loop.

        Reverting the asyncio.to_thread wrap in promote_guest_with_password makes
        the recorded thread id equal the test's own thread id, failing this test.
        """
        import threading

        from app.services import guest_service
        from app.services.guest_service import create_guest_user, promote_guest_with_password

        main_thread_id = threading.get_ident()
        observed_thread_id: list[int] = []

        def spy_hash(password: str) -> str:
            observed_thread_id.append(threading.get_ident())
            return "irrelevant-hash"

        monkeypatch.setattr(guest_service._password_helper, "hash", spy_hash)

        user, _token = await create_guest_user(db_session)
        await promote_guest_with_password(
            db_session, user, unique_email("threadtest"), "SecurePass1!"
        )

        assert observed_thread_id, "hash was never called"
        assert observed_thread_id[0] != main_thread_id, (
            "hash ran on the event-loop thread — asyncio.to_thread wrap is missing/reverted"
        )

    @pytest.mark.asyncio
    async def test_second_promotion_of_the_same_user_raises(self, db_session):
        """Promoting an already-promoted user again raises ValueError('Not a guest user').

        Moving the hash off the loop must not change the idempotency contract.
        """
        from app.services.guest_service import create_guest_user, promote_guest_with_password

        user, _token = await create_guest_user(db_session)
        first_email = unique_email("firstpromo")
        updated_user, _token = await promote_guest_with_password(
            db_session, user, first_email, "SecurePass1!"
        )

        with pytest.raises(ValueError, match="Not a guest user"):
            await promote_guest_with_password(
                db_session, updated_user, unique_email("secondpromo"), "AnotherPass1!"
            )

    @pytest.mark.asyncio
    async def test_concurrent_promotions_of_two_guests_produce_distinct_hashes(self, test_engine):
        """Two different guests promoted concurrently each get a distinct, verifying hash.

        Uses the real hasher (no monkeypatch) to also prove the algorithm was not
        swapped by the to_thread wrap. The module-level _password_helper carries
        no mutable state, so concurrent to_thread calls do not interfere.

        CLAUDE.md forbids asyncio.gather on the same AsyncSession — each guest is
        created and promoted through its own independent session (own connection),
        so the two promote_guest_with_password calls genuinely run concurrently
        without sharing a session.
        """
        import asyncio

        from fastapi_users.password import PasswordHelper
        from sqlalchemy.ext.asyncio import async_sessionmaker

        from app.services.guest_service import create_guest_user, promote_guest_with_password

        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        password_one = "SecurePassOne1!"
        password_two = "SecurePassTwo2!"

        async def _create_and_promote(password: str, email_prefix: str) -> str:
            async with session_maker() as session:
                user, _token = await create_guest_user(session)
                updated, _new_token = await promote_guest_with_password(
                    session, user, unique_email(email_prefix), password
                )
                return updated.hashed_password

        hash_one, hash_two = await asyncio.gather(
            _create_and_promote(password_one, "concurrent1"),
            _create_and_promote(password_two, "concurrent2"),
        )

        assert hash_one
        assert hash_two
        assert hash_one != hash_two

        verifier = PasswordHelper()
        valid1, _ = verifier.verify_and_update(password_one, hash_one)
        valid2, _ = verifier.verify_and_update(password_two, hash_two)
        assert valid1, "guest_one's password does not verify against its stored hash"
        assert valid2, "guest_two's password does not verify against its stored hash"


# ---------------------------------------------------------------------------
# POST /auth/guest/promote/email endpoint integration tests
# ---------------------------------------------------------------------------


class TestGuestPromotion:
    def setup_method(self) -> None:
        """Reset rate limiter before each test to prevent cross-test 429 errors."""
        from app.core.ip_rate_limiter import guest_create_limiter

        guest_create_limiter._timestamps.clear()

    @pytest.mark.asyncio
    async def test_promotion_succeeds(self):
        """POST /auth/guest/promote/email returns 200 with access_token; profile shows is_guest=False."""
        new_email = unique_email("promosuccess")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            guest_resp = await client.post("/api/auth/guest/create")
            assert guest_resp.status_code == 201
            guest_token = guest_resp.json()["access_token"]

            promo_resp = await client.post(
                "/api/auth/guest/promote/email",
                json={"email": new_email, "password": "TestPass123!"},
                headers={"Authorization": f"Bearer {guest_token}"},
            )
            assert promo_resp.status_code == 200
            promo_data = promo_resp.json()
            assert "access_token" in promo_data
            assert promo_data["token_type"] == "bearer"

            new_token = promo_data["access_token"]
            profile_resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {new_token}"},
            )
            assert profile_resp.status_code == 200
            profile = profile_resp.json()
            assert profile["is_guest"] is False
            assert profile["email"] == new_email

    @pytest.mark.asyncio
    async def test_promotion_email_conflict(self):
        """POST /auth/guest/promote/email returns 409 with EMAIL_ALREADY_REGISTERED."""
        existing_email = unique_email("existingpromo")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            # Register a normal user with that email
            await register_user(client, existing_email, "password123")

            # Create a guest and try to promote with the taken email
            guest_resp = await client.post("/api/auth/guest/create")
            guest_token = guest_resp.json()["access_token"]

            promo_resp = await client.post(
                "/api/auth/guest/promote/email",
                json={"email": existing_email, "password": "TestPass123!"},
                headers={"Authorization": f"Bearer {guest_token}"},
            )
            assert promo_resp.status_code == 409
            assert promo_resp.json()["detail"] == "EMAIL_ALREADY_REGISTERED"

    @pytest.mark.asyncio
    async def test_promotion_requires_guest(self):
        """POST /auth/guest/promote/email returns 403 for non-guest authenticated user."""
        email = unique_email("nonguestendpoint")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            await register_user(client, email, "password123")
            login_resp = await login_user(client, email, "password123")
            token = login_resp.json()["access_token"]

            promo_resp = await client.post(
                "/api/auth/guest/promote/email",
                json={"email": unique_email("target"), "password": "TestPass123!"},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert promo_resp.status_code == 403

    @pytest.mark.asyncio
    async def test_data_preserved_after_promotion(self):
        """Promotion keeps the same user row (in-place update), verified via created_at timestamp."""
        new_email = unique_email("datapreserved")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            guest_resp = await client.post("/api/auth/guest/create")
            guest_token = guest_resp.json()["access_token"]

            # Capture created_at before promotion as identity proxy
            before_resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {guest_token}"},
            )
            assert before_resp.status_code == 200
            created_at_before = before_resp.json()["created_at"]

            promo_resp = await client.post(
                "/api/auth/guest/promote/email",
                json={"email": new_email, "password": "TestPass123!"},
                headers={"Authorization": f"Bearer {guest_token}"},
            )
            assert promo_resp.status_code == 200
            new_token = promo_resp.json()["access_token"]

            after_resp = await client.get(
                "/api/users/me/profile",
                headers={"Authorization": f"Bearer {new_token}"},
            )
            assert after_resp.status_code == 200
            created_at_after = after_resp.json()["created_at"]

            # Same created_at proves it's the same row (updated in-place, not a new user)
            assert created_at_before == created_at_after

    @pytest.mark.asyncio
    async def test_promoted_user_can_login_with_password(self):
        """After promotion, user can log in via /auth/jwt/login with new email and password."""
        new_email = unique_email("loginafterpromo")
        password = "TestPass123!"
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            guest_resp = await client.post("/api/auth/guest/create")
            guest_token = guest_resp.json()["access_token"]

            promo_resp = await client.post(
                "/api/auth/guest/promote/email",
                json={"email": new_email, "password": password},
                headers={"Authorization": f"Bearer {guest_token}"},
            )
            assert promo_resp.status_code == 200

            login_resp = await login_user(client, new_email, password)
            assert login_resp.status_code == 200
            assert "access_token" in login_resp.json()
