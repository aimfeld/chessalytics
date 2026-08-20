"""SEED-145 Stage B ledger loader (E-10 storage).

Reads all sweep ledger shards (stage_b_ledger-worker-*.ndjson) and bulk-loads
them into a script-managed `seed145_entry_predictions` table in the benchmark
DB — plain CREATE TABLE, NO Alembic (the benchmark DB shares prod's migration
history; a benchmark-only migration would fork the head). The table joins
against games/game_positions for Stage C analysis and is readable via the
read-only MCP (init-benchmark-db.sql's FOR ROLE default privileges grant
SELECT on app-user-created tables automatically).

Idempotent full reload: DROP TABLE IF EXISTS + CREATE + insert everything.
Rows are deduped by (game_id, boundary) across shards (first wins); rows the
sweep ledgered with an error keep their identity/outcome fields, NULL arm
outputs, and the error message — Stage C filters `error IS NULL`.

Usage:
    bin/benchmark_db.sh start
    uv run python scripts/seed145/stage_b_load.py --db benchmark
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import db_url_for_target  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"
SHARD_GLOB = "stage_b_ledger-worker-*.ndjson"
TABLE = "seed145_entry_predictions"
INSERT_BATCH = 1000

# Script-managed DDL (E-10) — same territory as deploy/init-benchmark-db.sql.
CREATE_SQL = f"""
CREATE TABLE {TABLE} (
    game_id            integer          NOT NULL,
    boundary           text             NOT NULL CHECK (boundary IN ('middlegame', 'endgame')),
    platform           text             NOT NULL,
    platform_game_id   text             NOT NULL,
    tc                 text             NOT NULL,
    elo_bucket         smallint         NOT NULL,
    white_rating       smallint         NOT NULL,
    black_rating       smallint         NOT NULL,
    termination        text,
    flagged            boolean          NOT NULL,
    result             text             NOT NULL,
    white_score        real             NOT NULL,
    ply                smallint         NOT NULL,
    side_to_move       text             NOT NULL CHECK (side_to_move IN ('w', 'b')),
    fen                text             NOT NULL,
    eval_cp            smallint,
    eval_mate          smallint,
    endgame_class      smallint,
    clock_seconds      real,
    oppo_clock_seconds real,
    move_san           text,
    material_white     smallint,
    fc_node_budget     smallint,
    maia_score_stm     double precision,
    maia_score_white   double precision,
    maia_win_stm       double precision,
    maia_draw_stm      double precision,
    maia_loss_stm      double precision,
    maia_ms            integer,
    fc_score_stm       double precision,
    fc_score_white     double precision,
    fc_top_move        text,
    fc_nodes_evaluated integer,
    fc_stop_reason     text,
    fc_ms              integer,
    error              text,
    PRIMARY KEY (game_id, boundary)
)
"""

INDEX_SQL = [
    f"CREATE INDEX ix_{TABLE}_cell ON {TABLE} (boundary, tc, elo_bucket)",
]

COLUMNS = [
    "game_id",
    "boundary",
    "platform",
    "platform_game_id",
    "tc",
    "elo_bucket",
    "white_rating",
    "black_rating",
    "termination",
    "flagged",
    "result",
    "white_score",
    "ply",
    "side_to_move",
    "fen",
    "eval_cp",
    "eval_mate",
    "endgame_class",
    "clock_seconds",
    "oppo_clock_seconds",
    "move_san",
    "material_white",
    "fc_node_budget",
    "maia_score_stm",
    "maia_score_white",
    "maia_win_stm",
    "maia_draw_stm",
    "maia_loss_stm",
    "maia_ms",
    "fc_score_stm",
    "fc_score_white",
    "fc_top_move",
    "fc_nodes_evaluated",
    "fc_stop_reason",
    "fc_ms",
    "error",
]

INSERT_SQL = text(
    f"INSERT INTO {TABLE} ({', '.join(COLUMNS)}) VALUES ({', '.join(':' + c for c in COLUMNS)})"
)

SUMMARY_SQL = f"""
SELECT boundary, tc, elo_bucket,
       count(*) AS n_rows,
       count(*) FILTER (WHERE error IS NOT NULL) AS n_errors
FROM {TABLE}
GROUP BY boundary, tc, elo_bucket
ORDER BY boundary, tc, elo_bucket
"""


def _log(msg: str) -> None:
    print(f"[stage-b-loader] {msg}", flush=True)


def read_shards() -> tuple[list[dict[str, Any]], int, int]:
    """All shard rows deduped by (game_id, boundary); returns (rows, dupes, truncated)."""
    shard_files = sorted(DATA_DIR.glob(SHARD_GLOB))
    if not shard_files:
        raise SystemExit(f"no shard files matching {SHARD_GLOB} in {DATA_DIR}")
    seen: set[tuple[int, str]] = set()
    rows: list[dict[str, Any]] = []
    dupes = 0
    truncated = 0
    for shard in shard_files:
        with shard.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    truncated += 1  # crash mid-append tail line — the sweep re-ran that unit
                    continue
                key = (raw["game_id"], raw["boundary"])
                if key in seen:
                    dupes += 1
                    continue
                seen.add(key)
                rows.append({c: raw.get(c) for c in COLUMNS})
    _log(
        f"{len(rows)} unique rows from {len(shard_files)} shards ({dupes} dupes, {truncated} truncated lines)"
    )
    return rows, dupes, truncated


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="benchmark", choices=["benchmark", "dev"])
    args = parser.parse_args()

    rows, _, _ = read_shards()

    engine = create_async_engine(db_url_for_target(args.db))
    started = time.monotonic()
    try:
        async with engine.begin() as conn:
            _log(f"recreating {TABLE}...")
            await conn.execute(text(f"DROP TABLE IF EXISTS {TABLE}"))
            await conn.execute(text(CREATE_SQL))
            for ddl in INDEX_SQL:
                await conn.execute(text(ddl))
            for i in range(0, len(rows), INSERT_BATCH):
                await conn.execute(INSERT_SQL, rows[i : i + INSERT_BATCH])
                done = min(i + INSERT_BATCH, len(rows))
                if done % 20000 == 0 or done == len(rows):
                    _log(f"inserted {done}/{len(rows)}")
        async with engine.connect() as conn:
            summary = (await conn.execute(text(SUMMARY_SQL))).mappings().all()
            total = (await conn.execute(text(f"SELECT count(*) AS n FROM {TABLE}"))).scalar_one()
    finally:
        await engine.dispose()

    print(f"\n=== {TABLE} loaded: {total} rows in {time.monotonic() - started:.1f}s ===")
    print(f"{'boundary':<12} {'tc':<10} {'elo':>5} {'rows':>7} {'errors':>7}")
    for r in summary:
        print(
            f"{r['boundary']:<12} {r['tc']:<10} {r['elo_bucket']:>5} {r['n_rows']:>7} {r['n_errors']:>7}"
        )


if __name__ == "__main__":
    asyncio.run(main())
