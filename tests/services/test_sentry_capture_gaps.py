"""Quick task 260902-rmn: broad `except Exception` fallbacks must reach Sentry.

Each function below replays a *stored* PGN (already parsed at import), so a
parse that raises is a bug or data corruption, not user input. Before this task
the fallback value was returned silently and the failure left no trace.
Every test patches `chess.pgn.read_game` to raise and asserts exactly one
`capture_exception` call alongside the unchanged fallback return value.
"""

from __future__ import annotations

from unittest.mock import patch

import chess
import chess.pgn
import pytest

from app.routers.eval_remote import _build_lease_positions
from app.services.eval_apply import _collect_full_ply_targets
from app.services.eval_entry import _snapshot_boards

_GAME_ID = 1
_PGN = "1. e4 e5 2. Nf3 Nc6"
_ROWS: list[tuple[int, int, int | None, int | None]] = [(0, 111, None, None), (1, 222, None, None)]


class _ParseBoom(RuntimeError):
    """Sentinel raised from the patched read_game so tests can pin the type."""


def _raise_parse_boom(*args: object, **kwargs: object) -> None:
    raise _ParseBoom("simulated read_game failure")


@pytest.fixture
def capture():
    with patch("sentry_sdk.capture_exception") as spy:
        yield spy


class TestPgnParseFailureIsCaptured:
    def test_collect_full_ply_targets(self, capture) -> None:
        with patch("chess.pgn.read_game", _raise_parse_boom):
            result = _collect_full_ply_targets(
                game_id=_GAME_ID, pgn_text=_PGN, game_positions_rows=_ROWS
            )
        assert result == []
        assert capture.call_count == 1
        assert isinstance(capture.call_args.args[0], _ParseBoom)

    def test_snapshot_boards(self, capture) -> None:
        with patch("chess.pgn.read_game", _raise_parse_boom):
            result = _snapshot_boards(_PGN, {0})
        assert result == {}
        assert capture.call_count == 1
        assert isinstance(capture.call_args.args[0], _ParseBoom)

    def test_build_lease_positions(self, capture) -> None:
        with patch("chess.pgn.read_game", _raise_parse_boom):
            result = _build_lease_positions(_GAME_ID, _PGN, _ROWS)
        assert result is None
        assert capture.call_count == 1
        assert isinstance(capture.call_args.args[0], _ParseBoom)


class TestPlayedMoveSanFailureIsCaptured:
    def test_collect_full_ply_targets_keeps_target_with_none_san(self, capture) -> None:
        """A SAN failure drops only the played-move badge, but must be reported."""

        def _boom_san(self: chess.Board, move: chess.Move) -> str:
            raise ValueError("simulated san failure")

        with patch.object(chess.Board, "san", _boom_san):
            targets = _collect_full_ply_targets(
                game_id=_GAME_ID, pgn_text=_PGN, game_positions_rows=_ROWS[:1]
            )
        assert len(targets) == 1
        assert targets[0].move_san is None
        assert capture.call_count == 1
        assert isinstance(capture.call_args.args[0], ValueError)


class TestHappyPathDoesNotCapture:
    def test_valid_pgn_never_reaches_sentry(self, capture) -> None:
        assert _collect_full_ply_targets(game_id=_GAME_ID, pgn_text=_PGN, game_positions_rows=_ROWS)
        assert _snapshot_boards(_PGN, {0})
        assert _build_lease_positions(_GAME_ID, _PGN, _ROWS)
        assert capture.call_count == 0
