"""Node-budget engine call contract tests (EVAL-02). Phase 116 Wave 0.

Tests the evaluate_nodes() module-level function and EnginePool.evaluate_nodes()
method introduced in Phase 116. The node-budget path uses chess.engine.Limit(nodes=1_000_000)
instead of Limit(depth=15); timeout is 5.0s (_NODES_TIMEOUT_S) rather than 2.0s.
"""

import asyncio
import os
from unittest.mock import MagicMock, patch

import chess
import chess.engine
import pytest

from app.services.engine import (
    _HASH_MB,
    _NODES_BUDGET,
    _STOCKFISH_PATH,
    _THREADS,
    _engine_popen_kwargs,
    evaluate_nodes,
)
from app.services.zobrist import EVAL_CP_MAX_ABS, EVAL_MATE_MAX_ABS

# Reuse the same stockfish-presence detection as test_engine.py.
stockfish_missing = not (os.path.isfile(_STOCKFISH_PATH) and os.access(_STOCKFISH_PATH, os.X_OK))
skip_if_no_stockfish = pytest.mark.skipif(stockfish_missing, reason="Stockfish binary not found")

# Known position for real-engine smoke test
KQ_VS_K_WHITE_WINS = "8/8/8/8/8/8/4Q3/4K2k w - - 0 1"
# A dense middlegame (not a trivially-resolved endgame) so a 1M-node search
# cannot finish inside the sub-second cancellation window below.
DENSE_MIDDLEGAME_FEN = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1"

# ─── Constants (CLAUDE.md: no magic numbers) ──────────────────────────────────
EXPECTED_NONE_RESULT: tuple[None, None] = (None, None)
MOCK_EVAL_CP: int = 150
MOCK_EVAL_MATE: int = 3
# Cancellation-safety probe budgets (quick task 260725-da3, ITEM 2 gate).
_CANCEL_PROBE_TIMEOUT_S: float = 0.05  # forces asyncio.wait_for to cancel mid-search
_REUSE_PROBE_DEPTH: int = 6  # cheap second search on the SAME protocol
_REUSE_PROBE_TIMEOUT_S: float = 10.0  # generous: a desync would hang, not be slow
_WARMUP_PROBE_DEPTH: int = 4  # gets `ucinewgame`/`isready` out of the way first


class TestEvaluateNodesPoolUnset:
    """Tests that run unconditionally — no Stockfish binary required.

    Mirrors TestEngineNotStarted in test_engine.py. Tests the not-started branch
    which is independent of binary presence (EVAL-02).

    NOTE: We patch the module-level _pool to None instead of calling stop_engine(),
    so we don't destroy the session-scoped engine_started state for other test classes
    running in the same xdist worker session.
    """

    async def test_evaluate_nodes_returns_none_if_pool_unset(self) -> None:
        """evaluate_nodes() returns (None, None) when pool is not started.

        Mirrors test_evaluate_returns_none_tuple_if_engine_not_started.
        Must NOT be marked skip_if_no_stockfish — tests the not-started branch.
        Patches _pool to None instead of calling stop_engine() to avoid
        disrupting the session-scoped engine_started fixture in xdist runs.
        """
        import app.services.engine as engine_module

        with patch.object(engine_module, "_pool", None):
            result = await evaluate_nodes(chess.Board())
        assert result == EXPECTED_NONE_RESULT


class TestEvaluateNodesWithMock:
    """Unit tests using a mocked UciProtocol to verify Limit and timeout behavior.

    These tests verify the exact Limit(nodes=1_000_000) contract without requiring
    a real Stockfish binary — EVAL-02 compliance tests.
    """

    async def test_evaluate_nodes_uses_limit_nodes(self) -> None:
        """evaluate_nodes() calls protocol.analyse with Limit(nodes=1_000_000).

        Records the Limit instance passed to analyse() and asserts nodes=1_000_000
        is used, NOT depth. This is the EVAL-02 core contract.
        """
        from app.services.engine import EnginePool, _NODES_BUDGET

        # Create a pool and mock its internal protocol
        pool = EnginePool(size=1)
        pool._started = True

        # Build a mock InfoDict with a valid score
        mock_score = MagicMock(spec=chess.engine.PovScore)
        mock_white_score = MagicMock()
        mock_white_score.score.return_value = MOCK_EVAL_CP
        mock_white_score.mate.return_value = None
        mock_score.white.return_value = mock_white_score

        mock_info: chess.engine.InfoDict = chess.engine.InfoDict({"score": mock_score})  # type: ignore[misc]

        captured_limits: list[chess.engine.Limit] = []

        async def mock_analyse(
            board: chess.Board,
            limit: chess.engine.Limit,
            *args: object,
            **kwargs: object,
        ) -> chess.engine.InfoDict:
            captured_limits.append(limit)
            return mock_info

        mock_protocol = MagicMock(spec=chess.engine.UciProtocol)
        mock_protocol.analyse = mock_analyse

        pool._transports = [None]
        pool._protocols = [mock_protocol]
        pool._available.put_nowait(0)

        board = chess.Board()
        await pool.evaluate_nodes(board)

        assert len(captured_limits) == 1, "Expected exactly one analyse() call"
        limit = captured_limits[0]
        assert limit.nodes == _NODES_BUDGET, (
            f"Expected nodes={_NODES_BUDGET}, got nodes={limit.nodes}"
        )
        assert limit.depth is None, (
            f"Expected depth=None (not a depth-limited call), got depth={limit.depth}"
        )

    async def test_evaluate_nodes_timeout_returns_none_without_restart(self) -> None:
        """evaluate_nodes() returns (None, None) on TimeoutError WITHOUT restarting.

        Contract changed by quick task 260725-da3 (FLAWCHESS-8B): a timeout means
        the box is slow, not that the engine is broken, so the worker is kept and
        only its slot is released. Restarting spawned a fresh Stockfish process on
        an already-overloaded machine and amplified one slow position into a block
        of holes.

        The contrast test is test_evaluate_nodes_engine_error_returns_none, which
        asserts a genuine EngineError DOES still restart — together the two are the
        regression test for the split except handlers.
        """
        from app.services.engine import EnginePool

        pool = EnginePool(size=1)
        pool._started = True

        async def mock_analyse_slow(
            board: chess.Board,
            limit: chess.engine.Limit,
            *args: object,
            **kwargs: object,
        ) -> chess.engine.InfoDict:
            # Simulate a hung engine by sleeping longer than _NODES_TIMEOUT_S
            await asyncio.sleep(9999)
            raise AssertionError("Should have been cancelled before this")  # unreachable

        mock_protocol = MagicMock(spec=chess.engine.UciProtocol)
        mock_protocol.analyse = mock_analyse_slow

        pool._transports = [None]
        pool._protocols = [mock_protocol]
        pool._available.put_nowait(0)

        # Patch _restart_worker to avoid spawning a real process
        restart_called = False

        async def mock_restart(idx: int) -> bool:
            nonlocal restart_called
            restart_called = True
            return True

        pool._restart_worker = mock_restart  # ty: ignore[invalid-assignment]

        # Patch _NODES_TIMEOUT_S to a near-zero value so the test doesn't actually wait 5s
        with patch("app.services.engine._NODES_TIMEOUT_S", 0.01):
            result = await pool.evaluate_nodes(chess.Board())

        assert result == EXPECTED_NONE_RESULT, f"Expected (None, None) on timeout, got {result}"
        assert not restart_called, (
            "260725-da3: a timeout must NOT restart the worker — a slow box is not a "
            "broken engine, and restarting amplifies holes (FLAWCHESS-8B)"
        )

    async def test_evaluate_nodes_engine_error_returns_none(self) -> None:
        """evaluate_nodes() returns (None, None) on chess.engine.EngineError."""
        from app.services.engine import EnginePool

        pool = EnginePool(size=1)
        pool._started = True

        async def mock_analyse_error(
            board: chess.Board,
            limit: chess.engine.Limit,
            *args: object,
            **kwargs: object,
        ) -> chess.engine.InfoDict:
            raise chess.engine.EngineError("mock engine error")

        mock_protocol = MagicMock(spec=chess.engine.UciProtocol)
        mock_protocol.analyse = mock_analyse_error

        pool._transports = [None]
        pool._protocols = [mock_protocol]
        pool._available.put_nowait(0)

        restart_called = False

        async def mock_restart(idx: int) -> bool:
            nonlocal restart_called
            restart_called = True
            return True

        pool._restart_worker = mock_restart  # ty: ignore[invalid-assignment]

        result = await pool.evaluate_nodes(chess.Board())
        assert result == EXPECTED_NONE_RESULT
        assert restart_called

    async def test_evaluate_nodes_null_protocol_returns_none(self) -> None:
        """evaluate_nodes() returns (None, None) if the worker's protocol is None.

        This models a permanently-failed worker slot (restart returned False).
        """
        from app.services.engine import EnginePool

        pool = EnginePool(size=1)
        pool._started = True
        pool._transports = [None]
        pool._protocols = [None]  # simulates a failed/dead worker
        pool._available.put_nowait(0)

        result = await pool.evaluate_nodes(chess.Board())
        assert result == EXPECTED_NONE_RESULT


@skip_if_no_stockfish
class TestEvaluateNodesRealEngine:
    """Optional integration test requiring real Stockfish binary.

    Skipped cleanly when Stockfish is absent. Uses the module-level evaluate_nodes()
    which routes through the pool started by start_engine(). Each test ensures the
    engine is running before use — start_engine() is idempotent, so calling it after
    a stop_engine() (e.g., from TestEngineNotStarted in another test file) restarts
    the pool safely without requiring the session-scoped engine_started fixture.
    """

    async def test_white_winning_returns_positive_eval(self) -> None:
        """White-winning position returns positive eval_cp through the real budget call.

        At 1M nodes the engine reliably finds the KQ vs K advantage.
        """
        from app.services.engine import start_engine

        await start_engine()
        cp, mate = await evaluate_nodes(chess.Board(KQ_VS_K_WHITE_WINS))
        # Either positive cp OR positive forced-mate — both are correct.
        assert (cp is not None and cp >= 100) or (mate is not None and mate > 0), (
            f"Expected white-winning eval, got cp={cp} mate={mate}"
        )

    async def test_evaluate_nodes_returns_bounded_values(self) -> None:
        """evaluate_nodes() results are within the same clamped range as evaluate()."""
        from app.services.engine import start_engine

        await start_engine()
        cp, mate = await evaluate_nodes(chess.Board(KQ_VS_K_WHITE_WINS))
        if cp is not None:
            assert -EVAL_CP_MAX_ABS <= cp <= EVAL_CP_MAX_ABS
        if mate is not None:
            assert -EVAL_MATE_MAX_ABS <= mate <= EVAL_MATE_MAX_ABS

    async def test_protocol_reusable_after_cancelled_analyse(self) -> None:
        """A cancelled `analyse()` leaves the UCI protocol usable for the NEXT one.

        This is the correctness gate for quick task 260725-da3 ITEM 2 (skipping
        `_restart_worker` on `asyncio.TimeoutError`). Keeping a slot after a
        timeout is only safe if the cancellation does NOT desync the protocol,
        so this asserts it against the real binary rather than assuming it.

        Why it holds (python-chess 1.11.2 source):
          - `Protocol.analyse` (L1127-1132) awaits the result inside `with analysis:`.
          - `AnalysisResult.__exit__` (L2836) -> `.stop()` (L2761) -> the
            `stop=lambda: self.cancel()` hook installed by
            `UciAnalysisCommand.start` (L1712) -> `.cancel()` (L1766) sends `stop`.
          - Stockfish answers `stop` with `bestmove`, which reaches
            `UciAnalysisCommand._bestmove` (L1758-1763) -> `set_finished()`
            (L1268) -> resolves the command's `finished` future.
          - `Protocol.communicate` (L986-1021) queues the NEXT command as
            `next_command` and only `_start()`s it from
            `previous_command_finished` (L1001-1012), i.e. AFTER that `finished`
            future resolves. The next `analyse()` is therefore serialized behind
            the stale `bestmove` instead of racing it.
        """
        transport, protocol = await chess.engine.popen_uci(
            _STOCKFISH_PATH, **_engine_popen_kwargs()
        )
        try:
            await protocol.configure({"Hash": _HASH_MB, "Threads": _THREADS})

            # Warm up so `first_game` is False: the very first analysis on a fresh
            # protocol sends `ucinewgame`/`isready` and only resolves its result
            # future from the async `readyok` handler, which is a different (and
            # much narrower) cancellation window than the steady-state one the
            # pool actually hits.
            await asyncio.wait_for(
                protocol.analyse(chess.Board(), chess.engine.Limit(depth=_WARMUP_PROBE_DEPTH)),
                timeout=_REUSE_PROBE_TIMEOUT_S,
            )

            board = chess.Board(DENSE_MIDDLEGAME_FEN)
            with pytest.raises((asyncio.TimeoutError, TimeoutError)):
                await asyncio.wait_for(
                    protocol.analyse(board, chess.engine.Limit(nodes=_NODES_BUDGET)),
                    timeout=_CANCEL_PROBE_TIMEOUT_S,
                )

            # No restart, no re-popen: reuse the SAME protocol object. A desynced
            # protocol would hang here (caught by the wait_for) or raise.
            info = await asyncio.wait_for(
                protocol.analyse(board, chess.engine.Limit(depth=_REUSE_PROBE_DEPTH)),
                timeout=_REUSE_PROBE_TIMEOUT_S,
            )
            assert not isinstance(info, list), "expected a scalar InfoDict without multipv"
            score = info.get("score")
            assert score is not None, f"post-cancellation analyse returned no score: {info!r}"
            white = score.white()
            assert white.score() is not None or white.mate() is not None, (
                f"post-cancellation analyse returned an unusable score: {score!r}"
            )
        finally:
            try:
                await protocol.quit()
            except (chess.engine.EngineError, chess.engine.EngineTerminatedError, RuntimeError):
                pass
            transport.close()
