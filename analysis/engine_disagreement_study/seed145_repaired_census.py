r"""SEED-145 Stage B census, rescored with a provenance-aware Stockfish arm.

Only the Stockfish arm changes. Maia and FlawChess consumed `row.fen` directly,
so all 140,658 of their ledgered values are correct as they stand; no engine is
re-run here.

The repair is per-row, not global (see seed145_repair_aligned_evals.py):

  * lichess %evals are POST-MOVE  -> the eval of `fen[P]` is on row P-1;
  * entry-lane evals are ALIGNED  -> row P is already the eval of `fen[P]`.

Stage B is 72.2% entry-lane, so a blanket shift would corrupt most of the frame.

Everything else follows SEED-145's own conventions: E-05 flag filtering for the
headline basis, E-09 lichess sigmoid from app/services/eval_utils (mate maps to
exactly 1.0/0.0, never through the sigmoid), white-POV, draws as 0.5, and the
md5(game_id) fit/eval split. D-01's "never pool the boundaries" is honoured too.

Run it:  uv run --project analysis python analysis/engine_disagreement_study/seed145_repaired_census.py
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import TypedDict

import numpy as np
import polars as pl

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# noinspection PyUnresolvedReferences
from app.services.eval_utils import LICHESS_K, eval_cp_to_expected_score  # noqa: E402

DATA_DIR = REPO_ROOT / "scripts" / "engine_disagreement_study" / "data"
LEDGER_GLOB = "stage_b_ledger-worker-*.ndjson"
# The committed artifact is the gzipped copy (~0.8 MB); the plain .ndjson is a
# ~14 MB local by-product of the repair run and stays gitignored. Prefer the
# uncompressed file when it happens to be present, else read the .gz — polars
# decompresses ndjson transparently, so the two paths are interchangeable.
# Mirrors the same fallback in seed153_tail_analysis.py.
ALIGNED_PATH_PLAIN = DATA_DIR / "stage_b_aligned_evals.ndjson"
ALIGNED_PATH_GZ = DATA_DIR / "stage_b_aligned_evals.ndjson.gz"
REPORT_PATH = REPO_ROOT / "reports" / "engine-disagreement-study" / "seed145-repaired-census.md"

ARMS: dict[str, str] = {
    "SF": "sf_score_white",
    "Maia": "maia_score_white",
    "FC": "fc_score_white",
    "Blend50": "blend_score_white",
}
PAIRS: list[tuple[str, str]] = [("FC", "SF"), ("FC", "Maia"), ("FC", "Blend50"), ("SF", "Maia")]
BOUNDARIES: list[str] = ["middlegame", "endgame"]


def _pava_fit(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Non-decreasing isotonic fit of y on x. Returns (sorted x, fitted y)."""
    # lexsort, not argsort: PAVA's merge is order-sensitive across TIED x, and
    # polars gives no row-order guarantee after a join/filter, so plain argsort
    # made the whole report vary run to run (~10% of the reported deltas).
    # Breaking ties on y makes the fit a pure function of the data.
    order = np.lexsort((y, x))
    xs, ys = x[order], y[order].astype(float)
    values: list[float] = []
    weights: list[float] = []
    for point in ys:
        value, weight = float(point), 1.0
        while values and values[-1] > value:
            prev_v, prev_w = values.pop(), weights.pop()
            value = (prev_v * prev_w + value * weight) / (prev_w + weight)
            weight = prev_w + weight
        values.append(value)
        weights.append(weight)
    fitted = np.empty(len(ys))
    pos = 0
    for value, weight in zip(values, weights):
        count = int(round(weight))
        fitted[pos : pos + count] = value
        pos += count
    return xs, fitted


def _split_is_eval(game_id: int) -> bool:
    return int(hashlib.md5(f"{game_id}|split".encode()).hexdigest(), 16) % 2 == 0


def cross_fitted_isotonic(pred: np.ndarray, outcome: np.ndarray, is_eval: np.ndarray) -> np.ndarray:
    out = np.empty(len(pred))
    for holdout in (True, False):
        knots_x, knots_y = _pava_fit(pred[is_eval != holdout], outcome[is_eval != holdout])
        out[is_eval == holdout] = np.interp(pred[is_eval == holdout], knots_x, knots_y)
    return out


def expected_score(cp: pl.Expr, mate: pl.Expr) -> pl.Expr:
    """E-09 thermometer. Mate never routes through the sigmoid (eval_utils D-02)."""
    return (
        pl.when(mate.is_not_null())
        .then(pl.when(mate > 0).then(1.0).otherwise(0.0))
        .otherwise(1.0 / (1.0 + (-LICHESS_K * cp).exp()))
    )


def load() -> pl.DataFrame:
    shards = sorted(DATA_DIR.glob(LEDGER_GLOB))
    raw = pl.concat(
        [pl.read_ndjson(s, infer_schema_length=None) for s in shards], how="diagonal_relaxed"
    )
    aligned_path = ALIGNED_PATH_PLAIN if ALIGNED_PATH_PLAIN.exists() else ALIGNED_PATH_GZ
    if not aligned_path.exists():
        raise SystemExit(
            f"no aligned-eval file: expected {ALIGNED_PATH_PLAIN.name} or {ALIGNED_PATH_GZ.name} "
            f"in {DATA_DIR}"
        )
    aligned = pl.read_ndjson(
        aligned_path,
        schema={
            "game_id": pl.Int64,
            "ply": pl.Int64,
            "lichess_sourced": pl.Boolean,
            "prev_eval_cp": pl.Int64,
            "prev_eval_mate": pl.Int64,
        },
    )

    rows = (
        raw.filter(pl.col("error").is_null())
        .unique(subset=["game_id", "boundary"], keep="first")
        .join(aligned, on=["game_id", "ply"], how="left")
        # THE REPAIR. lichess rows take the previous row's eval; entry-lane rows
        # keep their own, which already describes fen[P].
        .with_columns(
            repaired_cp=pl.when(pl.col("lichess_sourced"))
            .then(pl.col("prev_eval_cp"))
            .otherwise(pl.col("eval_cp")),
            repaired_mate=pl.when(pl.col("lichess_sourced"))
            .then(pl.col("prev_eval_mate"))
            .otherwise(pl.col("eval_mate")),
        )
        .with_columns(
            sf_score_white=expected_score(pl.col("repaired_cp"), pl.col("repaired_mate")),
            sf_score_white_orig=expected_score(pl.col("eval_cp"), pl.col("eval_mate")),
        )
        .with_columns(
            blend_score_white=(pl.col("sf_score_white") + pl.col("maia_score_white")) / 2.0,
            blend_score_white_orig=(pl.col("sf_score_white_orig") + pl.col("maia_score_white"))
            / 2.0,
            is_eval_half=pl.col("game_id").map_elements(_split_is_eval, return_dtype=pl.Boolean),
        )
        .filter(
            pl.col("sf_score_white").is_not_null()
            & pl.col("maia_score_white").is_not_null()
            & pl.col("fc_score_white").is_not_null()
        )
        # Stable row order so every downstream numpy view is reproducible.
        .sort("game_id", "boundary")
    )

    # E-09 guard: the vectorised thermometer must match eval_utils exactly.
    probe = rows.filter(pl.col("repaired_mate").is_null()).head(500)
    expected = [eval_cp_to_expected_score(int(cp), "white") for cp in probe["repaired_cp"]]
    drift = max(abs(a - b) for a, b in zip(probe["sf_score_white"], expected))
    assert drift < 1e-12, f"vectorised sigmoid drifted from eval_utils by {drift}"
    return rows


class PairedDelta(TypedDict):
    """One arm-vs-arm comparison. Typed rather than `dict[str, object]` so the
    renderer can do arithmetic on `delta`/`z` and `.split()` on `pair`."""

    pair: str
    delta: float
    z: float


def paired(cols: dict[str, np.ndarray], outcome: np.ndarray) -> list[PairedDelta]:
    sq = {k: (v - outcome) ** 2 for k, v in cols.items()}
    out: list[PairedDelta] = []
    for a, b in PAIRS:
        d = sq[a] - sq[b]
        se = d.std(ddof=1) / np.sqrt(len(d))
        out.append(
            {
                "pair": f"{a} − {b}",
                "delta": float(d.mean()),
                "z": float(d.mean() / se) if se else float("nan"),
            }
        )
    return out


def main() -> None:
    rows = load()
    headline = rows.filter(~pl.col("flagged"))

    lines: list[str] = []
    add = lines.append
    add("# SEED-145 Stage B census — repaired Stockfish arm")
    add("")
    add(
        "Only the Stockfish arm changed. Maia and FlawChess read `row.fen` "
        "directly, so all their ledgered values were already correct and no "
        "engine was re-run."
    )
    add("")
    add("## The repair")
    add("")
    add(
        "`game_positions.eval_cp` has two populations with **opposite** ply "
        "conventions. lichess %evals are post-move, so the eval of the sampler's "
        "`fen[P]` sits on row P-1. Entry-lane evals (`eval_entry.py`) snapshot the "
        "board pre-push, evaluate that position, and write it at the same ply — "
        "already aligned."
    )
    add("")
    add(
        "Measured with a fresh Stockfish at depth 16 on `fen[P]`, 150 rows per "
        "population: entry-lane sits **7.0 cp** from `eval_cp[P]` (aligned); "
        "lichess sits **26.5 cp** from `eval_cp[P]` but **13.0 cp** from "
        "`eval_cp[P-1]` (shifted)."
    )
    add("")
    n_lich = headline.filter(pl.col("lichess_sourced")).height
    add(
        f"Stage B headline basis is **{headline.height:,}** rows: "
        f"**{n_lich:,}** lichess-sourced (repaired) and "
        f"**{headline.height - n_lich:,}** entry-lane (left untouched). A blanket "
        "ply-1 shift would have corrupted the larger share."
    )
    add("")

    for calibrated in (False, True):
        label = "isotonic-recalibrated (cross-fitted)" if calibrated else "raw"
        add(f"## Brier — {label}")
        add("")
        add("| boundary | n | " + " | ".join(ARMS) + " |")
        add("|---" * (len(ARMS) + 2) + "|")
        for boundary in BOUNDARIES:
            sub = headline.filter(pl.col("boundary") == boundary)
            outcome = sub["white_score"].to_numpy()
            is_eval = sub["is_eval_half"].to_numpy()
            scores = {}
            for name, col in ARMS.items():
                pred = sub[col].to_numpy()
                if calibrated:
                    pred = cross_fitted_isotonic(pred, outcome, is_eval)
                scores[name] = float(((pred - outcome) ** 2).mean())
            # `key=scores.get` is float | None to a type checker; index instead.
            best = min(scores, key=lambda arm: scores[arm])
            cells = [f"**{scores[a]:.4f}**" if a == best else f"{scores[a]:.4f}" for a in ARMS]
            add(f"| {boundary} | {sub.height:,} | " + " | ".join(cells) + " |")
        add("")

        add(f"### Paired ΔBrier — {label}")
        add("")
        add("Negative ⇒ the first arm is better. |z| >= 1.96 is p < 0.05.")
        add("")
        add("| boundary | pair | ΔBrier | z | verdict |")
        add("|---|---|---|---|---|")
        for boundary in BOUNDARIES:
            sub = headline.filter(pl.col("boundary") == boundary)
            outcome = sub["white_score"].to_numpy()
            is_eval = sub["is_eval_half"].to_numpy()
            cols = {}
            for name, col in ARMS.items():
                pred = sub[col].to_numpy()
                cols[name] = cross_fitted_isotonic(pred, outcome, is_eval) if calibrated else pred
            for row in paired(cols, outcome):
                z = float(row["z"])
                verdict = (
                    "n.s."
                    if abs(z) < 1.96
                    else f"**{row['pair'].split(' − ')[0 if z < 0 else 1]}** wins (p<0.05)"
                )
                add(
                    f"| {boundary} | {row['pair']} | {float(row['delta']):+.5f} | {z:+.2f} | {verdict} |"
                )
        add("")

    # What the repair moved, on the affected subset only.
    add("## What the repair moved")
    add("")
    add(
        "Stockfish's Brier before and after, split by provenance. The entry-lane "
        "rows are identical by construction — they are the control."
    )
    add("")
    add("| boundary | population | n | SF repaired | SF as-published | delta |")
    add("|---|---|---|---|---|---|")
    for boundary in BOUNDARIES:
        for pop_name, mask in (
            ("lichess (repaired)", pl.col("lichess_sourced")),
            ("entry-lane (control)", ~pl.col("lichess_sourced")),
        ):
            sub = headline.filter((pl.col("boundary") == boundary) & mask)
            if not sub.height:
                continue
            outcome = sub["white_score"].to_numpy()
            new = float(((sub["sf_score_white"].to_numpy() - outcome) ** 2).mean())
            old = float(((sub["sf_score_white_orig"].to_numpy() - outcome) ** 2).mean())
            add(
                f"| {boundary} | {pop_name} | {sub.height:,} | {new:.4f} | {old:.4f} | {new - old:+.4f} |"
            )
    add("")

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\n[written] {REPORT_PATH}")


if __name__ == "__main__":
    main()
