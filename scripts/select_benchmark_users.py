"""Phase 69 INGEST-01/INGEST-02: Streaming Lichess PGN dump scan -> per-cell username pool.

Scans a single Lichess monthly dump (.pgn.zst) without python-chess game-tree parsing.
For each game, extracts headers (White, Black, WhiteElo, BlackElo, TimeControl, Variant)
and a substring [%eval check on the moves line. Aggregates per-player stats indexed
by TC bucket, then produces one cell entry per (user, TC) pair where the user meets
the eval threshold within that TC. Persists the per-cell username pools to
benchmark_selected_users in the benchmark database, keyed compound on
(lichess_username, tc_bucket) so one user may occupy multiple cells.

The 5 rating buckets (REQUIREMENTS.md INGEST-02, 400-wide):
  800: 800-1199, 1200: 1200-1599, 1600: 1600-1999, 2000: 2000-2399, 2400: 2400+
The 4 TC buckets (canonical FlawChess rule):
  bullet < 180s, blitz 180-599s, rapid 600-1800s, classical > 1800s or daily

Per-TC eligibility: a user qualifies for the (rating, TC) cell if they have at
least K (default 5) eval-bearing games in that TC during the snapshot month
(D-12). Their ELO bucket within that TC is derived from the per-TC median Elo,
not a global median across all their TCs (which previously mis-bucketed
multi-TC specialists).

Players with per-TC median Elo < 800 are excluded from that TC's cell.

Centipawn convention: signed-from-white-POV, in centipawns. python-chess parses [%eval]
PGN comments via node.eval(); see tests/test_benchmark_ingest.py::test_centipawn_convention.

Note: Phase 69 selection uses 400-wide rating buckets per REQUIREMENTS.md. The existing
/benchmarks skill uses 500-wide buckets; that mismatch is reconciled in Phase 73 (BENCH-*).

Cheat contamination: D-01 -- no cheat-filtering in Phase 69. Residual upward bias in
2000+ buckets is documented; Phase 70 gate (Pawn/Rook/Minor) is the safety net.

INFRA-02: the benchmark_selected_users table is created via
Base.metadata.create_all() on first invocation; it is NOT in the canonical Alembic
chain (which serves dev/prod/test/benchmark uniformly).

Usage:
    uv run python scripts/select_benchmark_users.py \
        --dump-path /path/to/lichess_db_standard_rated_2026-03.pgn.zst \
        --dump-month 2026-03 \
        --per-cell 500 \
        --eval-threshold 10 \
        --eval-threshold-classical 3 \
        --db-url postgresql+asyncpg://flawchess_benchmark:flawchess_benchmark@localhost:5433/flawchess_benchmark \
        2>&1 | tee logs/benchmark-select-2026-03-$(date +%Y-%m-%d).log

Eval-threshold strategy:
    --eval-threshold sets the floor for bullet/blitz/rapid: a user qualifies
    for a (rating, TC) cell only if they have >= that many eval-bearing games
    in that TC during the snapshot month. K=10 gives a stable per-TC median
    Elo from a single month of fast-game data.

    --eval-threshold-classical overrides the floor for classical only.
    Classical games are rare in a single monthly dump (relatively few players
    log >= 10 classical games per month at any rating), but classical players
    typically analyze most of their games. K=1 for classical pulls in real
    classical players who barely cleared the surface in March; the 36-month
    per-TC window at ingest time still pulls plenty of analyzed games for
    each. Without the override, classical-2400 caps out around 30-60 users
    (vs ~1000 for the bullet/blitz/rapid 2400 cells).

    If --eval-threshold-classical is omitted, classical uses the same value
    as --eval-threshold (back-compat with one-flag invocations).
"""

from __future__ import annotations

import argparse
import asyncio
import io
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, TextIO, TypedDict, cast

# Ensure project root is on sys.path so `app.*` imports work when running as a script
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import sentry_sdk
import zstandard as zstd
from sqlalchemy import Table, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import settings
from app.models.benchmark_selected_user import BenchmarkSelectedUser

# Tunables
DEFAULT_PER_CELL = 500
DEFAULT_EVAL_THRESHOLD = 10  # D-12: K=5
RATING_BUCKETS = (800, 1200, 1600, 2000, 2400)  # REQUIREMENTS.md INGEST-02
TC_BUCKETS = ("bullet", "blitz", "rapid", "classical")
PROGRESS_LOG_INTERVAL = 1_000_000  # log every x games
TC_INCREMENT_WEIGHT = 40  # canonical estimated_seconds = base + 40 * increment
EVAL_GAME_COUNT_CAP = 32_000  # SmallInteger upper bound (signed 16-bit max 32_767)


class PlayerStats(TypedDict):
    """Per-player aggregate over snapshot-month games, indexed by TC bucket.

    elos_by_tc: TC bucket -> list of Elo at game time for that bucket.
    eval_count_by_tc: TC bucket -> count of eval-bearing games in that bucket.

    Indexing per-TC (vs flat lists across all TCs) lets the selector evaluate
    eligibility and median Elo per TC, so a multi-TC specialist (e.g.
    1900-blitz / 2200-classical) lands in the correct ELO bucket within each
    TC instead of a single conflated median.
    """

    elos_by_tc: dict[str, list[int]]
    eval_count_by_tc: dict[str, int]


def _log(msg: str = "") -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _parse_elo(s: str) -> int | None:
    try:
        return int(s)
    except ValueError, TypeError:
        return None


def compute_tc_bucket(time_control: str) -> str | None:
    """Return 'bullet'|'blitz'|'rapid'|'classical' or None for invalid/correspondence.

    Mirrors app/services/normalization.py::parse_time_control. Lichess TimeControl
    header is '<base>+<inc>' for clock games or '-' for correspondence/daily.
    Estimated seconds = base + 40 * increment.

    Correspondence games ('-') are excluded from selection (return None):
      1. Lichess `perfType=classical` does not include correspondence games at
         ingest time, so a correspondence-only user selected as 'classical' would
         return zero games on import.
      2. The games-table normalizer also returns None for '-', so any
         correspondence games ingested would be filtered out of the games table.
      3. Correspondence allows external help and days of thinking time, which
         makes position-quality and time-pressure metrics meaningless.
    """
    if not time_control or time_control == "-":
        return None
    try:
        if "+" in time_control:
            base_str, inc_str = time_control.split("+", 1)
            base = int(base_str)
            inc = int(inc_str)
        else:
            base = int(time_control)
            inc = 0
    except ValueError, AttributeError:
        return None
    est = base + TC_INCREMENT_WEIGHT * inc
    if est < 180:
        return "bullet"
    if est < 600:
        return "blitz"
    if est <= 1800:
        return "rapid"
    return "classical"


class GameRecord(TypedDict):
    """One game's headers + has_eval flag from streaming PGN scan."""

    white: str
    black: str
    white_elo: int | None
    black_elo: int | None
    time_control: str
    has_eval: bool


def _emit_record(headers: dict[str, str], has_eval: bool) -> GameRecord | None:
    """Build a GameRecord from accumulated headers; filter to Standard variant."""
    if headers.get("Variant", "Standard") != "Standard":
        return None
    return GameRecord(
        white=headers.get("White", ""),
        black=headers.get("Black", ""),
        white_elo=_parse_elo(headers.get("WhiteElo", "?")),
        black_elo=_parse_elo(headers.get("BlackElo", "?")),
        time_control=headers.get("TimeControl", ""),
        has_eval=has_eval,
    )


def parse_pgn_stream(text_stream: TextIO) -> Iterator[GameRecord]:
    """Yield one record per Standard-variant game from a decompressed PGN text stream.

    Header-only parse -- no python-chess game-tree parsing (INGEST-01).
    Yields: {white, black, white_elo, black_elo, time_control, has_eval}.
    """
    headers: dict[str, str] = {}
    has_eval = False
    in_moves = False

    for raw_line in text_stream:
        line = raw_line.rstrip("\n").rstrip("\r")

        if line.startswith("["):
            # Header line: [Key "Value"]
            try:
                inner = line[1:-1] if line.endswith("]") else line[1:]
                space_idx = inner.index(" ")
                key = inner[:space_idx]
                value_part = inner[space_idx + 1 :]
                value = value_part.strip().strip('"')
                headers[key] = value
            except ValueError:
                # Malformed header -- skip
                pass
            in_moves = False
            continue

        if line == "":
            # Blank line -- boundary between header block, moves block, and games
            if in_moves and headers:
                # End of game -- emit
                rec = _emit_record(headers, has_eval)
                if rec is not None:
                    yield rec
                headers = {}
                has_eval = False
                in_moves = False
            continue

        # Non-header, non-blank -> moves line
        in_moves = True
        if "%eval" in line:
            has_eval = True

    # Emit trailing game if file does not end with a blank line
    if headers and in_moves:
        rec = _emit_record(headers, has_eval)
        if rec is not None:
            yield rec


def _rating_bucket(median_elo: int) -> int | None:
    """Assign median Elo to a 400-wide bucket; None if < 800."""
    if median_elo < 800:
        return None
    if median_elo < 1200:
        return 800
    if median_elo < 1600:
        return 1200
    if median_elo < 2000:
        return 1600
    if median_elo < 2400:
        return 2000
    return 2400


def bucket_players(
    player_stats: dict[str, PlayerStats] | dict[str, dict],
    eval_threshold: int | dict[str, int],
) -> dict[tuple[int, str], list[str]]:
    """Bucket players into (rating_bucket, tc_bucket) cells with per-TC eligibility.

    Each user can produce up to 4 entries (one per TC where they have
    >= the TC's eval threshold eval-bearing games). The user's ELO bucket
    within a TC is derived from the per-TC median Elo.

    player_stats[username] = {"elos_by_tc": {tc: [int]}, "eval_count_by_tc": {tc: int}}
    eval_threshold: int (applies to all TCs) or dict[tc -> int] (per-TC override).
        Classical games are rare in a single monthly dump, but classical
        players analyze frequently — at ingest time the 36-month per-TC
        window pulls plenty of eval-bearing games regardless of selection-
        time threshold. So a typical config is high-K for bullet/blitz/rapid,
        low-K for classical.
    Returns: {(rating_bucket, tc_bucket): [usernames]}
    Excludes (per-TC): eval_count_by_tc[tc] < threshold_by_tc[tc]; median Elo in TC < 800.
    """
    if isinstance(eval_threshold, int):
        threshold_by_tc: dict[str, int] = {tc: eval_threshold for tc in TC_BUCKETS}
    else:
        threshold_by_tc = eval_threshold

    out: dict[tuple[int, str], list[str]] = defaultdict(list)
    for username, stats in player_stats.items():
        elos_by_tc = stats["elos_by_tc"]
        eval_count_by_tc = stats["eval_count_by_tc"]
        for tc, elos in elos_by_tc.items():
            if not elos:
                continue
            tc_threshold = threshold_by_tc.get(tc, 0)
            if eval_count_by_tc.get(tc, 0) < tc_threshold:
                continue
            sorted_elos = sorted(elos)
            median_elo_in_tc = sorted_elos[len(sorted_elos) // 2]
            rb = _rating_bucket(median_elo_in_tc)
            if rb is None:
                continue
            out[(rb, tc)].append(username)
    return out


def _new_player_stats() -> PlayerStats:
    return PlayerStats(elos_by_tc=defaultdict(list), eval_count_by_tc=defaultdict(int))


def scan_dump_for_players(dump_path: str) -> dict[str, PlayerStats]:
    """Stream the .zst dump and aggregate per-player, per-TC snapshot-month stats.

    Returns: {username: {"elos_by_tc": {tc: [int]}, "eval_count_by_tc": {tc: int}}}
    Players appear under both colors they played; per-game side-bucketing for
    analytics happens at query time over games.white_rating / games.black_rating.
    """
    player_stats: dict[str, PlayerStats] = defaultdict(_new_player_stats)
    games_seen = 0

    dctx = zstd.ZstdDecompressor()
    with open(dump_path, "rb") as fh:
        with dctx.stream_reader(fh) as reader:
            text_stream = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
            for record in parse_pgn_stream(text_stream):
                games_seen += 1
                if games_seen % PROGRESS_LOG_INTERVAL == 0:
                    _log(f"  scanned {games_seen:,} games; {len(player_stats):,} unique players")

                tc = compute_tc_bucket(record["time_control"])
                if tc is None:
                    continue

                # Pull both sides explicitly (TypedDict keys are literal-typed)
                sides: tuple[tuple[str, int | None], ...] = (
                    (record["white"], record["white_elo"]),
                    (record["black"], record["black_elo"]),
                )
                for username, elo in sides:
                    if not username or elo is None:
                        continue
                    stats = player_stats[username]
                    stats["elos_by_tc"][tc].append(elo)
                    if record["has_eval"]:
                        stats["eval_count_by_tc"][tc] = stats["eval_count_by_tc"].get(tc, 0) + 1

    _log(f"Scan complete: {games_seen:,} Standard games, {len(player_stats):,} unique players")
    return player_stats


async def persist_selection(
    db_url: str,
    cell_to_users: dict[tuple[int, str], list[str]],
    per_cell: int,
    median_elos_by_tc: dict[tuple[str, str], int],
    eval_counts_by_tc: dict[tuple[str, str], int],
    dump_month: str,
) -> None:
    """Create benchmark_selected_users (if not exists) and insert per-cell up to N usernames.

    median_elos_by_tc / eval_counts_by_tc are keyed (username, tc_bucket): one user
    in multiple TCs has one entry per TC. The compound (username, tc_bucket) unique
    constraint on the table mirrors this — re-runs are idempotent per (user, TC).
    """
    engine = create_async_engine(db_url, echo=False)

    # Create the benchmark_selected_users table on first invocation (INFRA-02:
    # benchmark-only tables are not in the canonical Alembic chain). We pass the
    # specific Table object via metadata.create_all(tables=[...]) so unrelated
    # canonical tables (already created by Alembic) are not touched.
    # __table__ is typed as FromClause by SQLAlchemy stubs; cast to Table for ty.
    bench_table = cast(Table, BenchmarkSelectedUser.__table__)
    async with engine.begin() as conn:
        await conn.run_sync(
            lambda sync_conn: BenchmarkSelectedUser.metadata.create_all(
                sync_conn, tables=[bench_table], checkfirst=True
            )
        )

    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    inserted = 0
    skipped_dupes = 0
    rng = random.Random(42)  # deterministic for reproducibility

    async with session_maker() as session:
        # Fetch existing (username, tc_bucket) pairs so re-runs are idempotent
        # per-cell. The compound dedup matches the new compound unique constraint;
        # a global username-only set would silently suppress multi-cell membership.
        result = await session.execute(
            select(
                BenchmarkSelectedUser.lichess_username,
                BenchmarkSelectedUser.tc_bucket,
            )
        )
        existing: set[tuple[str, str]] = {(row[0], row[1]) for row in result.all()}

        for (rating_bucket, tc_bucket), usernames in sorted(cell_to_users.items()):
            shuffled = list(usernames)
            rng.shuffle(shuffled)
            chosen = shuffled[:per_cell]
            _log(
                f"  cell ({rating_bucket}, {tc_bucket}): {len(usernames):,} candidates -> "
                f"selecting up to {per_cell} -> {len(chosen)}"
            )
            for username in chosen:
                key = (username, tc_bucket)
                if key in existing:
                    skipped_dupes += 1
                    continue
                session.add(
                    BenchmarkSelectedUser(
                        lichess_username=username,
                        rating_bucket=rating_bucket,
                        tc_bucket=tc_bucket,
                        median_elo=median_elos_by_tc[key],
                        eval_game_count=min(eval_counts_by_tc[key], EVAL_GAME_COUNT_CAP),
                        dump_month=dump_month,
                    )
                )
                existing.add(key)
                inserted += 1
        await session.commit()

    await engine.dispose()
    _log(f"Persistence complete: inserted {inserted:,}, skipped (already in DB) {skipped_dupes:,}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Phase 69 INGEST-01/INGEST-02: streaming Lichess dump scan -> per-cell username pool."
        )
    )
    parser.add_argument(
        "--dump-path",
        required=True,
        help="Path to lichess_db_standard_rated_YYYY-MM.pgn.zst",
    )
    parser.add_argument("--dump-month", required=True, help='Snapshot month, e.g. "2026-02"')
    parser.add_argument(
        "--per-cell",
        type=int,
        default=DEFAULT_PER_CELL,
        help="Max usernames to retain per cell",
    )
    parser.add_argument(
        "--eval-threshold",
        type=int,
        default=DEFAULT_EVAL_THRESHOLD,
        help=(
            "Min eval-bearing snapshot-month games per (user, TC) (D-12). "
            "Applies to bullet/blitz/rapid; classical can be overridden via "
            "--eval-threshold-classical."
        ),
    )
    parser.add_argument(
        "--eval-threshold-classical",
        type=int,
        default=None,
        help=(
            "Per-TC override for classical. Defaults to --eval-threshold if "
            "not set. Lower than the others is reasonable: classical is rare "
            "in a monthly dump, but classical players analyze frequently and "
            "the 36-month ingest window pulls plenty of analyzed games."
        ),
    )
    parser.add_argument(
        "--db-url",
        required=True,
        help=("Benchmark DB URL (postgresql+asyncpg://...:5433/flawchess_benchmark)"),
    )
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    classical_threshold = (
        args.eval_threshold_classical
        if args.eval_threshold_classical is not None
        else args.eval_threshold
    )
    threshold_by_tc: dict[str, int] = {
        "bullet": args.eval_threshold,
        "blitz": args.eval_threshold,
        "rapid": args.eval_threshold,
        "classical": classical_threshold,
    }

    _log(
        f"Phase 69 selection scan starting: dump={args.dump_path}, "
        f"month={args.dump_month}, per_cell={args.per_cell}, "
        f"eval_threshold={threshold_by_tc}"
    )

    # Step 1: Stream the dump
    player_stats = scan_dump_for_players(args.dump_path)

    # Step 2: Cache per-(user, TC) median elo + eval count for persistence
    median_elos_by_tc: dict[tuple[str, str], int] = {}
    eval_counts_by_tc: dict[tuple[str, str], int] = {}
    for username, stats in player_stats.items():
        for tc, elos in stats["elos_by_tc"].items():
            if not elos:
                continue
            sorted_elos = sorted(elos)
            median_elos_by_tc[(username, tc)] = sorted_elos[len(sorted_elos) // 2]
            eval_counts_by_tc[(username, tc)] = stats["eval_count_by_tc"].get(tc, 0)

    # Step 3: Bucket
    cell_to_users = bucket_players(player_stats, eval_threshold=threshold_by_tc)
    total_qualifying = sum(len(v) for v in cell_to_users.values())
    _log(
        f"Bucketing complete: {total_qualifying:,} qualifying (user, TC) pairs across "
        f"{len(cell_to_users)} cells"
    )

    # Step 4: Persist
    await persist_selection(
        db_url=args.db_url,
        cell_to_users=cell_to_users,
        per_cell=args.per_cell,
        median_elos_by_tc=median_elos_by_tc,
        eval_counts_by_tc=eval_counts_by_tc,
        dump_month=args.dump_month,
    )


if __name__ == "__main__":
    asyncio.run(main())
