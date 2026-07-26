"""Tests for app.services.guest_cleanup_service (Phase 187, SEED-116).

Covers:
- TestPurgeGuestEndToEnd: _purge_guest deletes games + 5 cascading children +
  import_jobs + the 2 derived-stats tables, resets both backfill-cursor
  mechanisms, and leaves the guest User row + bookmarks + user_import_settings
  row (and its tc_*/game_cap preferences) untouched (D-03/D-04/D-05/D-06,
  Pitfall 1/Pitfall 2, 187-RESEARCH.md).
- TestEligibilityQuery: get_eligible_guest_ids selects only guests inactive
  >= 30 days, excluding recent guests, NULL-last_activity guests, and
  registered (non-guest) users.
- TestTransactionPerGuest: a failure purging one guest does not roll back or
  block another guest's already-committed purge (D-06 isolation).
- TestCleanupSummaryLog: cleanup_inactive_guests emits one summary log line
  carrying scanned/purged/games_deleted counts (D-07).

Uses the real per-run test DB via a genuine (non-savepoint) session bound to
test_engine -- see the module-scoped fixtures below for why the usual
rollback-scoped `db_session` fixture cannot be used for tests that exercise
_purge_guest/cleanup_inactive_guests: those open their OWN
async_session_maker() session (D-06: one transaction per guest) on a
SEPARATE physical connection, and Postgres MVCC means that connection can
never see another connection's uncommitted work. TestEligibilityQuery calls
get_eligible_guest_ids directly with an explicit session (no separate
connection involved), so it uses the ordinary rollback-scoped db_session
fixture.

Note: tests using real_session_maker commit for real (no rollback), so
residual guest rows can persist in the per-run test DB across tests in the
same session. Assertions below are written to tolerate that (membership
checks / >= bounds on aggregate counts) rather than asserting exact global
row counts.
"""

import asyncio
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

import app.services.guest_cleanup_service as guest_cleanup_service
from app.models.bot_game_settings import BotGameSettings
from app.models.drill_item import DrillItem
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve
from app.models.eval_jobs import TIER_IDLE_BACKLOG, EvalJob
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.import_job import ImportJob
from app.models.position_bookmark import PositionBookmark
from app.models.user import User
from app.models.user_benchmark_percentile import UserBenchmarkPercentile
from app.models.user_import_settings import UserImportSettings
from app.models.user_rating_anchors import UserRatingAnchor
from app.repositories.user_benchmark_percentiles_repository import upsert_percentile
from app.repositories.user_rating_anchors_repository import upsert_anchor
from app.services.guest_cleanup_service import _purge_guest, get_eligible_guest_ids
from app.services.guest_service import create_guest_user

# ---------------------------------------------------------------------------
# Session-binding fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def real_session_maker(
    test_engine,
) -> async_sessionmaker[AsyncSession]:
    """A genuine (non-savepoint) sessionmaker bound to the per-run test DB.

    The usual `db_session` fixture binds an AsyncSession directly to an
    ALREADY-begun Connection (`conn.begin()` then `AsyncSession(bind=conn)`),
    which puts SQLAlchemy's session into `join_transaction_mode=
    "conditional_savepoint"` -- since the connection already has an open
    transaction, the session's own `commit()` only releases a SAVEPOINT; the
    real outer transaction stays open until the fixture's teardown
    `conn.rollback()`. That is invisible to any OTHER connection (standard
    Postgres MVCC) -- confirmed via a scratch repro where a game committed
    through `db_session` read back as 0 rows from a second connection.

    _purge_guest opens its own D-06 per-guest session on a genuinely separate
    connection, so test data it must see has to be committed for real. This
    fixture (mirroring conftest.py's own `fresh_test_user` pattern) provides
    a sessionmaker whose sessions own their transaction outright, so
    `.commit()` is a real, cross-connection-visible COMMIT.
    """
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(autouse=True)
async def _patch_guest_cleanup_session_maker(real_session_maker, monkeypatch):
    """Route guest_cleanup_service's OWN async_session_maker() opens to the test DB.

    _purge_guest opens its own session per guest (D-06) via a module-level
    `from app.core.database import async_session_maker` binding, captured at
    guest_cleanup_service's own import time (collection) -- BEFORE conftest's
    session-scoped override_get_async_session fixture ever patches
    app.core.database.async_session_maker (that patch only rebinds the
    attribute ON app.core.database; it cannot retroactively update a name
    another module already imported via `from ... import ...`, since Python
    binds that name to the object at import time, not a live attribute
    lookup). Confirmed via a scratch repro: without this patch, a service
    module's own `async_session_maker` resolves current_database() to the
    real dev DB ("flawchess"), not the isolated per-run test DB.

    Patching the NAME actually consulted at call time -- guest_cleanup_
    service's own module global -- mirrors the established
    `patch("app.services.import_service.async_session_maker", mock_maker)`
    idiom in tests/test_import_service.py, just with a real (not mocked)
    sessionmaker bound to the per-run test_engine.
    """
    monkeypatch.setattr(guest_cleanup_service, "async_session_maker", real_session_maker)


@pytest_asyncio.fixture(autouse=True)
async def _cleanup_leaked_guest_rows(real_session_maker):
    """Delete guest User rows a test creates so committed rows don't pollute later tests (WR-03).

    The real_session_maker-based tests commit for real (no rollback), and
    _purge_guest deliberately KEEPS the guest User row (D-05). So a committed
    test leaves an eligible-looking guest (is_guest=True, last_activity 30+
    days ago) in the per-run test DB for the rest of the xdist worker's
    session, which any future exact-`is_guest`-count assertion would trip on.
    Snapshot the guest ids before the test and delete any that appear after,
    leaving the DB as it was found. Deleting the User cascades every
    user-scoped child (both position_bookmark and user_import_settings carry
    ON DELETE CASCADE from users.id). db_session-scoped tests roll back, so
    before == after and this is a no-op for them.
    """

    async def _guest_ids() -> set[int]:
        async with real_session_maker() as s:
            rows = await s.execute(select(User.id).where(User.is_guest.is_(True)))
            return set(rows.scalars().all())

    before = await _guest_ids()
    yield
    leaked = await _guest_ids() - before
    if leaked:
        async with real_session_maker() as s:
            await s.execute(delete(User).where(User.id.in_(leaked)))
            await s.commit()


# ---------------------------------------------------------------------------
# TestPurgeGuestEndToEnd
# ---------------------------------------------------------------------------


class TestPurgeGuestEndToEnd:
    @pytest.mark.asyncio
    async def test_purge_deletes_all_and_resets_cursors_keeps_survivors(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """_purge_guest deletes games+children+cursors, keeps kept rows (D-03..D-06)."""
        async with real_session_maker() as seed_session:
            user, _token = await create_guest_user(seed_session)
            guest_id = user.id

            # Narrative fidelity with the 30-day threshold (_purge_guest itself
            # does not gate on eligibility -- the caller/orchestrator does, see
            # Task 2's TestEligibilityQuery/TestTransactionPerGuest).
            cutoff = datetime.now(timezone.utc) - timedelta(days=31)
            await seed_session.execute(
                text("UPDATE users SET last_activity = :ts WHERE id = :uid"),
                {"ts": cutoff, "uid": guest_id},
            )

            game = Game(
                user_id=guest_id,
                platform="lichess",
                platform_game_id=f"purge-test-{uuid.uuid4()}",
                platform_url="https://lichess.org/test",
                pgn="1. e4 e5 *",
                result="1-0",
                user_color="white",
                time_control_str="600+0",
                time_control_bucket="blitz",
                time_control_seconds=600,
                base_time_seconds=600,
                increment_seconds=0.0,
                rated=True,
                is_computer_game=False,
            )
            seed_session.add(game)
            await seed_session.flush()
            game_id = game.id

            seed_session.add(
                GamePosition(
                    game_id=game_id,
                    user_id=guest_id,
                    ply=1,
                    full_hash=111111,
                    white_hash=222222,
                    black_hash=333333,
                )
            )
            seed_session.add(
                GameFlaw(
                    user_id=guest_id,
                    game_id=game_id,
                    ply=1,
                    severity=2,
                    tempo=0,
                    phase=1,
                    is_miss=True,
                    is_lucky=False,
                    is_reversed=True,
                    is_squandered=True,
                    fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
                )
            )
            seed_session.add(
                GameBestMove(game_id=game_id, ply=1, maia_prob=0.5, best_cp=20, second_cp=10)
            )
            seed_session.add(
                EvalJob(
                    tier=TIER_IDLE_BACKLOG, user_id=guest_id, game_id=game_id, status="completed"
                )
            )
            seed_session.add(
                BotGameSettings(
                    game_id=game_id,
                    nominal_elo=1500,
                    play_style_blend=0.0,
                    tc_preset="10+0",
                    rating_source=None,
                )
            )
            seed_session.add(
                ImportJob(
                    id=str(uuid.uuid4()),
                    user_id=guest_id,
                    platform="lichess",
                    username="guest_test",
                    status="completed",
                    games_fetched=1,
                    games_imported=1,
                )
            )
            seed_session.add(
                UserImportSettings(
                    user_id=guest_id,
                    tc_bullet=True,
                    tc_blitz=False,
                    tc_rapid=True,
                    tc_classical=False,
                    game_cap=3000,
                    chesscom_backfill_oldest_year=2024,
                    chesscom_backfill_oldest_month=3,
                    lichess_backfill_oldest_ms=1700000000000,
                )
            )
            seed_session.add(
                PositionBookmark(
                    user_id=guest_id,
                    label="test bookmark",
                    target_hash=987654321,
                    fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                    moves="[]",
                    match_side="full",
                )
            )
            await upsert_percentile(
                seed_session,
                user_id=guest_id,
                metric="score_gap",
                time_control_bucket="blitz",
                value=1.5,
                n_games=30,
                percentile=55.0,
                cdf_snapshot=date.today(),
            )
            await upsert_anchor(
                seed_session,
                user_id=guest_id,
                time_control_bucket="blitz",
                anchor_rating=1500,
                n_chesscom_games=5,
                n_lichess_games=3,
                chesscom_median_native=1500,
                lichess_median_native=1500,
            )
            await seed_session.commit()

        deleted_count = await _purge_guest(guest_id)
        assert deleted_count == 1

        async with real_session_maker() as verify_session:

            async def _count(model, *predicates) -> int:
                result = await verify_session.execute(
                    select(func.count()).select_from(model).where(*predicates)
                )
                return result.scalar_one()

            assert await _count(Game, Game.id == game_id) == 0
            assert await _count(GamePosition, GamePosition.game_id == game_id) == 0
            assert await _count(GameFlaw, GameFlaw.game_id == game_id) == 0
            assert await _count(GameBestMove, GameBestMove.game_id == game_id) == 0
            assert await _count(EvalJob, EvalJob.game_id == game_id) == 0
            assert await _count(BotGameSettings, BotGameSettings.game_id == game_id) == 0
            assert await _count(ImportJob, ImportJob.user_id == guest_id) == 0
            assert (
                await _count(UserBenchmarkPercentile, UserBenchmarkPercentile.user_id == guest_id)
                == 0
            )
            assert await _count(UserRatingAnchor, UserRatingAnchor.user_id == guest_id) == 0

            settings_row = (
                await verify_session.execute(
                    select(UserImportSettings).where(UserImportSettings.user_id == guest_id)
                )
            ).scalar_one()
            assert settings_row.chesscom_backfill_oldest_year is None
            assert settings_row.chesscom_backfill_oldest_month is None
            assert settings_row.lichess_backfill_oldest_ms is None
            assert (
                settings_row.tc_bullet,
                settings_row.tc_blitz,
                settings_row.tc_rapid,
                settings_row.tc_classical,
            ) == (True, False, True, False)
            assert settings_row.game_cap == 3000

            assert await _count(PositionBookmark, PositionBookmark.user_id == guest_id) == 1
            user_row = (
                (await verify_session.execute(select(User).where(User.id == guest_id)))
                .unique()
                .scalar_one()
            )
            assert user_row.is_guest is True

    @pytest.mark.asyncio
    async def test_reactivated_guest_is_skipped_not_purged(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """WR-01: a guest who becomes active after the eligibility snapshot is not purged.

        cleanup_inactive_guests snapshots eligible ids, then purges each in its
        own later transaction; during a large first-tick backlog a guest can log
        back in (bumping last_activity) before their turn. _purge_guest re-checks
        the full eligibility predicate at delete time and must skip such a guest,
        returning 0 and leaving their game intact (the top threat: wrong-target
        deletion).
        """
        async with real_session_maker() as seed_session:
            guest_id, game_id = await _seed_eligible_guest_with_game(seed_session)
            # Simulate the guest logging back in after the snapshot: recent activity.
            await _set_last_activity(seed_session, user_id=guest_id, days_ago=0)
            await seed_session.commit()

        deleted_count = await _purge_guest(guest_id)
        assert deleted_count == 0

        async with real_session_maker() as verify_session:
            surviving_games = (
                await verify_session.execute(
                    select(func.count()).select_from(Game).where(Game.id == game_id)
                )
            ).scalar_one()
        assert surviving_games == 1, "a reactivated guest's game must survive"


# ---------------------------------------------------------------------------
# TestPurgeGuestDrillCascade (Phase 189 Plan 02, POOL-09, D-02/D-04/D-05)
# ---------------------------------------------------------------------------


class TestPurgeGuestDrillCascade:
    @pytest.mark.asyncio
    async def test_purge_guest_cascades_drill_rows(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """The 30-day guest purge cascades drill_items/drill_solves away via
        the games FK (D-02), while the guest's drill_sessions row survives (D-04).

        Guest-owned rows are cleaned up by the module's autouse
        `_cleanup_leaked_guest_rows` fixture (deletes the guest User row,
        cascading every FK'd child including drill_sessions) -- no separate
        finally block is needed since this test creates no non-guest rows.
        """
        async with real_session_maker() as seed_session:
            guest_id, game_id = await _seed_eligible_guest_with_game(seed_session)

            drill_session = DrillSession(
                user_id=guest_id,
                session_date=date(2026, 7, 25),
                puzzle_count=1,
                expires_on=date(2026, 8, 1),
            )
            seed_session.add(drill_session)
            await seed_session.flush()

            seed_session.add(
                DrillItem(
                    user_id=guest_id,
                    game_id=game_id,
                    ply=6,
                    due_date=date(2026, 7, 26),
                )
            )
            seed_session.add(
                DrillSolve(
                    session_id=drill_session.id,
                    position=0,
                    user_id=guest_id,
                    game_id=game_id,
                    ply=6,
                    source=0,
                )
            )
            await seed_session.commit()
            drill_session_id = drill_session.id

        async def _count(model, *predicates) -> int:
            async with real_session_maker() as s:
                result = await s.execute(select(func.count()).select_from(model).where(*predicates))
                return result.scalar_one()

        assert await _count(DrillItem, DrillItem.user_id == guest_id) == 1, (
            "seed setup must produce a non-zero drill_items count before the purge"
        )
        assert await _count(DrillSolve, DrillSolve.user_id == guest_id) == 1, (
            "seed setup must produce a non-zero drill_solves count before the purge"
        )

        deleted_count = await _purge_guest(guest_id)
        assert deleted_count == 1

        assert await _count(DrillItem, DrillItem.user_id == guest_id) == 0
        assert await _count(DrillSolve, DrillSolve.user_id == guest_id) == 0
        assert await _count(DrillSession, DrillSession.id == drill_session_id) == 1, (
            "drill_sessions must survive the guest purge (D-04)"
        )

    @pytest.mark.asyncio
    async def test_purge_guest_without_drill_rows_is_noop(
        self, real_session_maker: async_sessionmaker[AsyncSession]
    ) -> None:
        """An eligible guest with games but no train rows purges cleanly and
        returns the expected deleted-game count."""
        async with real_session_maker() as seed_session:
            guest_id, _game_id = await _seed_eligible_guest_with_game(seed_session)
            await seed_session.commit()

        deleted_count = await _purge_guest(guest_id)
        assert deleted_count == 1


# ---------------------------------------------------------------------------
# Shared seed helpers (Task 2)
# ---------------------------------------------------------------------------


async def _set_last_activity(
    session: AsyncSession, *, user_id: int, days_ago: float | None
) -> None:
    """Set (or NULL) a user's last_activity via a direct UPDATE (precise control)."""
    ts = None if days_ago is None else datetime.now(timezone.utc) - timedelta(days=days_ago)
    await session.execute(
        text("UPDATE users SET last_activity = :ts WHERE id = :uid"),
        {"ts": ts, "uid": user_id},
    )


async def _seed_eligible_guest_with_game(session: AsyncSession) -> tuple[int, int]:
    """Create a guest (last_activity 31 days ago) with one Game row.

    Returns (guest_id, game_id). Caller commits.
    """
    user, _token = await create_guest_user(session)
    guest_id = user.id
    await _set_last_activity(session, user_id=guest_id, days_ago=31)

    game = Game(
        user_id=guest_id,
        platform="lichess",
        platform_game_id=f"tx-test-{uuid.uuid4()}",
        platform_url="https://lichess.org/test",
        pgn="1. e4 e5 *",
        result="1-0",
        user_color="white",
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
    )
    session.add(game)
    await session.flush()
    return guest_id, game.id


# ---------------------------------------------------------------------------
# TestEligibilityQuery
# ---------------------------------------------------------------------------


class TestEligibilityQuery:
    @pytest.mark.asyncio
    async def test_selects_only_31_day_inactive_guests(self, db_session: AsyncSession) -> None:
        """31-day-inactive guest selected; 29-day, NULL, and registered users are not."""
        eligible_guest, _ = await create_guest_user(db_session)
        await _set_last_activity(db_session, user_id=eligible_guest.id, days_ago=31)

        recent_guest, _ = await create_guest_user(db_session)
        await _set_last_activity(db_session, user_id=recent_guest.id, days_ago=29)

        null_activity_guest, _ = await create_guest_user(db_session)
        # last_activity stays NULL (create_guest_user never sets it -- Pitfall 3).

        registered = User(
            email=f"registered-{uuid.uuid4().hex}@example.com",
            hashed_password="fakehash",
            is_active=True,
            is_verified=True,
            is_guest=False,
        )
        db_session.add(registered)
        await db_session.flush()
        await _set_last_activity(db_session, user_id=registered.id, days_ago=31)

        await db_session.flush()
        eligible_ids = await get_eligible_guest_ids(db_session)

        assert eligible_guest.id in eligible_ids
        assert recent_guest.id not in eligible_ids
        assert null_activity_guest.id not in eligible_ids
        assert registered.id not in eligible_ids


# ---------------------------------------------------------------------------
# TestTransactionPerGuest
# ---------------------------------------------------------------------------


class TestTransactionPerGuest:
    @pytest.mark.asyncio
    async def test_one_guest_failure_does_not_block_or_rollback_another(
        self, real_session_maker: async_sessionmaker[AsyncSession], monkeypatch
    ) -> None:
        """A failure purging guest 2 leaves guest 1's committed purge intact (D-06)."""
        async with real_session_maker() as seed_session:
            guest1_id, guest1_game_id = await _seed_eligible_guest_with_game(seed_session)
            guest2_id, guest2_game_id = await _seed_eligible_guest_with_game(seed_session)
            await seed_session.commit()

        original_purge_guest = guest_cleanup_service._purge_guest

        async def _purge_guest_fail_on_guest2(guest_id: int) -> int:
            if guest_id == guest2_id:
                raise RuntimeError("simulated purge failure")
            return await original_purge_guest(guest_id)

        monkeypatch.setattr(guest_cleanup_service, "_purge_guest", _purge_guest_fail_on_guest2)

        await guest_cleanup_service.cleanup_inactive_guests()  # must not raise

        async with real_session_maker() as verify_session:
            guest1_games = (
                await verify_session.execute(
                    select(func.count()).select_from(Game).where(Game.id == guest1_game_id)
                )
            ).scalar_one()
            guest2_games = (
                await verify_session.execute(
                    select(func.count()).select_from(Game).where(Game.id == guest2_game_id)
                )
            ).scalar_one()

        assert guest1_games == 0, "guest 1's purge should have committed independently"
        assert guest2_games == 1, "guest 2's data must survive its own failed purge"


# ---------------------------------------------------------------------------
# TestCleanupSummaryLog
# ---------------------------------------------------------------------------


class TestCleanupSummaryLog:
    @pytest.mark.asyncio
    async def test_emits_one_summary_line_with_counts(
        self, real_session_maker: async_sessionmaker[AsyncSession], caplog: pytest.LogCaptureFixture
    ) -> None:
        """cleanup_inactive_guests logs one summary line with scanned/purged/games_deleted (D-07)."""
        async with real_session_maker() as seed_session:
            await _seed_eligible_guest_with_game(seed_session)
            await seed_session.commit()

        caplog.set_level("INFO", logger="app.services.guest_cleanup_service")
        await guest_cleanup_service.cleanup_inactive_guests()

        summary_lines = [
            r.getMessage() for r in caplog.records if "Guest cleanup tick" in r.getMessage()
        ]
        assert len(summary_lines) == 1, f"expected exactly one summary line, got: {summary_lines}"
        summary = summary_lines[0]
        assert "scanned=" in summary
        assert "purged=" in summary
        assert "games_deleted=" in summary


# ---------------------------------------------------------------------------
# TestRunPeriodicGuestCleanup (Plan 02)
# ---------------------------------------------------------------------------


class TestRunPeriodicGuestCleanup:
    """Unit tests for run_periodic_guest_cleanup (mocked -- no real DB).

    Mirrors tests/test_import_service.py::TestRunPeriodicReaper: monkeypatch
    asyncio.sleep to drive a bounded number of loop iterations (raising
    CancelledError to stop the infinite loop), and monkeypatch
    cleanup_inactive_guests to a spy/failing stub.
    """

    @pytest.mark.asyncio
    async def test_calls_cleanup_once_per_iteration(self, monkeypatch) -> None:
        """run_periodic_guest_cleanup sleeps then calls cleanup_inactive_guests each tick."""
        from app.services.guest_cleanup_service import run_periodic_guest_cleanup

        sleep_count = 0

        async def _mock_sleep(_seconds: float) -> None:
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count >= 3:
                raise asyncio.CancelledError()

        call_count = 0

        async def _mock_cleanup() -> None:
            nonlocal call_count
            call_count += 1

        monkeypatch.setattr("app.services.guest_cleanup_service.asyncio.sleep", _mock_sleep)
        monkeypatch.setattr(
            "app.services.guest_cleanup_service.cleanup_inactive_guests", _mock_cleanup
        )

        with pytest.raises(asyncio.CancelledError):
            await run_periodic_guest_cleanup()

        assert call_count >= 2, "cleanup_inactive_guests must be called once per tick"

    @pytest.mark.asyncio
    async def test_survives_cleanup_exception(self, monkeypatch) -> None:
        """A raise from cleanup_inactive_guests is logged, Sentry-captured, and swallowed."""
        from app.services.guest_cleanup_service import run_periodic_guest_cleanup

        sleep_count = 0

        async def _mock_sleep(_seconds: float) -> None:
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count >= 3:
                raise asyncio.CancelledError()

        call_count = 0

        async def _mock_cleanup() -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("simulated cleanup failure")

        monkeypatch.setattr("app.services.guest_cleanup_service.asyncio.sleep", _mock_sleep)
        monkeypatch.setattr(
            "app.services.guest_cleanup_service.cleanup_inactive_guests", _mock_cleanup
        )

        with (
            patch(
                "app.services.guest_cleanup_service.sentry_sdk.capture_exception"
            ) as mock_capture,
            pytest.raises(asyncio.CancelledError),
        ):
            await run_periodic_guest_cleanup()

        assert call_count >= 2, (
            f"Loop should continue after cleanup exception. cleanup called {call_count} time(s)"
        )
        assert mock_capture.call_count >= 1, (
            "sentry_sdk.capture_exception must be called when cleanup raises"
        )
