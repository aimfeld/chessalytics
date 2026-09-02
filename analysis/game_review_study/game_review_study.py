"""SEED-157 — game-review behaviour: do players analyze their collapses?

EDA for the game-review data story. Classifies every benchmark game at the
middlegame and endgame entry boundaries (blown lead / comeback / expected /
balanced) and compares Lichess analysis-request rates across those classes with
user-stratified paired MH-weighted deltas and cluster-bootstrap CIs.

Run it:  uv run --project analysis marimo edit analysis/game_review_study/game_review_study.py
Needs:   bin/benchmark_db.sh start   (benchmark Postgres tunnel on port 5433)
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
    import sys
    from pathlib import Path

    import numpy as np
    import plotly.graph_objects as go
    import polars as pl

    REPO_ROOT = Path(__file__).resolve().parents[2]
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))

    from analysis import db

    # Canonical cohort / equal-footing / ELO-bucket SQL fragments. Imported, never
    # duplicated (CLAUDE.md: single implementation for shared filters). sql.py
    # imports only `typing`, so it is safe from analysis/.venv; the sys.path insert
    # above resolves it at runtime, which PyCharm cannot see.
    # noinspection PyUnresolvedReferences
    from scripts.benchmarks import sql as bsql

    return bsql, db, go, np, pl


@app.cell
def _(mo):
    mo.md(r"""
    # SEED-157 — do players review their losses?

    Every game is classified at a phase boundary from the **user's POV** using the
    entry eval (white-POV, sign-flipped for black):

    | class | condition |
    |---|---|
    | `blown_loss` | user held a decisive lead at entry, lost |
    | `comeback_win` | opponent held the lead, user won |
    | `held_win` | user held the lead, won |
    | `expected_loss` | opponent held the lead, user lost |
    | `blown_draw` / `comeback_draw` | same, game drawn |
    | `balanced` | \|lead\| below threshold |

    Outcome = the game **attracted an analysis request** (`lichess_evals_at IS NOT
    NULL`). Lichess records that `%eval` exists, not who requested it — never write
    "the loser requested it".

    **Ply-convention caveat (seed "Traps")**: `eval_cp` carries two ply conventions
    (lichess post-move-shifted on the analyzed arm vs entry-lane-aligned on ours),
    so classification error is differential by outcome. The threshold sweep below is
    the robustness guard; a one-ply offset rarely flips a ≥200cp class.
    """)
    return


@app.cell
def _(db, mo, pl):
    # Connection check — fails soft with instructions instead of a stack trace.
    try:
        with db.connect("benchmark") as _conn:
            counts = pl.read_database(
                "SELECT (SELECT count(*) FROM benchmark_selected_users) AS selected_users,"
                " (SELECT count(*) FROM games) AS games",
                _conn,
            )
    except Exception as _exc:
        counts = None
        mo.stop(
            True,
            mo.md(
                "**Benchmark DB unreachable** — start the tunnel first:\n\n"
                "```bash\nbin/benchmark_db.sh start\n```\n\n"
                f"`{_exc}`"
            ),
        )
    counts
    return


@app.cell
def _(mo):
    threshold_cp = mo.ui.dropdown(
        options=["200", "300", "400", "500"],
        value="200",
        label="Decisive-lead threshold (cp)",
    )
    bootstrap_reps = mo.ui.slider(0, 2000, value=0, step=250, label="Bootstrap reps (0 = point estimates only)")
    mo.hstack([threshold_cp, bootstrap_reps])
    return bootstrap_reps, threshold_cp


@app.cell
def _(bsql, db, pl):
    # One frame powering the boundary sections: one row per (game, boundary) for
    # every cohort game that reaches the boundary. Classification happens client-
    # side in polars so the threshold sweep never re-queries.
    _ELO_BUCKET_CASE = bsql.elo_bucket_case_sql(bsql.USER_ELO_AT_GAME_SQL)
    _FRAME_SQL = f"""\
    WITH {bsql.SELECTED_USERS_CTE},
    entries AS (
      SELECT game_id, phase, MIN(ply) AS entry_ply
      FROM game_positions
      WHERE phase IN (1, 2)
      GROUP BY game_id, phase
    )
    SELECT
      g.id AS game_id,
      su.user_id,
      su.tc_bucket AS tc,
      {_ELO_BUCKET_CASE} AS elo_bucket,
      g.result::text AS result,
      g.user_color::text AS user_color,
      g.termination::text AS termination,
      (g.lichess_evals_at IS NOT NULL) AS analyzed,
      e.phase,
      e.entry_ply,
      gp.eval_cp,
      gp.eval_mate
    FROM games g
    JOIN selected_users su ON su.user_id = g.user_id
    JOIN entries e ON e.game_id = g.id
    JOIN game_positions gp ON gp.game_id = g.id AND gp.ply = e.entry_ply
    WHERE {bsql.COHORT_GAME_FILTER}
      AND {bsql.EQUAL_FOOTING_PREDICATE}
    """
    with db.connect("benchmark") as _conn:
        frame_raw = pl.read_database(_FRAME_SQL, _conn)
    frame_raw.height
    return (frame_raw,)


@app.cell
def _(frame_raw, pl, threshold_cp):
    # User-POV entry lead and drama class. Mates map to ±MATE_CP so they always
    # clear any threshold.
    MATE_CP = 10_000
    _thr = int(threshold_cp.value)

    _eval_white = (
        pl.when(pl.col("eval_mate").is_not_null())
        .then(pl.col("eval_mate").sign() * MATE_CP)
        .otherwise(pl.col("eval_cp"))
    )
    _user_sign = pl.when(pl.col("user_color") == "white").then(1).otherwise(-1)
    _user_score = (
        pl.when(pl.col("result") == "1/2-1/2")
        .then(pl.lit("draw"))
        .when(
            ((pl.col("result") == "1-0") & (pl.col("user_color") == "white"))
            | ((pl.col("result") == "0-1") & (pl.col("user_color") == "black"))
        )
        .then(pl.lit("win"))
        .otherwise(pl.lit("loss"))
    )

    frame = frame_raw.with_columns(
        user_lead=(_eval_white * _user_sign),
        user_score=_user_score,
        boundary=pl.when(pl.col("phase") == 1).then(pl.lit("MG")).otherwise(pl.lit("EG")),
    ).with_columns(
        drama_class=(
            pl.when(pl.col("user_lead").is_null())
            .then(pl.lit(None))
            .when((pl.col("user_lead") >= _thr) & (pl.col("user_score") == "loss"))
            .then(pl.lit("blown_loss"))
            .when((pl.col("user_lead") <= -_thr) & (pl.col("user_score") == "win"))
            .then(pl.lit("comeback_win"))
            .when((pl.col("user_lead") >= _thr) & (pl.col("user_score") == "win"))
            .then(pl.lit("held_win"))
            .when((pl.col("user_lead") <= -_thr) & (pl.col("user_score") == "loss"))
            .then(pl.lit("expected_loss"))
            .when((pl.col("user_lead") >= _thr) & (pl.col("user_score") == "draw"))
            .then(pl.lit("blown_draw"))
            .when((pl.col("user_lead") <= -_thr) & (pl.col("user_score") == "draw"))
            .then(pl.lit("comeback_draw"))
            .otherwise(pl.lit("balanced"))
        )
    )
    frame.group_by("boundary", "drama_class").agg(
        games=pl.len(), analyzed_rate=pl.col("analyzed").mean()
    ).sort("boundary", "drama_class")
    return (frame,)


@app.cell
def _(np, pl):
    # Paired within-user contrasts, MH-weighted (the §6 pattern from the
    # two-pawns-up report): never pooled — pooling sign-flipped before
    # (feedback_paired_not_pooled_cohort_splits).
    def paired_frame(df: pl.DataFrame, cls_a: str, cls_b: str) -> pl.DataFrame:
        """Per-user (n, analyzed) counts for both classes; users with games in each."""

        def per_class(cls: str, suffix: str) -> pl.DataFrame:
            return (
                df.filter(pl.col("drama_class") == cls)
                .group_by("user_id")
                .agg(pl.len().alias(f"n{suffix}"), pl.col("analyzed").sum().alias(f"k{suffix}"))
            )

        return per_class(cls_a, "_a").join(per_class(cls_b, "_b"), on="user_id")

    def mh_delta(paired: pl.DataFrame) -> float:
        """MH-weighted mean of per-user rate differences, in percentage points."""
        w = paired["n_a"] * paired["n_b"] / (paired["n_a"] + paired["n_b"])
        d = paired["k_a"] / paired["n_a"] - paired["k_b"] / paired["n_b"]
        return float(100.0 * (w * d).sum() / w.sum())

    def cluster_bootstrap_ci(
        paired: pl.DataFrame, reps: int, seed: int = 157, alpha: float = 0.05
    ) -> tuple[float, float]:
        """Percentile CI from resampling USERS with replacement (games move with
        their user — the cluster). Vectorized: one (reps, n_users) index matrix."""
        n_a = paired["n_a"].to_numpy()
        n_b = paired["n_b"].to_numpy()
        w = n_a * n_b / (n_a + n_b)
        wd = w * (paired["k_a"].to_numpy() / n_a - paired["k_b"].to_numpy() / n_b)
        rng = np.random.default_rng(seed)
        idx = rng.integers(0, len(w), size=(reps, len(w)))
        deltas = 100.0 * wd[idx].sum(axis=1) / w[idx].sum(axis=1)
        lo, hi = np.quantile(deltas, [alpha / 2, 1 - alpha / 2])
        return float(lo), float(hi)

    return cluster_bootstrap_ci, mh_delta, paired_frame


@app.cell
def _(
    bootstrap_reps,
    cluster_bootstrap_ci,
    frame,
    mh_delta,
    mo,
    paired_frame,
    pl,
):
    # Core probe reproduction + bullet extension: the three locked contrasts,
    # per boundary x TC. Matches the seed's probe table (plus bullet).
    CONTRASTS = [
        ("blown_loss", "comeback_win"),
        ("expected_loss", "held_win"),
        ("blown_draw", "comeback_draw"),
    ]
    TCS = ["bullet", "blitz", "rapid", "classical"]

    _rows = []
    for _cls_a, _cls_b in CONTRASTS:
        for _boundary in ["MG", "EG"]:
            for _tc in TCS:
                _cell = frame.filter((pl.col("boundary") == _boundary) & (pl.col("tc") == _tc))
                _paired = paired_frame(_cell, _cls_a, _cls_b)
                if _paired.height == 0:
                    continue
                _row = {
                    "contrast": f"{_cls_a} − {_cls_b}",
                    "boundary": _boundary,
                    "tc": _tc,
                    "delta_pp": round(mh_delta(_paired), 1),
                    "users": _paired.height,
                }
                if bootstrap_reps.value:
                    _lo, _hi = cluster_bootstrap_ci(_paired, int(bootstrap_reps.value))
                    _row["ci95"] = f"[{_lo:+.1f}, {_hi:+.1f}]"
                _rows.append(_row)

    contrast_table = pl.DataFrame(_rows)
    mo.vstack([
        mo.md("## Paired MH-weighted contrasts (analysis-rate difference, pp)"),
        contrast_table,
    ])
    return


@app.cell
def _(mo):
    chart_contrast = mo.ui.dropdown(
        options={
            "blown loss − comeback win": "blown_loss|comeback_win",
            "expected loss − held win": "expected_loss|held_win",
            "blown draw − comeback draw": "blown_draw|comeback_draw",
        },
        value="blown loss − comeback win",
        label="Contrast",
    )
    chart_boundary = mo.ui.radio(options=["MG", "EG"], value="MG", label="Boundary")
    mo.hstack([chart_contrast, chart_boundary])
    return chart_boundary, chart_contrast


@app.cell
def _(
    bootstrap_reps,
    chart_boundary,
    chart_contrast,
    cluster_bootstrap_ci,
    frame,
    go,
    mh_delta,
    mo,
    paired_frame,
    pl,
):
    # Δpp per (ELO bucket × TC): the per-ELO paired cuts from the locked EDA scope.
    # TC colors match the two-pawns-up story palette; bullet's purple was added and
    # the 4-hue set passes the dataviz validator (CVD ΔE 28.7 worst adjacent pair).
    TC_COLORS = {
        "bullet": "#7C3AED",
        "blitz": "#C97A00",
        "rapid": "#3B82F6",
        "classical": "#166534",
    }
    ELO_BUCKETS = [800, 1200, 1600, 2000, 2400]
    # Below this many paired users the MH point estimate is noise, not signal.
    MIN_USERS_PER_CELL = 50

    _cls_a, _cls_b = chart_contrast.value.split("|")
    fig_elo_tc = go.Figure()
    for _tc, _color in TC_COLORS.items():
        _xs, _ys, _users, _lo_arm, _hi_arm = [], [], [], [], []
        for _elo in ELO_BUCKETS:
            _paired = paired_frame(
                frame.filter(
                    (pl.col("boundary") == chart_boundary.value)
                    & (pl.col("tc") == _tc)
                    & (pl.col("elo_bucket") == _elo)
                ),
                _cls_a,
                _cls_b,
            )
            if _paired.height < MIN_USERS_PER_CELL:
                continue
            _delta = mh_delta(_paired)
            _xs.append(_elo)
            _ys.append(_delta)
            _users.append(_paired.height)
            if bootstrap_reps.value:
                _lo, _hi = cluster_bootstrap_ci(_paired, int(bootstrap_reps.value))
                _lo_arm.append(_delta - _lo)
                _hi_arm.append(_hi - _delta)
        if not _xs:
            continue
        fig_elo_tc.add_trace(
            go.Scatter(
                x=_xs,
                y=_ys,
                mode="lines+markers",
                name=_tc,
                line=dict(color=_color, width=2),
                marker=dict(size=8),
                customdata=_users,
                error_y=(
                    dict(type="data", array=_hi_arm, arrayminus=_lo_arm, thickness=1)
                    if bootstrap_reps.value
                    else None
                ),
                hovertemplate=(
                    _tc + " · %{x}<br>Δ %{y:+.1f} pp · %{customdata} paired users<extra></extra>"
                ),
            )
        )
    fig_elo_tc.update_layout(
        title=f"{_cls_a} − {_cls_b} · {chart_boundary.value} boundary",
        xaxis=dict(title="ELO bucket (game-time rating)", tickvals=ELO_BUCKETS),
        yaxis=dict(
            title="Δ analysis rate (pp)",
            zeroline=True,
            zerolinecolor="#B0B0B0",
            zerolinewidth=1,
        ),
        legend=dict(orientation="h", yanchor="bottom", y=1.02),
        height=440,
        margin=dict(t=90),
    )
    mo.vstack([
        mo.md(
            "## Δ analysis rate by ELO × TC (paired within-user)\n"
            f"Cells with fewer than {MIN_USERS_PER_CELL} paired users are dropped. "
            "Enable bootstrap reps above for 95% cluster-bootstrap error bars."
        ),
        fig_elo_tc,
    ])
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## TODO — remaining EDA sections (locked scope, SEED-157)

    - **Threshold sweep**: re-render the contrast table at 300/400/500cp (dropdown
      above already re-classifies) and chart delta-vs-threshold stability per TC.
      This is the eval-source-homogeneity guard.
    - **Metadata tier** (needs its own query — ALL cohort games, no boundary join):
      analysis rate by result, termination type (are flagged/timeout losses
      buried?), game length (miniatures vs grinds), upsets vs expected results.
    - **Ply-convention check**: re-classify with `entry_ply - 1` for the analyzed
      arm (lichess post-move convention) and report class-agreement; decide whether
      the report needs per-arm reconciliation or the caveat suffices.
    - **Chart exports** for the story draft: `fig.write_image("analysis/out/...", scale=2)`.
    """)
    return


if __name__ == "__main__":
    app.run()
