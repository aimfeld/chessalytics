"""SEED-145 Stage B full-study sampler (E-07: 5,000 games/cell).

Extends the Gate 0 sampler machinery (shared SQL + FEN reconstruction via the
app's own _snapshot_boards) to the full study frame: up to 5,000 games per
ELO x TC cell across the 20 cells, dedup by (platform, platform_game_id),
BOTH boundaries per game (E-13). Thin cells (classical x 800/2400) simply take
everything and are reported as low-N.

Manifest row = Gate 0 row shape PLUS the Stage B additions (E-10):

  - move_san           — the human's actual next move (row P stores the
                         PRE-push position and the SAN of move P);
  - oppo_clock_seconds — the row's clock_seconds belongs to the row's
                         side_to_move (mover's clock after their move); the
                         opponent's clock is the PREVIOUS ply's clock_seconds
                         (gate0_null_baselines.py clock semantics);
  - material_white     — white-POV material balance in pawn units (E-14
                         null-logistic feature, precomputed so the refit
                         script reuses gate0's feature_matrix verbatim).

Games are fetched in batches (entry rows + prev clocks + PGNs per batch) so
~100k PGNs never sit in memory at once. Output is one NDJSON manifest; the
sweep (stage_b_sweep.mjs) reads it directly (or a .gz copy on a machine
without the benchmark DB).

Usage:
    bin/benchmark_db.sh start
    uv run python scripts/engine_disagreement_study/stage_b_sample.py --db benchmark
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import db_url_for_target  # noqa: E402
from gate0_null_baselines import PREV_CLOCK_SQL, material_balance_white  # noqa: E402
from sample_gate0_positions import (  # noqa: E402
    ELO_BUCKET_MAX_CENTER,
    ELO_BUCKET_MIN_CENTER,
    ELO_BUCKET_WIDTH,
    ENTRY_ROWS_SQL,
    GAME_SELECT_SQL,
    MAX_RATING_GAP,
    PGN_SQL,
    PHASE_ENDGAME,
    PHASE_MIDDLEGAME,
    _build_rows,
)

# E-07: user-approved at the Gate 0 checkpoint (no trim, no FC-only subset).
DEFAULT_GAMES_PER_CELL = 5000
DEFAULT_SEED = "seed145-stage-b"
DEFAULT_OUT = "scripts/engine_disagreement_study/data/stage_b_manifest.ndjson"
# Games per DB round-trip during the entry-rows/clocks/PGN fetch loop.
BATCH_GAMES = 2000
PROGRESS_EVERY_GAMES = 2000


def _log(msg: str) -> None:
    print(f"[stage-b-sampler] {msg}", flush=True)


async def fetch_batch(conn: Any, games: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Entry rows + prev-ply clocks + PGNs for one batch of games -> manifest rows."""
    ids = [g["id"] for g in games]
    entry_rows = [
        dict(r)
        for r in (
            await conn.execute(
                text(ENTRY_ROWS_SQL),
                {"ids": ids, "phase_mg": PHASE_MIDDLEGAME, "phase_eg": PHASE_ENDGAME},
            )
        ).mappings()
    ]
    prev_pairs = [(r["game_id"], r["ply"] - 1) for r in entry_rows if r["ply"] > 0]
    prev_clocks = {
        (r["game_id"], r["ply"]): r["clock_seconds"]
        for r in (
            await conn.execute(
                text(PREV_CLOCK_SQL),
                {"ids": [p[0] for p in prev_pairs], "plies": [p[1] for p in prev_pairs]},
            )
        ).mappings()
    }
    pgns = {r["id"]: r["pgn"] for r in (await conn.execute(text(PGN_SQL), {"ids": ids})).mappings()}

    entries_by_game: dict[int, list[dict[str, Any]]] = {}
    for row in entry_rows:
        entries_by_game.setdefault(row["game_id"], []).append(row)

    out: list[dict[str, Any]] = []
    for game in games:
        entries = entries_by_game.get(game["id"], [])
        pgn = pgns.get(game["id"])
        if pgn is None or not entries:
            continue
        for row in _build_rows(game, entries, pgn):
            row["oppo_clock_seconds"] = prev_clocks.get((row["game_id"], row["ply"] - 1))
            row["material_white"] = material_balance_white(row["fen"])
            out.append(row)
    return out


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="benchmark", choices=["benchmark", "dev"])
    parser.add_argument("--games-per-cell", type=int, default=DEFAULT_GAMES_PER_CELL)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".tmp")

    rows_written = 0
    boundary_counts: Counter[str] = Counter()
    cell_game_counts: Counter[tuple[str, int]] = Counter()

    engine = create_async_engine(db_url_for_target(args.db))
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET TRANSACTION READ ONLY"))
            _log(f"selecting up to {args.games_per_cell} games/cell (seed={args.seed!r})...")
            games = [
                dict(r)
                for r in (
                    await conn.execute(
                        text(GAME_SELECT_SQL),
                        {
                            "max_gap": MAX_RATING_GAP,
                            "min_center": ELO_BUCKET_MIN_CENTER,
                            "width": ELO_BUCKET_WIDTH,
                            "origin": ELO_BUCKET_MIN_CENTER - ELO_BUCKET_WIDTH // 2,
                            "max_index": (ELO_BUCKET_MAX_CENTER - ELO_BUCKET_MIN_CENTER)
                            // ELO_BUCKET_WIDTH,
                            "seed": args.seed,
                            "games_per_cell": args.games_per_cell,
                            "lichess_only": False,
                        },
                    )
                ).mappings()
            ]
            for g in games:
                cell_game_counts[(g["tc"], g["elo_bucket"])] += 1
            _log(f"{len(games)} games selected across {len(cell_game_counts)} cells")
            for (tc, elo), n in sorted(cell_game_counts.items()):
                low = "  <-- LOW-N (thin cell, takes everything)" if n < args.games_per_cell else ""
                _log(f"  cell {tc} x {elo}: {n} games{low}")

            started = time.monotonic()
            with tmp_path.open("w", encoding="utf-8") as fh:
                for batch_start in range(0, len(games), BATCH_GAMES):
                    batch = games[batch_start : batch_start + BATCH_GAMES]
                    for row in await fetch_batch(conn, batch):
                        fh.write(json.dumps(row) + "\n")
                        rows_written += 1
                        boundary_counts[row["boundary"]] += 1
                    done = min(batch_start + BATCH_GAMES, len(games))
                    if done % PROGRESS_EVERY_GAMES == 0 or done == len(games):
                        elapsed = time.monotonic() - started
                        rate = done / elapsed if elapsed > 0 else 0.0
                        eta_s = (len(games) - done) / rate if rate > 0 else 0.0
                        _log(
                            f"{done}/{len(games)} games ({rate:.0f}/s, ETA {eta_s / 60:.1f} min, "
                            f"{rows_written} rows)"
                        )
    finally:
        await engine.dispose()

    tmp_path.replace(out_path)
    _log(
        f"done: {rows_written} rows -> {out_path} "
        f"(middlegame={boundary_counts['middlegame']}, endgame={boundary_counts['endgame']})"
    )


if __name__ == "__main__":
    asyncio.run(main())
