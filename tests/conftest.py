import asyncio
import os
import re
import urllib.parse
import uuid

# Disable Sentry before any app imports — must precede app.core.config which
# reads SENTRY_DSN from env/.env.  Without this, test-triggered exceptions
# (e.g. mocked ValueError in import tests) leak to the real Sentry project.
os.environ["SENTRY_DSN"] = ""

# Use a full-length (32-byte) SECRET_KEY for tests so PyJWT does not emit
# InsecureKeyLengthWarning on every encode/decode. The production default
# "change-me-in-production" is 23 bytes, below RFC 7518 §3.2 minimum for HS256.
os.environ["SECRET_KEY"] = "test-secret-key-32-bytes-exactly-ok-for-hs256-tests"

# Pydantic-AI's built-in "test" provider prefix passes Agent(...) startup
# validation without requiring any real API key. Individual tests override
# via monkeypatch + TestModel/FunctionModel (see `fake_insights_agent`
# fixture added in a later plan). Must precede any `from app...` import so
# app/services/insights_llm module-level Agent construction (and the
# lifespan-time get_insights_agent() call in app/main.py) see the env var.
os.environ["PYDANTIC_AI_MODEL_INSIGHTS"] = "test"

import asyncpg
import chess
import pytest
import pytest_asyncio
from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from alembic.script import ScriptDirectory
from collections.abc import AsyncGenerator
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models.user import User

# Phase 61: expose the seeded_user fixture without requiring test modules to
# import it by name (import + parameter-name pytest fixture use triggers
# ruff F811 "redefined unused import" otherwise).
pytest_plugins = ["tests.seed_fixtures"]

# ---------------------------------------------------------------------------
# Per-run database isolation — Phase 100
#
# OVERVIEW
# --------
# (a) Each pytest session (and each xdist worker) gets its own database
#     "flawchess_test_<worker|pid>" cloned from the migrated template
#     "flawchess_test_template" via CREATE DATABASE ... TEMPLATE.  This removes
#     the session-start whole-schema ACCESS EXCLUSIVE lock (from the old
#     per-session table wipe) that blocked concurrent agent runs.
#
# (b) The template is auto-refreshed when the live Alembic head differs from
#     the template's stored alembic_version row — no manual rebuild step.
#     The refresh is serialized across concurrent runs by
#     pg_advisory_lock(_TEMPLATE_ADVISORY_LOCK_KEY): only the first run that
#     acquires the advisory lock performs the drop+remigrate; the others block
#     on the lock and then re-check drift after acquiring it (Pitfall 4 in
#     RESEARCH.md) so they skip the refresh and proceed directly to cloning.
#
# (c) Killed runs self-heal: a DROP DATABASE IF EXISTS before each CREATE
#     DATABASE acts as a stale-DB reaper — residue from a previously killed
#     pytest session is cleaned up automatically on the next invocation.
#
# (d) No manual template rebuild is ever needed.  After a migration the
#     template auto-refreshes on the next pytest run, paying migration time
#     (~1.7 s for 66 migrations) once and serving all subsequent clones.
#
# Advisory lock key — reserved for flawchess test template refresh.
# This is a fixed, app-chosen 64-bit integer; any unique value is valid as a
# pg_advisory_lock key.  7_777_777_777 is reserved for this purpose
# cluster-wide.
_TEMPLATE_ADVISORY_LOCK_KEY: int = 7_777_777_777

# Name of the shared migrated template database.  All per-run clones are
# created from this template via CREATE DATABASE <run_db> TEMPLATE <template>.
_TEMPLATE_DB_NAME: str = "flawchess_test_template"

# Valid PostgreSQL identifier for a database name (lower-case, digits,
# underscore; must start with a letter or underscore; <=63 bytes).  DB names
# cannot be parameter-bound in DDL, so they are interpolated as raw SQL
# identifiers — this guard ensures an explicit TEST_DB_NAME override cannot
# carry a statement-injection payload (threat model T-100-01 / review WR-02).
_DB_NAME_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _get_run_db_name() -> str:
    """Derive the per-run / per-worker database name.

    Priority order (CONTEXT.md Claude's Discretion):
      1. TEST_DB_NAME env var — explicit override
      2. PYTEST_XDIST_WORKER env var — set by pytest-xdist to "gw0", "gw1", …
      3. os.getpid() fallback for serial (non-xdist) runs

    Returns a name like "flawchess_test_gw0" or "flawchess_test_<pid>".
    DB names derive only from trusted sources (fixed prefix + xdist-set env
    var / PID / dev-controlled env var) — never from user/request input.
    The dev-controlled TEST_DB_NAME override is validated as a PostgreSQL
    identifier before it is interpolated into DDL (threat model T-100-01).
    """
    explicit = os.environ.get("TEST_DB_NAME")
    if explicit:
        if not _DB_NAME_RE.match(explicit):
            raise ValueError(
                f"TEST_DB_NAME={explicit!r} is not a valid PostgreSQL identifier "
                r"(expected ^[a-z_][a-z0-9_]{0,62}$)"
            )
        return explicit
    worker = os.environ.get("PYTEST_XDIST_WORKER")
    if worker:
        return f"flawchess_test_{worker}"
    return f"flawchess_test_{os.getpid()}"


def _maint_dsn(test_db_url: str) -> str:
    """Return an asyncpg plain DSN pointing at the 'postgres' maintenance DB.

    asyncpg.connect() requires a plain postgresql:// URL (no +asyncpg scheme
    prefix).  DDL statements (CREATE/DROP DATABASE) must run outside a
    transaction — asyncpg connections are autocommit by default, which is
    exactly what we need (SQLAlchemy wraps every connection in a transaction
    and raises ActiveSQLTransactionError for these DDL statements).
    """
    p = urllib.parse.urlparse(test_db_url)
    return f"postgresql://{p.username}:{p.password}@{p.hostname}:{p.port}/postgres"


def _run_alembic_upgrade(template_url: str, original_url: str) -> None:
    """Migrate the template DB to Alembic head (sync; run via asyncio.to_thread).

    Runs in a worker thread so Alembic's env.py — which calls asyncio.run()
    internally — gets a clean event loop.  Calling it directly from the running
    _ensure_template_fresh loop would raise RuntimeError; calling it from the
    sync test_engine fixture (the previous approach) released the advisory lock
    before migration finished, letting a concurrent worker drop the half-migrated
    template (review CR-01).  Threading keeps the migration inside the locked
    critical section.

    MANDATORY: patch settings.DATABASE_URL because alembic/env.py overwrites
    AlembicConfig's sqlalchemy.url from settings.DATABASE_URL at load time
    (RESEARCH Pitfall 1).  Restored in finally.
    """
    settings.DATABASE_URL = template_url
    try:
        cfg = AlembicConfig("alembic.ini")
        cfg.set_main_option("sqlalchemy.url", template_url)
        alembic_command.upgrade(cfg, "head")
    finally:
        settings.DATABASE_URL = original_url


def _alembic_head() -> str:
    """Return the current Alembic head revision from migration scripts.

    Pure-Python call — no DB connection required.
    """
    cfg = AlembicConfig("alembic.ini")
    head = ScriptDirectory.from_config(cfg).get_current_head()
    assert head is not None, "No alembic head found — broken migration chain"
    return head


async def _ensure_template_fresh(maint_dsn: str) -> None:
    """Bootstrap flawchess_test_template under an advisory lock.

    Compares the live Alembic head against the template's alembic_version.
    On drift (or if the template is missing), terminates lingering connections,
    drops the old template, creates a fresh empty one from template1, and
    migrates it to Alembic head — all inside the advisory-locked critical
    section.

    The advisory lock serializes concurrent refreshes cluster-wide: only the
    first run performs the drop+recreate+migrate; the others block on the lock,
    then re-check drift after acquiring it and find the template already up to
    date (Pitfall 4 re-check).

    CR-01 fix: the Alembic migration runs INSIDE the lock (via asyncio.to_thread
    so Alembic's internal asyncio.run() gets a clean worker-thread loop).  The
    previous approach returned the template URL and migrated in the sync caller
    AFTER this coroutine closed its lock-holding connection — that released the
    lock before migration finished, letting a second worker observe a template
    with no alembic_version table, judge it stale, and DROP it mid-migration.
    Holding the lock across the migration closes that race.

    asyncpg connections are autocommit by default — no BEGIN is injected, so
    CREATE DATABASE / DROP DATABASE work natively (RESEARCH Pattern 1).
    """
    head = _alembic_head()
    original_url = settings.DATABASE_URL
    p = urllib.parse.urlparse(maint_dsn)
    template_url = (
        f"postgresql+asyncpg://{p.username}:{p.password}@{p.hostname}:{p.port}/{_TEMPLATE_DB_NAME}"
    )
    admin = await asyncpg.connect(maint_dsn)
    try:
        await admin.execute(f"SELECT pg_advisory_lock({_TEMPLATE_ADVISORY_LOCK_KEY})")
        try:
            # Re-check AFTER acquiring the lock — a concurrent run may have
            # already refreshed the template while we were waiting (Pitfall 4).
            tmpl_exists = await admin.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = $1", _TEMPLATE_DB_NAME
            )
            tmpl_version: str | None = None
            if tmpl_exists:
                tmpl_conn = await asyncpg.connect(
                    host=p.hostname,
                    port=p.port,
                    user=p.username,
                    password=p.password,
                    database=_TEMPLATE_DB_NAME,
                )
                try:
                    tmpl_version = await tmpl_conn.fetchval(
                        "SELECT version_num FROM alembic_version LIMIT 1"
                    )
                except asyncpg.exceptions.UndefinedTableError:
                    tmpl_version = None
                finally:
                    await tmpl_conn.close()

            if not tmpl_exists or tmpl_version != head:
                # Terminate lingering connections to the template before DROP
                # (RESEARCH Pitfall 3 / Pattern 5 — ObjectInUseError otherwise).
                await admin.execute(
                    """SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                       WHERE datname = $1 AND pid <> pg_backend_pid()""",
                    _TEMPLATE_DB_NAME,
                )
                await admin.execute(f"DROP DATABASE IF EXISTS {_TEMPLATE_DB_NAME}")
                await admin.execute(f"CREATE DATABASE {_TEMPLATE_DB_NAME} TEMPLATE template1")
                # Migrate INSIDE the lock (CR-01).  asyncio.to_thread gives
                # Alembic's env.py asyncio.run() a fresh loop while the
                # lock-holding `admin` connection stays open in this loop.
                await asyncio.to_thread(_run_alembic_upgrade, template_url, original_url)
        finally:
            await admin.execute(f"SELECT pg_advisory_unlock({_TEMPLATE_ADVISORY_LOCK_KEY})")
    finally:
        await admin.close()


async def _create_run_db(maint_dsn: str, run_db_name: str) -> None:
    """Drop any stale run DB then clone a fresh one from the template.

    The DROP DATABASE IF EXISTS is the stale-DB reaper — it cleans up residue
    from killed pytest runs so they self-heal on the next invocation (SC-2).
    asyncpg autocommit ensures both DDL statements run outside a transaction.
    """
    admin = await asyncpg.connect(maint_dsn)
    try:
        # Stale reaper: clean up residue from a previously killed run.
        await admin.execute(f"DROP DATABASE IF EXISTS {run_db_name}")
        await admin.execute(f"CREATE DATABASE {run_db_name} TEMPLATE {_TEMPLATE_DB_NAME}")
    finally:
        await admin.close()


async def _drop_run_db(maint_dsn: str, run_db_name: str) -> None:
    """Drop the per-run database at session teardown.

    Called AFTER engine.sync_engine.dispose() to close the SQLAlchemy pool.
    Uses WITH (FORCE) (PostgreSQL 14+) to terminate any residual connections
    that survived the pool dispose — e.g. async connections from session-scoped
    pytest-asyncio fixtures that outlive the sync test_engine teardown point
    (RESEARCH Assumption A3 / Pitfall 2).
    """
    admin = await asyncpg.connect(maint_dsn)
    try:
        await admin.execute(f"DROP DATABASE IF EXISTS {run_db_name} WITH (FORCE)")
    finally:
        await admin.close()


def _quiet_connection_lost(loop: asyncio.AbstractEventLoop, context: dict[str, object]) -> None:
    """Swallow the benign 'unexpected connection_lost() call' teardown noise.

    Per-run DB teardown drops the database WITH (FORCE) (see _drop_run_db),
    which server-side terminates any asyncpg connection still attached to it —
    e.g. the per-run engine's pool connections (sync dispose doesn't send a
    graceful Terminate) or a session-scoped fixture connection that outlived
    dispose (RESEARCH Assumption A3).  asyncpg raises
    ConnectionError('unexpected connection_lost() call') into that connection's
    orphaned waiter future; with nothing awaiting it, asyncio's default handler
    logs it to stderr at loop close.  The drop is intentional and the session
    is already over, so this is pure teardown noise — suppress exactly this
    error and defer everything else to the default handler.
    """
    exc = context.get("exception")
    if isinstance(exc, ConnectionError) and "connection_lost" in str(exc):
        return
    loop.default_exception_handler(context)


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _silence_connection_lost_noise() -> AsyncGenerator[None, None]:
    """Install the connection_lost teardown-noise filter on the session loop.

    Session-scoped + autouse so it runs on the same session event loop that
    owns the connections the per-run-DB WITH (FORCE) drop terminates
    (asyncio_default_*_loop_scope = "session").  The handler stays set for the
    loop's lifetime, including the loop-close pass where the orphaned
    connection_lost futures would otherwise be logged to stderr.
    """
    asyncio.get_running_loop().set_exception_handler(_quiet_connection_lost)
    yield


@pytest.fixture(scope="session")
def test_engine():
    """Create a per-run async engine cloned from the migrated template DB.

    Session-scoped: created once per pytest session (and once per xdist worker
    subprocess), disposed at teardown.

    Setup:
      1. Ensure flawchess_test_template is up to date with Alembic head
         (advisory-lock-guarded refresh; re-checked after lock acquisition).
      2. DROP DATABASE IF EXISTS the per-run DB (stale reaper — SC-2 self-heal
         for killed runs) then CREATE DATABASE <run_db> TEMPLATE <template>.
      3. Patch settings.DATABASE_URL to the per-run DB URL so all code that
         opens its own sessions (on_after_login, LastActivityMiddleware, etc.)
         also hits the per-run DB.
      4. Yield the async engine.

    Teardown ordering is STRICT (RESEARCH Pitfall 2):
      - engine.sync_engine.dispose() FIRST (releases SQLAlchemy pool connections)
      - DROP DATABASE IF EXISTS <run_db> (fails if connections are still open)
      - Restore settings.DATABASE_URL

    asyncpg DDL runs via asyncio.run() throwaway loops — asyncpg pools are
    event-loop-bound so each DDL block uses its own short-lived loop
    (RESEARCH Pattern 7, same pattern used by the old per-session table-wipe).
    """
    original_url = settings.DATABASE_URL
    run_db_name = _get_run_db_name()
    maint = _maint_dsn(settings.DATABASE_URL_TEST)

    # Ensure the template DB exists and is at Alembic head.  The advisory-lock-
    # guarded refresh (drop + recreate + migrate) all happens inside
    # _ensure_template_fresh under the lock (CR-01) — the migration no longer
    # leaks out into this sync fixture.
    asyncio.run(_ensure_template_fresh(maint))

    # Clone a per-run DB from the (now fresh) template.
    asyncio.run(_create_run_db(maint, run_db_name))

    p = urllib.parse.urlparse(settings.DATABASE_URL_TEST)
    run_db_url = (
        f"postgresql+asyncpg://{p.username}:{p.password}@{p.hostname}:{p.port}/{run_db_name}"
    )

    # Patch settings.DATABASE_URL to the per-run DB.  All downstream code that
    # opens its own sessions flows through this single patch point unchanged —
    # override_get_async_session, db_session, and fresh_test_user all resolve
    # through the engine yielded here.
    settings.DATABASE_URL = run_db_url
    engine = create_async_engine(run_db_url, echo=False)

    try:
        yield engine
    finally:
        # Teardown: dispose engine BEFORE drop (open connections block DROP
        # DATABASE — RESEARCH Pitfall 2).  Wrapped so settings.DATABASE_URL is
        # always restored even if dispose/drop raises (review IN-01).
        try:
            engine.sync_engine.dispose()
            asyncio.run(_drop_run_db(maint, run_db_name))
        finally:
            settings.DATABASE_URL = original_url


@pytest.fixture(autouse=True, scope="session")
def override_get_async_session(test_engine):
    """Route all DB sessions to the test DB.

    Session-scoped autouse: active for the entire test session.
    Overrides both the FastAPI DI dependency AND the module-level
    async_session_maker so that code bypassing DI (e.g. on_after_login)
    also hits the test DB.
    """
    import app.core.database as db_module
    import app.middleware.last_activity as activity_module
    import app.repositories.llm_log_repository as llm_log_repo_module
    import app.services.eval_queue_service as eval_queue_module
    import app.users as users_module
    from app.core.database import get_async_session
    from app.main import app as fastapi_app

    test_session_maker = async_sessionmaker(test_engine, expire_on_commit=False)

    # Patch async_session_maker everywhere it's imported, so non-DI code
    # (e.g. UserManager.on_after_login, LastActivityMiddleware, create_llm_log's
    # D-02 own-session write path, enqueue_tier1_game) also uses the test DB.
    original_db_session_maker = db_module.async_session_maker
    original_users_session_maker = users_module.async_session_maker
    original_activity_session_maker = activity_module.async_session_maker
    original_llm_log_repo_session_maker = llm_log_repo_module.async_session_maker
    # Phase 118: enqueue_tier1_game opens its own session via async_session_maker
    # captured at module import time.  Patch the service module binding so enqueue
    # calls during router tests hit the test DB.
    original_eval_queue_session_maker = eval_queue_module.async_session_maker
    db_module.async_session_maker = test_session_maker
    users_module.async_session_maker = test_session_maker
    activity_module.async_session_maker = test_session_maker
    llm_log_repo_module.async_session_maker = test_session_maker
    eval_queue_module.async_session_maker = test_session_maker

    async def _test_session_generator():
        async with test_session_maker() as session:
            yield session
            await session.commit()

    fastapi_app.dependency_overrides[get_async_session] = _test_session_generator
    yield
    fastapi_app.dependency_overrides.pop(get_async_session, None)
    db_module.async_session_maker = original_db_session_maker
    users_module.async_session_maker = original_users_session_maker
    activity_module.async_session_maker = original_activity_session_maker
    llm_log_repo_module.async_session_maker = original_llm_log_repo_session_maker
    eval_queue_module.async_session_maker = original_eval_queue_session_maker


@pytest.fixture(scope="session", autouse=True)
def seed_openings_for_tests(test_engine: object) -> None:  # noqa: ARG001
    """Seed the openings table once per session (per xdist worker).

    Under xdist, each worker gets its own per-run DB (flawchess_test_gw0,
    gw1, etc.).  Any test that queries openings_dedup (e.g.
    TestQueryTopOpeningsSqlWDL) requires this seed to have run on the SAME
    worker.  Placing this fixture in conftest.py ensures every worker seeds
    its own DB, regardless of which test modules it collects.

    The fixture in tests/test_seed_openings.py is identical and remains as the
    canonical autouse hook for serial runs; this conftest copy guarantees xdist
    workers that do NOT collect test_seed_openings.py also get seeded.

    seed_openings() uses INSERT ... ON CONFLICT DO UPDATE, so calling it
    multiple times is safe.
    """
    from scripts.seed_openings import seed_openings

    asyncio.run(seed_openings())


@pytest.fixture(autouse=True)
def reset_in_process_rate_limiters() -> None:
    """Clear the in-process sliding-window limiters before every test.

    `guest_create_limiter` (per-IP), `feedback_limiter` (per-user), and
    `reset_password_limiter` (per-email, Phase 207) are all module-level
    singletons that persist for the whole process. Under serial execution
    (CI, D-02) every test shares one process and one ASGI test-client IP, so
    guest-create / feedback / reset-password calls accumulate across unrelated
    tests until the limit trips and an endpoint returns 429 instead of its
    success body (e.g. KeyError: 'access_token'). Under xdist each worker is a
    separate process so the bleed stays under the cap, which is why this only
    flaked in CI. Resetting per-test makes both modes deterministic.
    """
    from app.core.feedback_rate_limiter import feedback_limiter
    from app.core.ip_rate_limiter import guest_create_limiter
    from app.core.reset_password_rate_limiter import reset_password_limiter

    guest_create_limiter._timestamps.clear()
    feedback_limiter._timestamps.clear()
    reset_password_limiter._timestamps.clear()


@pytest.fixture
def starting_board() -> chess.Board:
    """Return a fresh starting-position chess board."""
    return chess.Board()


@pytest.fixture
def empty_board() -> chess.Board:
    """Return an empty chess board (no pieces)."""
    board = chess.Board()
    board.clear()
    return board


async def ensure_test_user(session: AsyncSession, user_id: int) -> None:
    """Create a test user with the given ID if it doesn't already exist.

    Needed because user_id columns have FK constraints to the users table.
    """
    existing = (await session.execute(select(User).where(User.id == user_id))).unique()
    if existing.scalar_one_or_none() is None:
        session.add(
            User(id=user_id, email=f"test-{user_id}@example.com", hashed_password="fakehash")
        )
        await session.flush()


@pytest_asyncio.fixture
async def db_session(test_engine) -> AsyncGenerator[AsyncSession, None]:
    """Provide an AsyncSession wrapped in a transaction that is rolled back after each test.

    Uses the per-run test DB engine (the flawchess_test_<pid|worker> clone)
    bound by the test_engine fixture. Each test runs inside a transaction that
    is always rolled back, so tests do not pollute each other even without
    cleanup code.
    """
    async with test_engine.connect() as conn:
        # Begin a transaction that we'll roll back at the end
        await conn.begin()
        # Bind a session to this connection
        session = AsyncSession(bind=conn, expire_on_commit=False)
        try:
            yield session
        finally:
            await session.close()
            await conn.rollback()


@pytest_asyncio.fixture
async def fresh_test_user(test_engine) -> AsyncGenerator[User, None]:
    """A committed User that survives outside the db_session rollback scope.

    Required because create_llm_log (Phase 64 D-02) opens its OWN async session
    via async_session_maker() and commits independently — the rollback-scoped
    db_session fixture cannot observe its writes, and rows inserted against a
    user_id FK must point at a user that actually exists in the DB, not one
    that will disappear at transaction rollback.

    On teardown, the user is deleted (not rolled back). ON DELETE CASCADE on
    llm_logs.user_id (Phase 64 migration) removes any log rows created during
    the test in the same teardown step.
    """
    session_maker = async_sessionmaker(test_engine, expire_on_commit=False)
    async with session_maker() as session:
        user = User(
            email=f"llm-log-test-{uuid.uuid4()}@example.com",
            hashed_password="x",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
    yield user
    async with session_maker() as session:
        await session.execute(delete(User).where(User.id == user.id))
        await session.commit()


@pytest_asyncio.fixture(scope="session")
async def engine_started():
    """Start Stockfish once per pytest session (D-02).

    Session-scoped so the UCI process is shared across all engine wrapper tests
    instead of restarting per test. Skips silently if the resolved Stockfish
    binary is missing (the individual tests handle the skipif marker). Keys on
    the same path the engine resolves so it works with a dev install at
    ~/.local/stockfish/sf, not only a binary literally named `stockfish` on PATH.
    """
    import os

    from app.services.engine import _STOCKFISH_PATH, start_engine, stop_engine

    if not (os.path.isfile(_STOCKFISH_PATH) and os.access(_STOCKFISH_PATH, os.X_OK)):
        yield
        return
    await start_engine()
    try:
        yield
    finally:
        await stop_engine()


@pytest.fixture
def fake_insights_agent(monkeypatch: pytest.MonkeyPatch):
    """Factory fixture that monkeypatches get_insights_agent() with a TestModel.

    Usage:
        def test_x(fake_insights_agent, sample_report):
            fake_insights_agent(sample_report)  # any subsequent call to
            # get_insights_agent() returns an Agent wrapping TestModel
            # that yields sample_report.

    Also clears the lru_cache on entry so prior cached Agents don't leak.
    """
    from pydantic_ai import Agent
    from pydantic_ai.models.test import TestModel
    from app.schemas.insights import EndgameInsightsReport
    from app.services import insights_llm

    # Save reference to the real cached function BEFORE monkeypatching so
    # teardown can clear it (monkeypatch restores AFTER our yield teardown runs,
    # so insights_llm.get_insights_agent would still be the lambda during teardown).
    original_get_insights_agent = insights_llm.get_insights_agent

    def _install(report: EndgameInsightsReport) -> None:
        original_get_insights_agent.cache_clear()
        fake = Agent(
            TestModel(custom_output_args=report.model_dump()),
            output_type=EndgameInsightsReport,
        )
        monkeypatch.setattr(
            "app.services.insights_llm.get_insights_agent",
            lambda: fake,
        )

    yield _install

    # Teardown: clear cache on the original lru_cache function so the real
    # Agent is rebuilt on next use. (monkeypatch restores the name binding
    # after this teardown, so we must use the saved reference.)
    original_get_insights_agent.cache_clear()
