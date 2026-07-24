"""Backfill script tests (FILL-01, FILL-02 relaxed). Phase 78 Wave 0.

Tests cover:
- dry-run: no writes, no engine calls
- idempotency: second run performs zero engine calls
- lichess eval preservation: rows with eval_cp already set are not overwritten
- limit: --limit N caps evaluations at N rows
- user filter: --user-id scopes rows to a single user

Data isolation: each test class seeds its own committed data using test_engine
so run_backfill's independently-created sessions can see it.  Cleanup is
handled in teardown via DELETE on the committed rows.
"""

from __future__ import annotations

import datetime
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.models.game import Game
from app.models.game_position import GamePosition
from app.repositories.endgame_repository import ENDGAME_PLY_THRESHOLD

# Public API of the script — run_backfill is the callable exposed for testability.
# CLI is parsed in main(); run_backfill takes explicit kwargs.
# Phase 188/SEED-115 D-04: script archived to scripts/archive/ (completed backfill).
from scripts.archive.backfill_eval import run_backfill


pytestmark = pytest.mark.asyncio

_SPAN_START_PLY = 10  # arbitrary span entry ply for tests


def _unique_game_id() -> str:
    return str(uuid.uuid4())


async def _seed_game(
    session: AsyncSession,
    *,
    user_id: int,
    pgn: str = "1. e4 e5 *",
) -> Game:
    """Insert a minimal Game row and flush to get an ID."""
    game = Game(
        user_id=user_id,
        platform="chess.com",
        platform_game_id=_unique_game_id(),
        platform_url="https://chess.com/game/test",
        pgn=pgn,
        result="1-0",
        user_color="white",
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        rated=True,
        is_computer_game=False,
    )
    game.played_at = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    session.add(game)
    await session.flush()
    return game


async def _seed_span(
    session: AsyncSession,
    *,
    user_id: int,
    game: Game,
    span_start_ply: int = _SPAN_START_PLY,
    endgame_class: int = 1,
    eval_cp_for_entry: int | None = None,
    eval_mate_for_entry: int | None = None,
) -> None:
    """Seed ENDGAME_PLY_THRESHOLD consecutive positions forming a valid endgame span.

    The first ply (span_start_ply) is the span entry. Its eval_cp / eval_mate
    are set from the kwargs so callers can test the lichess-preservation path.
    Subsequent plies always have NULL eval so they don't count as span entries.
    """
    for offset in range(ENDGAME_PLY_THRESHOLD):
        is_entry = offset == 0
        pos = GamePosition(
            game_id=game.id,
            user_id=user_id,
            ply=span_start_ply + offset,
            full_hash=hash(f"{game.id}-{span_start_ply + offset}") & 0x7FFFFFFFFFFFFFFF,
            white_hash=hash(f"w-{game.id}-{span_start_ply + offset}") & 0x7FFFFFFFFFFFFFFF,
            black_hash=hash(f"b-{game.id}-{span_start_ply + offset}") & 0x7FFFFFFFFFFFFFFF,
            endgame_class=endgame_class,
            eval_cp=eval_cp_for_entry if is_entry else None,
            eval_mate=eval_mate_for_entry if is_entry else None,
        )
        session.add(pos)
    await session.flush()


async def _get_entry_eval(
    session: AsyncSession,
    game_id: int,
    ply: int,
) -> tuple[int | None, int | None]:
    """Fetch (eval_cp, eval_mate) for a specific game_id + ply."""
    from sqlalchemy import select

    row = (
        await session.execute(
            select(GamePosition.eval_cp, GamePosition.eval_mate).where(
                GamePosition.game_id == game_id,
                GamePosition.ply == ply,
            )
        )
    ).one()
    return row.eval_cp, row.eval_mate


async def _ensure_user(session: AsyncSession, user_id: int) -> None:
    """Ensure test user exists (FK constraint)."""
    from sqlalchemy import select
    from app.models.user import User

    existing = (
        (await session.execute(select(User).where(User.id == user_id)))
        .unique()
        .scalar_one_or_none()
    )
    if existing is None:
        session.add(
            User(id=user_id, email=f"backfill-test-{user_id}@example.com", hashed_password="x")
        )
        await session.flush()


async def _delete_user_data(session: AsyncSession, user_id: int) -> None:
    """Delete all game/position data for user_id (test cleanup)."""
    from sqlalchemy import delete as sa_delete
    from app.models.user import User

    # GamePositions and Games cascade-delete when the User is deleted.
    await session.execute(sa_delete(User).where(User.id == user_id))
    await session.flush()


def _make_session_maker(test_engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Build a committed-write session maker on the test engine."""
    return async_sessionmaker(test_engine, expire_on_commit=False)


# ---------------------------------------------------------------------------
# TestDryRun
# ---------------------------------------------------------------------------


class TestDryRun:
    async def test_dry_run_writes_nothing(self, test_engine: AsyncEngine) -> None:
        """Dry-run counts rows but performs zero engine calls and zero DB writes."""
        user_id = 90001
        session_maker = _make_session_maker(test_engine)

        async with session_maker() as setup:
            await _ensure_user(setup, user_id)
            game = await _seed_game(setup, user_id=user_id)
            game_id = game.id
            await _seed_span(setup, user_id=user_id, game=game)
            await setup.commit()

        try:
            with patch("scripts.archive.backfill_eval.EnginePool") as MockPoolCls:
                mock_pool = AsyncMock()
                mock_pool.evaluate = AsyncMock(return_value=(150, None))
                MockPoolCls.return_value = mock_pool
                await run_backfill(
                    db="dev",
                    user_id=user_id,
                    dry_run=True,
                    limit=None,
                    _session_maker=session_maker,
                )

            # Dry-run returns before the pool is constructed/started.
            assert MockPoolCls.call_count == 0
            assert mock_pool.evaluate.call_count == 0

            # Entry row must still have NULL eval (nothing written)
            async with session_maker() as verify:
                eval_cp, eval_mate = await _get_entry_eval(verify, game_id, _SPAN_START_PLY)
            assert eval_cp is None
            assert eval_mate is None
        finally:
            async with session_maker() as teardown:
                await _delete_user_data(teardown, user_id)
                await teardown.commit()


# ---------------------------------------------------------------------------
# TestIdempotency
# ---------------------------------------------------------------------------


class TestIdempotency:
    async def test_second_run_zero_engine_calls(self, test_engine: AsyncEngine) -> None:
        """Second run performs zero engine calls (row-level idempotency check)."""
        user_id = 90002
        session_maker = _make_session_maker(test_engine)

        async with session_maker() as setup:
            await _ensure_user(setup, user_id)
            game = await _seed_game(setup, user_id=user_id)
            await _seed_span(setup, user_id=user_id, game=game)
            await setup.commit()

        try:
            with patch("scripts.archive.backfill_eval.EnginePool") as MockPoolCls:
                mock_pool = AsyncMock()
                mock_pool.evaluate = AsyncMock(return_value=(150, None))
                MockPoolCls.return_value = mock_pool
                mock_eval = mock_pool.evaluate
                await run_backfill(
                    db="dev",
                    user_id=user_id,
                    dry_run=False,
                    limit=None,
                    _session_maker=session_maker,
                )
                first_run_calls = mock_eval.call_count
                assert first_run_calls == 1  # one span entry to evaluate

                mock_eval.reset_mock()
                await run_backfill(
                    db="dev",
                    user_id=user_id,
                    dry_run=False,
                    limit=None,
                    _session_maker=session_maker,
                )
                assert mock_eval.call_count == 0  # idempotent: already populated
        finally:
            async with session_maker() as teardown:
                await _delete_user_data(teardown, user_id)
                await teardown.commit()


# ---------------------------------------------------------------------------
# TestLichessPreservation
# ---------------------------------------------------------------------------


class TestLichessPreservation:
    async def test_lichess_eval_not_overwritten(self, test_engine: AsyncEngine) -> None:
        """Rows with eval_cp already set (e.g. from lichess) are NOT overwritten."""
        user_id = 90003
        session_maker = _make_session_maker(test_engine)

        async with session_maker() as setup:
            await _ensure_user(setup, user_id)
            game = await _seed_game(setup, user_id=user_id)
            game_id = game.id
            await _seed_span(
                setup,
                user_id=user_id,
                game=game,
                eval_cp_for_entry=-42,  # lichess pre-populated
            )
            await setup.commit()

        try:
            with patch("scripts.archive.backfill_eval.EnginePool") as MockPoolCls:
                mock_pool = AsyncMock()
                mock_pool.evaluate = AsyncMock(return_value=(999, None))
                MockPoolCls.return_value = mock_pool
                mock_eval = mock_pool.evaluate
                await run_backfill(
                    db="dev",
                    user_id=user_id,
                    dry_run=False,
                    limit=None,
                    _session_maker=session_maker,
                )

            # The row had eval_cp set → skipped by WHERE eval_cp IS NULL AND eval_mate IS NULL
            assert mock_eval.call_count == 0

            # Original value preserved byte-for-byte (FILL-04 invariant)
            async with session_maker() as verify:
                eval_cp, eval_mate = await _get_entry_eval(verify, game_id, _SPAN_START_PLY)
            assert eval_cp == -42
            assert eval_mate is None
        finally:
            async with session_maker() as teardown:
                await _delete_user_data(teardown, user_id)
                await teardown.commit()


# ---------------------------------------------------------------------------
# TestLimit
# ---------------------------------------------------------------------------


class TestLimit:
    async def test_limit_caps_evaluations(self, test_engine: AsyncEngine) -> None:
        """--limit N processes at most N span-entry rows."""
        user_id = 90004
        session_maker = _make_session_maker(test_engine)

        async with session_maker() as setup:
            await _ensure_user(setup, user_id)
            # Seed 3 games, each with one NULL-eval span entry
            for i in range(3):
                game = await _seed_game(setup, user_id=user_id)
                # Stagger span start so each game has a distinct ply group
                await _seed_span(
                    setup,
                    user_id=user_id,
                    game=game,
                    span_start_ply=_SPAN_START_PLY + i * ENDGAME_PLY_THRESHOLD,
                )
            await setup.commit()

        try:
            with patch("scripts.archive.backfill_eval.EnginePool") as MockPoolCls:
                mock_pool = AsyncMock()
                mock_pool.evaluate = AsyncMock(return_value=(100, None))
                MockPoolCls.return_value = mock_pool
                mock_eval = mock_pool.evaluate
                await run_backfill(
                    db="dev",
                    user_id=user_id,
                    dry_run=False,
                    limit=2,
                    _session_maker=session_maker,
                )

            assert mock_eval.call_count == 2
        finally:
            async with session_maker() as teardown:
                await _delete_user_data(teardown, user_id)
                await teardown.commit()


# ---------------------------------------------------------------------------
# TestUserFilter
# ---------------------------------------------------------------------------


class TestUserFilter:
    async def test_user_id_scopes_rows(self, test_engine: AsyncEngine) -> None:
        """--user-id X only processes rows belonging to user X."""
        user_a = 90005
        user_b = 90006
        session_maker = _make_session_maker(test_engine)

        async with session_maker() as setup:
            await _ensure_user(setup, user_a)
            await _ensure_user(setup, user_b)
            game_a = await _seed_game(setup, user_id=user_a)
            game_b = await _seed_game(setup, user_id=user_b)
            game_a_id = game_a.id
            game_b_id = game_b.id
            await _seed_span(setup, user_id=user_a, game=game_a)
            await _seed_span(setup, user_id=user_b, game=game_b)
            await setup.commit()

        try:
            with patch("scripts.archive.backfill_eval.EnginePool") as MockPoolCls:
                mock_pool = AsyncMock()
                mock_pool.evaluate = AsyncMock(return_value=(50, None))
                MockPoolCls.return_value = mock_pool
                mock_eval = mock_pool.evaluate
                await run_backfill(
                    db="dev",
                    user_id=user_a,
                    dry_run=False,
                    limit=None,
                    _session_maker=session_maker,
                )

            # Only user A's row was processed
            assert mock_eval.call_count == 1

            async with session_maker() as verify:
                # User B's entry still NULL
                eval_cp_b, eval_mate_b = await _get_entry_eval(verify, game_b_id, _SPAN_START_PLY)
                assert eval_cp_b is None
                assert eval_mate_b is None

                # User A's entry was populated
                eval_cp_a, eval_mate_a = await _get_entry_eval(verify, game_a_id, _SPAN_START_PLY)
                assert eval_cp_a == 50
                assert eval_mate_a is None
        finally:
            async with session_maker() as teardown:
                await _delete_user_data(teardown, user_a)
                await _delete_user_data(teardown, user_b)
                await teardown.commit()


# ---------------------------------------------------------------------------
# TestIslandDetection
# ---------------------------------------------------------------------------


class TestIslandDetection:
    async def test_two_islands_same_class_both_get_entry_eval(
        self, test_engine: AsyncEngine
    ) -> None:
        """A game that re-enters the same endgame_class gets one entry-eval per
        contiguous run, not just on the first run.

        Layout: plies 10-11 = class 1, plies 12-13 = class 2, plies 14-15 = class 1.
        Expected entries: (10, class=1), (12, class=2), (14, class=1) → 3 evals.
        """
        user_id = 90007
        session_maker = _make_session_maker(test_engine)

        async with session_maker() as setup:
            await _ensure_user(setup, user_id)
            game = await _seed_game(setup, user_id=user_id)
            game_id = game.id

            layout = [
                (10, 1),
                (11, 1),
                (12, 2),
                (13, 2),
                (14, 1),
                (15, 1),
            ]
            for ply, ec in layout:
                setup.add(
                    GamePosition(
                        game_id=game_id,
                        user_id=user_id,
                        ply=ply,
                        full_hash=hash(f"{game_id}-{ply}") & 0x7FFFFFFFFFFFFFFF,
                        white_hash=hash(f"w-{game_id}-{ply}") & 0x7FFFFFFFFFFFFFFF,
                        black_hash=hash(f"b-{game_id}-{ply}") & 0x7FFFFFFFFFFFFFFF,
                        endgame_class=ec,
                        eval_cp=None,
                        eval_mate=None,
                    )
                )
            await setup.commit()

        try:
            with patch("scripts.archive.backfill_eval.EnginePool") as MockPoolCls:
                mock_pool = AsyncMock()
                mock_pool.evaluate = AsyncMock(return_value=(77, None))
                MockPoolCls.return_value = mock_pool
                mock_eval = mock_pool.evaluate
                await run_backfill(
                    db="dev",
                    user_id=user_id,
                    dry_run=False,
                    limit=None,
                    _session_maker=session_maker,
                )

            assert mock_eval.call_count == 3

            async with session_maker() as verify:
                # All three entry plies got the eval; the in-run plies stay NULL.
                for entry_ply in (10, 12, 14):
                    cp, mate = await _get_entry_eval(verify, game_id, entry_ply)
                    assert cp == 77, f"entry ply {entry_ply} should have eval_cp=77"
                    assert mate is None
                for non_entry_ply in (11, 13, 15):
                    cp, mate = await _get_entry_eval(verify, game_id, non_entry_ply)
                    assert cp is None, f"non-entry ply {non_entry_ply} should stay NULL"
                    assert mate is None
        finally:
            async with session_maker() as teardown:
                await _delete_user_data(teardown, user_id)
                await teardown.commit()
