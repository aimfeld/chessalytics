"""Tests for the Train reminder scheduler (Phase 201, REMIND-02..07).

Covers:
- TestListReminderCandidateUserIds / TestClaimReminderDay /
  TestHasCompletedSessionOn (Task 1): app.repositories.train_reminder_repository's
  SQL, using the ordinary rollback-scoped `db_session` fixture (no cross-
  connection visibility needed for these).
- Everything below TestTickInterval (Task 2): app.services.train_reminder_service's
  per-candidate eligibility loop, settle-before-copy, and claim-then-send
  fan-out, using a REAL (non-savepoint) session maker patched onto
  `train_reminder_service.async_session_maker` -- `send_due_reminders` opens
  its OWN session per candidate (mirrors `guest_cleanup_service._purge_guest`),
  so test data must be committed for real on a connection that job can see.
  Mirrors tests/test_guest_cleanup_service.py's `real_session_maker` fixture
  and its rationale verbatim.

Mocking: most tests patch `train_reminder_service.push_send.send_to_user`
directly (isolates the eligibility logic under test from the real send path,
already proven in tests/test_push_send.py). The two TestFanOut tests instead
patch `httpx.AsyncClient.post` and drive REAL aes128gcm encryption over real
EC subscription keys, to prove `send_due_reminders`' single call into
`push_send.send_to_user` really does fan out to every subscription -- mirrors
tests/routers/test_push.py's patch-the-outbound-client idiom.
"""

from __future__ import annotations

import base64
import datetime
import logging
import os
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.services.train_reminder_service as train_reminder_service
from app.core.config import settings as config_settings
from app.models.drill_session import DrillSession
from app.models.push_subscription import PushSubscription
from app.models.train_settings import TrainSettings
from app.models.user import User
from app.repositories import train_reminder_repository
from app.services import push_send
from app.services.train_scheduler import ALL_WEEKDAYS_MASK
from tests.conftest import ensure_test_user

_USER_ID = 93400
_TODAY = datetime.date(2026, 1, 15)

# 2026-08-01 is a Saturday (weekday() == 5) -- used by TestScheduledDay to
# build a mask that deliberately excludes it.
_NOW = datetime.datetime(2026, 8, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)


def _fresh_subscription_keys() -> tuple[str, str]:
    """A real EC public key + random secret, base64url-encoded (no padding).

    Mirrors tests/test_push_send.py's helper of the same name -- needed
    because our aes128gcm encryption requires an actual valid P-256
    point, not an arbitrary string.
    """
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    p256dh = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode()
    auth = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
    return p256dh, auth


# ---------------------------------------------------------------------------
# Task 1: app.repositories.train_reminder_repository
# ---------------------------------------------------------------------------


class TestListReminderCandidateUserIds:
    async def test_includes_enabled_user_with_subscription(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=True, reminder_hour=18))
        db_session.add(
            PushSubscription(user_id=_USER_ID, endpoint="https://x/1", p256dh="p", auth="a")
        )
        await db_session.flush()

        ids = await train_reminder_repository.list_reminder_candidate_user_ids(db_session)
        assert _USER_ID in ids

    async def test_excludes_reminder_disabled_user(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=False, reminder_hour=18))
        db_session.add(
            PushSubscription(user_id=_USER_ID, endpoint="https://x/2", p256dh="p", auth="a")
        )
        await db_session.flush()

        ids = await train_reminder_repository.list_reminder_candidate_user_ids(db_session)
        assert _USER_ID not in ids

    async def test_excludes_user_with_zero_subscriptions(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=True, reminder_hour=18))
        await db_session.flush()

        ids = await train_reminder_repository.list_reminder_candidate_user_ids(db_session)
        assert _USER_ID not in ids

    async def test_guest_excluded_even_with_reminder_enabled_forced_true(
        self, db_session: AsyncSession
    ) -> None:
        """REMIND-07: a guest can never appear in the candidate set, even when
        reminder_enabled is forced True directly at the DB layer, bypassing
        the /train/* 403 gate entirely."""
        await ensure_test_user(db_session, _USER_ID)
        await db_session.execute(update(User).where(User.id == _USER_ID).values(is_guest=True))
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=True, reminder_hour=18))
        db_session.add(
            PushSubscription(user_id=_USER_ID, endpoint="https://x/3", p256dh="p", auth="a")
        )
        await db_session.flush()

        ids = await train_reminder_repository.list_reminder_candidate_user_ids(db_session)
        assert _USER_ID not in ids

    async def test_includes_user_whose_reminder_last_sent_on_equals_current_date(
        self, db_session: AsyncSession
    ) -> None:
        """No SQL-side date predicate (D-16): the query returns this user
        regardless of what reminder_last_sent_on holds -- the per-user claim
        UPDATE is the real guard, not this scan."""
        await ensure_test_user(db_session, _USER_ID)
        today = (await db_session.execute(select(func.current_date()))).scalar_one()
        db_session.add(
            TrainSettings(
                user_id=_USER_ID,
                reminder_enabled=True,
                reminder_hour=18,
                reminder_last_sent_on=today,
            )
        )
        db_session.add(
            PushSubscription(user_id=_USER_ID, endpoint="https://x/4", p256dh="p", auth="a")
        )
        await db_session.flush()

        ids = await train_reminder_repository.list_reminder_candidate_user_ids(db_session)
        assert _USER_ID in ids


class TestClaimReminderDay:
    async def test_claims_when_null(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=True, reminder_hour=18))
        await db_session.flush()

        claimed = await train_reminder_repository.claim_reminder_day(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert claimed is True

    async def test_claims_when_earlier(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            TrainSettings(
                user_id=_USER_ID,
                reminder_enabled=True,
                reminder_hour=18,
                reminder_last_sent_on=_TODAY - datetime.timedelta(days=1),
            )
        )
        await db_session.flush()

        claimed = await train_reminder_repository.claim_reminder_day(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert claimed is True

    async def test_does_not_claim_when_equal(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            TrainSettings(
                user_id=_USER_ID,
                reminder_enabled=True,
                reminder_hour=18,
                reminder_last_sent_on=_TODAY,
            )
        )
        await db_session.flush()

        claimed = await train_reminder_repository.claim_reminder_day(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert claimed is False
        row = (
            await db_session.execute(
                select(TrainSettings.reminder_last_sent_on).where(TrainSettings.user_id == _USER_ID)
            )
        ).scalar_one()
        assert row == _TODAY

    async def test_two_sequential_committed_calls_yield_exactly_one_true_idempotent(
        self, db_session: AsyncSession
    ) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=True, reminder_hour=18))
        await db_session.commit()

        first = await train_reminder_repository.claim_reminder_day(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        await db_session.commit()
        second = await train_reminder_repository.claim_reminder_day(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        await db_session.commit()

        assert (first, second) == (True, False)
        row = (
            await db_session.execute(
                select(TrainSettings.reminder_last_sent_on).where(TrainSettings.user_id == _USER_ID)
            )
        ).scalar_one()
        assert row == _TODAY


class TestReleaseReminderClaim:
    """release_reminder_claim: Phase 204 D3/D-13/D-14. Mirrors TestClaimReminderDay's shape."""

    async def test_releases_when_equal_to_today(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            TrainSettings(
                user_id=_USER_ID,
                reminder_enabled=True,
                reminder_hour=18,
                reminder_last_sent_on=_TODAY,
            )
        )
        await db_session.flush()

        released = await train_reminder_repository.release_reminder_claim(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert released is True
        row = (
            await db_session.execute(
                select(TrainSettings.reminder_last_sent_on).where(TrainSettings.user_id == _USER_ID)
            )
        ).scalar_one()
        assert row is None

    async def test_does_not_release_when_earlier_date(self, db_session: AsyncSession) -> None:
        """D-14 guard: stands in for 'a second ticker already claimed a later
        day' -- the release must never touch a claim it did not itself make
        this tick."""
        earlier = _TODAY - datetime.timedelta(days=1)
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            TrainSettings(
                user_id=_USER_ID,
                reminder_enabled=True,
                reminder_hour=18,
                reminder_last_sent_on=earlier,
            )
        )
        await db_session.flush()

        released = await train_reminder_repository.release_reminder_claim(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert released is False
        row = (
            await db_session.execute(
                select(TrainSettings.reminder_last_sent_on).where(TrainSettings.user_id == _USER_ID)
            )
        ).scalar_one()
        assert row == earlier

    async def test_does_not_release_when_null(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(TrainSettings(user_id=_USER_ID, reminder_enabled=True, reminder_hour=18))
        await db_session.flush()

        released = await train_reminder_repository.release_reminder_claim(
            db_session, user_id=_USER_ID, today=_TODAY
        )
        assert released is False


class TestHasCompletedSessionOn:
    async def test_true_for_completed_session_same_date(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            DrillSession(
                user_id=_USER_ID,
                session_date=_TODAY,
                status="completed",
                puzzle_count=1,
                expires_on=_TODAY + datetime.timedelta(days=1),
                completed_at=datetime.datetime.now(datetime.timezone.utc),
            )
        )
        await db_session.flush()

        result = await train_reminder_repository.has_completed_session_on(
            db_session, user_id=_USER_ID, day=_TODAY
        )
        assert result is True

    async def test_false_when_completed_at_null(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            DrillSession(
                user_id=_USER_ID,
                session_date=_TODAY,
                status="open",
                puzzle_count=1,
                expires_on=_TODAY + datetime.timedelta(days=1),
                completed_at=None,
            )
        )
        await db_session.flush()

        result = await train_reminder_repository.has_completed_session_on(
            db_session, user_id=_USER_ID, day=_TODAY
        )
        assert result is False

    async def test_false_when_date_differs(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _USER_ID)
        db_session.add(
            DrillSession(
                user_id=_USER_ID,
                session_date=_TODAY - datetime.timedelta(days=1),
                status="completed",
                puzzle_count=1,
                expires_on=_TODAY,
                completed_at=datetime.datetime.now(datetime.timezone.utc),
            )
        )
        await db_session.flush()

        result = await train_reminder_repository.has_completed_session_on(
            db_session, user_id=_USER_ID, day=_TODAY
        )
        assert result is False


# ---------------------------------------------------------------------------
# Task 2: app.services.train_reminder_service
# ---------------------------------------------------------------------------


@pytest.fixture
def real_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """A genuine (non-savepoint) sessionmaker bound to the per-run test DB.

    Mirrors tests/test_guest_cleanup_service.py's fixture of the same name:
    `send_due_reminders` opens its OWN session per candidate via
    `async_session_maker()`, on a separate physical connection -- test data
    it must see has to be committed for real, not rolled back at teardown.
    """
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
def _patch_reminder_session_maker(
    real_session_maker: async_sessionmaker[AsyncSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Route train_reminder_service's OWN async_session_maker() opens to the test DB."""
    monkeypatch.setattr(train_reminder_service, "async_session_maker", real_session_maker)


@pytest.fixture(autouse=True)
async def _cleanup_leaked_users(real_session_maker: async_sessionmaker[AsyncSession]):
    """Delete any User rows committed during a test so they don't pollute later tests.

    Mirrors tests/test_guest_cleanup_service.py's `_cleanup_leaked_guest_rows`.
    Deleting the User CASCADEs train_settings/push_subscriptions/drill_sessions.
    """

    async def _user_ids() -> set[int]:
        async with real_session_maker() as session:
            rows = await session.execute(select(User.id))
            return set(rows.scalars().all())

    before = await _user_ids()
    yield
    leaked = await _user_ids() - before
    if leaked:
        async with real_session_maker() as session:
            await session.execute(delete(User).where(User.id.in_(leaked)))
            await session.commit()


async def _create_committed_user(
    session_maker: async_sessionmaker[AsyncSession], *, is_guest: bool = False
) -> int:
    async with session_maker() as session:
        user = User(
            email=f"reminder-{uuid.uuid4()}@example.com", hashed_password="x", is_guest=is_guest
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user.id


async def _seed_committed_settings(
    session_maker: async_sessionmaker[AsyncSession],
    *,
    user_id: int,
    reminder_enabled: bool = True,
    reminder_hour: int = 10,
    weekday_mask: int = ALL_WEEKDAYS_MASK,
    timezone: str = "UTC",
    reminder_last_sent_on: datetime.date | None = None,
    streak_count: int = 0,
    shield_level: int = 0,
    streak_settled_through: datetime.date | None = None,
    pool_eligible_since: datetime.date | None = None,
) -> None:
    async with session_maker() as session:
        session.add(
            TrainSettings(
                user_id=user_id,
                timezone=timezone,
                weekday_mask=weekday_mask,
                reminder_enabled=reminder_enabled,
                reminder_hour=reminder_hour,
                reminder_last_sent_on=reminder_last_sent_on,
                streak_count=streak_count,
                shield_level=shield_level,
                streak_settled_through=streak_settled_through,
                pool_eligible_since=pool_eligible_since,
            )
        )
        await session.commit()


async def _seed_committed_subscription(
    session_maker: async_sessionmaker[AsyncSession], *, user_id: int
) -> None:
    p256dh, auth = _fresh_subscription_keys()
    async with session_maker() as session:
        session.add(
            PushSubscription(
                user_id=user_id,
                endpoint=f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4()}",
                p256dh=p256dh,
                auth=auth,
            )
        )
        await session.commit()


async def _seed_committed_drill_session(
    session_maker: async_sessionmaker[AsyncSession],
    *,
    user_id: int,
    session_date: datetime.date,
    completed: bool,
) -> None:
    async with session_maker() as session:
        session.add(
            DrillSession(
                user_id=user_id,
                session_date=session_date,
                status="completed" if completed else "open",
                puzzle_count=1,
                expires_on=session_date + datetime.timedelta(days=1),
                completed_at=(datetime.datetime.now(datetime.timezone.utc) if completed else None),
            )
        )
        await session.commit()


async def _seed_ready_candidate(
    session_maker: async_sessionmaker[AsyncSession],
    *,
    reminder_hour: int = 10,
    reminder_last_sent_on: datetime.date | None = None,
    weekday_mask: int = ALL_WEEKDAYS_MASK,
    streak_count: int = 0,
    shield_level: int = 0,
    streak_settled_through: datetime.date | None = None,
    pool_eligible_since: datetime.date | None = None,
    is_guest: bool = False,
    n_subscriptions: int = 1,
) -> int:
    """Seed a fully-eligible candidate (all gates open at `_NOW`, hour 12 UTC).

    Default reminder_hour=10 (<=12) and weekday_mask=ALL_WEEKDAYS_MASK (2026-08-01
    is a Saturday, included) so a caller only overrides what a given test needs
    to vary.
    """
    user_id = await _create_committed_user(session_maker, is_guest=is_guest)
    await _seed_committed_settings(
        session_maker,
        user_id=user_id,
        reminder_hour=reminder_hour,
        weekday_mask=weekday_mask,
        reminder_last_sent_on=reminder_last_sent_on,
        streak_count=streak_count,
        shield_level=shield_level,
        streak_settled_through=streak_settled_through,
        pool_eligible_since=pool_eligible_since,
    )
    for _ in range(n_subscriptions):
        await _seed_committed_subscription(session_maker, user_id=user_id)
    return user_id


def _mock_send_to_user(*, attempted: int = 1, pruned: int = 0, failed: int = 0):
    result = push_send.PushFanoutResult(attempted=attempted, pruned=pruned, failed=failed)
    return patch(
        "app.services.train_reminder_service.push_send.send_to_user",
        new=AsyncMock(return_value=result),
    )


@pytest.fixture
def vapid_keypair(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure a real VAPID keypair for the duration of one test (fan-out tests only)."""
    from app.services.push_crypto import generate_keypair

    private_key, public_key, _application_server_key = generate_keypair()
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", private_key.decode())
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", public_key.decode())


class TestTickInterval:
    def test_tick_interval_at_least_15_minutes(self) -> None:
        assert train_reminder_service._REMINDER_TICK_INTERVAL_SECONDS >= 900


class TestZeroCandidates:
    async def test_zero_candidates_returns_all_zero_summary_and_no_post(self) -> None:
        with patch("app.services.train_reminder_service.push_send.send_to_user") as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_not_called()
        assert summary == train_reminder_service.ReminderTickSummary(
            scanned=0, eligible=0, claimed=0, sent=0, pruned=0, failed=0
        )


class TestOneCandidateHappyPath:
    async def test_one_candidate_one_subscription_sends_and_claims(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_ready_candidate(real_session_maker)
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_awaited_once()
        assert summary.scanned == 1
        assert summary.eligible == 1
        assert summary.claimed == 1
        assert summary.sent == 1

        async with real_session_maker() as session:
            row = (
                await session.execute(
                    select(TrainSettings.reminder_last_sent_on).where(
                        TrainSettings.user_id == user_id
                    )
                )
            ).scalar_one()
        assert row == datetime.date(2026, 8, 1)


class TestScheduledDay:
    async def test_unscheduled_weekday_is_skipped(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        # 2026-08-01 is a Saturday (weekday() == 5); exclude it from the mask.
        mask = ALL_WEEKDAYS_MASK & ~(1 << datetime.date(2026, 8, 1).weekday())
        await _seed_ready_candidate(real_session_maker, weekday_mask=mask)
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_not_called()
        assert summary.claimed == 0

    async def test_zero_weekday_mask_is_skipped_on_every_day_scheduled_day(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """The `<open_decisions_resolved>` resolution: a reminder never fires
        for a `weekday_mask == 0` ("train anytime") user."""
        await _seed_ready_candidate(real_session_maker, weekday_mask=0)
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_not_called()
        assert summary.claimed == 0


class TestHourBoundary:
    async def test_hour_minus_one_is_skipped(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_ready_candidate(real_session_maker, reminder_hour=13)  # _NOW hour is 12
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_not_called()
        assert summary.claimed == 0

    async def test_hour_equal_fires(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_ready_candidate(real_session_maker, reminder_hour=12)
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_awaited_once()
        assert summary.claimed == 1

    async def test_hour_plus_three_still_fires_catch_up(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_ready_candidate(real_session_maker, reminder_hour=9)  # 12 >= 9 + 3
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_awaited_once()
        assert summary.claimed == 1


class TestAlreadyTrained:
    async def test_already_trained_completed_session_suppressed_and_day_not_claimed(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_ready_candidate(real_session_maker)
        await _seed_committed_drill_session(
            real_session_maker,
            user_id=user_id,
            session_date=datetime.date(2026, 8, 1),
            completed=True,
        )
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_not_called()
        assert summary.claimed == 0

        async with real_session_maker() as session:
            row = (
                await session.execute(
                    select(TrainSettings.reminder_last_sent_on).where(
                        TrainSettings.user_id == user_id
                    )
                )
            ).scalar_one()
        assert row is None

    async def test_already_trained_open_session_still_sends(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        user_id = await _seed_ready_candidate(real_session_maker)
        await _seed_committed_drill_session(
            real_session_maker,
            user_id=user_id,
            session_date=datetime.date(2026, 8, 1),
            completed=False,
        )
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_awaited_once()
        assert summary.claimed == 1


class TestIdempotency:
    async def test_reminder_last_sent_on_equal_today_is_skipped(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_ready_candidate(
            real_session_maker, reminder_last_sent_on=datetime.date(2026, 8, 1)
        )
        with _mock_send_to_user() as mock_send:
            summary = await train_reminder_service.send_due_reminders(_NOW)
        mock_send.assert_not_called()
        assert summary.claimed == 0

    async def test_back_to_back_runs_issue_exactly_one_post_total_idempotent(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        await _seed_ready_candidate(real_session_maker)
        with _mock_send_to_user() as mock_send:
            await train_reminder_service.send_due_reminders(_NOW)
            await train_reminder_service.send_due_reminders(_NOW)
        assert mock_send.await_count == 1


class TestFanOut:
    async def test_three_subscriptions_receive_three_posts_from_one_claim(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        vapid_keypair: None,
    ) -> None:
        await _seed_ready_candidate(real_session_maker, n_subscriptions=3)
        mock_post = AsyncMock(side_effect=[MagicMock(status_code=201) for _ in range(3)])
        with patch("httpx.AsyncClient.post", new=mock_post):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        assert mock_post.await_count == 3
        assert summary.claimed == 1
        assert summary.sent == 1

    async def test_mid_fan_out_failure_does_not_skip_remaining_subscriptions(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        vapid_keypair: None,
    ) -> None:
        await _seed_ready_candidate(real_session_maker, n_subscriptions=3)
        mock_post = AsyncMock(
            side_effect=[
                MagicMock(status_code=201),
                httpx.ConnectError("boom"),
                MagicMock(status_code=201),
            ]
        )
        with patch("httpx.AsyncClient.post", new=mock_post):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        assert mock_post.await_count == 3
        assert summary.claimed == 1
        assert summary.sent == 1


class TestClaimReleaseOnTotalNonDelivery:
    """Phase 204 D3/D-13/D-14/D-15: step 8 of `_process_candidate`. Mirrors
    TestFanOut's real-encryption/real-post harness."""

    async def test_all_subscriptions_pruned_releases_the_claim(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        vapid_keypair: None,
    ) -> None:
        user_id = await _seed_ready_candidate(real_session_maker, n_subscriptions=1)
        mock_post = AsyncMock(return_value=MagicMock(status_code=410))
        with patch("httpx.AsyncClient.post", new=mock_post):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        assert summary.claimed == 1
        assert summary.pruned == 1

        async with real_session_maker() as session:
            row = (
                await session.execute(
                    select(TrainSettings.reminder_last_sent_on).where(
                        TrainSettings.user_id == user_id
                    )
                )
            ).scalar_one()
        assert row is None

    async def test_partial_failure_does_not_release_the_claim(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        vapid_keypair: None,
    ) -> None:
        user_id = await _seed_ready_candidate(real_session_maker, n_subscriptions=2)
        mock_post = AsyncMock(side_effect=[MagicMock(status_code=410), MagicMock(status_code=201)])
        with patch("httpx.AsyncClient.post", new=mock_post):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        assert summary.claimed == 1
        assert summary.pruned == 1

        async with real_session_maker() as session:
            row = (
                await session.execute(
                    select(TrainSettings.reminder_last_sent_on).where(
                        TrainSettings.user_id == user_id
                    )
                )
            ).scalar_one()
        assert row == datetime.date(2026, 8, 1)

    async def test_raising_send_to_user_does_not_release_the_claim(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """The D-07 invariant demonstration (ROADMAP criterion 5): a crash
        mid-fan-out must leave the claim standing. Patches
        `push_send.send_to_user` itself (NOT `httpx.AsyncClient.post`) --
        `send_to_user` already isolates per-subscription failures internally,
        so an httpx-level patch would surface as a normal PushFanoutResult,
        not an escaping exception."""
        user_id = await _seed_ready_candidate(real_session_maker, n_subscriptions=1)
        with (
            patch(
                "app.services.train_reminder_service.push_send.send_to_user",
                new=AsyncMock(side_effect=RuntimeError("simulated fan-out crash")),
            ),
            patch("app.services.train_reminder_service.sentry_sdk.capture_exception"),
        ):
            summary = await train_reminder_service.send_due_reminders(_NOW)
        # The exception escapes _process_candidate entirely (it is raised
        # AFTER the claim's own commit, with no try/except around the
        # send_to_user call) and is only caught by send_due_reminders' outer
        # per-candidate loop -- so the tick summary never sees a
        # _CandidateOutcome for this user: `claimed`/`sent` stay at 0 and
        # `failed` is incremented at the TICK level, not via outcome.failed.
        assert summary.claimed == 0
        assert summary.sent == 0
        assert summary.failed == 1

        async with real_session_maker() as session:
            row = (
                await session.execute(
                    select(TrainSettings.reminder_last_sent_on).where(
                        TrainSettings.user_id == user_id
                    )
                )
            ).scalar_one()
        assert row == datetime.date(2026, 8, 1)


class TestSettleBeforeCopy:
    async def test_stale_streak_is_settled_before_copy_is_built(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """D-12: a stale streak_count=5 with shield_level=1 and two elapsed
        missed scheduled days settles to 0 before the copy is built -- the
        notification must report the SETTLED count (0 + 1), never the stale
        stored one (5 + 1)."""
        user_id = await _seed_ready_candidate(
            real_session_maker,
            streak_count=5,
            shield_level=1,
            streak_settled_through=datetime.date(2026, 7, 29),
            pool_eligible_since=datetime.date(2026, 7, 20),
        )
        captured_payload: dict[str, object] = {}

        async def _capture_send(
            session: AsyncSession,
            *,
            user_id: int,
            payload: dict[str, object],
            ttl_seconds: int = 0,
        ) -> push_send.PushFanoutResult:
            captured_payload.update(payload)
            return push_send.PushFanoutResult(attempted=1, pruned=0, failed=0)

        with patch(
            "app.services.train_reminder_service.push_send.send_to_user",
            new=AsyncMock(side_effect=_capture_send),
        ):
            await train_reminder_service.send_due_reminders(_NOW)

        assert captured_payload["body"] == "Day 1 is waiting."

        async with real_session_maker() as session:
            row = (
                await session.execute(select(TrainSettings).where(TrainSettings.user_id == user_id))
            ).scalar_one()
        assert row.streak_count == 0
        assert row.shield_level == 0

    async def test_streak_zero_gets_day_one_body(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        captured_payload: dict[str, object] = {}

        async def _capture_send(
            session: AsyncSession,
            *,
            user_id: int,
            payload: dict[str, object],
            ttl_seconds: int = 0,
        ) -> push_send.PushFanoutResult:
            captured_payload.update(payload)
            return push_send.PushFanoutResult(attempted=1, pruned=0, failed=0)

        await _seed_ready_candidate(real_session_maker)
        with patch(
            "app.services.train_reminder_service.push_send.send_to_user",
            new=AsyncMock(side_effect=_capture_send),
        ):
            await train_reminder_service.send_due_reminders(_NOW)
        assert captured_payload["body"] == "Day 1 is waiting."


class TestFailureIsolation:
    async def test_one_candidate_raising_mid_tick_does_not_stop_others_sentry_captured_once(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        failing_user = await _seed_ready_candidate(real_session_maker)
        await _seed_ready_candidate(real_session_maker)

        original = train_reminder_repository.has_completed_session_on

        async def _raising_has_completed(
            session: AsyncSession, *, user_id: int, day: datetime.date
        ) -> bool:
            if user_id == failing_user:
                raise RuntimeError("simulated candidate failure")
            return await original(session, user_id=user_id, day=day)

        with (
            patch(
                "app.services.train_reminder_service.train_reminder_repository"
                ".has_completed_session_on",
                new=AsyncMock(side_effect=_raising_has_completed),
            ),
            _mock_send_to_user(),
            patch(
                "app.services.train_reminder_service.sentry_sdk.capture_exception"
            ) as mock_capture,
        ):
            summary = await train_reminder_service.send_due_reminders(_NOW)

        assert summary.scanned == 2
        assert summary.sent == 1
        assert summary.failed == 1
        assert mock_capture.call_count == 1


class TestTickSummaryLog:
    """SEED-135 D1: the per-tick summary escalates to WARNING when pruned or
    failed is non-zero, since app-level INFO is filtered out of prod docker
    logs. One call site, one format string -- the message shape (everything
    but the counts) must be byte-identical at both levels."""

    _PREFIX = "Train reminder tick:"

    def _one_summary_record(self, caplog: pytest.LogCaptureFixture) -> logging.LogRecord:
        records = [r for r in caplog.records if r.getMessage().startswith(self._PREFIX)]
        assert len(records) == 1, f"expected exactly one summary line, got: {records}"
        return records[0]

    async def test_pruned_nonzero_logs_summary_at_warning(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await _seed_ready_candidate(real_session_maker)
        caplog.set_level("INFO", logger="app.services.train_reminder_service")
        with _mock_send_to_user(pruned=1):
            summary = await train_reminder_service.send_due_reminders(_NOW)

        assert self._one_summary_record(caplog).levelno == logging.WARNING
        assert summary.pruned == 1

    async def test_failed_nonzero_logs_summary_at_warning(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await _seed_ready_candidate(real_session_maker)
        caplog.set_level("INFO", logger="app.services.train_reminder_service")
        with _mock_send_to_user(failed=1):
            summary = await train_reminder_service.send_due_reminders(_NOW)

        assert self._one_summary_record(caplog).levelno == logging.WARNING
        assert summary.failed == 1

    async def test_all_clear_logs_summary_at_info(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        await _seed_ready_candidate(real_session_maker)
        caplog.set_level("INFO", logger="app.services.train_reminder_service")
        with _mock_send_to_user():
            summary = await train_reminder_service.send_due_reminders(_NOW)

        assert self._one_summary_record(caplog).levelno == logging.INFO
        assert summary.pruned == 0
        assert summary.failed == 0

    async def test_warning_and_info_summaries_share_the_same_message_shape(
        self,
        real_session_maker: async_sessionmaker[AsyncSession],
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Only the counts differ between the WARNING and INFO cases -- the
        surrounding format string (one call site, per the plan) never does,
        so a prod grep for the prefix works regardless of which level fired."""
        await _seed_ready_candidate(real_session_maker)
        caplog.set_level("INFO", logger="app.services.train_reminder_service")
        with _mock_send_to_user(pruned=1):
            warning_summary = await train_reminder_service.send_due_reminders(_NOW)
        warning_record = self._one_summary_record(caplog)
        caplog.clear()

        await _seed_ready_candidate(real_session_maker)
        with _mock_send_to_user():
            info_summary = await train_reminder_service.send_due_reminders(_NOW)
        info_record = self._one_summary_record(caplog)

        # ReminderTickSummary's fields are unaffected by the logging change --
        # the log level is the only thing that varies.
        assert (
            type(warning_summary)
            is type(info_summary)
            is train_reminder_service.ReminderTickSummary
        )
        # Compare the RAW (pre-%-formatting) format string, not getMessage()
        # -- the rendered text legitimately differs on scanned/pruned/failed
        # (this real, non-rollback session accumulates candidates across the
        # two calls), but "one call site, one format string" means the
        # %-template itself, record.msg, must be identical either way.
        assert warning_record.msg == info_record.msg


class TestRunPeriodic:
    async def test_run_periodic_returns_without_ticking_when_vapid_unset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", "")
        monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", "")
        with patch("app.services.train_reminder_service.asyncio.sleep") as mock_sleep:
            await train_reminder_service.run_periodic_train_reminders()
        mock_sleep.assert_not_called()
