"""Phase 212 BENCHLANE-01/02/04/06: benchmark full-game-analysis lane operator surface.

One `scripts/` entry point with subcommands (D-16), following the established
`scripts/` self-describing `--help` convention: `select`, `snapshot`, `status`,
`record`. `select` and `snapshot` land in earlier plans of this phase; this
plan (212-05) adds `status` (tranche progress + the Maia guardrail) and
`record` (the timestamped row-count report SC6 requires).

`select` materializes `benchmark_selection` for one TC tranche: a capped
(GAMES_PER_USER_PER_TC_CAP=100 games/user/TC), randomly-selected (one
reproducible md5-seeded draw per user across the whole equal-footing set, D-02
-- no stratification, no minimum-per-arm floor), equal-footing
(EQUAL_FOOTING_MAX_RATING_GAP=100 opponent rating gap) slice of the benchmark
DB's eligible games for that tranche. THIS TABLE IS THE REPRODUCIBILITY RECORD
(D-01/D-16) -- selection order is deterministic (md5(g.id::text || SEED),
ascending user_id) so two runs over the same eligible set choose the identical
game set, and re-running is idempotent per (game_id, tc_tranche)
(uq_benchmark_selection_game_tranche).

The eligible-set query starts from the benchmarks skill's canonical
"selected_users" CTE (.claude/skills/benchmarks/SKILL.md) -- benchmark_selected_users
JOIN benchmark_ingest_checkpoints ON status='completed' JOIN users -- and adds the
equal-footing game filters (rated, non-computer, opponent rating gap <= 100,
both ratings present). games.time_control_bucket is a PostgreSQL enum and
tc_bucket is varchar, so the ::text cast is mandatory (SKILL.md's own note).

`status` reports selected/full_evals_done/full_pv_done/best_moves_done/blobs_done
counts, split by lichess_arm, joined benchmark_selection -> games via exact
COUNT(*) FILTER aggregates (never pg_class.reltuples). It surfaces D-12's Maia
guardrail explicitly: full_pv_done > 0 with best_moves_done == 0 across both
arms is the Maia-absent signature, not left for the operator to infer from row
counts after the fact.

`record` writes those same counts, plus a downstream row-count table
(game_positions.best_move/.pv non-NULL, game_flaws rows, game_best_moves rows,
all scoped via benchmark_selection), to a timestamped markdown report at
`reports/benchmark-lane/benchmark-lane-{tranche}-YYYY-MM-DD.md` -- mirroring
the db-report/tactic-tagger-report `reports/{topic}/{topic}-YYYY-MM-DD.md`
convention. This is SC6's "row counts recorded" artifact.

Usage:
    uv run python scripts/benchmark_lane.py select --tranche classical --db benchmark
    uv run python scripts/benchmark_lane.py select --tranche classical --db benchmark --limit 20
    uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark
    uv run python scripts/benchmark_lane.py status --all-tranches --db benchmark
    uv run python scripts/benchmark_lane.py record --tranche classical --db benchmark
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, cast

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sentry_sdk
from sqlalchemy import Table, select, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.benchmark_lichess_eval_snapshot import BenchmarkLichessEvalSnapshot  # noqa: E402
from app.models.benchmark_selection import BenchmarkSelection  # noqa: E402

# BenchmarkSelection FKs games.id and users.id; importing only BenchmarkSelection
# leaves both tables unregistered on the shared Base and create_all raises
# NoReferencedTableError at DDL-sort time (mirrors scripts/import_benchmark_users.py's
# same import requirement). User declares a relationship to OAuthAccount, so both
# must be imported too.
from app.models.game import Game  # noqa: E402, F401
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402, F401

# Tunables (no magic numbers, CLAUDE.md).
GAMES_PER_USER_PER_TC_CAP = 100
EQUAL_FOOTING_MAX_RATING_GAP = 100
# Reproducibility record (D-16): this exact string is baked into the md5 draw
# below, so changing it re-shuffles selection order for every future run.
SELECTION_SEED = "212-benchmark-lane"
TC_TRANCHES = ("classical", "rapid", "blitz", "bullet")
TcTranche = Literal["classical", "rapid", "blitz", "bullet"]

# D-05: commit every N rows while streaming the ~1.8M-row classical lichess-arm
# snapshot, rather than one giant transaction -- keeps a single WAL/undo
# footprint bounded and gives _log(...) progress visibility during a
# multi-minute run.
SNAPSHOT_COMMIT_BATCH_SIZE = 5000

# D-16: `record` mirrors the db-report/tactic-tagger-report timestamped-markdown
# convention -- reports/{topic}/{topic}-YYYY-MM-DD.md.
RECORD_REPORTS_DIR = Path(__file__).resolve().parent.parent / "reports" / "benchmark-lane"


@dataclass(frozen=True)
class ArmCounts:
    """One lichess_arm's worth of `status`/`record` completion counts.

    All four completion counts (full_evals_done/full_pv_done/best_moves_done/
    blobs_done) are exact COUNT(*) FILTER aggregates over benchmark_selection
    JOIN games, scoped to one tc_tranche and one lichess_arm value -- never a
    pg_class.reltuples estimate.
    """

    selected: int
    full_evals_done: int
    full_pv_done: int
    best_moves_done: int
    blobs_done: int


# An arm with zero benchmark_selection rows for this tranche (an unpopulated
# tranche, or a tranche whose eligible set was entirely one arm) reports
# explicit zeros -- never an omitted section, never a KeyError.
_ZERO_ARM_COUNTS = ArmCounts(
    selected=0, full_evals_done=0, full_pv_done=0, best_moves_done=0, blobs_done=0
)


@dataclass(frozen=True)
class TrancheStatus:
    """`status`/`record`'s per-tranche progress snapshot (D-16).

    lichess_arm / never_analyzed_arm mirror benchmark_selection.lichess_arm's
    two values (D-01's "both arms run" -- the lichess-eval arm is never
    deferred). snapshot_rows is benchmark_lichess_eval_snapshot's row count
    for this tranche's lichess arm only (the arm snapshot applies to) --
    there is no per-arm split for it since the never-analyzed arm has nothing
    to snapshot.
    """

    tranche: str
    lichess_arm: ArmCounts
    never_analyzed_arm: ArmCounts
    snapshot_rows: int


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _eligible_games_sql(limit: int | None) -> str:
    """Build the raw SQL text for the per-tranche eligible-games query.

    Returns the raw SQL string (not a compiled sa.text object) so callers
    (and tests) can inspect the exact text before it is wrapped in
    ``sa.text(...)``. Binds: :tranche, :seed, :max_gap, :cap (and :limit_n
    only when ``limit`` is not None -- the LIMIT clause is applied at the SQL
    level, on top of the deterministic user_id/game_id ordering, so two runs
    with the same --limit return the identical row set -- the idempotency
    proof BENCHLANE-04's smoke tranche depends on).

    The per-user cap is applied via ``ROW_NUMBER() OVER (PARTITION BY
    g.user_id ORDER BY md5(g.id::text || :seed)) <= :cap`` -- an md5-of-id
    ordering, not ``random()``, so the draw is uniform within a user AND
    reproducible across runs (D-16: this table IS the reproducibility
    record). Per D-02 this is exactly the described one-random-draw-per-user
    behavior: no stratification, no minimum-per-arm floor, no
    recency-ordering.
    """
    limit_clause = "\nLIMIT :limit_n" if limit is not None else ""
    return f"""
WITH selected_users AS (
  SELECT u.id AS user_id, bsu.tc_bucket
  FROM benchmark_selected_users bsu
  JOIN benchmark_ingest_checkpoints bic
    ON bic.lichess_username = bsu.lichess_username
   AND bic.tc_bucket = bsu.tc_bucket
   AND bic.status = 'completed'
  JOIN users u ON u.lichess_username = bsu.lichess_username
),
eligible AS (
  SELECT
    g.id AS game_id,
    g.user_id AS user_id,
    (g.lichess_evals_at IS NOT NULL) AS lichess_arm,
    ROW_NUMBER() OVER (
      PARTITION BY g.user_id ORDER BY md5(g.id::text || :seed)
    ) AS rn
  FROM games g
  JOIN selected_users su ON su.user_id = g.user_id
  WHERE g.rated
    AND NOT g.is_computer_game
    AND g.time_control_bucket::text = su.tc_bucket
    AND su.tc_bucket = :tranche
    AND g.white_rating IS NOT NULL
    AND g.black_rating IS NOT NULL
    AND abs(g.white_rating - g.black_rating) <= :max_gap
)
SELECT game_id, user_id, lichess_arm
FROM eligible
WHERE rn <= :cap
ORDER BY user_id, game_id{limit_clause}
"""


async def persist_selection(
    db_url: str,
    tranche: TcTranche,
    limit: int | None,
) -> tuple[int, int]:
    """Materialize benchmark_selection for one TC tranche.

    Creates benchmark_selection (if not exists, INFRA-02: targeted create_all,
    NOT in the canonical Alembic chain) then queries the tranche's eligible set
    and inserts up to GAMES_PER_USER_PER_TC_CAP games per user, skipping any
    (game_id, tc_tranche) pair already present so re-runs are idempotent.

    Returns (inserted, skipped_dupes). An empty eligible set (e.g. a tranche
    with zero eligible games) creates the table, inserts 0 rows, and returns
    (0, 0) without raising -- the 100/user/TC cap is a ceiling, never a floor,
    so a user with exactly one eligible game still contributes that one game.
    """
    engine = create_async_engine(db_url, echo=False)

    # Create benchmark_selection on first invocation (INFRA-02: benchmark-only
    # tables are not in the canonical Alembic chain). Pass the specific Table
    # object via metadata.create_all(tables=[...]) so unrelated canonical
    # tables (already created by Alembic) are not touched.
    bench_table = cast(Table, BenchmarkSelection.__table__)
    async with engine.begin() as conn:
        await conn.run_sync(
            lambda sync_conn: BenchmarkSelection.metadata.create_all(
                sync_conn, tables=[bench_table], checkfirst=True
            )
        )

    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    inserted = 0
    skipped_dupes = 0

    async with session_maker() as session:
        # Fetch existing (game_id, tc_tranche) pairs so re-runs are idempotent.
        # The compound dedup matches uq_benchmark_selection_game_tranche.
        existing_result = await session.execute(
            select(BenchmarkSelection.game_id, BenchmarkSelection.tc_tranche)
        )
        existing: set[tuple[int, str]] = {(row[0], row[1]) for row in existing_result.all()}

        params: dict[str, object] = {
            "tranche": tranche,
            "seed": SELECTION_SEED,
            "max_gap": EQUAL_FOOTING_MAX_RATING_GAP,
            "cap": GAMES_PER_USER_PER_TC_CAP,
        }
        if limit is not None:
            params["limit_n"] = limit

        eligible_result = await session.execute(text(_eligible_games_sql(limit)), params)
        eligible_rows = eligible_result.all()

        for game_id, user_id, lichess_arm in eligible_rows:
            key = (game_id, tranche)
            if key in existing:
                skipped_dupes += 1
                continue
            session.add(
                BenchmarkSelection(
                    game_id=game_id,
                    user_id=user_id,
                    tc_tranche=tranche,
                    lichess_arm=lichess_arm,
                    # Unarmed: invisible to every claim lane until the
                    # tranche's snapshot is complete. See arm_tranche below.
                    armed=False,
                )
            )
            existing.add(key)
            inserted += 1
        await session.commit()

    await engine.dispose()
    _log(
        f"select {tranche}: inserted {inserted:,}, skipped (already selected) "
        f"{skipped_dupes:,}, total considered {len(eligible_rows):,}"
    )
    _log(
        f"select {tranche}: rows are UNARMED and invisible to every claim lane. "
        f"Run `snapshot --tranche {tranche}` (which arms on success) or "
        f"`arm --tranche {tranche}` before the fleet can work on them."
    )
    return inserted, skipped_dupes


def _snapshot_source_sql(limit: int | None) -> str:
    """Build the raw SQL text for the lichess-eval-snapshot source query (D-05).

    Returns the raw SQL string (not a compiled sa.text object), mirroring
    _eligible_games_sql's shape, so callers (and tests) can inspect the exact
    text. Binds: :tranche (and :limit_n only when ``limit`` is not None).

    Joins benchmark_selection to game_positions, scoped to the requested
    tranche's lichess arm only (bs.lichess_arm IS TRUE) -- a lichess_arm=False
    selection row (the never-analyzed arm) never contributes a snapshot row,
    since there is nothing lichess-provided to preserve for it.

    Captures a ply only when at least one of eval_cp/eval_mate is non-NULL --
    game_positions stores a mate-scored position as eval_cp IS NULL with
    eval_mate set, so the eval_mate branch of this OR is what keeps mate
    plies from being silently dropped (see the model's module docstring).
    """
    limit_clause = "\nLIMIT :limit_n" if limit is not None else ""
    return f"""
SELECT gp.game_id, gp.ply, gp.eval_cp, gp.eval_mate
FROM benchmark_selection bs
JOIN game_positions gp ON gp.game_id = bs.game_id
WHERE bs.tc_tranche = :tranche
  AND bs.lichess_arm IS TRUE
  AND (gp.eval_cp IS NOT NULL OR gp.eval_mate IS NOT NULL)
ORDER BY gp.game_id, gp.ply{limit_clause}
"""


async def snapshot_lichess_evals(
    db_url: str,
    tranche: TcTranche,
    limit: int | None,
) -> tuple[int, int]:
    """Materialize benchmark_lichess_eval_snapshot for one TC tranche's lichess arm (D-05).

    Creates benchmark_lichess_eval_snapshot (if not exists, INFRA-02: targeted
    create_all, NOT in the canonical Alembic chain) then streams the
    tranche's lichess-arm plies from game_positions and inserts every
    (game_id, ply) not already captured, so re-runs are idempotent. This is
    the ONLY recovery path for the original lichess evals that
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE overwrites in place -- see the model's
    module docstring.

    Returns (inserted, skipped_dupes). An empty tranche (e.g. no
    benchmark_selection rows yet, or a tranche with zero lichess-arm games)
    creates the table, inserts 0 rows, and returns (0, 0) without raising.

    The classical lichess arm is roughly 27k games x ~67 plies, about 1.8M
    rows -- the source read uses session.stream(...) (a server-side cursor,
    mirroring scripts/archive/backfill_eval.py's _stream_eval_target_rows
    pattern) rather than .all(), and commits are batched every
    SNAPSHOT_COMMIT_BATCH_SIZE rows so a single transaction never holds the
    whole tranche.

    The read and the writes use SEPARATE sessions on purpose. Bug found in
    212-09 at full scale: with both on one session, the batched
    ``session.commit()`` ends the very transaction the server-side cursor
    lives in, and the next fetch raises
    ``asyncpg.exceptions.NoActiveSQLTransactionError: cursor cannot be
    created outside of a transaction``. The smoke tranche never reached the
    5,000-row batch threshold, so the batching path had never actually run
    before the real tranche hit it at row 5,000. Keep the stream on
    ``read_session`` and every insert/commit on ``write_session``.
    """
    engine = create_async_engine(db_url, echo=False)

    # Create benchmark_lichess_eval_snapshot on first invocation (INFRA-02:
    # benchmark-only tables are not in the canonical Alembic chain). Pass the
    # specific Table object via metadata.create_all(tables=[...]) so
    # unrelated canonical tables (already created by Alembic) are not
    # touched.
    bench_table = cast(Table, BenchmarkLichessEvalSnapshot.__table__)
    async with engine.begin() as conn:
        await conn.run_sync(
            lambda sync_conn: BenchmarkLichessEvalSnapshot.metadata.create_all(
                sync_conn, tables=[bench_table], checkfirst=True
            )
        )

    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    inserted = 0
    skipped_dupes = 0

    async with session_maker() as read_session, session_maker() as write_session:
        # Fetch existing (game_id, ply) pairs so re-runs are idempotent. The
        # compound dedup matches uq_benchmark_lichess_eval_snapshot_game_ply.
        existing_result = await write_session.execute(
            select(BenchmarkLichessEvalSnapshot.game_id, BenchmarkLichessEvalSnapshot.ply)
        )
        existing: set[tuple[int, int]] = {(row[0], row[1]) for row in existing_result.all()}

        params: dict[str, object] = {"tranche": tranche}
        if limit is not None:
            params["limit_n"] = limit

        pending_since_commit = 0
        stream_result = await read_session.stream(text(_snapshot_source_sql(limit)), params)
        async for row in stream_result:
            game_id, ply, eval_cp, eval_mate = row
            # Defense in depth on top of the SQL predicate: nothing to
            # preserve when both are NULL.
            if eval_cp is None and eval_mate is None:
                continue
            key = (game_id, ply)
            if key in existing:
                skipped_dupes += 1
                continue
            write_session.add(
                BenchmarkLichessEvalSnapshot(
                    game_id=game_id,
                    ply=ply,
                    eval_cp=eval_cp,
                    eval_mate=eval_mate,
                )
            )
            existing.add(key)
            inserted += 1
            pending_since_commit += 1
            if pending_since_commit >= SNAPSHOT_COMMIT_BATCH_SIZE:
                # Commits on write_session only -- committing on read_session
                # would invalidate the server-side cursor above.
                await write_session.commit()
                _log(
                    f"snapshot {tranche}: progress inserted={inserted:,} skipped={skipped_dupes:,}"
                )
                pending_since_commit = 0
        await write_session.commit()

    await engine.dispose()
    _log(f"snapshot {tranche}: inserted {inserted:,}, skipped (already captured) {skipped_dupes:,}")
    return inserted, skipped_dupes


def _arm_coverage_gap_sql() -> str:
    """SQL for the count of lichess-arm games in a tranche with NO snapshot rows.

    This is the predicate arming is conditional on. It must be 0 before a
    tranche is armed: a lichess-arm game with no preserved evals is one whose
    original lichess values are destroyed the moment a worker claims it, with
    no recovery path (see the model docstring on `armed`).

    Deliberately scoped to lichess_arm IS TRUE -- a never-analyzed-arm game has
    nothing lichess-provided to preserve, so it never contributes a gap.
    Binds: :tranche.
    """
    return """
SELECT count(*)
FROM benchmark_selection bs
WHERE bs.tc_tranche = :tranche
  AND bs.lichess_arm IS TRUE
  AND NOT EXISTS (
    SELECT 1 FROM benchmark_lichess_eval_snapshot s WHERE s.game_id = bs.game_id
  )
"""


async def arm_tranche(db_url: str, tranche: TcTranche) -> tuple[int, int]:
    """Arm a tranche's selection rows, but only if its snapshot is complete.

    Returns (armed_count, coverage_gap). When coverage_gap > 0 NOTHING is armed
    and armed_count is 0 -- the caller reports the gap and the tranche stays
    invisible to every claim lane.

    Arming is the step that makes a tranche claimable at all. Gating it on the
    coverage check turns "verify the gap is zero before starting the fleet"
    from an operator instruction that can be skipped into a precondition that
    cannot be. Idempotent: re-running on an armed tranche arms 0 more rows and
    still reports the gap.
    """
    engine = create_async_engine(db_url, echo=False)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        gap_result = await session.execute(text(_arm_coverage_gap_sql()), {"tranche": tranche})
        coverage_gap = int(gap_result.scalar_one())
        if coverage_gap > 0:
            await engine.dispose()
            return 0, coverage_gap
        # Counted with a SELECT rather than read off the UPDATE's rowcount:
        # session.execute is typed Result[Any], which has no rowcount, and an
        # admin command run once per tranche does not need the round trip back.
        pending_result = await session.execute(
            text(
                "SELECT count(*) FROM benchmark_selection WHERE tc_tranche = :tranche AND NOT armed"
            ),
            {"tranche": tranche},
        )
        armed_count = int(pending_result.scalar_one())
        await session.execute(
            text(
                "UPDATE benchmark_selection SET armed = true "
                "WHERE tc_tranche = :tranche AND NOT armed"
            ),
            {"tranche": tranche},
        )
        await session.commit()
    await engine.dispose()
    return armed_count, coverage_gap


def _status_counts_sql() -> str:
    """Build the raw SQL text for the per-tranche status/record completion counts.

    Returns the raw SQL string (not a compiled sa.text object), mirroring
    _eligible_games_sql's shape. Binds: :tranche.

    One query, not five round trips: COUNT(*) FILTER (WHERE ...) aggregate
    filters, GROUP BY bs.lichess_arm so the two arms come back as separate
    rows. Every count is an exact count(*) over benchmark_selection bs JOIN
    games g ON g.id = bs.game_id -- never pg_class.reltuples or any other
    planner-statistics estimate (the tranche's numbers are the artifact a
    data story cites, and an estimate would be wrong by a few percent in
    exactly the way nobody would notice).
    """
    return """
SELECT
  bs.lichess_arm,
  count(*) AS selected,
  count(*) FILTER (WHERE g.full_evals_completed_at IS NOT NULL) AS full_evals_done,
  count(*) FILTER (WHERE g.full_pv_completed_at IS NOT NULL) AS full_pv_done,
  count(*) FILTER (WHERE g.best_moves_completed_at IS NOT NULL) AS best_moves_done,
  count(*) FILTER (WHERE g.blobs_completed_at IS NOT NULL) AS blobs_done
FROM benchmark_selection bs
JOIN games g ON g.id = bs.game_id
WHERE bs.tc_tranche = :tranche
GROUP BY bs.lichess_arm
"""


def _snapshot_rows_count_sql() -> str:
    """Build the raw SQL text for the tranche's lichess-arm snapshot row count.

    Binds: :tranche. Exact count(*), joined through benchmark_selection and
    scoped to lichess_arm IS TRUE, mirroring _snapshot_source_sql's join
    shape (D-05) -- the never-analyzed arm has nothing to snapshot.
    """
    return """
SELECT count(*)
FROM benchmark_lichess_eval_snapshot s
JOIN benchmark_selection bs ON bs.game_id = s.game_id
WHERE bs.tc_tranche = :tranche
  AND bs.lichess_arm IS TRUE
"""


def _record_downstream_counts_sql() -> str:
    """Build the raw SQL text for `record`'s downstream row-count table (SC6).

    Binds: :tranche. One query (four scalar subselects), every count an
    exact count(*) scoped to the tranche via a join through
    benchmark_selection -- never pg_class.reltuples.
    """
    return """
SELECT
  (SELECT count(*) FROM benchmark_selection bs
     JOIN game_positions gp ON gp.game_id = bs.game_id
    WHERE bs.tc_tranche = :tranche AND gp.best_move IS NOT NULL) AS positions_with_best_move,
  (SELECT count(*) FROM benchmark_selection bs
     JOIN game_positions gp ON gp.game_id = bs.game_id
    WHERE bs.tc_tranche = :tranche AND gp.pv IS NOT NULL) AS positions_with_pv,
  (SELECT count(*) FROM benchmark_selection bs
     JOIN game_flaws gf ON gf.game_id = bs.game_id
    WHERE bs.tc_tranche = :tranche) AS game_flaws_rows,
  (SELECT count(*) FROM benchmark_selection bs
     JOIN game_best_moves gbm ON gbm.game_id = bs.game_id
    WHERE bs.tc_tranche = :tranche) AS game_best_moves_rows
"""


async def _fetch_arm_counts(
    session: AsyncSession, tranche: TcTranche
) -> tuple[dict[bool, ArmCounts], int]:
    """Query the per-arm completion counts + snapshot row count on an already-open session.

    Shared by tranche_status (status command) and write_record_report (record
    command) so both open exactly one engine/session for their own top-level
    call rather than tranche_status opening a second, throwaway one inside
    write_record_report.
    """
    result = await session.execute(text(_status_counts_sql()), {"tranche": tranche})
    arms: dict[bool, ArmCounts] = {}
    for row in result.all():
        lichess_arm, selected, full_evals_done, full_pv_done, best_moves_done, blobs_done = row
        arms[bool(lichess_arm)] = ArmCounts(
            selected=selected,
            full_evals_done=full_evals_done,
            full_pv_done=full_pv_done,
            best_moves_done=best_moves_done,
            blobs_done=blobs_done,
        )

    snapshot_result = await session.execute(text(_snapshot_rows_count_sql()), {"tranche": tranche})
    snapshot_rows = snapshot_result.scalar_one()
    return arms, snapshot_rows


async def _ensure_benchmark_lane_tables(engine: AsyncEngine) -> None:
    """Create benchmark_selection / benchmark_lichess_eval_snapshot if either
    is missing (checkfirst=True, INFRA-02), mirroring persist_selection's /
    snapshot_lichess_evals's own targeted create_all calls.

    `status`/`record` are read-only with respect to DATA (they never write a
    row), but an operator can legitimately run `status` before `select` has
    ever been run against this DB, or before `snapshot` has been run for this
    tranche -- in either case the underlying table does not exist yet, and a
    bare SELECT against a missing table raises UndefinedTableError rather
    than returning zero rows. Schema-only DDL (create an empty table if
    absent) keeps `status`/`record` from raising in that case while touching
    no data.
    """
    selection_table = cast(Table, BenchmarkSelection.__table__)
    snapshot_table = cast(Table, BenchmarkLichessEvalSnapshot.__table__)
    async with engine.begin() as conn:
        await conn.run_sync(
            lambda sync_conn: BenchmarkSelection.metadata.create_all(
                sync_conn, tables=[selection_table, snapshot_table], checkfirst=True
            )
        )


async def tranche_status(db_url: str, tranche: TcTranche) -> TrancheStatus:
    """Compute D-16's `status` snapshot for one TC tranche, split by lichess_arm.

    An unpopulated tranche (zero benchmark_selection rows for it, or the
    tables not created yet) returns explicit zeros for every count and exits
    normally -- never raises, never omits a section.
    """
    engine = create_async_engine(db_url, echo=False)
    await _ensure_benchmark_lane_tables(engine)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as session:
        arms, snapshot_rows = await _fetch_arm_counts(session, tranche)

    await engine.dispose()
    return TrancheStatus(
        tranche=tranche,
        lichess_arm=arms.get(True, _ZERO_ARM_COUNTS),
        never_analyzed_arm=arms.get(False, _ZERO_ARM_COUNTS),
        snapshot_rows=snapshot_rows,
    )


def _maia_absent_signature(status: TrancheStatus) -> bool:
    """D-12 guardrail (Pitfall 3): PV landed but no best-move rows ever stamped.

    full_pv_done > 0 with best_moves_done == 0, summed across BOTH arms, is
    the Maia-absent signature -- the local backend is producing PV but never
    stamping best_moves_completed_at. _build_best_move_candidates returns an
    empty list for BOTH "Maia ran, zero candidates" and "Maia absent" (see
    eval_apply.py's maia_available docstring), so row counts alone cannot
    distinguish them; the operator should check the :8001 startup log instead
    of waiting. Suppressed when both are zero -- an unstarted tranche is not
    a failure.
    """
    total_pv = status.lichess_arm.full_pv_done + status.never_analyzed_arm.full_pv_done
    total_best_moves = (
        status.lichess_arm.best_moves_done + status.never_analyzed_arm.best_moves_done
    )
    return total_pv > 0 and total_best_moves == 0


def _percent_complete(status: TrancheStatus) -> float:
    """best_moves_done / selected across both arms, as a percentage. Guards div-by-zero."""
    selected = status.lichess_arm.selected + status.never_analyzed_arm.selected
    if selected == 0:
        return 0.0
    best_moves_done = status.lichess_arm.best_moves_done + status.never_analyzed_arm.best_moves_done
    return 100.0 * best_moves_done / selected


def _format_arm_line(label: str, arm: ArmCounts) -> str:
    return (
        f"  {label}: selected={arm.selected:,} full_evals_done={arm.full_evals_done:,} "
        f"full_pv_done={arm.full_pv_done:,} best_moves_done={arm.best_moves_done:,} "
        f"blobs_done={arm.blobs_done:,}"
    )


def _format_status_block(status: TrancheStatus) -> str:
    """Human-readable status block for one tranche: per-arm counts, the
    lichess-arm snapshot row count, percent complete, and the Maia guardrail
    warning line when the Maia-absent signature is present (D-12)."""
    lines = [
        f"status {status.tranche}:",
        _format_arm_line("lichess_arm", status.lichess_arm),
        _format_arm_line("never_analyzed_arm", status.never_analyzed_arm),
        f"  snapshot_rows (lichess_arm only): {status.snapshot_rows:,}",
        f"  percent complete (best_moves_done / selected): {_percent_complete(status):.1f}%",
    ]
    if _maia_absent_signature(status):
        lines.append(
            "  WARNING: Maia-absent signature -- full_pv_done > 0 but best_moves_done == 0 "
            "across both arms. _build_best_move_candidates returns an empty list for BOTH "
            "'Maia ran, zero candidates' and 'Maia absent', so row counts alone cannot "
            "distinguish them -- check the :8001 startup log for 'Maia loaded' rather than "
            "waiting."
        )
    return "\n".join(lines)


async def write_record_report(db_url: str, tranche: TcTranche, now: datetime) -> Path:
    """Write the timestamped row-count report for one tranche (D-16, SC6).

    Writes to reports/benchmark-lane/benchmark-lane-{tranche}-YYYY-MM-DD.md,
    creating the directory if absent. Takes ``now`` as a parameter (never
    calls datetime.now() internally) so a test can pin the filename. The
    filename is deterministic in (tranche, now.date()) -- re-running on the
    same day for the same tranche overwrites that day's file rather than
    appending a second one.

    An empty tranche (zero benchmark_selection rows, or the tables not
    created yet) still writes a complete report whose count sections are
    explicit zero rows, never an omitted section and never a raised error.
    """
    engine = create_async_engine(db_url, echo=False)
    await _ensure_benchmark_lane_tables(engine)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as session:
        arms, snapshot_rows = await _fetch_arm_counts(session, tranche)
        downstream_result = await session.execute(
            text(_record_downstream_counts_sql()), {"tranche": tranche}
        )
        downstream_row = downstream_result.one()

    await engine.dispose()

    status = TrancheStatus(
        tranche=tranche,
        lichess_arm=arms.get(True, _ZERO_ARM_COUNTS),
        never_analyzed_arm=arms.get(False, _ZERO_ARM_COUNTS),
        snapshot_rows=snapshot_rows,
    )
    positions_with_best_move, positions_with_pv, game_flaws_rows, game_best_moves_rows = (
        downstream_row
    )

    RECORD_REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    date_str = now.strftime("%Y-%m-%d")
    report_path = RECORD_REPORTS_DIR / f"benchmark-lane-{tranche}-{date_str}.md"

    lines = [
        f"# FlawChess Benchmark Lane Report — {tranche} — {date_str}",
        "",
        f"- **Tranche**: {tranche}",
        f"- **Snapshot taken**: {now.strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "",
        "## Tranche progress",
        "",
        "Exact `COUNT(*)` aggregates, `benchmark_selection` joined to the `games` "
        "completion columns, split by `lichess_arm`.",
        "",
        "| Arm | Selected | full_evals_done | full_pv_done | best_moves_done | blobs_done |",
        "|---|---|---|---|---|---|",
        (
            f"| lichess_arm | {status.lichess_arm.selected:,} | "
            f"{status.lichess_arm.full_evals_done:,} | {status.lichess_arm.full_pv_done:,} | "
            f"{status.lichess_arm.best_moves_done:,} | {status.lichess_arm.blobs_done:,} |"
        ),
        (
            f"| never_analyzed_arm | {status.never_analyzed_arm.selected:,} | "
            f"{status.never_analyzed_arm.full_evals_done:,} | "
            f"{status.never_analyzed_arm.full_pv_done:,} | "
            f"{status.never_analyzed_arm.best_moves_done:,} | "
            f"{status.never_analyzed_arm.blobs_done:,} |"
        ),
        "",
        f"- **benchmark_lichess_eval_snapshot rows (lichess arm only)**: {status.snapshot_rows:,}",
        f"- **Percent complete (best_moves_done / selected)**: {_percent_complete(status):.1f}%",
    ]
    if _maia_absent_signature(status):
        lines.append(
            "- **WARNING**: Maia-absent signature -- `full_pv_done` > 0 but "
            "`best_moves_done` == 0 across both arms. Check the :8001 startup log for "
            '"Maia loaded" (D-12).'
        )
    lines += [
        "",
        "## Downstream row counts (SC6)",
        "",
        "Each row is an exact `COUNT(*)` scoped to this tranche via a join through "
        "`benchmark_selection` -- never a `pg_class.reltuples` estimate.",
        "",
        "| Metric | Count |",
        "|---|---|",
        f"| `game_positions` rows with non-NULL `best_move` | {positions_with_best_move:,} |",
        f"| `game_positions` rows with non-NULL `pv` | {positions_with_pv:,} |",
        f"| `game_flaws` rows | {game_flaws_rows:,} |",
        f"| `game_best_moves` rows | {game_best_moves_rows:,} |",
        "",
        "## Provenance",
        "",
        "Every row above is scoped to this tranche via `benchmark_selection`. "
        "`benchmark_selection.lichess_arm` is the split key for eval provenance: rows "
        "with `lichess_arm IS TRUE` were re-evaluated by our Stockfish despite having "
        "lichess evals at import time (`BENCHMARK_HOMOGENIZE_EVAL_SOURCE`, D-03); a "
        "game with no `benchmark_selection` row at all remains untouched, "
        "lichess-classified data. See `.claude/skills/benchmarks/SKILL.md` § 5 "
        '"Mixed eval provenance in `game_flaws`" for the full disclosure (D-06).',
        "",
    ]
    report_path.write_text("\n".join(lines), encoding="utf-8")
    _log(f"record {tranche}: wrote {report_path}")
    return report_path


def _add_select_subparser(
    subparsers: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    select_parser = subparsers.add_parser(
        "select",
        help="Materialize benchmark_selection for one TC tranche.",
    )
    select_parser.add_argument(
        "--tranche",
        choices=TC_TRANCHES,
        required=True,
        help="TC tranche to select games for.",
    )
    select_parser.add_argument(
        "--db",
        choices=["dev", "test", "prod", "benchmark"],
        default="benchmark",
        help="DB target (default: benchmark).",
    )
    select_parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap total rows inserted (e.g. for a small smoke tranche).",
    )


def _add_snapshot_subparser(
    subparsers: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    snapshot_parser = subparsers.add_parser(
        "snapshot",
        help="Preserve original lichess evals for one TC tranche's lichess arm (D-05).",
    )
    snapshot_parser.add_argument(
        "--tranche",
        choices=TC_TRANCHES,
        required=True,
        help="TC tranche to snapshot lichess evals for.",
    )
    snapshot_parser.add_argument(
        "--db",
        choices=["dev", "test", "prod", "benchmark"],
        default="benchmark",
        help="DB target (default: benchmark).",
    )
    snapshot_parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap total rows inserted (e.g. for a small smoke run).",
    )


def _add_arm_subparser(
    subparsers: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    arm_parser = subparsers.add_parser(
        "arm",
        help="Make a tranche claimable, only if its lichess-eval snapshot is complete.",
    )
    arm_parser.add_argument(
        "--tranche",
        choices=TC_TRANCHES,
        required=True,
        help="TC tranche to arm.",
    )
    arm_parser.add_argument(
        "--db",
        choices=["dev", "test", "prod", "benchmark"],
        default="benchmark",
        help="DB target (default: benchmark).",
    )


def _add_status_subparser(
    subparsers: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    status_parser = subparsers.add_parser(
        "status",
        help="Print tranche progress (selected/full_evals/full_pv/best_moves/blobs) and the Maia guardrail.",
    )
    status_parser.add_argument(
        "--tranche",
        choices=TC_TRANCHES,
        default=None,
        help="TC tranche to report status for. Required unless --all-tranches is given.",
    )
    status_parser.add_argument(
        "--db",
        choices=["dev", "test", "prod", "benchmark"],
        default="benchmark",
        help="DB target (default: benchmark).",
    )
    status_parser.add_argument(
        "--all-tranches",
        action="store_true",
        dest="all_tranches",
        help="Print every tranche's status block in one pass.",
    )


def _add_record_subparser(
    subparsers: "argparse._SubParsersAction[argparse.ArgumentParser]",
) -> None:
    record_parser = subparsers.add_parser(
        "record",
        help="Write the timestamped row-count report to reports/benchmark-lane/ (SC6).",
    )
    record_parser.add_argument(
        "--tranche",
        choices=TC_TRANCHES,
        required=True,
        help="TC tranche to record a report for.",
    )
    record_parser.add_argument(
        "--db",
        choices=["dev", "test", "prod", "benchmark"],
        default="benchmark",
        help="DB target (default: benchmark).",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Phase 212 benchmark full-game-analysis lane operator surface."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    _add_select_subparser(subparsers)
    _add_snapshot_subparser(subparsers)
    _add_arm_subparser(subparsers)
    _add_status_subparser(subparsers)
    _add_record_subparser(subparsers)
    args = parser.parse_args()
    if args.command == "status" and not args.all_tranches and args.tranche is None:
        parser.error("status requires --tranche unless --all-tranches is given")
    return args


async def _run_select(args: argparse.Namespace) -> None:
    db_url = db_url_for_target(args.db)
    inserted, skipped = await persist_selection(db_url, args.tranche, args.limit)
    _log(f"select-mode summary: inserted={inserted} skipped={skipped} total={inserted + skipped}")


async def _run_snapshot(args: argparse.Namespace) -> None:
    db_url = db_url_for_target(args.db)
    inserted, skipped = await snapshot_lichess_evals(db_url, args.tranche, args.limit)
    _log(f"snapshot-mode summary: inserted={inserted} skipped={skipped} total={inserted + skipped}")
    # Arm here rather than as a separate operator step: a snapshot that just
    # completed is exactly when the tranche becomes safe to claim, and leaving
    # arming to a remembered follow-up command reintroduces the ordering
    # mistake this column exists to prevent. A --limit run is a partial
    # snapshot by construction, so it never arms.
    if args.limit is not None:
        _log(
            f"snapshot {args.tranche}: --limit given, so this is a PARTIAL snapshot; "
            f"not arming. Run a full snapshot, then `arm --tranche {args.tranche}`."
        )
        return
    await _arm_and_log(db_url, args.tranche)


async def _arm_and_log(db_url: str, tranche: TcTranche) -> None:
    """Arm a tranche and report the outcome, including a refusal."""
    armed_count, coverage_gap = await arm_tranche(db_url, tranche)
    if coverage_gap > 0:
        _log(
            f"arm {tranche}: REFUSED -- {coverage_gap:,} lichess-arm game(s) have no "
            f"snapshot rows. Nothing was armed and the tranche stays invisible to every "
            f"claim lane. Re-run `snapshot --tranche {tranche}` and arm again."
        )
        return
    _log(f"arm {tranche}: armed {armed_count:,} row(s); coverage gap 0. Tranche is claimable.")


async def _run_arm(args: argparse.Namespace) -> None:
    await _arm_and_log(db_url_for_target(args.db), args.tranche)


async def _run_status(args: argparse.Namespace) -> None:
    db_url = db_url_for_target(args.db)
    tranches = TC_TRANCHES if args.all_tranches else (args.tranche,)
    for tranche in tranches:
        status = await tranche_status(db_url, tranche)
        _log(_format_status_block(status))


async def _run_record(args: argparse.Namespace) -> None:
    db_url = db_url_for_target(args.db)
    now = datetime.now(timezone.utc)
    report_path = await write_record_report(db_url, args.tranche, now)
    _log(f"record-mode summary: wrote {report_path}")


async def main() -> None:
    args = parse_args()
    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if args.command == "select":
        await _run_select(args)
    elif args.command == "snapshot":
        await _run_snapshot(args)
    elif args.command == "arm":
        await _run_arm(args)
    elif args.command == "status":
        await _run_status(args)
    elif args.command == "record":
        await _run_record(args)
    else:  # pragma: no cover — unreachable while argparse enforces a known command set
        raise ValueError(f"Unknown command: {args.command!r}")


if __name__ == "__main__":
    asyncio.run(main())
