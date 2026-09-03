"""Player fixed effects on the controlled streak curve (variant E): residual demeaned within user×TC."""
import sys; sys.path.insert(0, ".")
exec(open("analysis/tilt_study/probes/streak_controls.py").read().split('print("=== Diagnostics')[0])
E = base.filter(pl.col("streak_same_session") & (pl.col("hist_idx") >= 100) & (pl.col("r_dev").abs() <= 150))
# user mean over ALL their scored games (not just streak-enders), so the FE is the player's general over/under-performance
um = games.filter(pl.col("equal_footing")).group_by(["user_id", "tc"]).agg(pl.col("resid").mean().alias("user_mean_resid"))
E = E.join(um, on=["user_id", "tc"]).with_columns(resid_fe=pl.col("resid") - pl.col("user_mean_resid"))
rows = []
for x in range(-MAXK, MAXK + 1):
    c = E.filter(pl.col("x") == x)
    m0, _, _ = boot(c, "resid", reps=50); m, l, h = boot(c, "resid_fe", reps=200)
    rows.append({"x": x, "n": c.height, "resid_E": round(m0*100, 1), "resid_E_userFE": round(m*100, 1), "ci": round((h-l)/2*100, 1),
                 "user_FE_mean": round(c["user_mean_resid"].mean()*100, 2)})
t = pl.DataFrame(rows); print(t); t.write_csv(OUT + "tbl_streak_controls_fe.csv")
