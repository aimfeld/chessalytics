"""Per-game per-side move features: think times, fast-move share, opening hashes."""
import sys, time
sys.path.insert(0, ".")
from analysis import db
import polars as pl
OUT = "analysis/out/tilt/move_feats.parquet"
SQL = """
WITH p AS (
  SELECT p.game_id, p.ply, p.ply %% 2 AS side, p.clock_seconds AS clk, p.full_hash,
         LAG(p.clock_seconds) OVER (PARTITION BY p.game_id, p.ply %% 2 ORDER BY p.ply) AS prev_clk,
         g.increment_seconds AS inc
  FROM game_positions p JOIN games g ON g.id = p.game_id
  WHERE p.game_id BETWEEN %s AND %s
), t AS (
  SELECT *, (prev_clk + inc - clk) AS think FROM p
)
SELECT game_id, side,
  count(*) AS n_plies,
  count(clk) AS n_clk,
  min(clk) FILTER (WHERE ply <= 19) AS clk_m10,
  min(clk) FILTER (WHERE ply <= 39) AS clk_m20,
  min(clk) AS clk_last,
  count(*) FILTER (WHERE think IS NOT NULL AND ply BETWEEN 4 AND 39) AS n_think_o,
  sum(think) FILTER (WHERE think IS NOT NULL AND ply BETWEEN 4 AND 39) AS think_o,
  count(*) FILTER (WHERE think IS NOT NULL AND ply BETWEEN 4 AND 39 AND think <= 1) AS fast1_o,
  count(*) FILTER (WHERE think IS NOT NULL AND ply BETWEEN 4 AND 39 AND think <= 2) AS fast2_o,
  count(*) FILTER (WHERE think IS NOT NULL) AS n_think,
  sum(think) FILTER (WHERE think IS NOT NULL) AS think_all,
  count(*) FILTER (WHERE think IS NOT NULL AND think <= 1) AS fast1_all,
  max(think) AS max_think,
  min(full_hash) FILTER (WHERE ply = 3) AS hash_p3,
  min(full_hash) FILTER (WHERE ply = 7) AS hash_p7
FROM t GROUP BY game_id, side
"""
t0 = time.time()
with db.connect("benchmark") as conn:
    lo, hi = conn.execute("SELECT min(id), max(id) FROM games").fetchone()
    step = 100_000
    parts = []
    for a in range(lo, hi + 1, step):
        rows = conn.execute(SQL, (a, a + step - 1)).fetchall()
        parts.append(pl.DataFrame(rows, schema=["game_id","side","n_plies","n_clk","clk_m10","clk_m20","clk_last",
            "n_think_o","think_o","fast1_o","fast2_o","n_think","think_all","fast1_all","max_think","hash_p3","hash_p7"], orient="row"))
        print(f"{a} rows={parts[-1].height} t={time.time()-t0:.0f}s", flush=True)
df = pl.concat(parts)
df.write_parquet(OUT)
print(df.describe(), f"{time.time()-t0:.0f}s")
