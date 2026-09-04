from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings

# pool_size + max_overflow cap how many concurrent DB connections one
# uvicorn process can open. The earlier 20 + 30 = 50 ceiling let a single
# import (job 72a4ca0d on 2026-05-21) plus the eval drain plus API traffic
# fan out to 13 active Postgres backends, each holding ~100 MB anon memory.
# Combined with shared_buffers=2GB and Stockfish workers, this exhausted host
# RAM + 4 GB swap and OOM-killed Postgres. 10 + 10 = 20 is well above the
# steady-state need (drain 1-2, import 1-3, API single digits) and bounds
# the per-process memory footprint.
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=settings.DB_ECHO,
    pool_size=10,
    max_overflow=10,
    pool_pre_ping=True,
)

async_session_maker = async_sessionmaker(engine, expire_on_commit=False)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
        await session.commit()


def get_engine() -> AsyncEngine:
    """Expose the module-level engine as a FastAPI dependency.

    Used by ``/api/health`` so the probe can open its OWN short-lived connection
    inside its timeout instead of borrowing the request-scoped session above.
    ``get_async_session`` runs ``session.commit()`` after its ``yield``, outside
    any handler try/except: after a timed-out (cancelled) ``SELECT 1`` that commit
    would run unbounded on a cancelled asyncpg connection and turn the intended
    503 into a 500 or a hang (Phase 216 code review, BLOCKER). Tests override this
    dependency to inject the per-run test engine or a stub.
    """
    return engine
