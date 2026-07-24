"""Populate opening_position_eval from our-engine game_positions evals (SEED-053).

One-time idempotent backfill. Runs a single server-side INSERT … SELECT DISTINCT ON
so Postgres does all the work — no Python row streaming.

The cache table is keyed by full_hash (BIGINT PK). This script seeds it from the
same DISTINCT ON (full_hash) self-join that _fetch_dedup_evals uses today, filtered
to our-engine evals only (full_evals_completed_at IS NOT NULL AND lichess_evals_at
IS NULL). Idempotent: ON CONFLICT (full_hash) DO NOTHING means a second run inserts
0 rows and exits 0.

See: D-123.1-06 (backfill is a standalone script, NOT the Alembic migration),
     D-123.1-03 (our-engine evals only — no benchmark DB, no lichess %eval),
     app/models/game_position.py:DEDUP_MAX_PLY (=20, shared constant, not hardcoded).

DB target host:port mapping (CLAUDE.md):
    dev:  localhost:5432  (Docker compose flawchess-dev)
    prod: localhost:15432 (via bin/prod_db_tunnel.sh)

Usage:
    uv run python scripts/backfill_opening_eval_cache.py          # dev (default)
    uv run python scripts/backfill_opening_eval_cache.py --db dev
    uv run python scripts/backfill_opening_eval_cache.py --db prod  # requires prod_db_tunnel.sh
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

import sentry_sdk
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target  # noqa: E402
from app.models.game_position import DEDUP_MAX_PLY  # noqa: E402
from app.services.eval_drain import OPENING_CACHE_BACKFILL_SQL  # noqa: E402

# Generous statement timeout for prod — the INSERT … SELECT is a ~12.9M-row
# aggregate that may run for minutes. 1 hour is a practical upper bound for
# an operator-run one-time script (T-123.1-02).
STATEMENT_TIMEOUT_MS = 3_600_000  # 1 hour


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


async def run_backfill(*, db: str) -> None:
    """Seed opening_position_eval from our-engine opening-region evals.

    Single server-side INSERT … SELECT DISTINCT ON (full_hash). Idempotent:
    ON CONFLICT (full_hash) DO NOTHING. Prints before/after row counts and
    the number of rows inserted.
    """
    url = db_url_for_target(db)
    engine = create_async_engine(url, pool_pre_ping=True)

    count_sql = text("SELECT count(*) FROM opening_position_eval")
    set_timeout_sql = text(f"SET statement_timeout = {STATEMENT_TIMEOUT_MS}")

    try:
        async with engine.begin() as conn:
            await conn.execute(set_timeout_sql)

            before_row = await conn.execute(count_sql)
            before = before_row.scalar_one()
            _log(f"opening_position_eval rows before: {before:,}")

            _log(
                f"Running INSERT … SELECT DISTINCT ON (full_hash) "
                f"with DEDUP_MAX_PLY={DEDUP_MAX_PLY} …"
            )
            result = await conn.execute(
                OPENING_CACHE_BACKFILL_SQL, {"dedup_max_ply": DEDUP_MAX_PLY}
            )
            inserted = result.rowcount
            _log(f"Rows inserted: {inserted:,}")

            after_row = await conn.execute(count_sql)
            after = after_row.scalar_one()
            _log(f"opening_position_eval rows after:  {after:,}")

    except Exception as exc:
        sentry_sdk.capture_exception(exc)
        _log(f"ERROR: {exc}")
        sys.exit(1)
    finally:
        await engine.dispose()

    _log("Done.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill opening_position_eval from our-engine game_positions evals."
    )
    parser.add_argument(
        "--db",
        choices=["dev", "prod"],
        default="dev",
        help="DB target (default: dev). prod requires bin/prod_db_tunnel.sh.",
    )
    args = parser.parse_args()
    asyncio.run(run_backfill(db=args.db))


if __name__ == "__main__":
    main()
