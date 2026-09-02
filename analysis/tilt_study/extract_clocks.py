"""One-off extraction: per-game final clock of each side, cached as parquet.

Duration of a game = time used by both sides. clock_seconds at ply p is the
mover's clock after the move (ply 0 = white's first move, even = white).
Run: uv run --project analysis python analysis/tilt_study/extract_clocks.py
"""

import sys
import time
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
from analysis import db  # noqa: E402  (sys.path insert above must run first)

OUT = REPO / "analysis/out/tilt/clock_ends.parquet"
SQL = """
SELECT game_id,
       max(ply) FILTER (WHERE clock_seconds IS NOT NULL) AS last_ply,
       min(clock_seconds) FILTER (WHERE ply %% 2 = 0) AS w_last_clk,
       min(clock_seconds) FILTER (WHERE ply %% 2 = 1) AS b_last_clk,
       count(clock_seconds) AS n_clk
FROM game_positions
WHERE game_id BETWEEN %s AND %s
GROUP BY game_id
"""
t0 = time.time()
with db.connect("benchmark") as conn:
    lo, hi = conn.execute("SELECT min(id), max(id) FROM games").fetchone()
    step = 200_000
    parts = []
    for a in range(lo, hi + 1, step):
        rows = conn.execute(SQL, (a, a + step - 1)).fetchall()
        parts.append(
            pl.DataFrame(
                rows,
                schema=["game_id", "last_ply", "w_last_clk", "b_last_clk", "n_clk"],
                orient="row",
            )
        )
        print(f"{a}..{a + step - 1} rows={parts[-1].height} t={time.time() - t0:.0f}s", flush=True)
df = pl.concat(parts)
df.write_parquet(OUT)
print(df.describe(), OUT, f"{time.time() - t0:.0f}s")
