"""Dual-platform import stress driver for Phase 95 COPY-conversion verification.

Purpose: Spawn two concurrent import_service.run_import() calls (chess.com + lichess)
for a real FlawChess user while sampling docker stats + pg_stat_activity at a
configurable interval. Produces three output files per run:

    {output_dir}/{output_tag}-docker-stats.csv
    {output_dir}/{output_tag}-pg-activity.csv
    {output_dir}/{output_tag}-summary.json

The summary JSON exposes the peak memory, peak connection count, both ImportJob
final statuses, and total wall-clock duration — the numbers that feed the
phase95-import-stress-test-{date}.md verdict report.

Entrypoint used: import_service.run_import(job_id: str) -> None
Rationale: run_import is the exact code path the API calls via asyncio.create_task;
calling it directly from a script exercises the identical hot lane without
any mocking or simplified shim. create_job() seeds the in-memory registry with
the job spec and returns the UUID that run_import consumes.

DB connection for metric sampling: a dedicated AsyncEngine built from the
DATABASE_URL env var (defaults to the dev DB at localhost:5432). This is
separate from import_service's own sessions to avoid contention.

Override env var: DATABASE_URL  (inherits from settings.DATABASE_URL default)
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.services.import_service import JobState, create_job, get_job, run_import  # noqa: E402

# ---------------------------------------------------------------------------
# Constants — no magic numbers
# ---------------------------------------------------------------------------

DEFAULT_SAMPLE_INTERVAL_S: float = 5.0
DEFAULT_DB_CONTAINER: str = "flawchess-dev-db-1"
DEFAULT_OUTPUT_DIR: Path = Path("reports/phase95-stress-data")
# Dev DB name is "flawchess" per app.core.config.settings.DATABASE_URL;
# the plan (95-02-PLAN.md line 107) said "flawchess_dev" which was a plan-side typo.
PG_DBNAME: str = "flawchess"

# Columns for the docker-stats CSV.
_DOCKER_CSV_HEADER = [
    "timestamp_iso",
    "mem_usage_bytes",
    "mem_perc",
    "cpu_perc",
]

# Columns for the pg-activity CSV.
_PG_CSV_HEADER = [
    "timestamp_iso",
    "pid",
    "state",
    "query_age_s",
    "query_excerpt",
]


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class StressTestResult:
    """Summary of a completed stress test run."""

    start_iso: str
    end_iso: str
    total_duration_s: float
    chesscom_status: str
    lichess_status: str
    chesscom_error: str | None
    lichess_error: str | None
    peak_mem_usage_bytes: int
    peak_connection_count: int
    output_dir: Path
    output_tag: str


# ---------------------------------------------------------------------------
# Docker stats parsing helpers
# ---------------------------------------------------------------------------


def _parse_mem_bytes(raw: str) -> int:
    """Parse a docker stats memory string (e.g. '1.23GiB') to bytes.

    Returns 0 on parse failure.
    """
    raw = raw.strip()
    match = re.match(r"([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B)", raw, re.IGNORECASE)
    if not match:
        return 0
    value = float(match.group(1))
    unit = match.group(2).lower()
    factors: dict[str, float] = {
        "gib": 1024**3,
        "mib": 1024**2,
        "kib": 1024.0,
        "gb": 1_000_000_000.0,
        "mb": 1_000_000.0,
        "kb": 1_000.0,
        "b": 1.0,
    }
    return int(value * factors.get(unit, 1.0))


def _parse_perc(raw: str) -> float:
    """Parse a percentage string like '12.3%' to a float. Returns 0.0 on failure."""
    raw = raw.strip().rstrip("%")
    try:
        return float(raw)
    except ValueError:
        return 0.0


def _ts_iso_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Metric sampler coroutine
# ---------------------------------------------------------------------------


async def _sample_metrics(
    *,
    output_dir: Path,
    output_tag: str,
    db_container: str,
    sample_interval: float,
    stop_event: asyncio.Event,
) -> tuple[int, int]:
    """Sample docker stats + pg_stat_activity until stop_event is set.

    Appends rows to the two CSVs. Returns (peak_mem_bytes, peak_pg_connections).

    The sampler opens its own AsyncEngine to avoid sharing sessions with the
    import hot-lane. It connects to the default dev DATABASE_URL.
    """
    docker_csv_path = output_dir / f"{output_tag}-docker-stats.csv"
    pg_csv_path = output_dir / f"{output_tag}-pg-activity.csv"

    output_dir.mkdir(parents=True, exist_ok=True)

    peak_mem_bytes: int = 0
    peak_conn_count: int = 0

    # Build a separate engine for metric queries (pool_size=1 is enough).
    metric_engine = create_async_engine(
        settings.DATABASE_URL,
        pool_size=1,
        max_overflow=0,
        pool_pre_ping=True,
    )

    # IN-06 fix: open a single pg connection for the lifetime of the sampler
    # instead of opening/closing one per sample tick. Previously each tick did
    # a TCP handshake + auth round-trip and contributed an extra row to
    # pg_stat_activity (mildly inflating peak_connection_count). Mirrors the
    # docker_writer pattern (open once, reuse).
    async with metric_engine.connect() as pg_conn:
        with (
            docker_csv_path.open("w", newline="", encoding="utf-8") as docker_fh,
            pg_csv_path.open("w", newline="", encoding="utf-8") as pg_fh,
        ):
            docker_writer: csv.DictWriter[str] = csv.DictWriter(
                docker_fh, fieldnames=_DOCKER_CSV_HEADER
            )
            pg_writer: csv.DictWriter[str] = csv.DictWriter(pg_fh, fieldnames=_PG_CSV_HEADER)
            docker_writer.writeheader()
            pg_writer.writeheader()
            docker_fh.flush()
            pg_fh.flush()

            while not stop_event.is_set():
                ts = _ts_iso_utc()
                # WR-01 fix: _sample_docker now returns the parsed mem_bytes so the
                # CSV write and peak tracker share a single docker stats observation
                # (previously a second docker stats invocation captured the peak,
                # causing the CSV trace and peak_mem_usage_bytes to diverge under
                # live memory pressure, and doubling per-sample subprocess cost).
                mem_bytes = await _sample_docker(
                    ts=ts,
                    db_container=db_container,
                    writer=docker_writer,
                )
                if mem_bytes > peak_mem_bytes:
                    peak_mem_bytes = mem_bytes

                conn_count = await _sample_pg_activity(
                    ts=ts,
                    conn=pg_conn,
                    writer=pg_writer,
                )
                if conn_count > peak_conn_count:
                    peak_conn_count = conn_count

                docker_fh.flush()
                pg_fh.flush()

                # Sleep in small slices so we respond to stop_event quickly.
                elapsed = 0.0
                slice_s = min(0.5, sample_interval)
                while elapsed < sample_interval and not stop_event.is_set():
                    await asyncio.sleep(slice_s)
                    elapsed += slice_s

    await metric_engine.dispose()
    return peak_mem_bytes, peak_conn_count


async def _sample_docker(
    *,
    ts: str,
    db_container: str,
    writer: "csv.DictWriter[str]",
) -> int:
    """Run docker stats --no-stream, parse, write one CSV row. Returns mem_bytes (0 on error).

    WR-01 fix: single source of truth for both the CSV write and peak tracking —
    previously the peak was captured by a second `_get_docker_mem_bytes` call,
    which doubled the per-sample subprocess cost and could disagree with the
    CSV row under live memory pressure.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "stats",
            db_container,
            "--no-stream",
            "--format",
            "{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
        line = stdout.decode().strip()
        if not line:
            return 0
        parts = line.split("\t")
        if len(parts) < 3:
            return 0
        mem_used = parts[0].split("/")[0].strip()
        mem_bytes = _parse_mem_bytes(mem_used)
        mem_perc = _parse_perc(parts[1])
        cpu_perc = _parse_perc(parts[2])
        writer.writerow(
            {
                "timestamp_iso": ts,
                "mem_usage_bytes": mem_bytes,
                "mem_perc": f"{mem_perc:.2f}",
                "cpu_perc": f"{cpu_perc:.2f}",
            }
        )
        return mem_bytes
    except FileNotFoundError:
        # WR-03 fix: missing `docker` binary is fatal — re-raise so the run
        # aborts immediately rather than silently producing 0-byte traces.
        raise
    except Exception as exc:
        # WR-03 fix: surface the failure to stderr so the operator sees why
        # the CSV trace has gaps. Previously this `except Exception: pass`
        # made sampler failures invisible until the final summary.
        print(f"[sampler] docker sample failed: {exc!r}", file=sys.stderr)
        return 0


async def _sample_pg_activity(
    *,
    ts: str,
    conn: object,
    writer: "csv.DictWriter[str]",
) -> int:
    """Query pg_stat_activity, write one CSV row per backend, return row count.

    IN-06 fix: takes a long-lived ``AsyncConnection`` instead of opening one per
    call. The connection is owned by the outer ``_sample_metrics`` ``with`` block
    and reused across every sample tick, eliminating per-tick connect/auth cost.
    """
    sql = text(
        "SELECT pid, state, "
        "EXTRACT(EPOCH FROM (NOW() - query_start)) AS query_age_s, "
        "LEFT(query, 80) AS query_excerpt "
        "FROM pg_stat_activity "
        # IN-07 fix: filter out the sampler's own backend so peak_connection_count
        # reflects only import-driven connections, not the +1 from this SELECT.
        "WHERE datname = :dbname AND pid != pg_backend_pid()"
    )
    conn_count = 0
    try:
        from sqlalchemy.ext.asyncio import AsyncConnection  # noqa: PLC0415

        assert isinstance(conn, AsyncConnection)
        result = await conn.execute(sql, {"dbname": PG_DBNAME})
        rows = result.fetchall()
        for row in rows:
            conn_count += 1
            writer.writerow(
                {
                    "timestamp_iso": ts,
                    "pid": row.pid,
                    "state": row.state or "",
                    "query_age_s": f"{row.query_age_s:.1f}" if row.query_age_s is not None else "",
                    "query_excerpt": (row.query_excerpt or "").replace("\n", " "),
                }
            )
    except Exception as exc:
        # WR-03 fix: surface sampler failures to stderr instead of silently
        # swallowing them. A pg disconnect or query timeout would otherwise
        # leave the verdict report with peak_connection_count=0 and no clue
        # why.
        print(f"[sampler] pg_stat_activity sample failed: {exc!r}", file=sys.stderr)
    return conn_count


# ---------------------------------------------------------------------------
# Main stress test orchestrator
# ---------------------------------------------------------------------------


async def run_stress_test(
    *,
    user_id: int,
    chesscom_username: str,
    lichess_username: str,
    output_tag: str,
    sample_interval_s: float = DEFAULT_SAMPLE_INTERVAL_S,
    db_container_name: str = DEFAULT_DB_CONTAINER,
    output_dir: Path = DEFAULT_OUTPUT_DIR,
) -> StressTestResult:
    """Orchestrate dual-platform import + metric capture for one tagged run.

    Spawns three tasks via asyncio.gather:
      - Task A: run_import for chess.com
      - Task B: run_import for lichess
      - Task C: metric sampler (docker stats + pg_stat_activity at sample_interval_s)

    Returns a StressTestResult with peak memory, peak connection count, and
    both ImportJob final statuses.

    Raises RuntimeError with a clear message if user_id is not found in the
    dev DB (fast failure path).
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # Fast-fail check: verify the user exists before starting a 20-40 min run.
    await _verify_user_exists(user_id)

    start_epoch = time.monotonic()
    start_iso = _ts_iso_utc()
    print(f"[{start_iso}] Starting stress test: user_id={user_id} tag={output_tag!r}")
    print(f"[{start_iso}]   chess.com username: {chesscom_username!r}")
    print(f"[{start_iso}]   lichess   username: {lichess_username!r}")
    print(f"[{start_iso}]   sample interval:   {sample_interval_s}s")
    print(f"[{start_iso}]   db container:      {db_container_name!r}")
    print(f"[{start_iso}]   output dir:        {output_dir}/")

    # Create import jobs (registers in-memory state; run_import reads from registry).
    chesscom_job_id = create_job(
        user_id=user_id,
        platform="chess.com",
        username=chesscom_username,
    )
    lichess_job_id = create_job(
        user_id=user_id,
        platform="lichess",
        username=lichess_username,
    )

    stop_event = asyncio.Event()

    # Task C: sampler runs until imports finish.
    sampler_task = asyncio.create_task(
        _sample_metrics(
            output_dir=output_dir,
            output_tag=output_tag,
            db_container=db_container_name,
            sample_interval=sample_interval_s,
            stop_event=stop_event,
        )
    )

    # Tasks A and B: run_import never raises; failures land in job.status/error.
    try:
        results = await asyncio.gather(
            run_import(chesscom_job_id),
            run_import(lichess_job_id),
            return_exceptions=True,
        )
    finally:
        # Signal sampler to stop and wait for clean shutdown regardless of outcome.
        stop_event.set()
        try:
            peak_mem_bytes, peak_conn_count = await asyncio.wait_for(sampler_task, timeout=15.0)
        except asyncio.TimeoutError, asyncio.CancelledError:
            sampler_task.cancel()
            peak_mem_bytes = 0
            peak_conn_count = 0

    end_iso = _ts_iso_utc()
    total_s = time.monotonic() - start_epoch

    # Retrieve final job state from the in-memory registry.
    chesscom_job: JobState | None = get_job(chesscom_job_id)
    lichess_job: JobState | None = get_job(lichess_job_id)

    chesscom_status = chesscom_job.status.value if chesscom_job else "unknown"
    lichess_status = lichess_job.status.value if lichess_job else "unknown"
    chesscom_error = chesscom_job.error if chesscom_job else None
    lichess_error = lichess_job.error if lichess_job else None

    # Log any gather-level exceptions (run_import shouldn't raise, but be safe).
    for i, exc in enumerate(results):
        if isinstance(exc, BaseException):
            platform = "chess.com" if i == 0 else "lichess"
            print(f"[{end_iso}] WARNING: {platform} run_import raised: {exc}")

    result = StressTestResult(
        start_iso=start_iso,
        end_iso=end_iso,
        total_duration_s=total_s,
        chesscom_status=chesscom_status,
        lichess_status=lichess_status,
        chesscom_error=chesscom_error,
        lichess_error=lichess_error,
        peak_mem_usage_bytes=peak_mem_bytes,
        peak_connection_count=peak_conn_count,
        output_dir=output_dir,
        output_tag=output_tag,
    )

    _write_summary_json(result)
    _print_summary(result)
    return result


async def _verify_user_exists(user_id: int) -> None:
    """Raise RuntimeError with a clear message if user_id is absent from the dev DB.

    Uses a short-lived connection so failure is fast (< 1s) and the main run
    never starts a 20-40 min import for a nonexistent user.
    """
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    try:
        async with engine.connect() as conn:
            row = await conn.execute(text("SELECT id FROM users WHERE id = :uid"), {"uid": user_id})
            found = row.fetchone()
    finally:
        await engine.dispose()

    if found is None:
        raise RuntimeError(
            f"user_id={user_id} does not exist in the dev database "
            f"({settings.DATABASE_URL}). "
            "Create the user first or use a valid user_id."
        )


def _write_summary_json(result: StressTestResult) -> None:
    """Write the run summary to {output_dir}/{output_tag}-summary.json."""
    summary = {
        "start_iso": result.start_iso,
        "end_iso": result.end_iso,
        "total_duration_s": round(result.total_duration_s, 1),
        "output_tag": result.output_tag,
        "chesscom_status": result.chesscom_status,
        "lichess_status": result.lichess_status,
        "chesscom_error": result.chesscom_error,
        "lichess_error": result.lichess_error,
        "peak_mem_usage_bytes": result.peak_mem_usage_bytes,
        "peak_connection_count": result.peak_connection_count,
    }
    json_path = result.output_dir / f"{result.output_tag}-summary.json"
    json_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"[{result.end_iso}] Summary written: {json_path}")


def _print_summary(result: StressTestResult) -> None:
    """Print a human-readable summary to stdout."""
    peak_mb = result.peak_mem_usage_bytes / (1024**2)
    print()
    print("=" * 60)
    print(f"  Stress test complete: {result.output_tag}")
    print("=" * 60)
    print(f"  Duration              : {result.total_duration_s / 60:.1f} min")
    print(f"  chess.com import      : {result.chesscom_status}")
    if result.chesscom_error:
        print(f"    error               : {result.chesscom_error[:120]}")
    print(f"  lichess import        : {result.lichess_status}")
    if result.lichess_error:
        print(f"    error               : {result.lichess_error[:120]}")
    print(f"  Peak Postgres mem     : {peak_mb:.1f} MB ({result.peak_mem_usage_bytes:,} bytes)")
    print(f"  Peak connection count : {result.peak_connection_count}")
    print(f"  Output dir            : {result.output_dir}/")
    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Phase 95 dual-platform import stress driver. "
            "Runs concurrent chess.com + lichess imports for a FlawChess user, "
            "sampling docker stats and pg_stat_activity at a fixed interval. "
            "Writes {output_dir}/{output_tag}-docker-stats.csv, "
            "{output_tag}-pg-activity.csv, and {output_tag}-summary.json."
        ),
    )
    parser.add_argument(
        "--user-id",
        type=int,
        required=True,
        metavar="INT",
        dest="user_id",
        help="FlawChess internal user PK. Must exist in the dev database.",
    )
    parser.add_argument(
        "--chesscom-username",
        required=True,
        metavar="STR",
        dest="chesscom_username",
        help="chess.com username to import from.",
    )
    parser.add_argument(
        "--lichess-username",
        required=True,
        metavar="STR",
        dest="lichess_username",
        help="Lichess username to import from.",
    )
    parser.add_argument(
        "--output-tag",
        required=True,
        metavar="STR",
        dest="output_tag",
        help=(
            "Label for output files. Use 'pre-copy' for the baseline run "
            "and 'post-copy' for the COPY-converted run."
        ),
    )
    parser.add_argument(
        "--sample-interval",
        type=float,
        default=DEFAULT_SAMPLE_INTERVAL_S,
        metavar="SECONDS",
        dest="sample_interval",
        help=f"Metric sampling cadence in seconds (default: {DEFAULT_SAMPLE_INTERVAL_S}).",
    )
    parser.add_argument(
        "--db-container",
        default=DEFAULT_DB_CONTAINER,
        metavar="STR",
        dest="db_container",
        help=(
            f"Docker container name for the dev Postgres instance "
            f"(default: {DEFAULT_DB_CONTAINER!r})."
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        metavar="PATH",
        dest="output_dir",
        help=f"Directory for output CSVs and summary JSON (default: {DEFAULT_OUTPUT_DIR}).",
    )

    args = parser.parse_args()
    if args.sample_interval <= 0:
        parser.error(f"--sample-interval must be > 0, got {args.sample_interval}")
    return args


async def main() -> None:
    """Parse CLI args and run the stress test."""
    args = parse_args()

    try:
        await run_stress_test(
            user_id=args.user_id,
            chesscom_username=args.chesscom_username,
            lichess_username=args.lichess_username,
            sample_interval_s=args.sample_interval,
            db_container_name=args.db_container,
            output_dir=args.output_dir,
            output_tag=args.output_tag,
        )
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[stress_test] Interrupted by user. Partial CSVs may have been flushed to disk.")
        sys.exit(130)


if __name__ == "__main__":
    asyncio.run(main())
