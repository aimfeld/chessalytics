from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

import sentry_sdk
from asyncpg.exceptions import CannotConnectNowError, ConnectionDoesNotExistError
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

if TYPE_CHECKING:
    from sentry_sdk._types import Event

from app.core.config import assert_secret_key_configured, settings
from app.middleware.last_activity import LastActivityMiddleware
from app.routers import openings, position_bookmarks, imports, auth, feedback
from app.routers.admin import router as admin_router
from app.routers.bots import router as bots_router
from app.routers.endgames import router as endgames_router
from app.routers.insights import router as insights_router
from app.routers.eval_remote import router as eval_remote_router
from app.routers.library import router as library_router
from app.routers.stats import router as stats_router
from app.routers.users import router as users_router
from app.services.engine import start_engine, stop_engine
from app.services.maia_engine import start_maia, stop_maia
from app.services.eval_drain import run_eval_drain, run_full_eval_drain
from app.services.guest_cleanup_service import run_periodic_guest_cleanup
from app.services.import_service import cleanup_orphaned_jobs, run_periodic_reaper
from app.services.insights_llm import get_insights_agent

logger = logging.getLogger(__name__)

_DB_TRANSIENT_ERRORS = (ConnectionDoesNotExistError, CannotConnectNowError)
_MAX_CAUSE_CHAIN_DEPTH = 5

# Remote eval worker poll loop hits /api/eval/remote/* endpoints continuously
# (lease, submit, flaw-blob, entry). Each incoming request is auto-instrumented as
# a Sentry transaction, which floods the trace/span quota. These are internal
# machine-to-machine calls with no user-latency value, so we sample them out of
# tracing entirely (error capture is unaffected — before_send / capture_exception
# still fire). See _sentry_traces_sampler.
_UNTRACED_PATH_PREFIX = "/api/eval/remote/"


def _sentry_traces_sampler(sampling_context: dict[str, Any]) -> float:
    """Drop traces for the remote-worker poll endpoints, keep the configured rate otherwise.

    The ASGI scope is available in the sampling context before route resolution,
    so we match on the raw request path. Returning 0.0 means the transaction is
    never sampled (no spans sent); errors are still reported independently.
    """
    scope = sampling_context.get("asgi_scope")
    path = scope.get("path", "") if isinstance(scope, dict) else ""
    if path.startswith(_UNTRACED_PATH_PREFIX):
        return 0.0
    return settings.SENTRY_TRACES_SAMPLE_RATE


def _sentry_before_send(event: Event, hint: dict[str, Any]) -> Event | None:
    """Group transient DB connection errors into a single Sentry issue.

    SQLAlchemy wraps asyncpg errors in DBAPIError, so we walk the __cause__
    chain to detect the underlying asyncpg exception type.
    """
    exc_info = hint.get("exc_info")
    if exc_info is not None:
        exc = exc_info[1]
        depth = 0
        while exc is not None and depth < _MAX_CAUSE_CHAIN_DEPTH:
            if isinstance(exc, _DB_TRANSIENT_ERRORS):
                event["fingerprint"] = ["db-connection-lost"]
                break
            exc = exc.__cause__
            depth += 1
    return event


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # CR #1.2: refuse to boot a non-development environment with the default
    # SECRET_KEY — a publicly-known signing key makes every JWT forgeable. Checked
    # before anything else so the deploy-blocker fires as early as possible.
    assert_secret_key_configured()
    # D-22: validate insights Agent FIRST — startup failure is a deploy-blocker.
    # Orphan cleanup is best-effort and must not run if the app can't serve
    # the insights endpoint. Any pydantic-ai UserError / ValueError
    # propagates, aborting uvicorn startup (D-36).
    get_insights_agent()
    await cleanup_orphaned_jobs()
    # Phase 78 D-02: long-lived Stockfish UCI process. Comes AFTER existing startup
    # so engine startup failure does not mask deploy-blocker validation. try/finally
    # ensures stop_engine runs on exception during yield (graceful shutdown of UCI).
    await start_engine()
    # Phase 174 / D-03: eager-load the one process-wide Maia ONNX session right
    # after Stockfish, mirroring its lifecycle. NO-OP when onnxruntime is absent
    # (lean/worker images) — start_maia catches ImportError and disables Maia
    # gracefully (D-03a), so this can never block boot.
    await start_maia()
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
    # Phase 187 / SEED-116: daily guest inactivity cleanup (D-01/D-02). No
    # ordering dependency with stop_engine/stop_maia — guest cleanup never
    # touches the engine.
    guest_cleanup_task = asyncio.create_task(run_periodic_guest_cleanup(), name="guest-cleanup")
    try:
        yield
    finally:
        # WR-03: stop_engine() must always run even if the reaper or drain task
        # raises a non-CancelledError on shutdown — otherwise the long-lived
        # Stockfish UCI process leaks across restarts. Cancel both tasks before
        # awaiting either so they enter cancellation in parallel. Wrap the
        # awaits in an inner try/finally so the engine shutdown is unconditional.
        reaper_task.cancel()
        drain_task.cancel()
        full_drain_task.cancel()
        guest_cleanup_task.cancel()
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
            try:
                await guest_cleanup_task
            except asyncio.CancelledError:
                pass  # expected on shutdown
            except Exception:
                logger.exception("Guest cleanup task raised on shutdown")
        finally:
            await stop_engine()
            # Phase 174 / D-03: tear down the Maia session alongside Stockfish. No
            # cross-dependency with the engine, so order is flexible; stop_maia is a
            # safe no-op when Maia was never started (onnxruntime absent).
            await stop_maia()


if settings.SENTRY_DSN:
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        # Only trace in production — dev traces are noise and waste quota.
        # traces_sampler (not a flat rate) so the remote-worker poll endpoints are
        # excluded from tracing — they otherwise dominate the span quota.
        traces_sampler=_sentry_traces_sampler,
        send_default_pii=False,  # Do not send user PII (emails, IPs)
        before_send=_sentry_before_send,
    )

app = FastAPI(title="FlawChess", version="0.1.0", lifespan=lifespan)

# CORS only needed in development — Caddy provides same-origin routing in production
if settings.ENVIRONMENT == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.add_middleware(LastActivityMiddleware)

app.include_router(auth.router, prefix="/api")
app.include_router(imports.router, prefix="/api")
app.include_router(openings.router, prefix="/api")
app.include_router(position_bookmarks.router, prefix="/api")
app.include_router(stats_router, prefix="/api")
app.include_router(endgames_router, prefix="/api")
app.include_router(insights_router, prefix="/api")
app.include_router(users_router, prefix="/api")
app.include_router(admin_router, prefix="/api")
app.include_router(library_router, prefix="/api")
app.include_router(eval_remote_router, prefix="/api")
app.include_router(feedback.router, prefix="/api")
app.include_router(bots_router, prefix="/api")


@app.get("/", include_in_schema=False)
async def root_redirect():
    return RedirectResponse(url="/docs")


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}
