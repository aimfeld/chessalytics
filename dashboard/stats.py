"""Reusable, side-effect-free pieces of the activity dashboard runtime.

Both `dashboard/server.py` (the standalone tunnel-driven tool, queried against
`settings.DATABASE_URL_PROD`) and `app/routers/admin_activity.py` (the hosted
superuser page, queried against `settings.DATABASE_URL`) import from here — one
read-only engine factory, one payload builder, one cache implementation, so the
two consumers can never drift apart (D-3).

Importing this module has NO side effects: no engine is opened at import time.
That is what makes it safe for `app/` to import. `dashboard/server.py`, by
contrast, opens a prod-URL engine as a module-level side effect (`app =
create_app()`), which is exactly why `app/` must never import that module.
"""

import asyncio
import datetime

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from dashboard import queries
from dashboard.config import POLL_INTERVAL_SECONDS, PROMOTED_AT_SINCE

# One connection is plenty: the payload is built by a single sequential pass and
# results are cached, so concurrency here would only add load on the database.
_POOL_SIZE = 1


def build_readonly_engine(url: str, application_name: str) -> AsyncEngine:
    """Open a read-only engine against `url`.

    ``default_transaction_read_only`` is a server setting applied per connection:
    every transaction on this engine starts read-only, so an accidental write
    fails with a Postgres error rather than mutating data.
    """
    return create_async_engine(
        url,
        pool_size=_POOL_SIZE,
        max_overflow=0,
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "default_transaction_read_only": "on",
                "application_name": application_name,
            }
        },
    )


async def build_payload(engine: AsyncEngine) -> queries.Payload:
    """Run every dashboard query in one read-only connection."""
    async with engine.connect() as conn:
        first_day, days, last_complete = await queries.fetch_day_range(conn)
        return queries.Payload(
            generated_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            promoted_since=PROMOTED_AT_SINCE,
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
    """Serves one payload to every caller, refreshing at most once per TTL."""

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

    async def dispose(self) -> None:
        """Dispose the underlying engine's connection pool."""
        await self._engine.dispose()
