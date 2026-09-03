import sys; sys.path.insert(0, ".")
from analysis import db
import polars as pl
pl.Config.set_tbl_rows(40); pl.Config.set_tbl_width_chars(200)
Q = """SELECT user_id, played_at, time_control_bucket tc, rated,
  CASE WHEN (result='1-0' AND user_color='white') OR (result='0-1' AND user_color='black') THEN 1.0 WHEN result='1/2-1/2' THEN 0.5 ELSE 0.0 END AS score,
  base_time_seconds base_s
  FROM games WHERE NOT is_computer_game"""
with db.connect("benchmark") as c:
    g = pl.read_database(Q, c)
print("rated share:", g["rated"].mean(), g.height)
rank = {"bullet": 0, "blitz": 1, "rapid": 2, "classical": 3}
g = g.sort(["user_id", "played_at"]).with_columns(tcr=pl.col("tc").replace_strict(rank)).with_columns(
    next_tcr=pl.col("tcr").shift(-1).over("user_id"), next_rated=pl.col("rated").shift(-1).over("user_id"),
    next_base=pl.col("base_s").shift(-1).over("user_id"),
    gap_min=(pl.col("played_at").shift(-1) - pl.col("played_at")).dt.total_minutes().over("user_id"),
    res=pl.when(pl.col("score") == 1).then(pl.lit("W")).when(pl.col("score") == 0).then(pl.lit("L")).otherwise(pl.lit("D")))
h = g.filter(pl.col("rated") & (pl.col("gap_min") < 60) & pl.col("next_tcr").is_not_null())
print(h.group_by(["tc", "res"]).agg(pl.len().alias("n"), (pl.col("next_tcr") < pl.col("tcr")).mean().alias("p_faster_tc"),
    (pl.col("next_tcr") > pl.col("tcr")).mean().alias("p_slower_tc"), (pl.col("next_base") < pl.col("base_s")).mean().alias("p_shorter_base"),
    (~pl.col("next_rated")).mean().alias("p_next_casual")).filter(pl.col("res") != "D").sort(["tc", "res"]))
