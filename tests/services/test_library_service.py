"""Unit tests for the Phase 106 library-service severity-count seam.

Phase 108 D-02 migration: chip curation and tag-distribution tests updated to
use the new game_flaws-backed API (_curate_chips_from_rows, _build_tag_distribution).
The _curate_chips (FlawRecord-based) and _GameFlaws/_compute_tag_distribution helpers
were retired; tests now either use GameFlaw objects (chip curation) or call
_build_tag_distribution with direct keyword aggregates (distribution unit tests).

Wave-0 scaffold (106-01). Covers the additive `count_game_severities` kernel
helper: per-game B/M/I counts (incl. inaccuracy) restricted to the USER's moves,
gated identically to `classify_game_flaws` (>= EVAL_COVERAGE_MIN coverage,
else GameNotAnalyzed with reason="no_engine_analysis").

No DB required — GamePosition / Game objects are built in memory à la
tests/services/test_flaws_service.py.
"""

from typing import cast

import pytest

from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.services.eval_utils import eval_cp_to_expected_score
from app.services.flaws_service import (
    BLUNDER_DROP,
    MISTAKE_DROP,
    GameNotAnalyzed,
    SeverityCounts,
    count_game_severities,
)


def _make_game_flaw(
    *,
    user_id: int = 1,
    game_id: int = 1,
    ply: int = 2,
    severity: int = 2,  # 2=blunder
    tempo: int | None = None,
    phase: int = 1,  # 1=middlegame
    is_miss: bool = False,
    is_lucky: bool = False,
    is_reversed: bool = False,
    is_squandered: bool = False,
) -> GameFlaw:
    """Build a minimal in-memory GameFlaw object for unit testing (no DB flush)."""
    row = GameFlaw()
    row.user_id = user_id
    row.game_id = game_id
    row.ply = ply
    row.severity = severity
    row.tempo = tempo
    row.phase = phase
    row.is_miss = is_miss
    row.is_lucky = is_lucky
    row.is_reversed = is_reversed
    row.is_squandered = is_squandered
    # Phase 112 (D-07): es_before, es_after, move_san removed from game_flaws
    row.fen = ""
    return row


def _as_counts(result: SeverityCounts | GameNotAnalyzed) -> SeverityCounts:
    """Narrow the union to SeverityCounts (both erase to dict at runtime).

    Both TypedDicts are plain dicts at runtime, so discriminate on the
    presence of the "reason" key (RESEARCH §Code Examples note). ty cannot
    narrow a TypedDict union on key presence, so we cast after the check.
    """
    assert "reason" not in result, f"expected analyzed counts, got {result}"
    return result


def _as_not_analyzed(result: SeverityCounts | GameNotAnalyzed) -> GameNotAnalyzed:
    """Narrow the union to GameNotAnalyzed via the "reason" discriminant."""
    assert "reason" in result, f"expected GameNotAnalyzed, got {result}"
    return cast(GameNotAnalyzed, result)


# ---------------------------------------------------------------------------
# In-memory builders (mirror tests/services/test_flaws_service.py)
# ---------------------------------------------------------------------------


def _make_pos(
    ply: int,
    eval_cp: int | None = None,
    eval_mate: int | None = None,
    clock_seconds: float | None = None,
    phase: int = 1,
    move_san: str | None = None,
    best_move: str | None = None,
) -> GamePosition:
    """Build a GamePosition with eval fields for pure unit testing (no DB flush).

    Quick 260717-rbn: best_move param added (UCI, e.g. "e2e4") for the new
    best-tier identity-comparison tests.
    """
    pos = GamePosition()
    pos.ply = ply
    pos.eval_cp = eval_cp
    pos.eval_mate = eval_mate
    pos.clock_seconds = clock_seconds
    pos.phase = phase
    pos.move_san = move_san
    pos.best_move = best_move
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
    """Build a minimal Game object for unit testing (no DB flush)."""
    game = Game()
    game.pgn = pgn
    game.user_color = user_color
    game.result = result
    game.base_time_seconds = base_time_seconds
    game.increment_seconds = increment_seconds
    return game


def _make_best_move(
    *,
    game_id: int = 1,
    ply: int = 0,
    maia_prob: float = 0.10,
    best_cp: int | None = 169,  # white-mover ES margin ~0.15 vs second_cp=0 (>= MISTAKE_DROP)
    best_mate: int | None = None,
    second_cp: int | None = 0,
    second_mate: int | None = None,
) -> GameBestMove:
    """Build a minimal GameBestMove object for unit testing (no DB flush).

    Default cp pair (169 vs 0) gives a white-mover ES margin of ~0.15, comfortably
    above MISTAKE_DROP (0.10) — the "wide margin" case used by the gem/great tests.
    """
    row = GameBestMove()
    row.game_id = game_id
    row.ply = ply
    row.maia_prob = maia_prob
    row.best_cp = best_cp
    row.best_mate = best_mate
    row.second_cp = second_cp
    row.second_mate = second_mate
    return row


# Centipawn deltas (white-perspective) that produce a known mover-POV ES drop.
# For a WHITE mover at ply N: ES_before = ES(eval[N-1]), ES_after = ES(eval[N]).
# A drop of `d` means ES(prev) - ES(curr) >= threshold for white.
# We search a cp pair whose white-POV ES drop sits in the target band.


def _cp_for_white_drop(drop_target: float) -> tuple[int, int]:
    """Return (prev_cp, curr_cp) so the WHITE-mover ES drop is ~drop_target.

    ES(cp, white) = sigmoid. Start from prev_cp=0 (ES=0.5) and lower curr_cp
    until the drop reaches the target band.
    """
    prev_cp = 0
    es_before = eval_cp_to_expected_score(prev_cp, "white")
    curr_cp = -10
    while es_before - eval_cp_to_expected_score(curr_cp, "white") < drop_target:
        curr_cp -= 10
    return prev_cp, curr_cp


# ---------------------------------------------------------------------------
# TestCountGameSeverities
# ---------------------------------------------------------------------------


class TestCountGameSeverities:
    """count_game_severities: B/M/I counts (user moves only) or GameNotAnalyzed."""

    def test_no_engine_analysis_all_null_eval(self) -> None:
        """A chess.com-style all-null-eval game returns GameNotAnalyzed."""
        game = _make_game(user_color="white")
        positions = [_make_pos(ply=n) for n in range(5)]  # no evals at all
        not_analyzed = _as_not_analyzed(count_game_severities(game, positions))
        assert not_analyzed["reason"] == "no_engine_analysis"
        assert not_analyzed["eval_coverage"] == 0.0

    def test_analyzed_game_counts_all_three_tiers_user_only(self) -> None:
        """Counts include inaccuracy/mistake/blunder, restricted to user moves."""
        # White (the user) blunders at ply 2; black is clean throughout.
        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        # Build 5 plies, all with eval so coverage is 100%.
        # White moves are even plies (2, 4); black odd plies (1, 3).
        # ply0 baseline, ply1 black move (clean), ply2 white blunder, ...
        positions = [
            _make_pos(ply=0, eval_cp=prev_b),  # baseline before ply1
            _make_pos(ply=1, eval_cp=prev_b),  # black move N=1 (ES_before==ES_after -> no drop)
            _make_pos(
                ply=2, eval_cp=curr_b
            ),  # white move N=2: drop from prev_b -> curr_b = blunder
            _make_pos(ply=3, eval_cp=curr_b),  # black move N=3: clean
            _make_pos(ply=4, eval_cp=curr_b),  # white move N=4: clean
        ]
        game = _make_game(user_color="white")
        counts = _as_counts(count_game_severities(game, positions))
        assert counts["blunder"] == 1
        assert counts["mistake"] == 0
        # inaccuracy may be 0 here; the dedicated inaccuracy test below pins I>0.

    def test_inaccuracy_only_game_distinct_from_not_analyzed(self) -> None:
        """An inaccuracy-only analyzed game: inaccuracy>0, mistake=0, blunder=0.

        Proves the I count is NOT derived from the M+B FlawRecord set (Pitfall 3).
        """
        # White (user) makes a drop in [INACCURACY_DROP, MISTAKE_DROP).
        from app.services.flaws_service import INACCURACY_DROP

        # find a cp pair with drop in the inaccuracy band (>= INACCURACY_DROP, < MISTAKE_DROP)
        prev_cp = 0
        curr_cp = -10
        es_before = eval_cp_to_expected_score(prev_cp, "white")
        while es_before - eval_cp_to_expected_score(curr_cp, "white") < INACCURACY_DROP:
            curr_cp -= 5
        drop = es_before - eval_cp_to_expected_score(curr_cp, "white")
        assert INACCURACY_DROP <= drop < MISTAKE_DROP, f"drop {drop} not in inaccuracy band"

        positions = [
            _make_pos(ply=0, eval_cp=prev_cp),
            _make_pos(ply=1, eval_cp=prev_cp),  # black clean
            _make_pos(ply=2, eval_cp=curr_cp),  # white inaccuracy at N=2
            _make_pos(ply=3, eval_cp=curr_cp),  # black clean
        ]
        game = _make_game(user_color="white")
        counts = _as_counts(count_game_severities(game, positions))
        assert counts["inaccuracy"] > 0
        assert counts["mistake"] == 0
        assert counts["blunder"] == 0

    def test_opponent_moves_excluded(self) -> None:
        """A blunder by the OPPONENT (not the user) is not counted."""
        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        # user is BLACK; the white-POV drop above corresponds to a WHITE (opponent) blunder.
        positions = [
            _make_pos(ply=0, eval_cp=prev_b),
            _make_pos(ply=1, eval_cp=prev_b),  # black (user) move N=1 clean
            _make_pos(ply=2, eval_cp=curr_b),  # white (opponent) blunder N=2
            _make_pos(ply=3, eval_cp=curr_b),  # black (user) move N=3 clean
        ]
        game = _make_game(user_color="black")
        counts = _as_counts(count_game_severities(game, positions))
        assert counts["blunder"] == 0
        assert counts["mistake"] == 0
        assert counts["inaccuracy"] == 0

    def test_severity_counts_typed_shape(self) -> None:
        """The non-analyzed-positive result is a SeverityCounts with int fields."""
        positions = [_make_pos(ply=n, eval_cp=0) for n in range(5)]
        game = _make_game(user_color="white")
        counts = _as_counts(count_game_severities(game, positions))
        assert isinstance(counts["inaccuracy"], int)
        assert isinstance(counts["mistake"], int)
        assert isinstance(counts["blunder"], int)


# ---------------------------------------------------------------------------
# TestBestMoveTierAssembly (-k eval_series) — Phase 175 Plan 02 (BOARD-01)
# ---------------------------------------------------------------------------


class TestBestMoveTierAssembly:
    """_build_eval_series populates EvalPoint.best_move_tier/maia_prob from stored
    game_best_moves rows via classify_best_move — pure in-memory, no DB (mirrors
    TestCountGameSeverities above)."""

    def test_eval_series_gem_row_populates_tier_and_maia_prob(self) -> None:
        """maia_prob=0.10 + wide margin (>= MISTAKE_DROP) -> gem, maia_prob carried."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4")]
        best_moves = {0: _make_best_move(maia_prob=0.10)}

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply=best_moves)

        assert eval_series[0].best_move_tier == "gem"
        assert eval_series[0].maia_prob == 0.10

    def test_eval_series_great_row_populates_tier_and_maia_prob(self) -> None:
        """maia_prob=0.35 (between GEM_MAIA_MAX_PROB and GREAT_MAIA_MAX_PROB) -> great."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4")]
        best_moves = {0: _make_best_move(maia_prob=0.35)}

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply=best_moves)

        assert eval_series[0].best_move_tier == "great"
        assert eval_series[0].maia_prob == 0.35

    def test_eval_series_narrow_margin_row_yields_null_tier(self) -> None:
        """Pitfall 3: a stored row with margin in [0.05, 0.10) (best_cp=77 vs
        second_cp=0 -> ES margin ~0.07) is NOT automatically a marker — row
        presence alone must not decide the tier; classify_best_move must be
        called on the raw floats and return 'neither' here (< MISTAKE_DROP)."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4")]
        best_moves = {0: _make_best_move(maia_prob=0.10, best_cp=77, second_cp=0)}

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply=best_moves)

        assert eval_series[0].best_move_tier is None
        assert eval_series[0].maia_prob is None

    def test_eval_series_neither_row_leaves_maia_prob_null(self) -> None:
        """Pitfall 5: a wide-margin row with maia_prob above GREAT_MAIA_MAX_PROB
        classifies 'neither' -- maia_prob must NOT be populated on the EvalPoint."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4")]
        best_moves = {0: _make_best_move(maia_prob=0.60)}

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply=best_moves)

        assert eval_series[0].best_move_tier is None
        assert eval_series[0].maia_prob is None

    def test_eval_series_no_stored_row_yields_null_tier_deterministically(self) -> None:
        """A mainline ply with NO stored game_best_moves row yields best_move_tier
        =None deterministically (storage gate 0.05 < classify gate 0.10, so
        absence is authoritative 'not gem/great') -- no live engine call needed."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4")]

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply={})

        assert eval_series[0].best_move_tier is None
        assert eval_series[0].maia_prob is None

    def test_eval_series_best_moves_by_ply_defaults_to_none_safe(self) -> None:
        """Omitting best_moves_by_ply entirely (existing callers/tests) must not
        crash -- backward-compatible default."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4")]

        eval_series, _, _ = _build_eval_series(game, positions)

        assert eval_series[0].best_move_tier is None
        assert eval_series[0].maia_prob is None


# ---------------------------------------------------------------------------
# TestBestGoodTiers -- Quick 260717-rbn (Task 1)
# ---------------------------------------------------------------------------


class TestBestGoodTiers:
    """_build_eval_series 'best'/'good' tier computation -- precedence

    gem > great > best > good > null, out-of-book gate, and identity/drop
    classification, pure in-memory (mirrors TestBestMoveTierAssembly above).
    """

    def test_identity_match_neither_row_yields_best(self) -> None:
        """Out-of-book ply, played == stored best_move (identity), and the
        stored candidate row classifies 'neither' (maia_prob too high) ->
        best_move_tier='best', maia_prob stays None."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4", best_move="e2e4")]
        # Wide margin (best_cp=169 vs second_cp=0) but maia_prob=0.60 exceeds
        # GREAT_MAIA_MAX_PROB -> classify_best_move returns "neither" (mirrors
        # test_eval_series_neither_row_leaves_maia_prob_null's fixture).
        best_moves = {0: _make_best_move(maia_prob=0.60)}

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply=best_moves)

        assert eval_series[0].best_move_tier == "best"
        assert eval_series[0].maia_prob is None

    def test_sub_inaccuracy_drop_played_not_best_yields_good(self) -> None:
        """Out-of-book ply, played != best_move, mover-POV ES drop below
        INACCURACY_DROP -> best_move_tier='good', maia_prob stays None."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [
            _make_pos(ply=0, eval_cp=0, move_san=None),  # baseline, no move played
            # eval unchanged before/after -> drop=0 (< INACCURACY_DROP); best_move
            # left unset so identity never triggers regardless of played move.
            _make_pos(ply=1, eval_cp=0, move_san="e4"),
        ]

        eval_series, _, _ = _build_eval_series(game, positions)

        assert eval_series[1].best_move_tier == "good"
        assert eval_series[1].maia_prob is None

    def test_negative_drop_played_not_best_yields_good(self) -> None:
        """A negative drop (played move evaluates BETTER than the pre-move eval)
        with played != best_move still classifies 'good' (drop < INACCURACY_DROP
        trivially satisfied for any improvement)."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [
            _make_pos(ply=0, eval_cp=100, move_san=None),  # white favored pre-move
            # cp swings heavily toward black -> an improvement for whichever
            # mover _run_all_moves_pass attributes this transition to.
            _make_pos(ply=1, eval_cp=-100, move_san="e4"),
        ]

        eval_series, _, _ = _build_eval_series(game, positions)

        assert eval_series[1].best_move_tier == "good"
        assert eval_series[1].maia_prob is None

    def test_gem_tier_never_downgraded_to_best_or_good(self) -> None:
        """A ply classify_best_move grades 'gem' keeps 'gem' (never downgraded to
        best/good) and still carries maia_prob -- precedence gem > best/good."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        # Identity ALSO matches (played == best_move) to prove the gem branch
        # wins over the best/good fallback even when both would otherwise apply.
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4", best_move="e2e4")]
        best_moves = {0: _make_best_move(maia_prob=0.10)}  # -> gem

        eval_series, _, _ = _build_eval_series(game, positions, best_moves_by_ply=best_moves)

        assert eval_series[0].best_move_tier == "gem"
        assert eval_series[0].maia_prob == 0.10

    def test_book_ply_never_gets_best_or_good(self) -> None:
        """A book ply (ply < opening_ply_count) with played == best_move gets
        best_move_tier=None -- no best/good in book, even with an identity match."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san="e4", best_move="e2e4")]

        eval_series, _, _ = _build_eval_series(
            game,
            positions,
            opening_ply_count=1,  # ply 0 < 1 -> still in book
        )

        assert eval_series[0].best_move_tier is None
        assert eval_series[0].maia_prob is None

    def test_flaw_drop_played_not_best_falls_through_to_null(self) -> None:
        """A ply whose drop >= INACCURACY_DROP (an inaccuracy/mistake/blunder) and
        played != best_move gets best_move_tier=None -- falls through to the flaw
        path rather than being labeled best/good."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [
            # Large heavily-black-favored eval collapsing toward equal -- a real
            # blunder-sized drop for whichever mover this transition is attributed to.
            _make_pos(ply=0, eval_cp=-500, move_san=None),
            _make_pos(ply=1, eval_cp=0, move_san="e4", best_move="d2d4"),  # played != best_move
        ]

        eval_series, _, _ = _build_eval_series(game, positions)

        assert eval_series[1].best_move_tier is None
        assert eval_series[1].maia_prob is None

    def test_missing_eval_and_absent_best_move_yields_null(self) -> None:
        """A ply with a missing eval (no all_moves entry) and best_move absent
        gets best_move_tier=None."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [
            _make_pos(ply=0, eval_cp=0, move_san=None),
            _make_pos(ply=1, eval_cp=None, move_san="e4"),  # missing eval -> no all_moves entry
        ]

        eval_series, _, _ = _build_eval_series(game, positions)

        assert eval_series[1].best_move_tier is None
        assert eval_series[1].maia_prob is None

    def test_terminal_position_never_gets_a_tier(self) -> None:
        """The terminal position (move_san=None) never gets a best/good tier."""
        from app.services.library_service import _build_eval_series

        game = _make_game(user_color="white")
        positions = [_make_pos(ply=0, eval_cp=0, move_san=None)]

        eval_series, _, _ = _build_eval_series(game, positions)

        assert eval_series[0].best_move_tier is None
        assert eval_series[0].maia_prob is None


# ---------------------------------------------------------------------------
# TestCardChips (-k chips) — chip curation (106-02, D-02 updated)
# ---------------------------------------------------------------------------


class TestCardChips:
    """_curate_chips_from_rows: dedupe, phase exclusion, deterministic order.

    D-02 migration: updated from FlawRecord-based _curate_chips to GameFlaw
    row-based _curate_chips_from_rows. Phase tags (opening/middlegame/endgame)
    are excluded via the _CHIP_ORDER constant (not encoded in GameFlaw columns).
    Tempo tags come from the integer `tempo` column via _TEMPO_INT_TO_TAG lookup.
    """

    def test_chips_exclude_phase_and_dedupe(self) -> None:
        """Phase tags dropped (not in _CHIP_ORDER); one chip per tag; stable order."""
        from app.services.library_service import _curate_chips_from_rows

        # Flaw 1: reversed (phase=middlegame=1 excluded) + hasty (tempo=1)
        # Flaw 2: hasty (duplicate -> deduped) + miss
        # _TEMPO_INT: hasty=1, _CHIP_ORDER: miss < reversed < hasty
        row1 = _make_game_flaw(ply=2, phase=1, is_reversed=True, tempo=1)  # hasty
        row2 = _make_game_flaw(ply=4, phase=0, is_miss=True, tempo=1)  # hasty + miss
        chips = _curate_chips_from_rows([row1, row2])
        # Phase tags (middlegame/opening) never appear in chips (not in _CHIP_ORDER)
        assert "middlegame" not in chips
        assert "opening" not in chips
        # dedupe: hasty appears once
        assert chips.count("hasty") == 1
        # all non-phase tags present
        assert set(chips) == {"reversed", "hasty", "miss"}
        # deterministic order follows _CHIP_ORDER: miss < reversed < hasty
        assert chips == ["miss", "reversed", "hasty"]

    def test_chips_empty_when_no_flaws(self) -> None:
        """No flaw rows -> no chips."""
        from app.services.library_service import _curate_chips_from_rows

        assert _curate_chips_from_rows([]) == []

    def test_chips_only_phase_yields_empty(self) -> None:
        """A flaw row with no boolean tags and no tempo produces no chips.

        Phase is encoded as an integer column (not in chip booleans), so a
        row with all False booleans and tempo=None yields an empty chip list.
        """
        from app.services.library_service import _curate_chips_from_rows

        row = _make_game_flaw(ply=2, phase=2, tempo=None)  # endgame, no other tags
        chips = _curate_chips_from_rows([row])
        assert chips == []


# ---------------------------------------------------------------------------
# TestNoEngineAnalysis (-k no_engine_analysis) — service-level card state (106-02)
# ---------------------------------------------------------------------------


class TestNoEngineAnalysis:
    """get_library_games surfaces no_engine_analysis, never a false 0/0/0."""

    @pytest.mark.asyncio
    async def test_chesscom_game_card_is_no_engine_analysis(self, db_session: object) -> None:
        """A chess.com-style all-null-eval game -> no_engine_analysis card state."""
        import uuid

        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.models.game_position import GamePosition as PosModel
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99977)

        game = GameModel(
            user_id=99977,
            platform="chess.com",
            platform_game_id=str(uuid.uuid4()),
            platform_url="https://chess.com/game/test",
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
        # Positions with NO eval (chess.com has no engine analysis).
        for ply in range(3):
            pos = PosModel(
                game_id=game.id,
                user_id=99977,
                ply=ply,
                full_hash=hash(f"f-{game.id}-{ply}"),
                white_hash=hash(f"w-{game.id}-{ply}"),
                black_hash=hash(f"b-{game.id}-{ply}"),
                move_san=None,
                clock_seconds=None,
                phase=1,
                eval_cp=None,
                eval_mate=None,
                endgame_class=None,
            )
            session.add(pos)
        await session.flush()

        resp = await get_library_games(
            session,
            user_id=99977,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        card = next(c for c in resp.games if c.game_id == game.id)
        assert card.analysis_state == "no_engine_analysis"
        assert card.severity_counts is None  # NEVER a false 0/0/0
        assert card.chips == []
        # Quick 260714-rj5: the LIST endpoint's payload-blowup guard holds — it
        # keeps scoping fetch_page_eval_positions to the analyzed subset, so an
        # unanalyzed row here still gets moves=None (not the single-game path's
        # newly-populated moves list).
        assert card.moves is None
        assert card.phase_transitions is None

    @pytest.mark.asyncio
    async def test_flawchess_game_included_when_platform_is_none(self, db_session: object) -> None:
        """get_library_games opts flawchess back in when platform is None (D-03).

        Phase 167: apply_game_filters now excludes platform='flawchess' by
        default (D-02, STORE-07). The Library Games tab is the one surface
        that should keep showing bot-practice games, so get_library_games
        must substitute an explicit platform list (including 'flawchess')
        before calling query_filtered_games when the caller passes platform=None.
        opponent_type='all' bypasses the (separately scoped, Phase 171)
        is_computer_game gate so this test isolates the platform seam alone.
        """
        import uuid

        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99978)

        game = GameModel(
            user_id=99978,
            platform="flawchess",
            platform_game_id=str(uuid.uuid4()),
            pgn="1. e4 e5 1-0",
            result="1-0",
            user_color="white",
            time_control_str="600+0",
            time_control_bucket="rapid",
            rated=False,
            is_computer_game=True,
        )
        session.add(game)
        await session.flush()

        resp = await get_library_games(
            session,
            user_id=99978,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        returned_ids = {c.game_id for c in resp.games}
        assert game.id in returned_ids, "flawchess game must be included when platform is None"


# ---------------------------------------------------------------------------
# TestFlawStats (-k stats) — the stats-panel aggregate (106-03)
# ---------------------------------------------------------------------------


async def _seed_db_flaw(
    session: object,
    *,
    game: object,
    ply: int,
    severity: int = 2,  # 2=blunder
    tempo: int | None = None,
    phase: int = 1,  # 1=middlegame
    is_miss: bool = False,
    is_lucky: bool = False,
    is_reversed: bool = False,
    is_squandered: bool = False,
) -> None:
    """Insert a GameFlaw row for the given game."""
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.game import Game as GameModel
    from app.models.game_flaw import GameFlaw

    sess = cast(AsyncSession, session)
    g = cast(GameModel, game)
    flaw = GameFlaw(
        user_id=g.user_id,
        game_id=g.id,
        ply=ply,
        severity=severity,
        tempo=tempo,
        phase=phase,
        is_miss=is_miss,
        is_lucky=is_lucky,
        is_reversed=is_reversed,
        is_squandered=is_squandered,
        # Phase 112 (D-07): es_before, es_after, move_san removed from game_flaws
        fen="",
    )
    sess.add(flaw)
    await sess.flush()


async def _seed_db_game(
    session: object,
    *,
    user_id: int,
    user_color: str = "white",
    result: str = "1-0",
    played_at: object = None,
    platform: str = "lichess",
    ply_count: int = 10,
    white_blunders: int | None = None,
    black_blunders: int | None = None,
    white_mistakes: int | None = None,
    black_mistakes: int | None = None,
    white_inaccuracies: int | None = None,
    black_inaccuracies: int | None = None,
    analyzed: bool = True,
    white_rating: int | None = None,
    black_rating: int | None = None,
    time_control_str: str = "600+0",
    time_control_bucket: str | None = "blitz",
    white_accuracy: float | None = None,
    black_accuracy: float | None = None,
    initial_fen: str | None = None,
) -> object:
    """Insert a Game row, returning the persisted object.

    ply_count defaults to 10 so the macro per-100 denominator (floor/ceil(ply_count/2))
    yields 5 user moves for a white user. The white/black oracle move-quality columns
    feed the stats-panel inaccuracy rate (D-03) and the per-100 macro trend chart.

    analyzed (default True) marks the game as having full move-quality analysis:
    - Game.is_analyzed (white_blunders IS NOT NULL) — count_filtered_and_analyzed
      counts these toward analyzed_n. When analyzed and no explicit white_blunders
      is given, white_blunders defaults to 0 (analyzed, zero blunders); 0 and NULL
      are equivalent for the oracle trend.
    - full_evals_completed_at IS NOT NULL — _analyzed_game_ids_subquery gate
      (replaced per-ply eval-coverage recompute in quick-task 260617-pu4).
    Pass analyzed=False to seed a deliberately unanalyzed (e.g. chess.com) game.
    """
    import datetime as _dt
    import uuid

    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.game import Game as GameModel

    if analyzed and white_blunders is None:
        white_blunders = 0

    full_evals_completed_at = _dt.datetime.now(tz=_dt.timezone.utc) if analyzed else None

    sess = cast(AsyncSession, session)
    game = GameModel(
        user_id=user_id,
        platform=platform,
        platform_game_id=str(uuid.uuid4()),
        platform_url="https://lichess.org/test",
        pgn="1. e4 e5 *",
        result=result,
        user_color=user_color,
        time_control_str=time_control_str,
        time_control_bucket=time_control_bucket,
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
        ply_count=ply_count,
        white_blunders=white_blunders,
        black_blunders=black_blunders,
        white_mistakes=white_mistakes,
        black_mistakes=black_mistakes,
        white_inaccuracies=white_inaccuracies,
        black_inaccuracies=black_inaccuracies,
        white_rating=white_rating,
        black_rating=black_rating,
        white_accuracy=white_accuracy,
        black_accuracy=black_accuracy,
        played_at=played_at or _dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc),
        full_evals_completed_at=full_evals_completed_at,
        initial_fen=initial_fen,
    )
    sess.add(game)
    await sess.flush()
    return game


async def _seed_db_pos(
    session: object,
    *,
    game: object,
    ply: int,
    eval_cp: int | None = None,
    phase: int = 1,
    move_san: str | None = None,
) -> None:
    """Insert a GamePosition row."""
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.game import Game as GameModel
    from app.models.game_position import GamePosition as PosModel

    sess = cast(AsyncSession, session)
    g = cast(GameModel, game)
    pos = PosModel(
        game_id=g.id,
        user_id=g.user_id,
        ply=ply,
        full_hash=hash(f"f-{g.id}-{ply}"),
        white_hash=hash(f"w-{g.id}-{ply}"),
        black_hash=hash(f"b-{g.id}-{ply}"),
        move_san=move_san,
        clock_seconds=None,
        phase=phase,
        eval_cp=eval_cp,
        eval_mate=None,
        endgame_class=None,
    )
    sess.add(pos)
    await sess.flush()


class TestFlawStats:
    """get_flaw_stats: counts/rates, tag distribution, trend, denominator."""

    @pytest.mark.asyncio
    async def test_per_100_moves_and_counts(self, db_session: object) -> None:
        """1 user blunder over 5 user moves -> per_100_moves blunder == 20.0."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_flaw_stats
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99971)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        # White (user) game, plies 0..10 (11 positions, all evaled -> coverage 1.0).
        # Macro per-100 denominator = floor(ply_count/2) = floor(10/2) = 5 user moves.
        # game_positions provide eval coverage; game_flaws provide the M+B count.
        game = await _seed_db_game(session, user_id=99971, user_color="white", ply_count=10)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=prev_b)  # black clean
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white blunder
        for ply in range(3, 11):
            await _seed_db_pos(session, game=game, ply=ply, eval_cp=curr_b)  # flat -> clean
        # Seed one game_flaws row: blunder at ply 2 (white mover, phase=middlegame).
        await _seed_db_flaw(session, game=game, ply=2, severity=2, phase=1)

        resp = await get_flaw_stats(
            session,
            user_id=99971,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.per_severity_counts["blunder"] == 1
        assert resp.per_severity_counts["mistake"] == 0
        # No oracle inaccuracies seeded -> NULL -> 0.
        assert resp.per_severity_counts["inaccuracy"] == 0
        assert resp.analyzed_n == 1
        assert resp.total_n == 1
        assert resp.analyzed_pct == 1.0
        # Macro: single game, 1 blunder / 5 user moves * 100 = 20.0.
        assert resp.rates.per_100_moves["blunder"] == pytest.approx(20.0)
        assert resp.rates.per_100_moves["inaccuracy"] == 0.0
        # 1 blunder / 1 analyzed game = 1.0
        assert resp.rates.per_game["blunder"] == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_per_100_inaccuracy_from_oracle_columns(self, db_session: object) -> None:
        """Inaccuracy per-100 comes from the oracle columns (D-03), not game_flaws.

        White user, ply_count=10 -> 5 user moves, white_inaccuracies=2 -> 2/5*100=40.0.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_flaw_stats
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99981)

        # Analyzed (full eval coverage) white game with 2 oracle inaccuracies, no M+B.
        game = await _seed_db_game(
            session, user_id=99981, user_color="white", ply_count=10, white_inaccuracies=2
        )
        for ply in range(11):
            await _seed_db_pos(session, game=game, ply=ply, eval_cp=0)  # flat -> no M+B

        resp = await get_flaw_stats(
            session,
            user_id=99981,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.per_severity_counts["inaccuracy"] == 2
        assert resp.per_severity_counts["mistake"] == 0
        assert resp.per_severity_counts["blunder"] == 0
        # 2 inaccuracies / 5 user moves * 100 = 40.0
        assert resp.rates.per_100_moves["inaccuracy"] == pytest.approx(40.0)
        assert resp.rates.per_100_moves["blunder"] == 0.0

    @pytest.mark.asyncio
    async def test_per_100_is_macro_mean_of_per_game_rates(self, db_session: object) -> None:
        """per_100_moves is a MACRO mean of per-game rates, not a pooled (micro) rate.

        Game A: ply_count=10 (5 user moves), 1 blunder -> 20.0/100.
        Game B: ply_count=40 (20 user moves), 1 blunder -> 5.0/100.
        Macro mean = (20 + 5) / 2 = 12.5. (Micro/pooled would be 2/25*100 = 8.0.)
        This is the fix that makes the card equal the you-vs-opponent bullet's
        player_rate, which aggregates the same per-game-then-mean way.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_flaw_stats
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99982)

        # Game A — short: 10 plies, one white blunder at ply 2.
        game_a = await _seed_db_game(session, user_id=99982, user_color="white", ply_count=10)
        for ply in range(11):
            await _seed_db_pos(session, game=game_a, ply=ply, eval_cp=0)
        await _seed_db_flaw(session, game=game_a, ply=2, severity=2, phase=1)

        # Game B — long: 40 plies, one white blunder at ply 2.
        game_b = await _seed_db_game(session, user_id=99982, user_color="white", ply_count=40)
        for ply in range(41):
            await _seed_db_pos(session, game=game_b, ply=ply, eval_cp=0)
        await _seed_db_flaw(session, game=game_b, ply=2, severity=2, phase=1)

        resp = await get_flaw_stats(
            session,
            user_id=99982,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.analyzed_n == 2
        assert resp.per_severity_counts["blunder"] == 2
        # Macro mean of per-game rates: (20.0 + 5.0) / 2 = 12.5 (NOT the micro 8.0).
        assert resp.rates.per_100_moves["blunder"] == pytest.approx(12.5)

    @pytest.mark.asyncio
    async def test_reversed_rate_and_distribution(self, db_session: object) -> None:
        """1 reversed of 2 M+B flaws -> reversed_rate == 0.5."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_flaw_stats
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99972)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        # Two white (user) blunders. game_positions provide eval coverage.
        # game_flaws rows carry the tag columns (is_reversed, phase).
        game = await _seed_db_game(session, user_id=99972, user_color="white", result="1-0")
        win_cp = 800  # white-POV winning ES ~ >=0.85
        await _seed_db_pos(session, game=game, ply=0, eval_cp=win_cp, phase=1)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=win_cp, phase=1)  # black clean
        await _seed_db_pos(session, game=game, ply=2, eval_cp=0, phase=1)  # white blunder #1
        await _seed_db_pos(session, game=game, ply=3, eval_cp=0, phase=2)  # black clean
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_b, phase=2)  # white blunder #2
        for ply in range(5, 11):
            await _seed_db_pos(session, game=game, ply=ply, eval_cp=curr_b, phase=2)
        # Blunder #1: phase=middlegame (1), reversed=True (was winning >=0.70, dropped to <=0.30).
        # Blunder #2: phase=endgame (2), reversed=False (already losing on both sides).
        await _seed_db_flaw(session, game=game, ply=2, severity=2, phase=1, is_reversed=True)
        await _seed_db_flaw(session, game=game, ply=4, severity=2, phase=2, is_reversed=False)

        resp = await get_flaw_stats(
            session,
            user_id=99972,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.per_severity_counts["blunder"] == 2
        # exactly one of the two blunders is reversed -> rate == 0.5
        assert resp.tag_distribution.reversed_rate == pytest.approx(0.5)
        # phase histogram: blunder #1 phase=1=middlegame, blunder #2 phase=2=endgame
        hist = resp.tag_distribution.phase_histogram
        assert hist["middlegame"] == 1
        assert hist["endgame"] == 1
        # tempo: no clock data seeded -> all tempo counts are 0
        assert sum(resp.tag_distribution.tempo.values()) == 0

    @pytest.mark.asyncio
    async def test_trend_iso_week_macro_rates_from_oracle(self, db_session: object) -> None:
        """The trend is per-100-moves MACRO from oracle columns, bucketed by ISO week.

        10 white games in one ISO week, ply_count=10 (5 user moves), oracle
        blunders=1 / mistakes=0 / inaccuracies=2 each -> one point with
        blunder_rate=20, mistake_rate=0, inaccuracy_rate=40, dated the week's Monday.
        """
        import datetime as _dt

        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import FLAW_TREND_WINDOW, get_flaw_stats
        from app.services.openings_service import MIN_GAMES_FOR_TIMELINE
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99973)

        n_games = MIN_GAMES_FOR_TIMELINE  # exactly fills the partial-window floor
        played = _dt.datetime(2026, 6, 10, 12, 0, tzinfo=_dt.timezone.utc)  # all same ISO week
        for _ in range(n_games):
            game = await _seed_db_game(
                session,
                user_id=99973,
                user_color="white",
                ply_count=10,
                played_at=played,
                white_blunders=1,
                white_mistakes=0,
                white_inaccuracies=2,
            )
            # full_evals_completed_at is set by _seed_db_game (analyzed=True default);
            # positions no longer needed for the analyzed gate (260617-pu4 reversal).
            for ply in range(10):
                await _seed_db_pos(session, game=game, ply=ply, eval_cp=0)

        resp = await get_flaw_stats(
            session,
            user_id=99973,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.trend_window == FLAW_TREND_WINDOW
        assert len(resp.trend) == 1
        pt = resp.trend[0]
        iso = played.isocalendar()
        assert pt.date == _dt.date.fromisocalendar(iso.year, iso.week, 1).isoformat()
        assert pt.games_in_window == n_games
        assert pt.per_week_games == n_games
        assert pt.blunder_rate == pytest.approx(20.0)  # 1 / 5 * 100
        assert pt.mistake_rate == pytest.approx(0.0)
        assert pt.inaccuracy_rate == pytest.approx(40.0)  # 2 / 5 * 100

    @pytest.mark.asyncio
    async def test_empty_analyzed_set_returns_zeros(self, db_session: object) -> None:
        """A chess.com-only (unanalyzed) filtered set -> zeros, empty trend, no raise."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_flaw_stats
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99974)

        game = await _seed_db_game(
            session, user_id=99974, user_color="white", platform="chess.com", analyzed=False
        )
        for ply in range(10):
            await _seed_db_pos(session, game=game, ply=ply, eval_cp=None)  # no eval

        resp = await get_flaw_stats(
            session,
            user_id=99974,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.total_n == 1
        assert resp.analyzed_n == 0
        assert resp.analyzed_pct == 0.0
        assert resp.per_severity_counts["blunder"] == 0
        assert resp.rates.per_100_moves["blunder"] == 0.0
        assert resp.trend == []

    @pytest.mark.asyncio
    async def test_miss_rate_and_lucky_rate(self, db_session: object) -> None:
        """1 miss + 1 lucky out of 2 M+B flaws -> rates == 0.5 each.

        D-02 migration: seeds game_flaws rows directly (is_miss / is_lucky
        boolean columns) instead of calling the retired _compute_tag_distribution
        with hand-crafted FlawRecord objects. The API (get_flaw_stats) reads from
        game_flaws via fetch_stats_aggregates (COUNT(*) FILTER aggregates).
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_flaw_stats
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99975)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        # White (user) game, plies 0..10 all evaled -> full coverage -> analyzed.
        win_cp = 800
        game = await _seed_db_game(session, user_id=99975, user_color="white", result="1-0")
        await _seed_db_pos(session, game=game, ply=0, eval_cp=win_cp)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=win_cp)  # black clean
        await _seed_db_pos(session, game=game, ply=2, eval_cp=0)  # white blunder #1
        await _seed_db_pos(session, game=game, ply=3, eval_cp=0)  # black clean
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_b)  # white blunder #2
        for ply in range(5, 11):
            await _seed_db_pos(session, game=game, ply=ply, eval_cp=curr_b)

        # Seed two game_flaws rows: blunder #1 is a miss, blunder #2 is a lucky.
        await _seed_db_flaw(session, game=game, ply=2, severity=2, phase=1, is_miss=True)
        await _seed_db_flaw(session, game=game, ply=4, severity=2, phase=2, is_lucky=True)

        resp = await get_flaw_stats(
            session,
            user_id=99975,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
        )
        assert resp.per_severity_counts["blunder"] == 2
        assert resp.tag_distribution.miss_rate == pytest.approx(0.5)
        assert resp.tag_distribution.lucky_rate == pytest.approx(0.5)
        assert resp.tag_distribution.reversed_rate == 0.0

    def test_reversed_rate(self) -> None:
        """1 reversed of 2 M+B flaws -> reversed_rate == 0.5 (pure unit test).

        D-02 migration: calls _build_tag_distribution with direct keyword aggregates
        (from the SQL COUNT(*) FILTER scan) instead of the retired
        _compute_tag_distribution(_GameFlaws) per-game FlawRecord loop.
        """
        from app.services.library_service import _build_tag_distribution

        dist = _build_tag_distribution(
            mistake_count=0,
            blunder_count=2,
            tempo_low_clock=0,
            tempo_hasty=0,
            tempo_unrushed=0,
            is_reversed=1,
            is_miss=1,
            is_lucky=0,
            is_squandered=0,
            phase_opening=0,
            phase_middlegame=1,
            phase_endgame=1,
        )
        assert dist.reversed_rate == pytest.approx(0.5)
        assert dist.miss_rate == pytest.approx(0.5)
        assert dist.lucky_rate == 0.0

    def test_rates_zero_when_no_mb_flaws(self) -> None:
        """0 M+B flaws -> all four rates are 0.0 (no ZeroDivisionError).

        D-02 migration: calls _build_tag_distribution with all-zero aggregates
        instead of the retired _compute_tag_distribution([]).
        """
        from app.services.library_service import _build_tag_distribution

        dist = _build_tag_distribution(
            mistake_count=0,
            blunder_count=0,
            tempo_low_clock=0,
            tempo_hasty=0,
            tempo_unrushed=0,
            is_reversed=0,
            is_miss=0,
            is_lucky=0,
            is_squandered=0,
            phase_opening=0,
            phase_middlegame=0,
            phase_endgame=0,
        )
        assert dist.miss_rate == 0.0
        assert dist.lucky_rate == 0.0
        assert dist.reversed_rate == 0.0
        assert dist.squandered_rate == 0.0


# ---------------------------------------------------------------------------
# TestGetLibraryGame (-k get_library_game) — single-game card (Plan 112-02, SC-7)
# ---------------------------------------------------------------------------


class TestGetLibraryGame:
    """get_library_game: single-game card builder for the analysis-page view.

    Plan 112-02 (SC-7): GET /api/library/games/{game_id} returns one GameFlawCard.
    Quick 260717-agv: NOT owner-scoped — returns the owner's card for any game
    (own or another user's), None only for a missing game (→ 404 at the router).
    No router dependency — service-level only.
    """

    @pytest.mark.asyncio
    async def test_own_game_returns_card(self, db_session: object) -> None:
        """get_library_game returns a GameFlawCard for a game owned by the user.

        Seeds user A with an analyzed game (10 positions, >=90% eval coverage)
        and one game_flaw row. Asserts the returned card has the expected game_id
        and a non-null analysis_state.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.schemas.library import GameFlawCard
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99980)

        game_obj = await _seed_db_game(session, user_id=99980, user_color="white", result="1-0")
        game = cast(GameModel, game_obj)
        # Seed 10 positions, 9 with eval_cp (coverage = 9/10 = 0.9 >= EVAL_COVERAGE_MIN)
        for ply in range(9):
            await _seed_db_pos(session, game=game, ply=ply, eval_cp=0)
        # Final position: no eval (standard lichess convention)
        await _seed_db_pos(session, game=game, ply=9, eval_cp=None)
        # One blunder flaw
        await _seed_db_flaw(session, game=game, ply=2, severity=2, phase=1)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None, "Expected a GameFlawCard for own game, got None"
        assert isinstance(card, GameFlawCard), f"Expected GameFlawCard, got {type(card)}"
        assert card.game_id == game.id

    @pytest.mark.asyncio
    async def test_cross_user_returns_card(self, db_session: object) -> None:
        """get_library_game returns the owner's card for a cross-user request (Quick 260717-agv).

        Seeds user A with a game. The analysis-page view is intentionally NOT
        owner-scoped, so a request for that game_id (any logged-in user) returns
        user A's card scoped to user A's data — not None. "Logged in" is the only
        gate, enforced by the router's current_active_user dependency.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99981)  # user A (owner)
        await ensure_test_user(session, 99982)  # user B (requester)

        game_obj = await _seed_db_game(session, user_id=99981, user_color="white", result="1-0")
        game_a = cast(GameModel, game_obj)

        # A different logged-in user may inspect user A's game (opponent scouting).
        result = await get_library_game(session, game_id=game_a.id)
        assert result is not None, "cross-user analysis view must return the owner's card"
        assert result.game_id == game_a.id

    @pytest.mark.asyncio
    async def test_missing_game_returns_none(self, db_session: object) -> None:
        """get_library_game returns None for a non-existent game_id."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99983)

        result = await get_library_game(session, game_id=999999999)
        assert result is None, f"Expected None for non-existent game_id, got {result}"

    @pytest.mark.asyncio
    async def test_chesscom_blitz_card_has_higher_normalized_rating(
        self, db_session: object
    ) -> None:
        """A chess.com blitz game's normalized rating is higher than the raw rating.

        Phase 164 (SEED-093): white_rating_lichess_blitz reflects the
        Lichess-Blitz-equivalent (via normalize_to_lichess_blitz's
        chess.com-Blitz -> Table 2 chain), while the raw white_rating field is
        untouched. Rating 1500 is a known Table 2 anchor mapping to 1780.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99990)

        game_obj = await _seed_db_game(
            session,
            user_id=99990,
            user_color="white",
            platform="chess.com",
            time_control_str="600",
            time_control_bucket="blitz",
            white_rating=1500,
            black_rating=1500,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_rating == 1500, "raw white_rating must stay unchanged"
        assert card.black_rating == 1500, "raw black_rating must stay unchanged"
        assert card.white_rating_lichess_blitz == 1780
        assert card.black_rating_lichess_blitz == 1780
        assert card.white_rating_lichess_blitz > card.white_rating

    @pytest.mark.asyncio
    async def test_correspondence_game_card_has_none_normalized_ratings(
        self, db_session: object
    ) -> None:
        """A chess.com Daily (correspondence) game gets None for both normalized fields.

        Phase 164 (SEED-093, Pitfall 1): is_correspondence_time_control detects the
        "1/{seconds}" separator in time_control_str regardless of the
        time_control_bucket the game landed in; raw ratings stay populated.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99991)

        game_obj = await _seed_db_game(
            session,
            user_id=99991,
            user_color="white",
            platform="chess.com",
            time_control_str="1/172800",
            time_control_bucket="classical",
            white_rating=1500,
            black_rating=1500,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_rating == 1500
        assert card.black_rating == 1500
        assert card.white_rating_lichess_blitz is None
        assert card.black_rating_lichess_blitz is None

    @pytest.mark.asyncio
    async def test_null_rating_card_has_none_normalized_ratings(self, db_session: object) -> None:
        """A game with NULL ratings serializes None normalized fields without raising."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99992)

        game_obj = await _seed_db_game(
            session,
            user_id=99992,
            user_color="white",
            platform="lichess",
            white_rating=None,
            black_rating=None,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_rating is None
        assert card.black_rating is None
        assert card.white_rating_lichess_blitz is None
        assert card.black_rating_lichess_blitz is None

    @pytest.mark.asyncio
    async def test_accuracy_round_trips_from_canonical_columns(self, db_session: object) -> None:
        """Phase 179 (D-01): white_accuracy/black_accuracy pass through from the
        canonical Game columns, and NULL accuracy serializes as None."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99994)

        game_obj = await _seed_db_game(
            session,
            user_id=99994,
            user_color="white",
            platform="lichess",
            white_accuracy=91.23,
            black_accuracy=78.4,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_accuracy == 91.23
        assert card.black_accuracy == 78.4

    @pytest.mark.asyncio
    async def test_null_accuracy_card_has_none_accuracy(self, db_session: object) -> None:
        """A game with NULL canonical accuracy serializes both fields as None."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99995)

        game_obj = await _seed_db_game(
            session,
            user_id=99995,
            user_color="white",
            platform="lichess",
            white_accuracy=None,
            black_accuracy=None,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_accuracy is None
        assert card.black_accuracy is None

    @pytest.mark.asyncio
    async def test_chesscom_classical_noncorrespondence_card_has_normalized_rating(
        self, db_session: object
    ) -> None:
        """A chess.com classical-bucket, non-correspondence game normalizes via rapid.

        Phase 164 gap closure (WR-01 / Truth #13): a classical-bucketed
        chess.com game that is a genuine long real-time game (not Daily, e.g.
        "1800+30" — no "/" separator, so is_correspondence_time_control
        returns False) now normalizes via the rapid column instead of
        falling back to the raw rating (which was the None-returning bug
        this plan closes).
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.chesscom_to_lichess import convert_chesscom_to_lichess
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99993)

        game_obj = await _seed_db_game(
            session,
            user_id=99993,
            user_color="white",
            platform="chess.com",
            time_control_str="1800+30",
            time_control_bucket="classical",
            white_rating=1500,
            black_rating=1500,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_rating == 1500, "raw white_rating must stay unchanged"
        assert card.black_rating == 1500, "raw black_rating must stay unchanged"
        expected = convert_chesscom_to_lichess(1500, "rapid", "blitz")
        assert expected is not None
        assert card.white_rating_lichess_blitz == expected
        assert card.black_rating_lichess_blitz == expected

    @pytest.mark.asyncio
    async def test_flawchess_rapid_card_has_identity_normalized_rating(
        self, db_session: object
    ) -> None:
        """A flawchess bot-practice game's rating is never double-converted.

        Phase 167 (RESEARCH Pitfall 3): normalize_to_lichess_blitz has only
        chess.com/lichess branches. A flawchess game's stored rating is ALREADY
        lichess-blitz-equivalent (STORE-03's anchor_rating), so routing it
        through the lichess branch's Table-2 inversion for a non-blitz bucket
        (rapid here) would silently apply a second, spurious conversion.
        _build_card's platform=='flawchess' guard must pass the raw rating
        through unchanged for both colors.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99994)

        game_obj = await _seed_db_game(
            session,
            user_id=99994,
            user_color="white",
            platform="flawchess",
            time_control_str="600+0",
            time_control_bucket="rapid",
            white_rating=1500,
            black_rating=1400,
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.white_rating == 1500
        assert card.black_rating == 1400
        assert card.white_rating_lichess_blitz == 1500, "flawchess rating must not be re-converted"
        assert card.black_rating_lichess_blitz == 1400, "flawchess rating must not be re-converted"

    @pytest.mark.asyncio
    async def test_unanalyzed_game_with_positions_carries_moves_and_phase_transitions(
        self, db_session: object
    ) -> None:
        """Quick 260714-rj5: an unanalyzed game with positions gets moves + phase_transitions.

        eval_series/flaw_markers/severity_counts stay None (no evals to synthesize),
        chips stay [], analysis_state stays 'no_engine_analysis' — this is the
        fix for the empty-board dead end on an unanalyzed/pending single-game card.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99995)

        game_obj = await _seed_db_game(
            session, user_id=99995, user_color="white", result="1-0", analyzed=False
        )
        game = cast(GameModel, game_obj)
        await _seed_db_pos(session, game=game, ply=0, phase=0, move_san="e4")
        await _seed_db_pos(session, game=game, ply=1, phase=0, move_san="e5")
        await _seed_db_pos(session, game=game, ply=2, phase=1, move_san="Nf3")
        # Terminal position: move_san is None and must be filtered out of moves.
        await _seed_db_pos(session, game=game, ply=3, phase=1, move_san=None)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.analysis_state == "no_engine_analysis"
        assert card.moves == ["e4", "e5", "Nf3"]
        assert card.phase_transitions is not None
        assert card.phase_transitions.middlegame_ply == 2
        assert card.eval_series is None
        assert card.flaw_markers is None
        assert card.severity_counts is None
        assert card.chips == []

    @pytest.mark.asyncio
    async def test_unanalyzed_game_with_no_positions_has_none_moves(
        self, db_session: object
    ) -> None:
        """Quick 260714-rj5: an unanalyzed game with zero positions gets moves=None (not [])."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99996)

        game_obj = await _seed_db_game(
            session, user_id=99996, user_color="white", result="1-0", analyzed=False
        )
        game = cast(GameModel, game_obj)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.analysis_state == "no_engine_analysis"
        assert card.moves is None
        assert card.phase_transitions is None

    @pytest.mark.asyncio
    async def test_analyzed_game_moves_and_eval_series_unchanged(self, db_session: object) -> None:
        """Quick 260714-rj5: an analyzed game's card is byte-for-byte unchanged.

        Same moves, eval_series, flaw_markers, phase_transitions as before this
        plan's change — the always-fetch-positions path only affects the
        unanalyzed branch's moves/phase_transitions.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99997)

        game_obj = await _seed_db_game(session, user_id=99997, user_color="white", result="1-0")
        game = cast(GameModel, game_obj)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=0, phase=0, move_san="e4")
        await _seed_db_pos(session, game=game, ply=1, eval_cp=0, phase=0, move_san="e5")
        await _seed_db_pos(session, game=game, ply=2, eval_cp=0, phase=1, move_san="Nf3")
        await _seed_db_pos(session, game=game, ply=3, eval_cp=None, phase=1, move_san=None)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.analysis_state == "analyzed"
        assert card.moves == ["e4", "e5", "Nf3"]
        assert card.eval_series is not None
        assert card.flaw_markers is not None
        assert card.phase_transitions is not None
        assert card.phase_transitions.middlegame_ply == 2
        assert card.severity_counts is not None

    @pytest.mark.asyncio
    async def test_known_opening_game_has_nonzero_opening_ply_count(
        self, db_session: object
    ) -> None:
        """Phase 172 (SEED-106 D-06): a known-opening game's card carries the
        trie's matched ply depth, computed on-read from moves.

        1. e4 e5 2. Nf3 matches C40 King's Knight Opening at ply depth 3
        (see tests/test_opening_lookup.py::TestFindOpeningPlyCount, kept in
        lockstep with this fixture).
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99998)

        game_obj = await _seed_db_game(session, user_id=99998, user_color="white", result="1-0")
        game = cast(GameModel, game_obj)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=0, phase=0, move_san="e4")
        await _seed_db_pos(session, game=game, ply=1, eval_cp=0, phase=0, move_san="e5")
        await _seed_db_pos(session, game=game, ply=2, eval_cp=0, phase=0, move_san="Nf3")
        await _seed_db_pos(session, game=game, ply=3, eval_cp=None, phase=1, move_san=None)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.moves == ["e4", "e5", "Nf3"]
        assert card.opening_ply_count == 3

    @pytest.mark.asyncio
    async def test_unmatched_opening_game_has_zero_opening_ply_count(
        self, db_session: object
    ) -> None:
        """A game whose first move isn't in the opening trie gets opening_ply_count 0."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99999)

        game_obj = await _seed_db_game(session, user_id=99999, user_color="white", result="1-0")
        game = cast(GameModel, game_obj)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=0, phase=0, move_san="ZZUnknown")
        await _seed_db_pos(session, game=game, ply=1, eval_cp=None, phase=1, move_san=None)

        card = await get_library_game(session, game_id=game.id)

        assert card is not None
        assert card.moves == ["ZZUnknown"]
        assert card.opening_ply_count == 0


# ---------------------------------------------------------------------------
# TestActiveEvalStatus — active_eval_status field on GameFlawCard (260615-q1x)
# ---------------------------------------------------------------------------


class TestActiveEvalStatus:
    """GameFlawCard.active_eval_status reflects the active eval-job state per game.

    Covers pending / leased / absent cases for both get_library_games and
    get_library_game. Tests seed EvalJob rows directly and assert the field
    on the returned card(s). T-q1x-01 IDOR mitigation: game_ids are already
    user-scoped by the time they reach fetch_page_active_eval_status.
    """

    @pytest.mark.asyncio
    async def test_pending_job_surfaces_on_games_list(self, db_session: object) -> None:
        """get_library_games: a pending eval_jobs row → card.active_eval_status == 'pending'."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.eval_jobs import EvalJob
        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99984)

        game_obj = await _seed_db_game(session, user_id=99984, user_color="white", analyzed=False)
        game = cast(GameModel, game_obj)
        job = EvalJob(tier=1, user_id=99984, game_id=game.id, status="pending")
        session.add(job)
        await session.flush()

        resp = await get_library_games(
            session,
            user_id=99984,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        assert resp.matched_count == 1
        card = resp.games[0]
        assert card.active_eval_status == "pending", (
            f"Expected 'pending', got {card.active_eval_status!r}"
        )

    @pytest.mark.asyncio
    async def test_leased_job_surfaces_on_games_list(self, db_session: object) -> None:
        """get_library_games: a leased eval_jobs row → card.active_eval_status == 'leased'."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.eval_jobs import EvalJob
        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99985)

        game_obj = await _seed_db_game(session, user_id=99985, user_color="white", analyzed=False)
        game = cast(GameModel, game_obj)
        job = EvalJob(tier=1, user_id=99985, game_id=game.id, status="leased")
        session.add(job)
        await session.flush()

        resp = await get_library_games(
            session,
            user_id=99985,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        assert resp.matched_count == 1
        card = resp.games[0]
        assert card.active_eval_status == "leased", (
            f"Expected 'leased', got {card.active_eval_status!r}"
        )

    @pytest.mark.asyncio
    async def test_no_active_job_returns_none_on_games_list(self, db_session: object) -> None:
        """get_library_games: no active eval_jobs row → card.active_eval_status is None."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99986)

        await _seed_db_game(session, user_id=99986, user_color="white", analyzed=False)

        resp = await get_library_games(
            session,
            user_id=99986,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        assert resp.matched_count == 1
        card = resp.games[0]
        assert card.active_eval_status is None, f"Expected None, got {card.active_eval_status!r}"

    @pytest.mark.asyncio
    async def test_pending_job_surfaces_on_single_game(self, db_session: object) -> None:
        """get_library_game: a pending eval_jobs row → card.active_eval_status == 'pending'."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.eval_jobs import EvalJob
        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99987)

        game_obj = await _seed_db_game(session, user_id=99987, user_color="white", analyzed=False)
        game = cast(GameModel, game_obj)
        job = EvalJob(tier=1, user_id=99987, game_id=game.id, status="pending")
        session.add(job)
        await session.flush()

        card = await get_library_game(session, game_id=game.id)
        assert card is not None
        assert card.active_eval_status == "pending", (
            f"Expected 'pending', got {card.active_eval_status!r}"
        )

    @pytest.mark.asyncio
    async def test_completed_job_not_exposed(self, db_session: object) -> None:
        """A completed eval_jobs row does not surface as active_eval_status."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.eval_jobs import EvalJob
        from app.models.game import Game as GameModel
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99988)

        game_obj = await _seed_db_game(session, user_id=99988, user_color="white", analyzed=False)
        game = cast(GameModel, game_obj)
        job = EvalJob(tier=1, user_id=99988, game_id=game.id, status="completed")
        session.add(job)
        await session.flush()

        card = await get_library_game(session, game_id=game.id)
        assert card is not None
        assert card.active_eval_status is None, (
            f"Completed job must not surface as active, got {card.active_eval_status!r}"
        )


# ---------------------------------------------------------------------------
# Tests for tactic per-slot suppression in the Games path (_build_card /
# get_library_games) — Quick 260621-sm8 scenario (d).
# ---------------------------------------------------------------------------

# TacticMotifInt values matching FAMILY_TO_MOTIF_INTS (no magic numbers).
_FORK_INT = 1  # TacticMotifInt.FORK
_DISCOVERED_ATTACK_INT = 6  # TacticMotifInt.DISCOVERED_ATTACK


async def _seed_tactic_flaw_for_game(
    session: object,
    *,
    game: object,
    ply: int,
    severity: int = 2,
    missed_motif: int | None = None,
    missed_conf: int | None = None,
    missed_depth: int | None = None,
    allowed_motif: int | None = None,
    allowed_conf: int | None = None,
    allowed_depth: int | None = None,
) -> None:
    """Insert a GameFlaw with tactic fields for Games-path tests."""
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.game import Game as GameModel
    from app.models.game_flaw import GameFlaw

    sess = cast(AsyncSession, session)
    g = cast(GameModel, game)
    flaw = GameFlaw(
        user_id=g.user_id,
        game_id=g.id,
        ply=ply,
        severity=severity,
        phase=1,
        is_miss=False,
        is_lucky=False,
        is_reversed=False,
        is_squandered=False,
        fen="",
        missed_tactic_motif=missed_motif,
        missed_tactic_confidence=missed_conf,
        missed_tactic_depth=missed_depth,
        allowed_tactic_motif=allowed_motif,
        allowed_tactic_confidence=allowed_conf,
        allowed_tactic_depth=allowed_depth,
    )
    sess.add(flaw)
    await sess.flush()


class TestBuildCardTacticPerSlotSuppression:
    """get_library_games / _build_card (Quick 260702-mnd: cards show all tactic slots).

    Quick 260702-mnd removed the filter/severity pruning from _build_card's
    tactic_by_ply construction — a selected card is now a complete picture of
    its own tactic tags, regardless of the active tactic/severity filter (which
    still only selects WHICH games appear, via query_filtered_games). Tests use
    separate user_id values to avoid cross-test leakage in the rollback-scoped
    db_session.
    """

    @pytest.mark.asyncio
    async def test_orientation_filter_nulls_excluded_slot_in_flaw_markers(
        self, db_session: object
    ) -> None:
        """orientation='missed' → allowed slot is nulled in flaw_markers.

        Validates the FLAWS SUBTAB path (query_flaws), which still prunes
        per-slot by the active orientation/family/depth filter (each Flaws row
        IS a matching flaw — pruning is correct there). This is NOT the Games
        card path (_build_card no longer prunes, Quick 260702-mnd) — kept
        unchanged as a regression guard for query_flaws.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.repositories.library_repository import query_flaws
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99989
        await ensure_test_user(session, uid)

        game = await _seed_db_game(session, user_id=uid, user_color="white", ply_count=10)

        # Both slots populated with confident tactic motifs.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
            allowed_motif=_DISCOVERED_ATTACK_INT,
            allowed_conf=75,
            allowed_depth=0,
        )

        # Query via the Flaws path with orientation='missed' — shared predicate with _build_card.
        items, count = await query_flaws(
            session,
            user_id=uid,
            severity=[],
            tags=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
            tactic_families=[],
            orientation="missed",
            min_tactic_depth=None,
            max_tactic_depth=None,
        )
        assert count == 1
        item = items[0]
        # missed slot: populated (in scope for orientation='missed')
        assert item.missed_tactic_motif == "fork"
        assert item.missed_tactic_confidence == 80
        # allowed slot: nulled (orientation='missed' excludes it)
        assert item.allowed_tactic_motif is None
        assert item.allowed_tactic_confidence is None
        assert item.allowed_tactic_depth is None

    @pytest.mark.asyncio
    async def test_default_filter_both_slots_populated_in_games_response(
        self, db_session: object
    ) -> None:
        """Default tactic filter in get_library_games: both slots populated (regression guard).

        With no tactic controls active, _build_card must not suppress any slot.
        Positions seed a blunder drop at ply 2 so _build_eval_series produces a
        flaw_marker there, which then picks up the tactic chip from tactic_by_ply.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.flaws_service import BLUNDER_DROP
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99990
        await ensure_test_user(session, uid)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)

        # 5-ply game: positions 0..4 with a white (even ply) blunder at ply 2.
        game = await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4)

        # Positions seeded with an eval drop at ply 2 so _build_eval_series detects a blunder.
        await _seed_db_pos(session, game=game, ply=0, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=prev_b)  # black: flat
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white: blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=curr_b)
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_b)

        # Tactic flaw at ply 2 (white user move: even ply, user_color='white').
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
            allowed_motif=_DISCOVERED_ATTACK_INT,
            allowed_conf=75,
            allowed_depth=0,
        )

        resp = await get_library_games(
            session,
            user_id=uid,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            flaw_tags=None,
            tactic_families=None,  # default: no family filter
            tactic_orientation="either",  # default
            min_tactic_depth=None,  # default: no depth filter
            max_tactic_depth=None,
            offset=0,
            limit=20,
        )
        assert len(resp.games) == 1
        card = resp.games[0]

        # Card must have flaw_markers (analyzed game with positions).
        assert card.flaw_markers is not None

        # Find the user's flaw marker at ply 2.
        user_markers = [fm for fm in card.flaw_markers if fm.is_user]
        assert len(user_markers) >= 1
        ply2_marker = next((fm for fm in user_markers if fm.ply == 2), None)
        assert ply2_marker is not None, "Expected a flaw_marker at ply 2"

        # Both slots must be populated (default filter, no suppression).
        assert ply2_marker.missed_tactic_motif == "fork"
        assert ply2_marker.allowed_tactic_motif == "discovered-attack"

    @pytest.mark.asyncio
    async def test_single_game_shows_all_tactic_slots_depth_filter_removed(
        self, db_session: object
    ) -> None:
        """get_library_game (the "View game" modal path) shows all slots (Quick 260702-mnd).

        The single-game endpoint no longer accepts tactic filter params at all
        (D-3 dead-param removal) — a would-have-been depth-1-2 filter has no way
        to reach _build_card. Both slots must be populated regardless of the
        (now nonexistent) depth range, since one slot's raw depth would have
        anchored well outside any narrow range under the old pruning behavior.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.flaws_service import BLUNDER_DROP
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99991
        await ensure_test_user(session, uid)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)

        game = cast(
            GameModel,
            await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4),
        )
        await _seed_db_pos(session, game=game, ply=0, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=prev_b)  # black: flat
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white: blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=curr_b)
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_b)

        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
            allowed_motif=_DISCOVERED_ATTACK_INT,
            allowed_conf=75,
            allowed_depth=10,  # would have anchored outside a [1, 2] range under old pruning
        )

        card = await get_library_game(session, game_id=game.id)
        assert card is not None
        assert card.flaw_markers is not None
        ply2_marker = next((fm for fm in card.flaw_markers if fm.is_user and fm.ply == 2), None)
        assert ply2_marker is not None, "Expected a flaw_marker at ply 2"

        # Both slots populated — no filter pruning on the single-game card.
        assert ply2_marker.missed_tactic_motif == "fork"
        assert ply2_marker.missed_tactic_depth == 1
        assert ply2_marker.allowed_tactic_motif == "discovered-attack"
        assert ply2_marker.allowed_tactic_confidence == 75
        assert ply2_marker.allowed_tactic_depth == 10

    @pytest.mark.asyncio
    async def test_single_game_default_filter_unaffected(self, db_session: object) -> None:
        """get_library_game with no tactic params leaves both slots populated (Quick 260621-sm8).

        A direct game open (no active filter) must not suppress anything.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.flaws_service import BLUNDER_DROP
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99992
        await ensure_test_user(session, uid)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)

        game = cast(
            GameModel,
            await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4),
        )
        await _seed_db_pos(session, game=game, ply=0, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)
        await _seed_db_pos(session, game=game, ply=3, eval_cp=curr_b)
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_b)

        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
            allowed_motif=_DISCOVERED_ATTACK_INT,
            allowed_conf=75,
            allowed_depth=10,
        )

        # No tactic params → defaults → no suppression.
        card = await get_library_game(session, game_id=game.id)
        assert card is not None
        assert card.flaw_markers is not None
        ply2_marker = next((fm for fm in card.flaw_markers if fm.is_user and fm.ply == 2), None)
        assert ply2_marker is not None
        assert ply2_marker.missed_tactic_motif == "fork"
        assert ply2_marker.allowed_tactic_motif == "discovered-attack"

    @pytest.mark.asyncio
    async def test_severity_filter_no_longer_gates_tactic_slots_in_games_response(
        self, db_session: object
    ) -> None:
        """Severity filter selects games but no longer prunes tactic chips (Quick 260702-mnd, D-1).

        Reverses the pre-260702-mnd behavior: the severity gate that used to null
        non-matching-severity tactic slots in _build_card is removed (D-1 — kept
        consistent with context chips, which never pruned by severity). The game
        has a white blunder at ply 2 and a white mistake at ply 4, each with a
        tactic. Under EVERY flaw_severity value the game is selected (it always has
        at least one matching-severity flaw) and BOTH plies' tactics survive on the
        returned card.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.schemas.library import FlawMarker
        from app.services.flaws_service import BLUNDER_DROP, MISTAKE_DROP
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99993
        await ensure_test_user(session, uid)

        _, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        _, curr_m = _cp_for_white_drop(MISTAKE_DROP)

        # White (even ply) blunders at ply 2, recovers, then makes a mistake at ply 4.
        game = await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=0)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=0)
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=0)  # recover
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_m)  # white mistake

        # Blunder flaw (severity=2) with a tactic at ply 2.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            severity=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )
        # Mistake flaw (severity=1) with a tactic at ply 4.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=4,
            severity=1,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )

        async def _markers_for_severity(severity: list[str]) -> dict[int, FlawMarker]:
            resp = await get_library_games(
                session,
                user_id=uid,
                time_control=None,
                platform=None,
                rated=None,
                opponent_type="all",
                from_date=None,
                to_date=None,
                flaw_severity=severity,
                flaw_tags=None,
                tactic_families=None,
                tactic_orientation="either",
                min_tactic_depth=None,
                max_tactic_depth=None,
                offset=0,
                limit=20,
            )
            assert len(resp.games) == 1
            assert resp.games[0].flaw_markers is not None
            return {fm.ply: fm for fm in resp.games[0].flaw_markers if fm.is_user}

        # Sanity: the two user markers carry the expected severities (drops classified right).
        markers = await _markers_for_severity(["blunder"])
        assert markers[2].severity == "blunder"
        assert markers[4].severity == "mistake"

        # "Blunders only": the game is selected (has a blunder), but BOTH plies'
        # tactics survive — severity no longer prunes tactic tags (D-1).
        assert markers[2].missed_tactic_motif == "fork"
        assert markers[4].missed_tactic_motif == "fork"

        # "Mistakes only": same — both tactics still survive.
        markers = await _markers_for_severity(["mistake"])
        assert markers[4].missed_tactic_motif == "fork"
        assert markers[2].missed_tactic_motif == "fork"

        # Both tiers selected: both tactics survive (unchanged).
        markers = await _markers_for_severity(["blunder", "mistake"])
        assert markers[2].missed_tactic_motif == "fork"
        assert markers[4].missed_tactic_motif == "fork"

    @pytest.mark.asyncio
    async def test_single_game_shows_all_severities_severity_param_removed(
        self, db_session: object
    ) -> None:
        """get_library_game (the "View game" modal path) shows all tactic slots (Quick 260702-mnd, D-3).

        The single-game endpoint no longer accepts a severity param at all (D-3
        dead-param removal) — both plies' tactics always survive, matching the
        Games list's new selection-only severity semantics (D-1).
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.flaws_service import BLUNDER_DROP, MISTAKE_DROP
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99994
        await ensure_test_user(session, uid)

        _, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        _, curr_m = _cp_for_white_drop(MISTAKE_DROP)

        game = cast(
            GameModel,
            await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4),
        )
        await _seed_db_pos(session, game=game, ply=0, eval_cp=0)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=0)
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=0)  # recover
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_m)  # white mistake
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            severity=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=4,
            severity=1,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )

        # Single-game open: both plies' tactics always survive (no severity param exists).
        card = await get_library_game(session, game_id=game.id)
        assert card is not None
        assert card.flaw_markers is not None
        by_ply = {fm.ply: fm for fm in card.flaw_markers if fm.is_user}
        assert by_ply[2].missed_tactic_motif == "fork"
        assert by_ply[4].missed_tactic_motif == "fork"

    @pytest.mark.asyncio
    async def test_games_filter_selects_only_card_content_shows_every_motif(
        self, db_session: object
    ) -> None:
        """Lock-in test (Quick 260702-mnd): active tactic filter selects, never prunes.

        Seeds two tactic flaws: ply 2 (fork, depth anchored in-range) matches an
        active tactic_families=["fork"] + depth [1, 2] filter (so the game is
        SELECTED via query_filtered_games' EXISTS predicate); ply 4
        (discovered-attack, depth anchored well outside the range) does NOT match
        the filter on either axis. Under the pre-260702-mnd per-slot pruning
        behavior, ply 4's tactic would have been nulled on the card. It must now
        survive alongside ply 2's, proving the filter only selects games and no
        longer prunes card content.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.flaws_service import BLUNDER_DROP, MISTAKE_DROP
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99995
        await ensure_test_user(session, uid)

        _, curr_b = _cp_for_white_drop(BLUNDER_DROP)
        _, curr_m = _cp_for_white_drop(MISTAKE_DROP)

        game = await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=0)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=0)
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=0)  # recover
        await _seed_db_pos(session, game=game, ply=4, eval_cp=curr_m)  # white mistake

        # Matches the active filter (family=fork, depth in [1, 2]) -> selects the game.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            severity=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )
        # Does NOT match the active filter (wrong family, depth anchored well outside
        # [1, 2]) -> would have been nulled under the old per-slot pruning behavior.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=4,
            severity=1,
            missed_motif=_DISCOVERED_ATTACK_INT,
            missed_conf=75,
            missed_depth=10,
        )

        resp = await get_library_games(
            session,
            user_id=uid,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            flaw_tags=None,
            tactic_families=["fork"],
            tactic_orientation="either",
            min_tactic_depth=1,
            max_tactic_depth=2,
            offset=0,
            limit=20,
        )
        # Game selection still works (ply 2's flaw matches the EXISTS predicate).
        assert len(resp.games) == 1
        card = resp.games[0]
        assert card.flaw_markers is not None
        by_ply = {fm.ply: fm for fm in card.flaw_markers if fm.is_user}

        # Both seeded motifs survive on the card despite the active filter — the
        # non-matching ply-4 tactic is NOT pruned (selection-only semantics).
        assert by_ply[2].missed_tactic_motif == "fork"
        assert by_ply[4].missed_tactic_motif == "discovered-attack"


# ---------------------------------------------------------------------------
# TestOpponentTacticMarker — Quick 260628-u7d
#
# Opponent (hollow-square) flaw markers now show their tactic motif chips,
# sourced from fetch_page_game_flaws_both_colors. Severity counts, curated
# chips, and all stats remain player-gated (the landmine guard).
# ---------------------------------------------------------------------------

# Motif int for opponent flaw (using FORK, same as user flaw but kept readable
# by naming it separately — both are "fork" family at int 1).
_OPPONENT_MOTIF_INT = _FORK_INT  # TacticMotifInt.FORK = 1


class TestOpponentTacticMarker:
    """Opponent flaw markers carry tactic motif chips; counts/chips stay player-gated.

    Scenario (Quick 260628-u7d): game_flaws has rows for both movers (Phase 113
    emits FlawRecords for both). fetch_page_game_flaws is player-gated so opponent
    rows never reach counts/chips. fetch_page_game_flaws_both_colors is ungated so
    opponent rows populate tactic_by_ply for the eval-chart tooltip.

    Separate user_id per test to avoid cross-test leakage in the rollback-scoped
    db_session fixture.
    """

    @pytest.mark.asyncio
    async def test_opponent_tactic_motif_on_hollow_square_marker(self, db_session: object) -> None:
        """Opponent blunder marker carries its allowed_tactic_motif (the new behavior).

        Setup:
        - User is white. User blunder at ply 2 (even ply = white mover).
        - Opponent (black) blunder at ply 3 (odd ply = black mover).
          Eval rises from curr_b back to 0 between ply 2 and ply 3 (black gave
          back the advantage = black blundered).
        - GameFlaw at ply 2: user flaw with missed_motif=fork.
        - GameFlaw at ply 3: opponent flaw with allowed_motif=fork.

        Assertions (Quick 260628-u7d must_haves):
        1. is_user=False marker at ply 3 has non-null allowed_tactic_motif.
        2. is_user=True marker at ply 2 still has its missed_tactic_motif (no regression).
        3. severity_counts.blunder == 1 (opponent row does NOT inflate counts).
        4. Opponent motif does not appear in card.chips (chips stay player-gated).
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.flaws_service import BLUNDER_DROP
        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99995
        await ensure_test_user(session, uid)

        # prev_b=0 (ES=0.5), curr_b negative enough for a white-perspective BLUNDER_DROP.
        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)

        game = cast(
            GameModel,
            await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4),
        )

        # Position sequence:
        # ply 0: eval=prev_b (baseline, white pov = ~0)
        # ply 1: eval=prev_b (black move, clean — no drop from black's POV)
        # ply 2: eval=curr_b (white BLUNDER — large white-POV drop)
        # ply 3: eval=prev_b (black BLUNDER — eval rose back to ~0, black gave it back)
        # ply 4: eval=prev_b (white clean — flat)
        await _seed_db_pos(session, game=game, ply=0, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=prev_b)  # black blunder
        await _seed_db_pos(session, game=game, ply=4, eval_cp=prev_b)

        # User (white) flaw at ply 2 — player-gated, contributes to counts/chips.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            severity=2,  # blunder
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )
        # Opponent (black) flaw at ply 3 — NOT player-gated, only for tactic tooltip.
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=3,
            severity=2,  # blunder (opponent)
            allowed_motif=_OPPONENT_MOTIF_INT,
            allowed_conf=80,
            allowed_depth=0,
        )

        card = await get_library_game(session, game_id=game.id)
        assert card is not None
        assert card.flaw_markers is not None

        # 1. Opponent marker at ply 3 has its allowed_tactic_motif (new behavior).
        opp_markers = [fm for fm in card.flaw_markers if not fm.is_user]
        ply3_marker = next((fm for fm in opp_markers if fm.ply == 3), None)
        assert ply3_marker is not None, "Expected an opponent flaw_marker at ply 3"
        assert ply3_marker.allowed_tactic_motif == "fork", (
            f"Opponent marker at ply 3 must carry allowed_tactic_motif='fork', "
            f"got {ply3_marker.allowed_tactic_motif!r}"
        )
        assert ply3_marker.allowed_tactic_depth == 0

        # 2. User marker at ply 2 still has its missed_tactic_motif (no regression).
        user_markers = [fm for fm in card.flaw_markers if fm.is_user]
        ply2_marker = next((fm for fm in user_markers if fm.ply == 2), None)
        assert ply2_marker is not None, "Expected a user flaw_marker at ply 2"
        assert ply2_marker.missed_tactic_motif == "fork", (
            f"User marker at ply 2 must carry missed_tactic_motif='fork', "
            f"got {ply2_marker.missed_tactic_motif!r}"
        )

        # 3. Landmine guard: severity_counts["blunder"] == 1 (opponent row NOT counted).
        # SeverityCounts is a TypedDict (plain dict at runtime) — use [] access.
        assert card.severity_counts is not None
        sc = card.severity_counts
        assert sc["blunder"] == 1, f"Expected blunder count = 1 (user-only), got {sc['blunder']}"
        assert sc["mistake"] == 0

        # 4. Opponent motif does not appear in curated chips (chips stay player-gated).
        # The opponent flaw has no boolean tags (is_miss=False etc.) so no chip entry
        # regardless, but this guard is explicit: opponent rows must NOT inflate chips.
        # The user flaw also has no boolean tags, so chips should be empty.
        assert card.chips == [], (
            f"chips must be player-gated and empty for this game, got {card.chips!r}"
        )

    @pytest.mark.asyncio
    async def test_opponent_tactic_motif_via_get_library_games(self, db_session: object) -> None:
        """get_library_games (page-list path) also populates opponent tactic markers.

        Verifies that the page_tactic_flaws batch-fetch wired to get_library_games
        carries opponent tactic data to the flaw_markers, mirroring the single-game
        path tested above.
        """
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.models.game import Game as GameModel
        from app.services.flaws_service import BLUNDER_DROP
        from app.services.library_service import get_library_games
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        uid = 99996
        await ensure_test_user(session, uid)

        prev_b, curr_b = _cp_for_white_drop(BLUNDER_DROP)

        game = cast(
            GameModel,
            await _seed_db_game(session, user_id=uid, user_color="white", ply_count=4),
        )
        await _seed_db_pos(session, game=game, ply=0, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=1, eval_cp=prev_b)
        await _seed_db_pos(session, game=game, ply=2, eval_cp=curr_b)  # white blunder
        await _seed_db_pos(session, game=game, ply=3, eval_cp=prev_b)  # black blunder
        await _seed_db_pos(session, game=game, ply=4, eval_cp=prev_b)

        # User flaw at ply 2 (player-gated).
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=2,
            severity=2,
            missed_motif=_FORK_INT,
            missed_conf=80,
            missed_depth=1,
        )
        # Opponent flaw at ply 3 (tactic-tooltip only).
        await _seed_tactic_flaw_for_game(
            session,
            game=game,
            ply=3,
            severity=2,
            allowed_motif=_OPPONENT_MOTIF_INT,
            allowed_conf=80,
            allowed_depth=0,
        )

        resp = await get_library_games(
            session,
            user_id=uid,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            flaw_severity=None,
            offset=0,
            limit=20,
        )
        assert len(resp.games) == 1
        card = resp.games[0]
        assert card.flaw_markers is not None

        # Opponent marker at ply 3 carries the tactic motif.
        opp_markers = [fm for fm in card.flaw_markers if not fm.is_user]
        ply3_marker = next((fm for fm in opp_markers if fm.ply == 3), None)
        assert ply3_marker is not None, "Expected an opponent flaw_marker at ply 3"
        assert ply3_marker.allowed_tactic_motif == "fork"

        # Landmine guard: blunder count is 1 (user-only).
        # SeverityCounts is a TypedDict (plain dict at runtime) — use [] access.
        assert card.severity_counts is not None
        assert card.severity_counts["blunder"] == 1


class TestGameCardInitialFen:
    """Phase 210 (SEED-042): the game-detail payload carries the game's own root.

    /analysis game mode replays `moves` from this position. Before it existed the
    board seeded unconditionally from the standard start, which is illegal for a
    custom-start game and crashed the page (Sentry FLAWCHESS-96).
    """

    @pytest.mark.asyncio
    async def test_custom_start_game_exposes_its_initial_fen(self, db_session: object) -> None:
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99931)
        custom_fen = "r1bqk1nr/pppp1ppp/2n5/2b1p3/1PB1P3/5N2/P1PP1PPP/RNBQK2R b KQkq b3 0 4"
        game = await _seed_db_game(
            session, user_id=99931, user_color="black", initial_fen=custom_fen
        )
        await _seed_db_pos(session, game=game, ply=0, move_san="Bxb4")

        card = await get_library_game(session, cast(Game, game).id)
        assert card is not None
        assert card.initial_fen == custom_fen

    @pytest.mark.asyncio
    async def test_standard_start_game_exposes_null(self, db_session: object) -> None:
        """The 99.95% path must stay null so the frontend's `?? STARTING_FEN`
        fallback keeps standard games byte-identical."""
        from sqlalchemy.ext.asyncio import AsyncSession

        from app.services.library_service import get_library_game
        from tests.conftest import ensure_test_user

        session = cast(AsyncSession, db_session)
        await ensure_test_user(session, 99932)
        game = await _seed_db_game(session, user_id=99932, user_color="white")
        await _seed_db_pos(session, game=game, ply=0, move_san="e4")

        card = await get_library_game(session, cast(Game, game).id)
        assert card is not None
        assert card.initial_fen is None
