"""Extra tilt probes: bigger-than-score effects? Reuses the notebook's feature engineering."""
import sys
sys.path.insert(0, ".")
import numpy as np
import polars as pl
pl.Config.set_tbl_rows(80); pl.Config.set_tbl_cols(30); pl.Config.set_tbl_width_chars(220); pl.Config.set_fmt_str_lengths(40)
OUT = "analysis/out/tilt/"
SESSION_GAP_MIN = 60; CAL_BIN_ELO = 25; EQ = 100; ELO_ANCHORS = (800, 1200, 1600, 2000, 2400)
TC_ORDER = ["bullet", "blitz", "rapid", "classical"]

games_raw = pl.read_parquet(OUT + "games.parquet")
clocks = pl.read_parquet(OUT + "clock_ends.parquet")
_g = games_raw.join(clocks, on="game_id", how="left")
_g = _g.with_columns(dur_clk=(2 * pl.col("base_s").cast(pl.Float64) + pl.col("inc_s") * pl.col("ply_count") - pl.col("w_last_clk") - pl.col("b_last_clk")).clip(lower_bound=0))
_spp = _g.filter(pl.col("dur_clk").is_not_null() & (pl.col("ply_count") > 0)).group_by("tc").agg((pl.col("dur_clk") / pl.col("ply_count")).median().alias("sec_per_ply"))
_g = _g.join(_spp, on="tc").with_columns(dur_s=pl.coalesce(pl.col("dur_clk"), pl.col("ply_count") * pl.col("sec_per_ply")))
_g = _g.with_columns(end_at=pl.col("played_at") + pl.duration(seconds=pl.col("dur_s")))
_w = ["user_id", "tc"]
_g = _g.sort(_w + ["played_at"]).with_columns(
    gap_before_s=(pl.col("played_at") - pl.col("end_at").shift(1)).dt.total_seconds().over(_w),
    gap_after_s=(pl.col("played_at").shift(-1) - pl.col("end_at")).dt.total_seconds().over(_w),
    s1=pl.col("score").shift(1).over(_w), prev_opp=pl.col("opp").shift(1).over(_w),
    prev_termination=pl.col("termination").shift(1).over(_w), prev_ply=pl.col("ply_count").shift(1).over(_w),
)
_g = _g.with_columns(dir=pl.when(pl.col("score") == 1).then(1).when(pl.col("score") == 0).then(-1).otherwise(0)).with_columns(run_id=(pl.col("dir") != pl.col("dir").shift(1)).cast(pl.Int32).cum_sum().over(_w))
_g = _g.with_columns(run_len=pl.int_range(pl.len()).over(_w + ["run_id"]) + 1)
_g = _g.with_columns(streak_dir=pl.col("dir").shift(1).over(_w), streak_len=pl.col("run_len").shift(1).over(_w))
_g = _g.with_columns(new_session=(pl.col("gap_before_s").is_null() | (pl.col("gap_before_s") >= SESSION_GAP_MIN * 60))).with_columns(session_id=pl.col("new_session").cast(pl.Int32).cum_sum().over(_w))
_s = _w + ["session_id"]
_g = _g.with_columns(session_idx=pl.int_range(pl.len()).over(_s) + 1, session_len=pl.len().over(_s),
    last_of_session=pl.col("gap_after_s").is_null() | (pl.col("gap_after_s") >= SESSION_GAP_MIN * 60))
_floor = ELO_ANCHORS[0]
_g = _g.with_columns(elo_bucket=(((pl.col("my_r") - _floor) // 400) * 400 + _floor).clip(_floor, ELO_ANCHORS[-1]), gap_bin=((pl.col("my_r") - pl.col("opp_r")) / CAL_BIN_ELO).floor())
_g = _g.with_columns(equal_footing=(pl.col("my_r") - pl.col("opp_r")).abs() <= EQ)
_cal = _g.filter(pl.col("equal_footing")).group_by(["tc", "elo_bucket", "gap_bin"]).agg(pl.col("score").mean().alias("exp_score"))
games = _g.join(_cal, on=["tc", "elo_bucket", "gap_bin"], how="left").with_columns(
    resid=pl.col("score") - pl.col("exp_score"), rematch=pl.col("opp") == pl.col("prev_opp"),
    in_session=pl.col("gap_before_s") < SESSION_GAP_MIN * 60).sort(_w + ["played_at"])
# session-local loss streak (consecutive losses within the session, ending at previous game)
games = games.with_columns(
    sess_streak_dir=pl.when(pl.col("in_session")).then(pl.col("streak_dir")).otherwise(None),
    sess_streak_len=pl.when(pl.col("in_session")).then(pl.col("streak_len")).otherwise(None),
)
def lab(d="streak_dir", n="streak_len"):
    d, n = pl.col(d), pl.col(n)
    return (pl.when(d.is_null()).then(pl.lit("first")).when(d == 0).then(pl.lit("D"))
        .when((d == -1) & (n >= 3)).then(pl.lit("LLL+")).when((d == -1) & (n == 2)).then(pl.lit("LL")).when(d == -1).then(pl.lit("L"))
        .when((d == 1) & (n >= 3)).then(pl.lit("WWW+")).when((d == 1) & (n == 2)).then(pl.lit("WW")).otherwise(pl.lit("W")))
games = games.with_columns(streak=lab())
scored = games.filter(pl.col("equal_footing"))
S = ["LLL+", "LL", "L", "D", "W", "WW", "WWW+"]

def boot(df, col, reps=300, seed=7):
    pu = df.group_by("user_id").agg(pl.col(col).sum().alias("s"), pl.col(col).count().alias("n"))
    s = pu["s"].to_numpy(); n = pu["n"].to_numpy().astype(float)
    rng = np.random.default_rng(seed); idx = rng.integers(0, len(s), size=(reps, len(s)))
    b = s[idx].sum(1) / n[idx].sum(1)
    return float(s.sum() / n.sum()), float(np.percentile(b, 2.5)), float(np.percentile(b, 97.5))

def table(df, col, groups=S, by="streak", scale=1.0, fmt="{:+.2f}"):
    rows = []
    for tc in TC_ORDER:
        r = {"tc": tc}
        for g in groups:
            d = df.filter((pl.col("tc") == tc) & (pl.col(by) == g))
            m, lo, hi = boot(d, col)
            r[g] = f"{fmt.format(m*scale)} [{fmt.format(lo*scale)},{fmt.format(hi*scale)}] n={d.height//1000}k"
        rows.append(r)
    return pl.DataFrame(rows)

print("\n=== A1. Spiral: P(loss) raw vs expected by consecutive in-session losses just before ===")
sp = scored.filter(pl.col("in_session") & (pl.col("streak_dir") == -1)).with_columns(k=pl.col("streak_len").clip(upper_bound=7))
print(sp.group_by(["tc", "k"]).agg(pl.len().alias("n"), (pl.col("score") == 0).mean().alias("p_loss_raw"), pl.col("exp_score").mean().alias("exp"), pl.col("score").mean().alias("score"),
    pl.col("resid").mean().alias("resid")).sort(["tc", "k"]).with_columns(pl.col("tc").cast(pl.Enum(TC_ORDER))).sort(["tc","k"]))

print("\n=== A2. Stop-loss counterfactual: what a 'stop after LL' rule would have saved (per user per 100 games) ===")
after_ll = scored.filter(pl.col("in_session") & (pl.col("streak_dir") == -1) & (pl.col("streak_len") >= 2))
for tc in TC_ORDER:
    d = after_ll.filter(pl.col("tc") == tc); tot = scored.filter(pl.col("tc") == tc).height
    m, lo, hi = boot(d, "resid")
    share = d.height / tot
    print(f"{tc:10s} games after LL in-session: {share*100:.1f}% of games; resid {m*100:+.2f} pp -> per 100 games: {share*m*100:+.3f} pp of score = {share*m*100*2:+.3f} 'extra losses'/100 games; ~{share*m*100*12/100:+.3f} rating pts per 100 games at K=12")

print("\n=== A3. Session net outcome after going LL and continuing (rest of session, raw score & resid) ===")
# mark the first LL moment in a session, look at remaining games in session
g2 = games.with_columns(ll_here=(pl.col("in_session") & (pl.col("streak_dir") == -1) & (pl.col("streak_len") == 2)))
g2 = g2.with_columns(after_ll=pl.col("ll_here").cum_sum().over(_s) >= 1)
rest = g2.filter(pl.col("after_ll") & pl.col("equal_footing"))
sess = rest.group_by(_s + []).agg(pl.len().alias("n_rest"), pl.col("score").sum().alias("pts"), pl.col("exp_score").sum().alias("exp_pts"), pl.col("resid").sum().alias("resid_sum"), pl.col("tc").first().alias("tc2"))
print(sess.group_by("tc").agg(pl.len().alias("sessions"), pl.col("n_rest").mean().alias("games_after_LL"), (pl.col("pts") > pl.col("exp_pts")).mean().alias("p_beat_expectation"), (pl.col("pts")/pl.col("n_rest")).mean().alias("mean_score_after"), pl.col("resid_sum").mean().alias("mean_resid_sum")).with_columns(pl.col("tc").cast(pl.Enum(TC_ORDER))).sort("tc"))
# and: how much of a user's total residual sum sits in sessions containing LLL?
g3 = games.filter(pl.col("equal_footing")).with_columns(has_lll=((pl.col("streak_dir") == -1) & (pl.col("streak_len") >= 3) & pl.col("in_session")).any().over(_s))
print(g3.group_by(["tc", "has_lll"]).agg(pl.len().alias("n"), pl.col("resid").mean().alias("resid"), pl.col("score").mean().alias("score")).sort(["tc", "has_lll"]))

print("\n=== A4. Termination / behaviour of the next game after L vs W (same session, scored) ===")
ns = scored.filter(pl.col("in_session"))
beh = ns.group_by(["tc", "streak"]).agg(pl.len().alias("n"),
    (pl.col("termination") == "timeout").mean().alias("flag"),
    (pl.col("termination") == "resignation").mean().alias("resign"),
    (pl.col("termination") == "abandoned").mean().alias("abandon"),
    (pl.col("ply_count") <= 20).mean().alias("short"), pl.col("ply_count").mean().alias("plies"),
    ((pl.col("termination") == "timeout") & (pl.col("score") == 0)).mean().alias("flagged_loss"),
    pl.col("rematch").mean().alias("rematch"))
print(beh.filter(pl.col("streak").is_in(["LLL+", "L", "W", "WWW+"])).with_columns(pl.col("tc").cast(pl.Enum(TC_ORDER)), pl.col("streak").cast(pl.Enum(S))).sort(["tc", "streak"]))
print("termination values:", games["termination"].value_counts().sort("count", descending=True))

# ---------- B. move features ----------
import os
if os.path.exists(OUT + "move_feats.parquet"):
    mf = pl.read_parquet(OUT + "move_feats.parquet")
    uc = pl.read_parquet(OUT + "acc.parquet")
    # my side: white -> side 0
    my = games.join(uc, on="game_id", how="left").with_columns(side=pl.when(pl.col("user_color") == "white").then(0).otherwise(1))
    my = my.join(mf, on=["game_id", "side"], how="left")
    my = my.with_columns(
        think_per_move_o=pl.col("think_o") / pl.col("n_think_o"),
        fast1_share_o=pl.col("fast1_o") / pl.col("n_think_o"),
        fast2_share_o=pl.col("fast2_o") / pl.col("n_think_o"),
        fast1_share_all=pl.col("fast1_all") / pl.col("n_think"),
        clk_m20_frac=pl.col("clk_m20") / pl.col("base_s"),
        clk_last_frac=pl.col("clk_last") / pl.col("base_s"),
        my_blunders=pl.when(pl.col("user_color") == "white").then(pl.col("white_blunders")).otherwise(pl.col("black_blunders")),
        my_mistakes=pl.when(pl.col("user_color") == "white").then(pl.col("white_mistakes")).otherwise(pl.col("black_mistakes")),
        my_acpl=pl.when(pl.col("user_color") == "white").then(pl.col("w_acpl")).otherwise(pl.col("b_acpl")),
    ).with_columns(blunders_per100=pl.col("my_blunders") / (pl.col("ply_count") / 2) * 100)
    ms = my.filter(pl.col("equal_footing") & pl.col("in_session") & (pl.col("n_think_o") >= 10))
    print("\n=== B1. Think time per move, moves 3-20 (s), next game by streak ===")
    print(table(ms, "think_per_move_o", ["LLL+", "LL", "L", "W", "WW", "WWW+"], fmt="{:.2f}"))
    print("\n=== B2. Share of moves (3-20) played in <=1 s ===")
    print(table(ms, "fast1_share_o", ["LLL+", "L", "W", "WWW+"], scale=100, fmt="{:.1f}"))
    print("\n=== B2b. Share of ALL moves played in <=1 s ===")
    print(table(ms, "fast1_share_all", ["LLL+", "L", "W", "WWW+"], scale=100, fmt="{:.1f}"))
    print("\n=== B3. Clock left after move 20 (% of base) ===")
    print(table(ms, "clk_m20_frac", ["LLL+", "L", "W", "WWW+"], scale=100, fmt="{:.1f}"))
    print("\n=== B4. Max single think (s) ===")
    print(table(ms, "max_think", ["LLL+", "L", "W", "WWW+"], fmt="{:.1f}"))
    # paired per-user L vs W for think time
    print("\n=== B5. Paired per-user: think/move after L minus after W (users with >=20 each) ===")
    pu = ms.filter(pl.col("streak").is_in(["L", "W"])).group_by(["user_id", "tc", "streak"]).agg(pl.col("think_per_move_o").mean().alias("m"), pl.len().alias("n")).filter(pl.col("n") >= 20)
    pv = pu.pivot(on="streak", index=["user_id", "tc"], values="m").drop_nulls()
    print(pv.with_columns(d=pl.col("L") - pl.col("W"), rel=(pl.col("L") / pl.col("W") - 1)).group_by("tc").agg(pl.len().alias("users"), pl.col("d").mean().alias("mean_diff_s"), pl.col("rel").mean().alias("mean_rel"), (pl.col("d") < 0).mean().alias("share_faster_after_L")).with_columns(pl.col("tc").cast(pl.Enum(TC_ORDER))).sort("tc"))

    print("\n=== C1. Selection check: P(game analyzed on lichess) by streak ===")
    print(table(ms, "analyzed", ["LLL+", "L", "W", "WWW+"], scale=100, fmt="{:.1f}"))
    an = ms.filter(pl.col("analyzed") & pl.col("my_acpl").is_not_null())
    print("\n=== C2. ACPL (lichess imported, self-selected) by streak ===")
    print(table(an, "my_acpl", ["LLL+", "L", "W", "WWW+"], fmt="{:.1f}"))
    print("\n=== C3. Blunders per game by streak ===")
    print(table(an, "my_blunders", ["LLL+", "L", "W", "WWW+"], fmt="{:.2f}"))
    print("\n=== C3b. Blunders per 100 own moves by streak ===")
    print(table(an.filter(pl.col("ply_count") >= 20), "blunders_per100", ["LLL+", "L", "W", "WWW+"], fmt="{:.2f}"))
    print("\n=== C4. ACPL conditional on the game's own result (to see the selection direction) ===")
    print(an.group_by(["tc", "score"]).agg(pl.len().alias("n"), pl.col("my_acpl").mean()).sort(["tc", "score"]))

    print("\n=== D. Opening switch: same-colour previous game, hash after 2 moves each ===")
    oc = my.sort(_w + ["played_at"]).with_columns(
        prev_c_hash3=pl.col("hash_p3").shift(1).over(_w + ["user_color"]),
        prev_c_hash7=pl.col("hash_p7").shift(1).over(_w + ["user_color"]),
        prev_c_score=pl.col("score").shift(1).over(_w + ["user_color"]),
        prev_c_played=pl.col("played_at").shift(1).over(_w + ["user_color"]),
    ).with_columns(
        switch3=(pl.col("hash_p3") != pl.col("prev_c_hash3")).cast(pl.Float64),
        switch7=(pl.col("hash_p7") != pl.col("prev_c_hash7")).cast(pl.Float64),
        prev_c_res=pl.when(pl.col("prev_c_score") == 1).then(pl.lit("W")).when(pl.col("prev_c_score") == 0).then(pl.lit("L")).otherwise(pl.lit("D")),
        prev_c_recent=(pl.col("played_at") - pl.col("prev_c_played")).dt.total_minutes() < 60,
    ).filter(pl.col("hash_p3").is_not_null() & pl.col("prev_c_hash3").is_not_null() & pl.col("prev_c_recent"))
    print("P(switch at move 2) by result of previous same-colour game (within 60 min):")
    print(table(oc, "switch3", ["L", "W"], by="prev_c_res", scale=100, fmt="{:.1f}"))
    print("P(switch at move 4):")
    print(table(oc.filter(pl.col("hash_p7").is_not_null() & pl.col("prev_c_hash7").is_not_null()), "switch7", ["L", "W"], by="prev_c_res", scale=100, fmt="{:.1f}"))
    # does switching after a loss help? residual next game by (prev L, switched vs not)
    print("Residual (pp) after a same-colour loss: switched vs stayed (move 4 line):")
    oc2 = oc.filter(pl.col("equal_footing") & (pl.col("prev_c_res") == "L") & pl.col("hash_p7").is_not_null() & pl.col("prev_c_hash7").is_not_null()).with_columns(sw=pl.when(pl.col("switch7") == 1).then(pl.lit("switched")).otherwise(pl.lit("stayed")))
    print(table(oc2, "resid", ["switched", "stayed"], by="sw", scale=100))
