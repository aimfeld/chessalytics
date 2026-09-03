import sys; sys.path.insert(0, ".")
from analysis import db
import polars as pl
Q = """SELECT f.game_id,
  count(*) FILTER (WHERE f.ply % 2 = 0 AND f.severity = 2) AS w_bl, count(*) FILTER (WHERE f.ply % 2 = 1 AND f.severity = 2) AS b_bl,
  count(*) FILTER (WHERE f.ply % 2 = 0 AND f.severity = 1) AS w_mi, count(*) FILTER (WHERE f.ply % 2 = 1 AND f.severity = 1) AS b_mi
  FROM game_flaws f JOIN games g ON g.id = f.game_id
  WHERE g.full_evals_completed_at IS NOT NULL AND g.lichess_evals_at IS NULL
  GROUP BY f.game_id"""
Q2 = "SELECT id AS game_id, time_control_bucket tc FROM games WHERE full_evals_completed_at IS NOT NULL AND lichess_evals_at IS NULL AND rated AND NOT is_computer_game"
with db.connect("benchmark") as c:
    fl = pl.read_database(Q, c); byus = pl.read_database(Q2, c)
byus.join(fl, on="game_id", how="left").fill_null(0).write_parquet("analysis/out/tilt/flaws_byus.parquet")
print(byus.group_by("tc").len(), fl.height)
