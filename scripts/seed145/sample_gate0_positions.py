"""SEED-145 Gate 0 position sampler.

Draws a small stratified sample of games from the benchmark DB (one per-cell
quota across the 20 ELO x TC cells), reconstructs the FEN at each game's phase
boundaries (middlegame entry = MIN(ply) WHERE phase=1, endgame entry =
MIN(ply) WHERE phase=2), and writes one NDJSON manifest row per (game,
boundary) with the stored entry eval and outcome metadata.

The manifest feeds Gate 0's remaining items (FC node-budget convergence, FC
cost measurement, SF-vs-Maia disagreement probe, quick-scan vs lichess eval
cross-check). Deterministic given the DB contents: games are ranked per cell
by md5(id || seed), and FEN reconstruction reuses the app's own
_snapshot_boards (0-indexed, pre-push ply semantics — the exact function the
entry-eval lane used to place the evals we read back).

Usage:
    bin/benchmark_db.sh start
    uv run python scripts/seed145/sample_gate0_positions.py --db benchmark
    uv run python scripts/seed145/sample_gate0_positions.py --db benchmark \
        --games-per-cell 40 --out scripts/seed145/data/gate0_manifest.ndjson

--lichess-only (Gate 0 quick-scan vs lichess cross-check, E-09): restricts the
frame to games whose entry-ply evals came from LICHESS server analysis
(games.lichess_evals_at IS NOT NULL — those rows are preserved, never
overwritten by our quick-scan, T-78-17), writes to a separate manifest, and
defaults to a smaller per-cell quota (~300 rows total). The manifest rows'
eval_cp/eval_mate are then the STORED LICHESS evals, which the cross-check
script compares against our own depth-15 run on the same FENs.
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
from app.services.eval_entry import _snapshot_boards  # noqa: E402

DEFAULT_GAMES_PER_CELL = 40
DEFAULT_SEED = "seed145-gate0"
DEFAULT_OUT = "scripts/seed145/data/gate0_manifest.ndjson"
# --lichess-only defaults: ~10 games/cell x 20 cells x ~1.7 boundaries/game
# yields the ~300 entry positions the E-09 cross-check needs.
LICHESS_ONLY_GAMES_PER_CELL = 10
LICHESS_ONLY_OUT = "scripts/seed145/data/gate0_lichess_manifest.ndjson"
# Print a progress line every this many games during FEN reconstruction.
PROGRESS_EVERY_GAMES = 100

# E-04: equal-footing cohort, same convention as the two-pawns-up story (v2).
MAX_RATING_GAP = 100
# 400-wide ELO buckets anchored at centers 800..2400, on the mean of both ratings.
ELO_BUCKET_WIDTH = 400
ELO_BUCKET_MIN_CENTER = 800
ELO_BUCKET_MAX_CENTER = 2400

# game_positions.phase values (Lichess Divider classification).
PHASE_MIDDLEGAME = 1
PHASE_ENDGAME = 2
BOUNDARY_NAME = {PHASE_MIDDLEGAME: "middlegame", PHASE_ENDGAME: "endgame"}

# E-05 headline basis excludes these terminations (analysis-time filter; the
# sample itself deliberately includes them).
FLAGGED_TERMINATIONS = ("timeout", "abandoned", "unknown")

WHITE_SCORE = {"1-0": 1.0, "0-1": 0.0, "1/2-1/2": 0.5}

# Deterministic per-cell ranking + dedup. DISTINCT ON collapses the same
# platform game imported by two benchmark users (seed Trap: duplicate games).
GAME_SELECT_SQL = """
WITH dedup AS (
    SELECT DISTINCT ON (platform, platform_game_id)
        id, platform, platform_game_id, time_control_bucket AS tc,
        white_rating, black_rating, termination::text AS termination,
        result::text AS result
    FROM games
    WHERE rated
      AND NOT is_computer_game
      AND white_rating IS NOT NULL
      AND black_rating IS NOT NULL
      AND ABS(white_rating - black_rating) <= :max_gap
      -- --lichess-only (E-09 cross-check): entry evals in these games are the
      -- preserved lichess server-analysis values, never our quick-scan.
      AND (NOT CAST(:lichess_only AS boolean) OR lichess_evals_at IS NOT NULL)
    ORDER BY platform, platform_game_id, id
),
ranked AS (
    SELECT *,
        (CAST(:min_center AS int) + CAST(:width AS int) * LEAST(GREATEST(
            FLOOR(((white_rating + black_rating) / 2.0 - CAST(:origin AS int)) / CAST(:width AS int)),
            0), CAST(:max_index AS int)))::int AS elo_bucket,
        ROW_NUMBER() OVER (
            PARTITION BY tc,
                LEAST(GREATEST(
                    FLOOR(((white_rating + black_rating) / 2.0 - CAST(:origin AS int)) / CAST(:width AS int)),
                    0), CAST(:max_index AS int))
            ORDER BY md5(id::text || :seed)
        ) AS rn
    FROM dedup
)
SELECT id, platform, platform_game_id, tc, elo_bucket,
       white_rating, black_rating, termination, result
FROM ranked
WHERE rn <= :games_per_cell
"""

# Entry row per (game, phase) WITH its stored eval — DISTINCT ON picks the
# minimal ply per phase, which is the boundary entry the eval lane wrote.
ENTRY_ROWS_SQL = """
SELECT DISTINCT ON (game_id, phase)
    game_id, phase, ply, eval_cp, eval_mate, endgame_class, clock_seconds
FROM game_positions
WHERE game_id = ANY(:ids) AND phase IN (:phase_mg, :phase_eg)
ORDER BY game_id, phase, ply
"""

PGN_SQL = "SELECT id, pgn FROM games WHERE id = ANY(:ids)"


def _log(msg: str) -> None:
    print(f"[gate0-sampler] {msg}", flush=True)


def _build_rows(
    game: dict[str, Any],
    entries: list[dict[str, Any]],
    pgn: str,
) -> list[dict[str, Any]]:
    """Reconstruct FENs for one game's boundary entries -> manifest rows."""
    target_plies = {e["ply"] for e in entries}
    snapshots = _snapshot_boards(pgn, target_plies)
    rows: list[dict[str, Any]] = []
    for entry in entries:
        board = snapshots.get(entry["ply"])
        if board is None:
            continue  # mainline ended early / unparseable — same silent-skip as the eval lane
        rows.append(
            {
                "game_id": game["id"],
                "platform": game["platform"],
                "platform_game_id": game["platform_game_id"],
                "tc": game["tc"],
                "elo_bucket": game["elo_bucket"],
                "white_rating": game["white_rating"],
                "black_rating": game["black_rating"],
                "termination": game["termination"],
                "flagged": game["termination"] in FLAGGED_TERMINATIONS,
                "result": game["result"],
                "white_score": WHITE_SCORE[game["result"]],
                "boundary": BOUNDARY_NAME[entry["phase"]],
                "ply": entry["ply"],
                "side_to_move": "w" if board.turn else "b",
                "fen": board.fen(),
                "eval_cp": entry["eval_cp"],
                "eval_mate": entry["eval_mate"],
                "endgame_class": entry["endgame_class"],
                "clock_seconds": entry["clock_seconds"],
            }
        )
    return rows


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="benchmark", choices=["benchmark", "dev"])
    parser.add_argument("--games-per-cell", type=int, default=None)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--out", default=None)
    parser.add_argument("--lichess-only", action="store_true")
    args = parser.parse_args()
    if args.games_per_cell is None:
        args.games_per_cell = (
            LICHESS_ONLY_GAMES_PER_CELL if args.lichess_only else DEFAULT_GAMES_PER_CELL
        )
    if args.out is None:
        args.out = LICHESS_ONLY_OUT if args.lichess_only else DEFAULT_OUT

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
                            # Lower edge of the bottom bucket and the top bucket's
                            # index, precomputed here because asyncpg cannot deduce
                            # one type for a parameter used in mixed arithmetic.
                            "origin": ELO_BUCKET_MIN_CENTER - ELO_BUCKET_WIDTH // 2,
                            "max_index": (ELO_BUCKET_MAX_CENTER - ELO_BUCKET_MIN_CENTER)
                            // ELO_BUCKET_WIDTH,
                            "seed": args.seed,
                            "games_per_cell": args.games_per_cell,
                            "lichess_only": args.lichess_only,
                        },
                    )
                ).mappings()
            ]
            ids = [g["id"] for g in games]
            _log(f"{len(games)} games selected; fetching entry rows + PGNs...")
            entry_rows = [
                dict(r)
                for r in (
                    await conn.execute(
                        text(ENTRY_ROWS_SQL),
                        {"ids": ids, "phase_mg": PHASE_MIDDLEGAME, "phase_eg": PHASE_ENDGAME},
                    )
                ).mappings()
            ]
            pgns = {
                r["id"]: r["pgn"]
                for r in (await conn.execute(text(PGN_SQL), {"ids": ids})).mappings()
            }
    finally:
        await engine.dispose()

    entries_by_game: dict[int, list[dict[str, Any]]] = {}
    for row in entry_rows:
        entries_by_game.setdefault(row["game_id"], []).append(row)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".tmp")

    rows_written = 0
    boundary_counts = {"middlegame": 0, "endgame": 0}
    started = time.monotonic()
    with tmp_path.open("w", encoding="utf-8") as fh:
        for i, game in enumerate(games, start=1):
            entries = entries_by_game.get(game["id"], [])
            pgn = pgns.get(game["id"])
            if pgn is None or not entries:
                continue
            for row in _build_rows(game, entries, pgn):
                fh.write(json.dumps(row) + "\n")
                rows_written += 1
                boundary_counts[row["boundary"]] += 1
            if i % PROGRESS_EVERY_GAMES == 0:
                elapsed = time.monotonic() - started
                rate = i / elapsed if elapsed > 0 else 0.0
                eta_s = (len(games) - i) / rate if rate > 0 else 0.0
                _log(f"{i}/{len(games)} games ({rate:.0f}/s, ETA {eta_s:.0f}s)")
    tmp_path.replace(out_path)

    elapsed = time.monotonic() - started
    _log(
        f"done in {elapsed:.1f}s: {rows_written} rows -> {out_path} "
        f"(middlegame={boundary_counts['middlegame']}, endgame={boundary_counts['endgame']})"
    )


if __name__ == "__main__":
    asyncio.run(main())
