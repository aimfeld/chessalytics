"""SEED-145 Gate 0 null-baseline fit (E-14).

Fits the two free statistical null arms on a stratified sample of the study
frame and records their Brier / log loss per boundary — the floor every engine
arm must clear (pre-registered gate: `practicalScore` must beat BOTH, at both
boundaries):

  (a) rating-only ELO expectation: E = 1 / (1 + 10^(-(white-black)/400)),
      closed-form, no fit;
  (b) material + rating + clock logistic: white-POV material balance, rating
      diff, clock diff/total at the entry position, side-to-move indicator —
      fit per (boundary, tc bucket) so raw clock seconds never share one slope
      across bullet..classical, via weighted IRLS (draws enter the fit as two
      half-weight rows: the proper soft-target cross-entropy fit; no sklearn
      dependency).

Held-out discipline: games split into fit/eval halves by md5(game_id) parity;
all reported metrics are eval-half only. Headline basis (termination filter,
E-05) is primary; with-flags reported alongside. Draws score 0.5 (same
convention as expectedScore()).

Clock semantics (zobrist.py): row P stores the PRE-push position, and
clock_seconds on row P is the MOVER's clock after move P — i.e. it belongs to
the row's side_to_move. The opponent's clock is the previous ply's
clock_seconds, fetched here separately.

Usage:
    bin/benchmark_db.sh start
    uv run python scripts/seed145/gate0_null_baselines.py --db benchmark
    uv run python scripts/seed145/gate0_null_baselines.py --refit-only
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import db_url_for_target  # noqa: E402
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

DEFAULT_GAMES_PER_CELL = 250
DEFAULT_SEED = "seed145-gate0-null"
DEFAULT_MANIFEST = "scripts/seed145/data/gate0_null_manifest.ndjson"
DEFAULT_OUT = "scripts/seed145/data/gate0_null_baselines.json"
PROGRESS_EVERY_GAMES = 500

# Standard piece values (pawn units) for the material-balance feature.
PIECE_VALUES = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9}

# Weighted-IRLS fit knobs.
IRLS_ITERATIONS = 30
IRLS_RIDGE = 1e-6

# The opponent's clock at the entry position is the previous ply's annotation.
PREV_CLOCK_SQL = """
SELECT gp.game_id, gp.ply, gp.clock_seconds
FROM game_positions gp
JOIN unnest(CAST(:ids AS int[]), CAST(:plies AS int[])) AS t(gid, p)
  ON gp.game_id = t.gid AND gp.ply = t.p
"""


def _log(msg: str) -> None:
    print(f"[null-baselines] {msg}", flush=True)


def material_balance_white(fen: str) -> int:
    """White-POV material balance in pawn units from the FEN piece placement."""
    placement = fen.split(" ")[0]
    balance = 0
    for ch in placement:
        value = PIECE_VALUES.get(ch.lower())
        if value is None:
            continue
        balance += value if ch.isupper() else -value
    return balance


def elo_expectation_white(white_rating: float, black_rating: float) -> float:
    return 1.0 / (1.0 + 10 ** (-(white_rating - black_rating) / 400.0))


def eval_half(game_id: int) -> bool:
    """Deterministic fit/eval split by md5(game_id) parity."""
    return int(hashlib.md5(f"{game_id}|split".encode()).hexdigest(), 16) % 2 == 0


def fit_logistic_irls(x: np.ndarray, y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted logistic regression via IRLS (Newton steps, tiny ridge)."""
    beta = np.zeros(x.shape[1])
    for _ in range(IRLS_ITERATIONS):
        p = 1.0 / (1.0 + np.exp(-(x @ beta)))
        grad = x.T @ (w * (y - p))
        hess = (x * (w * p * (1 - p))[:, None]).T @ x + IRLS_RIDGE * np.eye(x.shape[1])
        step = np.linalg.solve(hess, grad)
        beta += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return beta


def soft_target_expand(
    x: np.ndarray, scores: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Draws (score 0.5) become two half-weight rows -> proper soft-label fit."""
    decisive = (scores == 0.0) | (scores == 1.0)
    xs = [x[decisive]]
    ys = [scores[decisive]]
    ws = [np.ones(int(decisive.sum()))]
    draws = ~decisive
    n_draws = int(draws.sum())
    if n_draws > 0:
        xs += [x[draws], x[draws]]
        ys += [np.ones(n_draws), np.zeros(n_draws)]
        ws += [np.full(n_draws, 0.5), np.full(n_draws, 0.5)]
    return np.vstack(xs), np.concatenate(ys), np.concatenate(ws)


def feature_matrix(rows: list[dict[str, Any]]) -> np.ndarray:
    """[1, material, elo_diff, clock_diff, clock_total, stm_white] — white-POV."""
    feats = []
    for r in rows:
        stm_white = 1.0 if r["side_to_move"] == "w" else 0.0
        white_clock = r["clock_seconds"] if stm_white else r["oppo_clock_seconds"]
        black_clock = r["oppo_clock_seconds"] if stm_white else r["clock_seconds"]
        feats.append(
            [
                1.0,
                r["material_white"],
                (r["white_rating"] - r["black_rating"]) / 100.0,
                (white_clock - black_clock) / 60.0,
                (white_clock + black_clock) / 60.0,
                stm_white,
            ]
        )
    return np.array(feats)


def brier_logloss(preds: np.ndarray, scores: np.ndarray) -> dict[str, float]:
    p = np.clip(preds, 1e-9, 1 - 1e-9)
    return {
        "brier": float(np.mean((p - scores) ** 2)),
        "log_loss": float(-np.mean(scores * np.log(p) + (1 - scores) * np.log(1 - p))),
    }


def evaluate_boundary(rows: list[dict[str, Any]], boundary: str) -> dict[str, Any]:
    """Per-boundary metrics for both null arms, headline + with-flags bases."""
    boundary_rows = [r for r in rows if r["boundary"] == boundary]
    clocked = [
        r
        for r in boundary_rows
        if r["clock_seconds"] is not None and r["oppo_clock_seconds"] is not None
    ]

    # Per-tc logistic fits on the fit half (clock slopes must not be shared
    # across bullet..classical).
    betas: dict[str, np.ndarray] = {}
    for tc in sorted({r["tc"] for r in clocked}):
        fit_rows = [r for r in clocked if r["tc"] == tc and not eval_half(r["game_id"])]
        if len(fit_rows) < 50:
            continue
        x, y, w = soft_target_expand(
            feature_matrix(fit_rows), np.array([r["white_score"] for r in fit_rows])
        )
        betas[tc] = fit_logistic_irls(x, y, w)

    out: dict[str, Any] = {
        "n_rows": len(boundary_rows),
        "n_clocked": len(clocked),
        "tc_fits": sorted(betas),
    }
    for basis in ("headline", "with_flags"):
        flag_ok = (lambda r: not r["flagged"]) if basis == "headline" else (lambda r: True)
        elo_rows = [r for r in boundary_rows if eval_half(r["game_id"]) and flag_ok(r)]
        elo_preds = np.array(
            [elo_expectation_white(r["white_rating"], r["black_rating"]) for r in elo_rows]
        )
        elo_scores = np.array([r["white_score"] for r in elo_rows])

        logi_rows = [
            r for r in clocked if r["tc"] in betas and eval_half(r["game_id"]) and flag_ok(r)
        ]
        logi_preds = np.array(
            [1.0 / (1.0 + np.exp(-(feature_matrix([r])[0] @ betas[r["tc"]]))) for r in logi_rows]
        )
        logi_scores = np.array([r["white_score"] for r in logi_rows])

        out[basis] = {
            "elo_only": {"n_eval": len(elo_rows), **brier_logloss(elo_preds, elo_scores)},
            "material_rating_clock_logistic": {
                "n_eval": len(logi_rows),
                **brier_logloss(logi_preds, logi_scores),
            },
        }
    return out


async def sample_manifest(args: argparse.Namespace) -> list[dict[str, Any]]:
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
            pgns = {
                r["id"]: r["pgn"]
                for r in (await conn.execute(text(PGN_SQL), {"ids": ids})).mappings()
            }
    finally:
        await engine.dispose()

    entries_by_game: dict[int, list[dict[str, Any]]] = {}
    for row in entry_rows:
        entries_by_game.setdefault(row["game_id"], []).append(row)

    manifest: list[dict[str, Any]] = []
    started = time.monotonic()
    for i, game in enumerate(games, start=1):
        entries = entries_by_game.get(game["id"], [])
        pgn = pgns.get(game["id"])
        if pgn is None or not entries:
            continue
        for row in _build_rows(game, entries, pgn):
            row["oppo_clock_seconds"] = prev_clocks.get((row["game_id"], row["ply"] - 1))
            row["material_white"] = material_balance_white(row["fen"])
            manifest.append(row)
        if i % PROGRESS_EVERY_GAMES == 0:
            elapsed = time.monotonic() - started
            rate = i / elapsed if elapsed > 0 else 0.0
            eta_s = (len(games) - i) / rate if rate > 0 else 0.0
            _log(f"{i}/{len(games)} games ({rate:.0f}/s, ETA {eta_s:.0f}s)")
    return manifest


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="benchmark", choices=["benchmark", "dev"])
    parser.add_argument("--games-per-cell", type=int, default=DEFAULT_GAMES_PER_CELL)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument(
        "--refit-only", action="store_true", help="skip sampling; refit from the existing manifest"
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if args.refit_only:
        manifest = [json.loads(line) for line in manifest_path.read_text().splitlines() if line]
        _log(f"loaded {len(manifest)} manifest rows from {manifest_path}")
    else:
        manifest = await sample_manifest(args)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        with manifest_path.open("w", encoding="utf-8") as fh:
            for row in manifest:
                fh.write(json.dumps(row) + "\n")
        _log(f"{len(manifest)} manifest rows -> {manifest_path}")

    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "config": {
            "games_per_cell": args.games_per_cell,
            "seed": args.seed,
            "features": "[1, material_white, elo_diff/100, clock_diff/60, clock_total/60, stm_white]",
            "fit": "per (boundary, tc) weighted IRLS, draws as two half-weight rows",
            "split": "md5(game_id) parity; metrics are eval-half only",
        },
        "middlegame": evaluate_boundary(manifest, "middlegame"),
        "endgame": evaluate_boundary(manifest, "endgame"),
    }
    out_path = Path(args.out)
    out_path.write_text(json.dumps(summary, indent=2) + "\n")

    print("\n=== E-14 null baselines (eval half, headline basis) ===")
    for boundary in ("middlegame", "endgame"):
        s = summary[boundary]
        h = s["headline"]
        print(
            f"{boundary:<12} n={s['n_rows']:<6} "
            f"elo-only: Brier {h['elo_only']['brier']:.4f} / LL {h['elo_only']['log_loss']:.4f} "
            f"(n={h['elo_only']['n_eval']})   "
            f"logistic: Brier {h['material_rating_clock_logistic']['brier']:.4f} / "
            f"LL {h['material_rating_clock_logistic']['log_loss']:.4f} "
            f"(n={h['material_rating_clock_logistic']['n_eval']})"
        )
    _log(f"summary -> {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
