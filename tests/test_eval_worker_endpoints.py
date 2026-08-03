"""Integration tests for the remote eval worker protocol endpoints.

Phase 149-03 PRUNE-01: the original Gen-1 POST /lease + POST /submit pair and
their tests (including TestTier1Claiming) have been deleted — the fleet fully
migrated to the atomic (versioned) /atomic-lease + /atomic-submit pair. See
TestAtomicLeaseEndpoint / TestAtomicSubmitEndpoint for the equivalent coverage
(job_id -> eval_jobs stamping and the lichess-eval-game release+204 branch were
explicitly ported before the Gen-1 tests were removed — 149-RESEARCH.md
Pitfall 1). This module now covers /entry-lease, /entry-submit, /atomic-lease,
/atomic-submit, and /flaw-blob-lease, /flaw-blob-submit.

Session patching: monkeypatch app.routers.eval_remote.async_session_maker to route
the router's own sessions to the per-run test DB (eval_drain / eval_queue_service
session makers are already patched by conftest's session-scoped override_get_async_session).
claim_eval_job is monkeypatched directly in the eval_remote router namespace for tests
that need to control which game is leased without relying on the recency-weighted lottery.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.main import app
from app.services.eval_queue_service import ClaimedJob

# ─── URL constants (no magic numbers) ─────────────────────────────────────────

_ENTRY_LEASE_URL = "/api/eval/remote/entry-lease"
_ENTRY_SUBMIT_URL = "/api/eval/remote/entry-submit"

# ─── Test data constants ───────────────────────────────────────────────────────

# A simple 2-move (4 half-move) PGN for lease/submit tests.
# 4 non-terminal plies (0-3) + 1 terminal eval-donor ply (4).
_TWO_MOVE_PGN: str = "1. e4 e5 *"

# Token used for tests that exercise a correctly-configured server.
_TEST_TOKEN: str = "test-operator-secret-xyz"

# Unique user ID range for this module — avoids FK conflicts with other test modules.
_TEST_USER_ID: int = 99300


# ─── Session-scoped fixtures ──────────────────────────────────────────────────


@pytest_asyncio.fixture(scope="session")
async def eval_worker_session_maker(test_engine) -> async_sessionmaker[AsyncSession]:
    """async_sessionmaker bound to the per-run test engine."""
    return async_sessionmaker(test_engine, expire_on_commit=False)


@pytest_asyncio.fixture(scope="session", autouse=False)
async def eval_worker_test_user(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
) -> int:
    """Ensure test user _TEST_USER_ID exists in the test DB. Returns user_id."""
    from app.models.user import User

    async with eval_worker_session_maker() as session:
        result = await session.execute(select(User).where(User.id == _TEST_USER_ID))
        if result.unique().scalar_one_or_none() is None:
            session.add(
                User(
                    id=_TEST_USER_ID,
                    email=f"eval-worker-test-{_TEST_USER_ID}@example.com",
                    hashed_password="fakehash",
                    is_active=True,
                    is_superuser=False,
                    is_verified=True,
                )
            )
            await session.commit()
    return _TEST_USER_ID


# ─── DB helpers ───────────────────────────────────────────────────────────────


_EVALS_NOW: datetime = datetime.now(timezone.utc)
"""Default evals_completed_at value — module-load-time now(), matching legacy behavior."""


async def _insert_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    pgn: str = _TWO_MOVE_PGN,
    *,
    evals_completed_at: datetime | None = _EVALS_NOW,
    full_evals_completed_at: datetime | None = None,
    lichess_evals_at: datetime | None = None,
    full_eval_attempts: int = 0,
) -> int:
    """Insert a Game row and commit. Returns game_id.

    By default evals_completed_at is set to now() so the game is NOT in the
    entry-ply pending queue (preserves pre-Phase-123 test behavior).
    Pass evals_completed_at=None to insert a pending entry-ply game
    (evals_completed_at IS NULL = unclaimed by the entry-eval drain).
    """
    from app.models.game import Game

    async with session_maker() as session:
        g = Game(
            user_id=user_id,
            platform="chess.com",
            platform_game_id=f"eval-worker-{uuid.uuid4().hex}",
            pgn=pgn,
            result="1-0",
            user_color="white",
            rated=True,
            is_computer_game=False,
            evals_completed_at=evals_completed_at,
            full_evals_completed_at=full_evals_completed_at,
            lichess_evals_at=lichess_evals_at,
            full_eval_attempts=full_eval_attempts,
        )
        session.add(g)
        await session.flush()
        game_id = int(g.id)  # type: ignore[arg-type]
        await session.commit()
    return game_id


async def _insert_game_positions(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    rows: list[dict[str, Any]],
) -> None:
    """Insert GamePosition rows for a game and commit.

    Each dict: {"ply": int, "full_hash": int, "eval_cp": int|None, "eval_mate": int|None,
                "phase": int (optional, default 0), "best_move": str|None (optional,
                the row's OWN un-shifted best_move — Phase 177 tier-4b tests)}.

    For entry-ply target collection, at least one row needs phase=1 (midgame) to produce
    a middlegame_entry target. Pass phase=1 in the row dict when needed.
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
                    phase=r.get("phase", 0),
                    endgame_class=None,
                    eval_cp=r.get("eval_cp"),
                    eval_mate=r.get("eval_mate"),
                    best_move=r.get("best_move"),
                )
            )
        await session.commit()


async def _get_game_position(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
    ply: int,
) -> dict[str, Any] | None:
    """Fetch a GamePosition row. Returns a dict with eval_cp/eval_mate or None."""
    from app.models.game_position import GamePosition

    async with session_maker() as session:
        result = await session.execute(
            select(GamePosition).where(
                GamePosition.game_id == game_id,
                GamePosition.ply == ply,
            )
        )
        gp = result.scalar_one_or_none()
        if gp is None:
            return None
        return {
            "ply": gp.ply,
            "eval_cp": gp.eval_cp,
            "eval_mate": gp.eval_mate,
            "best_move": gp.best_move,
            "pv": gp.pv,
        }


async def _get_game_full_evals_completed_at(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> datetime | None:
    """Fetch Game.full_evals_completed_at."""
    from app.models.game import Game

    async with session_maker() as session:
        result = await session.execute(
            select(Game.full_evals_completed_at).where(Game.id == game_id)
        )
        return result.scalar_one_or_none()


async def _get_game_evals_completed_at(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> datetime | None:
    """Fetch Game.evals_completed_at (entry-ply completion stamp)."""
    from app.models.game import Game

    async with session_maker() as session:
        result = await session.execute(select(Game.evals_completed_at).where(Game.id == game_id))
        return result.scalar_one_or_none()


async def _get_game_entry_eval_leased_by(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> str | None:
    """Fetch Game.entry_eval_leased_by."""
    from app.models.game import Game

    async with session_maker() as session:
        result = await session.execute(select(Game.entry_eval_leased_by).where(Game.id == game_id))
        return result.scalar_one_or_none()


async def _get_game_best_moves_completed_at(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> datetime | None:
    """Fetch Game.best_moves_completed_at (Phase 177 tier-4b completion stamp)."""
    from app.models.game import Game

    async with session_maker() as session:
        result = await session.execute(
            select(Game.best_moves_completed_at).where(Game.id == game_id)
        )
        return result.scalar_one_or_none()


async def _count_game_best_moves(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> int:
    """Count game_best_moves rows for a game (Phase 177 tier-4b)."""
    from app.models.game_best_move import GameBestMove

    async with session_maker() as session:
        result = await session.execute(
            select(func.count()).select_from(GameBestMove).where(GameBestMove.game_id == game_id)
        )
        return result.scalar_one() or 0


async def _get_best_cp_by_ply(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
) -> dict[int, int | None]:
    """Return {ply: best_cp} for a game's game_best_moves rows (Quick 260719-fsz)."""
    from app.models.game_best_move import GameBestMove

    async with session_maker() as session:
        rows = await session.execute(
            select(GameBestMove.ply, GameBestMove.best_cp).where(GameBestMove.game_id == game_id)
        )
        return {ply: best_cp for ply, best_cp in rows.all()}


async def _delete_games(
    session_maker: async_sessionmaker[AsyncSession],
    game_ids: list[int],
) -> None:
    """Delete games by ID (cascades to game_positions)."""
    from app.models.game import Game

    if not game_ids:
        return
    async with session_maker() as session:
        await session.execute(delete(Game).where(Game.id.in_(game_ids)))
        await session.commit()


# httpx's ASGITransport default client address — what request.client.host, and
# therefore the heartbeat/log `last_ip`, resolves to under _make_client().
_DEFAULT_CLIENT_ADDR: tuple[str, int] = ("127.0.0.1", 123)

# The Path-C cap message prefix, asserted by
# test_atomic_submit_holed_batch_at_cap_stamps_with_log_warning. 260803: this lane
# no longer Sentry-captures the cap path (it fired ~30x/hour for an expected
# outcome — FLAWCHESS-8B noise); the same facts go to logger.warning instead.
_PATH_C_CAP_MESSAGE: str = (
    "atomic-submit: stamping complete after MAX_EVAL_ATTEMPTS with residual holes"
)
_PATH_C_WORKER_ID: str = "w-path-c"


def _make_client() -> httpx.AsyncClient:
    """Return an httpx AsyncClient using the ASGI transport."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _patch_router_session(
    monkeypatch: pytest.MonkeyPatch,
    session_maker: async_sessionmaker[AsyncSession],
) -> None:
    """Patch session makers for the eval remote router, eval drain, and eval apply services.

    The router's own sessions (probe, claim, read) use async_session_maker imported
    into the router module. The entry-ply endpoints also call _load_pgns_for_games and
    _collect_eval_targets_from_db which open sessions via eval_drain.async_session_maker,
    so that module binding must also be redirected to the test DB. Phase 150 R7: several
    shared-write-path primitives (_derive_atomic_sentinel_lines, _build_flaw_multipv2_blobs,
    _build_flaw_blob_lease_positions, apply_full_eval's helpers) moved to eval_apply.py and
    open their OWN internal sessions there, so that module binding must be redirected too.
    """
    import app.routers.eval_remote as eval_remote_module
    import app.services.eval_apply as eval_apply_module
    import app.services.eval_drain as eval_drain_module

    monkeypatch.setattr(eval_remote_module, "async_session_maker", session_maker)
    monkeypatch.setattr(eval_drain_module, "async_session_maker", session_maker)
    monkeypatch.setattr(eval_apply_module, "async_session_maker", session_maker)


# Phase 149-03 PRUNE-01: the Gen-1 /lease auth/queue and /submit auth/version-gate
# /write-path test blocks (test_lease_requires_operator_token through
# test_submit_idempotent) have been deleted — /lease and /submit no longer exist.
# /atomic-lease + /atomic-submit (TestAtomicLeaseEndpoint / TestAtomicSubmitEndpoint
# below) carry the equivalent auth/version-gate/write-path coverage for the live lane.


# ─── Tier-1 claiming: helpers ─────────────────────────────────────────────────


async def _get_eval_job(
    session_maker: async_sessionmaker[AsyncSession],
    job_id: int,
) -> dict[str, Any] | None:
    """Fetch an eval_jobs row by id. Returns a dict with status/completed_at or None."""
    from app.models.eval_jobs import EvalJob

    async with session_maker() as session:
        result = await session.execute(select(EvalJob).where(EvalJob.id == job_id))
        row = result.scalar_one_or_none()
        if row is None:
            return None
        return {
            "id": row.id,
            "status": row.status,
            "completed_at": row.completed_at,
            "leased_by": row.leased_by,
        }


async def _seed_eval_job(
    session_maker: async_sessionmaker[AsyncSession],
    game_id: int,
    user_id: int,
    *,
    status: str = "leased",
) -> int:
    """Insert an eval_jobs row with the given status. Returns the new job_id."""
    from app.models.eval_jobs import EvalJob, TIER_EXPLICIT

    async with session_maker() as session:
        job = EvalJob(
            tier=TIER_EXPLICIT,
            user_id=user_id,
            game_id=game_id,
            status=status,
        )
        session.add(job)
        await session.flush()
        job_id = int(job.id)  # type: ignore[arg-type]
        await session.commit()
    return job_id


# ─── Tier-1 claiming: tests ───────────────────────────────────────────────────
# Phase 149-03 PRUNE-01: TestTier1Claiming (Gen-1 /lease + /submit only) has been
# deleted — its job_id -> eval_jobs stamping and lichess-eval-game release
# coverage was ported to TestAtomicSubmitEndpoint / TestAtomicLeaseEndpoint
# (test_atomic_submit_with_job_id_stamps_eval_jobs and friends, see
# 149-RESEARCH.md Pitfall 1) BEFORE this class was removed. The one method that
# was NOT Gen-1-specific (a worker-script constant, not a /lease or /submit
# behavior) is relocated below rather than deleted.


def test_default_idle_sleep_is_one_second() -> None:
    """DEFAULT_IDLE_SLEEP constant must be 1.0 (lowered from 5.0 in Phase 121).

    Only the empty-queue / 204 path sleeps; the busy path is a tight loop. This
    constant controls idle-pickup latency for every lane (D-06 ladder), not just
    the deleted Gen-1 pair — relocated out of TestTier1Claiming (Phase 149-03
    PRUNE-01) rather than deleted with it.
    """
    import scripts.remote_eval_worker as remote_eval_worker

    assert remote_eval_worker.DEFAULT_IDLE_SLEEP == 1.0, (
        f"DEFAULT_IDLE_SLEEP must be 1.0, got {remote_eval_worker.DEFAULT_IDLE_SLEEP}"
    )


# ─── Phase 123 lease-claim tests ─────────────────────────────────────────────
# SEED-051 D-3/D-4: _claim_entry_eval_games SKIP-LOCKED LIFO correctness.
# Tests: partition (disjoint), LIFO ordering, TTL reclaim + future-lease exclusion,
# leased_by population.  All four drive the helper directly (no HTTP needed).


@pytest.mark.asyncio
async def test_lease_partition(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Two sequential claims with different worker IDs return disjoint game ID sets.

    Inserts ENTRY_LEASE_BATCH_SIZE + 5 pending games (evals_completed_at=None) so
    both claims get a non-empty result, then asserts no overlap.  Sequential calls
    suffice because the first claim stamps entry_eval_lease_expiry in the future,
    making those rows invisible to the second claim's predicate — same partition
    guarantee as concurrent SKIP LOCKED.

    SEED-051 D-3 / validation matrix row 123-02-02.
    """
    from app.services.eval_drain import ENTRY_LEASE_BATCH_SIZE, _claim_entry_eval_games

    n_games = ENTRY_LEASE_BATCH_SIZE + 5
    game_ids: list[int] = []
    for _ in range(n_games):
        gid = await _insert_game(
            eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
        )
        game_ids.append(gid)

    try:
        async with eval_worker_session_maker() as session:
            first_batch = await _claim_entry_eval_games(
                session, "worker-A", ENTRY_LEASE_BATCH_SIZE, 60
            )
            await session.commit()

        async with eval_worker_session_maker() as session:
            second_batch = await _claim_entry_eval_games(
                session, "worker-B", ENTRY_LEASE_BATCH_SIZE, 60
            )
            await session.commit()

        assert len(first_batch) > 0, "first claim must return at least one game"
        assert len(second_batch) > 0, "second claim must return at least one game"
        overlap = set(first_batch) & set(second_batch)
        assert overlap == set(), (
            f"Claims must be disjoint (SKIP LOCKED partition), but overlap={overlap}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


@pytest.mark.asyncio
async def test_lease_lifo(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """The claim returns the highest IDs first (LIFO: newest import first, ORDER BY id DESC).

    Inserts 5 pending games sequentially (auto-increment IDs are monotonically
    increasing), then claims 3 of them.  The returned IDs must be the 3 largest
    (most recently inserted), confirming ORDER BY id DESC.

    SEED-051 D-3 (LIFO ordering) / RESEARCH §Architecture Diagram.
    """
    from app.services.eval_drain import _claim_entry_eval_games

    game_ids: list[int] = []
    for _ in range(5):
        gid = await _insert_game(
            eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
        )
        game_ids.append(gid)

    try:
        async with eval_worker_session_maker() as session:
            claimed = await _claim_entry_eval_games(session, "worker-lifo", 3, 60)
            await session.commit()

        assert len(claimed) == 3, f"Expected 3 claimed games, got {len(claimed)}"
        # The 3 highest IDs from the 5 inserted must be the ones claimed.
        top3 = sorted(game_ids)[-3:]
        assert sorted(claimed) == sorted(top3), (
            f"LIFO claim must return the 3 newest games (ids {top3}), got {sorted(claimed)}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


@pytest.mark.asyncio
async def test_lease_reclaim(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Past-expiry lease is reclaimable; future-expiry lease is NOT returned.

    1. Insert two pending games.
    2. Manually set game A's lease to the past (expired) and game B's to the future.
    3. Assert only game A is returned by a new claim (TTL reclaim); game B is skipped.

    SEED-051 D-4 (TTL reclaim) / PATTERNS.md lease_reclaim shape.
    """
    from app.services.eval_drain import _claim_entry_eval_games

    # Expired lease: entry_eval_lease_expiry 10 minutes in the past.
    game_expired = await _insert_game(
        eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
    )
    # Active (future) lease: entry_eval_lease_expiry 60 seconds from now.
    game_active = await _insert_game(
        eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
    )

    try:
        now = datetime.now(timezone.utc)
        async with eval_worker_session_maker() as session:
            await session.execute(
                sa.text("""
                    UPDATE games
                    SET entry_eval_lease_expiry = :past_ts,
                        entry_eval_leased_by = 'old-worker'
                    WHERE id = :gid
                """),
                {"past_ts": now - timedelta(minutes=10), "gid": game_expired},
            )
            await session.execute(
                sa.text("""
                    UPDATE games
                    SET entry_eval_lease_expiry = :future_ts,
                        entry_eval_leased_by = 'active-worker'
                    WHERE id = :gid
                """),
                {"future_ts": now + timedelta(seconds=60), "gid": game_active},
            )
            await session.commit()

        async with eval_worker_session_maker() as session:
            claimed = await _claim_entry_eval_games(session, "reclaimer", 10, 30)
            await session.commit()

        assert game_expired in claimed, f"Expired lease (game {game_expired}) must be reclaimable"
        assert game_active not in claimed, (
            f"Active future lease (game {game_active}) must NOT be reclaimable"
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_expired, game_active])


@pytest.mark.asyncio
async def test_leased_by_set(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """After a claim, the leased games' entry_eval_leased_by equals the worker_id passed.

    SEED-051 D-9 / CONTEXT D-09 (observability column).
    """
    from app.services.eval_drain import _claim_entry_eval_games

    game_id = await _insert_game(
        eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
    )
    worker_id = "tst-worker"

    try:
        async with eval_worker_session_maker() as session:
            claimed = await _claim_entry_eval_games(session, worker_id, 10, 30)
            await session.commit()

        assert game_id in claimed, f"Game {game_id} must appear in the claimed set"

        async with eval_worker_session_maker() as session:
            from app.models.game import Game

            result = await session.execute(
                select(Game.entry_eval_leased_by).where(Game.id == game_id)
            )
            leased_by = result.scalar_one()

        assert leased_by == worker_id, (
            f"entry_eval_leased_by must equal worker_id '{worker_id}', got {leased_by!r}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])


# ─── Phase 123 entry-lease HTTP endpoint tests ────────────────────────────────
# Tests for POST /eval/remote/entry-lease and /entry-submit (SEED-051 D-07).


@pytest.mark.asyncio
async def test_entry_lease_auth_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing operator token → 403 (fail-closed, T-123-01 / T-123-auth)."""
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", "")
    async with _make_client() as client:
        response = await client.post(_ENTRY_LEASE_URL)
    assert response.status_code == 403, f"Expected 403, got {response.status_code}: {response.text}"


@pytest.mark.asyncio
async def test_entry_lease_auth_wrong_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wrong operator token → 401 (T-123-auth)."""
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    async with _make_client() as client:
        response = await client.post(_ENTRY_LEASE_URL, headers={"X-Operator-Token": "wrong-token"})
    assert response.status_code == 401, f"Expected 401, got {response.status_code}: {response.text}"


@pytest.mark.asyncio
async def test_entry_lease_gate_below_threshold(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Backlog exactly THRESHOLD-1 pending games → 204 (D-5 gate, Pitfall 6).

    The existence probe fires at OFFSET = THRESHOLD - 1 (0-indexed). With exactly
    THRESHOLD-1 games, the probe returns no row → 204 (too shallow for remote workers).
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    # Insert exactly THRESHOLD-1 pending games.
    n_games = ENTRY_LEASE_BACKLOG_THRESHOLD - 1
    game_ids: list[int] = []
    for _ in range(n_games):
        gid = await _insert_game(
            eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
        )
        game_ids.append(gid)

    try:
        async with _make_client() as client:
            response = await client.post(
                _ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN}
            )
        assert response.status_code == 204, (
            f"Expected 204 (backlog below threshold), got {response.status_code}: {response.text}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


@pytest.mark.asyncio
async def test_entry_lease_gate_at_threshold(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Backlog exactly THRESHOLD pending games → 200 (D-5 gate boundary, Pitfall 6).

    The 300th row is at OFFSET 299 (0-indexed). With exactly THRESHOLD games,
    the probe finds a row → gate passes → workers get a batch.
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    # Insert exactly THRESHOLD pending games.
    n_games = ENTRY_LEASE_BACKLOG_THRESHOLD
    game_ids: list[int] = []
    for _ in range(n_games):
        gid = await _insert_game(
            eval_worker_session_maker, eval_worker_test_user, evals_completed_at=None
        )
        game_ids.append(gid)

    try:
        async with _make_client() as client:
            response = await client.post(
                _ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN}
            )
        # 200 = gate passed (batch leased); 204 would mean gate blocked (off-by-one bug).
        assert response.status_code == 200, (
            f"Expected 200 (backlog at threshold), got {response.status_code}: {response.text}"
        )
        body = response.json()
        assert "positions" in body, f"Response must have 'positions' key: {body}"
        # The response may have 0 positions if games have no entry targets (no game_positions).
        # The key assertion is that the gate passed (200), not that positions is non-empty.
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


@pytest.mark.asyncio
async def test_entry_lease_returns_positions(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """With ≥ threshold pending games (with game_positions), entry-lease returns positions.

    Seeds THRESHOLD pending games + game_positions rows to produce real entry targets.
    Asserts the response has non-empty positions with {game_id, ply, fen} structure.
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    game_ids: list[int] = []

    # Pad to reach threshold first (these get lower IDs, so LIFO skips them in first batch).
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD - 1):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        game_ids.append(gid)

    # Insert our game with game_positions LAST so it gets the highest ID and
    # is picked first by the LIFO (id DESC) claim.
    game_with_positions = await _insert_game(
        eval_worker_session_maker, user_id, evals_completed_at=None
    )
    game_ids.append(game_with_positions)
    # phase=1 (midgame) on ply 0 produces a middlegame_entry target for _collect_target_specs.
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_with_positions,
        [
            {"ply": ply, "full_hash": 9000 + ply, "phase": 1, "eval_cp": None, "eval_mate": None}
            for ply in range(4)
        ],
    )

    try:
        async with _make_client() as client:
            response = await client.post(
                _ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN}
            )
        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        body = response.json()
        assert "positions" in body
        assert "leased_at" in body
        positions = body["positions"]
        assert len(positions) > 0, "positions must be non-empty (game has game_positions rows)"
        for pos in positions:
            assert "game_id" in pos and isinstance(pos["game_id"], int)
            assert "ply" in pos and isinstance(pos["ply"], int) and pos["ply"] >= 0
            assert "fen" in pos and pos["fen"], f"position at ply {pos['ply']} has empty FEN"
            # Entry-ply schema: NO is_terminal field (unlike full-ply LeasePosition)
            assert "is_terminal" not in pos, (
                "Entry-ply positions must not have is_terminal (depth-15, no best_move/pv)"
            )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


@pytest.mark.asyncio
async def test_entry_submit_auth_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing operator token → 403 (T-123-01)."""
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", "")
    payload = {"sf_version": "Stockfish 18", "evals": []}
    async with _make_client() as client:
        response = await client.post(_ENTRY_SUBMIT_URL, json=payload)
    assert response.status_code == 403, f"Expected 403, got {response.status_code}: {response.text}"


@pytest.mark.asyncio
async def test_entry_submit_sf_version_mismatch(monkeypatch: pytest.MonkeyPatch) -> None:
    """EXPECTED_SF_VERSION set, wrong version in body → 422 (T-123-07)."""
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "Stockfish 18")
    payload = {"sf_version": "Stockfish 17", "evals": []}
    async with _make_client() as client:
        response = await client.post(
            _ENTRY_SUBMIT_URL,
            json=payload,
            headers={"X-Operator-Token": _TEST_TOKEN},
        )
    assert response.status_code == 422, f"Expected 422, got {response.status_code}: {response.text}"


@pytest.mark.asyncio
async def test_entry_submit_no_shift(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Entry-submit writes eval at the EXACT submitted ply — NO +1 post-move shift.

    The inverse of test_submit_applies_post_move_shift (which verifies the +1 shift
    for full-ply /submit). Entry-ply uses _apply_eval_results (no shift); the worker
    submits at ply N and the server must store at row ply=N (Pitfall 1).

    For _TWO_MOVE_PGN "1. e4 e5 *": ply 0 is the middlegame entry (first half-move).
    Submit eval_cp=77 at ply=0 → row ply=0 must store eval_cp=77 (not shifted to ply=-1).
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user

    # Insert padding FIRST (lowest IDs) so the LIFO claim picks our game last.
    # The game with positions is inserted LAST to get the highest ID — LIFO picks it first.
    pad_ids: list[int] = []
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD - 1):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        pad_ids.append(gid)

    # Game with game_positions inserted LAST (highest ID → LIFO picks it in first batch).
    game_id = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [
            {"ply": ply, "full_hash": 10000 + ply, "phase": 1, "eval_cp": None, "eval_mate": None}
            for ply in range(4)
        ],
    )

    # First lease to discover what plies the server assigned.
    async with _make_client() as client:
        lease_resp = await client.post(_ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN})
    assert lease_resp.status_code == 200, (
        f"Expected 200 on entry-lease, got {lease_resp.status_code}: {lease_resp.text}"
    )
    positions = lease_resp.json()["positions"]
    # Find the position for our game.
    our_positions = [p for p in positions if p["game_id"] == game_id]
    assert our_positions, (
        f"Game {game_id} must appear in the leased positions. All positions: {positions}"
    )

    # Submit an eval for the first assigned ply of our game.
    target_ply = our_positions[0]["ply"]
    eval_cp_value = 77
    payload = {
        "sf_version": "Stockfish 18",
        "evals": [
            {"game_id": game_id, "ply": target_ply, "eval_cp": eval_cp_value, "eval_mate": None}
        ],
    }

    try:
        async with _make_client() as client:
            resp = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 200, (
            f"Expected 200 on entry-submit, got {resp.status_code}: {resp.text}"
        )

        # No-shift assertion: eval must be at the EXACT submitted ply (not shifted).
        row = await _get_game_position(eval_worker_session_maker, game_id, ply=target_ply)
        assert row is not None, f"game_positions row at ply={target_ply} must exist"
        assert row["eval_cp"] == eval_cp_value, (
            f"Entry-ply must write eval_cp={eval_cp_value} at ply={target_ply} (no +1 shift). "
            f"Got eval_cp={row['eval_cp']}. "
            "If the value landed at a different ply, the +1 shift was accidentally applied."
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_id, *pad_ids])


@pytest.mark.asyncio
async def test_entry_submit_stamps_evals_completed_at(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """After entry-submit, evals_completed_at IS NOT NULL for the submitted game.

    The completion stamp is the permanent lease release (D-01): once stamped,
    the game exits the queue (evals_completed_at IS NULL predicate no longer matches).
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    # Padding inserted FIRST (lower IDs); game with positions LAST (highest ID → LIFO).
    pad_ids: list[int] = []
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD - 1):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        pad_ids.append(gid)

    game_id = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [
            {"ply": ply, "full_hash": 11000 + ply, "phase": 1, "eval_cp": None, "eval_mate": None}
            for ply in range(4)
        ],
    )

    # Lease to get the assigned plies.
    async with _make_client() as client:
        lease_resp = await client.post(_ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN})
    assert lease_resp.status_code == 200
    our_positions = [p for p in lease_resp.json()["positions"] if p["game_id"] == game_id]

    evals = [
        {"game_id": game_id, "ply": p["ply"], "eval_cp": 50, "eval_mate": None}
        for p in our_positions
    ]
    payload = {"sf_version": "Stockfish 18", "evals": evals}

    try:
        async with _make_client() as client:
            resp = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert game_id in body["game_ids"], f"game_id must be in game_ids: {body}"
        assert body["stamped_count"] >= 1, f"stamped_count must be ≥1: {body}"

        # Key assertion: evals_completed_at is now set.
        completed_at = await _get_game_evals_completed_at(eval_worker_session_maker, game_id)
        assert completed_at is not None, (
            "evals_completed_at must be stamped after entry-submit "
            "(permanent lease release per D-01)"
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_id, *pad_ids])


@pytest.mark.asyncio
async def test_entry_submit_stamps_full_leased_set_including_zero_target_games(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """CR-01 regression: a leased game that yields ZERO eval targets is still stamped.

    Before the fix, entry-submit stamped evals_completed_at ONLY for games present in
    the worker's submission body. A leased game with no derivable targets (e.g. an
    unreachable target ply, or — as here — a game with no game_positions rows) never
    appeared in body.evals, so it was never stamped and got re-leased every TTL cycle
    forever (re-lease livelock). The fix stamps the FULL set of games leased to this
    worker, mirroring the in-process server pool's "no permanent retry" invariant.

    Setup: BACKLOG_THRESHOLD-1 padding games with NO game_positions (zero targets) plus
    one game WITH positions. The LIFO claim leases a batch spanning padding games. We
    submit ONLY the target game's evals, then assert that a leased zero-target padding
    game also ends up stamped evals_completed_at.
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    # Padding games have NO game_positions → zero eval targets at drain time.
    pad_ids: list[int] = []
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD - 1):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        pad_ids.append(gid)

    # Highest ID → LIFO picks it first; it carries the only real eval targets.
    game_id = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [
            {"ply": ply, "full_hash": 13000 + ply, "phase": 1, "eval_cp": None, "eval_mate": None}
            for ply in range(4)
        ],
    )

    async with _make_client() as client:
        lease_resp = await client.post(_ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN})
    assert lease_resp.status_code == 200, lease_resp.text

    # Find a padding game that was actually leased to this (default) worker but produced
    # no positions in the lease response — that is the zero-target game CR-01 is about.
    leased_position_game_ids = {p["game_id"] for p in lease_resp.json()["positions"]}
    leased_zero_target_pad_id: int | None = None
    for pid in pad_ids:
        leased_by = await _get_game_entry_eval_leased_by(eval_worker_session_maker, pid)
        if leased_by is not None and pid not in leased_position_game_ids:
            leased_zero_target_pad_id = pid
            break
    assert leased_zero_target_pad_id is not None, (
        "Expected at least one padding game to be leased with zero target positions "
        "(LIFO claims a batch wider than the single game-with-positions)."
    )

    # Submit ONLY the target game's evals — the zero-target padding game is absent.
    our_positions = [p for p in lease_resp.json()["positions"] if p["game_id"] == game_id]
    evals = [
        {"game_id": game_id, "ply": p["ply"], "eval_cp": 42, "eval_mate": None}
        for p in our_positions
    ]
    payload = {"sf_version": "Stockfish 18", "evals": evals}

    try:
        async with _make_client() as client:
            resp = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

        # CR-01 key assertion: the leased zero-target padding game (never submitted) is
        # stamped complete, so it cannot be re-leased — the livelock is broken.
        pad_completed_at = await _get_game_evals_completed_at(
            eval_worker_session_maker, leased_zero_target_pad_id
        )
        assert pad_completed_at is not None, (
            "A zero-target game leased to this worker must be stamped evals_completed_at "
            "on entry-submit even though it never appeared in the submission body "
            "(CR-01: full-leased-set stamping prevents the re-lease livelock)."
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_id, *pad_ids])


@pytest.mark.asyncio
async def test_entry_submit_excludes_expired_lease(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """D-05 (Phase 148 item 5): entry-submit excludes a leased-but-expired game.

    Two games leased to the SAME worker_id (default X-Worker-Id-less
    "remote-worker" label) — one with a PAST entry_eval_lease_expiry, one with
    a FUTURE expiry. Only the future-expiry game may appear in the response
    game_ids / get evals_completed_at stamped; the past-expiry game must stay
    NULL (reclaimable by a fresh lease later), mirroring test_lease_reclaim's
    raw-SQL fixture style.
    """
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    game_expired = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
    game_active = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)

    now = datetime.now(timezone.utc)
    async with eval_worker_session_maker() as session:
        await session.execute(
            sa.text("""
                UPDATE games
                SET entry_eval_lease_expiry = :past_ts,
                    entry_eval_leased_by = 'remote-worker'
                WHERE id = :gid
            """),
            {"past_ts": now - timedelta(minutes=10), "gid": game_expired},
        )
        await session.execute(
            sa.text("""
                UPDATE games
                SET entry_eval_lease_expiry = :future_ts,
                    entry_eval_leased_by = 'remote-worker'
                WHERE id = :gid
            """),
            {"future_ts": now + timedelta(seconds=60), "gid": game_active},
        )
        await session.commit()

    payload = {"sf_version": "", "evals": []}

    try:
        async with _make_client() as client:
            resp = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()

        assert game_active in body["game_ids"], f"Future-expiry game must be in game_ids: {body}"
        assert game_expired not in body["game_ids"], (
            f"Past-expiry (expired) game must NOT be in game_ids: {body}"
        )

        active_completed_at = await _get_game_evals_completed_at(
            eval_worker_session_maker, game_active
        )
        assert active_completed_at is not None, (
            "Future-expiry game must be stamped evals_completed_at"
        )

        expired_completed_at = await _get_game_evals_completed_at(
            eval_worker_session_maker, game_expired
        )
        assert expired_completed_at is None, (
            "Past-expiry (expired) game must NOT be stamped evals_completed_at "
            "(D-05: entry_eval_lease_expiry > now() excludes it) — it stays "
            "reclaimable by a fresh lease"
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_expired, game_active])


@pytest.mark.asyncio
async def test_entry_submit_idempotent(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Double entry-submit is safe: no error, no duplicate flaws.

    ON CONFLICT DO NOTHING for flaws; re-stamping evals_completed_at is a no-op.
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    # Padding inserted FIRST (lower IDs); game with positions LAST (highest ID → LIFO).
    pad_ids: list[int] = []
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD - 1):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        pad_ids.append(gid)

    game_id = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [
            {"ply": ply, "full_hash": 12000 + ply, "phase": 1, "eval_cp": None, "eval_mate": None}
            for ply in range(4)
        ],
    )

    # Lease to get assigned plies.
    async with _make_client() as client:
        lease_resp = await client.post(_ENTRY_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN})
    assert lease_resp.status_code == 200
    our_positions = [p for p in lease_resp.json()["positions"] if p["game_id"] == game_id]

    evals = [
        {"game_id": game_id, "ply": p["ply"], "eval_cp": 42, "eval_mate": None}
        for p in our_positions
    ]
    payload = {"sf_version": "Stockfish 18", "evals": evals}

    try:
        async with _make_client() as client:
            resp1 = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
            resp2 = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp1.status_code == 200, (
            f"First submit: expected 200, got {resp1.status_code}: {resp1.text}"
        )
        assert resp2.status_code == 200, (
            f"Second submit: expected 200, got {resp2.status_code}: {resp2.text}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, [game_id, *pad_ids])


# Phase 149-03 PRUNE-01: test_scope_explicit_returns_only_tier1_2 /
# test_scope_idle_skips_tier1_2 / test_scope_absent_is_bundled (/lease?scope=
# param, Gen-1-specific) deleted — the scope param concept lives on identically
# on /atomic-lease (atomic_lease_eval_game passes scope straight through to the
# same claim_eval_job(), mirroring the deleted lease_eval_game's call site).


# ─── Phase 123 X-Worker-Id header tests ──────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_id_header_populates_leased_by_on_entry_lease(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """X-Worker-Id header on /entry-lease populates games.entry_eval_leased_by.

    Sends X-Worker-Id: box1 on the /entry-lease call. After the claim, asserts
    that the leased games carry entry_eval_leased_by='box1'.
    """
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    game_ids: list[int] = []
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        game_ids.append(gid)

    try:
        async with _make_client() as client:
            response = await client.post(
                _ENTRY_LEASE_URL,
                headers={"X-Operator-Token": _TEST_TOKEN, "X-Worker-Id": "box1"},
            )
        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )

        # The claim stamped entry_eval_leased_by='box1' on the leased games.
        # Read back from DB to verify — games without entry targets still get the lease.
        found_any = False
        for gid in game_ids:
            leased_by = await _get_game_entry_eval_leased_by(eval_worker_session_maker, gid)
            if leased_by is not None:
                assert leased_by == "box1", (
                    f"Game {gid}: entry_eval_leased_by must be 'box1', got {leased_by!r}"
                )
                found_any = True
        assert found_any, "At least one game must have been leased with entry_eval_leased_by='box1'"
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


@pytest.mark.asyncio
async def test_worker_id_absent_falls_back_to_remote_worker_on_entry_lease(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Absent X-Worker-Id header → entry_eval_leased_by = 'remote-worker' (D-10 fallback)."""
    from app.services.eval_drain import ENTRY_LEASE_BACKLOG_THRESHOLD

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    game_ids: list[int] = []
    for _ in range(ENTRY_LEASE_BACKLOG_THRESHOLD):
        gid = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        game_ids.append(gid)

    try:
        async with _make_client() as client:
            response = await client.post(
                _ENTRY_LEASE_URL,
                headers={"X-Operator-Token": _TEST_TOKEN},
                # No X-Worker-Id header.
            )
        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        found_any = False
        for gid in game_ids:
            leased_by = await _get_game_entry_eval_leased_by(eval_worker_session_maker, gid)
            if leased_by is not None:
                assert leased_by == "remote-worker", (
                    f"Game {gid}: absent X-Worker-Id must fall back to 'remote-worker', "
                    f"got {leased_by!r}"
                )
                found_any = True
        assert found_any, (
            "At least one game must have been leased with entry_eval_leased_by='remote-worker'"
        )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)


# Phase 149-03 PRUNE-01: test_worker_id_header_populates_leased_by_on_full_lease /
# test_worker_id_absent_falls_back_to_remote_worker_on_full_lease (/lease-only)
# deleted — worker_id_label is a shared dependency exercised identically by the
# kept entry-lease variants above; /atomic-lease calls claim_eval_job(worker_id=
# worker_id, ...) the same way the deleted lease_eval_game did.


# ─── Phase 142 MPV-02: SubmitEval second-best fields + blob tests ─────────────

# 6-ply game for blob tests (same structure as drain test _SIX_PLY_PGN).
_SIX_PLY_PGN_142: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *"

# Blunder eval sequence for _SIX_PLY_PGN_142 (position plies 0-6).
# Post-move storage shift via _post_move_eval(pos_eval, row_ply) = pos_eval[row_ply + 1]:
#   row 0 = pos_eval[1] = 20, row 1 = pos_eval[2] = 30,
#   row 2 = pos_eval[3] = -500  ← blunder (white win-prob 53%→7% at ply 2),
#   row 3 = pos_eval[4] = -480, row 4 = pos_eval[5] = 60, row 5 = pos_eval[6] = 30.
# ply=0 eval is positional (no matching row; not stored).
_BLUNDER_SUBMIT_EVALS_142: list[dict[str, object]] = [
    {"ply": 0, "eval_cp": 0, "eval_mate": None, "best_move": None, "pv": None},
    {"ply": 1, "eval_cp": 20, "eval_mate": None, "best_move": "e2e4", "pv": None},
    {"ply": 2, "eval_cp": 30, "eval_mate": None, "best_move": "g1f3", "pv": None},
    {"ply": 3, "eval_cp": -500, "eval_mate": None, "best_move": "b8c6", "pv": None},
    {"ply": 4, "eval_cp": -480, "eval_mate": None, "best_move": "f1c4", "pv": None},
    {"ply": 5, "eval_cp": 60, "eval_mate": None, "best_move": "f8c5", "pv": None},
    {"ply": 6, "eval_cp": 30, "eval_mate": None, "best_move": None, "pv": None},  # terminal
]


# Phase 149 WR-02 (code review 2026-07-04): test_submit_eval_accepts_second_best_fields
# and test_submit_eval_schema_phase146_no_second_best_fields (both exercised the
# now-deleted Gen-1 SubmitEval schema in isolation) deleted along with the
# schema class itself. Equivalent coverage of the same second_cp/second_mate/
# second_uci removal lives on the live AtomicSubmitEval schema (Phase 147),
# which never carried those fields to begin with.


# Phase 149-03 PRUNE-01: TestMultipv2BlobsRemote (Phase 142 MPV-02 / Phase 146
# D-03 /submit blob-null behavior, all 3 methods /submit-only) deleted — moot
# once /submit no longer exists. The equivalent /atomic-submit coverage lives
# in TestAtomicSubmitEndpoint (test_atomic_submit_missing_blob_writes_null_tag
# and test_atomic_submit_gates_tactic_tag_and_stamps_both_markers).


# Phase 149-03 PRUNE-01: test_submit_phase146_build_blob_not_called and
# test_submit_phase146_blobs_null_both_markers_stamped (/submit-only) deleted —
# moot once /submit no longer exists. Equivalent atomic-lane coverage lives in
# TestAtomicSubmitEndpoint.


# ─── Phase 145 SHIP-01: FlawBlob lease/submit schema tests ───────────────────

_FLAW_BLOB_LEASE_URL = "/api/eval/remote/flaw-blob-lease"


def test_flaw_blob_schema_lease_position() -> None:
    """FlawBlobLeasePosition holds token + fen (D-04 schema, Task 1)."""
    from app.schemas.eval_remote import FlawBlobLeasePosition

    pos = FlawBlobLeasePosition(
        token="10:missed:0", fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"
    )
    assert pos.token == "10:missed:0"
    assert "rnbqkbnr" in pos.fen


def test_flaw_blob_schema_lease_response() -> None:
    """FlawBlobLeaseResponse holds game_id, positions, leased_at (D-04 schema)."""
    from datetime import datetime, timezone

    from app.schemas.eval_remote import FlawBlobLeasePosition, FlawBlobLeaseResponse

    now = datetime.now(timezone.utc)
    pos = FlawBlobLeasePosition(token="4:allowed:1", fen="8/8/8/8/8/8/8/8 w - - 0 1")
    resp = FlawBlobLeaseResponse(game_id=42, positions=[pos], leased_at=now)
    assert resp.game_id == 42
    assert len(resp.positions) == 1
    assert resp.leased_at == now


def test_flaw_blob_schema_submit_eval_fields() -> None:
    """FlawBlobSubmitEval holds all required fields; second_uci=None allowed (D-04 Pitfall 3)."""
    from app.schemas.eval_remote import FlawBlobSubmitEval

    ev = FlawBlobSubmitEval(
        token="10:missed:0",
        best_cp=100,
        best_mate=None,
        second_cp=25,
        second_mate=None,
        second_uci="d2d4",
    )
    assert ev.token == "10:missed:0"
    assert ev.best_cp == 100
    assert ev.second_uci == "d2d4"

    # second_uci=None is valid on the wire (single-legal-move sentinel)
    ev_null_uci = FlawBlobSubmitEval(
        token="10:allowed:2",
        best_cp=None,
        best_mate=None,
        second_cp=None,
        second_mate=None,
        second_uci=None,
    )
    assert ev_null_uci.second_uci is None


def test_flaw_blob_schema_submit_request_max_length() -> None:
    """FlawBlobSubmitRequest.evals rejects >MAX_SUBMIT_EVALS entries (DoS guard)."""
    from app.schemas.eval_remote import MAX_SUBMIT_EVALS, FlawBlobSubmitEval, FlawBlobSubmitRequest

    import pytest

    ok_evals = [
        FlawBlobSubmitEval(
            token=f"0:missed:{k}",
            best_cp=0,
            best_mate=None,
            second_cp=None,
            second_mate=None,
            second_uci=None,
        )
        for k in range(MAX_SUBMIT_EVALS)
    ]
    req = FlawBlobSubmitRequest(game_id=1, sf_version="Stockfish 18", evals=ok_evals)
    assert len(req.evals) == MAX_SUBMIT_EVALS

    too_many = ok_evals + [
        FlawBlobSubmitEval(
            token="0:missed:1024",
            best_cp=0,
            best_mate=None,
            second_cp=None,
            second_mate=None,
            second_uci=None,
        )
    ]
    with pytest.raises(Exception):
        FlawBlobSubmitRequest(game_id=1, sf_version="Stockfish 18", evals=too_many)


def test_flaw_blob_schema_submit_response() -> None:
    """FlawBlobSubmitResponse holds game_id + blobs_written (D-04 schema)."""
    from app.schemas.eval_remote import FlawBlobSubmitResponse

    resp = FlawBlobSubmitResponse(game_id=7, blobs_written=3)
    assert resp.game_id == 7
    assert resp.blobs_written == 3


# ─── Phase 177 PROTO-01/PROTO-03: protocol v2 schema tests ───────────────────


def test_lease_position_move_uci_defaults_none() -> None:
    """LeasePosition validates without move_uci (v1-compatible payload shape);
    move_uci defaults to None when omitted."""
    from app.schemas.eval_remote import LeasePosition

    pos = LeasePosition(
        ply=0, fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", is_terminal=False
    )
    assert pos.move_uci is None

    pos_with_move = LeasePosition(
        ply=0,
        fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        is_terminal=False,
        move_uci="e2e4",
    )
    assert pos_with_move.move_uci == "e2e4"


def test_atomic_second_best_eval_rejects_out_of_range_ply() -> None:
    """AtomicSecondBestEval rejects a ply beyond MAX_PLY (per-field Pydantic bound,
    mirrors AtomicSubmitEval's own ply bound)."""
    import pytest
    from pydantic import ValidationError

    from app.schemas.eval_remote import MAX_PLY, AtomicSecondBestEval

    ev = AtomicSecondBestEval(ply=MAX_PLY, second_cp=10, second_mate=None, second_uci="e2e4")
    assert ev.ply == MAX_PLY

    with pytest.raises(ValidationError):
        AtomicSecondBestEval(ply=MAX_PLY + 1, second_cp=10, second_mate=None, second_uci="e2e4")


def test_atomic_submit_request_second_best_defaults_empty() -> None:
    """AtomicSubmitRequest validates with second_best omitted (v1 worker payload
    shape) and defaults to an empty list."""
    from app.schemas.eval_remote import AtomicSubmitRequest

    req = AtomicSubmitRequest(
        game_id=1,
        sf_version="Stockfish 18",
        worker_schema_version=1,
        evals=[],
        blob_nodes=[],
    )
    assert req.second_best == []


# ─── Phase 145 Plan 03: POST /eval/remote/flaw-blob-lease endpoint tests ────

# PGN for flaw-blob-lease endpoint tests: 6-half-move game.
# Flaw at ply=2 (e5 position). Missed PV walks from ply=2, allowed from ply=3.
_FLAW_LEASE_PGN: str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 *"
# Walkable PVs for the positions at ply 2 and ply 3:
_WALKABLE_PV_PLY2: str = "g1f3 b8c6"  # 2 moves → 3 nodes (k=0,1,2) for missed
_WALKABLE_PV_PLY3: str = "b8c6"  # 1 move → 2 nodes (k=0,1) for allowed


async def _insert_flaw_for_lease_test(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    ply: int = 2,
) -> None:
    """Insert a GameFlaw row with allowed_pv_lines = SQL NULL (not set) for blob-lease tests."""
    from app.models.game_flaw import GameFlaw

    async with session_maker() as session:
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
            fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
        )
        # Do NOT set allowed_pv_lines → SQL NULL (asyncpg JSONB caution)
        session.add(flaw)
        await session.commit()


async def _insert_game_position_pv(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    game_id: int,
    ply: int,
    pv: str | None,
) -> None:
    """Insert a GamePosition row with the given PV string and commit."""
    from app.models.game_position import GamePosition

    async with session_maker() as session:
        gp = GamePosition(
            user_id=user_id,
            game_id=game_id,
            ply=ply,
            full_hash=hash((game_id, ply)) & 0x7FFFFFFFFFFFFFFF,
            white_hash=0,
            black_hash=0,
            pv=pv,
        )
        session.add(gp)
        await session.commit()


class TestFlawBlobLeaseEndpoint:
    """Phase 145 Plan 03: POST /eval/remote/flaw-blob-lease endpoint.

    Tests:
    - blob_lease_empty_queue_returns_204: no tier-4 pick → 204
    - blob_lease_requires_operator_token: missing/wrong token → 403/401
    - blob_lease_returns_positions: walkable game → FlawBlobLeaseResponse with tokens
    - blob_lease_token_parses_correctly: tokens parse to (flaw_ply, line, node_k)
    - blob_lease_all_sentinel_game_no_loop: all-sentinel game → 204 (sentinels written, no loop)
    - blob_lease_over_cap_sentinels_all_null_blob_flaws: >MAX_SUBMIT_EVALS lease positions →
      204 (not 500), every NULL-blob flaw ply sentineled, existing tactic tags unchanged (SEED-073)

    Phase 149-03 PRUNE-01: the isolation-proof test verifying the (now-deleted) Gen-1
    /submit endpoint was unaffected by this lease has itself been removed.
    """

    @pytest.mark.asyncio
    async def test_blob_lease_requires_operator_token(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Missing operator token → 403 (fail-closed); wrong token → 401."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", "")
        async with _make_client() as client:
            resp = await client.post(_FLAW_BLOB_LEASE_URL)
        assert resp.status_code == 403, f"Expected 403, got {resp.status_code}: {resp.text}"

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        async with _make_client() as client:
            resp = await client.post(
                _FLAW_BLOB_LEASE_URL, headers={"X-Operator-Token": "bad-token"}
            )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_blob_lease_empty_queue_returns_204(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """No tier-4 pick available → 204 (empty backfill queue)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        # Patch _claim_tier4_blob to return None (empty queue)
        monkeypatch.setattr(eval_remote_module, "_claim_tier4_blob", AsyncMock(return_value=None))

        async with _make_client() as client:
            resp = await client.post(
                _FLAW_BLOB_LEASE_URL,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 204, f"Expected 204, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_blob_lease_returns_positions(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Walkable game → FlawBlobLeaseResponse with game_id, positions, leased_at."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        # Insert walkable PV strings at ply 2 (missed start) and ply 3 (allowed start)
        await _insert_game_position_pv(
            eval_worker_session_maker, user_id, game_id, 2, _WALKABLE_PV_PLY2
        )
        await _insert_game_position_pv(
            eval_worker_session_maker, user_id, game_id, 3, _WALKABLE_PV_PLY3
        )

        # Patch _claim_tier4_blob to return this specific game
        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_blob",
            AsyncMock(return_value=(game_id, user_id)),
        )

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _FLAW_BLOB_LEASE_URL,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            body = resp.json()
            assert body["game_id"] == game_id, (
                f"Expected game_id={game_id}, got {body.get('game_id')}"
            )
            assert "leased_at" in body, "Response must include leased_at"
            positions = body["positions"]
            assert len(positions) > 0, "Expected non-empty positions list"
            # Each position must have token and fen
            for pos in positions:
                assert "token" in pos, f"Position missing token: {pos}"
                assert "fen" in pos, f"Position missing fen: {pos}"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_blob_lease_token_parses_correctly(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Tokens parse back to expected (flaw_ply, line, node_k) components."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        await _insert_game_position_pv(
            eval_worker_session_maker, user_id, game_id, 2, _WALKABLE_PV_PLY2
        )
        await _insert_game_position_pv(
            eval_worker_session_maker, user_id, game_id, 3, _WALKABLE_PV_PLY3
        )

        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_blob",
            AsyncMock(return_value=(game_id, user_id)),
        )

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _FLAW_BLOB_LEASE_URL,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            positions = resp.json()["positions"]

            # Verify token format: "{flaw_ply}:{line}:{node_k}"
            for pos in positions:
                parts = pos["token"].split(":")
                assert len(parts) == 3, f"Token must have 3 ':'-separated parts: {pos['token']!r}"
                flaw_ply_str, line, node_k_str = parts
                assert flaw_ply_str.isdigit(), f"flaw_ply must be int: {pos['token']!r}"
                assert line in ("missed", "allowed"), (
                    f"line must be missed/allowed: {pos['token']!r}"
                )
                assert node_k_str.isdigit(), f"node_k must be int: {pos['token']!r}"
                assert int(flaw_ply_str) == 2, f"flaw_ply must be 2 for this test: {pos['token']!r}"

            # SEED-079: only even (solver) node_k are leased — defender nodes skipped.
            # Missed line: 2-move PV → walk nodes 0,1,2 → even tokens k=0,2.
            missed_ks = sorted(
                int(p["token"].split(":")[2]) for p in positions if ":missed:" in p["token"]
            )
            assert missed_ks == [0, 2], f"Expected missed k=[0,2] (even only), got {missed_ks}"
            # Allowed line: 1-move PV → walk nodes 0,1 → even token k=0.
            allowed_ks = sorted(
                int(p["token"].split(":")[2]) for p in positions if ":allowed:" in p["token"]
            )
            assert allowed_ks == [0], f"Expected allowed k=[0] (even only), got {allowed_ks}"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_blob_lease_all_sentinel_game_no_loop(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """All-sentinel game: endpoint writes [] sentinels, returns 204 (forward progress, T-145-07)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        from app.models.game_flaw import GameFlaw

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        # Insert flaw but NO game_positions with pv → NULL pv at both plies → all-sentinel
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        # No game_positions rows → board_at_ply will be empty → sentinel for both lines

        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_blob",
            AsyncMock(return_value=(game_id, user_id)),
        )

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _FLAW_BLOB_LEASE_URL,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            # All-sentinel game → 204 (forward progress, no empty lease returned)
            assert resp.status_code == 204, (
                f"Expected 204 for all-sentinel game, got {resp.status_code}: {resp.text}"
            )

            # Verify sentinels were written: allowed_pv_lines must be [] (not SQL NULL)
            # so the game no longer matches the tier-4 predicate
            async with eval_worker_session_maker() as verify:
                flaw_rows = (
                    await verify.execute(
                        sa.select(
                            GameFlaw.ply,
                            GameFlaw.allowed_pv_lines,
                            GameFlaw.missed_pv_lines,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).all()

            assert len(flaw_rows) == 1, f"Expected 1 flaw row, got {len(flaw_rows)}"
            _flaw_ply, allowed, missed = flaw_rows[0]
            # After sentinel write, blobs are [] (not NULL) — game leaves the predicate
            assert allowed is not None, (
                "allowed_pv_lines must be non-NULL (sentinel []) after all-sentinel lease"
            )
            assert missed is not None, (
                "missed_pv_lines must be non-NULL (sentinel []) after all-sentinel lease"
            )
            assert allowed == [], f"allowed_pv_lines must be sentinel [], got {allowed!r}"
            assert missed == [], f"missed_pv_lines must be sentinel [], got {missed!r}"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_blob_lease_over_cap_sentinels_all_null_blob_flaws(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """SEED-073: >MAX_SUBMIT_EVALS lease positions → 204 (not 500).

        Fat games used to raise a Pydantic ValidationError when FlawBlobLeaseResponse
        (positions max_length=MAX_SUBMIT_EVALS) was constructed with an oversized list,
        surfacing as a 500 and looping forever in the tier-4 lottery. The over-cap branch
        must sentinel EVERY NULL-blob flaw ply of the game (not just the un-walkable
        sentinel_lines the mocked builder happens to report) and leave existing tactic
        tags untouched — sentinel-ing must not run the gated retag.

        Real seeding of >1024 walkable positions is impractical (would require a PGN with
        hundreds of flaws and long PVs), so _build_flaw_blob_lease_positions is monkeypatched
        to return an oversized lease_positions list. The NULL-blob flaw plies it sentinels
        are queried live from real GameFlaw rows, so the write path itself is exercised
        end-to-end against the real DB.
        """
        import app.routers.eval_remote as eval_remote_module
        from app.models.game_flaw import GameFlaw
        from app.schemas.eval_remote import MAX_SUBMIT_EVALS, FlawBlobLeasePosition

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        # Two NULL-blob flaws with pre-existing tactic tags — the over-cap sentinel write
        # must leave these tags exactly as they were (no gated retag runs).
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=4)
        async with eval_worker_session_maker() as tag_session:
            await tag_session.execute(
                sa.update(GameFlaw)
                .where(GameFlaw.game_id == game_id, GameFlaw.ply == 2)
                .values(allowed_tactic_motif=5, missed_tactic_motif=None)
            )
            await tag_session.execute(
                sa.update(GameFlaw)
                .where(GameFlaw.game_id == game_id, GameFlaw.ply == 4)
                .values(allowed_tactic_motif=None, missed_tactic_motif=9)
            )
            await tag_session.commit()

        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_blob",
            AsyncMock(return_value=(game_id, user_id)),
        )
        # Oversized lease: > MAX_SUBMIT_EVALS walkable positions, no sentinel_lines.
        oversized_positions = [
            FlawBlobLeasePosition(token=f"2:missed:{k}", fen="8/8/8/8/8/8/8/8 w - - 0 1")
            for k in range(MAX_SUBMIT_EVALS + 1)
        ]
        monkeypatch.setattr(
            eval_remote_module,
            "_build_flaw_blob_lease_positions",
            AsyncMock(return_value=(oversized_positions, set())),
        )

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _FLAW_BLOB_LEASE_URL,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 204, (
                f"Expected 204 for over-cap game, got {resp.status_code}: {resp.text}"
            )

            async with eval_worker_session_maker() as verify:
                flaw_rows = (
                    await verify.execute(
                        sa.select(
                            GameFlaw.ply,
                            GameFlaw.allowed_pv_lines,
                            GameFlaw.missed_pv_lines,
                            GameFlaw.allowed_tactic_motif,
                            GameFlaw.missed_tactic_motif,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).all()

            assert len(flaw_rows) == 2, f"Expected 2 flaw rows, got {len(flaw_rows)}"
            by_ply = {row.ply: row for row in flaw_rows}

            # Zero NULL-blob flaws remain — both plies sentineled in one pass.
            for ply, row in by_ply.items():
                assert row.allowed_pv_lines == [], (
                    f"ply {ply}: allowed_pv_lines must be sentinel [], got {row.allowed_pv_lines!r}"
                )
                assert row.missed_pv_lines == [], (
                    f"ply {ply}: missed_pv_lines must be sentinel [], got {row.missed_pv_lines!r}"
                )

            # Tactic tags unchanged — the sentinel write does not run the gated retag.
            assert by_ply[2].allowed_tactic_motif == 5, (
                "ply 2 allowed_tactic_motif must be unchanged"
            )
            assert by_ply[2].missed_tactic_motif is None, (
                "ply 2 missed_tactic_motif must be unchanged"
            )
            assert by_ply[4].allowed_tactic_motif is None, (
                "ply 4 allowed_tactic_motif must be unchanged"
            )
            assert by_ply[4].missed_tactic_motif == 9, "ply 4 missed_tactic_motif must be unchanged"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])


# ─── Phase 147 Plan 04 Task 2: POST /eval/remote/atomic-lease (SEED-074 Part B) ──

_ATOMIC_LEASE_URL = "/api/eval/remote/atomic-lease"
_ATOMIC_SUBMIT_URL = "/api/eval/remote/atomic-submit"


class TestAtomicLeaseEndpoint:
    """Tests for the NEW /atomic-lease endpoint (D-02 — does not touch /lease).

    - test_atomic_lease_requires_operator_token: empty server token → 403.
    - test_atomic_lease_wrong_operator_token: configured token, wrong header → 401.
    - test_atomic_lease_no_pending_games: no eligible game → 204.
    - test_atomic_lease_returns_positions: eligible game → 200, well-formed
      AtomicLeaseResponse (FEN-per-ply positions, exactly one is_terminal=True).
    - test_atomic_lease_over_cap_releases_job_and_returns_204: >MAX_SUBMIT_EVALS
      lease positions → 204, not 500 (147-03/SEED-073 over-cap sentinel pattern);
      a held tier-1/2 job is released back to 'pending' instead of staying leased.
    - test_atomic_lease_lichess_eval_game_returns_full_positions: is_lichess_eval_game=True
      claim → 200 with is_lichess_eval_game=True and every ply leased, not the
      near-empty lease the SEED-076 redundancy filter would otherwise produce
      (Phase 174-06/SEED-109 — replaces the retired 204-defer test the Gen-1 lane
      used to port here per 149-RESEARCH.md Pitfall 1).
    """

    @pytest.mark.asyncio
    async def test_atomic_lease_requires_operator_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Empty server EVAL_OPERATOR_TOKEN → 403 (fail-closed per T-120-01)."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", "")
        async with _make_client() as client:
            response = await client.post(_ATOMIC_LEASE_URL)
        assert response.status_code == 403, (
            f"Expected 403, got {response.status_code}: {response.text}"
        )

    @pytest.mark.asyncio
    async def test_atomic_lease_wrong_operator_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Configured token but wrong header value → 401."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        async with _make_client() as client:
            response = await client.post(
                _ATOMIC_LEASE_URL, headers={"X-Operator-Token": "wrong-secret"}
            )
        assert response.status_code == 401, (
            f"Expected 401, got {response.status_code}: {response.text}"
        )

    @pytest.mark.asyncio
    async def test_atomic_lease_no_pending_games(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """No eligible game in the queue → 204 (empty response)."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        import app.routers.eval_remote as eval_remote_module

        claim_mock = AsyncMock(return_value=None)
        monkeypatch.setattr(eval_remote_module, "claim_eval_job", claim_mock)

        async with _make_client() as client:
            response = await client.post(
                _ATOMIC_LEASE_URL,
                params={"worker_schema_version": 2},
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert response.status_code == 204, (
            f"Expected 204, got {response.status_code}: {response.text}"
        )
        claim_mock.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_atomic_lease_returns_positions(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Eligible game → 200 with a well-formed AtomicLeaseResponse.

        Mirrors test_lease_returns_positions: seeds a 4-half-move game, claims it as
        a tier-3 pick, asserts the same FEN-per-ply shape (positions non-empty,
        exactly one is_terminal=True, every position has a non-empty FEN).
        """
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 51000 + ply, "eval_cp": None, "eval_mate": None}
                for ply in range(4)
            ],
        )

        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(
            eval_remote_module,
            "claim_eval_job",
            AsyncMock(
                return_value=ClaimedJob(
                    game_id=game_id,
                    user_id=user_id,
                    tier=3,
                    is_lichess_eval_game=False,
                    job_id=None,
                )
            ),
        )

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_LEASE_URL,
                    params={"worker_schema_version": 2},
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )

            assert response.status_code == 200, (
                f"Expected 200, got {response.status_code}: {response.text}"
            )
            body = response.json()
            assert body["game_id"] == game_id
            assert body["user_id"] == user_id
            assert body["is_lichess_eval_game"] is False
            assert body["job_id"] is None

            positions = body["positions"]
            assert len(positions) > 0, "positions must be non-empty"

            terminal_positions = [p for p in positions if p["is_terminal"]]
            assert len(terminal_positions) == 1, (
                f"Expected exactly 1 is_terminal=True position, got {len(terminal_positions)}: "
                f"{terminal_positions}"
            )
            for pos in positions:
                assert pos["fen"], f"position at ply {pos['ply']} has empty FEN"
                assert "ply" in pos and isinstance(pos["ply"], int)
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_lease_over_cap_releases_job_and_returns_204(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """>MAX_SUBMIT_EVALS lease positions → 204, not 500 (over-cap sentinel).

        A real chess game essentially never reaches MAX_SUBMIT_EVALS (1024) plies,
        so _build_lease_positions is monkeypatched to return an oversized list
        (mirroring how 147-03's flaw-blob-lease over-cap test simulates a fat
        game). The held tier-1 job must be released back to 'pending' rather than
        left stuck 'leased' — asserted via a spied release_job.
        """
        from app.schemas.eval_remote import MAX_SUBMIT_EVALS, LeasePosition

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        import app.routers.eval_remote as eval_remote_module

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id)
        held_job_id = 424242

        monkeypatch.setattr(
            eval_remote_module,
            "claim_eval_job",
            AsyncMock(
                return_value=ClaimedJob(
                    game_id=game_id,
                    user_id=user_id,
                    tier=1,
                    is_lichess_eval_game=False,
                    job_id=held_job_id,
                )
            ),
        )
        release_job_mock = AsyncMock(return_value=None)
        monkeypatch.setattr(eval_remote_module, "release_job", release_job_mock)

        oversized_positions = [
            LeasePosition(ply=ply, fen="8/8/8/8/8/8/8/8 w - - 0 1", is_terminal=False)
            for ply in range(MAX_SUBMIT_EVALS + 1)
        ]
        monkeypatch.setattr(
            eval_remote_module,
            "_build_lease_positions",
            lambda *args, **kwargs: oversized_positions,
        )

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_LEASE_URL,
                    params={"worker_schema_version": 2},
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert response.status_code == 204, (
                f"Expected 204 for over-cap game, got {response.status_code}: {response.text}"
            )
            release_job_mock.assert_awaited_once_with(held_job_id)
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_lease_lichess_eval_game_returns_full_positions(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Phase 174-06 (SEED-109): lichess-eval games are NO LONGER deferred at
        /atomic-lease — replaces the retired test_atomic_lease_lichess_eval_game_releases_lease
        (the D-4/v1-scope 204 skip it ported from the Gen-1 lane is gone; they now
        lease and submit like any other game).

        Every game_positions row already carries a %eval (the defining lichess-eval
        shape). Asserts the lease is NOT collapsed to near-nothing by the SEED-076
        incremental-redundancy filter, which would otherwise treat every already-
        eval'd row as "a worker already resolved this" — a premise that does not
        hold for lichess-eval games, whose %evals came from import, never an
        engine call (`_build_lease_positions`'s Phase 174-06 docstring).
        """
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker, user_id, pgn="1. e4 e5 2. Nf3 Nc6 *"
        )
        # Every row already carries a %eval — the lichess-eval shape (import-supplied,
        # never engine-derived).
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 52000 + ply, "eval_cp": 20 + ply, "eval_mate": None}
                for ply in range(4)
            ],
        )

        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(
            eval_remote_module,
            "claim_eval_job",
            AsyncMock(
                return_value=ClaimedJob(
                    game_id=game_id,
                    user_id=user_id,
                    tier=1,
                    is_lichess_eval_game=True,
                    job_id=None,
                )
            ),
        )

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_LEASE_URL,
                    params={"worker_schema_version": 2},
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )

            assert response.status_code == 200, (
                f"lichess-eval game must lease like any other game, got "
                f"{response.status_code}: {response.text}"
            )
            body = response.json()
            assert body["is_lichess_eval_game"] is True

            positions = body["positions"]
            # All 4 real plies leased, none redundancy-omitted, and NO terminal
            # donor (lichess games never need one — their %evals are never shifted).
            assert len(positions) == 4, (
                "Expected all 4 plies leased (no SEED-076 redundancy omission for "
                f"lichess-eval games), got {len(positions)}: {positions}"
            )
            assert all(not p["is_terminal"] for p in positions), (
                "a lichess-eval game's lease must not include a terminal eval-donor "
                "position — its %evals are never shifted (Phase 174-06)"
            )
            assert {p["ply"] for p in positions} == {0, 1, 2, 3}
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_lease_v1_worker_204(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Phase 177 PROTO-01/S-03: a v1 worker (worker_schema_version=1, or the
        param omitted entirely) gets 204 no-work on the WHOLE atomic lane — for
        BOTH scope=explicit and scope=idle — even with an eligible game present
        and claim_eval_job mocked to succeed. The gate fires BEFORE any claim
        attempt (Pitfall 4), asserted via claim_eval_job never being awaited.
        """
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 53000 + ply, "eval_cp": None, "eval_mate": None}
                for ply in range(2)
            ],
        )

        import app.routers.eval_remote as eval_remote_module

        try:
            for scope in ("explicit", "idle"):
                for params in (
                    {"scope": scope, "worker_schema_version": 1},
                    {"scope": scope},  # param omitted entirely — un-updated binary
                ):
                    claim_mock = AsyncMock(
                        return_value=ClaimedJob(
                            game_id=game_id,
                            user_id=user_id,
                            tier=3,
                            is_lichess_eval_game=False,
                            job_id=None,
                        )
                    )
                    monkeypatch.setattr(eval_remote_module, "claim_eval_job", claim_mock)

                    async with _make_client() as client:
                        response = await client.post(
                            _ATOMIC_LEASE_URL,
                            params=params,
                            headers={"X-Operator-Token": _TEST_TOKEN},
                        )
                    assert response.status_code == 204, (
                        f"Expected 204 for v1 worker (params={params}), got "
                        f"{response.status_code}: {response.text}"
                    )
                    claim_mock.assert_not_awaited()
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_lease_v2_worker_carries_move_uci(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Phase 177 PROTO-01: a v2 lease of a game with a played mainline returns
        positions whose move_uci equals the played UCI at each non-terminal ply
        (None for the terminal donor)."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker, user_id, pgn="1. e4 e5 2. Nf3 Nc6 *"
        )
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 54000 + ply, "eval_cp": None, "eval_mate": None}
                for ply in range(4)
            ],
        )

        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(
            eval_remote_module,
            "claim_eval_job",
            AsyncMock(
                return_value=ClaimedJob(
                    game_id=game_id,
                    user_id=user_id,
                    tier=3,
                    is_lichess_eval_game=False,
                    job_id=None,
                )
            ),
        )

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_LEASE_URL,
                    params={"worker_schema_version": 2},
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert response.status_code == 200, (
                f"Expected 200, got {response.status_code}: {response.text}"
            )
            positions = response.json()["positions"]
            expected_uci_by_ply = {0: "e2e4", 1: "e7e5", 2: "g1f3", 3: "b8c6"}
            move_uci_by_ply = {p["ply"]: p["move_uci"] for p in positions if not p["is_terminal"]}
            assert move_uci_by_ply == expected_uci_by_ply, (
                f"Expected {expected_uci_by_ply}, got {move_uci_by_ply}"
            )
            terminal = [p for p in positions if p["is_terminal"]]
            assert len(terminal) == 1
            assert terminal[0]["move_uci"] is None, "the terminal eval-donor has no played move"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])


class TestAtomicSubmitEndpoint:
    """Tests for the NEW /atomic-submit endpoint (Phase 147 SEED-074 Part B, D-01/D-02).

    - test_atomic_submit_gates_tactic_tag_and_stamps_both_markers: a real forcing
      blob submitted for the server-classified flaw -> the GATED tag is persisted
      AND both completion markers are stamped, atomically, in one call.
    - test_atomic_submit_lichess_eval_game_produces_best_move_candidate_row
      (Phase 174-06/SEED-109): a lichess-eval game's atomic-submit — no
      second-best in the payload (remote worker is MultiPV-1) — produces a
      GameBestMove row for its out-of-book played==best ply via the Pitfall-1
      targeted backend fallback, while the stored lichess %evals stay untouched.
    - test_atomic_submit_missing_blob_writes_null_tag: a walkable flaw with zero
      submitted blob_nodes -> the tag is suppressed to NULL (Part A net), completion
      is still stamped (blobs_pending=True — see the deviation documented in
      _apply_atomic_submit's docstring).
    - test_atomic_submit_drops_blob_for_non_flaw_ply: a blob token for an in-range
      ply the server does not classify as a flaw -> silently dropped, no error.
    - test_atomic_submit_foreign_token_rejected: a token whose flaw_ply falls
      outside the game's ply range -> 422, nothing persisted (T-147-02 tamper guard).
    - test_atomic_submit_over_cap_payload_rejected_by_schema: an evals list beyond
      MAX_SUBMIT_EVALS -> Pydantic 422 before the handler runs, so no write is ever
      attempted (the over-cap game itself is already sentineled at /atomic-lease,
      147-04; this covers the submit side's own structural cap as defense-in-depth).
    - test_atomic_submit_holed_batch_under_cap_leaves_pending (CR-01, Path B): a
      NULL-hole engine-game ply on the first attempt must NOT stamp either
      completion marker, must increment full_eval_attempts, and must NOT signal
      flaw completion (IN-01).
    - test_atomic_submit_holed_batch_at_cap_stamps_with_sentry_warning (CR-01,
      Path C): the same hole, but full_eval_attempts is already at
      MAX_EVAL_ATTEMPTS - 1 -> stamps anyway, emits one aggregated Sentry warning,
      and DOES signal flaw completion.
    - test_atomic_submit_with_job_id_stamps_eval_jobs / _late_job_id_is_noop /
      _without_job_id_does_not_touch_eval_jobs: port TestTier1Claiming's job_id ->
      eval_jobs completion-stamping coverage to the atomic lane (Phase 149-03 Task
      1, 149-RESEARCH.md Pitfall 1) before the Gen-1 /lease+/submit pair and its
      tests are deleted in Task 2/3.
    """

    @pytest.mark.asyncio
    async def test_atomic_submit_gates_tactic_tag_and_stamps_both_markers(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Real forcing blob for the server-classified flaw -> GATED tag + both
        completion markers stamped atomically in one /atomic-submit call.

        Mirrors test_submit_suppresses_cp_flaw_tag_then_blob_submit_self_heals's
        setup (_SIX_PLY_PGN_142 / _BLUNDER_SUBMIT_EVALS_142, blunder at ply 2,
        pre_flaw_eval_cp = positions[1].eval_cp = 30). _detect_tactic_for_flaw is
        monkeypatched to a fixed HANGING_PIECE motif on "allowed" (deterministic,
        independent of real PV pattern matching, mirrors
        tests/scripts/test_retag_flaws.py::TestPreFlawEvalParity._patch_detector).
        _assemble_flaw_blobs_from_submit is monkeypatched to return a hand-built
        forcing blob so the REAL forcing-line gate genuinely runs and passes —
        proving the gate fires within this single call, not just that some tag
        exists.
        """
        import app.routers.eval_remote as eval_remote_module
        import app.services.flaws_service as flaws_service_module
        from app.models.game import Game
        from app.models.game_flaw import GameFlaw
        from app.services.forcing_line_gate import PvNode
        from app.services.tactic_detector import TACTIC_CONFIDENCE_HIGH, TacticMotifInt

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

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

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51100 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        forcing_allowed_blob: list[PvNode] = [
            {"b": -800, "bm": None, "s": 0, "sm": None, "su": "b8c6"},
            {"b": 300, "bm": None, "s": 250, "sm": None, "su": "f1c4"},
            {"b": -800, "bm": None, "s": 0, "sm": None, "su": "f8c5"},
        ]

        def _fake_assemble(
            game_id_arg: int, submit_evals: object, sentinel_lines: object
        ) -> dict[int, tuple[list[PvNode], list[PvNode]]]:
            return {2: (forcing_allowed_blob, [])}

        monkeypatch.setattr(eval_remote_module, "_assemble_flaw_blobs_from_submit", _fake_assemble)

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": list(_BLUNDER_SUBMIT_EVALS_142),
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

            async with eval_worker_session_maker() as verify:
                flaw_row = (
                    await verify.execute(
                        select(
                            GameFlaw.ply,
                            GameFlaw.allowed_tactic_motif,
                            GameFlaw.missed_tactic_motif,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).one()
                flaw_ply, allowed_motif, missed_motif = flaw_row
                assert flaw_ply == 2, f"Flaw must be at ply 2, got {flaw_ply}"
                assert allowed_motif == int(TacticMotifInt.HANGING_PIECE), (
                    "Real forcing blob must pass the gate and persist the GATED tag "
                    "in the same atomic-submit call"
                )
                assert missed_motif is None

                game_row = (
                    await verify.execute(
                        select(Game.full_evals_completed_at, Game.full_pv_completed_at).where(
                            Game.id == game_id
                        )
                    )
                ).one()
                full_evals_at, full_pv_at = game_row
                assert full_evals_at is not None, (
                    "full_evals_completed_at must be stamped atomically with the gated tag"
                )
                assert full_pv_at is not None, (
                    "full_pv_completed_at must be stamped atomically with the gated tag"
                )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_lichess_eval_game_produces_best_move_candidate_row(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Phase 174-06 (SEED-109): a lichess-eval game's /atomic-submit produces a
        GameBestMove row for its out-of-book played==best ply via the Pitfall-1
        targeted backend fallback (the worker's own pass is MultiPV-1, so
        second_best_map is None — `_build_best_move_candidates` docstring), while
        the stored lichess %evals stay byte-identical (never shifted/overwritten).

        Game: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Na5 (8 plies) — book depth 7
        (find_opening_ply_count), so ply 7 (Na5, c6a5) is the first out-of-book
        ply. Every submitted eval carries a best_move matching the played move so
        no ply is left holed; only ply 7's fallback second-best creates a wide
        enough margin to pass the inaccuracy gate.
        """
        import app.services.eval_apply as eval_apply_module
        from app.models.game import Game
        from app.models.game_best_move import GameBestMove

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        # ply 7 (Na5) is BLACK to move — cp is White-POV throughout, so a wide
        # margin FOR BLACK needs best_cp very negative and the fallback's
        # second_cp comparatively positive (worse for black).
        fallback_spy = AsyncMock(return_value=(None, None, None, None, 300, None, "b7b5"))
        monkeypatch.setattr(
            eval_apply_module.engine_service, "evaluate_nodes_multipv2", fallback_spy
        )

        italian_pgn = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Na5 *"
        played_uci = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "c2c3", "c6a5"]
        now = datetime.now(timezone.utc)
        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=italian_pgn,
            lichess_evals_at=now,
        )
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 53000 + p, "eval_cp": 15 + p, "eval_mate": None}
                for p in range(8)
            ],
        )
        # Ply 7 is White to move (mover_color_for_ply(7 - 1)=... even ply=white);
        # _build_best_move_candidates needs a rating to pin the Maia ELO.
        async with eval_worker_session_maker() as rating_session:
            await rating_session.execute(
                sa.update(Game)
                .where(Game.id == game_id)
                .values(white_rating=1500, black_rating=1500, time_control_bucket="blitz")
            )
            await rating_session.commit()

        # Every ply carries a best_move matching the played move (no holes); ply 7
        # is the out-of-book played==best candidate, scored via the Pitfall-1
        # fallback (no second_cp/mate submitted — remote lane is MultiPV-1).
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": [
                {
                    "ply": p,
                    "eval_cp": -300 if p == 7 else None,
                    "eval_mate": None,
                    "best_move": played_uci[p],
                    "pv": None,
                }
                for p in range(8)
            ],
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            assert fallback_spy.await_count == 1, (
                "the Pitfall-1 targeted fallback must fire once for ply 7 "
                "(no second-best in the worker's MultiPV-1 submission)"
            )

            async with eval_worker_session_maker() as verify:
                best_move_row = (
                    await verify.execute(
                        select(GameBestMove).where(
                            GameBestMove.game_id == game_id, GameBestMove.ply == 7
                        )
                    )
                ).scalar_one_or_none()
                assert best_move_row is not None, (
                    "ply 7 (Na5, out-of-book played==best) must produce a "
                    "GameBestMove row via the remote-lane Pitfall-1 fallback"
                )
                assert best_move_row.maia_prob == pytest.approx(0.1, abs=1e-6)

                for ply in range(8):
                    gp = await _get_game_position(eval_worker_session_maker, game_id, ply)
                    assert gp is not None
                    assert gp["eval_cp"] == 15 + ply, (
                        f"lichess %eval at ply {ply} must be preserved unchanged "
                        "(SEED-109 item 4), never shifted/overwritten"
                    )
                    assert gp["best_move"] == played_uci[ply], (
                        f"best_move at ply {ply} must be written from the worker's submission"
                    )

                game_row = (
                    await verify.execute(select(Game.lichess_evals_at).where(Game.id == game_id))
                ).one()
                assert game_row[0] is not None, (
                    "games.lichess_evals_at provenance must stay set (SEED-109 item 4)"
                )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_missing_blob_writes_null_tag(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A walkable flaw with zero submitted blob_nodes -> tag suppressed to NULL
        (Part A net), completion still stamped (must_have: "a flaw the server found
        but the worker did not blob writes NULL ... and is left for tier-4 backfill").

        Both PV lines of the ply-2 flaw are made walkable via _WALKABLE_PV_PLY2 /
        _WALKABLE_PV_PLY3 (reused from the flaw-blob-lease fixtures — the opening
        moves of _SIX_PLY_PGN_142 and _FLAW_LEASE_PGN are identical through ply 3,
        so the same PV strings walk the same boards) so the flaw_ply key ends up
        entirely absent from the assembled blob_map (neither submitted nor
        sentineled) — the specific condition that triggers the blobs_pending=True
        suppression net rather than a D-06 structural sentinel.
        """
        import app.services.flaws_service as flaws_service_module
        from app.models.game import Game
        from app.models.game_flaw import GameFlaw
        from app.services.tactic_detector import TACTIC_CONFIDENCE_HIGH, TacticMotifInt

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

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

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51200 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        walkable_evals: list[dict[str, object]] = [dict(e) for e in _BLUNDER_SUBMIT_EVALS_142]
        walkable_evals[2]["pv"] = _WALKABLE_PV_PLY2  # flaw's "missed" line (node0 = ply 2)
        walkable_evals[3]["pv"] = _WALKABLE_PV_PLY3  # flaw's "allowed" line (node0 = ply 3)

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": walkable_evals,
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

            async with eval_worker_session_maker() as verify:
                flaw_row = (
                    await verify.execute(
                        select(
                            GameFlaw.ply,
                            GameFlaw.allowed_tactic_motif,
                            GameFlaw.allowed_pv_lines,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).one()
                flaw_ply, allowed_motif, allowed_pv_lines = flaw_row
                assert flaw_ply == 2, f"Flaw must be at ply 2, got {flaw_ply}"
                assert allowed_motif is None, (
                    "A server-found flaw the worker did not blob must be suppressed "
                    "to NULL, never raw/ungated (Part A net)"
                )
                assert allowed_pv_lines is None, (
                    "PV-line columns must stay NULL so the flaw is left for tier-4 backfill"
                )

                game_row = (
                    await verify.execute(
                        select(Game.full_evals_completed_at, Game.full_pv_completed_at).where(
                            Game.id == game_id
                        )
                    )
                ).one()
                full_evals_at, full_pv_at = game_row
                assert full_evals_at is not None, "completion must still be stamped"
                assert full_pv_at is not None, "completion must still be stamped"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_holed_batch_under_cap_leaves_pending(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """CR-01 (147-REVIEW.md, Path B): a NULL-hole engine-game ply on the first
        attempt must NOT stamp either completion marker, must increment
        full_eval_attempts, and must NOT signal flaw completion (IN-01) — mirrors
        /submit's SEED-045 bounded-retry invariant instead of unconditionally
        stamping complete with a gap.

        The hole is engineered by nulling the terminal eval (ply=6) of
        _BLUNDER_SUBMIT_EVALS_142: row 5 = pos_eval[6] = None on a non-terminal
        row (the game is not over) -> failed_ply_count == 1.
        """
        import app.routers.eval_remote as eval_remote_module
        from app.models.game import Game

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        signal_calls: list[int] = []
        monkeypatch.setattr(eval_remote_module, "_signal_flaw_completion", signal_calls.append)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_SIX_PLY_PGN_142,
            full_eval_attempts=0,  # explicitly under cap
        )
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51500 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        holed_evals: list[dict[str, object]] = [dict(e) for e in _BLUNDER_SUBMIT_EVALS_142]
        holed_evals[6]["eval_cp"] = None  # terminal eval hole -> row 5 (pos_eval[6]) NULL
        holed_evals[6]["eval_mate"] = None

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": holed_evals,
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            body = resp.json()
            assert body["failed_ply_count"] == 1, f"One hole expected: {body}"
            assert body["stamp_complete"] is False, (
                f"Path B (under cap) must not report complete: {body}"
            )

            async with eval_worker_session_maker() as verify:
                game_row = (
                    await verify.execute(
                        select(
                            Game.full_evals_completed_at,
                            Game.full_pv_completed_at,
                            Game.full_eval_attempts,
                        ).where(Game.id == game_id)
                    )
                ).one()
                full_evals_at, full_pv_at, attempts = game_row
                assert full_evals_at is None, (
                    "Path B must NOT stamp full_evals_completed_at with a residual hole"
                )
                assert full_pv_at is None, (
                    "Path B must NOT stamp full_pv_completed_at with a residual hole"
                )
                assert attempts == 1, f"full_eval_attempts must increment to 1, got {attempts}"

            assert signal_calls == [], (
                "IN-01: a Path-B (not-yet-complete) submit must NOT signal flaw "
                f"completion, got {signal_calls}"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_holed_batch_at_cap_stamps_with_log_warning(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """CR-01 (147-REVIEW.md, Path C): the same hole as the Path B test, but
        full_eval_attempts is already at MAX_EVAL_ATTEMPTS - 1 -> the NEXT attempt
        reaches the cap, stamps anyway (D-116-07 no-loop invariant), emits exactly
        one aggregated logger.warning carrying game_id/hole_count/attempts/worker_id,
        and DOES signal flaw completion (stamp_complete=True gates IN-01 the other
        way).

        260803: also a regression guard that this cap path stays OUT of Sentry — it
        fired ~30x/hour in production for an expected outcome (FLAWCHESS-8B), so the
        capture_message spy must stay empty.
        """
        import app.routers.eval_remote as eval_remote_module
        from app.models.game import Game
        from app.services.eval_drain import MAX_EVAL_ATTEMPTS

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        signal_calls: list[int] = []
        monkeypatch.setattr(eval_remote_module, "_signal_flaw_completion", signal_calls.append)

        capture_message_calls: list[str] = []
        monkeypatch.setattr(
            eval_remote_module.sentry_sdk,
            "capture_message",
            lambda msg, **kw: capture_message_calls.append(msg),
        )

        user_id = eval_worker_test_user
        assert MAX_EVAL_ATTEMPTS > 1, "test requires MAX_EVAL_ATTEMPTS > 1 for the cap path"
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_SIX_PLY_PGN_142,
            full_eval_attempts=MAX_EVAL_ATTEMPTS - 1,  # ONE more attempt reaches the cap
        )
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51600 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        holed_evals: list[dict[str, object]] = [dict(e) for e in _BLUNDER_SUBMIT_EVALS_142]
        holed_evals[6]["eval_cp"] = None  # same persistent hole as the Path B test
        holed_evals[6]["eval_mate"] = None

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": holed_evals,
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            with caplog.at_level(logging.WARNING, logger="app.routers.eval_remote"):
                async with _make_client() as client:
                    resp = await client.post(
                        _ATOMIC_SUBMIT_URL,
                        json=payload,
                        headers={
                            "X-Operator-Token": _TEST_TOKEN,
                            "X-Worker-Id": _PATH_C_WORKER_ID,
                        },
                    )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            body = resp.json()
            assert body["failed_ply_count"] == 1, f"One hole expected: {body}"
            assert body["stamp_complete"] is True, (
                f"Path C (cap reached) must report complete despite the hole: {body}"
            )

            async with eval_worker_session_maker() as verify:
                game_row = (
                    await verify.execute(
                        select(Game.full_evals_completed_at, Game.full_pv_completed_at).where(
                            Game.id == game_id
                        )
                    )
                ).one()
                full_evals_at, full_pv_at = game_row
                assert full_evals_at is not None, (
                    "Path C must stamp full_evals_completed_at despite the residual hole"
                )
                assert full_pv_at is not None, (
                    "Path C must stamp full_pv_completed_at despite the residual hole"
                )

            # 260803 NOISE GUARD: this expected cap-path outcome must NOT reach
            # Sentry — it fired ~30x/hour in production (FLAWCHESS-8B, 5550 events)
            # with zero actionable signal, the same mistake FLAWCHESS-5V taught in
            # the drain lane. logger.warning stays a breadcrumb, never an event.
            assert capture_message_calls == [], (
                "the Path-C cap must not Sentry-capture (FLAWCHESS-8B noise), "
                f"got {capture_message_calls}"
            )

            cap_logs = [
                r.getMessage()
                for r in caplog.records
                if r.name == "app.routers.eval_remote" and "MAX_EVAL_ATTEMPTS" in r.getMessage()
            ]
            assert len(cap_logs) == 1, (
                f"Exactly one cap log warning expected, got {len(cap_logs)}: {cap_logs}"
            )
            cap_log = cap_logs[0]
            assert cap_log.startswith(_PATH_C_CAP_MESSAGE), (
                f"unexpected cap log message: {cap_log!r}"
            )
            # The diagnostic payload that used to live in the Sentry `eval` context.
            # worker_id names only the LAST attempter (see the reporter's docstring);
            # the real attribution mechanism is worker_heartbeats.holes_submitted /
            # plies_leased.
            assert f"game_id={game_id}" in cap_log, cap_log
            assert "hole_count=1" in cap_log, cap_log
            assert f"attempts={MAX_EVAL_ATTEMPTS}" in cap_log, cap_log
            assert f"worker_id={_PATH_C_WORKER_ID}" in cap_log, cap_log
            assert f"last_ip={_DEFAULT_CLIENT_ADDR[0]}" in cap_log, cap_log

            assert signal_calls == [user_id], (
                f"Path C (stamp_complete=True) must signal flaw completion, got {signal_calls}"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_drops_blob_for_non_flaw_ply(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A blob_nodes token for an in-range ply the server does not classify as a
        flaw -> silently dropped (no matching game_flaws row to update), no error —
        the worker's local hint-classify is expected to sometimes diverge from the
        server's authoritative classify.
        """
        from app.models.game_flaw import GameFlaw

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51300 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": list(_BLUNDER_SUBMIT_EVALS_142),
            "blob_nodes": [
                {
                    # ply 0 is a real ply of this game but not the ply-2 flaw.
                    "token": "0:missed:0",
                    "best_cp": 10,
                    "best_mate": None,
                    "second_cp": None,
                    "second_mate": None,
                    "second_uci": None,
                }
            ],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, (
                f"Non-flaw-ply token must be dropped, not rejected: "
                f"got {resp.status_code} {resp.text}"
            )

            async with eval_worker_session_maker() as verify:
                flaw_plies = (
                    (await verify.execute(select(GameFlaw.ply).where(GameFlaw.game_id == game_id)))
                    .scalars()
                    .all()
                )
                assert list(flaw_plies) == [2], (
                    f"Only the real ply-2 flaw must exist; got {list(flaw_plies)}"
                )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_foreign_token_rejected(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A token whose flaw_ply falls outside the game's ply range -> 422, nothing
        persisted (T-147-02 tamper guard, mirrors _apply_flaw_blob_submit's T-145-09
        precedent, whose own test uses an equally out-of-range flaw_ply=99).
        """
        from app.models.game import Game
        from app.models.game_flaw import GameFlaw

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51400 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": list(_BLUNDER_SUBMIT_EVALS_142),
            "blob_nodes": [
                {
                    # flaw_ply=99 is far beyond this 6-ply game — structurally foreign.
                    "token": "99:missed:0",
                    "best_cp": 50,
                    "best_mate": None,
                    "second_cp": None,
                    "second_mate": None,
                    "second_uci": None,
                }
            ],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 422, (
                f"Foreign token must be rejected with 422 (T-147-02). "
                f"Got {resp.status_code}: {resp.text}"
            )

            async with eval_worker_session_maker() as verify:
                flaw_count = (
                    await verify.execute(
                        select(sa.func.count())
                        .select_from(GameFlaw)
                        .where(GameFlaw.game_id == game_id)
                    )
                ).scalar_one()
                assert flaw_count == 0, "Rejection must happen before any write"

                full_evals_at = (
                    await verify.execute(
                        select(Game.full_evals_completed_at).where(Game.id == game_id)
                    )
                ).scalar_one()
                assert full_evals_at is None, "No partial write on a rejected submit"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_second_best_out_of_range_422(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Phase 177 T-177-01: a second_best entry whose ply falls outside the
        game's ply range (0 <= ply < game_length) -> 422, no game_best_moves rows
        written (mirrors test_atomic_submit_foreign_token_rejected's blob-node
        precedent, using an equally out-of-range ply == game_length)."""
        from app.models.game import Game
        from app.models.game_best_move import GameBestMove

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": p, "full_hash": 51500 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 2,
            "evals": list(_BLUNDER_SUBMIT_EVALS_142),
            "blob_nodes": [],
            "second_best": [
                {
                    # ply == game_length (6) is one past this 6-ply game's last real
                    # ply — structurally out of range.
                    "ply": 6,
                    "second_cp": -50,
                    "second_mate": None,
                    "second_uci": "d2d4",
                }
            ],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 422, (
                f"Out-of-range second_best ply must be rejected with 422 (T-177-01). "
                f"Got {resp.status_code}: {resp.text}"
            )

            async with eval_worker_session_maker() as verify:
                best_move_count = (
                    await verify.execute(
                        select(sa.func.count())
                        .select_from(GameBestMove)
                        .where(GameBestMove.game_id == game_id)
                    )
                ).scalar_one()
                assert best_move_count == 0, "Rejection must happen before any write"

                full_evals_at = (
                    await verify.execute(
                        select(Game.full_evals_completed_at).where(Game.id == game_id)
                    )
                ).scalar_one()
                assert full_evals_at is None, "No partial write on a rejected submit"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_over_cap_payload_rejected_by_schema(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """An evals list beyond MAX_SUBMIT_EVALS is rejected by Pydantic validation
        before the handler runs, so an over-cap payload can never reach a partial
        write. The primary defense is /atomic-lease's own over-cap sentinel
        (147-04 — an over-cap game is never even issued a lease); this covers
        /atomic-submit's own structural cap as defense-in-depth for a worker that
        posts directly without going through /atomic-lease.
        """
        from app.models.game import Game
        from app.schemas.eval_remote import MAX_SUBMIT_EVALS

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)

        oversized_evals = [
            {"ply": p, "eval_cp": 0, "eval_mate": None, "best_move": None, "pv": None}
            for p in range(MAX_SUBMIT_EVALS + 1)
        ]
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": oversized_evals,
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 422, (
                f"Over-cap evals list must be rejected by schema validation, "
                f"got {resp.status_code}: {resp.text}"
            )

            async with eval_worker_session_maker() as verify:
                full_evals_at = (
                    await verify.execute(
                        select(Game.full_evals_completed_at).where(Game.id == game_id)
                    )
                ).scalar_one()
                assert full_evals_at is None, "No write must occur for a schema-rejected payload"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_with_job_id_stamps_eval_jobs(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A real leased job_id on /atomic-submit stamps eval_jobs.status='completed'
        with completed_at set (ports Gen-1's test_submit_with_job_id_stamps_eval_jobs
        — Phase 149-03 Task 1, 149-RESEARCH.md Pitfall 1).

        _apply_atomic_submit's eval_jobs stamp logic (WHERE status='leased' guard) is
        identical to _apply_submit's — this is the atomic-lane replacement so the
        coverage survives Gen-1's deletion.
        """
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 52000 + ply, "eval_cp": None, "eval_mate": None}
                for ply in range(4)
            ],
        )

        # Seed an eval_jobs row with status='leased' to simulate a claimed tier-1 job.
        job_id = await _seed_eval_job(eval_worker_session_maker, game_id, user_id, status="leased")

        evals = [
            {"ply": p, "eval_cp": 10 + p, "eval_mate": None, "best_move": None, "pv": None}
            for p in range(5)
        ]
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": evals,
            "blob_nodes": [],
            "job_id": job_id,
        }

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert response.status_code == 200, (
                f"Expected 200, got {response.status_code}: {response.text}"
            )
            body = response.json()
            assert body["stamp_complete"] is True, f"stamp_complete should be True: {body}"

            job_row = await _get_eval_job(eval_worker_session_maker, job_id)
            assert job_row is not None, f"eval_jobs row {job_id} must exist"
            assert job_row["status"] == "completed", (
                f"eval_jobs status should be 'completed', got {job_row['status']!r}"
            )
            assert job_row["completed_at"] is not None, (
                "eval_jobs.completed_at must be set after stamping"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_late_job_id_is_noop(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A late/stale job_id (already completed or re-leased) is a no-op, not a
        corruption (ports Gen-1's test_late_submit_does_not_corrupt_eval_jobs —
        Phase 149-03 Task 1, 149-RESEARCH.md Pitfall 1).

        Seeds an eval_jobs row with status='completed' (simulates a race where the
        lease expired and another worker already completed the job). The
        WHERE status='leased' guard must make the stamp UPDATE a no-op.
        """
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(eval_worker_session_maker, user_id)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 52100 + ply, "eval_cp": None, "eval_mate": None}
                for ply in range(4)
            ],
        )

        # Seed an eval_jobs row with status='completed' — not 'leased'.
        job_id = await _seed_eval_job(
            eval_worker_session_maker, game_id, user_id, status="completed"
        )

        evals = [
            {"ply": p, "eval_cp": 10 + p, "eval_mate": None, "best_move": None, "pv": None}
            for p in range(5)
        ]
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": evals,
            "blob_nodes": [],
            "job_id": job_id,
        }

        job_before = await _get_eval_job(eval_worker_session_maker, job_id)
        assert job_before is not None
        assert job_before["status"] == "completed"

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert response.status_code == 200, (
                f"Expected 200, got {response.status_code}: {response.text}"
            )

            job_after = await _get_eval_job(eval_worker_session_maker, job_id)
            assert job_after is not None
            assert job_after["status"] == "completed", (
                f"Status must remain 'completed' after a late submit; got {job_after['status']!r}"
            )
            assert job_after["completed_at"] == job_before["completed_at"], (
                "completed_at must be unchanged after a late submit no-op"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_atomic_submit_without_job_id_does_not_touch_eval_jobs(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """job_id=None (tier-3 pick) never touches eval_jobs (ports Gen-1's
        test_submit_without_job_id_does_not_touch_eval_jobs — Phase 149-03 Task 1,
        149-RESEARCH.md Pitfall 1).

        Seeds a separate eval_jobs row (status='leased') unrelated to the game being
        submitted, then submits with job_id=None. Verifies the seeded row is
        unchanged.
        """
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user

        # Game that will be submitted.
        game_id = await _insert_game(eval_worker_session_maker, user_id)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": ply, "full_hash": 52200 + ply, "eval_cp": None, "eval_mate": None}
                for ply in range(4)
            ],
        )

        # A second game/job to verify eval_jobs is not touched.
        sentinel_game_id = await _insert_game(eval_worker_session_maker, user_id)
        sentinel_job_id = await _seed_eval_job(
            eval_worker_session_maker, sentinel_game_id, user_id, status="leased"
        )

        evals = [
            {"ply": p, "eval_cp": 10 + p, "eval_mate": None, "best_move": None, "pv": None}
            for p in range(5)
        ]
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 1,
            "evals": evals,
            "blob_nodes": [],
            "job_id": None,
        }

        try:
            async with _make_client() as client:
                response = await client.post(
                    _ATOMIC_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert response.status_code == 200, (
                f"Expected 200, got {response.status_code}: {response.text}"
            )

            sentinel_row = await _get_eval_job(eval_worker_session_maker, sentinel_job_id)
            assert sentinel_row is not None
            assert sentinel_row["status"] == "leased", (
                f"Sentinel eval_jobs status must remain 'leased' after tier-3 submit "
                f"(job_id=None); got {sentinel_row['status']!r}"
            )
            assert sentinel_row["completed_at"] is None, (
                "Sentinel eval_jobs.completed_at must stay NULL after tier-3 submit"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id, sentinel_game_id])


# ─── Phase 145 Plan 04 Task 1: blob assembly from worker results (TDD RED) ───


class TestBlobAssemblyHelper:
    """Unit tests for _assemble_flaw_blobs_from_submit (pure CPU helper, Task 1).

    Tests:
    - test_blob_assembly_full_sequence_assembles_pvnodes: k=0..N sequence with
      second_uci=None→"" conversion (Pitfall 3).
    - test_blob_assembly_sentinel_line_returns_empty: (flaw_ply, line) in sentinel_lines → [].
    - test_blob_assembly_missing_node0_returns_empty: no k=0 result → [].
    - test_blob_assembly_missed_allowed_stay_distinct: "10:missed:2" and "10:allowed:2"
      stay distinct (Pitfall 5 — all three token components are used as index key).
    """

    def test_blob_assembly_full_sequence_assembles_pvnodes(self) -> None:
        """Even-k sequence assembles a full-index PvNode list with odd placeholders (SEED-079);
        second_uci=None maps to su='' (Pitfall 3)."""
        from app.schemas.eval_remote import FlawBlobSubmitEval
        from app.services.eval_drain import _assemble_flaw_blobs_from_submit

        evals = [
            FlawBlobSubmitEval(
                token="10:missed:0",
                best_cp=150,
                best_mate=None,
                second_cp=50,
                second_mate=None,
                second_uci=None,  # None on the wire → su="" in PvNode (Pitfall 3)
            ),
            FlawBlobSubmitEval(
                token="10:missed:2",
                best_cp=100,
                best_mate=None,
                second_cp=20,
                second_mate=None,
                second_uci="d2d4",
            ),
        ]
        blob_map = _assemble_flaw_blobs_from_submit(42, evals, sentinel_lines=set())

        assert 10 in blob_map, "flaw_ply=10 must appear in blob_map"
        allowed_blob, missed_blob = blob_map[10]
        # missed: even nodes k=0, k=2 submitted → 3-element list with an odd placeholder
        # at index 1 (SEED-079 slim blob keeps the gate's solver-node indices aligned).
        assert len(missed_blob) == 3, f"Expected 3 missed nodes, got {len(missed_blob)}"
        assert missed_blob[0]["b"] == 150
        assert missed_blob[0]["su"] == "", "None second_uci must map to '' (Pitfall 3)"
        assert missed_blob[1] == {"b": None, "bm": None, "s": None, "sm": None, "su": ""}, (
            "Odd index must be the all-None defender placeholder (SEED-079)"
        )
        assert missed_blob[2]["b"] == 100
        assert missed_blob[2]["su"] == "d2d4"
        # allowed: no tokens submitted → no node-0 → []
        assert allowed_blob == [], "No allowed tokens submitted → blob should be []"

    def test_blob_assembly_sentinel_line_returns_empty(self) -> None:
        """Line in sentinel_lines gets [] regardless of submitted evals (D-06 sentinel write)."""
        from app.schemas.eval_remote import FlawBlobSubmitEval
        from app.services.eval_drain import _assemble_flaw_blobs_from_submit

        evals = [
            FlawBlobSubmitEval(
                token="10:allowed:0",
                best_cp=100,
                best_mate=None,
                second_cp=None,
                second_mate=None,
                second_uci=None,
            ),
        ]
        sentinel_lines: set[tuple[int, str]] = {(10, "missed")}  # missed is un-fillable
        blob_map = _assemble_flaw_blobs_from_submit(42, evals, sentinel_lines)

        assert 10 in blob_map
        allowed_blob, missed_blob = blob_map[10]
        assert missed_blob == [], "Sentinel line must produce [] (D-06)"
        assert len(allowed_blob) == 1, "Non-sentinel allowed line must have real blob"

    def test_blob_assembly_missing_node0_returns_empty(self) -> None:
        """Line missing node-0 result gets [] (can't start the PvNode sequence)."""
        from app.schemas.eval_remote import FlawBlobSubmitEval
        from app.services.eval_drain import _assemble_flaw_blobs_from_submit

        # Submit k=1 but not k=0 — no start node → can't assemble
        evals = [
            FlawBlobSubmitEval(
                token="5:missed:1",
                best_cp=100,
                best_mate=None,
                second_cp=None,
                second_mate=None,
                second_uci=None,
            ),
        ]
        blob_map = _assemble_flaw_blobs_from_submit(42, evals, sentinel_lines=set())

        assert 5 in blob_map
        _allowed, missed_blob = blob_map[5]
        assert missed_blob == [], "Missing node-0 → no blob sequence can be built → []"

    def test_blob_assembly_missed_allowed_stay_distinct(self) -> None:
        """Tokens '10:missed:0' and '10:allowed:0' are distinct keys (Pitfall 5 — all 3 components)."""
        from app.schemas.eval_remote import FlawBlobSubmitEval
        from app.services.eval_drain import _assemble_flaw_blobs_from_submit

        evals = [
            FlawBlobSubmitEval(
                token="10:missed:0",
                best_cp=50,
                best_mate=None,
                second_cp=10,
                second_mate=None,
                second_uci="e2e4",  # missed line marker
            ),
            FlawBlobSubmitEval(
                token="10:allowed:0",
                best_cp=200,
                best_mate=None,
                second_cp=80,
                second_mate=None,
                second_uci="d2d4",  # allowed line marker
            ),
        ]
        blob_map = _assemble_flaw_blobs_from_submit(42, evals, sentinel_lines=set())

        assert 10 in blob_map
        allowed_blob, missed_blob = blob_map[10]
        # missed and allowed must NOT overwrite each other
        assert len(missed_blob) == 1
        assert missed_blob[0]["b"] == 50
        assert missed_blob[0]["su"] == "e2e4"
        assert len(allowed_blob) == 1
        assert allowed_blob[0]["b"] == 200
        assert allowed_blob[0]["su"] == "d2d4"


# ─── Phase 145 Plan 04 Task 2: /flaw-blob-submit endpoint tests (TDD RED) ────

_FLAW_BLOB_SUBMIT_URL = "/api/eval/remote/flaw-blob-submit"


class TestFlawBlobSubmitEndpoint:
    """Phase 145 Plan 04 Task 2: POST /eval/remote/flaw-blob-submit endpoint.

    Tests:
    - test_blob_submit_requires_operator_token: missing/wrong token → 403/401.
    - test_blob_submit_game_not_found: unknown game_id → 404.
    - test_blob_submit_roundtrip_writes_blobs: lease→submit writes blobs + tactic tags.
    - test_blob_submit_sentinel_line_gets_empty_blob: NULL-PV allowed line gets [],
      submitted missed line gets real blob (mixed-game sentinel D-06).
    - test_blob_submit_foreign_token_rejected: token not from lease → 422 (T-145-09).
    - test_blob_submit_idempotent: second submit of same game → 200, blobs_written=0
      (no NULL-blob flaws remain → no-op D-03 idempotency).

    Phase 149-03 PRUNE-01: the isolation-proof test verifying the (now-deleted) Gen-1
    submit endpoint's response shape was unaffected by this endpoint has itself been
    removed.
    """

    @pytest.mark.asyncio
    async def test_blob_submit_requires_operator_token(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Missing operator token → 403 (fail-closed); wrong token → 401."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", "")
        async with _make_client() as client:
            resp = await client.post(
                _FLAW_BLOB_SUBMIT_URL,
                json={"game_id": 1, "sf_version": "Stockfish 18", "evals": []},
            )
        assert resp.status_code == 403, f"Expected 403, got {resp.status_code}: {resp.text}"

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        async with _make_client() as client:
            resp = await client.post(
                _FLAW_BLOB_SUBMIT_URL,
                json={"game_id": 1, "sf_version": "Stockfish 18", "evals": []},
                headers={"X-Operator-Token": "bad-token"},
            )
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_blob_submit_game_not_found(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """Unknown game_id → 404."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        async with _make_client() as client:
            resp = await client.post(
                _FLAW_BLOB_SUBMIT_URL,
                json={"game_id": 999999999, "sf_version": "Stockfish 18", "evals": []},
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 404, f"Expected 404, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_blob_submit_roundtrip_writes_blobs(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Lease→submit roundtrip writes non-NULL blobs and updates tactic tag columns (D-07)."""
        import app.routers.eval_remote as eval_remote_module
        from app.models.game_flaw import GameFlaw

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        # Insert PV strings + basic positions for positions list
        for ply, pv in [(0, None), (1, None), (2, _WALKABLE_PV_PLY2), (3, _WALKABLE_PV_PLY3)]:
            await _insert_game_position_pv(eval_worker_session_maker, user_id, game_id, ply, pv)

        monkeypatch.setattr(
            eval_remote_module, "_claim_tier4_blob", AsyncMock(return_value=(game_id, user_id))
        )

        try:
            # Step 1: lease
            async with _make_client() as client:
                lease_resp = await client.post(
                    _FLAW_BLOB_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN}
                )
            assert lease_resp.status_code == 200, f"Lease failed: {lease_resp.text}"
            lease_positions = lease_resp.json()["positions"]
            assert len(lease_positions) > 0, "Expected non-empty lease positions"

            # Step 2: submit worker evals (one per leased token)
            submit_evals = [
                {
                    "token": pos["token"],
                    "best_cp": 80,
                    "best_mate": None,
                    "second_cp": None,
                    "second_mate": None,
                    "second_uci": None,
                }
                for pos in lease_positions
            ]
            async with _make_client() as client:
                submit_resp = await client.post(
                    _FLAW_BLOB_SUBMIT_URL,
                    json={"game_id": game_id, "sf_version": "Stockfish 18", "evals": submit_evals},
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert submit_resp.status_code == 200, (
                f"Submit failed: {submit_resp.status_code} {submit_resp.text}"
            )
            body = submit_resp.json()
            assert body["game_id"] == game_id
            assert body["blobs_written"] >= 1, "At least one blob must be written"

            # Step 3: verify blobs are non-NULL in DB
            async with eval_worker_session_maker() as verify:
                flaw_rows = (
                    await verify.execute(
                        sa.select(
                            GameFlaw.ply,
                            GameFlaw.allowed_pv_lines,
                            GameFlaw.missed_pv_lines,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).all()

            assert len(flaw_rows) == 1, f"Expected 1 flaw row, got {len(flaw_rows)}"
            _ply, allowed, missed = flaw_rows[0]
            assert allowed is not None, "allowed_pv_lines must be non-NULL after submit (D-01)"
            assert missed is not None, "missed_pv_lines must be non-NULL after submit (D-01)"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_blob_submit_sentinel_line_gets_empty_blob(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Mixed game: allowed line with NULL PV gets sentinel [], missed (walkable) gets real blob (D-06)."""
        import app.routers.eval_remote as eval_remote_module
        from app.models.game_flaw import GameFlaw

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        # missed line (ply=2): walkable PV → leased to worker
        # allowed line (ply=3): no PV row inserted → NULL pv → 1-node walk → sentinel
        for ply, pv in [(0, None), (1, None), (2, _WALKABLE_PV_PLY2)]:
            await _insert_game_position_pv(eval_worker_session_maker, user_id, game_id, ply, pv)
        # ply=3 NOT inserted → pv_at_ply.get(3) is None → sentinel for allowed line

        monkeypatch.setattr(
            eval_remote_module, "_claim_tier4_blob", AsyncMock(return_value=(game_id, user_id))
        )

        try:
            # Lease: should return only missed tokens (allowed is sentinel)
            async with _make_client() as client:
                lease_resp = await client.post(
                    _FLAW_BLOB_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN}
                )
            assert lease_resp.status_code == 200, f"Lease failed: {lease_resp.text}"
            lease_positions = lease_resp.json()["positions"]
            # All tokens should be for missed line only
            for pos in lease_positions:
                assert ":missed:" in pos["token"], (
                    f"Allowed line has NULL PV → sentinel; no allowed tokens should be leased. "
                    f"Got: {pos['token']!r}"
                )

            # Submit missed-line evals
            submit_evals = [
                {
                    "token": pos["token"],
                    "best_cp": 60,
                    "best_mate": None,
                    "second_cp": None,
                    "second_mate": None,
                    "second_uci": None,
                }
                for pos in lease_positions
            ]
            async with _make_client() as client:
                submit_resp = await client.post(
                    _FLAW_BLOB_SUBMIT_URL,
                    json={"game_id": game_id, "sf_version": "Stockfish 18", "evals": submit_evals},
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert submit_resp.status_code == 200, (
                f"Submit failed: {submit_resp.status_code} {submit_resp.text}"
            )

            # Verify: allowed_pv_lines=[] (sentinel), missed_pv_lines=<real blob>
            async with eval_worker_session_maker() as verify:
                flaw_rows = (
                    await verify.execute(
                        sa.select(
                            GameFlaw.ply,
                            GameFlaw.allowed_pv_lines,
                            GameFlaw.missed_pv_lines,
                        ).where(GameFlaw.game_id == game_id)
                    )
                ).all()

            assert len(flaw_rows) == 1
            _ply, allowed, missed = flaw_rows[0]
            assert allowed == [], (
                "Sentinel allowed line (NULL PV) must get [] blob — D-06 sentinel write"
            )
            assert missed is not None and missed != [], (
                "Walkable missed line must get real PvNode blob"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_blob_submit_foreign_token_rejected(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Token not in the current lease set → 422 (T-145-09: foreign-token injection blocked)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        for ply, pv in [(0, None), (1, None), (2, _WALKABLE_PV_PLY2), (3, _WALKABLE_PV_PLY3)]:
            await _insert_game_position_pv(eval_worker_session_maker, user_id, game_id, ply, pv)

        monkeypatch.setattr(
            eval_remote_module, "_claim_tier4_blob", AsyncMock(return_value=(game_id, user_id))
        )

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _FLAW_BLOB_SUBMIT_URL,
                    json={
                        "game_id": game_id,
                        "sf_version": "Stockfish 18",
                        "evals": [
                            {
                                # Foreign token: flaw_ply=99 doesn't exist in this game
                                "token": "99:missed:0",
                                "best_cp": 50,
                                "best_mate": None,
                                "second_cp": None,
                                "second_mate": None,
                                "second_uci": None,
                            }
                        ],
                    },
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 422, (
                f"Foreign token must be rejected with 422 (T-145-09). Got {resp.status_code}: {resp.text}"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_blob_submit_idempotent(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Double-submit is idempotent: second submit of same game → 200, blobs_written=0 (D-03)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)
        for ply, pv in [(0, None), (1, None), (2, _WALKABLE_PV_PLY2), (3, _WALKABLE_PV_PLY3)]:
            await _insert_game_position_pv(eval_worker_session_maker, user_id, game_id, ply, pv)

        monkeypatch.setattr(
            eval_remote_module, "_claim_tier4_blob", AsyncMock(return_value=(game_id, user_id))
        )

        try:
            # Lease tokens
            async with _make_client() as client:
                lease_resp = await client.post(
                    _FLAW_BLOB_LEASE_URL, headers={"X-Operator-Token": _TEST_TOKEN}
                )
            assert lease_resp.status_code == 200
            lease_positions = lease_resp.json()["positions"]

            submit_evals = [
                {
                    "token": pos["token"],
                    "best_cp": 70,
                    "best_mate": None,
                    "second_cp": None,
                    "second_mate": None,
                    "second_uci": None,
                }
                for pos in lease_positions
            ]
            submit_payload = {
                "game_id": game_id,
                "sf_version": "Stockfish 18",
                "evals": submit_evals,
            }

            # First submit
            async with _make_client() as client:
                resp1 = await client.post(
                    _FLAW_BLOB_SUBMIT_URL,
                    json=submit_payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp1.status_code == 200, (
                f"First submit failed: {resp1.status_code} {resp1.text}"
            )
            assert resp1.json()["blobs_written"] >= 1, "First submit must write blobs"

            # Second submit (same payload) — idempotent no-op
            async with _make_client() as client:
                resp2 = await client.post(
                    _FLAW_BLOB_SUBMIT_URL,
                    json=submit_payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp2.status_code == 200, (
                f"Second (idempotent) submit must return 200, got {resp2.status_code}: {resp2.text}"
            )
            assert resp2.json()["blobs_written"] == 0, (
                "Second submit is a no-op — no NULL-blob flaws remain → blobs_written=0 (D-03)"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])


# ─── SEED-076: cache-aware incremental lease + blob-preserving classify ────────
#
# Root cause (FLAWCHESS-8B): a weak remote worker times out on high-branching
# opening positions, submits partial evals; the atomic path passed dedup_map={}
# and re-leased the whole game, so fillable cached-opening holes reached the
# Path-C cap and were permanently stamped complete. These tests cover the fix:
#   - _build_lease_positions omits cached + already-eval'd positions (never the
#     terminal donor; falls back to the full list rather than an empty lease).
#   - the submit paths fill cached openings server-side (dedup_map) before the
#     hole count, and preserve_existing_evals keeps already-eval'd plies out of it.
#   - _apply_atomic_submit snapshots + restores flaw blobs/tags so a sparse retry
#     never wipes an already-blobbed midgame flaw.

_SEED076_PGN: str = _SIX_PLY_PGN_142  # 6 plies (0-5) + terminal donor (ply 6)


def _atomic_request(
    game_id: int,
    eval_dicts: list[dict[str, object]],
) -> Any:
    """Build an AtomicSubmitRequest from _BLUNDER-style eval dicts (no blob_nodes)."""
    from app.schemas.eval_remote import AtomicSubmitEval, AtomicSubmitRequest

    return AtomicSubmitRequest(
        game_id=game_id,
        sf_version="Stockfish 18",
        worker_schema_version=1,
        evals=[
            AtomicSubmitEval(
                ply=int(cast(int, e["ply"])),
                eval_cp=cast("int | None", e["eval_cp"]),
                eval_mate=cast("int | None", e["eval_mate"]),
                best_move=cast("str | None", e["best_move"]),
                pv=cast("str | None", e["pv"]),
            )
            for e in eval_dicts
        ],
        blob_nodes=[],
    )


async def _insert_opening_cache(
    session_maker: async_sessionmaker[AsyncSession],
    rows: list[tuple[int, int | None, int | None, str | None]],
) -> None:
    """Insert opening_position_eval rows: (full_hash, eval_cp, eval_mate, best_move)."""
    from app.models.opening_position_eval import OpeningPositionEval

    async with session_maker() as session:
        for full_hash, cp, mate, bm in rows:
            session.add(
                OpeningPositionEval(full_hash=full_hash, eval_cp=cp, eval_mate=mate, best_move=bm)
            )
        await session.commit()


async def _insert_opening_cache_with_pv(
    session_maker: async_sessionmaker[AsyncSession],
    rows: list[tuple[int, int | None, int | None, str | None, str | None]],
) -> None:
    """Insert opening_position_eval rows incl. pv: (full_hash, eval_cp, eval_mate,
    best_move, pv). SEED-076 follow-up: pv-bearing variant of _insert_opening_cache
    for tests exercising the pv-gated lease omission / merge mechanism."""
    from app.models.opening_position_eval import OpeningPositionEval

    async with session_maker() as session:
        for full_hash, cp, mate, bm, pv in rows:
            session.add(
                OpeningPositionEval(
                    full_hash=full_hash, eval_cp=cp, eval_mate=mate, best_move=bm, pv=pv
                )
            )
        await session.commit()


async def _delete_opening_cache(
    session_maker: async_sessionmaker[AsyncSession],
    full_hashes: list[int],
) -> None:
    from app.models.opening_position_eval import OpeningPositionEval

    if not full_hashes:
        return
    async with session_maker() as session:
        await session.execute(
            delete(OpeningPositionEval).where(OpeningPositionEval.full_hash.in_(full_hashes))
        )
        await session.commit()


def test_build_lease_positions_incremental_omits_already_evald() -> None:
    """SEED-076: a ply whose DB row (row Q-1, post-move shift) already has an eval is
    omitted from the re-lease; the terminal donor and genuine holes are kept."""
    from app.routers.eval_remote import _build_lease_positions

    # row 1 already eval'd → position 2 (whose eval fills row 1) is redundant.
    gp_rows: list[tuple[int, int, int | None, int | None]] = [
        (0, 100, None, None),
        (1, 101, 50, None),
        (2, 102, None, None),
        (3, 103, None, None),
        (4, 104, None, None),
        (5, 105, None, None),
    ]
    positions = _build_lease_positions(1, _SEED076_PGN, gp_rows)
    assert positions is not None
    plies = {p.ply for p in positions}
    assert 2 not in plies, "position 2 (fills already-eval'd row 1) must be omitted"
    assert {0, 1, 3, 4, 5}.issubset(plies), "genuine holes must remain leased"
    assert any(p.is_terminal for p in positions), "terminal donor must always be kept"


def test_build_lease_positions_cache_aware_omits_cached_opening() -> None:
    """SEED-076: an opening position whose full_hash is in the cache is omitted (the
    submit dedup_map fills it server-side)."""
    from app.routers.eval_remote import _build_lease_positions

    gp_rows = [(p, 100 + p, None, None) for p in range(6)]
    # h3 = 103 is cached → position 3 omitted.
    positions = _build_lease_positions(1, _SEED076_PGN, gp_rows, frozenset({103}))
    assert positions is not None
    plies = {p.ply for p in positions}
    assert 3 not in plies, "cached opening position 3 must be omitted"
    assert any(p.is_terminal for p in positions), "terminal donor must always be kept"


def test_build_lease_positions_terminal_kept_when_all_rows_filled() -> None:
    """SEED-076: even with every real row already eval'd, the terminal donor survives
    the incremental filter (SEED-044 pitfall 3)."""
    from app.routers.eval_remote import _build_lease_positions

    gp_rows: list[tuple[int, int, int | None, int | None]] = [
        (p, 100 + p, 10 + p, None) for p in range(6)
    ]  # all filled
    positions = _build_lease_positions(1, _SEED076_PGN, gp_rows)
    assert positions is not None
    assert any(p.is_terminal for p in positions), "terminal donor must survive"


def test_build_lease_positions_empty_filter_falls_back_to_full_list() -> None:
    """SEED-076 safety net: a board-over game with every position redundant must not
    yield an empty lease (which would starve the game of the dedup-triggering submit)."""
    from app.routers.eval_remote import _build_lease_positions

    # Fool's mate → game-over final board → NO terminal donor; last row ends_game.
    fools_mate = "1. f3 e5 2. g4 Qh4# *"
    gp_rows: list[tuple[int, int, int | None, int | None]] = [
        (p, 200 + p, 10 + p, None) for p in range(4)
    ]  # all filled
    cached = frozenset({200, 201, 202, 203})  # + all cached
    positions = _build_lease_positions(1, fools_mate, gp_rows, cached)
    assert positions is not None
    assert len(positions) == 4, "must fall back to the full position list, not an empty lease"


@pytest.mark.asyncio
async def test_atomic_submit_fills_cached_opening_hole_server_side(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """SEED-076 (req a): a partial submit missing a cached opening ply is filled
    server-side from opening_position_eval — no worker round-trip — and the game
    reaches Path A (no permanent hole)."""
    from app.routers.eval_remote import _apply_atomic_submit

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    base = 76000
    game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SEED076_PGN)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [{"ply": p, "full_hash": base + p, "eval_cp": None, "eval_mate": None} for p in range(6)],
    )
    # Cache position 1's hash with eval 20 (== blunder pos_eval[1]); worker omits ply 1.
    await _insert_opening_cache(eval_worker_session_maker, [(base + 1, 20, None, "e2e4")])
    partial = [e for e in _BLUNDER_SUBMIT_EVALS_142 if e["ply"] != 1]

    try:
        resp = await _apply_atomic_submit(
            game_id, _atomic_request(game_id, partial), worker_id="test-worker", last_ip=None
        )
        assert resp.failed_ply_count == 0, (
            f"cached opening must be filled server-side (no hole), got {resp.failed_ply_count}"
        )
        row0 = await _get_game_position(eval_worker_session_maker, game_id, 0)
        assert row0 is not None and row0["eval_cp"] == 20, (
            f"row 0 (= pos_eval[1]) must be filled from cache, got {row0}"
        )
        stamped = await _get_game_full_evals_completed_at(eval_worker_session_maker, game_id)
        assert stamped is not None, "Path A must stamp full_evals_completed_at"
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])
        await _delete_opening_cache(eval_worker_session_maker, [base + 1])


@pytest.mark.asyncio
async def test_atomic_submit_uncached_hole_bounded_by_path_c(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """SEED-076 (req b): a genuinely-uncached residual hole stays bounded by Path C —
    stamped complete after MAX_EVAL_ATTEMPTS, never re-leased forever."""
    from app.routers.eval_remote import _apply_atomic_submit
    from app.services.eval_drain import MAX_EVAL_ATTEMPTS

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    base = 76100
    game_id = await _insert_game(
        eval_worker_session_maker,
        user_id,
        pgn=_SEED076_PGN,
        full_eval_attempts=MAX_EVAL_ATTEMPTS - 1,  # this submit is the last attempt
    )
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [{"ply": p, "full_hash": base + p, "eval_cp": None, "eval_mate": None} for p in range(6)],
    )
    # No cache entry → position 1 is a genuine hole; worker omits it.
    partial = [e for e in _BLUNDER_SUBMIT_EVALS_142 if e["ply"] != 1]

    try:
        resp = await _apply_atomic_submit(
            game_id, _atomic_request(game_id, partial), worker_id="test-worker", last_ip=None
        )
        assert resp.failed_ply_count == 1, f"row 0 must be an uncached hole, got {resp}"
        stamped = await _get_game_full_evals_completed_at(eval_worker_session_maker, game_id)
        assert stamped is not None, "Path C must stamp complete at the cap (no infinite re-lease)"
        row0 = await _get_game_position(eval_worker_session_maker, game_id, 0)
        assert row0 is not None and row0["eval_cp"] is None, "residual hole stays NULL (accepted)"
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])


@pytest.mark.asyncio
async def test_atomic_submit_preserve_guard_omitted_evald_ply_not_hole(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """SEED-076: an already-eval'd ply dropped from the incremental re-lease (worker
    does not resend it) is NOT counted as a hole — the game still reaches Path A."""
    from app.routers.eval_remote import _apply_atomic_submit

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    base = 76200
    game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SEED076_PGN)
    rows = [{"ply": p, "full_hash": base + p, "eval_cp": None, "eval_mate": None} for p in range(6)]
    rows[1] = {"ply": 1, "full_hash": base + 1, "eval_cp": 45, "eval_mate": None}  # already eval'd
    await _insert_game_positions(eval_worker_session_maker, user_id, game_id, rows)
    # Worker omits position 2 (which fills row 1) — row 1 already carries an eval.
    partial = [e for e in _BLUNDER_SUBMIT_EVALS_142 if e["ply"] != 2]

    try:
        resp = await _apply_atomic_submit(
            game_id, _atomic_request(game_id, partial), worker_id="test-worker", last_ip=None
        )
        assert resp.failed_ply_count == 0, (
            f"already-eval'd row 1 must not be counted as a hole, got {resp.failed_ply_count}"
        )
        stamped = await _get_game_full_evals_completed_at(eval_worker_session_maker, game_id)
        assert stamped is not None, "preserve guard must let the game reach Path A"
        row1 = await _get_game_position(eval_worker_session_maker, game_id, 1)
        assert row1 is not None and row1["eval_cp"] == 45, "existing eval must not be overwritten"
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])


@pytest.mark.asyncio
async def test_atomic_retry_preserves_existing_flaw_blobs_and_tags(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """SEED-076: a sparse atomic retry (no fresh blob for an already-done flaw) must NOT
    wipe its allowed/missed PV-line blobs + tactic tags via classify's delete-then-insert."""
    from app.models.game_flaw import GameFlaw
    from app.routers.eval_remote import _apply_atomic_submit

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    base = 76300
    game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SEED076_PGN)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [{"ply": p, "full_hash": base + p, "eval_cp": None, "eval_mate": None} for p in range(6)],
    )

    preserved_allowed = [{"b": 10, "bm": None, "s": 5, "sm": None, "su": "e2e4"}]
    preserved_missed = [{"b": 20, "bm": None, "s": 8, "sm": None, "su": "d2d4"}]
    try:
        # Attempt 1: full evals, no blobs → flaw row created at ply 2 (blobs NULL).
        await _apply_atomic_submit(
            game_id,
            _atomic_request(game_id, list(_BLUNDER_SUBMIT_EVALS_142)),
            worker_id="test-worker",
            last_ip=None,
        )
        # Simulate attempt 1 having blobbed + tagged the flaw (as an atomic worker would).
        async with eval_worker_session_maker() as s:
            await s.execute(
                sa.update(GameFlaw)
                .where(GameFlaw.game_id == game_id, GameFlaw.ply == 2)
                .values(
                    allowed_pv_lines=preserved_allowed,
                    missed_pv_lines=preserved_missed,
                    allowed_tactic_motif=7,
                    allowed_tactic_confidence=80,
                )
            )
            await s.commit()

        # Attempt 2: full evals again, NO blobs → classify delete-then-insert would wipe
        # the flaw's blobs/tags; the snapshot+restore must preserve them.
        await _apply_atomic_submit(
            game_id,
            _atomic_request(game_id, list(_BLUNDER_SUBMIT_EVALS_142)),
            worker_id="test-worker",
            last_ip=None,
        )

        async with eval_worker_session_maker() as verify:
            row = (
                await verify.execute(
                    select(
                        GameFlaw.allowed_pv_lines,
                        GameFlaw.missed_pv_lines,
                        GameFlaw.allowed_tactic_motif,
                    ).where(GameFlaw.game_id == game_id, GameFlaw.ply == 2)
                )
            ).one_or_none()
        assert row is not None, "flaw at ply 2 must still exist after the retry"
        allowed, missed, motif = row
        assert allowed == preserved_allowed, f"allowed_pv_lines must be preserved, got {allowed}"
        assert missed == preserved_missed, f"missed_pv_lines must be preserved, got {missed}"
        assert motif == 7, f"allowed_tactic_motif must be preserved, got {motif}"
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])


# Flat (non-blunder) eval set: no win-prob drop anywhere, so classify finds no flaw.
_FLAT_SUBMIT_EVALS_142: list[dict[str, object]] = [
    {"ply": 0, "eval_cp": 0, "eval_mate": None, "best_move": None, "pv": None},
    {"ply": 1, "eval_cp": 20, "eval_mate": None, "best_move": "e2e4", "pv": None},
    {"ply": 2, "eval_cp": 30, "eval_mate": None, "best_move": "g1f3", "pv": None},
    {"ply": 3, "eval_cp": 25, "eval_mate": None, "best_move": "b8c6", "pv": None},
    {"ply": 4, "eval_cp": 28, "eval_mate": None, "best_move": "f1c4", "pv": None},
    {"ply": 5, "eval_cp": 22, "eval_mate": None, "best_move": "f8c5", "pv": None},
    {"ply": 6, "eval_cp": 20, "eval_mate": None, "best_move": None, "pv": None},  # terminal
]


@pytest.mark.asyncio
async def test_atomic_retry_snapshotted_ply_no_longer_flaw_does_not_raise(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """FLAWCHESS-8D regression: a snapshotted (previously-blobbed) flaw ply that the retry's
    reclassify no longer flags as a flaw must NOT raise StaleDataError.

    The restore uses the ORM bulk-update-by-PK path, which asserts exactly 1 row matched
    per parameter set. When attempt 2's evals flip ply 2 out of flaw status, classify's
    delete-then-insert leaves no row at ply 2, so restoring the attempt-1 snapshot there
    matched 0 rows and crashed (500 on /atomic-submit). The fix filters the snapshot to
    plies that survived classify.
    """
    from app.models.game_flaw import GameFlaw
    from app.routers.eval_remote import _apply_atomic_submit

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    base = 76350
    game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SEED076_PGN)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [{"ply": p, "full_hash": base + p, "eval_cp": None, "eval_mate": None} for p in range(6)],
    )

    preserved_allowed = [{"b": 10, "bm": None, "s": 5, "sm": None, "su": "e2e4"}]
    try:
        # Attempt 1: blunder evals → flaw row created + blobbed at ply 2 (snapshot source).
        await _apply_atomic_submit(
            game_id,
            _atomic_request(game_id, list(_BLUNDER_SUBMIT_EVALS_142)),
            worker_id="test-worker",
            last_ip=None,
        )
        async with eval_worker_session_maker() as s:
            await s.execute(
                sa.update(GameFlaw)
                .where(GameFlaw.game_id == game_id, GameFlaw.ply == 2)
                .values(allowed_pv_lines=preserved_allowed)
            )
            await s.commit()

        # Attempt 2: FLAT evals → reclassify drops the ply-2 flaw. Pre-fix this raised
        # StaleDataError inside _restore_preserved_flaw_blobs; post-fix it is a clean no-op.
        resp = await _apply_atomic_submit(
            game_id,
            _atomic_request(game_id, list(_FLAT_SUBMIT_EVALS_142)),
            worker_id="test-worker",
            last_ip=None,
        )
        assert resp.stamp_complete is True, "flat retry has no holes → Path A stamps complete"

        async with eval_worker_session_maker() as verify:
            still_flaw = (
                await verify.execute(
                    select(GameFlaw.ply).where(GameFlaw.game_id == game_id, GameFlaw.ply == 2)
                )
            ).one_or_none()
        assert still_flaw is None, "ply 2 must no longer be a flaw after the flat retry"
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])


# ─── SEED-076 follow-up: cache the pv alongside the eval (Task 3) ─────────────
#
# Fix: opening_position_eval gained a nullable pv column (Task 1) and
# _fetch_dedup_evals/_upsert_opening_cache now carry it (Task 2). These tests cover
# the submit-side merge + pv-gated lease omission:
#   - _fetch_cached_opening_hashes only omits a cached opening when its cache row
#     has a real pv (a pv-less row must still be leased to the worker).
#   - _merge_dedup_pv_into_engine_map lets a cache-omitted opening flaw ply get a
#     real walkable PV (game_positions.pv + a non-sentineled game_flaws blob line)
#     instead of the permanent [] sentinel.
#   - _upsert_opening_cache's self-heal backfills pv onto a pv-less row without
#     touching eval_cp/eval_mate/best_move, and never clobbers an existing pv.


@pytest.mark.asyncio
async def test_fetch_cached_opening_hashes_gates_on_pv_presence(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
) -> None:
    """SEED-076 follow-up: a cache row WITH pv is omittable from the lease; a cache row
    WITHOUT pv is NOT (the worker must still evaluate it fresh to get a pv)."""
    from app.routers.eval_remote import _fetch_cached_opening_hashes

    _patch_router_session(monkeypatch, eval_worker_session_maker)

    base = 76400
    hash_with_pv = base
    hash_without_pv = base + 1
    await _insert_opening_cache_with_pv(
        eval_worker_session_maker, [(hash_with_pv, 30, None, "g1f3", "g1f3 b8c6")]
    )
    await _insert_opening_cache(eval_worker_session_maker, [(hash_without_pv, 10, None, "d2d4")])

    gp_rows: list[tuple[int, int, int | None, int | None]] = [
        (2, hash_with_pv, None, None),
        (4, hash_without_pv, None, None),
    ]
    try:
        async with eval_worker_session_maker() as session:
            cached = await _fetch_cached_opening_hashes(session, gp_rows)
        assert hash_with_pv in cached, "pv-bearing cache row must be omittable from the lease"
        assert hash_without_pv not in cached, (
            "pv-less cache row must NOT be omitted — the worker still needs to evaluate it"
        )
    finally:
        await _delete_opening_cache(eval_worker_session_maker, [hash_with_pv, hash_without_pv])


@pytest.mark.asyncio
async def test_atomic_submit_merges_cached_pv_into_flaw_line_not_sentineled(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """SEED-076 follow-up (req a): a cached opening ply omitted from a partial atomic
    submit still gets its pv merged into engine_result_map — game_positions.pv at the
    flaw-adjacent ply matches the cached pv, the flaw's PV lines are NOT []-sentineled
    (left NULL / still fillable), and _build_flaw_blob_lease_positions walks a real,
    non-empty lease for it instead of a D-06 sentinel.

    Uses _SIX_PLY_PGN_142 / _BLUNDER_SUBMIT_EVALS_142 (blunder at ply 2, flaw_ply=2):
    missed line starts at ply 2 (the flaw's own board), allowed line at ply 3.
    """
    from app.models.game_flaw import GameFlaw
    from app.routers.eval_remote import _apply_atomic_submit
    from app.services.eval_drain import _build_flaw_blob_lease_positions

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    user_id = eval_worker_test_user
    base = 76500
    game_id = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
    await _insert_game_positions(
        eval_worker_session_maker,
        user_id,
        game_id,
        [{"ply": p, "full_hash": base + p, "eval_cp": None, "eval_mate": None} for p in range(6)],
    )
    # Cache ply 2's position (the flaw's own board, "missed" line node 0) WITH a real,
    # walkable pv — matching what _fetch_cached_opening_hashes would have made the
    # lease omit. The worker's partial submit below omits ply 2 accordingly.
    cached_pv = "g1f3 b8c6"
    await _insert_opening_cache_with_pv(
        eval_worker_session_maker, [(base + 2, 30, None, "g1f3", cached_pv)]
    )
    # Ply 3 ("allowed" line node 0) is NOT cache-omitted — the worker evaluates and
    # submits it directly, including a real pv so the allowed line is walkable too
    # (isolating the fix under test to the missed line's cache-merged pv).
    allowed_pv = "b8c6 f1c4"
    partial = [dict(e) for e in _BLUNDER_SUBMIT_EVALS_142 if e["ply"] != 2]
    for e in partial:
        if e["ply"] == 3:
            e["pv"] = allowed_pv

    try:
        resp = await _apply_atomic_submit(
            game_id, _atomic_request(game_id, partial), worker_id="test-worker", last_ip=None
        )
        assert resp.failed_ply_count == 0, (
            f"cached opening must fill the hole (eval + pv), got {resp.failed_ply_count}"
        )

        row2 = await _get_game_position(eval_worker_session_maker, game_id, 2)
        assert row2 is not None and row2["pv"] == cached_pv, (
            f"game_positions.pv at the flaw-adjacent cached ply must equal the cached "
            f"pv, got {row2}"
        )

        async with eval_worker_session_maker() as verify:
            flaw_row = (
                await verify.execute(
                    select(GameFlaw.allowed_pv_lines, GameFlaw.missed_pv_lines).where(
                        GameFlaw.game_id == game_id, GameFlaw.ply == 2
                    )
                )
            ).one_or_none()
        assert flaw_row is not None, "flaw at ply 2 must exist"
        allowed_lines, missed_lines = flaw_row
        assert allowed_lines != [], "allowed_pv_lines must NOT be []-sentineled"
        assert missed_lines != [], "missed_pv_lines must NOT be []-sentineled"

        # _build_flaw_blob_lease_positions must find a real, walkable lease for the
        # flaw (not a D-06 sentinel) — proving the merged pv reached game_positions.pv
        # for BOTH lines and is walkable.
        positions, sentinel_lines = await _build_flaw_blob_lease_positions(game_id)
        assert (2, "missed") not in sentinel_lines, "missed line must not be sentineled"
        assert (2, "allowed") not in sentinel_lines, "allowed line must not be sentineled"
        assert len(positions) > 0, "a real, non-empty lease must be built for the flaw"
    finally:
        await _delete_games(eval_worker_session_maker, [game_id])
        await _delete_opening_cache(eval_worker_session_maker, [base + 2])


@pytest.mark.asyncio
async def test_upsert_opening_cache_backfills_pv_without_overwriting_eval_or_existing_pv(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
) -> None:
    """SEED-076 follow-up (req c): _upsert_opening_cache's self-heal backfills pv onto
    a pv-less existing row without touching eval_cp/eval_mate/best_move, and leaves an
    existing non-NULL pv untouched (first-write-wins for pv too, once set)."""
    import chess

    from app.models.opening_position_eval import OpeningPositionEval
    from app.services.eval_drain import _FullPlyEvalTarget, _upsert_opening_cache

    board = chess.Board()
    base = 76600
    hash_pv_less = base
    hash_pv_bearing = base + 1

    # Row A: pre-existing pv-less cache row — must self-heal pv only.
    await _insert_opening_cache(eval_worker_session_maker, [(hash_pv_less, 42, None, "e2e4")])
    # Row B: pre-existing cache row that ALREADY has a real pv — must not be clobbered.
    await _insert_opening_cache_with_pv(
        eval_worker_session_maker, [(hash_pv_bearing, 10, None, "d2d4", "d2d4 d7d5")]
    )

    t_a = _FullPlyEvalTarget(
        game_id=1, ply=2, full_hash=hash_pv_less, board=board, eval_cp=None, eval_mate=None
    )
    t_b = _FullPlyEvalTarget(
        game_id=1, ply=4, full_hash=hash_pv_bearing, board=board, eval_cp=None, eval_mate=None
    )
    # Different eval/best_move/pv than what's cached — proves first-write-wins on
    # eval/best_move (row A) and on pv once already set (row B), with row A's pv
    # backfilled from this fresh engine result.
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
        2: (99, None, "a2a4", "a2a4 a7a5"),
        4: (55, None, "c2c4", "c2c4 c7c5"),
    }

    try:
        async with eval_worker_session_maker() as session:
            await _upsert_opening_cache(session, [t_a, t_b], engine_result_map)
            await session.commit()

        async with eval_worker_session_maker() as session:
            rows = (
                await session.execute(
                    select(
                        OpeningPositionEval.full_hash,
                        OpeningPositionEval.eval_cp,
                        OpeningPositionEval.eval_mate,
                        OpeningPositionEval.best_move,
                        OpeningPositionEval.pv,
                    ).where(OpeningPositionEval.full_hash.in_([hash_pv_less, hash_pv_bearing]))
                )
            ).all()
        by_hash = {r[0]: (r[1], r[2], r[3], r[4]) for r in rows}

        assert by_hash[hash_pv_less] == (42, None, "e2e4", "a2a4 a7a5"), (
            f"row A must keep its original eval/best_move and self-heal pv only: "
            f"{by_hash[hash_pv_less]}"
        )
        assert by_hash[hash_pv_bearing] == (10, None, "d2d4", "d2d4 d7d5"), (
            f"row B's existing pv must NOT be overwritten: {by_hash[hash_pv_bearing]}"
        )
    finally:
        await _delete_opening_cache(eval_worker_session_maker, [hash_pv_less, hash_pv_bearing])


# ─── Phase 177 BACK-02/03: tier-4b bestmove-lease/submit endpoint tests ──────

_BESTMOVE_LEASE_URL = "/api/eval/remote/bestmove-lease"
_BESTMOVE_SUBMIT_URL = "/api/eval/remote/bestmove-submit"

# "1. a4 a5 2. h4 h5" -- find_opening_ply_count(['a4','a5','h4']) == 2 (verified
# against the real openings.tsv data): plies 0-1 are book, plies 2-3 are out-of-book.
# UCIs: a4=a2a4, a5=a7a5, h4=h2h4, h5=h7h5.
_BESTMOVE_PGN: str = "1. a4 a5 2. h4 h5 *"


class TestBestMoveLeaseEndpoint:
    """Phase 177 Task 2: POST /eval/remote/bestmove-lease.

    Tests:
    - bestmove_lease_requires_operator_token: missing/wrong token -> 403/401
    - bestmove_lease_disabled_returns_204: BEST_MOVE_BACKFILL_ENABLED=False -> 204,
      no DB round-trip (settings gate checked BEFORE any claim)
    - bestmove_lease_empty_queue_returns_204: no tier-4b pick -> 204
    - bestmove_lease_candidate_plies: server-recomputed candidate set matches the
      out-of-book/played==best/usable-eval reconstruction
    - bestmove_lease_zero_candidates_stamps_completed: a picked game with zero
      candidates stamps best_moves_completed_at directly (Pitfall 2 forward progress)
    """

    @pytest.mark.asyncio
    async def test_bestmove_lease_requires_operator_token(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", "")
        async with _make_client() as client:
            resp = await client.post(_BESTMOVE_LEASE_URL)
        assert resp.status_code == 403, f"Expected 403, got {resp.status_code}: {resp.text}"

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        async with _make_client() as client:
            resp = await client.post(_BESTMOVE_LEASE_URL, headers={"X-Operator-Token": "bad-token"})
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_bestmove_lease_disabled_returns_204(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        """BEST_MOVE_BACKFILL_ENABLED=False -> 204 before any DB round-trip
        (D-04 single switch)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "BEST_MOVE_BACKFILL_ENABLED", False)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        spy = AsyncMock(return_value=None)
        monkeypatch.setattr(eval_remote_module, "_claim_tier4_bestmove", spy)

        async with _make_client() as client:
            resp = await client.post(
                _BESTMOVE_LEASE_URL,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 204, f"Expected 204, got {resp.status_code}: {resp.text}"
        assert spy.await_count == 0, "_claim_tier4_bestmove must not be called when disabled"

    @pytest.mark.asyncio
    async def test_bestmove_lease_empty_queue_returns_204(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "BEST_MOVE_BACKFILL_ENABLED", True)
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(
            eval_remote_module, "_claim_tier4_bestmove", AsyncMock(return_value=None)
        )

        async with _make_client() as client:
            resp = await client.post(
                _BESTMOVE_LEASE_URL,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 204, f"Expected 204, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_bestmove_lease_candidate_plies(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A tier-4b-eligible game with an out-of-book played==best ply leases 200
        with exactly the server-recomputed candidate set (ply+fen only)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "BEST_MOVE_BACKFILL_ENABLED", True)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_BESTMOVE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            [
                {"ply": 0, "full_hash": 1, "best_move": "a2a4", "eval_cp": 1},
                {"ply": 1, "full_hash": 2, "best_move": "h2h4", "eval_cp": 2},
                {"ply": 2, "full_hash": 3, "best_move": "h2h4", "eval_cp": 3},
                # ply 3: played h7h5, stored best differs -> not a candidate.
                {"ply": 3, "full_hash": 4, "best_move": "a7a6", "eval_cp": 4},
            ],
        )
        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_bestmove",
            AsyncMock(return_value=(game_id, user_id)),
        )

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_LEASE_URL,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            body = resp.json()
            assert body["game_id"] == game_id
            assert "leased_at" in body
            positions = body["positions"]
            assert [p["ply"] for p in positions] == [2], (
                f"Expected exactly candidate ply 2, got {positions}"
            )
            assert "move_uci" not in positions[0], "lease positions must carry no move_uci field"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_lease_zero_candidates_stamps_completed(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A picked game with zero candidate plies (no GamePosition rows at all)
        stamps best_moves_completed_at directly and returns 204 (Pitfall 2 forward
        progress -- the ES lottery must never re-draw it)."""
        import app.routers.eval_remote as eval_remote_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "BEST_MOVE_BACKFILL_ENABLED", True)
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_BESTMOVE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        # No GamePosition rows inserted -> zero candidates.
        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_bestmove",
            AsyncMock(return_value=(game_id, user_id)),
        )

        try:
            assert (
                await _get_game_best_moves_completed_at(eval_worker_session_maker, game_id) is None
            )

            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_LEASE_URL,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 204, f"Expected 204, got {resp.status_code}: {resp.text}"

            stamped = await _get_game_best_moves_completed_at(eval_worker_session_maker, game_id)
            assert stamped is not None, (
                "best_moves_completed_at must be stamped directly on a zero-candidate pick"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])


async def _seed_bestmove_submit_game(
    session_maker: async_sessionmaker[AsyncSession],
    user_id: int,
    *,
    lichess: bool = False,
) -> int:
    """Insert a tier-4b-eligible game (_BESTMOVE_PGN) with GamePosition rows wired
    so ply 2 (h4, white) is the out-of-book played==best candidate: eval_of_position(2)
    (row 1's stored eval) is a wide +300 so a submitted second_cp=-100 clears
    INACCURACY_DROP. Ratings are seeded so _build_best_move_candidates can pin the
    Maia ELO. With lichess=True the stored eval_cp represents a LICHESS %eval
    (lichess_evals_at set) — the case where best_cp must NOT come from the stored row.
    Returns game_id."""
    from app.models.game import Game

    now = datetime.now(timezone.utc)
    game_id = await _insert_game(
        session_maker,
        user_id,
        pgn=_BESTMOVE_PGN,
        full_evals_completed_at=now,
        lichess_evals_at=now if lichess else None,
    )
    await _insert_game_positions(
        session_maker,
        user_id,
        game_id,
        [
            {"ply": 0, "full_hash": 61500, "best_move": "a2a4", "eval_cp": 1},
            {"ply": 1, "full_hash": 61501, "best_move": "h2h4", "eval_cp": 300},
            {"ply": 2, "full_hash": 61502, "best_move": "h2h4", "eval_cp": 3},
            # ply 3: played h7h5, stored best differs -> never a candidate.
            {"ply": 3, "full_hash": 61503, "best_move": "a7a6", "eval_cp": 4},
        ],
    )
    async with session_maker() as rating_session:
        await rating_session.execute(
            sa.update(Game)
            .where(Game.id == game_id)
            .values(white_rating=1500, black_rating=1500, time_control_bucket="blitz")
        )
        await rating_session.commit()
    return game_id


class TestBestMoveSubmitEndpoint:
    """Phase 177 Task 3: POST /eval/remote/bestmove-submit.

    Tests:
    - bestmove_submit_sf_version_mismatch: version gate -> 422
    - bestmove_submit_game_not_found: -> 404
    - bestmove_submit_minimal_write_no_reclassify: writes ONLY game_best_moves +
      stamps best_moves_completed_at; apply_full_eval/_classify_and_fill_oracle
      are never called (structural isolation, T-177-07)
    - bestmove_submit_out_of_range_ply_422: a submitted ply outside [0, game_length)
      -> 422, no write (T-177-05)
    - bestmove_submit_foreign_ply_dropped: an in-range, non-candidate ply's
      second-best is silently dropped -> no row for that ply, still 200 (T-177-06)
    - bestmove_submit_existing_flaws_unchanged: game_flaws rows are byte-identical
      before/after (T-177-07)
    """

    @pytest.mark.asyncio
    async def test_bestmove_submit_sf_version_mismatch(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "Stockfish 18")
        payload = {
            "game_id": 1,
            "sf_version": "Stockfish 17",
            "evals": [],
        }
        async with _make_client() as client:
            resp = await client.post(
                _BESTMOVE_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_bestmove_submit_game_not_found(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
    ) -> None:
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        payload = {
            "game_id": -1,
            "sf_version": "Stockfish 18",
            "evals": [],
        }
        async with _make_client() as client:
            resp = await client.post(
                _BESTMOVE_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert resp.status_code == 404, f"Expected 404, got {resp.status_code}: {resp.text}"

    @pytest.mark.asyncio
    async def test_bestmove_submit_minimal_write_no_reclassify(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A submit writes a game_best_moves row + stamps best_moves_completed_at,
        and does NOT call apply_full_eval / _classify_and_fill_oracle (S-06/T-177-07)."""
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        # 177-REVIEW CR-01 fix: the stamp is now gated on maia_engine.is_maia_available(),
        # so this positive-path test must mark Maia present (sentinel session object),
        # mirroring test_full_drain_tick_tier4b_minimal_path in test_full_eval_drain.py.
        monkeypatch.setattr(maia_engine, "_session", object())

        apply_full_eval_spy = AsyncMock(side_effect=AssertionError("must not be called"))
        classify_spy = AsyncMock(side_effect=AssertionError("must not be called"))
        monkeypatch.setattr(eval_apply_module, "apply_full_eval", apply_full_eval_spy)
        monkeypatch.setattr(eval_apply_module, "_classify_and_fill_oracle", classify_spy)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id)

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                {"ply": 2, "second_cp": -100, "second_mate": None, "second_uci": "a2a3"},
            ],
        }

        try:
            assert await _count_game_best_moves(eval_worker_session_maker, game_id) == 0
            assert (
                await _get_game_best_moves_completed_at(eval_worker_session_maker, game_id) is None
            )

            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            body = resp.json()
            assert body["game_id"] == game_id
            assert body["rows_written"] == 1, f"Expected exactly 1 row written, got {body}"

            assert apply_full_eval_spy.await_count == 0, "apply_full_eval must never be called"
            assert classify_spy.await_count == 0, "_classify_and_fill_oracle must never be called"

            assert await _count_game_best_moves(eval_worker_session_maker, game_id) == 1
            stamped = await _get_game_best_moves_completed_at(eval_worker_session_maker, game_id)
            assert stamped is not None, "best_moves_completed_at must be stamped on submit"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_lichess_uses_worker_best_cp(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Quick 260719-fsz (new worker, Option B): for a LICHESS game the stored
        eval_cp is lichess %eval, so the worker's submitted fresh best_cp must be
        used for the game_best_moves row (NOT the stored 300)."""
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        monkeypatch.setattr(maia_engine, "_session", object())
        # A submitted best_cp means NO re-search — assert the engine is never called.
        no_search = AsyncMock(return_value=(None, None, None, None, None, None, None))
        monkeypatch.setattr(eval_apply_module.engine_service, "evaluate_nodes_multipv2", no_search)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id, lichess=True)
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                {
                    "ply": 2,
                    "second_cp": -100,
                    "second_mate": None,
                    "second_uci": "a2a3",
                    "best_cp": 250,  # fresh Stockfish best from the worker (Option B)
                    "best_mate": None,
                },
            ],
        }
        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL, json=payload, headers={"X-Operator-Token": _TEST_TOKEN}
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            best_cp_by_ply = await _get_best_cp_by_ply(eval_worker_session_maker, game_id)
            assert best_cp_by_ply.get(2) == 250, (
                f"lichess game must store the worker-submitted best_cp 250, not the stored "
                f"lichess eval 300; got {best_cp_by_ply}"
            )
            assert no_search.await_count == 0, "No re-search when the worker submits best_cp"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_lichess_old_worker_researches_best_cp(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Quick 260719-fsz (old worker, transition fallback): a pre-260719-fsz worker
        omits best_cp, so for a LICHESS game the server re-searches the candidate ply
        and stores the FRESH Stockfish best_cp (275), never the stored lichess eval (300)."""
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        monkeypatch.setattr(maia_engine, "_session", object())
        # Fresh re-search returns best_cp=275 (res[0]); the runner-up here is unused
        # (second comes from the submitted -100).
        research = AsyncMock(return_value=(275, None, "h2h4", "h2h4", -999, None, "a2a3"))
        monkeypatch.setattr(eval_apply_module.engine_service, "evaluate_nodes_multipv2", research)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id, lichess=True)
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                # Old-worker payload: no best_cp/best_mate keys.
                {"ply": 2, "second_cp": -100, "second_mate": None, "second_uci": "a2a3"},
            ],
        }
        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL, json=payload, headers={"X-Operator-Token": _TEST_TOKEN}
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            best_cp_by_ply = await _get_best_cp_by_ply(eval_worker_session_maker, game_id)
            assert best_cp_by_ply.get(2) == 275, (
                f"lichess game from an old worker must re-search best_cp (275), not use the "
                f"stored lichess eval (300); got {best_cp_by_ply}"
            )
            assert research.await_count == 1, (
                "The stale lichess ply must be re-searched exactly once"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_engine_ignores_worker_best_cp(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Quick 260719-fsz: an ENGINE game's stored eval already IS our Stockfish, so
        it keeps the stored best_cp (300) and ignores any submitted best_cp — byte-identical
        to pre-260719-fsz behavior (the is_lichess_eval_game guard)."""
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        monkeypatch.setattr(maia_engine, "_session", object())
        no_search = AsyncMock(return_value=(None, None, None, None, None, None, None))
        monkeypatch.setattr(eval_apply_module.engine_service, "evaluate_nodes_multipv2", no_search)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(
            eval_worker_session_maker, user_id, lichess=False
        )
        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                # Even a new worker's submitted best_cp is ignored for engine games.
                {
                    "ply": 2,
                    "second_cp": -100,
                    "second_mate": None,
                    "second_uci": "a2a3",
                    "best_cp": 999,
                    "best_mate": None,
                },
            ],
        }
        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL, json=payload, headers={"X-Operator-Token": _TEST_TOKEN}
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            best_cp_by_ply = await _get_best_cp_by_ply(eval_worker_session_maker, game_id)
            assert best_cp_by_ply.get(2) == 300, (
                f"engine game must keep the stored best_cp 300 and ignore the submitted 999; "
                f"got {best_cp_by_ply}"
            )
            assert no_search.await_count == 0, "Engine games must never re-search"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_maia_absent_never_stamps(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """GUARDRAIL (177-REVIEW CR-01): with maia_engine._session forced to
        None, best_moves_completed_at MUST stay NULL after a submit even
        though score_move is mocked to SUCCEED (rows_written would be
        non-zero if row-count alone gated the stamp) -- proving the stamp is
        independently gated by maia_engine.is_maia_available(), never
        inferred from row count (mirrors the drain-path guardrail,
        test_maia_absent_never_stamps_best_moves_completed_at in
        tests/services/test_full_eval_drain.py). Before the fix,
        _apply_bestmove_submit stamped unconditionally, permanently
        excluding a Maia-absent backend's submits from the tier-4b lottery
        (best_moves_completed_at IS NULL predicate) with zero rows written."""
        import app.services.eval_apply as eval_apply_module
        from app.services import maia_engine

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        # THE GUARDRAIL SETUP: Maia session forced ABSENT, but score_move is
        # mocked to SUCCEED anyway. If the stamp were (incorrectly) gated by
        # rows_written being non-zero rather than is_maia_available(), this
        # test would wrongly observe the stamp fire.
        monkeypatch.setattr(maia_engine, "_session", None)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id)

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                {"ply": 2, "second_cp": -100, "second_mate": None, "second_uci": "a2a3"},
            ],
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

            stamped = await _get_game_best_moves_completed_at(eval_worker_session_maker, game_id)
            assert stamped is None, (
                "GUARDRAIL VIOLATION: best_moves_completed_at must stay NULL when "
                "maia_engine._session is None (Maia-absent backend), even though "
                "score_move was mocked to succeed. Stamping here would "
                "permanently lock this game out of the tier-4b lottery on a "
                "Maia-absent backend (D-01 correctness requirement)."
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_out_of_range_ply_422(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """A submitted ply outside [0, game_length) is rejected 422 before any
        write (T-177-05)."""
        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id)

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                # game_length == 4 (plies 0-3) -> ply 4 is one past the end.
                {"ply": 4, "second_cp": -100, "second_mate": None, "second_uci": "a2a3"},
            ],
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
            assert await _count_game_best_moves(eval_worker_session_maker, game_id) == 0, (
                "Rejection must happen before any write"
            )
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_foreign_ply_dropped(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """An in-range ply that is NOT a real candidate (ply 3: played != stored
        best) is silently dropped -- no row for it, and the request still
        succeeds (T-177-06, mirrors the second_best guard precedent)."""
        import app.services.eval_apply as eval_apply_module

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)
        # Ply 2 IS a real candidate with no submitted runner-up, so
        # _build_best_move_candidates fires its Pitfall-1 fallback for it. With a
        # warm global Stockfish pool (earlier tests in a serial full-suite run) the
        # real engine call succeeded and legitimately wrote a ply-2 row, flipping
        # rows_written to 1 — an order-dependent failure. Stub the fallback to
        # return no runner-up so this test isolates the foreign-ply invariant only.
        fallback_stub = AsyncMock(return_value=(None, None, None, None, None, None, None))
        monkeypatch.setattr(
            eval_apply_module.engine_service, "evaluate_nodes_multipv2", fallback_stub
        )

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id)

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                # ply 3 is in-range but never a candidate (played != stored best).
                {"ply": 3, "second_cp": -100, "second_mate": None, "second_uci": "a2a3"},
            ],
        }

        try:
            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"
            assert resp.json()["rows_written"] == 0, (
                "A foreign (non-candidate) ply must produce no row"
            )
            assert await _count_game_best_moves(eval_worker_session_maker, game_id) == 0
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])

    @pytest.mark.asyncio
    async def test_bestmove_submit_existing_flaws_unchanged(
        self,
        monkeypatch: pytest.MonkeyPatch,
        eval_worker_session_maker: async_sessionmaker[AsyncSession],
        eval_worker_test_user: int,
    ) -> None:
        """Existing game_flaws rows are byte-identical before/after a bestmove
        submit -- game_flaws is never read or written here (T-177-07)."""
        import app.services.eval_apply as eval_apply_module
        from app.models.game_flaw import GameFlaw

        monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
        monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
        _patch_router_session(monkeypatch, eval_worker_session_maker)
        monkeypatch.setattr(eval_apply_module, "score_move", lambda fen, elo, uci: 0.1)

        user_id = eval_worker_test_user
        game_id = await _seed_bestmove_submit_game(eval_worker_session_maker, user_id)
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, game_id, ply=2)

        async def _snapshot_flaws() -> list[tuple[object, ...]]:
            async with eval_worker_session_maker() as session:
                result = await session.execute(
                    select(
                        GameFlaw.game_id,
                        GameFlaw.ply,
                        GameFlaw.severity,
                        GameFlaw.phase,
                        GameFlaw.is_miss,
                        GameFlaw.is_lucky,
                        GameFlaw.is_reversed,
                        GameFlaw.is_squandered,
                        GameFlaw.allowed_pv_lines,
                        GameFlaw.missed_pv_lines,
                    )
                    .where(GameFlaw.game_id == game_id)
                    .order_by(GameFlaw.ply)
                )
                return [tuple(row) for row in result.all()]

        payload = {
            "game_id": game_id,
            "sf_version": "Stockfish 18",
            "evals": [
                {"ply": 2, "second_cp": -100, "second_mate": None, "second_uci": "a2a3"},
            ],
        }

        try:
            before = await _snapshot_flaws()
            assert len(before) == 1, "fixture must seed exactly one flaw row"

            async with _make_client() as client:
                resp = await client.post(
                    _BESTMOVE_SUBMIT_URL,
                    json=payload,
                    headers={"X-Operator-Token": _TEST_TOKEN},
                )
            assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text}"

            after = await _snapshot_flaws()
            assert after == before, "game_flaws rows must be byte-identical after a bestmove submit"
        finally:
            await _delete_games(eval_worker_session_maker, [game_id])
