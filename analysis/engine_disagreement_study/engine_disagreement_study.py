"""SEED-145 — Stockfish vs Maia vs FlawChess at the two phase boundaries.

Reads the Stage B sweep ledgers straight off disk (scripts/engine_disagreement_study/data/*.ndjson)
and reproduces the headline scoring interactively: per-arm Brier, paired ΔBrier
z-tests, reliability diagrams, and the Murphy calibration/resolution split.

Run it:  uv run --project analysis marimo edit analysis/engine_disagreement_study/engine_disagreement_study.py
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
    from plotly.subplots import make_subplots
    import polars as pl

    REPO_ROOT = Path(__file__).resolve().parents[2]
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

    LEDGER_DIR = REPO_ROOT / "scripts" / "engine_disagreement_study" / "data"
    return (
        LEDGER_DIR,
        LICHESS_K,
        eval_cp_to_expected_score,
        eval_mate_to_expected_score,
        go,
        hashlib,
        make_subplots,
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
    # The app's engine identity colors (frontend/src/lib/theme.ts: STOCKFISH_ACCENT,
    # MAIA_ACCENT, FLAWCHESS_ENGINE_ACCENT), converted oklch -> hex because plotly
    # has no oklch parser. Defined once so every figure below reads the same.
    ARM_COLORS = {
        "SF": "#2B7AD6",  # oklch(0.58 0.16 255) — blue
        "Maia": "#7D5BE6",  # oklch(0.58 0.20 290) — violet
        "FC": "#E6AC3D",  # oklch(0.78 0.14 80) — gold/amber
    }
    rows.select("boundary", "flagged", "is_eval_half").group_by(
        "boundary", "flagged", "is_eval_half"
    ).len().sort("boundary", "flagged", "is_eval_half")
    return ARMS, ARM_COLORS, rows


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
def _(ARMS, ARM_COLORS, basis, frame, go, half, make_subplots, mo, np, pl):
    # Headline plot: at endgame entry, does what an engine predicted actually
    # happen? Left panel bins each arm's prediction into five plain-language
    # buckets and shows the real average white score in that bucket; the dashed
    # line is what a perfect forecaster would show. Right panel collapses the
    # whole thing to one number per arm (Brier skill score = share of outcome
    # variance explained, vs. always guessing the base rate), because on this
    # data all three arms sit almost on the diagonal and the ranking only shows
    # up in the summary.
    _eg = frame.filter(pl.col("boundary") == "endgame")
    _y = _eg["white_score"].to_numpy()
    _base = float(((_y - _y.mean()) ** 2).mean())

    _edges = np.array([0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
    _labels = [
        "Black clearly better<br>(0.0–0.2)",
        "Black better<br>(0.2–0.4)",
        "Balanced<br>(0.4–0.6)",
        "White better<br>(0.6–0.8)",
        "White clearly better<br>(0.8–1.0)",
    ]
    _mid = [0.1, 0.3, 0.5, 0.7, 0.9]

    _fig = make_subplots(
        rows=1,
        cols=2,
        column_widths=[0.68, 0.32],
        horizontal_spacing=0.12,
        subplot_titles=(
            "What the engine said → what actually happened",
            "Predictive power (higher = better)",
        ),
    )

    _skill = {}
    for _name, _col in ARMS.items():
        _p = _eg[_col].to_numpy()
        _skill[_name] = 1.0 - float(((_p - _y) ** 2).mean()) / _base
        _idx = np.clip(np.digitize(_p, _edges) - 1, 0, len(_mid) - 1)
        _actual, _n = [], []
        for _k in range(len(_mid)):
            _m = _idx == _k
            _actual.append(float(_y[_m].mean()) if _m.any() else None)
            _n.append(int(_m.sum()))
        _fig.add_trace(
            go.Bar(
                x=_labels,
                y=_actual,
                name=_name,
                marker_color=ARM_COLORS[_name],
                customdata=_n,
                hovertemplate=(
                    "<b>%{fullData.name}</b><br>said: %{x}<br>"
                    "white actually scored %{y:.2f}<br>%{customdata:,} positions<extra></extra>"
                ),
            ),
            row=1,
            col=1,
        )

    _fig.add_trace(
        go.Scatter(
            x=_labels,
            y=_mid,
            mode="lines+markers",
            name="perfect prediction",
            line=dict(dash="dash", color="#444"),
            marker=dict(symbol="diamond", size=9, color="#444"),
            hovertemplate="perfect: %{y:.2f}<extra></extra>",
        ),
        row=1,
        col=1,
    )

    # `key=_skill.get` is float | None to a type checker; index instead.
    _order = sorted(_skill, key=lambda k: _skill[k])
    _fig.add_trace(
        go.Bar(
            x=[_skill[k] for k in _order],
            y=_order,
            orientation="h",
            marker_color=[ARM_COLORS[k] for k in _order],
            text=[f"{_skill[k]:.1%}" for k in _order],
            textposition="outside",
            showlegend=False,
            hovertemplate="<b>%{y}</b><br>explains %{x:.1%} of the outcome<extra></extra>",
        ),
        row=1,
        col=2,
    )

    _fig.update_yaxes(
        title_text="actual white score (1 = white won)",
        range=[0, 1],
        row=1,
        col=1,
    )
    _fig.update_xaxes(title_text="the engine's call at endgame entry", row=1, col=1)
    _fig.update_xaxes(
        title_text="share of outcome variance explained",
        tickformat=".0%",
        range=[0, max(_skill.values()) * 1.25],
        row=1,
        col=2,
    )
    # The legend lives under the chart: a horizontal legend above the plot
    # collided with both the figure title and the two subplot titles.
    _fig.update_layout(
        barmode="group",
        height=560,
        template="plotly_white",
        legend=dict(orientation="h", yanchor="top", y=-0.26, x=0.5, xanchor="center"),
        margin=dict(t=80, b=150),
        title=dict(
            text=(
                f"Endgame entry — prediction vs. reality<br>"
                f"<span style='font-size:13px;color:#666'>{_eg.height:,} positions "
                f"· {basis.value} · {half.value} split</span>"
            ),
            x=0,
            xanchor="left",
            y=0.96,
            yanchor="top",
        ),
    )
    _fig.update_annotations(selector=dict(yref="paper"), yshift=-6)

    mo.vstack(
        [
            mo.ui.plotly(_fig),
            mo.md(
                "**How to read it.** Left: group the positions by what the engine "
                "said, then look at how they really ended. Bars on the dashed line "
                "mean the engine's number meant what it said. Right: one number per "
                "engine — how much of the outcome it actually explains compared with "
                "always guessing the average result. All three are well calibrated "
                "here, so the ranking lives in the right-hand panel."
            ),
        ]
    )

    return


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
def _(ARMS, ARM_COLORS, frame, go, mo, n_bins, np, pl):
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
                    line=dict(color=ARM_COLORS[_name]),
                    marker=dict(color=ARM_COLORS[_name]),
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
