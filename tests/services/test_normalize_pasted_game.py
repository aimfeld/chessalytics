"""Unit tests for the Phase 208 pasted-PGN normalization helpers.

Covers canonical_root_fen, pasted_game_identity_hash, parse_pgn_played_at
(Task 2, D-16) and normalize_pasted_game (Task 3) — no DB required, pure
unit tests, one test per <behavior> bullet in 208-02-PLAN.md.
"""

import datetime
import io
from unittest.mock import patch

import chess
import chess.pgn
import pytest

from app.schemas.normalization import Color
from app.services.normalization import (
    MAX_PASTED_PGN_PLIES,
    canonical_root_fen,
    normalize_pasted_game,
    parse_pgn_played_at,
    pasted_game_identity_hash,
)

_STANDARD_ROOT_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

# Same standard root, but with an en-passant field and different counters —
# D-16's canonicalization must strip these so both roots hash identically.
_STANDARD_ROOT_FEN_WITH_EP_AND_COUNTERS = (
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 7 42"
)

_BLACK_TO_MOVE_ROOT_FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"


class TestCanonicalRootFen:
    def test_counters_and_ep_field_do_not_affect_output(self) -> None:
        assert canonical_root_fen(_STANDARD_ROOT_FEN) == canonical_root_fen(
            _STANDARD_ROOT_FEN_WITH_EP_AND_COUNTERS
        )

    def test_output_has_exactly_three_fields(self) -> None:
        result = canonical_root_fen(_STANDARD_ROOT_FEN_WITH_EP_AND_COUNTERS)
        assert len(result.split(" ")) == 3


def _root_fen_and_sans(pgn_text: str) -> tuple[str, list[str]]:
    """Parse *pgn_text* and return (root FEN, mainline SANs) — the exact
    extraction normalize_pasted_game will perform ahead of hashing."""
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    assert game is not None
    root_fen = game.board().fen()
    sans = [node.san() for node in game.mainline()]
    return root_fen, sans


# Same movetext, wildly different header spellings (D-16's corpus evidence:
# one player spelled twelve ways across White/Black/Event/Site/Date/Result).
_PGN_HEADER_VARIANT_A = (
    '[White "Noël, Studer"]\n[Black "Some Opponent"]\n[Event "Club Ch"]\n'
    '[Site "Basel"]\n[Date "2024.01.01"]\n[Result "1-0"]\n\n'
    "1. e4 e5 2. Nf3 Nc6 1-0\n"
)
_PGN_HEADER_VARIANT_B = (
    '[White "IM Studer Noel 2438 (SUI)"]\n[Black "opponent, some"]\n'
    '[Event "?"]\n[Site "?"]\n[Date "????.??.??"]\n[Result "*"]\n\n'
    "1. e4 e5 2. Nf3 Nc6 *\n"
)


class TestPastedGameIdentityHash:
    def test_header_spelling_does_not_affect_digest(self) -> None:
        root_fen_a, sans_a = _root_fen_and_sans(_PGN_HEADER_VARIANT_A)
        root_fen_b, sans_b = _root_fen_and_sans(_PGN_HEADER_VARIANT_B)

        digest_a = pasted_game_identity_hash(root_fen_a, sans_a)
        digest_b = pasted_game_identity_hash(root_fen_b, sans_b)

        assert digest_a == digest_b

    def test_different_roots_produce_different_digests(self) -> None:
        sans = ["Nc6", "Nf3"]
        digest_standard_root = pasted_game_identity_hash(_STANDARD_ROOT_FEN, sans)
        digest_black_to_move_root = pasted_game_identity_hash(_BLACK_TO_MOVE_ROOT_FEN, sans)
        assert digest_standard_root != digest_black_to_move_root

    def test_digest_is_64_char_lowercase_hex(self) -> None:
        digest = pasted_game_identity_hash(_STANDARD_ROOT_FEN, ["e4", "e5"])
        assert len(digest) == 64
        assert digest == digest.lower()
        assert all(ch in "0123456789abcdef" for ch in digest)


class TestParsePgnPlayedAt:
    def test_utc_date_and_time_yields_tz_aware_instant(self) -> None:
        headers = chess.pgn.Headers()
        headers["UTCDate"] = "2024.03.15"
        headers["UTCTime"] = "18:22:01"
        result = parse_pgn_played_at(headers)
        assert result == datetime.datetime(2024, 3, 15, 18, 22, 1, tzinfo=datetime.timezone.utc)

    def test_date_only_yields_midnight_utc(self) -> None:
        headers = chess.pgn.Headers()
        headers["Date"] = "2024.03.15"
        result = parse_pgn_played_at(headers)
        assert result == datetime.datetime(2024, 3, 15, 0, 0, 0, tzinfo=datetime.timezone.utc)

    def test_unknown_date_marker_yields_none(self) -> None:
        headers = chess.pgn.Headers()
        headers["Date"] = "????.??.??"
        assert parse_pgn_played_at(headers) is None

    def test_missing_header_yields_none(self) -> None:
        # A plain dict with no Date/UTCDate key at all — chess.pgn.Headers()
        # always defaults Date to "????.??.??" (covered by the marker test
        # above), so this exercises the true absent-key path via .get().
        assert parse_pgn_played_at({}) is None


_TEST_USER_ID = 42

# Plain movetext, no [%clk] anywhere — the clock gate normalize_flawchess_game
# enforces must be absent from normalize_pasted_game (D-07).
_PGN_CLOCKLESS_PLAIN = '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 1-0\n'

# Scholar's mate, but [Result] is "*" (a common broadcast/incomplete-header
# case) — the final board is checkmate, so the result must be derived from it.
_PGN_RESULT_STAR_CHECKMATE = '[Result "*"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# *\n'

# [Result "*"] with a non-terminal final board — no honest result exists.
_PGN_RESULT_STAR_NON_TERMINAL = '[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 *\n'

# A crafted, unrecognized [Termination] header far longer than
# games.termination_raw's String(50) bound (CR-02's exact reproduction).
_PGN_OVERSIZED_TERMINATION_HEADER = (
    '[Result "1-0"]\n' + f'[Termination "{"A" * 60}"]\n\n'
    "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0\n"
)

# A [SetUp]/[FEN] Black-to-move root (WR-02) — the mainline SAN and the hash
# must be computed from this root, not from the standard start.
_BLACK_TO_MOVE_ROOT_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
_PGN_BLACK_TO_MOVE_ROOT = (
    f'[Result "1-0"]\n[SetUp "1"]\n[FEN "{_BLACK_TO_MOVE_ROOT_FEN}"]\n\n1... e5 2. Nf3 Nc6 1-0\n'
)

_PGN_UNPARSEABLE = "not a pgn at all, just some garbage text"
_PGN_ZERO_MOVES = '[Event "Headers only"]\n[Result "*"]\n\n*\n'


def _build_long_pgn(num_plies: int) -> str:
    """Build a legal PGN with exactly *num_plies* reversible knight-shuffle
    plies (Nf3/Nb8/Ng1/Nc6 cycle) — pure move generation, no DB/engine."""
    board = chess.Board()
    game = chess.pgn.Game()
    game.headers["Result"] = "*"
    node: chess.pgn.GameNode = game
    moves_cycle = [
        chess.Move.from_uci("g1f3"),
        chess.Move.from_uci("b8c6"),
        chess.Move.from_uci("f3g1"),
        chess.Move.from_uci("c6b8"),
    ]
    for i in range(num_plies):
        move = moves_cycle[i % len(moves_cycle)]
        node = node.add_variation(move)
        board.push(move)
    return str(game)


class TestNormalizePastedGame:
    def test_clockless_plain_movetext_normalizes(self) -> None:
        """The [%clk]-for-both-colors gate normalize_flawchess_game enforces
        is absent — a pasted PGN is untimed by definition (D-07)."""
        result = normalize_pasted_game(_PGN_CLOCKLESS_PLAIN, _TEST_USER_ID, "white")
        assert result is not None

    def test_returned_fields_match_d07_and_hash_contract(self) -> None:
        result = normalize_pasted_game(_PGN_CLOCKLESS_PLAIN, _TEST_USER_ID, "white")
        assert result is not None
        assert result.platform == "pgn"
        assert result.platform_url is None
        assert result.rated is False
        assert result.is_computer_game is False
        assert result.time_control_str is None
        assert result.time_control_bucket is None
        assert result.time_control_seconds is None
        assert result.base_time_seconds is None
        assert result.increment_seconds is None

        root_fen, sans = _root_fen_and_sans(_PGN_CLOCKLESS_PLAIN)
        assert result.platform_game_id == pasted_game_identity_hash(root_fen, sans)

    def test_result_header_used_when_valid(self) -> None:
        result = normalize_pasted_game(_PGN_CLOCKLESS_PLAIN, _TEST_USER_ID, "white")
        assert result is not None
        assert result.result == "1-0"

    def test_result_star_with_checkmate_final_board_is_derived(self) -> None:
        result = normalize_pasted_game(_PGN_RESULT_STAR_CHECKMATE, _TEST_USER_ID, "white")
        assert result is not None
        assert result.result == "1-0"

    def test_result_star_with_non_terminal_final_board_returns_none(self) -> None:
        result = normalize_pasted_game(_PGN_RESULT_STAR_NON_TERMINAL, _TEST_USER_ID, "white")
        assert result is None

    def test_oversized_termination_header_never_stored_verbatim(self) -> None:
        result = normalize_pasted_game(_PGN_OVERSIZED_TERMINATION_HEADER, _TEST_USER_ID, "white")
        assert result is not None
        assert "A" * 60 not in result.termination_raw
        assert len(result.termination_raw) <= 50
        assert result.termination == "checkmate"

    def test_black_to_move_setup_root_feeds_hash(self) -> None:
        result = normalize_pasted_game(_PGN_BLACK_TO_MOVE_ROOT, _TEST_USER_ID, "white")
        assert result is not None
        expected_hash = pasted_game_identity_hash(_BLACK_TO_MOVE_ROOT_FEN, ["e5", "Nf3", "Nc6"])
        assert result.platform_game_id == expected_hash

    def test_mainline_over_max_plies_returns_none(self) -> None:
        long_pgn = _build_long_pgn(MAX_PASTED_PGN_PLIES + 1)
        result = normalize_pasted_game(long_pgn, _TEST_USER_ID, "white")
        assert result is None

    def test_mainline_at_max_plies_normalizes(self) -> None:
        """Boundary check: exactly MAX_PASTED_PGN_PLIES is still accepted."""
        boundary_pgn = _build_long_pgn(MAX_PASTED_PGN_PLIES)
        result = normalize_pasted_game(boundary_pgn, _TEST_USER_ID, "white")
        assert result is not None

    def test_unparseable_text_returns_none_no_sentry_capture(self) -> None:
        with patch("app.services.normalization.sentry_sdk.capture_exception") as mock_capture:
            result = normalize_pasted_game(_PGN_UNPARSEABLE, _TEST_USER_ID, "white")
        assert result is None
        mock_capture.assert_not_called()

    def test_zero_mainline_moves_returns_none_no_sentry_capture(self) -> None:
        with patch("app.services.normalization.sentry_sdk.capture_exception") as mock_capture:
            result = normalize_pasted_game(_PGN_ZERO_MOVES, _TEST_USER_ID, "white")
        assert result is None
        mock_capture.assert_not_called()

    @pytest.mark.parametrize("user_color", ["white", "black"])
    def test_user_color_passed_through(self, user_color: Color) -> None:
        result = normalize_pasted_game(_PGN_CLOCKLESS_PLAIN, _TEST_USER_ID, user_color)
        assert result is not None
        assert result.user_color == user_color
