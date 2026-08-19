"""Unit tests for app/services/normalization.py helpers.

Covers is_correspondence_time_control and normalize_flawchess_game (Phase 167
STORE-01/02) — no DB required, pure unit tests.
"""

import pytest

from app.services.normalization import (
    FLAWCHESS_BOT_USERNAME,
    _clock_presence_by_color,
    is_correspondence_time_control,
    normalize_flawchess_game,
    normalize_flawchess_game_or_reason,
)

# Test constants (no magic numbers per CLAUDE.md)
_TEST_USER_ID = 42
_TEST_GAME_UUID = "6f6b7f9a-4b0e-4c6c-9b9a-2a7a2b2c2d2e"
_TEST_BOT_ELO = 1400
_TEST_PLAYER_RATING = 1250
_TEST_TC_STR = "180+2"
_TEST_PLAYER_USERNAME = "hikaru"

# Scholar's Mate PGN with per-move [%clk] on both colors — a clean checkmate
# ending so termination-derivation (board.is_checkmate()) is exercised too.
_PGN_BOTH_CLOCKS_CHECKMATE = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} "
    "2. Bc4 {[%clk 0:02:58]} Nc6 {[%clk 0:02:58]} "
    "3. Qh5 {[%clk 0:02:56]} Nf6 {[%clk 0:02:56]} "
    "4. Qxf7# {[%clk 0:02:54]} 1-0\n"
)

# Same line but clocks only on white's plies — gates on missing black clock.
_PGN_WHITE_CLOCK_ONLY = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 "
    "2. Bc4 {[%clk 0:02:58]} Nc6 "
    "3. Qh5 {[%clk 0:02:56]} Nf6 "
    "4. Qxf7# {[%clk 0:02:54]} 1-0\n"
)

# Same line but clocks only on black's plies — gates on missing white clock.
_PGN_BLACK_CLOCK_ONLY = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n\n'
    "1. e4 e5 {[%clk 0:03:00]} "
    "2. Bc4 Nc6 {[%clk 0:02:58]} "
    "3. Qh5 Nf6 {[%clk 0:02:56]} "
    "4. Qxf7# 1-0\n"
)

_PGN_UNPARSEABLE = "not a pgn at all, just some garbage text"

_PGN_NO_RESULT = (
    '[Event "FlawChess Bot Game"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} "
    "2. Bc4 {[%clk 0:02:58]} Nc6 {[%clk 0:02:58]} *\n"
)

# Same clean checkmate line but with an explicit [Termination "resignation"]
# header — the header must take precedence over the board-derived checkmate.
_PGN_WITH_TERMINATION_HEADER = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n[Termination "resignation"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} "
    "2. Bc4 {[%clk 0:02:58]} Nc6 {[%clk 0:02:58]} "
    "3. Qh5 {[%clk 0:02:56]} Nf6 {[%clk 0:02:56]} "
    "4. Qxf7# {[%clk 0:02:54]} 1-0\n"
)

# CR-02: same clean checkmate line but with a crafted, UNRECOGNIZED [Termination]
# header longer than games.termination_raw's String(50) bound. Before the fix,
# termination_raw stored this raw header string verbatim regardless of
# recognition, crashing _flush_batch's INSERT with a Postgres DataError (500)
# instead of falling back to the closed-vocabulary board-derived value.
_PGN_WITH_OVERSIZED_UNRECOGNIZED_TERMINATION_HEADER = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n'
    f'[Termination "{"A" * 60}"]\n\n'
    "1. e4 {[%clk 0:03:00]} e5 {[%clk 0:03:00]} "
    "2. Bc4 {[%clk 0:02:58]} Nc6 {[%clk 0:02:58]} "
    "3. Qh5 {[%clk 0:02:56]} Nf6 {[%clk 0:02:56]} "
    "4. Qxf7# {[%clk 0:02:54]} 1-0\n"
)


# WR-02: a client-supplied SetUp/FEN header pair starting from a Black-to-move
# position. All 5 real-color plies (Black: e5, Nc6, exd4; White: Nf3, d4) carry
# a [%clk] annotation, so this is a valid submission that must normalize.
_BLACK_TO_MOVE_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
_PGN_BLACK_TO_MOVE_BOTH_CLOCKS = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n[SetUp "1"]\n'
    f'[FEN "{_BLACK_TO_MOVE_FEN}"]\n\n'
    "1... e5 {[%clk 0:03:00]} 2. Nf3 {[%clk 0:02:58]} Nc6 {[%clk 0:02:58]} "
    "3. d4 {[%clk 0:02:56]} exd4 {[%clk 0:02:56]} 1-0\n"
)

# Same Black-to-move start, but [%clk] is present ONLY on the real White plies
# (Nf3, d4) — the real Black plies (e5, Nc6, exd4) have none. Pre-WR-02-fix,
# the even/odd-index-to-color mapping assumed White moves first, so this
# PGN's real-color clock presence would be mislabeled internally (though the
# final combined AND-gate decision happens to be unaffected here — see
# TestClockPresenceByColor for the labeling-level regression).
_PGN_BLACK_TO_MOVE_WHITE_CLOCK_ONLY = (
    '[Event "FlawChess Bot Game"]\n[Result "1-0"]\n[SetUp "1"]\n'
    f'[FEN "{_BLACK_TO_MOVE_FEN}"]\n\n'
    "1... e5 2. Nf3 {[%clk 0:02:58]} Nc6 3. d4 {[%clk 0:02:56]} exd4 1-0\n"
)


class TestClockPresenceByColor:
    """WR-02: _clock_presence_by_color must derive per-color clock presence from
    the true starting side-to-move, not assume White always moves first.
    """

    def test_white_starts_even_indices_are_white(self) -> None:
        """Standard game (White to move first): index 0 is White's ply."""
        white_has_clock, black_has_clock = _clock_presence_by_color(
            [True, False, False], start_white_to_move=True
        )
        assert white_has_clock is True  # index 0 (White) has a clock
        assert black_has_clock is False  # indices 1, 2 (Black) have none

    def test_black_starts_even_indices_are_black(self) -> None:
        """Black-to-move start (SetUp/FEN): index 0 is Black's ply, not White's.

        This is the exact regression the pre-fix even=White/odd=Black
        assumption got wrong: with clocks only at index 0, the buggy mapping
        would report white_has_clock=True/black_has_clock=False (backwards) —
        the correct labeling is the reverse, since index 0 is actually Black's
        ply when the mainline starts from a Black-to-move position.
        """
        white_has_clock, black_has_clock = _clock_presence_by_color(
            [True, False, False], start_white_to_move=False
        )
        assert white_has_clock is False  # indices 1, 2 (White) have none
        assert black_has_clock is True  # index 0 (Black) has a clock


class TestIsCorrespondenceTimeControl:
    """Parameterised coverage for the is_correspondence_time_control predicate."""

    def test_daily_one_day_returns_true(self) -> None:
        """chess.com '1/86400' (1 day per move) → True."""
        assert is_correspondence_time_control("1/86400") is True

    def test_daily_three_days_returns_true(self) -> None:
        """chess.com '1/259200' (3 days per move) → True."""
        assert is_correspondence_time_control("1/259200") is True

    def test_classical_1800_returns_false(self) -> None:
        """'1800' is a 30-minute rapid/classical game, not correspondence."""
        assert is_correspondence_time_control("1800") is False

    def test_rapid_with_increment_returns_false(self) -> None:
        """'600+5' (10 min + 5s increment) is rapid, not correspondence."""
        assert is_correspondence_time_control("600+5") is False

    def test_bullet_returns_false(self) -> None:
        """'60+0' (1 min bullet) → False."""
        assert is_correspondence_time_control("60+0") is False

    def test_fractional_increment_returns_false(self) -> None:
        """'10+0.1' (chess.com fractional increment) → False."""
        assert is_correspondence_time_control("10+0.1") is False

    def test_none_returns_false(self) -> None:
        """None (missing time_control_str) → False."""
        assert is_correspondence_time_control(None) is False

    def test_empty_string_returns_false(self) -> None:
        """Empty string → False."""
        assert is_correspondence_time_control("") is False

    def test_dash_returns_false(self) -> None:
        """'-' (missing TC sentinel) → False."""
        assert is_correspondence_time_control("-") is False


class TestNormalizeFlawchessGame:
    """Phase 167 STORE-01/02 — PGN-only normalizer + [%clk]/result/termination gating."""

    def test_happy_path_white_user(self) -> None:
        """Both-color clocks + valid Result -> NormalizedGame with D-08 placement."""
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.platform == "flawchess"
        assert normalized.platform_game_id == _TEST_GAME_UUID
        assert normalized.rated is False
        assert normalized.is_computer_game is True
        assert normalized.result == "1-0"
        # D-08: player-color (white) rating column = converted player rating;
        # opponent-color (black) = bot nominal ELO.
        assert normalized.white_rating == _TEST_PLAYER_RATING
        assert normalized.black_rating == _TEST_BOT_ELO
        assert normalized.black_username == FLAWCHESS_BOT_USERNAME
        # quick-260714-pnk: the caller-resolved player_username reaches the
        # player-color (white) username column.
        assert normalized.white_username == _TEST_PLAYER_USERNAME

    def test_happy_path_black_user_rating_placement(self) -> None:
        """user_color='black' -> player rating in black column, bot ELO in white column."""
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "black",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.black_rating == _TEST_PLAYER_RATING
        assert normalized.white_rating == _TEST_BOT_ELO
        assert normalized.white_username == FLAWCHESS_BOT_USERNAME
        # quick-260714-pnk: the caller-resolved player_username reaches the
        # player-color (black) username column.
        assert normalized.black_username == _TEST_PLAYER_USERNAME

    def test_happy_path_bot_username_defaults_to_flawchess_bot(self) -> None:
        """quick-260722-ucc: no bot_username kwarg -> the Custom-mode fallback."""
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.black_username == FLAWCHESS_BOT_USERNAME

    def test_persona_bot_username_and_calibrated_rating_white_user(self) -> None:
        """quick-260722-ucc: a persona name + calibrated rating go in the
        bot-color (black, since user_color='white') columns."""
        calibrated_rating = 800
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            calibrated_rating,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
            bot_username="Ziggy the Wasp",
        )
        assert normalized is not None
        assert normalized.black_username == "Ziggy the Wasp"
        assert normalized.black_rating == calibrated_rating
        assert normalized.white_username == _TEST_PLAYER_USERNAME
        assert normalized.white_rating == _TEST_PLAYER_RATING

    def test_persona_bot_username_and_calibrated_rating_black_user(self) -> None:
        """quick-260722-ucc: mirrored placement when user_color='black' — the
        persona name + calibrated rating go in the white columns."""
        calibrated_rating = 800
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "black",
            calibrated_rating,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
            bot_username="Ziggy the Wasp",
        )
        assert normalized is not None
        assert normalized.white_username == "Ziggy the Wasp"
        assert normalized.white_rating == calibrated_rating
        assert normalized.black_username == _TEST_PLAYER_USERNAME
        assert normalized.black_rating == _TEST_PLAYER_RATING

    def test_no_anchor_player_rating_none(self) -> None:
        """player_rating=None (no anchor, D-06) flows through to the games row untouched."""
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            None,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.white_rating is None

    def test_white_missing_clock_returns_none(self) -> None:
        """No [%clk] on black's plies -> None (STORE-02/D-15)."""
        normalized = normalize_flawchess_game(
            _PGN_WHITE_CLOCK_ONLY,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is None

    def test_black_missing_clock_returns_none(self) -> None:
        """No [%clk] on white's plies -> None (STORE-02/D-15)."""
        normalized = normalize_flawchess_game(
            _PGN_BLACK_CLOCK_ONLY,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is None

    def test_unparseable_pgn_returns_none(self) -> None:
        """Garbage input with no parseable moves -> None, never an exception."""
        normalized = normalize_flawchess_game(
            _PGN_UNPARSEABLE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is None

    def test_missing_result_returns_none(self) -> None:
        """No Result header (defaults to '*') -> None."""
        normalized = normalize_flawchess_game(
            _PGN_NO_RESULT,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is None

    def test_checkmate_termination_derived_from_board(self) -> None:
        """No [Termination] header -> derived from the final board state."""
        normalized = normalize_flawchess_game(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.termination == "checkmate"

    def test_termination_header_takes_precedence(self) -> None:
        """A [Termination "resignation"] header overrides the board-derived value."""
        normalized = normalize_flawchess_game(
            _PGN_WITH_TERMINATION_HEADER,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.termination == "resignation"

    def test_unrecognized_oversized_termination_header_falls_back_to_board_derived(
        self,
    ) -> None:
        """CR-02: an unrecognized [Termination] header longer than the
        termination_raw String(50) DB column must never be stored verbatim —
        termination_raw must fall back to the closed-vocabulary board-derived
        value (here "checkmate"), never the raw ~60-char header string.
        """
        normalized = normalize_flawchess_game(
            _PGN_WITH_OVERSIZED_UNRECOGNIZED_TERMINATION_HEADER,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None
        assert normalized.termination == "checkmate"
        assert normalized.termination_raw == "checkmate"
        assert len(normalized.termination_raw) <= 50

    def test_black_to_move_setup_with_both_clocks_normalizes(self) -> None:
        """WR-02: a SetUp/FEN Black-to-move PGN with clocks on both real colors
        must normalize successfully — the clock gate must not misidentify a
        valid submission as invalid due to a wrong even=White/odd=Black
        assumption.
        """
        normalized = normalize_flawchess_game(
            _PGN_BLACK_TO_MOVE_BOTH_CLOCKS,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is not None

    def test_black_to_move_setup_missing_real_black_clock_returns_none(self) -> None:
        """WR-02: a SetUp/FEN Black-to-move PGN missing [%clk] on the real Black
        plies must still be rejected (STORE-02/D-15) under the fixed labeling.
        """
        normalized = normalize_flawchess_game(
            _PGN_BLACK_TO_MOVE_WHITE_CLOCK_ONLY,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert normalized is None


# Fewer than two plies is exactly the FLAWCHESS-64 shape: a game resigned (or
# flagged) before both sides moved can never satisfy the both-colors [%clk]
# gate, so the frontend must not POST it at all.
_PGN_SINGLE_PLY = (
    '[Event "FlawChess Bot Game"]\n[Result "0-1"]\n[Termination "resignation"]\n\n'
    "1. e4 {[%clk 0:05:00]} 0-1\n"
)

_PGN_NO_MOVES = '[Event "FlawChess Bot Game"]\n[Result "0-1"]\n[Termination "resignation"]\n\n0-1\n'

_PGN_NO_RESULT_HEADER = (
    '[Event "FlawChess Bot Game"]\n\n1. e4 {[%clk 0:05:00]} e5 {[%clk 0:04:57]} *\n'
)


class TestNormalizeFlawchessGameRejectReason:
    """FLAWCHESS-64 — every rejection carries a machine-readable reason code."""

    @pytest.mark.parametrize(
        ("pgn", "expected_reason"),
        [
            (_PGN_NO_MOVES, "no_moves"),
            (_PGN_SINGLE_PLY, "missing_clk"),
            (_PGN_NO_RESULT_HEADER, "invalid_result"),
        ],
    )
    def test_rejection_returns_reason(self, pgn: str, expected_reason: str) -> None:
        """A rejected PGN returns the reason string, not a NormalizedGame."""
        result = normalize_flawchess_game_or_reason(
            pgn,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert result == expected_reason

    def test_accepted_pgn_returns_normalized_game(self) -> None:
        """The success arm of the union is a NormalizedGame, never a str."""
        result = normalize_flawchess_game_or_reason(
            _PGN_BOTH_CLOCKS_CHECKMATE,
            _TEST_GAME_UUID,
            _TEST_USER_ID,
            "white",
            _TEST_BOT_ELO,
            _TEST_PLAYER_RATING,
            _TEST_PLAYER_USERNAME,
            _TEST_TC_STR,
        )
        assert not isinstance(result, str)
        assert result.platform_game_id == _TEST_GAME_UUID

    def test_wrapper_collapses_reason_to_none(self) -> None:
        """normalize_flawchess_game keeps its reason-free None contract."""
        assert (
            normalize_flawchess_game(
                _PGN_SINGLE_PLY,
                _TEST_GAME_UUID,
                _TEST_USER_ID,
                "white",
                _TEST_BOT_ELO,
                _TEST_PLAYER_RATING,
                _TEST_PLAYER_USERNAME,
                _TEST_TC_STR,
            )
            is None
        )
