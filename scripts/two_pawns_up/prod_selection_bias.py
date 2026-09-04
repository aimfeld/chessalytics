"""Direct measurement of the analysis-request selection bias (report §6).

The v2 report's §6 could only bound the bias because the benchmark cohort exists
only where a Lichess server analysis exists. Prod removes that wall: every
non-guest game gets our own Stockfish evals, so games WITHOUT a Lichess analysis
still have per-ply evals and an identifiable middlegame-entry lead. This script
measures, within the same player, how entry-lead outcomes differ between their
Lichess-analyzed and non-Lichess-analyzed games — the §6.4 "untestable remainder",
tested.

Cohort: prod lichess games of non-guest users, rated, human, both ratings present,
blitz/rapid (classical is too thin in prod: ~1.2k games), equal footing
(abs gap <= 100), >= 90% eval coverage — i.e. the v2 report's cohort rules with
`platform='lichess' AND NOT is_guest` replacing the benchmark-pool join.
All game-level semantics (entry ply, entry lead, leader identity, outcome) are
imported from gen_report_v2.Fact, so they are identical to the report's by
construction.

Estimators: prod has only ~85 distinct users and heavy per-user concentration, so
pooled rates are reported for context only. Every headline number is a
user-stratified paired delta (Mantel-Haenszel weights n1*n0/(n1+n0) over users
with games in both arms) with a 95% cluster-bootstrap CI resampling users.
This is the paired-not-pooled lesson of report §6.2 applied throughout.

Usage:
    bin/prod_db_tunnel.sh              # tunnel must be up
    uv run python scripts/two_pawns_up/prod_selection_bias.py            # prod
    uv run python scripts/two_pawns_up/prod_selection_bias.py --db dev   # smoke
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from gen_report_v2 import (  # noqa: E402
    COVERAGE_MIN,
    MATE_ABS,
    Fact,
    equal_footing,
)

from app.core.config import db_url_for_target  # noqa: E402

TC_BUCKETS = ("blitz", "rapid")  # classical: ~1.2k prod games, decoration not data
USER_BATCH = 12  # keep each game_positions pass small and index-friendly
BOOTSTRAP_ITERS = 2000
BOOTSTRAP_SEED = 151  # SEED-151 heritage
SCORE_MIN_GAMES_PER_ARM = 20  # mirrors benchmarks §1's paired-score estimator
SENSITIVITY_THRESHOLDS = (180, 200, 220)  # eval-source drift check at the boundary

USER_IDS_SQL = """
SELECT DISTINCT g.user_id
FROM games g
JOIN users u ON u.id = g.user_id
WHERE g.platform = 'lichess'
  AND g.rated AND NOT g.is_computer_game
  AND NOT u.is_guest
  AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
  AND g.time_control_bucket::text IN :tcs
ORDER BY g.user_id
"""

# gen_report_v2.FACT_SQL with the benchmark-pool join replaced by the prod cohort
# filters, plus two appended columns (user_id, lichess_analyzed) that are peeled
# off before the row is handed to Fact(*row) — column order otherwise mirrors the
# report query exactly so the shared dataclass keeps identical semantics.
FACT_SQL = f"""
WITH cohort_games AS (
  SELECT g.id, g.result, g.termination::text AS termination,
         g.time_control_bucket::text AS tc_bucket,
         g.user_color::text AS user_color,
         CASE WHEN g.user_color::text = 'white' THEN g.white_rating ELSE g.black_rating END AS user_rating,
         CASE WHEN g.user_color::text = 'white' THEN g.black_rating ELSE g.white_rating END AS opp_rating,
         g.white_inaccuracies, g.black_inaccuracies,
         g.white_mistakes, g.black_mistakes,
         g.white_blunders, g.black_blunders,
         g.user_id,
         (g.lichess_evals_at IS NOT NULL) AS lichess_analyzed
  FROM games g
  JOIN users u ON u.id = g.user_id
  WHERE g.platform = 'lichess'
    AND g.rated AND NOT g.is_computer_game
    AND NOT u.is_guest
    AND g.white_rating IS NOT NULL AND g.black_rating IS NOT NULL
    AND g.time_control_bucket::text IN :tcs
    AND g.user_id = ANY(:uids)
),
bucketed AS (
  SELECT *,
    CASE
      WHEN user_rating BETWEEN  600 AND  999 THEN  800
      WHEN user_rating BETWEEN 1000 AND 1399 THEN 1200
      WHEN user_rating BETWEEN 1400 AND 1799 THEN 1600
      WHEN user_rating BETWEEN 1800 AND 2199 THEN 2000
      WHEN user_rating BETWEEN 2200 AND 2599 THEN 2400
    END AS elo_bucket
  FROM cohort_games
),
bounds AS (
  SELECT p.game_id,
         COUNT(*) AS total_plies,
         COUNT(*) FILTER (WHERE p.eval_cp IS NOT NULL OR p.eval_mate IS NOT NULL) AS evaled_plies,
         MAX(p.ply) AS max_ply,
         MIN(p.ply) FILTER (WHERE p.phase > 0) AS entry_ply,
         MAX(p.ply) FILTER (WHERE p.eval_cp IS NOT NULL OR p.eval_mate IS NOT NULL) AS last_eval_ply
  FROM game_positions p
  JOIN bucketed b ON b.id = p.game_id
  GROUP BY p.game_id
),
included AS (
  SELECT b.*, bo.max_ply, bo.entry_ply, bo.last_eval_ply
  FROM bucketed b
  JOIN bounds bo ON bo.game_id = b.id
  WHERE bo.evaled_plies::numeric / NULLIF(bo.total_plies, 0) >= {COVERAGE_MIN}
    AND b.elo_bucket IS NOT NULL
),
mg AS (
  SELECT p.game_id,
         COUNT(*) AS mg_positions,
         MIN(CASE WHEN p.eval_cp IS NOT NULL THEN abs(p.eval_cp)
                  WHEN p.eval_mate IS NOT NULL THEN {MATE_ABS} END) AS mg_min_abs,
         MIN(CASE WHEN p.eval_cp IS NOT NULL THEN sign(p.eval_cp)::int
                  WHEN p.eval_mate IS NOT NULL THEN sign(p.eval_mate)::int END) AS mg_min_sign,
         MAX(CASE WHEN p.eval_cp IS NOT NULL THEN sign(p.eval_cp)::int
                  WHEN p.eval_mate IS NOT NULL THEN sign(p.eval_mate)::int END) AS mg_max_sign
  FROM game_positions p
  JOIN included i ON i.id = p.game_id
  WHERE p.phase > 0 AND p.ply > 0 AND p.ply < i.max_ply
    AND (p.eval_cp IS NOT NULL OR p.eval_mate IS NOT NULL)
  GROUP BY p.game_id
)
SELECT i.id, i.elo_bucket, i.tc_bucket, i.result, i.termination, i.user_color,
       i.user_rating, i.opp_rating,
       i.white_inaccuracies, i.black_inaccuracies,
       i.white_mistakes, i.black_mistakes,
       i.white_blunders, i.black_blunders,
       i.entry_ply,
       ep.eval_cp AS entry_cp, ep.eval_mate AS entry_mate,
       le.eval_cp AS last_cp, le.eval_mate AS last_mate,
       COALESCE(m.mg_positions, 0) AS mg_positions,
       m.mg_min_abs, m.mg_min_sign, m.mg_max_sign,
       i.user_id, i.lichess_analyzed
FROM included i
LEFT JOIN game_positions ep ON ep.game_id = i.id AND ep.ply = i.entry_ply
LEFT JOIN game_positions le ON le.game_id = i.id AND le.ply = i.last_eval_ply
LEFT JOIN mg m ON m.game_id = i.id
"""


@dataclass(slots=True)
class ProdFact:
    fact: Fact
    user_id: int
    analyzed: bool

    @property
    def user_score(self) -> float:
        if self.fact.result == "1/2-1/2":
            return 0.5
        user_sign = 1 if self.fact.user_color == "white" else -1
        return 1.0 if self.fact.side_won(user_sign) else 0.0


async def load_facts(db: str) -> list[ProdFact]:
    engine = create_async_engine(db_url_for_target(db))
    rows: list[ProdFact] = []
    try:
        async with engine.connect() as conn:
            res = await conn.execute(
                text(USER_IDS_SQL).bindparams(
                    bindparam("tcs", expanding=True, value=list(TC_BUCKETS))
                )
            )
            user_ids = [r[0] for r in res]
            print(f"cohort users: {len(user_ids)}", file=sys.stderr)
            for i in range(0, len(user_ids), USER_BATCH):
                batch = user_ids[i : i + USER_BATCH]
                res = await conn.execute(
                    text(FACT_SQL).bindparams(
                        bindparam("tcs", expanding=True, value=list(TC_BUCKETS)),
                        uids=batch,
                    )
                )
                for row in res.tuples():
                    *fact_cols, user_id, analyzed = row
                    rows.append(ProdFact(Fact(*fact_cols), user_id, analyzed))
                print(
                    f"  users {i + 1}-{i + len(batch)}: {len(rows)} facts so far",
                    file=sys.stderr,
                )
    finally:
        await engine.dispose()
    return rows


# ---------- user-stratified estimation ----------

# Per user, one [trials, successes] pair per arm; arm key True = lichess-analyzed.
# successes is a float accumulator (success() may return partial/fractional credit).
UserArms = dict[int, dict[bool, list[float]]]


def collect(
    rows: list[ProdFact],
    trial: Callable[[ProdFact], bool],
    success: Callable[[ProdFact], float],
) -> UserArms:
    arms: UserArms = defaultdict(lambda: {True: [0.0, 0.0], False: [0.0, 0.0]})
    for r in rows:
        if trial(r):
            cell = arms[r.user_id][r.analyzed]
            cell[0] += 1
            cell[1] += success(r)
    return arms


def pooled_rate(arms: UserArms, arm: bool) -> tuple[int, float | None]:
    # Trial counts (index 0) are always whole numbers even though the list is
    # typed float to share storage with the fractional success accumulator.
    n = int(sum(a[arm][0] for a in arms.values()))
    s = sum(a[arm][1] for a in arms.values())
    return n, (s / n if n else None)


def stratified_delta(arms: UserArms, users: "list[int] | None" = None) -> float | None:
    """MH-weighted mean of per-user (analyzed - unanalyzed) rate deltas."""
    num = den = 0.0
    for uid in users if users is not None else arms.keys():
        a = arms.get(uid)
        if a is None:
            continue
        n1, s1 = a[True]
        n0, s0 = a[False]
        if n1 == 0 or n0 == 0:
            continue
        w = n1 * n0 / (n1 + n0)
        num += w * (s1 / n1 - s0 / n0)
        den += w
    return num / den if den else None


def bootstrap_ci(arms: UserArms) -> tuple[float, float] | None:
    uids = [u for u, a in arms.items() if a[True][0] and a[False][0]]
    if len(uids) < 5:
        return None
    rng = random.Random(BOOTSTRAP_SEED)
    deltas = []
    for _ in range(BOOTSTRAP_ITERS):
        sample = rng.choices(uids, k=len(uids))
        d = stratified_delta(arms, sample)
        if d is not None:
            deltas.append(d)
    deltas.sort()
    lo = deltas[int(0.025 * len(deltas))]
    hi = deltas[int(0.975 * len(deltas)) - 1]
    return lo, hi


def contributing_users(arms: UserArms) -> int:
    return sum(1 for a in arms.values() if a[True][0] and a[False][0])


def fmt_pct(v: float | None, digits: int = 1) -> str:
    return "—" if v is None else f"{100 * v:.{digits}f}%"


def fmt_pp(v: float | None) -> str:
    return "—" if v is None else f"{100 * v:+.1f}pp"


def fmt_ci(ci: tuple[float, float] | None) -> str:
    return "—" if ci is None else f"[{100 * ci[0]:+.1f}, {100 * ci[1]:+.1f}]"


def report_contrast(title: str, arms: UserArms) -> None:
    n1, p1 = pooled_rate(arms, True)
    n0, p0 = pooled_rate(arms, False)
    d = stratified_delta(arms)
    ci = bootstrap_ci(arms)
    print(
        f"| {title} | {n1:,} | {fmt_pct(p1)} | {n0:,} | {fmt_pct(p0)} "
        f"| {fmt_pp(d)} | {fmt_ci(ci)} | {contributing_users(arms)} |"
    )


def is_entry_lead_at(f: Fact, threshold: int) -> bool:
    ea, es = f.entry_abs, f.entry_sign
    return ea is not None and ea >= threshold and es is not None and es != 0


def main_analysis(rows: list[ProdFact]) -> None:
    rows = [r for r in rows if equal_footing(r.fact)]
    n1 = sum(1 for r in rows if r.analyzed)
    print(
        f"Equal-footing cohort: {len(rows):,} games "
        f"({n1:,} lichess-analyzed, {len(rows) - n1:,} not), "
        f"{len({r.user_id for r in rows})} users\n"
    )

    header = (
        "| Metric | analyzed n | analyzed rate | unanalyzed n | unanalyzed rate "
        "| stratified Δ | 95% CI (pp) | users |"
    )
    rule = "|---|---:|---:|---:|---:|---:|---:|---:|"

    print("### A. Replication of the §6.2 loss tilt (user score, all cohort games)\n")
    print(header)
    print(rule)
    report_contrast(
        "user score (win + ½ draw)",
        collect(rows, lambda r: True, lambda r: r.user_score),
    )
    for tc in TC_BUCKETS:
        arms = collect(rows, lambda r, tc=tc: r.fact.tc == tc, lambda r: r.user_score)
        big = {
            u: a
            for u, a in arms.items()
            if a[True][0] >= SCORE_MIN_GAMES_PER_ARM and a[False][0] >= SCORE_MIN_GAMES_PER_ARM
        }
        report_contrast(f"user score, {tc} (≥{SCORE_MIN_GAMES_PER_ARM}/arm)", big)

    print("\n### B. Entry-lead prevalence (someone enters the MG at ≥ +2)\n")
    print(header)
    print(rule)
    report_contrast(
        "entry-lead prevalence",
        collect(rows, lambda r: True, lambda r: float(r.fact.is_entry_lead)),
    )
    for side, name in ((True, "user-led"), (False, "opp-led")):
        report_contrast(
            f"prevalence, {name}",
            collect(
                rows,
                lambda r: True,
                lambda r, side=side: float(r.fact.is_entry_lead and r.fact.user_is_leader == side),
            ),
        )

    print("\n### C. Leader loses, among entry-lead games (the §6 question)\n")
    print(header)
    print(rule)
    lead_rows = [r for r in rows if r.fact.is_entry_lead]
    for side, name in ((True, "user's"), (False, "opponent's")):
        report_contrast(
            f"{name} entry leads ending in a loss",
            collect(
                lead_rows,
                lambda r, side=side: r.fact.user_is_leader == side,
                lambda r: float(r.fact.outcome == "ll"),
            ),
        )
    report_contrast(
        "all entry leads ending in a loss",
        collect(lead_rows, lambda r: True, lambda r: float(r.fact.outcome == "ll")),
    )

    print("\n### D. Threshold sensitivity (eval-source drift check)\n")
    print(header)
    print(rule)
    for thr in SENSITIVITY_THRESHOLDS:
        for side, name in ((True, "user's"), (False, "opponent's")):
            report_contrast(
                f"{name} leads lost, threshold ≥{thr}cp",
                collect(
                    rows,
                    lambda r, thr=thr, side=side: (
                        is_entry_lead_at(r.fact, thr) and r.fact.user_is_leader == side
                    ),
                    lambda r: float(r.fact.outcome == "ll"),
                ),
            )

    print("\n### E. Per rating bucket (raw rates; user-led entry-lead games)\n")
    print(
        "| Bucket | analyzed n | analyzed loses | unanalyzed n | unanalyzed loses "
        "| stratified Δ | users |"
    )
    print("|---|---:|---:|---:|---:|---:|---:|")
    for elo in (800, 1200, 1600, 2000, 2400):
        arms = collect(
            lead_rows,
            lambda r, elo=elo: r.fact.elo == elo and r.fact.user_is_leader,
            lambda r: float(r.fact.outcome == "ll"),
        )
        na, pa = pooled_rate(arms, True)
        nu, pu = pooled_rate(arms, False)
        print(
            f"| {elo} | {na:,} | {fmt_pct(pa)} | {nu:,} | {fmt_pct(pu)} "
            f"| {fmt_pp(stratified_delta(arms))} | {contributing_users(arms)} |"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="prod", choices=["dev", "prod", "benchmark"])
    parser.add_argument(
        "--exclude-user-ids",
        type=int,
        nargs="*",
        default=[],
        help="drop these user ids (robustness check for dominant/internal accounts)",
    )
    args = parser.parse_args()
    rows = asyncio.run(load_facts(args.db))
    if args.exclude_user_ids:
        excluded = set(args.exclude_user_ids)
        rows = [r for r in rows if r.user_id not in excluded]
        print(f"(excluding user ids {sorted(excluded)})")
    print(f"\nLoaded {len(rows):,} fact rows from {args.db}\n")
    main_analysis(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
