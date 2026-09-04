"""Confound controls for the pooled streak curve: same-session streaks, absences, new/provisional accounts, smurfs."""
import sys; sys.path.insert(0, ".")
exec(open("analysis/tilt_study/probes/probe2.py").read().split("print(\"\\n=== A1")[0])
pl.Config.set_tbl_rows(40)
MAXK = 8
w = ["user_id", "tc"]
g = games.sort(w + ["played_at"]).with_columns(
    hist_idx=pl.int_range(pl.len()).over(w),                      # game index in the user's TC history
    med_r=pl.col("my_r").median().over(w),                         # long-run rating in this TC
    run_start_session=pl.col("session_id").first().over(w + ["run_id"]),
    run_start_r=pl.col("my_r").first().over(w + ["run_id"]),
    run_start_gap=pl.col("gap_before_s").first().over(w + ["run_id"]),
).with_columns(
    # attributes of the streak that just ended (previous game's run)
    streak_same_session=(pl.col("run_start_session").shift(1).over(w) == pl.col("session_id")),
    streak_r_change=(pl.col("my_r") - pl.col("run_start_r").shift(1).over(w)),
    streak_start_gap_d=(pl.col("run_start_gap").shift(1).over(w) / 86400),
    r_dev=pl.col("my_r") - pl.col("med_r"),
    score=pl.col("score").cast(pl.Float64),
)
base = g.filter(pl.col("equal_footing") & pl.col("in_session") & pl.col("streak_dir").is_not_null()).with_columns(
    x=(pl.col("streak_dir") * pl.col("streak_len").clip(upper_bound=MAXK)).cast(pl.Int32))

print("=== Diagnostics per streak length (pooled) ===")
print(base.group_by("x").agg(pl.len().alias("n"),
    pl.col("streak_same_session").mean().round(3).alias("streak_in_1_session"),
    (pl.col("streak_start_gap_d") >= 7).mean().round(3).alias("streak_began_after_7d_gap"),
    (pl.col("hist_idx") < 100).mean().round(3).alias("in_first_100_games"),
    pl.col("hist_idx").median().alias("median_hist_idx"),
    pl.col("r_dev").mean().round(1).alias("mean_r_minus_median"),
    (pl.col("r_dev").abs() > 150).mean().round(3).alias("share_|dev|>150"),
    pl.col("streak_r_change").mean().round(1).alias("rating_change_over_streak"),
).sort("x"))

print("\n=== First game back after an absence (equal footing; residual pp) ===")
back = g.filter(pl.col("equal_footing")).with_columns(gap_d=pl.col("gap_before_s") / 86400)
for lo, hi, lab in [(0, 1/24, "<1h (in session)"), (1/24, 1, "1-24h"), (1, 7, "1-7d"), (7, 30, "7-30d"), (30, 90, "30-90d"), (90, 10000, ">90d")]:
    c = back.filter((pl.col("gap_d") >= lo) & (pl.col("gap_d") < hi))
    m, l, h = boot(c, "resid", reps=200)
    print(f"{lab:18s} n={c.height:8d} resid {m*100:+.2f} [{l*100:+.2f},{h*100:+.2f}]  raw {c['score'].mean()*100:.1f}")

def curve(df, name):
    rows = []
    for x in range(-MAXK, MAXK + 1):
        c = df.filter(pl.col("x") == x)
        m, l, h = boot(c, "score", reps=200); r, _, _ = boot(c, "resid", reps=50)
        rows.append({"x": x, "n": c.height, "score": round(m*100, 1), "ci": round((h-l)/2*100, 1), "resid": round(r*100, 1)})
    t = pl.DataFrame(rows); print(f"\n=== {name} ===\n{t}")
    return t.with_columns(pl.lit(name).alias("variant"))
variants = [
    (base, "A. as published (streak over full history, next game in-session)"),
    (base.filter(pl.col("streak_same_session")), "B. streak entirely within one session"),
    (base.filter(pl.col("hist_idx") >= 100), "C. drop first 100 games of each user-TC history"),
    (base.filter(pl.col("r_dev").abs() <= 150), "D. drop games with rating >150 from the user's long-run median"),
    (base.filter(pl.col("streak_same_session") & (pl.col("hist_idx") >= 100) & (pl.col("r_dev").abs() <= 150)), "E. B+C+D combined"),
]
out = pl.concat([curve(d, n) for d, n in variants])
out.write_csv(OUT + "tbl_streak_controls.csv")
