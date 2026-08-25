"""SEED-153 step 2a: shard sampler for the SF-vs-Maia disagreement scan (D-06).

Emits the positions the Maia scan (`seed153_scan.mjs`) will score. One NDJSON
line per GAME, carrying every scannable non-opening ply with its reconstructed
FEN, Stockfish's white-POV expected score, and the full E-10 payload — so the
scan, the FlawChess sweep and the analysis all join on this file without ever
going back to the DB.

Grouping by game (rather than one line per ply) is what makes D-05's
"one randomly chosen qualifying ply per game" a local decision in the scan:
the scan sees a game's whole qualifier set at once and never has to hold a
cross-shard index to enforce per-game independence.

D-06 frame, deduped on (platform, platform_game_id):

    rated, not a computer game, both ratings present,
    ABS(white_rating - black_rating) <= 100  (E-04),
    full_evals_completed_at IS NOT NULL,
    termination <> 'abandoned',
    phase > 0  (non-opening plies only)

D-04 (mate excluded from the frame) is applied HERE, at scan-sample time, not
downstream: a mate ply pins Stockfish at exactly 1.0/0.0 while Maia's value
head cannot count mate, so scoring one would buy a row the study must discard
anyway. Mate plies are still COUNTED (`mate_plies`) because the 2.13%
incidence this scan is checked against was measured over a denominator that
included them — see `evaled_plies` in the shard stats.

Sharding is by HASH RESIDUE, not by rank window: a game belongs to shard
`md5(id || seed) % num_shards`. Shard membership is a pure function of
(id, seed) and cannot move.

That is not the obvious design, and the reason is a bug this script had.
Sharding used to be `ROW_NUMBER() OVER (ORDER BY md5(...))` with shard K taking
ranks (K*size, (K+1)*size]. The benchmark DB is NOT static — the eval backfill
keeps granting `full_evals_completed_at`, and the frame grew by 636 games
during one 3-hour 15-shard run. Every game admitted mid-run shifts the rank of
every game ordered after it, so games sitting near a shard boundary landed in
shard K on one query and shard K+1 on the next: 9 were scanned twice and a
similar number were skipped outright. Both failures are silent — the run looks
complete, and the duplicates surface only as a quietly inflated n. A residue
has no such coupling: admitting a game changes nothing about where any other
game goes.

Stockfish's expected score is computed here via the app's own
`eval_cp_to_expected_score` (E-09 — never hand-roll the sigmoid), so the Node
side only ever compares two numbers that are already in the same white-POV
frame.

Usage:
    bin/benchmark_db.sh start
    uv run python scripts/engine_disagreement_study/seed153_scan_sample.py \
        --db benchmark --shard 0 --num-shards 160
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import db_url_for_target  # noqa: E402
from app.services.eval_entry import _snapshot_boards  # noqa: E402
from app.services.eval_utils import eval_cp_to_expected_score  # noqa: E402
from gate0_null_baselines import material_balance_white  # noqa: E402
from sample_gate0_positions import (  # noqa: E402
    ELO_BUCKET_MAX_CENTER,
    ELO_BUCKET_MIN_CENTER,
    ELO_BUCKET_WIDTH,
    FLAGGED_TERMINATIONS,
    MAX_RATING_GAP,
    PGN_SQL,
    WHITE_SCORE,
)

DEFAULT_SEED = "seed153-scan"
# The frame is ~325k games, so 160 shards puts ~2,030 games (~100k positions,
# ~12 min of scanning) in each — the granularity the run driver and the
# first-shard stop condition were sized around.
DEFAULT_NUM_SHARDS = 160
DEFAULT_OUT_DIR = "scripts/engine_disagreement_study/data"
# Games per DB round-trip. 2,000 games x ~60 plies is ~120k position rows,
# which is a comfortable single fetch and keeps PGNs from piling up.
BATCH_GAMES = 500
PROGRESS_EVERY_GAMES = 2000

# game_positions.phase: 0 = opening, 1 = middlegame, 2 = endgame. The frame is
# every NON-opening ply, not just the two boundary entries Stage B sampled.
PHASE_OPENING = 0
PHASE_NAME = {1: "middlegame", 2: "endgame"}

# D-06 frame. Deduped because the same platform game imported by two benchmark
# users appears twice (SEED-145 sampler's own dedup trap).
GAME_SELECT_SQL = """
WITH dedup AS (
    SELECT DISTINCT ON (platform, platform_game_id)
        id, platform, platform_game_id, time_control_bucket AS tc,
        white_rating, black_rating, termination::text AS termination,
        result::text AS result, lichess_evals_at
    FROM games
    WHERE rated
      AND NOT is_computer_game
      AND white_rating IS NOT NULL
      AND black_rating IS NOT NULL
      AND ABS(white_rating - black_rating) <= :max_gap
      AND full_evals_completed_at IS NOT NULL
      AND termination::text <> 'abandoned'
    ORDER BY platform, platform_game_id, id
),
bucketed AS (
    SELECT *,
        (CAST(:min_center AS int) + CAST(:width AS int) * LEAST(GREATEST(
            FLOOR(((white_rating + black_rating) / 2.0 - CAST(:origin AS int)) / CAST(:width AS int)),
            0), CAST(:max_index AS int)))::int AS elo_bucket,
        -- Top 8 hex digits of the seeded md5 as an unsigned 32-bit integer.
        -- Taking its residue is what pins a game to one shard for good; see
        -- the rank-drift incident in this module's docstring.
        ('x' || substr(md5(id::text || :seed), 1, 8))::bit(32)::bigint AS h
    FROM dedup
)
SELECT id, platform, platform_game_id, tc, elo_bucket,
       white_rating, black_rating, termination, result,
       (lichess_evals_at IS NOT NULL) AS lichess_sourced
FROM bucketed
WHERE h % CAST(:num_shards AS bigint) = CAST(:shard AS bigint)
ORDER BY h
"""

# EVERY ply of the batch's games, opening included. The opening rows are not
# scanned; they are fetched so `oppo_clock_seconds` (the PREVIOUS ply's clock,
# gate0_null_baselines' convention) resolves for a ply at the opening boundary
# without a second round-trip.
PLIES_SQL = """
SELECT game_id, ply, phase, eval_cp, eval_mate, endgame_class, clock_seconds, move_san
FROM game_positions
WHERE game_id = ANY(:ids)
ORDER BY game_id, ply
"""


def _log(msg: str) -> None:
    print(f"[seed153-scan-sample] {msg}", flush=True)


class ShardStats:
    """Denominators the first-shard incidence check is reported against."""

    def __init__(self) -> None:
        self.games = 0
        self.games_emitted = 0
        self.evaled_plies = 0
        self.mate_plies = 0
        self.scannable_plies = 0
        self.unreachable_plies = 0

    def as_dict(self) -> dict[str, int]:
        return {
            "games": self.games,
            "games_emitted": self.games_emitted,
            "evaled_plies": self.evaled_plies,
            "mate_plies": self.mate_plies,
            "scannable_plies": self.scannable_plies,
            "unreachable_plies": self.unreachable_plies,
        }


def build_game_row(
    game: dict[str, Any],
    plies: list[dict[str, Any]],
    pgn: str,
    stats: ShardStats,
) -> dict[str, Any] | None:
    """One manifest line for `game`, or None when nothing in it is scannable."""
    clock_by_ply = {p["ply"]: p["clock_seconds"] for p in plies}

    # EVAL ALIGNMENT (repaired 2026-08-24). `game_positions.eval_cp` at row P is
    # the POST-MOVE eval — the eval of the position AFTER the move played at ply
    # P (see app/repositories/library_repository.py:2431 and eval_drain.py). The
    # FEN this sampler builds for ply P is `_snapshot_boards`' PRE-PUSH board,
    # i.e. the position BEFORE that move. So the Stockfish reading that describes
    # fen[P] lives on row **P-1**, and pairing fen[P] with eval_cp[P] hands
    # Stockfish a half-move of lookahead — including the move actually played —
    # that Maia and FlawChess never see.
    #
    # Verified with a fresh Stockfish at depth 16 on fen[P]: median
    # |fresh - eval_cp[P]| = 145.5 cp vs |fresh - eval_cp[P-1]| = 22.0 cp,
    # only 25/200 rows closer to eval_cp[P].
    #
    # The D-06 frame is full-ply-evaled games (99.3% lichess %evals, the rest
    # engine-drained), and BOTH of those lanes are post-move, so P-1 is right
    # for the whole frame. The one lane that is already aligned is the entry-ply
    # lane (app/services/eval_entry.py), which snapshots pre-push and writes at
    # the same ply — it only ever fills plies no full-ply lane had populated, so
    # it is near-absent here. See SEED-145's repair for the frame where that
    # lane dominates and a blanket shift would be WRONG.
    eval_by_ply = {p["ply"]: p for p in plies}

    scannable = []
    for p in plies:
        if p["phase"] == PHASE_OPENING:
            continue
        # The eval describing THIS ply's position, not the next one's.
        aligned = eval_by_ply.get(p["ply"] - 1)
        if aligned is None:
            continue  # no previous row (ply 0) — nothing describes fen[P]
        has_eval = aligned["eval_cp"] is not None or aligned["eval_mate"] is not None
        if has_eval:
            stats.evaled_plies += 1
        if aligned["eval_mate"] is not None:
            stats.mate_plies += 1  # D-04: counted, never scanned
            continue
        if aligned["eval_cp"] is None:
            continue
        # Carry the aligned reading forward under an explicit name so nothing
        # downstream can silently pick up the post-move value again.
        scannable.append({**p, "aligned_eval_cp": aligned["eval_cp"]})

    if not scannable:
        return None

    snapshots = _snapshot_boards(pgn, {p["ply"] for p in scannable})
    out_plies = []
    for p in scannable:
        board = snapshots.get(p["ply"])
        if board is None:
            # Mainline ended before this ply — same silent skip as the eval lane.
            stats.unreachable_plies += 1
            continue
        fen = board.fen()
        out_plies.append(
            {
                "ply": p["ply"],
                "phase": PHASE_NAME[p["phase"]],
                "side_to_move": "w" if board.turn else "b",
                "fen": fen,
                # The eval of fen[P] — row P-1's value, NOT row P's. `eval_cp`
                # keeps the aligned number so every downstream consumer (the
                # Node scan's D-02 test, the manifest, the analysis) reads the
                # position it actually scored. `post_move_eval_cp` preserves the
                # old pairing purely so the contamination can be quantified.
                "eval_cp": p["aligned_eval_cp"],
                "post_move_eval_cp": p["eval_cp"],
                # E-09: the project's own sigmoid, white-POV, so the Node scan
                # never re-derives a cp->score curve of its own.
                "sf_score_white": eval_cp_to_expected_score(p["aligned_eval_cp"], "white"),
                "endgame_class": p["endgame_class"],
                "clock_seconds": p["clock_seconds"],
                "oppo_clock_seconds": clock_by_ply.get(p["ply"] - 1),
                "move_san": p["move_san"],
                "material_white": material_balance_white(fen),
            }
        )
    stats.scannable_plies += len(out_plies)
    if not out_plies:
        return None

    return {
        "game_id": game["id"],
        "platform": game["platform"],
        "platform_game_id": game["platform_game_id"],
        "tc": game["tc"],
        "elo_bucket": game["elo_bucket"],
        "white_rating": game["white_rating"],
        "black_rating": game["black_rating"],
        "termination": game["termination"],
        "flagged": game["termination"] in FLAGGED_TERMINATIONS,
        "lichess_sourced": game["lichess_sourced"],
        "result": game["result"],
        "white_score": WHITE_SCORE[game["result"]],
        "plies": out_plies,
    }


async def fetch_batch(conn: Any, games: list[dict[str, Any]], stats: ShardStats) -> list[dict]:
    ids = [g["id"] for g in games]
    plies_by_game: dict[int, list[dict[str, Any]]] = {}
    for r in (await conn.execute(text(PLIES_SQL), {"ids": ids})).mappings():
        plies_by_game.setdefault(r["game_id"], []).append(dict(r))
    pgns = {r["id"]: r["pgn"] for r in (await conn.execute(text(PGN_SQL), {"ids": ids})).mappings()}

    rows = []
    for game in games:
        stats.games += 1
        pgn = pgns.get(game["id"])
        plies = plies_by_game.get(game["id"], [])
        if pgn is None or not plies:
            continue
        row = build_game_row(game, plies, pgn, stats)
        if row is not None:
            stats.games_emitted += 1
            rows.append(row)
    return rows


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="benchmark", choices=["benchmark", "dev"])
    parser.add_argument("--shard", type=int, default=0)
    parser.add_argument(
        "--num-shards",
        type=int,
        default=DEFAULT_NUM_SHARDS,
        help="shards the frame splits into; a game's shard is md5(id||seed) %% this",
    )
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"seed153_scan_shard-{args.shard}.ndjson.gz"
    stats_path = out_dir / f"seed153_scan_shard-{args.shard}.stats.json"
    tmp_path = out_path.with_suffix(".tmp")

    stats = ShardStats()

    engine = create_async_engine(db_url_for_target(args.db))
    started = time.monotonic()
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET TRANSACTION READ ONLY"))
            _log(
                f"shard {args.shard}/{args.num_shards}: "
                f"md5(id||{args.seed!r}) % {args.num_shards} == {args.shard}"
            )
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
                            "num_shards": args.num_shards,
                            "shard": args.shard,
                        },
                    )
                ).mappings()
            ]
            _log(f"{len(games)} games selected; reconstructing FENs...")
            with gzip.open(tmp_path, "wt", encoding="utf-8") as fh:
                for start in range(0, len(games), BATCH_GAMES):
                    for row in await fetch_batch(conn, games[start : start + BATCH_GAMES], stats):
                        fh.write(json.dumps(row) + "\n")
                    done = min(start + BATCH_GAMES, len(games))
                    if done % PROGRESS_EVERY_GAMES == 0 or done == len(games):
                        elapsed = time.monotonic() - started
                        rate = done / elapsed if elapsed > 0 else 0.0
                        eta = (len(games) - done) / rate if rate > 0 else 0.0
                        _log(
                            f"{done}/{len(games)} games ({rate:.0f}/s, ETA {eta / 60:.1f} min, "
                            f"{stats.scannable_plies} scannable plies)"
                        )
    finally:
        await engine.dispose()

    tmp_path.replace(out_path)
    payload = {
        "shard": args.shard,
        "num_shards": args.num_shards,
        "seed": args.seed,
        **stats.as_dict(),
    }
    stats_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    per_game = stats.scannable_plies / stats.games_emitted if stats.games_emitted else 0.0
    _log(
        f"done in {time.monotonic() - started:.1f}s -> {out_path}\n"
        f"  games={stats.games} emitted={stats.games_emitted}\n"
        f"  evaled non-opening plies={stats.evaled_plies} (mate={stats.mate_plies}, "
        f"scannable={stats.scannable_plies}, unreachable={stats.unreachable_plies})\n"
        f"  {per_game:.1f} scannable plies per emitted game"
    )


if __name__ == "__main__":
    asyncio.run(main())
