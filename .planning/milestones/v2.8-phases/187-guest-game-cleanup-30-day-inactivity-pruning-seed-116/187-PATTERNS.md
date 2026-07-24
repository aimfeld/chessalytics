# Phase 187: Guest Game Cleanup — 30-Day Inactivity Pruning - Pattern Map

**Mapped:** 2026-07-24
**Files analyzed:** 4 (2 new, 2 modified)
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `app/services/guest_cleanup_service.py` (NEW) | service | batch / CRUD (periodic delete) | `app/services/import_service.py` (`run_periodic_reaper`, `cleanup_orphaned_jobs`) | exact |
| `app/main.py` (MODIFY — lifespan) | provider (task lifecycle wiring) | event-driven | `app/main.py` lifespan itself (add a 4th task mirroring `reaper_task`/`drain_task`/`full_drain_task`) | exact |
| `tests/test_guest_cleanup_service.py` (NEW) | test | CRUD / unit+integration | `tests/test_import_service.py` (`TestRunPeriodicReaper`, `TestFailOrphanedJobsAgeThreshold`) | exact |
| `tests/test_main_lifespan.py` (MODIFY) | test | event-driven | existing `TestLifespanBackgroundTasks.test_both_background_tasks_spawned` (same file) | exact |

No repository-layer file needs creation — the per-guest delete/reset repository functions already exist and are reused as-is (`app/repositories/game_repository.py::delete_all_games_for_user`, `app/repositories/user_import_settings_repository.py::reset_backfill_cursors`). The eligibility query is a small `select()` that can live directly in `guest_cleanup_service.py` (discretionary per CONTEXT.md — no existing dedicated "guest repository" file to extend).

## Pattern Assignments

### `app/services/guest_cleanup_service.py` (service, batch/periodic-delete) — NEW

**Analog:** `app/services/import_service.py` (`run_periodic_reaper` at line 338, `_REAPER_INTERVAL_SECONDS` at line 119, `cleanup_orphaned_jobs` at line 185)

**Imports pattern** (mirror `import_service.py` top-of-file style — module-level `logger`, `sentry_sdk`, stdlib `asyncio`/`datetime`):
```python
import asyncio
import logging
from datetime import datetime, timedelta, timezone

import sentry_sdk
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_maker
from app.models.import_job import ImportJob
from app.models.user import User
from app.repositories import game_repository, user_import_settings_repository

logger = logging.getLogger(__name__)
```

**Interval constant pattern** (`app/services/import_service.py:119`):
```python
_REAPER_INTERVAL_SECONDS = 5 * 60  # 5 minutes between periodic reaper ticks
```
Mirror as:
```python
_GUEST_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60  # D-02: daily tick
_GUEST_INACTIVITY_THRESHOLD = timedelta(days=30)  # advertised threshold, not tunable this phase
```

**Core periodic-loop pattern** (`app/services/import_service.py:332-359`, verbatim):
```python
# Bug fix (Phase 90, SEED-017): cleanup_orphaned_jobs() only ran at backend
# startup. A Postgres-only restart (or any DB recovery window the backend
# survives) left in_progress jobs stuck forever. This coroutine runs
# every _REAPER_INTERVAL_SECONDS and uses an orphan-age threshold of
# IMPORT_TIMEOUT_SECONDS (3h) so a live healthy import is never reaped
# (Pitfall 3 in 90-RESEARCH.md).
async def run_periodic_reaper() -> None:
    """Periodically mark stuck import jobs as failed.
    ...
    Sleeps BEFORE the first cleanup call so the startup-time cleanup_orphaned_jobs()
    handles T=0 and this reaper handles T+5min, T+10min, etc.

    Wired in app/main.py lifespan — started on startup, cancelled+awaited on shutdown.
    """
    while True:
        await asyncio.sleep(_REAPER_INTERVAL_SECONDS)
        try:
            await cleanup_orphaned_jobs(
                orphan_age_threshold=timedelta(seconds=IMPORT_TIMEOUT_SECONDS)
            )
        except Exception:
            logger.exception("Periodic orphan-job reaper failed")
            sentry_sdk.set_tag("source", "import")
            sentry_sdk.capture_exception()
```

**Target shape for `run_periodic_guest_cleanup()`** (structural 1:1 mirror, per D-01/D-02/D-07):
```python
async def run_periodic_guest_cleanup() -> None:
    """Periodically purge game data for guests inactive >= 30 days (SEED-116).

    Sleeps BEFORE the first run — mirrors run_periodic_reaper's T=0 vs T+interval
    split. Wired in app/main.py lifespan — started on startup, cancelled+awaited
    on shutdown, alongside the other 3 background tasks.
    """
    while True:
        await asyncio.sleep(_GUEST_CLEANUP_INTERVAL_SECONDS)
        try:
            await cleanup_inactive_guests()
        except Exception:
            logger.exception("Periodic guest cleanup failed")
            sentry_sdk.set_tag("source", "guest_cleanup")
            sentry_sdk.capture_exception()
```

**Eligibility query pattern** (new, mirrors `import_job_repository.py`'s Python-side cutoff idiom — bind `datetime.now(timezone.utc) - threshold` as a param rather than a SQL `now() - interval` fragment):
```python
async def get_eligible_guest_ids(session: AsyncSession) -> list[int]:
    """Return user.id for every guest inactive >= 30 days (SEED-116).

    NULL last_activity (a guest with no authenticated request since creation)
    is naturally excluded: PostgreSQL's `<` comparison against NULL evaluates
    to NULL, which WHERE treats as false. The explicit IS NOT NULL below is
    documentation, not a functional guard.
    """
    cutoff = datetime.now(timezone.utc) - _GUEST_INACTIVITY_THRESHOLD
    result = await session.execute(
        select(User.id).where(
            User.is_guest.is_(True),
            User.last_activity.isnot(None),
            User.last_activity < cutoff,
        )
    )
    return list(result.scalars().all())
```

**Per-guest delete-and-reset pattern** (mirrors `app/routers/imports.py:455-479` `DELETE /games` body — see Shared Patterns below for the full precedent; D-06 mandates one `async_session_maker()` session/commit per guest, not a single outer transaction):
```python
async def _purge_guest(guest_id: int) -> int:
    """Delete one guest's games + reset import cursors. One transaction (D-06)."""
    async with async_session_maker() as session:
        deleted_count = await game_repository.delete_all_games_for_user(session, guest_id)
        await session.execute(delete(ImportJob).where(ImportJob.user_id == guest_id))
        # Pitfall 1 (187-RESEARCH.md): without this call, a returning guest's
        # backward-walk backlog import silently resumes from a stale cursor
        # instead of re-backfilling the fresh (post-purge) account budget.
        await user_import_settings_repository.reset_backfill_cursors(
            session, user_id=guest_id
        )
        await session.commit()
    return deleted_count
```

**Error handling pattern:** outer per-tick try/except (shown above) matches CLAUDE.md's "retry/per-tick loops capture once, not per item" rule. Per Pitfall 4 in RESEARCH.md, consider catching per-guest inside the loop body, logging via `logger.exception()` with guest_id, and accumulating a failure count to report/capture once at tick end — this is discretionary (not contradicting D-07) but avoids one bad guest starving the rest of the tick's backlog.

**Logging pattern (D-07 — per-run summary):** no direct existing analog for a "counts summary" log line in this codebase; keep it simple:
```python
logger.info(
    "Guest cleanup tick: scanned=%d purged=%d games_deleted=%d",
    scanned_count, purged_count, total_games_deleted,
)
```

---

### `app/main.py` (lifespan wiring) — MODIFY

**Analog:** the existing 3-task pattern in the same file (`app/main.py:103-149`)

**Startup pattern** (lines 103-114, verbatim):
```python
    # Phase 90 / SEED-017: periodic reaper for the live process. Catches
    # orphans that arise from a Postgres-only restart (backend survives)
    # which the startup-only cleanup_orphaned_jobs() call would miss.
    reaper_task = asyncio.create_task(run_periodic_reaper(), name="periodic-orphan-reaper")
    # Phase 91 / SEED-023: cold-lane eval drain. Spawned here so it outlives
    # any individual import job and shuts down cleanly alongside the reaper.
    # stop_engine() runs AFTER both tasks are awaited so in-flight evaluations
    # can complete before the EnginePool is torn down (T-91-20 ordering gate).
    drain_task = asyncio.create_task(run_eval_drain(), name="eval-drain")
    # Phase 116 / EVAL-01: full-ply drain — analyzes every non-terminal ply at 1M nodes.
    # Runs alongside the entry-ply drain (D-116-08: entry-ply drain untouched).
    full_drain_task = asyncio.create_task(run_full_eval_drain(), name="full-eval-drain")
```
Add a 4th line here:
```python
    # Phase 187 / SEED-116: daily guest inactivity cleanup (D-01/D-02).
    guest_cleanup_task = asyncio.create_task(
        run_periodic_guest_cleanup(), name="guest-cleanup"
    )
```

**Shutdown pattern** (lines 117-144, verbatim):
```python
    finally:
        # WR-03: stop_engine() must always run even if the reaper or drain task
        # raises a non-CancelledError on shutdown — otherwise the long-lived
        # Stockfish UCI process leaks across restarts. Cancel both tasks before
        # awaiting either so they enter cancellation in parallel. Wrap the
        # awaits in an inner try/finally so the engine shutdown is unconditional.
        reaper_task.cancel()
        drain_task.cancel()
        full_drain_task.cancel()
        try:
            try:
                await reaper_task
            except asyncio.CancelledError:
                pass  # expected on shutdown
            except Exception:
                logger.exception("Periodic reaper task raised on shutdown")
            try:
                await drain_task
            except asyncio.CancelledError:
                pass  # expected on shutdown
            except Exception:
                logger.exception("Eval drain task raised on shutdown")
            try:
                await full_drain_task
            except asyncio.CancelledError:
                pass  # expected on shutdown
            except Exception:
                logger.exception("Full eval drain task raised on shutdown")
        finally:
            await stop_engine()
```
Add `guest_cleanup_task.cancel()` alongside the other three `.cancel()` calls, and an identical `try: await guest_cleanup_task / except CancelledError: pass / except Exception: logger.exception(...)` block — placed last (after `full_drain_task`'s block) since there's no ordering dependency with `stop_engine()`/`stop_maia()`.

**Import to add:** `from app.services.guest_cleanup_service import run_periodic_guest_cleanup` alongside the existing `from app.services.import_service import run_periodic_reaper` import.

---

### `tests/test_guest_cleanup_service.py` (test) — NEW

**Analogs:**
- `tests/test_import_service.py::TestRunPeriodicReaper` (loop-mechanics tests: interval sleep, exception survival) — mirror `test_reaper_calls_cleanup_at_interval` and `test_reaper_survives_cleanup_exception` (monkeypatch `asyncio.sleep` and the inner function).
- `tests/test_import_service.py::TestFailOrphanedJobsAgeThreshold` (`_seed_job` pattern — direct `UPDATE ... SET started_at = :ts` via `text()` to control timestamps precisely) — mirror for controlling `users.last_activity` precisely in eligibility tests.
- `tests/test_imports_router.py::TestDeleteAllGamesCursorReset` (`test_delete_and_cursor_reset_preserves_tc_and_cap`) — mirror near-identically for asserting the 3 backfill-cursor columns are NULL and TC/cap columns are unchanged after purge.
- `tests/test_guest_auth.py` (`create_guest_user(db_session)` fixture helper, `TestGuestCreate`/`TestGuestRefresh`) — use for seeding guest `User` rows and for the "guest row + auth still work after purge" assertion.

Suggested test classes (per RESEARCH.md's requirement→test map): `TestEligibilityQuery`, `TestCascadeCompleteness`, `TestRunPeriodicGuestCleanup`, plus a cursor-reset assertion block mirroring `TestDeleteAllGamesCursorReset`.

---

### `tests/test_main_lifespan.py` (test) — MODIFY

**Analog:** same file, `TestLifespanBackgroundTasks.test_both_background_tasks_spawned` (existing `_stub_reaper`/`_stub_drain` monkeypatch shape). Note (RESEARCH.md): `EXPECTED_TASKS` is already stale (missing `"full-eval-drain"`) — fix that drift while adding `"guest-cleanup"`, following the exact same stub-and-assert pattern for the new task name.

---

## Shared Patterns

### Periodic asyncio task (scheduling)
**Source:** `app/services/import_service.py:338-359` (`run_periodic_reaper`), `app/main.py:103-149` (lifespan wiring)
**Apply to:** `guest_cleanup_service.py`'s `run_periodic_guest_cleanup()` and its `app/main.py` wiring.
```python
while True:
    await asyncio.sleep(_INTERVAL_SECONDS)
    try:
        await do_work()
    except Exception:
        logger.exception("... failed")
        sentry_sdk.set_tag("source", "...")
        sentry_sdk.capture_exception()
```

### Guest data purge (delete + cursor reset)
**Source:** `app/routers/imports.py:455-479` (`DELETE /games` handler — the full precedent to mirror)
```python
@router.delete("/games", response_model=DeleteGamesResponse)
async def delete_all_games(
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> DeleteGamesResponse:
    """Delete all games, positions, import jobs, benchmark percentiles, and
    rating anchors for the authenticated user.

    Returns the count of deleted games.
    """
    deleted_count = await game_repository.delete_all_games_for_user(session, user.id)
    await session.execute(delete(ImportJob).where(ImportJob.user_id == user.id))
    await session.execute(
        delete(UserBenchmarkPercentile).where(UserBenchmarkPercentile.user_id == user.id)
    )
    await session.execute(delete(UserRatingAnchor).where(UserRatingAnchor.user_id == user.id))
    # Phase 186 Plan 02 (IMPORT-03, Pitfall 4): the backward-walk cursor is NOT
    # derived from `games` rows (it tracks fetch ATTEMPTS, not stored games) ...
    await user_import_settings_repository.reset_backfill_cursors(session, user_id=user.id)
    await session.commit()
    return DeleteGamesResponse(deleted_count=deleted_count)
```
**Apply to:** `guest_cleanup_service.py::_purge_guest()`. The router deletes `UserBenchmarkPercentile`/`UserRatingAnchor` too — RESEARCH.md flags this as an open question (Pitfall 2) not settled by CONTEXT.md; the planner should decide whether guest purge mirrors this exactly or omits those two tables (both are idempotent no-ops either way).

### Reusable repository functions (do not reimplement)
**Source:** `app/repositories/game_repository.py:249-263` (`delete_all_games_for_user`), `app/repositories/user_import_settings_repository.py:284-308` (`reset_backfill_cursors`)
```python
async def delete_all_games_for_user(session: AsyncSession, user_id: int) -> int:
    """Delete all games and positions for the given user.

    Deletes game_positions first (child rows), then games. Returns the count of deleted games.
    """
    await session.execute(delete(GamePosition).where(GamePosition.user_id == user_id))
    result = await session.execute(delete(Game).where(Game.user_id == user_id).returning(Game.id))
    return len(result.fetchall())
```
```python
async def reset_backfill_cursors(session: AsyncSession, *, user_id: int) -> None:
    """NULL all three backward-walk cursor columns for a user. ... Caller commits."""
    await session.execute(
        update(UserImportSettings)
        .where(UserImportSettings.user_id == user_id)
        .values(
            chesscom_backfill_oldest_year=None,
            chesscom_backfill_oldest_month=None,
            lichess_backfill_oldest_ms=None,
        )
    )
```
**Apply to:** `guest_cleanup_service.py` — call both as-is, keyword `user_id=` on the second per its signature.

### Sentry error capture
**Source:** `app/services/import_service.py:356-359`, CLAUDE.md backend Sentry rules
**Apply to:** the outer per-tick except block in `run_periodic_guest_cleanup()` — `logger.exception(msg)` + `sentry_sdk.set_tag("source", "guest_cleanup")` + `sentry_sdk.capture_exception()`. Never embed guest_id/counts in the exception message string; use `set_context`/`set_tag` if per-guest data is needed.

## No Analog Found

None — every file in scope has a direct, exact-match analog already in the codebase (this phase is explicitly "copy an existing pattern, wire a new predicate" per RESEARCH.md's own summary).

## Metadata

**Analog search scope:** `app/services/import_service.py`, `app/main.py`, `app/repositories/game_repository.py`, `app/repositories/user_import_settings_repository.py`, `app/routers/imports.py`, `tests/test_import_service.py`, `tests/test_imports_router.py`, `tests/test_main_lifespan.py`, `tests/test_guest_auth.py`
**Files scanned:** 9 (all pre-identified by RESEARCH.md; confirmed via direct `Read`/`Bash grep` against current line numbers)
**Pattern extraction date:** 2026-07-24
</content>
