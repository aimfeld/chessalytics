"""Regenerate the cohort empirical-CDF artifact from the benchmark DB.

Phase 94.4 — cohort sliding-window methodology
----------------------------------------------

The Phase 94.3 flat ``GLOBAL_PERCENTILE_CDF`` (16-key, pooled across all
anchors) retires. Plan 04 replaces it with ``COHORT_PERCENTILE_CDF`` — an
8-metric × ~33-anchor × 4-TC nested registry where each cell is the 99-
breakpoint CDF over the K=200 nearest-anchor users in that (metric, anchor,
TC) cohort (CONTEXT D-09 / D-11 / D-13).

In-Python ranking strategy (RESEARCH Pitfall 8)
-----------------------------------------------

A naive per-anchor SQL approach would issue ``8 metrics × N anchors × 4 TCs``
queries against the benchmark DB (where ``N`` is the size of the anchor
grid). The chosen strategy collapses this to ``8 × 4 = 32 queries`` by:

1. Issuing one query per (metric, TC) returning ``(user_id, metric_value,
   n_games, anchor_rating)`` over the joint pool: ``per_user_values
   JOIN per_user_anchor USING (user_id)``.
2. Ranking the result in Python across each anchor on the 50-Elo grid
   between ``COHORT_ANCHOR_MIN_ELO`` and ``COHORT_ANCHOR_MAX_ELO``. The
   in-window users at each anchor form the cohort for that cell.
3. A user_id tiebreaker on the sort is REQUIRED for byte-identical
   deterministic regen: when the in-window cohort exceeds ``COHORT_MAX_USERS_PER_ANCHOR``
   and the cap-at-MAX truncation has ties on anchor distance, sort by
   ``(distance, user_id)`` so the cohort is stable across runs.

Suppression policy
------------------

The window (``COHORT_MAX_WINDOW_ELO``) is the primary filter — only users
within ``±W`` Elo of the anchor are eligible. From that pool:

- if ``n_in_window < COHORT_MIN_USERS_PER_ANCHOR`` → cell SUPPRESSED
  (``insufficient_users_in_window``);
- otherwise, the cohort is the in-window users, capped at
  ``COHORT_MAX_USERS_PER_ANCHOR`` (nearest-anchor preferred when capping).

Cohort size is therefore variable per cell (between MIN and MAX). The regen
report's TOP-LINE suppression table surfaces both ``n_users`` (actual
cohort size) and ``n_in_window`` (the available pool) so the operator can
see where MAX is binding.

What this script produces
-------------------------
1. Emits ``app/data/cohort_cdf.tsv`` — a tab-delimited seed file with one
   row per (metric, anchor_elo, tc, percentile) breakpoint (~130k rows).
   The TSV replaces the old in-source ``COHORT_PERCENTILE_CDF`` literal that
   was previously rewritten between ``BEGIN/END GENERATED REGISTRY`` sentinels.
2. Writes ``reports/percentile/cohort-percentile-cdf-latest.md`` with the
   per-(metric, anchor, TC) suppression-flag table as the TOP-LINE section.

Operator workflow::

    bin/benchmark_db.sh start
    uv run python scripts/gen_global_percentile_cdf.py --target benchmark \\
        --snapshot-date 2026-05-26

CLI:

* ``--target benchmark`` (required) — only the benchmark Docker DB on port
  5433 is supported. ``_assert_benchmark_db`` refuses to run unless the
  resolved URL contains both ``flawchess_benchmark`` and ``:5433`` (94.1
  Plan 09 safety guard).
* ``--snapshot-date YYYY-MM-DD`` (optional) — anchors the 36-month recency
  window. Defaults to today (UTC).
* ``--regen-report-path PATH`` (optional) — defaults to
  ``reports/percentile/cohort-percentile-cdf-latest.md``.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Final, cast
from urllib.parse import urlparse, urlunparse

import sentry_sdk
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Bootstrap project root so ``app.*`` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.services.canonical_slice_sql import (  # noqa: E402
    TimeControlBucket,
    per_user_cte_achievable_tc,
    per_user_cte_clock_gap,
    per_user_cte_conv_rate_tc,
    per_user_cte_median_anchor,
    per_user_cte_net_flag_rate,
    per_user_cte_parity_rate_tc,
    per_user_cte_recovery_rate_tc,
    per_user_cte_score_gap_tc,
    per_user_cte_score_gap_bucket_tc,
    per_user_cte_time_pressure_score_gap,
    selected_users_cte,
)
from app.services.global_percentile_cdf import (  # noqa: E402
    BENCHMARK_DB_SNAPSHOT_MONTH,
    BREAKPOINT_PERCENTILES,
    CdfMetricId,
    CdfTable,
)

# ---------------------------------------------------------------------------
# Module-level constants (no magic numbers — CLAUDE.md; CONTEXT D-11).
# ---------------------------------------------------------------------------

# Sliding-window cohort policy. The operator may relax these after reviewing
# the regen report's suppression table (HUMAN-VERIFY checkpoint at end of
# Plan 04). Strict defaults ship unless the operator explicitly relaxes.

# CONTEXT D-11 — minimum cohort size for a cell to qualify. Below this the
# cell suppresses. Floor on noise (~±5pp CI on any breakpoint at MIN=100).
COHORT_MIN_USERS_PER_ANCHOR: Final[int] = 100

# CONTEXT D-11 — maximum cohort size per cell. When the in-window pool
# exceeds this, the cohort is capped to the nearest-anchor MAX users.
# Tradeoff: tighter CIs in dense bands, at the cost of variable per-cell
# precision across cells.
COHORT_MAX_USERS_PER_ANCHOR: Final[int] = 500

# CONTEXT D-11 — maximum Elo distance from anchor for a user to be eligible.
# Anchor ± W defines the cohort window. Wider = more coverage, looser
# peer-relativity.
COHORT_MAX_WINDOW_ELO: Final[int] = 200

# CONTEXT D-11 — anchor grid step. Must match COHORT_ANCHOR_STEP_ELO in
# ``app/services/global_percentile_cdf.py`` (interpolate_cohort_percentile
# rounds inputs to this grid).
COHORT_ANCHOR_STEP_ELO: Final[int] = 50

# CONTEXT D-11 — anchor sweep range.
COHORT_ANCHOR_MIN_ELO: Final[int] = 800
COHORT_ANCHOR_MAX_ELO: Final[int] = 2600

# Time-control sweep order — canonical bullet → blitz → rapid → classical.
ALL_TIME_CONTROLS: Final[tuple[TimeControlBucket, ...]] = (
    "bullet",
    "blitz",
    "rapid",
    "classical",
)

# 11-value CdfMetricId tuple. Order matters: registry-literal emission walks
# this tuple so two regen runs against the same DB produce byte-identical
# Python source. Order mirrors the Literal in
# ``app/services/global_percentile_cdf.py`` (CONTEXT D-13).
# Phase 99: 3 raw-rate families appended
# (conversion_rate, parity_rate, recovery_rate).
IN_SCOPE_METRICS: Final[tuple[CdfMetricId, ...]] = (
    "score_gap",
    "achievable_score_gap",
    "score_gap_conv",
    "score_gap_parity",
    "recovery_score_gap",
    "time_pressure_score_gap",
    "clock_gap",
    "net_flag_rate",
    "conversion_rate",
    "parity_rate",
    "recovery_rate",
)

# Output paths.
OUTPUT_SEED_PATH: Final[Path] = Path("app/data/cohort_cdf.tsv")
DEFAULT_REPORT_PATH: Final[Path] = Path("reports/percentile/cohort-percentile-cdf-latest.md")
ARCHIVE_DIR: Final[Path] = Path("reports/archive")

# Safety-guard tokens (mirrors ``scripts/backfill_eval.py --db benchmark``).
BENCHMARK_DB_NAME_TOKEN: Final[str] = "flawchess_benchmark"
BENCHMARK_DB_PORT_TOKEN: Final[str] = ":5433"

# Floats are rendered to 4 decimal places. This is the byte-identical regen
# precision: all breakpoint floats are emitted as `f"{v:.4f}"` so two runs
# against the same DB snapshot produce identical TSV content.
FLOAT_PRECISION: Final[int] = 4

# Port map for --target choices.
_TARGET_PORT: Final[dict[str, int]] = {"benchmark": 5433}


# ---------------------------------------------------------------------------
# Logging.
# ---------------------------------------------------------------------------


def _log(msg: str = "") -> None:
    """Print ``msg`` prefixed with a UTC second-precision timestamp."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


# ---------------------------------------------------------------------------
# DB URL resolution + safety guard (94.1 Plan 09 pattern, preserved).
# ---------------------------------------------------------------------------


def _db_url(target: str) -> str:
    """Resolve the asyncpg URL for the chosen ``--target``.

    Reads DATABASE_URL_BENCHMARK (sourced from .env) via db_url_for_target.
    Phase 94.4 keeps ``benchmark`` as the only supported target; the
    ``_assert_benchmark_db`` guard below still enforces that the resolved URL
    points at the benchmark Docker DB (port 5433).
    """
    return db_url_for_target(target)


def _mask_password(url: str) -> str:
    """Replace the password in ``url`` with ``***`` for safe logging."""
    parsed = urlparse(url)
    if parsed.password is None:
        return url
    safe_netloc = f"{parsed.username}:***@{parsed.hostname}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=safe_netloc))


def _assert_benchmark_db(url: str) -> None:
    """Refuse to run unless ``url`` points at the benchmark DB (T-94.4-04-01)."""
    if BENCHMARK_DB_NAME_TOKEN not in url or BENCHMARK_DB_PORT_TOKEN not in url:
        raise SystemExit(
            f"Refusing to run: resolved DB URL does not contain both "
            f"{BENCHMARK_DB_NAME_TOKEN!r} and {BENCHMARK_DB_PORT_TOKEN!r}. "
            f"Got: {_mask_password(url)}. "
            f"This script only operates against the benchmark Docker DB on port 5433."
        )


# ---------------------------------------------------------------------------
# SQL composition — per-(metric, TC) per_user_values × per_user_anchor join.
# ---------------------------------------------------------------------------


def _per_user_cte_for_metric_and_tc(
    metric: CdfMetricId,
    tc: TimeControlBucket,
    *,
    snapshot_date: date,
) -> str:
    """Dispatch to the correct per-TC ``per_user_values`` CTE builder for one metric.

    Phase 94.4 8-value + Phase 99 3-value = 11-value CdfMetricId dispatcher.
    The builders are imported from ``app.services.canonical_slice_sql``:

    - ``score_gap``                  → ``per_user_cte_score_gap_tc``
    - ``achievable_score_gap``       → ``per_user_cte_achievable_tc``
    - ``score_gap_conv``    → ``per_user_cte_score_gap_bucket_tc(bucket_label='conversion')``
    - ``score_gap_parity``  → ``per_user_cte_score_gap_bucket_tc(bucket_label='parity')``
    - ``recovery_score_gap``         → ``per_user_cte_score_gap_bucket_tc(bucket_label='recovery')``
    - ``time_pressure_score_gap``    → ``per_user_cte_time_pressure_score_gap(tc)``
    - ``clock_gap``                  → ``per_user_cte_clock_gap(tc)``
    - ``net_flag_rate``              → ``per_user_cte_net_flag_rate(tc)``
    - ``conversion_rate``            → ``per_user_cte_conv_rate_tc(tc)``
    - ``parity_rate``                → ``per_user_cte_parity_rate_tc(tc)``
    - ``recovery_rate``              → ``per_user_cte_recovery_rate_tc(tc)``

    All return a CTE block ending in ``per_user_values(user_id, metric_value, n_games)``
    restricted to TC ``tc``. The CTE is joined against
    ``per_user_cte_median_anchor(tc, ...)`` in the outer query.
    """
    if metric == "score_gap":
        return per_user_cte_score_gap_tc(tc, source="benchmark", snapshot_date=snapshot_date)
    if metric == "achievable_score_gap":
        return per_user_cte_achievable_tc(tc, source="benchmark", snapshot_date=snapshot_date)
    if metric == "score_gap_conv":
        return per_user_cte_score_gap_bucket_tc(
            tc, source="benchmark", snapshot_date=snapshot_date, bucket_label="conversion"
        )
    if metric == "score_gap_parity":
        return per_user_cte_score_gap_bucket_tc(
            tc, source="benchmark", snapshot_date=snapshot_date, bucket_label="parity"
        )
    if metric == "recovery_score_gap":
        return per_user_cte_score_gap_bucket_tc(
            tc, source="benchmark", snapshot_date=snapshot_date, bucket_label="recovery"
        )
    if metric == "time_pressure_score_gap":
        return per_user_cte_time_pressure_score_gap(
            tc, source="benchmark", snapshot_date=snapshot_date
        )
    if metric == "clock_gap":
        return per_user_cte_clock_gap(tc, source="benchmark", snapshot_date=snapshot_date)
    if metric == "net_flag_rate":
        return per_user_cte_net_flag_rate(tc, source="benchmark", snapshot_date=snapshot_date)
    # Phase 99: raw-rate families — same builders as the per-user dispatch so
    # CDF construction and per-user lookup share one code path (SC-2).
    if metric == "conversion_rate":
        return per_user_cte_conv_rate_tc(tc, source="benchmark", snapshot_date=snapshot_date)
    if metric == "parity_rate":
        return per_user_cte_parity_rate_tc(tc, source="benchmark", snapshot_date=snapshot_date)
    if metric == "recovery_rate":
        return per_user_cte_recovery_rate_tc(tc, source="benchmark", snapshot_date=snapshot_date)
    raise ValueError(f"Unknown metric: {metric!r}")


def _build_per_user_with_anchor_query(
    metric: CdfMetricId,
    tc: TimeControlBucket,
    *,
    snapshot_date: date,
) -> str:
    """Build the per-(metric, TC) SQL query joining per_user_values × per_user_anchor.

    Returns rows of ``(user_id, metric_value, n_games, anchor_rating)`` over
    the cohort selected by ``selected_users_cte(source="benchmark")``. Plan 04
    of Phase 94.4 ranks these rows in Python (RESEARCH Pitfall 8) — collapses
    1,056 per-anchor queries to 32 per-(metric, TC) queries.

    The two CTE blocks (``per_user_values`` and ``per_user_anchor``) emit
    distinct top-level CTE names that don't collide; the JOIN ``USING
    (user_id)`` aligns each user's metric value with their median anchor.
    """
    per_user_block = _per_user_cte_for_metric_and_tc(metric, tc, snapshot_date=snapshot_date)
    anchor_block = per_user_cte_median_anchor(tc, source="benchmark", snapshot_date=snapshot_date)
    # Both builders share the ``recent_capped`` CTE name via their common
    # ``_recent_capped_per_tc_cte`` dependency. Joining the two builders inside
    # one WITH chain triggers ``DuplicateAliasError: WITH query name
    # "recent_capped" specified more than once``. Rename the anchor block's
    # local CTEs to a unique prefix — they're internal to that block and only
    # the final ``per_user_anchor`` name is referenced by the outer SELECT.
    anchor_block_renamed = (
        anchor_block.replace("recent_capped AS (", "recent_capped_anchor AS (")
        .replace("recent_capped_no_daily", "recent_capped_anchor_no_daily")
        .replace("FROM recent_capped rc", "FROM recent_capped_anchor rc")
    )
    return f"""
WITH {selected_users_cte(source="benchmark")},
{per_user_block},
{anchor_block_renamed}
SELECT
  puv.user_id,
  puv.metric_value,
  puv.n_games,
  pua.anchor_rating
FROM per_user_values puv
JOIN per_user_anchor pua USING (user_id)
""".strip()


# ---------------------------------------------------------------------------
# Per-cell cohort CDF computation (in-Python ranking).
# ---------------------------------------------------------------------------


# Row from the benchmark-DB JOIN. ``user_id`` is required for the deterministic
# tiebreaker on the sort (RESEARCH Pitfall 1 + W3 fix). Use a NamedTuple so
# the sort key can write ``r.anchor_rating`` / ``r.user_id`` (matches the
# RESEARCH Pattern 1 reference style and the plan-acceptance literal grep).
from typing import NamedTuple  # noqa: E402 — local to keep the row type near its sort


class _PerUserRow(NamedTuple):
    user_id: int
    metric_value: float
    n_games: int
    anchor_rating: int


# Per-cell suppression log entry. Captures both suppressed and non-suppressed
# anchors so the regen report can render the full 1,056-row table.
_CellLogEntry = dict[str, object]


def _percentile_linear(sorted_values: list[float], p: int) -> float:
    """Linear-interpolation percentile, matching numpy's default 'linear' method.

    ``sorted_values`` must already be sorted ascending. ``p`` is an integer
    percentile in [0, 100]. Returns ``float(sorted_values[i] + frac * (next-cur))``
    where ``i = (len(values) - 1) * p / 100`` (linear interpolation between
    the two surrounding ranks, matching ``numpy.percentile(..., method='linear')``).

    Pure-Python implementation so the script does not depend on numpy
    (which is not a project dependency — see pyproject.toml).

    Determinism: byte-identical results across runs given identical input.
    """
    n = len(sorted_values)
    if n == 0:
        raise ValueError("_percentile_linear called with empty list")
    if n == 1:
        return float(sorted_values[0])
    idx = (n - 1) * p / 100.0
    lo = int(idx)
    hi = min(lo + 1, n - 1)
    frac = idx - lo
    return float(sorted_values[lo] + frac * (sorted_values[hi] - sorted_values[lo]))


async def _query_per_user_with_anchor(
    session: AsyncSession,
    metric: CdfMetricId,
    tc: TimeControlBucket,
    snapshot_date: date,
) -> list[_PerUserRow]:
    """Fetch all (user_id, metric_value, n_games, anchor_rating) rows for one (metric, TC)."""
    sql = _build_per_user_with_anchor_query(metric, tc, snapshot_date=snapshot_date)
    result = await session.execute(text(sql))
    out: list[_PerUserRow] = []
    for r in result.all():
        out.append(
            _PerUserRow(
                user_id=int(r.user_id),
                metric_value=float(r.metric_value),
                n_games=int(r.n_games),
                anchor_rating=int(r.anchor_rating),
            )
        )
    return out


def _build_cohort_cdf_for(
    rows: list[_PerUserRow],
    metric: CdfMetricId,
    tc: TimeControlBucket,
) -> tuple[dict[int, CdfTable], list[_CellLogEntry]]:
    """In-Python rank ``rows`` across the anchor grid; return (per-anchor CDF map, log).

    For each anchor on the 50-Elo grid from ``COHORT_ANCHOR_MIN_ELO`` to
    ``COHORT_ANCHOR_MAX_ELO`` (inclusive):

    1. Filter ``rows`` to users with ``abs(anchor_rating - anchor) <= W`` (the
       eligibility window). This is the in-window pool ``n_in_window``.
    2. If ``n_in_window < MIN`` → suppress (insufficient_users_in_window).
    3. Otherwise, sort the in-window pool by ``(abs(distance), user_id)`` and
       cap at ``MAX`` to form the cohort. The ``user_id`` tiebreaker is
       REQUIRED for byte-identical regen determinism when capping at MAX
       and multiple users share the same anchor distance.
    4. Compute 99-breakpoint CDF via ``numpy.percentile`` and record under
       ``result[anchor]``.

    Returns a parallel suppression log capturing per-anchor n_users (cohort
    size), n_in_window (available pool), farthest_dist_elo (cohort width),
    suppressed flag, and suppression reason. The log feeds the regen report.
    """
    result: dict[int, CdfTable] = {}
    log: list[_CellLogEntry] = []
    for anchor in range(COHORT_ANCHOR_MIN_ELO, COHORT_ANCHOR_MAX_ELO + 1, COHORT_ANCHOR_STEP_ELO):
        in_window = [r for r in rows if abs(r.anchor_rating - anchor) <= COHORT_MAX_WINDOW_ELO]
        n_in_window = len(in_window)
        suppressed = False
        suppression_reason: str | None = None
        cohort: list[_PerUserRow] = []
        if n_in_window < COHORT_MIN_USERS_PER_ANCHOR:
            suppressed = True
            suppression_reason = "insufficient_users_in_window"
        else:
            # The (|distance|, user_id) tiebreaker is REQUIRED for byte-identical
            # regen determinism — when capping at MAX, users at the same anchor
            # distance must sort deterministically so the cohort is stable.
            cohort = sorted(in_window, key=lambda r: (abs(r.anchor_rating - anchor), r.user_id))[
                :COHORT_MAX_USERS_PER_ANCHOR
            ]
        n_users = len(cohort)
        farthest_dist: int = abs(cohort[-1].anchor_rating - anchor) if cohort else 0
        if not suppressed:
            values = sorted(r.metric_value for r in cohort)
            breakpoints = tuple(_percentile_linear(values, p) for p in range(1, 100))
            result[anchor] = CdfTable(
                breakpoints=breakpoints,
                n_users=n_users,
                snapshot_month=BENCHMARK_DB_SNAPSHOT_MONTH,
            )
        log.append(
            {
                "metric": metric,
                "anchor": anchor,
                "tc": tc,
                "n_users": n_users,
                "n_in_window": n_in_window,
                "farthest_dist_elo": farthest_dist,
                "suppressed": suppressed,
                "suppression_reason": suppression_reason,
            }
        )
    return result, log


# ---------------------------------------------------------------------------
# TSV seed emission — write cohort_cdf.tsv from cells dict.
# ---------------------------------------------------------------------------


def _write_seed_tsv(
    cells: dict[CdfMetricId, dict[tuple[int, TimeControlBucket], CdfTable]],
    path: Path,
) -> None:
    """Write ``cells`` to ``path`` as a tab-delimited seed file.

    Header: ``metric\tanchor_elo\ttc\tpercentile\tvalue\tn_users\tsnapshot_month``
    One data row per ``(metric, anchor_elo, tc, percentile)`` breakpoint.

    Iteration order mirrors the retired ``_emit_registry_block`` exactly so two
    regen runs against the same DB snapshot produce byte-identical TSV content:
    outer loop in ``IN_SCOPE_METRICS`` order; within each metric, sorted by
    ``(anchor ASC, tc in canonical ALL_TIME_CONTROLS order)``; innermost loop
    percentile index 0..98 (p1..p99).
    """
    tc_order = {tc: i for i, tc in enumerate(ALL_TIME_CONTROLS)}
    with path.open("w", newline="") as f:
        writer = csv.writer(f, delimiter="\t")
        writer.writerow(
            ["metric", "anchor_elo", "tc", "percentile", "value", "n_users", "snapshot_month"]
        )
        for metric in IN_SCOPE_METRICS:
            per_metric = cells.get(metric, {})
            sorted_keys = sorted(per_metric.keys(), key=lambda k: (k[0], tc_order[k[1]]))
            for anchor, tc in sorted_keys:
                table = per_metric[(anchor, tc)]
                for i, bp in enumerate(table.breakpoints):
                    percentile = int(BREAKPOINT_PERCENTILES[i])
                    writer.writerow(
                        [
                            metric,
                            anchor,
                            tc,
                            percentile,
                            f"{bp:.{FLOAT_PRECISION}f}",
                            table.n_users,
                            table.snapshot_month,
                        ]
                    )
    _log(f"Wrote {path}")


# ---------------------------------------------------------------------------
# Regen report.
# ---------------------------------------------------------------------------


_METRIC_DISPLAY: Final[dict[CdfMetricId, str]] = {
    "score_gap": "Endgame Score Gap",
    "achievable_score_gap": "Achievable Score Gap",
    "score_gap_conv": "Section 2 Conversion ΔES",
    "score_gap_parity": "Section 2 Parity ΔES",
    "recovery_score_gap": "Recovery Score Gap",
    "time_pressure_score_gap": "Time Pressure Score Gap",
    "clock_gap": "Clock Gap",
    "net_flag_rate": "Net Flag Rate",
    # Phase 99: raw-rate metric families
    "conversion_rate": "Conversion Rate",
    "parity_rate": "Parity Rate",
    "recovery_rate": "Recovery Rate",
}


def _render_regen_report(
    log: list[_CellLogEntry],
    snapshot_date: date,
    runtime_seconds: float,
    git_commit: str,
) -> str:
    """Compose the markdown text of the regen report.

    CONTEXT D-11 requires the per-(metric, anchor, TC) suppression-flag
    table as the TOP-LINE section after a brief intro + snapshot metadata.
    """
    snapshot_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    n_anchors_per_tc = (
        (COHORT_ANCHOR_MAX_ELO - COHORT_ANCHOR_MIN_ELO) // COHORT_ANCHOR_STEP_ELO
    ) + 1
    total_cells = len(IN_SCOPE_METRICS) * n_anchors_per_tc * len(ALL_TIME_CONTROLS)

    intro = (
        f"# Cohort Percentile CDF — Sliding-Window Methodology (Phase 94.4)\n\n"
        f"**Methodology:** Each cell is the 99-breakpoint empirical CDF over the "
        f"users in the (metric, anchor, TC) cohort, where a user is eligible "
        f"if their anchor rating is within ±{COHORT_MAX_WINDOW_ELO} Elo of the "
        f"cell anchor. The cohort takes up to {COHORT_MAX_USERS_PER_ANCHOR} users "
        f"from the in-window pool (nearest-anchor preferred when capping) and "
        f"requires at least {COHORT_MIN_USERS_PER_ANCHOR} for the cell to qualify. "
        f"Ranked in Python after one per-(metric, TC) SQL query joining "
        f"``per_user_values × per_user_anchor`` (RESEARCH Pitfall 8). Anchors "
        f"sweep {COHORT_ANCHOR_MIN_ELO}..{COHORT_ANCHOR_MAX_ELO} Elo on a "
        f"{COHORT_ANCHOR_STEP_ELO}-Elo grid ({n_anchors_per_tc} anchors per (metric, TC)). "
        f"A cell is SUPPRESSED when fewer than "
        f"{COHORT_MIN_USERS_PER_ANCHOR} users fall within ±"
        f"{COHORT_MAX_WINDOW_ELO} Elo of the anchor "
        f"(``insufficient_users_in_window``). Cohort size is variable per "
        f"cell — denser bands yield larger cohorts (tighter CIs) up to the "
        f"MAX cap; sparser bands sit closer to MIN.\n\n"
        f"- **DB**: benchmark (Docker on localhost:5433, "
        f"{BENCHMARK_DB_NAME_TOKEN})\n"
        f"- **Snapshot date (recency anchor)**: {snapshot_date.isoformat()} "
        f"(36-month window: ≥ {snapshot_date.isoformat()} − INTERVAL '36 months')\n"
        f"- **Report generated**: {snapshot_iso}\n"
        f"- **Benchmark DB snapshot month**: {BENCHMARK_DB_SNAPSHOT_MONTH}\n"
        f"- **Git commit (gen script)**: {git_commit}\n"
        f"- **Regen runtime**: {runtime_seconds:.1f}s\n"
        f"- **Generated by**: ``scripts/gen_global_percentile_cdf.py "
        f"--target benchmark --snapshot-date {snapshot_date.isoformat()}``\n\n"
        f"## Policy constants\n\n"
        f"- ``COHORT_MIN_USERS_PER_ANCHOR = {COHORT_MIN_USERS_PER_ANCHOR}``\n"
        f"- ``COHORT_MAX_USERS_PER_ANCHOR = {COHORT_MAX_USERS_PER_ANCHOR}``\n"
        f"- ``COHORT_MAX_WINDOW_ELO = {COHORT_MAX_WINDOW_ELO}``\n"
        f"- ``COHORT_ANCHOR_STEP_ELO = {COHORT_ANCHOR_STEP_ELO}``\n"
        f"- ``COHORT_ANCHOR_MIN_ELO = {COHORT_ANCHOR_MIN_ELO}``\n"
        f"- ``COHORT_ANCHOR_MAX_ELO = {COHORT_ANCHOR_MAX_ELO}``\n\n"
    )

    # TOP-LINE suppression-flag table.
    table_header = (
        "## Per-(metric, anchor, TC) suppression-flag table (TOP-LINE)\n\n"
        f"Per-cell rows for all {len(IN_SCOPE_METRICS)} metrics × "
        f"{n_anchors_per_tc} anchors × {len(ALL_TIME_CONTROLS)} TCs = "
        f"{total_cells:,} cells. "
        "Sorted by metric ASC, anchor ASC, TC in canonical order (bullet, "
        "blitz, rapid, classical). ``n_users`` is the cohort size used to "
        "compute the CDF (capped at MAX); ``n_in_window`` is the total "
        "available pool within ±W of the anchor; ``farthest_dist`` is the "
        "anchor distance of the furthest user actually in the cohort.\n\n"
        "| metric | anchor (Elo) | TC | suppressed | reason | farthest_dist (Elo) | n_users | n_in_window |\n"
        "|---|---:|---|---|---|---:|---:|---:|\n"
    )
    tc_order = {tc: i for i, tc in enumerate(ALL_TIME_CONTROLS)}
    sorted_log = sorted(
        log,
        key=lambda e: (
            IN_SCOPE_METRICS.index(e["metric"]),  # type: ignore[arg-type]
            cast(int, e["anchor"]),
            tc_order[cast(TimeControlBucket, e["tc"])],
        ),
    )
    rows: list[str] = []
    for entry in sorted_log:
        metric = entry["metric"]
        anchor = entry["anchor"]
        tc = entry["tc"]
        suppressed = bool(entry["suppressed"])
        reason = entry["suppression_reason"] or "—"
        farthest = entry["farthest_dist_elo"]
        n_users = entry["n_users"]
        n_in_window = entry["n_in_window"]
        rows.append(
            f"| {metric} | {anchor} | {tc} | {'Y' if suppressed else 'N'} | "
            f"{reason} | {farthest} | {n_users} | {n_in_window} |"
        )
    table_body = "\n".join(rows)

    # Per-metric coverage summary.
    coverage_lines: list[str] = ["\n\n## Per-metric coverage\n"]
    for metric in IN_SCOPE_METRICS:
        per_metric_log = [e for e in log if e["metric"] == metric]
        non_suppressed = sum(1 for e in per_metric_log if not e["suppressed"])
        total = len(per_metric_log)
        per_tc_counts: list[str] = []
        for tc in ALL_TIME_CONTROLS:
            tc_log = [e for e in per_metric_log if e["tc"] == tc]
            tc_non = sum(1 for e in tc_log if not e["suppressed"])
            per_tc_counts.append(f"{tc} {tc_non}/{len(tc_log)}")
        coverage_lines.append(
            f"- **{_METRIC_DISPLAY[metric]}** (`{metric}`): "
            f"{non_suppressed}/{total} cells non-suppressed; " + ", ".join(per_tc_counts)
        )

    # Relaxation-guidance paragraph (cites CONTEXT D-11).
    guidance = (
        "\n\n## Relaxation guidance\n\n"
        "If coverage in the table above is too sparse for the shipping goal, "
        "the operator can choose:\n\n"
        "- **Option A — ship current settings**: chip suppresses for users "
        "in the affected (metric, anchor, TC) cells; "
        "``interpolate_cohort_percentile`` returns ``None`` → frontend "
        "renders nothing.\n"
        "- **Option B — lower the MIN floor**: lower "
        f"``COHORT_MIN_USERS_PER_ANCHOR`` from {COHORT_MIN_USERS_PER_ANCHOR} "
        "and rerun the regen. Tradeoff: wider CIs on chips that fall in "
        "newly-qualifying cells (~±5pp at n=100, ~±7pp at n=50).\n"
        "- **Option C — widen the window**: raise ``COHORT_MAX_WINDOW_ELO`` "
        f"from {COHORT_MAX_WINDOW_ELO} Elo and rerun the regen. Tradeoff: "
        "the chip becomes less peer-relative as the band widens (a "
        "1600-anchored user gets compared against a [1600−W, 1600+W] band).\n"
        "- **Option D — raise the MAX cap**: raise "
        f"``COHORT_MAX_USERS_PER_ANCHOR`` from {COHORT_MAX_USERS_PER_ANCHOR} "
        "(or remove the cap) and rerun the regen. Tradeoff: tighter CIs in "
        "dense bands, but ``n_users`` becomes more variable across cells.\n\n"
        "Inspect the ``n_in_window`` column above to see where MAX is binding "
        "(``n_users == MAX < n_in_window``) vs. where MIN is the only floor "
        "(``n_users < MAX``).\n"
    )

    return intro + table_header + table_body + "\n".join(coverage_lines) + guidance


def _archive_prior_report(report_path: Path) -> Path | None:
    """Copy the prior report (if any) into ``reports/archive/`` before overwrite.

    Idempotent: if the dated archive destination already exists, logs a warning
    and returns the existing path without copying. The archive filename embeds
    today's date so successive regenerations across days produce non-colliding
    archive names.
    """
    if not report_path.exists():
        return None
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    today = date.today()
    # Try a tag based on the prior report's H1.
    try:
        head = report_path.read_text().splitlines()[0]
        m = re.search(r"\(Phase (\d+(?:\.\d+)*)\)", head)
        phase_tag = m.group(1) if m else "prior"
    except (OSError, IndexError):
        phase_tag = "prior"
    archive_path = ARCHIVE_DIR / f"{report_path.stem}-{today.isoformat()}-phase-{phase_tag}.md"
    if archive_path.exists():
        _log(f"Archive already exists: {archive_path}; not overwriting.")
        return archive_path
    import shutil

    shutil.copy2(report_path, archive_path)
    _log(f"Archived {report_path} -> {archive_path}")
    return archive_path


# ---------------------------------------------------------------------------
# Driver.
# ---------------------------------------------------------------------------


async def regenerate(
    *,
    target: str,
    snapshot_date: date,
    report_path: Path,
) -> tuple[dict[CdfMetricId, dict[tuple[int, TimeControlBucket], CdfTable]], list[_CellLogEntry]]:
    """Run the 3-level loop and emit the populated seed file + regen report.

    Returns ``(cells, suppression_log)`` for testing / inspection. Side effects:
    writes ``app/data/cohort_cdf.tsv`` (the long-row seed file) and writes the
    regen report to ``report_path``.
    """
    url = _db_url(target)
    _assert_benchmark_db(url)
    _log(f"Resolved DB URL: {_mask_password(url)}")
    _log(f"Snapshot date (recency anchor): {snapshot_date.isoformat()}")

    start_epoch = time.monotonic()
    cells: dict[CdfMetricId, dict[tuple[int, TimeControlBucket], CdfTable]] = {}
    full_log: list[_CellLogEntry] = []

    engine = create_async_engine(url, pool_pre_ping=True)
    try:
        session_maker = async_sessionmaker(engine, expire_on_commit=False)
        async with session_maker() as session:
            for metric in IN_SCOPE_METRICS:
                for tc in ALL_TIME_CONTROLS:
                    _log(f"  [{metric}|{tc}] querying per_user_values × per_user_anchor...")
                    rows = await _query_per_user_with_anchor(session, metric, tc, snapshot_date)
                    _log(f"  [{metric}|{tc}] received {len(rows)} rows; ranking in Python...")
                    per_anchor, log = _build_cohort_cdf_for(rows, metric, tc)
                    full_log.extend(log)
                    if per_anchor:
                        cells.setdefault(metric, {}).update(
                            {(anchor, tc): table for anchor, table in per_anchor.items()}
                        )
                    non_suppressed = sum(1 for e in log if not e["suppressed"])
                    _log(f"  [{metric}|{tc}] {non_suppressed}/{len(log)} anchors non-suppressed")
    finally:
        await engine.dispose()

    runtime = time.monotonic() - start_epoch

    # Resolve git commit for the gen script (audit-trail).
    git_commit = "unknown"
    try:
        import subprocess

        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        git_commit = out.stdout.strip()
    except Exception:  # pragma: no cover — best-effort audit
        pass

    _write_seed_tsv(cells, OUTPUT_SEED_PATH)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    _archive_prior_report(report_path)
    report_md = _render_regen_report(full_log, snapshot_date, runtime, git_commit)
    report_path.write_text(report_md)
    _log(f"Wrote {report_path}")
    return cells, full_log


def _parse_snapshot_date(raw: str) -> date:
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Invalid --snapshot-date {raw!r}: must be YYYY-MM-DD ({exc})"
        ) from exc


def parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Regenerate the cohort empirical-CDF artifact from the benchmark DB "
            "under the Phase 94.4 sliding-window cohort methodology "
            "(CONTEXT D-09 / D-11 / D-13)."
        ),
    )
    parser.add_argument(
        "--target",
        choices=["benchmark"],
        required=True,
        help=(
            "Database target. Only 'benchmark' is supported "
            f"(localhost:{_TARGET_PORT['benchmark']}, {BENCHMARK_DB_NAME_TOKEN})."
        ),
    )
    parser.add_argument(
        "--snapshot-date",
        type=_parse_snapshot_date,
        default=date.today(),
        dest="snapshot_date",
        metavar="YYYY-MM-DD",
        help=(
            "Anchor for the 36-month recency window. Defaults to today (UTC). "
            "Pinning to a specific date is recommended for byte-identical regen."
        ),
    )
    parser.add_argument(
        "--regen-report-path",
        type=Path,
        default=DEFAULT_REPORT_PATH,
        dest="report_path",
        help=(f"Output path for the markdown regen report. Defaults to {DEFAULT_REPORT_PATH}."),
    )
    return parser.parse_args()


async def main() -> None:
    """Entry point: parse CLI args, init Sentry, run regeneration."""
    args = parse_args()
    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)
    _log(
        f"Starting regen: target={args.target} "
        f"snapshot_date={args.snapshot_date.isoformat()} "
        f"report_path={args.report_path}"
    )
    await regenerate(
        target=args.target,
        snapshot_date=args.snapshot_date,
        report_path=args.report_path,
    )
    _log("Done.")


if __name__ == "__main__":
    asyncio.run(main())
