"""SEED-145 — Stockfish vs Maia vs FlawChess at the two phase boundaries.

Reads the Stage B sweep ledgers straight off disk (scripts/seed145/data/*.ndjson)
and reproduces the headline scoring interactively: per-arm Brier, paired ΔBrier
z-tests, reliability diagrams, and the Murphy calibration/resolution split.

Run it:  uv run --project analysis marimo edit analysis/notebooks/engine_disagreement_study/engine_disagreement_study.py
"""

import marimo

__generated_with = "0.24.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo

    return (mo,)


@app.cell
def _():
    import hashlib
    import sys
    from pathlib import Path

    import numpy as np
    import plotly.graph_objects as go
    import polars as pl

    REPO_ROOT = Path(__file__).resolve().parents[3]
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))

    # The project's own thermometer — never hand-roll the sigmoid (E-09). Resolved
    # at runtime via the sys.path insert above; PyCharm cannot see that, and the
    # analysis module deliberately does not depend on the app package, so the
    # inspection is suppressed rather than the import removed. A copied constant
    # here is exactly the drift the assert cell below exists to catch.
    # noinspection PyUnresolvedReferences
    from app.services.eval_utils import (
        LICHESS_K,
        eval_cp_to_expected_score,
        eval_mate_to_expected_score,
    )

    LEDGER_DIR = REPO_ROOT / "scripts" / "seed145" / "data"
    return (
        LEDGER_DIR,
        LICHESS_K,
        eval_cp_to_expected_score,
        eval_mate_to_expected_score,
        go,
        hashlib,
        np,
        pl,
    )


@app.cell
def _(mo):
    mo.md(r"""
    # SEED-145 — who predicts the outcome best?

    Three judges at two board-defined moments (middlegame entry, endgame entry):
    **Stockfish** (objective), **Maia** (pure human model), **FlawChess
    `practicalScore`** (the hybrid). Everything is scored against the real game
    result, white-perspective, draws as 0.5.
    """)
    return


@app.cell
def _(LEDGER_DIR, mo):
    # Ledger families in the data dir, e.g. `stage_b_ledger` (main sweep) and
    # `t2_ledger` (the policy-temperature 2.0 variant). Shards are per-worker.
    _prefixes = sorted({p.name.split("-worker-")[0] for p in LEDGER_DIR.glob("*-worker-*.ndjson")})
    ledger_prefix = mo.ui.dropdown(
        options=_prefixes,
        value="stage_b_ledger" if "stage_b_ledger" in _prefixes else _prefixes[0],
        label="Ledger family",
    )
    ledger_prefix
    return (ledger_prefix,)


@app.cell
def _(LEDGER_DIR, ledger_prefix, mo, pl):
    _shards = sorted(LEDGER_DIR.glob(f"{ledger_prefix.value}-worker-*.ndjson"))
    # infer_schema_length=None reads the whole shard before fixing dtypes. Without
    # it, a shard whose first 100 rows are all decisive infers white_score as Int64
    # and then dies on the first draw (0.5).
    # diagonal_relaxed: shards written by different sweep revisions can differ in
    # column set (e.g. `ort_backend` was added mid-study) and in inferred dtype
    # for all-null columns.
    raw = pl.concat(
        [pl.read_ndjson(s, infer_schema_length=None) for s in _shards],
        how="diagonal_relaxed",
    )
    mo.md(f"Loaded **{raw.height:,}** rows from **{len(_shards)}** shards.")
    return (raw,)


@app.cell
def _(LICHESS_K, hashlib, pl, raw):
    def _eval_half(game_id: int) -> bool:
        """md5(game_id) parity — the study's fit/eval split (gate0_null_baselines.py)."""
        return int(hashlib.md5(f"{game_id}|split".encode()).hexdigest(), 16) % 2 == 0

    # Stockfish's white-POV expected score. Mate never routes through the sigmoid
    # (eval_utils D-02): it maps to exactly 1.0 / 0.0. Vectorised here rather than
    # calling eval_utils per row; the next cell asserts the two agree.
    _sf_white = (
        pl.when(pl.col("eval_mate").is_not_null())
        .then(pl.when(pl.col("eval_mate") > 0).then(1.0).otherwise(0.0))
        .otherwise(1.0 / (1.0 + (-LICHESS_K * pl.col("eval_cp")).exp()))
    )

    rows = (
        raw.filter(pl.col("error").is_null())
        # Shards overlap on resume; (game_id, boundary) is the study's identity.
        .unique(subset=["game_id", "boundary"], keep="first")
        .with_columns(
            sf_score_white=_sf_white,
            is_eval_half=pl.col("game_id").map_elements(_eval_half, return_dtype=pl.Boolean),
        )
        .filter(
            pl.col("sf_score_white").is_not_null()
            & pl.col("maia_score_white").is_not_null()
            & pl.col("fc_score_white").is_not_null()
        )
    )

    ARMS = {"SF": "sf_score_white", "Maia": "maia_score_white", "FC": "fc_score_white"}
    rows.select("boundary", "flagged", "is_eval_half").group_by(
        "boundary", "flagged", "is_eval_half"
    ).len().sort("boundary", "flagged", "is_eval_half")
    return ARMS, rows


@app.cell
def _(eval_cp_to_expected_score, eval_mate_to_expected_score, pl, rows):
    # Guard: the vectorised thermometer above must match app/services/eval_utils.py
    # exactly. A silent drift here would rewrite the SF arm's whole result.
    _probe = rows.filter(pl.col("eval_cp").is_not_null()).head(500)
    _expected = [eval_cp_to_expected_score(int(cp), "white") for cp in _probe["eval_cp"]]
    assert max(abs(a - b) for a, b in zip(_probe["sf_score_white"], _expected)) < 1e-12, (
        "vectorised sigmoid drifted from eval_utils"
    )

    _mate = rows.filter(pl.col("eval_mate").is_not_null()).head(200)
    if _mate.height:
        assert all(
            abs(a - eval_mate_to_expected_score(int(m), "white")) < 1e-12
            for a, m in zip(_mate["sf_score_white"], _mate["eval_mate"])
        ), "mate mapping drifted from eval_utils"
    "thermometer matches eval_utils ✓"
    return


@app.cell
def _(mo):
    basis = mo.ui.radio(
        options={
            "Headline (unflagged only)": "headline",
            "With flags": "with_flags",
        },
        value="Headline (unflagged only)",
        label="Termination basis",
    )
    half = mo.ui.radio(
        options={"Eval half only": "eval", "All rows": "all"},
        value="Eval half only",
        label="Split",
    )
    n_bins = mo.ui.slider(5, 25, value=12, label="Reliability bins")
    mo.hstack([basis, half, n_bins], justify="start", gap=2)
    return basis, half, n_bins


@app.cell
def _(basis, half, pl, rows):
    frame = rows
    if basis.value == "headline":
        # E-05: flags randomise outcomes and flatter shrunk predictors, so the
        # conservative (pro-SF) headline drops them.
        frame = frame.filter(~pl.col("flagged"))
    if half.value == "eval":
        frame = frame.filter(pl.col("is_eval_half"))
    return (frame,)


@app.cell
def _(ARMS, frame, mo, pl):
    _brier = (
        frame.group_by("boundary")
        .agg(
            pl.len().alias("n"),
            *[
                ((pl.col(col) - pl.col("white_score")) ** 2).mean().alias(name)
                for name, col in ARMS.items()
            ],
        )
        .sort("boundary")
    )
    mo.vstack([mo.md("### Brier (lower is better)"), _brier])
    return


@app.cell
def _(ARMS, frame, mo, np, pl):
    # Paired ΔBrier with a per-position z-test — the arms see the same positions,
    # so the paired SE is what the significance claim rests on.
    _pairs = [("SF", "Maia"), ("SF", "FC"), ("Maia", "FC")]
    _out = []
    for _boundary in sorted(frame["boundary"].unique()):
        _sub = frame.filter(pl.col("boundary") == _boundary)
        _y = _sub["white_score"].to_numpy()
        _se = {k: (_sub[c].to_numpy() - _y) ** 2 for k, c in ARMS.items()}
        for _a, _b in _pairs:
            _d = _se[_a] - _se[_b]
            _z = _d.mean() / (_d.std(ddof=1) / np.sqrt(len(_d)))
            _out.append(
                {
                    "boundary": _boundary,
                    "pair": f"{_a} − {_b}",
                    "ΔBrier": round(float(_d.mean()), 5),
                    "z": round(float(_z), 2),
                    "n": len(_d),
                }
            )
    mo.vstack(
        [
            mo.md("### Paired ΔBrier (negative ⇒ the first arm is better)"),
            pl.DataFrame(_out),
        ]
    )
    return


@app.cell
def _(ARMS, frame, go, mo, n_bins, np, pl):
    # Reliability diagram: does an arm's stated probability mean what it says?
    # A well-calibrated arm sits on the diagonal; an arm shrunk toward 50%
    # (the suspicion about the hybrid) shows an S that is flatter than y = x.
    _figs = []
    for _boundary in sorted(frame["boundary"].unique()):
        _sub = frame.filter(pl.col("boundary") == _boundary)
        _y = _sub["white_score"].to_numpy()
        _edges = np.linspace(0.0, 1.0, n_bins.value + 1)
        _fig = go.Figure()
        _fig.add_trace(
            go.Scatter(
                x=[0, 1],
                y=[0, 1],
                mode="lines",
                name="perfect",
                line=dict(dash="dot", color="#888"),
            )
        )
        for _name, _col in ARMS.items():
            _p = _sub[_col].to_numpy()
            _idx = np.clip(np.digitize(_p, _edges) - 1, 0, n_bins.value - 1)
            _px, _py, _n = [], [], []
            for _k in range(n_bins.value):
                _m = _idx == _k
                if _m.sum() >= 30:  # thin bins are noise, not calibration
                    _px.append(_p[_m].mean())
                    _py.append(_y[_m].mean())
                    _n.append(int(_m.sum()))
            _fig.add_trace(
                go.Scatter(
                    x=_px,
                    y=_py,
                    mode="lines+markers",
                    name=_name,
                    customdata=_n,
                    hovertemplate="pred %{x:.3f}<br>actual %{y:.3f}<br>n=%{customdata}<extra>%{fullData.name}</extra>",
                )
            )
        _fig.update_layout(
            title=f"Reliability — {_boundary} entry",
            xaxis_title="predicted white score",
            yaxis_title="observed white score",
            height=420,
            template="plotly_white",
        )
        _figs.append(mo.ui.plotly(_fig))
    mo.vstack(_figs)
    return


@app.cell
def _(ARMS, frame, mo, n_bins, np, pl):
    # Murphy decomposition of MSE over the same bins:
    #     Brier = reliability − resolution + uncertainty
    # reliability  = miscalibration (fixable by recalibration — isotonic/Platt)
    # resolution   = how much real signal the arm carries (NOT fixable)
    # uncertainty  = Var(outcome), identical for every arm on a given frame
    # If an arm's deficit is all reliability, the negative result is a thermometer
    # problem. If it is resolution, the arm genuinely knows less.
    _out = []
    for _boundary in sorted(frame["boundary"].unique()):
        _sub = frame.filter(pl.col("boundary") == _boundary)
        _y = _sub["white_score"].to_numpy()
        _ybar = _y.mean()
        _unc = float(((_y - _ybar) ** 2).mean())
        _edges = np.linspace(0.0, 1.0, n_bins.value + 1)
        for _name, _col in ARMS.items():
            _p = _sub[_col].to_numpy()
            _idx = np.clip(np.digitize(_p, _edges) - 1, 0, n_bins.value - 1)
            _rel = _res = 0.0
            for _k in range(n_bins.value):
                _m = _idx == _k
                if not _m.any():
                    continue
                _w = _m.sum() / len(_y)
                _rel += _w * (_p[_m].mean() - _y[_m].mean()) ** 2
                _res += _w * (_y[_m].mean() - _ybar) ** 2
            _out.append(
                {
                    "boundary": _boundary,
                    "arm": _name,
                    "reliability↓": round(_rel, 5),
                    "resolution↑": round(_res, 5),
                    "uncertainty": round(_unc, 5),
                    "≈Brier": round(_rel - _res + _unc, 5),
                }
            )
    mo.vstack(
        [
            mo.md("### Murphy decomposition — is the gap calibration or knowledge?"),
            pl.DataFrame(_out),
        ]
    )
    return


if __name__ == "__main__":
    app.run()
