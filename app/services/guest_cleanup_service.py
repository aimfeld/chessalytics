"""Guest cleanup service: purge game data for guests inactive >= 30 days (SEED-116).

Implements the already-advertised but never-built 30-day-inactivity guest
cleanup (Phase 187). Eligible guests (``is_guest=true``, ``last_activity``
older than ``_GUEST_INACTIVITY_THRESHOLD``) have their games and all
cascading children purged and their import cursor mechanisms reset, but
their ``User`` row + auth + bookmarks + import-settings preferences survive
(D-05) so a returning guest can log back in and simply re-import.

Plan 01 built the eligibility query, the per-guest purge, and the per-tick
orchestration loop (``cleanup_inactive_guests``). Plan 02 (this module's
``run_periodic_guest_cleanup``) wraps that orchestration in a periodic
``asyncio`` task and wires it into the FastAPI lifespan, mirroring
``run_periodic_reaper`` (``app/services/import_service.py``).
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import sentry_sdk
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_maker
from app.models.import_job import ImportJob
from app.models.user import User
from app.models.user_benchmark_percentile import UserBenchmarkPercentile
from app.models.user_rating_anchors import UserRatingAnchor
from app.repositories import game_repository, user_import_settings_repository

logger = logging.getLogger(__name__)

# D-02: daily tick interval. Declared here (consumed by Plan 02's periodic
# wrapper) so the interval and the eligibility threshold live together as
# this module's two named constants (no magic numbers, CLAUDE.md).
_GUEST_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60  # 24 hours

# The already-advertised 30-day threshold (welcome/import copy) — not a
# tunable to revisit in this phase (187-CONTEXT.md domain boundary).
_GUEST_INACTIVITY_THRESHOLD = timedelta(days=30)


async def get_eligible_guest_ids(session: AsyncSession) -> list[int]:
    """Return ``user.id`` for every guest inactive >= 30 days (SEED-116).

    NULL ``last_activity`` (a guest with no authenticated request since
    creation — Pitfall 3, 187-RESEARCH.md) is naturally excluded: PostgreSQL's
    ``<`` comparison against NULL evaluates to NULL, which ``WHERE`` treats as
    false. The explicit ``isnot(None)`` below documents that behavior; it is
    not a functional guard.
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


async def _purge_guest(guest_id: int) -> int:
    """Delete one guest's games + reset import cursors. One transaction (D-06).

    Mirrors ``app/routers/imports.py``'s ``DELETE /games`` handler body — the
    same delete-all-games-and-reset-cursors flow a registered user already
    triggers in production via ``DELETE /api/games`` — applied here to a
    guest selected by the 30-day inactivity eligibility query instead of the
    authenticated user. Reuses the existing, production-tested repository
    functions rather than reimplementing the cascade/cursor-reset logic.

    Returns the count of deleted games.
    """
    async with async_session_maker() as session:
        # WR-01 defense-in-depth: re-verify eligibility inside the purge
        # transaction. cleanup_inactive_guests snapshots the eligible-id list
        # in one SELECT, then purges each guest in its own later transaction;
        # during a large first-tick backlog a guest can log back in (bumping
        # last_activity) or promote to a registered account between the
        # snapshot and their turn. Re-checking the full eligibility predicate
        # here against a fresh cutoff means such a guest is skipped, never
        # purged on stale eligibility (the top threat: wrong-target deletion).
        cutoff = datetime.now(timezone.utc) - _GUEST_INACTIVITY_THRESHOLD
        still_eligible = await session.scalar(
            select(User.id).where(
                User.id == guest_id,
                User.is_guest.is_(True),
                User.last_activity.isnot(None),
                User.last_activity < cutoff,
            )
        )
        if still_eligible is None:
            return 0
        deleted_count = await game_repository.delete_all_games_for_user(session, guest_id)
        await session.execute(delete(ImportJob).where(ImportJob.user_id == guest_id))
        # Pitfall 2 (187-RESEARCH.md): mirror the DELETE /api/games precedent
        # and also drop derived-stats rows tied to the now-deleted games, so a
        # returning guest never sees stale benchmark percentiles / rating
        # anchors computed from history that no longer exists. Both deletes
        # are idempotent no-ops when the guest never had rows here.
        await session.execute(
            delete(UserBenchmarkPercentile).where(UserBenchmarkPercentile.user_id == guest_id)
        )
        await session.execute(delete(UserRatingAnchor).where(UserRatingAnchor.user_id == guest_id))
        # Phase 189 Plan 02 (POOL-09, D-04/D-05): the Train tables need NO
        # handling here either. `drill_items`/`drill_solves` ride the same
        # `games` cascade `delete_all_games_for_user` already triggered above
        # (D-02). `drill_sessions`/`train_settings` are preserved by design
        # (D-04, session history is user progress, not game-derived data) --
        # do NOT add a delete for them. And in practice a guest never
        # accumulates Train rows in the first place: `_reject_guest` (Phase
        # 189's D-05) rejects every /train/* request with 403 before any pool
        # query runs, so this purge never needs to reason about a guest's
        # drill state. See tests/test_guest_cleanup_service.py::
        # test_purge_guest_cascades_drill_rows.
        # Pitfall 1 (187-RESEARCH.md): deleting import_jobs alone does NOT
        # reset the backward-walk backlog cursor (chesscom_backfill_oldest_year
        # /_month, lichess_backfill_oldest_ms) — those live on
        # user_import_settings, a separate table that survives game deletion
        # (Phase 186). Without this call, a returning guest's re-import would
        # silently resume the backward walk from wherever the original import
        # had already reached, skipping backlog games that were just purged,
        # instead of re-backfilling the fresh (empty) account's full budget.
        # D-05: this only NULLs the 3 progress-cursor columns — the row
        # itself (and its tc_*/game_cap preferences) survives.
        await user_import_settings_repository.reset_backfill_cursors(session, user_id=guest_id)
        await session.commit()
    return deleted_count


async def cleanup_inactive_guests() -> None:
    """One cleanup tick: purge every currently-eligible guest (D-06/D-07).

    Opens one session to snapshot the eligible-guest id list, then purges each
    guest in its own transaction (D-06). A failure purging one guest is
    logged (with a traceback, via ``logger.exception``) and does NOT prevent
    the rest of the tick's backlog from being processed (Pitfall 4,
    187-RESEARCH.md) — a naive single outer try/except around the whole loop
    (mirroring ``run_periodic_reaper``'s single-bulk-operation shape) would
    let guest N's failure starve guests N+1..the end of the backlog every
    tick. Failures are accumulated and reported as a single Sentry event at
    the end of the tick (CLAUDE.md: per-tick loops capture once, not once per
    guest), while every failure still gets a full local traceback.

    Wired into the periodic loop by Plan 02's ``run_periodic_guest_cleanup``.
    """
    async with async_session_maker() as session:
        eligible_guest_ids = await get_eligible_guest_ids(session)

    scanned = len(eligible_guest_ids)
    purged = 0
    games_deleted = 0
    failure_count = 0
    last_failure: Exception | None = None

    for guest_id in eligible_guest_ids:
        try:
            games_deleted += await _purge_guest(guest_id)
            purged += 1
        except Exception as exc:
            # guest_id is safe in a LOG message (CLAUDE.md's "never embed
            # variables" rule targets Sentry MESSAGE strings, not log
            # messages) -- Sentry itself gets aggregate counts via
            # set_context below, never a per-guest message.
            logger.exception("Guest cleanup failed to purge guest %s", guest_id)
            failure_count += 1
            last_failure = exc

    # D-07: one per-run summary log line (scanned/purged/games_deleted).
    logger.info(
        "Guest cleanup tick: scanned=%d purged=%d games_deleted=%d failed=%d",
        scanned,
        purged,
        games_deleted,
        failure_count,
    )

    if last_failure is not None:
        sentry_sdk.set_tag("source", "guest_cleanup")
        sentry_sdk.set_context(
            "guest_cleanup",
            {"scanned": scanned, "purged": purged, "failed": failure_count},
        )
        sentry_sdk.capture_exception(last_failure)


# D-01/D-02: daily in-process asyncio task, following the exact
# run_periodic_reaper pattern (app/services/import_service.py:338) — no
# external cron/systemd infra exists in this repo.
async def run_periodic_guest_cleanup() -> None:
    """Periodically purge game data for guests inactive >= 30 days (SEED-116).

    Sleeps BEFORE the first tick — mirrors run_periodic_reaper's T=0 vs
    T+interval split (there is no startup-time equivalent call for guest
    cleanup, but the sleep-first shape is kept identical for consistency and
    to avoid a cold-start cleanup racing app boot).

    A cleanup_inactive_guests exception is caught here (per-tick, not
    per-guest — per-guest isolation already happens inside
    cleanup_inactive_guests itself, D-06/D-07), logged, and reported to
    Sentry; the loop always continues to the next tick.

    Wired in app/main.py lifespan — started on startup, cancelled+awaited on
    shutdown, alongside the other 3 background tasks (reaper, eval-drain,
    full-eval-drain).
    """
    while True:
        await asyncio.sleep(_GUEST_CLEANUP_INTERVAL_SECONDS)
        try:
            await cleanup_inactive_guests()
        except Exception:
            logger.exception("Periodic guest cleanup failed")
            sentry_sdk.set_tag("source", "guest_cleanup")
            sentry_sdk.capture_exception()
