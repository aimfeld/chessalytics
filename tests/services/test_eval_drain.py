"""Cold-drain architectural invariant tests for Phase 91.

Tests cover:
- gather-outside-session structural invariant (AST scan + static check)
- LIFO pick order (id DESC, batch=10)
- Idempotency: crash before commit leaves rows pending, re-picked next tick
- Engine (None, None) marks game completed — no permanent retry (D-09 / R-02)
- Partial index used for the LIFO pick query (ix_games_evals_pending EXPLAIN check)
- Cancellation propagates without retry (lifespan shutdown contract)

Integration tests that need to test code which opens its own sessions (like
run_eval_drain's helper functions) must commit data to the test DB and clean
up explicitly. We use the test_session_maker (backed by test_engine) directly
for test data inserts that need to be visible across sessions, and monkeypatch
app.services.eval_drain.async_session_maker to route drain sessions to the
test DB (same pattern as test_import_service.py).

Phase 91 / SEED-023 locked decisions exercised here:
    D-09: engine (None, None) → game still marked evals_completed_at = NOW()
    D-11: LIFO id-DESC, batch size = _DRAIN_BATCH_SIZE
    D-13: idle sleep = _DRAIN_IDLE_SLEEP_SECONDS (not tested for duration)
    T-91-06: stuck game at LIFO head gets marked done via D-09 guard
    T-91-08: gather-outside-session enforced by static AST test (CI regression)
    T-91-09: idempotency on crash verified by test_idempotent_on_simulated_crash
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import uuid
from datetime import timedelta, timezone
from datetime import datetime as dt
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.forcing_line_gate import PvNode

# No module-level `pytestmark = pytest.mark.asyncio`: asyncio_mode = "auto"
# (pyproject.toml) auto-marks every `async def` test, so the module mark was
# redundant — and it also stamped the sync tests in this file (e.g.
# test_gather_outside_session), emitting "marked with asyncio but not an async
# function" PytestWarnings.

# ─── Module-level test constants (CLAUDE.md: no magic numbers) ───────────────
LIFO_FIXTURE_GAME_COUNT: int = 15
_TEST_USER_ID: int = 99100  # unique per test module to avoid FK conflicts
_TEST_USER_ID_2: int = 99101  # second user for isolation tests
_SIMPLE_PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"


# ─── Session-scoped fixture: committed test user ───────────────────────────────


@pytest_asyncio.fixture(scope="session")
async def drain_test_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """Return an async_sessionmaker bound to the test engine.

    Used by integration tests to:
    1. Insert committed test data visible across sessions.
    2. Patch app.services.eval_drain.async_session_maker.
    """
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(scope="session", autouse=False)
async def drain_test_user(drain_test_session_maker: async_sessionmaker[AsyncSession]) -> int:
    """Ensure test user _TEST_USER_ID exists in the test DB (committed). Returns user_id."""
    from app.models.user import User

    async with drain_test_session_maker() as session:
        from sqlalchemy import select as sa_select

        result = await session.execute(sa_select(User).where(User.id == _TEST_USER_ID))
        if result.scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID,
                    email=f"drain-test-{_TEST_USER_ID}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID


async def _insert_and_commit_pending_games(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    n: int,
    pgn: str = _SIMPLE_PGN,
) -> list[int]:
    """Insert N Game rows with evals_completed_at=NULL and COMMIT. Returns inserted IDs.

    Commits so that other sessions (like drain helpers) can see the data.
    The caller is responsible for cleanup (DELETE games WHERE id IN ...).
    """
    from app.models.game import Game

    ids: list[int] = []
    async with session_maker() as session:
        for _ in range(n):
            g = Game(
                user_id=user_id,
                platform="chess.com",
                platform_game_id=f"drain-test-{uuid.uuid4().hex}",
                pgn=pgn,
                result="1-0",
                user_color="white",
                rated=True,
                is_computer_game=False,
            )
            session.add(g)
            await session.flush()
            ids.append(g.id)
        await session.commit()
    return ids


async def _delete_games_by_ids(
    session_maker: async_sessionmaker[AsyncSession],
    game_ids: list[int],
) -> None:
    """Delete games with the given IDs (committed cleanup for integration tests)."""
    from app.models.game import Game

    if not game_ids:
        return
    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.id.in_(game_ids)))
        await session.commit()


# ─── Test: gather-outside-session (static AST check) ──────────────────────────


class TestGatherOutsideSession:
    """T-91-08: asyncio.gather must NEVER be inside an AsyncSession scope.

    Task 2 (SEED-138) extracted run_eval_drain's per-tick body into
    _eval_drain_tick (mirroring _full_drain_tick) so the loop is thin enough
    to carry a per-tick Sentry isolation scope. run_eval_drain itself no
    longer contains a gather call at all, so this test parses the AST of
    _eval_drain_tick instead and fails if a future edit moves the gather
    call inside an `async with async_session_maker()` block. It acts as a
    CI regression guard for the core architectural invariant.
    """

    def test_gather_outside_session(self) -> None:
        """AST scan: asyncio.gather call in _eval_drain_tick is not inside an async-with block."""
        from app.services.eval_drain import _eval_drain_tick

        source = inspect.getsource(_eval_drain_tick)
        tree = ast.parse(source)

        # Walk the function body to find all `asyncio.gather(...)` Call nodes
        # and verify that none of them are nested inside an AsyncWith node.
        #
        # Strategy: track async-with scope depth during traversal.
        # When we encounter a gather() Call, its nesting depth must be 0.

        class GatherOutsideSessionChecker(ast.NodeVisitor):
            def __init__(self) -> None:
                self.violations: list[int] = []
                self.gather_calls_seen: int = 0
                self._async_with_stack: int = 0  # depth counter for async-with scopes

            def visit_AsyncWith(self, node: ast.AsyncWith) -> None:  # noqa: N802
                """Track entry/exit of async-with contexts."""
                self._async_with_stack += 1
                self.generic_visit(node)
                self._async_with_stack -= 1

            def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
                """Check if this is a gather() call inside an async-with scope."""
                func = node.func
                is_gather = False

                # Match `asyncio.gather(...)` form
                if isinstance(func, ast.Attribute):
                    if func.attr == "gather":
                        is_gather = True

                # Match `gather(...)` form (bare import)
                if isinstance(func, ast.Name) and func.id == "gather":
                    is_gather = True

                if is_gather:
                    self.gather_calls_seen += 1
                    if self._async_with_stack > 0:
                        self.violations.append(getattr(node, "lineno", -1))

                self.generic_visit(node)

        checker = GatherOutsideSessionChecker()
        checker.visit(tree)

        # A future rename of _eval_drain_tick (or a re-inlining into
        # run_eval_drain without updating this test) must fail loudly rather
        # than passing vacuously on zero observed gather calls.
        assert checker.gather_calls_seen >= 1, (
            "AST scan observed no asyncio.gather() call in _eval_drain_tick — "
            "the guard would pass vacuously; check the retarget is correct."
        )
        assert checker.violations == [], (
            f"asyncio.gather() found inside an async-with scope at line(s) "
            f"{checker.violations} in _eval_drain_tick — violates CLAUDE.md "
            f"hard rule (T-91-08 / SEED-023 architectural invariant)."
        )


# ─── Test: LIFO pick order ─────────────────────────────────────────────────────


class TestLifoOrder:
    """D-11: pick query returns the 10 highest IDs in descending order."""

    async def test_lifo_order(
        self,
        drain_test_user: int,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Insert 15 pending games; verify _pick_pending_game_ids returns 10 highest IDs DESC."""
        import app.services.eval_drain as drain_module
        from app.services.eval_drain import _DRAIN_BATCH_SIZE, _pick_pending_game_ids

        # Route drain sessions to test DB
        monkeypatch.setattr(drain_module, "async_session_maker", drain_test_session_maker)

        # Insert and commit LIFO_FIXTURE_GAME_COUNT games with NULL evals_completed_at
        all_ids = await _insert_and_commit_pending_games(
            drain_test_session_maker, drain_test_user, LIFO_FIXTURE_GAME_COUNT
        )
        try:
            # Pick the batch
            picked = await _pick_pending_game_ids(limit=_DRAIN_BATCH_SIZE)

            # Expect the 10 highest IDs in descending order (LIFO)
            expected = sorted(all_ids, reverse=True)[:_DRAIN_BATCH_SIZE]
            assert picked == expected, f"LIFO pick order wrong: expected {expected}, got {picked}"
        finally:
            await _delete_games_by_ids(drain_test_session_maker, all_ids)

    async def test_lifo_returns_at_most_batch_size(
        self,
        drain_test_user: int,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Insert 3 pending games; verify pick returns all 3 (< batch size)."""
        import app.services.eval_drain as drain_module
        from app.services.eval_drain import _DRAIN_BATCH_SIZE, _pick_pending_game_ids

        monkeypatch.setattr(drain_module, "async_session_maker", drain_test_session_maker)

        all_ids = await _insert_and_commit_pending_games(
            drain_test_session_maker, drain_test_user, 3
        )
        try:
            picked = await _pick_pending_game_ids(limit=_DRAIN_BATCH_SIZE)

            # Should return all 3, which are the highest IDs
            highest_3 = sorted(all_ids, reverse=True)
            # The picked set may include other games from other tests, but our 3 must all appear
            for gid in highest_3:
                assert gid in picked, f"Game {gid} not picked despite being pending"
        finally:
            await _delete_games_by_ids(drain_test_session_maker, all_ids)


# ─── Test: idempotency on simulated crash ──────────────────────────────────────


class TestIdempotentOnSimulatedCrash:
    """T-91-09: crash before commit leaves rows pending; they are re-picked."""

    async def test_idempotent_on_simulated_crash(
        self,
        drain_test_user: int,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Simulate a crash in _mark_evals_completed (before commit) and verify rows remain NULL.

        The idempotency invariant: if the drain crashes before session.commit(),
        all picked games remain evals_completed_at IS NULL and are re-picked on
        the next tick. We crash _mark_evals_completed (which runs inside the
        write-window session before commit) to exercise this invariant reliably.
        """
        import app.services.eval_drain as drain_module
        from app.services.eval_drain import (
            _DRAIN_BATCH_SIZE,
            _mark_evals_completed,
            _pick_pending_game_ids,
        )
        from app.models.game import Game

        # Route drain sessions to test DB
        monkeypatch.setattr(drain_module, "async_session_maker", drain_test_session_maker)

        # Track Sentry capture_exception calls
        capture_calls: list[Any] = []

        def mock_capture_exception(exc: Any = None) -> None:
            capture_calls.append(exc)

        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", mock_capture_exception)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_context", lambda *a, **kw: None)

        # Insert 3 pending games (committed so drain sessions can see them)
        game_ids = await _insert_and_commit_pending_games(
            drain_test_session_maker, drain_test_user, 3
        )
        try:
            # Monkeypatch _mark_evals_completed to raise before committing.
            # This simulates a crash INSIDE the write-window session, after
            # UPDATEs are issued but before session.commit() — the session
            # is rolled back and all picked games remain evals_completed_at IS NULL.
            original_mark = _mark_evals_completed

            async def crashing_mark(
                session: AsyncSession,
                ids: Any,
            ) -> None:
                raise RuntimeError("simulated crash before commit in _mark_evals_completed")

            monkeypatch.setattr(drain_module, "_mark_evals_completed", crashing_mark)

            # Drive one drain iteration; the exception should be caught by the
            # Exception handler in run_eval_drain and the loop sleeps.
            drain_task = asyncio.create_task(drain_module.run_eval_drain())
            try:
                await asyncio.wait_for(asyncio.shield(drain_task), timeout=0.5)
            except asyncio.TimeoutError:
                pass  # expected — drain is sleeping after the error
            drain_task.cancel()
            try:
                await drain_task
            except asyncio.CancelledError:
                pass

            # (a) All 3 games must still have evals_completed_at IS NULL
            async with drain_test_session_maker() as verify_session:
                result = await verify_session.execute(
                    select(Game.id, Game.evals_completed_at).where(Game.id.in_(game_ids))
                )
                rows = result.all()

            assert len(rows) == 3
            for row in rows:
                assert row.evals_completed_at is None, (
                    f"Game {row.id} has evals_completed_at set after simulated crash — "
                    f"idempotency invariant violated (T-91-09)"
                )

            # (b) Sentry capture_exception was called for the RuntimeError
            assert len(capture_calls) >= 1, (
                "sentry_sdk.capture_exception was not called after simulated crash"
            )

            # Restore original _mark_evals_completed for the re-pick check
            monkeypatch.setattr(drain_module, "_mark_evals_completed", original_mark)

            # (c) The SAME 3 games are re-pickable after their lease expires (TTL reclaim).
            # D-01 (Phase 123 SEED-051): _pick_pending_game_ids now commits a lease before
            # drain work, so games are NOT instantly re-pickable on crash — they're reclaimable
            # after entry_eval_lease_expiry < now().  Simulate expiry by back-dating leases.
            past_ts = dt.now(timezone.utc) - timedelta(minutes=5)
            async with drain_test_session_maker() as s:
                await s.execute(
                    sa.text("UPDATE games SET entry_eval_lease_expiry = :ts WHERE id = ANY(:ids)"),
                    {"ts": past_ts, "ids": game_ids},
                )
                await s.commit()

            picked_again = await _pick_pending_game_ids(limit=_DRAIN_BATCH_SIZE)
            for gid in game_ids:
                assert gid in picked_again, (
                    f"Game {gid} not re-picked after lease expiry (simulated crash + TTL reclaim "
                    f"— T-91-09 / D-01 invariant violated)"
                )
        finally:
            await _delete_games_by_ids(drain_test_session_maker, game_ids)


# ─── Test: engine (None, None) marks game complete ─────────────────────────────


class TestEngineNoneMarksComplete:
    """D-09 / R-02: engine returning (None, None) must NOT cause permanent retry."""

    async def test_engine_none_marks_complete(
        self,
        drain_test_user: int,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Monkeypatch engine.evaluate to always return (None, None); verify games marked done."""
        import app.services.eval_drain as drain_module
        from app.models.game import Game

        # Route drain sessions to test DB
        monkeypatch.setattr(drain_module, "async_session_maker", drain_test_session_maker)

        # Suppress Sentry calls
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_message", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_context", lambda *a, **kw: None)

        # Engine always returns (None, None)
        mock_evaluate = AsyncMock(return_value=(None, None))
        monkeypatch.setattr(drain_module.engine_service, "evaluate", mock_evaluate)

        # Insert 2 pending games with NULL evals_completed_at (committed so drain sees them)
        # No GamePosition rows — the drain will find 0 eval targets but still call
        # _mark_evals_completed for all picked game IDs (D-09 invariant).
        game_ids = await _insert_and_commit_pending_games(
            drain_test_session_maker, drain_test_user, 2
        )
        try:
            # Run one drain iteration with a short timeout.
            # The drain picks the games, finds 0 eval targets (no GamePosition rows),
            # skips _apply_eval_results, calls _mark_evals_completed, commits.
            drain_task = asyncio.create_task(drain_module.run_eval_drain())
            # Allow the drain to complete one full iteration (no eval targets → quick path)
            try:
                await asyncio.wait_for(asyncio.shield(drain_task), timeout=2.0)
            except asyncio.TimeoutError:
                pass  # drain goes back to idle sleep after processing
            drain_task.cancel()
            try:
                await drain_task
            except asyncio.CancelledError:
                pass

            # Both games must have evals_completed_at IS NOT NULL after the drain commits.
            async with drain_test_session_maker() as verify_session:
                result = await verify_session.execute(
                    select(Game.id, Game.evals_completed_at).where(Game.id.in_(game_ids))
                )
                rows = result.all()

            assert len(rows) == 2
            for row in rows:
                assert row.evals_completed_at is not None, (
                    f"Game {row.id} still has NULL evals_completed_at after drain iteration "
                    f"— D-09 / R-02 violated (engine returning (None,None) should not cause "
                    f"permanent retry; game must be marked complete)"
                )
        finally:
            await _delete_games_by_ids(drain_test_session_maker, game_ids)


# ─── Test: dead-pool all-fail circuit breaker leaves batch pending (Phase 148 item 2) ──


class TestDeadPoolAllFailLeavesPending:
    """Phase 148 item 2: a non-empty entry-ply batch where every engine eval

    returns (None, None) must NOT be stamped evals_completed_at — mirrors the
    full-ply WR-05 breaker (test_full_eval_drain.py::test_all_fail_keeps_game_pending).
    Must coexist with TestEngineNoneMarksComplete (D-09 zero-eval-target case),
    which asserts the OPPOSITE outcome for an empty eval_targets batch.
    """

    async def test_dead_pool_all_fail_leaves_batch_pending(
        self,
        drain_test_user: int,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Non-empty eval_targets, engine always (None, None) -> evals_completed_at stays NULL."""
        import app.services.eval_drain as drain_module
        from app.models.game import Game
        from app.models.game_position import GamePosition

        # Route drain sessions to test DB
        monkeypatch.setattr(drain_module, "async_session_maker", drain_test_session_maker)

        # Suppress unrelated Sentry calls; capture capture_message calls for assertion.
        capture_message_calls: list[Any] = []

        def mock_capture_message(*args: Any, **kwargs: Any) -> None:
            capture_message_calls.append((args, kwargs))

        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_message", mock_capture_message)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_context", lambda *a, **kw: None)

        # Engine always returns (None, None) — simulates a fully-dead pool.
        mock_evaluate = AsyncMock(return_value=(None, None))
        monkeypatch.setattr(drain_module.engine_service, "evaluate", mock_evaluate)

        # One pending game with a real midgame-entry GamePosition row (phase=1)
        # so eval_targets is non-empty — this is the load-bearing distinction
        # from TestEngineNoneMarksComplete (which uses zero GamePosition rows).
        game_ids = await _insert_and_commit_pending_games(
            drain_test_session_maker, drain_test_user, 1
        )
        game_id = game_ids[0]
        async with drain_test_session_maker() as session:
            session.add(
                GamePosition(
                    user_id=drain_test_user,
                    game_id=game_id,
                    ply=2,
                    full_hash=2,
                    white_hash=0,
                    black_hash=0,
                    phase=1,  # midgame entry — needs eval
                    endgame_class=None,
                    eval_cp=None,
                    eval_mate=None,
                )
            )
            await session.commit()
        try:
            drain_task = asyncio.create_task(drain_module.run_eval_drain())
            try:
                await asyncio.wait_for(asyncio.shield(drain_task), timeout=1.0)
            except asyncio.TimeoutError:
                pass  # expected — the breaker sleeps after the all-fail batch
            drain_task.cancel()
            try:
                await drain_task
            except asyncio.CancelledError:
                pass

            async with drain_test_session_maker() as verify_session:
                result = await verify_session.execute(
                    select(Game.evals_completed_at).where(Game.id == game_id)
                )
                evals_completed_at = result.scalar_one()

            assert evals_completed_at is None, (
                "Game with an all-fail non-empty eval batch was stamped "
                "evals_completed_at — dead-pool circuit breaker (Phase 148 item 2) "
                "did not trip"
            )
            assert len(capture_message_calls) >= 1, (
                "Expected one aggregated Sentry capture_message for the all-fail batch"
            )
        finally:
            await _delete_games_by_ids(drain_test_session_maker, game_ids)


# ─── Test: cancellation propagates ────────────────────────────────────────────


class TestCancellationPropagates:
    """Lifespan shutdown contract: CancelledError propagates from run_eval_drain."""

    async def test_cancellation_propagates(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Cancel run_eval_drain task; verify CancelledError is raised, not swallowed."""
        import app.services.eval_drain as drain_module

        # Route sessions to test DB (so pick query runs against test DB)
        monkeypatch.setattr(drain_module, "async_session_maker", drain_test_session_maker)

        # Suppress Sentry
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)

        # Start the drain task — it will find 0 pending games and sleep
        drain_task = asyncio.create_task(drain_module.run_eval_drain())

        # Give it a moment to enter the idle sleep
        await asyncio.sleep(0.05)

        # Cancel and await — must raise CancelledError
        drain_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await drain_task


# ─── Test: single-walk per-game target collection (Quick 260521-d6o) ──────────


def _make_ply_data(
    ply: int,
    *,
    phase: int = 0,
    endgame_class: int | None = None,
    eval_cp: int | None = None,
    eval_mate: int | None = None,
) -> dict[str, Any]:
    """Build a minimal PlyData dict for the single-walk tests.

    The fields used by the target collectors are ply, phase, endgame_class,
    eval_cp, eval_mate. Other fields are zero/None placeholders (PlyData is a
    TypedDict, not a dataclass, so the return type is `dict[str, Any]`).
    """
    return {
        "ply": ply,
        "phase": phase,
        "endgame_class": endgame_class,
        "eval_cp": eval_cp,
        "eval_mate": eval_mate,
        "white_hash": 0,
        "black_hash": 0,
        "full_hash": 0,
        "move_san": None,
        "clock_seconds": None,
    }


# A 10-move PGN (20 plies) used by the single-walk tests.
_LONG_PGN: str = (
    "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 "
    "6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *"
)


class TestSingleWalkTargetCollection:
    """Quick 260521-d6o: cold-drain target collection must parse each PGN once.

    Locks the single-walk invariant: a game with N entry plies (1 midgame +
    M endgame spans) triggers AT MOST ONE chess.pgn.read_game per outer
    collector call (i.e. the per-game helper does not re-parse for each ply).
    """

    def _install_read_game_counter(self, monkeypatch: pytest.MonkeyPatch) -> list[int]:
        """Patch chess.pgn.read_game in the eval_entry namespace with a counter wrapper.

        Phase 150 R7 Task 2: the single-walk collectors live in eval_entry.py now
        (moved from eval_drain.py) -- chess.pgn is a shared module object either way
        (patching it here affects the one real chess.pgn.read_game globally), but
        `import chess.pgn` itself only lives in eval_entry.py's namespace post-move.

        Returns a single-element list so the closure can mutate the counter.
        """
        import app.services.eval_entry as eval_entry_module

        original_read_game = eval_entry_module.chess.pgn.read_game
        counter: list[int] = [0]

        def counting_read_game(*args: Any, **kwargs: Any) -> Any:
            counter[0] += 1
            return original_read_game(*args, **kwargs)

        monkeypatch.setattr(eval_entry_module.chess.pgn, "read_game", counting_read_game)
        return counter

    async def test_single_parse_invariant(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 1: 1 midgame + 2 endgame span entries → read_game called ≤1 per collector."""
        from app.services.eval_drain import (
            _collect_endgame_span_eval_targets,
            _collect_midgame_eval_targets,
        )

        # Build plies_list: midgame entry at ply 4, endgame class=1 island at
        # plies 8-9, endgame class=2 island at plies 10-11.
        plies_list: list[Any] = [
            _make_ply_data(2, phase=0),
            _make_ply_data(4, phase=1),  # midgame entry — needs eval
            _make_ply_data(8, phase=2, endgame_class=1),  # class=1 island start
            _make_ply_data(9, phase=2, endgame_class=1),  # class=1 island continued
            _make_ply_data(10, phase=2, endgame_class=2),  # class=2 island start
            _make_ply_data(11, phase=2, endgame_class=2),  # class=2 island continued
        ]
        game_eval_data: list[Any] = [(1, _LONG_PGN, plies_list)]

        counter = self._install_read_game_counter(monkeypatch)
        midgame_targets = _collect_midgame_eval_targets(game_eval_data)
        midgame_parses = counter[0]
        endgame_targets = _collect_endgame_span_eval_targets(game_eval_data)
        endgame_parses = counter[0] - midgame_parses

        assert midgame_parses <= 1, (
            f"midgame collector parsed PGN {midgame_parses} times for a single game"
        )
        assert endgame_parses <= 1, (
            f"endgame collector parsed PGN {endgame_parses} times for a single game"
        )

        assert len(midgame_targets) == 1
        assert midgame_targets[0].ply == 4
        assert midgame_targets[0].eval_kind == "middlegame_entry"

        assert len(endgame_targets) == 2
        assert all(t.endgame_class is not None for t in endgame_targets)
        endgame_classes = sorted(cast(int, t.endgame_class) for t in endgame_targets)
        assert endgame_classes == [1, 2]
        for t in endgame_targets:
            assert t.eval_kind == "endgame_span_entry"

    async def test_covered_game_skips_parse(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 2: all candidate entry plies pre-covered → read_game NEVER invoked."""
        from app.services.eval_drain import (
            _collect_endgame_span_eval_targets,
            _collect_midgame_eval_targets,
        )

        plies_list: list[Any] = [
            _make_ply_data(4, phase=1, eval_cp=15),  # midgame pre-covered
            _make_ply_data(8, phase=2, endgame_class=1, eval_cp=20),
            _make_ply_data(10, phase=2, endgame_class=2, eval_mate=3),
        ]
        game_eval_data: list[Any] = [(1, _LONG_PGN, plies_list)]

        counter = self._install_read_game_counter(monkeypatch)
        midgame_targets = _collect_midgame_eval_targets(game_eval_data)
        endgame_targets = _collect_endgame_span_eval_targets(game_eval_data)

        assert midgame_targets == []
        assert endgame_targets == []
        assert counter[0] == 0, (
            f"read_game should not be called when every candidate is covered "
            f"(was called {counter[0]} times)"
        )

    async def test_parse_failure_returns_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test 3: unparseable PGN → both collectors return [] without raising."""
        import app.services.eval_entry as eval_entry_module
        from app.services.eval_drain import (
            _collect_endgame_span_eval_targets,
            _collect_midgame_eval_targets,
        )

        # Force read_game to return None (simulates unparseable PGN).
        monkeypatch.setattr(eval_entry_module.chess.pgn, "read_game", lambda *_a, **_kw: None)

        plies_list: list[Any] = [
            _make_ply_data(4, phase=1),  # midgame entry — needs board
            _make_ply_data(8, phase=2, endgame_class=1),
        ]
        game_eval_data: list[Any] = [(1, "not a valid pgn", plies_list)]

        midgame_targets = _collect_midgame_eval_targets(game_eval_data)
        endgame_targets = _collect_endgame_span_eval_targets(game_eval_data)

        assert midgame_targets == []
        assert endgame_targets == []

    async def test_mainline_ends_before_target_ply(self) -> None:
        """Test 4: unreachable endgame target silently dropped, reachable midgame kept."""
        from app.services.eval_drain import (
            _collect_endgame_span_eval_targets,
            _collect_midgame_eval_targets,
        )

        # 4-ply PGN (2 full moves).
        short_pgn = "1. e4 e5 2. Nf3 Nc6 *"
        plies_list: list[Any] = [
            _make_ply_data(2, phase=1),  # midgame entry — reachable
            _make_ply_data(20, phase=2, endgame_class=1),  # unreachable
        ]
        game_eval_data: list[Any] = [(1, short_pgn, plies_list)]

        midgame_targets = _collect_midgame_eval_targets(game_eval_data)
        endgame_targets = _collect_endgame_span_eval_targets(game_eval_data)

        assert len(midgame_targets) == 1
        assert midgame_targets[0].ply == 2
        assert endgame_targets == []

    async def test_midgame_covered_endgame_uncovered(self) -> None:
        """Test 5: midgame entry pre-covered, endgame uncovered → only endgame target."""
        from app.services.eval_drain import (
            _collect_endgame_span_eval_targets,
            _collect_midgame_eval_targets,
        )

        plies_list: list[Any] = [
            _make_ply_data(4, phase=1, eval_cp=15),  # midgame pre-covered (lichess)
            _make_ply_data(8, phase=2, endgame_class=1),  # endgame uncovered
        ]
        game_eval_data: list[Any] = [(1, _LONG_PGN, plies_list)]

        midgame_targets = _collect_midgame_eval_targets(game_eval_data)
        endgame_targets = _collect_endgame_span_eval_targets(game_eval_data)

        assert midgame_targets == []
        assert len(endgame_targets) == 1
        assert endgame_targets[0].endgame_class == 1
        assert endgame_targets[0].ply == 8

    async def test_multiple_islands_same_class(self) -> None:
        """Test 6: class=1 at [5,6,7], class=2 at [8], class=1 at [9,10] → 3 targets."""
        from app.services.eval_drain import _collect_endgame_span_eval_targets

        plies_list: list[Any] = [
            _make_ply_data(5, phase=2, endgame_class=1),
            _make_ply_data(6, phase=2, endgame_class=1),
            _make_ply_data(7, phase=2, endgame_class=1),
            _make_ply_data(8, phase=2, endgame_class=2),
            _make_ply_data(9, phase=2, endgame_class=1),
            _make_ply_data(10, phase=2, endgame_class=1),
        ]
        game_eval_data: list[Any] = [(1, _LONG_PGN, plies_list)]

        endgame_targets = _collect_endgame_span_eval_targets(game_eval_data)

        # Expect 3 islands: class=1 at ply 5, class=2 at ply 8, class=1 at ply 9.
        assert len(endgame_targets) == 3
        by_ply = sorted(endgame_targets, key=lambda t: t.ply)
        assert (by_ply[0].ply, by_ply[0].endgame_class) == (5, 1)
        assert (by_ply[1].ply, by_ply[1].endgame_class) == (8, 2)
        assert (by_ply[2].ply, by_ply[2].endgame_class) == (9, 1)

    async def test_board_snapshot_is_pre_push(self) -> None:
        """Test 7: midgame entry at ply=2 → board has e4 + e5 played, Nf3 NOT yet pushed."""
        import chess as chess_lib

        from app.services.eval_drain import _collect_midgame_eval_targets

        pgn = "1. e4 e5 2. Nf3 *"
        plies_list: list[Any] = [_make_ply_data(2, phase=1)]
        game_eval_data: list[Any] = [(1, pgn, plies_list)]

        midgame_targets = _collect_midgame_eval_targets(game_eval_data)

        assert len(midgame_targets) == 1
        board = midgame_targets[0].board

        # Expected: after 1. e4 e5, before 2. Nf3 — white to move, knight on g1.
        expected = chess_lib.Board()
        expected.push_san("e4")
        expected.push_san("e5")
        assert board.board_fen() == expected.board_fen()
        assert board.turn == chess_lib.WHITE
        # Knight still on its starting square.
        assert board.piece_at(chess_lib.G1) is not None
        knight = board.piece_at(chess_lib.G1)
        assert knight is not None
        assert knight.piece_type == chess_lib.KNIGHT


# ─── SEED-052: batched entry-ply eval write regression ────────────────────────


async def _insert_entry_positions(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    rows: list[dict[str, Any]],
) -> None:
    """Insert GamePosition rows for a game and commit (SEED-052 test helper).

    Each dict: {"ply": int, "endgame_class": int|None}. eval_cp/eval_mate start
    NULL so the test can assert the batched UPDATE wrote them.
    """
    from app.models.game_position import GamePosition

    async with session_maker() as session:
        for r in rows:
            session.add(
                GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=r["ply"],
                    full_hash=r["ply"],  # any non-null int; uniqueness not required here
                    white_hash=0,
                    black_hash=0,
                    phase=0,
                    endgame_class=r.get("endgame_class"),
                    eval_cp=None,
                    eval_mate=None,
                )
            )
        await session.commit()


class TestBatchedEntryEvalWrite:
    """SEED-052: _apply_eval_results batches the per-row UPDATE into one round-trip.

    Mirrors the full-ply lane's 260616-jq1 / FLAWCHESS-6B fix on the entry-ply lane.
    Asserts the batched write spans multiple games, honors the optional endgame_class
    disambiguation, preserves the (None, None) skip + counts, and never clobbers a row
    whose endgame_class does not match the target.
    """

    async def test_batched_write_multi_game_multi_class(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
        drain_test_user: int,
    ) -> None:
        import chess

        from app.models.game_position import GamePosition
        from app.services.eval_drain import _apply_eval_results, _EvalTarget

        user_id = drain_test_user
        game_ids = await _insert_and_commit_pending_games(drain_test_session_maker, user_id, n=2)
        g1, g2 = game_ids[0], game_ids[1]

        # g1: a middlegame entry (endgame_class=None) at ply 6, plus a failure ply 8.
        # g2: an endgame span entry (endgame_class=3) at ply 40, plus a row whose
        #     actual endgame_class is 5 that a class=2 target must NOT overwrite.
        await _insert_entry_positions(
            drain_test_session_maker,
            user_id,
            g1,
            [{"ply": 6, "endgame_class": None}, {"ply": 8, "endgame_class": None}],
        )
        await _insert_entry_positions(
            drain_test_session_maker,
            user_id,
            g2,
            [{"ply": 40, "endgame_class": 3}, {"ply": 42, "endgame_class": 5}],
        )

        board = chess.Board()
        targets = [
            _EvalTarget(
                game_id=g1,
                ply=6,
                eval_kind="middlegame_entry",
                endgame_class=None,
                board=board,
            ),
            _EvalTarget(
                game_id=g1,
                ply=8,
                eval_kind="middlegame_entry",
                endgame_class=None,
                board=board,
            ),
            _EvalTarget(
                game_id=g2,
                ply=40,
                eval_kind="endgame_span_entry",
                endgame_class=3,
                board=board,
            ),
            _EvalTarget(
                game_id=g2,
                ply=42,
                eval_kind="endgame_span_entry",
                endgame_class=2,
                board=board,  # mismatch vs row's actual class 5
            ),
        ]
        results: list[tuple[int | None, int | None]] = [
            (55, None),  # g1 ply 6 — eval_cp
            (None, None),  # g1 ply 8 — engine failure (skip + Sentry)
            (None, 4),  # g2 ply 40 — eval_mate
            (-30, None),  # g2 ply 42 — class mismatch, must NOT land
        ]

        try:
            async with drain_test_session_maker() as session:
                made, failed = await _apply_eval_results(session, targets, results)
                await session.commit()

            assert made == 4
            assert failed == 1

            async with drain_test_session_maker() as session:
                got = (
                    await session.execute(
                        select(
                            GamePosition.game_id,
                            GamePosition.ply,
                            GamePosition.eval_cp,
                            GamePosition.eval_mate,
                        ).where(GamePosition.game_id.in_([g1, g2]))
                    )
                ).all()
            by_key = {(r[0], r[1]): (r[2], r[3]) for r in got}

            assert by_key[(g1, 6)] == (55, None)  # eval_cp written
            assert by_key[(g1, 8)] == (None, None)  # (None, None) skip — stays NULL
            assert by_key[(g2, 40)] == (None, 4)  # eval_mate written, class=3 matched
            assert by_key[(g2, 42)] == (None, None)  # class mismatch — untouched
        finally:
            await _delete_games_by_ids(drain_test_session_maker, game_ids)


# ─── SEED-053: opening-eval cache read/write tests ────────────────────────────

# Unique hash values used across the three cache tests (avoid collisions with
# other test helpers that use ply=0 or small integers as full_hash).
_CACHE_HASH_A: int = 9_900_000_001  # shared by two fixture games — will be cached once
_CACHE_HASH_B: int = 9_900_000_002  # standalone opening position
_CACHE_HASH_C: int = 9_900_000_003  # flaw-adjacent ply in the fixture — excluded from dedup
_CACHE_HASH_TERMINAL: int = 9_900_000_004  # terminal donor hash — must NOT be cached
_CACHE_HASH_DEEP: int = 9_900_000_005  # ply > DEDUP_MAX_PLY — must NOT be cached
_CACHE_HASH_MISS: int = 9_900_000_099  # a hash that is NOT in the cache


async def _seed_opening_eval_cache(
    session_maker: async_sessionmaker[AsyncSession],
    rows: list[tuple[int, int | None, int | None, str | None]],
) -> None:
    """Insert rows into opening_position_eval and commit.

    Each tuple: (full_hash, eval_cp, eval_mate, best_move).
    Uses INSERT … ON CONFLICT (full_hash) DO NOTHING so the helper is safe to
    call multiple times with overlapping hashes.
    """
    import sqlalchemy as sa_local

    async with session_maker() as session:
        for fh, cp, mate, bm in rows:
            await session.execute(
                sa_local.text(
                    "INSERT INTO opening_position_eval (full_hash, eval_cp, eval_mate, best_move)"
                    " VALUES (:fh, :cp, :mate, :bm)"
                    " ON CONFLICT (full_hash) DO NOTHING"
                ),
                {"fh": fh, "cp": cp, "mate": mate, "bm": bm},
            )
        await session.commit()


async def _delete_opening_eval_rows(
    session_maker: async_sessionmaker[AsyncSession],
    hashes: list[int],
) -> None:
    """Delete opening_position_eval rows by full_hash and commit (test cleanup)."""
    import sqlalchemy as sa_local

    async with session_maker() as session:
        await session.execute(
            sa_local.text("DELETE FROM opening_position_eval WHERE full_hash = ANY(:hashes)"),
            {"hashes": hashes},
        )
        await session.commit()


class TestOpeningEvalCacheRead:
    """SEED-053 / D-123.1-05: _fetch_dedup_evals reads the opening_position_eval cache.

    Read-equivalence test: seed opening_position_eval directly, call _fetch_dedup_evals,
    assert the result matches the expected (eval_cp, eval_mate, best_move) values.
    The test also verifies that a hash NOT in the cache is absent from the result
    (equivalent to the former self-join returning no donor row for that hash).
    """

    async def test_cache_backed_fetch_dedup_evals(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """_fetch_dedup_evals returns cache contents for present hashes; absent hashes omitted."""
        from app.services.eval_drain import _fetch_dedup_evals

        # Seed: hash A has a cp eval + best_move; hash B has a mate-only eval.
        seed_rows: list[tuple[int, int | None, int | None, str | None]] = [
            (_CACHE_HASH_A, 42, None, "e2e4"),
            (_CACHE_HASH_B, None, 3, "d1h5"),
        ]
        cleanup_hashes = [_CACHE_HASH_A, _CACHE_HASH_B]
        await _seed_opening_eval_cache(drain_test_session_maker, seed_rows)
        try:
            # Request hash A, hash B, and a hash that is not in the cache (_CACHE_HASH_MISS).
            request_hashes = [_CACHE_HASH_A, _CACHE_HASH_B, _CACHE_HASH_MISS]
            async with drain_test_session_maker() as session:
                result = await _fetch_dedup_evals(session, request_hashes)

            # Hash A and B should be in the result; the miss hash must NOT be present.
            assert _CACHE_HASH_A in result, "cached hash A must be returned"
            assert _CACHE_HASH_B in result, "cached hash B must be returned"
            assert _CACHE_HASH_MISS not in result, "uncached hash must be absent"

            # Values must match what was seeded (4-tuple incl. pv — SEED-076 follow-up).
            assert result[_CACHE_HASH_A] == (42, None, "e2e4", None), (
                f"hash A: expected (42, None, 'e2e4', None), got {result[_CACHE_HASH_A]}"
            )
            assert result[_CACHE_HASH_B] == (None, 3, "d1h5", None), (
                f"hash B: expected (None, 3, 'd1h5', None), got {result[_CACHE_HASH_B]}"
            )
        finally:
            await _delete_opening_eval_rows(drain_test_session_maker, cleanup_hashes)

    async def test_empty_hash_list_returns_empty_dict(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Empty input must short-circuit and return {} without hitting the DB."""
        from app.services.eval_drain import _fetch_dedup_evals

        async with drain_test_session_maker() as session:
            result = await _fetch_dedup_evals(session, [])
        assert result == {}, f"expected empty dict, got {result}"


class TestOpeningEvalCacheWrite:
    """SEED-053 / D-123.1-04: _upsert_opening_cache fills the cache from engine results.

    Write-population test: construct engine_targets and engine_result_map representing
    a mix of cacheable positions, excluded positions (terminal, deep ply, null eval),
    and verify the correct subset lands in opening_position_eval.

    Idempotency test: calling _upsert_opening_cache a second time (or pre-seeding the
    table with a conflicting value for the same hash) leaves the original row unchanged.
    """

    async def _make_engine_targets_and_results(
        self,
    ) -> tuple[
        list[Any],
        dict[int, tuple[int | None, int | None, str | None, str | None]],
    ]:
        """Build a small set of _FullPlyEvalTarget instances and a matching engine_result_map.

        Targets:
          - ply=2, hash=_CACHE_HASH_A: cacheable (ply<=DEDUP_MAX_PLY, not terminal, real eval)
          - ply=4, hash=_CACHE_HASH_B: cacheable, mate-only eval
          - ply=6, hash=_CACHE_HASH_C: null eval (engine failure) — must NOT be cached
          - ply=99, hash=_CACHE_HASH_DEEP: ply > DEDUP_MAX_PLY — must NOT be cached
          - ply=0, hash=_CACHE_HASH_TERMINAL, is_terminal=True — must NOT be cached

        Returns (engine_targets, engine_result_map).
        """
        import chess

        from app.models.game_position import DEDUP_MAX_PLY
        from app.services.eval_drain import _FullPlyEvalTarget

        board = chess.Board()

        # ply=2, cp eval + best_move
        t_a = _FullPlyEvalTarget(
            game_id=99999,
            ply=2,
            full_hash=_CACHE_HASH_A,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        # ply=4, mate-only eval
        t_b = _FullPlyEvalTarget(
            game_id=99999,
            ply=4,
            full_hash=_CACHE_HASH_B,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        # ply=6, null eval (engine failure) — engine returns (None, None, None, None)
        t_null = _FullPlyEvalTarget(
            game_id=99999,
            ply=6,
            full_hash=_CACHE_HASH_C,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        # ply > DEDUP_MAX_PLY — must be excluded even with a real eval
        deep_ply = DEDUP_MAX_PLY + 1
        t_deep = _FullPlyEvalTarget(
            game_id=99999,
            ply=deep_ply,
            full_hash=_CACHE_HASH_DEEP,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        # Terminal donor — must be excluded
        t_terminal = _FullPlyEvalTarget(
            game_id=99999,
            ply=0,
            full_hash=_CACHE_HASH_TERMINAL,
            board=board,
            eval_cp=None,
            eval_mate=None,
            is_terminal=True,
        )

        engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
            2: (77, None, "e2e4", None),  # hash A: cp eval
            4: (None, 2, "d1h5", None),  # hash B: mate eval
            6: (None, None, None, None),  # null eval — excluded
            deep_ply: (50, None, "a2a4", None),  # deep — excluded
            0: (0, None, None, None),  # terminal — excluded (is_terminal=True)
        }
        return [t_a, t_b, t_null, t_deep, t_terminal], engine_result_map

    async def test_write_population_includes_and_excludes(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Freshly-computed opening misses land in the cache; excluded targets do not."""
        from app.services.eval_drain import _upsert_opening_cache

        engine_targets, engine_result_map = await self._make_engine_targets_and_results()
        cleanup_hashes = [
            _CACHE_HASH_A,
            _CACHE_HASH_B,
            _CACHE_HASH_C,
            _CACHE_HASH_DEEP,
            _CACHE_HASH_TERMINAL,
        ]
        # Ensure no stale rows from a prior run.
        await _delete_opening_eval_rows(drain_test_session_maker, cleanup_hashes)

        try:
            async with drain_test_session_maker() as session:
                await _upsert_opening_cache(session, engine_targets, engine_result_map)
                await session.commit()

            # Verify inclusions — hash A and B must now be in the cache.
            async with drain_test_session_maker() as session:
                from app.models.opening_position_eval import OpeningPositionEval

                rows = (
                    await session.execute(
                        select(
                            OpeningPositionEval.full_hash,
                            OpeningPositionEval.eval_cp,
                            OpeningPositionEval.eval_mate,
                            OpeningPositionEval.best_move,
                        ).where(OpeningPositionEval.full_hash.in_(cleanup_hashes))
                    )
                ).all()
            cached = {r[0]: (r[1], r[2], r[3]) for r in rows}

            # Included: fresh engine opening misses
            assert _CACHE_HASH_A in cached, "hash A (ply=2, cp eval) must be cached"
            assert cached[_CACHE_HASH_A] == (77, None, "e2e4"), (
                f"hash A values wrong: {cached[_CACHE_HASH_A]}"
            )
            assert _CACHE_HASH_B in cached, "hash B (ply=4, mate eval) must be cached"
            assert cached[_CACHE_HASH_B] == (None, 2, "d1h5"), (
                f"hash B values wrong: {cached[_CACHE_HASH_B]}"
            )

            # Excluded: null eval, deep ply, terminal donor
            assert _CACHE_HASH_C not in cached, "null-eval hash must NOT be cached"
            assert _CACHE_HASH_DEEP not in cached, "deep-ply hash must NOT be cached"
            assert _CACHE_HASH_TERMINAL not in cached, "terminal donor must NOT be cached"

        finally:
            await _delete_opening_eval_rows(drain_test_session_maker, cleanup_hashes)

    async def test_idempotency_first_write_wins(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """ON CONFLICT DO NOTHING: a second upsert leaves the original cached row unchanged."""
        from app.services.eval_drain import _upsert_opening_cache
        from app.models.opening_position_eval import OpeningPositionEval
        import chess

        from app.services.eval_drain import _FullPlyEvalTarget

        board = chess.Board()
        # Pre-seed hash A with the original value.
        original_value: tuple[int, None, str] = (42, None, "e2e4")
        await _seed_opening_eval_cache(
            drain_test_session_maker,
            [(_CACHE_HASH_A, original_value[0], original_value[1], original_value[2])],
        )

        # Now run _upsert_opening_cache with a DIFFERENT value for the same hash.
        conflicting_cp = 99
        conflicting_bm = "a2a4"
        t_conflict = _FullPlyEvalTarget(
            game_id=99999,
            ply=2,
            full_hash=_CACHE_HASH_A,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        conflict_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
            2: (conflicting_cp, None, conflicting_bm, None),
        }

        try:
            async with drain_test_session_maker() as session:
                await _upsert_opening_cache(session, [t_conflict], conflict_result_map)
                await session.commit()

            # Original value must be unchanged.
            async with drain_test_session_maker() as session:
                row = (
                    await session.execute(
                        select(
                            OpeningPositionEval.eval_cp,
                            OpeningPositionEval.eval_mate,
                            OpeningPositionEval.best_move,
                        ).where(OpeningPositionEval.full_hash == _CACHE_HASH_A)
                    )
                ).one_or_none()

            assert row is not None, "cache row must still exist after conflict"
            assert row[0] == original_value[0], (
                f"eval_cp changed: expected {original_value[0]}, got {row[0]}"
            )
            assert row[1] == original_value[1], (
                f"eval_mate changed: expected {original_value[1]}, got {row[1]}"
            )
            assert row[2] == original_value[2], (
                f"best_move changed: expected {original_value[2]!r}, got {row[2]!r}"
            )
        finally:
            await _delete_opening_eval_rows(drain_test_session_maker, [_CACHE_HASH_A])

    async def test_transposition_duplicate_full_hash_deduped(
        self,
        drain_test_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """FLAWCHESS-8E: two plies reaching the same position must not crash the upsert.

        A single game can reach the same board position at two different plies (a
        transposition or repetition). Both plies produce a cache row with the same
        full_hash, and Postgres rejects INSERT ... ON CONFLICT when two proposed rows
        share the conflict key (CardinalityViolationError). The upsert must collapse
        duplicates and prefer a pv-bearing row so the pv backfill still works.
        """
        from app.services.eval_drain import _upsert_opening_cache, _FullPlyEvalTarget
        from app.models.opening_position_eval import OpeningPositionEval
        import chess

        board = chess.Board()
        # Two targets at different plies but the SAME full_hash (the transposition).
        t_first = _FullPlyEvalTarget(
            game_id=99999,
            ply=2,
            full_hash=_CACHE_HASH_A,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        t_second = _FullPlyEvalTarget(
            game_id=99999,
            ply=6,
            full_hash=_CACHE_HASH_A,
            board=board,
            eval_cp=None,
            eval_mate=None,
        )
        # First occurrence has no pv; second carries one — dedup must keep the pv row.
        result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
            2: (55, None, "e2e4", None),
            6: (55, None, "e2e4", "e2e4 e7e5"),
        }
        await _delete_opening_eval_rows(drain_test_session_maker, [_CACHE_HASH_A])

        try:
            async with drain_test_session_maker() as session:
                # Must not raise CardinalityViolationError.
                await _upsert_opening_cache(session, [t_first, t_second], result_map)
                await session.commit()

            async with drain_test_session_maker() as session:
                row = (
                    await session.execute(
                        select(
                            OpeningPositionEval.eval_cp,
                            OpeningPositionEval.best_move,
                            OpeningPositionEval.pv,
                        ).where(OpeningPositionEval.full_hash == _CACHE_HASH_A)
                    )
                ).one_or_none()

            assert row is not None, "transposition position must be cached exactly once"
            assert row[0] == 55, f"eval_cp wrong: {row[0]}"
            assert row[2] == "e2e4 e7e5", f"dedup must prefer the pv-bearing row, got pv={row[2]!r}"
        finally:
            await _delete_opening_eval_rows(drain_test_session_maker, [_CACHE_HASH_A])


# ─── Phase 145 Plan 03: _build_flaw_blob_lease_positions tests ────────────────
#
# PGN used throughout: "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"
# Half-move (ply) sequence:
#   ply 0 = initial board (before e4)
#   ply 1 = after 1. e4  (e4)
#   ply 2 = after 1... e5 (e5)   ← flaw ply in tests below
#   ply 3 = after 2. Nf3 (Nf3)
# Missed line walks from board-at-ply-2 using game_positions.pv at ply 2.
# Allowed line walks from board-at-ply-3 using game_positions.pv at ply 3.
_LEASE_BUILD_PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"
_LEASE_BUILD_FLAW_PLY: int = 2  # artificial flaw ply for the tests

# A valid 2-move PV from the e5 position (ply 2): Nf3 then Nc6.
_WALKABLE_PV_AT_PLY_2: str = "g1f3 b8c6"  # 2 moves → walk len 3 (nodes 0, 1, 2)
# A valid 1-move PV from the Nf3 position (ply 3): Nc6.
_WALKABLE_PV_AT_PLY_3: str = "b8c6"  # 1 move → walk len 2 (nodes 0, 1)


@pytest_asyncio.fixture(scope="session")
async def lease_build_test_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """async_sessionmaker bound to the test engine for lease-builder tests."""
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(scope="session")
async def lease_build_test_user(
    lease_build_test_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure a unique non-guest test user exists for lease-builder tests. Returns user_id."""
    from app.models.user import User

    _LEASE_BUILD_USER_ID = 99120  # unique range for this test class

    async with lease_build_test_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _LEASE_BUILD_USER_ID))
        if result.scalar_one_or_none() is None:
            session.add(
                User(
                    id=_LEASE_BUILD_USER_ID,
                    email=f"lease-build-test-{_LEASE_BUILD_USER_ID}@example.com",
                    hashed_password="fakehash",
                    is_active=True,
                    is_superuser=False,
                    is_verified=True,
                )
            )
            await session.commit()
    return _LEASE_BUILD_USER_ID


async def _insert_lease_build_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    *,
    pgn: str = _LEASE_BUILD_PGN,
    full_evals_completed_at: dt | None = None,
) -> int:
    """Insert an analyzed game row and commit. Returns game_id."""
    from app.models.game import Game

    async with session_maker() as session:
        g = Game(
            user_id=user_id,
            platform="chess.com",
            platform_game_id=f"lease-build-{uuid.uuid4().hex}",
            pgn=pgn,
            result="1-0",
            user_color="white",
            rated=True,
            is_computer_game=False,
            full_evals_completed_at=full_evals_completed_at or dt.now(timezone.utc),
        )
        session.add(g)
        await session.flush()
        game_id = int(g.id)  # type: ignore[arg-type]
        await session.commit()
    return game_id


async def _insert_game_position_with_pv(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    ply: int,
    pv: str | None,
) -> None:
    """Insert a GamePosition row with a PV string at the given ply and commit."""
    from app.models.game_position import GamePosition

    async with session_maker() as session:
        gp = GamePosition(
            user_id=user_id,
            game_id=game_id,
            ply=ply,
            full_hash=hash((game_id, ply)) & 0x7FFFFFFFFFFFFFFF,
            white_hash=0,
            black_hash=0,
            pv=pv,
        )
        session.add(gp)
        await session.commit()


async def _insert_null_blob_flaw(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    ply: int,
) -> None:
    """Insert a GameFlaw row with allowed_pv_lines = SQL NULL (not set) and commit."""
    from app.models.game_flaw import GameFlaw

    async with session_maker() as session:
        flaw = GameFlaw(
            user_id=user_id,
            game_id=game_id,
            ply=ply,
            severity=2,
            phase=0,
            is_miss=False,
            is_lucky=False,
            is_reversed=False,
            is_squandered=False,
            fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
        )
        # Do NOT set allowed_pv_lines → PostgreSQL stores SQL NULL (asyncpg JSONB caution)
        session.add(flaw)
        await session.commit()


async def _delete_lease_build_games(
    session_maker: async_sessionmaker[AsyncSession],
    game_ids: list[int],
) -> None:
    """Delete games by ID (cascades to game_positions, game_flaws). Committed cleanup."""
    from app.models.game import Game

    if not game_ids:
        return
    async with session_maker() as session:
        await session.execute(sa.delete(Game).where(Game.id.in_(game_ids)))
        await session.commit()


class TestBuildFlawBlobLeasePositions:
    """Phase 145 Plan 03: _build_flaw_blob_lease_positions correctness.

    Tests:
    - lease_build_normal: walkable PV → N tokens with correct {flaw_ply}:{line}:{node_k}
    - lease_build_null_pv_sentinel: NULL pv → zero positions, one sentinel entry
    - lease_build_lichess_identical: lichess %eval game → same output as engine game
    """

    async def test_lease_build_normal_walkable_line(
        self,
        monkeypatch: pytest.MonkeyPatch,
        lease_build_test_session_maker: async_sessionmaker[AsyncSession],
        lease_build_test_user: int,
    ) -> None:
        """Walkable PV (>= 2 nodes) → lease positions with correct token format."""
        import app.services.eval_apply as eval_apply_module
        import app.services.eval_drain as eval_drain_module
        from app.services.eval_drain import _build_flaw_blob_lease_positions

        monkeypatch.setattr(
            eval_drain_module, "async_session_maker", lease_build_test_session_maker
        )
        # Phase 150 R7: _build_flaw_blob_lease_positions moved to eval_apply.py and
        # opens its own internal session there -- redirect that binding too.
        monkeypatch.setattr(
            eval_apply_module, "async_session_maker", lease_build_test_session_maker
        )

        user_id = lease_build_test_user
        game_id = await _insert_lease_build_game(lease_build_test_session_maker, user_id)
        await _insert_null_blob_flaw(
            lease_build_test_session_maker, user_id, game_id, _LEASE_BUILD_FLAW_PLY
        )
        # ply 2 (missed start): walkable PV with 2 moves → 3 nodes (k=0, 1, 2)
        await _insert_game_position_with_pv(
            lease_build_test_session_maker,
            user_id,
            game_id,
            _LEASE_BUILD_FLAW_PLY,
            _WALKABLE_PV_AT_PLY_2,
        )
        # ply 3 (allowed start): walkable PV with 1 move → 2 nodes (k=0, 1)
        await _insert_game_position_with_pv(
            lease_build_test_session_maker,
            user_id,
            game_id,
            _LEASE_BUILD_FLAW_PLY + 1,
            _WALKABLE_PV_AT_PLY_3,
        )

        try:
            positions, sentinels = await _build_flaw_blob_lease_positions(game_id)

            # Both lines are walkable → no sentinels
            assert len(sentinels) == 0, f"Expected no sentinels for walkable PV, got {sentinels}"

            # SEED-079: only even (solver) node_k are leased — the gate never reads
            # odd (defender) nodes, so they are not engine-evaluated.
            # Missed line: 2-move PV → walk nodes 0, 1, 2 → even tokens k=0, k=2 only.
            missed_tokens = [p.token for p in positions if ":missed:" in p.token]
            assert len(missed_tokens) == 2, f"Expected 2 missed tokens, got {missed_tokens}"
            assert "2:missed:0" in missed_tokens, f"Token '2:missed:0' not found in {missed_tokens}"
            assert "2:missed:2" in missed_tokens, f"Token '2:missed:2' not found in {missed_tokens}"
            assert "2:missed:1" not in missed_tokens, (
                f"Odd (defender) node_k must not be leased (SEED-079), got {missed_tokens}"
            )

            # Allowed line: 1-move PV → walk nodes 0, 1 → even token k=0 only.
            allowed_tokens = [p.token for p in positions if ":allowed:" in p.token]
            assert len(allowed_tokens) == 1, f"Expected 1 allowed token, got {allowed_tokens}"
            assert "2:allowed:0" in allowed_tokens, (
                f"Token '2:allowed:0' not found in {allowed_tokens}"
            )

            # All positions have non-empty FEN strings
            for pos in positions:
                assert pos.fen, f"FEN must be non-empty for token {pos.token}"
        finally:
            await _delete_lease_build_games(lease_build_test_session_maker, [game_id])

    async def test_lease_build_null_pv_sentinel(
        self,
        monkeypatch: pytest.MonkeyPatch,
        lease_build_test_session_maker: async_sessionmaker[AsyncSession],
        lease_build_test_user: int,
    ) -> None:
        """NULL pv at flaw ply → zero lease positions and one sentinel entry."""
        import app.services.eval_apply as eval_apply_module
        import app.services.eval_drain as eval_drain_module
        from app.services.eval_drain import _build_flaw_blob_lease_positions

        monkeypatch.setattr(
            eval_drain_module, "async_session_maker", lease_build_test_session_maker
        )
        # Phase 150 R7: _build_flaw_blob_lease_positions moved to eval_apply.py and
        # opens its own internal session there -- redirect that binding too.
        monkeypatch.setattr(
            eval_apply_module, "async_session_maker", lease_build_test_session_maker
        )

        user_id = lease_build_test_user
        game_id = await _insert_lease_build_game(lease_build_test_session_maker, user_id)
        await _insert_null_blob_flaw(
            lease_build_test_session_maker, user_id, game_id, _LEASE_BUILD_FLAW_PLY
        )
        # NULL pv at ply 2 → missed line walk = 1 node (just start board) → sentinel
        await _insert_game_position_with_pv(
            lease_build_test_session_maker, user_id, game_id, _LEASE_BUILD_FLAW_PLY, None
        )
        # No position at ply 3 → allowed line has no start board → sentinel

        try:
            positions, sentinels = await _build_flaw_blob_lease_positions(game_id)

            # No walkable lines → no lease positions
            assert len(positions) == 0, f"Expected 0 positions for NULL PV, got {len(positions)}"

            # Both lines become sentinels
            assert (_LEASE_BUILD_FLAW_PLY, "missed") in sentinels, (
                f"Expected sentinel for (ply={_LEASE_BUILD_FLAW_PLY}, 'missed'), got {sentinels}"
            )
            assert (_LEASE_BUILD_FLAW_PLY, "allowed") in sentinels, (
                f"Expected sentinel for (ply={_LEASE_BUILD_FLAW_PLY}, 'allowed'), got {sentinels}"
            )
        finally:
            await _delete_lease_build_games(lease_build_test_session_maker, [game_id])

    async def test_lease_build_lichess_game_identical(
        self,
        monkeypatch: pytest.MonkeyPatch,
        lease_build_test_session_maker: async_sessionmaker[AsyncSession],
        lease_build_test_user: int,
    ) -> None:
        """Lichess %eval game leased identically to engine game (D-09/D-09a)."""
        import app.services.eval_apply as eval_apply_module
        import app.services.eval_drain as eval_drain_module
        from app.services.eval_drain import _build_flaw_blob_lease_positions

        monkeypatch.setattr(
            eval_drain_module, "async_session_maker", lease_build_test_session_maker
        )
        # Phase 150 R7: _build_flaw_blob_lease_positions moved to eval_apply.py and
        # opens its own internal session there -- redirect that binding too.
        monkeypatch.setattr(
            eval_apply_module, "async_session_maker", lease_build_test_session_maker
        )

        from app.models.game import Game

        user_id = lease_build_test_user

        # Insert a lichess-style game (lichess_evals_at IS NOT NULL marks it as a lichess game)
        async with lease_build_test_session_maker() as session:
            g = Game(
                user_id=user_id,
                platform="lichess",
                platform_game_id=f"lichess-lease-build-{uuid.uuid4().hex}",
                pgn=_LEASE_BUILD_PGN,
                result="1-0",
                user_color="white",
                rated=True,
                is_computer_game=False,
                full_evals_completed_at=dt.now(timezone.utc),
                lichess_evals_at=dt.now(timezone.utc),
            )
            session.add(g)
            await session.flush()
            game_id = int(g.id)  # type: ignore[arg-type]
            await session.commit()

        await _insert_null_blob_flaw(
            lease_build_test_session_maker, user_id, game_id, _LEASE_BUILD_FLAW_PLY
        )
        await _insert_game_position_with_pv(
            lease_build_test_session_maker,
            user_id,
            game_id,
            _LEASE_BUILD_FLAW_PLY,
            _WALKABLE_PV_AT_PLY_2,
        )
        await _insert_game_position_with_pv(
            lease_build_test_session_maker,
            user_id,
            game_id,
            _LEASE_BUILD_FLAW_PLY + 1,
            _WALKABLE_PV_AT_PLY_3,
        )

        try:
            positions, sentinels = await _build_flaw_blob_lease_positions(game_id)

            # D-09: lichess game produces identical output (no is_lichess branch in the walk)
            assert len(sentinels) == 0, (
                f"Lichess game: expected no sentinels for walkable PV, got {sentinels}"
            )
            # SEED-079: even-only leasing applies identically to lichess games.
            missed_tokens = [p.token for p in positions if ":missed:" in p.token]
            allowed_tokens = [p.token for p in positions if ":allowed:" in p.token]
            assert len(missed_tokens) == 2, (
                f"Lichess: expected 2 missed tokens (even k only), got {missed_tokens}"
            )
            assert len(allowed_tokens) == 1, (
                f"Lichess: expected 1 allowed token (even k only), got {allowed_tokens}"
            )
        finally:
            await _delete_lease_build_games(lease_build_test_session_maker, [game_id])


# ─── SEED-079: slim-blob assembly (even-only worker results + odd placeholders) ─


def _submit_eval(
    flaw_ply: int,
    line: str,
    k: int,
    best_cp: int | None = 100,
    second_cp: int | None = -50,
    second_uci: str | None = "e2e4",
):
    """Build a FlawBlobSubmitEval for token '{flaw_ply}:{line}:{k}'."""
    from app.schemas.eval_remote import FlawBlobSubmitEval

    return FlawBlobSubmitEval(
        token=f"{flaw_ply}:{line}:{k}",
        best_cp=best_cp,
        best_mate=None,
        second_cp=second_cp,
        second_mate=None,
        second_uci=second_uci,
    )


def _is_placeholder_node(node: PvNode) -> bool:
    """True when a PvNode is the SEED-079 all-None odd-index defender placeholder."""
    return (
        node["b"] is None
        and node["bm"] is None
        and node["s"] is None
        and node["sm"] is None
        and node["su"] == ""
    )


class TestSlimBlobAssembly:
    """SEED-079: _assemble_one_line_blob reconstructs full-index blobs from even-only results.

    - even-only worker results → full-index blob with all-None placeholders at odd indices
    - a missing EVEN node is a gap (stop); a missing odd node is a placeholder (not a gap)
    - odd-k worker submissions (old workers) are discarded — placeholder wins
    - slim blob gates identically to its fat equivalent for even-firing tactics
    """

    def test_even_only_results_reconstruct_full_index_blob(self) -> None:
        """k=0 and k=2 results yield [node0, placeholder, node2]; placeholder is all-None."""
        from app.services.eval_drain import _assemble_one_line_blob

        node_results = {
            (10, "missed", 0): _submit_eval(10, "missed", 0, best_cp=150),
            (10, "missed", 2): _submit_eval(10, "missed", 2, best_cp=120),
        }
        blob = _assemble_one_line_blob(10, "missed", node_results, sentinel_lines=set())

        assert len(blob) == 3, f"Expected 3 nodes (real, placeholder, real), got {len(blob)}"
        assert blob[0]["b"] == 150
        assert _is_placeholder_node(blob[1]), f"Odd index must be a placeholder, got {blob[1]}"
        assert blob[2]["b"] == 120
        # The blob must always end on a real even solver node (never a trailing placeholder)
        # to preserve _strip_trailing_only_moves' "last solver node is real" assumption.
        assert not _is_placeholder_node(blob[-1])

    def test_missing_node0_returns_empty(self) -> None:
        """A missing node-0 result still returns [] (can't start the sequence)."""
        from app.services.eval_drain import _assemble_one_line_blob

        node_results = {
            (5, "missed", 2): _submit_eval(5, "missed", 2),
        }
        assert _assemble_one_line_blob(5, "missed", node_results, sentinel_lines=set()) == []

    def test_missing_even_node_is_gap(self) -> None:
        """k=0 present, k=2 missing, k=4 present → [node0] (stop at the first missing EVEN)."""
        from app.services.eval_drain import _assemble_one_line_blob

        node_results = {
            (7, "allowed", 0): _submit_eval(7, "allowed", 0, best_cp=90),
            (7, "allowed", 4): _submit_eval(7, "allowed", 4, best_cp=80),
        }
        blob = _assemble_one_line_blob(7, "allowed", node_results, sentinel_lines=set())

        assert len(blob) == 1, f"Missing even k=2 must stop the walk at [node0], got {len(blob)}"
        assert blob[0]["b"] == 90

    def test_odd_worker_submissions_discarded(self) -> None:
        """Old workers still submitting odd nodes have them discarded at assembly (item 5)."""
        from app.services.eval_drain import _assemble_one_line_blob

        node_results = {
            (12, "missed", 0): _submit_eval(12, "missed", 0, best_cp=200),
            # Old fat-lease worker submits the odd defender node — must never be read.
            (12, "missed", 1): _submit_eval(12, "missed", 1, best_cp=-999, second_uci="a1a2"),
            (12, "missed", 2): _submit_eval(12, "missed", 2, best_cp=180),
        }
        blob = _assemble_one_line_blob(12, "missed", node_results, sentinel_lines=set())

        assert len(blob) == 3
        assert _is_placeholder_node(blob[1]), (
            f"Odd index must be the server-synthesized placeholder, not the worker value "
            f"(server authoritative — SEED-079 item 5); got {blob[1]}"
        )
        assert blob[1]["b"] != -999

    def test_sentinel_line_still_returns_empty(self) -> None:
        """Sentinel lines keep their [] semantics under slim assembly."""
        from app.services.eval_drain import _assemble_one_line_blob

        node_results = {
            (3, "missed", 0): _submit_eval(3, "missed", 0),
        }
        blob = _assemble_one_line_blob(3, "missed", node_results, sentinel_lines={(3, "missed")})
        assert blob == []

    def test_slim_blob_gates_identically_to_fat(self) -> None:
        """A slim blob yields the SAME gate decision as its fat equivalent (even firing depth)."""
        from app.services.eval_drain import _assemble_one_line_blob
        from app.services.forcing_line_gate import PvNode, apply_forcing_line_filter

        # Fat blob: forced tactic firing at depth 0 (S0 forced via cp gap, S2 conversion).
        fat: list[PvNode] = [
            PvNode(b=400, bm=None, s=-100, sm=None, su="d2d4"),  # S0 firing — forced
            PvNode(b=380, bm=None, s=300, sm=None, su="g8f6"),  # D0 defender (real data)
            PvNode(b=420, bm=None, s=350, sm=None, su="c2c4"),  # S2 conversion
        ]
        # Slim equivalent assembled from even-only worker results.
        node_results = {
            (20, "missed", 0): _submit_eval(20, "missed", 0, best_cp=400, second_cp=-100),
            (20, "missed", 2): _submit_eval(
                20, "missed", 2, best_cp=420, second_cp=350, second_uci="c2c4"
            ),
        }
        slim = _assemble_one_line_blob(20, "missed", node_results, sentinel_lines=set())

        fat_decision = apply_forcing_line_filter(fat, "white", pre_flaw_eval_cp=0, firing_depth=0)
        slim_decision = apply_forcing_line_filter(slim, "white", pre_flaw_eval_cp=0, firing_depth=0)
        assert fat_decision is True, "Sanity: the fat blob must be credited"
        assert slim_decision == fat_decision, (
            "Slim blob must yield the same credit decision as its fat equivalent "
            f"(fat={fat_decision}, slim={slim_decision})"
        )

        # Rejected case: firing node not forced (small gap) — both shapes reject.
        fat_reject = [
            PvNode(b=50, bm=None, s=40, sm=None, su="d2d4"),
            PvNode(b=45, bm=None, s=30, sm=None, su="g8f6"),
            PvNode(b=55, bm=None, s=45, sm=None, su="c2c4"),
        ]
        reject_results = {
            (21, "missed", 0): _submit_eval(21, "missed", 0, best_cp=50, second_cp=40),
            (21, "missed", 2): _submit_eval(21, "missed", 2, best_cp=55, second_cp=45),
        }
        slim_reject = _assemble_one_line_blob(21, "missed", reject_results, sentinel_lines=set())
        assert (
            apply_forcing_line_filter(fat_reject, "white", pre_flaw_eval_cp=0, firing_depth=0)
            is False
        )
        assert (
            apply_forcing_line_filter(slim_reject, "white", pre_flaw_eval_cp=0, firing_depth=0)
            is False
        )


class TestSlimLocalDrainLineBlobs:
    """SEED-079 item 4: _build_line_blobs assembles slim blobs (even continuation nodes only).

    Node 0 comes from pos_eval + second_best_map (unchanged); even continuation nodes
    (2, 4, ...) come from node_eval; odd indices are all-None placeholders; a missing
    even node_eval entry stops the walk.
    """

    _FLAW_PLY = 4

    @staticmethod
    def _node_eval_7tuple(
        b: int, su: str | None = "e2e4"
    ) -> tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None]:
        """Build a 7-tuple matching evaluate_nodes_multipv2's return shape."""
        return (b, None, "e2e4", "e2e4 e7e5", -50, None, su)

    def _walk_of_len(self, n: int) -> list:
        """Build a walk of n boards (content unused by _build_line_blobs; only len matters)."""
        import chess

        return [chess.Board() for _ in range(n)]

    def _pos_eval(self) -> dict[int, tuple[int | None, int | None]]:
        return {self._FLAW_PLY: (30, None)}

    def _second_best(self) -> dict[int, tuple[int | None, int | None, str | None]]:
        return {self._FLAW_PLY: (-100, None, "d2d4")}

    def test_even_continuation_nodes_with_placeholders(self) -> None:
        """Walk len 5, node_eval at k=2 and k=4 → [node0, ph, n2, ph, n4]."""
        from app.services.eval_drain import _build_line_blobs

        node_eval = {
            (self._FLAW_PLY, "missed", 2): self._node_eval_7tuple(120),
            (self._FLAW_PLY, "missed", 4): self._node_eval_7tuple(110),
        }
        blob = _build_line_blobs(
            self._FLAW_PLY,
            "missed",
            self._walk_of_len(5),
            self._pos_eval(),
            self._second_best(),
            node_eval,
        )

        assert len(blob) == 5, f"Expected 5 nodes (0..4 with odd placeholders), got {len(blob)}"
        assert blob[0]["b"] == 30, "node 0 must come from pos_eval"
        assert blob[0]["su"] == "d2d4", "node 0 su must come from second_best_map"
        assert _is_placeholder_node(blob[1]), f"Index 1 must be a placeholder, got {blob[1]}"
        assert blob[2]["b"] == 120
        assert _is_placeholder_node(blob[3]), f"Index 3 must be a placeholder, got {blob[3]}"
        assert blob[4]["b"] == 110
        assert not _is_placeholder_node(blob[-1]), "Blob must end on a real even solver node"

    def test_missing_even_node_eval_stops_walk(self) -> None:
        """Walk len 5 but node_eval only at k=2 → [node0, ph, n2] (k=4 missing = gap)."""
        from app.services.eval_drain import _build_line_blobs

        node_eval = {
            (self._FLAW_PLY, "missed", 2): self._node_eval_7tuple(120),
        }
        blob = _build_line_blobs(
            self._FLAW_PLY,
            "missed",
            self._walk_of_len(5),
            self._pos_eval(),
            self._second_best(),
            node_eval,
        )

        assert len(blob) == 3, f"Missing even k=4 must stop the walk at 3 nodes, got {len(blob)}"
        assert _is_placeholder_node(blob[1])
        assert blob[2]["b"] == 120

    def test_short_walk_yields_node0_only(self) -> None:
        """Walk len 2 (no even continuation index) → [node0] only."""
        from app.services.eval_drain import _build_line_blobs

        blob = _build_line_blobs(
            self._FLAW_PLY,
            "missed",
            self._walk_of_len(2),
            self._pos_eval(),
            self._second_best(),
            node_eval={},
        )

        assert len(blob) == 1, f"Walk of len 2 has no even continuation node, got {len(blob)}"
        assert blob[0]["b"] == 30

    def test_odd_node_eval_entries_never_read(self) -> None:
        """Stray odd-k node_eval entries are ignored — placeholders win (defense in depth)."""
        from app.services.eval_drain import _build_line_blobs

        node_eval = {
            (self._FLAW_PLY, "missed", 1): self._node_eval_7tuple(-999),
            (self._FLAW_PLY, "missed", 2): self._node_eval_7tuple(120),
            (self._FLAW_PLY, "missed", 3): self._node_eval_7tuple(-999),
        }
        blob = _build_line_blobs(
            self._FLAW_PLY,
            "missed",
            self._walk_of_len(4),
            self._pos_eval(),
            self._second_best(),
            node_eval,
        )

        # Walk len 4: indices 0..3; even continuation k=2 only; blob ends at n2.
        assert len(blob) == 3, f"Expected [node0, ph, n2], got {len(blob)} nodes"
        assert _is_placeholder_node(blob[1]), "Odd node_eval entry must never be read"
        assert blob[1]["b"] != -999
        assert blob[2]["b"] == 120
