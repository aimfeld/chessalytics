"""Tests for scripts/gen_red_herring_pool.py (Phase 192, Plan 03).

These are selection/persistence-logic tests — the engine is always stubbed
(a `_FakePool` recording every board it was asked to evaluate) and the FEN/
arriving-move reconstruction is monkeypatched to a per-test lookup table, so
every test is deterministic regardless of ambient game_positions data left
behind by other test files sharing the same isolated per-worker test
database. `_existing_count` (the resumable-top-up baseline) is read for
real via the module's own helper where a test's assertions depend on it, so
ambient `herring_pool` rows from other tests never bias the shortfall math.

Coverage:
- test_generator_rejects_fewer_than_five_legal_moves : D-18's legal-move-count
  reject runs BEFORE any engine call.
- test_generator_loose_gate_boundary : D-15's loose band is inclusive at the
  boundary, exclusive one step beyond.
- test_generator_rerun_tops_up_without_duplicates : a re-run only inserts the
  shortfall (SC2, D-14) via ON CONFLICT DO NOTHING, and a genuine top-up run
  fills the remainder from previously-unconsumed candidates.
- test_generator_splits_n_into_phase_thirds : each phase bucket gets its own
  independent target/shortfall (D-19) — one bucket's shortfall never absorbs
  another's quota.
- test_generator_excludes_guest_sourced_positions : D-02's is_guest=false
  join keeps guest-sourced candidates out of the sampling frame entirely.
- test_generator_dry_run_writes_nothing : --dry-run performs the full scan
  and tally without writing any row.
- test_generator_caps_rows_per_game : SEED-124's per-game cap holds, and the
  skip happens BEFORE the engine call.
- test_generator_caps_rows_per_user_and_moves_on : SEED-124's per-user cap
  holds AND the scan reaches a second user (the concentration bug itself).
- test_generator_caps_carry_across_runs : the caps are seeded from rows
  already in the pool, so a top-up cannot re-concentrate.
- test_generator_reset_clears_phase_before_regenerating : --reset wipes and
  refills only the targeted phase.
- test_generator_reset_is_inert_under_dry_run : --reset --dry-run deletes
  nothing.
"""

from __future__ import annotations

import uuid

import chess
import chess.engine
import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

import scripts.gen_red_herring_pool as gen_module
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.herring_pool import HerringPool
from app.models.user import User
from scripts.gen_red_herring_pool import run_generation

pytestmark = pytest.mark.asyncio

_SIMPLE_PGN = "1. e4 e5 *"  # never actually replayed — fen_and_last_move_at_ply is stubbed

# A lone-king-on-b1 FEN has exactly 5 legal moves (a2/a1/b2/c1/c2), white to
# move. Used for every "should reach the engine" candidate.
_FEN_5_LEGAL_MOVES = "7k/8/8/8/8/8/8/1K6 w - - 0 1"
# King a1 + own pawn b2 has exactly 4 legal moves (a1a2, a1b1, b2b3, b2b4).
_FEN_4_LEGAL_MOVES = "7k/8/8/8/8/8/1P6/K7 w - - 0 1"


def _make_info(cp: int, move_uci: str, mate: int | None = None) -> chess.engine.InfoDict:
    """Build a minimal white-POV InfoDict, matching what _score_to_cp_mate reads."""
    score: chess.engine.PovScore
    if mate is not None:
        score = chess.engine.PovScore(chess.engine.Mate(mate), chess.WHITE)
    else:
        score = chess.engine.PovScore(chess.engine.Cp(cp), chess.WHITE)
    return {"score": score, "pv": [chess.Move.from_uci(move_uci)]}


# A 5-entry ladder where every move is within 0 ES of the best (fake identical
# cp) — always qualifies regardless of the measured HERRING_LOOSE_BAND_ES value.
_UNIFORM_QUALIFYING_LADDER: list[chess.engine.InfoDict] = [
    _make_info(30, "a1a2"),
    _make_info(30, "a1b1"),
    _make_info(30, "b1c1"),
    _make_info(30, "b1c2"),
    _make_info(30, "b1b2"),
]


class _FakePool:
    """Stub EnginePool. Returns a scripted ladder keyed by board FEN and
    records every board it was asked to evaluate (fen strings)."""

    def __init__(self, ladder_by_fen: dict[str, list[chess.engine.InfoDict]]) -> None:
        self._ladder_by_fen = ladder_by_fen
        self.evaluated_fens: list[str] = []

    async def evaluate_nodes_multipv5(
        self, board: chess.Board
    ) -> list[chess.engine.InfoDict] | None:
        fen = board.fen()
        self.evaluated_fens.append(fen)
        return self._ladder_by_fen.get(fen)


def _patch_fen_lookup(
    monkeypatch: pytest.MonkeyPatch, lookup: dict[int, tuple[str, str | None]]
) -> None:
    """Replace fen_and_last_move_at_ply with a per-ply lookup table. Any ply
    not in the table (ambient game_positions rows from other tests) is
    "unreconstructable" — silently rejected, never reaching the engine."""

    def _fake(pgn: str, ply: int) -> tuple[str, str | None] | None:
        return lookup.get(ply)

    monkeypatch.setattr(gen_module, "fen_and_last_move_at_ply", _fake)


def _session_maker(test_engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(test_engine, expire_on_commit=False)


def _lift_diversity_caps(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralize the SEED-124 per-user/per-game caps for tests about OTHER gates.

    Those tests deliberately seed many plies of a single game (the cheapest way
    to produce N qualifying candidates), which the real caps would now reject
    long before the gate under test is reached. Lifting the caps here keeps each
    test measuring the one thing it was written to measure; the caps themselves
    are covered by the dedicated tests below, at their real values.

    Replaces the cap BUILDER rather than the two constants: the per-user cap is
    derived from the bucket shortfall (`ceil(target / N)`), so no setting of N
    is unconditionally permissive — and the builder also seeds its counters from
    rows already in the pool, which would still cap a multi-run test.
    """

    async def _uncapped(
        session: AsyncSession, phase_code: int, *, target: int
    ) -> gen_module._DiversityCaps:
        return gen_module._DiversityCaps(max_rows_per_user=10_000, max_rows_per_game=10_000)

    monkeypatch.setattr(gen_module, "_load_existing_caps", _uncapped)


async def _ensure_user(session: AsyncSession, *, is_guest: bool = False) -> int:
    user = User(
        email=f"herring-gen-{uuid.uuid4().hex[:10]}@example.com",
        hashed_password="x",
        is_guest=is_guest,
    )
    session.add(user)
    await session.flush()
    return user.id


async def _seed_game(session: AsyncSession, *, user_id: int) -> int:
    game = Game(
        user_id=user_id,
        platform="lichess",
        platform_game_id=str(uuid.uuid4()),
        platform_url="https://lichess.org/test",
        pgn=_SIMPLE_PGN,
        result="1-0",
        user_color="white",
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        rated=True,
        is_computer_game=False,
    )
    session.add(game)
    await session.flush()
    return game.id


async def _seed_position(
    session: AsyncSession, *, user_id: int, game_id: int, ply: int, phase: int, eval_cp: int = 50
) -> None:
    session.add(
        GamePosition(
            game_id=game_id,
            user_id=user_id,
            ply=ply,
            full_hash=1_000_000 + game_id * 1000 + ply,
            white_hash=2_000_000 + game_id * 1000 + ply,
            black_hash=3_000_000 + game_id * 1000 + ply,
            phase=phase,
            eval_cp=eval_cp,
        )
    )


async def _current_existing(test_engine: AsyncEngine, phase_code: int) -> int:
    """Read the real ambient herring_pool count for a phase via the module's
    own helper — used to compute headroom so ambient rows from other tests
    never bias a test's shortfall math."""
    async with _session_maker(test_engine)() as session:
        return await gen_module._existing_count(session, phase_code)


async def _pool_row_exists(
    test_engine: AsyncEngine, *, user_id: int, game_id: int, ply: int
) -> bool:
    async with _session_maker(test_engine)() as session:
        stmt = (
            select(func.count())
            .select_from(HerringPool)
            .where(
                HerringPool.user_id == user_id,
                HerringPool.game_id == game_id,
                HerringPool.ply == ply,
            )
        )
        return (await session.execute(stmt)).scalar_one() > 0


async def _cleanup(test_engine: AsyncEngine, *, user_ids: list[int]) -> None:
    """Delete herring_pool rows scoped to these users FIRST (D-01's SET NULL
    FK would otherwise null out the linkage before we can scope the delete),
    then delete the users (cascades Game/GamePosition)."""
    if not user_ids:
        return
    async with _session_maker(test_engine)() as session:
        async with session.begin():
            await session.execute(delete(HerringPool).where(HerringPool.user_id.in_(user_ids)))
            await session.execute(delete(User).where(User.id.in_(user_ids)))


# ---------------------------------------------------------------------------
# test_generator_rejects_fewer_than_five_legal_moves
# ---------------------------------------------------------------------------


async def test_generator_rejects_fewer_than_five_legal_moves(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    ply_4_legal = 12
    ply_5_legal = 14
    phase_code = 1  # middlegame

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=ply_4_legal, phase=phase_code
            )
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=ply_5_legal, phase=phase_code
            )

    _patch_fen_lookup(
        monkeypatch,
        {ply_4_legal: (_FEN_4_LEGAL_MOVES, None), ply_5_legal: (_FEN_5_LEGAL_MOVES, None)},
    )
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)
        await run_generation(
            db="dev",
            n_positions=existing + 1,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        assert fake_pool.evaluated_fens == [_FEN_5_LEGAL_MOVES]
        assert await _pool_row_exists(
            test_engine, user_id=user_id, game_id=game_id, ply=ply_5_legal
        )
        assert not await _pool_row_exists(
            test_engine, user_id=user_id, game_id=game_id, ply=ply_4_legal
        )
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


# ---------------------------------------------------------------------------
# test_generator_loose_gate_boundary
# ---------------------------------------------------------------------------


async def test_generator_loose_gate_boundary(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    _lift_diversity_caps(monkeypatch)
    ply_at_boundary = 20
    ply_beyond_boundary = 22
    phase_code = 1  # middlegame

    # Markers stand in for cp; expected_score_for is monkeypatched to look
    # them up directly, sidestepping sigmoid floating-point round-trip
    # concerns entirely — the gap is defined exactly, not approximated.
    es_by_marker: dict[int, float] = {
        100: 1.0,
        101: 1.0 - gen_module.HERRING_LOOSE_BAND_ES,  # exactly at the band -> qualifies
        102: 0.0,
        103: 0.0,
        104: 0.0,
        200: 1.0,
        201: 1.0 - gen_module.HERRING_LOOSE_BAND_ES - 1e-6,  # one step beyond -> rejects
        202: 0.0,
        203: 0.0,
        204: 0.0,
    }

    def _fake_expected_score_for(
        cp: int | None, mate: int | None, mover_color: str
    ) -> float | None:
        assert cp is not None
        return es_by_marker[cp]

    monkeypatch.setattr(gen_module, "expected_score_for", _fake_expected_score_for)

    fen_at_boundary = _FEN_5_LEGAL_MOVES  # reused verbatim for both plies below
    _patch_fen_lookup(
        monkeypatch,
        {
            ply_at_boundary: (fen_at_boundary, None),
            ply_beyond_boundary: (fen_at_boundary, None),
        },
    )
    ladder_at_boundary = [_make_info(m, "a1a2") for m in (100, 101, 102, 103, 104)]
    ladder_beyond_boundary = [_make_info(m, "a1a2") for m in (200, 201, 202, 203, 204)]

    class _BoundaryPool:
        """The two candidates share the same FEN, so the fake pool must
        script by call order rather than by board — first call is the
        at-boundary candidate, second is beyond-boundary (deterministic
        because the module scans in (user_id, game_id, ply) ascending order
        within a single keyset page, and both rows share one game_id)."""

        def __init__(self) -> None:
            self.calls = 0

        async def evaluate_nodes_multipv5(self, board: chess.Board):
            self.calls += 1
            return ladder_at_boundary if self.calls == 1 else ladder_beyond_boundary

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=ply_at_boundary, phase=phase_code
            )
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=ply_beyond_boundary, phase=phase_code
            )

    try:
        existing = await _current_existing(test_engine, phase_code)
        await run_generation(
            db="dev",
            n_positions=existing + 2,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=_BoundaryPool(),  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        assert await _pool_row_exists(
            test_engine, user_id=user_id, game_id=game_id, ply=ply_at_boundary
        )
        assert not await _pool_row_exists(
            test_engine, user_id=user_id, game_id=game_id, ply=ply_beyond_boundary
        )
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


# ---------------------------------------------------------------------------
# test_generator_rerun_tops_up_without_duplicates
# ---------------------------------------------------------------------------


async def test_generator_rerun_tops_up_without_duplicates(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    _lift_diversity_caps(monkeypatch)
    phase_code = 1  # middlegame
    plies = [30, 32, 34, 36, 38]  # 5 qualifying candidates, one game

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            for ply in plies:
                await _seed_position(
                    session, user_id=user_id, game_id=game_id, ply=ply, phase=phase_code
                )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None) for ply in plies})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)

        # Run 1: target = existing + 3 -> exactly 3 of the 5 candidates stored.
        await run_generation(
            db="dev",
            n_positions=existing + 3,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _current_existing(test_engine, phase_code) == existing + 3

        # Run 2: same target -> shortfall is 0, count must not grow.
        await run_generation(
            db="dev",
            n_positions=existing + 3,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _current_existing(test_engine, phase_code) == existing + 3

        # Run 3: target = existing + 5 -> genuine top-up fills the remaining 2
        # leftover candidates (never exceeding the 5 that were ever seeded).
        await run_generation(
            db="dev",
            n_positions=existing + 5,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _current_existing(test_engine, phase_code) == existing + 5
        for ply in plies:
            assert await _pool_row_exists(test_engine, user_id=user_id, game_id=game_id, ply=ply)
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


# ---------------------------------------------------------------------------
# test_generator_splits_n_into_phase_thirds
# ---------------------------------------------------------------------------


async def test_generator_splits_n_into_phase_thirds(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    _lift_diversity_caps(monkeypatch)
    # Two qualifying candidates per phase (opening=0, middlegame=1, endgame=2),
    # all sharing one game so the FEN-lookup monkeypatch is keyed on ply alone.
    # All-even plies: mover_color_for_ply(even) == "white", matching the
    # shared white-to-move FEN's actual board.turn.
    plies_by_phase = {0: (40, 42), 1: (44, 46), 2: (48, 50)}

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            for phase_code, plies in plies_by_phase.items():
                for ply in plies:
                    await _seed_position(
                        session, user_id=user_id, game_id=game_id, ply=ply, phase=phase_code
                    )

    all_plies = [ply for plies in plies_by_phase.values() for ply in plies]
    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None) for ply in all_plies})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    # Every bucket must see a shortfall of at least 2 regardless of ambient
    # herring_pool rows left by other tests — pick a shared per-bucket target
    # comfortably above the largest ambient count, then N = 3x that (thirds
    # split with zero remainder gives every bucket the identical target).
    existing_by_phase = {
        phase_code: await _current_existing(test_engine, phase_code) for phase_code in (0, 1, 2)
    }
    per_bucket_target = max(existing_by_phase.values()) + 2
    n_positions = per_bucket_target * 3

    try:
        await run_generation(
            db="dev",
            n_positions=n_positions,
            phase=None,
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        for phase_code, plies in plies_by_phase.items():
            for ply in plies:
                assert await _pool_row_exists(
                    test_engine, user_id=user_id, game_id=game_id, ply=ply
                ), f"phase {phase_code} ply {ply} was not stored"
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


# ---------------------------------------------------------------------------
# test_generator_excludes_guest_sourced_positions
# ---------------------------------------------------------------------------


async def test_generator_excludes_guest_sourced_positions(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    phase_code = 1  # middlegame
    guest_ply = 50
    signed_up_ply = 52

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            guest_user_id = await _ensure_user(session, is_guest=True)
            guest_game_id = await _seed_game(session, user_id=guest_user_id)
            await _seed_position(
                session,
                user_id=guest_user_id,
                game_id=guest_game_id,
                ply=guest_ply,
                phase=phase_code,
            )
            signed_up_user_id = await _ensure_user(session, is_guest=False)
            signed_up_game_id = await _seed_game(session, user_id=signed_up_user_id)
            await _seed_position(
                session,
                user_id=signed_up_user_id,
                game_id=signed_up_game_id,
                ply=signed_up_ply,
                phase=phase_code,
            )

    _patch_fen_lookup(
        monkeypatch,
        {guest_ply: (_FEN_5_LEGAL_MOVES, None), signed_up_ply: (_FEN_5_LEGAL_MOVES, None)},
    )
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)
        await run_generation(
            db="dev",
            n_positions=existing + 1,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        assert await _pool_row_exists(
            test_engine, user_id=signed_up_user_id, game_id=signed_up_game_id, ply=signed_up_ply
        )
        assert not await _pool_row_exists(
            test_engine, user_id=guest_user_id, game_id=guest_game_id, ply=guest_ply
        )
        # The guest row was excluded by the frame's is_guest=false join, so it
        # should never have reached the engine at all.
        assert fake_pool.evaluated_fens == [_FEN_5_LEGAL_MOVES]
    finally:
        await _cleanup(test_engine, user_ids=[guest_user_id, signed_up_user_id])


# ---------------------------------------------------------------------------
# test_generator_dry_run_writes_nothing
# ---------------------------------------------------------------------------


async def test_generator_dry_run_writes_nothing(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    phase_code = 1  # middlegame
    ply = 60

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=ply, phase=phase_code
            )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None)})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing_before = await _current_existing(test_engine, phase_code)
        await run_generation(
            db="dev",
            n_positions=existing_before + 1,
            phase="middlegame",
            dry_run=True,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        # The engine WAS called (a dry-run still does the full scan+search),
        # but nothing was written.
        assert fake_pool.evaluated_fens == [_FEN_5_LEGAL_MOVES]
        assert not await _pool_row_exists(test_engine, user_id=user_id, game_id=game_id, ply=ply)
        assert await _current_existing(test_engine, phase_code) == existing_before
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


# ---------------------------------------------------------------------------
# SEED-124 diversity caps
# ---------------------------------------------------------------------------


async def _rows_for_game(test_engine: AsyncEngine, game_id: int) -> int:
    async with _session_maker(test_engine)() as session:
        stmt = select(func.count()).select_from(HerringPool).where(HerringPool.game_id == game_id)
        return (await session.execute(stmt)).scalar_one()


async def _rows_for_user(test_engine: AsyncEngine, user_id: int) -> int:
    async with _session_maker(test_engine)() as session:
        stmt = select(func.count()).select_from(HerringPool).where(HerringPool.user_id == user_id)
        return (await session.execute(stmt)).scalar_one()


async def test_generator_caps_rows_per_game(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEED-124: consecutive plies of one game are near-duplicate positions, so
    a single game contributes at most HERRING_MAX_ROWS_PER_GAME rows even when
    every one of its plies would otherwise qualify."""
    phase_code = 1  # middlegame
    plies = [30, 32, 34, 36, 38, 40, 42, 44]  # 8 qualifying candidates, ONE game

    # Isolate the per-GAME cap: with one user supplying everything, the per-user
    # cap (ceil(target / N)) would otherwise bind first and mask it.
    monkeypatch.setattr(gen_module, "HERRING_TARGET_USERS_PER_BUCKET", 1)

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            for ply in plies:
                await _seed_position(
                    session, user_id=user_id, game_id=game_id, ply=ply, phase=phase_code
                )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None) for ply in plies})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)
        # Ask for far more than the cap allows from this game.
        await run_generation(
            db="dev",
            n_positions=existing + len(plies),
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        assert await _rows_for_game(test_engine, game_id) == gen_module.HERRING_MAX_ROWS_PER_GAME
        # The capped plies must be skipped BEFORE the engine call — that is what
        # keeps a cap from costing Stockfish time (module docstring).
        assert len(fake_pool.evaluated_fens) == gen_module.HERRING_MAX_ROWS_PER_GAME
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


async def test_generator_caps_rows_per_user_and_moves_on(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEED-124: one user cannot fill a whole bucket. With a per-user cap of 2,
    a prolific user contributes 2 rows and the scan JUMPS past their remaining
    positions to reach a second user — the concentration bug in one assertion.
    """
    phase_code = 1  # middlegame
    plies = [30, 32, 34, 36]

    # Per-user cap = ceil(target / HERRING_TARGET_USERS_PER_BUCKET). With a
    # shortfall of 4 and 2 target users, that is 2 rows per user.
    monkeypatch.setattr(gen_module, "HERRING_TARGET_USERS_PER_BUCKET", 2)
    monkeypatch.setattr(gen_module, "HERRING_MAX_ROWS_PER_GAME", 10_000)

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            hog_id = await _ensure_user(session)
            hog_game = await _seed_game(session, user_id=hog_id)
            for ply in plies:
                await _seed_position(
                    session, user_id=hog_id, game_id=hog_game, ply=ply, phase=phase_code
                )
            other_id = await _ensure_user(session)
            other_game = await _seed_game(session, user_id=other_id)
            for ply in plies:
                await _seed_position(
                    session, user_id=other_id, game_id=other_game, ply=ply, phase=phase_code
                )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None) for ply in plies})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)
        await run_generation(
            db="dev",
            n_positions=existing + 4,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )

        # Neither user may exceed the cap, and BOTH must have contributed —
        # pre-fix, whichever user the scan landed on first took all 4.
        assert await _rows_for_user(test_engine, hog_id) == 2
        assert await _rows_for_user(test_engine, other_id) == 2
    finally:
        await _cleanup(test_engine, user_ids=[hog_id, other_id])


async def test_generator_caps_carry_across_runs(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SEED-124: a top-up must not re-concentrate. The caps are seeded from the
    rows already in the pool, so a user who is already at their cap gets nothing
    more from a later run even though that run has its own fresh shortfall."""
    phase_code = 1  # middlegame
    plies = [30, 32, 34, 36]

    monkeypatch.setattr(gen_module, "HERRING_MAX_ROWS_PER_GAME", 10_000)

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            for ply in plies:
                await _seed_position(
                    session, user_id=user_id, game_id=game_id, ply=ply, phase=phase_code
                )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None) for ply in plies})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)

        # Run 1: shortfall 2, 2 target users -> cap 1/user, so 1 row lands.
        monkeypatch.setattr(gen_module, "HERRING_TARGET_USERS_PER_BUCKET", 2)
        await run_generation(
            db="dev",
            n_positions=existing + 2,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _rows_for_user(test_engine, user_id) == 1

        # Run 2: a fresh shortfall of 2 -> the SAME cap of 1/user. Seeding the
        # counters from the pool is what stops this run handing the user a
        # second allowance on top of the row run 1 already gave them.
        await run_generation(
            db="dev",
            n_positions=existing + 3,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _rows_for_user(test_engine, user_id) == 1
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


async def test_generator_reset_clears_phase_before_regenerating(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--reset` regenerates from scratch instead of topping up, and is scoped
    to the targeted phase so the other buckets survive."""
    _lift_diversity_caps(monkeypatch)
    target_phase = 1  # middlegame
    other_phase = 2  # endgame
    plies = [30, 32]

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            for ply in plies:
                await _seed_position(
                    session, user_id=user_id, game_id=game_id, ply=ply, phase=target_phase
                )
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=50, phase=other_phase
            )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None) for ply in [*plies, 50]})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})
    run_kwargs = {
        "db": "dev",
        "dry_run": False,
        "session_maker": _session_maker(test_engine),
        "pool": fake_pool,
    }

    try:
        # Seed both buckets.
        middlegame_before = await _current_existing(test_engine, target_phase)
        await run_generation(
            n_positions=middlegame_before + 2,
            phase="middlegame",
            **run_kwargs,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        endgame_before = await _current_existing(test_engine, other_phase)
        await run_generation(
            n_positions=endgame_before + 1,
            phase="endgame",
            **run_kwargs,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _current_existing(test_engine, target_phase) == middlegame_before + 2
        endgame_after_seed = await _current_existing(test_engine, other_phase)

        # Reset middlegame only: it is wiped and refilled to the new target,
        # while endgame is untouched.
        await run_generation(
            n_positions=1,
            phase="middlegame",
            reset=True,
            **run_kwargs,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _current_existing(test_engine, target_phase) == 1
        assert await _current_existing(test_engine, other_phase) == endgame_after_seed
    finally:
        await _cleanup(test_engine, user_ids=[user_id])


async def test_generator_reset_is_inert_under_dry_run(
    test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--reset --dry-run` must not delete: a dry run is for inspecting what a
    real run WOULD do, so it may never be the thing that empties the pool."""
    _lift_diversity_caps(monkeypatch)
    phase_code = 1  # middlegame
    ply = 30

    async with _session_maker(test_engine)() as session:
        async with session.begin():
            user_id = await _ensure_user(session)
            game_id = await _seed_game(session, user_id=user_id)
            await _seed_position(
                session, user_id=user_id, game_id=game_id, ply=ply, phase=phase_code
            )

    _patch_fen_lookup(monkeypatch, {ply: (_FEN_5_LEGAL_MOVES, None)})
    fake_pool = _FakePool({_FEN_5_LEGAL_MOVES: _UNIFORM_QUALIFYING_LADDER})

    try:
        existing = await _current_existing(test_engine, phase_code)
        await run_generation(
            db="dev",
            n_positions=existing + 1,
            phase="middlegame",
            dry_run=False,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        seeded = await _current_existing(test_engine, phase_code)
        assert seeded == existing + 1

        await run_generation(
            db="dev",
            n_positions=existing + 1,
            phase="middlegame",
            dry_run=True,
            reset=True,
            session_maker=_session_maker(test_engine),
            pool=fake_pool,  # ty: ignore[invalid-argument-type]  # test stub duck-types EnginePool
        )
        assert await _current_existing(test_engine, phase_code) == seeded
    finally:
        await _cleanup(test_engine, user_ids=[user_id])
