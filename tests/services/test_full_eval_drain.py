"""Integration tests for run_full_eval_drain (Phase 116 EVAL-01/03/05/QUEUE-07,
Phase 117 EVAL-04/EVAL-06/D-117-07/QUEUE-03).

Tests cover:
- EVAL-01: all non-terminal plies collected; terminal position excluded
- EVAL-01: PGN parse failure returns empty list
- EVAL-03: dedup returns hit for known parity hash (full_evals_completed_at gated)
- EVAL-03: dedup ignores depth-15 source (no full_evals_completed_at marker)
- EVAL-04: best_move populated on every evaluated non-dedup'd ply after drain tick
- EVAL-04: dedup_best_move transplanted via dedup for opening-region plies (D-117-01)
- EVAL-04: flaw_pv written ONLY at ply N+1 for FlawRecord at ply N (D-117-02)
- EVAL-05: full_evals_completed_at set after drain tick
- EVAL-05: marker set even when engine returns (None, None) holes
- EVAL-06: classify_hook — game_flaws rows exist after full eval completes
- EVAL-06: oracle_counts — white/black oracle columns filled and match game_flaws
- D-117-07: wr02_repointed — lichess_evals_at gates dedup source, not white_blunders
- QUEUE-03: gather_outside_session — asyncio.gather NOT inside an AsyncSession scope (AST scan)
- QUEUE-07: yield gate is True when an active ImportJob exists
- QUEUE-07: yield gate is True when a game has evals_completed_at IS NULL

Session patching mirrors test_eval_drain.py: monkeypatch
app.services.eval_drain.async_session_maker to route drain sessions to the
test DB. Engine calls are monkeypatched for all drain-logic tests; no real
Stockfish required.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import uuid
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, patch

import chess
import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# ─── Module-level test constants ──────────────────────────────────────────────

_TEST_USER_ID: int = 99200  # unique to this module to avoid FK conflicts
_TEST_USER_ID_117: int = 99201  # separate range for Phase 117 tests to avoid FK conflicts
# A short PGN ending in checkmate (Scholar's mate in 4 moves = 8 half-moves).
# The final position IS checkmate; the iterator should never visit it.
_CHECKMATE_PGN: str = "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7# 1-0"
# A simple non-terminal PGN used for general tests.
_SIMPLE_PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"
# A minimal PGN with only 2 moves (4 half-moves).
_TWO_MOVE_PGN: str = "1. e4 e5 *"
# A 6-half-move PGN (3 moves each, 6 non-terminal positions).
# Used for oracle/classify/flaw-PV tests where coverage >= 90% is required and
# we need enough plies for the blunder-eval-sequence (plies 0..5).
_SIX_PLY_PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *"


# ─── Session-scoped fixtures ──────────────────────────────────────────────────


@pytest_asyncio.fixture(scope="session")
async def full_drain_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """async_sessionmaker bound to the test engine.

    Used to:
    1. Insert committed test data visible across sessions.
    2. Patch app.services.eval_drain.async_session_maker.
    """
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(scope="session", autouse=False)
async def full_drain_test_user(
    full_drain_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID exists in the test DB (committed). Returns user_id."""
    from app.models.user import User

    async with full_drain_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID))
        # .unique() required: User → OAuthAccount lazy="joined" collection load.
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID,
                    email=f"full-drain-test-{_TEST_USER_ID}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID


@pytest_asyncio.fixture(scope="session", autouse=False)
async def full_drain_test_user_117(
    full_drain_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID_117 exists in the test DB. Returns user_id."""
    from app.models.user import User

    async with full_drain_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID_117))
        # User → OAuthAccount is lazy="joined" (a collection eager-load), so the
        # entity result must be de-duplicated with .unique() before scalar access.
        # Without it, SQLAlchemy raises once cross-file mapper configuration emits
        # the joined collection load (errors only when run alongside other suites).
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID_117,
                    email=f"full-drain-test-{_TEST_USER_ID_117}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID_117


# ─── DB helpers ───────────────────────────────────────────────────────────────


async def _insert_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    pgn: str = _SIMPLE_PGN,
    *,
    evals_completed_at: datetime | None = None,
    full_evals_completed_at: datetime | None = None,
    full_pv_completed_at: datetime | None = None,
    full_eval_attempts: int = 0,
    white_blunders: int | None = None,
    lichess_evals_at: datetime | None = None,
) -> int:
    """Insert a Game row and commit. Returns the game_id."""
    from app.models.game import Game

    async with session_maker() as session:
        g = Game(
            user_id=user_id,
            platform="chess.com",
            platform_game_id=f"full-drain-{uuid.uuid4().hex}",
            pgn=pgn,
            result="1-0",
            user_color="white",
            rated=True,
            is_computer_game=False,
            evals_completed_at=evals_completed_at,
            full_evals_completed_at=full_evals_completed_at,
            full_pv_completed_at=full_pv_completed_at,
            full_eval_attempts=full_eval_attempts,
            white_blunders=white_blunders,
            lichess_evals_at=lichess_evals_at,
        )
        session.add(g)
        await session.flush()
        game_id = g.id
        await session.commit()
    return game_id


async def _insert_game_positions(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    rows: list[dict[str, Any]],
) -> None:
    """Insert GamePosition rows for a game and commit.

    Each dict in rows: {"ply": int, "full_hash": int, "eval_cp": int|None,
    "eval_mate": int|None, "best_move": str|None (optional), "pv": str|None (optional),
    "move_san": str|None (optional)}.
    """
    from app.models.game_position import GamePosition

    async with session_maker() as session:
        for r in rows:
            session.add(
                GamePosition(
                    user_id=user_id,
                    game_id=game_id,
                    ply=r["ply"],
                    full_hash=r["full_hash"],
                    white_hash=0,
                    black_hash=0,
                    move_san=r.get("move_san"),
                    phase=0,
                    endgame_class=None,
                    eval_cp=r.get("eval_cp"),
                    eval_mate=r.get("eval_mate"),
                    best_move=r.get("best_move"),
                    pv=r.get("pv"),
                )
            )
        await session.commit()


async def _delete_games(
    session_maker: async_sessionmaker[AsyncSession],
    game_ids: list[int],
) -> None:
    """Delete games by ID (committed cleanup)."""
    from app.models.game import Game

    if not game_ids:
        return
    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.id.in_(game_ids)))
        await session.commit()


async def _delete_import_jobs(
    session_maker: async_sessionmaker[AsyncSession],
    job_ids: list[str],
) -> None:
    """Delete ImportJob rows by ID (committed cleanup)."""
    from app.models.import_job import ImportJob

    if not job_ids:
        return
    async with session_maker() as session:
        await session.execute(delete(ImportJob).where(ImportJob.id.in_(job_ids)))
        await session.commit()


async def _delete_opening_eval_rows(
    session_maker: async_sessionmaker[AsyncSession],
    hashes: list[int],
) -> None:
    """Delete opening_position_eval rows by full_hash and commit (test cleanup)."""
    if not hashes:
        return
    async with session_maker() as session:
        await session.execute(
            sa.text("DELETE FROM opening_position_eval WHERE full_hash = ANY(:hashes)"),
            {"hashes": hashes},
        )
        await session.commit()


# ─── EVAL-01: all-ply collector ───────────────────────────────────────────────


class TestCollectAllPliesExcludesTerminal:
    """EVAL-01: _collect_full_ply_targets yields one target per non-terminal ply."""

    def test_collect_all_plies_excludes_terminal(self) -> None:
        """A checkmate PGN: targets == number of half-moves played (terminal excluded).

        Scholar's mate: 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7# = 7 half-moves
        (plies 0..6). The mainline iterator yields the board BEFORE each move is
        pushed, so it yields 7 nodes (plies 0..6). The post-4.Qxf7# board is
        checkmate — never yielded, never added to targets.
        """
        from app.services.eval_drain import _collect_full_ply_targets

        pgn = _CHECKMATE_PGN
        # Provide game_positions_rows for plies 0..6 (7 half-moves).
        expected_ply_count = 7  # plies 0..6; ply 7 is the terminal checkmate position
        gp_rows = [(ply, ply + 1000, None, None) for ply in range(expected_ply_count)]

        targets = _collect_full_ply_targets(game_id=1, pgn_text=pgn, game_positions_rows=gp_rows)

        # Must have exactly 7 targets (plies 0..6); the terminal board is never visited.
        assert len(targets) == expected_ply_count, (
            f"Expected {expected_ply_count} non-terminal targets, got {len(targets)}. "
            "Terminal (checkmate) position must be excluded — EVAL-01."
        )
        plies_collected = [t.ply for t in targets]
        assert plies_collected == list(range(expected_ply_count)), (
            f"Expected plies [0..{expected_ply_count - 1}], got {plies_collected}"
        )
        # Each board snapshot must be a valid chess.Board (not game-over).
        for t in targets:
            assert isinstance(t.board, chess.Board), f"Target at ply {t.ply} has no board"
            assert not t.board.is_game_over(), (
                f"Board at ply {t.ply} is game-over — terminal position was incorrectly included"
            )

    def test_collect_handles_bad_pgn(self) -> None:
        """Malformed PGN returns empty list (no exception)."""
        from app.services.eval_drain import _collect_full_ply_targets

        gp_rows = [(0, 12345, None, None)]
        targets = _collect_full_ply_targets(
            game_id=1, pgn_text="THIS IS NOT VALID PGN !!!", game_positions_rows=gp_rows
        )
        assert targets == [], "Malformed PGN must return [] without raising"

    def test_collect_handles_none_pgn_result(self) -> None:
        """Empty PGN (chess.pgn.read_game returns None) returns empty list."""
        from app.services.eval_drain import _collect_full_ply_targets

        gp_rows = [(0, 12345, None, None)]
        targets = _collect_full_ply_targets(game_id=1, pgn_text="", game_positions_rows=gp_rows)
        assert targets == [], "Empty PGN (None game) must return []"

    def test_collect_missing_gp_rows_skipped(self) -> None:
        """Plies not in game_positions_rows are silently skipped."""
        from app.services.eval_drain import _collect_full_ply_targets

        # Only provide a row for ply 2 — plies 0, 1, 3 skipped.
        gp_rows = [(2, 99999, None, None)]
        targets = _collect_full_ply_targets(
            game_id=1, pgn_text=_SIMPLE_PGN, game_positions_rows=gp_rows
        )
        assert len(targets) == 1
        assert targets[0].ply == 2


# ─── EVAL-03: dedup lookup ────────────────────────────────────────────────────


class TestDedupHitsParity:
    """EVAL-03: dedup returns parity eval only when source game has full_evals_completed_at set."""

    async def test_dedup_hits_parity_source(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """SEED-044 post-move self-join: a position's OWN eval is recovered from the
        PRIOR row's post-move eval, and its best_move from the position's own row.

        Donor game (full_evals_completed_at set):
          ply 4: eval_cp=42  -> post-move eval of ply 4 = eval of the position REACHED = ply 5's position
          ply 5: full_hash=Q, best_move="g1f3" -> best move FROM Q (decision-keyed)
        So _fetch_dedup_evals([Q]) recovers (eval OF Q=42, None, best_move FROM Q="g1f3").

        SEED-053: the gate now lives in OPENING_CACHE_BACKFILL_SQL. We populate the
        cache with that SQL first so _fetch_dedup_evals exercises the cache read path
        against rows that genuinely passed the gate.
        """
        from app.models.game_position import DEDUP_MAX_PLY
        from app.services.eval_drain import (
            OPENING_CACHE_BACKFILL_SQL,
            _DEDUP_MAX_PLY,
            _fetch_dedup_evals,
        )

        # Insert a parity-source game (full_evals_completed_at set).
        now = datetime.now(timezone.utc)
        source_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            full_evals_completed_at=now,
            evals_completed_at=now,
        )
        # A unique hash to avoid collisions with other test data.
        target_hash = 0xDEAD_BEEF_0001
        predecessor_hash = 0xDEAD_BEEF_00FF
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            source_game_id,
            [
                # cur (ply 4): post-move eval = eval of the position reached (Q at ply 5).
                {"ply": 4, "full_hash": predecessor_hash, "eval_cp": 42, "eval_mate": None},
                # nxt (ply 5): the requested position Q; carries best_move FROM Q.
                {
                    "ply": 5,
                    "full_hash": target_hash,
                    "eval_cp": 99,
                    "eval_mate": None,
                    "best_move": "g1f3",
                },
            ],
        )
        # Pre-clean any stale cache row (defensive for reruns), then populate via
        # the shared gate SQL so the test exercises the gate at its enforcement site.
        await _delete_opening_eval_rows(full_drain_session_maker, [target_hash, predecessor_hash])
        async with full_drain_session_maker() as session:
            await session.execute(OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY})
            await session.commit()
        try:
            async with full_drain_session_maker() as session:
                result = await _fetch_dedup_evals(session, [target_hash])

            assert target_hash in result, (
                f"Parity source (full_evals_completed_at set, ply {5} <= {_DEDUP_MAX_PLY}) "
                "must be recovered by the post-move self-join (EVAL-03 / SEED-044)."
            )
            # (eval OF Q from prior row, eval_mate, best_move FROM Q from Q's own row, pv).
            # OPENING_CACHE_BACKFILL_SQL does not populate pv (SEED-076 follow-up scope
            # is _upsert_opening_cache's incremental write path, not the one-time backfill).
            assert result[target_hash] == (42, None, "g1f3", None)
        finally:
            await _delete_games(full_drain_session_maker, [source_game_id])
            await _delete_opening_eval_rows(
                full_drain_session_maker, [target_hash, predecessor_hash]
            )

    async def test_dedup_excludes_depth15_source(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """A game_position row at ply<=20 whose game has only evals_completed_at (no full marker)
        must NOT be returned by _fetch_dedup_evals (Pitfall 4, D-116-02).

        SEED-053: after running OPENING_CACHE_BACKFILL_SQL the target_hash must still be
        absent from the cache — the gate (full_evals_completed_at IS NOT NULL) must
        exclude depth-15 sources at populate time.
        """
        from app.models.game_position import DEDUP_MAX_PLY
        from app.services.eval_drain import OPENING_CACHE_BACKFILL_SQL, _fetch_dedup_evals

        # Insert a depth-15 source game (evals_completed_at set, full_evals_completed_at NULL).
        now = datetime.now(timezone.utc)
        depth15_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )
        target_hash = 0xDEAD_BEEF_0002
        predecessor_hash = 0xDEAD_BEEF_02FF
        # Insert the predecessor too, so the backfill SQL WOULD match if not for the
        # full_evals_completed_at gate (SEED-044 — the gate is what must exclude it).
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            depth15_game_id,
            [
                {"ply": 4, "full_hash": predecessor_hash, "eval_cp": 100, "eval_mate": None},
                {"ply": 5, "full_hash": target_hash, "eval_cp": 80, "eval_mate": None},
            ],
        )
        # Pre-clean any stale cache rows, then run the gate SQL.
        await _delete_opening_eval_rows(full_drain_session_maker, [target_hash, predecessor_hash])
        async with full_drain_session_maker() as session:
            await session.execute(OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY})
            await session.commit()
        try:
            async with full_drain_session_maker() as session:
                result = await _fetch_dedup_evals(session, [target_hash])

            assert target_hash not in result, (
                "Depth-15 source (full_evals_completed_at IS NULL) must NOT be returned "
                "by _fetch_dedup_evals — Pitfall 4 / D-116-02."
            )
        finally:
            await _delete_games(full_drain_session_maker, [depth15_game_id])
            await _delete_opening_eval_rows(
                full_drain_session_maker, [target_hash, predecessor_hash]
            )

    async def test_dedup_excludes_analyzed_source(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """A lichess-analyzed game (lichess_evals_at IS NOT NULL) must NOT be a dedup
        source (WR-02 repointed to D-117-07): its preserved rows are lichess post-move
        evals, which are not position-keyed by full_hash — only engine-written rows
        (lichess_evals_at IS NULL) are safe to transplant.

        D-117-07: the WR-02 gate was repointed from white_blunders IS NULL onto
        lichess_evals_at IS NULL. After oracle counts are filled for engine games,
        white_blunders IS NOT NULL for engine games too — using white_blunders would
        wrongly exclude engine-written sources.

        SEED-053: after running OPENING_CACHE_BACKFILL_SQL the target_hash must still
        be absent — the gate (lichess_evals_at IS NULL) must exclude analyzed sources
        at populate time.
        """
        from app.models.game_position import DEDUP_MAX_PLY
        from app.services.eval_drain import OPENING_CACHE_BACKFILL_SQL, _fetch_dedup_evals

        now = datetime.now(timezone.utc)
        analyzed_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            evals_completed_at=now,
            full_evals_completed_at=now,
            lichess_evals_at=now,  # D-117-07: this is what marks a lichess-analyzed source
        )
        target_hash = 0xDEAD_BEEF_0003
        predecessor_hash = 0xDEAD_BEEF_03FF
        # Insert the predecessor too, so the backfill SQL WOULD match if not for the
        # lichess_evals_at gate (SEED-044 — the gate is what must exclude it).
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            analyzed_game_id,
            [
                {"ply": 4, "full_hash": predecessor_hash, "eval_cp": 77, "eval_mate": None},
                {"ply": 5, "full_hash": target_hash, "eval_cp": 70, "eval_mate": None},
            ],
        )
        # Pre-clean any stale cache rows, then run the gate SQL.
        await _delete_opening_eval_rows(full_drain_session_maker, [target_hash, predecessor_hash])
        async with full_drain_session_maker() as session:
            await session.execute(OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY})
            await session.commit()
        try:
            async with full_drain_session_maker() as session:
                result = await _fetch_dedup_evals(session, [target_hash])

            assert target_hash not in result, (
                "lichess-analyzed source (lichess_evals_at IS NOT NULL) must NOT be "
                "returned by _fetch_dedup_evals — lichess post-move evals are not "
                "position-keyed by full_hash (WR-02, D-117-07 repoint)."
            )
        finally:
            await _delete_games(full_drain_session_maker, [analyzed_game_id])
            await _delete_opening_eval_rows(
                full_drain_session_maker, [target_hash, predecessor_hash]
            )

    async def test_dedup_empty_input_returns_empty(
        self,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Empty hash list returns empty dict without querying the DB."""
        from app.services.eval_drain import _fetch_dedup_evals

        async with full_drain_session_maker() as session:
            result = await _fetch_dedup_evals(session, [])

        assert result == {}


# ─── EVAL-05: marker write ────────────────────────────────────────────────────


def _patch_drain_for_tick_tests(
    monkeypatch: pytest.MonkeyPatch,
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
    user_id: int,
    *,
    is_lichess_eval_game: bool = False,
    tier: int = 3,
    job_id: int | None = None,
) -> Any:
    """Shared monkeypatching for direct _full_drain_tick tests (WR-07).

    Routes drain sessions to the test DB, suppresses Sentry, forces the
    yield gate to False, and mocks claim_eval_job to return a deterministic
    ClaimedJob for the given game_id/user_id.

    Phase 117: _full_drain_tick now calls claim_eval_job (which uses
    eval_queue_service.async_session_maker internally). We mock claim_eval_job
    directly in the drain module namespace so it doesn't open any sessions.

    Returns the drain module.
    """
    import app.services.eval_apply as eval_apply_module
    import app.services.eval_drain as drain_module
    from app.services.eval_queue_service import ClaimedJob

    monkeypatch.setattr(drain_module, "async_session_maker", session_maker)
    # Phase 150 R7: _build_flaw_multipv2_blobs / _flaw_engine_plies / _classify_with_overlay
    # etc. moved to eval_apply.py and some open their OWN internal sessions there — that
    # module binding must be redirected to the test DB too.
    monkeypatch.setattr(eval_apply_module, "async_session_maker", session_maker)
    monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
    monkeypatch.setattr(drain_module.sentry_sdk, "capture_message", lambda *a, **kw: None)
    monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)
    monkeypatch.setattr(drain_module.sentry_sdk, "set_context", lambda *a, **kw: None)
    monkeypatch.setattr(
        drain_module,
        "_any_active_import_or_entry_ply_pending",
        AsyncMock(return_value=False),
    )
    # Mock claim_eval_job to return a ClaimedJob for the seeded game without
    # opening a DB session (avoids dependency on eval_queue_service sessions).
    # is_analyzed renamed to is_lichess_eval_game (see ClaimedJob docstring).
    claimed = ClaimedJob(
        game_id=game_id,
        user_id=user_id,
        tier=tier,
        is_lichess_eval_game=is_lichess_eval_game,
        job_id=job_id,
    )
    monkeypatch.setattr(drain_module, "claim_eval_job", AsyncMock(return_value=claimed))
    # Phase 142 MPV-02: stub _build_flaw_multipv2_blobs so existing tests that only
    # mock the main-gather side-effect list are not disrupted by continuation calls.
    # Tests that specifically exercise blobs patch this away or skip _patch_drain.
    monkeypatch.setattr(drain_module, "_build_flaw_multipv2_blobs", AsyncMock(return_value={}))
    return drain_module


class TestMarkerWrite:
    """EVAL-05: full_evals_completed_at is set after a drain tick.

    WR-07: tests call _full_drain_tick() directly — deterministic, no wall-clock
    sleeps or loop cancellation. Phase 117: claim_eval_job is mocked directly in
    the drain module so the tick can run without touching eval_queue_service sessions.
    """

    async def test_marker_set_after_drain(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After one drain tick on a seeded game with no holes, full_evals_completed_at IS NOT NULL.

        Phase 119 SEED-045: the marker is only stamped when failed_ply_count == 0.
        Uses _TWO_MOVE_PGN with rows for both plies; all engine calls succeed so
        no post-move holes remain after the tick.
        """
        from app.models.game import Game

        # Insert a non-guest game with evals_completed_at set (not in entry-ply queue)
        # and full_evals_completed_at NULL (pending for the full drain).
        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user
        )

        # Engine returns valid evals for ply 0, ply 1, and terminal (ply 2).
        # Post-move: row 0 = pos_eval[1] (50), row 1 = pos_eval[2] (30) — no holes.
        mock_evaluate = AsyncMock(
            side_effect=[
                (
                    99,
                    None,
                    "e2e4",
                    "e2e4 e7e5",
                    None,
                    None,
                    "",
                ),  # ply 0 (best_move; eval unused for row)
                (50, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0 post-move eval
                (
                    30,
                    None,
                    "g1f3",
                    "g1f3",
                    None,
                    None,
                    "",
                ),  # terminal → row 1 post-move eval (no hole)
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        # Insert game_position rows for both plies — needed so each has a post-move donor.
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            game_id,
            [
                {"ply": 0, "full_hash": 0xABCD_EF01, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xABCD_EF02, "eval_cp": None, "eval_mate": None},
            ],
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game (WR-07 contract)"

            async with full_drain_session_maker() as verify_session:
                result = await verify_session.execute(
                    select(Game.full_evals_completed_at).where(Game.id == game_id)
                )
                row = result.scalar_one_or_none()

            assert row is not None, (
                f"Game {game_id} still has full_evals_completed_at IS NULL after drain tick "
                "— EVAL-05 marker not written."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_marker_withheld_with_holes_under_cap(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Phase 119 SEED-045: when evaluate_nodes_multipv2 fails for SOME plies and
        full_eval_attempts + 1 < MAX_EVAL_ATTEMPTS, the marker is NOT set and
        full_eval_attempts is incremented. The partial eval IS written.

        SEED-044 post-move: a row stores the eval of the NEXT position. For
        _TWO_MOVE_PGN ("1. e4 e5 *", plies 0,1, terminal ply 2):
          row 0 = pos_eval[1] = ply-1 result (50)  → written
          row 1 = pos_eval[2] = terminal result (None) → NULL hole (non-terminal row!)

        WR-05: this must be a PARTIAL failure — an all-fail game trips the circuit
        breaker and stays pending (see test_all_fail_keeps_game_pending).
        Under Phase 119 (SEED-045): partial failure no longer stamps complete;
        full_eval_attempts increments and the game stays pending for retry.
        """
        from app.models.game import Game
        from app.models.game_position import GamePosition
        from app.services.eval_drain import MAX_EVAL_ATTEMPTS

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,  # explicitly under cap
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user
        )

        # Engine calls (in order): ply 0, ply 1, terminal. Post-move:
        #   row 0 = pos_eval[1] = ply-1 result (50)  → written (no hole)
        #   row 1 = pos_eval[2] = terminal result (None)  → NULL hole
        mock_evaluate = AsyncMock(
            side_effect=[
                (
                    99,
                    None,
                    "e2e4",
                    "e2e4 e7e5",
                    None,
                    None,
                    "",
                ),  # ply 0 (best_move; eval unused for row)
                (50, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0 post-move eval
                (None, None, None, None, None, None, None),  # terminal → row 1 hole
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            game_id,
            [
                {"ply": 0, "full_hash": 0xCAFE_BABE, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xCAFE_BABF, "eval_cp": None, "eval_mate": None},
            ],
        )
        try:
            assert MAX_EVAL_ATTEMPTS > 1, "test requires MAX_EVAL_ATTEMPTS > 1 for under-cap path"
            processed = await drain_module._full_drain_tick()
            assert processed is False, (
                "Phase 119: partial failure under cap must NOT report processed "
                "(game stays pending for retry) — SEED-045"
            )

            async with full_drain_session_maker() as verify_session:
                game_row = await verify_session.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g = game_row.one_or_none()

                pos_rows = await verify_session.execute(
                    select(GamePosition.ply, GamePosition.eval_cp, GamePosition.eval_mate)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                evals_by_ply = {r[0]: (r[1], r[2]) for r in pos_rows.all()}

            assert g is not None
            assert g[0] is None, (
                "full_evals_completed_at must stay NULL when a hole remains (under cap) — SEED-045"
            )
            assert g[1] == 1, (
                f"full_eval_attempts must be incremented to 1 after a hole tick, got {g[1]}"
            )
            assert evals_by_ply.get(0) == (50, None), (
                "Row 0 stores the post-move eval (ply-1 engine result = 50) — partial evals written"
            )
            assert evals_by_ply.get(1) == (None, None), (
                "game_position.eval_cp/eval_mate must remain NULL for the terminal-driven hole"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_all_fail_keeps_game_pending(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """WR-05 circuit breaker: when EVERY engine call fails, the game must NOT be
        marked complete — an all-fail tick is an engine-pool problem, and marking
        would permanently burn the backlog with all-NULL holes."""
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            pgn=_SIMPLE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user
        )

        # Engine always returns all-None 4-tuple — simulated dead pool.
        mock_evaluate = AsyncMock(return_value=(None, None, None, None, None, None, None))
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            game_id,
            [{"ply": 0, "full_hash": 0xCAFE_BAC0, "eval_cp": None, "eval_mate": None}],
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is False, (
                "Tick must report no progress when the circuit breaker trips (WR-05)."
            )

            async with full_drain_session_maker() as verify_session:
                game_row = await verify_session.execute(
                    select(Game.full_evals_completed_at).where(Game.id == game_id)
                )
                marker = game_row.scalar_one_or_none()

            assert marker is None, (
                "full_evals_completed_at must stay NULL when ALL engine evals failed "
                "— the game must remain pending for retry (WR-05 circuit breaker)."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── QUEUE-07: gather-outside-session invariant (AST scan) ────────────────────


class TestGatherOutsideSession:
    """QUEUE-07: asyncio.gather must NEVER be inside an AsyncSession scope in the full-drain tick.

    AST scan mirrors the existing test_gather_outside_session in test_eval_drain.py
    (T-91-08 pattern). Acts as a CI regression guard for the CLAUDE.md hard rule.
    WR-07: the gather moved from run_full_eval_drain into _full_drain_tick — the
    scan targets the tick (where the gather actually lives).
    """

    def test_gather_outside_session(self) -> None:
        """AST scan: asyncio.gather call in _full_drain_tick is not inside an async-with block."""
        from app.services.eval_drain import _full_drain_tick

        source = inspect.getsource(_full_drain_tick)
        tree = ast.parse(source)

        class GatherOutsideSessionChecker(ast.NodeVisitor):
            def __init__(self) -> None:
                self.violations: list[int] = []
                self._async_with_stack: int = 0

            def visit_AsyncWith(self, node: ast.AsyncWith) -> None:  # noqa: N802
                self._async_with_stack += 1
                self.generic_visit(node)
                self._async_with_stack -= 1

            def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
                func = node.func
                is_gather = False
                if isinstance(func, ast.Attribute) and func.attr == "gather":
                    is_gather = True
                if isinstance(func, ast.Name) and func.id == "gather":
                    is_gather = True
                if is_gather and self._async_with_stack > 0:
                    self.violations.append(getattr(node, "lineno", -1))
                self.generic_visit(node)

        checker = GatherOutsideSessionChecker()
        checker.visit(tree)

        assert checker.violations == [], (
            f"asyncio.gather() found inside an async-with scope at line(s) "
            f"{checker.violations} in _full_drain_tick — violates CLAUDE.md "
            f"hard rule (QUEUE-07 / T-116-06 architectural invariant)."
        )

    def test_gather_outside_session_tier4b_minimal_path(self) -> None:
        """Phase 177 D-05: same AST scan, targeting the new
        `_tier4b_minimal_drain_tick` (its own asyncio.gather for the targeted
        MultiPV-2 runner-up search must also never run inside an async-with
        session scope)."""
        from app.services.eval_drain import _tier4b_minimal_drain_tick

        source = inspect.getsource(_tier4b_minimal_drain_tick)
        tree = ast.parse(source)

        class GatherOutsideSessionChecker(ast.NodeVisitor):
            def __init__(self) -> None:
                self.violations: list[int] = []
                self._async_with_stack: int = 0

            def visit_AsyncWith(self, node: ast.AsyncWith) -> None:  # noqa: N802
                self._async_with_stack += 1
                self.generic_visit(node)
                self._async_with_stack -= 1

            def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
                func = node.func
                is_gather = False
                if isinstance(func, ast.Attribute) and func.attr == "gather":
                    is_gather = True
                if isinstance(func, ast.Name) and func.id == "gather":
                    is_gather = True
                if is_gather and self._async_with_stack > 0:
                    self.violations.append(getattr(node, "lineno", -1))
                self.generic_visit(node)

        checker = GatherOutsideSessionChecker()
        checker.visit(tree)

        assert checker.violations == [], (
            f"asyncio.gather() found inside an async-with scope at line(s) "
            f"{checker.violations} in _tier4b_minimal_drain_tick — violates "
            f"CLAUDE.md hard rule (QUEUE-07 / T-116-06 architectural invariant)."
        )


# ─── QUEUE-07: yield gate ─────────────────────────────────────────────────────


class TestYieldGate:
    """QUEUE-07: _any_active_import_or_entry_ply_pending gates the full drain."""

    async def test_yield_gate_active_import(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Yield gate is True when an ImportJob with status 'pending' exists."""
        from app.models.import_job import ImportJob
        from app.services.eval_drain import _any_active_import_or_entry_ply_pending

        job_id = f"test-full-drain-yield-{uuid.uuid4().hex[:8]}"
        async with full_drain_session_maker() as session:
            session.add(
                ImportJob(
                    id=job_id,
                    user_id=full_drain_test_user,
                    platform="chess.com",
                    username="test_yield_user",
                    status="pending",
                    games_fetched=0,
                    games_imported=0,
                )
            )
            await session.commit()
        try:
            async with full_drain_session_maker() as check_session:
                result = await _any_active_import_or_entry_ply_pending(check_session)
            assert result is True, (
                "Yield gate must return True when a pending ImportJob exists (D-116-11)."
            )
        finally:
            await _delete_import_jobs(full_drain_session_maker, [job_id])

    async def test_yield_gate_entry_ply_pending(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Yield gate is True when a Game with evals_completed_at IS NULL exists."""
        from app.services.eval_drain import _any_active_import_or_entry_ply_pending

        # Insert a game with evals_completed_at = NULL (entry-ply drain has backlog).
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            evals_completed_at=None,
        )
        try:
            async with full_drain_session_maker() as check_session:
                result = await _any_active_import_or_entry_ply_pending(check_session)
            assert result is True, (
                "Yield gate must return True when a Game with evals_completed_at IS NULL "
                "exists (entry-ply drain backlog, D-116-11)."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── D-117-07: WR-02 repoint (lichess_evals_at gates dedup) ───────────────────


class TestWr02Repointed:
    """D-117-07: _fetch_dedup_evals gates on lichess_evals_at IS NULL, not white_blunders.

    After oracle counts are filled for engine games, white_blunders IS NOT NULL for
    engine games too — using white_blunders would wrongly exclude engine sources.
    The WR-02 gate was repointed onto lichess_evals_at (the reliable discriminator).
    """

    async def test_wr02_engine_source_included(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Engine-written game (lichess_evals_at IS NULL, white_blunders IS NOT NULL)
        must be usable as a dedup source after oracle counts are filled.

        SEED-053: populate the cache via OPENING_CACHE_BACKFILL_SQL first so the
        inclusion assertion exercises the gate at its enforcement site.
        """
        from app.models.game_position import DEDUP_MAX_PLY
        from app.services.eval_drain import OPENING_CACHE_BACKFILL_SQL, _fetch_dedup_evals

        now = datetime.now(timezone.utc)
        engine_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            evals_completed_at=now,
            full_evals_completed_at=now,
            white_blunders=2,  # oracle counts filled — but lichess_evals_at is NULL
            # lichess_evals_at=None is the default — engine-written source
        )
        target_hash = 0xDEAD_BEEF_0010
        predecessor_hash = 0xDEAD_BEEF_10FF
        # Predecessor (ply 2) holds the post-move eval of the requested position
        # (ply 3) — the SEED-044 self-join / backfill SQL recovers it.
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            engine_game_id,
            [
                {"ply": 2, "full_hash": predecessor_hash, "eval_cp": 99, "eval_mate": None},
                {"ply": 3, "full_hash": target_hash, "eval_cp": 88, "eval_mate": None},
            ],
        )
        # Pre-clean any stale cache rows, then populate via the gate SQL.
        await _delete_opening_eval_rows(full_drain_session_maker, [target_hash, predecessor_hash])
        async with full_drain_session_maker() as session:
            await session.execute(OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY})
            await session.commit()
        try:
            async with full_drain_session_maker() as session:
                result = await _fetch_dedup_evals(session, [target_hash])

            assert target_hash in result, (
                "Engine-written source (lichess_evals_at IS NULL) must be usable as dedup "
                "even when white_blunders IS NOT NULL (D-117-07 — WR-02 repointed)."
            )
        finally:
            await _delete_games(full_drain_session_maker, [engine_game_id])
            await _delete_opening_eval_rows(
                full_drain_session_maker, [target_hash, predecessor_hash]
            )

    async def test_wr02_lichess_source_excluded(
        self,
        full_drain_test_user: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Lichess-analyzed game (lichess_evals_at IS NOT NULL, white_blunders IS NULL)
        must NOT be usable as a dedup source.

        SEED-053: after running OPENING_CACHE_BACKFILL_SQL the target_hash must still
        be absent — the gate (lichess_evals_at IS NULL) must exclude lichess sources
        at populate time, making the exclusion assertion genuine (not vacuously true).
        """
        from app.models.game_position import DEDUP_MAX_PLY
        from app.services.eval_drain import OPENING_CACHE_BACKFILL_SQL, _fetch_dedup_evals

        now = datetime.now(timezone.utc)
        lichess_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user,
            evals_completed_at=now,
            full_evals_completed_at=now,
            lichess_evals_at=now,  # lichess-analyzed — not safe for transplant
            # white_blunders=None (no oracle counts yet)
        )
        target_hash = 0xDEAD_BEEF_0011
        predecessor_hash = 0xDEAD_BEEF_11FF
        # Predecessor present so the backfill SQL WOULD match if not for the
        # lichess_evals_at gate (SEED-044 — the gate is what must exclude it).
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user,
            lichess_game_id,
            [
                {"ply": 2, "full_hash": predecessor_hash, "eval_cp": 55, "eval_mate": None},
                {"ply": 3, "full_hash": target_hash, "eval_cp": 44, "eval_mate": None},
            ],
        )
        # Pre-clean any stale cache rows, then run the gate SQL.
        await _delete_opening_eval_rows(full_drain_session_maker, [target_hash, predecessor_hash])
        async with full_drain_session_maker() as session:
            await session.execute(OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY})
            await session.commit()
        try:
            async with full_drain_session_maker() as session:
                result = await _fetch_dedup_evals(session, [target_hash])

            assert target_hash not in result, (
                "Lichess-analyzed source (lichess_evals_at IS NOT NULL) must NOT be "
                "usable as a dedup source even when white_blunders IS NULL (D-117-07)."
            )
        finally:
            await _delete_games(full_drain_session_maker, [lichess_game_id])
            await _delete_opening_eval_rows(
                full_drain_session_maker, [target_hash, predecessor_hash]
            )


# ─── EVAL-04: best_move populated after drain tick ────────────────────────────


class TestBestMove:
    """EVAL-04: best_move is written for every evaluated non-dedup'd ply."""

    async def test_best_move_written_after_tick(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """best_move is populated in game_positions.best_move for every ply the
        engine evaluated (non-dedup'd) after a drain tick (EVAL-04 / D-117-01).

        _SIX_PLY_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *" has 6 half-moves → 6
        non-terminal positions (plies 0..5). All 6 plies have DB rows so each row
        gets a valid post-move eval (no holes), ensuring the tick completes and the
        marker is stamped (Phase 119 SEED-045: stamp only when no holes remain).
        Each ply gets a distinct best_move from the mock.
        """
        from app.models.game_position import GamePosition

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        # Per-ply best_move for all 6 positions (plies 0..5) + terminal call.
        # best_move stays decision-ply-keyed under post-move (SEED-044).
        # The terminal call (ply 6) provides the post-move eval for row 5; its
        # best_move is unused. All evals succeed so no holes → stamp on first tick.
        best_moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5"]
        mock_evaluate = AsyncMock(
            side_effect=[
                *[
                    (cp, None, bm, bm, None, None, "")
                    for cp, bm in zip([20, 15, 25, 10, 30, 5], best_moves)
                ],
                (
                    5,
                    None,
                    "h2h3",
                    "h2h3",
                    None,
                    None,
                    "",
                ),  # terminal eval-donor call (best_move ignored)
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        # Provide rows for all 6 plies so each row has a post-move eval donor.
        gp_rows = [
            {"ply": i, "full_hash": 0xBEEF_0020 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.best_move)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                bm_by_ply = {r[0]: r[1] for r in rows.all()}

            assert bm_by_ply.get(0) == "e2e4", f"ply 0 best_move mismatch: {bm_by_ply.get(0)}"
            assert bm_by_ply.get(1) == "e7e5", f"ply 1 best_move mismatch: {bm_by_ply.get(1)}"
            assert bm_by_ply.get(2) == "g1f3", f"ply 2 best_move mismatch: {bm_by_ply.get(2)}"
            assert bm_by_ply.get(3) == "b8c6", f"ply 3 best_move mismatch: {bm_by_ply.get(3)}"
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_dedup_best_move_transplanted(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """best_move is transplanted from a dedup source for opening-region plies
        (ply <= DEDUP_MAX_PLY) without an engine call (EVAL-04 / D-117-01).

        Setup: a parity-source game has a position at ply 2 with full_hash X and
        best_move "g1f3". The target game has a position at the same hash (ply 2,
        dedup-eligible) and a position at a different hash (ply 4, engine-evaluated).

        PGN: _SIMPLE_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bc4 *" (5 half-moves, plies 0..4).
        We use ply 2 for dedup and ply 4 for engine-evaluated (both within PGN range).

        SEED-053: populate the cache via OPENING_CACHE_BACKFILL_SQL before the tick
        so the dedup hit comes from the cache (its new enforcement site).
        """
        from app.models.game_position import DEDUP_MAX_PLY, GamePosition
        from app.services.eval_drain import OPENING_CACHE_BACKFILL_SQL, _DEDUP_MAX_PLY

        now = datetime.now(timezone.utc)
        dedup_hash = 0xBEEF_DED0_0001  # unique dedup source hash (ply 2 in source)
        dedup_predecessor_hash = 0xBEEF_DED0_00FF

        # Parity source: full_evals_completed_at set, lichess_evals_at NULL.
        source_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            evals_completed_at=now,
            full_evals_completed_at=now,
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_117,
            source_game_id,
            [
                # SEED-044 self-join: the predecessor row (ply 1) holds the post-move
                # eval of the dedup position (ply 2); the dedup position's own row
                # carries the best_move FROM it. The backfill SQL recovers
                # (eval=30 from ply 1, best_move="g1f3" from ply 2).
                {"ply": 1, "full_hash": dedup_predecessor_hash, "eval_cp": 30, "eval_mate": None},
                {
                    "ply": 2,  # within DEDUP_MAX_PLY — the dedup'd position
                    "full_hash": dedup_hash,
                    "eval_cp": 31,
                    "eval_mate": None,
                    "best_move": "g1f3",  # the transplanted best_move (FROM this position)
                },
            ],
        )

        # Target game using _SIMPLE_PGN (plies 0..4 in PGN).
        target_game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIMPLE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )
        # ply 2 (dedup-eligible), ply 3 (engine-eval donor for row 2's post-move),
        # ply 4 (engine-evaluated for best_move assertion).
        # Phase 119 SEED-045: rows 2 and 4 each need their post-move eval donor in
        # pos_eval (i.e. rows for ply 3 and ply 5, or the terminal at ply 5 suffices
        # for row 4). Row 2's post-move eval needs pos_eval[3], so ply 3 must be a target.
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_117,
            target_game_id,
            [
                {
                    "ply": 2,
                    "full_hash": dedup_hash,  # will be dedup'd from cache
                    "eval_cp": None,
                    "eval_mate": None,
                },
                {
                    "ply": 3,
                    "full_hash": 0xBEEF_DED0_0003,  # engine-evaluated (donor for row 2)
                    "eval_cp": None,
                    "eval_mate": None,
                },
                {
                    "ply": 4,
                    "full_hash": 0xBEEF_DED0_0002,  # unique → engine-evaluated
                    "eval_cp": None,
                    "eval_mate": None,
                },
            ],
        )

        # Pre-clean any stale cache rows, then populate via the gate SQL so the
        # drain tick's _fetch_dedup_evals hits the cache at ply 2.
        await _delete_opening_eval_rows(
            full_drain_session_maker, [dedup_hash, dedup_predecessor_hash]
        )
        async with full_drain_session_maker() as session:
            await session.execute(OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY})
            await session.commit()

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, target_game_id, full_drain_test_user_117
        )

        # Engine is called for ply 3, ply 4 (non-dedup'd), and the terminal (ply 5).
        # Ply 2 is dedup'd → no engine call for it.
        mock_evaluate = AsyncMock(return_value=(40, None, "d2d4", "d2d4", None, None, ""))
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        assert 2 <= _DEDUP_MAX_PLY, f"ply 2 must be within DEDUP_MAX_PLY={_DEDUP_MAX_PLY}"

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.best_move)
                    .where(GamePosition.game_id == target_game_id)
                    .order_by(GamePosition.ply)
                )
                bm_by_ply = {r[0]: r[1] for r in rows.all()}

            # Dedup'd ply 2: best_move transplanted from cache (not engine-called).
            assert bm_by_ply.get(2) == "g1f3", (
                f"Dedup'd ply 2 must carry transplanted best_move 'g1f3', got {bm_by_ply.get(2)!r}"
            )
            # Engine-evaluated ply 4: best_move from engine.
            assert bm_by_ply.get(4) == "d2d4", (
                f"Engine-evaluated ply 4 must carry best_move 'd2d4', got {bm_by_ply.get(4)!r}"
            )
        finally:
            await _delete_games(full_drain_session_maker, [source_game_id, target_game_id])
            await _delete_opening_eval_rows(
                full_drain_session_maker, [dedup_hash, dedup_predecessor_hash]
            )


# ─── EVAL-04: flaw PV written at ply N+1 (D-117-02) ──────────────────────────


def _blunder_eval_sequence() -> list[tuple[int, None, str, str, None, None, str]]:
    """Return an engine eval sequence whose POST-MOVE written rows cause exactly ONE
    blunder (white, ply 2) for _SIX_PLY_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *".

    SEED-044 post-move convention: the drain stores at row k the eval of the position
    AFTER move k = the engine eval of the NEXT position (`_post_move_eval`). The engine
    is called per pre-push position (plies 0..5) PLUS the terminal position (ply 6),
    in that order. So row k's stored eval = engine_result[k + 1]. To reproduce the
    desired WRITTEN eval-by-ply [20, 30, -500, -480, 60, 30] at rows 0..5, the engine
    sequence is that list shifted right by one: a leading ply-0 entry (its eval is the
    eval of the start position, never stored — it only supplies row 0's best_move),
    then the six desired values at engine calls 1..6 (the last being the terminal).

    Stored (post-move) eval-by-ply after the tick — same as the historic pre-shift
    sequence, so the ES analysis is unchanged:
      row 0: 20   row 1: 30   row 2: -500 (WHITE BLUNDER)   row 3: -480   row 4: 60   row 5: 30

    Exact ES analysis (LICHESS_K = 0.00368208), over the STORED rows:
      n=1 (black): ES_black(20) ≈ 0.498, ES_black(30) ≈ 0.473 → drop ≈ 0.025 < INACCURACY_DROP
      n=2 (white): ES_white(30) ≈ 0.527, ES_white(-500) ≈ 0.163 → drop ≈ 0.364 >> BLUNDER_DROP
      n=3 (black): ES_black(-500) ≈ 0.837, ES_black(-480) ≈ 0.829 → drop ≈ 0.008 < threshold
      n=4 (white): ES_white(-480) ≈ 0.171, ES_white(60) ≈ 0.555 → drop = negative (improvement)
      n=5 (black): ES_black(60) ≈ 0.445, ES_black(30) ≈ 0.473 → drop = negative (improvement)

    Result: exactly one blunder (white at ply 2). PV must be written at ply 3 (the
    refutation board = engine_result_map[3]), nowhere else.

    Phase 142: expanded to 7-tuple (eval_cp, eval_mate, best_move, pv, second_cp,
    second_mate, second_uci) as evaluate_nodes_multipv2 now returns multipv=2 results.
    second_uci="" is the PvNode.su single-legal-move / no-second-move sentinel.
    """
    return [
        # engine call ply 0 — eval unused for storage (no row before move 0); supplies
        # row 0's best_move. The remaining six entries become the stored rows 0..5.
        (20, None, "e2e4", "e2e4 e7e5", None, None, ""),
        (20, None, "e2e4", "e2e4 e7e5", None, None, ""),  # → row 0 = 20 (balanced)
        (30, None, "e7e5", "e7e5 g1f3", None, None, ""),  # → row 1 = 30 (stable; black tiny drop)
        (
            -500,
            None,
            "g1f3",
            "g1f3 g8f6 d2d4",
            None,
            None,
            "",
        ),  # → row 2 = -500 (white BLUNDER; PV from here at ply 3)
        (
            -480,
            None,
            "g8f6",
            "g8f6 f1c4 d7d5",
            None,
            None,
            "",
        ),  # → row 3 = -480 (still black winning)
        (60, None, "f1c4", "f1c4 f8c5", None, None, ""),  # → row 4 = 60 (white recovers)
        (30, None, "f8c5", "f8c5", None, None, ""),  # terminal call → row 5 = 30 (stable)
    ]


class TestFlawPv:
    """EVAL-04 / D-117-02 / SEED-054: game_positions.pv is written at BOTH ply N and ply N+1
    for a flaw at ply N.

    - ply N+1: the refutation line from the position AFTER the flawed move (Pitfall 4,
      the SEED-039 tactic-motif input).
    - ply N: the ideal-continuation line from the pre-blunder decision board (SEED-054).
    """

    async def test_flaw_pv_written_at_flaw_ply_and_ply_n_plus_one(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After a drain tick on a game with a clear blunder at ply 2 (white's move),
        game_positions.pv is set at BOTH ply 2 (flaw_ply) and ply 3 (ply N+1), NULL elsewhere.

        classify_game_flaws emits a FlawRecord for ply 2 (n=2, mover=white).
        The PV for ply 2 (the decision board) comes from engine_result_map[2]; the PV
        for ply 3 (the refutation board) comes from engine_result_map[3] (SEED-054).
        Plies 0,1,4,5 must have pv=NULL (pv only written at flaw plies).
        """
        from app.models.game_position import GamePosition

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        eval_sequence = _blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0xBEEF_F1A0 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.pv)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                pv_by_ply = {r[0]: r[1] for r in rows.all()}

            # ply 3 must have the PV from engine_result_map[3] (D-117-02 / Pitfall 4).
            assert pv_by_ply.get(3) is not None, (
                "game_positions.pv at ply 3 (N+1 for blunder at ply 2) must be set "
                "— D-117-02 flaw PV write."
            )
            # ply 2 (flaw_ply) must have the ideal-continuation PV from
            # engine_result_map[2] (SEED-054 Part 2).
            assert pv_by_ply.get(2) is not None, (
                "game_positions.pv at ply 2 (flaw_ply) must be set — SEED-054 "
                "ideal-continuation PV write."
            )
            # All other plies must NOT have a PV set (pv is only written at flaw plies).
            for ply in [0, 1, 4, 5]:
                assert pv_by_ply.get(ply) is None, (
                    f"game_positions.pv at ply {ply} must be NULL — pv is only written "
                    "at flaw plies (ply N and ply N+1; D-117-02 / SEED-054)."
                )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_flaw_pv_written_for_analyzed_lichess_game(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """D-117-13 / SEED-054 (adapted for Phase 174-06 Task 1's unified full pass):
        analyzed lichess games get a flaw PV + best_move at BOTH flaw plies even
        though every ply already carries a lichess %eval.

        Regression guard for the prod-observed 0% flaw-PV coverage on analyzed
        lichess games: the is_lichess_eval_game eval-preservation filter used to drop
        every flaw ply before the engine gather, so neither the refutation PV nor the
        better-alternative best_move was captured (lichess supplies %eval but no PV
        and no best_move). D-117-13/SEED-054 originally fixed this with a targeted
        pre-classify-and-exempt mechanism ({flaw_ply, flaw_ply + 1} only); Phase
        174-06 Task 1 retires that whole mechanism in favor of engine-evaluating
        EVERY ply (SEED-109) — the flaw-PV guarantee this test protects now falls out
        of the general full pass rather than a special case.

        Setup: all 6 plies carry a pre-existing %eval encoding a white blunder at
        ply 2. Under the unified full pass every one of the 6 plies is
        engine-evaluated (for best_move); the flaw-PV write (a SEPARATE, always-
        flaw-only mechanism — D-117-02 — unrelated to how many plies got engine
        calls) still only lands `game_positions.pv` at ply 2 (flaw_ply) and ply 3
        (flaw_ply + 1). Before D-117-13 the engine was called 0 times (D-117); after
        D-117-13/before this phase it was called only at the 2 flaw-adjacent plies.
        """
        from app.models.game_position import GamePosition

        now = datetime.now(timezone.utc)
        # Analyzed lichess game: lichess_evals_at set; claim reports is_lichess_eval_game=True.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            lichess_evals_at=now,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch,
            full_drain_session_maker,
            game_id,
            full_drain_test_user_117,
            is_lichess_eval_game=True,
        )

        # Both ply 2 (flaw_ply) and ply 3 (flaw_ply + 1) should reach the engine
        # (SEED-054). Same mock result for each — only the keying matters here.
        mock_evaluate = AsyncMock(
            return_value=(-480, None, "g8f6", "g8f6 f1c4 d7d5", None, None, "")
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        # Pre-existing lichess %evals on EVERY ply, encoding a white blunder at ply 2
        # (30 cp -> -500 cp). Without D-117-13 the is_lichess_eval_game filter would
        # drop all six plies (each has an eval) and no PV would ever be captured.
        cp_by_ply = [20, 30, -500, -480, 60, 30]
        gp_rows = [
            {
                "ply": i,
                "full_hash": 0xABCDE000 + i,
                "eval_cp": cp_by_ply[i],
                "eval_mate": None,
            }
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            # Phase 174-06 Task 1: ALL 6 non-terminal plies are now engine-evaluated
            # (the targets filter + flaw-ply exemption are retired) — not just the 2
            # flaw-adjacent plies the pre-174-06 filter used to leave visible.
            assert mock_evaluate.await_count == 6, (
                "Every non-terminal ply of a lichess-eval game must be "
                f"engine-evaluated under the unified full pass — got "
                f"{mock_evaluate.await_count} engine calls."
            )

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(
                        GamePosition.ply,
                        GamePosition.pv,
                        GamePosition.eval_cp,
                        GamePosition.best_move,
                    )
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                by_ply = {r[0]: (r[1], r[2], r[3]) for r in rows.all()}

            assert by_ply.get(3, (None, None, None))[0] is not None, (
                "game_positions.pv at ply 3 must be set for an analyzed lichess game "
                "— D-117-13 flaw-PV fix (lichess provides %eval but no PV)."
            )
            # SEED-054: pv + best_move at flaw_ply (ply 2) — the better-alternative arrow.
            assert by_ply.get(2, (None, None, None))[0] is not None, (
                "game_positions.pv at ply 2 (flaw_ply) must be set for an analyzed "
                "lichess game — SEED-054 ideal-continuation PV."
            )
            assert by_ply.get(2, (None, None, None))[2] == "g8f6", (
                "game_positions.best_move at ply 2 (flaw_ply) must be set for an "
                "analyzed lichess game — SEED-054 better-alternative arrow."
            )
            # Preserved lichess %evals are untouched at both flaw plies (D-116-04).
            assert by_ply.get(3, (None, None, None))[1] == -480, (
                "The lichess %eval at flaw_ply + 1 must be preserved, not "
                "overwritten by the engine eval (D-116-04)."
            )
            assert by_ply.get(2, (None, None, None))[1] == -500, (
                "The lichess %eval at flaw_ply must be preserved, not overwritten "
                "by the engine eval (D-116-04 / SEED-054)."
            )
            for ply in [0, 1, 4, 5]:
                assert by_ply.get(ply, (None, None, None))[0] is None, (
                    f"game_positions.pv at ply {ply} must be NULL — pv is only written "
                    "at flaw plies (ply N and ply N+1; D-117-02 / SEED-054), a "
                    "SEPARATE mechanism from best_move which is now written at every "
                    "engine-evaluated ply (Phase 174-06)."
                )
                # Phase 174-06: best_move IS now populated beyond the flaw-adjacent
                # plies — every ply the unified full pass covers.
                assert by_ply.get(ply, (None, None, None))[2] == "g8f6", (
                    f"game_positions.best_move at ply {ply} must be set under the "
                    "unified full pass (Phase 174-06 Task 1), not just at flaw plies."
                )
            for ply in range(6):
                assert by_ply.get(ply, (None, None, None))[1] == cp_by_ply[ply], (
                    f"The stored lichess %eval at ply {ply} must be preserved "
                    "unchanged by the full pass (SEED-109 item 4)."
                )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_lichess_game_forced_null_best_move_is_a_hole_not_false_completion(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Phase 174-06 / SEED-109 item 3: hole-counting parity — a lichess-eval
        game whose full pass has exactly one ply's engine call genuinely fail
        (best_move None) must NOT get `full_pv_completed_at` (or
        `full_evals_completed_at`) stamped on that tick, and must be left
        pending for a bounded retry (SEED-045 Path B), exactly like an engine
        game's hole. Pre-fix, the `is_lichess_eval_game` branch in
        `_apply_full_eval_results` never incremented `failed_ply_count`, so this
        same scenario would have silently stamped complete with a permanent
        NULL best_move at ply 5 — the exact self-terminating-out-of-the-174-07-
        lottery trap this fix closes.
        """
        from app.models.game import Game
        from app.models.game_position import GamePosition

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            lichess_evals_at=now,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch,
            full_drain_session_maker,
            game_id,
            full_drain_test_user_117,
            is_lichess_eval_game=True,
        )

        # 6 non-terminal plies, engine-evaluated in ply order (dedup_map is always
        # empty for lichess games, so engine_targets == targets == plies 0-5).
        # Ply 5's call is forced to fail (best_move=None) — every other ply succeeds.
        mock_evaluate = AsyncMock(
            side_effect=[
                (20, None, "e2e4", "e2e4", None, None, ""),
                (20, None, "e7e5", "e7e5", None, None, ""),
                (30, None, "g1f3", "g1f3", None, None, ""),
                (30, None, "b8c6", "b8c6", None, None, ""),
                (60, None, "f1c4", "f1c4", None, None, ""),
                (None, None, None, None, None, None, None),  # ply 5: forced failure
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        cp_by_ply = [20, 30, -500, -480, 60, 30]
        gp_rows = [
            {
                "ply": i,
                "full_hash": 0xF06_0000 + i,
                "eval_cp": cp_by_ply[i],
                "eval_mate": None,
            }
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is False, (
                "A tick with a genuine engine-covered hole must NOT report "
                "'processed' — the game is left pending for retry (Path B)."
            )

            async with full_drain_session_maker() as verify:
                game_row = (
                    await verify.execute(
                        select(
                            Game.full_evals_completed_at,
                            Game.full_pv_completed_at,
                            Game.full_eval_attempts,
                        ).where(Game.id == game_id)
                    )
                ).one()
                pos_rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.best_move, GamePosition.eval_cp)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                by_ply = {r[0]: (r[1], r[2]) for r in pos_rows.all()}

            full_evals_at, full_pv_at, attempts = game_row
            assert full_evals_at is None, (
                "full_evals_completed_at must NOT be stamped while a genuine "
                "engine-covered hole remains (SEED-045 Path B)."
            )
            assert full_pv_at is None, (
                "full_pv_completed_at must NOT be stamped while a genuine "
                "engine-covered hole remains — this is the exact silent "
                "false-completion trap the hole-counting fix closes."
            )
            assert attempts == 1, (
                f"full_eval_attempts must increment on a Path B tick, got {attempts}"
            )
            assert by_ply.get(5, (None, None))[0] is None, (
                "ply 5's best_move must stay NULL after the forced engine failure "
                "(the hole itself), not silently defaulted to something else."
            )
            for ply in range(5):
                assert by_ply.get(ply, (None, None))[0] is not None, (
                    f"ply {ply} must still get its best_move written even though a "
                    "DIFFERENT ply in the same tick holed (SEED-044 independence)."
                )
                assert by_ply.get(ply, (None, None))[1] == cp_by_ply[ply], (
                    f"The stored lichess %eval at ply {ply} must stay preserved "
                    "even on a Path B (holed) tick."
                )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_engine_game_flaw_pv_recovered_when_refutation_ply_dedups(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """SEED-056: a fresh engine game whose flaw_ply + 1 took an opening dedup
        transplant (eval only, NO pv) still gets its refutation pv via the second
        engine pass — so the flaw is taggable instead of being silently un-classifiable.

        Setup: engine game (lichess_evals_at NULL), _SIX_PLY_PGN, a white blunder at
        ply 2. The refutation board (ply 3, flaw_ply + 1) is in the opening dedup region
        and its full_hash matches a dedup donor, so the FIRST gather never engine-evaluates
        it — pre-SEED-056 its pv stayed NULL (registered, un-taggable). After the fix the
        drain pre-classifies, detects the pv-less flaw ply, and runs a targeted second
        pass that writes the pv at ply 3.

        Engine is mocked per-ply (keyed off the board) so dedup'ing ply 3 out of the first
        gather doesn't desync a positional side_effect list. The dedup map is stubbed to
        cover ONLY ply 3's hash; every other opening ply is engine-evaluated normally.
        """
        from app.models.game_position import GamePosition
        from app.services.eval_drain import _DEDUP_MAX_PLY

        ply3_hash = 0x5EED_0056_0003
        # Stored (post-move) eval-by-ply [20, 30, -500, -480, 60, 30] → one white
        # blunder at ply 2 (same construction as _blunder_eval_sequence). pos_eval is
        # position-keyed: pos_eval[k] = eval OF the position at ply k; stored row k =
        # pos_eval[k + 1] (_post_move_eval). pos_eval[3] = -500 is supplied by the dedup
        # transplant, so ply 3 is the pv-less refutation ply this test exercises.
        eval_by_ply = {0: 20, 1: 20, 2: 30, 3: -500, 4: -480, 5: 60, 6: 30}
        ply3_pv = "g1f3 g8f6 d2d4"

        def _eval_for_board(board: chess.Board) -> tuple[int, None, str, str, None, None, str]:
            ply = 2 * (board.fullmove_number - 1) + (0 if board.turn == chess.WHITE else 1)
            pv = ply3_pv if ply == 3 else f"e2e4 {ply}"
            return (eval_by_ply[ply], None, pv.split()[0], pv, None, None, "")

        assert 3 <= _DEDUP_MAX_PLY, f"ply 3 must be within DEDUP_MAX_PLY={_DEDUP_MAX_PLY}"

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        # Stub the dedup lookup to transplant ONLY ply 3 (eval -500, no pv — dedup never
        # carries a pv through _resolve_full_eval). Every other opening ply falls through
        # to a real engine call. 4-tuple shape (SEED-076 follow-up added cached pv as the
        # 4th element); this cache row itself has no pv (None) so it does not change
        # SEED-056's recovery-pass behavior under test here.
        async def _fake_fetch_dedup_evals(
            _session: Any, hashes: Any
        ) -> dict[int, tuple[int | None, int | None, str | None, str | None]]:
            return {ply3_hash: (-500, None, "g1f3", None)} if ply3_hash in hashes else {}

        monkeypatch.setattr(drain_module, "_fetch_dedup_evals", _fake_fetch_dedup_evals)
        mock_evaluate = AsyncMock(side_effect=_eval_for_board)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)
        # The SEED-056 refutation-pv recovery pass (_fill_engine_game_flaw_pvs) still calls
        # evaluate_nodes_with_pv (4-tuple), not multipv2 — mock it from the same board-keyed
        # eval so the ply-3 pv is recovered (Phase 142 left the recovery pass on with_pv).
        mock_evaluate_pv = AsyncMock(side_effect=lambda board: _eval_for_board(board)[:4])
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_with_pv", mock_evaluate_pv)

        gp_rows = [
            {
                "ply": i,
                "full_hash": ply3_hash if i == 3 else 0x5EED_0056_0010 + i,
                "eval_cp": None,
                "eval_mate": None,
            }
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.pv, GamePosition.eval_cp)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                by_ply = {r[0]: (r[1], r[2]) for r in rows.all()}

            # The dedup transplant drove classification: the blunder at ply 2 materialized
            # from the transplanted eval at ply 3 (stored at row 2).
            assert by_ply.get(2, (None, None))[1] == -500, (
                "Row 2's stored eval must be the transplanted -500 (post-move eval of the "
                "dedup'd ply 3) — the blunder must come from the dedup path."
            )
            # SEED-056 core assertion: the refutation pv at ply 3 was recovered by the
            # second engine pass even though ply 3 was dedup-transplanted in the first.
            assert by_ply.get(3, (None, None))[0] == ply3_pv, (
                "game_positions.pv at ply 3 (flaw_ply + 1) must be recovered via the "
                f"SEED-056 second pass, got {by_ply.get(3, (None, None))[0]!r}. Pre-fix a "
                "dedup-transplanted refutation ply kept pv=NULL (registered, un-taggable)."
            )
            # flaw_ply (ply 2) was engine-evaluated in the first gather, so its pv is present
            # via the normal path — guards against the fix only handling N+1.
            assert by_ply.get(2, (None, None))[0] is not None, (
                "game_positions.pv at ply 2 (flaw_ply) must be set (engine-evaluated, "
                "not dedup'd) — SEED-054 ideal-continuation pv."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── Phase 174-07 / SEED-109 item 2: lichess best-move backfill ───────────────


class TestLichessBestMoveBackfill:
    """174-07 Task 2: a lichess-eval backlog game (full_pv_completed_at IS NULL)
    selected by the broadened residual fallback drains through the unified
    174-06 full pass, gets game_best_moves coverage, keeps its stored lichess
    %evals untouched, and exits the backfill predicate afterward
    (self-termination) — all proven end-to-end in one tick.
    """

    async def test_backfill_pick_drains_gets_best_moves_and_self_terminates(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """End-to-end: the REAL claim_eval_job -> _claim_tier3_derived residual
        fallback (not mocked) selects a lichess backlog game, _full_drain_tick
        drains it, and afterward the game no longer matches the 174-07 backfill
        predicate.

        PGN: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. h3 a6 *" — the Italian Game
        main line (plies 0-5) is fully booked (find_opening_ply_count == 6),
        so plies 6 (h3) and 7 (a6) are the only out-of-book candidates. Ply 6
        is engineered to pass the GEMS-02 inaccuracy gate (played == best,
        wide margin); ply 7 is engineered to fail it (sub-margin) — proving
        the gate stays selective even under the backfill lane.
        """
        from app.models.game import Game
        from app.models.game_best_move import GameBestMove
        from app.models.game_position import GamePosition
        import app.services.eval_apply as eval_apply_module
        import app.services.eval_drain as drain_module
        import app.services.eval_queue_service as queue_module

        backfill_pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. h3 a6 *"

        now = datetime.now(timezone.utc)
        # Backlog game: already eval-complete (as a lichess game commonly is at
        # import) but PV/best-move-incomplete — the exact 174-07 target row.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=backfill_pgn,
            evals_completed_at=now,
            full_evals_completed_at=now,
            full_pv_completed_at=None,
            lichess_evals_at=now,
        )
        async with full_drain_session_maker() as session:
            await session.execute(
                sa.update(Game.__table__)  # ty: ignore[invalid-argument-type]
                .where(Game.id == game_id)
                .values(white_rating=1500, black_rating=1500)
            )
            await session.commit()

        # Route the REAL claim_eval_job's internal sessions (eval_queue_service)
        # to the test DB, and enable auto-drain (default False).
        monkeypatch.setattr(queue_module, "async_session_maker", full_drain_session_maker)
        monkeypatch.setattr(queue_module.settings, "EVAL_AUTO_DRAIN_ENABLED", True)
        # Drain + eval_apply sessions to the test DB, Sentry suppressed, yield
        # gate forced open (mirrors _patch_drain_for_tick_tests but WITHOUT
        # mocking claim_eval_job — this test drives the real selection path).
        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)
        monkeypatch.setattr(eval_apply_module, "async_session_maker", full_drain_session_maker)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_message", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_context", lambda *a, **kw: None)
        monkeypatch.setattr(
            drain_module,
            "_any_active_import_or_entry_ply_pending",
            AsyncMock(return_value=False),
        )
        monkeypatch.setattr(drain_module, "_build_flaw_multipv2_blobs", AsyncMock(return_value={}))
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.15)

        # 8 non-terminal plies (0-7). Plies 0-5 are the booked Italian Game main
        # line (best_uci given but irrelevant — book_plies excludes them from
        # candidacy regardless of played==best). Ply 6 (h2h3, white) is the
        # out-of-book played==best candidate with a wide margin (passes GEMS-02,
        # mirrors test_eval_apply.py's known-good 300/-100 example). Ply 7
        # (a7a6, black) is out-of-book played==best but sub-margin (10/5,
        # mirrors test_eval_apply.py's known-fail example) — must NOT yield a row.
        mock_evaluate = AsyncMock(
            side_effect=[
                (20, None, "e2e4", "e2e4", None, None, ""),
                (20, None, "e7e5", "e7e5", None, None, ""),
                (30, None, "g1f3", "g1f3", None, None, ""),
                (30, None, "b8c6", "b8c6", None, None, ""),
                (60, None, "f1c4", "f1c4", None, None, ""),
                (60, None, "f8c5", "f8c5", None, None, ""),
                (300, None, "h2h3", "h2h3", -100, None, "e7e6"),  # ply 6: candidate
                (10, None, "a7a6", "a7a6", 5, None, "b7b6"),  # ply 7: sub-margin
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        # Stored lichess %evals for all 8 plies — must be preserved unchanged.
        cp_by_ply = [15, 25, 35, 45, 55, 65, 75, 85]
        gp_rows = [
            {"ply": i, "full_hash": 0xB0F1_0000 + i, "eval_cp": cp_by_ply[i], "eval_mate": None}
            for i in range(8)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, (
                "Tick must report a processed game — the backlog game must be "
                "selected by the real claim_eval_job/residual fallback and "
                "drained without holes."
            )
            assert mock_evaluate.await_count == 8, (
                "All 8 non-terminal plies of the lichess backlog game must be "
                f"engine-evaluated under the unified full pass; got "
                f"{mock_evaluate.await_count} engine calls."
            )

            async with full_drain_session_maker() as verify:
                game_row = (
                    await verify.execute(
                        select(Game.full_pv_completed_at, Game.full_evals_completed_at).where(
                            Game.id == game_id
                        )
                    )
                ).one()
                pos_rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.eval_cp, GamePosition.best_move)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                pos_by_ply = {r[0]: (r[1], r[2]) for r in pos_rows.all()}
                bm_rows = (
                    (
                        await verify.execute(
                            select(GameBestMove).where(GameBestMove.game_id == game_id)
                        )
                    )
                    .scalars()
                    .all()
                )

            full_pv_at, full_evals_at = game_row
            assert full_pv_at is not None, (
                "full_pv_completed_at must be stamped after a hole-free tick (Path A)."
            )
            assert full_evals_at is not None

            # (b) stored lichess %evals preserved unchanged at every ply.
            for i in range(8):
                assert pos_by_ply.get(i, (None, None))[0] == cp_by_ply[i], (
                    f"ply {i}: stored lichess %eval must be preserved unchanged "
                    f"(SEED-109 item 4); got {pos_by_ply.get(i, (None, None))[0]!r}"
                )

            # (a) game_best_moves: exactly one row, at ply 6 (the wide-margin
            # out-of-book played==best candidate). Ply 7 (sub-margin) must NOT
            # produce a row — the GEMS-02 gate stays selective under backfill.
            assert len(bm_rows) == 1, (
                f"Expected exactly 1 game_best_moves row (ply 6 only); got "
                f"{len(bm_rows)}: {[(r.ply) for r in bm_rows]}"
            )
            bm_row = bm_rows[0]
            assert bm_row.ply == 6
            assert bm_row.best_cp == 300
            assert bm_row.second_cp == -100

            # (c) self-termination: the 174-07 backfill predicate no longer
            # matches this game — the exact Task 1 predicate, checked directly
            # against this game_id (not via the lottery, to stay deterministic).
            async with full_drain_session_maker() as verify:
                still_matches = (
                    await verify.execute(
                        select(Game.id).where(
                            Game.id == game_id,
                            Game.lichess_evals_at.isnot(None),
                            Game.full_pv_completed_at.is_(None),
                        )
                    )
                ).scalar_one_or_none()
            assert still_matches is None, (
                "After drain, this game must no longer match the 174-07 backfill "
                "predicate (lichess_evals_at IS NOT NULL AND full_pv_completed_at "
                "IS NULL) — self-termination is broken if it does."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_double_pick_of_same_backlog_game_does_not_duplicate_best_moves(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Concurrency safety (D-7 residual-duplicate acceptance): two workers
        picking the SAME backlog game (double-claim under the plain, non-locking
        residual-fallback SELECT) must not produce duplicate game_best_moves
        rows — the (game_id, ply) upsert makes re-processing idempotent.

        Simulated by forcing claim_eval_job to return the same game_id twice
        (mocked claim, mirroring _patch_drain_for_tick_tests) and running two
        full drain ticks back to back.
        """
        from app.models.game import Game
        from app.models.game_best_move import GameBestMove
        from app.services.eval_queue_service import ClaimedJob

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn="1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. h3 a6 *",
            evals_completed_at=now,
            full_evals_completed_at=now,
            full_pv_completed_at=None,
            lichess_evals_at=now,
        )
        async with full_drain_session_maker() as session:
            await session.execute(
                sa.update(Game.__table__)  # ty: ignore[invalid-argument-type]
                .where(Game.id == game_id)
                .values(white_rating=1500, black_rating=1500)
            )
            await session.commit()

        cp_by_ply = [15, 25, 35, 45, 55, 65, 75, 85]
        gp_rows = [
            {"ply": i, "full_hash": 0xB0F2_0000 + i, "eval_cp": cp_by_ply[i], "eval_mate": None}
            for i in range(8)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )

        def _engine_mock() -> AsyncMock:
            return AsyncMock(
                side_effect=[
                    (20, None, "e2e4", "e2e4", None, None, ""),
                    (20, None, "e7e5", "e7e5", None, None, ""),
                    (30, None, "g1f3", "g1f3", None, None, ""),
                    (30, None, "b8c6", "b8c6", None, None, ""),
                    (60, None, "f1c4", "f1c4", None, None, ""),
                    (60, None, "f8c5", "f8c5", None, None, ""),
                    (300, None, "h2h3", "h2h3", -100, None, "e7e6"),
                    (10, None, "a7a6", "a7a6", 5, None, "b7b6"),
                ]
            )

        import app.services.eval_apply as eval_apply_module

        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.15)

        try:
            for _ in range(2):
                drain_module = _patch_drain_for_tick_tests(
                    monkeypatch,
                    full_drain_session_maker,
                    game_id,
                    full_drain_test_user_117,
                    is_lichess_eval_game=True,
                )
                # _patch_drain_for_tick_tests always builds a fresh ClaimedJob and
                # stubs _build_flaw_multipv2_blobs — override the engine mock only.
                monkeypatch.setattr(
                    drain_module.engine_service, "evaluate_nodes_multipv2", _engine_mock()
                )
                monkeypatch.setattr(
                    drain_module,
                    "claim_eval_job",
                    AsyncMock(
                        return_value=ClaimedJob(
                            game_id=game_id,
                            user_id=full_drain_test_user_117,
                            tier=3,
                            is_lichess_eval_game=True,
                            job_id=None,
                        )
                    ),
                )
                processed = await drain_module._full_drain_tick()
                assert processed is True

            async with full_drain_session_maker() as verify:
                bm_rows = (
                    (
                        await verify.execute(
                            select(GameBestMove).where(GameBestMove.game_id == game_id)
                        )
                    )
                    .scalars()
                    .all()
                )

            assert len(bm_rows) == 1, (
                "Two picks of the SAME backlog game must upsert on (game_id, ply), "
                f"not duplicate — expected exactly 1 row, got {len(bm_rows)}."
            )
            assert bm_rows[0].ply == 6
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── Phase 176 BACK-01: tier-4b best-move backfill ───────────────────────────


class TestBestMoveBackfill:
    """Phase 176 Plan 01 / Phase 177 Plan 03: an engine-side (non-lichess) game
    claimed by tier-4b drains through the MINIMAL candidate-only path (Phase
    177 D-05 — fixes the documented `_ = tier` no-op) end-to-end, gets
    `best_moves_completed_at` stamped (self-termination) — and, the crux, a
    Maia-absent backend never stamps it even when best-move candidate rows
    were otherwise produced (guardrail; mutation-test-style negative
    assertion per project MEMORY.md).
    """

    _BACKFILL_PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. h3 a6 *"

    @staticmethod
    def _engine_mock() -> AsyncMock:
        """EXACTLY 2 targeted MultiPV-2 runner-up searches — the minimal
        drain path (Phase 177 D-05) leases only the out-of-book played==best
        candidate plies (ply 6 h2h3, wide-margin; ply 7 a7a6, sub-margin) via
        `_build_bestmove_lease_positions`, never the other 6 in-book plies +
        terminal eval-donor the old full-pipeline path used to gather. Only
        indices 4/5/6 (second_cp, second_mate, second_uci) are read by the
        minimal path — best_cp/best_mate/best_uci come from the STORED
        game_positions data (Pitfall 1 inverse-shift reconstruction), not
        from these mock results, so indices 0-3 are left at None."""
        return AsyncMock(
            side_effect=[
                (None, None, None, None, -500, None, "e7e6"),  # ply 6: wide margin -> candidate
                (None, None, None, None, 75, None, "b7b6"),  # ply 7: zero margin -> rejected
            ]
        )

    async def _seed_backfill_game(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        full_hash_base: int,
    ) -> int:
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=self._BACKFILL_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,
            full_pv_completed_at=now,
            lichess_evals_at=None,
        )
        async with full_drain_session_maker() as session:
            await session.execute(
                sa.update(Game.__table__)  # ty: ignore[invalid-argument-type]
                .where(Game.id == game_id)
                .values(white_rating=1500, black_rating=1500)
            )
            await session.commit()
        # cp_by_ply is the STORED (post-move-shifted) eval_cp per row — row i's
        # value is the eval OF position i+1 (Pitfall 1 inverse-shift source).
        # best_move is set ONLY on the two out-of-book rows (6, 7) so
        # _build_bestmove_lease_positions's played==stored-best test nominates
        # exactly those two as candidates (plies 0-5 are in-book and skipped
        # regardless of their best_move value).
        cp_by_ply = [15, 25, 35, 45, 55, 65, 75, 85]
        gp_rows: list[dict[str, Any]] = [
            {"ply": i, "full_hash": full_hash_base + i, "eval_cp": cp_by_ply[i], "eval_mate": None}
            for i in range(8)
        ]
        gp_rows[6]["best_move"] = "h2h3"  # played at ply 6 -> candidate
        gp_rows[7]["best_move"] = (
            "a7a6"  # played at ply 7 -> candidate (sub-margin, rejected later)
        )
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        return game_id

    async def test_full_drain_tick_tier4b_minimal_path(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Phase 177 D-05 (the plan's core artifact): a claimed
        TIER_BESTMOVE_BACKFILL game runs the MINIMAL candidate-only path —
        writes game_best_moves + stamps best_moves_completed_at, calls
        `evaluate_nodes_multipv2` EXACTLY twice (only the 2 leased candidate
        plies, never the other 6 in-book plies + terminal donor the full
        every-ply gather would visit), and never calls `apply_full_eval`."""
        from app.models.eval_jobs import TIER_BESTMOVE_BACKFILL
        from app.models.game import Game
        from app.models.game_best_move import GameBestMove
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        game_id = await self._seed_backfill_game(
            full_drain_test_user_117, full_drain_session_maker, 0xB1F3_0000
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch,
            full_drain_session_maker,
            game_id,
            full_drain_test_user_117,
            is_lichess_eval_game=False,
            tier=TIER_BESTMOVE_BACKFILL,
        )
        monkeypatch.setattr(maia_engine, "_session", object())  # Maia present (sentinel)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.15)
        engine_mock = self._engine_mock()
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", engine_mock)

        apply_full_eval_calls: list[int] = []
        real_apply_full_eval = drain_module.apply_full_eval

        async def _spy_apply_full_eval(*args: Any, **kwargs: Any) -> Any:
            apply_full_eval_calls.append(1)
            return await real_apply_full_eval(*args, **kwargs)

        monkeypatch.setattr(drain_module, "apply_full_eval", _spy_apply_full_eval)

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            assert apply_full_eval_calls == [], (
                "apply_full_eval must NEVER be called on a TIER_BESTMOVE_BACKFILL "
                "claim — that is the full every-ply reclassify path, which the "
                "minimal tier-4b path must bypass entirely (Pitfall 3 fix)."
            )
            assert engine_mock.await_count == 2, (
                "evaluate_nodes_multipv2 must be called EXACTLY twice (the 2 "
                f"leased candidate plies only); got {engine_mock.await_count} calls "
                "— the minimal path must never run the full every-ply gather."
            )

            async with full_drain_session_maker() as verify:
                best_moves_at = (
                    await verify.execute(
                        select(Game.best_moves_completed_at).where(Game.id == game_id)
                    )
                ).scalar_one()
                bm_rows = (
                    (
                        await verify.execute(
                            select(GameBestMove).where(GameBestMove.game_id == game_id)
                        )
                    )
                    .scalars()
                    .all()
                )

            assert best_moves_at is not None, "best_moves_completed_at must be stamped."
            assert len(bm_rows) == 1, (
                f"Expected exactly 1 game_best_moves row (ply 6 only); got "
                f"{len(bm_rows)}: {[r.ply for r in bm_rows]}"
            )
            assert bm_rows[0].ply == 6
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_non_tier4b_claim_still_takes_full_path(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Regression guard: a non-tier-4b claim (tier=3, idle backlog) is
        UNCHANGED — it still runs the full every-ply gather + apply_full_eval
        reclassify, proving the new tier branch is scoped to
        TIER_BESTMOVE_BACKFILL only."""
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        game_id = await self._seed_backfill_game(
            full_drain_test_user_117, full_drain_session_maker, 0xB1F4_0000
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch,
            full_drain_session_maker,
            game_id,
            full_drain_test_user_117,
            is_lichess_eval_game=False,
            tier=3,  # idle/tier-3 derived — NOT TIER_BESTMOVE_BACKFILL
        )
        monkeypatch.setattr(maia_engine, "_session", object())
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.15)

        # Full path re-evaluates all 8 non-terminal plies + 1 terminal donor.
        engine_mock = AsyncMock(
            side_effect=[
                (20, None, "e2e4", "e2e4", None, None, ""),
                (20, None, "e7e5", "e7e5", None, None, ""),
                (30, None, "g1f3", "g1f3", None, None, ""),
                (30, None, "b8c6", "b8c6", None, None, ""),
                (60, None, "f1c4", "f1c4", None, None, ""),
                (60, None, "f8c5", "f8c5", None, None, ""),
                (300, None, "h2h3", "h2h3", -100, None, "e7e6"),
                (10, None, "a7a6", "a7a6", 5, None, "b7b6"),
                (5, None, "a2a3", "a2a3", None, None, ""),
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", engine_mock)

        apply_full_eval_calls: list[int] = []
        real_apply_full_eval = drain_module.apply_full_eval

        async def _spy_apply_full_eval(*args: Any, **kwargs: Any) -> Any:
            apply_full_eval_calls.append(1)
            return await real_apply_full_eval(*args, **kwargs)

        monkeypatch.setattr(drain_module, "apply_full_eval", _spy_apply_full_eval)

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"
            assert apply_full_eval_calls == [1], (
                "apply_full_eval must be called exactly once for a non-tier-4b "
                f"claim; got {len(apply_full_eval_calls)} calls."
            )
            assert engine_mock.await_count == 9, (
                "The full path must gather all 8 non-terminal plies + 1 terminal "
                f"donor; got {engine_mock.await_count} calls."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_tier4b_drain_local_fallback_tagged_source(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """D-06/OBS-01: when the minimal drain path's own targeted search comes
        back with no usable runner-up for a leased candidate ply,
        `_build_best_move_candidates`'s Pitfall-1 fallback fires a SECOND
        `evaluate_nodes_multipv2` call for that ply and tags the Sentry event
        `source='drain-local'` — queryable apart from the
        `worker-submit-fallback` regression signal (177-01-SUMMARY.md)."""
        from app.models.eval_jobs import TIER_BESTMOVE_BACKFILL
        from app.models.game_best_move import GameBestMove
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        # A rare, non-book opening so book_plies == 0 (ply 1 is out-of-book
        # from the very start) — 1 candidate ply keeps the fallback trigger
        # deterministic and isolated.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn="1. a4 h6 *",
            evals_completed_at=datetime.now(timezone.utc),
            full_evals_completed_at=datetime.now(timezone.utc),
            full_pv_completed_at=datetime.now(timezone.utc),
            lichess_evals_at=None,
        )
        from app.models.game import Game

        async with full_drain_session_maker() as session:
            await session.execute(
                sa.update(Game.__table__)  # ty: ignore[invalid-argument-type]
                .where(Game.id == game_id)
                .values(white_rating=1500, black_rating=1500)
            )
            await session.commit()
        gp_rows: list[dict[str, Any]] = [
            {"ply": 0, "full_hash": 0xB1F5_0000, "eval_cp": 0, "eval_mate": None},
            {
                "ply": 1,
                "full_hash": 0xB1F5_0001,
                "eval_cp": 10,
                "eval_mate": None,
                "best_move": "h7h6",  # played at ply 1 -> candidate
            },
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch,
            full_drain_session_maker,
            game_id,
            full_drain_test_user_117,
            is_lichess_eval_game=False,
            tier=TIER_BESTMOVE_BACKFILL,
        )
        monkeypatch.setattr(maia_engine, "_session", object())
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.15)

        set_tag_calls: list[tuple[str, str]] = []
        monkeypatch.setattr(
            eval_apply_module.sentry_sdk,
            "set_tag",
            lambda key, value: set_tag_calls.append((key, value)),
        )
        monkeypatch.setattr(eval_apply_module.sentry_sdk, "set_context", lambda *a, **kw: None)

        # Call 1: the minimal path's OWN targeted search for ply 1 comes back
        # with no usable runner-up (both second_cp and second_uci None) -> ply 1
        # is left OUT of second_best_map -> _build_best_move_candidates's own
        # Pitfall-1 fallback fires call 2, this time with a real runner-up.
        # best_cp (ply 1, mover=black) resolves to eval_of_position[1] = row 0's
        # eval_cp = 0 (white POV, roughly neutral). The runner-up must be
        # clearly WORSE for black — a HIGHER white-POV cp (favors white) — for
        # the margin gate to pass in black's favor.
        engine_mock = AsyncMock(
            side_effect=[
                (None, None, None, None, None, None, None),  # ply 1: no runner-up
                (None, None, "h7h6", None, 1000, None, "b7b5"),  # fallback re-search
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", engine_mock)

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            assert engine_mock.await_count == 2, (
                "expected exactly 2 evaluate_nodes_multipv2 calls (the targeted "
                f"search + the Pitfall-1 fallback re-search); got {engine_mock.await_count}"
            )
            assert ("source", "drain-local") in set_tag_calls, (
                f"Expected a ('source', 'drain-local') Sentry tag when the "
                f"drain-local fallback fires, got {set_tag_calls}"
            )

            async with full_drain_session_maker() as verify:
                bm_rows = (
                    (
                        await verify.execute(
                            select(GameBestMove).where(GameBestMove.game_id == game_id)
                        )
                    )
                    .scalars()
                    .all()
                )
            assert len(bm_rows) == 1
            assert bm_rows[0].ply == 1
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_maia_absent_never_stamps_best_moves_completed_at(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """GUARDRAIL (the crux, D-01): with maia_engine._session forced to None,
        best_moves_completed_at MUST stay NULL after the drain tick even though
        score_move is mocked to SUCCEED (best_move_rows would be non-empty if
        row-count alone gated the stamp) — proving the stamp is independently
        gated by maia_engine.is_maia_available(), never inferred from row
        count (RESEARCH Pitfall 1: _build_best_move_candidates returns [] for
        BOTH 'Maia ran, zero candidates' AND 'Maia absent', so row count is a
        structurally unsound availability signal). The game stays re-drainable.

        Positive counterpart (session present -> stamp fires) is proven by
        test_full_drain_tick_tier4b_minimal_path above — per project
        MEMORY.md "Mutation-test gap closures", both the negative and
        positive assertions are required, not just the positive path.
        """
        from app.models.game import Game
        from app.models.eval_jobs import TIER_BESTMOVE_BACKFILL
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        game_id = await self._seed_backfill_game(
            full_drain_test_user_117, full_drain_session_maker, 0xB1F2_0000
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch,
            full_drain_session_maker,
            game_id,
            full_drain_test_user_117,
            is_lichess_eval_game=False,
            tier=TIER_BESTMOVE_BACKFILL,
        )

        # THE GUARDRAIL SETUP: Maia session forced ABSENT, but score_move is
        # mocked to SUCCEED anyway. If the stamp were (incorrectly) gated by
        # best_move_rows being non-empty rather than is_maia_available(), this
        # test would wrongly observe the stamp fire.
        monkeypatch.setattr(maia_engine, "_session", None)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.15)
        monkeypatch.setattr(
            drain_module.engine_service, "evaluate_nodes_multipv2", self._engine_mock()
        )

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                best_moves_at = (
                    await verify.execute(
                        select(Game.best_moves_completed_at).where(Game.id == game_id)
                    )
                ).scalar_one()

            assert best_moves_at is None, (
                "GUARDRAIL VIOLATION: best_moves_completed_at must stay NULL when "
                "maia_engine._session is None (Maia-absent backend), even though "
                "score_move was mocked to succeed. Stamping here would "
                "permanently lock this game out of the tier-4b lottery on a "
                "Maia-absent backend (D-01 correctness requirement)."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── EVAL-06: classify hook + oracle counts ───────────────────────────────────


class TestClassifyHook:
    """EVAL-06: classify_game_flaws runs automatically after full eval completes.

    After a drain tick, game_flaws rows must exist for any game with sufficient
    eval coverage and at least one mistake/blunder.
    """

    async def test_classify_hook_inserts_game_flaws(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After a drain tick with a blunder at ply 2, game_flaws rows exist
        for the game (EVAL-06 / _classify_and_fill_oracle hook)."""
        from app.models.game_flaw import GameFlaw

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        eval_sequence = _blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0xBEEF_B00C + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                flaw_count = await verify.scalar(
                    select(sa.func.count()).select_from(GameFlaw).where(GameFlaw.game_id == game_id)
                )

            assert flaw_count is not None and flaw_count > 0, (
                f"game_flaws must have rows after drain tick for game {game_id} "
                "— _classify_and_fill_oracle EVAL-06 hook must have run."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_full_pass_replaces_entry_pass_flaw_rows(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The full/oracle pass must REPLACE pre-existing entry-pass flaw rows.

        Regression guard (tactic-tag bug): lichess "covered" games get flaw rows
        from _classify_and_insert_flaws at import — with NULL tactic columns,
        because the entry pass has no PVs. The full pass then re-classifies WITH
        PVs (tactics detected) but used to call bulk_insert_game_flaws with
        ON CONFLICT DO NOTHING, so the fresh tactic-bearing rows were silently
        dropped and tactic_motif stayed NULL forever. The fix deletes the game's
        flaw rows before re-inserting, so the authoritative full pass fully
        replaces the entry-pass approximation.

        Setup: a blunder at ply 2 (severity 2). Pre-seed two stale entry-pass
        rows: ply 2 with the WRONG severity (1=mistake), and ply 0 which the full
        pass does NOT classify as a flaw at all. After the tick: ply 2 must read
        severity 2 (overwritten — DO NOTHING would have kept 1), and ply 0 must
        be GONE (stale row removed by the delete).
        """
        from app.models.game_flaw import GameFlaw

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        eval_sequence = _blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0xDEAD_B00C + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )

        # Pre-seed stale entry-pass rows BEFORE the tick.
        async with full_drain_session_maker() as seed:
            seed.add_all(
                [
                    # Real flaw ply, but stamped with the WRONG severity + NULL tactics
                    # (mimics the no-PV entry pass).
                    GameFlaw(
                        user_id=full_drain_test_user_117,
                        game_id=game_id,
                        ply=2,
                        severity=1,
                        phase=0,
                        is_miss=False,
                        is_lucky=False,
                        is_reversed=False,
                        is_squandered=False,
                        fen="stale",
                    ),
                    # Not a flaw per the full classify — must be deleted, not survive.
                    GameFlaw(
                        user_id=full_drain_test_user_117,
                        game_id=game_id,
                        ply=0,
                        severity=2,
                        phase=0,
                        is_miss=False,
                        is_lucky=False,
                        is_reversed=False,
                        is_squandered=False,
                        fen="stale",
                    ),
                ]
            )
            await seed.commit()

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(GameFlaw.ply, GameFlaw.severity, GameFlaw.fen)
                    .where(GameFlaw.game_id == game_id)
                    .order_by(GameFlaw.ply)
                )
                by_ply = {r[0]: (r[1], r[2]) for r in rows.all()}

            assert 2 in by_ply, "The blunder at ply 2 must still have a flaw row."
            assert by_ply[2][0] == 2, (
                "ply 2 must be re-classified as a blunder (severity 2) by the full "
                "pass — ON CONFLICT DO NOTHING would have kept the stale severity 1."
            )
            assert by_ply[2][1] != "stale", (
                "ply 2 row must be the freshly inserted one (real fen), not the "
                "stale entry-pass row — proves delete-then-insert ran."
            )
            assert 0 not in by_ply, (
                "The stale ply-0 row (not a flaw per the full pass) must be deleted "
                "— the full pass is authoritative and replaces entry-pass rows."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


class TestLocalDrainBlobsPendingSuppression:
    """SEED-075: the local in-process drain must pass blobs_pending=True to
    _classify_and_fill_oracle, mirroring the atomic go-forward path
    (test_eval_worker_endpoints.py::test_submit_suppresses_cp_flaw_tag_then_blob_submit_self_heals).

    Before the fix the drain defaulted blobs_pending=False and re-minted raw ungated
    cp-based tactic tags for any flaw whose continuation blob was not assembled this
    pass — the Phase 147 strict-zero violation this seed closes.
    """

    async def test_drain_suppresses_cp_flaw_tag_with_no_blob(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A cp-based motif'd flaw with no assembled blob is suppressed to NULL after a
        drain tick (blobs_pending=True), not persisted raw/ungated.

        Setup mirrors the atomic-submit test: blunder at ply 2 (pre_flaw_eval_cp =
        stored row 1 = 30, cp-based not mate-adjacent), the tactic kernel is fixed to a
        deterministic HANGING_PIECE motif on the "allowed" orientation, and
        _build_flaw_multipv2_blobs is stubbed to {} by _patch_drain_for_tick_tests so
        the flaw_ply is absent from flaw_pv_blobs (pv_blob is None) — the exact leak
        condition. With the SEED-075 fix the raw tag is suppressed; without it (default
        False) allowed_tactic_motif would be persisted non-NULL.
        """
        import app.services.flaws_service as flaws_service_module
        from app.models.game_flaw import GameFlaw
        from app.services.tactic_detector import TACTIC_CONFIDENCE_HIGH, TacticMotifInt

        def _fake_detect(
            n: int,
            fen_map: dict[int, str],
            positions: list[Any],
            pv_by_ply: Any = None,
            orientation: str = "allowed",
        ) -> tuple[int | None, int | None, int | None, int | None]:
            if orientation == "allowed":
                return (int(TacticMotifInt.HANGING_PIECE), 2, TACTIC_CONFIDENCE_HIGH, 0)
            return (None, None, None, None)

        monkeypatch.setattr(flaws_service_module, "_detect_tactic_for_flaw", _fake_detect)

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        eval_sequence = _blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0x5EED_0075 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                flaw_row = (
                    await verify.execute(
                        select(
                            GameFlaw.ply,
                            GameFlaw.allowed_tactic_motif,
                            GameFlaw.missed_tactic_motif,
                            GameFlaw.allowed_pv_lines,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).one()
            flaw_ply, allowed_motif, missed_motif, allowed_blob = flaw_row

            assert flaw_ply == 2, f"Flaw must be at ply 2, got {flaw_ply}"
            assert allowed_blob is None, (
                "No blob was assembled this pass (flaw_pv_blobs stubbed to {}), so "
                "allowed_pv_lines must be NULL — the leak precondition."
            )
            assert allowed_motif is None, (
                "SEED-075: the local drain must pass blobs_pending=True so a cp-based "
                "motif with no assembled blob is suppressed to NULL, not persisted "
                "raw/ungated (Phase 147 strict-zero invariant)."
            )
            assert missed_motif is None
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


class TestOracleCounts:
    """EVAL-06 / D-117-08: oracle count columns are filled after full eval and match game_flaws."""

    async def test_oracle_counts_filled_and_match_game_flaws(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After a drain tick, white/black inaccuracy/mistake/blunder columns on games
        are filled (D-117-08) and the blunder counts match the game_flaws rows.

        _blunder_eval_sequence creates one blunder at ply 2 (white's move). So:
          white_blunders = 1, white_mistakes = 0, white_inaccuracies = ? (via count_game_severities)
          black_blunders = 0, black_mistakes = 0, black_inaccuracies = ?
        The test verifies white_blunders >= 1 and black_blunders == 0 to avoid
        over-specifying the inaccuracy count (depends on exact sigmoid thresholds).
        It also verifies that sum(game_flaws severity=blunder for white) == white_blunders.
        """
        from app.models.game import Game
        from app.models.game_flaw import GameFlaw

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        eval_sequence = _blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0xBEEF_0AC0 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                game_row = await verify.execute(
                    select(
                        Game.white_blunders,
                        Game.white_mistakes,
                        Game.white_inaccuracies,
                        Game.black_blunders,
                        Game.black_mistakes,
                        Game.black_inaccuracies,
                    ).where(Game.id == game_id)
                )
                oracle = game_row.one_or_none()

                # White blunder rows in game_flaws: white plays at even plies (ply % 2 == 0).
                # ply 2 is white's blunder in the blunder-eval sequence.
                _SEVERITY_BLUNDER = 2
                white_blunder_rows = await verify.scalar(
                    select(sa.func.count())
                    .select_from(GameFlaw)
                    .where(
                        GameFlaw.game_id == game_id,
                        GameFlaw.severity == _SEVERITY_BLUNDER,
                        GameFlaw.ply % 2 == 0,  # white plays at even plies
                    )
                )

            assert oracle is not None, "Game row must exist after drain tick"
            white_blunders, white_mistakes, white_inaccuracies = oracle[0], oracle[1], oracle[2]
            black_blunders, black_mistakes, black_inaccuracies = oracle[3], oracle[4], oracle[5]

            # Oracle counts must be filled (not NULL).
            assert white_blunders is not None, "white_blunders must be set after drain (D-117-08)"
            assert white_mistakes is not None, "white_mistakes must be set after drain (D-117-08)"
            assert white_inaccuracies is not None, "white_inaccuracies must be set after drain"
            assert black_blunders is not None, "black_blunders must be set after drain (D-117-08)"
            assert black_mistakes is not None, "black_mistakes must be set after drain (D-117-08)"
            assert black_inaccuracies is not None, "black_inaccuracies must be set after drain"

            # The blunder sequence has exactly one clear blunder for white at ply 2.
            assert white_blunders >= 1, (
                f"white_blunders must be >= 1 for the blunder-sequence game, got {white_blunders}"
            )
            assert black_blunders == 0, (
                f"black_blunders must be 0 (no black blunders in eval sequence), got {black_blunders}"
            )

            # Oracle blunder count must match game_flaws blunder rows for white (D-117-08).
            assert white_blunders == white_blunder_rows, (
                f"white_blunders ({white_blunders}) must equal game_flaws blunder rows "
                f"for white ({white_blunder_rows}) — D-117-08 oracle consistency."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── Phase 178 Plan 03: live-hook accuracy/ACPL wiring ────────────────────────


class TestAccuracyAcplHook:
    """T-178-03-T/T-178-03-I: the live full-eval-completion hook writes the four
    canonical accuracy/ACPL columns atomically with oracle counts, and correctly
    leaves them NULL (never stale/wrong) when the shared compute detects an
    interior eval hole — even though the completion stamp may still be set
    (D-03: stamp-complete does not imply hole-free)."""

    async def test_accuracy_acpl_filled_after_hole_free_drain_tick(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After a hole-free drain tick, the four canonical columns are non-NULL,
        in a sane range, and full_evals_completed_at is set in the same committed
        state (atomicity: both land together, T-178-03-T)."""
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_117
        )

        eval_sequence = _blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0xACC0_1234 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                row = (
                    await verify.execute(
                        select(
                            Game.white_accuracy,
                            Game.black_accuracy,
                            Game.white_acpl,
                            Game.black_acpl,
                            Game.full_evals_completed_at,
                        ).where(Game.id == game_id)
                    )
                ).one()
            white_accuracy, black_accuracy, white_acpl, black_acpl, completed_at = row

            assert completed_at is not None, (
                "full_evals_completed_at must be set after a hole-free drain tick"
            )
            for label, value in (
                ("white_accuracy", white_accuracy),
                ("black_accuracy", black_accuracy),
            ):
                assert value is not None, f"{label} must be non-NULL after a hole-free drain tick"
                assert 0.0 <= value <= 100.0, f"{label}={value} out of [0,100] range"
            for label, value in (
                ("white_acpl", white_acpl),
                ("black_acpl", black_acpl),
            ):
                assert value is not None, f"{label} must be non-NULL after a hole-free drain tick"
                assert value >= 0, f"{label}={value} must be >= 0"
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_accuracy_acpl_null_on_interior_hole(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Direct call to `_classify_and_fill_oracle` (the seam under test) with an
        interior eval hole at ply 2: the compute's own Complete-Sequence Gate
        returns None, so all four canonical columns stay NULL, while the
        oracle-count UPDATE still executes and a pre-existing completion stamp is
        left untouched (D-03 — stamp-complete does not imply hole-free)."""
        import app.services.eval_apply as eval_apply_module
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        # Pre-set full_evals_completed_at to prove the stamp is independent of
        # this call and stays set regardless of the accuracy/ACPL hole outcome —
        # `_classify_and_fill_oracle` itself never writes this column.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,
        )

        # Six rows (plies 0-5) mirroring _SIX_PLY_PGN. Ply 2's eval is left NULL
        # (both eval_cp and eval_mate) — an interior hole per the compute's
        # Complete-Sequence Gate (_is_hole_free checks the position reached by
        # each of plies 0-3, i.e. keys 1-4; ply 2's row supplies key 3).
        gp_rows = [
            {"ply": 0, "full_hash": 0xB0BE_0100, "eval_cp": 20, "eval_mate": None},
            {"ply": 1, "full_hash": 0xB0BE_0101, "eval_cp": 30, "eval_mate": None},
            {"ply": 2, "full_hash": 0xB0BE_0102, "eval_cp": None, "eval_mate": None},  # the hole
            {"ply": 3, "full_hash": 0xB0BE_0103, "eval_cp": -480, "eval_mate": None},
            {"ply": 4, "full_hash": 0xB0BE_0104, "eval_cp": 60, "eval_mate": None},
            {"ply": 5, "full_hash": 0xB0BE_0105, "eval_cp": 30, "eval_mate": None},
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            async with full_drain_session_maker() as session:
                await eval_apply_module._classify_and_fill_oracle(
                    session, game_id, engine_result_map={}
                )
                await session.commit()

            async with full_drain_session_maker() as verify:
                row = (
                    await verify.execute(
                        select(
                            Game.white_accuracy,
                            Game.black_accuracy,
                            Game.white_acpl,
                            Game.black_acpl,
                            Game.white_blunders,
                            Game.full_evals_completed_at,
                        ).where(Game.id == game_id)
                    )
                ).one()
            (
                white_accuracy,
                black_accuracy,
                white_acpl,
                black_acpl,
                white_blunders,
                completed_at,
            ) = row

            assert white_accuracy is None, "white_accuracy must be NULL on an interior eval hole"
            assert black_accuracy is None, "black_accuracy must be NULL on an interior eval hole"
            assert white_acpl is None, "white_acpl must be NULL on an interior eval hole"
            assert black_acpl is None, "black_acpl must be NULL on an interior eval hole"
            assert white_blunders is not None, (
                "the oracle-count UPDATE must still execute even when the accuracy/ACPL "
                "compute returns None (D-03) — white_blunders must not be NULL"
            )
            assert completed_at is not None, (
                "the pre-existing full_evals_completed_at stamp must be left untouched by "
                "_classify_and_fill_oracle — D-03: stamp-complete does not imply hole-free"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_seed125_clear_direction_reclassification_nulls_blob_stamp(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """SEED-125 CLEAR direction: a game already carrying a `blobs_completed_at`
        stamp, whose reclassification (`_classify_and_fill_oracle`) inserts a fresh
        NULL-blob flaw ply, has the stamp cleared back to NULL. Uses the same
        stored (post-move) eval-by-ply as `_blunder_eval_sequence`'s docstring —
        [20, 30, -500, -480, 60, 30] — which classifies to exactly one white
        blunder at ply 2 (unlike the interior-hole fixture, whose NULL at ply 2
        nulls out both adjacent flaw classifications and produces zero rows)."""
        import app.services.eval_apply as eval_apply_module
        from app.models.game import Game
        from app.models.game_flaw import GameFlaw

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,
        )

        gp_rows = [
            {"ply": 0, "full_hash": 0xB0BF_0100, "eval_cp": 20, "eval_mate": None},
            {"ply": 1, "full_hash": 0xB0BF_0101, "eval_cp": 30, "eval_mate": None},
            {"ply": 2, "full_hash": 0xB0BF_0102, "eval_cp": -500, "eval_mate": None},
            {"ply": 3, "full_hash": 0xB0BF_0103, "eval_cp": -480, "eval_mate": None},
            {"ply": 4, "full_hash": 0xB0BF_0104, "eval_cp": 60, "eval_mate": None},
            {"ply": 5, "full_hash": 0xB0BF_0105, "eval_cp": 30, "eval_mate": None},
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            # Pre-stamp blobs_completed_at directly (not via _insert_game — that
            # helper has no kwarg for this column) to simulate an earlier tier-4
            # pass having already completed the blob backfill for this game.
            async with full_drain_session_maker() as pre_session:
                await pre_session.execute(
                    sa.update(Game).where(Game.id == game_id).values(blobs_completed_at=now)
                )
                await pre_session.commit()

            async with full_drain_session_maker() as session:
                await eval_apply_module._classify_and_fill_oracle(
                    session, game_id, engine_result_map={}
                )
                await session.commit()

            async with full_drain_session_maker() as verify:
                stamp = (
                    await verify.execute(select(Game.blobs_completed_at).where(Game.id == game_id))
                ).scalar_one()
                null_blob_flaws = (
                    (
                        await verify.execute(
                            select(GameFlaw.ply).where(
                                GameFlaw.game_id == game_id,
                                GameFlaw.allowed_pv_lines.is_(None),
                            )
                        )
                    )
                    .scalars()
                    .all()
                )

            assert stamp is None, (
                "blobs_completed_at must be cleared back to NULL after a reclassification "
                "inserts a fresh NULL-blob flaw ply on an already-stamped game"
            )
            assert null_blob_flaws, (
                "the reclassification must have actually produced a NULL-blob flaw ply — "
                "otherwise this test would pass vacuously"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_seed125_set_direction_refresh_stamps_blob_completed(
        self,
        full_drain_test_user_117: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """SEED-125 SET direction: once every flaw ply on a game carries a non-NULL
        `allowed_pv_lines` blob, calling `_refresh_blobs_completed` stamps
        `blobs_completed_at` non-NULL."""
        import app.services.eval_apply as eval_apply_module
        from app.models.game import Game
        from app.models.game_flaw import GameFlaw

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,
        )

        gp_rows = [
            {"ply": 0, "full_hash": 0xB0C0_0100, "eval_cp": 20, "eval_mate": None},
            {"ply": 1, "full_hash": 0xB0C0_0101, "eval_cp": 30, "eval_mate": None},
            {"ply": 2, "full_hash": 0xB0C0_0102, "eval_cp": -500, "eval_mate": None},
            {"ply": 3, "full_hash": 0xB0C0_0103, "eval_cp": -480, "eval_mate": None},
            {"ply": 4, "full_hash": 0xB0C0_0104, "eval_cp": 60, "eval_mate": None},
            {"ply": 5, "full_hash": 0xB0C0_0105, "eval_cp": 30, "eval_mate": None},
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )
        try:
            async with full_drain_session_maker() as session:
                await eval_apply_module._classify_and_fill_oracle(
                    session, game_id, engine_result_map={}
                )
                await session.commit()

            # Confirm the classify pass actually produced at least one flaw ply,
            # then write a non-NULL blob onto every one of them (simulating a
            # tier-4 submit that fills every remaining NULL-blob ply).
            async with full_drain_session_maker() as blob_session:
                flaw_plies = (
                    (
                        await blob_session.execute(
                            select(GameFlaw.ply).where(GameFlaw.game_id == game_id)
                        )
                    )
                    .scalars()
                    .all()
                )
                assert flaw_plies, "classify must produce at least one flaw ply for this test"
                await blob_session.execute(
                    sa.update(GameFlaw)
                    .where(GameFlaw.game_id == game_id)
                    .values(allowed_pv_lines=[], missed_pv_lines=[])
                )
                await eval_apply_module._refresh_blobs_completed(blob_session, game_id)
                await blob_session.commit()

            async with full_drain_session_maker() as verify:
                stamp = (
                    await verify.execute(select(Game.blobs_completed_at).where(Game.id == game_id))
                ).scalar_one()

            assert stamp is not None, (
                "blobs_completed_at must be stamped non-NULL once every flaw ply's blob is written"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── Phase 119 SEED-045: hole-aware completion gate + bounded re-pick ──────────

# Shared user ID for Phase 119 tests (distinct range to avoid FK conflicts).
_TEST_USER_ID_119: int = 99202


@pytest_asyncio.fixture(scope="session", autouse=False)
async def full_drain_test_user_119(
    full_drain_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID_119 exists in the test DB. Returns user_id."""
    from app.models.user import User

    async with full_drain_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID_119))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID_119,
                    email=f"full-drain-test-{_TEST_USER_ID_119}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID_119


class TestHoleAwareCompletionGate:
    """Phase 119 SEED-045: full_evals_completed_at is withheld while genuine
    non-terminal holes remain, up to MAX_EVAL_ATTEMPTS; the cap stamps anyway
    with one aggregated Sentry event.

    A "hole" = non-terminal ply with eval_cp IS NULL AND eval_mate IS NULL after
    the tick. Terminal plies and mate-scored plies are NOT holes.
    """

    async def test_no_holes_stamps_complete_first_tick(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A game where every non-terminal ply resolves with eval_cp OR eval_mate set
        → full_evals_completed_at IS stamped on the first tick; full_eval_attempts stays 0;
        no cap Sentry event.
        """
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,
        )

        capture_calls: list[Any] = []
        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_119
        )
        monkeypatch.setattr(
            drain_module.sentry_sdk,
            "capture_message",
            lambda *a, **kw: capture_calls.append(a),
        )

        # All engine calls succeed — no holes after the tick.
        mock_evaluate = AsyncMock(
            side_effect=[
                (99, None, "e2e4", "e2e4 e7e5", None, None, ""),  # ply 0
                (50, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0 eval
                (30, None, "g1f3", "g1f3", None, None, ""),  # terminal → row 1 eval
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF119_0001, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xF119_0002, "eval_cp": None, "eval_mate": None},
            ],
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report processed when no holes remain"

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                game_row = row.one_or_none()

            assert game_row is not None
            assert game_row[0] is not None, (
                "full_evals_completed_at must be stamped when no holes remain (first tick)"
            )
            assert game_row[1] == 0, (
                f"full_eval_attempts must stay 0 when game completes without holes, got {game_row[1]}"
            )
            # No cap Sentry event must have fired.
            cap_events = [a for a in capture_calls if "MAX_EVAL_ATTEMPTS" in str(a)]
            assert len(cap_events) == 0, (
                f"No cap Sentry event should fire when no holes remain, got {cap_events}"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_mate_scored_is_not_a_hole(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A non-terminal ply with eval_cp NULL but eval_mate SET is NOT a hole
        → game is stamped complete on the first tick.

        The _apply_full_eval_results function counts failed_ply_count only when
        BOTH eval_cp IS NULL AND eval_mate IS NULL for a non-terminal row. A mate
        score clears the hole condition.
        """
        from app.models.game import Game

        # _TWO_MOVE_PGN: plies 0 and 1 (non-terminal), terminal = ply 2.
        # Engine gives a mate score for ply 1's after-position (terminal). Row 1 gets
        # eval_mate set (not NULL) → not a hole.
        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_119
        )

        # Terminal call returns a mate score; row 1 gets eval_mate=1 (not a hole).
        mock_evaluate = AsyncMock(
            side_effect=[
                (99, None, "e2e4", "e2e4", None, None, ""),  # ply 0 best_move (eval unused)
                (50, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0 eval
                (
                    None,
                    1,
                    "g1f3",
                    "g1f3",
                    None,
                    None,
                    "",
                ),  # terminal → row 1 = mate score (NOT a hole)
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF119_0010, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xF119_0011, "eval_cp": None, "eval_mate": None},
            ],
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report processed (mate score is not a hole)"

            async with full_drain_session_maker() as verify:
                marker = await verify.scalar(
                    select(Game.full_evals_completed_at).where(Game.id == game_id)
                )
            assert marker is not None, (
                "full_evals_completed_at must be stamped when only mate-scored plies exist "
                "(eval_mate set → not a hole)"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_transient_hole_withholds_stamp_increments_attempts(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Tick 1 leaves a non-terminal hole → game NOT stamped, full_eval_attempts becomes 1.
        Tick 2 the hole fills → stamped complete (full_eval_attempts still 1).

        Uses _TWO_MOVE_PGN: plies 0, 1, terminal.
        Post-move: row 1 = terminal engine result.
        Tick 1: terminal returns None → row 1 stays NULL (hole) → NOT stamped, attempts → 1.
        Tick 2: terminal returns a real eval → row 1 filled → stamped.
        """
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,
        )

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF119_0020, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xF119_0021, "eval_cp": None, "eval_mate": None},
            ],
        )

        # ── Tick 1: terminal fails → row 1 becomes a hole ──
        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_119
        )
        mock_tick1 = AsyncMock(
            side_effect=[
                (99, None, "e2e4", "e2e4", None, None, ""),  # ply 0 (best_move; eval unused)
                (50, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0 eval
                (None, None, None, None, None, None, None),  # terminal → row 1 hole
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_tick1)

        try:
            processed1 = await drain_module._full_drain_tick()
            assert processed1 is False, "Tick 1 must NOT report processed (hole present, under cap)"

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g1 = row.one_or_none()
            assert g1 is not None
            assert g1[0] is None, "full_evals_completed_at must stay NULL after tick 1 hole"
            assert g1[1] == 1, f"full_eval_attempts must be 1 after tick 1 hole, got {g1[1]}"

            # ── Tick 2: terminal succeeds → hole fills → stamp ──
            mock_tick2 = AsyncMock(
                side_effect=[
                    (99, None, "e2e4", "e2e4", None, None, ""),
                    (50, None, "e7e5", "e7e5", None, None, ""),
                    (30, None, "g1f3", "g1f3", None, None, ""),  # terminal now succeeds
                ]
            )
            monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_tick2)

            processed2 = await drain_module._full_drain_tick()
            assert processed2 is True, "Tick 2 must report processed (hole filled)"

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g2 = row.one_or_none()
            assert g2 is not None
            assert g2[0] is not None, "full_evals_completed_at must be stamped after tick 2 fills"
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_cap_reached_stamps_and_logs(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After full_eval_attempts reaches MAX_EVAL_ATTEMPTS with a persistent hole,
        the game IS stamped complete and the cap outcome is LOGGED locally — NOT sent to
        Sentry. The cap path is the expected terminal state of the bounded-retry drain
        (D-116-07), so capturing it per game burned the error quota (was FLAWCHESS-5V);
        it was demoted to logger.warning. Sentry must NOT be touched on this path.

        Seed game with full_eval_attempts = MAX_EVAL_ATTEMPTS - 1 so the NEXT tick
        is the cap tick (attempts + 1 >= MAX_EVAL_ATTEMPTS).
        """
        from app.models.game import Game
        from app.services.eval_drain import MAX_EVAL_ATTEMPTS

        now = datetime.now(timezone.utc)
        # Pre-seed with attempts = MAX_EVAL_ATTEMPTS - 1 so ONE more tick caps it.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=MAX_EVAL_ATTEMPTS - 1,
        )

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF119_0030, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xF119_0031, "eval_cp": None, "eval_mate": None},
            ],
        )

        capture_message_calls: list[str] = []
        # (msg_template, positional_args) tuples for each logger.warning call.
        warning_logs: list[tuple[str, tuple[object, ...]]] = []

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_119
        )
        # Guard: the cap path must not emit ANY Sentry event.
        monkeypatch.setattr(
            drain_module.sentry_sdk,
            "capture_message",
            lambda msg, **kw: capture_message_calls.append(msg),
        )
        # Patch the module logger directly rather than relying on caplog propagation,
        # which is fragile under CI's logging config (a real record never reached caplog).
        monkeypatch.setattr(
            drain_module.logger,
            "warning",
            lambda msg, *args, **kw: warning_logs.append((msg, args)),
        )

        # Hole persists: terminal still returns None.
        mock_evaluate = AsyncMock(
            side_effect=[
                (99, None, "e2e4", "e2e4", None, None, ""),
                (50, None, "e7e5", "e7e5", None, None, ""),
                (None, None, None, None, None, None, None),  # hole persists
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Cap tick must report processed (stamp happens at cap)"

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g = row.one_or_none()

            assert g is not None
            assert g[0] is not None, (
                "full_evals_completed_at must be stamped at cap even with residual holes"
            )

            # No Sentry event for the cap path (quota fix — FLAWCHESS-5V).
            cap_events = [m for m in capture_message_calls if "MAX_EVAL_ATTEMPTS" in m]
            assert cap_events == [], (
                f"Cap path must NOT capture to Sentry (demoted to log), got {cap_events}"
            )

            # Exactly one WARNING log line for the cap path, carrying game_id as an arg
            # (variables passed as logger args, never interpolated into the template).
            cap_logs = [(msg, args) for msg, args in warning_logs if "MAX_EVAL_ATTEMPTS" in msg]
            assert len(cap_logs) == 1, (
                f"Expected one cap warning log, got {len(cap_logs)}: {cap_logs}"
            )
            assert game_id in cap_logs[0][1], (
                f"Cap log must carry game_id={game_id} as an arg, got {cap_logs[0]!r}"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_all_fail_does_not_increment_attempts(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """WR-05 all-fail circuit breaker stays on the existing path and does NOT
        increment full_eval_attempts — pool outages must not exhaust the hole budget.

        When ALL engine calls fail (simulated dead pool), the existing circuit breaker
        returns False without ever opening the write session. full_eval_attempts stays 0.
        """
        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_SIMPLE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_119
        )
        # Dead pool — every call returns all-None.
        mock_evaluate = AsyncMock(return_value=(None, None, None, None, None, None, None))
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [{"ply": 0, "full_hash": 0xF119_0040, "eval_cp": None, "eval_mate": None}],
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is False, "All-fail circuit breaker must return False (WR-05)"

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g = row.one_or_none()

            assert g is not None
            assert g[0] is None, "full_evals_completed_at must stay NULL (all-fail circuit breaker)"
            assert g[1] == 0, f"full_eval_attempts must NOT be incremented by all-fail, got {g[1]}"
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── Phase 119 SEED-045: resweep_holed_games ──────────────────────────────────


class TestResweepHoledGames:
    """Phase 119 SEED-045: resweep_holed_games clears completion markers on already-stamped
    engine games that carry non-terminal holes, leaving terminal-only games untouched.

    Test fixture setup: games stamped with full_evals_completed_at; game_positions rows
    with NULL evals placed at non-terminal (should sweep) or terminal-only (should not sweep)
    plies.
    """

    async def test_sweeps_non_terminal_hole_only(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """resweep_holed_games() clears full_evals_completed_at on the game with a
        genuine mid-game hole, leaves game-ending-ply and terminal-only games untouched.

        SEED-049 update: the hole definition is now ply < max_ply - 1 (not ply < max_ply).
        A NULL at ply = max_ply - 1 (the game-ending move ply) is no longer a hole.

        Game A: 4 rows (plies 0..3). Genuine mid-game hole at ply 1 (< max_ply - 1 = 2).
            → IS swept (real hole).
        Game B: 3 rows (plies 0..2). Only ply 1 = max_ply - 1 = 1 and ply 2 = max_ply
            are NULL. Under SEED-049 ply 1 is the game-ending-move ply → NOT a hole.
            → NOT swept.
        Expected: count=1 (only game A swept); game B's marker untouched.
        """
        from app.models.game import Game
        import app.services.eval_drain as drain_module

        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)

        now = datetime.now(timezone.utc)

        # Game A: genuine mid-game hole at ply 1. max_ply = 3, so max_ply - 1 = 2.
        # ply 1 < max_ply - 1 = 2 → TRUE → it IS a hole → swept.
        game_a_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_SIMPLE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,  # already stamped
            full_pv_completed_at=now,
            full_eval_attempts=2,
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_a_id,
            [
                {"ply": 0, "full_hash": 0xF119_A001, "eval_cp": 50, "eval_mate": None},
                # ply 1 is a genuine mid-game hole (1 < max_ply - 1 = 2 → TRUE)
                {"ply": 1, "full_hash": 0xF119_A002, "eval_cp": None, "eval_mate": None},
                {"ply": 2, "full_hash": 0xF119_A003, "eval_cp": 30, "eval_mate": None},
                # ply 3 = max_ply (terminal game-over ply); NULL → excluded
                {"ply": 3, "full_hash": 0xF119_A004, "eval_cp": None, "eval_mate": None},
            ],
        )

        # Game B: only the game-ending-move ply (ply 1 = max_ply - 1 = 1) is NULL.
        # SEED-049: ply = max_ply - 1 is the game-ending move → NOT a hole → NOT swept.
        game_b_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,  # already stamped
            full_pv_completed_at=now,
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_b_id,
            [
                {"ply": 0, "full_hash": 0xF119_B001, "eval_cp": 50, "eval_mate": None},
                # ply 1 = max_ply - 1 = 1: game-ending-move ply NULL (SEED-049 false hole)
                {"ply": 1, "full_hash": 0xF119_B002, "eval_cp": None, "eval_mate": None},
                # ply 2 = max_ply (terminal); NULL → excluded by ply < max_ply - 1
                {"ply": 2, "full_hash": 0xF119_B003, "eval_cp": None, "eval_mate": None},
            ],
        )

        try:
            from app.services.eval_drain import resweep_holed_games

            count = await resweep_holed_games()
            assert count == 1, (
                f"resweep_holed_games must return 1 (only game A has a genuine mid-game hole), "
                f"got {count}"
            )

            async with full_drain_session_maker() as verify:
                row_a = await verify.execute(
                    select(
                        Game.full_evals_completed_at,
                        Game.full_pv_completed_at,
                        Game.full_eval_attempts,
                    ).where(Game.id == game_a_id)
                )
                a = row_a.one_or_none()

                row_b = await verify.execute(
                    select(Game.full_evals_completed_at).where(Game.id == game_b_id)
                )
                b = row_b.scalar_one_or_none()

            assert a is not None
            assert a[0] is None, "Game A: full_evals_completed_at must be cleared by sweep"
            assert a[1] is None, "Game A: full_pv_completed_at must be cleared by sweep"
            assert a[2] == 0, f"Game A: full_eval_attempts must be reset to 0, got {a[2]}"

            assert b is not None, (
                "Game B: full_evals_completed_at must stay set — SEED-049 excludes the "
                "game-ending-move ply (max_ply - 1) from the hole definition"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_a_id, game_b_id])

    async def test_dry_run_counts_but_does_not_update(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """dry_run=True returns the candidate count without updating full_evals_completed_at."""
        from app.models.game import Game
        import app.services.eval_drain as drain_module

        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)

        now = datetime.now(timezone.utc)
        # Use a 4-row game so the hole at ply 1 is a genuine mid-game hole
        # (1 < max_ply - 1 = 3 - 1 = 2 → TRUE). SEED-049 requires ply < max_ply - 1.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_SIMPLE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,  # stamped
            full_pv_completed_at=now,
            full_eval_attempts=1,
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF119_C001, "eval_cp": 50, "eval_mate": None},
                # ply 1 is a genuine mid-game hole (1 < max_ply - 1 = 2 → TRUE)
                {"ply": 1, "full_hash": 0xF119_C002, "eval_cp": None, "eval_mate": None},
                {"ply": 2, "full_hash": 0xF119_C003, "eval_cp": 30, "eval_mate": None},
                # ply 3 = max_ply (terminal); NULL → excluded by ply < max_ply - 1
                {"ply": 3, "full_hash": 0xF119_C004, "eval_cp": None, "eval_mate": None},
            ],
        )

        try:
            from app.services.eval_drain import resweep_holed_games

            count = await resweep_holed_games(dry_run=True)
            assert count >= 1, f"dry_run must return count >= 1 (at least game {game_id})"

            # Verify nothing changed.
            async with full_drain_session_maker() as verify:
                marker = await verify.scalar(
                    select(Game.full_evals_completed_at).where(Game.id == game_id)
                )
            assert marker is not None, (
                "dry_run=True must NOT clear full_evals_completed_at — count only"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_swept_game_has_attempts_reset(
        self,
        full_drain_test_user_119: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A swept game has full_eval_attempts reset to 0 and full_evals_completed_at NULL."""
        from app.models.game import Game
        import app.services.eval_drain as drain_module

        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)

        now = datetime.now(timezone.utc)
        # Use a 4-row game so the hole at ply 1 is a genuine mid-game hole
        # (1 < max_ply - 1 = 3 - 1 = 2 → TRUE). SEED-049 requires ply < max_ply - 1.
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_119,
            pgn=_SIMPLE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,
            full_pv_completed_at=now,
            full_eval_attempts=3,  # pre-existing attempts (would have hit cap)
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_119,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF119_D001, "eval_cp": 50, "eval_mate": None},
                # ply 1 is a genuine mid-game hole (1 < max_ply - 1 = 2 → TRUE)
                {"ply": 1, "full_hash": 0xF119_D002, "eval_cp": None, "eval_mate": None},
                {"ply": 2, "full_hash": 0xF119_D003, "eval_cp": 30, "eval_mate": None},
                # ply 3 = max_ply (terminal); NULL → excluded by ply < max_ply - 1
                {"ply": 3, "full_hash": 0xF119_D004, "eval_cp": None, "eval_mate": None},
            ],
        )

        try:
            from app.services.eval_drain import resweep_holed_games

            count = await resweep_holed_games()
            assert count >= 1, f"At least game {game_id} must be swept"

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(
                        Game.full_evals_completed_at,
                        Game.full_pv_completed_at,
                        Game.full_eval_attempts,
                    ).where(Game.id == game_id)
                )
                g = row.one_or_none()

            assert g is not None
            assert g[0] is None, "Swept game: full_evals_completed_at must be NULL"
            assert g[1] is None, "Swept game: full_pv_completed_at must be NULL"
            assert g[2] == 0, f"Swept game: full_eval_attempts must be reset to 0, got {g[2]}"
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── SEED-139 item 5: run_periodic_holed_game_resweep ────────────────────────


class TestRunPeriodicHoledGameResweep:
    """Unit tests for run_periodic_holed_game_resweep (mocked -- no real DB).

    Mirrors tests/test_guest_cleanup_service.py::TestRunPeriodicGuestCleanup:
    monkeypatch asyncio.sleep to drive a bounded number of loop iterations
    (raising CancelledError to stop the infinite loop), and monkeypatch
    resweep_holed_games to a spy/failing stub.
    """

    @pytest.mark.asyncio
    async def test_calls_resweep_once_per_tick_never_dry_run(self, monkeypatch: Any) -> None:
        """Every tick calls resweep_holed_games(limit=_RESWEEP_TICK_LIMIT, dry_run=False)
        -- the loop must NEVER run a dry sweep."""
        import app.services.eval_drain as drain_module
        from app.services.eval_drain import (
            _RESWEEP_TICK_LIMIT,
            run_periodic_holed_game_resweep,
        )

        sleep_count = 0

        async def _mock_sleep(_seconds: float) -> None:
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count >= 3:
                raise asyncio.CancelledError()

        calls: list[dict[str, object]] = []

        async def _mock_resweep(*, limit: int | None = None, dry_run: bool = False) -> int:
            calls.append({"limit": limit, "dry_run": dry_run})
            return 0

        monkeypatch.setattr(drain_module.asyncio, "sleep", _mock_sleep)
        monkeypatch.setattr(drain_module, "resweep_holed_games", _mock_resweep)

        with pytest.raises(asyncio.CancelledError):
            await run_periodic_holed_game_resweep()

        assert len(calls) >= 2, "resweep_holed_games must be called once per tick"
        for call in calls:
            assert call["limit"] == _RESWEEP_TICK_LIMIT, (
                f"every tick must pass the bounded per-tick limit, got {call}"
            )
            assert call["dry_run"] is False, f"the loop must NEVER run a dry sweep, got {call}"

    @pytest.mark.asyncio
    async def test_survives_resweep_exception(self, monkeypatch: Any) -> None:
        """A raise from resweep_holed_games is logged, Sentry-captured, and swallowed --
        the loop continues to the next tick."""
        import app.services.eval_drain as drain_module
        from app.services.eval_drain import run_periodic_holed_game_resweep

        sleep_count = 0

        async def _mock_sleep(_seconds: float) -> None:
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count >= 3:
                raise asyncio.CancelledError()

        call_count = 0

        async def _mock_resweep(*, limit: int | None = None, dry_run: bool = False) -> int:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("simulated resweep failure")
            return 0

        monkeypatch.setattr(drain_module.asyncio, "sleep", _mock_sleep)
        monkeypatch.setattr(drain_module, "resweep_holed_games", _mock_resweep)

        with (
            patch("app.services.eval_drain.sentry_sdk.capture_exception") as mock_capture,
            pytest.raises(asyncio.CancelledError),
        ):
            await run_periodic_holed_game_resweep()

        assert call_count >= 2, (
            f"loop must continue after a resweep exception, called {call_count} time(s)"
        )
        assert mock_capture.call_count >= 1, (
            "sentry_sdk.capture_exception must be called when resweep_holed_games raises"
        )


# ─── SEED-049: game-ending ply is not a hole ──────────────────────────────────

# Separate user ID range for SEED-049 tests to avoid FK conflicts.
_TEST_USER_ID_049: int = 99203


@pytest_asyncio.fixture(scope="session", autouse=False)
async def full_drain_test_user_049(
    full_drain_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID_049 exists in the test DB. Returns user_id."""
    from app.models.user import User

    async with full_drain_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID_049))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID_049,
                    email=f"full-drain-test-{_TEST_USER_ID_049}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID_049


class TestSeed049GameEndingPly:
    """SEED-049: the game-ending ply is not an eval hole.

    Under post-move storage, the row for the game-ending move stores the eval of the
    terminal (game-over) position. That terminal is deliberately unevaluable: the engine
    skip in _collect_full_ply_targets already omits the terminal donor when the final
    board is_game_over(). The false hole this created in failed_ply_count (live drain)
    and in the resweep predicate is corrected by SEED-049.
    """

    async def test_checkmate_game_stamps_complete_first_tick(
        self,
        full_drain_test_user_049: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A checkmate-ending engine game stamps full_evals_completed_at on attempt 1
        with failed_ply_count == 0, even though the game-ending move's row receives a
        NULL post-move eval (the terminal checkmate position has no engine eval).

        Scholar's mate: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? 4. Qxf7# 1-0"
        7 half-moves (plies 0..6). Under post-move storage:
          - Plies 0..5: each row stores the eval of the NEXT position (the one AFTER
            the move). The engine is called for plies 0..5 and for the terminal (ply 7).
            But the final board IS checkmate (is_game_over()), so _collect_full_ply_targets
            skips the terminal donor call. Therefore pos_eval[7] is never set.
          - Ply 6 (4.Qxf7# — the game-ending move): _post_move_eval(pos_eval, 6) = (None,
            None) because pos_eval[7] is absent. SEED-049 fix: this NULL is NOT a hole —
            ends_game=True on that target excludes it from failed_ply_count.

        Expected: full_evals_completed_at IS NOT NULL, full_eval_attempts == 0,
        no cap-path Sentry capture_message, and ply 6's eval stays NULL (legitimate).
        """
        from app.models.game import Game
        from app.models.game_position import GamePosition

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_049,
            pgn=_CHECKMATE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,
        )

        capture_calls: list[Any] = []
        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_049
        )
        monkeypatch.setattr(
            drain_module.sentry_sdk,
            "capture_message",
            lambda *a, **kw: capture_calls.append(a),
        )

        # Scholar's mate has 7 half-moves (plies 0..6). Under include_terminal=True,
        # the terminal board (after Qxf7#) IS game-over, so _collect_full_ply_targets
        # skips the terminal donor. The engine is called for plies 0..6 only (7 calls).
        # Post-move: row k = pos_eval[k+1]. Row 6's donor (pos_eval[7]) is absent,
        # so _post_move_eval returns (None, None) for ply 6 — the game-ending move.
        # SEED-049: this must NOT count as a hole (ends_game=True on ply 6 target).
        mock_evaluate = AsyncMock(
            side_effect=[
                (
                    20,
                    None,
                    "e2e4",
                    "e2e4",
                    None,
                    None,
                    "",
                ),  # ply 0 — best_move; eval becomes row 0 = pos_eval[1]
                (15, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0's post-move eval
                (25, None, "d1h5", "d1h5", None, None, ""),  # ply 2 → row 1's post-move eval
                (10, None, "b8c6", "b8c6", None, None, ""),  # ply 3 → row 2's post-move eval
                (30, None, "f1c4", "f1c4", None, None, ""),  # ply 4 → row 3's post-move eval
                (5, None, "g8f6", "g8f6", None, None, ""),  # ply 5 → row 4's post-move eval
                (
                    80,
                    None,
                    "d1f7",
                    "d1f7",
                    None,
                    None,
                    "",
                ),  # ply 6 (Qxf7# move) — best_move; eval for row 5
                # No terminal call: is_game_over() board skipped in _collect_full_ply_targets
                # → pos_eval[7] absent → row 6's post-move eval = (None, None) by design
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        # Insert game_position rows for all 7 plies (0..6).
        gp_rows = [
            {"ply": i, "full_hash": 0xF049_0100 + i, "eval_cp": None, "eval_mate": None}
            for i in range(7)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_049, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, (
                "Checkmate-ending game must report processed on first tick (SEED-049: "
                "game-ending ply is not a hole → failed_ply_count == 0)"
            )

            async with full_drain_session_maker() as verify:
                game_row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g = game_row.one_or_none()

                # Check that ply 6's eval is still NULL (the legitimate game-ending NULL).
                ply6 = await verify.execute(
                    select(GamePosition.eval_cp, GamePosition.eval_mate).where(
                        GamePosition.game_id == game_id, GamePosition.ply == 6
                    )
                )
                ply6_row = ply6.one_or_none()

            assert g is not None
            assert g[0] is not None, (
                "full_evals_completed_at must be stamped on first tick for a checkmate game "
                "— SEED-049: game-ending ply excluded from failed_ply_count"
            )
            assert g[1] == 0, f"full_eval_attempts must stay 0 (no retries needed), got {g[1]}"

            # The game-ending move's row must still have NULL eval (it's legitimately empty).
            assert ply6_row is not None, "ply 6 game_positions row must exist"
            assert ply6_row[0] is None and ply6_row[1] is None, (
                "Ply 6 (game-ending move) must retain NULL eval — its after-position is "
                "the terminal checkmate, which is correctly unevaluable (SEED-049)"
            )

            # No cap-path Sentry event: the game must never enter the hole-retry path.
            cap_events = [a for a in capture_calls if "MAX_EVAL_ATTEMPTS" in str(a)]
            assert len(cap_events) == 0, (
                f"No cap Sentry event must fire for a checkmate game (SEED-049), "
                f"got {len(cap_events)}: {cap_events}"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_midgame_null_still_retries(
        self,
        full_drain_test_user_049: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A genuine mid-game NULL post-move eval at a non-game-ending ply is still a
        hole and still goes to Path B (marker NOT stamped, full_eval_attempts incremented).

        Uses _TWO_MOVE_PGN = "1. e4 e5 *" — the game ends by agreement (neither side's
        final position is is_game_over()), so _collect_full_ply_targets DOES append the
        terminal donor. Row 1's post-move eval = pos_eval[2] = terminal engine result.
        When the terminal engine call returns (None, None), row 1 has a NULL post-move
        eval at a non-game-ending ply (ply 1 < max_ply - 1 is FALSE here: ply 1 = max_ply
        - 1 = 2 - 1 = 1, but _TWO_MOVE_PGN's board is NOT game-over → ends_game=False
        on ply 1 → the NULL IS counted as a genuine hole).

        SEED-049 note: the "*" result means the final board is NOT checkmate/stalemate,
        so ends_game remains False on the last real row. The hole at ply 1 is real.
        """
        from app.models.game import Game
        from app.services.eval_drain import MAX_EVAL_ATTEMPTS

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_049,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
            full_eval_attempts=0,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_049
        )

        # Engine succeeds for plies 0 and 1, but the terminal call fails.
        # Post-move: row 1 = pos_eval[2] = terminal result (None) → genuine hole.
        mock_evaluate = AsyncMock(
            side_effect=[
                (
                    99,
                    None,
                    "e2e4",
                    "e2e4",
                    None,
                    None,
                    "",
                ),  # ply 0 (best_move; eval unused for row 0 here)
                (50, None, "e7e5", "e7e5", None, None, ""),  # ply 1 → row 0 post-move eval
                (
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                ),  # terminal → row 1 hole (non-game-ending board)
            ]
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_049,
            game_id,
            [
                {"ply": 0, "full_hash": 0xF049_0200, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xF049_0201, "eval_cp": None, "eval_mate": None},
            ],
        )
        try:
            assert MAX_EVAL_ATTEMPTS > 1, "test requires MAX_EVAL_ATTEMPTS > 1"
            processed = await drain_module._full_drain_tick()
            assert processed is False, (
                "Mid-game NULL at a non-game-ending ply must NOT report processed "
                "— hole-aware retry path must still fire (SEED-049 Path B unchanged)"
            )

            async with full_drain_session_maker() as verify:
                row = await verify.execute(
                    select(Game.full_evals_completed_at, Game.full_eval_attempts).where(
                        Game.id == game_id
                    )
                )
                g = row.one_or_none()

            assert g is not None
            assert g[0] is None, (
                "full_evals_completed_at must stay NULL when a genuine hole remains (SEED-049)"
            )
            assert g[1] == 1, (
                f"full_eval_attempts must be incremented to 1 for a genuine hole, got {g[1]}"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_resweep_skips_game_ending_ply(
        self,
        full_drain_test_user_049: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """resweep_holed_games does NOT re-arm a game whose ONLY NULL hole is at the
        game-ending move ply (ply = max_ply - 1), but DOES re-arm a game with a
        genuine mid-game hole (ply < max_ply - 1).

        Game E (game-ending-only hole): 3 rows (plies 0, 1, 2). Row at ply 1 = NULL
        (= max_ply - 1 = 2 - 1 = 1). Only the game-ending-move ply is NULL.
        SEED-049 fix: ply < max_ply - 1 excludes ply 1 → not a hole → NOT swept.

        Game F (genuine mid-game hole): 3 rows (plies 0, 1, 2). Row at ply 0 = NULL
        (= 0 < max_ply - 1 = 1). This is a real hole → IS swept.
        """
        from app.models.game import Game
        import app.services.eval_drain as drain_module

        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)

        now = datetime.now(timezone.utc)

        # Game E: only hole is at ply 1 = max_ply(2) - 1 = game-ending-move ply.
        # SEED-049: ply < max_ply - 1 is FALSE for ply 1 (1 < 1 is False) → not swept.
        game_e_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_049,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,  # already stamped (would be re-armed without fix)
            full_pv_completed_at=now,
            full_eval_attempts=2,
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_049,
            game_e_id,
            [
                {"ply": 0, "full_hash": 0xF049_E001, "eval_cp": 50, "eval_mate": None},
                # ply 1 = max_ply - 1: game-ending-move ply NULL (SEED-049 false hole)
                {"ply": 1, "full_hash": 0xF049_E002, "eval_cp": None, "eval_mate": None},
                # ply 2 = max_ply: the existing terminal exclusion (ply < max_ply)
                {"ply": 2, "full_hash": 0xF049_E003, "eval_cp": None, "eval_mate": None},
            ],
        )

        # Game F: genuine mid-game hole at ply 0 (< max_ply - 1 = 1) → IS swept.
        game_f_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_049,
            pgn=_TWO_MOVE_PGN,
            evals_completed_at=now,
            full_evals_completed_at=now,  # stamped, should be re-armed
            full_pv_completed_at=now,
            full_eval_attempts=2,
        )
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_049,
            game_f_id,
            [
                # ply 0 = genuine mid-game hole (0 < max_ply - 1 = 1) → IS a hole
                {"ply": 0, "full_hash": 0xF049_F001, "eval_cp": None, "eval_mate": None},
                {"ply": 1, "full_hash": 0xF049_F002, "eval_cp": 30, "eval_mate": None},
                {"ply": 2, "full_hash": 0xF049_F003, "eval_cp": None, "eval_mate": None},
            ],
        )

        try:
            from app.services.eval_drain import resweep_holed_games

            # Use dry_run=False but limit to ensure we only get our own test games.
            # We verify by checking each game's marker directly.
            await resweep_holed_games()

            async with full_drain_session_maker() as verify:
                row_e = await verify.execute(
                    select(Game.full_evals_completed_at).where(Game.id == game_e_id)
                )
                marker_e = row_e.scalar_one_or_none()

                row_f = await verify.execute(
                    select(Game.full_evals_completed_at).where(Game.id == game_f_id)
                )
                marker_f = row_f.scalar_one_or_none()

            # Game E (game-ending-only hole): must NOT be swept by SEED-049 fix.
            assert marker_e is not None, (
                "Game E (game-ending-move-only hole at ply = max_ply - 1) must NOT be "
                "re-armed — SEED-049: ply < max_ply - 1 excludes the game-ending move ply"
            )

            # Game F (genuine mid-game hole): must be swept.
            assert marker_f is None, (
                "Game F (genuine mid-game hole at ply 0 < max_ply - 1) must be re-armed "
                "by resweep_holed_games — SEED-049 must not break real hole detection"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_e_id, game_f_id])


# ─── 260616-jq1: batched write regression (multi-flaw, multi-eval) ────────────

# Shared user ID for the batched-write regression tests.
_TEST_USER_ID_JQ1: int = 99210


@pytest_asyncio.fixture(scope="session", autouse=False)
async def full_drain_test_user_jq1(
    full_drain_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID_JQ1 exists in the test DB. Returns user_id."""
    from app.models.user import User

    async with full_drain_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID_JQ1))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID_JQ1,
                    email=f"full-drain-test-{_TEST_USER_ID_JQ1}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID_JQ1


def _two_blunder_eval_sequence() -> list[tuple[int, None, str, str, None, None, str]]:
    """Engine eval sequence that produces TWO blunders for _SIX_PLY_PGN.

    Stored (post-move) eval-by-ply after the tick (row k = engine_call[k+1]):
      row 0: 20  row 1: 30  row 2: -500  row 3: 100  row 4: 60  row 5: 30

    ES analysis (LICHESS_K = 0.00368208):
      ply 2 (white): ES_white(30) ≈ 0.527, ES_white(-500) ≈ 0.163 → drop ≈ 0.364 >> BLUNDER_DROP
      ply 3 (black): ES_black(-500) ≈ 0.837, ES_black(100) ≈ 0.421 → drop ≈ 0.416 >> BLUNDER_DROP

    PV must be written at ply 3 (refutation after white blunder at ply 2)
    and ply 4 (refutation after black blunder at ply 3).

    Phase 142: expanded to 7-tuple; second_uci="" is the no-second-move sentinel.
    """
    return [
        # engine_call[0] (ply 0) — best_move only; eval never stored (no pre-ply-0 row)
        (20, None, "e2e4", "e2e4 e7e5", None, None, ""),
        # engine_call[1] (ply 1) → row 0 stored eval = 20
        (20, None, "e7e5", "e7e5 g1f3", None, None, ""),
        # engine_call[2] (ply 2) → row 1 stored eval = 30
        (30, None, "g1f3", "g1f3 b8c6", None, None, ""),
        # engine_call[3] (ply 3) → row 2 stored eval = -500 (WHITE BLUNDER; PV at ply 3)
        (-500, None, "g8f6", "g8f6 d2d4 d7d5", None, None, ""),
        # engine_call[4] (ply 4) → row 3 stored eval = 100 (BLACK BLUNDER; PV at ply 4)
        (100, None, "f1c4", "f1c4 f8c5 d2d4", None, None, ""),
        # engine_call[5] (ply 5) → row 4 stored eval = 60
        (60, None, "f8c5", "f8c5 d2d4", None, None, ""),
        # engine_call[6] (terminal) → row 5 stored eval = 30
        (30, None, "h2h3", "h2h3", None, None, ""),
    ]


class TestBatchedWriteRegression:
    """260616-jq1 regression: batched eval + flaw-PV writes with multiple rows.

    The single-flaw tests in TestFlawPv exercise the VALUES clause with one row;
    these tests exercise it with MULTIPLE rows to confirm the multi-row batch path.
    """

    async def test_two_flaw_pvs_written_at_correct_plies(
        self,
        full_drain_test_user_jq1: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After a drain tick on a game with TWO blunders (one white, one black),
        game_positions.pv is set at flaw plies 2, 3 AND 4 (SEED-054) and NULL elsewhere.

        This exercises the multi-row VALUES clause in the batched flaw-PV UPDATE
        (FLAWCHESS-6B) — the existing single-flaw test covers one VALUES row only.

        _SIX_PLY_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *" (plies 0..5).
        Two blunders from _two_blunder_eval_sequence:
          - White blunder at ply 2 → PV at ply 2 (decision, SEED-054) and ply 3 (refutation)
          - Black blunder at ply 3 → PV at ply 3 (decision, SEED-054) and ply 4 (refutation)
        Union of written plies = {2, 3, 4}; plies 0, 1, 5 stay NULL.
        """
        from app.models.game_position import GamePosition

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        drain_module = _patch_drain_for_tick_tests(
            monkeypatch, full_drain_session_maker, game_id, full_drain_test_user_jq1
        )

        eval_sequence = _two_blunder_eval_sequence()
        mock_evaluate = AsyncMock(side_effect=eval_sequence)
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        gp_rows = [
            {"ply": i, "full_hash": 0xBEEF_6B00 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_jq1, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Tick must report a processed game"

            async with full_drain_session_maker() as verify:
                rows = await verify.execute(
                    select(GamePosition.ply, GamePosition.pv, GamePosition.eval_cp)
                    .where(GamePosition.game_id == game_id)
                    .order_by(GamePosition.ply)
                )
                by_ply = {r[0]: (r[1], r[2]) for r in rows.all()}

            # Flaw plies 2, 3, 4 must carry a PV (batched VALUES with multiple rows).
            assert by_ply.get(2, (None, None))[0] is not None, (
                "ply 2 (decision board for white blunder at ply 2) must have pv set — "
                "SEED-054 ideal-continuation PV"
            )
            assert by_ply.get(3, (None, None))[0] is not None, (
                "ply 3 (N+1 for white blunder at ply 2; decision for black blunder at "
                "ply 3) must have pv set — multi-row batched PV VALUES (FLAWCHESS-6B)"
            )
            assert by_ply.get(4, (None, None))[0] is not None, (
                "ply 4 (N+1 for black blunder at ply 3) must have pv set — "
                "multi-row batched PV VALUES clause (FLAWCHESS-6B regression)"
            )
            # Non-flaw plies must NOT have a PV.
            for ply in [0, 1, 5]:
                assert by_ply.get(ply, (None, None))[0] is None, (
                    f"ply {ply} must have pv=NULL — pv only written at flaw plies "
                    "(ply N and ply N+1; D-117-02 / SEED-054)"
                )
            # Sanity: eval_cp rows populated by the batched eval write (Task 1 batch).
            # Row 2 = -500 (white blunder), row 3 = 100 (black blunder).
            assert by_ply.get(2, (None, None))[1] == -500, (
                f"ply 2 eval_cp must be -500 (white blunder), got {by_ply.get(2, (None, None))[1]}"
            )
            assert by_ply.get(3, (None, None))[1] == 100, (
                f"ply 3 eval_cp must be 100 (black blunder), got {by_ply.get(3, (None, None))[1]}"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_eval_row_does_not_clobber_existing_best_move(
        self,
        full_drain_test_user_jq1: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """COALESCE no-clobber guard (FLAWCHESS-6B).

        best_move is sourced from THIS ply's resolution while the row's eval is the
        POST-MOVE eval of ply+1 (a different resolution), so an eval-bearing row can
        legitimately carry best_move=None. On a re-submit / retry the row may already
        hold a best_move from a prior pass; the batched eval UPDATE must preserve it,
        exactly as the pre-batch per-row code did (it only wrote best_move when
        present). Without the COALESCE guard the batch would null it out.
        """
        from app.models.game_position import GamePosition
        from app.services import eval_drain

        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            pgn=_TWO_MOVE_PGN,
        )
        # Pre-seed ply 0 with an existing best_move (as if a prior eval pass wrote it).
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            game_id,
            [
                {
                    "ply": 0,
                    "full_hash": 0xC0FFEE00,
                    "eval_cp": None,
                    "eval_mate": None,
                    "best_move": "e2e4",
                }
            ],
        )

        # Target at ply 0 (non-terminal) + a terminal donor at ply 1. The donor's
        # eval becomes row 0's post-move eval (pos_eval[1]), making row 0 eval-bearing
        # while engine_result_map[0] supplies NO best_move for ply 0.
        board = chess.Board()
        targets = [
            eval_drain._FullPlyEvalTarget(
                game_id=game_id,
                ply=0,
                full_hash=0xC0FFEE00,
                board=board,
                eval_cp=None,
                eval_mate=None,
            ),
            eval_drain._FullPlyEvalTarget(
                game_id=game_id,
                ply=1,
                full_hash=0,
                board=board,
                eval_cp=None,
                eval_mate=None,
                is_terminal=True,
            ),
        ]
        engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
            0: (10, None, None, None),  # ply 0: no best_move
            1: (50, None, None, None),  # ply 1 donor → row 0 post-move eval = 50
        }
        try:
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session, targets, {}, engine_result_map, False
                )
                await session.commit()
            assert failed == 0, "row 0 has a resolved post-move eval — not a hole"

            async with full_drain_session_maker() as verify:
                row = (
                    await verify.execute(
                        select(GamePosition.eval_cp, GamePosition.best_move).where(
                            GamePosition.game_id == game_id, GamePosition.ply == 0
                        )
                    )
                ).one()
            assert row[0] == 50, f"ply 0 post-move eval_cp must be 50, got {row[0]}"
            assert row[1] == "e2e4", (
                "existing best_move must be preserved when the eval-bearing batched "
                "UPDATE carries best_move=None (COALESCE no-clobber, FLAWCHESS-6B)"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_lichess_preserve_existing_evals_skips_already_resolved_hole(
        self,
        full_drain_test_user_jq1: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """WR-01: preserve_existing_evals parity for the lichess-eval branch.

        A lichess-eval game always re-leases its FULL position set, so an
        already-resolved ply can be re-submitted and transiently re-fail
        (best_move None) on the SAME ply that already carries a good stored
        best_move. Under preserve_existing_evals=True that is NOT a fresh hole
        and must not be counted (mirrors _is_engine_hole's existing-eval guard),
        else a game with complete best-move coverage burns an unneeded Path-B
        retry. lichess rows always have a non-NULL %eval from import, so
        `stored_best_move` — not eval_cp/eval_mate — is the "already resolved"
        signal.

        Mutation guard: reverting the `elif _is_lichess_best_move_hole(...)`
        gate back to an unconditional `else: failed_ply_count += 1` makes the
        preserve+stored-best_move case return 1, failing this test.
        """
        from app.services import eval_drain

        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            pgn=_TWO_MOVE_PGN,
        )
        # Ply 0 already carries a stored best_move + a lichess %eval (as if a prior
        # submit resolved it). A later full re-lease's worker fails ply 0 this pass.
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            game_id,
            [
                {
                    "ply": 0,
                    "full_hash": 0xB0BB1E00,
                    "eval_cp": 20,  # lichess %eval, always present from import
                    "eval_mate": None,
                    "best_move": "e2e4",
                }
            ],
        )

        board = chess.Board()

        def _target(stored_best_move: str | None) -> eval_drain._FullPlyEvalTarget:
            return eval_drain._FullPlyEvalTarget(
                game_id=game_id,
                ply=0,
                full_hash=0xB0BB1E00,
                board=board,
                eval_cp=20,
                eval_mate=None,
                stored_best_move=stored_best_move,
            )

        # Worker returns NO best_move for ply 0 this pass (transient re-failure).
        engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
            0: (20, None, None, None),
        }

        try:
            # Case 1: preserve=True AND ply already has a stored best_move → NOT a hole.
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session,
                    [_target("e2e4")],
                    {},
                    engine_result_map,
                    True,  # is_lichess_eval_game
                    preserve_existing_evals=True,
                )
                await session.rollback()
            assert failed == 0, (
                "an already-resolved lichess ply that transiently re-fails under "
                "preserve_existing_evals must NOT be counted as a fresh hole (WR-01)"
            )

            # Case 2 (parity): preserve=True but NO prior best_move stored → genuine hole.
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session,
                    [_target(None)],
                    {},
                    engine_result_map,
                    True,
                    preserve_existing_evals=True,
                )
                await session.rollback()
            assert failed == 1, (
                "a lichess ply with no prior best_move is a genuine failure — still "
                "a hole even under preserve_existing_evals"
            )

            # Case 3 (parity): drain path (preserve=False) → genuine hole regardless.
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session,
                    [_target("e2e4")],
                    {},
                    engine_result_map,
                    True,
                    preserve_existing_evals=False,
                )
                await session.rollback()
            assert failed == 1, (
                "with preserve_existing_evals=False (the drain path) a NULL best_move "
                "is always a genuine hole"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])

    async def test_homogenized_preserve_existing_evals_does_not_trust_stale_import_eval(
        self,
        full_drain_test_user_jq1: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """tier3-branch-b-one-ply-stamp regression: a homogenized lichess-arm
        game's engine (is_lichess_eval_game=False) branch must not trust a
        pre-existing eval_cp as "already resolved by a prior engine round" when
        that eval_cp actually came from lichess IMPORT (BENCHMARK_HOMOGENIZE_EVAL_SOURCE
        forces is_lichess_eval_game=False for these games — D-03 — but never
        clears the imported %eval columns — D-04).

        Ply 0's row already carries eval_cp=999 (the import value, never
        engine-touched) and no best_move. The worker fails to resubmit this
        ply this round (engine_result_map has no entry covering it). Before
        the fix, `_is_engine_hole`'s `preserve_existing_evals` guard could not
        distinguish "already resolved by our own engine" from "still holds raw
        import data" — so this genuine failure was silently swallowed as
        already-resolved, and (via `apply_completion_decision`'s Path A)
        the game was stamped complete with a permanent best_move hole.

        Mutation guard: dropping `stored_eval_predates_engine` from
        `_is_engine_hole`'s guard condition (i.e. reverting to the pre-fix
        `preserve_existing_evals and (eval_cp is not None or eval_mate is not
        None)`) makes Case 2 return 0, failing this test.
        """
        from app.services import eval_drain

        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            pgn=_TWO_MOVE_PGN,
        )
        # Ply 0 already carries a stale, import-sourced %eval (999) and no best_move —
        # the exact shape a homogenized lichess-arm game has before our engine has
        # ever touched it.
        await _insert_game_positions(
            full_drain_session_maker,
            full_drain_test_user_jq1,
            game_id,
            [
                {
                    "ply": 0,
                    "full_hash": 0x51A1E000,
                    "eval_cp": 999,
                    "eval_mate": None,
                    "best_move": None,
                }
            ],
        )

        board = chess.Board()
        target = eval_drain._FullPlyEvalTarget(
            game_id=game_id,
            ply=0,
            full_hash=0x51A1E000,
            board=board,
            eval_cp=999,
            eval_mate=None,
        )
        # Terminal donor at ply 1 (Cases 1/2 only — see _post_move_eval's SEED-044
        # +1 shift): row 0's post-move eval is pos_eval[1]. Omitting a ply=1 target
        # entirely from `targets` also yields (None, None) via _post_move_eval's own
        # default, so Cases 1/2 pass `[target]` alone (no donor needed to prove a
        # hole); Case 3 needs a REAL ply=1 target so its engine_result_map[1] entry
        # actually gets resolved into pos_eval.
        terminal_donor = eval_drain._FullPlyEvalTarget(
            game_id=game_id,
            ply=1,
            full_hash=0,
            board=board,
            eval_cp=None,
            eval_mate=None,
            is_terminal=True,
        )
        # Worker submits nothing this round — a genuine per-ply failure. No
        # engine_result_map entry means pos_eval[1] (row 0's post-move eval)
        # never resolves.
        empty_engine_result_map: dict[
            int, tuple[int | None, int | None, str | None, str | None]
        ] = {}

        try:
            # Case 1 (parity, zero blast radius): a REAL engine game (never
            # lichess-sourced, stored_eval_predates_engine defaults False) keeps
            # today's SEED-076 behavior — the stale-but-genuinely-engine-written
            # eval_cp is trusted as already-resolved, NOT a fresh hole.
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session,
                    [target],
                    {},
                    empty_engine_result_map,
                    False,  # is_lichess_eval_game
                    preserve_existing_evals=True,
                )
                await session.rollback()
            assert failed == 0, (
                "a real engine game's pre-existing eval_cp must still be trusted as "
                "already-resolved under preserve_existing_evals (unchanged SEED-076 "
                "behavior — stored_eval_predates_engine defaults False)"
            )

            # Case 2 (the fix): stored_eval_predates_engine=True — the SAME stale
            # eval_cp must now count as a genuine hole, not an already-resolved ply.
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session,
                    [target],
                    {},
                    empty_engine_result_map,
                    False,  # is_lichess_eval_game
                    preserve_existing_evals=True,
                    stored_eval_predates_engine=True,
                )
                await session.rollback()
            assert failed == 1, (
                "a homogenized lichess-arm game's import-populated eval_cp must NOT "
                "be trusted as already-resolved-by-our-engine — a worker failure on "
                "this ply is a genuine hole"
            )

            # Case 3 (sanity): the SAME ply, but the worker DID resolve it this
            # round (engine_result_map now covers the post-move donor ply 1, which
            # needs a real ply=1 target present so _apply_full_eval_results
            # actually resolves it into pos_eval — see terminal_donor above) —
            # correctly resolved, regardless of stored_eval_predates_engine.
            async with full_drain_session_maker() as session:
                failed = await eval_drain._apply_full_eval_results(
                    session,
                    [target, terminal_donor],
                    {},
                    {1: (42, None, "e2e4", None)},
                    False,
                    preserve_existing_evals=True,
                    stored_eval_predates_engine=True,
                )
                await session.rollback()
            assert failed == 0, (
                "a ply the worker DID resolve this round is never a hole, "
                "independent of stored_eval_predates_engine"
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


# ─── Phase 142 MPV-02: blob population ────────────────────────────────────────

_TEST_USER_ID_142: int = 99211


@pytest_asyncio.fixture(scope="session", autouse=False)
async def full_drain_test_user_142(
    full_drain_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID_142 exists in the test DB. Returns user_id."""
    from app.models.user import User

    async with full_drain_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID_142))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID_142,
                    email=f"full-drain-test-{_TEST_USER_ID_142}@example.com",
                    hashed_password="fakehash",
                )
            )
            await session.commit()
    return _TEST_USER_ID_142


class TestMultipv2Blobs:
    """Phase 142 MPV-02: _full_drain_tick populates allowed_pv_lines / missed_pv_lines.

    T-142-02-03: drain integration test proving non-NULL multi-node blobs and the
    flaw/tactic count invariant (multipv2 pass does not add or remove flaws).
    """

    async def test_blobs_populated_after_drain_tick(
        self,
        full_drain_test_user_142: int,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """After one drain tick on _SIX_PLY_PGN with one blunder, the flaw row has
        non-NULL allowed_pv_lines and missed_pv_lines, each with at least one node.

        Uses _blunder_eval_sequence (7-tuple; one white blunder at ply 2) for the
        main gather; continuation calls in _build_flaw_multipv2_blobs fall back to
        (None,)*7 so node-0 blobs are still built from engine_result_map.
        """
        from app.models.game_flaw import GameFlaw

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_142,
            pgn=_SIX_PLY_PGN,
            evals_completed_at=now,
            full_evals_completed_at=None,
        )

        import app.services.eval_apply as eval_apply_module
        import app.services.eval_drain as drain_module

        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)
        # Phase 150 R7: _build_flaw_multipv2_blobs (exercised by this test, NOT mocked)
        # opens its own internal session in eval_apply.py now — redirect that too.
        monkeypatch.setattr(eval_apply_module, "async_session_maker", full_drain_session_maker)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_message", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_tag", lambda *a, **kw: None)
        monkeypatch.setattr(drain_module.sentry_sdk, "set_context", lambda *a, **kw: None)
        monkeypatch.setattr(
            drain_module,
            "_any_active_import_or_entry_ply_pending",
            AsyncMock(return_value=False),
        )
        from app.services.eval_queue_service import ClaimedJob

        monkeypatch.setattr(
            drain_module,
            "claim_eval_job",
            AsyncMock(
                return_value=ClaimedJob(
                    game_id=game_id,
                    user_id=full_drain_test_user_142,
                    tier=3,
                    is_lichess_eval_game=False,
                    job_id=None,
                )
            ),
        )
        # NOTE: _build_flaw_multipv2_blobs is NOT mocked here — this test exercises it.

        # Board-keyed eval so EVERY board (main-gather plies AND the hypothetical PV
        # continuation positions the Option-B walk visits) gets a LEGAL multi-move PV.
        # eval_by_ply reproduces the post-move stored sequence [20,30,-500,-480,60,30]
        # → one white blunder at ply 2 (same construction as _blunder_eval_sequence,
        # but board-keyed like the SEED-056 dedup test's _eval_for_board). A by-call-order
        # list would emit illegal PVs (e.g. a black move from a white-to-move board), so
        # _walk_pv_boards would stop at node 0 and no multi-node blob could form.
        eval_by_ply = {0: 20, 1: 20, 2: 30, 3: -500, 4: -480, 5: 60, 6: 30}

        def _legal_pv(board: chess.Board) -> str:
            moves: list[str] = []
            b = board.copy()
            for _ in range(3):
                legal = list(b.legal_moves)
                if not legal:
                    break
                mv = legal[0]
                moves.append(mv.uci())
                b.push(mv)
            return " ".join(moves)

        async def _multipv2_side_effect(
            board: chess.Board, *args: Any
        ) -> tuple[int, None, str, str, None, None, str]:
            ply = 2 * (board.fullmove_number - 1) + (0 if board.turn == chess.WHITE else 1)
            pv = _legal_pv(board)
            best = pv.split()[0] if pv else ""
            return (eval_by_ply.get(ply, 0), None, best, pv, None, None, "")

        monkeypatch.setattr(
            drain_module.engine_service,
            "evaluate_nodes_multipv2",
            AsyncMock(side_effect=_multipv2_side_effect),
        )

        gp_rows = [
            {"ply": i, "full_hash": 0x0142_B10B_0000 + i, "eval_cp": None, "eval_mate": None}
            for i in range(6)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_142, game_id, gp_rows
        )
        try:
            processed = await drain_module._full_drain_tick()
            assert processed is True, "Drain tick must report processed game"

            async with full_drain_session_maker() as verify:
                # allowed_pv_lines / missed_pv_lines are deferred=True — must project explicitly.
                flaw_rows = (
                    await verify.execute(
                        select(
                            GameFlaw.ply,
                            GameFlaw.allowed_pv_lines,
                            GameFlaw.missed_pv_lines,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).all()

            assert len(flaw_rows) == 1, (
                f"Exactly 1 flaw expected (one blunder at ply 2), got {len(flaw_rows)}"
            )
            flaw_ply, allowed, missed = flaw_rows[0]
            assert flaw_ply == 2, f"Flaw must be at ply 2 (white blunder), got ply {flaw_ply}"

            assert allowed is not None, (
                "allowed_pv_lines must be non-NULL after drain tick (MPV-02)"
            )
            assert missed is not None, "missed_pv_lines must be non-NULL after drain tick (MPV-02)"
            assert len(allowed) >= 1, (
                f"allowed_pv_lines must have at least 1 node (node 0), got {len(allowed)}"
            )
            assert len(missed) >= 1, (
                f"missed_pv_lines must have at least 1 node (node 0), got {len(missed)}"
            )
            # Multi-node requirement: the PV-walk (Option B) must produce >=2 nodes on at
            # least one line so the Phase 143 gate's >=2-solver-node path is reachable.
            assert max(len(allowed), len(missed)) >= 2, (
                "at least one blob must have >=2 nodes (PV continuation walked); "
                f"got allowed={len(allowed)}, missed={len(missed)}"
            )
            # Every node is a PvNode dict carrying the full b/bm/s/sm/su key set (the
            # JSONB-over-text future-proofing: su is stored even when unused by the gate).
            for node in (*allowed, *missed):
                assert set(node.keys()) == {"b", "bm", "s", "sm", "su"}, (
                    f"each PvNode must carry keys b/bm/s/sm/su, got {sorted(node.keys())}"
                )
                assert isinstance(node["su"], str), (
                    "PvNode.su must be a str sentinel (never None — Pitfall 3)"
                )
            # SEED-079: the local drain skips odd (defender) continuation engine calls.
            # The mock returns a real cp for EVERY evaluated board, so an all-None odd
            # node proves the defender board was never handed to the engine; even
            # (solver) nodes must carry real evals.
            _placeholder = {"b": None, "bm": None, "s": None, "sm": None, "su": ""}
            for blob in (allowed, missed):
                for i, node in enumerate(blob):
                    if i % 2 == 1:
                        assert node == _placeholder, (
                            f"Odd index {i} must be the all-None defender placeholder "
                            f"(SEED-079), got {node}"
                        )
                    else:
                        assert node["b"] is not None, (
                            f"Even (solver) index {i} must carry a real eval, got {node}"
                        )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])


class TestTier4bMinimalDrainLichessBestCp:
    """Quick 260719-fsz Task 2: the minimal tier-4b drain (_tier4b_minimal_drain_tick)
    must store our-Stockfish best_cp for a LICHESS-eval game, not the stored lichess
    %eval, so the query-time gem/great divergence guard (library_service.py) is
    meaningful. Engine games are unchanged (their stored eval already IS our Stockfish).

    Fixture game "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. h3 a6" — the Italian Game main
    line (plies 0-5) is fully booked (find_opening_ply_count == 6), so ply 6 (h2h3,
    white) is the out-of-book, played==stored-best gem candidate (same known-good
    setup as the 174-07 backfill test above). eval_of_position[6] comes from the
    ply-5 row (post-move shift), seeded as a distinct LICHESS value; the mocked fresh
    MultiPV-2 search returns a clearly different Stockfish best cp.
    """

    _PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. h3 a6 *"
    _CANDIDATE_PLY: int = 6
    _LICHESS_BEST_CP: int = 111  # stored on the ply-5 row -> eval_of_position[6]
    _FRESH_STOCKFISH_CP: int = 300  # returned by the mocked fresh search (res[0])
    _SECOND_CP: int = -100  # runner-up -> wide ES margin so ply 6 is a gem candidate

    @pytest.mark.parametrize(
        ("is_lichess", "expected_best_cp"),
        [
            (True, _FRESH_STOCKFISH_CP),  # lichess game: overridden to fresh Stockfish
            (False, _LICHESS_BEST_CP),  # engine game: stored eval kept unchanged
        ],
    )
    async def test_minimal_drain_best_cp_source(
        self,
        full_drain_session_maker: async_sessionmaker[AsyncSession],
        full_drain_test_user_117: int,
        monkeypatch: pytest.MonkeyPatch,
        is_lichess: bool,
        expected_best_cp: int,
    ) -> None:
        import app.services.eval_apply as eval_apply_module
        import app.services.eval_drain as drain_module
        from app.models.game_best_move import GameBestMove

        from app.models.game import Game

        now = datetime.now(timezone.utc)
        game_id = await _insert_game(
            full_drain_session_maker,
            full_drain_test_user_117,
            pgn=self._PGN,
            full_evals_completed_at=now,
            full_pv_completed_at=now,
            lichess_evals_at=now if is_lichess else None,
        )
        # Ratings are required to pin the Maia ELO — without them
        # _build_best_move_candidates skips the mover (no candidate row).
        async with full_drain_session_maker() as session:
            await session.execute(
                sa.update(Game.__table__)  # ty: ignore[invalid-argument-type]
                .where(Game.id == game_id)
                .values(white_rating=1500, black_rating=1500)
            )
            await session.commit()

        # Route drain + eval_apply sessions to the test DB, suppress Sentry, mock Maia.
        monkeypatch.setattr(drain_module, "async_session_maker", full_drain_session_maker)
        monkeypatch.setattr(eval_apply_module, "async_session_maker", full_drain_session_maker)
        monkeypatch.setattr(drain_module.sentry_sdk, "capture_exception", lambda *a, **kw: None)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        monkeypatch.setattr(drain_module.maia_engine, "is_maia_available", lambda: True)

        # Fresh MultiPV-2 search for the single candidate ply (6): res[0] is the
        # WHITE-perspective Stockfish best cp, res[4] the runner-up (wide margin).
        mock_evaluate = AsyncMock(
            return_value=(
                self._FRESH_STOCKFISH_CP,
                None,
                "h2h3",
                "h2h3 e7e6",
                self._SECOND_CP,
                None,
                "e7e6",
            )
        )
        monkeypatch.setattr(drain_module.engine_service, "evaluate_nodes_multipv2", mock_evaluate)

        # Plies 0-6 store best_move == played (only ply 6 is out-of-book, so only it
        # is a candidate); ply 7 stored best_move != played so it is not a candidate.
        # Ply-5 row carries the LICHESS best_cp -> eval_of_position[6].
        played_uci = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "h2h3", "a7a6"]
        gp_rows = [
            {
                "ply": i,
                "full_hash": 0xB600 + i,
                "best_move": played_uci[i] if i <= self._CANDIDATE_PLY else "b7b6",
                "eval_cp": self._LICHESS_BEST_CP if i == self._CANDIDATE_PLY - 1 else 20 + i,
                "eval_mate": None,
            }
            for i in range(8)
        ]
        await _insert_game_positions(
            full_drain_session_maker, full_drain_test_user_117, game_id, gp_rows
        )

        try:
            processed = await drain_module._tier4b_minimal_drain_tick(
                game_id, full_drain_test_user_117
            )
            assert processed is True, "Minimal tier-4b tick must report the game processed"
            assert mock_evaluate.await_count == 1, (
                f"Exactly one candidate ply ({self._CANDIDATE_PLY}) must be searched; "
                f"got {mock_evaluate.await_count}"
            )

            async with full_drain_session_maker() as verify:
                bm_rows = (
                    await verify.execute(
                        select(GameBestMove.ply, GameBestMove.best_cp).where(
                            GameBestMove.game_id == game_id
                        )
                    )
                ).all()

            best_cp_by_ply = {ply: best_cp for ply, best_cp in bm_rows}
            assert self._CANDIDATE_PLY in best_cp_by_ply, (
                f"Ply {self._CANDIDATE_PLY} must be a gem candidate and get a "
                f"game_best_moves row; got {best_cp_by_ply}"
            )
            assert best_cp_by_ply[self._CANDIDATE_PLY] == expected_best_cp, (
                f"{'lichess' if is_lichess else 'engine'} game: stored best_cp must be "
                f"{expected_best_cp} (got {best_cp_by_ply[self._CANDIDATE_PLY]}). For a lichess "
                f"game the fresh Stockfish {self._FRESH_STOCKFISH_CP} must override the stored "
                f"lichess {self._LICHESS_BEST_CP}; for an engine game the stored eval is kept."
            )
        finally:
            await _delete_games(full_drain_session_maker, [game_id])
