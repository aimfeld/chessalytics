import sys; sys.path.insert(0, ".")
from analysis import db
import polars as pl
Q = """SELECT id AS game_id, user_color, white_blunders, black_blunders, white_mistakes, black_mistakes,
  white_acpl_imported AS w_acpl, black_acpl_imported AS b_acpl, (lichess_evals_at IS NOT NULL) AS analyzed
  FROM games WHERE rated AND NOT is_computer_game"""
with db.connect("benchmark") as c:
    df = pl.read_database(Q, c)
df.write_parquet("analysis/out/tilt/acc.parquet"); print(df.describe())
