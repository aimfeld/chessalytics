"""Worker heartbeat repository: upsert-on-submit fleet liveness registry (PRUNE-06).

Single shared helper called from all three live submit handlers (entry-submit,
flaw-blob-submit, atomic-submit) inside their existing write session — never
opens a new session, never called from a lease endpoint (D-04).
"""

import sentry_sdk
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.worker_heartbeat import WorkerHeartbeat

# Mirror app/models/worker_heartbeat.py column widths so an oversized value
# from a misbehaving/future worker can never hit a DB-level
# StringDataRightTruncation on the heartbeat insert (WR-01 code review
# 2026-07-04). `last_ip` is intentionally excluded: its model column is
# `Text` (unbounded), so there is no width to truncate to.
_WORKER_ID_MAX_LEN = 16  # WorkerHeartbeat.worker_id: String(16)
_SF_VERSION_MAX_LEN = 50  # WorkerHeartbeat.sf_version: String(50)


async def upsert_worker_heartbeat(
    session: AsyncSession,
    *,
    worker_id: str,
    last_ip: str | None,
    sf_version: str | None,
    worker_schema_version: int | None,
    n_evals: int,
    n_holes: int = 0,
    n_plies_leased: int = 0,
) -> None:
    """Upsert one worker_heartbeats row by advisory worker identity (D-01/D-05).

    Accumulates submit_count/evals_submitted across calls for the same worker_id;
    overwrites last_ip/sf_version/last_seen with the latest values. worker_schema_version
    is coalesced (D-03): a lane that omits it (entry-submit, flaw-blob-submit) must never
    clobber the last known atomic-lane value with NULL.

    n_holes/n_plies_leased (260725-da3, FLAWCHESS-8B) accumulate exactly like
    submit_count/evals_submitted, but are ATOMIC-LANE-ONLY: the default of 0 is
    load-bearing so the untouched entry-submit and flaw-blob-submit call sites can
    never inflate them, keeping holes_submitted/plies_leased a meaningful per-worker
    hole rate.

    Does NOT commit — the caller's existing write session owns the commit.

    Bug fix (WR-01 code review 2026-07-04): this is passive telemetry only —
    "never a gate" per the phase's design intent — so ANY failure here (a
    still-oversized value, a transient DB error, etc.) is isolated to its own
    SAVEPOINT and swallowed after a Sentry capture. It must never abort the
    caller's surrounding write transaction and discard real, already-computed
    Stockfish eval work.
    """
    worker_id = worker_id[:_WORKER_ID_MAX_LEN]
    if sf_version is not None:
        sf_version = sf_version[:_SF_VERSION_MAX_LEN]

    stmt = pg_insert(WorkerHeartbeat).values(
        worker_id=worker_id,
        last_ip=last_ip,
        sf_version=sf_version,
        worker_schema_version=worker_schema_version,
        last_seen=sa.func.now(),
        submit_count=1,
        evals_submitted=n_evals,
        holes_submitted=n_holes,
        plies_leased=n_plies_leased,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["worker_id"],
        set_={
            "last_ip": stmt.excluded.last_ip,
            "sf_version": stmt.excluded.sf_version,
            # worker_schema_version: only overwrite when the new value is non-NULL
            # (D-03: entry/flaw-blob lanes never send it — must not clobber the
            # last known atomic-lane value with NULL).
            "worker_schema_version": sa.func.coalesce(
                stmt.excluded.worker_schema_version, WorkerHeartbeat.worker_schema_version
            ),
            "last_seen": stmt.excluded.last_seen,
            "submit_count": WorkerHeartbeat.submit_count + stmt.excluded.submit_count,
            "evals_submitted": WorkerHeartbeat.evals_submitted + stmt.excluded.evals_submitted,
            "holes_submitted": WorkerHeartbeat.holes_submitted + stmt.excluded.holes_submitted,
            "plies_leased": WorkerHeartbeat.plies_leased + stmt.excluded.plies_leased,
        },
    )
    try:
        async with session.begin_nested():
            await session.execute(stmt)
    except Exception as exc:
        sentry_sdk.set_context("heartbeat", {"worker_id": worker_id})
        sentry_sdk.capture_exception(exc)
