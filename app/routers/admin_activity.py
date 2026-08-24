"""Hosted superuser Activity Pulse endpoint (Quick 260824-qaz).

Serves the same dashboard dataset as the standalone `dashboard/server.py` tool,
built from the SAME `dashboard/stats.py` + `dashboard/queries.py` (D-3) so the
SQL is never duplicated between the two consumers. Per the admin-router
convention (CLAUDE.md / app/routers/admin.py), 401/403 raised by
`current_superuser` are EXPECTED conditions — not wrapped in Sentry capture.
"""

import logging
from typing import Annotated

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.models.user import User
from app.users import current_superuser
from dashboard.config import HOSTED_CACHE_TTL_SECONDS
from dashboard.stats import StatsCache, build_readonly_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/activity", tags=["admin"])

_APP_NAME = "flawchess-activity-hosted"

# Lazy module-level cache: built on first request, NOT at import time. A
# module-level create_async_engine() call would open a dev-DB engine during
# every pytest session (app/main.py always imports this router). Lazy
# construction also gives tests a seam: app.dependency_overrides can point
# get_activity_cache at a StatsCache built against the per-run test engine
# instead of settings.DATABASE_URL.
_cache: StatsCache | None = None


async def get_activity_cache() -> StatsCache:
    global _cache
    if _cache is None:
        # Per D-4: settings.DATABASE_URL, NOT settings.DATABASE_URL_PROD. In
        # production the two point at the same database — DATABASE_URL_PROD
        # only exists so the standalone dashboard tool can reach production
        # from a developer's machine through bin/prod_db_tunnel.sh. This
        # endpoint runs IN the production container, where settings.DATABASE_URL
        # already resolves to the real database; DATABASE_URL_PROD there is a
        # dev-only tunnel URL that would not resolve. Do not "fix" this to
        # DATABASE_URL_PROD.
        engine = build_readonly_engine(settings.DATABASE_URL, _APP_NAME)
        _cache = StatsCache(engine, ttl_seconds=HOSTED_CACHE_TTL_SECONDS)
    return _cache


async def dispose_activity_engine() -> None:
    """Dispose the module-level cache's engine. Called from app/main.py's lifespan."""
    global _cache
    if _cache is not None:
        await _cache.dispose()
        _cache = None


@router.get("/stats", response_model=None)
async def activity_stats(
    _admin: Annotated[User, Depends(current_superuser)],
    cache: Annotated[StatsCache, Depends(get_activity_cache)],
    refresh: bool = False,
) -> JSONResponse:
    """Return the whole Activity Pulse dataset, cached for HOSTED_CACHE_TTL_SECONDS.

    The payload is large and TypedDict, not a Pydantic model — re-validating it
    through Pydantic on every hit buys nothing (response_model=None). A
    SQLAlchemyError during the query pass IS a bug (unlike the 401/403 above),
    so it is captured to Sentry and surfaced as a 503, mirroring
    dashboard/server.py's own handling of the same failure mode.
    """
    try:
        payload = await cache.get(force=refresh)
    except SQLAlchemyError as exc:
        sentry_sdk.capture_exception(exc)
        logger.warning("activity stats query failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="Could not build the activity dashboard payload.",
        ) from exc
    return JSONResponse(dict(payload), headers={"Cache-Control": "no-store"})
