"""Local live dashboard for production activity metrics.

Serves a single page on loopback and refreshes it from the production database
through the SSH tunnel (``bin/prod_db_tunnel.sh``). Read-only by construction:
the engine forces ``default_transaction_read_only`` on every connection, so a
write would raise instead of reaching production.

    uv run python -m dashboard.server            # http://127.0.0.1:8899
    uv run python -m dashboard.server --port 9000

This is an internal analytics tool, not part of the product app.
"""

import argparse
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import settings
from dashboard.config import CACHE_TTL_SECONDS, HOST, PORT
from dashboard.stats import StatsCache, build_readonly_engine

logger = logging.getLogger("dashboard")

_STATIC_DIR = Path(__file__).parent / "static"
_APP_NAME = "flawchess-activity-dashboard"


def _build_engine() -> AsyncEngine:
    """Open a read-only engine against the tunnelled production database.

    See `dashboard.stats.build_readonly_engine` for why read-only is enforced
    as a Postgres server setting rather than by convention.
    """
    return build_readonly_engine(settings.DATABASE_URL_PROD, _APP_NAME)


def create_app(*, ttl_seconds: int = CACHE_TTL_SECONDS) -> FastAPI:
    engine = _build_engine()
    cache = StatsCache(engine, ttl_seconds)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await cache.dispose()

    app = FastAPI(title="FlawChess Activity Pulse", lifespan=lifespan, docs_url=None)

    @app.get("/api/stats")
    async def stats(refresh: bool = False) -> JSONResponse:
        """Return the whole dashboard dataset, cached for the configured TTL."""
        try:
            payload = await cache.get(force=refresh)
        except SQLAlchemyError as exc:
            # Almost always the tunnel being down. Say so instead of a bare 500 —
            # the page renders this message directly.
            logger.warning("prod query failed: %s", type(exc).__name__)
            raise HTTPException(
                status_code=503,
                detail=(
                    "Cannot reach the production database. Start the tunnel with "
                    "bin/prod_db_tunnel.sh and retry."
                ),
            ) from exc
        return JSONResponse(dict(payload), headers={"Cache-Control": "no-store"})

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(_STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")
    return app


app = create_app()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=HOST, help=f"bind address (default {HOST})")
    parser.add_argument("--port", type=int, default=PORT, help=f"port (default {PORT})")
    parser.add_argument(
        "--cache-seconds",
        type=int,
        default=CACHE_TTL_SECONDS,
        help=f"how long a payload is reused before re-querying (default {CACHE_TTL_SECONDS})",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    print(f"Activity Pulse → http://{args.host}:{args.port}  (needs bin/prod_db_tunnel.sh)")
    uvicorn.run(create_app(ttl_seconds=args.cache_seconds), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
