"""Tests for the Phase 174 GEMS-03 best-move candidate builder in eval_apply.

Covers the three cases the plan calls out:
  1. Candidate gate — an out-of-book played==best ply with a >= INACCURACY_DROP
     expected-score margin yields a row; a sub-margin ply, an in-book ply, and a
     played!=best ply each yield nothing.
  2. Pitfall-1 fallback — a played==best out-of-book ply whose second-best is MISSING
     (the remote-worker MultiPV-1 lane) triggers a targeted, backend-owned
     evaluate_nodes_multipv2 call and still produces a row.
  3. Idempotency — re-running the upsert over the same (game_id, ply) updates in place
     rather than duplicating.

The gate + fallback plumbing runs in the default no-group suite: `score_move` is
monkeypatched to a fixed probability (no onnxruntime needed) and the Pitfall-1 Stockfish
fallback is monkeypatched to a fixed 7-tuple (no real engine needed).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock

import chess
import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.services import eval_apply
from app.services.eval_apply import (
    _build_best_move_candidates,
    _build_bestmove_lease_positions,
    _contiguous_san_prefix,
    _eval_of_position_map,
    _FullPlyEvalTarget,
    _upsert_best_move_rows,
)
from tests.test_eval_worker_endpoints import (
    _BLUNDER_SUBMIT_EVALS_142,
    _SIX_PLY_PGN_142,
    _atomic_request,
    _get_game_position,
    _patch_router_session,
)
from tests.test_eval_worker_endpoints import _delete_games as _delete_games_homogenization
from tests.test_eval_worker_endpoints import _insert_game as _insert_atomic_game
from tests.test_eval_worker_endpoints import (
    _insert_game_positions as _insert_atomic_game_positions,
)

_TEST_USER_ID: int = 99205  # unique to this module to avoid FK conflicts

# Match the builder's parameter types exactly (dict is invariant — ty rejects a
# narrower literal type otherwise).
_EngineResultMap = dict[int, tuple[int | None, int | None, str | None, str | None]]
_SecondBestMap = dict[int, tuple[int | None, int | None, str | None]]


# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture(scope="session")
async def ea_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """async_sessionmaker bound to the per-run test DB engine."""
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(scope="session")
async def ea_user(ea_session_maker: async_sessionmaker[AsyncSession]) -> int:
    """Ensure the module's test user exists (committed)."""
    from app.models.user import User

    async with ea_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID,
                    email=f"eval-apply-{_TEST_USER_ID}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID


# ─── DB helpers ─────────────────────────────────────────────────────────────────


async def _insert_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    *,
    pgn: str = "*",
    white_rating: int | None = 1500,
    black_rating: int | None = 1500,
    platform: str = "chess.com",
    tc_bucket: str | None = "blitz",
    tc_str: str | None = "300+0",
) -> int:
    """Insert a minimal Game row (committed). Returns the game_id."""
    from app.models.game import Game

    async with session_maker() as session:
        g = Game(
            user_id=user_id,
            platform=platform,
            platform_game_id=f"eval-apply-{uuid.uuid4().hex}",
            pgn=pgn,
            result="1-0",
            user_color="white",
            rated=True,
            is_computer_game=False,
            white_rating=white_rating,
            black_rating=black_rating,
            time_control_bucket=tc_bucket,
            time_control_str=tc_str,
        )
        session.add(g)
        await session.flush()
        game_id = g.id
        await session.commit()
    return game_id


async def _delete_game(session_maker: async_sessionmaker[AsyncSession], game_id: int) -> None:
    """Delete a game (CASCADE removes its game_best_moves rows)."""
    from app.models.game import Game

    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.id == game_id))
        await session.commit()


async def _count_best_moves(session_maker: async_sessionmaker[AsyncSession], game_id: int) -> int:
    async with session_maker() as session:
        return (
            await session.scalar(
                select(func.count())
                .select_from(GameBestMove)
                .where(GameBestMove.game_id == game_id)
            )
        ) or 0


def _target(
    ply: int, move_uci: str, move_san: str, board: chess.Board | None = None
) -> _FullPlyEvalTarget:
    """A minimal pre-move target for one ply (board content is irrelevant for most
    tests here, since score_move / the Stockfish fallback are monkeypatched).

    Pass `board` explicitly (a REAL board reflecting the actual position at
    `ply`, with a correctly-populated `move_stack`) for a test that exercises
    book-depth detection: `_contiguous_san_prefix` (CR-01 fix, 174-06) derives
    the book-depth prefix from the deepest target's `board.move_stack`, not
    from a bare default board.
    """
    return _FullPlyEvalTarget(
        game_id=0,
        ply=ply,
        full_hash=0,
        board=board if board is not None else chess.Board(),
        eval_cp=None,
        eval_mate=None,
        move_uci=move_uci,
        move_san=move_san,
    )


# ─── 0. Book-prefix reconstruction ──────────────────────────────────────────────


class TestContiguousSanPrefix:
    """`_contiguous_san_prefix` derives the game's SAN move order from the deepest
    target's board.move_stack, replayed from the standard start."""

    def test_standard_start_reconstructs_full_prefix(self) -> None:
        board = chess.Board()
        board.push_san("e4")
        board.push_san("e5")
        target = _target(2, "g1f3", "Nf3", board=board.copy())
        assert _contiguous_san_prefix([target]) == ["e4", "e5", "Nf3"]

    def test_from_position_game_returns_empty(self) -> None:
        """A "from position" game (custom initial FEN) has a move_stack legal only
        from its own root; replaying it from the standard start used to raise
        AssertionError in san() (FLAWCHESS-8W). It has no standard opening, so the
        prefix is empty."""
        board = chess.Board("rnbqkbnr/p1pppppp/8/1p6/2B5/8/PPPP1PPP/RNBQK1NR w KQkq - 0 1")
        board.push_san("Bxb5")  # c4b5 — illegal from the standard starting position
        target = _target(1, "a7a6", "a6", board=board.copy())
        assert _contiguous_san_prefix([target]) == []


# ─── 1. Candidate gate ──────────────────────────────────────────────────────────


class TestCandidateGate:
    """GEMS-02/03: out-of-book AND played==best AND ES margin >= INACCURACY_DROP."""

    async def test_out_of_book_played_best_yields_row(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """A played==best out-of-book ply with a wide ES margin yields exactly one row
        carrying the Maia probability and the raw best/second cp."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.1)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]  # ply 0 absent -> book depth 0
            engine_result_map: _EngineResultMap = {6: (300, None, "e2e4", None)}
            second_best_map: _SecondBestMap = {6: (-100, None, "d2d4")}

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )

            assert len(rows) == 1
            row = rows[0]
            assert row["game_id"] == game_id
            assert row["ply"] == 6
            assert row["maia_prob"] == 0.1
            assert row["best_cp"] == 300
            assert row["second_cp"] == -100
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_below_margin_no_row(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """A played==best ply whose best beats the runner-up by < INACCURACY_DROP
        (0.05 ES) is not a candidate — only-good-move-ness is what makes a gem."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.1)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]
            engine_result_map: _EngineResultMap = {6: (10, None, "e2e4", None)}
            second_best_map: _SecondBestMap = {6: (5, None, "d2d4")}  # ~0.0046 ES margin < 0.05

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert rows == []
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_in_book_ply_no_row(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """A played==best ply INSIDE the opening book (ply < find_opening_ply_count)
        is excluded — book theory is not a gem (D-04).

        Boards are REAL, sequentially-played positions (not the bare default board
        `_target` otherwise uses) because the CR-01 book-depth fix derives the
        prefix from the deepest target's `board.move_stack` — a bare board would
        report an empty stack and silently mis-detect book depth."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.1)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            # Contiguous book prefix e4 e5 Nf3 -> book depth 3, so ply 2 is in book.
            board0 = chess.Board()
            board1 = board0.copy()
            board1.push_san("e4")
            board2 = board1.copy()
            board2.push_san("e5")
            targets = [
                _target(0, "e2e4", "e4", board=board0),
                _target(1, "e7e5", "e5", board=board1),
                _target(2, "g1f3", "Nf3", board=board2),
            ]
            engine_result_map: _EngineResultMap = {2: (300, None, "g1f3", None)}
            second_best_map: _SecondBestMap = {2: (-100, None, "b1c3")}

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert rows == []
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_sparse_targets_book_depth_not_collapsed_cr01(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """CR-01 regression guard: a sparse `targets` list missing plies 0-2 (the
        historical local-drain lichess-eval call-site shape, before Phase 174-06
        Task 1 retired that filter) must NOT collapse book depth to 0.

        Real game: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (Ruy Lopez, book depth 5). `targets`
        only contains plies 3 (Nc6) and 4 (Bb5) — plies 0-2 are absent entirely, not
        just missing their `move_san`. Bb5 (ply 4) is wired as a played==best,
        wide-margin candidate: if book depth collapsed to 0 (the pre-fix bug), this
        would incorrectly yield a row despite Bb5 completing a fully book line.
        """
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.1)

        boards: dict[int, chess.Board] = {}
        board = chess.Board()
        for ply, san in enumerate(["e4", "e5", "Nf3", "Nc6", "Bb5"]):
            boards[ply] = board.copy()
            board.push_san(san)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            # Plies 0-2 deliberately absent — only the flaw-adjacent/hole subset the
            # (retired) lichess targets filter used to leave behind.
            targets = [
                _target(3, "b8c6", "Nc6", board=boards[3]),
                _target(4, "f1b5", "Bb5", board=boards[4]),
            ]
            # Only ply 4 (Bb5, white to move) is wired as a would-be candidate.
            engine_result_map: _EngineResultMap = {4: (300, None, "f1b5", None)}
            second_best_map: _SecondBestMap = {4: (-300, None, "c2c4")}

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert rows == [], (
                "Bb5 completes the 5-ply Ruy Lopez book line -- must be excluded "
                "even though targets omits plies 0-2 (CR-01 regression guard)"
            )
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_played_not_best_no_row(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """A ply where the played move != Stockfish best is never a candidate."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.1)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]
            engine_result_map: _EngineResultMap = {6: (300, None, "d2d4", None)}  # best != played
            second_best_map: _SecondBestMap = {6: (-100, None, "e2e4")}

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert rows == []
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_maia_disabled_no_rows(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """When Maia is disabled (score_move returns None, e.g. onnxruntime absent),
        the builder produces no rows and does not crash."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: None)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]
            engine_result_map: _EngineResultMap = {6: (300, None, "e2e4", None)}
            second_best_map: _SecondBestMap = {6: (-100, None, "d2d4")}

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert rows == []
        finally:
            await _delete_game(ea_session_maker, game_id)


# ─── 2. Pitfall-1 fallback (remote-worker MultiPV-1 lane) ───────────────────────


class TestPitfall1Fallback:
    """A played==best out-of-book ply with NO second-best (second_best_map is None,
    the remote-worker lane) triggers a targeted backend evaluate_nodes_multipv2 call."""

    async def test_missing_second_best_triggers_targeted_fallback(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.12)
        # evaluate_nodes_multipv2 -> (cp, mate, best, pv, second_cp, second_mate, second_uci)
        spy = AsyncMock(return_value=(300, None, "e2e4", None, -100, None, "d2d4"))
        monkeypatch.setattr(eval_apply.engine_service, "evaluate_nodes_multipv2", spy)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]
            engine_result_map: _EngineResultMap = {6: (300, None, "e2e4", None)}

            rows = await _build_best_move_candidates(
                game_id,
                targets,
                engine_result_map,
                None,  # no second-best coverage
            )

            assert spy.await_count == 1, "the targeted MultiPV-2 fallback must fire once"
            assert len(rows) == 1
            row = rows[0]
            assert row["ply"] == 6
            assert row["second_cp"] == -100  # sourced from the fallback, not a drop
            assert row["maia_prob"] == 0.12
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_no_fallback_when_second_best_present(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """The local lane already carries second-best, so no extra Stockfish is spent."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.1)
        spy = AsyncMock(return_value=(300, None, "e2e4", None, -100, None, "d2d4"))
        monkeypatch.setattr(eval_apply.engine_service, "evaluate_nodes_multipv2", spy)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]
            engine_result_map: _EngineResultMap = {6: (300, None, "e2e4", None)}
            second_best_map: _SecondBestMap = {6: (-100, None, "d2d4")}

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert spy.await_count == 0, "no fallback when second-best is already present"
            assert len(rows) == 1
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_build_best_move_candidates_uses_submitted_second_best(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """Phase 177 PROTO-03: a second_best_map covering ALL candidate plies (the
        v2-worker submit shape) means the builder runs ZERO fallback Stockfish
        searches, across multiple candidate plies in the same call."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.15)
        spy = AsyncMock(return_value=(300, None, "e2e4", None, -100, None, "d2d4"))
        monkeypatch.setattr(eval_apply.engine_service, "evaluate_nodes_multipv2", spy)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [
                _target(6, "e2e4", "Ne2"),
                _target(8, "d2d4", "d4"),
            ]
            engine_result_map: _EngineResultMap = {
                6: (300, None, "e2e4", None),
                8: (250, None, "d2d4", None),
            }
            second_best_map: _SecondBestMap = {
                6: (-100, None, "d2d4"),
                8: (-150, None, "e2e4"),
            }

            rows = await _build_best_move_candidates(
                game_id, targets, engine_result_map, second_best_map
            )
            assert spy.await_count == 0, (
                "second_best_map covers every candidate ply -- ZERO fallback "
                "Stockfish searches must run"
            )
            assert len(rows) == 2
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_best_move_candidates_fallback_source_tag(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """Phase 177 D-06/OBS-01: when the Pitfall-1 fallback fires, the caller's
        `source` label is recorded as a Sentry tag under the key "source" — so a
        worker-submit-path fallback is queryable independent of the expected
        drain-local fallback noise."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        monkeypatch.setattr(eval_apply, "score_move", lambda fen, elo, uci: 0.12)
        spy = AsyncMock(return_value=(300, None, "e2e4", None, -100, None, "d2d4"))
        monkeypatch.setattr(eval_apply.engine_service, "evaluate_nodes_multipv2", spy)

        set_tag_calls: list[tuple[str, str]] = []
        monkeypatch.setattr(
            eval_apply.sentry_sdk,
            "set_tag",
            lambda key, value: set_tag_calls.append((key, value)),
        )
        monkeypatch.setattr(eval_apply.sentry_sdk, "set_context", lambda *a, **kw: None)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            targets = [_target(6, "e2e4", "Ne2")]
            engine_result_map: _EngineResultMap = {6: (300, None, "e2e4", None)}

            rows = await _build_best_move_candidates(
                game_id,
                targets,
                engine_result_map,
                None,  # no second-best coverage -> fallback fires
                source="worker-submit-fallback",
            )

            assert spy.await_count == 1, "the fallback must fire once"
            assert len(rows) == 1
            assert ("source", "worker-submit-fallback") in set_tag_calls, (
                f"Expected a ('source', 'worker-submit-fallback') Sentry tag, got {set_tag_calls}"
            )
        finally:
            await _delete_game(ea_session_maker, game_id)


# ─── 3. Idempotent upsert ───────────────────────────────────────────────────────


class TestUpsertIdempotency:
    """Re-running the builder over the same game upserts on (game_id, ply), not
    duplicates (T-174-12)."""

    async def test_upsert_updates_in_place(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            first: list[dict[str, Any]] = [
                {
                    "game_id": game_id,
                    "ply": 6,
                    "maia_prob": 0.10,
                    "best_cp": 300,
                    "best_mate": None,
                    "second_cp": -100,
                    "second_mate": None,
                }
            ]
            async with ea_session_maker() as session:
                await _upsert_best_move_rows(session, first)
                await session.commit()

            second = [dict(first[0], maia_prob=0.42, second_cp=-50)]
            async with ea_session_maker() as session:
                await _upsert_best_move_rows(session, second)
                await session.commit()

            assert await _count_best_moves(ea_session_maker, game_id) == 1

            async with ea_session_maker() as session:
                row = (
                    await session.execute(
                        select(GameBestMove).where(
                            GameBestMove.game_id == game_id, GameBestMove.ply == 6
                        )
                    )
                ).scalar_one()
                assert row.maia_prob == pytest.approx(0.42, abs=1e-6)  # REAL is float32
                assert row.second_cp == -50
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_upsert_empty_is_noop(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            async with ea_session_maker() as session:
                await _upsert_best_move_rows(session, [])
                await session.commit()
            assert await _count_best_moves(ea_session_maker, game_id) == 0
        finally:
            await _delete_game(ea_session_maker, game_id)


# ─── 4. Phase 177 BACK-02: tier-4b lease-position reconstruction ────────────────


async def _insert_game_positions(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    rows: list[dict[str, Any]],
) -> None:
    """Insert GamePosition rows carrying `best_move` (un-shifted, decision-keyed)
    and `eval_cp`/`eval_mate` (post-move shifted, SEED-044) exactly as stored,
    for the tier-4b reconstruction tests below. Each dict: {"ply", "full_hash",
    "best_move", "eval_cp", "eval_mate"}."""
    from app.models.game_position import GamePosition

    async with session_maker() as session:
        for r in rows:
            session.add(
                GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=r["ply"],
                    full_hash=r.get("full_hash", r["ply"]),
                    white_hash=0,
                    black_hash=0,
                    best_move=r.get("best_move"),
                    eval_cp=r.get("eval_cp"),
                    eval_mate=r.get("eval_mate"),
                )
            )
        await session.commit()


class TestEvalOfPositionMap:
    """Pitfall 1: `_eval_of_position_map` inverts `_post_move_eval`'s +1 forward
    shift — pure, no DB/session needed."""

    def test_inverts_post_move_shift(self) -> None:
        # Row ply=0's stored eval is "eval of position 1"; row ply=1's stored
        # eval is "eval of position 2" (SEED-044 post-move convention).
        gp_rows = [(0, 100, None), (1, -50, None)]
        result = _eval_of_position_map(gp_rows)
        assert result == {1: (100, None), 2: (-50, None)}

    def test_ply_zero_resolves_to_none_none_no_crash(self) -> None:
        """No row -1 exists, so key 0 is never populated — callers MUST read via
        .get(ply, (None, None)), never index directly (Pitfall 1)."""
        gp_rows = [(0, 100, None), (1, -50, None)]
        result = _eval_of_position_map(gp_rows)
        assert 0 not in result
        assert result.get(0, (None, None)) == (None, None)

    def test_empty_input_yields_empty_map(self) -> None:
        assert _eval_of_position_map([]) == {}


class TestBestMoveLeasePositions:
    """`_build_bestmove_lease_positions` (Task 1, BACK-02): server-recomputed
    tier-4b candidate-ply FENs from already-stored full-pass data — no engine
    calls (S-05).

    Fixture game: "1. a4 a5 2. h4 h5" -- find_opening_ply_count(['a4','a5','h4'])
    == 2 (verified against the real openings.tsv data), so plies 0-1 are book and
    plies 2-3 are out-of-book. UCIs: a4=a2a4, a5=a7a5, h4=h2h4, h5=h7h5.
    """

    _PGN: str = "1. a4 a5 2. h4 h5 *"

    async def test_out_of_book_played_best_yields_candidate(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """Ply 2 (h4, white) is out-of-book, played == stored best_move, and has a
        usable eval_of_position -- included. Ply 0/1 (book) and ply 3 (played !=
        stored best) are excluded."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)

        game_id = await _insert_game(ea_session_maker, ea_user, pgn=self._PGN)
        try:
            await _insert_game_positions(
                ea_session_maker,
                ea_user,
                game_id,
                [
                    {"ply": 0, "best_move": "a2a4", "eval_cp": 1, "eval_mate": None},
                    {"ply": 1, "best_move": "h2h4", "eval_cp": 2, "eval_mate": None},
                    {"ply": 2, "best_move": "h2h4", "eval_cp": 3, "eval_mate": None},
                    # ply 3: played h7h5, but stored best_move differs -> not a candidate.
                    {"ply": 3, "best_move": "a7a6", "eval_cp": 4, "eval_mate": None},
                ],
            )

            positions = await _build_bestmove_lease_positions(game_id)

            assert [p.ply for p in positions] == [2]
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_missing_prior_row_excludes_candidate_no_crash(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """A candidate ply whose (ply - 1) row is absent from the DB has no
        resolvable eval_of_position -- excluded via the Pitfall-1 None guard,
        without raising."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)

        game_id = await _insert_game(ea_session_maker, ea_user, pgn=self._PGN)
        try:
            await _insert_game_positions(
                ea_session_maker,
                ea_user,
                game_id,
                [
                    {"ply": 0, "best_move": "a2a4", "eval_cp": 1, "eval_mate": None},
                    # ply 1 row deliberately absent -> eval_of_position(2) unresolvable.
                    {"ply": 2, "best_move": "h2h4", "eval_cp": 3, "eval_mate": None},
                ],
            )

            positions = await _build_bestmove_lease_positions(game_id)

            assert positions == []
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_no_positions_returns_empty(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        """A game with no stored GamePosition rows yields no candidates, no crash."""
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)

        game_id = await _insert_game(ea_session_maker, ea_user)
        try:
            positions = await _build_bestmove_lease_positions(game_id)
            assert positions == []
        finally:
            await _delete_game(ea_session_maker, game_id)

    async def test_missing_game_returns_empty(
        self,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch,
    ) -> None:
        monkeypatch.setattr(eval_apply, "async_session_maker", ea_session_maker)
        positions = await _build_bestmove_lease_positions(-1)
        assert positions == []


# ─── Homogenization (Phase 212 BENCHLANE-05, D-03) ──────────────────────────
#
# Proves the homogenized write path -- driven through the PRODUCTION submit
# entry point app.routers.eval_remote._apply_atomic_submit, never a copy of
# the classify/write logic, mirroring tests/services/write_path_golden_scenarios.py's
# own reuse pattern. All six tests use one game (_SIX_PLY_PGN_142) with
# lichess_evals_at set and a stored eval_cp (999) recognizably different from
# the submitted engine values (_BLUNDER_SUBMIT_EVALS_142: post-move-shifted to
# [20, 30, -500, -480, 60, 30] at plies 0-5) so a preserved-vs-overwritten
# assertion cannot pass by coincidence.

_HOMOGENIZATION_STORED_EVAL_CP: int = 999
# Post-move shift (SEED-044): row `ply`'s eval_cp = the submitted eval at
# index ply+1. Matches _BLUNDER_SUBMIT_EVALS_142's own documented mapping.
_HOMOGENIZATION_EXPECTED_ENGINE_EVAL_CP_BY_PLY: dict[int, int] = {
    0: 20,
    1: 30,
    2: -500,
    3: -480,
    4: 60,
    5: 30,
}


async def _get_game_lichess_evals_at(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> datetime | None:
    from app.models.game import Game

    async with session_maker() as session:
        result = await session.execute(select(Game.lichess_evals_at).where(Game.id == game_id))
        return result.scalar_one_or_none()


async def _seed_homogenization_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
) -> int:
    """A lichess-eval _SIX_PLY_PGN_142 game with stored eval_cp=999 at every
    ply (0-5) -- a flat, non-flaw sequence recognizably different from the
    submitted engine values."""
    now = datetime.now(timezone.utc)
    game_id = await _insert_atomic_game(
        session_maker,
        user_id,
        pgn=_SIX_PLY_PGN_142,
        lichess_evals_at=now,
    )
    await _insert_atomic_game_positions(
        session_maker,
        user_id,
        game_id,
        [
            {"ply": p, "full_hash": 212_040_000 + p, "eval_cp": _HOMOGENIZATION_STORED_EVAL_CP}
            for p in range(6)
        ],
    )
    return game_id


async def _run_homogenization_submit(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> None:
    """Drive the production submit entry point directly (bypasses the
    HTTP/auth layer), submitting _BLUNDER_SUBMIT_EVALS_142."""
    from app.routers.eval_remote import _apply_atomic_submit

    await _apply_atomic_submit(
        game_id,
        _atomic_request(game_id, list(_BLUNDER_SUBMIT_EVALS_142)),
        worker_id="test-homogenization",
        last_ip=None,
    )


class TestHomogenization:
    """Phase 212 BENCHLANE-05 (D-03): BENCHMARK_HOMOGENIZE_EVAL_SOURCE forces
    the drain write path to store our engine's eval_cp instead of preserving
    a lichess-eval game's stored value, restores the terminal eval donor,
    enables opening dedup, and classifies game_flaws from the engine values --
    while games.lichess_evals_at itself stays byte-identical in both flag
    states (D-04's §6 selection-marker guarantee)."""

    async def test_homogenization_off_preserves_lichess_eval_cp(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Control: pins today's behavior (flag off, the default) so the
        flag-on test means something -- a lichess-eval game's stored eval_cp
        is preserved; the submitted engine value is discarded."""
        monkeypatch.setattr(settings, "BENCHMARK_HOMOGENIZE_EVAL_SOURCE", False)
        _patch_router_session(monkeypatch, ea_session_maker)

        game_id = await _seed_homogenization_game(ea_session_maker, ea_user)
        try:
            await _run_homogenization_submit(ea_session_maker, game_id)

            for ply in range(6):
                row = await _get_game_position(ea_session_maker, game_id, ply)
                assert row is not None
                assert row["eval_cp"] == _HOMOGENIZATION_STORED_EVAL_CP, (
                    f"ply {ply}: expected preserved stored eval_cp="
                    f"{_HOMOGENIZATION_STORED_EVAL_CP}, got {row['eval_cp']}"
                )
        finally:
            await _delete_games_homogenization(ea_session_maker, [game_id])

    async def test_homogenization_on_overwrites_eval_cp_with_engine_value(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag on: the stored eval_cp becomes the submitted engine value
        (post-move shifted) -- fails if the override is removed from
        derive_is_lichess_eval_game."""
        monkeypatch.setattr(settings, "BENCHMARK_HOMOGENIZE_EVAL_SOURCE", True)
        _patch_router_session(monkeypatch, ea_session_maker)

        game_id = await _seed_homogenization_game(ea_session_maker, ea_user)
        try:
            await _run_homogenization_submit(ea_session_maker, game_id)

            for ply, expected_cp in _HOMOGENIZATION_EXPECTED_ENGINE_EVAL_CP_BY_PLY.items():
                row = await _get_game_position(ea_session_maker, game_id, ply)
                assert row is not None
                assert row["eval_cp"] == expected_cp, (
                    f"ply {ply}: expected engine eval_cp={expected_cp}, got {row['eval_cp']}"
                )
        finally:
            await _delete_games_homogenization(ea_session_maker, [game_id])

    async def test_homogenization_on_restores_terminal_donor(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag on: _collect_full_ply_targets is called with
        include_terminal=True for a lichess-eval game (the terminal donor is
        restored) -- asserted by patching _collect_full_ply_targets and
        inspecting the kwarg it was actually called with."""
        import app.routers.eval_remote as eval_remote_module
        from app.services.eval_apply import _collect_full_ply_targets as _real_collect

        monkeypatch.setattr(settings, "BENCHMARK_HOMOGENIZE_EVAL_SOURCE", True)
        _patch_router_session(monkeypatch, ea_session_maker)

        captured_kwargs: dict[str, Any] = {}

        def _spy_collect(*args: Any, **kwargs: Any) -> Any:
            captured_kwargs.update(kwargs)
            return _real_collect(*args, **kwargs)

        monkeypatch.setattr(eval_remote_module, "_collect_full_ply_targets", _spy_collect)

        game_id = await _seed_homogenization_game(ea_session_maker, ea_user)
        try:
            await _run_homogenization_submit(ea_session_maker, game_id)

            assert captured_kwargs.get("include_terminal") is True
        finally:
            await _delete_games_homogenization(ea_session_maker, [game_id])

    async def test_homogenization_on_enables_opening_dedup(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag on: the opening-region dedup lookup actually runs for a
        lichess-eval game (a non-empty candidate full_hash list is passed to
        _fetch_dedup_evals), instead of being short-circuited to the
        unconditional {} the flag-off branch uses."""
        import app.routers.eval_remote as eval_remote_module
        from app.services.eval_apply import _fetch_dedup_evals as _real_fetch_dedup

        monkeypatch.setattr(settings, "BENCHMARK_HOMOGENIZE_EVAL_SOURCE", True)
        _patch_router_session(monkeypatch, ea_session_maker)

        captured_hashes: list[list[int]] = []

        async def _spy_fetch_dedup(session: Any, full_hashes: list[int]) -> Any:
            captured_hashes.append(list(full_hashes))
            return await _real_fetch_dedup(session, full_hashes)

        monkeypatch.setattr(eval_remote_module, "_fetch_dedup_evals", _spy_fetch_dedup)

        game_id = await _seed_homogenization_game(ea_session_maker, ea_user)
        try:
            await _run_homogenization_submit(ea_session_maker, game_id)

            assert len(captured_hashes) == 1, "expected exactly one _fetch_dedup_evals call"
            assert captured_hashes[0], "expected a non-empty opening-region hash list"
        finally:
            await _delete_games_homogenization(ea_session_maker, [game_id])

    async def test_homogenization_on_classifies_flaws_from_engine_values(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Flag on: game_flaws classification is driven by the just-written
        engine values (the blunder at ply 2), not the flat stored lichess
        values that would have produced zero flaws."""
        monkeypatch.setattr(settings, "BENCHMARK_HOMOGENIZE_EVAL_SOURCE", True)
        _patch_router_session(monkeypatch, ea_session_maker)

        game_id = await _seed_homogenization_game(ea_session_maker, ea_user)
        try:
            await _run_homogenization_submit(ea_session_maker, game_id)

            async with ea_session_maker() as session:
                result = await session.execute(
                    select(GameFlaw).where(GameFlaw.game_id == game_id, GameFlaw.ply == 2)
                )
                flaw = result.scalar_one_or_none()
            assert flaw is not None, (
                "expected a game_flaws row at ply 2 (the blunder swing in the "
                "just-written engine values), not zero flaws from the flat "
                "stored lichess values"
            )
        finally:
            await _delete_games_homogenization(ea_session_maker, [game_id])

    async def test_homogenization_never_writes_lichess_evals_at(
        self,
        ea_user: int,
        ea_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """D-04's guarantee is load-bearing for §6: re-read the game after the
        write in BOTH flag states and assert the timestamp is byte-identical
        to what it was before -- this is the assertion that fails loudly if a
        future change starts clearing it. Two separate games (one per flag
        state) so neither run's write session can contaminate the other's
        assertion."""
        _patch_router_session(monkeypatch, ea_session_maker)

        for homogenize in (False, True):
            monkeypatch.setattr(settings, "BENCHMARK_HOMOGENIZE_EVAL_SOURCE", homogenize)

            game_id = await _seed_homogenization_game(ea_session_maker, ea_user)
            try:
                before = await _get_game_lichess_evals_at(ea_session_maker, game_id)
                assert before is not None

                await _run_homogenization_submit(ea_session_maker, game_id)

                after = await _get_game_lichess_evals_at(ea_session_maker, game_id)
                assert after == before, (
                    f"games.lichess_evals_at must never change (homogenize={homogenize}): "
                    f"before={before!r}, after={after!r}"
                )
            finally:
                await _delete_games_homogenization(ea_session_maker, [game_id])
