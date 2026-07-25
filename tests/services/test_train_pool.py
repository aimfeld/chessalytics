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
from typing import Any

import httpx
import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.main import app
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.services.eval_utils import LICHESS_K
from app.services.train_pool import (
    SHARP_GAP_ES,
    blob_pending_stmt,
    classify_puzzle_type,
    expected_score_for,
    herring_stmt,
    pool_entry_stmt,
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
# herring_stmt tests
# ---------------------------------------------------------------------------


async def _seed_herring_candidate(
    test_engine,
    user_id: int,
    *,
    ply: int = 8,
    user_color: str = "white",
    best_cp: int = 50,
    second_cp: int = 45,
    maia_prob: float = 0.9,
    prior_eval_cp: int | None = 300,
    played_at: datetime.datetime | None = None,
) -> int:
    """Seed one game + one game_best_moves candidate row (+ optional prior-ply
    eval for the winnability floor). Returns game_id."""
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
                played_at=played_at,
            )
            session.add(game)
            await session.flush()
            game_id: int = game.id

            candidate = GameBestMove(
                game_id=game_id,
                ply=ply,
                maia_prob=maia_prob,
                best_cp=best_cp,
                best_mate=None,
                second_cp=second_cp,
                second_mate=None,
            )
            session.add(candidate)

            if prior_eval_cp is not None:
                prior = GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=ply - 1,
                    full_hash=1_000_000 + game_id * 100 + ply,
                    white_hash=2_000_000 + game_id * 100 + ply,
                    black_hash=3_000_000 + game_id * 100 + ply,
                    eval_cp=prior_eval_cp,
                    eval_mate=None,
                )
                session.add(prior)

    return game_id


async def _add_herring_candidate_row(
    test_engine,
    user_id: int,
    game_id: int,
    *,
    ply: int,
    best_cp: int = 50,
    second_cp: int = 45,
    maia_prob: float = 0.9,
    prior_eval_cp: int | None = 300,
) -> None:
    """Add one more game_best_moves candidate row (+ prior-ply eval) to an
    EXISTING game_id — for multi-candidate-per-game ordering tests."""
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        async with session.begin():
            candidate = GameBestMove(
                game_id=game_id,
                ply=ply,
                maia_prob=maia_prob,
                best_cp=best_cp,
                best_mate=None,
                second_cp=second_cp,
                second_mate=None,
            )
            session.add(candidate)

            if prior_eval_cp is not None:
                prior = GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=ply - 1,
                    full_hash=4_000_000 + game_id * 100 + ply,
                    white_hash=5_000_000 + game_id * 100 + ply,
                    black_hash=6_000_000 + game_id * 100 + ply,
                    eval_cp=prior_eval_cp,
                    eval_mate=None,
                )
                session.add(prior)


async def _seed_served_herring(test_engine, user_id: int, game_id: int, ply: int) -> None:
    """Insert a DrillSession + DrillSolve(source=RED_HERRING) row marking
    (user_id, game_id, ply) as already served."""
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
                ply=ply,
                source=DrillSource.RED_HERRING,
            )
            session.add(solve)


@pytest.mark.asyncio
async def test_herring_includes_close_best_and_second(test_engine) -> None:
    """A candidate whose best/second gap is below SHARP_GAP_ES (several fine
    moves) and clears the winnability floor is a valid herring."""
    user_id, _ = await _register_and_login(f"herring-close-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_herring_candidate(test_engine, user_id, best_cp=50, second_cp=45)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        assert [(bm.game_id, bm.ply) for bm, _game in rows] == [(game_id, 8)]
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_gem_tier(test_engine) -> None:
    """A candidate that classifies as gem (large gap, low maia_prob) is excluded."""
    user_id, _ = await _register_and_login(f"herring-gem-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_herring_candidate(
        test_engine, user_id, best_cp=300, second_cp=-300, maia_prob=0.05
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_large_gap_easy_move(test_engine) -> None:
    """A large-gap candidate that is EASY to find (high maia_prob, tier NULL)
    must still be excluded — tier-IS-NULL alone would wrongly include it."""
    user_id, _ = await _register_and_login(f"herring-easy-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_herring_candidate(
        test_engine, user_id, best_cp=300, second_cp=-300, maia_prob=0.95
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_opponent_ply(test_engine) -> None:
    """A candidate whose mover is the opponent (ply parity) is excluded."""
    user_id, _ = await _register_and_login(f"herring-opp-{uuid.uuid4().hex[:8]}@example.com")
    # user_color=white, ply=7 (odd) -> black mover -> opponent ply.
    game_id = await _seed_herring_candidate(
        test_engine, user_id, ply=7, user_color="white", best_cp=50, second_cp=45
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_below_winnability_floor(test_engine) -> None:
    """A candidate from an already-hopeless pre-move position is excluded."""
    user_id, _ = await _register_and_login(f"herring-hopeless-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_herring_candidate(
        test_engine, user_id, best_cp=50, second_cp=45, prior_eval_cp=-2000
    )

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_excludes_other_users_games(test_engine) -> None:
    """An identical candidate seeded under a second user is absent from the
    first user's herring results (IDOR safety — T-189-09)."""
    user_id_a, _ = await _register_and_login(f"herring-a-{uuid.uuid4().hex[:8]}@example.com")
    user_id_b, _ = await _register_and_login(f"herring-b-{uuid.uuid4().hex[:8]}@example.com")
    game_id_b = await _seed_herring_candidate(test_engine, user_id_b, best_cp=50, second_cp=45)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id_a))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id_b])


@pytest.mark.asyncio
async def test_herring_excludes_already_served(test_engine) -> None:
    """A (game_id, ply) already served as a red herring is excluded by default."""
    user_id, _ = await _register_and_login(f"herring-served-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_herring_candidate(test_engine, user_id, ply=8, best_cp=50, second_cp=45)
    await _seed_served_herring(test_engine, user_id, game_id, ply=8)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        assert rows == []
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_allows_repeats_when_exhausted(test_engine) -> None:
    """With exclude_served=False the same already-served candidate is returned
    again — the exhaustion fallback."""
    user_id, _ = await _register_and_login(f"herring-repeat-{uuid.uuid4().hex[:8]}@example.com")
    game_id = await _seed_herring_candidate(test_engine, user_id, ply=8, best_cp=50, second_cp=45)
    await _seed_served_herring(test_engine, user_id, game_id, ply=8)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id, exclude_served=False))).all()
        assert [(bm.game_id, bm.ply) for bm, _game in rows] == [(game_id, 8)]
    finally:
        await _delete_games(test_engine, [game_id])


@pytest.mark.asyncio
async def test_herring_order_is_recency_then_deterministic(test_engine) -> None:
    """Game.played_at DESC (nulls last), then game_id DESC, then ply ASC —
    three candidates across two games with distinct played_at, exact order."""
    user_id, _ = await _register_and_login(f"herring-order-{uuid.uuid4().hex[:8]}@example.com")
    game_a = await _seed_herring_candidate(
        test_engine,
        user_id,
        ply=8,
        best_cp=50,
        second_cp=45,
        played_at=datetime.datetime(2026, 1, 3, tzinfo=datetime.timezone.utc),
    )
    game_b = await _seed_herring_candidate(
        test_engine,
        user_id,
        ply=6,
        best_cp=50,
        second_cp=45,
        played_at=datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc),
    )
    await _add_herring_candidate_row(test_engine, user_id, game_b, ply=10)

    try:
        session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
        async with session_maker() as session:
            rows = (await session.execute(herring_stmt(user_id))).all()
        actual_order = [(bm.game_id, bm.ply) for bm, _game in rows]
        # game_a (most recent) first; then game_b's two candidates, ply ASC.
        assert actual_order == [(game_a, 8), (game_b, 6), (game_b, 10)]
    finally:
        await _delete_games(test_engine, [game_a, game_b])
