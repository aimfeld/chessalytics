"""Idempotent seed script: populate benchmark_cohort_cdf table from app/data/cohort_cdf.tsv.

Each row in the TSV maps directly to one row in the table (LONG layout, one row
per breakpoint). Uses INSERT ... ON CONFLICT DO UPDATE to upsert rows, making
re-runs safe: the same row count is produced on every invocation regardless of
prior state.

Runbook: a fresh production DB shows suppressed percentile chips until this
seed runs.  The lookup in the repository returns None for missing cells, which
causes the chip to be suppressed (graceful degradation -- accepted project
pattern that mirrors openings).  Run this script immediately after deploying to
a new environment or after running ``uv run alembic upgrade head`` to create the
table.

Usage (local dev):
    uv run python -m scripts.seed_cohort_cdf

Usage (production):
    The runtime image has no ``uv`` on the host -- run inside the backend
    container using the venv's Python directly:

        ssh flawchess "cd /opt/flawchess && docker compose exec backend /app/.venv/bin/python -m scripts.seed_cohort_cdf"
"""

import asyncio
import csv
import logging
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

TSV_PATH = Path(__file__).resolve().parent.parent / "app" / "data" / "cohort_cdf.tsv"

_INSERT_SQL = (
    "INSERT INTO benchmark_cohort_cdf "
    "(metric, anchor_elo, tc, percentile, value, n_users, snapshot_month) "
    "VALUES (:metric, :anchor_elo, :tc, :percentile, :value, :n_users, :snapshot_month) "
    "ON CONFLICT (metric, anchor_elo, tc, percentile) "
    "DO UPDATE SET value = EXCLUDED.value, "
    "n_users = EXCLUDED.n_users, "
    "snapshot_month = EXCLUDED.snapshot_month"
)


def _parse_row(row: dict[str, str]) -> dict[str, object]:
    """Cast TSV string fields to the correct Python types for DB binding.

    ``csv.DictReader`` yields all values as strings; PostgreSQL rejects string
    values for integer and float columns, so explicit casts are required.
    """
    n_users_raw = row.get("n_users", "")
    snapshot_month_raw = row.get("snapshot_month", "")
    return {
        "metric": row["metric"],
        "anchor_elo": int(row["anchor_elo"]),
        "tc": row["tc"],
        "percentile": int(row["percentile"]),
        "value": float(row["value"]),
        "n_users": int(n_users_raw) if n_users_raw else None,
        "snapshot_month": snapshot_month_raw if snapshot_month_raw else None,
    }


async def seed_cohort_cdf() -> int:
    """Read TSV and upsert rows into benchmark_cohort_cdf. Returns count of upserted rows."""
    engine = create_async_engine(settings.DATABASE_URL)
    async_session = async_sessionmaker(engine, expire_on_commit=False)

    inserted = 0
    errors = 0

    async with async_session() as session:
        with open(TSV_PATH, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter="\t")
            for row_num, row in enumerate(reader, start=2):
                try:
                    params = _parse_row(row)
                except (ValueError, KeyError) as exc:
                    logger.warning("Row %d: failed to parse — skipping: %s", row_num, exc)
                    errors += 1
                    continue

                result = await session.execute(text(_INSERT_SQL), params)
                if result.rowcount > 0:  # ty: ignore[unresolved-attribute]  # SQLAlchemy DML result carries rowcount
                    inserted += 1

        await session.commit()

    await engine.dispose()
    logger.info(
        "Seed complete: %d upserted, %d errors",
        inserted,
        errors,
    )
    return inserted


if __name__ == "__main__":
    asyncio.run(seed_cohort_cdf())
