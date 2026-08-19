"""Generator for the two-pawns-up report v2 (SEED-151).

Re-runs every analysis of stories/two-pawns-up/two-pawns-up-report-v1.md on TWO bases
from identical code:

- v1 basis: the cohort half of BASE_GAME_FILTER only (rated, human) — the published
  report's basis.
- v2 basis: v1 basis + the equal-footing opponent filter (both ratings present,
  abs(user − opp) <= EQUAL_FOOTING_TOLERANCE), applied in Python so every v1↔v2
  delta is attributable to the filter alone, never to a re-derivation artifact.

One fact-row query does the entire game_positions work (coverage, ply bounds,
middlegame-window aggregates) in a single grouped pass plus two indexed point-joins
(entry-ply eval, last-evaled-ply eval). Section 3 (blunder timing) is the only
other game_positions query; it is fed the entry-lead game ids and returns per-game
blunder counts, so the basis split again happens in Python.

The two `sustained` definitions are deliberately NOT collapsed into one boolean
(see SEED-151 implementation notes): the fact row carries the raw mg_positions /
mg_min_abs / mg_min_sign / mg_max_sign columns, and Section 1's condition
(no reference to the entry ply) and Section 2's (additionally min_sign = entry_sign)
are derived independently.

Before emitting anything, the v1-basis output is checked against hard-coded anchor
numbers from the published report; any mismatch aborts the run.

Usage:
    bin/benchmark_db.sh start
    uv run python stories/two-pawns-up/gen_report_v2.py            # benchmark DB
    uv run python stories/two-pawns-up/gen_report_v2.py --db dev   # smoke only

Output: markdown tables for both bases plus v1→v2 delta tables on stdout, and a
JSON dump of every table via --json PATH.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import quantiles
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.core.config import db_url_for_target  # noqa: E402
from scripts.benchmarks.sql import EQUAL_FOOTING_TOLERANCE  # noqa: E402

ELO_BUCKETS = (800, 1200, 1600, 2000, 2400)
TC_BUCKETS = ("blitz", "rapid", "classical")
ENTRY_LEAD_CP = 200  # the >= 2-pawn threshold used throughout
MATE_ABS = 10000  # mate-in-N stored as an infinite edge, matching the v1 SQL
COVERAGE_MIN = 0.90
# Section 4 bands on entry_abs; the last band absorbs mate (10000).
BANDS = (
    (200, 300, "+2.0 to +3.0"),
    (300, 500, "+3.0 to +5.0"),
    (500, 1000, "+5.0 to +10.0"),
    (1000, 10**9, "+10.0 / mate"),
)
# Lichess advice rule: blunder = mover's win% drops >= 15 points (v1 Section 3).
BLUNDER_WIN_PCT_DROP = 15
WIN_PCT_CP_CLAMP = 1000

# The single fact query: cohort -> per-game position aggregates in ONE grouped pass
# over game_positions, then two indexed point-joins for the entry-ply eval and the
# last-evaled-ply eval. All definitions mirror the v1 report's SQL verbatim.
FACT_SQL = f"""
WITH cohort_games AS (
  SELECT g.id, g.result, g.termination::text AS termination,
         g.time_control_bucket::text AS tc_bucket,
         g.user_color::text AS user_color,
         CASE WHEN g.user_color::text = 'white' THEN g.white_rating ELSE g.black_rating END AS user_rating,
         CASE WHEN g.user_color::text = 'white' THEN g.black_rating ELSE g.white_rating END AS opp_rating,
         g.white_inaccuracies, g.black_inaccuracies,
         g.white_mistakes, g.black_mistakes,
         g.white_blunders, g.black_blunders
  FROM games g
  JOIN users u ON u.id = g.user_id
  JOIN benchmark_ingest_checkpoints c
    ON c.benchmark_user_id = u.id
   AND c.tc_bucket::text = g.time_control_bucket::text
   AND c.status = 'completed'
  WHERE g.time_control_bucket::text IN ('blitz', 'rapid', 'classical')
    AND g.rated AND NOT g.is_computer_game
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
       m.mg_min_abs, m.mg_min_sign, m.mg_max_sign
FROM included i
LEFT JOIN game_positions ep ON ep.game_id = i.id AND ep.ply = i.entry_ply
LEFT JOIN game_positions le ON le.game_id = i.id AND le.ply = i.last_eval_ply
LEFT JOIN mg m ON m.game_id = i.id
"""

# Section 3: per-game blunder counts split at the entry ply, for the entry-lead
# games passed in as parallel arrays. Mirrors the v1 report's Section 3 SQL: the
# Lichess advice rule on the stored per-ply evals, with the one-half-move eval
# shift (row P holds the eval AFTER half-move P+1, so the mover at row P is White
# when P is even).
SECTION3_SQL = f"""
WITH entry AS (
  SELECT * FROM unnest(
    CAST(:ids AS bigint[]), CAST(:signs AS int[]), CAST(:plies AS int[])
  ) AS t(game_id, entry_sign, entry_ply)
),
wp AS (
  SELECT p.game_id, p.ply,
    CASE WHEN p.eval_cp IS NOT NULL
           THEN 50*(2/(1+exp(-0.004*LEAST({WIN_PCT_CP_CLAMP},
                GREATEST(-{WIN_PCT_CP_CLAMP}, p.eval_cp::int))))-1)+50
         WHEN p.eval_mate IS NOT NULL
           THEN CASE WHEN p.eval_mate > 0 THEN 100.0 ELSE 0.0 END END AS w
  FROM game_positions p
  JOIN entry e ON e.game_id = p.game_id
),
j AS (
  SELECT game_id, ply, w, lag(w) OVER (PARTITION BY game_id ORDER BY ply) AS wprev
  FROM wp
),
blun AS (
  SELECT game_id, ply,
    CASE WHEN ply % 2 = 0 AND ply > 0 AND wprev - w >= {BLUNDER_WIN_PCT_DROP} THEN 1
         WHEN ply % 2 = 1 AND w - wprev >= {BLUNDER_WIN_PCT_DROP} THEN -1
         ELSE 0 END AS by_side
  FROM j
  WHERE wprev IS NOT NULL AND w IS NOT NULL
)
SELECT e.game_id,
  COUNT(*) FILTER (WHERE b.ply >  e.entry_ply AND b.by_side =  e.entry_sign) AS leader_after,
  COUNT(*) FILTER (WHERE b.ply >  e.entry_ply AND b.by_side = -e.entry_sign) AS opp_after,
  COUNT(*) FILTER (WHERE b.ply <= e.entry_ply AND b.by_side =  e.entry_sign) AS leader_open,
  COUNT(*) FILTER (WHERE b.ply <= e.entry_ply AND b.by_side = -e.entry_sign) AS opp_open
FROM entry e
LEFT JOIN blun b ON b.game_id = e.game_id AND b.by_side <> 0
GROUP BY e.game_id
"""


@dataclass(slots=True)
class Fact:
    """One analyzed-cohort game with everything Sections 1-5 + robustness need."""

    id: int
    elo: int
    tc: str
    result: str
    termination: str | None
    user_color: str
    user_rating: int
    opp_rating: int | None
    w_inacc: int | None
    b_inacc: int | None
    w_mist: int | None
    b_mist: int | None
    w_blun: int | None
    b_blun: int | None
    entry_ply: int | None
    entry_cp: int | None
    entry_mate: int | None
    last_cp: int | None
    last_mate: int | None
    mg_positions: int
    mg_min_abs: int | None
    mg_min_sign: int | None
    mg_max_sign: int | None

    @property
    def entry_abs(self) -> int | None:
        if self.entry_cp is not None:
            return abs(self.entry_cp)
        if self.entry_mate is not None:
            return MATE_ABS
        return None

    @property
    def entry_sign(self) -> int | None:
        if self.entry_cp is not None:
            return (self.entry_cp > 0) - (self.entry_cp < 0)
        if self.entry_mate is not None:
            return (self.entry_mate > 0) - (self.entry_mate < 0)
        return None

    @property
    def s1_sustained(self) -> bool:
        """Section 1's condition — no reference to the entry ply."""
        return (
            self.mg_positions > 0
            and self.mg_min_abs is not None
            and self.mg_min_abs >= ENTRY_LEAD_CP
            and self.mg_min_sign == self.mg_max_sign
            and self.mg_min_sign != 0
        )

    @property
    def is_entry_lead(self) -> bool:
        ea, es = self.entry_abs, self.entry_sign
        return ea is not None and ea >= ENTRY_LEAD_CP and es is not None and es != 0

    @property
    def s2_sustained(self) -> bool:
        """Section 2's condition — Section 1's, additionally tied to the entry leader."""
        return self.s1_sustained and self.mg_min_sign == self.entry_sign

    def side_won(self, sign: int) -> bool:
        return (sign > 0 and self.result == "1-0") or (sign < 0 and self.result == "0-1")

    @property
    def outcome(self) -> str:
        """Section 2 four-way outcome relative to the initial leader."""
        es = self.entry_sign
        assert es is not None and es != 0
        if self.result == "1/2-1/2":
            return "draw"
        if self.side_won(es):
            return "sw" if self.s2_sustained else "wns"
        return "ll"

    @property
    def user_is_leader(self) -> bool:
        es = self.entry_sign
        assert es is not None  # only meaningful for entry-lead games
        return (es > 0) == (self.user_color == "white")

    @property
    def last_lead_cp(self) -> float:
        """Leader-relative eval at the last evaluated ply (mate = infinite)."""
        es = self.entry_sign
        assert es is not None
        if self.last_cp is not None:
            return float(self.last_cp * es)
        if self.last_mate is not None:
            return math.inf if self.last_mate * es > 0 else -math.inf
        return -math.inf  # unreachable: last_eval_ply has an eval by construction


def equal_footing(f: Fact) -> bool:
    return f.opp_rating is not None and abs(f.user_rating - f.opp_rating) <= EQUAL_FOOTING_TOLERANCE


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def pct(num: int | float, den: int | float, digits: int = 1) -> str:
    if not den:
        return "n/a"
    return f"{100.0 * num / den:.{digits}f}%"


def mean(vals: Sequence[float]) -> float:
    return sum(vals) / len(vals) if vals else float("nan")


def md_table(header: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(lines)


def q123(vals: list[int]) -> tuple[float, float, float]:
    """p25 / median / p75 with linear interpolation (matches percentile_cont)."""
    q = quantiles(vals, n=4, method="inclusive")
    return q[0], q[1], q[2]


# ---------------------------------------------------------------------------
# Per-basis table computation. Every function takes the basis' fact list, so v1
# and v2 come out of identical code.
# ---------------------------------------------------------------------------


def t_game_sample(facts: list[Fact]) -> dict[str, Any]:
    cell: dict[tuple[int, str], int] = defaultdict(int)
    for f in facts:
        cell[(f.elo, f.tc)] += 1
    rows = {e: {tc: cell[(e, tc)] for tc in TC_BUCKETS} for e in ELO_BUCKETS}
    return {"cells": rows, "total": len(facts)}


def t_section1(facts: list[Fact]) -> dict[str, Any]:
    out: dict[int, dict[str, Any]] = {}
    tc_loss: dict[tuple[int, str], dict[str, int]] = defaultdict(lambda: {"n": 0, "ll": 0})
    for e in ELO_BUCKETS:
        out[e] = {
            "n": 0,
            "sustained": 0,
            "wins": 0,
            "draws": 0,
            "losses": 0,
            "lead_i": 0,
            "lead_m": 0,
            "lead_b": 0,
            "opp_i": 0,
            "opp_m": 0,
            "opp_b": 0,
        }
    for f in facts:
        b = out[f.elo]
        b["n"] += 1
        c = tc_loss[(f.elo, f.tc)]
        c["n"] += 1
        if not f.s1_sustained:
            continue
        b["sustained"] += 1
        s = f.mg_min_sign
        assert s is not None
        if f.side_won(s):
            b["wins"] += 1
        elif f.result == "1/2-1/2":
            b["draws"] += 1
        else:
            b["losses"] += 1
            c["ll"] += 1
        lead_white = s > 0
        for key, w, blk in (
            ("i", f.w_inacc, f.b_inacc),
            ("m", f.w_mist, f.b_mist),
            ("b", f.w_blun, f.b_blun),
        ):
            lead_cnt, opp_cnt = (w, blk) if lead_white else (blk, w)
            b[f"lead_{key}"] += lead_cnt or 0
            b[f"opp_{key}"] += opp_cnt or 0
    return {"buckets": out, "tc_loss": dict(tc_loss)}


def t_section2(facts: list[Fact]) -> dict[str, Any]:
    by_elo: dict[int, dict[str, int]] = {e: defaultdict(int) for e in ELO_BUCKETS}
    by_cell: dict[tuple[int, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))
    n_games: dict[int, int] = defaultdict(int)
    n_cell: dict[tuple[int, str], int] = defaultdict(int)
    for f in facts:
        n_games[f.elo] += 1
        n_cell[(f.elo, f.tc)] += 1
        if not f.is_entry_lead:
            continue
        for agg in (by_elo[f.elo], by_cell[(f.elo, f.tc)]):
            agg["n"] += 1
            agg[f.outcome] += 1
    return {
        "by_elo": {e: dict(v) for e, v in by_elo.items()},
        "by_cell": {k: dict(v) for k, v in by_cell.items()},
        "n_games": dict(n_games),
        "n_cell": dict(n_cell),
    }


def t_section4(facts: list[Fact]) -> dict[str, Any]:
    def band_of(ea: int) -> str:
        for lo, hi, label in BANDS:
            if lo <= ea < hi:
                return label
        raise ValueError(ea)

    by_band: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    by_elo_band: dict[tuple[int, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))
    entry_abs_by_elo: dict[int, list[int]] = defaultdict(list)
    for f in facts:
        if not f.is_entry_lead:
            continue
        ea = f.entry_abs
        assert ea is not None
        band = band_of(ea)
        entry_abs_by_elo[f.elo].append(ea)
        for agg in (by_band[band], by_elo_band[(f.elo, band)]):
            agg["n"] += 1
            agg[f.outcome] += 1
    return {
        "by_band": {k: dict(v) for k, v in by_band.items()},
        "by_elo_band": {k: dict(v) for k, v in by_elo_band.items()},
        "entry_abs_by_elo": dict(entry_abs_by_elo),
    }


def t_section5(facts: list[Fact]) -> dict[str, Any]:
    cell: dict[tuple[int, str], dict[str, int]] = defaultdict(lambda: defaultdict(int))
    flag_last: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for f in facts:
        if not f.is_entry_lead:
            continue
        c = cell[(f.elo, f.tc)]
        c["n"] += 1
        # Mirror the v1 SQL's NULL semantics: a NULL termination joins neither the
        # board nor the clock component (and is excluded from the board-decided-only
        # denominator), while still counting in the entry-lead total.
        board_ended = f.termination is not None and f.termination not in ("timeout", "abandoned")
        if board_ended:
            c["board_den"] += 1
        if f.outcome == "ll":
            if board_ended:
                c["ll_board"] += 1
            elif f.termination == "timeout":
                c["ll_clock"] += 1
                fl = flag_last[f.tc]
                fl["n"] += 1
                if f.last_lead_cp >= ENTRY_LEAD_CP:
                    fl["ge200"] += 1
                if f.last_lead_cp >= 0:
                    fl["ge0"] += 1
            elif f.termination == "abandoned":
                c["ll_abandoned"] += 1
    return {
        "cells": {k: dict(v) for k, v in cell.items()},
        "flag_last": {k: dict(v) for k, v in flag_last.items()},
    }


def t_robustness(facts: list[Fact]) -> dict[str, Any]:
    split: dict[int, dict[str, int]] = {e: defaultdict(int) for e in ELO_BUCKETS}
    gap: dict[int, list[int]] = defaultdict(list)
    # Cohort user's score (win + half draw) over ALL analyzed-cohort games of the
    # basis — the strength context for reading the leader-identity split.
    score: dict[int, list[float]] = defaultdict(list)
    for f in facts:
        if f.opp_rating is not None:
            gap[f.elo].append(f.opp_rating - f.user_rating)
        user_sign = 1 if f.user_color == "white" else -1
        score[f.elo].append(
            0.5 if f.result == "1/2-1/2" else (1.0 if f.side_won(user_sign) else 0.0)
        )
        if not f.is_entry_lead:
            continue
        s = split[f.elo]
        who = "user" if f.user_is_leader else "opp"
        s[f"{who}_n"] += 1
        if f.outcome == "ll":
            s[f"{who}_ll"] += 1
    return {
        "split": {e: dict(v) for e, v in split.items()},
        "mean_gap": {e: mean(g) for e, g in gap.items()},
        "user_score": {e: mean(s) for e, s in score.items()},
    }


def t_section3(facts: list[Fact], blun: dict[int, tuple[int, int, int, int]]) -> dict[str, Any]:
    agg: dict[int, dict[str, float]] = {
        e: {"n": 0, "leader_after": 0, "opp_after": 0, "leader_open": 0, "opp_open": 0}
        for e in ELO_BUCKETS
    }
    for f in facts:
        if not f.is_entry_lead:
            continue
        la, oa, lo, oo = blun[f.id]
        a = agg[f.elo]
        a["n"] += 1
        a["leader_after"] += la
        a["opp_after"] += oa
        a["leader_open"] += lo
        a["opp_open"] += oo
    return {"by_elo": agg}


def compute_basis(facts: list[Fact], blun: dict[int, tuple[int, int, int, int]]) -> dict[str, Any]:
    return {
        "game_sample": t_game_sample(facts),
        "s1": t_section1(facts),
        "s2": t_section2(facts),
        "s3": t_section3(facts, blun),
        "s4": t_section4(facts),
        "s5": t_section5(facts),
        "robustness": t_robustness(facts),
    }


# ---------------------------------------------------------------------------
# Replication gate: the v1 basis must reproduce the published report.
# ---------------------------------------------------------------------------

# Hard anchors from stories/two-pawns-up/two-pawns-up-report-v1.md (2026-08-15).
V1_ANCHORS: dict[str, Any] = {
    "n_total": 460_604,
    "n_by_elo": {800: 16_637, 1200: 64_875, 1600: 98_911, 2000: 130_346, 2400: 149_835},
    "s1_sustained": {800: 4_336, 1200: 12_908, 1600: 13_493, 2000: 10_687, 2400: 8_279},
    "s2_totals": {"n": 112_583, "sw": 48_524, "wns": 33_450, "draw": 3_822, "ll": 26_787},
    "s5_flag_upsets": {"blitz": 2_836, "rapid": 1_257, "classical": 285},
}
# Soft (tolerance) anchors: published values are rounded.
V1_SOFT_ANCHORS = {
    # Section 3, 800 bucket, blunders per entry-lead game (published to 2 dp).
    "s3_800": {"opp_open": 1.68, "leader_open": 0.80, "opp_after": 1.26, "leader_after": 1.55},
    # Section 1 mistakes table, 800: joint blunder rates (published to 3 dp).
    "s1_800_blun": {"leader": 0.206, "opp": 0.502},
}


def check_anchors(v1: dict[str, Any]) -> list[str]:
    errs: list[str] = []

    def chk(label: str, got: Any, want: Any) -> None:
        if got != want:
            errs.append(f"{label}: got {got}, published {want}")

    gs = v1["game_sample"]
    chk("n_total", gs["total"], V1_ANCHORS["n_total"])
    for e in ELO_BUCKETS:
        chk(f"n[{e}]", sum(gs["cells"][e].values()), V1_ANCHORS["n_by_elo"][e])
        chk(
            f"s1_sustained[{e}]", v1["s1"]["buckets"][e]["sustained"], V1_ANCHORS["s1_sustained"][e]
        )
    s2 = v1["s2"]["by_elo"]
    tot = {k: sum(s2[e].get(k, 0) for e in ELO_BUCKETS) for k in ("n", "sw", "wns", "draw", "ll")}
    for k, want in V1_ANCHORS["s2_totals"].items():
        chk(f"s2_total[{k}]", tot[k], want)
    for tc, want in V1_ANCHORS["s5_flag_upsets"].items():
        chk(f"s5_flag[{tc}]", v1["s5"]["flag_last"].get(tc, {}).get("n", 0), want)

    s3 = v1["s3"]["by_elo"][800]
    for k, want in V1_SOFT_ANCHORS["s3_800"].items():
        got = s3[k] / s3["n"]
        if abs(got - want) > 0.006:
            errs.append(f"s3_800[{k}]: got {got:.3f}, published {want}")
    b800 = v1["s1"]["buckets"][800]
    for k, want in V1_SOFT_ANCHORS["s1_800_blun"].items():
        got = b800[f"{'lead' if k == 'leader' else 'opp'}_b"] / b800["n"]
        if abs(got - want) > 0.0006:
            errs.append(f"s1_800_blun[{k}]: got {got:.4f}, published {want}")
    return errs


# ---------------------------------------------------------------------------
# Markdown rendering (per basis + deltas)
# ---------------------------------------------------------------------------


def render_basis(name: str, r: dict[str, Any]) -> str:
    parts = [f"\n\n# ===== basis: {name} ====="]
    gs = r["game_sample"]
    rows = [
        [f"**{e}**"]
        + [f"{gs['cells'][e][tc]:,}" for tc in TC_BUCKETS]
        + [f"**{sum(gs['cells'][e].values()):,}**"]
        for e in ELO_BUCKETS
    ]
    col_tot = [sum(gs["cells"][e][tc] for e in ELO_BUCKETS) for tc in TC_BUCKETS]
    rows.append(["**total**"] + [f"**{t:,}**" for t in col_tot] + [f"**{gs['total']:,}**"])
    parts += ["\n## Game sample", md_table(["Rating ↓ / TC →", *TC_BUCKETS, "total"], rows)]

    s1 = r["s1"]["buckets"]
    rows = []
    for e in ELO_BUCKETS:
        b = s1[e]
        rows.append(
            [
                f"**{e}**",
                f"{b['n']:,}",
                f"{b['sustained']:,}",
                pct(b["sustained"], b["n"], 2),
                pct(b["wins"], b["n"], 2),
                pct(b["draws"], b["n"], 2),
                pct(b["losses"], b["n"], 2),
                pct(b["wins"], b["sustained"], 1),
            ]
        )
    parts += [
        "\n## Section 1 — sustained lead",
        md_table(
            [
                "Rating",
                "n_games",
                "sustained",
                "% of n",
                "leader wins %",
                "draws %",
                "leader loses %",
                "conversion %",
            ],
            rows,
        ),
    ]

    tc_loss = r["s1"]["tc_loss"]
    rows = [
        [f"**{e}**"]
        + [
            pct(tc_loss.get((e, tc), {}).get("ll", 0), tc_loss.get((e, tc), {}).get("n", 0), 3)
            for tc in TC_BUCKETS
        ]
        for e in ELO_BUCKETS
    ]
    parts += [
        "\n### S1 leader loses by TC (% of cell n)",
        md_table(["Rating ↓ / TC →", *TC_BUCKETS], rows),
    ]

    rows = []
    for e in ELO_BUCKETS:
        b = s1[e]
        cells = [
            f"{b[k] / b['n']:.3f}"
            for k in ("lead_i", "lead_m", "lead_b", "opp_i", "opp_m", "opp_b")
        ]
        per_sus = (
            [
                f"{b['lead_b'] / b['sustained']:.2f}",
                f"{b['opp_b'] / b['sustained']:.2f}",
                f"{b['opp_b'] / b['lead_b']:.1f}x",
            ]
            if b["sustained"] and b["lead_b"]
            else ["n/a"] * 3
        )
        rows.append([f"**{e}**", *cells, *per_sus])
    parts += [
        "\n### S1 mistakes (joint rates ÷ n_games; last 3 cols per sustained game)",
        md_table(
            [
                "Rating",
                "leader inacc",
                "leader mist",
                "leader blun",
                "opp inacc",
                "opp mist",
                "opp blun",
                "leader blun/sust",
                "opp blun/sust",
                "opp÷leader",
            ],
            rows,
        ),
    ]

    s2 = r["s2"]
    rows = []
    for e in ELO_BUCKETS:
        b, n = s2["by_elo"][e], s2["n_games"][e]
        rows.append(
            [
                f"**{e}**",
                f"{n:,}",
                f"{b['n']:,}",
                pct(b["n"], n, 1),
                pct(b.get("sw", 0), b["n"], 1),
                pct(b.get("wns", 0), b["n"], 1),
                pct(b.get("draw", 0), b["n"], 1),
                pct(b.get("ll", 0), b["n"], 1),
                f"{b.get('sw', 0):,}/{b.get('wns', 0):,}/{b.get('draw', 0):,}/{b.get('ll', 0):,}",
            ]
        )
    tot = {
        k: sum(s2["by_elo"][e].get(k, 0) for e in ELO_BUCKETS)
        for k in ("n", "sw", "wns", "draw", "ll")
    }
    n_all = sum(s2["n_games"].values())
    rows.append(
        [
            "**all**",
            f"{n_all:,}",
            f"{tot['n']:,}",
            pct(tot["n"], n_all, 1),
            pct(tot["sw"], tot["n"], 1),
            pct(tot["wns"], tot["n"], 1),
            pct(tot["draw"], tot["n"], 1),
            pct(tot["ll"], tot["n"], 1),
            f"{tot['sw']:,}/{tot['wns']:,}/{tot['draw']:,}/{tot['ll']:,}",
        ]
    )
    parts += [
        "\n## Section 2 — entry-lead four-way split",
        md_table(
            [
                "Rating",
                "n_games",
                "entry-lead",
                "% of n",
                "sustained win",
                "win not sust",
                "draw",
                "leader loses",
                "raw sw/wns/draw/ll",
            ],
            rows,
        ),
    ]

    rows = []
    for e in ELO_BUCKETS:
        for tc in TC_BUCKETS:
            b = s2["by_cell"].get((e, tc), {})
            n_c = s2["n_cell"].get((e, tc), 0)
            if not b.get("n"):
                rows.append([f"**{e}**", tc, "0", "-", "-", "-", "-", "-"])
                continue
            rows.append(
                [
                    f"**{e}**",
                    tc,
                    f"{b['n']:,}",
                    pct(b["n"], n_c, 1),
                    pct(b.get("sw", 0), b["n"], 1),
                    pct(b.get("wns", 0), b["n"], 1),
                    pct(b.get("draw", 0), b["n"], 1),
                    pct(b.get("ll", 0), b["n"], 1),
                ]
            )
    parts += [
        "\n### S2 by TC",
        md_table(
            [
                "Rating",
                "TC",
                "entry-lead",
                "% of cell",
                "sustained win",
                "win not sust",
                "draw",
                "leader loses",
            ],
            rows,
        ),
    ]

    s3 = r["s3"]["by_elo"]
    rows = []
    for e in ELO_BUCKETS:
        a = s3[e]
        if not a["n"]:
            continue
        n = a["n"]
        rows.append(
            [
                f"**{e}**",
                f"{n:,}",
                f"{a['opp_open'] / n:.2f}",
                f"{a['leader_open'] / n:.2f}",
                f"{a['opp_open'] / a['leader_open']:.1f}x" if a["leader_open"] else "n/a",
                f"{a['opp_after'] / n:.2f}",
                f"{a['leader_after'] / n:.2f}",
                f"{a['leader_after'] / a['opp_after']:.2f}x" if a["opp_after"] else "n/a",
            ]
        )
    parts += [
        "\n## Section 3 — blunders per entry-lead game",
        md_table(
            [
                "Rating",
                "entry-lead",
                "opp up to entry",
                "leader up to entry",
                "opp÷leader (open)",
                "opp after",
                "leader after",
                "leader÷opp (after)",
            ],
            rows,
        ),
    ]

    s4 = r["s4"]
    tot_n = sum(v["n"] for v in s4["by_band"].values())
    rows = []
    for _, _, label in BANDS:
        b = s4["by_band"].get(label, {})
        if not b.get("n"):
            continue
        rows.append(
            [
                f"**{label}**",
                f"{b['n']:,}",
                pct(b["n"], tot_n, 1),
                pct(b.get("sw", 0), b["n"], 1),
                pct(b.get("wns", 0), b["n"], 1),
                pct(b.get("draw", 0), b["n"], 1),
                pct(b.get("ll", 0), b["n"], 1),
            ]
        )
    parts += [
        "\n## Section 4 — by entry-lead size (all ratings)",
        md_table(
            [
                "Entry lead",
                "n",
                "% of entry-lead",
                "sustained win",
                "win not sust",
                "draw",
                "leader loses",
            ],
            rows,
        ),
    ]

    rows = []
    for e in ELO_BUCKETS:
        shares = [
            pct(s4["by_elo_band"].get((e, label), {}).get("n", 0), s2["by_elo"][e]["n"], 1)
            for _, _, label in BANDS
        ]
        vals = s4["entry_abs_by_elo"][e]
        p25, med, p75 = q123(vals)
        rows.append([f"**{e}**", *shares, f"{med:.0f}", f"{p25:.0f}–{p75:.0f}"])
    parts += [
        "\n### S4 entry-lead size distribution by rating",
        md_table(["Rating", *(label for _, _, label in BANDS), "median cp", "IQR"], rows),
    ]

    for metric, title in (("sw", "sustained-win"), ("ll", "leader-loses")):
        rows = []
        for _, _, label in BANDS[:3]:
            row = [label]
            for e in ELO_BUCKETS:
                b = s4["by_elo_band"].get((e, label), {})
                row.append(pct(b.get(metric, 0), b.get("n", 0), 1))
            rows.append(row)
        parts += [
            f"\n### S4 {title} share by rating, holding lead size fixed",
            md_table(["Entry lead", *(str(e) for e in ELO_BUCKETS)], rows),
        ]

    s5 = r["s5"]
    rows = []
    for e in ELO_BUCKETS:
        for tc in TC_BUCKETS:
            c = s5["cells"].get((e, tc), {})
            n = c.get("n", 0)
            if not n:
                rows.append([f"**{e}**", tc, "0"] + ["-"] * 5)
                continue
            ll_total = c.get("ll_board", 0) + c.get("ll_clock", 0) + c.get("ll_abandoned", 0)
            rows.append(
                [
                    f"**{e}**",
                    tc,
                    f"{n:,}",
                    pct(c.get("ll_board", 0), n, 1),
                    pct(c.get("ll_clock", 0), n, 1),
                    pct(c.get("ll_abandoned", 0), n, 1),
                    pct(ll_total, n, 1),
                    pct(c.get("ll_board", 0), c.get("board_den", 0), 1),
                ]
            )
    parts += [
        "\n## Section 5 — upsets by termination (% of cell entry-lead games)",
        md_table(
            [
                "Rating",
                "TC",
                "entry-lead",
                "board",
                "clock",
                "abandoned",
                "total ll",
                "board-only ll%",
            ],
            rows,
        ),
    ]

    rows = []
    for tc in TC_BUCKETS:
        fl = s5["flag_last"].get(tc, {})
        if not fl.get("n"):
            continue
        rows.append(
            [
                tc,
                f"{fl['n']:,}",
                pct(fl.get("ge200", 0), fl["n"], 1),
                pct(fl.get("ge0", 0), fl["n"], 1),
            ]
        )
    parts += [
        "\n### S5 last eval of timeout upsets",
        md_table(["TC", "flag upsets", "leader still >= +200", "leader still >= 0"], rows),
    ]

    rb = r["robustness"]
    rows = []
    for e in ELO_BUCKETS:
        s = rb["split"][e]
        un, on = s.get("user_n", 0), s.get("opp_n", 0)
        u_ll = 100 * s.get("user_ll", 0) / un if un else float("nan")
        o_ll = 100 * s.get("opp_ll", 0) / on if on else float("nan")
        rows.append(
            [
                f"**{e}**",
                f"{rb['mean_gap'][e]:+.1f}",
                f"{rb['user_score'][e]:.3f}",
                f"{un:,}",
                f"{on:,}",
                f"{u_ll:.2f}%",
                f"{o_ll:.2f}%",
                f"{u_ll - o_ll:+.1f}pp",
            ]
        )
    un = sum(rb["split"][e].get("user_n", 0) for e in ELO_BUCKETS)
    on = sum(rb["split"][e].get("opp_n", 0) for e in ELO_BUCKETS)
    ul = sum(rb["split"][e].get("user_ll", 0) for e in ELO_BUCKETS)
    ol = sum(rb["split"][e].get("opp_ll", 0) for e in ELO_BUCKETS)
    rows.append(
        [
            "**all (pooled — Simpson's warning)**",
            "",
            "",
            f"{un:,}",
            f"{on:,}",
            pct(ul, un, 2),
            pct(ol, on, 2),
            f"{100 * ul / un - 100 * ol / on:+.1f}pp" if un and on else "n/a",
        ]
    )
    parts += [
        "\n## Robustness — leader-identity split (entry-lead games)",
        md_table(
            [
                "Rating",
                "mean (opp − user) Elo",
                "user score (all cohort games)",
                "user leads (n)",
                "opp leads (n)",
                "user-leader loses",
                "opp-leader loses",
                "Δ",
            ],
            rows,
        ),
    ]
    return "\n".join(parts)


def render_deltas(v1: dict[str, Any], v2: dict[str, Any]) -> str:
    parts = ["\n\n# ===== v1 → v2 deltas ====="]

    def rate(b: dict[str, int], k: str) -> float:
        return 100.0 * b.get(k, 0) / b["n"] if b.get("n") else float("nan")

    rows = []
    for e in ELO_BUCKETS:
        b1, b2 = v1["s2"]["by_elo"][e], v2["s2"]["by_elo"][e]
        rows.append(
            [f"**{e}**", f"{b1['n']:,} → {b2['n']:,}"]
            + [
                f"{rate(b1, k):.1f} → {rate(b2, k):.1f} ({rate(b2, k) - rate(b1, k):+.1f})"
                for k in ("sw", "wns", "draw", "ll")
            ]
        )
    parts += [
        "\n## S2 four-way per rating (v1 → v2, pp delta)",
        md_table(
            ["Rating", "entry-lead n", "sustained win", "win not sust", "draw", "leader loses"],
            rows,
        ),
    ]

    rows = []
    for e in ELO_BUCKETS:
        for tc in TC_BUCKETS:
            b1 = v1["s2"]["by_cell"].get((e, tc), {})
            b2 = v2["s2"]["by_cell"].get((e, tc), {})
            if not b1.get("n") or not b2.get("n"):
                continue
            rows.append(
                [
                    f"**{e}**",
                    tc,
                    f"{b1['n']:,} → {b2['n']:,}",
                    f"{rate(b1, 'll'):.1f} → {rate(b2, 'll'):.1f} ({rate(b2, 'll') - rate(b1, 'll'):+.1f})",
                ]
            )
    parts += [
        "\n## S2 leader-loses per rating × TC (v1 → v2)",
        md_table(["Rating", "TC", "entry-lead n", "leader loses"], rows),
    ]

    rows = []
    for e in ELO_BUCKETS:
        for tc in TC_BUCKETS:
            c1 = v1["s5"]["cells"].get((e, tc), {})
            c2 = v2["s5"]["cells"].get((e, tc), {})
            if not c1.get("n") or not c2.get("n"):
                continue

            def bo(c: dict[str, int]) -> float:
                return (
                    100.0 * c.get("ll_board", 0) / c["board_den"]
                    if c.get("board_den")
                    else float("nan")
                )

            rows.append(
                [
                    f"**{e}**",
                    tc,
                    f"{100 * c1.get('ll_clock', 0) / c1['n']:.1f} → {100 * c2.get('ll_clock', 0) / c2['n']:.1f}",
                    f"{bo(c1):.1f} → {bo(c2):.1f} ({bo(c2) - bo(c1):+.1f})",
                ]
            )
    parts += [
        "\n## S5 clock share and board-only leader-loses (v1 → v2)",
        md_table(["Rating", "TC", "clock ll% of entry-lead", "board-only ll%"], rows),
    ]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


async def load_facts(session: AsyncSession) -> list[Fact]:
    _log("fact query (single game_positions pass) ...")
    res = await session.execute(text(FACT_SQL))
    facts = [Fact(*row) for row in res.tuples()]
    _log(f"fact rows: {len(facts):,}")
    return facts


async def load_blunders(
    session: AsyncSession, facts: list[Fact]
) -> dict[int, tuple[int, int, int, int]]:
    entry = [(f.id, f.entry_sign, f.entry_ply) for f in facts if f.is_entry_lead]
    _log(f"section 3 blunder query over {len(entry):,} entry-lead games ...")
    res = await session.execute(
        text(SECTION3_SQL),
        {
            "ids": [e[0] for e in entry],
            "signs": [e[1] for e in entry],
            "plies": [e[2] for e in entry],
        },
    )
    return {gid: (la, oa, lo, oo) for gid, la, oa, lo, oo in res.tuples()}


async def run(db: str, json_path: str | None) -> int:
    engine = create_async_engine(db_url_for_target(db), pool_pre_ping=True)
    try:
        maker = async_sessionmaker(engine, expire_on_commit=False)
        async with maker() as session:
            await session.execute(text("SET TRANSACTION READ ONLY"))
            facts = await load_facts(session)
            blun = await load_blunders(session, facts)
    finally:
        await engine.dispose()

    _log("computing v1 basis (cohort filter only) ...")
    v1 = compute_basis(facts, blun)
    _log(f"computing v2 basis (equal footing, tolerance {EQUAL_FOOTING_TOLERANCE}) ...")
    ef_facts = [f for f in facts if equal_footing(f)]
    _log(
        f"equal-footing cohort: {len(ef_facts):,} of {len(facts):,} "
        f"({100 * len(ef_facts) / len(facts):.1f}%)"
    )
    v2 = compute_basis(ef_facts, blun)

    errs = check_anchors(v1)
    if errs:
        _log("REPLICATION GATE FAILED — v1 basis does not reproduce the published report:")
        for e in errs:
            _log(f"  {e}")
        return 1
    _log("replication gate passed: v1 basis matches the published report anchors.")

    print(render_basis("v1 (no equal-footing filter — published basis)", v1))
    print(
        render_basis(
            f"v2 (equal-footing: both ratings present, gap <= {EQUAL_FOOTING_TOLERANCE})", v2
        )
    )
    print(render_deltas(v1, v2))

    if json_path:

        def keyfix(o: Any) -> Any:
            if isinstance(o, dict):
                return {str(k): keyfix(v) for k, v in o.items()}
            if isinstance(o, (list, tuple)):
                return [keyfix(v) for v in o]
            return o

        blob = {
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "db": db,
            "equal_footing_tolerance": EQUAL_FOOTING_TOLERANCE,
            "v1": keyfix(v1),
            "v2": keyfix(v2),
        }
        Path(json_path).write_text(json.dumps(blob, indent=1, default=str))
        _log(f"json written to {json_path}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", choices=("benchmark", "dev"), default="benchmark")
    ap.add_argument("--json", default=None, help="also dump all tables as JSON to this path")
    args = ap.parse_args()
    return asyncio.run(run(args.db, args.json))


if __name__ == "__main__":
    raise SystemExit(main())
