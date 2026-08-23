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
import asyncio
import contextlib
import datetime
import logging
from collections.abc import AsyncIterator
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from app.core.config import settings
from dashboard import queries
from dashboard.config import (
    CACHE_TTL_SECONDS,
    HOST,
    LAUNCH_DATE,
    POLL_INTERVAL_SECONDS,
    PORT,
)

logger = logging.getLogger("dashboard")

_STATIC_DIR = Path(__file__).parent / "static"
_APP_NAME = "flawchess-activity-dashboard"

# One connection is plenty: the payload is built by a single sequential pass and
# results are cached, so concurrency here would only add load on production.
_POOL_SIZE = 1


def _build_engine() -> AsyncEngine:
    """Open a read-only engine against the tunnelled production database.

    ``default_transaction_read_only`` is a server setting applied per connection:
    every transaction on this engine starts read-only, so an accidental write
    fails with a Postgres error rather than mutating production data.
    """
    return create_async_engine(
        settings.DATABASE_URL_PROD,
        pool_size=_POOL_SIZE,
        max_overflow=0,
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "default_transaction_read_only": "on",
                "application_name": _APP_NAME,
            }
        },
    )


async def build_payload(engine: AsyncEngine) -> queries.Payload:
    """Run every dashboard query in one read-only connection."""
    async with engine.connect() as conn:
        first_day, days, last_complete = await queries.fetch_day_range(conn)
        return queries.Payload(
            generated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            launch_date=LAUNCH_DATE,
            poll_interval_seconds=POLL_INTERVAL_SECONDS,
            days=days,
            last_complete_index=last_complete,
            activity=await queries.fetch_activity(conn, first_day),
            signups=await queries.fetch_signups(conn, first_day),
            bot=await queries.fetch_bot_games(conn),
            train=await queries.fetch_train(conn),
            solves=await queries.fetch_solves(conn),
            imports=await queries.fetch_imports(conn, first_day),
            persona=await queries.fetch_persona(conn),
            bot_players=await queries.fetch_bot_players(conn),
            elo=await queries.fetch_elo(conn),
            funnel=await queries.fetch_funnel(conn, first_day),
            tti=await queries.fetch_time_to_import(conn, first_day),
            stick=await queries.fetch_stickiness(conn, first_day),
            conversion=await queries.fetch_conversion(conn, first_day),
            conversion_compare=await queries.fetch_conversion_compare(conn, first_day),
        )


class StatsCache:
    """Serves one payload to every poller, refreshing at most once per TTL."""

    def __init__(self, engine: AsyncEngine, ttl_seconds: int) -> None:
        self._engine = engine
        self._ttl = ttl_seconds
        self._lock = asyncio.Lock()
        self._payload: queries.Payload | None = None
        self._fetched_at: float = 0.0

    async def get(self, *, force: bool = False) -> queries.Payload:
        loop = asyncio.get_running_loop()
        async with self._lock:
            fresh = self._payload is not None and loop.time() - self._fetched_at < self._ttl
            if fresh and not force:
                assert self._payload is not None
                return self._payload
            payload = await build_payload(self._engine)
            self._payload, self._fetched_at = payload, loop.time()
            return payload


def create_app(*, ttl_seconds: int = CACHE_TTL_SECONDS) -> FastAPI:
    engine = _build_engine()
    cache = StatsCache(engine, ttl_seconds)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await engine.dispose()

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
