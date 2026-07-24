"""Enlist a user's games as tier-1 eval_jobs for full-game evaluation.

For the given user, inserts a tier-1 (TIER_EXPLICIT) eval_jobs row for every
game whose `full_evals_completed_at` is NULL — i.e. every game still missing
full-ply Stockfish evals. The already-running full-eval drain worker
(`run_full_eval_drain` in app/services/eval_drain.py, started in the backend
lifespan) then claims these jobs WITH PRIORITY and, in one write transaction
per game, evaluates all plies, classifies flaws, tags tactic motifs, fills the
oracle blunder/mistake/inaccuracy counts, and stamps `full_evals_completed_at`
/ `full_pv_completed_at`. Flaw tagging is therefore automatic — this script
only seeds the queue.

Tier-1 is the highest-priority lane and is claimed regardless of the
`EVAL_AUTO_DRAIN_ENABLED` setting (that flag only gates the tier-3 idle
backlog). For the jobs to actually drain, the target backend must be running
its drain loop (and/or a remote eval worker must be claiming jobs). On prod
the backend is always up, so enqueueing here is sufficient.

Idempotent: a partial unique index (uq_eval_jobs_game_active) allows at most
one active (pending|leased) job per game, so re-running this script never
double-enqueues. Games already queued are reported as "already queued".

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

The URL for each target comes from the DATABASE_URL_{DEV,BENCHMARK,PROD} env
vars (.env), resolved via app.core.config.db_url_for_target.

Usage:
    uv run python scripts/backfill_full_evals.py --db dev --user-id 28 --dry-run
    uv run python scripts/backfill_full_evals.py --db dev --user-id 28
    uv run python scripts/backfill_full_evals.py --db prod --user-id 101
    uv run python scripts/backfill_full_evals.py --db prod --user-id 101 --limit 50
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

import sentry_sdk
import sqlalchemy as sa
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.eval_jobs import TIER_EXPLICIT, EvalJob  # noqa: E402
from app.models.game import Game  # noqa: E402

# Game.user_id has a FK to users.id; importing only Game leaves the users table
# unregistered and select(Game...) raises NoReferencedTableError at compile time.
# User in turn declares a relationship to OAuthAccount, so both must be imported.
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402

# Commit every N enqueues to keep memory + transaction size bounded (OOM history,
# CLAUDE.md). Tier-1 rows are tiny, but batching keeps the SSH tunnel to prod
# responsive and bounds work lost to a mid-run kill (re-running is idempotent).
ENQUEUE_GAMES_PER_BATCH = 100


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Enlist a user's games as tier-1 eval_jobs for full-game evaluation."
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help="DB target: dev (localhost:5432), benchmark (localhost:5433), prod (via SSH tunnel).",
    )
    parser.add_argument(
        "--user-id",
        type=int,
        required=True,
        dest="user_id",
        help="Enlist this user's games as tier-1 eval jobs (REQUIRED).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Count games that would be enqueued; do not insert any eval_jobs rows.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Enqueue at most this many games (useful for smoke tests / staged ramps).",
    )
    return parser.parse_args()


def _build_enqueue_stmt(game_id: int, user_id: int) -> sa.Insert:
    """Idempotent tier-1 insert for one game.

    Mirrors eval_queue_service.enqueue_tier1_game: ON CONFLICT DO NOTHING on the
    active-job partial unique index (uq_eval_jobs_game_active, status IN
    ('pending','leased')). A game already in an active status is silently
    skipped; completed/failed jobs DO allow re-enqueue.
    """
    return (
        pg_insert(EvalJob)
        .values(
            tier=TIER_EXPLICIT,
            user_id=user_id,
            game_id=game_id,
            status="pending",
        )
        .on_conflict_do_nothing(
            index_elements=["game_id"],
            index_where=sa.text("status IN ('pending', 'leased')"),
        )
    )


async def run_backfill(
    *,
    db: str,
    user_id: int,
    dry_run: bool,
    limit: int | None,
    session_maker: async_sessionmaker[AsyncSession] | None = None,
) -> None:
    """Enlist `user_id`'s un-full-evald games as tier-1 eval jobs.

    Args:
        db: DB target string ("dev", "benchmark", "prod").
        user_id: Owner of the games to enqueue. REQUIRED.
        dry_run: If True, count candidate games but insert nothing.
        limit: Maximum number of games to enqueue (None = no limit).
        session_maker: Injectable session factory for testing. When None,
            a real engine is created from db_url_for_target(db).
    """
    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    _log(f"Target DB: {db}")
    _log(f"User: {user_id}")
    _log(f"Mode: {'--dry-run (no inserts)' if dry_run else 'enqueue'}")
    _log("Scope: games with full_evals_completed_at IS NULL")
    if limit:
        _log(f"Limit: {limit} games")

    # ------------------------------------------------------------------
    # Phase 1: confirm the user exists, then load candidate game IDs.
    # Scope = this user's games still missing full-game evals.
    # ------------------------------------------------------------------
    async with session_maker() as session:
        user_exists = (
            await session.execute(select(User.id).where(User.id == user_id))
        ).scalar_one_or_none()
        if user_exists is None:
            _log(f"ERROR: user {user_id} not found in the {db} database. Aborting.")
            return

        stmt = (
            select(Game.id)
            .where(Game.user_id == user_id, Game.full_evals_completed_at.is_(None))
            .order_by(Game.id)
        )
        if limit is not None:
            stmt = stmt.limit(limit)
        game_ids = list((await session.execute(stmt)).scalars().all())

    total_games = len(game_ids)
    _log(f"Games needing full evals: {total_games}")

    if total_games == 0:
        _log("Nothing to do.")
        return

    if dry_run:
        _log(f"--dry-run: would enqueue up to {total_games} tier-1 eval jobs.")
        _log("--dry-run: exiting without inserting.")
        return

    # ------------------------------------------------------------------
    # Phase 2: enqueue one tier-1 job per game, batching commits.
    # Per-game insert lets us count enqueued vs already-queued via rowcount
    # (1 = inserted, 0 = active job already existed). Sequential within a
    # session — no asyncio.gather on the same session (CLAUDE.md constraint).
    # ------------------------------------------------------------------
    total_enqueued = 0
    total_already_queued = 0

    for batch_start in range(0, total_games, ENQUEUE_GAMES_PER_BATCH):
        batch = game_ids[batch_start : batch_start + ENQUEUE_GAMES_PER_BATCH]
        batch_num = batch_start // ENQUEUE_GAMES_PER_BATCH + 1
        total_batches = (total_games + ENQUEUE_GAMES_PER_BATCH - 1) // ENQUEUE_GAMES_PER_BATCH

        async with session_maker() as session:
            batch_enqueued = 0
            for game_id_val in batch:
                result = await session.execute(_build_enqueue_stmt(game_id_val, user_id))
                inserted = (result.rowcount or 0) > 0  # ty: ignore[unresolved-attribute]  # DML result carries rowcount
                if inserted:
                    batch_enqueued += 1
                    total_enqueued += 1
                else:
                    total_already_queued += 1
            await session.commit()

        _log(
            f"Batch {batch_num}/{total_batches}: {len(batch)} games, "
            f"{batch_enqueued} newly enqueued"
        )

    _log("")
    _log("Enqueue complete:")
    _log(f"  Tier-1 jobs newly enqueued: {total_enqueued}")
    _log(f"  Already queued (skipped):   {total_already_queued}")
    _log(
        "  The drain worker will now process these with priority "
        "(full evals + flaw/tactic tagging + oracle counts)."
    )


if __name__ == "__main__":
    asyncio.run(run_backfill(**vars(_parse_args())))
