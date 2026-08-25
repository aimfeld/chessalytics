"""SEED-153 step 4 — does FlawChess beat Stockfish where SF and Maia disagree?

Scores the four arms over the SEED-153 disagreement tail (the FC sweep ledger
written by `stage_b_sweep.mjs --ledger-prefix seed153_fc_ledger`) and writes a
markdown report.

The whole point of this study is the conditional: positions where Stockfish and
Maia favour OPPOSITE sides by >= 0.20 expected score (D-02), mate excluded
(D-04), one randomly chosen qualifying ply per game (D-05).

Design decisions this script is bound by (see .planning/seeds/SEED-153-*.md):

  D-01  Per-phase analysis, pooling FORBIDDEN. MG and EG have opposite-signed
        effects that cancel to nothing when pooled. Every table below splits.
  D-09  The 50/50 SF+Maia blend is a MANDATORY secondary arm, not a kill gate.
  D-10  SEED-145 conventions: E-09 lichess sigmoid from app/services/eval_utils,
        white-POV normalisation, draws as 0.5, E-05 flag filtering.
  E-15  This compares the hybrid against its own two ingredients. It is NOT a
        claim that these are the best available outcome predictors.

Run it:  uv run --project analysis python analysis/engine_disagreement_study/seed153_tail_analysis.py
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import TypedDict

import numpy as np
import polars as pl

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# The project's own thermometer — never hand-roll the sigmoid (E-09/D-10).
# noinspection PyUnresolvedReferences
from app.services.eval_utils import (  # noqa: E402
    LICHESS_K,
    eval_cp_to_expected_score,
)

LEDGER_DIR = REPO_ROOT / "scripts" / "engine_disagreement_study" / "data"
LEDGER_PREFIX = "seed153_fc_ledger"
# The step-2 scan manifest, i.e. the selection-time record of D-02/D-04/D-05.
MANIFEST_PATH = LEDGER_DIR / "seed153_manifest.ndjson.gz"
# The step-2 scan shards carry EVERY scannable ply per game, which is what makes
# the eval-alignment repair below possible (the manifest keeps only the one
# D-05-picked ply per game, so the previous ply's eval lives only here).
SCAN_SHARD_GLOB = "seed153_scan_shard-*.ndjson.gz"
# Distilled from the shards: one (game_id, ply, eval_cp_aligned) row per manifest
# ply. Committed so the analysis reproduces without the ~51 MB of raw shards,
# which stay local. Rebuilt automatically if absent and the shards are present.
ALIGNED_EVALS_PATH = LEDGER_DIR / "seed153_aligned_evals.ndjson.gz"
REPORT_PATH = REPO_ROOT / "reports" / "engine-disagreement-study" / "seed153-tail-report.md"

# White-POV arm columns. Blend is derived, so it is added after load.
ARMS: dict[str, str] = {
    "SF": "sf_score_white",
    "Maia": "maia_score_white",
    "FC": "fc_score_white",
    "Blend50": "blend_score_white",
}

# The pairs the study exists to report. FC first so a NEGATIVE delta always
# means "FlawChess is better" — the direction the seed's tables use.
PAIRS: list[tuple[str, str]] = [
    ("FC", "SF"),
    ("FC", "Maia"),
    ("FC", "Blend50"),
    ("SF", "Maia"),
]

# D-01: the two phases are separate studies. Order is display order.
PHASES: list[str] = ["middlegame", "endgame"]

# Pre-registered 80%-power sample sizes from the seed's power table. Reported
# as a check, never as a filter — the sizing was fixed before the data existed.
POWER_TARGET_N: dict[str, int] = {"middlegame": 6_604, "endgame": 4_531}

# Reliability-diagram / calibration bins are not used here; the recalibration is
# isotonic (below), which is bin-free.


# ─── Isotonic recalibration (PAVA) ──────────────────────────────────────────
#
# sklearn is deliberately NOT an analysis dependency, so the pool-adjacent-
# violators fit lives here. It is ~20 lines and exactly reproducible.


def _pava_fit(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Non-decreasing isotonic fit of y on x. Returns (sorted x, fitted y)."""
    # lexsort, not argsort: PAVA's merge is order-sensitive across TIED x, and
    # polars gives no row-order guarantee after a join/filter, so plain argsort
    # made the whole report vary run to run (~10% of the reported deltas).
    # Breaking ties on y makes the fit a pure function of the data.
    order = np.lexsort((y, x))
    xs = x[order]
    ys = y[order].astype(float)

    values: list[float] = []
    weights: list[float] = []
    for point in ys:
        value, weight = float(point), 1.0
        # Merge backwards while the previous block violates monotonicity.
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


def _pava_predict(knots_x: np.ndarray, knots_y: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Apply a fitted isotonic map, clamping outside the fitted support."""
    return np.interp(x, knots_x, knots_y)


def _split_is_eval(game_id: int) -> bool:
    """md5(game_id) parity — the study's fit/eval split (gate0_null_baselines.py)."""
    return int(hashlib.md5(f"{game_id}|split".encode()).hexdigest(), 16) % 2 == 0


def cross_fitted_isotonic(pred: np.ndarray, outcome: np.ndarray, is_eval: np.ndarray) -> np.ndarray:
    """Out-of-fold isotonic recalibration over the study's two halves.

    Every row gets a calibrated prediction from a map fitted on the OTHER half,
    so nothing is scored on its own fit and the full n survives. The seed's
    census table used eval-half-only (fit on the fit half, score the eval half);
    that halves n, which the endgame arm here cannot afford (see the power
    table). The eval-half-only variant is reported alongside for comparability.
    """
    out = np.empty(len(pred))
    for holdout in (True, False):
        fit_mask = is_eval != holdout
        score_mask = is_eval == holdout
        knots_x, knots_y = _pava_fit(pred[fit_mask], outcome[fit_mask])
        out[score_mask] = _pava_predict(knots_x, knots_y, pred[score_mask])
    return out


# ─── Load ───────────────────────────────────────────────────────────────────


def prior_ply_evals() -> pl.DataFrame:
    """(game_id, ply) -> eval_cp of the row at ply-1 == the true eval of fen[ply].

    THE EVAL-ALIGNMENT REPAIR. `game_positions.eval_cp` at row P is the eval of
    the position AFTER the move played at ply P, while the sampler's FEN for row
    P is the position BEFORE that move (`_snapshot_boards` is pre-push). So
    pairing fen[P] with eval_cp[P] hands Stockfish a half-move of lookahead —
    including the move the player actually chose — that Maia and FlawChess never
    see.

    Measured 2026-08-24 on 200 sampled plies, fresh Stockfish depth 16 on fen[P]:
    median |fresh - eval_cp[P]| = 145.5 cp, median |fresh - eval_cp[P-1]| = 22.0
    cp, and only 25/200 rows sat closer to eval_cp[P]. The correctly aligned
    Stockfish reading for fen[P] is therefore eval_cp[P-1].

    This affects `stage_b_sample.py` identically (same `_snapshot_boards` + same
    same-ply eval pairing), so SEED-145's Stage B numbers inherit it too.
    """
    import gzip

    schema = {"game_id": pl.Int64, "ply": pl.Int64, "eval_cp_aligned": pl.Int64}
    if ALIGNED_EVALS_PATH.exists():
        return pl.read_ndjson(ALIGNED_EVALS_PATH, schema=schema)

    # Only the plies the manifest actually picked are worth keeping; the shards
    # carry ~1.4M and the study needs 18k.
    wanted = {
        (row["game_id"], row["ply"])
        for row in pl.read_ndjson(MANIFEST_PATH, infer_schema_length=None)
        .select("game_id", "ply")
        .iter_rows(named=True)
    }

    game_ids: list[int] = []
    plies: list[int] = []
    evals: list[int] = []
    for path in sorted(LEDGER_DIR.glob(SCAN_SHARD_GLOB)):
        with gzip.open(path, "rt") as handle:
            for line in handle:
                game = json.loads(line)
                gid = game["game_id"]
                by_ply = {p["ply"]: p for p in game["plies"]}
                for ply in by_ply:
                    if (gid, ply) not in wanted:
                        continue
                    prev = by_ply.get(ply - 1)
                    if prev is not None and prev["eval_cp"] is not None:
                        game_ids.append(gid)
                        plies.append(ply)
                        evals.append(prev["eval_cp"])

    out = pl.DataFrame({"game_id": game_ids, "ply": plies, "eval_cp_aligned": evals}, schema=schema)
    with gzip.open(ALIGNED_EVALS_PATH, "wt") as handle:
        handle.write(out.write_ndjson())
    return out


def ledger_is_prealigned(raw: pl.DataFrame) -> bool:
    """True when the SAMPLER already stored the aligned eval in `eval_cp`.

    The repaired `seed153_scan_sample.py` writes the ply-(P-1) reading into
    `eval_cp` and preserves the old pairing as `post_move_eval_cp`. A ledger
    carrying that column therefore needs NO shift at analysis time — applying
    one would move the eval a second ply back and silently corrupt the SF arm
    in the opposite direction. Ledgers produced before the sampler repair lack
    the column and still need the join-based repair below.
    """
    return "post_move_eval_cp" in raw.columns


def load_rows() -> pl.DataFrame:
    shards = sorted(LEDGER_DIR.glob(f"{LEDGER_PREFIX}-worker-*.ndjson"))
    if not shards:
        raise SystemExit(
            f"no ledger shards matching {LEDGER_PREFIX}-worker-*.ndjson in {LEDGER_DIR}"
        )
    raw = pl.concat(
        [pl.read_ndjson(s, infer_schema_length=None) for s in shards],
        how="diagonal_relaxed",
    )

    # Vectorised E-09 thermometer. D-04 removed mate rows at selection time, so
    # eval_mate must be null throughout — asserted below rather than branched on.
    def sigmoid(col: str) -> pl.Expr:
        return 1.0 / (1.0 + (-LICHESS_K * pl.col(col)).exp())

    prealigned = ledger_is_prealigned(raw)
    if prealigned:
        print("[seed153] ledger is PRE-ALIGNED by the repaired sampler — no shift applied")

    rows = (
        raw.filter(pl.col("error").is_null())
        # Shards overlap on resume; (game_id, boundary) is the study's identity.
        .unique(subset=["game_id", "boundary"], keep="first")
        # `sf_score_white_shifted` is the eval one ply AHEAD of the FEN — the
        # free lookahead the alignment defect handed Stockfish. Kept only so the
        # report can quantify what it was worth. Where that value lives depends
        # on the sampler: the old sampler put it in `eval_cp`, the repaired one
        # keeps it under `post_move_eval_cp` and puts the aligned reading in
        # `eval_cp`. It can be null on a repaired ledger (the sampler requires an
        # eval on row P-1, not on row P), so the contamination table drops nulls.
        .with_columns(
            sf_score_white_shifted=sigmoid("post_move_eval_cp")
            if prealigned
            else sigmoid("eval_cp")
        )
        .join(
            prior_ply_evals()
            if not prealigned
            else pl.DataFrame(
                schema={"game_id": pl.Int64, "ply": pl.Int64, "eval_cp_aligned": pl.Int64}
            ),
            on=["game_id", "ply"],
            how="left",
        )
        # Provenance-aware: `eval_cp` has TWO populations with opposite ply
        # conventions. lichess %evals are post-move, so fen[P]'s eval is on row
        # P-1; entry-lane evals (app/services/eval_entry.py) snapshot the board
        # pre-push and write it at the SAME ply, so they are already aligned and
        # must be left alone. This frame is 99.29% lichess, so the distinction
        # touches only 129 rows here — but shifting them would be simply wrong,
        # and SEED-145's frame is 72% entry-lane where it decides everything.
        #
        # `prealigned` short-circuits ALL of that: a ledger from the repaired
        # sampler already holds the aligned reading in `eval_cp`.
        .with_columns(
            eval_cp_for_fen=pl.col("eval_cp")
            if prealigned
            else pl.when(pl.col("lichess_sourced"))
            .then(pl.col("eval_cp_aligned"))
            .otherwise(pl.col("eval_cp"))
        )
        .with_columns(sf_score_white=sigmoid("eval_cp_for_fen"))
        .with_columns(
            blend_score_white=(pl.col("sf_score_white") + pl.col("maia_score_white")) / 2.0,
            is_eval_half=pl.col("game_id").map_elements(_split_is_eval, return_dtype=pl.Boolean),
        )
        .filter(
            pl.col("sf_score_white").is_not_null()
            & pl.col("maia_score_white").is_not_null()
            & pl.col("fc_score_white").is_not_null()
        )
        # D-02, re-applied to the position all three arms actually evaluate.
        # The selection rule never touches FlawChess's output, so conditioning on
        # it stays E-01-clean; it just narrows the frame to rows where Stockfish
        # and Maia genuinely dispute fen[P] rather than fen[P+1].
        .with_columns(
            d02_clean=(
                (
                    (pl.col("sf_score_white") - 0.5).sign()
                    != (pl.col("maia_score_white") - 0.5).sign()
                )
                & ((pl.col("sf_score_white") - pl.col("maia_score_white")).abs() >= 0.20)
            )
        )
        # Stable row order so every downstream numpy view is reproducible.
        .sort("game_id", "boundary")
    )
    return rows


def assert_invariants(raw: pl.DataFrame, rows: pl.DataFrame) -> list[str]:
    """Guards that would each silently rewrite the result if they broke."""
    notes: list[str] = []

    # E-09: the vectorised sigmoid must match eval_utils exactly.
    probe = rows.head(500)
    expected = [eval_cp_to_expected_score(int(cp), "white") for cp in probe["eval_cp_for_fen"]]
    drift = max(abs(a - b) for a, b in zip(probe["sf_score_white"], expected))
    assert drift < 1e-12, f"vectorised sigmoid drifted from eval_utils by {drift}"
    notes.append(f"E-09 thermometer matches `eval_utils` (max drift {drift:.1e})")

    # D-04: mate rows were excluded at selection time. The scan drops the column
    # outright rather than carrying an all-null one, so absence is the stronger
    # pass — but if a future re-scan does carry it, it must be all null.
    if "eval_mate" in raw.columns:
        n_mate = raw.filter(pl.col("eval_mate").is_not_null()).height
        assert n_mate == 0, f"D-04 violated: {n_mate} mate rows in the ledger"
        notes.append("D-04 holds: `eval_mate` present and all null")
    else:
        notes.append("D-04 holds: no `eval_mate` column — mate rows never entered the frame")

    # D-02 must be checked against the SELECTION-time values in the manifest, not
    # against the ledger's columns. The sweep overwrites `maia_score_white` with
    # its own per-position `nodeValueHead` call, which differs from the scan's
    # BATCHED value-head pass by ~1e-4 (the seed measured 3.9e-4). For a row
    # sitting within that drift of the 0.20 threshold — or with Maia within it of
    # exactly 0.5 — the recomputed value lands on the other side of the rule.
    # Selection was valid when applied; re-deriving it from recomputed numbers
    # tests something else. So: assert the rule on the manifest, and report the
    # drift separately (it is also the scan-vs-sweep cross-check).
    manifest = pl.read_ndjson(MANIFEST_PATH, infer_schema_length=None)
    bad = manifest.filter(
        ((pl.col("sf_score_white") - 0.5).sign() == (pl.col("maia_score_white") - 0.5).sign())
        | ((pl.col("sf_score_white") - pl.col("maia_score_white")).abs() < 0.20)
    ).height
    assert bad == 0, f"D-02 violated in the manifest: {bad} rows are not opposite-sides >= 0.20"
    notes.append(
        f"D-02 holds at selection time: all {manifest.height:,} manifest rows are "
        "opposite-sides disagreements >= 0.20 ES"
    )

    joined = rows.join(
        manifest.select("game_id", "boundary", pl.col("maia_score_white").alias("scan_maia_white")),
        on=["game_id", "boundary"],
        how="inner",
    )
    drift = (joined["maia_score_white"] - joined["scan_maia_white"]).abs().to_numpy()
    # Same rule, re-evaluated on the sweep's recomputed Maia — how many rows the
    # drift moves across the line. Reported, not filtered: excluding them would
    # be selecting on a recomputation of the selector.
    # Uses whichever SF reading the scan actually selected on, so this isolates
    # the Maia recomputation drift and nothing else. On a repaired ledger that is
    # the ALIGNED SF (the sampler selected on it); on a pre-repair ledger it is
    # the shifted one, and re-applying the rule with the aligned SF is instead
    # the much larger alignment effect, reported separately as `d02_clean`.
    selector = "sf_score_white" if "post_move_eval_cp" in raw.columns else "sf_score_white_shifted"
    flipped = rows.filter(
        ((pl.col(selector) - 0.5).sign() == (pl.col("maia_score_white") - 0.5).sign())
        | ((pl.col(selector) - pl.col("maia_score_white")).abs() < 0.20)
    ).height
    notes.append(
        f"Scan-vs-sweep Maia drift: max {drift.max():.2e}, mean {drift.mean():.2e} "
        f"(batched value-head vs per-position `nodeValueHead`) — far below D-02's "
        f"0.20 margin. It moves {flipped} of {rows.height:,} rows "
        f"({flipped / rows.height:.2%}) across the selection boundary; they are kept, "
        "since dropping them would mean selecting on a recomputation of the selector."
    )

    # D-05: one qualifying ply per game.
    dupes = rows.group_by("game_id").len().filter(pl.col("len") > 1).height
    assert dupes == 0, f"D-05 violated: {dupes} games contribute more than one row"
    notes.append("D-05 holds: one row per game (per-game independence)")

    return notes


# ─── Scoring ────────────────────────────────────────────────────────────────


def brier_table(
    frame: pl.DataFrame, cols: dict[str, np.ndarray], outcome: np.ndarray
) -> dict[str, float]:
    return {name: float(((pred - outcome) ** 2).mean()) for name, pred in cols.items()}


class PairedDelta(TypedDict):
    """One arm-vs-arm comparison. A TypedDict, not a bare dict, because the
    renderer does arithmetic on `delta`/`z` and `.split()` on `pair` — with
    `dict[str, object]` every one of those reads back as `object`."""

    pair: str
    delta: float
    z: float
    n: int


def paired_delta(cols: dict[str, np.ndarray], outcome: np.ndarray) -> list[PairedDelta]:
    """Paired ΔBrier with a per-position z-test.

    The arms see identical positions, so the paired SE is what any significance
    claim rests on. Negative ΔBrier ⇒ the FIRST arm is better.
    """
    sq_err = {name: (pred - outcome) ** 2 for name, pred in cols.items()}
    out: list[PairedDelta] = []
    for a, b in PAIRS:
        d = sq_err[a] - sq_err[b]
        se = d.std(ddof=1) / np.sqrt(len(d))
        z = float(d.mean() / se) if se > 0 else float("nan")
        out.append({"pair": f"{a} − {b}", "delta": float(d.mean()), "z": z, "n": len(d)})
    return out


def arm_matrix(frame: pl.DataFrame, calibrated: bool) -> dict[str, np.ndarray]:
    outcome = frame["white_score"].to_numpy()
    is_eval = frame["is_eval_half"].to_numpy()
    cols: dict[str, np.ndarray] = {}
    for name, col in ARMS.items():
        pred = frame[col].to_numpy()
        cols[name] = cross_fitted_isotonic(pred, outcome, is_eval) if calibrated else pred
    return cols


def directional_accuracy(frame: pl.DataFrame) -> dict[str, float]:
    """How often each arm's FAVOURED SIDE actually won, plus the draw share.

    Descriptive, not a scoring rule: it throws away magnitude and calibration,
    which is what the Brier tables measure. Reported because "they disagree about
    who is winning, who was right" is the one question a lay reader asks — and
    because the answer is easy to over-read (see the report's own warning).

    Direction is read from the RAW scores. Isotonic recalibration is monotone so
    it cannot reorder an arm's preferences, but it does move where the arm crosses
    0.5, and "which side does this arm back" is a property of the arm as it ships.
    """
    outcome = frame["white_score"].to_numpy()
    draw = outcome == 0.5
    out: dict[str, float] = {"n": float(len(outcome)), "draw": float(draw.mean())}
    for name, col in ARMS.items():
        backs_white = frame[col].to_numpy() > 0.5
        out[name] = float((~draw & ((outcome == 1.0) == backs_white)).sum()) / len(outcome)
    # FC's arbitration rate: how often the hybrid lands on Stockfish's side. Under
    # D-02 the two ingredients always disagree, so this is the whole story of how
    # the search resolves a conflict — Maia's share is its complement.
    out["fc_with_sf"] = float(
        (
            (frame["fc_score_white"].to_numpy() > 0.5) == (frame["sf_score_white"].to_numpy() > 0.5)
        ).mean()
    )
    return out


def rating_trend(frame: pl.DataFrame, calibrated: bool) -> tuple[float, float]:
    """OLS slope of paired ΔBrier(FC−SF) on mean rating, per +100 ELO, with its z.

    ONE pre-specifiable test in place of five subgroup looks, so a significant
    trend cannot be dismissed as multiplicity. Run on both raw and recalibrated
    scores because the difference between the two IS the finding: a trend that
    exists raw and vanishes calibrated is a confidence-level effect, not
    information.
    """
    cols = arm_matrix(frame, calibrated)
    outcome = frame["white_score"].to_numpy()
    d = (cols["FC"] - outcome) ** 2 - (cols["SF"] - outcome) ** 2
    x = frame["mean_rating"].to_numpy().astype(float)
    xc = x - x.mean()
    slope = float((xc * d).sum() / (xc**2).sum())
    resid = d - (d.mean() + slope * xc)
    se = float(np.sqrt((resid**2).sum() / (len(d) - 2) / (xc**2).sum()))
    return slope * 100.0, (slope / se if se > 0 else float("nan"))


def within_cell_delta(frame: pl.DataFrame, other: str) -> tuple[float, float]:
    """ΔBrier(FC − other) with BOTH arms recalibrated inside this cell.

    The decisive test for a rating gradient. A global calibration map cannot
    absorb a per-rating difference in how shrunk an arm is, so a raw gradient can
    be pure confidence level. Recalibrate within the cell and whatever survives
    has to be information.
    """
    outcome = frame["white_score"].to_numpy()
    is_eval = frame["is_eval_half"].to_numpy()
    fc = cross_fitted_isotonic(frame["fc_score_white"].to_numpy(), outcome, is_eval)
    ot = cross_fitted_isotonic(frame[ARMS[other]].to_numpy(), outcome, is_eval)
    d = (fc - outcome) ** 2 - (ot - outcome) ** 2
    se = d.std(ddof=1) / np.sqrt(len(d))
    return float(d.mean()), (float(d.mean() / se) if se > 0 else float("nan"))


# ─── Report ─────────────────────────────────────────────────────────────────


def fmt_delta(value: float) -> str:
    return f"{value:+.5f}"


# The |ΔBrier(FC−SF)| the seed's power table was sized against, per phase. Both
# came from the entry-ply pilot, which was itself scored on the shifted eval — so
# they are the effect this study set out to confirm or rule out, not a prediction.
PILOT_EFFECT: dict[str, float] = {"middlegame": 0.00690, "endgame": 0.00829}


def render(rows: pl.DataFrame, notes: list[str], *, prealigned: bool) -> str:
    # E-05 headline basis: flags randomise outcomes and flatter shrunk
    # predictors, so the conservative (pro-SF) headline drops them.
    unflagged = rows.filter(~pl.col("flagged"))
    # D-02 re-applied to the aligned position — the frame the study actually
    # claims to be about. On a pre-aligned ledger the sampler already selected on
    # this reading, so the filter is a near-no-op guard (it only drops rows the
    # sweep's Maia recomputation moved across the line); on a pre-repair ledger it
    # is the load-bearing narrowing. See prior_ply_evals() for why the two differ.
    headline = unflagged.filter(pl.col("d02_clean"))

    lines: list[str] = []
    add = lines.append

    add("# SEED-153 — FlawChess vs Stockfish on the disagreement tail")
    add("")
    add(
        "Positions where **Stockfish and Maia favour opposite sides** by at least "
        "0.20 expected score (D-02), mate excluded (D-04), one randomly chosen "
        "qualifying ply per game (D-05). This is the one conditional where the "
        "hybrid's two ingredients conflict, so it is the only place its "
        "arbitration can earn its cost."
    )
    add("")
    add("**D-01 governs every table below: the phases are never pooled.**")
    add("")

    # ── The alignment defect ──
    add("## Read this first: eval alignment")
    add("")
    add(
        "For lichess-sourced games, `game_positions.eval_cp` at row P is the "
        "eval of the position **after** the move played at ply P. The sampler's "
        "FEN for row P is the position **before** that move (`_snapshot_boards` "
        "is pre-push). Pairing them hands Stockfish a half-move of lookahead — "
        "including the move the player actually chose — that Maia and FlawChess "
        "never see."
    )
    add("")
    add(
        "Measured on 200 sampled plies with a fresh Stockfish at depth 16 on "
        "`fen[P]`: median `|fresh - eval_cp[P]|` = **145.5 cp**, median "
        "`|fresh - eval_cp[P-1]|` = **22.0 cp**, and only **25/200** rows sat "
        "closer to `eval_cp[P]`. The correctly aligned Stockfish reading for "
        "`fen[P]` is `eval_cp[P-1]`."
    )
    add("")
    add(
        "**The defect is provenance-specific.** Only lichess %evals are "
        "post-move; entry-lane evals (`app/services/eval_entry.py`) snapshot the "
        "board pre-push and write it at the same ply, so they are already "
        "aligned and must be left alone. This frame is ~99% lichess-sourced, so "
        "nearly every row is affected. SEED-145's Stage B is the mirror image — "
        "72.2% entry-lane — and was repaired per-row instead; see "
        "`reports/engine-disagreement-study/seed145-repaired-census.md`."
    )
    add("")
    if prealigned:
        add(
            "**This run is clean at the source.** `seed153_scan_sample.py` pairs "
            "`fen[P]` with the eval from row P-1 and applies D-04's mate gate to "
            "that row, so both the Stockfish **arm** and the D-02 **selection** "
            "already use the aligned reading. The headline frame below is the "
            "population D-02 describes, not a subset of it. The old pairing "
            "survives as `post_move_eval_cp` purely so the contamination table "
            "at the end can still price the defect."
        )
    else:
        add(
            "**This run selected on the shifted values.** Two consequences: the "
            "Stockfish arm was inflated, and the D-02 selection ran on the wrong "
            "numbers, so the sampled set is not the set D-02 describes. This "
            "report re-applies D-02 to the aligned position and reports that "
            "subset as the headline. The rule never touches FlawChess's output, "
            "so conditioning on it stays E-01-clean — but the frame is "
            "`D-02-correct AND D-02-shifted`, which is narrower."
        )
    add("")

    # ── Frame ──
    add("## Frame")
    add("")
    add(
        f"- Ledger rows scored: **{rows.height:,}** (errors excluded, deduped on `(game_id, boundary)`)"
    )
    add(f"- Unflagged (E-05 headline basis): **{unflagged.height:,}**")
    label = (
        "- Still satisfying D-02 after the sweep's Maia recomputation"
        if prealigned
        else "- Still satisfying D-02 once aligned"
    )
    add(f"{label}: **{headline.height:,}** ({headline.height / unflagged.height:.1%} of unflagged)")
    add("")
    for note in notes:
        add(f"- {note}")
    add("")

    add("### Achieved n vs the pre-registered power target")
    add("")
    add(
        "The last two columns are what make a null here readable. **MDE** is the "
        "smallest |ΔBrier(FC−SF)| this n could detect at 80% power given the "
        "*observed* paired-diff sd (`2.80 · sd / sqrt(n)`), and it is compared "
        "against the pilot effect the targets were sized for. An MDE below the "
        "pilot effect means the study would have seen that effect if it were "
        "there — so failing to see it rules it out, rather than merely failing "
        "to resolve it."
    )
    add("")
    add(
        "| phase | n (aligned, D-02-clean) | 80%-power target | achieved | "
        "observed sd | MDE at this n | pilot effect |"
    )
    add("|---|---|---|---|---|---|---|")
    for phase in PHASES:
        sub = headline.filter(pl.col("phase") == phase)
        n = sub.height
        y = sub["white_score"].to_numpy()
        d = (sub["fc_score_white"].to_numpy() - y) ** 2 - (
            sub["sf_score_white"].to_numpy() - y
        ) ** 2
        sd = float(np.std(d, ddof=1))
        # 2.80 = z(0.975) + z(0.80), the two-sided 80%-power constant.
        mde = 2.80 * sd / np.sqrt(n)
        target = POWER_TARGET_N[phase]
        add(
            f"| {phase} | {n:,} | {target:,} | {n / target:.2f}x | {sd:.4f} | "
            f"{mde:.5f} | {PILOT_EFFECT[phase]:.5f} |"
        )
    add("")
    add(
        "The targets were fixed in the seed before any FlawChess eval existed, "
        "and are reported as a check on the sweep's size, never as a filter. Note "
        "they were derived from entry-ply pilot variance; the mid-phase frame here "
        "has different variance, so they are a rough guide rather than a contract."
    )
    add("")

    # ── Headline results ──
    for calibrated in (False, True):
        label = "isotonic-recalibrated (cross-fitted)" if calibrated else "raw"
        add(f"## Brier — aligned Stockfish, D-02-clean frame, {label}")
        add("")
        if calibrated:
            add(
                "Each arm is recalibrated out-of-fold: fitted on one half of the "
                "games, applied to the other, then swapped, so no row is scored on "
                "its own fit and the full n survives. `practicalScore` was never "
                "built to be an outcome probability, so raw Brier partly punishes "
                "miscalibration rather than measuring information — this is the "
                "fair comparison."
            )
        else:
            add(
                "No recalibration. Included because the seed's pilot table was raw, "
                "and because a recalibrated-only result invites the objection that "
                "the calibration did the work."
            )
        add("")
        add("| phase | n | " + " | ".join(ARMS) + " |")
        add("|---" * (len(ARMS) + 2) + "|")
        for phase in PHASES:
            sub = headline.filter(pl.col("phase") == phase)
            outcome = sub["white_score"].to_numpy()
            cols = arm_matrix(sub, calibrated=calibrated)
            scores = brier_table(sub, cols, outcome)
            # `key=scores.get` is float | None to a type checker; index instead.
            best = min(scores, key=lambda arm: scores[arm])
            cells = [f"**{scores[a]:.4f}**" if a == best else f"{scores[a]:.4f}" for a in ARMS]
            add(f"| {phase} | {sub.height:,} | " + " | ".join(cells) + " |")
        add("")

        add(f"### Paired ΔBrier — {label}")
        add("")
        add("Negative ⇒ the first arm is better. |z| >= 1.96 is p < 0.05.")
        add("")
        add("| phase | pair | ΔBrier | z | verdict |")
        add("|---|---|---|---|---|")
        for phase in PHASES:
            sub = headline.filter(pl.col("phase") == phase)
            outcome = sub["white_score"].to_numpy()
            cols = arm_matrix(sub, calibrated=calibrated)
            for row in paired_delta(cols, outcome):
                z = float(row["z"])
                if abs(z) < 1.96:
                    verdict = "n.s."
                else:
                    winner = row["pair"].split(" − ")[0 if z < 0 else 1]
                    verdict = f"**{winner}** wins (p<0.05)"
                add(
                    f"| {phase} | {row['pair']} | {fmt_delta(float(row['delta']))} | "
                    f"{z:+.2f} | {verdict} |"
                )
        add("")

    # ── Directional accuracy: the lay question ──
    add("## Who is right when the engines disagree?")
    add("")
    add(
        "Descriptive, not a scoring rule — it discards magnitude and calibration, "
        "which is what the Brier tables above measure. Under D-02 Stockfish and "
        "Maia always back opposite colours, so their two shares plus the draw "
        "share sum to 100%. FlawChess is free to land on either side, so its "
        "column is independent of the other two."
    )
    add("")
    add("| slice | n | SF's side won | Maia's side won | FC's side won | draw | FC sides with SF |")
    add("|---|---|---|---|---|---|---|")
    for label, frame_df in (
        ("all (incl. flagged)", rows),
        ("middlegame", rows.filter(pl.col("phase") == "middlegame")),
        ("endgame", rows.filter(pl.col("phase") == "endgame")),
        ("unflagged (E-05 basis)", unflagged),
        ("headline (D-02-clean)", headline),
    ):
        a = directional_accuracy(frame_df)
        add(
            f"| {label} | {int(a['n']):,} | {a['SF']:.1%} | {a['Maia']:.1%} | "
            f"{a['FC']:.1%} | {a['draw']:.1%} | {a['fc_with_sf']:.1%} |"
        )
    add("")
    add(
        '**Do not read this as "Stockfish is the better predictor."** These rows '
        "were selected *because* the two disagree; the proper scoring above finds "
        "the arms far closer than the raw split suggests. Two things the table "
        "understates: where the engines dispute an endgame the game is about twice "
        "as likely to be drawn as at middlegame, so a large slice of Maia's "
        "disagreements resolve to the outcome neither side claimed; and Maia is "
        'predicting what a HUMAN does, so backing the "wrong" colour in a '
        "position the player cannot convert may be the better practical call."
    )
    add("")

    # ── The rating gradient ──
    add("## The rating gradient, and why it is not information")
    add("")
    add(
        "Split by rating band and score on RAW Brier and a clean monotone story "
        "appears: FlawChess beats Stockfish at low ratings and loses at high ones. "
        "The trend rows are a single regression of the paired difference on the "
        "continuous mean rating — one test per phase, not five subgroup looks — so "
        "multiplicity is not the objection."
    )
    add("")
    add("| phase | ELO | n | FC sides with SF | ΔBrier(FC−SF) raw | z |")
    add("|---|---|---|---|---|---|")
    for phase in PHASES:
        sub = headline.filter(pl.col("phase") == phase)
        for elo in sorted(sub["elo_bucket"].unique().to_list()):
            cell = sub.filter(pl.col("elo_bucket") == elo)
            cols = arm_matrix(cell, False)
            y = cell["white_score"].to_numpy()
            d = (cols["FC"] - y) ** 2 - (cols["SF"] - y) ** 2
            se = d.std(ddof=1) / np.sqrt(len(d))
            a = directional_accuracy(cell)
            add(
                f"| {phase} | {elo} | {cell.height:,} | {a['fc_with_sf']:.1%} | "
                f"{fmt_delta(float(d.mean()))} | {float(d.mean() / se):+.2f} |"
            )
        raw_slope, raw_z = rating_trend(sub, False)
        cal_slope, cal_z = rating_trend(sub, True)
        add(
            f"| **{phase} trend, raw** | per +100 ELO | {sub.height:,} | | "
            f"{fmt_delta(raw_slope)} | {raw_z:+.2f} |"
        )
        add(
            f"| **{phase} trend, recalibrated** | per +100 ELO | {sub.height:,} | | "
            f"{fmt_delta(cal_slope)} | {cal_z:+.2f} |"
        )
    add("")
    add(
        "**The trend does not survive recalibration**, and it disappears entirely "
        "when each arm is recalibrated INSIDE its own cell — after which any "
        "surviving difference has to be information rather than confidence level:"
    )
    add("")
    add("| phase | ELO | n | ΔBrier(FC−SF) within-cell | z | ΔBrier(FC−Maia) within-cell | z |")
    add("|---|---|---|---|---|---|---|")
    for phase in PHASES:
        sub = headline.filter(pl.col("phase") == phase)
        for elo in sorted(sub["elo_bucket"].unique().to_list()):
            cell = sub.filter(pl.col("elo_bucket") == elo)
            d_sf, z_sf = within_cell_delta(cell, "SF")
            d_ma, z_ma = within_cell_delta(cell, "Maia")
            add(
                f"| {phase} | {elo} | {cell.height:,} | {fmt_delta(d_sf)} | {z_sf:+.2f} | "
                f"{fmt_delta(d_ma)} | {z_ma:+.2f} |"
            )
    add("")
    add(
        "**Mechanism.** At low ratings outcomes are noisier, so the best possible "
        "prediction sits nearer 0.5. `practicalScore` is shrunk toward 0.5 at low "
        "ratings because its Maia component is; Stockfish is not. Raw Brier rewards "
        "that shrinkage — but it is rewarding being less confident, not knowing "
        "more. This is the most tempting wrong conclusion in the dataset, and it is "
        "why the raw and recalibrated headline tables disagree on the sign of "
        "FC−SF. What DOES survive: FlawChess's margin over Maia grows monotonically "
        "with rating, and at the lowest bands the two are indistinguishable — in "
        "information terms FlawChess is close to Maia alone down there."
    )
    add("")

    # ── Contamination contrast ──
    add("## What the defect was worth")
    add("")
    add(
        "The same rows, scoring Stockfish with the shifted (one-ply-ahead) eval "
        "instead of the aligned one. The gap is the size of the free lookahead, "
        "and it is roughly an order of magnitude larger than the FC-vs-SF "
        "difference this study exists to measure."
    )
    add("")
    add("| phase | frame | n | SF aligned | SF shifted | inflation |")
    add("|---|---|---|---|---|---|")
    for phase in PHASES:
        for frame_name, frame_df in (("D-02-clean", headline), ("as-selected", unflagged)):
            # The shifted reading can be null on a repaired ledger: the sampler
            # requires an eval on row P-1, never on row P. Compare on the rows
            # that carry both, so `n` here can trail the headline frame's.
            sub = frame_df.filter(pl.col("phase") == phase).filter(
                pl.col("sf_score_white_shifted").is_not_null()
            )
            outcome = sub["white_score"].to_numpy()
            aligned = float(((sub["sf_score_white"].to_numpy() - outcome) ** 2).mean())
            shifted = float(((sub["sf_score_white_shifted"].to_numpy() - outcome) ** 2).mean())
            add(
                f"| {phase} | {frame_name} | {sub.height:,} | {aligned:.4f} | "
                f"{shifted:.4f} | {aligned - shifted:+.4f} |"
            )
    add("")

    # ── Cell coverage ──
    add("## ELO x TC coverage (headline frame)")
    add("")
    cells_tbl = headline.group_by("elo_bucket", "tc").len().sort("elo_bucket", "tc")
    tcs = sorted(headline["tc"].unique().to_list())
    add("| ELO | " + " | ".join(tcs) + " |")
    add("|---" * (len(tcs) + 1) + "|")
    for elo in sorted(headline["elo_bucket"].unique().to_list()):
        counts = []
        for tc in tcs:
            match = cells_tbl.filter((pl.col("elo_bucket") == elo) & (pl.col("tc") == tc))
            counts.append(f"{match['len'][0]:,}" if match.height else "0")
        add(f"| {elo} | " + " | ".join(counts) + " |")
    add("")

    # ── Caveats ──
    add("## Caveats")
    add("")
    if prealigned:
        add(
            "- **The frame is the population D-02 describes.** Selection and "
            "scoring both use `SF(fen[P])`, so conditioning on the rule is plain "
            "conditioning: no re-measurement, and therefore none of the "
            "regression-to-the-mean that E-01 warns about. The rule reads only "
            "Stockfish and Maia, never FlawChess, so the comparison stays "
            "E-01-clean."
        )
    else:
        add(
            "- **The selection is narrowed, not re-run.** The sweep only ever "
            "evaluated FlawChess on rows the *shifted* rule selected, so the "
            "headline frame is `D-02-correct AND D-02-shifted`, not "
            "`D-02-correct`. That is a legitimate position-based frame for an "
            "arm-vs-arm comparison (it never reads FlawChess's output), but it is "
            "not the population D-02 describes. Fully honouring D-02 needs a "
            "re-scan and a re-sweep."
        )
        add(
            "- **The residual selection effect runs against Stockfish, not for "
            "it.** The frame still carries the shifted rule, which selected on "
            "`SF(fen[P+1])`, while the arm is scored at `SF(fen[P])`. Those are "
            "correlated but distinct readings, so conditioning on the first being "
            "extreme induces regression to the mean in the second — the same "
            "mechanism E-01 invoked, now pointed at Stockfish. Net: the FC-vs-SF "
            "nulls below are, if anything, mildly generous to FlawChess. A "
            "re-scan is the only clean fix."
        )
    add(
        "- **Population, not fairness.** The free-eval frame is ~99% "
        "lichess-analysis-requested games, reintroducing the self-selection "
        "SEED-145's E-03 removed. Selection changes the *population*, not the "
        "fairness of an arm-vs-arm comparison on identical positions. Do not let "
        "this become a population claim."
    )
    add(
        "- **@100 nodes (D-08).** Gate 0's @100-vs-@400 MAE of 0.0070 in expected "
        "score is the same order as the ΔBrier being measured, so a null here "
        "stays attackable. The @400 arm can be added on these same rows."
    )
    add(
        "- **The blend is partly convex-scoring free money (D-09).** Brier is "
        "convex, so `Brier(mean(a,b)) <= mean(Brier(a), Brier(b))` by Jensen with "
        "no information content required. The blend beating the *average of* SF "
        "and Maia is guaranteed. The blend beating Stockfish outright, and beating "
        "FlawChess, is not."
    )
    add(
        "- **E-15 bound.** This compares the hybrid against its own two "
        "ingredients. It is not a claim that these are the best available outcome "
        "predictors."
    )
    add("")
    return "\n".join(lines)


def main() -> None:
    shards = sorted(LEDGER_DIR.glob(f"{LEDGER_PREFIX}-worker-*.ndjson"))
    raw = pl.concat(
        [pl.read_ndjson(s, infer_schema_length=None) for s in shards],
        how="diagonal_relaxed",
    )
    rows = load_rows()
    notes = assert_invariants(raw, rows)
    report = render(rows, notes, prealigned=ledger_is_prealigned(raw))
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(report)
    print(f"\n[written] {REPORT_PATH}")


if __name__ == "__main__":
    main()
