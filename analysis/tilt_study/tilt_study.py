"""Tilt study — "Should you stop playing after a loss?"

EDA for the tilt data-story candidate (.planning/notes/2026-09-02-data-story-candidates.md §1).
Every rated human game in the benchmark DB, ordered per (user, time control), with an
empirically calibrated expected score (Lichess ratings are NOT Elo-calibrated: a 300-point
favourite scores ~85%, not 93%). Residual = score − expected. Sessions and breaks are measured
from the END of the previous game (clock-derived duration), not from its start. Equal-footing
filter (|rating gap| <= 100) applied to every scored game (stories/CLAUDE.md).

Run it:  uv run --project analysis marimo edit analysis/tilt_study/tilt_study.py
         uv run --project analysis python analysis/tilt_study/tilt_study.py   (headless, writes PNGs)
Needs:   bin/benchmark_db.sh start, and analysis/out/tilt/clock_ends.parquet
         (python analysis/tilt_study/extract_clocks.py, ~2 min).
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

    OUT = REPO_ROOT / "analysis" / "out" / "tilt"
    OUT.mkdir(parents=True, exist_ok=True)
    return OUT, db, go, np, pl


@app.cell
def _():
    # --- constants -------------------------------------------------------------
    SESSION_GAP_MIN = 60  # break (from previous game END) that starts a new session
    CAL_BIN_ELO = 25  # rating-gap bin width for the empirical expected-score table
    # Equal-footing filter (stories/CLAUDE.md, scripts/benchmarks/sql.py EQUAL_FOOTING_TOLERANCE):
    # only games with |my_r - opp_r| <= 100 are SCORED. The 2400 bucket faces systematically
    # weaker opponents (thin pool), which biases every per-bucket outcome without it.
    EQUAL_FOOTING_TOLERANCE = 100
    ELO_ANCHORS = (800, 1200, 1600, 2000, 2400)  # 400-wide, rating at game time
    TC_ORDER = ("bullet", "blitz", "rapid", "classical")
    # dataviz palette, fixed categorical order: blue / orange / aqua / yellow
    TC_COLOR = {"bullet": "#2a78d6", "blitz": "#eb6834", "rapid": "#1baf7a", "classical": "#eda100"}
    COLD, HOT = "#2a78d6", "#eb6834"
    MAX_STREAK = 8
    TRAILING_WINDOW = 20  # games used to estimate "form" before the streak window
    TRAILING_SKIP = 4  # games skipped so the form window never overlaps the 3-game streak
    BOOT_REPS = 1000
    GAP_EDGES_S = [0, 60, 180, 600, 1800, 3600, 6 * 3600, 24 * 3600, 7 * 86400]
    GAP_LABELS = ["<1m", "1-3m", "3-10m", "10-30m", "30-60m", "1-6h", "6-24h", "1-7d", ">7d"]
    return (
        BOOT_REPS,
        CAL_BIN_ELO,
        COLD,
        ELO_ANCHORS,
        EQUAL_FOOTING_TOLERANCE,
        GAP_EDGES_S,
        GAP_LABELS,
        HOT,
        MAX_STREAK,
        SESSION_GAP_MIN,
        TC_COLOR,
        TC_ORDER,
        TRAILING_SKIP,
        TRAILING_WINDOW,
    )


@app.cell
def _(mo):
    mo.md(r"""
    # Tilt: should you stop playing after a loss?

    **Unit**: consecutive rated games of one user in one time control, ordered by start time.
    **Outcome**: score residual = actual score − expected score, where *expected* is the
    empirical mean score in the same (TC, rating-gap 25-pt bin) — the Elo formula is
    miscalibrated on Lichess ratings and would fake a "hot hand" for favourites.

    **Equal-footing filter**: only games with both players within 100 rating points are
    scored (sequence features use the full history). Without it the 2400 bucket, which
    faces systematically weaker opponents, biases every per-bucket number.

    **Confounds handled**: matchmaking drift (expected score), regression to the mean
    (residual, not raw score), session position (end-of-game based sessions), and the
    big one — *form drift* (an improving player is both more likely to be on a win streak
    and to beat expectation next game). The break test and the trailing-form control
    separate a transient *state* (tilt / hot hand) from a persistent *trait* (form).
    """)
    return


@app.cell
def _(OUT, db, pl):
    # --- load games (cached) + clock ends ------------------------------------
    _GAMES_SQL = """
    SELECT g.id AS game_id, g.user_id, g.time_control_bucket::text AS tc, g.played_at,
      CASE WHEN (g.result='1-0' AND g.user_color='white') OR (g.result='0-1' AND g.user_color='black') THEN 1.0
           WHEN g.result='1/2-1/2' THEN 0.5 ELSE 0.0 END AS score,
      CASE WHEN g.user_color='white' THEN g.white_rating ELSE g.black_rating END AS my_r,
      CASE WHEN g.user_color='white' THEN g.black_rating ELSE g.white_rating END AS opp_r,
      CASE WHEN g.user_color='white' THEN g.black_username ELSE g.white_username END AS opp,
      g.termination::text AS termination, g.ply_count, g.base_time_seconds AS base_s,
      g.increment_seconds AS inc_s
    FROM games g
    WHERE g.rated AND NOT g.is_computer_game AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    """
    _cache = OUT / "games.parquet"
    if _cache.exists():
        games_raw = pl.read_parquet(_cache)
    else:
        with db.connect("benchmark") as _conn:
            games_raw = pl.read_database(_GAMES_SQL, _conn)
        games_raw.write_parquet(_cache)
    clocks = pl.read_parquet(OUT / "clock_ends.parquet")
    (games_raw.height, clocks.height)
    return clocks, games_raw


@app.cell
def _(
    CAL_BIN_ELO,
    ELO_ANCHORS,
    EQUAL_FOOTING_TOLERANCE,
    SESSION_GAP_MIN,
    clocks,
    games_raw,
    pl,
):
    # --- feature engineering --------------------------------------------------
    _g = games_raw.join(clocks, on="game_id", how="left")

    # Duration = time used by both sides. clock_seconds at ply p is the mover's clock
    # after the move; white moves on even plies. Fallback: median seconds/ply of the TC.
    _g = _g.with_columns(
        dur_clk=(
            2 * pl.col("base_s").cast(pl.Float64)
            + pl.col("inc_s") * pl.col("ply_count")
            - pl.col("w_last_clk")
            - pl.col("b_last_clk")
        ).clip(lower_bound=0)
    )
    _spp = (
        _g.filter(pl.col("dur_clk").is_not_null() & (pl.col("ply_count") > 0))
        .group_by("tc")
        .agg((pl.col("dur_clk") / pl.col("ply_count")).median().alias("sec_per_ply"))
    )
    _g = _g.join(_spp, on="tc").with_columns(
        dur_s=pl.coalesce(pl.col("dur_clk"), pl.col("ply_count") * pl.col("sec_per_ply")),
        has_clock=pl.col("dur_clk").is_not_null(),
    )
    _g = _g.with_columns(end_at=pl.col("played_at") + pl.duration(seconds=pl.col("dur_s")))

    _w = ["user_id", "tc"]
    _g = _g.sort(_w + ["played_at"]).with_columns(
        gap_before_s=(pl.col("played_at") - pl.col("end_at").shift(1)).dt.total_seconds().over(_w),
        gap_after_s=(pl.col("played_at").shift(-1) - pl.col("end_at")).dt.total_seconds().over(_w),
        s1=pl.col("score").shift(1).over(_w),
        prev_opp=pl.col("opp").shift(1).over(_w),
        prev_termination=pl.col("termination").shift(1).over(_w),
        prev_ply=pl.col("ply_count").shift(1).over(_w),
        prev_edge=(pl.col("my_r") - pl.col("opp_r")).shift(1).over(_w),
    )
    # Streak ending at the previous game: direction (+1 win / -1 loss / 0 draw) and length.
    _g = _g.with_columns(
        dir=pl.when(pl.col("score") == 1).then(1).when(pl.col("score") == 0).then(-1).otherwise(0)
    ).with_columns(
        run_id=(pl.col("dir") != pl.col("dir").shift(1)).cast(pl.Int32).cum_sum().over(_w)
    )
    _g = _g.with_columns(run_len=pl.int_range(pl.len()).over(_w + ["run_id"]) + 1)
    _g = _g.with_columns(
        streak_dir=pl.col("dir").shift(1).over(_w),
        streak_len=pl.col("run_len").shift(1).over(_w),
    )
    # Sessions from END-of-previous-game gaps.
    _g = _g.with_columns(
        new_session=(
            pl.col("gap_before_s").is_null() | (pl.col("gap_before_s") >= SESSION_GAP_MIN * 60)
        )
    ).with_columns(session_id=pl.col("new_session").cast(pl.Int32).cum_sum().over(_w))
    _s = _w + ["session_id"]
    _g = _g.with_columns(
        session_idx=pl.int_range(pl.len()).over(_s) + 1,
        session_len=pl.len().over(_s),
        session_elapsed_min=(
            pl.col("played_at") - pl.col("played_at").min().over(_s)
        ).dt.total_minutes(),
        last_of_session=pl.col("gap_after_s").is_null()
        | (pl.col("gap_after_s") >= SESSION_GAP_MIN * 60),
    )
    # Rating bucket (rating at game time) and calibrated expected score.
    _floor = ELO_ANCHORS[0]
    _g = _g.with_columns(
        elo_bucket=(((pl.col("my_r") - _floor) // 400) * 400 + _floor).clip(
            _floor, ELO_ANCHORS[-1]
        ),
        gap_bin=((pl.col("my_r") - pl.col("opp_r")) / CAL_BIN_ELO).floor(),
    )
    _g = _g.with_columns(
        equal_footing=(pl.col("my_r") - pl.col("opp_r")).abs() <= EQUAL_FOOTING_TOLERANCE
    )
    # Calibration table fitted on equal-footing games only.
    _cal = (
        _g.filter(pl.col("equal_footing"))
        .group_by(["tc", "elo_bucket", "gap_bin"])
        .agg(pl.col("score").mean().alias("exp_score"))
    )
    games = (
        _g.join(_cal, on=["tc", "elo_bucket", "gap_bin"], how="left")
        .with_columns(
            resid=pl.col("score") - pl.col("exp_score"),
            rematch=pl.col("opp") == pl.col("prev_opp"),
            in_session=pl.col("gap_before_s") < SESSION_GAP_MIN * 60,
        )
        .sort(_w + ["played_at"])
    )
    # Sequence features (streaks, sessions, breaks, rematches) come from the FULL history;
    # only equal-footing games are scored from here on.
    scored = games.filter(pl.col("equal_footing"))
    (games.select("has_clock").mean().item(), scored.height / games.height)
    return (scored,)


@app.cell
def _(BOOT_REPS, np, pl):
    # --- cluster (per-user) bootstrap for a mean residual -----------------------
    def boot_mean(
        df: pl.DataFrame, col: str = "resid", reps: int = BOOT_REPS, seed: int = 7
    ) -> tuple[float, float, float]:
        """Mean of `col` with a 95% CI from a bootstrap over users (scored within a user are correlated)."""
        per_user = df.group_by("user_id").agg(pl.col(col).sum().alias("s"), pl.len().alias("n"))
        s = per_user["s"].to_numpy()
        n = per_user["n"].to_numpy().astype(float)
        rng = np.random.default_rng(seed)
        idx = rng.integers(0, len(s), size=(reps, len(s)))
        boots = s[idx].sum(axis=1) / n[idx].sum(axis=1)
        return (
            float(s.sum() / n.sum()),
            float(np.percentile(boots, 2.5)),
            float(np.percentile(boots, 97.5)),
        )

    def streak_label(dir_col: str = "streak_dir", len_col: str = "streak_len") -> pl.Expr:
        d, n = pl.col(dir_col), pl.col(len_col)
        return (
            pl.when(d.is_null())
            .then(pl.lit("first"))
            .when(d == 0)
            .then(pl.lit("D"))
            .when((d == -1) & (n >= 3))
            .then(pl.lit("LLL+"))
            .when((d == -1) & (n == 2))
            .then(pl.lit("LL"))
            .when(d == -1)
            .then(pl.lit("L"))
            .when((d == 1) & (n >= 3))
            .then(pl.lit("WWW+"))
            .when((d == 1) & (n == 2))
            .then(pl.lit("WW"))
            .otherwise(pl.lit("W"))
        )

    STREAK_ORDER = ["LLL+", "LL", "L", "D", "W", "WW", "WWW+"]
    return STREAK_ORDER, boot_mean, streak_label


@app.cell
def _(mo):
    mo.md(r"""
    ## 1. Headline: score residual after a streak (same session, calibrated)
    """)
    return


@app.cell
def _(STREAK_ORDER, TC_ORDER, boot_mean, pl, scored, streak_label):
    _df = scored.filter(pl.col("in_session")).with_columns(streak=streak_label())
    _rows = []
    for _tc in TC_ORDER:
        for _st in STREAK_ORDER:
            _sub = _df.filter((pl.col("tc") == _tc) & (pl.col("streak") == _st))
            _m, _lo, _hi = boot_mean(_sub)
            _rows.append(
                {
                    "tc": _tc,
                    "streak": _st,
                    "n": _sub.height,
                    "score": _sub["score"].mean(),
                    "resid": _m,
                    "lo": _lo,
                    "hi": _hi,
                }
            )
    headline = pl.DataFrame(_rows)
    headline
    return (headline,)


@app.cell
def _(OUT, STREAK_ORDER, TC_COLOR, TC_ORDER, go, headline, pl):
    fig_headline = go.Figure()
    for _tc in TC_ORDER:
        _d = headline.filter(pl.col("tc") == _tc).sort(pl.col("streak").cast(pl.Enum(STREAK_ORDER)))
        fig_headline.add_trace(
            go.Scatter(
                x=_d["streak"],
                y=_d["resid"] * 100,
                name=_tc,
                mode="lines+markers",
                line={"color": TC_COLOR[_tc], "width": 2},
                marker={"size": 8},
                error_y={
                    "type": "data",
                    "array": (_d["hi"] - _d["resid"]) * 100,
                    "arrayminus": (_d["resid"] - _d["lo"]) * 100,
                    "thickness": 1,
                },
            )
        )
    fig_headline.update_layout(
        title="Next-game score vs expectation, by streak just ended (same session)",
        yaxis_title="score − expected (percentage points)",
        xaxis_title="streak before this game",
        template="plotly_white",
        height=420,
        legend={"orientation": "h", "y": -0.2},
    )
    fig_headline.add_hline(y=0, line={"color": "#9a9890", "width": 1})
    fig_headline.write_image(OUT / "headline_streak.png", scale=2)
    fig_headline
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## 2. Dose-response: exact streak length 1..8+
    """)
    return


@app.cell
def _(MAX_STREAK, OUT, TC_COLOR, TC_ORDER, boot_mean, go, pl, scored):
    _df = scored.filter(
        pl.col("in_session") & (pl.col("streak_dir") != 0) & pl.col("streak_dir").is_not_null()
    ).with_columns(len_c=pl.col("streak_len").clip(upper_bound=MAX_STREAK))
    _rows = []
    for _tc in TC_ORDER:
        for _dir in (-1, 1):
            for _len in range(1, MAX_STREAK + 1):
                _sub = _df.filter(
                    (pl.col("tc") == _tc)
                    & (pl.col("streak_dir") == _dir)
                    & (pl.col("len_c") == _len)
                )
                _m, _lo, _hi = boot_mean(_sub, reps=300)
                _rows.append(
                    {
                        "tc": _tc,
                        "dir": _dir,
                        "len": _len,
                        "n": _sub.height,
                        "score": _sub["score"].mean(),
                        "resid": _m,
                        "lo": _lo,
                        "hi": _hi,
                    }
                )
    dose = pl.DataFrame(_rows)
    fig_dose = go.Figure()
    for _tc in TC_ORDER:
        for _dir, _dash in ((1, "solid"), (-1, "dot")):
            _d = dose.filter((pl.col("tc") == _tc) & (pl.col("dir") == _dir))
            fig_dose.add_trace(
                go.Scatter(
                    x=_d["len"] * _dir,
                    y=_d["resid"] * 100,
                    name=f"{_tc} {'wins' if _dir == 1 else 'losses'}",
                    mode="lines+markers",
                    line={"color": TC_COLOR[_tc], "width": 2, "dash": _dash},
                    marker={"size": 7},
                    showlegend=_dir == 1,
                )
            )
    fig_dose.update_layout(
        title="Signed streak length → next-game residual (dotted = loss streaks)",
        xaxis_title="← losses in a row | wins in a row →",
        yaxis_title="score − expected (pp)",
        template="plotly_white",
        height=420,
        legend={"orientation": "h", "y": -0.2},
    )
    fig_dose.add_hline(y=0, line={"color": "#9a9890", "width": 1})
    fig_dose.write_image(OUT / "dose_response.png", scale=2)
    fig_dose
    return (dose,)


@app.cell
def _(mo):
    mo.md(r"""
    ## 3. The break test: state or trait?

    Same streak (2+ losses / 2+ wins), next game bucketed by the **real break** (from the end
    of the previous game). A transient state fades with the break; a persistent form
    difference survives it. Note the first-game-of-session penalty appears in *both*
    curves after long breaks.
    """)
    return


@app.cell
def _(
    COLD,
    GAP_EDGES_S,
    GAP_LABELS,
    HOT,
    OUT,
    TC_ORDER,
    boot_mean,
    go,
    np,
    pl,
    scored,
):
    _df = scored.filter(
        pl.col("streak_dir").is_in([-1, 1])
        & (pl.col("streak_len") >= 2)
        & pl.col("gap_before_s").is_not_null()
    )
    _edges = np.array(GAP_EDGES_S + [np.inf])
    _df = _df.with_columns(
        gap_lbl=pl.col("gap_before_s").map_batches(
            lambda s: pl.Series(
                [
                    GAP_LABELS[
                        min(int(np.searchsorted(_edges, v, side="right")) - 1, len(GAP_LABELS) - 1)
                    ]
                    if v >= 0
                    else GAP_LABELS[0]
                    for v in s.to_list()
                ]
            )
        )
    )
    _rows = []
    for _tc in TC_ORDER:
        for _dir in (-1, 1):
            for _lbl in GAP_LABELS:
                _sub = _df.filter(
                    (pl.col("tc") == _tc)
                    & (pl.col("streak_dir") == _dir)
                    & (pl.col("gap_lbl") == _lbl)
                )
                if _sub.height < 200:
                    continue
                _m, _lo, _hi = boot_mean(_sub, reps=300)
                _rows.append(
                    {
                        "tc": _tc,
                        "dir": _dir,
                        "gap": _lbl,
                        "n": _sub.height,
                        "resid": _m,
                        "lo": _lo,
                        "hi": _hi,
                    }
                )
    breaks = pl.DataFrame(_rows)

    from plotly.subplots import make_subplots

    fig_breaks = make_subplots(rows=1, cols=4, subplot_titles=TC_ORDER, shared_yaxes=True)
    for _i, _tc in enumerate(TC_ORDER, start=1):
        for _dir, _color, _name in ((1, HOT, "after 2+ wins"), (-1, COLD, "after 2+ losses")):
            _d = breaks.filter((pl.col("tc") == _tc) & (pl.col("dir") == _dir)).sort(
                pl.col("gap").cast(pl.Enum(GAP_LABELS))
            )
            fig_breaks.add_trace(
                go.Scatter(
                    x=_d["gap"],
                    y=_d["resid"] * 100,
                    name=_name,
                    mode="lines+markers",
                    line={"color": _color, "width": 2},
                    marker={"size": 7},
                    showlegend=_i == 1,
                    error_y={
                        "type": "data",
                        "array": (_d["hi"] - _d["resid"]) * 100,
                        "arrayminus": (_d["resid"] - _d["lo"]) * 100,
                        "thickness": 1,
                    },
                ),
                row=1,
                col=_i,
            )
        fig_breaks.add_hline(y=0, line={"color": "#9a9890", "width": 1}, row=1, col=_i)
    fig_breaks.update_layout(
        title="Break length before the next game → residual (streak of 2+ just ended)",
        template="plotly_white",
        height=420,
        legend={"orientation": "h", "y": -0.25},
        yaxis_title="score − expected (pp)",
    )
    fig_breaks.write_image(OUT / "break_test.png", scale=2)
    fig_breaks
    return (breaks,)


@app.cell
def _(mo):
    mo.md(r"""
    ## 4. Trailing-form control

    Form = mean residual over the 20 scored ending 4 scored before this one (never overlapping
    the 3-game streak window). Within each form tercile, does the streak still predict the
    next game? If the streak effect vanishes inside form terciles, it was form all along.
    """)
    return


@app.cell
def _(TRAILING_SKIP, TRAILING_WINDOW, boot_mean, pl, scored, streak_label):
    _w = ["user_id", "tc"]
    _df = (
        scored.with_columns(
            form=pl.col("resid")
            .shift(TRAILING_SKIP)
            .rolling_mean(window_size=TRAILING_WINDOW, min_samples=TRAILING_WINDOW)
            .over(_w)
        )
        .filter(pl.col("in_session") & pl.col("form").is_not_null())
        .with_columns(streak=streak_label())
    )
    _q = _df.select(
        pl.col("form").quantile(1 / 3).alias("q1"), pl.col("form").quantile(2 / 3).alias("q2")
    ).row(0)
    _df = _df.with_columns(
        form_tercile=pl.when(pl.col("form") < _q[0])
        .then(pl.lit("cold form"))
        .when(pl.col("form") < _q[1])
        .then(pl.lit("mid form"))
        .otherwise(pl.lit("hot form"))
    )
    _rows = []
    for _ft in ("cold form", "mid form", "hot form"):
        for _st in ("LLL+", "L", "W", "WWW+"):
            _sub = _df.filter((pl.col("form_tercile") == _ft) & (pl.col("streak") == _st))
            _m, _lo, _hi = boot_mean(_sub, reps=300)
            _rows.append(
                {
                    "form_tercile": _ft,
                    "streak": _st,
                    "n": _sub.height,
                    "form_mean": _sub["form"].mean(),
                    "resid": _m,
                    "lo": _lo,
                    "hi": _hi,
                }
            )
    form_control = pl.DataFrame(_rows)
    form_control
    return (form_control,)


@app.cell
def _(mo):
    mo.md(r"""
    ## 5. Behaviour after a loss: quitting, rushing, revenge
    """)
    return


@app.cell
def _(TC_ORDER, pl, scored):
    # Quit-on-loss: does the session end after this game?
    quit_tbl = (
        scored.filter(pl.col("dir") != 0)
        .with_columns(now=pl.when(pl.col("dir") == 1).then(pl.lit("win")).otherwise(pl.lit("loss")))
        .group_by(["tc", "now"])
        .agg(
            pl.len().alias("n"),
            pl.col("last_of_session").mean().alias("p_quit"),
            (pl.col("gap_after_s") < 60).mean().alias("p_next_within_60s"),
            pl.col("gap_after_s")
            .filter(pl.col("gap_after_s") < 1800)
            .median()
            .alias("median_gap_s_if_continue"),
        )
        .sort(pl.col("tc").cast(pl.Enum(list(TC_ORDER))), "now")
    )
    # Session-end composition: P(last game is a loss) vs base loss rate, by TC × rating.
    session_end = (
        scored.group_by(["tc", "elo_bucket"])
        .agg(
            pl.len().alias("scored"),
            pl.col("last_of_session").sum().alias("sessions"),
            (pl.col("score") == 0).mean().alias("p_loss"),
            (pl.col("score") == 0).filter(pl.col("last_of_session")).mean().alias("p_last_is_loss"),
        )
        .with_columns(excess_pp=(pl.col("p_last_is_loss") - pl.col("p_loss")) * 100)
        .sort(pl.col("tc").cast(pl.Enum(list(TC_ORDER))), "elo_bucket")
    )
    quit_tbl, session_end
    return quit_tbl, session_end


@app.cell
def _(TC_ORDER, boot_mean, pl, scored):
    # Revenge rematch: same opponent immediately after a loss, vs a fresh opponent.
    _df = scored.filter(pl.col("in_session") & (pl.col("s1") == 0))
    _rows = []
    for _tc in TC_ORDER:
        for _rm in (True, False):
            _sub = _df.filter((pl.col("tc") == _tc) & (pl.col("rematch") == _rm))
            _m, _lo, _hi = boot_mean(_sub, reps=300)
            _rows.append(
                {
                    "tc": _tc,
                    "rematch": _rm,
                    "n": _sub.height,
                    "score": _sub["score"].mean(),
                    "opp_minus_me": (_sub["opp_r"] - _sub["my_r"]).mean(),
                    "resid": _m,
                    "lo": _lo,
                    "hi": _hi,
                }
            )
    revenge = pl.DataFrame(_rows)
    rematch_rates = (
        scored.filter(pl.col("in_session") & pl.col("s1").is_in([0, 1]))
        .group_by(["tc", "elo_bucket", "s1"])
        .agg(pl.len().alias("n"), pl.col("rematch").mean().alias("rematch_rate"))
        .pivot(on="s1", index=["tc", "elo_bucket"], values="rematch_rate")
        .rename({"0.0": "after_loss", "1.0": "after_win"})
        .sort(pl.col("tc").cast(pl.Enum(list(TC_ORDER))), "elo_bucket")
    )
    revenge, rematch_rates
    return rematch_rates, revenge


@app.cell
def _(mo):
    mo.md(r"""
    ## 6. Anatomy of the loss that tilts you
    """)
    return


@app.cell
def _(TC_ORDER, boot_mean, pl, scored):
    _df = scored.filter(pl.col("in_session") & (pl.col("s1") == 0))
    _rows = []
    for _tc in TC_ORDER:
        for _term in ("checkmate", "resignation", "timeout", "abandoned"):
            _sub = _df.filter((pl.col("tc") == _tc) & (pl.col("prev_termination") == _term))
            _m, _lo, _hi = boot_mean(_sub, reps=300)
            _rows.append(
                {
                    "tc": _tc,
                    "cut": f"lost by {_term}",
                    "n": _sub.height,
                    "resid": _m,
                    "lo": _lo,
                    "hi": _hi,
                }
            )
        for _lbl, _lo_p, _hi_p in (
            ("short loss (≤20 plies)", 0, 20),
            ("mid loss (21-60)", 21, 60),
            ("long loss (>60)", 61, 10_000),
        ):
            _sub = _df.filter((pl.col("tc") == _tc) & pl.col("prev_ply").is_between(_lo_p, _hi_p))
            _m, _lo, _hi = boot_mean(_sub, reps=300)
            _rows.append(
                {"tc": _tc, "cut": _lbl, "n": _sub.height, "resid": _m, "lo": _lo, "hi": _hi}
            )
        for _lbl, _lo_e, _hi_e in (
            ("lost to much stronger (>100)", -10_000, -101),
            ("lost to peer (±100)", -100, 100),
            ("lost to much weaker (>100)", 101, 10_000),
        ):
            _sub = _df.filter((pl.col("tc") == _tc) & pl.col("prev_edge").is_between(_lo_e, _hi_e))
            _m, _lo, _hi = boot_mean(_sub, reps=300)
            _rows.append(
                {"tc": _tc, "cut": _lbl, "n": _sub.height, "resid": _m, "lo": _lo, "hi": _hi}
            )
    loss_anatomy = pl.DataFrame(_rows)
    loss_anatomy
    return (loss_anatomy,)


@app.cell
def _(TC_ORDER, pl, scored, streak_label):
    # How the NEXT loss looks after a streak: give-up signatures.
    loss_shape = (
        scored.filter(pl.col("in_session"))
        .with_columns(streak=streak_label())
        .filter(pl.col("streak").is_in(["LLL+", "L", "W", "WWW+"]))
        .group_by(["tc", "streak"])
        .agg(
            pl.len().alias("n"),
            (pl.col("score") == 0).mean().alias("p_loss"),
            ((pl.col("score") == 0) & (pl.col("ply_count") <= 20)).sum().alias("short_losses"),
            ((pl.col("score") == 0) & (pl.col("termination") == "abandoned"))
            .sum()
            .alias("abandoned_losses"),
            ((pl.col("score") == 0) & (pl.col("termination") == "timeout"))
            .sum()
            .alias("flag_losses"),
            (pl.col("score") == 0).sum().alias("losses"),
            pl.col("ply_count").filter(pl.col("score") == 0).mean().alias("mean_ply_of_loss"),
        )
        .with_columns(
            short_share=pl.col("short_losses") / pl.col("losses"),
            abandon_share=pl.col("abandoned_losses") / pl.col("losses"),
            flag_share=pl.col("flag_losses") / pl.col("losses"),
        )
        .sort(
            pl.col("tc").cast(pl.Enum(list(TC_ORDER))),
            pl.col("streak").cast(pl.Enum(["LLL+", "L", "W", "WWW+"])),
        )
    )
    loss_shape
    return (loss_shape,)


@app.cell
def _(mo):
    mo.md(r"""
    ## 7. Warm-up and fatigue (session position)
    """)
    return


@app.cell
def _(OUT, TC_COLOR, TC_ORDER, boot_mean, go, pl, scored):
    _rows = []
    for _tc in TC_ORDER:
        _first = scored.filter((pl.col("tc") == _tc) & (pl.col("session_idx") == 1))
        _m, _lo, _hi = boot_mean(_first, reps=300)
        _rows.append(
            {"tc": _tc, "bin": "first game", "n": _first.height, "resid": _m, "lo": _lo, "hi": _hi}
        )
        for _lo_m, _hi_m, _lbl in (
            (0, 30, "0-30 min"),
            (30, 60, "30-60"),
            (60, 120, "60-120"),
            (120, 240, "120-240"),
            (240, 100_000, ">240"),
        ):
            _sub = scored.filter(
                (pl.col("tc") == _tc)
                & (pl.col("session_idx") > 1)
                & (pl.col("session_elapsed_min") >= _lo_m)
                & (pl.col("session_elapsed_min") < _hi_m)
            )
            if _sub.height < 500:
                continue
            _m, _lo, _hi = boot_mean(_sub, reps=300)
            _rows.append(
                {"tc": _tc, "bin": _lbl, "n": _sub.height, "resid": _m, "lo": _lo, "hi": _hi}
            )
    fatigue = pl.DataFrame(_rows)
    _order = ["first game", "0-30 min", "30-60", "60-120", "120-240", ">240"]
    fig_fatigue = go.Figure()
    for _tc in TC_ORDER:
        _d = fatigue.filter(pl.col("tc") == _tc).sort(pl.col("bin").cast(pl.Enum(_order)))
        fig_fatigue.add_trace(
            go.Scatter(
                x=_d["bin"],
                y=_d["resid"] * 100,
                name=_tc,
                mode="lines+markers",
                line={"color": TC_COLOR[_tc], "width": 2},
                marker={"size": 8},
                error_y={
                    "type": "data",
                    "array": (_d["hi"] - _d["resid"]) * 100,
                    "arrayminus": (_d["resid"] - _d["lo"]) * 100,
                    "thickness": 1,
                },
            )
        )
    fig_fatigue.update_layout(
        title="Session position → residual (first game, then minutes into the session)",
        template="plotly_white",
        height=420,
        yaxis_title="score − expected (pp)",
        legend={"orientation": "h", "y": -0.2},
    )
    fig_fatigue.add_hline(y=0, line={"color": "#9a9890", "width": 1})
    fig_fatigue.write_image(OUT / "fatigue.png", scale=2)
    fig_fatigue
    return (fatigue,)


@app.cell
def _(
    OUT,
    breaks,
    dose,
    fatigue,
    form_control,
    headline,
    loss_anatomy,
    loss_shape,
    quit_tbl,
    rematch_rates,
    revenge,
    session_end,
):
    # Persist every table so the findings doc can quote them.
    for _name, _df in {
        "headline": headline,
        "dose": dose,
        "breaks": breaks,
        "form_control": form_control,
        "quit": quit_tbl,
        "session_end": session_end,
        "revenge": revenge,
        "rematch_rates": rematch_rates,
        "loss_anatomy": loss_anatomy,
        "loss_shape": loss_shape,
        "fatigue": fatigue,
    }.items():
        _df.write_csv(OUT / f"tbl_{_name}.csv")
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## 8. Is tilt a trait? Split-half reliability of a player's own tilt number

    Per user: Δ = mean residual after a loss − mean residual after a win (same session).
    Computed separately on odd and even sessions. If Δ is a stable personal trait, the two
    halves correlate; if every player tilts the same (or it is all noise), r ≈ 0.
    """)
    return


@app.cell
def _(np, pl, scored):
    _MIN_PER_SIDE = 25
    _df = scored.filter(pl.col("in_session") & pl.col("s1").is_in([0, 1])).with_columns(
        half=pl.col("session_id") % 2
    )
    _per = (
        _df.group_by(["user_id", "tc", "half", "s1"])
        .agg(pl.col("resid").mean().alias("m"), pl.len().alias("n"))
        .filter(pl.col("n") >= _MIN_PER_SIDE)
        .pivot(on="s1", index=["user_id", "tc", "half"], values="m")
        .rename({"0.0": "after_loss", "1.0": "after_win"})
        .drop_nulls()
        .with_columns(delta=pl.col("after_loss") - pl.col("after_win"))
        .pivot(on="half", index=["user_id", "tc"], values="delta")
        .rename({"0": "delta_even", "1": "delta_odd"})
        .drop_nulls()
    )
    _r = float(np.corrcoef(_per["delta_even"].to_numpy(), _per["delta_odd"].to_numpy())[0, 1])
    _sd_obs = float(np.std((_per["delta_even"] + _per["delta_odd"]).to_numpy() / 2))
    # Spearman-Brown: reliability of the full-length (both halves) score.
    _rel_full = 2 * _r / (1 + _r) if _r > -1 else float("nan")
    trait = {
        "users": _per.height,
        "split_half_r": round(_r, 3),
        "spearman_brown_reliability": round(_rel_full, 3),
        "sd_of_user_delta_pp": round(_sd_obs * 100, 2),
        "implied_true_sd_pp": round(_sd_obs * 100 * (max(_rel_full, 0) ** 0.5), 2),
        "mean_delta_pp": round(float((_per["delta_even"] + _per["delta_odd"]).mean() / 2 * 100), 2),
    }
    trait_users = _per
    trait
    return trait, trait_users


@app.cell
def _(OUT, trait, trait_users):
    import json

    (OUT / "tbl_trait.json").write_text(json.dumps(trait, indent=2))
    trait_users.write_csv(OUT / "tbl_trait_users.csv")
    return


if __name__ == "__main__":
    app.run()
