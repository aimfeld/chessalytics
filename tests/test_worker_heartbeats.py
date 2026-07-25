"""Tests for the worker_heartbeats upsert-on-submit registry (Phase 149 PRUNE-06/04).

Covers:
- test_worker_heartbeat_accumulates_across_all_three_submit_lanes: sequential
  entry-submit -> atomic-submit -> flaw-blob-submit from the same worker_id
  accumulates submit_count/evals_submitted; the atomic lane's
  worker_schema_version survives the later flaw-blob-submit (which never sends
  it) via the repository's coalesce guard (D-03).
- test_worker_heartbeat_null_client_last_ip: request.client is None (no client
  info on the ASGI scope) -> last_ip is stored as NULL, upsert still succeeds.

Reuses DB/fixture helpers from tests/test_eval_worker_endpoints.py (session-scoped
eval_worker_session_maker/eval_worker_test_user, _insert_game/_insert_game_positions,
_patch_router_session, the flaw-blob-lease PV fixtures, the operator-token constant)
rather than duplicating them — see that module's own docstring for the session-
patching rationale.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
import sqlalchemy as sa
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import settings
from app.main import app
from app.models.worker_heartbeat import WorkerHeartbeat
from app.repositories.worker_heartbeat_repository import upsert_worker_heartbeat
from tests.test_eval_worker_endpoints import (
    _BLUNDER_SUBMIT_EVALS_142,
    _FLAW_LEASE_PGN,
    _SIX_PLY_PGN_142,
    _TEST_TOKEN,
    _WALKABLE_PV_PLY2,
    _WALKABLE_PV_PLY3,
    _delete_games,
    _insert_flaw_for_lease_test,
    _insert_game,
    _insert_game_position_pv,
    _insert_game_positions,
    _patch_router_session,
    eval_worker_session_maker,
    eval_worker_test_user,
)

__all__ = ["eval_worker_session_maker", "eval_worker_test_user"]

_ENTRY_SUBMIT_URL = "/api/eval/remote/entry-submit"
_ATOMIC_SUBMIT_URL = "/api/eval/remote/atomic-submit"
_FLAW_BLOB_LEASE_URL = "/api/eval/remote/flaw-blob-lease"
_FLAW_BLOB_SUBMIT_URL = "/api/eval/remote/flaw-blob-submit"

# Default client address for the ASGI test transport (matches httpx's own default).
_DEFAULT_CLIENT_ADDR: tuple[str, int] = ("127.0.0.1", 123)


def _make_client(client: tuple[str, int] | None = _DEFAULT_CLIENT_ADDR) -> httpx.AsyncClient:
    """ASGI test client. Pass client=None to simulate request.client is None
    (verifies last_ip is stored as NULL rather than crashing — D-06 nullability).
    """
    transport = httpx.ASGITransport(app=app, client=client)  # ty: ignore[invalid-argument-type]  # httpx types client as non-optional but accepts None at runtime (Starlette Request.client returns None)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _get_worker_heartbeat(
    session_maker: async_sessionmaker[AsyncSession],
    worker_id: str,
) -> dict[str, object] | None:
    """Fetch a worker_heartbeats row as a plain dict, or None if absent."""
    async with session_maker() as session:
        row = (
            await session.execute(
                select(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == worker_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        return {
            "last_ip": row.last_ip,
            "sf_version": row.sf_version,
            "worker_schema_version": row.worker_schema_version,
            "submit_count": row.submit_count,
            "evals_submitted": row.evals_submitted,
            "holes_submitted": row.holes_submitted,
            "plies_leased": row.plies_leased,
        }


async def _delete_worker_heartbeat(
    session_maker: async_sessionmaker[AsyncSession],
    worker_id: str,
) -> None:
    async with session_maker() as session:
        await session.execute(
            sa.delete(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == worker_id)
        )
        await session.commit()


async def _lease_entry_games_to_worker(
    session_maker: async_sessionmaker[AsyncSession],
    game_ids: list[int],
    worker_id: str,
) -> None:
    """Directly set Game.entry_eval_leased_by/entry_eval_lease_expiry, bypassing
    /entry-lease (whose ENTRY_LEASE_BACKLOG_THRESHOLD=300 padding requirement is
    unrelated to this test's scope — entry_submit_eval's ownership guard only
    checks these two columns plus evals_completed_at IS NULL).
    """
    from app.models.game import Game

    async with session_maker() as session:
        await session.execute(
            update(Game)
            .where(Game.id.in_(game_ids))
            .values(
                entry_eval_leased_by=worker_id,
                entry_eval_lease_expiry=datetime.now(timezone.utc) + timedelta(seconds=60),
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_worker_heartbeat_accumulates_across_all_three_submit_lanes(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """Sequential entry-submit -> atomic-submit -> flaw-blob-submit from the same
    worker_id accumulates submit_count/evals_submitted, and worker_schema_version
    (set by atomic-submit) is never clobbered back to NULL by a later lane that
    doesn't send it (D-03 coalesce guard).
    """
    import app.routers.eval_remote as eval_remote_module

    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    worker_id = "w1-heartbeat"
    user_id = eval_worker_test_user
    game_ids: list[int] = []

    try:
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)

        # ── Step 1: entry-submit, 2 evals from worker_id ──────────────────────
        entry_game_a = await _insert_game(
            eval_worker_session_maker, user_id, evals_completed_at=None
        )
        entry_game_b = await _insert_game(
            eval_worker_session_maker, user_id, evals_completed_at=None
        )
        game_ids += [entry_game_a, entry_game_b]
        for gid in (entry_game_a, entry_game_b):
            await _insert_game_positions(
                eval_worker_session_maker,
                user_id,
                gid,
                [
                    {
                        "ply": p,
                        "full_hash": 900000 + gid * 10 + p,
                        "phase": 1,
                        "eval_cp": None,
                        "eval_mate": None,
                    }
                    for p in range(4)
                ],
            )
        await _lease_entry_games_to_worker(
            eval_worker_session_maker, [entry_game_a, entry_game_b], worker_id
        )

        entry_payload = {
            "sf_version": "Stockfish 18",
            "evals": [
                {"game_id": entry_game_a, "ply": 0, "eval_cp": 10, "eval_mate": None},
                {"game_id": entry_game_b, "ply": 0, "eval_cp": 20, "eval_mate": None},
            ],
        }
        async with _make_client() as client:
            resp = await client.post(
                _ENTRY_SUBMIT_URL,
                json=entry_payload,
                headers={"X-Operator-Token": _TEST_TOKEN, "X-Worker-Id": worker_id},
            )
        assert resp.status_code == 200, f"entry-submit: {resp.status_code} {resp.text}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None, "worker_heartbeats row must exist after entry-submit"
        assert hb["submit_count"] == 1
        assert hb["evals_submitted"] == 2
        assert hb["sf_version"] == "Stockfish 18"
        assert hb["worker_schema_version"] is None, (
            "entry-submit never sends worker_schema_version (D-03)"
        )
        assert hb["last_ip"] == _DEFAULT_CLIENT_ADDR[0]

        # ── Step 2: atomic-submit, 7 evals + worker_schema_version=3 ──────────
        atomic_game = await _insert_game(eval_worker_session_maker, user_id, pgn=_SIX_PLY_PGN_142)
        game_ids.append(atomic_game)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            atomic_game,
            [
                {"ply": p, "full_hash": 910000 + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )
        atomic_payload = {
            "game_id": atomic_game,
            "sf_version": "Stockfish 18",
            "worker_schema_version": 3,
            "evals": list(_BLUNDER_SUBMIT_EVALS_142),
            "blob_nodes": [],
            "job_id": None,
        }
        async with _make_client() as client:
            resp = await client.post(
                _ATOMIC_SUBMIT_URL,
                json=atomic_payload,
                headers={"X-Operator-Token": _TEST_TOKEN, "X-Worker-Id": worker_id},
            )
        assert resp.status_code == 200, f"atomic-submit: {resp.status_code} {resp.text}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None
        assert hb["submit_count"] == 2
        assert hb["evals_submitted"] == 2 + len(_BLUNDER_SUBMIT_EVALS_142)
        assert hb["worker_schema_version"] == 3, (
            "atomic-submit's worker_schema_version must be recorded"
        )

        # ── Step 3: flaw-blob-submit (schema has no worker_schema_version field) ──
        blob_game = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_FLAW_LEASE_PGN,
            full_evals_completed_at=datetime.now(timezone.utc),
        )
        game_ids.append(blob_game)
        await _insert_flaw_for_lease_test(eval_worker_session_maker, user_id, blob_game, ply=2)
        for ply, pv in [(0, None), (1, None), (2, _WALKABLE_PV_PLY2), (3, _WALKABLE_PV_PLY3)]:
            await _insert_game_position_pv(eval_worker_session_maker, user_id, blob_game, ply, pv)

        monkeypatch.setattr(
            eval_remote_module,
            "_claim_tier4_blob",
            AsyncMock(return_value=(blob_game, user_id)),
        )
        async with _make_client() as client:
            lease_resp = await client.post(
                _FLAW_BLOB_LEASE_URL,
                headers={"X-Operator-Token": _TEST_TOKEN},
            )
        assert lease_resp.status_code == 200, f"flaw-blob-lease: {lease_resp.text}"
        lease_positions = lease_resp.json()["positions"]
        assert lease_positions, "expected non-empty flaw-blob-lease positions"

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
            resp = await client.post(
                _FLAW_BLOB_SUBMIT_URL,
                json={"game_id": blob_game, "sf_version": "Stockfish 18", "evals": submit_evals},
                headers={"X-Operator-Token": _TEST_TOKEN, "X-Worker-Id": worker_id},
            )
        assert resp.status_code == 200, f"flaw-blob-submit: {resp.status_code} {resp.text}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None
        assert hb["submit_count"] == 3
        assert hb["evals_submitted"] == 2 + len(_BLUNDER_SUBMIT_EVALS_142) + len(submit_evals)
        assert hb["worker_schema_version"] == 3, (
            "flaw-blob-submit must NOT clobber the atomic lane's worker_schema_version "
            "back to NULL (D-03 coalesce guard)"
        )
        # 260725-da3: the two hole counters are ATOMIC-LANE-ONLY. Only step 2 was an
        # atomic-submit, and it was hole-free, so holes_submitted must still be 0 and
        # plies_leased must count that one lane's evals — never the entry-submit or
        # flaw-blob-submit ones.
        assert hb["holes_submitted"] == 0, (
            "entry-submit / flaw-blob-submit / a hole-free atomic-submit must all "
            f"leave holes_submitted at 0, got {hb['holes_submitted']}"
        )
        assert hb["plies_leased"] == len(_BLUNDER_SUBMIT_EVALS_142), (
            "plies_leased must count ONLY the atomic lane's submitted plies (the "
            f"entry and flaw-blob lanes must not inflate it), got {hb['plies_leased']}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)


@pytest.mark.asyncio
async def test_worker_hole_counters_accumulate_across_atomic_submits(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """holes_submitted / plies_leased accumulate across atomic-submits and are moved
    by NON-cap (Path B) attempts (quick task 260725-da3, FLAWCHESS-8B).

    Two holed submits then one hole-free submit, all from the same worker_id:
    holes_submitted goes 1 -> 2 -> 2 (accumulator, never last-value, and a clean
    submit leaves it alone) while plies_leased advances by len(evals) every time.

    Every game is left at full_eval_attempts=0 so each holed submit takes Path B.
    That is the point of the test: the counters must move on EVERY attempt, not
    only at the MAX_EVAL_ATTEMPTS cap — per-attempt telemetry is what makes a slow
    worker visible before it burns all its retries.
    """
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    worker_id = "w-holes"
    user_id = eval_worker_test_user
    game_ids: list[int] = []
    n_evals = len(_BLUNDER_SUBMIT_EVALS_142)

    async def _make_atomic_game(full_hash_base: int) -> int:
        game_id = await _insert_game(
            eval_worker_session_maker,
            user_id,
            pgn=_SIX_PLY_PGN_142,
            full_eval_attempts=0,  # explicitly under cap -> Path B, not the Path-C cap
        )
        game_ids.append(game_id)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            game_id,
            # Distinct full_hash base per game so no cross-game dedup interaction
            # can fill a hole server-side and change failed_ply_count.
            [
                {"ply": p, "full_hash": full_hash_base + p, "eval_cp": None, "eval_mate": None}
                for p in range(6)
            ],
        )
        return game_id

    async def _post_atomic(game_id: int, evals: list[dict[str, object]]) -> dict[str, object]:
        async with _make_client() as client:
            resp = await client.post(
                _ATOMIC_SUBMIT_URL,
                json={
                    "game_id": game_id,
                    "sf_version": "Stockfish 18",
                    "worker_schema_version": 1,
                    "evals": evals,
                    "blob_nodes": [],
                    "job_id": None,
                },
                headers={"X-Operator-Token": _TEST_TOKEN, "X-Worker-Id": worker_id},
            )
        assert resp.status_code == 200, f"atomic-submit: {resp.status_code} {resp.text}"
        return resp.json()

    def _holed_evals() -> list[dict[str, object]]:
        """One hole: nulling index 6 makes row 5 (pos_eval[6]) NULL on a
        non-terminal row -> failed_ply_count == 1 (same shape as the Path-B/C
        tests in test_eval_worker_endpoints.py).
        """
        evals: list[dict[str, object]] = [dict(e) for e in _BLUNDER_SUBMIT_EVALS_142]
        evals[6]["eval_cp"] = None
        evals[6]["eval_mate"] = None
        return evals

    try:
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)

        # ── Submit 1: holed, under the cap (Path B) ───────────────────────────
        body = await _post_atomic(await _make_atomic_game(930000), _holed_evals())
        assert body["failed_ply_count"] == 1, f"one hole expected: {body}"
        assert body["stamp_complete"] is False, f"Path B expected (under cap): {body}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None, "worker_heartbeats row must exist after atomic-submit"
        assert hb["holes_submitted"] == 1, (
            f"a Path-B holed submit must count its hole, got {hb['holes_submitted']}"
        )
        assert hb["plies_leased"] == n_evals, (
            f"plies_leased must count the submitted plies, got {hb['plies_leased']}"
        )

        # ── Submit 2: holed again, different game, same worker ────────────────
        body = await _post_atomic(await _make_atomic_game(931000), _holed_evals())
        assert body["failed_ply_count"] == 1, f"one hole expected: {body}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None
        assert hb["holes_submitted"] == 2, (
            "holes_submitted must ACCUMULATE across submits (not be last-value), "
            f"got {hb['holes_submitted']}"
        )
        assert hb["plies_leased"] == 2 * n_evals, (
            f"plies_leased must accumulate too, got {hb['plies_leased']}"
        )

        # ── Submit 3: hole-free ──────────────────────────────────────────────
        body = await _post_atomic(
            await _make_atomic_game(932000), list(_BLUNDER_SUBMIT_EVALS_142)
        )
        assert body["failed_ply_count"] == 0, f"hole-free submit expected: {body}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None
        assert hb["holes_submitted"] == 2, (
            "a hole-free submit must leave holes_submitted UNCHANGED, "
            f"got {hb['holes_submitted']}"
        )
        assert hb["plies_leased"] == 3 * n_evals, (
            "a hole-free submit must still advance plies_leased (it is the hole-rate "
            f"denominator), got {hb['plies_leased']}"
        )
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)


@pytest.mark.asyncio
async def test_worker_heartbeat_null_client_last_ip(
    monkeypatch: pytest.MonkeyPatch,
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
    eval_worker_test_user: int,
) -> None:
    """When request.client is None (no client info on the ASGI scope), the
    heartbeat upsert stores last_ip=NULL instead of raising."""
    monkeypatch.setattr(settings, "EVAL_OPERATOR_TOKEN", _TEST_TOKEN)
    monkeypatch.setattr(settings, "EXPECTED_SF_VERSION", "")
    _patch_router_session(monkeypatch, eval_worker_session_maker)

    worker_id = "w-no-client"
    user_id = eval_worker_test_user
    game_ids: list[int] = []

    try:
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)

        entry_game = await _insert_game(eval_worker_session_maker, user_id, evals_completed_at=None)
        game_ids.append(entry_game)
        await _insert_game_positions(
            eval_worker_session_maker,
            user_id,
            entry_game,
            [
                {
                    "ply": p,
                    "full_hash": 920000 + p,
                    "phase": 1,
                    "eval_cp": None,
                    "eval_mate": None,
                }
                for p in range(4)
            ],
        )
        await _lease_entry_games_to_worker(eval_worker_session_maker, [entry_game], worker_id)

        payload = {
            "sf_version": "Stockfish 18",
            "evals": [{"game_id": entry_game, "ply": 0, "eval_cp": 5, "eval_mate": None}],
        }
        async with _make_client(client=None) as client:
            resp = await client.post(
                _ENTRY_SUBMIT_URL,
                json=payload,
                headers={"X-Operator-Token": _TEST_TOKEN, "X-Worker-Id": worker_id},
            )
        assert resp.status_code == 200, f"entry-submit: {resp.status_code} {resp.text}"

        hb = await _get_worker_heartbeat(eval_worker_session_maker, worker_id)
        assert hb is not None, "worker_heartbeats row must exist even with no client info"
        assert hb["last_ip"] is None, "last_ip must be NULL when request.client is None"
    finally:
        await _delete_games(eval_worker_session_maker, game_ids)
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)


@pytest.mark.asyncio
async def test_upsert_worker_heartbeat_oversized_sf_version_never_aborts_caller_session(
    eval_worker_session_maker: async_sessionmaker[AsyncSession],
) -> None:
    """An over-long sf_version (WR-01 code review 2026-07-04) must never abort
    the caller's write transaction — the heartbeat upsert is passive telemetry
    only, never a gate. Defensive truncation to the model's String(50) column
    width means this never even reaches the savepoint's except branch, but the
    outer session must remain fully usable regardless.
    """
    worker_id = "w-oversized"
    oversized_sf_version = "X" * 200

    try:
        async with eval_worker_session_maker() as session:
            await _delete_worker_heartbeat_in_session(session, worker_id)

            await upsert_worker_heartbeat(
                session,
                worker_id=worker_id,
                last_ip="127.0.0.1",
                sf_version=oversized_sf_version,
                worker_schema_version=None,
                n_evals=1,
            )
            await session.commit()

            # The outer session must still be usable for a subsequent query.
            row = (
                await session.execute(
                    select(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == worker_id)
                )
            ).scalar_one()
            assert row.sf_version is not None
            assert len(row.sf_version) <= 50
    finally:
        await _delete_worker_heartbeat(eval_worker_session_maker, worker_id)


async def _delete_worker_heartbeat_in_session(session: AsyncSession, worker_id: str) -> None:
    """Delete any pre-existing row for this worker_id using the SAME session
    (not a fresh session_maker() call) so the caller-session-still-usable
    assertion in the oversized-sf_version test is meaningful.
    """
    await session.execute(sa.delete(WorkerHeartbeat).where(WorkerHeartbeat.worker_id == worker_id))
    await session.commit()
