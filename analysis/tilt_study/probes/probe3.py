import sys; sys.path.insert(0, ".")
exec(open("/home/aimfeld/.claude/jobs/dccd7eab/tmp/probe2.py").read().split("print(\"\\n=== A1")[0])  # reuse feature engineering + helpers
fl = pl.read_parquet(OUT + "flaws_byus.parquet").drop("tc")
uc = pl.read_parquet(OUT + "acc.parquet").select("game_id", "user_color")
d = games.join(uc, on="game_id").join(fl, on="game_id", how="inner").with_columns(
    my_bl=pl.when(pl.col("user_color") == "white").then(pl.col("w_bl")).otherwise(pl.col("b_bl")),
    my_mi=pl.when(pl.col("user_color") == "white").then(pl.col("w_mi")).otherwise(pl.col("b_mi")),
    opp_bl=pl.when(pl.col("user_color") == "white").then(pl.col("b_bl")).otherwise(pl.col("w_bl")),
).with_columns(bl100=pl.col("my_bl") / (pl.col("ply_count") / 2) * 100, mi100=pl.col("my_mi") / (pl.col("ply_count") / 2) * 100,
               opp_bl100=pl.col("opp_bl") / (pl.col("ply_count") / 2) * 100)
d = d.filter(pl.col("equal_footing") & pl.col("in_session") & (pl.col("ply_count") >= 20))
print("games by us, scored in-session:", d.group_by("tc").len())
TC_ORDER[:] = ["rapid", "classical"]
print("\n=== E1. Blunders per 100 own moves (uniform coverage) ===")
print(table(d, "bl100", ["LLL+", "LL", "L", "W", "WW", "WWW+"], fmt="{:.2f}"))
print("\n=== E2. Mistakes per 100 own moves ===")
print(table(d, "mi100", ["LLL+", "L", "W", "WWW+"], fmt="{:.2f}"))
print("\n=== E3. OPPONENT blunders per 100 moves (should be flat: placebo) ===")
print(table(d, "opp_bl100", ["LLL+", "L", "W", "WWW+"], fmt="{:.2f}"))
print("\n=== E4. Residual (pp) in this subset, for comparison ===")
print(table(d, "resid", ["LLL+", "L", "W", "WWW+"], scale=100))
print("\n=== E5. Paired per-user blunders/100: after L minus after W (>=10 games each) ===")
pu = d.filter(pl.col("streak").is_in(["L", "W"])).group_by(["user_id", "tc", "streak"]).agg(pl.col("bl100").mean().alias("m"), pl.len().alias("n")).filter(pl.col("n") >= 10)
pv = pu.pivot(on="streak", index=["user_id", "tc"], values="m").drop_nulls()
print(pv.with_columns(dd=pl.col("L") - pl.col("W"), rel=pl.col("L") / pl.col("W") - 1).group_by("tc").agg(pl.len().alias("users"), pl.col("dd").mean(), pl.col("rel").mean(), (pl.col("dd") > 0).mean().alias("share_more_after_L")))
print("\n=== E6. Blunders/100 by rating bucket, L vs W (rapid) ===")
print(d.filter((pl.col("tc")=="rapid") & pl.col("streak").is_in(["L","W","LLL+","WWW+"])).group_by(["elo_bucket","streak"]).agg(pl.len().alias("n"), pl.col("bl100").mean().round(2)).sort(["elo_bucket","streak"]))
