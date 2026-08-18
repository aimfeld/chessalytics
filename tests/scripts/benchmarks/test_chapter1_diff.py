"""Numeric acceptance gate for Chapter 1 (SEED-029 Phase A regression oracle).

Runs the ported §1 queries against the live benchmark DB (localhost:5433) and
asserts every value matches `reports/benchmark/benchmarks-latest.md` (2026-05-27
snapshot). Skips when the benchmark DB is unreachable (e.g. CI, or `bin/benchmark_db.sh`
not started) — it is a local calibration-source regression check, not a unit test.

If this test fails after an intentional benchmark-DB re-ingest, update the EXPECTED_*
literals from the new report in the same commit that rotates the report.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from scripts.benchmarks import chapter1

pytestmark = pytest.mark.asyncio

# `benchmark_session` fixture lives in conftest.py (shared with the other chapter gates).

# --- expected values, transcribed from benchmarks-latest.md (2026-05-27) -------

EXPECTED_POPULATION = {"users": 4697, "games": 2767158, "positions": 190934222}

EXPECTED_EVAL = {"endgame_games": 1538585, "with_eval": 1538581}

# (elo, tc) -> completed users (selection-pool coverage grid).
EXPECTED_COVERAGE: dict[tuple[int, str], int] = {
    (elo, tc): 200
    for elo in (800, 1200, 1600, 2000, 2400)
    for tc in ("bullet", "blitz", "rapid", "classical")
}
EXPECTED_COVERAGE[(800, "classical")] = 151
EXPECTED_COVERAGE[(2400, "classical")] = 12

# (elo, tc) -> (users, games) (game-time cell sizes, post equal-footing filter).
EXPECTED_GAME_TIME: dict[tuple[int, str], tuple[int, int]] = {
    (800, "bullet"): (268, 114933),
    (1200, "bullet"): (404, 165994),
    (1600, "bullet"): (363, 165589),
    (2000, "bullet"): (334, 147313),
    (2400, "bullet"): (240, 113012),
    (800, "blitz"): (260, 115661),
    (1200, "blitz"): (423, 162443),
    (1600, "blitz"): (419, 164380),
    (2000, "blitz"): (364, 140587),
    (2400, "blitz"): (223, 89885),
    (800, "rapid"): (317, 95792),
    (1200, "rapid"): (545, 132196),
    (1600, "rapid"): (502, 134570),
    (2000, "rapid"): (399, 97751),
    (2400, "rapid"): (208, 31627),
    (800, "classical"): (222, 11609),
    (1200, "classical"): (452, 39705),
    (1600, "classical"): (423, 48763),
    (2000, "classical"): (222, 17766),
    (2400, "classical"): (10, 47),
}

# (elo, tc) -> (analyzed, games) on the cohort filter (full-game analysis share, §1).
# Equal-footing counterparts are gated by the pooled invariants below rather than cell by
# cell — the grid is already the thing that regresses if the cohort filter drifts.
EXPECTED_ANALYSIS_SHARE: dict[tuple[int, str], tuple[int, int]] = {
    (800, "bullet"): (15914, 138400),
    (1200, "bullet"): (16774, 184122),
    (1600, "bullet"): (12666, 193294),
    (2000, "bullet"): (13284, 190624),
    (2400, "bullet"): (17180, 175462),
    (800, "blitz"): (20991, 135447),
    (1200, "blitz"): (25380, 181336),
    (1600, "blitz"): (27636, 189074),
    (2000, "blitz"): (37527, 183668),
    (2400, "blitz"): (79609, 144349),
    (800, "rapid"): (21355, 115483),
    (1200, "rapid"): (31735, 148778),
    (1600, "rapid"): (39772, 158664),
    (2000, "rapid"): (59357, 136965),
    (2400, "rapid"): (49068, 69945),
    (800, "classical"): (6105, 22494),
    (1200, "classical"): (21913, 54337),
    (1600, "classical"): (40060, 69725),
    (2000, "classical"): (26427, 35864),
    (2400, "classical"): (473, 609),
}

# Pooled totals with the sparse (2400, classical) cell excluded, as the report renders them.
EXPECTED_ANALYSIS_POOLED = {"analyzed": 562753, "games": 2528031}
EXPECTED_ANALYSIS_POOLED_EF = {"analyzed": 397114, "games": 1989576}

# Representative status cells (C/S/F/U), incl. the pool-limited / sparse cells whose
# 'unattempted' is absent from the query result and must render as 0.
EXPECTED_STATUS: dict[tuple[int, str], dict[str, int]] = {
    (800, "bullet"): {"completed": 200, "skipped": 14, "failed": 2, "unattempted": 284},
    (800, "classical"): {"completed": 151, "skipped": 340, "failed": 9, "unattempted": 0},
    (2400, "classical"): {"completed": 12, "skipped": 8, "failed": 3, "unattempted": 0},
}


async def test_chapter1_matches_report(benchmark_session: AsyncSession) -> None:
    values = await chapter1.compute(benchmark_session)

    assert values["population"] == EXPECTED_POPULATION

    ev = values["eval_coverage"]
    assert {"endgame_games": ev["endgame_games"], "with_eval": ev["with_eval"]} == EXPECTED_EVAL
    assert round(ev["pct_with_eval"], 2) == 100.00

    coverage = {(c["elo"], c["tc"]): c["n"] for c in values["pool_coverage"]}
    assert coverage == EXPECTED_COVERAGE

    game_time = {(c["elo"], c["tc"]): (c["users"], c["games"]) for c in values["game_time_cells"]}
    assert game_time == EXPECTED_GAME_TIME

    share = {(c["elo"], c["tc"]): (c["analyzed"], c["games"]) for c in values["analysis_share"]}
    assert share == EXPECTED_ANALYSIS_SHARE

    # Marginals drop the sparse cell (SKILL.md "Sparse-cell exclusion"); the report's
    # pooled row is this sum, so gate it directly rather than trusting the grid alone.
    non_sparse = [c for c in values["analysis_share"] if (c["elo"], c["tc"]) != (2400, "classical")]
    assert {
        "analyzed": sum(c["analyzed"] for c in non_sparse),
        "games": sum(c["games"] for c in non_sparse),
    } == EXPECTED_ANALYSIS_POOLED
    assert {
        "analyzed": sum(c["analyzed_ef"] for c in non_sparse),
        "games": sum(c["games_ef"] for c in non_sparse),
    } == EXPECTED_ANALYSIS_POOLED_EF

    # The equal-footing subset is a subset: never more games, never more analyzed.
    for c in values["analysis_share"]:
        assert c["games_ef"] <= c["games"] and c["analyzed_ef"] <= c["analyzed"]

    # Cross-table invariant: the analysis share's equal-footing denominator IS the
    # game-time cell size (same filter, same bucketing). Catches a drift in either query
    # without a second hand-transcribed grid.
    assert {(c["elo"], c["tc"]): c["games_ef"] for c in values["analysis_share"]} == {
        cell: games for cell, (_users, games) in EXPECTED_GAME_TIME.items()
    }

    status: dict[tuple[int, str], dict[str, int]] = {}
    for row in values["pool_status"]:
        status.setdefault((row["elo"], row["tc"]), {})[row["status"]] = row["n"]
    for cell, expected in EXPECTED_STATUS.items():
        got = status.get(cell, {})
        for code, n in expected.items():
            assert got.get(code, 0) == n, (
                f"{cell} status {code!r}: got {got.get(code, 0)}, want {n}"
            )
