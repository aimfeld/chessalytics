"""Phase 212 BENCHLANE-01/05/06: scripts/benchmark_lane.py
`select`/`snapshot`/`status`/`record` subcommands.

Mock-session unit tests mirroring tests/test_benchmark_ingest.py::
test_persist_selection_compound_dedup's shape -- patch create_async_engine and
async_sessionmaker, feed a fake eligible-row result, and assert idempotency
behavior without touching a real database.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

from scripts import benchmark_lane


class _CursorInvalidatedError(RuntimeError):
    """Stand-in for asyncpg.exceptions.NoActiveSQLTransactionError.

    A real server-side cursor dies the moment its own session commits --
    "cursor cannot be created outside of a transaction". _FakeStreamResult
    reproduces that so the mock tests can catch the 212-09 bug, where the
    batched commit ran on the same session that owned the stream.
    """


class _FakeStreamResult:
    """Fake AsyncResult supporting `async for row in result`, mirroring
    session.stream()'s interface without a real server-side cursor.

    When ``owner`` is given, the fake enforces the real cursor's lifetime
    rule: committing the owning session mid-iteration invalidates it, and
    the next fetch raises instead of quietly returning the next row.
    """

    def __init__(self, rows: list[tuple[Any, ...]], owner: Any | None = None) -> None:
        self._rows = rows
        self._owner = owner
        self._commits_at_open = 0

    def __aiter__(self) -> "_FakeStreamResult":
        self._iter = iter(self._rows)
        self._commits_at_open = getattr(self._owner, "commit_count", 0)
        return self

    async def __anext__(self) -> tuple[Any, ...]:
        if self._owner is not None and self._owner.commit_count != self._commits_at_open:
            raise _CursorInvalidatedError(
                "cursor cannot be created outside of a transaction -- the session "
                "owning this stream was committed mid-iteration"
            )
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration from None


def _make_fake_engine_and_stream_session(
    existing_rows: list[tuple[int, int]],
    stream_rows: list[tuple[int, int, int | None, int | None]],
) -> tuple[MagicMock, MagicMock, list["benchmark_lane.BenchmarkLichessEvalSnapshot"], MagicMock]:
    """Build a fake engine + session pair for snapshot_lichess_evals's
    two-session shape (212-09): a read session that owns the streaming
    cursor, and a separate write session that takes the adds and the batched
    commits. ``async_sessionmaker`` is called once per session, so the fake
    maker hands out a fresh context manager on each call -- read first,
    write second, matching the ``async with`` order in the source.

    Returns (engine, session_maker, added_rows, read_session); the read
    session is returned so tests can assert it was never committed.
    """
    existing_result = MagicMock()
    existing_result.all = MagicMock(return_value=existing_rows)

    added_rows: list[benchmark_lane.BenchmarkLichessEvalSnapshot] = []

    def _make_session() -> MagicMock:
        session = MagicMock()
        session.commit_count = 0

        async def _commit() -> None:
            session.commit_count += 1

        session.commit = AsyncMock(side_effect=_commit)
        return session

    read_session = _make_session()
    read_session.stream = AsyncMock(return_value=_FakeStreamResult(stream_rows, owner=read_session))

    write_session = _make_session()
    write_session.execute = AsyncMock(return_value=existing_result)
    write_session.add = MagicMock(side_effect=lambda obj: added_rows.append(obj))

    @asynccontextmanager
    async def fake_session_cm(session: MagicMock):
        yield session

    # First call -> read session, second -> write session (source order).
    fake_session_maker = MagicMock(
        side_effect=[fake_session_cm(read_session), fake_session_cm(write_session)]
    )

    @asynccontextmanager
    async def fake_engine_begin():
        conn = MagicMock()
        conn.run_sync = AsyncMock()
        yield conn

    fake_engine = MagicMock()
    fake_engine.begin = MagicMock(side_effect=fake_engine_begin)
    fake_engine.dispose = AsyncMock()

    return fake_engine, fake_session_maker, added_rows, read_session


def _make_fake_engine_and_session(
    existing_rows: list[tuple[int, str]],
    eligible_rows: list[tuple[int, int, bool]],
) -> tuple[MagicMock, MagicMock, list["benchmark_lane.BenchmarkSelection"]]:
    """Build a fake engine + session pair for persist_selection's two-execute shape.

    session.execute is called twice in order: first the existing-pairs SELECT,
    then the eligible-games raw-SQL query. side_effect returns each result in
    turn.
    """
    existing_result = MagicMock()
    existing_result.all = MagicMock(return_value=existing_rows)

    eligible_result = MagicMock()
    eligible_result.all = MagicMock(return_value=eligible_rows)

    added_rows: list[benchmark_lane.BenchmarkSelection] = []

    mock_session = MagicMock()
    mock_session.execute = AsyncMock(side_effect=[existing_result, eligible_result])
    mock_session.add = MagicMock(side_effect=lambda obj: added_rows.append(obj))
    mock_session.commit = AsyncMock()

    @asynccontextmanager
    async def fake_session_cm():
        yield mock_session

    fake_session_maker = MagicMock(return_value=fake_session_cm())

    @asynccontextmanager
    async def fake_engine_begin():
        conn = MagicMock()
        conn.run_sync = AsyncMock()
        yield conn

    fake_engine = MagicMock()
    fake_engine.begin = MagicMock(side_effect=fake_engine_begin)
    fake_engine.dispose = AsyncMock()

    return fake_engine, fake_session_maker, added_rows


async def test_persist_selection_empty_eligible_set_is_a_noop() -> None:
    """persist_selection with an empty eligible set creates the table, inserts
    0 rows, and returns (0, 0) without raising -- the 100/user/TC cap is a
    ceiling, never a floor."""
    fake_engine, fake_session_maker, added_rows = _make_fake_engine_and_session(
        existing_rows=[], eligible_rows=[]
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.persist_selection(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    assert result == (0, 0)
    assert added_rows == []


async def test_persist_selection_idempotent_second_run_skips_all() -> None:
    """A second run over the same eligible rows inserts 0 and skips N."""
    eligible_rows = [(101, 5, True), (102, 5, False)]
    # Second run: both games already selected under 'classical'.
    existing_rows = [(101, "classical"), (102, "classical")]

    fake_engine, fake_session_maker, added_rows = _make_fake_engine_and_session(
        existing_rows=existing_rows, eligible_rows=eligible_rows
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.persist_selection(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    assert result == (0, 2)
    assert added_rows == []


async def test_persist_selection_one_game_two_tranches_inserts_two_rows() -> None:
    """A game eligible under two different tranches gets one row per tranche
    -- never merged into a single row."""
    # First run inserts the game under 'classical'.
    eligible_rows = [(101, 5, True)]

    fake_engine, fake_session_maker, added_rows = _make_fake_engine_and_session(
        existing_rows=[], eligible_rows=eligible_rows
    )
    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result_classical = await benchmark_lane.persist_selection(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )
    assert result_classical == (1, 0)
    assert len(added_rows) == 1
    assert added_rows[0].tc_tranche == "classical"

    # Second run: same game_id, but a DIFFERENT tranche ('rapid') and no
    # existing rows for 'rapid' yet -- must insert a second, independent row.
    fake_engine2, fake_session_maker2, added_rows2 = _make_fake_engine_and_session(
        existing_rows=[], eligible_rows=eligible_rows
    )
    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine2),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker2),
    ):
        result_rapid = await benchmark_lane.persist_selection(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="rapid",
            limit=None,
        )
    assert result_rapid == (1, 0)
    assert len(added_rows2) == 1
    assert added_rows2[0].tc_tranche == "rapid"
    assert added_rows2[0].game_id == added_rows[0].game_id


def test_eligible_games_sql_uses_md5_seed_not_random() -> None:
    """The compiled query text (inspected at runtime, not the source file) uses
    a reproducible md5-of-id ordering keyed on the :seed bind, and does not
    contain a non-deterministic ordering function."""
    sql = benchmark_lane._eligible_games_sql(limit=None)

    assert "md5(" in sql
    assert ":seed" in sql
    assert "random()" not in sql


def test_eligible_games_sql_limit_appends_limit_clause() -> None:
    """Passing a limit adds a LIMIT clause bound to :limit_n; omitting it does
    not."""
    sql_no_limit = benchmark_lane._eligible_games_sql(limit=None)
    sql_with_limit = benchmark_lane._eligible_games_sql(limit=20)

    assert "LIMIT" not in sql_no_limit
    assert "LIMIT :limit_n" in sql_with_limit


async def test_snapshot_empty_tranche_inserts_nothing() -> None:
    """snapshot_lichess_evals with zero streamed rows creates the table,
    inserts 0 rows, and returns (0, 0) without raising."""
    fake_engine, fake_session_maker, added_rows, _read_session = (
        _make_fake_engine_and_stream_session(existing_rows=[], stream_rows=[])
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.snapshot_lichess_evals(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    assert result == (0, 0)
    assert added_rows == []


async def test_snapshot_captures_eval_mate_rows() -> None:
    """A ply with eval_cp=None, eval_mate=3 (mate-scored position) produces a
    snapshot row, and the source query predicate includes the eval_mate
    branch -- removing it from _snapshot_source_sql would both stop the
    predicate assertion below from passing AND (in a live DB) silently drop
    every mate ply from the snapshot."""
    stream_rows: list[tuple[int, int, int | None, int | None]] = [(101, 5, None, 3)]
    fake_engine, fake_session_maker, added_rows, _read_session = (
        _make_fake_engine_and_stream_session(existing_rows=[], stream_rows=stream_rows)
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.snapshot_lichess_evals(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    assert result == (1, 0)
    assert len(added_rows) == 1
    assert added_rows[0].game_id == 101
    assert added_rows[0].ply == 5
    assert added_rows[0].eval_cp is None
    assert added_rows[0].eval_mate == 3

    sql = benchmark_lane._snapshot_source_sql(limit=None)
    assert "gp.eval_mate IS NOT NULL" in sql


async def test_snapshot_batched_commit_does_not_invalidate_the_stream() -> None:
    """Regression, 212-09: crossing SNAPSHOT_COMMIT_BATCH_SIZE mid-stream must
    not kill the server-side cursor.

    The batched commit has to land on the write session, never on the session
    that owns the stream -- committing the latter raises asyncpg's
    NoActiveSQLTransactionError ("cursor cannot be created outside of a
    transaction") on the very next fetch. The 20-game smoke tranche produced
    397 rows and never reached the 5,000-row threshold, so this path shipped
    unexercised and failed on the first real tranche at row 5,000.

    Feed 2x the batch size + 1 rows so at least two batch commits fire while
    the stream is still being consumed.
    """
    batch = benchmark_lane.SNAPSHOT_COMMIT_BATCH_SIZE
    row_count = batch * 2 + 1
    stream_rows: list[tuple[int, int, int | None, int | None]] = [
        (100_000 + i, i, i - 50, None) for i in range(row_count)
    ]

    (
        fake_engine,
        fake_session_maker,
        added_rows,
        read_session,
    ) = _make_fake_engine_and_stream_session(existing_rows=[], stream_rows=stream_rows)

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.snapshot_lichess_evals(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    # Every row survived the batch boundaries -- no truncation at row `batch`.
    assert result == (row_count, 0)
    assert len(added_rows) == row_count
    # The stream's own session was never committed; that is what keeps the
    # cursor alive across batches.
    assert read_session.commit_count == 0


def test_snapshot_source_sql_only_covers_lichess_arm() -> None:
    """The source query is scoped to bs.lichess_arm IS TRUE -- a
    lichess_arm=False selection row never contributes a snapshot row."""
    sql = benchmark_lane._snapshot_source_sql(limit=None)

    assert "bs.lichess_arm IS TRUE" in sql
    assert "bs.tc_tranche = :tranche" in sql


async def test_snapshot_skips_plies_with_no_eval() -> None:
    """A ply with both eval_cp and eval_mate NULL -- nothing to preserve --
    produces no snapshot row, even if it somehow reaches the Python loop
    (defense in depth on top of the SQL predicate)."""
    stream_rows: list[tuple[int, int, int | None, int | None]] = [(101, 5, None, None)]
    fake_engine, fake_session_maker, added_rows, _read_session = (
        _make_fake_engine_and_stream_session(existing_rows=[], stream_rows=stream_rows)
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.snapshot_lichess_evals(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    assert result == (0, 0)
    assert added_rows == []


def _make_fake_status_session(
    arm_rows: list[tuple[Any, ...]],
    snapshot_count: int,
    downstream_row: tuple[int, int, int, int] | None = None,
) -> tuple[MagicMock, MagicMock]:
    """Build a fake engine + session pair for tranche_status's / write_record_report's
    execute-call shape: session.execute is called in order --
    (1) the per-arm status counts query, (2) the snapshot row count, and
    (3, write_record_report only) the downstream row-count query."""
    arm_result = MagicMock()
    arm_result.all = MagicMock(return_value=arm_rows)

    snapshot_result = MagicMock()
    snapshot_result.scalar_one = MagicMock(return_value=snapshot_count)

    execute_results: list[MagicMock] = [arm_result, snapshot_result]
    if downstream_row is not None:
        downstream_result = MagicMock()
        downstream_result.one = MagicMock(return_value=downstream_row)
        execute_results.append(downstream_result)

    mock_session = MagicMock()
    mock_session.execute = AsyncMock(side_effect=execute_results)

    @asynccontextmanager
    async def fake_session_cm():
        yield mock_session

    fake_session_maker = MagicMock(return_value=fake_session_cm())

    @asynccontextmanager
    async def fake_engine_begin():
        conn = MagicMock()
        conn.run_sync = AsyncMock()
        yield conn

    fake_engine = MagicMock()
    fake_engine.begin = MagicMock(side_effect=fake_engine_begin)
    fake_engine.dispose = AsyncMock()

    return fake_engine, fake_session_maker


async def test_status_empty_tranche_all_zeros() -> None:
    """status --tranche classical on an unpopulated tranche returns explicit
    zeros for all four counts (in both arms) and exits normally -- never
    raises, never omits a section."""
    fake_engine, fake_session_maker = _make_fake_status_session(arm_rows=[], snapshot_count=0)

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        status = await benchmark_lane.tranche_status(
            db_url="postgresql+asyncpg://x:y@localhost/z", tranche="classical"
        )

    assert status.lichess_arm == benchmark_lane._ZERO_ARM_COUNTS
    assert status.never_analyzed_arm == benchmark_lane._ZERO_ARM_COUNTS
    assert status.snapshot_rows == 0


async def test_status_reports_four_completion_counts() -> None:
    """status reports selected/full_evals_done/full_pv_done/best_moves_done
    (plus blobs_done), split by lichess_arm, from the query's row shape."""
    arm_rows = [
        (True, 100, 80, 60, 40, 20),
        (False, 50, 50, 30, 10, 5),
    ]
    fake_engine, fake_session_maker = _make_fake_status_session(
        arm_rows=arm_rows, snapshot_count=1200
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        status = await benchmark_lane.tranche_status(
            db_url="postgresql+asyncpg://x:y@localhost/z", tranche="classical"
        )

    assert status.lichess_arm.selected == 100
    assert status.lichess_arm.full_evals_done == 80
    assert status.lichess_arm.full_pv_done == 60
    assert status.lichess_arm.best_moves_done == 40
    assert status.lichess_arm.blobs_done == 20
    assert status.never_analyzed_arm.selected == 50
    assert status.never_analyzed_arm.best_moves_done == 10
    assert status.snapshot_rows == 1200


def test_status_warns_on_maia_absent_signature() -> None:
    """A tranche with full_pv_done > 0 but best_moves_done == 0 across both
    arms prints the Maia-absent warning -- fails if the warning branch is
    removed."""
    status = benchmark_lane.TrancheStatus(
        tranche="classical",
        lichess_arm=benchmark_lane.ArmCounts(
            selected=100, full_evals_done=100, full_pv_done=90, best_moves_done=0, blobs_done=0
        ),
        never_analyzed_arm=benchmark_lane._ZERO_ARM_COUNTS,
        snapshot_rows=500,
    )

    output = benchmark_lane._format_status_block(status)

    assert "Maia-absent signature" in output


def test_status_no_maia_warning_on_unstarted_tranche() -> None:
    """A tranche with full_pv_done == 0 and best_moves_done == 0 (both arms)
    prints no warning -- an unstarted tranche is not a Maia failure."""
    status = benchmark_lane.TrancheStatus(
        tranche="classical",
        lichess_arm=benchmark_lane.ArmCounts(
            selected=100, full_evals_done=0, full_pv_done=0, best_moves_done=0, blobs_done=0
        ),
        never_analyzed_arm=benchmark_lane._ZERO_ARM_COUNTS,
        snapshot_rows=0,
    )

    output = benchmark_lane._format_status_block(status)

    assert "Maia-absent signature" not in output


async def test_record_writes_report(tmp_path: Path) -> None:
    """record writes to reports/benchmark-lane/benchmark-lane-{tranche}-YYYY-MM-DD.md."""
    fake_engine, fake_session_maker = _make_fake_status_session(
        arm_rows=[(True, 10, 8, 6, 4, 2)],
        snapshot_count=50,
        downstream_row=(30, 25, 15, 5),
    )
    now = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
        patch.object(benchmark_lane, "RECORD_REPORTS_DIR", tmp_path / "benchmark-lane"),
    ):
        report_path = await benchmark_lane.write_record_report(
            db_url="postgresql+asyncpg://x:y@localhost/z", tranche="classical", now=now
        )

    assert report_path == tmp_path / "benchmark-lane" / "benchmark-lane-classical-2026-08-22.md"
    assert report_path.exists()


async def test_record_empty_tranche_writes_explicit_zeros(tmp_path: Path) -> None:
    """record on an empty tranche writes a file whose count sections are
    explicit zeros -- not an omitted section, not a failure."""
    fake_engine, fake_session_maker = _make_fake_status_session(
        arm_rows=[], snapshot_count=0, downstream_row=(0, 0, 0, 0)
    )
    now = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
        patch.object(benchmark_lane, "RECORD_REPORTS_DIR", tmp_path / "benchmark-lane"),
    ):
        report_path = await benchmark_lane.write_record_report(
            db_url="postgresql+asyncpg://x:y@localhost/z", tranche="classical", now=now
        )

    content = report_path.read_text(encoding="utf-8")
    assert "| lichess_arm | 0 | 0 | 0 | 0 | 0 |" in content
    assert "| never_analyzed_arm | 0 | 0 | 0 | 0 | 0 |" in content
    assert "| `game_positions` rows with non-NULL `best_move` | 0 |" in content
    assert "## Downstream row counts" in content


async def test_record_same_day_overwrites(tmp_path: Path) -> None:
    """Re-running record for the same tranche on the same day overwrites that
    day's file rather than appending a second one."""
    now = datetime(2026, 8, 22, 12, 0, 0, tzinfo=timezone.utc)
    record_dir = tmp_path / "benchmark-lane"

    fake_engine1, fake_session_maker1 = _make_fake_status_session(
        arm_rows=[(True, 10, 5, 0, 0, 0)], snapshot_count=10, downstream_row=(0, 0, 0, 0)
    )
    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine1),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker1),
        patch.object(benchmark_lane, "RECORD_REPORTS_DIR", record_dir),
    ):
        await benchmark_lane.write_record_report(
            db_url="postgresql+asyncpg://x:y@localhost/z", tranche="classical", now=now
        )

    fake_engine2, fake_session_maker2 = _make_fake_status_session(
        arm_rows=[(True, 10, 10, 8, 6, 4)], snapshot_count=10, downstream_row=(6, 6, 3, 2)
    )
    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine2),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker2),
        patch.object(benchmark_lane, "RECORD_REPORTS_DIR", record_dir),
    ):
        second_path = await benchmark_lane.write_record_report(
            db_url="postgresql+asyncpg://x:y@localhost/z", tranche="classical", now=now
        )

    files = list(record_dir.glob("benchmark-lane-classical-*.md"))
    assert len(files) == 1
    content = second_path.read_text(encoding="utf-8")
    assert "| lichess_arm | 10 | 10 | 8 | 6 | 4 |" in content


def test_record_counts_use_exact_count_not_reltuples() -> None:
    """The compiled SQL text (inspected at runtime, not the source file) for
    status/record's count queries uses exact count(*), never
    pg_class.reltuples or any other planner-statistics relation. An
    explanatory comment in benchmark_lane.py cannot invalidate this."""
    for sql in (
        benchmark_lane._status_counts_sql(),
        benchmark_lane._snapshot_rows_count_sql(),
        benchmark_lane._record_downstream_counts_sql(),
    ):
        assert "count(" in sql
        assert "reltuples" not in sql
        assert "pg_class" not in sql


async def test_snapshot_idempotent_on_game_ply() -> None:
    """Re-running snapshot for the same (game_id, ply) inserts 0 and skips N,
    keyed on the compound unique constraint."""
    stream_rows: list[tuple[int, int, int | None, int | None]] = [
        (101, 5, 50, None),
        (101, 6, -30, None),
    ]
    existing_rows = [(101, 5)]
    fake_engine, fake_session_maker, added_rows, _read_session = (
        _make_fake_engine_and_stream_session(existing_rows=existing_rows, stream_rows=stream_rows)
    )

    with (
        patch.object(benchmark_lane, "create_async_engine", return_value=fake_engine),
        patch.object(benchmark_lane, "async_sessionmaker", return_value=fake_session_maker),
    ):
        result = await benchmark_lane.snapshot_lichess_evals(
            db_url="postgresql+asyncpg://x:y@localhost/z",
            tranche="classical",
            limit=None,
        )

    assert result == (1, 1)
    assert len(added_rows) == 1
    assert added_rows[0].ply == 6
