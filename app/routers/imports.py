"""Import router: POST /imports and GET /imports/{job_id} endpoints.

HTTP layer only — all orchestration logic lives in import_service.
"""

import asyncio
from typing import Annotated

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.models.game import Game
from app.models.import_job import ImportJob
from app.models.user import User
from app.models.user_benchmark_percentile import UserBenchmarkPercentile
from app.models.user_rating_anchors import UserRatingAnchor
from app.repositories import (
    game_repository,
    import_job_repository,
    user_benchmark_percentiles_repository,
    user_import_settings_repository,
    user_rating_anchors_repository,
    user_repository,
)
from app.schemas.imports import (
    DeleteGamesResponse,
    EnqueueTier1Response,
    EvalCoverageResponse,
    ImportRequest,
    ImportStartedResponse,
    ImportStatusResponse,
    ReadinessResponse,
)
from app.services import (
    import_service,
    percentile_compute_registry,
    user_benchmark_percentiles_service,
)
from app.services.eval_queue_service import enqueue_tier1_game
from app.users import current_active_user

router = APIRouter(prefix="/imports", tags=["imports"])


@router.post("", response_model=ImportStartedResponse, status_code=201)
async def start_import(
    request: ImportRequest,
    response: Response,
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> ImportStartedResponse:
    """Trigger a background import from chess.com or lichess.

    Returns immediately with a job_id that can be polled via GET /imports/{job_id}.

    If an import for this user+platform is already PENDING or IN_PROGRESS,
    the existing job is returned with HTTP 200 instead of creating a duplicate.

    Platform username is saved to user profile immediately at import start (not
    at completion), so that after a server restart the Import page pre-populates
    the username field and the Sync button is enabled even if the import failed.
    """
    # Extract user_id before asyncio.create_task — Depends only works in request scope
    user_id = user.id

    # Return existing active job instead of starting a duplicate
    existing = import_service.find_active_job(user_id, request.platform)
    if existing is not None:
        response.status_code = 200
        return ImportStartedResponse(
            job_id=existing.job_id,
            status=existing.status.value,
        )

    # Save platform username to user profile immediately — ensures the username
    # persists even if the import fails mid-way or the server restarts, so the
    # Import page can pre-populate the username field for immediate re-sync.
    await user_repository.update_platform_username(
        session, user_id, request.platform, request.username
    )
    await session.commit()

    job_id = import_service.create_job(user_id, request.platform, request.username)

    # Bug fix (Phase 149 PRUNE-05): the durable import_jobs row used to be
    # created later, inside the fire-and-forget background task
    # (_bootstrap_import_job) — strictly AFTER this response would already
    # have been sent. That left a TOCTOU window where two concurrent requests
    # both see an empty in-memory registry above and both proceed. The row is
    # now created HERE, synchronously, before the background task is
    # scheduled, backed by the uq_import_jobs_user_platform_active partial
    # unique index — the DB, not the in-memory registry, is the real
    # concurrency guarantee. A losing concurrent request hits IntegrityError
    # below (expected race, not a bug — mirrors guest_service.py's Google-
    # promotion double-submit handling) and returns the winner's job with 200.
    try:
        await import_job_repository.create_import_job(
            session,
            job_id=job_id,
            user_id=user_id,
            platform=request.platform,
            username=request.username,
        )
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # This request's in-memory JobState never got a background task
        # scheduled — discard it so it doesn't linger as a permanently-stuck
        # duplicate in find_active_jobs_for_user / count_active_platform_jobs.
        import_service.discard_job(job_id)
        # Re-fetch scoped by user_id + platform (V4 / IDOR guard) — never
        # leaks another user's job. IntegrityError is not capture_exception'd:
        # it's an expected race, per CLAUDE.md's skip-trivial-exceptions rule.
        existing_row = await import_job_repository.get_active_job_for_user_platform(
            session, user_id, request.platform
        )
        # Explicit guard, not `assert` (Bug fix, IN-02 code review 2026-07-04):
        # `assert` statements are stripped under `python -O`, which would let
        # this genuinely-should-never-happen invariant fail silently and fall
        # through to an AttributeError on `existing_row.id` below instead of a
        # clearly-labeled internal error.
        if existing_row is None:
            sentry_sdk.set_context(
                "import", {"user_id": str(user_id), "platform": request.platform}
            )
            exc = RuntimeError(
                "uq_import_jobs_user_platform_active raised IntegrityError but no "
                "active row was found on re-fetch"
            )
            sentry_sdk.capture_exception(exc)
            raise exc
        response.status_code = 200
        return ImportStartedResponse(job_id=existing_row.id, status=existing_row.status)
    except Exception:
        # Bug fix (CR-01 code review 2026-07-04): the durable-insert write
        # above can fail for reasons OTHER than the expected IntegrityError
        # race (e.g. a transient Postgres outage during flush/commit). Before
        # this branch existed, such a failure left the in-memory
        # JobState(status=PENDING) registered forever — no background task
        # was ever scheduled to transition it, and no reaper touches the
        # in-memory registry, so find_active_job() would report this phantom
        # job as active on every retry, permanently locking the user out of
        # importing this platform until the backend process restarted.
        await session.rollback()
        import_service.discard_job(job_id)
        sentry_sdk.set_context("import", {"user_id": str(user_id), "platform": request.platform})
        sentry_sdk.capture_exception()
        raise

    asyncio.create_task(import_service.run_import(job_id))

    return ImportStartedResponse(job_id=job_id, status="pending")


@router.get("/active", response_model=list[ImportStatusResponse])
async def get_active_imports(
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> list[ImportStatusResponse]:
    """Return import jobs the frontend should display for the authenticated user.

    Includes:
    - In-memory active jobs (PENDING/IN_PROGRESS) — live imports in this session
    - Recently failed DB jobs (last 24h) — surfaces errors from server restarts
      that the user hasn't seen yet (in-memory registry is empty after restart)
    """
    results: list[ImportStatusResponse] = []
    seen_job_ids: set[str] = set()

    # In-memory active jobs
    for job in import_service.find_active_jobs_for_user(user.id):
        seen_job_ids.add(job.job_id)
        results.append(
            ImportStatusResponse(
                job_id=job.job_id,
                platform=job.platform,
                username=job.username,
                status=job.status.value,
                games_fetched=job.games_fetched,
                games_imported=job.games_imported,
                error=job.error,
                other_importers=import_service.count_active_platform_jobs(
                    job.platform, job.user_id
                ),
            )
        )

    # Recently failed DB jobs (e.g. orphaned after server restart)
    failed_jobs = await import_job_repository.get_unseen_failed_jobs_for_user(session, user.id)
    for db_job in failed_jobs:
        if db_job.id in seen_job_ids:
            continue
        results.append(
            ImportStatusResponse(
                job_id=db_job.id,
                platform=db_job.platform,
                username=db_job.username,
                status=db_job.status,
                games_fetched=db_job.games_fetched,
                games_imported=db_job.games_imported,
                error=db_job.error_message,
            )
        )

    return results


@router.get("/readiness", response_model=ReadinessResponse)
async def get_readiness(
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> ReadinessResponse:
    """Return two-tier readiness for the authenticated user.

    Locked by D-01/D-04: dedicated endpoint; keys tier1, tier2, pending_count,
    total_count.

    Tier 1 (tier1=True): no active import job in-flight for this user.
        Derived from the in-memory import registry only — orphaned DB jobs
        after server restart are not detected here (RESEARCH Open Question 1 /
        A3, out of scope).

    Tier 2 (tier2=True): tier1=True AND pending evals == 0 AND
        (total_count == 0 OR at least one user_benchmark_percentiles row exists
         OR an anchor row exists but no percentile rows (settled-empty)
         OR the user is below the per-TC anchor floor in every TC)
        AND the user is not mid-Stage-B percentile compute (in-memory registry).
        The ``total_count == 0`` branch is the empty-account escape: a user with
        no games is vacuously Stage-B ready and must not be locked out forever
        (RESEARCH Pitfall 1). The below-anchor-floor branch (quick-260529)
        generalises that escape to users who DO have games but too few to clear
        the 30-game per-TC anchor floor in any TC: Stage A/B write zero rows for
        them by design, so ``has_any_rows`` stays False forever and they would
        otherwise be locked out permanently (prod user 145: 13 games). The
        settled-empty branch (endgame-percentiles-missing, prod user 146) closes
        a gap that branch missed: a user can be ABOVE the anchor floor (enough
        rating-eligible games) yet BELOW every endgame metric's per-metric
        population floor because too few of their games reach an endgame (user
        146: 33 rating-eligible rapid games, only 22 reach an endgame, < 30). An
        anchor row proves Stage A ran and committed; zero percentile rows
        alongside it means no metric can ever qualify (score_gap's game set is a
        superset of every Stage B metric's), so the user is unlocked rather than
        spinning forever. The Stage-B-computing clause (Quick 260529-015) closes
        the race where pending==0 is observed before the eval-dependent
        percentile rows are written, so the page would otherwise unlock with
        missing (first import) or stale (re-import) badges.

    Reads are strictly sequential on one AsyncSession per CLAUDE.md constraint
    (no asyncio.gather on a single AsyncSession). Short-circuits skip downstream
    queries when not needed. On the common ready path the query count is at most
    3. Only when the user is "stuck" (evals drained, not mid-compute, no
    percentile rows) does a 4th query run — a cheap LIMIT-1 ``has_any_anchor``
    count for the settled-empty escape — and only when that returns False (no
    anchor row) do up to 4 per-TC anchor-candidate CTEs run for the below-floor
    escape. The settled-empty probe is ordered first because it is a single
    cheap count, and an anchor row implies above-floor (so the per-TC probes
    would return False anyway). The is_computing check is a sync in-memory set
    lookup (no query).
    """
    # Tier 1: no active import job for this user (in-memory check only)
    has_active = bool(import_service.find_active_jobs_for_user(user.id))
    tier1 = not has_active

    # Quick 260529-015: in-memory Stage-B-in-progress gate (sync set lookup).
    stage_b_computing = percentile_compute_registry.is_computing(user.id)

    # Total games (needed for tier2 and pending_count)
    total = await game_repository.count_games_for_user(session, user.id)

    # Skip pending eval count when tier1=False (no point during active import)
    pending = 0 if not tier1 else await game_repository.count_pending_evals(session, user.id)

    # Skip has_any_rows when total==0 (vacuously ready) or tier1=False
    percentile_ready = total == 0 or (
        tier1 and await user_benchmark_percentiles_repository.has_any_rows(session, user_id=user.id)
    )

    # "Stuck" precondition shared by both no-rows escapes below: evals drained,
    # not mid-compute, but no percentile rows exist yet.
    stuck = tier1 and pending == 0 and not stage_b_computing and not percentile_ready

    # Settled-empty escape (bug fix endgame-percentiles-missing, prod user 146):
    # an anchor row proves compute_stage_a ran AND committed (Stage A writes its
    # anchors and the eval-independent score_gap percentiles in one transaction,
    # so the anchor only becomes visible once that whole commit lands). If Stage A
    # ran yet produced zero percentile rows, every endgame metric is below its
    # per-metric population floor: the user is above the 30-game ANCHOR floor but
    # too few of their games REACH an endgame (user 146: 33 rating-eligible rapid
    # games, only 22 reach an endgame, < 30). score_gap's game set is a superset
    # of every Stage B metric's set, so no metric can ever produce a row — the
    # page would otherwise spin forever. Probed before the below-floor SQL because
    # it is a single cheap LIMIT-1 count vs up to 4 per-TC anchor-candidate CTEs.
    settled_empty = stuck and await user_rating_anchors_repository.has_any_anchor(
        session, user_id=user.id
    )

    # Below-anchor-floor escape (quick-260529): a user with games but no
    # percentile rows, whose evals are fully drained and who is not mid-compute,
    # may simply be below the per-TC anchor floor everywhere — Stage A/B wrote
    # nothing by design and never will (no anchor row exists either). Probe the
    # anchor-candidate SQL so these users unlock instead of polling forever.
    # Evaluated lazily: skipped on the common above-floor path AND when the
    # settled-empty escape already fired (an anchor row exists, so the user is
    # above floor and this probe would return False anyway).
    below_floor = (
        stuck
        and not settled_empty
        and await user_benchmark_percentiles_service.is_below_anchor_floor(
            session, user.id, total_games=total
        )
    )

    tier2 = (
        tier1
        and pending == 0
        and not stage_b_computing
        and (percentile_ready or settled_empty or below_floor)
    )

    return ReadinessResponse(
        tier1=tier1,
        tier2=tier2,
        pending_count=pending,
        total_count=total,
    )


@router.get("/eval-coverage", response_model=EvalCoverageResponse)
async def get_eval_coverage(
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> EvalCoverageResponse:
    """Return Stockfish eval coverage for the authenticated user.

    Returns pending_count, total_count, pct_complete (0-100), and analyzed_count.
    Returns pct_complete=100 when the user has no games (avoids division-by-zero).
    D-118-12 extension: analyzed_count added. in_flight_count removed in Phase
    119-03 (tier-3 derived picks have no eval_jobs rows — structurally blind to
    the dominant backlog drain; see 119-RESEARCH-NOTES.md).

    Locked by D-01: dedicated endpoint, NOT extending GET /imports/active.
    Locked by D-04: response keys pending_count, total_count, pct_complete unchanged.
    """
    # Badge = "analyzed of total games", matching the per-game Library cards.
    # total_count is every imported game; analyzed_count is full_evals_completed_at
    # IS NOT NULL (FlawChess's own full analysis — the same column the cards' Analyze
    # button keys off). A lichess game imported with bundled %eval analysis sets
    # white_blunders at import (is_analyzed=True) but NOT full_evals_completed_at, so
    # it stays "not analyzed" here until our drain runs — the card and badge agree.
    # X-of-X stays reachable: degenerate games get full_evals_completed_at stamped by
    # the drain, so they count as analyzed (their cards show no Analyze button too).
    total = await game_repository.count_games_for_user(session, user.id)
    if total == 0:
        return EvalCoverageResponse(
            pending_count=0, total_count=0, pct_complete=100, analyzed_count=0
        )
    pending = await game_repository.count_pending_evals(session, user.id)
    # pending (evals_completed_at IS NULL) is always a subset of all games, so
    # total - pending is non-negative; pct tracks entry-ply readiness (unchanged).
    pct = round(100 * (total - pending) / total)
    # Sequential awaits on the same session (never asyncio.gather — CLAUDE.md)
    analyzed = await game_repository.count_fully_analyzed_games(session, user.id)
    return EvalCoverageResponse(
        pending_count=pending,
        total_count=total,
        pct_complete=pct,
        analyzed_count=analyzed,
    )


@router.post("/eval/tier1/{game_id}", response_model=EnqueueTier1Response)
async def enqueue_tier1(
    game_id: int,
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> EnqueueTier1Response:
    """Enqueue a single game for tier-1 (explicit-request) Stockfish eval.

    IDOR guard (T-118-06, ASVS V4): returns 404 when the game does not exist OR
    belongs to a different user. Never 403 — avoids confirming id existence to
    unauthorised callers (library.py pattern). game_id typed int: FastAPI rejects
    non-integers with 422 (T-118-10).

    Tier-1 is an explicit per-game request available to guests for their OWN games
    (QUEUE-08 guest gate opened for tier-1 only). Automatic tier-3 background
    analysis remains gated to authenticated users.
    """
    # IDOR guard — verifies ownership before any service call
    game = await session.get(Game, game_id)
    if game is None or game.user_id != user.id:
        raise HTTPException(status_code=404, detail="Game not found")

    inserted = await enqueue_tier1_game(game_id=game_id, user_id=user.id)
    status = "enqueued" if inserted else "already_queued"
    return EnqueueTier1Response(status=status, game_id=game_id)


@router.get("/{job_id}", response_model=ImportStatusResponse)
async def get_import_status(
    job_id: str,
    user: Annotated[User, Depends(current_active_user)],
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> ImportStatusResponse:
    """Return the current progress of an import job.

    Checks in-memory registry first (live jobs), then falls back to the database
    (for completed/failed jobs that may have been evicted from memory after restart).

    Auth + IDOR guard (code-review 2026-07-02, #1): this was previously the only
    import route with no authentication and no user scoping — any client could poll
    another user's job and read its (formerly raw) error string. Requires an
    authenticated user and returns 404 (never 403) when the job belongs to someone
    else, matching the enqueue_tier1 / library IDOR pattern (don't confirm id
    existence to unauthorised callers).
    """
    # Try in-memory registry first (live progress)
    job = import_service.get_job(job_id)
    if job is not None:
        if job.user_id != user.id:
            raise HTTPException(status_code=404, detail="Job not found")
        return ImportStatusResponse(
            job_id=job.job_id,
            platform=job.platform,
            username=job.username,
            status=job.status.value,
            games_fetched=job.games_fetched,
            games_imported=job.games_imported,
            error=job.error,
            other_importers=import_service.count_active_platform_jobs(job.platform, job.user_id),
        )

    # Fall back to DB for historical jobs
    db_job = await import_job_repository.get_import_job(session, job_id)
    if db_job is not None:
        if db_job.user_id != user.id:
            raise HTTPException(status_code=404, detail="Job not found")
        # other_importers=0 is correct for completed/failed jobs — count is irrelevant
        return ImportStatusResponse(
            job_id=db_job.id,
            platform=db_job.platform,
            username=db_job.username,
            status=db_job.status,
            games_fetched=db_job.games_fetched,
            games_imported=db_job.games_imported,
            error=db_job.error_message,
        )

    raise HTTPException(status_code=404, detail="Job not found")


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
    # Phase 189 Plan 02 (POOL-09, D-02/D-04): `drill_items` and `drill_solves`
    # need NO explicit delete here -- both FK to `games.id ON DELETE CASCADE`
    # (D-02), so the DELETE FROM games above already removed them. `drill_sessions`
    # and `train_settings` are DELIBERATELY preserved: session history is user
    # progress (the Phase 191 weekly-streak source), not game-derived data (D-04).
    # Do NOT add a delete(DrillSession)/delete(TrainSettings) statement here --
    # that would silently violate D-04. See tests/test_imports_router.py::
    # TestDeleteAllGamesDrillCascade for the pinning tests.
    await session.execute(delete(ImportJob).where(ImportJob.user_id == user.id))
    await session.execute(
        delete(UserBenchmarkPercentile).where(UserBenchmarkPercentile.user_id == user.id)
    )
    await session.execute(delete(UserRatingAnchor).where(UserRatingAnchor.user_id == user.id))
    # Phase 186 Plan 02 (IMPORT-03, Pitfall 4): the backward-walk cursor is NOT
    # derived from `games` rows (it tracks fetch ATTEMPTS, not stored games),
    # so it would otherwise still point at wherever a previous walk reached --
    # a post-delete resync would then skip straight to that stale boundary
    # instead of backfilling the fresh account's full budget. TC toggles and
    # game_cap PREFERENCES are left untouched (only progress cursors reset).
    await user_import_settings_repository.reset_backfill_cursors(session, user_id=user.id)
    await session.commit()
    return DeleteGamesResponse(deleted_count=deleted_count)
