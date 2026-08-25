r"""SEED-145 Stage B repair — provenance-aware aligned Stockfish eval.

`game_positions.eval_cp` has TWO populations with OPPOSITE ply conventions, and
conflating them is worse than doing nothing:

  * **lichess %evals** (`games.lichess_evals_at IS NOT NULL`) are POST-MOVE:
    row P holds the eval of the position AFTER the move played at ply P. See
    `app/models/game.py:243` and `library_repository.py:2431`. For these, the
    eval of the sampler's `fen[P]` (pre-push) lives on row **P-1**.
  * **entry-lane evals** (`app/services/eval_entry.py`, everything else) are
    ALIGNED: the lane snapshots the board with `_snapshot_boards` (pre-push),
    evaluates THAT position, and writes it at the SAME ply. For these, row P is
    already the eval of `fen[P]` and must be left alone.

Measured 2026-08-24, fresh Stockfish depth 16 on `fen[P]`, 150 rows per
population from the Stage B ledgers:

  | population | median \|fresh - eval_cp[P]\| | median \|fresh - eval_cp[P-1]\| |
  |---|---|---|
  | entry-lane | 7.0 cp (aligned)  | n/a |
  | lichess    | 26.5 cp           | 13.0 cp (aligned) |

Stage B is 72.2% entry-lane / 27.8% lichess, so a blanket ply-1 shift would
CORRUPT most of the frame. SEED-153's D-06 frame is the mirror image (99.29%
lichess), which is why the blanket shift was correct there.

This script does NOT re-run any engine. The expensive arms (Maia value head,
FlawChess mctsSearch @100) read `row.fen` directly and are correct already —
140,658 of them sit in the Stage B ledgers untouched. Only the lichess subset's
Stockfish arm needs the previous row's eval, which this writes to an NDJSON
keyed by (game_id, ply) carrying the provenance flag so the analysis can pick
the right column per row.

Usage:
    bin/benchmark_db.sh start
    uv run python scripts/engine_disagreement_study/seed145_repair_aligned_evals.py --db benchmark
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
LEDGER_GLOB = "stage_b_ledger-worker-*.ndjson"
OUT_PATH = DATA_DIR / "stage_b_aligned_evals.ndjson"

# Rows per DB round-trip. The lookup is a two-column IN over a composite key,
# so keep batches modest to stay inside the planner's comfort zone.
BATCH_ROWS = 5_000

# The aligned eval for fen[P] lives on the row at ply - 1. unnest keeps this a
# single indexed lookup per batch rather than 5,000 OR'd predicates.
ALIGNED_EVAL_SQL = """
SELECT gp.game_id, gp.ply, gp.eval_cp, gp.eval_mate
FROM game_positions gp
JOIN unnest(CAST(:game_ids AS bigint[]), CAST(:plies AS int[])) AS t(game_id, ply)
  ON gp.game_id = t.game_id AND gp.ply = t.ply
"""

# Provenance: which games carry lichess %evals (post-move) rather than
# entry-lane evals (aligned). This is what decides the per-row repair.
PROVENANCE_SQL = """
SELECT id, (lichess_evals_at IS NOT NULL) AS lichess_sourced
FROM games WHERE id = ANY(:ids)
"""


def _log(msg: str) -> None:
    print(f"[seed145-repair] {msg}", flush=True)


def load_ledger_keys() -> list[tuple[int, int]]:
    """Unique (game_id, ply) over every Stage B ledger shard, errors excluded."""
    seen: set[tuple[int, int]] = set()
    shards = sorted(DATA_DIR.glob(LEDGER_GLOB))
    if not shards:
        raise SystemExit(f"no Stage B ledger shards matching {LEDGER_GLOB} in {DATA_DIR}")
    for shard in shards:
        with shard.open(encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue  # truncated tail line from a crash mid-append
                if row.get("error"):
                    continue
                seen.add((row["game_id"], row["ply"]))
    _log(f"{len(shards)} shards -> {len(seen):,} unique (game_id, ply)")
    return sorted(seen)


async def fetch_aligned(db: str, keys: list[tuple[int, int]]) -> list[dict[str, Any]]:
    engine = create_async_engine(db_url_for_target(db))
    out: list[dict[str, Any]] = []
    started = time.monotonic()
    try:
        async with engine.connect() as conn:
            prov_result = await conn.execute(
                text(PROVENANCE_SQL), {"ids": sorted({g for g, _ in keys})}
            )
            lichess: dict[int, bool] = {
                r["id"]: bool(r["lichess_sourced"]) for r in prov_result.mappings()
            }
            n_lich = sum(1 for v in lichess.values() if v)
            _log(
                f"provenance: {n_lich:,} lichess-sourced games (post-move, need ply-1), "
                f"{len(lichess) - n_lich:,} entry-lane (already aligned)"
            )
            for start in range(0, len(keys), BATCH_ROWS):
                batch = keys[start : start + BATCH_ROWS]
                # ply - 1: the row carrying the eval of the position at `ply`.
                result = await conn.execute(
                    text(ALIGNED_EVAL_SQL),
                    {
                        "game_ids": [g for g, _ in batch],
                        "plies": [p - 1 for _, p in batch],
                    },
                )
                by_key = {(r["game_id"], r["ply"]): r for r in result.mappings()}
                for game_id, ply in batch:
                    found = by_key.get((game_id, ply - 1))
                    if found is None:
                        continue  # no eval on the previous row — dropped at analysis time
                    out.append(
                        {
                            "game_id": game_id,
                            "ply": ply,
                            "lichess_sourced": lichess.get(game_id, False),
                            "prev_eval_cp": found["eval_cp"],
                            "prev_eval_mate": found["eval_mate"],
                        }
                    )
                done = min(start + BATCH_ROWS, len(keys))
                elapsed = time.monotonic() - started
                rate = done / elapsed if elapsed else 0
                eta = (len(keys) - done) / rate if rate else 0
                _log(
                    f"{done:,}/{len(keys):,} ({done / len(keys):.1%}), "
                    f"{rate:,.0f} keys/s, ETA {eta / 60:.1f} min"
                )
    finally:
        await engine.dispose()
    return out


async def main_async() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="benchmark", choices=["benchmark", "dev"])
    args = parser.parse_args()

    keys = load_ledger_keys()
    at_ply_zero = sum(1 for _, ply in keys if ply == 0)
    if at_ply_zero:
        _log(f"WARNING: {at_ply_zero} rows at ply 0 have no previous row and will be dropped")

    rows = await fetch_aligned(args.db, keys)
    with OUT_PATH.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")

    lich_rows = [r for r in rows if r["lichess_sourced"]]
    repairable = sum(
        1 for r in lich_rows if r["prev_eval_cp"] is not None or r["prev_eval_mate"] is not None
    )
    _log(
        f"wrote {len(rows):,}/{len(keys):,} rows -> {OUT_PATH}\n"
        f"    lichess-sourced (need repair): {len(lich_rows):,}, "
        f"of which {repairable:,} have a usable ply-1 eval ({repairable / max(len(lich_rows), 1):.1%})\n"
        f"    entry-lane (already aligned, left alone): {len(rows) - len(lich_rows):,}"
    )


if __name__ == "__main__":
    asyncio.run(main_async())
