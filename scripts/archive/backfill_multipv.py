"""Observe and validate the tier-4 MultiPV=2 blob-backfill rollout (Phase 145 SC1).

DESIGN — this script is a THIN observability/kickoff/dev-validate CLI.
It does NOT spin a server-local EnginePool and does NOT do the bulk MultiPV=2
compute. The bulk compute is done by the remote eval-worker fleet via the
tier-4 lottery (EVAL_AUTO_DRAIN_ENABLED=true on prod) and the dedicated
flaw-blob lease/submit endpoints added in Plans 02–04 of Phase 145.

SC1 reconciliation: the earlier CONTEXT.md wording said "module-level EnginePool
is reused" — that referred to the live drain's shared pool, not this script.
This script has no EnginePool at all (D-01: the fleet does the compute). The
lone server-side role here is observability (--status / --dry-run) and
end-to-end dev validation (--dev-validate) of the service functions that already
exist in app/services/eval_queue_service.py and app/services/eval_drain.py.

Modes
-----
--status     Print how many game/flaw rows still have allowed_pv_lines IS NULL,
             with an engine-vs-lichess split. This is the drain-progress monitor.
--dry-run    Report how many games/flaws are eligible for the tier-4 lottery
             (analyzed, non-guest) without writing anything to the DB.
--dev-validate
             Drive the full tier-4 lottery → flaw-blob lease → blob assembly →
             write → retag pipeline end-to-end against the dev DB, then assert
             idempotency (the selected game leaves the IS NULL predicate).
             Only valid with --db dev.  Requires the dev DB to be running
             (docker compose -f docker-compose.dev.yml -p flawchess-dev up -d).

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

Usage
-----
    uv run python scripts/backfill_multipv.py --db dev --status
    uv run python scripts/backfill_multipv.py --db prod --status
    uv run python scripts/backfill_multipv.py --db dev --dry-run
    uv run python scripts/backfill_multipv.py --db dev --dev-validate
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Callable, Coroutine
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.game import Game  # noqa: E402
from app.models.game_flaw import GameFlaw  # noqa: E402
from app.schemas.eval_remote import FlawBlobSubmitEval  # noqa: E402
from app.services.eval_apply import _batch_update_flaw_pv_lines  # noqa: E402
from app.services.eval_drain import (  # noqa: E402
    _assemble_flaw_blobs_from_submit,
    _build_flaw_blob_lease_positions,
)
from app.services.eval_queue_service import _claim_tier4_blob  # noqa: E402

# Register FK-referenced tables so SQLAlchemy resolves the relationship chain
# without raising NoReferencedTableError when Game / GameFlaw are used in
# select() statements within this script.
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402, F401


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Observe and validate the Phase 145 MultiPV=2 blob-backfill rollout. "
            "The bulk compute is done by the remote eval-worker fleet (D-01) — "
            "this script provides observability (--status / --dry-run) and "
            "end-to-end dev validation (--dev-validate) only."
        )
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help="DB target: dev (localhost:5432), benchmark (localhost:5433), prod (SSH tunnel).",
    )

    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--status",
        action="store_true",
        help=(
            "Print the number of games and flaws still missing blobs "
            "(allowed_pv_lines IS NULL), with an engine-vs-lichess split. "
            "Read-only."
        ),
    )
    mode.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help=(
            "Report how many games and flaws are eligible for the tier-4 lottery "
            "(analyzed + non-guest) without writing anything to the DB."
        ),
    )
    mode.add_argument(
        "--dev-validate",
        action="store_true",
        dest="dev_validate",
        help=(
            "Run the full tier-4 lottery → lease → blob-assembly → write → retag "
            "pipeline end-to-end against the dev DB and assert idempotency. "
            "Only valid with --db dev."
        ),
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Progress-query helpers (read-only)
# ---------------------------------------------------------------------------

# Type alias for the injectable session factory
SessionMaker = async_sessionmaker[AsyncSession]
# Type alias for the injectable lease builder (enables testing without global session)
LeaseBuilder = Callable[[int], Coroutine[Any, Any, tuple[list[Any], set[tuple[int, str]]]]]


async def _query_status(session: AsyncSession) -> dict[str, Any]:
    """Return overall and per-source NULL-blob counts.

    Queries all game_flaws rows where allowed_pv_lines IS NULL, joining games
    for the lichess_evals_at split (engine-sourced vs. lichess-%eval games).
    This is the raw observability count — not filtered to analyzed/non-guest games.

    Returns a dict with keys:
        total_games, total_flaws,
        engine_games, engine_flaws,
        lichess_games, lichess_flaws.
    """
    # Overall totals (no join needed — faster on large tables)
    overall = await session.execute(
        sa.select(
            sa.func.count(sa.distinct(GameFlaw.game_id)).label("total_games"),
            sa.func.count().label("total_flaws"),
        ).where(GameFlaw.allowed_pv_lines.is_(None))
    )
    row = overall.one()
    total_games: int = row.total_games
    total_flaws: int = row.total_flaws

    # Per-source split (lichess_evals_at IS NOT NULL → lichess-sourced game)
    split_stmt = (
        sa.select(
            sa.case(
                (Game.lichess_evals_at.isnot(None), "lichess"),
                else_="engine",
            ).label("source"),
            sa.func.count(sa.distinct(GameFlaw.game_id)).label("games"),
            sa.func.count().label("flaws"),
        )
        .join(Game, Game.id == GameFlaw.game_id)
        .where(GameFlaw.allowed_pv_lines.is_(None))
        .group_by("source")
    )
    split_rows = (await session.execute(split_stmt)).all()

    engine_games = engine_flaws = lichess_games = lichess_flaws = 0
    for source, games, flaws in split_rows:
        if source == "engine":
            engine_games = games
            engine_flaws = flaws
        else:
            lichess_games = games
            lichess_flaws = flaws

    return {
        "total_games": total_games,
        "total_flaws": total_flaws,
        "engine_games": engine_games,
        "engine_flaws": engine_flaws,
        "lichess_games": lichess_games,
        "lichess_flaws": lichess_flaws,
    }


async def _query_eligible(session: AsyncSession) -> dict[str, int]:
    """Return the tier-4-eligible count: analyzed non-guest games with NULL blobs.

    Mirrors the WHERE clause of _claim_tier4_blob exactly (full_evals_completed_at
    IS NOT NULL + is_guest = false) so --dry-run gives the same count that the
    tier-4 lottery draws from.
    """
    result = await session.execute(
        sa.select(
            sa.func.count(sa.distinct(GameFlaw.game_id)).label("games"),
            sa.func.count().label("flaws"),
        )
        .join(Game, Game.id == GameFlaw.game_id)
        .join(User, User.id == Game.user_id)
        .where(
            GameFlaw.allowed_pv_lines.is_(None),
            Game.full_evals_completed_at.isnot(None),
            User.is_guest.is_(False),
        )
    )
    row = result.one()
    return {"games": row.games, "flaws": row.flaws}


# ---------------------------------------------------------------------------
# Top-level runners (injectable session_maker for testability)
# ---------------------------------------------------------------------------


async def run_status(
    *,
    db: str,
    session_maker: SessionMaker | None = None,
) -> None:
    """Print the NULL-blob progress counts to stdout. Read-only."""
    if settings.SENTRY_DSN:
        import sentry_sdk

        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    _log(f"Target DB: {db}")
    _log("Mode: --status (read-only)")
    _log("Predicate: game_flaws.allowed_pv_lines IS NULL")
    _log("")

    async with session_maker() as session:
        counts = await _query_status(session)

    _log("Backfill progress (flaws still needing blobs):")
    _log(f"  Total games remaining : {counts['total_games']:,}")
    _log(f"  Total flaws remaining : {counts['total_flaws']:,}")
    _log("")
    _log("  By eval source:")
    _log(
        f"    Engine games         : {counts['engine_games']:,}  ({counts['engine_flaws']:,} flaws)"
    )
    _log(
        f"    Lichess %%eval games  : {counts['lichess_games']:,}  ({counts['lichess_flaws']:,} flaws)"
    )
    _log("")
    if counts["total_flaws"] == 0:
        _log("Backfill complete — no flaws remaining with allowed_pv_lines IS NULL.")
    else:
        _log(
            "Backfill in progress — tier-4 lottery fills blobs as remote workers are idle. "
            "Ensure EVAL_AUTO_DRAIN_ENABLED=true on the target backend."
        )


async def run_dry_run(
    *,
    db: str,
    session_maker: SessionMaker | None = None,
) -> None:
    """Report how many games/flaws the tier-4 lottery would process. No DB writes."""
    if settings.SENTRY_DSN:
        import sentry_sdk

        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    _log(f"Target DB: {db}")
    _log("Mode: --dry-run (no writes)")
    _log("Scope: analyzed non-guest games (tier-4 lottery eligible)")
    _log("")

    async with session_maker() as session:
        eligible = await _query_eligible(session)

    _log("Tier-4-eligible backfill scope:")
    _log(f"  Games with NULL blobs : {eligible['games']:,}")
    _log(f"  Flaws with NULL blobs : {eligible['flaws']:,}")
    _log("")
    if eligible["flaws"] == 0:
        _log("--dry-run: nothing to backfill in the tier-4-eligible scope.")
    else:
        _log(
            f"--dry-run: {eligible['flaws']:,} flaw rows across {eligible['games']:,} games "
            "would receive blobs. Enable EVAL_AUTO_DRAIN_ENABLED=true for the fleet to fill them."
        )


async def run_dev_validate(
    *,
    db: str,
    session_maker: SessionMaker | None = None,
    lease_builder: LeaseBuilder | None = None,
) -> None:
    """Drive the tier-4 lottery → lease → blob-write → retag loop on the dev DB.

    This is an end-to-end integration validator for the Plan 02/03/04 service
    functions. It picks one game from the tier-4 lottery, builds the lease, constructs
    synthetic evals (all cp=0, no second-best — placeholder values that exercise the
    write path without engine involvement), writes the resulting blobs, and asserts
    idempotency.

    Only valid against --db dev (explicitly checked below). The lease builder
    (_build_flaw_blob_lease_positions) uses the app's global async_session_maker
    which reads DATABASE_URL from the environment — this should be the dev DB when
    running locally (the default).

    No engine is invoked at any point (D-01: the fleet does the compute). Synthetic
    evals exercise the write path; the resulting blobs contain placeholder PvNode
    values only.

    Args:
        db: Must be "dev".
        session_maker: Injectable session factory (test override). When None,
            created from db_url_for_target(db).
        lease_builder: Injectable lease builder (test override). When None,
            defaults to _build_flaw_blob_lease_positions.
    """
    if db != "dev":
        _log(f"ERROR: --dev-validate only targets --db dev (got --db {db}). Aborting.")
        sys.exit(1)

    if settings.SENTRY_DSN:
        import sentry_sdk

        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    if lease_builder is None:
        lease_builder = _build_flaw_blob_lease_positions

    _log(f"Target DB: {db}")
    _log("Mode: --dev-validate (end-to-end pipeline check)")
    _log("")

    # ── Step 1: Tier-4 pick ──────────────────────────────────────────────────
    async with session_maker() as session:
        blob_pick = await _claim_tier4_blob(session)

    if blob_pick is None:
        _log("No games eligible for tier-4 backfill on dev DB.")
        _log("--dev-validate: nothing to validate (empty queue). PASS (trivially).")
        return

    game_id, user_id = blob_pick
    _log(f"Tier-4 pick: game_id={game_id}, user_id={user_id}")

    # ── Step 2: Build lease positions ────────────────────────────────────────
    # _build_flaw_blob_lease_positions uses the app's global async_session_maker.
    # For dev-validate this must match the dev DB (DATABASE_URL in env).
    _log("Building flaw-blob lease positions …")
    lease_positions, sentinel_lines = await lease_builder(game_id)

    _log(f"  Walkable positions : {len(lease_positions)}")
    _log(f"  Sentinel lines     : {len(sentinel_lines)}")

    # ── Step 3: Build synthetic evals (no engine) ────────────────────────────
    # Each token gets a placeholder eval (cp=0, no second-best). This exercises
    # the full blob-assembly write path without a real Stockfish process (D-01).
    # The resulting blobs are valid PvNode lists but carry placeholder values.
    synthetic_evals = [
        FlawBlobSubmitEval(
            token=pos.token,
            best_cp=0,
            best_mate=None,
            second_cp=None,
            second_mate=None,
            second_uci=None,
        )
        for pos in lease_positions
    ]
    _log(f"  Synthetic evals    : {len(synthetic_evals)} (placeholder cp=0, no engine)")

    # ── Step 4: Assemble blob_map (pure CPU) ─────────────────────────────────
    blob_map = _assemble_flaw_blobs_from_submit(game_id, synthetic_evals, sentinel_lines)
    _log(f"  Blob map size      : {len(blob_map)} flaw plies")

    # ── Step 5: Write blobs ──────────────────────────────────────────────────
    _log("Writing blobs to dev DB …")
    async with session_maker() as write_session:
        await _batch_update_flaw_pv_lines(write_session, game_id, blob_map)
        await write_session.commit()
    _log("  Blobs written and committed.")

    # ── Step 6: Idempotency assertion ────────────────────────────────────────
    _log("Verifying idempotency (game must leave the IS NULL predicate) …")
    async with session_maker() as check_session:
        remaining = await check_session.scalar(
            sa.select(sa.func.count())
            .select_from(GameFlaw)
            .where(
                GameFlaw.game_id == game_id,
                GameFlaw.allowed_pv_lines.is_(None),
            )
        )

    if remaining != 0:
        _log(
            f"FAIL: game_id={game_id} still has {remaining} flaw row(s) with "
            "allowed_pv_lines IS NULL after write. Expected 0."
        )
        sys.exit(1)

    _log(f"  game_id={game_id}: 0 NULL-blob flaws remaining. Idempotency: PASS.")
    _log("")
    _log("--dev-validate: PASS. Full tier-4 lottery → lease → write pipeline verified.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _main() -> None:
    args = _parse_args()
    if args.status:
        asyncio.run(run_status(db=args.db))
    elif args.dry_run:
        asyncio.run(run_dry_run(db=args.db))
    elif args.dev_validate:
        asyncio.run(run_dev_validate(db=args.db))


if __name__ == "__main__":
    _main()
