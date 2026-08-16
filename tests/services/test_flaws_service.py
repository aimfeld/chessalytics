"""Unit tests for app.services.flaws_service.

Covers Phase 105 LIBG-02/06/07: severity classification, 8 attribution tags,
TypedDict output contract, eval coverage gate, mate Option B, FEN recomputation.
No DB required — all tests construct GamePosition objects in memory.

Phase 113 additions: TestIsOpponentExpr (parity helper), TestClassifyBothColors
(both-mover kernel), TestOpponentLuckyTag (per-mover subject_result).

Sign convention: eval_cp / eval_mate are white-perspective (Stockfish / python-chess).
"""

import chess
import pytest
from sqlalchemy import literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.services.flaws_service import (
    BLUNDER_DROP,
    EVAL_COVERAGE_MIN,
    FROM_WINNING_ES,
    INACCURACY_DROP,
    LOSING_LINE_ES,
    MATE_CP_EQUIVALENT,
    MISTAKE_DROP,
    SANITY_TOLERANCE,
    SQUANDERED_EXIT_ES,
    TIME_PRESSURE_CLOCK_FRACTION,
    HASTY_MOVE_FRACTION,
    MATE_LADDER_DECIDED_CP,
    MATE_LADDER_LOPSIDED_CP,
    WINNING_LINE_ES,
    FlawRecord,
    GameFlawsResult,
    GameNotAnalyzed,
    _classify_impact,
    _classify_mate_ladder,
    classify_severity,
    _classify_tempo,
    _classify_tactic_gated,
    _compute_eval_coverage,
    _detect_tactic_for_flaw,
    _move_time,
    _ply_to_es,
    _recompute_fen_map,
    _run_all_moves_pass,
    _solver_color_for,
    classify_game_flaws,
)
from app.services.forcing_line_gate import PvNode
from app.services.tactic_detector import TACTIC_CONFIDENCE_HIGH, TacticMotifInt


def _make_pos(
    ply: int,
    eval_cp: int | None = None,
    eval_mate: int | None = None,
    clock_seconds: float | None = None,
    phase: int = 1,
    move_san: str | None = None,
) -> GamePosition:
    """Build a GamePosition with eval/clock fields for pure unit testing (no DB flush).

    SQLAlchemy ORM objects can be instantiated without a session for attribute access.
    We set all columns the service reads plus non-null NOT-NULL columns so that
    attribute access never raises.
    """
    pos = GamePosition()
    pos.ply = ply
    pos.eval_cp = eval_cp
    pos.eval_mate = eval_mate
    pos.clock_seconds = clock_seconds
    pos.phase = phase
    pos.move_san = move_san
    pos.full_hash = 0
    pos.white_hash = 0
    pos.black_hash = 0
    pos.endgame_class = None
    return pos


def _make_game(
    pgn: str = "1. e4 e5 *",
    user_color: str = "white",
    result: str = "1-0",
    base_time_seconds: int | None = 600,
    increment_seconds: float | None = 0.0,
) -> Game:
    """Build a minimal Game object for unit testing (no DB flush).

    Uses direct constructor — SQLAlchemy ORM objects can be instantiated without
    a session for attribute access (session only required for DB queries/commits).
    """
    game = Game()
    game.pgn = pgn
    game.user_color = user_color
    game.result = result
    game.base_time_seconds = base_time_seconds
    game.increment_seconds = increment_seconds
    return game


# Short analyzed-game PGN for use in classify_game_flaws tests.
# Two-move game: 1. e4 e5 (white plays e4, black plays e5).
_SHORT_PGN = "1. e4 e5 *"

# A minimal but valid PGN for testing FEN recomputation.
_PGN_THREE_MOVES = "1. e4 e5 2. Nf3 *"


class TestConstants:
    """Verify that the named constants have the locked values from CONTEXT.md §Severity."""

    """Verify that the named constants have the locked values from CONTEXT.md §Severity."""

    def test_inaccuracy_drop_value(self) -> None:
        """INACCURACY_DROP must equal 0.05 (Lichess 0.10 halved for [0,1] ES scale)."""
        assert INACCURACY_DROP == 0.05

    def test_mistake_drop_value(self) -> None:
        """MISTAKE_DROP must equal 0.10."""
        assert MISTAKE_DROP == 0.10

    def test_blunder_drop_value(self) -> None:
        """BLUNDER_DROP must equal 0.15."""
        assert BLUNDER_DROP == 0.15

    def test_mate_cp_equivalent_value(self) -> None:
        """MATE_CP_EQUIVALENT must equal 1000 (Option B mate mapping)."""
        assert MATE_CP_EQUIVALENT == 1000

    def test_eval_coverage_min_value(self) -> None:
        """EVAL_COVERAGE_MIN must equal 0.90."""
        assert EVAL_COVERAGE_MIN == 0.90

    def test_from_winning_es_value(self) -> None:
        """FROM_WINNING_ES must equal 0.7511 (squandered entry, ES of +3.0)."""
        assert FROM_WINNING_ES == 0.7511

    def test_winning_line_es_value(self) -> None:
        """WINNING_LINE_ES must equal 0.6762 (reversed entry: clearly winning, ES of +2.0)."""
        assert WINNING_LINE_ES == 0.6762

    def test_losing_line_es_value(self) -> None:
        """LOSING_LINE_ES must equal 0.3238 (reversed exit: clearly losing, ES of −2.0)."""
        assert LOSING_LINE_ES == 0.3238

    def test_squandered_exit_es_value(self) -> None:
        """SQUANDERED_EXIT_ES must equal 0.5910 (squandered exit: back to a slight edge, ES of +1.0)."""
        assert SQUANDERED_EXIT_ES == 0.5910


class TestTypeContract:
    """Verify that FlawRecord and GameNotAnalyzed are importable and accept full literals."""

    def test_flaw_record_accepts_full_literal(self) -> None:
        """A fully-constructed FlawRecord literal round-trips all fields."""
        record: FlawRecord = {
            "ply": 10,
            "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
            "side": "white",
            "severity": "blunder",
            "tags": [],
            "es_before": 0.65,
            "es_after": 0.40,
            "move_san": "Qxf7",
            # Phase 128: renamed tactic_* → allowed_tactic_*; added missed_tactic_* (D-01/D-02).
            "allowed_tactic_motif_int": None,
            "allowed_tactic_piece": None,
            "allowed_tactic_confidence": None,
            "allowed_tactic_depth": None,
            "missed_tactic_motif_int": None,
            "missed_tactic_piece": None,
            "missed_tactic_confidence": None,
            "missed_tactic_depth": None,
        }
        assert record["ply"] == 10
        assert record["severity"] == "blunder"
        assert record["side"] == "white"
        assert record["es_before"] == pytest.approx(0.65)
        assert record["es_after"] == pytest.approx(0.40)
        assert record["move_san"] == "Qxf7"
        assert record["tags"] == []

    def test_game_not_analyzed_accepts_full_literal(self) -> None:
        """A fully-constructed GameNotAnalyzed literal round-trips all 2 fields."""
        not_analyzed: GameNotAnalyzed = {
            "reason": "no_engine_analysis",
            "eval_coverage": 0.0,
        }
        assert not_analyzed["reason"] == "no_engine_analysis"
        assert not_analyzed["eval_coverage"] == 0.0

    def test_game_flaws_result_is_union_type(self) -> None:
        """GameFlawsResult is the union type (importable and usable as annotation)."""
        result: GameFlawsResult = []
        assert isinstance(result, list)
        result2: GameFlawsResult = {"reason": "no_engine_analysis", "eval_coverage": 0.0}
        assert isinstance(result2, dict)


class TestSeverityClassification:
    """Boundary tests for classify_severity — halved Lichess thresholds on [0,1] ES."""

    def test_below_inaccuracy_threshold_returns_none(self) -> None:
        """A drop of 0.04 is below all thresholds — returns None."""
        assert classify_severity(0.04) is None

    def test_exactly_zero_drop_returns_none(self) -> None:
        """A drop of 0.0 (no worsening) returns None."""
        assert classify_severity(0.0) is None

    def test_inaccuracy_threshold_boundary_inclusive(self) -> None:
        """A drop of exactly 0.05 (INACCURACY_DROP) classifies as 'inaccuracy'."""
        assert classify_severity(0.05) == "inaccuracy"

    def test_inaccuracy_just_above_threshold(self) -> None:
        """A drop of 0.051 classifies as 'inaccuracy' (below MISTAKE_DROP)."""
        assert classify_severity(0.051) == "inaccuracy"

    def test_mistake_threshold_boundary_inclusive(self) -> None:
        """A drop of exactly 0.10 (MISTAKE_DROP) classifies as 'mistake'."""
        assert classify_severity(0.10) == "mistake"

    def test_mistake_just_above_threshold(self) -> None:
        """A drop of 0.101 classifies as 'mistake' (below BLUNDER_DROP)."""
        assert classify_severity(0.101) == "mistake"

    def test_blunder_threshold_boundary_inclusive(self) -> None:
        """A drop of exactly 0.15 (BLUNDER_DROP) classifies as 'blunder'."""
        assert classify_severity(0.15) == "blunder"

    def test_blunder_large_drop(self) -> None:
        """A large drop (0.50) classifies as 'blunder' (highest band wins)."""
        assert classify_severity(0.50) == "blunder"

    def test_highest_band_wins(self) -> None:
        """A drop of 0.20 classifies as 'blunder', not 'mistake' or 'inaccuracy'."""
        assert classify_severity(0.20) == "blunder"


class TestPlyToEs:
    """Tests for _ply_to_es — mover-POV ES derivation with Option B mate handling."""

    def test_cp_eval_white_mover(self) -> None:
        """+100 cp with white mover yields ~0.591 (sigmoid at +100)."""
        pos = _make_pos(0, eval_cp=100)
        result = _ply_to_es(pos, "white")
        assert result == pytest.approx(0.591, abs=1e-3)

    def test_cp_eval_black_mover_symmetry(self) -> None:
        """+100 cp with black mover yields ~0.409 (sign-flipped sigmoid — white is ahead)."""
        pos = _make_pos(0, eval_cp=100)
        result = _ply_to_es(pos, "black")
        assert result == pytest.approx(0.409, abs=1e-3)

    def test_null_eval_returns_none(self) -> None:
        """A position with both eval_cp and eval_mate null returns None."""
        pos = _make_pos(0)
        assert _ply_to_es(pos, "white") is None

    def test_mate_option_b_positive_for_white(self) -> None:
        """eval_mate=+3 with white mover yields ~0.975 (Option B, NOT 1.0)."""
        pos = _make_pos(0, eval_mate=3)
        result = _ply_to_es(pos, "white")
        assert result is not None
        assert result == pytest.approx(0.975, abs=1e-3)
        assert result != 1.0  # Option B: never exactly 1.0

    def test_mate_option_b_negative_for_white(self) -> None:
        """eval_mate=-3 with white mover yields ~0.025 (opponent has mate)."""
        pos = _make_pos(0, eval_mate=-3)
        result = _ply_to_es(pos, "white")
        assert result is not None
        assert result == pytest.approx(0.025, abs=1e-3)

    def test_mate_option_b_positive_for_black(self) -> None:
        """eval_mate=+3 (white has mate) with black mover yields ~0.025."""
        pos = _make_pos(0, eval_mate=3)
        result = _ply_to_es(pos, "black")
        assert result is not None
        assert result == pytest.approx(0.025, abs=1e-3)

    def test_eval_mate_takes_precedence_over_eval_cp(self) -> None:
        """When both eval_cp and eval_mate are present, eval_mate takes precedence (Option B)."""
        pos = _make_pos(0, eval_cp=50, eval_mate=3)
        result = _ply_to_es(pos, "white")
        assert result is not None
        assert result == pytest.approx(0.975, abs=1e-3)


class TestMateOptionB:
    """Tests for mate handling — Option B ensures mate-to-mate is NOT always a blunder."""

    def test_same_sign_mate_positions_near_zero_drop(self) -> None:
        """Two consecutive same-sign mate positions yield a near-zero ES drop.

        Both positions have eval_mate > 0 for white (white has forced mate throughout).
        The mover (white) at ply 2 should NOT have this classified as a blunder.
        """
        pos_before = _make_pos(1, eval_mate=4)  # ply 1: white has mate-in-4
        pos_after = _make_pos(2, eval_mate=3)  # ply 2: white has mate-in-3 (improved)
        # White mover at ply 2: reads ES_before from pos_before
        es_before = _ply_to_es(pos_before, "white")
        es_after = _ply_to_es(pos_after, "white")
        assert es_before is not None
        assert es_after is not None
        drop = es_before - es_after
        # Both map to ~0.975 with Option B; drop is near zero
        assert abs(drop) < INACCURACY_DROP, (
            f"Same-sign mate-to-mate drop should be near zero, got {drop}"
        )
        # Classify the drop — should NOT be classified as blunder
        severity = classify_severity(drop) if drop >= 0 else None
        assert severity is None or severity == "inaccuracy"


class TestMateLadder:
    """Tests for _classify_mate_ladder — the lila MateAdvice port (2026-06-11).

    Sign convention reminder: eval_cp/eval_mate are WHITE-perspective; the
    ladder inverts internally for a black mover. Thresholds are strict
    (lila `prevCp < -999` etc.), so the boundary value itself does NOT downgrade.
    """

    def test_constants_match_lila(self) -> None:
        """Ladder cp thresholds must match lila Advice.scala (999 / 700)."""
        assert MATE_LADDER_DECIDED_CP == 999
        assert MATE_LADDER_LOPSIDED_CP == 700

    # --- MateCreated: cp -> mate against the mover ---

    def test_mate_created_from_playable_position_is_blunder(self) -> None:
        prev = _make_pos(1, eval_cp=200)
        cur = _make_pos(2, eval_mate=-3)
        assert _classify_mate_ladder(prev, cur, "white") == "blunder"

    def test_mate_created_when_heavily_lost_is_mistake(self) -> None:
        prev = _make_pos(1, eval_cp=-750)
        cur = _make_pos(2, eval_mate=-3)
        assert _classify_mate_ladder(prev, cur, "white") == "mistake"

    def test_mate_created_when_already_decided_is_inaccuracy(self) -> None:
        prev = _make_pos(1, eval_cp=-1200)
        cur = _make_pos(2, eval_mate=-3)
        assert _classify_mate_ladder(prev, cur, "white") == "inaccuracy"

    def test_mate_created_boundaries_are_strict(self) -> None:
        """lila uses strict <: exactly -700 stays blunder, exactly -999 stays mistake."""
        cur = _make_pos(2, eval_mate=-3)
        assert _classify_mate_ladder(_make_pos(1, eval_cp=-700), cur, "white") == "blunder"
        assert _classify_mate_ladder(_make_pos(1, eval_cp=-701), cur, "white") == "mistake"
        assert _classify_mate_ladder(_make_pos(1, eval_cp=-999), cur, "white") == "mistake"
        assert _classify_mate_ladder(_make_pos(1, eval_cp=-1000), cur, "white") == "inaccuracy"

    # --- MateLost: mover's forced mate -> cp / mate against ---

    def test_mate_lost_back_to_moderate_advantage_is_blunder(self) -> None:
        """The conversion-throw case the Option-B drop math missed (game 1958407)."""
        prev = _make_pos(1, eval_mate=5)
        cur = _make_pos(2, eval_cp=550)
        assert _classify_mate_ladder(prev, cur, "white") == "blunder"

    def test_mate_lost_still_winning_big_is_mistake(self) -> None:
        prev = _make_pos(1, eval_mate=5)
        cur = _make_pos(2, eval_cp=750)
        assert _classify_mate_ladder(prev, cur, "white") == "mistake"

    def test_mate_lost_still_completely_winning_is_inaccuracy(self) -> None:
        prev = _make_pos(1, eval_mate=5)
        cur = _make_pos(2, eval_cp=1200)
        assert _classify_mate_ladder(prev, cur, "white") == "inaccuracy"

    def test_mate_flipped_to_mate_against_is_blunder(self) -> None:
        """Mate FOR the mover -> mate AGAINST: no cp side exists (lila defaults 0)."""
        prev = _make_pos(1, eval_mate=4)
        cur = _make_pos(2, eval_mate=-2)
        assert _classify_mate_ladder(prev, cur, "white") == "blunder"

    # --- No-advice transitions (must all return None, matching lila) ---

    def test_mate_delayed_is_not_a_flaw(self) -> None:
        """Mate-in-3 -> mate-in-8 (still winning): lila MateDelayed has no judgement."""
        prev = _make_pos(1, eval_mate=3)
        cur = _make_pos(2, eval_mate=8)
        assert _classify_mate_ladder(prev, cur, "white") is None

    def test_escaping_mate_against_is_not_a_flaw(self) -> None:
        prev = _make_pos(1, eval_mate=-5)
        cur = _make_pos(2, eval_cp=-600)
        assert _classify_mate_ladder(prev, cur, "white") is None

    def test_creating_mate_for_mover_is_not_a_flaw(self) -> None:
        prev = _make_pos(1, eval_cp=300)
        cur = _make_pos(2, eval_mate=5)
        assert _classify_mate_ladder(prev, cur, "white") is None

    def test_sinking_deeper_into_mate_against_is_not_a_flaw(self) -> None:
        prev = _make_pos(1, eval_mate=-5)
        cur = _make_pos(2, eval_mate=-3)
        assert _classify_mate_ladder(prev, cur, "white") is None

    # --- Black-mover symmetry (white-POV inputs are inverted internally) ---

    def test_black_mover_mate_created_is_blunder(self) -> None:
        """Black walks from a level cp position into a forced mate by white."""
        prev = _make_pos(2, eval_cp=-50)  # black slightly better (white POV -50)
        cur = _make_pos(3, eval_mate=4)  # white now mates in 4
        assert _classify_mate_ladder(prev, cur, "black") == "blunder"

    def test_black_mover_mate_lost_still_winning_is_mistake(self) -> None:
        """Black throws a forced mate but keeps a +800 (black-POV) position."""
        prev = _make_pos(2, eval_mate=-3)  # black mates in 3
        cur = _make_pos(3, eval_cp=-800)  # black still up the equivalent of +800
        assert _classify_mate_ladder(prev, cur, "black") == "mistake"


class TestMateLadderRouting:
    """_run_all_moves_pass must route mate-involved transitions to the ladder."""

    def test_mate_transition_uses_ladder_not_drop(self) -> None:
        """prev cp -800 -> mate against white: Option-B drop is ~0.025 (sub-threshold,
        previously None); the ladder grades it a mistake (heavily lost, not decided).
        """
        positions = [
            _make_pos(0, eval_cp=0),
            _make_pos(1, eval_cp=-800),
            _make_pos(2, eval_mate=-5),
        ]
        all_moves = _run_all_moves_pass(positions)
        mover, severity, _es_before, _es_after = all_moves[2]
        assert mover == "white"
        assert severity == "mistake"

    def test_thrown_mate_is_blunder_via_kernel(self) -> None:
        """Black reaches a forced mate then throws it back to ~+550 (black POV):
        under Option B the drop is ~0.09 (below MISTAKE_DROP); lichess and the
        ladder call it a blunder.
        """
        positions = [
            _make_pos(0, eval_cp=-400),
            _make_pos(1, eval_mate=-8),  # black has forced mate
            _make_pos(2, eval_mate=-8),  # white can't prevent it
            _make_pos(3, eval_cp=-550),  # black throws the mate, still winning
        ]
        all_moves = _run_all_moves_pass(positions)
        mover, severity, _es_before, _es_after = all_moves[3]
        assert mover == "black"
        assert severity == "blunder"

    def test_cp_only_transitions_unchanged(self) -> None:
        """Pure cp->cp games keep ES-drop classification (regression guard)."""
        positions = [
            _make_pos(0, eval_cp=20),
            _make_pos(1, eval_cp=30),
            _make_pos(2, eval_cp=-450),  # white throws ~0.36 ES -> blunder
        ]
        all_moves = _run_all_moves_pass(positions)
        _mover, severity, _es_before, _es_after = all_moves[2]
        assert severity == "blunder"

    def test_ladder_severity_flows_into_flaw_records(self) -> None:
        """classify_game_flaws emits a FlawRecord for a ladder-graded thrown mate."""
        game = _make_game(pgn="1. e4 e5 2. Nf3 Nc6 *", user_color="black", result="0-1")
        positions = [
            _make_pos(0, eval_cp=-400, move_san="e4"),
            _make_pos(1, eval_mate=-8, move_san="e5"),
            _make_pos(2, eval_mate=-8, move_san="Nf3"),
            _make_pos(3, eval_cp=-550, move_san="Nc6"),
        ]
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        thrown = [f for f in result if f["ply"] == 3]
        assert len(thrown) == 1
        assert thrown[0]["severity"] == "blunder"
        assert thrown[0]["side"] == "black"


class TestEvalCoverageGate:
    """Tests for _compute_eval_coverage."""

    def test_all_null_returns_zero(self) -> None:
        """All-null evals (chess.com game) returns 0.0."""
        positions = [_make_pos(i) for i in range(10)]
        assert _compute_eval_coverage(positions) == 0.0

    def test_empty_positions_returns_zero(self) -> None:
        """Empty list returns 0.0 (no divide-by-zero)."""
        assert _compute_eval_coverage([]) == 0.0

    def test_full_coverage_minus_final_ply(self) -> None:
        """81-row fully-analyzed game returns 1.0 (terminal position excluded).

        An 81-position game (plies 0-80) where only ply 80 has null eval has
        coverage 80/(81-1) = 80/80 = 1.0 — the terminal position is excluded from
        the denominator, so a fully-analyzed game scores 1.0 regardless of length.
        """
        positions = [_make_pos(i, eval_cp=50) for i in range(80)]
        positions.append(_make_pos(80))  # final ply: no eval
        coverage = _compute_eval_coverage(positions)
        assert coverage == pytest.approx(1.0, abs=1e-9)
        assert coverage >= EVAL_COVERAGE_MIN

    def test_below_threshold_returns_low_coverage(self) -> None:
        """A genuinely sparse game (5 of 10 positions eval'd) stays below threshold.

        5 eval'd of 10 positions = 5/(10-1) ≈ 0.556 — still well below 0.90, proving
        the terminal-position fix does not over-correct sparse games into "analyzed".
        """
        positions = [_make_pos(i, eval_cp=50 if i % 2 == 0 else None) for i in range(10)]
        coverage = _compute_eval_coverage(positions)
        assert coverage == pytest.approx(5 / 9, abs=1e-9)
        assert coverage < EVAL_COVERAGE_MIN

    def test_single_position_returns_zero(self) -> None:
        """A single-position list has no movable ply, returns 0.0 (denominator guard)."""
        assert _compute_eval_coverage([_make_pos(0)]) == 0.0

    def test_short_fully_analyzed_game_clears_gate(self) -> None:
        """Regression (260615-rb1): a 7-ply fully-analyzed game clears the gate.

        7 movable positions all eval'd + 1 terminal null position (8 total, a 7-ply
        game) = 7/(8-1) = 1.0. Before the fix this was 7/8 = 0.875 < 0.90, which
        misclassified short fully-analyzed games as GameNotAnalyzed.
        """
        positions = [_make_pos(i, eval_cp=20) for i in range(7)]
        positions.append(_make_pos(7))  # terminal ply: no eval
        coverage = _compute_eval_coverage(positions)
        assert coverage == pytest.approx(1.0, abs=1e-9)
        assert coverage >= EVAL_COVERAGE_MIN


class TestFenRecompute:
    """Tests for _recompute_fen_map — PGN replay using board.fen() (Phase 148 D-02).

    BUGFIX (Phase 148): this map used to store board.board_fen() (piece placement
    only), dropping side-to-move/castling/en-passant state and corrupting PV replay
    for ep/castling flaws. These tests were inverted to encode the fixed (full-FEN)
    contract as correct — see 148-RESEARCH.md's inversion table; the pre-fix
    assertions below are expected fallout, not a regression.
    """

    def test_initial_position_at_ply_zero(self) -> None:
        """Ply 0 (before any moves) is the standard initial position (full FEN)."""
        fen_map = _recompute_fen_map(_SHORT_PGN)
        assert 0 in fen_map
        assert fen_map[0] == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

    def test_after_e4_full_fen(self) -> None:
        """After 1. e4, the fen at ply 1 is a full FEN (side-to-move, castling rights)."""
        fen_map = _recompute_fen_map(_SHORT_PGN)
        assert 1 in fen_map
        fen = fen_map[1]
        # Full FEN has 6 space-separated fields: placement, side, castling, ep, halfmove, fullmove
        fields = fen.split(" ")
        assert len(fields) == 6, f"expected 6 space-separated FEN fields, got {len(fields)}: {fen}"
        assert fields[1] == "b", "black to move after 1. e4"
        assert fields[2] == "KQkq", "castling rights unaffected by a pawn push"
        # No black pawn is adjacent to capture en passant yet, so python-chess omits
        # the ep target here (it only records a target when a capture is legally
        # available) — the dedicated ep-capture fixture below covers the case where
        # the target square DOES matter for replay correctness.

    def test_three_moves_produces_four_entries(self) -> None:
        """A 3-move PGN produces 4 entries: ply 0 through 3."""
        fen_map = _recompute_fen_map(_PGN_THREE_MOVES)
        assert len(fen_map) == 4  # plies 0, 1, 2, 3

    def test_invalid_pgn_returns_initial_position(self) -> None:
        """An unparseable PGN (no valid moves) returns the initial position at ply 0.

        chess.pgn.read_game successfully parses a game header even on invalid input,
        yielding zero mainline moves. The map contains only ply 0 (initial position).
        """
        fen_map = _recompute_fen_map("not valid pgn at all !!!!")
        # python-chess parses this as an empty game (no moves) — ply 0 only
        assert 0 in fen_map
        # No moves parsed, so only ply 0 is in the map
        assert len(fen_map) == 1

    def test_full_fen_not_board_fen(self) -> None:
        """FEN values are full FENs (6 space-separated fields), not piece-placement-only."""
        fen_map = _recompute_fen_map(_PGN_THREE_MOVES)
        for ply_n, fen in fen_map.items():
            fields = fen.split(" ")
            assert len(fields) == 6, (
                f"ply {ply_n}: expected 6 space-separated FEN fields, got {len(fields)}: {fen}"
            )
            assert fields[1] in ("w", "b"), f"ply {ply_n}: missing side-to-move field: {fen}"
            # Piece-placement field alone still has exactly 8 rank fields.
            ranks = fields[0].split("/")
            assert len(ranks) == 8, f"ply {ply_n}: expected 8 rank fields, got {len(ranks)}: {fen}"

    def test_replay_failure_captured_to_sentry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """WR-03: a replay failure is captured to Sentry, not silently swallowed.

        We make board.fen() raise inside the replay loop and assert capture_exception
        fired exactly once while the partial map (ply 0) is still returned. fen() is
        only called by the replay (never by chess.pgn.read_game), so patching it
        isolates the failure to the try block without breaking PGN parsing.
        """
        captured: list[BaseException | None] = []

        def fake_capture(exc: BaseException | None = None) -> None:
            captured.append(exc)

        monkeypatch.setattr("app.services.flaws_service.sentry_sdk.capture_exception", fake_capture)

        real_fen = chess.Board.fen
        calls = {"n": 0}

        def flaky_fen(self: chess.Board, **kwargs: object) -> str:
            calls["n"] += 1
            # 1st call is ply 0 (outside the try) and must succeed; raise on the
            # 2nd call (first loop iteration, inside the try) to hit the except path.
            if calls["n"] == 2:
                raise ValueError("simulated replay failure")
            return real_fen(self, **kwargs)  # ty: ignore[invalid-argument-type]  # monkeypatch shim

        monkeypatch.setattr(chess.Board, "fen", flaky_fen)

        fen_map = _recompute_fen_map(_PGN_THREE_MOVES)

        assert len(captured) == 1, "replay failure must be reported to Sentry exactly once"
        # Partial map preserved: ply 0 captured before the failure; later plies absent.
        assert 0 in fen_map
        assert 1 not in fen_map


_EP_CAPTURE_PGN = "1. e4 Nf6 2. e5 d5 3. exd6 *"  # 3. exd6 is an en-passant capture


class TestFenMapEpCapture:
    """Bug B (Phase 148 D-02): full-FEN fen_map replays en-passant flaws correctly.

    Before the fix, _recompute_fen_map stored board.board_fen() (piece placement
    only), dropping the en-passant target square. Reconstructing a chess.Board from
    that string made a subsequent en-passant-capture SAN illegal (IllegalMoveError),
    silently corrupting the PV replay for any flaw at or after an ep capture.
    """

    def test_ep_target_recorded_and_capture_replays(self) -> None:
        """fen_map preserves the en-passant target so an ep-capture SAN parses and
        pushing it removes the captured pawn (occupant-count check)."""
        fen_map = _recompute_fen_map(_EP_CAPTURE_PGN)
        # ply 4: after 1. e4 Nf6 2. e5 d5 (black's double push) — white to move.
        fen_before = fen_map[4]
        fields = fen_before.split(" ")
        assert fields[1] == "w"
        assert fields[3] == "d6", f"expected en-passant target d6, got FEN: {fen_before}"

        board_before = chess.Board(fen_before)
        pawns_before = len(board_before.pieces(chess.PAWN, chess.BLACK))

        # SAN parses — this would raise chess.IllegalMoveError under the pre-fix
        # board_fen()-only reconstruction, since the ep target square is missing.
        ep_move = board_before.parse_san("exd6")
        assert board_before.is_en_passant(ep_move)

        board_before.push(ep_move)
        pawns_after = len(board_before.pieces(chess.PAWN, chess.BLACK))
        assert pawns_after == pawns_before - 1, "the en-passant-captured black pawn must be removed"
        # The captured pawn sat on d5 (not the destination square d6) — verify it's gone.
        assert board_before.piece_at(chess.D5) is None

    def test_detect_tactic_for_flaw_replays_ep_capture_without_parse_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The consumption site (_detect_tactic_for_flaw, 'allowed' orientation) parses
        the ep-capture flaw move and reaches the tactic detector without raising.

        Pre-fix, board_before.parse_san("exd6") would raise chess.IllegalMoveError
        (caught by the existing try/except), silently returning all-None for the
        WRONG reason (a parse failure, not "no tactic detected"). We prove the parse
        succeeded by monkeypatching detect_tactic_motif with a sentinel stub and
        asserting it was actually reached and called with the post-capture board.
        """
        fen_map = _recompute_fen_map(_EP_CAPTURE_PGN)
        positions = [_make_pos(i) for i in range(6)]
        positions[4].move_san = "exd6"

        sentinel_calls: list[chess.Board] = []

        def fake_detect_tactic_motif(
            board_after_flaw: chess.Board, pv_str: str, has_forced_mate: bool = False
        ) -> tuple[int | None, int | None, int | None, int | None]:
            sentinel_calls.append(board_after_flaw)
            return TacticMotifInt.FORK, chess.KNIGHT, TACTIC_CONFIDENCE_HIGH, 0

        monkeypatch.setattr(
            "app.services.flaws_service.detect_tactic_motif", fake_detect_tactic_motif
        )

        motif_int, piece, conf, depth = _detect_tactic_for_flaw(
            4, fen_map, positions, pv_by_ply={5: "b8c6"}, orientation="allowed"
        )

        assert len(sentinel_calls) == 1, (
            "detect_tactic_motif must be reached — parse_san('exd6') must not raise"
        )
        # The board passed to the detector reflects the ep capture already played:
        # black's d5 pawn is gone and it's black to move.
        board_after_flaw = sentinel_calls[0]
        assert board_after_flaw.piece_at(chess.D5) is None
        assert board_after_flaw.turn == chess.BLACK
        assert (motif_int, piece, conf, depth) == (
            TacticMotifInt.FORK,
            chess.KNIGHT,
            TACTIC_CONFIDENCE_HIGH,
            0,
        )


class TestClassifyGameFlaws:
    """Tests for classify_game_flaws — the public API."""

    # -----------------------------------------------------------------------
    # Helpers: build small position sequences for testing
    # -----------------------------------------------------------------------

    def _make_analyzed_positions(
        self,
        n_plies: int = 10,
        eval_cp_value: int = 20,
    ) -> list[GamePosition]:
        """Build n_plies positions where all but the last have eval_cp set."""
        positions = [_make_pos(i, eval_cp=eval_cp_value) for i in range(n_plies)]
        positions[-1] = _make_pos(n_plies - 1)  # final ply: no eval (normal)
        return positions

    def _make_chesscom_positions(self, n_plies: int = 10) -> list[GamePosition]:
        """Build positions with all-null evals (chess.com game)."""
        return [_make_pos(i) for i in range(n_plies)]

    # -----------------------------------------------------------------------
    # Coverage gate
    # -----------------------------------------------------------------------

    def test_zero_coverage_returns_game_not_analyzed(self) -> None:
        """A chess.com game (all evals null) returns GameNotAnalyzed."""
        game = _make_game(pgn=_SHORT_PGN, user_color="white")
        positions = self._make_chesscom_positions(4)
        result = classify_game_flaws(game, positions)
        assert isinstance(result, dict), "Expected GameNotAnalyzed dict"
        assert result["reason"] == "no_engine_analysis"
        assert result["eval_coverage"] == pytest.approx(0.0)

    def test_analyzed_game_returns_list(self) -> None:
        """A >= 90%-coverage game returns a list (possibly empty)."""
        # Use 10 positions; only the last has no eval: coverage = 9/10 = 0.90 >= threshold
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")
        positions = [_make_pos(i, eval_cp=20) for i in range(9)]
        positions.append(_make_pos(9))  # final ply: no eval
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list), "Expected list[FlawRecord]"

    def test_coverage_gate_below_threshold_returns_not_analyzed(self) -> None:
        """A game with < 90% eval coverage returns GameNotAnalyzed."""
        game = _make_game(pgn=_SHORT_PGN, user_color="white")
        # 10 positions, only 5 with eval = 5/(10-1) ≈ 0.556 coverage < 90%
        positions = [_make_pos(i, eval_cp=20 if i < 5 else None) for i in range(10)]
        result = classify_game_flaws(game, positions)
        assert isinstance(result, dict)
        assert result["reason"] == "no_engine_analysis"

    def test_short_fully_analyzed_game_not_marked_unanalyzed(self) -> None:
        """Regression (260615-rb1): a short fully-analyzed game is NOT GameNotAnalyzed.

        _SHORT_PGN is "1. e4 e5 *" (a 2-ply game): 2 movable positions both eval'd +
        1 terminal null = coverage 2/(3-1) = 1.0 >= EVAL_COVERAGE_MIN. Before the fix
        this scored 2/3 = 0.667 and was wrongly returned as GameNotAnalyzed, leaving
        oracle columns NULL and the "Analyze" pill stuck.
        """
        game = _make_game(pgn=_SHORT_PGN, user_color="white")
        positions = [_make_pos(0, eval_cp=20), _make_pos(1, eval_cp=20), _make_pos(2)]
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list), (
            "Short fully-analyzed game must return list, not GameNotAnalyzed"
        )

    # -----------------------------------------------------------------------
    # Flaw emission: only mistakes/blunders, not inaccuracies
    # -----------------------------------------------------------------------

    def test_inaccuracy_only_game_returns_empty_list(self) -> None:
        """An analyzed game with only inaccuracies returns empty list, NOT GameNotAnalyzed.

        This tests the 2026-06-05 amendment: inaccuracies are count-only.

        White mover at ply 2 (even ply).
        eval_cp_to_expected_score(50, "white") ≈ 0.568 (es_before from ply 1)
        eval_cp_to_expected_score(0, "white") = 0.5   (es_after from ply 2)
        drop = 0.068 -> inaccuracy band — NOT emitted.
        10 positions with 1 final null: coverage = 9/10 = 0.90 >= EVAL_COVERAGE_MIN.
        """
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")
        # Build 10 positions; only white at ply 2 has an inaccuracy (drop ≈ 0.068)
        positions = [_make_pos(i, eval_cp=0) for i in range(10)]
        positions[1] = _make_pos(1, eval_cp=50)  # es_before for white mover at ply 2
        positions[2] = _make_pos(2, eval_cp=0)  # es_after for white mover at ply 2
        positions[9] = _make_pos(9)  # final null; coverage = 9/10 = 0.90
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list), (
            "Inaccuracy-only analyzed game must return list, not GameNotAnalyzed"
        )
        assert result == [], "Inaccuracy-only analyzed game must return empty list"

    def test_blunder_emitted_as_flaw_record(self) -> None:
        """A deliberate blunder is emitted as a FlawRecord with correct fields.

        White is the user (user_color="white"). White's move at ply 2 (even ply).
        ES_before = _ply_to_es(positions[1], "white"); ES_after = _ply_to_es(positions[2], "white").
        """
        # Use a real PGN so FEN recomputation works
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")

        # 10 positions: plies 0-9, final ply has no eval.
        # Induce a blunder for white at ply 2 (even ply => white mover).
        # ES_before from ply 1, ES_after from ply 2.
        # eval_cp_to_expected_score(200, "white") ≈ 0.685
        # eval_cp_to_expected_score(-500, "white") ≈ 0.160
        # drop = 0.685 - 0.160 = 0.525 >= 0.15 => blunder
        positions = [_make_pos(i, eval_cp=20) for i in range(10)]
        positions[1] = _make_pos(1, eval_cp=200, move_san="e4")
        positions[2] = _make_pos(2, eval_cp=-500, move_san="Nf3")
        positions[9] = _make_pos(9)  # final ply: no eval

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        assert len(result) >= 1, "Expected at least one blunder FlawRecord"

        # Find the blunder at ply 2
        blunders = [r for r in result if r["ply"] == 2]
        assert len(blunders) == 1
        flaw = blunders[0]
        assert flaw["severity"] == "blunder"
        assert flaw["side"] == "white"
        assert flaw["fen"] != ""  # FEN recomputed from PGN
        assert flaw["es_before"] > flaw["es_after"], "Blunder worsens ES"
        assert isinstance(flaw["tags"], list)  # tags populated in plan 02

    def test_fen_is_decision_point_before_flawed_move(self) -> None:
        """Regression: flaw['fen'] is the position BEFORE the flawed move, and the
        move resolves from it (guards the off-by-one that rendered the miniboard
        one ply too early).

        positions[k].move_san is the move played FROM ply k, so the flaw at ply n
        plays positions[n].move_san. Its decision point is fen_map[n] (n half-moves
        already played), NOT fen_map[n - 1]. Verified semantically: pushing the
        flawed move onto the stored fen must reach the next ply's board
        (fen_map[n + 1]). The earlier fen_map[n - 1] bug skipped the immediately
        preceding move (here black's ...a6), so this assertion failed.
        """
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")
        # Induce a blunder for white at ply 6 — the move FROM ply 6 is Ba4 (7th
        # half-move). ...a6 (6th half-move) is the move immediately before it; the
        # off-by-one fen would have shown the board before ...a6.
        positions = [_make_pos(i, eval_cp=0) for i in range(10)]
        positions[5] = _make_pos(5, eval_cp=300, move_san="a6")  # before the blunder
        positions[6] = _make_pos(6, eval_cp=-500, move_san="Ba4")  # the blunder
        positions[9] = _make_pos(9)  # final null ply

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        flaws = [r for r in result if r["ply"] == 6]
        assert len(flaws) == 1
        flaw = flaws[0]
        assert flaw["move_san"] == "Ba4"

        fen_map = _recompute_fen_map(pgn)
        # flaw["fen"] is the persisted, API-facing piece-placement-only field (Phase
        # 148 D-02 keeps this contract unchanged); fen_map now stores the full FEN
        # (detector-internal). The decision point is board after `ply` half-moves.
        assert flaw["fen"] == fen_map[6].split(" ")[0]
        # And playing the flawed move from it reaches the next ply's board.
        side = "w" if flaw["side"] == "white" else "b"
        board = chess.Board(f"{flaw['fen']} {side} - - 0 1")
        board.push_san(flaw["move_san"])
        assert board.board_fen() == fen_map[7].split(" ")[0]

    def test_es_before_greater_than_es_after_for_blunder(self) -> None:
        """Eval-AFTER landmine: ES_before reads positions[N-1], ES_after reads positions[N].

        White mover at ply 2 (even ply):
          positions[1] = ES_before (eval stored AFTER ply-1 move, BEFORE ply-2 move)
          positions[2] = ES_after  (eval stored AFTER ply-2 move, showing the blunder)
        A move that worsened the position must show es_before > es_after.
        """
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")
        positions = [_make_pos(i, eval_cp=0) for i in range(10)]
        positions[1] = _make_pos(1, eval_cp=300)  # good position before white's blunder
        positions[2] = _make_pos(2, eval_cp=-500)  # bad position after white's blunder
        positions[9] = _make_pos(9)  # final null; coverage = 9/10 = 0.90

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2_flaws = [r for r in result if r["ply"] == 2]
        assert len(ply2_flaws) == 1
        flaw = ply2_flaws[0]
        assert flaw["es_before"] > flaw["es_after"]

    def test_opponent_flaws_in_result_for_white_user(self) -> None:
        """Phase 113 (D-06): both movers' flaws appear in the result.

        After dropping the mover != user_color filter, classify_game_flaws emits
        FlawRecords for BOTH movers. An opponent (black) blunder at ply 3 must
        appear alongside any player (white) flaws. Readers that need player-only
        rows use is_opponent_expr() at query time (CONTEXT D-01).
        """
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")

        # Induce a blunder for BLACK at ply 3 (odd ply => black mover).
        # pos[2].eval_cp = -300 => es_before for black ≈ 0.667 (black was winning)
        # pos[3].eval_cp = +200 => es_after for black ≈ 0.315 (black now losing)
        # drop = 0.667 - 0.315 = 0.352 => blunder for black
        positions = [_make_pos(i, eval_cp=0) for i in range(10)]
        positions[2] = _make_pos(2, eval_cp=-300)  # before black's ply-3 move
        positions[3] = _make_pos(3, eval_cp=200)  # after black's blunder
        positions[9] = _make_pos(9)  # final null

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        # Phase 113: both sides emitted — the opponent (black) blunder must appear
        black_flaws = [f for f in result if f["side"] == "black"]
        assert len(black_flaws) >= 1, (
            "Phase 113 kernel change: opponent (black) flaw at ply 3 must appear in result. "
            "Readers use is_opponent_expr() to filter player-only at query time."
        )

    def test_flaws_are_sorted_by_ply(self) -> None:
        """Returned FlawRecords are ordered by ply ascending (iteration order)."""
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")

        # Induce two white blunders: ply 2 and ply 6
        positions = [_make_pos(i, eval_cp=0) for i in range(10)]
        positions[1] = _make_pos(1, eval_cp=200)
        positions[2] = _make_pos(2, eval_cp=-500)  # blunder at ply 2
        positions[5] = _make_pos(5, eval_cp=200)
        positions[6] = _make_pos(6, eval_cp=-500)  # blunder at ply 6
        positions[9] = _make_pos(9)

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        plies = [r["ply"] for r in result]
        assert plies == sorted(plies), "FlawRecords should be ordered by ply ASC"


class TestTempoTags:
    """Tests for _classify_tempo — at most one tempo tag per flaw."""

    def test_low_clock_when_low_clock_fraction(self) -> None:
        """clock_after < TIME_PRESSURE_CLOCK_FRACTION * base_time yields low-clock."""
        base_time = 600
        low_clock = base_time * TIME_PRESSURE_CLOCK_FRACTION - 1  # just below threshold
        result = _classify_tempo(move_time=30.0, clock_after=low_clock, base_time=base_time)
        assert result == "low-clock"

    def test_hasty_when_fast_move_on_comfortable_clock(self) -> None:
        """move_time < HASTY_MOVE_FRACTION * base_time on a comfortable clock yields hasty."""
        base_time = 600
        comfortable_clock = base_time * TIME_PRESSURE_CLOCK_FRACTION + 10  # well above threshold
        fast_move = base_time * HASTY_MOVE_FRACTION - 0.1  # just below fast threshold
        result = _classify_tempo(
            move_time=fast_move, clock_after=comfortable_clock, base_time=base_time
        )
        assert result == "hasty"

    def test_unrushed_when_adequate_time(self) -> None:
        """Adequate clock and adequate move time yields unrushed."""
        base_time = 600
        comfortable_clock = base_time * TIME_PRESSURE_CLOCK_FRACTION + 60
        adequate_move = base_time * HASTY_MOVE_FRACTION + 5.0
        result = _classify_tempo(
            move_time=adequate_move, clock_after=comfortable_clock, base_time=base_time
        )
        assert result == "unrushed"

    def test_no_tempo_tag_when_clock_data_missing(self) -> None:
        """Missing clock_after yields None — missing clock/move-time yields no tempo tag, not a fallback."""
        result = _classify_tempo(move_time=10.0, clock_after=None, base_time=600)
        assert result is None

    def test_no_tempo_tag_when_move_time_missing(self) -> None:
        """Missing move_time yields None — missing clock/move-time yields no tempo tag, not a fallback."""
        result = _classify_tempo(move_time=None, clock_after=100.0, base_time=600)
        assert result is None

    def test_abs_fallback_low_clock_when_no_base_time(self) -> None:
        """When base_time is None, falls back to absolute threshold for low-clock."""
        # clock < 30s absolute = low-clock
        result = _classify_tempo(move_time=10.0, clock_after=25.0, base_time=None)
        assert result == "low-clock"

    def test_abs_fallback_hasty_when_no_base_time(self) -> None:
        """When base_time is None, falls back to absolute threshold for hasty."""
        # clock >= 30s, move < 5s = hasty
        result = _classify_tempo(move_time=3.0, clock_after=60.0, base_time=None)
        assert result == "hasty"

    def test_move_time_clamps_negative_to_none(self) -> None:
        """WR-05: a clock anomaly producing a negative move time returns None.

        Same-side clock is two plies back. If the clock 'gains' more than the
        increment between the player's own moves (corrupt data), the raw formula
        goes negative — which would otherwise satisfy move_time < fast_threshold
        and mislabel the move as hasty. The fix returns None so tempo is
        absent (None) so the move is not mislabeled hasty.
        """
        positions = [_make_pos(i) for i in range(4)]
        # prev same-side clock (n-2) LOWER than current (n) with zero increment
        # => prev - curr + inc = 100 - 130 + 0 = -30 (impossible, anomaly)
        positions[0] = _make_pos(0, clock_seconds=100.0)
        positions[2] = _make_pos(2, clock_seconds=130.0)
        assert _move_time(positions, n=2, increment=0.0) is None

    def test_move_time_zero_is_valid(self) -> None:
        """A genuinely instant move (time == 0) is valid and not clamped to None."""
        positions = [_make_pos(i) for i in range(4)]
        positions[0] = _make_pos(0, clock_seconds=100.0)
        positions[2] = _make_pos(2, clock_seconds=100.0)
        assert _move_time(positions, n=2, increment=0.0) == 0.0

    def test_at_most_one_tempo_tag_per_flaw_in_classify_game(self) -> None:
        """Every emitted FlawRecord contains at most one tempo tag."""
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        # Construct positions with clocks to exercise tempo logic
        game = _make_game(pgn=pgn, user_color="white", base_time_seconds=600)
        positions = [_make_pos(i, eval_cp=0, clock_seconds=float(600 - i * 5)) for i in range(10)]
        # Induce blunder at ply 2 (white)
        positions[1] = _make_pos(1, eval_cp=300, clock_seconds=590.0)
        positions[2] = _make_pos(2, eval_cp=-500, clock_seconds=580.0)
        positions[9] = _make_pos(9)  # final null

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        assert len(result) >= 1, "Expected at least one flaw"
        for flaw in result:
            tempo_tags = [t for t in flaw["tags"] if t in ("low-clock", "hasty", "unrushed")]
            assert len(tempo_tags) <= 1, (
                f"Flaw at ply {flaw['ply']} must have at most one tempo tag, got: {tempo_tags}"
            )

    def test_no_tempo_tag_when_flaw_has_missing_clock_data(self) -> None:
        """A FlawRecord built from a flaw with missing clock data carries NO tempo tag.

        This tests the at-most-one rule from flaw-tag-naming.md §'Structural change':
        when clock_after or move_time is None, _classify_tempo returns None and
        _build_tags omits the tempo append entirely.
        """
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white", base_time_seconds=600)
        # Build positions with NO clock data (clock_seconds=None throughout)
        positions = [_make_pos(i, eval_cp=0, clock_seconds=None) for i in range(10)]
        # Induce blunder at ply 2 (white) — clock_seconds remains None
        positions[1] = _make_pos(1, eval_cp=300, clock_seconds=None)
        positions[2] = _make_pos(2, eval_cp=-500, clock_seconds=None)
        positions[9] = _make_pos(9)  # final null

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        assert len(result) >= 1, "Expected at least one flaw"
        tempo_set = {"low-clock", "hasty", "unrushed"}
        for flaw in result:
            tempo_tags = [t for t in flaw["tags"] if t in tempo_set]
            assert tempo_tags == [], (
                f"Flaw at ply {flaw['ply']} must carry no tempo tag when clock data is "
                f"unavailable, got: {tempo_tags}"
            )


class TestAttributionTags:
    """Tests for miss, lucky, reversed, squandered, and phase tags."""

    # PGN long enough to have moves for position building
    _PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"

    def _make_standard_positions(self, n: int = 12) -> list[GamePosition]:
        """Build n positions with moderate eval (no errors)."""
        positions = [_make_pos(i, eval_cp=20) for i in range(n)]
        positions[-1] = _make_pos(n - 1)  # final null
        return positions

    def test_miss_tag_when_preceding_opponent_was_blunder(self) -> None:
        """User flaw at ply N gets miss tag when opponent at ply N-1 was a blunder.

        Positions: user is white.
        Ply 3 (odd = black mover): black blunders (eval_cp drops for black).
        Ply 4 (even = white mover): white also blunders — this gets miss tag.
        """
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        # Black blunders at ply 3: set positions[2] and positions[3]
        # Black POV: eval_cp=-300 at [2] means es_before for black ≈ 1-0.333=0.667
        # eval_cp=+400 at [3] means es_after for black ≈ 1-0.731=0.269
        # drop = 0.667 - 0.269 = 0.398 >= 0.15 => blunder for black
        positions[2] = _make_pos(2, eval_cp=-300)
        positions[3] = _make_pos(3, eval_cp=400)  # black blunder
        # White blunders at ply 4 (immediately after black's ply 3 blunder):
        # eval_cp=400 at [3] means es_before for white ≈ 0.731
        # eval_cp=-400 at [4] means es_after for white ≈ 1-0.731=0.269
        # drop = 0.731 - 0.269 = 0.462 >= 0.15 => blunder for white
        positions[4] = _make_pos(4, eval_cp=-400)  # white blunder right after
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply4 = [f for f in result if f["ply"] == 4]
        assert len(ply4) == 1, "Expected white blunder at ply 4"
        assert "miss" in ply4[0]["tags"], "White blunder after black blunder should get miss tag"

    def test_no_miss_tag_when_preceding_opponent_not_error(self) -> None:
        """User flaw at ply N does NOT get miss tag when opponent at N-1 was fine.

        Black at ply 3 (odd): positions[2].eval_cp = positions[3].eval_cp = 20
        => drop for black ≈ 0, not an error.
        White at ply 4 (even): positions[3].eval_cp = 20, positions[4].eval_cp = -400
        => large drop for white = blunder. But ply 3 had no opponent error, so no miss.
        """
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        # Black at ply 3: both positions[2] and positions[3] at eval_cp=20 => near-zero drop for black
        positions[2] = _make_pos(2, eval_cp=20)  # es_before for black at ply 3 (same as default)
        positions[3] = _make_pos(
            3, eval_cp=20
        )  # opponent's ply 3: fine (negligible drop for black)
        positions[4] = _make_pos(4, eval_cp=-400)  # white blunders at ply 4 (drop ≈ 0.72)
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply4 = [f for f in result if f["ply"] == 4]
        assert len(ply4) == 1
        assert "miss" not in ply4[0]["tags"]

    def test_lucky_tag_when_opponent_blunders_back(self) -> None:
        """User blunder at ply N gets lucky when the opponent ERRS in reply.

        lucky = the user's blunder went unpunished because the opponent
        failed to find the punishing line (their reply was itself a mistake/blunder),
        so the user's expected score recovered.

        White blunders at ply 4 (400 → -400, drop ≈ 0.462), then black blunders
        back at ply 5 (-400 → +400): black's es drops from ≈0.731 to ≈0.269
        (drop ≈ 0.462 = blunder), handing the advantage back to white. White got
        away with it → lucky.
        """
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[3] = _make_pos(3, eval_cp=400)  # before white's ply 4
        positions[4] = _make_pos(4, eval_cp=-400)  # white blunders (drop ≈ 0.462)
        positions[5] = _make_pos(5, eval_cp=400)  # black blunders back → white recovers
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply4 = [f for f in result if f["ply"] == 4]
        assert len(ply4) == 1
        assert ply4[0]["severity"] == "blunder"
        assert "lucky" in ply4[0]["tags"], (
            "White blunder should be lucky when black blunders back in reply"
        )

    def test_no_lucky_when_opponent_capitalizes(self) -> None:
        """User blunder is NOT lucky when the opponent plays a fine move.

        Regression guard for the inverted-heuristic bug (2026-06-07): a blunder
        followed by a sensible opponent reply (the opponent capitalizes / holds the
        advantage) must NOT be tagged lucky. White blunders at ply 4
        (400 → -400), black plays fine at ply 5 (-380, near-zero drop): black keeps
        the winning position, so white did not escape.
        """
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[3] = _make_pos(3, eval_cp=400)  # before white's ply 4
        positions[4] = _make_pos(4, eval_cp=-400)  # white blunders (drop ≈ 0.462)
        positions[5] = _make_pos(5, eval_cp=-380)  # black plays fine, keeps advantage
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply4 = [f for f in result if f["ply"] == 4]
        assert len(ply4) == 1
        assert ply4[0]["severity"] == "blunder"
        assert "lucky" not in ply4[0]["tags"], (
            "A blunder the opponent capitalizes on is not a lucky escape"
        )

    def test_no_lucky_tag_on_non_blunder(self) -> None:
        """A user mistake (not blunder) does NOT get the lucky tag."""
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        # White makes a mistake at ply 4 (between MISTAKE_DROP and BLUNDER_DROP)
        # eval_cp_to_expected_score(200, "white") ≈ 0.685 (es_before)
        # eval_cp_to_expected_score(50, "white")  ≈ 0.568 (es_after)
        # drop ≈ 0.117 >= 0.10 = mistake, < 0.15 = not blunder
        positions[3] = _make_pos(3, eval_cp=200)
        positions[4] = _make_pos(4, eval_cp=50)  # mistake (drop ≈ 0.117)
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply4 = [f for f in result if f["ply"] == 4]
        assert len(ply4) == 1
        assert ply4[0]["severity"] == "mistake"
        assert "lucky" not in ply4[0]["tags"], "Mistakes should not get lucky tag"

    def _make_end_of_game_blunder_positions(self) -> list[GamePosition]:
        """Positions where the user (white) blunders on the final analyzed ply.

        Index 11 is the trailing null-eval position, so ply 10 (white mover) is the
        last entry in the all-moves pass and has no opponent move at ply 11 — the
        end-of-game branch of _is_unpunished. White blunders at ply 10:
        es_before(white) ≈ 0.731, es_after(white) ≈ 0.269, drop ≈ 0.462 = blunder.
        """
        positions = self._make_standard_positions(12)
        positions[9] = _make_pos(9, eval_cp=400)  # before white's ply 10
        positions[10] = _make_pos(10, eval_cp=-400)  # white blunders (last move)
        return positions

    def test_no_lucky_on_end_of_game_blunder_when_user_lost(self) -> None:
        """A blunder on the user's last move is NOT lucky when the user lost.

        Bug fix: a blunder followed by the user resigning or flagging ends the game
        with no opponent reply, but it's a loss, not an escape. Previously every
        end-of-game blunder was tagged lucky; now a loss suppresses it.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions = self._make_end_of_game_blunder_positions()
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply10 = [f for f in result if f["ply"] == 10]
        assert len(ply10) == 1
        assert ply10[0]["severity"] == "blunder"
        assert "lucky" not in ply10[0]["tags"], (
            "A blunder on the last move of a lost game (resign/timeout) is not a lucky escape"
        )

    def test_lucky_on_end_of_game_blunder_when_user_won(self) -> None:
        """A blunder on the user's last move IS lucky when the user won.

        End-of-game blunder where the user did not lose (e.g. the blunder was
        actually mate, or the opponent resigned anyway) still counts as an escape.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="1-0")
        positions = self._make_end_of_game_blunder_positions()
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply10 = [f for f in result if f["ply"] == 10]
        assert len(ply10) == 1
        assert ply10[0]["severity"] == "blunder"
        assert "lucky" in ply10[0]["tags"], (
            "An end-of-game blunder where the user won is still a lucky escape"
        )

    def test_lucky_on_end_of_game_blunder_when_user_drew(self) -> None:
        """A blunder on the user's last move IS lucky when the game was drawn."""
        game = _make_game(pgn=self._PGN, user_color="white", result="1/2-1/2")
        positions = self._make_end_of_game_blunder_positions()
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply10 = [f for f in result if f["ply"] == 10]
        assert len(ply10) == 1
        assert "lucky" in ply10[0]["tags"], (
            "An end-of-game blunder in a drawn game is a lucky escape"
        )

    def test_opening_tag_for_phase_0(self) -> None:
        """Flaw at a position with phase=0 gets opening tag."""
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[1] = _make_pos(1, eval_cp=300, phase=0)  # opening phase
        positions[2] = _make_pos(2, eval_cp=-500, phase=0)  # blunder in opening
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2 = [f for f in result if f["ply"] == 2]
        assert len(ply2) == 1
        assert "opening" in ply2[0]["tags"]
        assert "middlegame" not in ply2[0]["tags"]
        assert "endgame" not in ply2[0]["tags"]

    def test_middlegame_tag_for_phase_1(self) -> None:
        """Flaw at a position with phase=1 gets middlegame tag."""
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[1] = _make_pos(1, eval_cp=300, phase=1)
        positions[2] = _make_pos(2, eval_cp=-500, phase=1)
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2 = [f for f in result if f["ply"] == 2]
        assert len(ply2) == 1
        assert "middlegame" in ply2[0]["tags"]

    def test_endgame_tag_for_phase_2(self) -> None:
        """Flaw at a position with phase=2 gets endgame tag."""
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[1] = _make_pos(1, eval_cp=300, phase=2)
        positions[2] = _make_pos(2, eval_cp=-500, phase=2)
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2 = [f for f in result if f["ply"] == 2]
        assert len(ply2) == 1
        assert "endgame" in ply2[0]["tags"]


class TestImpactLadder:
    """Boundary tests for _classify_impact and its integration via _build_tags.

    Verifies the outcome-independent two-rung ladder (reversed / squandered) with
    >= entry / <= exit boundaries (inclusive on both ends, per flaw-tag-definitions.md
    §Impact §"Boundary convention").

    All cases also confirm outcome-independence: the same ES swing must produce the
    same impact tag regardless of the game's user_result.
    """

    # PGN long enough to support classify_game_flaws calls
    _PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"

    def _make_standard_positions(self, n: int = 12) -> list[GamePosition]:
        """Build n positions with moderate eval (no errors)."""
        positions = [_make_pos(i, eval_cp=20) for i in range(n)]
        positions[-1] = _make_pos(n - 1)  # final null
        return positions

    # ------------------------------------------------------------------
    # _classify_impact unit tests (pure helper boundary tests)
    # ------------------------------------------------------------------

    def test_reversed_at_exact_entry_exit_boundary(self) -> None:
        """es_before=0.6762 and es_after=0.3238 (exact boundary) must return 'reversed'."""
        assert _classify_impact(0.6762, 0.3238) == "reversed"

    def test_reversed_entry_below_boundary_returns_none(self) -> None:
        """es_before=0.67 (just below WINNING_LINE_ES) must not return 'reversed'."""
        assert _classify_impact(0.67, 0.30) is None

    def test_reversed_exit_above_boundary_returns_none(self) -> None:
        """es_after=0.33 (just above LOSING_LINE_ES) must not return 'reversed'."""
        assert _classify_impact(0.70, 0.33) is None

    def test_squandered_at_exact_boundary(self) -> None:
        """es_before=0.7511 and es_after=0.5910 (exact boundary) must return 'squandered'."""
        assert _classify_impact(0.7511, 0.5910) == "squandered"

    def test_squandered_exit_above_boundary_returns_none(self) -> None:
        """es_after=0.60 (just above SQUANDERED_EXIT_ES) must not return 'squandered'."""
        assert _classify_impact(0.85, 0.60) is None

    def test_most_severe_wins_reversed_beats_squandered(self) -> None:
        """An overwhelming swing (0.90 -> 0.25) qualifies for both rungs;
        most-severe-wins means only 'reversed' is returned.
        """
        # es_before=0.90 >= FROM_WINNING_ES (0.7511) => qualifies for squandered entry
        # es_after=0.25 <= LOSING_LINE_ES (0.3238)   => qualifies for reversed exit
        # Both conditions met; reversed is the more severe and wins.
        assert _classify_impact(0.90, 0.25) == "reversed"

    def test_deliberate_no_impact_gap_70_to_45(self) -> None:
        """es_before=0.70 -> es_after=0.45 carries no impact tag (deliberate gap).

        reversed needs entry >= WINNING_LINE_ES (0.6762) AND exit <= LOSING_LINE_ES (0.3238):
        entry 0.70 qualifies, but exit 0.45 > 0.3238, so reversed does not fire.
        squandered needs entry >= FROM_WINNING_ES (0.7511): 0.70 < 0.7511, so squandered does not fire.
        A clear-but-not-near-decisive swing is captured by blunder severity, not impact.
        """
        assert _classify_impact(0.70, 0.45) is None

    def test_outcome_independence_reversed(self) -> None:
        """The same ES swing must produce 'reversed' for any user_result value.

        _classify_impact does not take user_result; this test drives through
        classify_game_flaws with the same position but different game results to
        confirm the impact tag is identical.
        """
        # Build positions with es_before >= 0.70 and es_after <= 0.30 for white at ply 2.
        # eval_cp_to_expected_score(300, "white") ≈ 0.733 >= WINNING_LINE_ES
        # eval_cp_to_expected_score(-500, "white") ≈ 0.160 <= LOSING_LINE_ES
        for result_str in ("1-0", "0-1", "1/2-1/2"):
            game = _make_game(pgn=self._PGN, user_color="white", result=result_str)
            positions = self._make_standard_positions(12)
            positions[1] = _make_pos(1, eval_cp=300)  # es_before ≈ 0.733
            positions[2] = _make_pos(2, eval_cp=-500)  # es_after ≈ 0.160
            flaws = classify_game_flaws(game, positions)
            assert isinstance(flaws, list)
            ply2 = [f for f in flaws if f["ply"] == 2]
            assert len(ply2) == 1, f"Expected blunder at ply 2 for result={result_str}"
            assert "reversed" in ply2[0]["tags"], (
                f"'reversed' must appear for result={result_str} (outcome-independent)"
            )

    # ------------------------------------------------------------------
    # Integration tests via classify_game_flaws (at-most-one + tag presence)
    # ------------------------------------------------------------------

    def test_reversed_in_tags_when_full_reversal(self) -> None:
        """A full-reversal blunder (winning -> losing) produces 'reversed' in tags."""
        # eval_cp_to_expected_score(300, "white") ≈ 0.733 >= 0.6762 (WINNING_LINE_ES)
        # eval_cp_to_expected_score(-500, "white") ≈ 0.160 <= 0.3238 (LOSING_LINE_ES)
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[1] = _make_pos(1, eval_cp=300)  # es_before ≈ 0.733
        positions[2] = _make_pos(2, eval_cp=-500)  # es_after ≈ 0.160
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2 = [f for f in result if f["ply"] == 2]
        assert len(ply2) == 1
        assert "reversed" in ply2[0]["tags"]
        assert "squandered" not in ply2[0]["tags"], "most-severe-wins: squandered suppressed"

    def test_squandered_in_tags_when_overwhelming_advantage_erased(self) -> None:
        """An overwhelming-to-roughly-even blunder produces 'squandered' in tags.

        es_before >= 0.7511 (FROM_WINNING_ES) and es_after <= 0.5910 (SQUANDERED_EXIT_ES)
        but es_after > 0.3238 (above LOSING_LINE_ES) so reversed does NOT fire.
        eval_cp_to_expected_score(600, "white") ≈ 0.859 >= 0.7511
        eval_cp_to_expected_score(50, "white")  ≈ 0.568 <= 0.5910 but > 0.3238
        """
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[1] = _make_pos(1, eval_cp=600)  # es_before ≈ 0.859
        positions[2] = _make_pos(2, eval_cp=50)  # es_after ≈ 0.568
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2 = [f for f in result if f["ply"] == 2]
        assert len(ply2) == 1
        assert "squandered" in ply2[0]["tags"]
        assert "reversed" not in ply2[0]["tags"]

    def test_no_impact_tag_for_moderate_blunder(self) -> None:
        """A moderate blunder (below impact thresholds) carries no impact tag."""
        # eval_cp_to_expected_score(100, "white") ≈ 0.591 < WINNING_LINE_ES (0.6762)
        # drop is a blunder but does not cross the reversed/squandered entry threshold
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        positions[1] = _make_pos(1, eval_cp=100)  # es_before ≈ 0.591
        positions[2] = _make_pos(2, eval_cp=-500)  # es_after ≈ 0.160
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        ply2 = [f for f in result if f["ply"] == 2]
        assert len(ply2) == 1
        assert "reversed" not in ply2[0]["tags"]
        assert "squandered" not in ply2[0]["tags"]

    def test_at_most_one_impact_tag(self) -> None:
        """At most one of 'reversed'/'squandered' appears in any flaw's tags."""
        game = _make_game(pgn=self._PGN, user_color="white")
        positions = self._make_standard_positions(12)
        # Use a full-reversal swing (would qualify for both if not most-severe-wins)
        positions[1] = _make_pos(1, eval_cp=900)  # es_before well above 0.85
        positions[2] = _make_pos(2, eval_cp=-500)  # es_after ≈ 0.160
        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        for flaw in result:
            impact_tags = [t for t in flaw["tags"] if t in ("reversed", "squandered")]
            assert len(impact_tags) <= 1, (
                f"Flaw at ply {flaw['ply']} must have at most one impact tag, got: {impact_tags}"
            )


class TestOracleCloseness:
    """Oracle-closeness sanity test: derived B/M/I counts vs. Lichess game-level columns.

    Derived counts are CLOSE (within SANITY_TOLERANCE), NOT identical to Lichess's
    oracle columns. Divergence sources:
    1. Mate handling: we use Option B (±1000 cp), Lichess uses MateAdvice ladder.
       Mate-adjacent moves may be classified differently.
    2. Floating point edge cases at exact threshold values (minor).
    3. Book-move eval omissions (some plies have null eval; we skip them, Lichess may count).

    This test uses a synthetic position list where all drops are well away from boundaries,
    so mate handling doesn't matter and counts should match exactly (tolerance of 2 is generous).
    """

    def _make_oracle_positions_and_counts(
        self,
    ) -> tuple[list[GamePosition], int, int, int, int, int, int]:
        """Build a synthetic 16-ply game with deliberate errors, return positions + oracle counts.

        Returns:
            (positions, white_blunders, white_mistakes, white_inaccuracies,
             black_blunders, black_mistakes, black_inaccuracies)

        Game structure (plies 0-15, final ply 15 has null eval):
        Ply 2 (white): blunder  — drop > BLUNDER_DROP
        Ply 4 (white): mistake  — MISTAKE_DROP <= drop < BLUNDER_DROP
        Ply 6 (white): inaccuracy — INACCURACY_DROP <= drop < MISTAKE_DROP
        Ply 9 (black): blunder  — drop > BLUNDER_DROP
        Ply 11 (black): mistake  — MISTAKE_DROP <= drop < BLUNDER_DROP
        Ply 13 (black): inaccuracy — INACCURACY_DROP <= drop < MISTAKE_DROP
        """
        positions = [_make_pos(i, eval_cp=0) for i in range(16)]
        positions[15] = _make_pos(15)  # final null

        # White blunder at ply 2:
        # eval_cp_to_expected_score(400, "white") ≈ 0.731 (es_before)
        # eval_cp_to_expected_score(-400, "white") ≈ 0.269 (es_after)
        # drop ≈ 0.462 >= 0.15 = blunder
        positions[1] = _make_pos(1, eval_cp=400)
        positions[2] = _make_pos(2, eval_cp=-400)

        # White mistake at ply 4:
        # eval_cp_to_expected_score(150, "white") ≈ 0.634 (es_before)
        # eval_cp_to_expected_score(0, "white") = 0.5 (es_after)
        # drop ≈ 0.134 >= 0.10, < 0.15 = mistake
        positions[3] = _make_pos(3, eval_cp=150)
        positions[4] = _make_pos(4, eval_cp=0)

        # White inaccuracy at ply 6:
        # eval_cp_to_expected_score(80, "white") ≈ 0.576 (es_before)
        # eval_cp_to_expected_score(0, "white") = 0.5 (es_after)
        # drop ≈ 0.076 >= 0.05, < 0.10 = inaccuracy
        positions[5] = _make_pos(5, eval_cp=80)
        positions[6] = _make_pos(6, eval_cp=0)

        # Black blunder at ply 9:
        # black mover: eval_cp=-300 at [8] means es_before for black ≈ 1-0.333=0.667
        # eval_cp=+300 at [9] means es_after for black ≈ 1-0.667=0.333
        # drop ≈ 0.334 >= 0.15 = blunder
        positions[8] = _make_pos(8, eval_cp=-300)
        positions[9] = _make_pos(9, eval_cp=300)

        # Black mistake at ply 11:
        # eval_cp=-100 at [10] means es_before for black ≈ 1-0.409=0.591
        # eval_cp=+100 at [11] means es_after for black ≈ 1-0.591=0.409
        # drop ≈ 0.182 >= 0.10, hmm that's too large (blunder). Let's recalculate.
        # We need a drop of MISTAKE_DROP <= drop < BLUNDER_DROP (0.10 <= d < 0.15).
        # eval_cp_to_expected_score(x, "black") = 1 - eval_cp_to_expected_score(x, "white")
        # For a black mistake: we need es_before(black) - es_after(black) ∈ [0.10, 0.15).
        # es_before(black) = 1 - es_before(white) = 1 - eval_cp_to_expected_score(eval_before, "white")
        # es_after(black)  = 1 - es_after(white)  = 1 - eval_cp_to_expected_score(eval_after, "white")
        # drop(black) = es_before(black) - es_after(black)
        #             = (1 - es_before(white)) - (1 - es_after(white))
        #             = es_after(white) - es_before(white)    [a gain for white = loss for black]
        # We want es_after(white) - es_before(white) ∈ [0.10, 0.15).
        # eval_cp_to_expected_score(-50, "white") ≈ 0.486
        # eval_cp_to_expected_score(100, "white") ≈ 0.591
        # drop(black) = 0.591 - 0.486 = 0.105 ∈ [0.10, 0.15) = mistake for black
        positions[10] = _make_pos(10, eval_cp=-50)
        positions[11] = _make_pos(11, eval_cp=100)

        # Black inaccuracy at ply 13:
        # We need drop(black) ∈ [0.05, 0.10).
        # eval_cp_to_expected_score(-20, "white") ≈ 0.494
        # eval_cp_to_expected_score(50, "white")  ≈ 0.568
        # drop(black) = 0.568 - 0.494 = 0.074 ∈ [0.05, 0.10) = inaccuracy for black
        positions[12] = _make_pos(12, eval_cp=-20)
        positions[13] = _make_pos(13, eval_cp=50)

        # Oracle counts (what Lichess would report for this synthetic game)
        white_blunders = 1
        white_mistakes = 1
        white_inaccuracies = 1
        black_blunders = 1
        black_mistakes = 1
        black_inaccuracies = 1

        return (
            positions,
            white_blunders,
            white_mistakes,
            white_inaccuracies,
            black_blunders,
            black_mistakes,
            black_inaccuracies,
        )

    def test_derived_counts_close_to_oracle_white(self) -> None:
        """Derived white B/M/I counts are within SANITY_TOLERANCE of oracle."""
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 *"
        positions, wb, wm, wi, bb, bm, bi = self._make_oracle_positions_and_counts()

        # White user
        game = _make_game(
            pgn=pgn,
            user_color="white",
            result="1/2-1/2",
            base_time_seconds=600,
        )
        game.white_blunders = wb
        game.white_mistakes = wm
        game.white_inaccuracies = wi

        flaws = classify_game_flaws(game, positions)
        assert isinstance(flaws, list)

        # Phase 113: kernel emits both movers. Filter to white side only for oracle comparison.
        # (Oracle counts are per-color; derive_blunders must match the white-only subset.)
        white_flaws = [f for f in flaws if f["side"] == "white"]
        derived_blunders = sum(1 for f in white_flaws if f["severity"] == "blunder")
        derived_mistakes = sum(1 for f in white_flaws if f["severity"] == "mistake")

        # For inaccuracy count: re-run all-moves pass and count inaccuracy severity entries for white
        # (inaccuracies are count-only per the 2026-06-05 amendment — not emitted but classifiable)
        from app.services.flaws_service import _run_all_moves_pass

        all_moves = _run_all_moves_pass(positions)
        derived_inaccuracies = sum(
            1
            for n, (mover, sev, _, _) in all_moves.items()
            if mover == "white" and sev == "inaccuracy"
        )

        assert abs(derived_blunders - wb) <= SANITY_TOLERANCE, (
            f"White blunders: derived={derived_blunders} oracle={wb} diff={abs(derived_blunders - wb)}"
        )
        assert abs(derived_mistakes - wm) <= SANITY_TOLERANCE, (
            f"White mistakes: derived={derived_mistakes} oracle={wm} diff={abs(derived_mistakes - wm)}"
        )
        assert abs(derived_inaccuracies - wi) <= SANITY_TOLERANCE, (
            f"White inaccuracies: derived={derived_inaccuracies} oracle={wi} diff={abs(derived_inaccuracies - wi)}"
        )

    def test_derived_counts_close_to_oracle_black(self) -> None:
        """Derived black B/M/I counts are within SANITY_TOLERANCE of oracle."""
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 *"
        positions, wb, wm, wi, bb, bm, bi = self._make_oracle_positions_and_counts()

        # Black user — to test the black-side derived counts
        game = _make_game(
            pgn=pgn,
            user_color="black",
            result="1/2-1/2",
            base_time_seconds=600,
        )
        game.black_blunders = bb
        game.black_mistakes = bm
        game.black_inaccuracies = bi

        flaws = classify_game_flaws(game, positions)
        assert isinstance(flaws, list)

        # Phase 113: kernel emits both movers. Filter to black side only for oracle comparison.
        black_flaws = [f for f in flaws if f["side"] == "black"]
        derived_blunders = sum(1 for f in black_flaws if f["severity"] == "blunder")
        derived_mistakes = sum(1 for f in black_flaws if f["severity"] == "mistake")

        from app.services.flaws_service import _run_all_moves_pass as _ramp_black

        all_moves = _ramp_black(positions)
        derived_inaccuracies = sum(
            1
            for n, (mover, sev, _, _) in all_moves.items()
            if mover == "black" and sev == "inaccuracy"
        )

        assert abs(derived_blunders - bb) <= SANITY_TOLERANCE, (
            f"Black blunders: derived={derived_blunders} oracle={bb} diff={abs(derived_blunders - bb)}"
        )
        assert abs(derived_mistakes - bm) <= SANITY_TOLERANCE, (
            f"Black mistakes: derived={derived_mistakes} oracle={bm} diff={abs(derived_mistakes - bm)}"
        )
        assert abs(derived_inaccuracies - bi) <= SANITY_TOLERANCE, (
            f"Black inaccuracies: derived={derived_inaccuracies} oracle={bi} diff={abs(derived_inaccuracies - bi)}"
        )


# ---------------------------------------------------------------------------
# Phase 113 tests: is_opponent_expr, both-mover kernel, per-mover lucky tag
# ---------------------------------------------------------------------------

# PLY_EVEN / PLY_ODD: named constants so tests do not scatter bare magic numbers.
# Convention (mirrors _run_all_moves_pass): even ply → white mover; odd ply → black mover.
_PLY_EVEN = 2  # white mover (first even ply after the initial position)
_PLY_ODD = 3  # black mover


class TestIsOpponentExpr:
    """Mandatory parity gate: is_opponent_expr must return the correct boolean for
    all 4 (ply parity × user_color) combinations evaluated against the real DB.

    Code-reading alone is insufficient — a prior off-by-one bug lived here
    (CONTEXT D-01; RESEARCH Pitfall 1). Only a live SQL evaluation closes the trap.

    Convention:
        even ply → white mover → is_opponent when user_color == 'black'
        odd ply  → black mover → is_opponent when user_color == 'white'
    """

    async def _eval_is_opponent(
        self,
        session: AsyncSession,
        ply: int,
        user_color: str,
    ) -> bool:
        """Evaluate is_opponent_expr(literal(ply), literal(user_color)) via a real DB query."""
        from app.repositories.query_utils import is_opponent_expr

        expr = is_opponent_expr(literal(ply), literal(user_color))
        result = await session.execute(select(expr))
        value = result.scalar_one()
        # SQLAlchemy may return a Python bool or a DB-backend truthy value.
        return bool(value)

    @pytest.mark.asyncio
    async def test_white_user_even_ply_is_player(self, db_session: AsyncSession) -> None:
        """White user at even ply (white moves): is_opponent == False (player)."""
        assert await self._eval_is_opponent(db_session, _PLY_EVEN, "white") is False

    @pytest.mark.asyncio
    async def test_white_user_odd_ply_is_opponent(self, db_session: AsyncSession) -> None:
        """White user at odd ply (black moves): is_opponent == True (opponent)."""
        assert await self._eval_is_opponent(db_session, _PLY_ODD, "white") is True

    @pytest.mark.asyncio
    async def test_black_user_even_ply_is_opponent(self, db_session: AsyncSession) -> None:
        """Black user at even ply (white moves): is_opponent == True (opponent)."""
        assert await self._eval_is_opponent(db_session, _PLY_EVEN, "black") is True

    @pytest.mark.asyncio
    async def test_black_user_odd_ply_is_player(self, db_session: AsyncSession) -> None:
        """Black user at odd ply (black moves): is_opponent == False (player)."""
        assert await self._eval_is_opponent(db_session, _PLY_ODD, "black") is False


class TestClassifyBothColors:
    """classify_game_flaws emits FlawRecords for BOTH movers (Phase 113 FLAWX-02).

    After dropping the mover != user_color filter, the kernel must return at
    least one FlawRecord for each color when both colors make mistakes/blunders.
    """

    # PGN long enough for 8 plies (positions[0..7]); plies 2/4 even = white,
    # plies 3/5 odd = black.
    _PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *"

    def _build_both_color_positions(self) -> list[GamePosition]:
        """Positions with a white blunder at ply 2 and a black blunder at ply 3."""
        # 8 positions (plies 0-7), all with baseline eval_cp=20
        positions = [_make_pos(i, eval_cp=20) for i in range(8)]

        # White blunder at ply 2 (even → white mover):
        # ES drop for white: eval_cp drops from +200 to -500 → drop ≈ 0.525
        positions[1] = _make_pos(1, eval_cp=200)  # before ply 2 (white's view)
        positions[2] = _make_pos(2, eval_cp=-500)  # after white's blunder

        # Black blunder at ply 3 (odd → black mover):
        # After ply 2: white is −500 cp (black advantage), so es_before for black
        # is high. At ply 3, eval swings to +300 (black's ES drops sharply).
        # eval_cp=-500 at positions[2] → es_before for black = 1 - es_white ≈ 1 - 0.16 = 0.84
        # eval_cp=300 at positions[3] → es_after for black = 1 - es_white ≈ 1 - 0.73 = 0.27
        # drop ≈ 0.84 - 0.27 = 0.57 ≥ BLUNDER_DROP
        positions[3] = _make_pos(3, eval_cp=300)  # after black's blunder

        # Final ply: no eval (coverage gate: 7/8 = 0.875 < 0.90, so add more covered)
        # Make coverage 7/8 = 0.875... need 90%: for 8 positions need at least 7.2,
        # so this is marginal. Use 10 positions to be safe.
        return positions

    def _build_positions_10(self) -> list[GamePosition]:
        """10 positions (plies 0-9) with white blunder at ply 2 and black blunder at ply 3.

        Coverage = 9/10 = 0.90 >= EVAL_COVERAGE_MIN.
        Final ply 9 has no eval.
        """
        positions = [_make_pos(i, eval_cp=20) for i in range(10)]

        # White blunder at ply 2 (even → white mover)
        positions[1] = _make_pos(1, eval_cp=200)
        positions[2] = _make_pos(2, eval_cp=-500)

        # Black blunder at ply 3 (odd → black mover)
        # es_before for black at ply 3 = 1 - eval_cp_to_es(-500, "white") ≈ 1 - 0.16 = 0.84
        # es_after for black at ply 3 = 1 - eval_cp_to_es(300, "white") ≈ 1 - 0.73 = 0.27
        # drop ≈ 0.57 >= BLUNDER_DROP
        positions[3] = _make_pos(3, eval_cp=300)

        # Final ply has no eval
        positions[9] = _make_pos(9)

        return positions

    # Long PGN for 10 positions
    _PGN_10 = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"

    def test_emits_flaws_for_both_movers(self) -> None:
        """classify_game_flaws returns at least one FlawRecord for each color."""
        game = _make_game(pgn=self._PGN_10, user_color="white", result="1-0")
        positions = self._build_positions_10()

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list), "Expected list[FlawRecord], got GameNotAnalyzed"

        sides = {flaw["side"] for flaw in result}
        assert "white" in sides, (
            "Expected at least one FlawRecord with side='white' (player's blunder at ply 2)"
        )
        assert "black" in sides, (
            "Expected at least one FlawRecord with side='black' (opponent's blunder at ply 3)"
        )

    def test_white_user_opponent_flaw_has_black_side(self) -> None:
        """For a white user, the opponent flaw has side='black'."""
        game = _make_game(pgn=self._PGN_10, user_color="white", result="1-0")
        positions = self._build_positions_10()

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        black_flaws = [f for f in result if f["side"] == "black"]
        assert len(black_flaws) >= 1, "Expected at least one opponent (black) FlawRecord"
        assert all(f["severity"] in ("mistake", "blunder") for f in black_flaws)

    def test_black_user_opponent_flaw_has_white_side(self) -> None:
        """For a black user, the opponent flaw has side='white'."""
        # Same positions but user_color='black': player is black (odd plies),
        # opponent is white (even plies). White blunders at ply 2 (opponent).
        game = _make_game(pgn=self._PGN_10, user_color="black", result="0-1")
        positions = self._build_positions_10()

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        white_flaws = [f for f in result if f["side"] == "white"]
        assert len(white_flaws) >= 1, (
            "Expected at least one opponent (white) FlawRecord when user_color='black'"
        )


class TestOpponentLuckyTag:
    """Per-mover subject_result drives the lucky end-of-game rule correctly.

    After Phase 113, classify_game_flaws passes derive_user_result(game.result, mover)
    to _build_tags instead of the pre-resolved user_result. This means:
    - An opponent end-of-game blunder where the OPPONENT LOST must NOT carry 'lucky'
      (subject_result for the opponent is 'loss'; lucky requires subject_result != 'loss').
    - A genuinely unpunished blunder (opponent erred in reply) still gets 'lucky'.

    RESEARCH Pitfall 2: The prior code passed user_result='win' (player won) to _build_tags
    for all flaws, incorrectly tagging opponent end-of-game blunders as 'lucky'.
    """

    # PGN for 8 positions (plies 0-7), enough for the end-of-game blunder test
    _PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *"

    def _build_end_of_game_positions(self, n_plies: int = 10) -> list[GamePosition]:
        """Build positions for a game ending after an opponent blunder at the last ply."""
        positions = [_make_pos(i, eval_cp=20) for i in range(n_plies)]
        # Final ply has no eval (end of game)
        positions[n_plies - 1] = _make_pos(n_plies - 1)
        return positions

    def test_opponent_end_of_game_blunder_no_lucky_tag_when_opponent_lost(self) -> None:
        """Opponent blunders on the last move and then loses: no 'lucky' tag.

        The opponent's subject_result is 'loss' (they resigned/flagged).
        _is_unpunished end-of-game rule: return subject_result != 'loss'.
        With subject_result='loss', this returns False → no lucky tag.
        """
        # White user, game result=1-0 (white won). Black is opponent.
        # Build a game where black blunders at the last move (odd ply, before game ends).
        # Use a position where all moves have eval except the last.
        # For the opponent (black) blundering at ply 3 (odd) to be "end of game"
        # we need ply 4 to have no next entry in all_moves (it's the final position).

        # 5 positions (plies 0-4): ply 4 has no eval → it's the final position
        # Coverage: 4/5 = 0.80 < EVAL_COVERAGE_MIN... need more
        # Use 10 positions: ply 9 has no eval; black blunders at ply 9 is the "end"
        # Actually: "end of game" means there's no next move (n+1 not in all_moves).
        # So the blunder at ply N is "end of game" if N = last evaluated ply and
        # positions[N+1] has no eval.
        # Let's build: 11 positions (plies 0-10), final ply 10 has no eval.
        # Black blunders at ply 9 (odd → black mover). Ply 10 is the game end (no eval).
        # all_moves won't have an entry at ply 10 (no es_before/after available).
        # So _is_unpunished for ply 9: entry = all_moves.get(10) → None → end-of-game rule.
        n_plies = 11
        positions = [_make_pos(i, eval_cp=20) for i in range(n_plies)]

        # Black blunder at ply 9 (odd → black mover):
        # es_before for black = 1 - es_white(eval_cp=-300) ≈ 1 - 0.333 = 0.667
        # es_after for black = 1 - es_white(eval_cp=400) ≈ 1 - 0.731 = 0.269
        # drop ≈ 0.398 >= BLUNDER_DROP
        positions[8] = _make_pos(8, eval_cp=-300)  # before ply 9 (black's view)
        positions[9] = _make_pos(9, eval_cp=400)  # after black's blunder

        # Ply 10: no eval (end of game, opponent resigned/lost)
        positions[10] = _make_pos(10)

        # Game result: white won (1-0). Opponent (black) lost.
        # For black (the mover at ply 9): subject_result = derive_user_result("1-0", "black") = "loss"
        # _is_unpunished end-of-game: subject_result != "loss" → False → no lucky tag
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"  # placeholder PGN
        game = _make_game(pgn=pgn, user_color="white", result="1-0")

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        # Find the opponent (black) flaw at ply 9
        black_flaw_at_9 = next((f for f in result if f["side"] == "black" and f["ply"] == 9), None)
        assert black_flaw_at_9 is not None, (
            "Expected a black FlawRecord at ply 9 (opponent blunder). "
            f"Got flaws: {[(f['side'], f['ply'], f['severity']) for f in result]}"
        )
        assert "lucky" not in black_flaw_at_9["tags"], (
            f"Opponent end-of-game blunder where opponent lost must NOT carry 'lucky'. "
            f"Tags: {black_flaw_at_9['tags']}"
        )

    def test_player_end_of_game_blunder_lucky_when_player_did_not_lose(self) -> None:
        """Player blunders on the last move but does not lose: 'lucky' tag fires.

        Per-mover subject_result: player's result != 'loss' → lucky.
        """
        # White user, result='1/2-1/2' (draw). White blunders at ply 8 (even → white mover).
        # Ply 9 has no eval (end of game). all_moves has no entry at ply 9.
        # _is_unpunished for ply 8: entry = all_moves.get(9) → None.
        # subject_result = derive_user_result("1/2-1/2", "white") = "draw" != "loss" → True → lucky
        n_plies = 10
        positions = [_make_pos(i, eval_cp=20) for i in range(n_plies)]

        # White blunder at ply 8 (even → white mover)
        positions[7] = _make_pos(7, eval_cp=200)
        positions[8] = _make_pos(8, eval_cp=-500)

        # Ply 9: no eval (end of game)
        positions[9] = _make_pos(9)

        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white", result="1/2-1/2")

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        white_flaw_at_8 = next((f for f in result if f["side"] == "white" and f["ply"] == 8), None)
        assert white_flaw_at_8 is not None, (
            "Expected a white FlawRecord at ply 8. "
            f"Got flaws: {[(f['side'], f['ply'], f['severity']) for f in result]}"
        )
        assert "lucky" in white_flaw_at_8["tags"], (
            f"Player end-of-game blunder where player did not lose should carry 'lucky'. "
            f"Tags: {white_flaw_at_8['tags']}"
        )


class TestSeed044PostMoveConvention:
    """SEED-044 regression: engine-game flaws are detected only under the POST-MOVE
    eval convention. Before the fix the engine drain stored eval_cp for the PRE-PUSH
    position (eval BEFORE the move), so this classifier — which assumes eval AFTER the
    move — was off-by-one for every chess.com game and missed (or misattributed) real
    blunders. These fixtures encode the documented prod game 1420780 swing and assert
    the convention outcome (correct sequence detects the blunder; the pre-push-shifted
    sequence does not put a blunder at the true decision ply).
    """

    # Prod fixture 1420780 (chess.com engine, user 99), seed proof table:
    #   1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.b3 Bc5 5.Bb2 d6 6.Ng5 O-O 7.O-O Ng4 8.h3?? Bxf2+
    # h3 is white's 8th move = ply 14 (0-indexed; white plays even plies). After h3,
    # ...Bxf2+ wins material/initiative for black. AS-IS (pre-push read as post-move):
    # 0 flaws. SHIFTED +1 (true post-move): the h3 blunder surfaces.
    _FIXTURE_PGN_1420780 = (
        "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. b3 Bc5 5. Bb2 d6 "
        "6. Ng5 O-O 7. O-O Ng4 8. h3 Bxf2+ 9. Rxf2 *"
    )
    _BLUNDER_PLY_1420780 = 14  # h3, white's 8th move (even ply -> white mover)

    def _post_move_eval_by_ply(self) -> list[int]:
        """The eval AFTER each move (post-move convention) for the 1420780 fixture.

        Roughly level through the opening, then a decisive swing against white the
        instant h3 (ply 14) is played: positions[13] (after ...Ng4) ~ level; positions[14]
        (after h3) ~ black winning. The exact prod centipawns are not reconstructable
        from the seed, so we encode the documented swing magnitude that reproduces it.
        """
        evals = [25, 20, 30, 18, 28, 15, 22, 12, 26, 10, 24, 8, 20, 15]  # plies 0..13 (level)
        evals += [-650, -640, -600]  # ply 14 (after h3??), 15 (after Bxf2+), 16 (after Rxf2)
        return evals

    def test_post_move_sequence_detects_engine_blunder(self) -> None:
        """Under the correct POST-MOVE storage, the h3 blunder at ply 14 is detected."""
        game = _make_game(pgn=self._FIXTURE_PGN_1420780, user_color="white")
        evals = self._post_move_eval_by_ply()
        positions = [_make_pos(i, eval_cp=cp) for i, cp in enumerate(evals)]
        positions.append(_make_pos(len(evals)))  # final ply: no eval

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list), f"Expected analyzed list, got {result!r}"

        blunder_at_14 = next((f for f in result if f["ply"] == self._BLUNDER_PLY_1420780), None)
        assert blunder_at_14 is not None, (
            "Post-move convention must detect the h3 blunder at ply 14 (SEED-044). "
            f"Got flaws: {[(f['side'], f['ply'], f['severity']) for f in result]}"
        )
        assert blunder_at_14["side"] == "white"
        assert blunder_at_14["severity"] in ("mistake", "blunder")
        assert blunder_at_14["es_before"] > blunder_at_14["es_after"]

    def test_pre_push_sequence_misses_blunder_at_decision_ply(self) -> None:
        """The OLD pre-push storage (eval BEFORE the move) read by this post-move
        classifier puts no flaw at the true decision ply 14 — the off-by-one bug.

        Pre-push storage shifts every eval one row LATER relative to post-move
        (row k holds the eval of the position BEFORE move k). Simulate by shifting
        the post-move sequence right by one ply, then assert ply 14 is NOT flagged
        (the swing now lands at the adjacent ply, mis-attributing the blunder).
        """
        game = _make_game(pgn=self._FIXTURE_PGN_1420780, user_color="white")
        post_move = self._post_move_eval_by_ply()
        # Pre-push = eval of the position BEFORE move k = post-move eval of k-1.
        pre_push = [post_move[0]] + post_move[:-1]
        positions = [_make_pos(i, eval_cp=cp) for i, cp in enumerate(pre_push)]
        positions.append(_make_pos(len(pre_push)))

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        blunder_at_14 = next((f for f in result if f["ply"] == self._BLUNDER_PLY_1420780), None)
        assert blunder_at_14 is None, (
            "Pre-push storage (the SEED-044 bug) must NOT place a flaw at the true "
            "decision ply 14 — that off-by-one is exactly what shipped wrong engine-"
            f"game flaw stats. Got flaws: {[(f['side'], f['ply']) for f in result]}"
        )

    def test_lichess_coherent_sequence_unchanged(self) -> None:
        """Guard against over-correction: a coherent post-move sequence (as lichess
        %eval always supplied) classifies normally and is never shifted. Represents
        fixture 640092 (lichess), which must keep its coherent flaw set — the fix
        touches only how the ENGINE drain WRITES, never how post-move evals are read.
        """
        # One clear white blunder at ply 4; everything else level. 9 eval'd plies +
        # 1 trailing null = 10 positions → 0.90 coverage (meets EVAL_COVERAGE_MIN).
        pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6 5. O-O *"
        game = _make_game(pgn=pgn, user_color="white")
        evals = [20, 25, 18, 22, -520, -500, 15, 10, 12]  # ply 4 (white) is the blunder
        positions = [_make_pos(i, eval_cp=cp) for i, cp in enumerate(evals)]
        positions.append(_make_pos(len(evals)))

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)
        white_blunders = [f for f in result if f["side"] == "white" and f["severity"] == "blunder"]
        assert any(f["ply"] == 4 for f in white_blunders), (
            "A coherent post-move (lichess-style) sequence must classify normally; "
            f"expected a white blunder at ply 4. Got: {[(f['side'], f['ply'], f['severity']) for f in result]}"
        )


# ---------------------------------------------------------------------------
# Phase 124 tests: tactic detection integration (TACDET-04)
# ---------------------------------------------------------------------------


def _make_pos_with_pv(
    ply: int,
    eval_cp: int | None = None,
    eval_mate: int | None = None,
    move_san: str | None = None,
    pv: str | None = None,
    clock_seconds: float | None = None,
    phase: int = 1,
) -> GamePosition:
    """Build a GamePosition with pv and move_san set for tactic integration tests.

    Extends the base _make_pos helper with the pv field (stored at flaw_ply+1
    for full-eval positions). All other columns that the service reads are
    populated with safe defaults.
    """
    pos = _make_pos(
        ply=ply,
        eval_cp=eval_cp,
        eval_mate=eval_mate,
        clock_seconds=clock_seconds,
        phase=phase,
        move_san=move_san,
    )
    pos.pv = pv
    return pos


class TestTacticIntegration:
    """Phase 124 (TACDET-04): detect_tactic_motif runs inside _build_flaw_record.

    Tests verify:
    1. Both-color population: allowed_tactic_motif_int is non-None for BOTH a white flaw
       AND a black flaw in the same game (Phase 113 both-color coverage).
    2. None-PV guard: a flaw whose positions[n+1].pv is None yields a FlawRecord
       with allowed_tactic_motif_int=None and no exception raised.
    3. Malformed move_san guard: a flaw with an invalid move_san leaves tactic
       fields None without raising.

    Phase 128: renamed tactic_* → allowed_tactic_* in FlawRecord (D-02).

    PGN: '1. e4 e5 2. Bc4 d5 3. f3 Bg4 *'  (6 half-moves)

    FEN reference (from _recompute_fen_map replay):
      ply 4: 'rnbqkbnr/ppp2ppp/8/3pp3/2B1P3/8/PPPP1PPP/RNBQK1NR'  (after 2...d5, white to move)
      ply 5: 'rnbqkbnr/ppp2ppp/8/3pp3/2B1P3/5P2/PPPP2PP/RNBQK1NR'  (after 3.f3, black to move)
      ply 6: 'rn1qkbnr/ppp2ppp/8/3pp3/2B1P1b1/5P2/PPPP2PP/RNBQK1NR' (after 3...Bg4, white to move)

    White blunder at ply 4 (even=white mover): 3. f3??  leaves Bc4 hanging for d5xc4.
    Black blunder at ply 5 (odd=black mover): 3...Bg4?? leaves Bg4 hanging for f3xg4.
    """

    _PGN = "1. e4 e5 2. Bc4 d5 3. f3 Bg4 *"

    def _build_both_color_positions(self) -> list[GamePosition]:
        """12 positions (plies 0-11) with white blunder at ply 4 and black blunder at ply 5.

        pv is set at positions[5] (for white's blunder at ply 4) and positions[6]
        (for black's blunder at ply 5). The hanging-piece detector reliably fires
        for both because each blunder leaves a non-pawn undefended piece.

        Coverage: 11/(12-1) = 11/11 = 1.0 >= EVAL_COVERAGE_MIN.
        """
        positions = [_make_pos_with_pv(i, eval_cp=20) for i in range(12)]

        # White blunder at ply 4 (even=white mover):
        # es_before(white) = es(positions[3], white) ≈ eval_cp_to_es(200, white) ≈ 0.685
        # es_after(white)  = es(positions[4], white) ≈ eval_cp_to_es(-500, white) ≈ 0.160
        # drop ≈ 0.525 >= BLUNDER_DROP -> blunder for white ✓
        positions[3] = _make_pos_with_pv(3, eval_cp=200, move_san="d5")
        positions[4] = _make_pos_with_pv(4, eval_cp=-500, move_san="f3")
        # PV at ply 5: d5xc4 -- black captures the hanging Bc4 (hanging-piece)
        positions[5] = _make_pos_with_pv(5, eval_cp=300, move_san="Bg4", pv="d5c4")

        # Black blunder at ply 5 (odd=black mover):
        # es_before(black) = 1 - es(positions[4], white) ≈ 1 - 0.160 = 0.840
        # es_after(black)  = 1 - es(positions[5], white) ≈ 1 - 0.730 = 0.270
        # drop ≈ 0.570 >= BLUNDER_DROP -> blunder for black ✓
        # PV at ply 6: f3xg4 -- white captures the hanging Bg4 (hanging-piece)
        positions[6] = _make_pos_with_pv(6, eval_cp=20, pv="f3g4")

        # Final terminal position has no eval
        positions[11] = _make_pos_with_pv(11)

        return positions

    def test_both_color_detection(self) -> None:
        """Both-color coverage: white AND black flaws both have tactic_motif_int populated.

        Proves that the Phase 113 both-color all-moves pass flows through to
        tactic detection: _build_flaw_record runs detect_tactic_motif for every
        FlawRecord regardless of color, so both sides' flaws carry a non-None motif.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions = self._build_both_color_positions()

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        white_flaws = [f for f in result if f["side"] == "white"]
        black_flaws = [f for f in result if f["side"] == "black"]

        assert len(white_flaws) >= 1, (
            f"Expected at least one white FlawRecord. Got: {[(f['side'], f['ply']) for f in result]}"
        )
        assert len(black_flaws) >= 1, (
            f"Expected at least one black FlawRecord. Got: {[(f['side'], f['ply']) for f in result]}"
        )

        # Both sides must have allowed_tactic_motif_int populated (non-None)
        # Phase 128: renamed tactic_motif_int → allowed_tactic_motif_int (D-02).
        white_with_motif = [f for f in white_flaws if f["allowed_tactic_motif_int"] is not None]
        black_with_motif = [f for f in black_flaws if f["allowed_tactic_motif_int"] is not None]

        assert len(white_with_motif) >= 1, (
            "WHITE flaw must have allowed_tactic_motif_int populated (both-color detection). "
            f"White flaws: {[(f['ply'], f['allowed_tactic_motif_int']) for f in white_flaws]}"
        )
        assert len(black_with_motif) >= 1, (
            "BLACK flaw must have allowed_tactic_motif_int populated (both-color detection). "
            f"Black flaws: {[(f['ply'], f['allowed_tactic_motif_int']) for f in black_flaws]}"
        )

    def test_none_pv_leaves_tactic_fields_none(self) -> None:
        """Flaw with pv=None in positions[n+1] yields allowed_tactic_motif_int=None, no exception.

        This represents a lichess-eval-only flaw (no full_evals_completed_at): the
        pv column is NULL for that position. The detector must leave all three tactic
        fields None without raising (T-124-07 guard).
        Phase 128: renamed tactic_* → allowed_tactic_* in FlawRecord (D-02).
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="1-0")
        positions = self._build_both_color_positions()
        # Remove the PV from positions[5] — white's blunder at ply 4 loses its refutation
        positions[5] = _make_pos_with_pv(5, eval_cp=300, move_san="Bg4", pv=None)

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        # White's flaw at ply 4 must have allowed_tactic_motif_int=None (no pv available)
        white_ply4 = next((f for f in result if f["side"] == "white" and f["ply"] == 4), None)
        assert white_ply4 is not None, (
            f"Expected a white FlawRecord at ply 4. Got: {[(f['side'], f['ply']) for f in result]}"
        )
        assert white_ply4["allowed_tactic_motif_int"] is None, (
            "pv=None must leave allowed_tactic_motif_int=None (lichess-eval-only flaw guard)"
        )
        assert white_ply4["allowed_tactic_piece"] is None
        assert white_ply4["allowed_tactic_confidence"] is None

    def test_malformed_move_san_leaves_tactic_fields_none(self) -> None:
        """Flaw with malformed move_san leaves tactic fields None without raising.

        The try/except (ValueError, chess.IllegalMoveError) guard in
        _detect_tactic_for_flaw ensures parse failures do not propagate. The
        FlawRecord is still emitted (severity/tags unaffected); only the three
        tactic fields stay None (T-124-07).

        Guard path: pv and fen_before are both set (truthy) so the early-exit
        guard does not fire; the exception happens inside board.parse_san(move_san).
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="1-0")
        positions = self._build_both_color_positions()
        # positions[5].pv = "d5c4" is already set (from _build_both_color_positions).
        # Replace positions[4].move_san with a nonsense string that parse_san rejects.
        # The guard checks positions[n+1].pv where n=4 → positions[5].pv is "d5c4" (truthy),
        # so the code enters the try block and parse_san("INVALID!!!") raises IllegalMoveError.
        positions[4] = _make_pos_with_pv(4, eval_cp=-500, move_san="INVALID!!!")

        result = classify_game_flaws(game, positions)
        assert isinstance(result, list)

        white_ply4 = next((f for f in result if f["side"] == "white" and f["ply"] == 4), None)
        assert white_ply4 is not None, (
            f"Expected a white FlawRecord at ply 4. Got: {[(f['side'], f['ply']) for f in result]}"
        )
        # All three tactic fields must be None due to malformed move_san
        # Phase 128: renamed tactic_* → allowed_tactic_* in FlawRecord (D-02).
        assert white_ply4["allowed_tactic_motif_int"] is None, (
            "Malformed move_san must leave allowed_tactic_motif_int=None (no exception raised)"
        )
        assert white_ply4["allowed_tactic_piece"] is None
        assert white_ply4["allowed_tactic_confidence"] is None

    def test_pv_by_ply_override_tags_when_positions_pv_is_none(self) -> None:
        """260618-aiq: pv_by_ply override tags flaws even when positions[n+1].pv is NULL.

        This is the in-process eval-drain scenario: at classify time the freshly
        computed PVs are NOT yet written to game_positions, so positions[n+1].pv is
        None. The drain passes the PVs via pv_by_ply instead. Without the override
        the flaws must stay NULL (control); with it the hanging-piece detector fires
        for both the white blunder (ply 4) and the black blunder (ply 5).
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions = self._build_both_color_positions()
        # Drain state: refutation PVs are NOT in game_positions yet.
        positions[5] = _make_pos_with_pv(5, eval_cp=300, move_san="Bg4", pv=None)
        positions[6] = _make_pos_with_pv(6, eval_cp=20, pv=None)

        # Control: no override + no stored pv -> tactic fields stay None.
        control = classify_game_flaws(game, positions)
        assert isinstance(control, list)
        control_white = next(f for f in control if f["side"] == "white" and f["ply"] == 4)
        control_black = next(f for f in control if f["side"] == "black" and f["ply"] == 5)
        # Phase 128: renamed tactic_* → allowed_tactic_* in FlawRecord (D-02).
        assert control_white["allowed_tactic_motif_int"] is None
        assert control_black["allowed_tactic_motif_int"] is None

        # Override: drain supplies the in-memory PVs keyed by ply (refutation at n+1).
        pv_by_ply = {5: "d5c4", 6: "f3g4"}
        tagged = classify_game_flaws(game, positions, pv_by_ply=pv_by_ply)
        assert isinstance(tagged, list)
        tagged_white = next(f for f in tagged if f["side"] == "white" and f["ply"] == 4)
        tagged_black = next(f for f in tagged if f["side"] == "black" and f["ply"] == 5)

        assert tagged_white["allowed_tactic_motif_int"] == TacticMotifInt.HANGING_PIECE, (
            "White ply-4 blunder must tag hanging-piece via pv_by_ply override, "
            f"got {tagged_white['allowed_tactic_motif_int']}"
        )
        assert tagged_white["allowed_tactic_confidence"] == TACTIC_CONFIDENCE_HIGH
        assert tagged_black["allowed_tactic_motif_int"] == TacticMotifInt.HANGING_PIECE, (
            "Black ply-5 blunder must tag hanging-piece via pv_by_ply override, "
            f"got {tagged_black['allowed_tactic_motif_int']}"
        )
        assert tagged_black["allowed_tactic_confidence"] == TACTIC_CONFIDENCE_HIGH


# ---------------------------------------------------------------------------
# Phase 128 tests: orientation-parametrized _detect_tactic_for_flaw (Plan 02)
# ---------------------------------------------------------------------------

# PGN reference (same as TestTacticIntegration):
#   '1. e4 e5 2. Bc4 d5 3. f3 Bg4 *'  (6 half-moves)
#
# FEN reference (board.board_fen() piece-placement only):
#   fen_map[4]: 'rnbqkbnr/ppp2ppp/8/3pp3/2B1P3/8/PPPP1PPP/RNBQK1NR'  (after 2...d5, white to move)
#   fen_map[5]: 'rnbqkbnr/ppp2ppp/8/3pp3/2B1P3/5P2/PPPP2PP/RNBQK1NR'  (after 3.f3, black to move)
#   fen_map[6]: 'rn1qkbnr/ppp2ppp/8/3pp3/2B1P1b1/5P2/PPPP2PP/RNBQK1NR' (after 3...Bg4, white to move)
#
# Missed-pass fixture (Plan 02, D-03):
#   At ply 5 (black flaw = 3...Bg4??), board_before has fen_map[5], turn=BLACK.
#   White's Bc4 on c4 is undefended (white has no defender of c4 after 3.f3).
#   Black's missed-pass PV at flaw_ply=5 is 'd5c4' (dxc4, capturing the hanging Bc4).
#   detect_tactic_motif(board_before, 'd5c4') fires HANGING_PIECE (non-pawn, undefended).
#
# Allowed-pass fixture (unchanged orientation):
#   At ply 4 (white flaw = 3.f3??), board_after_flaw has fen_map[5] (same FEN), turn=BLACK.
#   Allowed-pass PV at flaw_ply+1=5 is 'd5c4' (refutation PV that punishes white).
#   detect_tactic_motif(board_after_flaw, 'd5c4') fires HANGING_PIECE with pov=BLACK.

_FEN_MAP_128 = {
    4: "rnbqkbnr/ppp2ppp/8/3pp3/2B1P3/8/PPPP1PPP/RNBQK1NR",
    5: "rnbqkbnr/ppp2ppp/8/3pp3/2B1P3/5P2/PPPP2PP/RNBQK1NR",
    6: "rn1qkbnr/ppp2ppp/8/3pp3/2B1P1b1/5P2/PPPP2PP/RNBQK1NR",
}


def _make_positions_128() -> list[GamePosition]:
    """12 positions for Plan 02 orientation tests.

    White blunder at ply 4 (even=white mover): 3.f3?? allows dxc4 (hanging Bc4).
    Black blunder at ply 5 (odd=black mover): 3...Bg4?? misses dxc4 (hanging Bc4).
    """
    positions = [_make_pos_with_pv(i, eval_cp=20) for i in range(12)]
    positions[3] = _make_pos_with_pv(3, eval_cp=200, move_san="d5")
    positions[4] = _make_pos_with_pv(4, eval_cp=-500, move_san="f3")
    # Allowed-pass PV at ply 5 (refutation of white's flaw at ply 4): d5xc4
    positions[5] = _make_pos_with_pv(5, eval_cp=300, move_san="Bg4", pv="d5c4")
    # Allowed-pass PV at ply 6 (refutation of black's flaw at ply 5): f3xg4
    positions[6] = _make_pos_with_pv(6, eval_cp=20, pv="f3g4")
    positions[11] = _make_pos_with_pv(11)
    return positions


class TestDetectTacticForFlawOrientation:
    """Phase 128 Plan 02 (D-03/D-06): _detect_tactic_for_flaw orientation parameter.

    Tests verify:
    (a) orientation='allowed' is unchanged: identical to today's behavior on an
        existing fixture (allowed PV at flaw_ply+1 with board_after_flaw).
    (b) orientation='missed' fires on a constructed board_before + flaw_ply PV
        where the mover had a hanging piece available (dxc4 capturing Bc4).
    (c) orientation='missed' returns all-None when the flaw_ply PV is absent.
    """

    def test_allowed_orientation_unchanged(self) -> None:
        """(a) orientation='allowed' is byte-identical to today's behavior.

        White flaw at ply 4 (3.f3??): allowed-pass PV is 'd5c4' (at ply 5),
        board_after_flaw has fen_map[5] turn=BLACK, detector fires HANGING_PIECE.
        """
        positions = _make_positions_128()
        motif_int, piece, confidence, depth = _detect_tactic_for_flaw(
            n=4,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
        )
        assert motif_int == TacticMotifInt.HANGING_PIECE, (
            f"allowed orientation must fire HANGING_PIECE, got {motif_int}"
        )
        assert confidence == TACTIC_CONFIDENCE_HIGH
        assert depth == 0

    def test_missed_orientation_fires_hanging_piece(self) -> None:
        """(b) orientation='missed' fires on board_before + flaw_ply PV.

        Black flaw at ply 5 (3...Bg4??): missed-pass PV is 'd5c4' (at ply 5),
        board_before has fen_map[5] turn=BLACK, detector fires HANGING_PIECE
        (white's undefended Bc4 available for dxc4).
        """
        positions = _make_positions_128()
        # Missed-pass PV at flaw_ply=5: d5c4 (black should have taken the hanging bishop)
        pv_by_ply = {5: "d5c4"}
        motif_int, piece, confidence, depth = _detect_tactic_for_flaw(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            pv_by_ply=pv_by_ply,
            orientation="missed",
        )
        assert motif_int == TacticMotifInt.HANGING_PIECE, (
            f"missed orientation must fire HANGING_PIECE for dxc4 (capturing hanging Bc4), "
            f"got {motif_int}"
        )
        assert confidence == TACTIC_CONFIDENCE_HIGH
        assert depth == 0

    def test_missed_orientation_returns_none_when_flaw_ply_pv_absent(self) -> None:
        """(c) orientation='missed' returns all-None when the flaw_ply PV is absent.

        No pv_by_ply entry for ply 5, and positions[5].pv is None.
        The result must be (None, None, None, None) without raising.
        """
        positions = _make_positions_128()
        # Ensure positions[5].pv is None (no stored PV)
        positions[5] = _make_pos_with_pv(5, eval_cp=300, move_san="Bg4", pv=None)
        # No pv_by_ply override
        motif_int, piece, confidence, depth = _detect_tactic_for_flaw(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            pv_by_ply=None,
            orientation="missed",
        )
        assert motif_int is None
        assert piece is None
        assert confidence is None
        assert depth is None


class TestDetectTacticForFlawForcedMatePov:
    """Phase 148 code-review CR-01 regression: has_forced_mate honors eval_mate's
    white-perspective sign convention for black-POV flaws.

    GamePosition.eval_mate is stored white-perspective-absolute (positive = white
    mates, negative = black mates). The has_forced_mate flag passed to
    detect_tactic_motif must be True iff the POV side (the mover for 'missed', the
    refuter for 'allowed') has the forced mate — which requires converting to that
    side's POV before the sign test. The original Phase 148 wiring compared the raw
    stored value against 0, inverting the result for every black-POV flaw (~half of
    all plies). These tests pin the corrected conversion by capturing the flag value
    detect_tactic_motif receives.
    """

    @staticmethod
    def _capture_forced_mate(
        monkeypatch: pytest.MonkeyPatch,
    ) -> list[bool]:
        captured: list[bool] = []

        def fake_detect_tactic_motif(
            board: chess.Board, pv_str: str, has_forced_mate: bool = False
        ) -> tuple[int | None, int | None, int | None, int | None]:
            captured.append(has_forced_mate)
            return TacticMotifInt.MATE, None, TACTIC_CONFIDENCE_HIGH, 0

        monkeypatch.setattr(
            "app.services.flaws_service.detect_tactic_motif", fake_detect_tactic_motif
        )
        return captured

    def test_missed_black_pov_forced_mate_sets_flag(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """'missed' at ply 5 (mover=Black): a Black forced mate (eval_mate<0) sets the flag.

        With the pre-fix `eval_mate > 0` test this returned False (the exact deep-mate
        drop the phase set out to fix, reintroduced for black POV).
        """
        captured = self._capture_forced_mate(monkeypatch)
        positions = _make_positions_128()
        positions[5] = _make_pos_with_pv(5, eval_mate=-4, move_san="Bg4", pv="d5c4")
        _detect_tactic_for_flaw(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            pv_by_ply={5: "d5c4"},
            orientation="missed",
        )
        assert captured == [True], (
            "black mover with a Black forced mate (eval_mate=-4) must set has_forced_mate=True"
        )

    def test_missed_black_pov_white_mate_does_not_set_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """'missed' at ply 5 (mover=Black): a White forced mate (eval_mate>0) does NOT set it.

        Guards the false-positive direction — the pre-fix code fired the fallback for
        the wrong side, tagging MATE on a line that is not the mover's mate.
        """
        captured = self._capture_forced_mate(monkeypatch)
        positions = _make_positions_128()
        positions[5] = _make_pos_with_pv(5, eval_mate=4, move_san="Bg4", pv="d5c4")
        _detect_tactic_for_flaw(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            pv_by_ply={5: "d5c4"},
            orientation="missed",
        )
        assert captured == [False], (
            "black mover with only a White forced mate must leave has_forced_mate=False"
        )

    def test_allowed_black_refuter_forced_mate_sets_flag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """'allowed' at ply 4 (refuter=Black): a Black forced mate (eval_mate<0) sets the flag."""
        captured = self._capture_forced_mate(monkeypatch)
        positions = _make_positions_128()
        positions[5] = _make_pos_with_pv(5, eval_mate=-4, move_san="Bg4", pv="d5c4")
        _detect_tactic_for_flaw(
            n=4,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
        )
        assert captured == [True], (
            "black refuter with a Black forced mate (eval_mate=-4) must set has_forced_mate=True"
        )


# ---------------------------------------------------------------------------
# Phase 128 Plan 02 Task 2: _build_flaw_record calls both passes (D-06)
# ---------------------------------------------------------------------------


class TestBuildFlawRecordBothOrientations:
    """Phase 128 Plan 02 Task 2 (D-06): _build_flaw_record calls both passes.

    Tests verify the neither/one/both matrix for the four cases from the plan:
    (1) Both PVs present: both allowed_* and missed_* 4-tuples are non-None.
    (2) Only flaw_ply+1 PV (allowed PV): allowed_* set, missed_* all None.
    (3) Only flaw_ply PV (missed PV): missed_* set, allowed_* all None.
    (4) Neither PV: both 4-tuples all None.

    Uses classify_game_flaws (the integration path) with pv_by_ply to control
    which PVs are available. Both PVs 'd5c4' fire HANGING_PIECE:
    - Allowed at ply 4 (white flaw): board_after_flaw(fen5, turn=BLACK), PV at ply 5
    - Missed at ply 5 (black flaw): board_before(fen5, turn=BLACK), PV at ply 5

    For the tests below we focus on the black flaw at ply 5 (3...Bg4??):
    - Allowed PV at ply 6: 'f3g4' (f3xg4, white captures hanging Bg4)
    - Missed PV at ply 5: 'd5c4' (dxc4, black should have captured hanging Bc4)

    PGN reference: '1. e4 e5 2. Bc4 d5 3. f3 Bg4 *' (TestTacticIntegration)
    """

    _PGN = "1. e4 e5 2. Bc4 d5 3. f3 Bg4 *"

    def _make_positions_for_black_flaw(
        self,
        allowed_pv: str | None = "f3g4",
        missed_pv: str | None = "d5c4",
    ) -> tuple[list[GamePosition], dict[int, str]]:
        """Build positions for black's flaw at ply 5, with controllable PVs.

        Returns (positions, pv_by_ply) where pv_by_ply carries both PVs unless
        one/both are set to None.

        Allowed PV for the black flaw at ply 5 is at ply 6: 'f3g4'.
        Missed PV for the black flaw at ply 5 is at ply 5: 'd5c4'.
        """
        positions = [_make_pos_with_pv(i, eval_cp=20) for i in range(12)]
        # Black blunder at ply 5 (odd=black mover): Bg4?? misses dxc4
        positions[4] = _make_pos_with_pv(4, eval_cp=-500, move_san="f3")
        # eval_cp at ply 4: white badly down (after playing f3?? but before black blunders)
        # es_before(black@5) = 1 - es(pos[4], white) ≈ 1 - 0.160 = 0.840
        # es_after(black@5)  = 1 - es(pos[5], white) ≈ 1 - 0.730 = 0.270
        # drop ≈ 0.570 >= BLUNDER_DROP -> black blunder
        positions[5] = _make_pos_with_pv(5, eval_cp=300, move_san="Bg4", pv=None)
        positions[6] = _make_pos_with_pv(6, eval_cp=20, pv=None)
        positions[11] = _make_pos_with_pv(11)

        pv_by_ply: dict[int, str] = {}
        if allowed_pv is not None:
            pv_by_ply[6] = allowed_pv  # allowed PV for black flaw: at flaw_ply+1=6
        if missed_pv is not None:
            pv_by_ply[5] = missed_pv  # missed PV for black flaw: at flaw_ply=5

        return positions, pv_by_ply

    def _get_black_ply5_flaw(self, result: list[FlawRecord]) -> FlawRecord:
        """Return the black FlawRecord at ply 5, or fail if not found."""
        flaw = next((f for f in result if f["side"] == "black" and f["ply"] == 5), None)
        assert flaw is not None, (
            f"Expected a black FlawRecord at ply 5. Got: {[(f['side'], f['ply']) for f in result]}"
        )
        return flaw

    def test_both_pvs_present_fills_both_orientations(self) -> None:
        """(1) Both PVs present: both allowed_* and missed_* are non-None.

        pv_by_ply[6]='f3g4' (allowed) + pv_by_ply[5]='d5c4' (missed).
        Both fire HANGING_PIECE for the black flaw at ply 5.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions, pv_by_ply = self._make_positions_for_black_flaw(
            allowed_pv="f3g4", missed_pv="d5c4"
        )
        result = classify_game_flaws(game, positions, pv_by_ply=pv_by_ply)
        assert isinstance(result, list)
        flaw = self._get_black_ply5_flaw(result)

        assert flaw["allowed_tactic_motif_int"] is not None, (
            "Both PVs present: allowed_tactic_motif_int must be non-None"
        )
        assert flaw["missed_tactic_motif_int"] is not None, (
            "Both PVs present: missed_tactic_motif_int must be non-None"
        )

    def test_allowed_pv_only_sets_allowed_clears_missed(self) -> None:
        """(2) Only flaw_ply+1 PV (allowed PV): allowed_* set, missed_* all None.

        pv_by_ply[6]='f3g4' (allowed only). No missed PV. Black flaw at ply 5
        should have allowed_tactic_motif_int set and all missed_* as None.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions, pv_by_ply = self._make_positions_for_black_flaw(
            allowed_pv="f3g4", missed_pv=None
        )
        result = classify_game_flaws(game, positions, pv_by_ply=pv_by_ply)
        assert isinstance(result, list)
        flaw = self._get_black_ply5_flaw(result)

        assert flaw["allowed_tactic_motif_int"] is not None, (
            "Allowed-only: allowed_tactic_motif_int must be non-None"
        )
        assert flaw["missed_tactic_motif_int"] is None, (
            "Allowed-only: missed_tactic_motif_int must be None (no missed PV)"
        )
        assert flaw["missed_tactic_piece"] is None
        assert flaw["missed_tactic_confidence"] is None
        assert flaw["missed_tactic_depth"] is None

    def test_missed_pv_only_sets_missed_clears_allowed(self) -> None:
        """(3) Only flaw_ply PV (missed PV): missed_* set, allowed_* all None.

        pv_by_ply[5]='d5c4' (missed only). No allowed PV. Black flaw at ply 5
        should have missed_tactic_motif_int set and all allowed_* as None.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions, pv_by_ply = self._make_positions_for_black_flaw(
            allowed_pv=None, missed_pv="d5c4"
        )
        result = classify_game_flaws(game, positions, pv_by_ply=pv_by_ply)
        assert isinstance(result, list)
        flaw = self._get_black_ply5_flaw(result)

        assert flaw["missed_tactic_motif_int"] is not None, (
            "Missed-only: missed_tactic_motif_int must be non-None"
        )
        assert flaw["allowed_tactic_motif_int"] is None, (
            "Missed-only: allowed_tactic_motif_int must be None (no allowed PV)"
        )
        assert flaw["allowed_tactic_piece"] is None
        assert flaw["allowed_tactic_confidence"] is None
        assert flaw["allowed_tactic_depth"] is None

    def test_neither_pv_leaves_both_orientations_none(self) -> None:
        """(4) Neither PV: both 4-tuples all None.

        No pv_by_ply entries and no stored PVs. The FlawRecord is still emitted
        (severity/tags unaffected); all 8 tactic fields stay None.
        """
        game = _make_game(pgn=self._PGN, user_color="white", result="0-1")
        positions, pv_by_ply = self._make_positions_for_black_flaw(allowed_pv=None, missed_pv=None)
        result = classify_game_flaws(game, positions, pv_by_ply=pv_by_ply)
        assert isinstance(result, list)
        flaw = self._get_black_ply5_flaw(result)

        assert flaw["allowed_tactic_motif_int"] is None
        assert flaw["allowed_tactic_piece"] is None
        assert flaw["allowed_tactic_confidence"] is None
        assert flaw["allowed_tactic_depth"] is None
        assert flaw["missed_tactic_motif_int"] is None
        assert flaw["missed_tactic_piece"] is None
        assert flaw["missed_tactic_confidence"] is None
        assert flaw["missed_tactic_depth"] is None


# ---------------------------------------------------------------------------
# Phase 143 Plan 02 Task 1: _classify_tactic_gated wrapper + _solver_color_for
# ---------------------------------------------------------------------------


class TestSolverColorFor:
    """_solver_color_for maps (ply parity, orientation) to solver color (D-02, SC4).

    Convention (matches flaws_service.py line 444-446):
      Even ply: white moved (made the flaw).
      "allowed": the refuter (solver) is the OPPONENT of the mover.
      "missed": the flaw-maker (solver) IS the mover.

    Four parity cases:
      (even, "allowed")  -> opponent of white = "black"
      (odd,  "allowed")  -> opponent of black = "white"
      (even, "missed")   -> flaw-maker = white = "white"
      (odd,  "missed")   -> flaw-maker = black = "black"
    """

    def test_even_ply_allowed_returns_black(self) -> None:
        """Even ply = white mover; allowed refuter = opponent = black."""
        assert _solver_color_for(4, "allowed") == "black"

    def test_odd_ply_allowed_returns_white(self) -> None:
        """Odd ply = black mover; allowed refuter = opponent = white."""
        assert _solver_color_for(5, "allowed") == "white"

    def test_even_ply_missed_returns_white(self) -> None:
        """Even ply = white mover; missed flaw-maker = white."""
        assert _solver_color_for(4, "missed") == "white"

    def test_odd_ply_missed_returns_black(self) -> None:
        """Odd ply = black mover; missed flaw-maker = black."""
        assert _solver_color_for(5, "missed") == "black"


class TestClassifyTacticGated:
    """Phase 143 Plan 02 Task 1 (D-02, SC4): _classify_tactic_gated wrapper contract.

    Uses the 'black flaw at ply 5' fixture from TestDetectTacticForFlawOrientation
    (PGN "1. e4 e5 2. Bc4 d5 3. f3 Bg4 *"). _detect_tactic_for_flaw(5, ..., "allowed")
    fires HANGING_PIECE (allowed PV at ply 6: "f3g4"). This baseline motif lets the
    gate tests verify skip / suppress / pass-through without mocking the kernel.

    Solver color for n=5, "allowed": _solver_color_for(5, "allowed") = "white"
    pre_flaw_eval_cp for n=5: positions[5].eval_cp = 300 (from _make_positions_128).

    Already-winning check: _is_already_winning(300, "white") = (300 > 300) = False
    => the gate proceeds to node-level checks.
    """

    def test_gate_skip_on_none_blob_returns_kernel_result(self) -> None:
        """pv_blob=None: gate is skipped; raw _detect_tactic_for_flaw result returned.

        Gate condition is `pv_blob is not None` (not truthiness). None means a
        pre-Phase-142 row with no stored blob — backward compatibility preserved.
        """
        positions = _make_positions_128()
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=None,
            pre_flaw_eval_cp=None,
        )
        assert motif == TacticMotifInt.HANGING_PIECE, (
            "gate-skip on None blob must return raw kernel result (HANGING_PIECE)"
        )
        assert piece is not None
        assert conf == TACTIC_CONFIDENCE_HIGH
        assert depth == 0

    def test_sentinel_empty_blob_skips_gate_returns_kernel_result(self) -> None:
        """pv_blob=[]: D-06 sentinel — gate is SKIPPED, raw kernel result returned.

        An empty list is the D-06 un-fillable sentinel (a flaw whose PV blob could
        not be assembled, e.g. single-legal-move position or analysis gap). The gate
        condition must be `pv_blob is not None and len(pv_blob) > 0` so that [] is
        treated the same as None (gate skipped, no suppression). This supersedes the
        Phase-143 Pitfall-2 wording which treated [] as a gate-eligible blob.
        """
        positions = _make_positions_128()
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=[],
            pre_flaw_eval_cp=300,
        )
        assert motif == TacticMotifInt.HANGING_PIECE, (
            "D-06 sentinel [] must skip the gate and return raw kernel result (HANGING_PIECE)"
        )
        assert piece is not None
        assert conf == TACTIC_CONFIDENCE_HIGH
        assert depth == 0

    def test_pass_through_when_line_is_forced(self) -> None:
        """pv_blob with a forced line: gate passes, kernel result returned unchanged.

        Uses a 3-node line [S0_forced, D0_defender, S1_forced] with large cp gaps.
        Both solver nodes (S0, S1) have p_best - p_second >> 0.35 (the margin).
        The gate passes and the underlying HANGING_PIECE detection is returned.
        """
        positions = _make_positions_128()
        # 3-node forced blob: solver nodes at indices 0, 2; defender at index 1 (ignored).
        # Solver color = "white" (odd ply, allowed), white-perspective values:
        #   S0: b=800, s=0 -> p(800,"white")-p(0,"white") ≈ 0.45 > 0.35 -> forced
        #   D0: defender node, not evaluated for uniqueness
        #   S1: b=800, s=0 -> forced
        forced_blob: list[PvNode] = [
            {"b": 800, "bm": None, "s": 0, "sm": None, "su": "f3g4"},
            {"b": -300, "bm": None, "s": -350, "sm": None, "su": "g8f6"},
            {"b": 800, "bm": None, "s": 0, "sm": None, "su": "d1h5"},
        ]
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=forced_blob,
            pre_flaw_eval_cp=300,
        )
        assert motif == TacticMotifInt.HANGING_PIECE, (
            "forced line must pass the gate and return the kernel HANGING_PIECE result"
        )
        assert conf == TACTIC_CONFIDENCE_HIGH

    def test_suppression_when_nodes_have_small_gap(self) -> None:
        """pv_blob with non-forcing nodes (small margin gap): motif suppressed.

        Solver nodes have p_best - p_second < 0.35 AND a cp gap below the 100cp escape;
        the gate rejects the line. Uses a 3-node line where both solver nodes have b=200, s=120.
        p(200,"white") - p(120,"white") ≈ 0.068 < 0.35, and the 80cp gap < 100 escape.
        """
        positions = _make_positions_128()
        non_forcing_blob: list[PvNode] = [
            {"b": 200, "bm": None, "s": 120, "sm": None, "su": "f3g4"},
            {"b": -100, "bm": None, "s": -150, "sm": None, "su": "g8f6"},
            {"b": 200, "bm": None, "s": 120, "sm": None, "su": "d1h5"},
        ]
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=non_forcing_blob,
            pre_flaw_eval_cp=300,
        )
        assert motif is None, "non-forcing blob (small margin gap) must suppress the motif"
        assert piece is None
        assert conf is None
        assert depth is None


# ---------------------------------------------------------------------------
# Phase 147 Plan 01 Task 2: blobs_pending suppression branch (D-01, D-03)
# ---------------------------------------------------------------------------


class TestClassifyTacticGatedBlobsPending:
    """blobs_pending=True suppresses cp-based tags with no blob yet (D-01, D-03).

    Uses the same n=5 "allowed" fixture as TestClassifyTacticGated: raw kernel
    result is HANGING_PIECE (TACTIC_CONFIDENCE_HIGH, depth=0).
    """

    def test_blobs_pending_true_cp_flaw_no_blob_suppresses(self) -> None:
        """blobs_pending=True, pv_blob=None, cp-based flaw: motif suppressed to NULL.

        The continuation blob is deferred (tier-4 pass); the gate cannot yet
        run, so the raw ungated motif must NOT be persisted (self-heals later
        via the D-07 gated retag once the blob lands).
        """
        positions = _make_positions_128()
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=None,
            pre_flaw_eval_cp=300,
            blobs_pending=True,
        )
        assert motif is None, "blobs_pending=True with a cp-based, blob-less flaw must suppress"
        assert piece is None
        assert conf is None
        assert depth is None

    def test_blobs_pending_true_mate_adjacent_keeps_raw(self) -> None:
        """blobs_pending=True, pre_flaw_eval_cp=None (mate-adjacent): raw tag KEPT.

        Mate-adjacent flaw plies are a FINAL case (D-06 KEEP rule) — there is no
        cp value to gate-check against even once a blob eventually arrives, so
        suppression must never apply here.
        """
        positions = _make_positions_128()
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=None,
            pre_flaw_eval_cp=None,
            blobs_pending=True,
        )
        assert motif == TacticMotifInt.HANGING_PIECE, (
            "mate-adjacent flaws are FINAL and must keep the raw motif under blobs_pending"
        )
        assert piece is not None
        assert conf == TACTIC_CONFIDENCE_HIGH
        assert depth == 0

    def test_blobs_pending_true_sentinel_empty_blob_keeps_raw(self) -> None:
        """blobs_pending=True, pv_blob=[] (D-06 sentinel): raw tag KEPT.

        The []-sentinel is a FINAL un-fillable case. Suppression must key off
        `pv_blob is None`, NOT falsy, so [] is never re-suppressed here.
        """
        positions = _make_positions_128()
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=[],
            pre_flaw_eval_cp=300,
            blobs_pending=True,
        )
        assert motif == TacticMotifInt.HANGING_PIECE, (
            "D-06 []-sentinel is FINAL and must keep the raw motif under blobs_pending"
        )
        assert piece is not None
        assert conf == TACTIC_CONFIDENCE_HIGH
        assert depth == 0

    def test_blobs_pending_false_default_cp_flaw_no_blob_keeps_raw(self) -> None:
        """blobs_pending=False (default): no suppression, raw tag KEPT — unchanged behavior.

        This is the local-drain / discovery-only default; the new parameter must
        be opt-in only at the remote go-forward call site.
        """
        positions = _make_positions_128()
        motif, piece, conf, depth = _classify_tactic_gated(
            n=5,
            fen_map=_FEN_MAP_128,
            positions=positions,
            orientation="allowed",
            pv_blob=None,
            pre_flaw_eval_cp=300,
        )
        assert motif == TacticMotifInt.HANGING_PIECE, (
            "blobs_pending default False must preserve pre-Phase-147 behavior (raw kept)"
        )
        assert piece is not None
        assert conf == TACTIC_CONFIDENCE_HIGH
        assert depth == 0
