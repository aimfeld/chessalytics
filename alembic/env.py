import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context

from app.core.config import settings
from app.models.base import Base
from app.models.position_bookmark import PositionBookmark  # noqa: F401
from app.models.game import Game  # noqa: F401
from app.models.game_position import GamePosition  # noqa: F401
from app.models.oauth_account import OAuthAccount  # noqa: F401
from app.models.user import User  # noqa: F401
from app.models.opening import Opening  # noqa: F401
from app.models.llm_log import LlmLog  # noqa: F401
from app.models.benchmark_cohort_cdf import BenchmarkCohortCdf  # noqa: F401
from app.models.feedback import Feedback  # noqa: F401
from app.models.user_activity import UserActivity  # noqa: F401
from app.models.bot_game_settings import BotGameSettings  # noqa: F401
from app.models.user_import_settings import UserImportSettings  # noqa: F401
from app.models.drill_item import DrillItem  # noqa: F401
from app.models.drill_session import DrillSession  # noqa: F401
from app.models.drill_solve import DrillSolve  # noqa: F401
from app.models.train_settings import TrainSettings  # noqa: F401
from app.models.herring_pool import HerringPool  # noqa: F401
from app.models.push_subscription import PushSubscription  # noqa: F401

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Override sqlalchemy.url with the application settings
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

# Interpret the config file for Python logging.
# This line sets up loggers basically.
# disable_existing_loggers=False: the default (True) marks every already-created
# logger as `disabled`, which silently kills app loggers when a migration runs
# in-process (e.g. Alembic-driven tests) — a disabled logger drops all records,
# breaking pytest's caplog capture for any test that runs after a migration
# (surfaced as a serial-only failure in tests/test_guest_cleanup_service.py).
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# add your model's MetaData object here
# for 'autogenerate' support
target_metadata = Base.metadata

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode.

    This configures the context with just a URL
    and not an Engine, though an Engine is acceptable
    here as well.  By skipping the Engine creation
    we don't even need a DBAPI to be available.

    Calls to context.execute() here emit the given string to the
    script output.

    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


# Indexes that Alembic autogenerate keeps emitting as "changed" due to upstream
# bugs around postgresql_ops={"col": "DESC"} on functional/composite indexes
# (Alembic #1166 / #1213 / #1285). The ORM declaration matches the DB; autogen
# just can't see through the literal_column("col DESC") representation. Skip
# them so noise diffs stop landing in every fresh autogenerate run.
_AUTOGEN_INDEX_IGNORELIST = {
    "ix_llm_logs_endpoint_created_at",
    "ix_llm_logs_model_created_at",
    "ix_llm_logs_user_id_created_at",
    # Partial indexes created by Phase 91/116/117/119 migrations — not reflected in ORM
    # declarations (SQLAlchemy can't represent partial indexes in the ORM, only in migrations).
    # Autogenerate sees them as "removed" because the ORM has no knowledge of them, but they
    # must not be dropped. Phase 122 migration correctly excludes them (see note in upgrade()).
    "ix_games_evals_pending",
    "ix_games_full_evals_pending",
    "ix_games_full_pv_pending",
    "ix_games_needs_engine_full_evals",
    # Partial index from the Phase 145 tier-4 blob-backfill migration (c3f5d1e8a092),
    # WHERE allowed_pv_lines IS NULL. Like the others above it is migration-only (not
    # ORM-declared), so without this entry the next --autogenerate would emit
    # op.drop_index on prod's most-scanned game_flaws index (~348M scans). Time-bomb
    # fix from code-review 2026-07-02 (#3).
    "ix_game_flaws_blob_backfill",
    # ix_eval_jobs_user_id is created by index=True on EvalJob.user_id but autogenerate
    # detects it as missing in the DB due to the eval_jobs table being created by a prior
    # migration that didn't reflect this ORM-level index. Let alembic manage it separately.
    "ix_eval_jobs_user_id",
}


# Benchmark-only tables (Phase 69 INFRA-02, Phase 212 D-08). These tables live
# on the shared declarative Base (so target_metadata sees them) but are
# created ONLY by targeted Base.metadata.create_all(tables=[...]) from
# scripts/ against the benchmark engine on :5433 -- never by an Alembic
# migration. _include_object previously filtered indexes only (see
# _AUTOGEN_INDEX_IGNORELIST above and the 2026-07-02 code-review note), so
# tables were never filtered: the next unrelated `alembic revision
# --autogenerate` would have silently emitted op.create_table for each of
# these against prod's migration chain, the same class of latent time-bomb
# the index ignorelist above already guards against. This retroactively
# protects the two tables that predate this fix
# (benchmark_selected_users, benchmark_ingest_checkpoints) as well as the two
# added in Phase 212 (benchmark_selection, benchmark_lichess_eval_snapshot).
# Do NOT add benchmark_cohort_cdf here -- that table IS canonical and is
# deliberately imported at the top of this module.
_AUTOGEN_TABLE_IGNORELIST = {
    "benchmark_selected_users",
    "benchmark_ingest_checkpoints",
    "benchmark_selection",
    "benchmark_lichess_eval_snapshot",
}


def _include_object(object_, name, type_, reflected, compare_to):  # type: ignore[no-untyped-def]
    if type_ == "index" and name in _AUTOGEN_INDEX_IGNORELIST:
        return False
    if type_ == "table" and name in _AUTOGEN_TABLE_IGNORELIST:
        return False
    return True


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=_include_object,
        compare_type=True,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    """In this scenario we need to create an Engine
    and associate a connection with the context.

    """

    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode."""

    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
