"""Next-game score vs streak just ended (-5 = 5+ losses ... +5 = 5+ wins), by ELO bucket and by TC."""
import sys; sys.path.insert(0, ".")
exec(open("analysis/tilt_study/probes/probe2.py").read().split("print(\"\\n=== A1")[0])
import plotly.graph_objects as go
MAXK = int(sys.argv[1]) if len(sys.argv) > 1 else 5
d = scored.filter(pl.col("in_session") & pl.col("streak_dir").is_not_null()).with_columns(
    x=(pl.col("streak_dir") * pl.col("streak_len").clip(upper_bound=MAXK)).cast(pl.Int32), score=pl.col("score").cast(pl.Float64))
ELO_COLOR = {800: "#b9c8e8", 1200: "#7fa3dd", 1600: "#2a78d6", 2000: "#134d92", 2400: "#08264d"}
def curve(df, key, colors, title, fname, order):
    rows = []
    for k in order:
        for x in range(-MAXK, MAXK + 1):
            c = df.filter((pl.col(key) == k) & (pl.col("x") == x))
            m, lo, hi = boot(c, "score", reps=200)
            rows.append({key: k, "x": x, "n": c.height, "score": m, "lo": lo, "hi": hi, "exp": float(c["exp_score"].mean())})
    agg = pl.DataFrame(rows)
    fig = go.Figure()
    for k in order:
        s = agg.filter(pl.col(key) == k)
        fig.add_trace(go.Scatter(x=s["x"], y=s["exp"] * 100, mode="lines", line=dict(color=colors[k], dash="dot", width=1), showlegend=False, hoverinfo="skip"))
        fig.add_trace(go.Scatter(x=s["x"], y=s["score"] * 100, mode="lines+markers", name=str(k), line=dict(color=colors[k], width=2.5),
                                 error_y=dict(type="data", symmetric=False, array=(s["hi"] - s["score"]) * 100, arrayminus=(s["score"] - s["lo"]) * 100, thickness=1, width=3),
                                 customdata=s["n"], hovertemplate="%{y:.1f}% (n=%{customdata})"))
    fig.update_layout(title=title, template="plotly_white", width=900, height=520, legend_title=key,
        xaxis=dict(title=f"streak just ended (−{MAXK} = {MAXK} or more losses … +{MAXK} = {MAXK} or more wins)", tickmode="array",
                   tickvals=list(range(-MAXK, MAXK + 1)), ticktext=[f"{v:+d}" if v else "draw" for v in range(-MAXK, MAXK + 1)]),
        yaxis=dict(title="score in the next game (%)", range=[40, 60]))
    fig.add_hline(y=50, line=dict(color="#999", width=1))
    fig.write_image(OUT + fname.replace(".png", f"_{MAXK}.png"), scale=2)
    return agg
a1 = curve(d, "elo_bucket", ELO_COLOR, "Next-game score by streak, per rating bucket (all TCs; dotted = calibrated expectation)", "streak_curve_elo.png", [800, 1200, 1600, 2000, 2400])
TCC = {"bullet": "#2a78d6", "blitz": "#eb6834", "rapid": "#1baf7a", "classical": "#eda100"}
a2 = curve(d, "tc", TCC, "Next-game score by streak, per time control (dotted = calibrated expectation)", "streak_curve_tc.png", TC_ORDER)
for a, key in [(a1, "elo_bucket"), (a2, "tc")]:
    print(a.pivot(on="x", index=key, values="score").with_columns(pl.all().exclude(key).round(3)))
    print("CI half-width (pp):"); print(a.with_columns(hw=((pl.col("hi") - pl.col("lo")) / 2 * 100).round(1)).pivot(on="x", index=key, values="hw"))
    print(a.pivot(on="x", index=key, values="n"))
a1.write_csv(OUT + f"tbl_streak_curve_elo_{MAXK}.csv"); a2.write_csv(OUT + f"tbl_streak_curve_tc_{MAXK}.csv")

# --- fully pooled: one line, all TCs and all rating buckets ---------------------
dd = d.with_columns(all=pl.lit("all"))
a3 = curve(dd, "all", {"all": "#2a78d6"}, "Next-game score by streak, all players pooled (dotted = calibrated expectation)", "streak_curve_all.png", ["all"])
print(a3.with_columns((pl.col("score") * 100).round(1), (pl.col("lo") * 100).round(1), (pl.col("hi") * 100).round(1), (pl.col("exp") * 100).round(1), resid=((pl.col("score") - pl.col("exp")) * 100).round(1)).drop("all"))
a3.write_csv(OUT + f"tbl_streak_curve_all_{MAXK}.csv")
