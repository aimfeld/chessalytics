"""Engine, payload builder and cache for the Activity Pulse dashboard.

Consumed by `app/routers/admin_activity.py`, which serves the payload to the
superuser-only `/activity` page. Importing this module has NO side effects: no
engine is opened at import time, so the router can build its cache lazily on
first request rather than opening a connection during every pytest session.
"""

import asyncio
import datetime

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from typing import Final

from app.services import activity_queries as queries

# The date users.promoted_at started recording (see the migration in
# alembic/versions/). Production only begins stamping rows at the first deploy
# on or after this date, so guest-conversion history before it is a floor
# (Google-only, recovered by the migration backfill with the row's signup date
# standing in for the unrecoverable true promotion date), not the true rate.
PROMOTED_AT_SINCE: Final[str] = "2026-08-23"

# The /activity page is manual-refresh only, but build_payload runs ~16
# sequential full-history aggregate queries directly against production. This
# TTL bounds that load no matter how many superuser tabs are open, while still
# refreshing within a normal monitoring session.
CACHE_TTL_SECONDS: Final[int] = 300

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


async def build_payload(
    engine: AsyncEngine, range_key: queries.RangeKey, now_utc: datetime.datetime
) -> queries.Payload:
    """Run every dashboard query, for `range_key` alone, in one read-only connection.

    `now_utc` comes from the caller (ultimately `Depends(dev_now_utc)`), never
    an inline clock read, so the resolved window is reproducible under the
    dev-clock override.
    """
    async with engine.connect() as conn:
        window = await queries.fetch_window(conn, range_key, now_utc)
        return queries.Payload(
            generated_at=now_utc.isoformat(),
            promoted_since=PROMOTED_AT_SINCE,
            range=window.range_key,
            data_start=window.data_start.isoformat(),
            days=window.days,
            window_start_index=window.window_start_index,
            last_complete_index=window.last_complete_index,
            activity=await queries.fetch_activity(conn, window.lead_in_start, window.window_start),
            signups=await queries.fetch_signups(conn, window.window_start),
            bot=await queries.fetch_bot_games(conn, window.window_start),
            train=await queries.fetch_train(conn, window.window_start),
            solves=await queries.fetch_solves(conn, window.lead_in_start),
            imports=await queries.fetch_imports(conn, window.window_start),
            persona=await queries.fetch_persona(conn, window.window_start),
            bot_players=await queries.fetch_bot_players(conn, window.window_start),
            elo=await queries.fetch_elo(conn, window.window_start),
            funnel=await queries.fetch_funnel(conn, window.window_start),
            tti=await queries.fetch_time_to_import(conn, window.window_start),
            stick=await queries.fetch_stickiness(conn, window.window_start),
            conversion=await queries.fetch_conversion(conn, window.window_start),
            conversion_compare=await queries.fetch_conversion_compare(conn, window.window_start),
        )


class StatsCache:
    """Serves one payload PER RANGE KEY, refreshing each key at most once per TTL.

    A SINGLE `asyncio.Lock` guards every key, not one lock per key. The
    read-only engine (`build_readonly_engine`) is opened with `pool_size=1` and
    `max_overflow=0`, so if two range keys were allowed to build concurrently
    under separate locks, two cold misses on different keys could each try to
    check out the one available connection at once. Serialising every build —
    including builds for DIFFERENT keys — behind one lock is what prevents
    that contention; it costs throughput only when two different windows are
    both requested cold at the same instant, which this manual-refresh,
    superuser-only page essentially never does.
    """

    def __init__(self, engine: AsyncEngine, ttl_seconds: int) -> None:
        self._engine = engine
        self._ttl = ttl_seconds
        self._lock = asyncio.Lock()
        # One (payload, fetched_at) entry per range key, so each key ages on
        # its own TTL independently of the other three.
        self._entries: dict[queries.RangeKey, tuple[queries.Payload, float]] = {}

    async def get(
        self,
        range_key: queries.RangeKey,
        *,
        now_utc: datetime.datetime,
        force: bool = False,
    ) -> queries.Payload:
        loop = asyncio.get_running_loop()
        async with self._lock:
            entry = self._entries.get(range_key)
            fresh = entry is not None and loop.time() - entry[1] < self._ttl
            if fresh and not force:
                assert entry is not None
                return entry[0]
            # `force` (from `?refresh=1`) rebuilds ONLY `range_key`'s entry.
            # Dropping all four would force three future cold 16-query
            # rebuilds for a refresh the operator only asked for on the one
            # window in front of them.
            payload = await build_payload(self._engine, range_key, now_utc)
            self._entries[range_key] = (payload, loop.time())
            return payload

    async def dispose(self) -> None:
        """Dispose the underlying engine's connection pool."""
        await self._engine.dispose()
