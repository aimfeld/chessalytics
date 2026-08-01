"""Engine wrapper contract tests (ENG-02). Phase 78 Wave 0."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import chess
import chess.engine
import pytest

from app.services.engine import _STOCKFISH_PATH, evaluate

if TYPE_CHECKING:
    from app.services.engine import EnginePool
from app.services.zobrist import EVAL_CP_MAX_ABS, EVAL_MATE_MAX_ABS

# ─── Constants (CLAUDE.md: no magic numbers) ──────────────────────────────────
MOCK_BEST_CP: int = 200
MOCK_SECOND_CP: int = 100
MOCK_MATE_IN_2: int = 2
MOCK_SECOND_MATE_CP: int = 500

# Use the same path the engine resolves (env var / Docker / dev install / PATH),
# so these run locally after bin/install_stockfish.sh, not only when a binary
# literally named `stockfish` is on PATH.
stockfish_missing = not (os.path.isfile(_STOCKFISH_PATH) and os.access(_STOCKFISH_PATH, os.X_OK))
skip_if_no_stockfish = pytest.mark.skipif(stockfish_missing, reason="Stockfish binary not found")

# Known positions (chosen for deterministic depth-15 outcome)
KQ_VS_K_WHITE_WINS = "8/8/8/8/8/8/4Q3/4K2k w - - 0 1"
K_VS_Q_BLACK_WINS = "8/8/8/8/8/8/4q3/4k2K w - - 0 1"  # white to move, severely losing
NEAR_EQUAL_AFTER_E4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
# Forced mate positions: simple known mate-in-1 positions
MATE_IN_1_WHITE = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1"  # Ra8# is mate in 1
MATE_IN_1_BLACK = "1r4k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1"  # Rb1# is mate in 1 for black

# Flake fix: these tests failed at random under `pytest -n auto` with
# `assert (None is not None)`. evaluate() returns (None, None) on its defensive
# per-eval wall-clock guard (_TIMEOUT_S = 2.0s), which is sized for a mostly
# idle box — the depth-15 mean is ~0.09s. But every Stockfish subprocess is
# spawned under SCHED_IDLE (see _sched_idle_preexec in app/services/engine.py),
# so the kernel preempts it the instant any other runnable task wants CPU. With
# one xdist worker per core all competing, the search is starved almost
# continuously and a depth-15 eval genuinely exceeds 2s wall-clock — a property
# of the loaded test box, not a regression in the wrapper.
#
# These tests assert the SCORE, never the latency, so give the search a
# generous wall-clock budget here. The production constant is deliberately left
# alone: 2.0s is a real prod guard and must not be relaxed to appease a test.
_TEST_EVAL_TIMEOUT_S: float = 30.0


@pytest.fixture
def generous_eval_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Lift evaluate()'s wall-clock guard for the real-engine contract tests."""
    import app.services.engine as engine_module

    monkeypatch.setattr(engine_module, "_TIMEOUT_S", _TEST_EVAL_TIMEOUT_S)


@skip_if_no_stockfish
@pytest.mark.usefixtures("engine_started", "generous_eval_timeout")
class TestEngineWrapper:
    async def test_white_winning_returns_positive_cp(self) -> None:
        cp, mate = await evaluate(chess.Board(KQ_VS_K_WHITE_WINS))
        # Either Stockfish reports cp >= 100, OR it sees the forced mate and reports eval_mate.
        # Both are correct — assert at least one of (cp >= 100, mate is not None and mate > 0).
        assert (cp is not None and cp >= 100) or (mate is not None and mate > 0)

    async def test_black_winning_returns_negative_cp(self) -> None:
        cp, mate = await evaluate(chess.Board(K_VS_Q_BLACK_WINS))
        assert (cp is not None and cp <= -100) or (mate is not None and mate < 0)

    async def test_near_equal_returns_small_cp(self) -> None:
        cp, mate = await evaluate(chess.Board(NEAR_EQUAL_AFTER_E4))
        assert mate is None
        assert cp is not None and abs(cp) < 100

    async def test_mate_for_white_returns_positive_mate(self) -> None:
        cp, mate = await evaluate(chess.Board(MATE_IN_1_WHITE))
        assert mate is not None and mate > 0

    async def test_mate_for_black_returns_negative_mate(self) -> None:
        cp, mate = await evaluate(chess.Board(MATE_IN_1_BLACK))
        assert mate is not None and mate < 0

    async def test_clamp_bounds(self) -> None:
        cp, mate = await evaluate(chess.Board(KQ_VS_K_WHITE_WINS))
        if cp is not None:
            assert -EVAL_CP_MAX_ABS <= cp <= EVAL_CP_MAX_ABS
        if mate is not None:
            assert -EVAL_MATE_MAX_ABS <= mate <= EVAL_MATE_MAX_ABS


def _make_mock_cp_score(cp: int) -> MagicMock:
    """Build a mock PovScore returning a centipawn value (white perspective)."""
    mock_score = MagicMock(spec=chess.engine.PovScore)
    mock_white = MagicMock()
    mock_white.score.return_value = cp
    mock_white.mate.return_value = None
    mock_score.white.return_value = mock_white
    return mock_score


def _make_mock_mate_score(mate_in: int) -> MagicMock:
    """Build a mock PovScore returning a forced-mate value (white perspective)."""
    mock_score = MagicMock(spec=chess.engine.PovScore)
    mock_white = MagicMock()
    mock_white.score.return_value = None
    mock_white.mate.return_value = mate_in
    mock_score.white.return_value = mock_white
    return mock_score


def _make_pool_with_mock_protocol(mock_analyse_fn: object) -> "EnginePool":
    """Construct a started EnginePool with a mock protocol, ready for one call."""
    from app.services.engine import EnginePool

    pool = EnginePool(size=1)
    pool._started = True
    mock_protocol = MagicMock(spec=chess.engine.UciProtocol)
    mock_protocol.analyse = mock_analyse_fn
    pool._transports = [None]
    pool._protocols = [mock_protocol]
    pool._available.put_nowait(0)
    return pool


class TestEvaluateNodesMultipv2:
    """Unit tests for evaluate_nodes_multipv2 (Phase 142 MPV-01).

    Covers: two-line extraction, single-legal-move su='' guard,
    not-started 7-None return, and a mate-in-N first line (Pitfall 1 guard).
    No real Stockfish process is started — all tests use mock protocols.
    """

    async def test_pool_not_started_returns_7_none(self) -> None:
        """evaluate_nodes_multipv2 returns (None,)*7 when pool is not started (module wrapper)."""
        import app.services.engine as engine_module
        from app.services.engine import evaluate_nodes_multipv2

        with patch.object(engine_module, "_pool", None):
            result = await evaluate_nodes_multipv2(chess.Board())
        assert result == (None, None, None, None, None, None, None)

    async def test_engine_not_started_returns_7_none(self) -> None:
        """EnginePool.evaluate_nodes_multipv2 returns (None,)*7 when _started=False."""
        from app.services.engine import EnginePool

        pool = EnginePool(size=1)
        # _started is False by default (pool.start() never called)
        result = await pool.evaluate_nodes_multipv2(chess.Board())
        assert result == (None, None, None, None, None, None, None)

    async def test_two_line_extraction(self) -> None:
        """Two-line info_list: best from line 0, second from line 1 (Pitfall 1 guard).

        Verifies correct extraction from each InfoDict by index — the list must
        never be passed whole to scalar helpers (_score_to_cp_mate etc.).
        """
        best_move = chess.Move.from_uci("e2e4")
        second_move = chess.Move.from_uci("d2d4")

        info_best: chess.engine.InfoDict = chess.engine.InfoDict(  # type: ignore[misc]
            {"score": _make_mock_cp_score(MOCK_BEST_CP), "pv": [best_move]}
        )
        info_second: chess.engine.InfoDict = chess.engine.InfoDict(  # type: ignore[misc]
            {"score": _make_mock_cp_score(MOCK_SECOND_CP), "pv": [second_move]}
        )

        async def mock_analyse(
            board: chess.Board,
            limit: chess.engine.Limit,
            *args: object,
            **kwargs: object,
        ) -> list[chess.engine.InfoDict]:
            return [info_best, info_second]

        pool = _make_pool_with_mock_protocol(mock_analyse)
        (
            eval_cp,
            eval_mate,
            best_uci,
            pv_str,
            second_cp,
            second_mate,
            second_uci,
        ) = await pool.evaluate_nodes_multipv2(chess.Board())

        assert eval_cp == MOCK_BEST_CP
        assert eval_mate is None
        assert best_uci == "e2e4"
        assert pv_str == "e2e4"
        assert second_cp == MOCK_SECOND_CP
        assert second_mate is None
        assert second_uci == "d2d4"

    async def test_single_legal_move_sets_second_sentinel(self) -> None:
        """Single-legal-move board (len(info_list)==1): second_cp=None, second_mate=None, second_uci=''.

        PvNode.su is str (not str | None) — the empty string sentinel must be used,
        never None (Pitfall 2 + Pitfall 3 from RESEARCH.md D-02).
        """
        info_only: chess.engine.InfoDict = chess.engine.InfoDict(  # type: ignore[misc]
            {
                "score": _make_mock_cp_score(MOCK_BEST_CP),
                "pv": [chess.Move.from_uci("e1e2")],
            }
        )

        async def mock_analyse_single(
            board: chess.Board,
            limit: chess.engine.Limit,
            *args: object,
            **kwargs: object,
        ) -> list[chess.engine.InfoDict]:
            return [info_only]

        pool = _make_pool_with_mock_protocol(mock_analyse_single)
        (
            eval_cp,
            eval_mate,
            best_uci,
            pv_str,
            second_cp,
            second_mate,
            second_uci,
        ) = await pool.evaluate_nodes_multipv2(chess.Board())

        assert eval_cp == MOCK_BEST_CP
        assert second_cp is None
        assert second_mate is None
        # Critical: su must be "" (str), never None (PvNode.su sentinel)
        assert second_uci == ""
        assert isinstance(second_uci, str)

    async def test_mate_line_best_and_second_extracted(self) -> None:
        """Line 0 has a mate score: best_mate populated, best_cp None, second line still extracted.

        Guards Pitfall 1: the list[InfoDict] must not be passed to scalar helpers.
        With multipv=2 and a forced mate, Stockfish may still return a second PV
        line — verify it is extracted correctly.
        """
        info_mate: chess.engine.InfoDict = chess.engine.InfoDict(  # type: ignore[misc]
            {
                "score": _make_mock_mate_score(MOCK_MATE_IN_2),
                "pv": [chess.Move.from_uci("a1a8")],
            }
        )
        info_second: chess.engine.InfoDict = chess.engine.InfoDict(  # type: ignore[misc]
            {
                "score": _make_mock_cp_score(MOCK_SECOND_MATE_CP),
                "pv": [chess.Move.from_uci("d7d5")],
            }
        )

        async def mock_analyse_mate(
            board: chess.Board,
            limit: chess.engine.Limit,
            *args: object,
            **kwargs: object,
        ) -> list[chess.engine.InfoDict]:
            return [info_mate, info_second]

        pool = _make_pool_with_mock_protocol(mock_analyse_mate)
        (
            eval_cp,
            eval_mate,
            best_uci,
            pv_str,
            second_cp,
            second_mate,
            second_uci,
        ) = await pool.evaluate_nodes_multipv2(chess.Board())

        # Best line: mate score — cp must be None, mate must be populated
        assert eval_cp is None
        assert eval_mate == MOCK_MATE_IN_2
        assert best_uci == "a1a8"
        # Second line: cp score
        assert second_cp == MOCK_SECOND_MATE_CP
        assert second_mate is None
        assert second_uci == "d7d5"


class TestEngineNotStarted:
    async def test_evaluate_returns_none_tuple_if_engine_not_started(self) -> None:
        """When start_engine() has not been called, evaluate() degrades to (None, None).

        Required for tests that don't bring up the engine and for the import-time
        graceful-degradation path (D-11).

        NOTE: This test must NOT be marked with @skip_if_no_stockfish — it tests
        the not-started branch which is independent of binary presence.
        NOTE: This test must run in isolation from engine_started (no autouse).
        """
        from app.services.engine import stop_engine

        # Ensure engine is stopped before testing the not-started path.
        # This makes the test resilient to collection order, since session-scoped
        # engine_started may have started the engine earlier in the session.
        await stop_engine()
        cp, mate = await evaluate(chess.Board())
        assert (cp, mate) == (None, None)
