"""Tests for app.services.train_pool's classifier + red-herring source query
(Phase 189, Plan 03).

Coverage:
- TestExpectedScoreFor       : the Python twin of expected_score_sql — cp-only,
                                Option-B mate mapping, None/None -> None,
                                white/black symmetry.
- TestClassifyPuzzleType     : node-0 sharp/soft classification, the exact
                                SHARP_GAP_ES threshold and one-cp-below tie,
                                every degenerate blob shape, the su=="" no-
                                second-move sentinel, and mate-node coverage
                                for both colors.
- test_soft_blob_still_enters_pool : DB-backed regression guard proving the
                                classifier is never an entry gate (POOL-02).
- test_empty_blob_excluded_from_pool_entry : 189-06 gap closure — a non-NULL
                                EMPTY missed_pv_lines (`[]`, the D-06
                                un-fillable sentinel) is excluded from
                                pool_entry_stmt exactly like true NULL.
- test_empty_blob_not_counted_as_blob_pending : 189-06 D-GAP-01 — the same
                                `[]` sentinel is counted in NEITHER
                                pool_entry_stmt NOR blob_pending_stmt.
- herring_stmt tests         : user-scoping (IDOR), tier exclusion (gem AND
                                large-gap-but-easy-to-find), ply-parity,
                                winnability floor, already-served exclusion +
                                exhaustion fallback, and deterministic
                                recency ordering (POOL-03).
"""

from __future__ import annotations

import datetime
import math
import uuid
from typing import Any, Literal

import httpx
import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.main import app
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.herring_pool import HerringPool
from app.services.eval_utils import LICHESS_K
from app.services.flaws_service import BLUNDER_DROP, INACCURACY_DROP
from app.services.train_pool import (
    HERRING_DEGENERATE_MIN_GAP_ES,
    HERRING_LADDER_SIZE,
    HERRING_LOOSE_BAND_ES,
    HERRING_MIN_QUALIFYING_MOVES,
    HERRING_PREFERRED_QUALIFYING_MOVES,
    MAX_ITEMS_PER_GAME_PER_SESSION,
    SHARP_GAP_ES,
    answer_key_present,
    blob_pending_stmt,
    classify_puzzle_type,
    expected_score_for,
    fen_and_last_move_at_ply,
    full_fen_at_ply,
    herring_stmt,
    pick_one_per_game,
    pool_entry_stmt,
    second_best_not_winning_admissible,
)

# A real, legal Ruy Lopez opening PGN, long enough (14 half-moves) to cover
# every ply used by this file's herring fixtures.
_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 *"


# ---------------------------------------------------------------------------
# TestExpectedScoreFor
# ---------------------------------------------------------------------------


class TestExpectedScoreFor:
    """expected_score_for — the Python twin of expected_score_sql."""

    def test_zero_cp_is_half(self) -> None:
        assert expected_score_for(0, None, "white") == pytest.approx(0.5, abs=1e-9)
        assert expected_score_for(0, None, "black") == pytest.approx(0.5, abs=1e-9)

    def test_white_black_symmetry(self) -> None:
        for cp in (-1500, -300, -1, 0, 1, 300, 1500):
            white = expected_score_for(cp, None, "white")
            black = expected_score_for(cp, None, "black")
            assert white is not None and black is not None
            assert white + black == pytest.approx(1.0, abs=1e-9)

    def test_both_none_returns_none(self) -> None:
        assert expected_score_for(None, None, "white") is None
        assert expected_score_for(None, None, "black") is None

    def test_mate_takes_priority_over_cp(self) -> None:
        """When both eval_mate and eval_cp are present, mate wins (Option-B)."""
        mate_only = expected_score_for(None, 3, "white")
        both = expected_score_for(50, 3, "white")
        assert mate_only == both

    def test_positive_mate_white_high_negative_black_low(self) -> None:
        white_es = expected_score_for(None, 3, "white")
        black_es = expected_score_for(None, 3, "black")
        assert white_es is not None and white_es > 0.9
        assert black_es is not None and black_es < 0.1

    def test_negative_mate_flips(self) -> None:
        white_es = expected_score_for(None, -3, "white")
        black_es = expected_score_for(None, -3, "black")
        assert white_es is not None and white_es < 0.1
        assert black_es is not None and black_es > 0.9


# ---------------------------------------------------------------------------
# TestClassifyPuzzleType
# ---------------------------------------------------------------------------


def _boundary_best_cp(gap: float) -> float:
    """The 'b' cp value such that expected_score_for(cp, None, "white") minus
    the second-move's es (held at cp=0, es=0.5) is >= `gap`, as close to the
    boundary as float round-trip precision allows.

    Solved via the exact inverse of the sigmoid used by eval_cp_to_expected_score:
    target_es = 1 / (1 + exp(-K*cp))  =>  cp = ln(es / (1-es)) / K

    A tiny upward nudge (1e-6 cp) compensates for log/exp round-trip error
    that can otherwise leave the recomputed gap a few ULPs BELOW the target —
    negligible next to the "one whole cp lower" comparison case, but enough
    to guarantee `best_es - second_es >= gap` holds for the "exactly at
    threshold" case.
    """
    target_es = 0.5 + gap
    return math.log(target_es / (1 - target_es)) / LICHESS_K + 1e-6


class TestClassifyPuzzleType:
    """classify_puzzle_type — node-0 sharp/soft classification."""

    def test_none_is_soft(self) -> None:
        assert classify_puzzle_type(None, "white") == "soft"

    def test_empty_list_is_soft(self) -> None:
        assert classify_puzzle_type([], "white") == "soft"

    def test_non_dict_node_is_soft(self) -> None:
        assert classify_puzzle_type(["not-a-dict"], "white") == "soft"  # type: ignore[list-item]

    def test_large_gap_is_sharp(self) -> None:
        node = {"b": 300, "bm": None, "s": 0, "sm": None, "su": "e2e4"}
        assert classify_puzzle_type([node], "white") == "sharp"

    def test_gap_exactly_at_threshold_is_sharp(self) -> None:
        best_cp = _boundary_best_cp(SHARP_GAP_ES)
        node: dict[str, Any] = {"b": best_cp, "bm": None, "s": 0, "sm": None, "su": "e2e4"}
        # Confirm the construction lands exactly on the boundary before asserting behavior.
        # best_cp is intentionally a float (exact sigmoid-inverse boundary math, not a
        # realistic stored value) — ty's int|None param type doesn't cover this
        # deliberately precise boundary construction.
        best_es = expected_score_for(best_cp, None, "white")  # ty: ignore[invalid-argument-type]
        second_es = expected_score_for(0, None, "white")
        assert best_es is not None and second_es is not None
        gap = best_es - second_es
        assert gap == pytest.approx(SHARP_GAP_ES, abs=1e-6)
        assert classify_puzzle_type([node], "white") == "sharp"

    def test_gap_one_cp_below_threshold_is_soft(self) -> None:
        best_cp = _boundary_best_cp(SHARP_GAP_ES) - 1.0
        node: dict[str, Any] = {"b": best_cp, "bm": None, "s": 0, "sm": None, "su": "e2e4"}
        assert classify_puzzle_type([node], "white") == "soft"

    def test_equal_best_and_second_is_soft(self) -> None:
        node = {"b": 50, "bm": None, "s": 50, "sm": None, "su": "e2e4"}
        assert classify_puzzle_type([node], "white") == "soft"

    def test_no_legal_second_move_is_sharp(self) -> None:
        node = {"b": 50, "bm": None, "s": None, "sm": None, "su": ""}
        assert classify_puzzle_type([node], "white") == "sharp"

    def test_missing_best_fields_is_soft(self) -> None:
        node = {"s": 0, "sm": None, "su": "e2e4"}
        assert classify_puzzle_type([node], "white") == "soft"

    def test_missing_second_fields_is_soft(self) -> None:
        node = {"b": 300, "bm": None, "su": "e2e4"}
        assert classify_puzzle_type([node], "white") == "soft"

    def test_mate_node_white_sharp_black_soft(self) -> None:
        """The runner-up (s=0, cp) is a near-even eval; a forced mate for the
        mover is decisively sharp for that mover's own color, but the SAME
        node evaluated from the opponent's POV flips to soft."""
        node = {"b": None, "bm": 3, "s": 0, "sm": None, "su": "e2e4"}
        assert classify_puzzle_type([node], "white") == "sharp"
        assert classify_puzzle_type([node], "black") == "soft"

    def test_reads_node_zero_only_no_resort(self) -> None:
        sharp_node = {"b": 300, "bm": None, "s": 0, "sm": None, "su": "e2e4"}
        soft_node = {"b": 50, "bm": None, "s": 50, "sm": None, "su": "e2e4"}
        assert classify_puzzle_type([sharp_node, soft_node], "white") == "sharp"
        assert classify_puzzle_type([soft_node, sharp_node], "white") == "soft"


# ---------------------------------------------------------------------------
# TestFenAndLastMoveAtPly (190-02, SOLV-02) — the shared PGN-replay helper
# behind TrainPuzzle.last_move_uci and full_fen_at_ply's delegation.
# ---------------------------------------------------------------------------


class TestFenAndLastMoveAtPly:
    """fen_and_last_move_at_ply — one PGN replay, returning (fen, last_move_uci)."""

    def test_mid_game_ply_returns_correct_last_move_uci(self) -> None:
        # _PGN's 5th half-move (index 4) is 3. Bb5 -> f1b5.
        result = fen_and_last_move_at_ply(_PGN, 5)
        assert result is not None
        _fen, last_move_uci = result
        assert last_move_uci == "f1b5"

    def test_ply_zero_returns_none_move_and_valid_starting_fen(self) -> None:
        result = fen_and_last_move_at_ply(_PGN, 0)
        assert result is not None
        fen, last_move_uci = result
        assert last_move_uci is None
        assert fen == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

    def test_unparseable_pgn_returns_none(self) -> None:
        assert fen_and_last_move_at_ply("not a real pgn {{{", 1) is None

    def test_ply_past_end_returns_none(self) -> None:
        # _PGN has 14 half-moves; ply=15 is one past the end.
        assert fen_and_last_move_at_ply(_PGN, 15) is None

    def test_fen_matches_full_fen_at_ply_delegation_guard(self) -> None:
        """full_fen_at_ply delegates to this helper — the FEN must be byte-identical."""
        for ply in (0, 1, 5, 14):
            result = fen_and_last_move_at_ply(_PGN, ply)
            assert result is not None
            fen, _last_move_uci = result
            assert fen == full_fen_at_ply(_PGN, ply)


# ---------------------------------------------------------------------------
# TestPickOnePerGame (quick task 260728-pgp) — pure, no DB.
# ---------------------------------------------------------------------------


class TestPickOnePerGame:
    """pick_one_per_game — uniform-random per-game cap, deterministic seeding."""

    def test_empty_input_yields_empty_list(self) -> None:
        assert pick_one_per_game([], user_id=1, session_date=datetime.date(2026, 1, 1)) == []

    def test_single_candidate_game_always_picked(self) -> None:
        candidates = [(1, 4, "payload")]
        result = pick_one_per_game(candidates, user_id=1, session_date=datetime.date(2026, 1, 1))
        assert result == [(1, 4, "payload")]

    def test_caps_at_max_items_per_game(self) -> None:
        candidates = [(1, ply, None) for ply in range(0, 20, 2)]  # 10 candidates, one game
        result = pick_one_per_game(candidates, user_id=1, session_date=datetime.date(2026, 1, 1))
        assert len(result) == MAX_ITEMS_PER_GAME_PER_SESSION

    def test_deterministic_across_repeated_calls(self) -> None:
        candidates = [(1, ply, None) for ply in range(0, 20, 2)] + [
            (2, ply, None) for ply in range(0, 10, 2)
        ]
        first = pick_one_per_game(candidates, user_id=42, session_date=datetime.date(2026, 3, 1))
        second = pick_one_per_game(candidates, user_id=42, session_date=datetime.date(2026, 3, 1))
        assert first == second

    def test_pick_independent_of_other_games_in_pool(self) -> None:
        """A game's chosen ply does not change when OTHER games are added to
        or removed from the candidate pool — the seed carries game_id."""
        game_one = [(1, ply, None) for ply in range(0, 20, 2)]
        with_extra_games = game_one + [(2, 4, None), (3, 6, None), (3, 8, None)]
        result_alone = pick_one_per_game(
            game_one, user_id=7, session_date=datetime.date(2026, 5, 1)
        )
        result_with_others = pick_one_per_game(
            with_extra_games, user_id=7, session_date=datetime.date(2026, 5, 1)
        )
        game_one_pick_alone = [entry for entry in result_alone if entry[0] == 1]
        game_one_pick_with_others = [entry for entry in result_with_others if entry[0] == 1]
        assert game_one_pick_alone == game_one_pick_with_others

    def test_preserves_first_appearance_game_order(self) -> None:
        candidates = [(3, 2, None), (1, 4, None), (2, 6, None)]
        result = pick_one_per_game(candidates, user_id=1, session_date=datetime.date(2026, 1, 1))
        assert [game_id for game_id, _ply, _payload in result] == [3, 1, 2]

    def test_not_earliest_ply_across_session_dates(self) -> None:
        """Across a spread of session dates for one 10-candidate game, the
        chosen ply is NOT pinned to the earliest ply — several distinct
        plies are selected and at least one is in the back half of the
        candidate list (the earliest-ply skew this helper deliberately
        avoids — see the module docstring measurement)."""
        candidates = [(1, ply, None) for ply in range(0, 20, 2)]  # 10 candidates, plies 0..18
        plies = {
            pick_one_per_game(candidates, user_id=99, session_date=datetime.date(2026, 1, day))[0][
                1
            ]
            for day in range(1, 29)
        }
        assert len(plies) > 1  # several distinct plies chosen, not always the same one
        assert any(ply >= 10 for ply in plies)  # at least one in the back half


# ---------------------------------------------------------------------------
# Shared HTTP/DB seeding helpers
# ---------------------------------------------------------------------------


async def _register_and_login(email: str, password: str = "testpass123!") -> tuple[int, str]:
    """Register a user via HTTP and return (user_id, auth_token)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        reg = await client.post("/api/auth/register", json={"email": email, "password": password})
        assert reg.status_code in (200, 201), f"register failed: {reg.text}"
        user_id = int(reg.json()["id"])

        login = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        assert login.status_code == 200, f"login failed: {login.text}"
        token = str(login.json()["access_token"])
    return user_id, token


async def _delete_games(test_engine, game_ids: list[int]) -> None:
    if not game_ids:
        return
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            await session.execute(delete(Game).where(Game.id.in_(game_ids)))


# ---------------------------------------------------------------------------
# test_soft_blob_still_enters_pool
# ---------------------------------------------------------------------------


async def _seed_blunder_game(
    test_engine,
    user_id: int,
    *,
    ply: int = 10,
    missed_pv_lines: list[Any],
    prior_eval_cp: int = 300,
    user_color: Literal["white", "black"] = "white",
) -> int:
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            game = Game(
                user_id=user_id,
                platform="lichess",
                platform_game_id=str(uuid.uuid4()),
                platform_url="https://lichess.org/test",
                pgn=_PGN,
                result="1-0",
                user_color=user_color,
                time_control_str="600+0",
                time_control_bucket="blitz",
                time_control_seconds=600,
                base_time_seconds=600,
                increment_seconds=0.0,
                rated=True,
                is_computer_game=False,
                ply_count=14,
                full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
            )
            session.add(game)
            await session.flush()
            game_id: int = game.id

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
                fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR",
                missed_pv_lines=missed_pv_lines,
            )
            session.add(flaw)

            prior = GamePosition(
                user_id=user_id,
                game_id=game_id,
                ply=ply - 1,
                full_hash=1000 + game_id,
                white_hash=2000 + game_id,
                black_hash=3000 + game_id,
                eval_cp=prior_eval_cp,
                eval_mate=None,
            )
            session.add(prior)

    return game_id


@pytest.mark.asyncio
async def test_soft_blob_still_enters_pool(test_engine) -> None:
    """A blunder whose node-0 gap is below SHARP_GAP_ES (soft) still passes
    pool_entry_stmt — the classifier is a label, never an entry gate (POOL-02)."""
    user_id, _ = await _register_and_login(f"train-softblob-{uuid.uuid4().hex[:8]}@example.com")
    soft_node = {"b": 50, "bm": None, "s": 50, "sm": None, "su": "e2e4"}
    game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[soft_node])

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(pool_entry_stmt(user_id))).all()
        assert len(rows) == 1
        flaw, _game = rows[0]
        assert classify_puzzle_type(flaw.missed_pv_lines, "white") == "soft"
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_empty_blob_excluded_from_pool_entry(test_engine) -> None:
    """189-06 gap closure: a non-NULL EMPTY missed_pv_lines (`[]`, the eval
    pipeline's D-06 un-fillable sentinel) is excluded from pool_entry_stmt
    exactly like a true SQL NULL blob — the verifier's reproduction."""
    user_id, _ = await _register_and_login(f"train-emptyblob-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[])

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(pool_entry_stmt(user_id))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_empty_blob_not_counted_as_blob_pending(test_engine) -> None:
    """189-06 D-GAP-01: the `[]` sentinel is counted in NEITHER
    pool_entry_stmt NOR blob_pending_stmt — it is terminal, not "still
    analyzing" material, so it is invisible to both signals by design."""
    user_id, _ = await _register_and_login(f"train-emptypend-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[])

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            pool_rows = (await session.execute(pool_entry_stmt(user_id))).all()
            pending_count = (await session.execute(blob_pending_stmt(user_id))).scalar_one()
        assert pool_rows == []
        assert pending_count == 0
    finally:
        await _delete_games(test_engine, [game_id])


# ---------------------------------------------------------------------------
# TestDeadBandAdmissible (Phase 205, ORACLE-03/ORACLE-04) — dead_band_admissible
# applied at pool_entry_stmt. Both boundaries, both D-03 degenerate paths, the
# JSON-null node, black-mover parity, and the SQL/Python twin agreement at the
# boundary.
# ---------------------------------------------------------------------------


def _band_node(gap: float) -> dict[str, Any]:
    """A missed_pv_lines node-0 dict whose best-vs-second expected-score gap
    is >= `gap`, built on `_boundary_best_cp`'s exact sigmoid-inverse
    construction. The second move is held at cp=0 (es=0.5), with a real
    second-move UCI so the D-03 no-second-move sentinel is never accidentally
    hit by these fixtures."""
    return {"b": _boundary_best_cp(gap), "bm": None, "s": 0, "sm": None, "su": "e2e4"}


async def _pool_contains(test_engine, user_id: int, game_id: int, ply: int) -> bool:
    """True when pool_entry_stmt(user_id) yields the (game_id, ply) row."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        rows = (await session.execute(pool_entry_stmt(user_id))).all()
    return any(flaw.game_id == game_id and flaw.ply == ply for flaw, _game in rows)


class TestDeadBandAdmissible:
    """dead_band_admissible, applied at pool_entry_stmt."""

    @pytest.mark.asyncio
    async def test_drop_exactly_at_upper_edge_is_present(self, test_engine) -> None:
        """BLUNDER_DROP itself is KEPT — the upper edge is open."""
        user_id, _ = await _register_and_login(
            f"train-band-upper-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[_band_node(BLUNDER_DROP)]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is True
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_one_cp_below_upper_edge_is_absent(self, test_engine) -> None:
        """One cp inside the upper edge is banded — the boundary is sharp."""
        user_id, _ = await _register_and_login(
            f"train-band-upperabs-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = _band_node(BLUNDER_DROP)
        node["b"] = node["b"] - 1.0
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_drop_exactly_at_lower_edge_is_absent(self, test_engine) -> None:
        """INACCURACY_DROP itself is EXCLUDED — the lower edge is closed."""
        user_id, _ = await _register_and_login(
            f"train-band-lower-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[_band_node(INACCURACY_DROP)]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_one_cp_below_lower_edge_is_present(self, test_engine) -> None:
        """One cp below the lower edge is KEPT (soft) — the boundary is sharp."""
        user_id, _ = await _register_and_login(
            f"train-band-lowerabs-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = _band_node(INACCURACY_DROP)
        node["b"] = node["b"] - 1.0
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is True
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_no_second_move_sentinel_is_absent(self, test_engine) -> None:
        """D-03 path 1: su == "" (no legal second move) is excluded."""
        user_id, _ = await _register_and_login(
            f"train-band-nosecond-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = {"b": 50, "bm": None, "s": None, "sm": None, "su": ""}
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_non_dict_node_is_absent(self, test_engine) -> None:
        """D-03 path 2: a non-object node 0 is excluded, not raising."""
        user_id, _ = await _register_and_login(
            f"train-band-nondict-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=["not-a-dict"])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_node_with_no_second_move_keys_is_absent(self, test_engine) -> None:
        """D-03 path 2: a node 0 missing s/sm/su entirely is excluded, not raising."""
        user_id, _ = await _register_and_login(
            f"train-band-nokeys-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = {"b": 300, "bm": None}
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_json_null_node_is_absent_and_raises_nothing(self, test_engine) -> None:
        """A blob whose single element is a JSON null (the asyncpg None-binding
        gotcha's shape, RESEARCH Pitfall 3) is excluded, not raising."""
        user_id, _ = await _register_and_login(
            f"train-band-jsonnull-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[None])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_integer_valued_in_band_blob_is_absent(self, test_engine) -> None:
        """An in-band blob built from plain ints (not the sigmoid-inverse
        float construction) is still banded — the float cast on b/s does not
        break the ordinary integer case."""
        user_id, _ = await _register_and_login(f"train-band-int-{uuid.uuid4().hex[:8]}@example.com")
        node = {"b": 40, "bm": None, "s": -30, "sm": None, "su": "g8f6"}  # gap ~0.0643, in-band
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_second_node_does_not_affect_decision(self, test_engine) -> None:
        """Only node 0 is read, no re-sorting: a second node that would
        classify very differently changes nothing."""
        user_id, _ = await _register_and_login(
            f"train-band-node0only-{uuid.uuid4().hex[:8]}@example.com"
        )
        banded_node = _band_node(INACCURACY_DROP)  # excluded, exactly at the lower edge
        large_gap_node = {"b": 300, "bm": None, "s": 0, "sm": None, "su": "e2e4"}
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[banded_node, large_gap_node]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_twin_agreement_at_upper_edge(self, test_engine) -> None:
        """The SQL predicate and the Python classifier cannot disagree at the
        threshold: the exact BLUNDER_DROP construction is 'sharp' under
        classify_puzzle_type AND kept by pool_entry_stmt in the same run."""
        user_id, _ = await _register_and_login(
            f"train-band-twin-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = _band_node(BLUNDER_DROP)
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert classify_puzzle_type([node], "white") == "sharp"
            assert await _pool_contains(test_engine, user_id, game_id, 10) is True
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_black_mover_parity_flips_admissibility(self, test_engine) -> None:
        """The same node evaluated for a black mover flips admissibility
        relative to the white-mover case, with mover color derived purely
        from ply parity -- no Game column enters the predicate."""
        node = _band_node(INACCURACY_DROP)  # excluded (banded) for a white mover
        user_id, _ = await _register_and_login(
            f"train-band-parity-{uuid.uuid4().hex[:8]}@example.com"
        )
        white_game_id = await _seed_blunder_game(
            test_engine, user_id, ply=10, missed_pv_lines=[dict(node)], user_color="white"
        )
        black_game_id = await _seed_blunder_game(
            test_engine,
            user_id,
            ply=11,
            missed_pv_lines=[dict(node)],
            prior_eval_cp=-300,  # winnable for black (sign flips vs the white default)
            user_color="black",
        )
        try:
            assert await _pool_contains(test_engine, user_id, white_game_id, 10) is False
            assert await _pool_contains(test_engine, user_id, black_game_id, 11) is True
        finally:
            await _delete_games(test_engine, [white_game_id, black_game_id])


# ---------------------------------------------------------------------------
# TestSecondBestNotWinningAdmissible (SEED-141) — second_best_not_winning_admissible
# applied at pool_entry_stmt. `_still_winning_node`'s "b" is fixed at 900 cp
# (ES ~0.965), large enough that best-vs-second always clears BLUNDER_DROP for
# every "s" value used below (400 down to -400) — dead_band_admissible stays
# admissible throughout, isolating the new predicate as the only variable.
# ---------------------------------------------------------------------------


def _still_winning_node(second_cp: int) -> dict[str, Any]:
    """A missed_pv_lines node-0 dict with a fixed large best-move eval (900 cp,
    ES ~0.965) and `second_cp` as the runner-up's white-perspective eval — the
    gap always clears BLUNDER_DROP regardless of `second_cp`'s value in the
    range this module's tests use, so dead_band_admissible is admissible
    throughout and second_best_not_winning_admissible is the only variable."""
    return {"b": 900, "bm": None, "s": second_cp, "sm": None, "su": "e2e4"}


class TestSecondBestNotWinningAdmissible:
    """second_best_not_winning_admissible, applied at pool_entry_stmt."""

    @pytest.mark.asyncio
    async def test_second_best_clearly_winning_is_absent(self, test_engine) -> None:
        """White mover, s=400 (>= SECOND_BEST_WINNING_FLOOR_CP): the runner-up
        still leaves the mover clearly winning, so the puzzle is excluded."""
        user_id, _ = await _register_and_login(
            f"train-swin-clear-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[_still_winning_node(400)]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_second_best_exactly_at_floor_is_absent(self, test_engine) -> None:
        """s == SECOND_BEST_WINNING_FLOOR_CP (200): the exclusion boundary is
        inclusive at the exclusion side."""
        user_id, _ = await _register_and_login(
            f"train-swin-floor-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[_still_winning_node(200)]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is False
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_second_best_one_cp_below_floor_is_present(self, test_engine) -> None:
        """s == 199 (one cp below the floor): admissible — the boundary is sharp."""
        user_id, _ = await _register_and_login(
            f"train-swin-below-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[_still_winning_node(199)]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is True
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_second_best_leaves_mover_losing_is_present(self, test_engine) -> None:
        """s = -400 (the runner-up leaves the mover losing, not winning):
        admissible — this is exactly the case the puzzle should still test."""
        user_id, _ = await _register_and_login(
            f"train-swin-losing-{uuid.uuid4().hex[:8]}@example.com"
        )
        game_id = await _seed_blunder_game(
            test_engine, user_id, missed_pv_lines=[_still_winning_node(-400)]
        )
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is True
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_black_mover_sign_flip(self, test_engine) -> None:
        """The SAME raw node (b=-900, s=-400, both white-perspective) flips
        admissibility depending purely on ply parity: at a black-mover ply the
        runner-up (mover-POV +400) is still clearly winning for black and is
        excluded; at a white-mover ply the identical raw blob has a
        mover-POV runner-up of -400 (losing for white) and is admissible. A
        predicate that ignores color cannot satisfy both halves in one run."""
        node = {"b": -900, "bm": None, "s": -400, "sm": None, "su": "g8f6"}
        user_id, _ = await _register_and_login(
            f"train-swin-flip-{uuid.uuid4().hex[:8]}@example.com"
        )
        black_game_id = await _seed_blunder_game(
            test_engine,
            user_id,
            ply=11,
            missed_pv_lines=[dict(node)],
            prior_eval_cp=-300,  # winnable for black (mirrors dead-band's parity test)
            user_color="black",
        )
        white_game_id = await _seed_blunder_game(
            test_engine,
            user_id,
            ply=10,
            missed_pv_lines=[dict(node)],
            prior_eval_cp=300,
            user_color="white",
        )
        try:
            assert await _pool_contains(test_engine, user_id, black_game_id, 11) is False
            assert await _pool_contains(test_engine, user_id, white_game_id, 10) is True
        finally:
            await _delete_games(test_engine, [black_game_id, white_game_id])

    @pytest.mark.asyncio
    async def test_mate_for_the_mover_is_absent(self, test_engine) -> None:
        """A forced mate FOR the mover is the degenerate 'still winning' case
        this predicate exists to catch: excluded for both colors."""
        user_id, _ = await _register_and_login(
            f"train-swin-matefor-{uuid.uuid4().hex[:8]}@example.com"
        )
        white_node = {"b": 50, "bm": None, "s": None, "sm": 3, "su": "e2e4"}  # white mating
        white_game_id = await _seed_blunder_game(
            test_engine, user_id, ply=10, missed_pv_lines=[white_node], user_color="white"
        )
        black_node = {"b": -50, "bm": None, "s": None, "sm": -3, "su": "e2e4"}  # black mating
        black_game_id = await _seed_blunder_game(
            test_engine,
            user_id,
            ply=11,
            missed_pv_lines=[black_node],
            prior_eval_cp=-300,
            user_color="black",
        )
        try:
            assert await _pool_contains(test_engine, user_id, white_game_id, 10) is False
            assert await _pool_contains(test_engine, user_id, black_game_id, 11) is False
        finally:
            await _delete_games(test_engine, [white_game_id, black_game_id])

    @pytest.mark.asyncio
    async def test_mate_against_the_mover_is_present(self, test_engine) -> None:
        """A forced mate AGAINST the mover is exactly the case the puzzle
        should still test: admissible for both colors."""
        user_id, _ = await _register_and_login(
            f"train-swin-mateagainst-{uuid.uuid4().hex[:8]}@example.com"
        )
        white_node = {"b": 50, "bm": None, "s": None, "sm": -3, "su": "e2e4"}  # black mating
        white_game_id = await _seed_blunder_game(
            test_engine, user_id, ply=10, missed_pv_lines=[white_node], user_color="white"
        )
        black_node = {"b": -50, "bm": None, "s": None, "sm": 3, "su": "e2e4"}  # white mating
        black_game_id = await _seed_blunder_game(
            test_engine,
            user_id,
            ply=11,
            missed_pv_lines=[black_node],
            prior_eval_cp=-300,
            user_color="black",
        )
        try:
            assert await _pool_contains(test_engine, user_id, white_game_id, 10) is True
            assert await _pool_contains(test_engine, user_id, black_game_id, 11) is True
        finally:
            await _delete_games(test_engine, [white_game_id, black_game_id])

    @pytest.mark.asyncio
    async def test_mate_takes_priority_over_cp(self, test_engine) -> None:
        """sm=-3 (mate against the mover) together with s=900 (a clearly
        winning cp value) is still PRESENT — mate outranks cp exactly as
        expected_score_sql's branch order does."""
        user_id, _ = await _register_and_login(
            f"train-swin-matepriority-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = {"b": 50, "bm": None, "s": 900, "sm": -3, "su": "e2e4"}
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            assert await _pool_contains(test_engine, user_id, game_id, 10) is True
        finally:
            await _delete_games(test_engine, [game_id])

    @pytest.mark.asyncio
    async def test_no_second_move_sentinel_survives_in_isolation(self, test_engine) -> None:
        """The su == "" sentinel must survive second_best_not_winning_admissible
        on its own -- NOT via a pool_entry_stmt round-trip, because
        dead_band_admissible already excludes su == "" through its own
        `second_uci != ""` clause, so a pool_entry_stmt test here would pass
        for the wrong reason even under a bare-NOT NULL-dropping bug. Pairing
        just answer_key_present with the new predicate isolates it: this is
        the test that catches the NULL-under-NOT bug the seed warns about
        (a bare `s_mover_cp >= threshold` under `NOT` yields NULL for this
        row and silently drops it). Do NOT "simplify" this to `_pool_contains`
        -- that would silently gut the regression this test exists to catch.
        """
        user_id, _ = await _register_and_login(
            f"train-swin-sentinel-{uuid.uuid4().hex[:8]}@example.com"
        )
        node = {"b": 50, "bm": None, "s": None, "sm": None, "su": ""}
        game_id = await _seed_blunder_game(test_engine, user_id, missed_pv_lines=[node])
        try:
            session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
            async with session_maker() as session:
                rows = (
                    await session.execute(
                        select(GameFlaw.game_id, GameFlaw.ply).where(
                            GameFlaw.user_id == user_id,
                            answer_key_present(GameFlaw.missed_pv_lines),
                            second_best_not_winning_admissible(
                                GameFlaw.missed_pv_lines, GameFlaw.ply
                            ),
                        )
                    )
                ).all()
            assert any(row.game_id == game_id and row.ply == 10 for row in rows)
        finally:
            await _delete_games(test_engine, [game_id])


# ---------------------------------------------------------------------------
# herring_stmt tests
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Phase 192 (POOL-03 amended) — herring_pool source-swap seed/cleanup helpers
# ---------------------------------------------------------------------------

# A default 5-entry MultiPV-5 ladder (white POV, best-first) for pool-row
# fixtures that don't care about the exact ladder shape. Deliberately clears
# BOTH of herring_stmt's Phase 192 (192-04) query-time gates so a fixture
# using this default is, by construction, a valid non-degenerate herring:
# PV0/PV1/PV2 all fall within INACCURACY_DROP (0.05 ES) of PV0 (3 qualifying
# moves, above HERRING_MIN_QUALIFYING_MOVES=2), and PV0-to-PV4 is ~0.092 ES,
# comfortably above HERRING_DEGENERATE_MIN_GAP_ES (0.02).
_DEFAULT_HERRING_LADDER: list[dict[str, object]] = [
    {"move_uci": "e2e4", "cp": 60, "mate": None},
    {"move_uci": "d2d4", "cp": 45, "mate": None},
    {"move_uci": "g1f3", "cp": 20, "mate": None},
    {"move_uci": "c2c4", "cp": -10, "mate": None},
    {"move_uci": "b1c3", "cp": -40, "mate": None},
]


async def _seed_bare_game(
    test_engine, user_id: int, *, played_at: datetime.datetime | None = None
) -> int:
    """Seed a Game row with no game_best_moves/game_flaws attached — a bare FK
    target for herring_pool fixtures (the pool row carries everything the
    query needs; the game exists only to satisfy the composite FK, D-01)."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            game = Game(
                user_id=user_id,
                platform="lichess",
                platform_game_id=str(uuid.uuid4()),
                platform_url="https://lichess.org/test",
                pgn=_PGN,
                result="1-0",
                user_color="white",
                time_control_str="600+0",
                time_control_bucket="blitz",
                time_control_seconds=600,
                base_time_seconds=600,
                increment_seconds=0.0,
                rated=True,
                is_computer_game=False,
                ply_count=14,
                full_evals_completed_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
                played_at=played_at,
            )
            session.add(game)
            await session.flush()
            game_id: int = game.id
    return game_id


async def _seed_pool_row(
    test_engine,
    user_id: int,
    game_id: int,
    *,
    ply: int = 8,
    mover_color: str = "white",
    fen: str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    arriving_move_uci: str | None = "e2e4",
    phase: int = 1,
    played_at: datetime.datetime | None = None,
    ladder: list[dict[str, object]] | None = None,
) -> int:
    """Seed one `herring_pool` row against an existing `(user_id, game_id)`.
    Returns the new row's `id`."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            row = HerringPool(
                user_id=user_id,
                game_id=game_id,
                ply=ply,
                mover_color=mover_color,
                fen=fen,
                arriving_move_uci=arriving_move_uci,
                phase=phase,
                source_played_at=played_at,
                ladder=ladder if ladder is not None else _DEFAULT_HERRING_LADDER,
            )
            session.add(row)
            await session.flush()
            pool_id: int = row.id
    return pool_id


async def _seed_served_herring_by_pool_id(
    test_engine, user_id: int, game_id: int, herring_pool_id: int
) -> None:
    """Insert a DrillSession + DrillSolve(source=RED_HERRING, herring_pool_id=...)
    marking a pool row as already served. Uses a `ply` distinct from the pool
    row's own `ply` to prove the exclusion keys on `herring_pool_id` (D-04),
    never on `(game_id, ply)` coincidence."""
    served_ply_sentinel = 999
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            drill_session = DrillSession(
                user_id=user_id,
                session_date=datetime.date(2026, 1, 1),
                status="completed",
                puzzle_count=1,
                expires_on=datetime.date(2026, 1, 2),
            )
            session.add(drill_session)
            await session.flush()
            solve = DrillSolve(
                session_id=drill_session.id,
                position=0,
                user_id=user_id,
                game_id=game_id,
                ply=served_ply_sentinel,
                source=DrillSource.RED_HERRING,
                herring_pool_id=herring_pool_id,
            )
            session.add(solve)


async def _delete_herring_pool_rows(test_engine, herring_pool_ids: list[int]) -> None:
    """Explicit cleanup for herring_pool test rows.

    `_delete_games`'s FK is `ondelete="SET NULL"` (D-01), NOT `CASCADE` —
    deleting the backing game nulls out the pool row's `user_id`/`game_id`
    but does not remove it. `herring_stmt` is deliberately identity-blind
    (D-10, no `HerringPool.user_id` filter), so an orphaned row from an
    earlier test would leak into every later test's results in this shared
    per-run DB. Must be cleaned up explicitly, before `_delete_games`.
    """
    if not herring_pool_ids:
        return
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            await session.execute(delete(HerringPool).where(HerringPool.id.in_(herring_pool_ids)))


@pytest.mark.asyncio
async def test_herring_selects_pool_row(test_engine) -> None:
    """Phase 192 source swap: herring_stmt returns a HerringPool row directly
    — not a two-tuple carrying a joined Game row (the superseded shape)."""
    user_id, _ = await _register_and_login(f"herring-poolrow-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_bare_game(test_engine, user_id)
    pool_id = await _seed_pool_row(test_engine, user_id, game_id, ply=10)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert len(rows) == 1
        row = rows[0]
        assert isinstance(row, HerringPool)
        assert row.id == pool_id
        assert row.game_id == game_id
        assert row.ply == 10
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_already_served_by_pool_id(test_engine) -> None:
    """D-04: the exclude_served pair keys on herring_pool_id, not (game_id, ply)."""
    user_id, _ = await _register_and_login(f"herring-servedpool-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_bare_game(test_engine, user_id)
    pool_id = await _seed_pool_row(test_engine, user_id, game_id, ply=10)
    await _seed_served_herring_by_pool_id(test_engine, user_id, game_id, pool_id)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            excluded_rows = (
                (await session.execute(herring_stmt(user_id, exclude_served=True))).scalars().all()
            )
            included_rows = (
                (await session.execute(herring_stmt(user_id, exclude_served=False))).scalars().all()
            )
        assert excluded_rows == []
        assert [row.id for row in included_rows] == [pool_id]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])
        await _delete_games(test_engine, [game_id])


def test_loose_band_exceeds_tight_gate() -> None:
    """D-15: the generation-time loose band must sit comfortably above the
    query-time tight gate (INACCURACY_DROP), or the generator could reject
    at write time a candidate the (retuned-downward) query-time gate would
    otherwise have accepted — defeating the whole loose-gen/tight-query
    split's "retunable with zero re-analysis" promise (192-03 Task 2)."""
    assert HERRING_LOOSE_BAND_ES > INACCURACY_DROP


def test_degenerate_min_gap_is_a_real_positive_discriminator() -> None:
    """D-17: the query-time degenerate-exclusion floor must be a real,
    positive threshold (0 would exclude nothing — every position has a
    PV0-PV4 gap >= 0) and small relative to the full [0, 1] expected-score
    range, matching D-17's "trim the tail, not the body" intent (192-03
    Task 2)."""
    assert 0 < HERRING_DEGENERATE_MIN_GAP_ES < 1.0


# ---------------------------------------------------------------------------
# herring_stmt query-time gate tests (Phase 192, Plan 04)
#
# The nine tests this block replaces exercised the pre-Phase-192 source
# (best/second gap + tier exclusion). Three of the behaviors they protected
# have a new home rather than a re-expression here — recorded as decisions,
# not omissions:
#   - The winnability floor now lives in the generator's own selection frame
#     (WINNABILITY_FLOOR_ES against the generator's own MultiPV[0] on its own
#     searched board — scripts/gen_red_herring_pool.py, pinned by 192-03's
#     tests). A served HerringPool row is winnable by construction; this
#     query never re-checks it.
#   - "Mover is the opponent" ply-parity exclusion is now settled by the
#     stored `HerringPool.mover_color` (the side to move on the generator's
#     own searched board, D-16) rather than re-derived from `Game.user_color`
#     plus ply parity at query time — there is no `Game` join on the happy
#     path at all.
#   - The other-users'-games exclusion is DELIBERATELY GONE: D-10 explicitly
#     permits (and this pool is identity-blind about) serving a user a
#     herring drawn from someone else's — or their own — game. Adding it
#     back would cost a join to prevent a harmless coincidence.
# ---------------------------------------------------------------------------


def _ladder(*entries: tuple[int | None, int | None]) -> list[dict[str, object]]:
    """Build a `HERRING_LADDER_SIZE`-entry ladder from (cp, mate) pairs,
    best-first, mover POV. Move UCIs are arbitrary placeholders — none of
    herring_stmt's gates read `move_uci`."""
    ucis = ["e2e4", "d2d4", "g1f3", "c2c4", "b1c3"]
    assert len(entries) == HERRING_LADDER_SIZE
    return [
        {"move_uci": uci, "cp": cp, "mate": mate}
        for uci, (cp, mate) in zip(ucis, entries, strict=True)
    ]


def _ladder_with_qualifying_count(
    qualifying: int, *, best_cp: int = 0, small_gap_cp: int = -10
) -> list[dict[str, object]]:
    """Build a ladder with exactly `qualifying` entries (PV[0] plus
    `qualifying - 1` near-`best_cp` entries) inside `INACCURACY_DROP` of the
    best, and the remaining entries far enough outside both the tight gate
    and the degenerate bound to never affect either one.
    """
    assert 1 <= qualifying <= HERRING_LADDER_SIZE
    entries: list[tuple[int | None, int | None]] = [(best_cp, None)]
    entries.extend((small_gap_cp, None) for _ in range(qualifying - 1))
    entries.extend((best_cp - 500 - 100 * i, None) for i in range(HERRING_LADDER_SIZE - qualifying))
    return _ladder(*entries)


def _boundary_cp(
    best_cp: int, target_gap: float, mover_color: Literal["white", "black"] = "white"
) -> int:
    """Return the integer cp closest to `best_cp` (moving away from it,
    mover-POV) whose expected-score gap from `best_cp` first reaches or
    exceeds `target_gap`. One cp step back TOWARD `best_cp` has a strictly
    SMALLER gap — so this is the tightest INCLUSIVE-boundary value for any
    `>=`-style gate, and the first EXCLUDED value for any strict `<`-style
    gate. Constructs the gap in expected-score space per 192-04-PLAN.md's
    instruction, rather than picking a cp offset and hoping it lands right.
    """
    best_es = expected_score_for(best_cp, None, mover_color)
    assert best_es is not None
    step = -1 if mover_color == "white" else 1
    cp = best_cp
    while True:
        cp += step
        es = expected_score_for(cp, None, mover_color)
        assert es is not None
        if best_es - es >= target_gap:
            return cp


@pytest.mark.asyncio
async def test_herring_requires_two_within_inaccuracy_drop(test_engine) -> None:
    """A row with only PV[0] inside the band (every alternative clearly
    worse) is not selected; a row with PV[0] and PV[1] inside it is."""
    user_id, _ = await _register_and_login(f"herring-reqtwo-{uuid.uuid4().hex[:8]}@example.com")
    game_one = await _seed_bare_game(test_engine, user_id)
    pool_one = await _seed_pool_row(
        test_engine, user_id, game_one, ply=8, ladder=_ladder_with_qualifying_count(1)
    )
    game_two = await _seed_bare_game(test_engine, user_id)
    pool_two = await _seed_pool_row(
        test_engine,
        user_id,
        game_two,
        ply=8,
        ladder=_ladder_with_qualifying_count(HERRING_MIN_QUALIFYING_MOVES),
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert [row.id for row in rows] == [pool_two]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_one, pool_two])
        await _delete_games(test_engine, [game_one, game_two])


@pytest.mark.asyncio
async def test_herring_gate_boundary_at_inaccuracy_drop(test_engine) -> None:
    """Three rows differing only in PV[1]'s cp: gap right at
    INACCURACY_DROP (excluded — the gate is strict `<`), one representable
    cp step closer to the best (gap just under the threshold, selected), and
    one step further away (gap just over, excluded)."""
    user_id, _ = await _register_and_login(f"herring-boundary-{uuid.uuid4().hex[:8]}@example.com")
    best_cp = 0
    at_boundary_cp = _boundary_cp(best_cp, INACCURACY_DROP)  # first EXCLUDED cp

    def _row_ladder(pv1_cp: int) -> list[dict[str, object]]:
        return _ladder((best_cp, None), (pv1_cp, None), (-1000, None), (-1010, None), (-1020, None))

    game_at = await _seed_bare_game(test_engine, user_id)
    pool_at = await _seed_pool_row(
        test_engine, user_id, game_at, ply=8, ladder=_row_ladder(at_boundary_cp)
    )
    game_under = await _seed_bare_game(test_engine, user_id)
    pool_under = await _seed_pool_row(
        test_engine, user_id, game_under, ply=8, ladder=_row_ladder(at_boundary_cp + 1)
    )
    game_over = await _seed_bare_game(test_engine, user_id)
    pool_over = await _seed_pool_row(
        test_engine, user_id, game_over, ply=8, ladder=_row_ladder(at_boundary_cp - 1)
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert [row.id for row in rows] == [pool_under]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_at, pool_under, pool_over])
        await _delete_games(test_engine, [game_at, game_under, game_over])


@pytest.mark.asyncio
async def test_herring_gate_counts_exactly_equal_moves(test_engine) -> None:
    """PV[0] and PV[1] share an identical cp (gap 0.0) — both count toward
    the qualifying tally (2, not 1 via an accidental distinct-value
    collapse), so the row is selected."""
    user_id, _ = await _register_and_login(f"herring-equalcp-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_bare_game(test_engine, user_id)
    ladder = _ladder((100, None), (100, None), (-500, None), (-600, None), (-700, None))
    pool_id = await _seed_pool_row(test_engine, user_id, game_id, ply=8, ladder=ladder)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert [row.id for row in rows] == [pool_id]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_degenerate_all_fine_position(test_engine) -> None:
    """A row whose PV[1] qualifies but whose PV[4] is inside
    HERRING_DEGENERATE_MIN_GAP_ES is not selected; the same row with PV[4]
    pushed exactly to the (inclusive) bound is selected."""
    user_id, _ = await _register_and_login(f"herring-degenerate-{uuid.uuid4().hex[:8]}@example.com")
    best_cp = 0
    at_bound_pv4 = _boundary_cp(best_cp, HERRING_DEGENERATE_MIN_GAP_ES)  # first INCLUDED cp

    game_flat = await _seed_bare_game(test_engine, user_id)
    pool_flat = await _seed_pool_row(
        test_engine,
        user_id,
        game_flat,
        ply=8,
        ladder=_ladder(
            (best_cp, None), (-5, None), (-10, None), (-15, None), (at_bound_pv4 + 1, None)
        ),
    )
    game_boundary = await _seed_bare_game(test_engine, user_id)
    pool_boundary = await _seed_pool_row(
        test_engine,
        user_id,
        game_boundary,
        ply=8,
        ladder=_ladder((best_cp, None), (-5, None), (-10, None), (-15, None), (at_bound_pv4, None)),
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert [row.id for row in rows] == [pool_boundary]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_flat, pool_boundary])
        await _delete_games(test_engine, [game_flat, game_boundary])


@pytest.mark.asyncio
async def test_herring_prefers_three_qualifying_moves(test_engine) -> None:
    """A row with HERRING_PREFERRED_QUALIFYING_MOVES qualifiers sorts before
    an otherwise-comparable row with only HERRING_MIN_QUALIFYING_MOVES, even
    though the 2-qualifier row was played MORE recently — the preference
    outranks recency — and the 2-qualifier row is still present in the
    result (a preference, never a filter)."""
    user_id, _ = await _register_and_login(f"herring-prefer3-{uuid.uuid4().hex[:8]}@example.com")
    game_three = await _seed_bare_game(test_engine, user_id)
    pool_three = await _seed_pool_row(
        test_engine,
        user_id,
        game_three,
        ply=8,
        ladder=_ladder_with_qualifying_count(HERRING_PREFERRED_QUALIFYING_MOVES),
        played_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    )
    game_two = await _seed_bare_game(test_engine, user_id)
    pool_two = await _seed_pool_row(
        test_engine,
        user_id,
        game_two,
        ply=8,
        ladder=_ladder_with_qualifying_count(HERRING_MIN_QUALIFYING_MOVES),
        played_at=datetime.datetime(2026, 1, 5, tzinfo=datetime.timezone.utc),
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert [row.id for row in rows] == [pool_three, pool_two]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_three, pool_two])
        await _delete_games(test_engine, [game_three, game_two])


@pytest.mark.asyncio
async def test_herring_gate_handles_mate_ladder_entry(test_engine) -> None:
    """A runner-up carrying `mate` (a small integer mate distance, not `cp`)
    converts through MATE_CP_EQUIVALENT before the sigmoid rather than being
    read as a near-zero raw cp value — a losing mate for the mover must not
    silently qualify as "fine" just because its magnitude looks small. PV[1]
    here is a mate-in-1 AGAINST the mover: mis-handled as a raw cp of -1
    (instead of -MATE_CP_EQUIVALENT), it would sit right next to a cp=0 best
    move and look like a second fine alternative. Correctly converted, it is
    far outside INACCURACY_DROP, so only PV[0] qualifies (count 1, below
    HERRING_MIN_QUALIFYING_MOVES) and the row is excluded."""
    user_id, _ = await _register_and_login(f"herring-mate-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_bare_game(test_engine, user_id)
    ladder = _ladder((0, None), (None, -1), (-1000, None), (-1010, None), (-1020, None))
    pool_id = await _seed_pool_row(test_engine, user_id, game_id, ply=8, ladder=ladder)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert rows == []
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_order_is_total_and_stable_under_ties(test_engine) -> None:
    """Two rows equal on preferred-tier and `source_played_at` still serve in
    the same sequence across repeated executions of the same statement —
    the trailing `id ASC` tiebreak, not insertion-order happenstance."""
    user_id, _ = await _register_and_login(f"herring-tiebreak-{uuid.uuid4().hex[:8]}@example.com")
    tied_played_at = datetime.datetime(2026, 1, 10, tzinfo=datetime.timezone.utc)
    ladder = _ladder_with_qualifying_count(HERRING_MIN_QUALIFYING_MOVES)

    game_a = await _seed_bare_game(test_engine, user_id)
    pool_a = await _seed_pool_row(
        test_engine, user_id, game_a, ply=8, ladder=ladder, played_at=tied_played_at
    )
    game_b = await _seed_bare_game(test_engine, user_id)
    pool_b = await _seed_pool_row(
        test_engine, user_id, game_b, ply=8, ladder=ladder, played_at=tied_played_at
    )
    expected_order = sorted([pool_a, pool_b])

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            first_run = (await session.execute(herring_stmt(user_id))).scalars().all()
            second_run = (await session.execute(herring_stmt(user_id))).scalars().all()
        assert [row.id for row in first_run] == expected_order
        assert [row.id for row in second_run] == expected_order
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_a, pool_b])
        await _delete_games(test_engine, [game_a, game_b])


@pytest.mark.asyncio
async def test_herring_allows_repeats_when_exhausted(test_engine) -> None:
    """With every pool row already served, `exclude_served=True` returns
    empty and `exclude_served=False` returns them — the exhaustion contract,
    carried over unchanged from the pre-Phase-192 source and re-expressed
    against the `herring_pool_id` key (D-04)."""
    user_id, _ = await _register_and_login(f"herring-exhausted-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_bare_game(test_engine, user_id)
    ladder = _ladder_with_qualifying_count(HERRING_MIN_QUALIFYING_MOVES)
    pool_id = await _seed_pool_row(test_engine, user_id, game_id, ply=8, ladder=ladder)
    await _seed_served_herring_by_pool_id(test_engine, user_id, game_id, pool_id)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            excluded_rows = (
                (await session.execute(herring_stmt(user_id, exclude_served=True))).scalars().all()
            )
            included_rows = (
                (await session.execute(herring_stmt(user_id, exclude_served=False))).scalars().all()
            )
        assert excluded_rows == []
        assert [row.id for row in included_rows] == [pool_id]
    finally:
        await _delete_herring_pool_rows(test_engine, [pool_id])
        await _delete_games(test_engine, [game_id])
