"""Backfill Stockfish eval into endgame span-entry rows (Phase 78 FILL-01/02/03).

Row-level idempotency only (skip rows where eval_cp OR eval_mate is already
populated). No cross-row hash dedup — endgame span entries are effectively
unique across games and a hash cache lookup costs more than re-evaluating
the rare collision (FILL-02 relaxed, locked per CONTEXT.md D-10).

Three-round runbook (D-07, executed by Plan 78-06):
    Round 1 (dev):       --db dev --user-id <test-user-id> --limit 50  # smoke
    Round 2 (benchmark): --db benchmark                                  # full
                         then operator runs /conv-recov-validation (VAL-01 gate)
    Round 3 (prod):      --db prod                                       # via bin/prod_db_tunnel.sh
                         must complete BEFORE phase merge + deploy

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

The URL for each target comes from the DATABASE_URL_{DEV,BENCHMARK,PROD} env
vars (.env), resolved via app.core.config.db_url_for_target.

Stockfish binary:
    The script invokes app.services.engine, which auto-discovers the binary:
    STOCKFISH_PATH if set, else /usr/local/bin/stockfish (prod Docker), else
    ~/.local/stockfish/sf (bin/install_stockfish.sh dev location), else
    `stockfish` on PATH. So a standard local install needs no env var:

        bin/install_stockfish.sh   # one-time, idempotent
        uv run python scripts/backfill_eval.py --db dev --user-id 13

    Set STOCKFISH_PATH only to point at a binary in a non-standard location.

Usage:
    uv run python scripts/backfill_eval.py --db dev --limit 50
    uv run python scripts/backfill_eval.py --db benchmark
    uv run python scripts/backfill_eval.py --db prod --user-id 1
    uv run python scripts/backfill_eval.py --db prod --dry-run

Parallelism (--workers, default 1):
    The eval phase runs N independent Stockfish processes via EnginePool.
    Default 1 = byte-identical to the legacy singleton path. On a 16 vCPU
    workstation, 10–12 workers is a good upper bound (leave headroom for
    Postgres + the SSH tunnel + OS). Each worker is configured with
    Threads=1, so N×1 scales much better than 1×N for independent positions.

        uv run python scripts/backfill_eval.py --db prod --workers 10

    Do NOT raise --workers on the prod server (4 vCPU / 8 GB) — the import
    path uses the engine module's singleton, and a multi-engine pool there
    would starve the API and Postgres.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import sys
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Sequence

import chess
import chess.pgn
import sentry_sdk
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.sql import Select

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.game import Game  # noqa: E402
from app.models.game_position import GamePosition  # noqa: E402
from app.services import engine as _engine_module  # noqa: E402
from app.services.engine import EnginePool  # noqa: E402

# D-09: COMMIT every 500 evals — at 10 workers × ~70ms/eval that's ~3.5s of work
# per chunk. Each chunk now collapses to one batched UPDATE … FROM (VALUES …)
# round-trip instead of EVAL_BATCH_SIZE individual UPDATEs, so the SSH tunnel to
# prod sees ~1/500th the round-trip overhead. Resume semantics are unchanged: a
# mid-run kill loses at most one chunk's worth of evaluated rows.
EVAL_BATCH_SIZE = 500

# Upstream streaming bound (rows materialized in Python at a time, in game-units).
# The previous code did `(await session.execute(stmt)).all()` for both the span
# and middlegame eval queries, materializing ~2M rows × full PGN string each →
# ~15 GB RSS → OOM-killed on the benchmark DB. We now stream rows from a
# server-side cursor and yield game-batched lists; only one batch is alive in
# Python at a time. 5_000 games per batch = a few thousand entry rows × ~2 KB
# PGN ≈ tens of MB, comfortably below any RAM ceiling on dev/benchmark/prod.
EVAL_GAMES_PER_BATCH = 5_000

# Default to single-worker mode = byte-identical legacy behavior. CLI --workers
# overrides; a 16 vCPU workstation can comfortably run 10–12.
DEFAULT_WORKERS = 1


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _db_url(target: str) -> str:
    """Resolve the asyncpg URL for the chosen --db target.

    Reads the matching DATABASE_URL_{DEV,BENCHMARK,PROD} setting (sourced from
    .env) via db_url_for_target. All targets are reached over localhost
    (dev/benchmark via Docker, prod via the SSH tunnel from
    bin/prod_db_tunnel.sh).
    """
    return db_url_for_target(target)


def _board_at_ply(pgn_text: str, target_ply: int) -> chess.Board | None:
    """Replay PGN to target_ply (0-indexed, pre-push).

    Returns the board state BEFORE the move at that ply — this is the
    state that was classified as the endgame span entry.  Mirrors the
    replay loop in scripts/reclassify_positions.py.

    Returns None if the PGN cannot be parsed or if target_ply is out of range.
    """
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        return None
    if game is None:
        return None
    board = game.board()
    for i, node in enumerate(game.mainline()):
        if i == target_ply:
            return board
        board.push(node.move)
    # target_ply >= number of moves → return final position
    return board


def _boards_at_plies(pgn_text: str, plies: Sequence[int]) -> dict[int, chess.Board]:
    """Replay PGN once, return {ply: board} for all requested plies.

    Same per-ply semantics as _board_at_ply: board state BEFORE the move at
    that ply; ply >= mainline length → final position. Returns an empty dict
    if the PGN cannot be parsed; callers treat missing keys as a skip.

    Used by the backfill eval loop to amortize PGN parsing across all rows
    that share a game_id (a game with one middlegame entry plus several
    endgame span entries used to re-parse its PGN N times).
    """
    if not plies:
        return {}
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        return {}
    if game is None:
        return {}

    plies_set = set(plies)
    captured: dict[int, chess.Board] = {}
    board = game.board()
    for i, node in enumerate(game.mainline()):
        if i in plies_set:
            captured[i] = board.copy()
        board.push(node.move)
    # Any requested ply >= mainline length → final position (after last push).
    for ply in plies_set:
        captured.setdefault(ply, board)
    return captured


def _build_span_entry_stmt(
    user_id: int | None,
    limit: int | None,
) -> Select[tuple[int, int, str]]:
    """Build the span-entry SELECT statement.

    Selects GamePosition rows where:
    1. eval_cp IS NULL AND eval_mate IS NULL  (row-level idempotency, FILL-02)
    2. endgame_class IS NOT NULL              (endgame row)
    3. ply == MIN(ply) for its contiguous-run group (user_id, game_id,
       endgame_class, island_id)

    Each contiguous run of the same endgame_class within a game is treated as
    its own span. If a game enters class=1, switches to class=2, then
    re-enters class=1, both class=1 stretches get an entry eval — not just
    the earliest. Spans of any length (including 1-ply) are included; the
    repository's ENDGAME_PLY_THRESHOLD is intentionally not enforced here.

    Island detection uses the gaps-and-islands trick: within a partition of
    (user_id, game_id, endgame_class), `ply - row_number()` is constant for
    consecutive plies and changes whenever a non-class row breaks the run,
    so it serves as a stable per-run group key.

    Optional filters:
    - user_id: scopes to a single user (--user-id flag)
    - limit: caps result set (--limit flag)
    """
    # Per-class row number, ordered by ply. ply - rn is constant within a
    # contiguous run of the same endgame_class in the same game.
    island_rn = func.row_number().over(
        partition_by=(
            GamePosition.user_id,
            GamePosition.game_id,
            GamePosition.endgame_class,
        ),
        order_by=GamePosition.ply,
    )

    classified = (
        select(
            GamePosition.user_id.label("uid"),
            GamePosition.game_id.label("gid"),
            GamePosition.endgame_class.label("ec"),
            GamePosition.ply.label("ply"),
            (GamePosition.ply - island_rn).label("island_id"),
        )
        .where(GamePosition.endgame_class.isnot(None))
        .subquery("classified")
    )

    span_min = (
        select(
            classified.c.uid,
            classified.c.gid,
            classified.c.ec,
            func.min(classified.c.ply).label("min_ply"),
        )
        .group_by(
            classified.c.uid,
            classified.c.gid,
            classified.c.ec,
            classified.c.island_id,
        )
        .subquery("span_min")
    )

    stmt = (
        select(
            GamePosition.game_id,
            GamePosition.ply,
            Game.pgn,
        )
        .join(Game, Game.id == GamePosition.game_id)
        .join(
            span_min,
            (GamePosition.user_id == span_min.c.uid)
            & (GamePosition.game_id == span_min.c.gid)
            & (GamePosition.endgame_class == span_min.c.ec)
            & (GamePosition.ply == span_min.c.min_ply),
        )
        .where(
            GamePosition.eval_cp.is_(None),
            GamePosition.eval_mate.is_(None),
        )
    )

    if user_id is not None:
        stmt = stmt.where(GamePosition.user_id == user_id)

    stmt = stmt.order_by(GamePosition.game_id, GamePosition.ply)

    if limit is not None:
        stmt = stmt.limit(limit)

    return stmt


def _build_middlegame_entry_stmt(
    user_id: int | None,
    limit: int | None,
) -> Select[tuple[int, int, str]]:
    """Build the middlegame entry SELECT statement (Phase 79 PHASE-FILL-02).

    Selects GamePosition rows where:
    1. eval_cp IS NULL AND eval_mate IS NULL  (row-level idempotency, T-78-17 lichess preserve)
    2. phase = 1                               (middlegame row)
    3. ply == MIN(ply) of phase=1 rows in the same game

    At most one middlegame entry per game. Later phase=1 stretches after an
    endgame are NOT re-evaluated (D-79-08 — mirrors lichess Divider's single
    Division(midGame, endGame) return).

    Returns rows with the same (game_id, ply, pgn) shape as
    _build_span_entry_stmt so the shared eval+write loop processes both
    row sets uniformly.
    """
    midgame_min = (
        select(
            GamePosition.game_id.label("gid"),
            func.min(GamePosition.ply).label("min_ply"),
        )
        .where(GamePosition.phase == 1)
        .group_by(GamePosition.game_id)
        .subquery("midgame_min")
    )

    stmt = (
        select(
            GamePosition.game_id,
            GamePosition.ply,
            Game.pgn,
        )
        .join(Game, Game.id == GamePosition.game_id)
        .join(
            midgame_min,
            (GamePosition.game_id == midgame_min.c.gid)
            & (GamePosition.ply == midgame_min.c.min_ply),
        )
        .where(
            GamePosition.eval_cp.is_(None),
            GamePosition.eval_mate.is_(None),
            GamePosition.phase == 1,
        )
    )

    if user_id is not None:
        stmt = stmt.where(GamePosition.user_id == user_id)

    stmt = stmt.order_by(GamePosition.game_id, GamePosition.ply)

    if limit is not None:
        stmt = stmt.limit(limit)

    return stmt


def _resolve_boards_grouped(
    rows: Sequence[Any],
) -> list[tuple[Any, chess.Board | None]]:
    """Replay each game's PGN once across all of its rows.

    Rows arrive ordered by (game_id, ply); itertools.groupby gives us one
    contiguous block per game so we can hand all of that game's plies to
    `_boards_at_plies` and walk the mainline a single time. A game with one
    middlegame entry plus several endgame span entries used to re-parse its
    PGN N times — now it parses once.

    Returns a list of (row, board_or_None) preserving the input order. None
    means the PGN failed to parse; callers count that as `skipped_no_board`.
    """
    from itertools import groupby

    out: list[tuple[Any, chess.Board | None]] = []
    for _gid, group_iter in groupby(rows, key=lambda r: r.game_id):
        group = list(group_iter)
        plies = [r.ply for r in group]
        boards = _boards_at_plies(group[0].pgn, plies)
        for r in group:
            out.append((r, boards.get(r.ply)))
    return out


def _build_batch_update_sql(batch_size: int) -> str:
    """Render the batched UPDATE … FROM (VALUES …) template for `batch_size` rows.

    One round-trip writes the whole chunk instead of one UPDATE per row.

    The explicit ::integer casts on every VALUES tuple are required because
    asyncpg binds Python ints as untyped parameters and Postgres infers `text`
    for the resulting columns ("operator does not exist: integer = text" on
    the JOIN). Casting every tuple (not just the first) is safe and avoids a
    NULL-on-the-first-row gotcha: eval_cp may be NULL on mate positions and
    eval_mate may be NULL on non-mate positions, so neither column has a
    reliable type-anchor row. Postgres coerces integer to the SMALLINT
    column types on the SET assignment.
    """
    values = ", ".join(
        f"((:gid_{i})::integer, (:ply_{i})::integer, (:cp_{i})::integer, (:mate_{i})::integer)"
        for i in range(batch_size)
    )
    # SEED-035: rows are now keyed by the natural (game_id, ply) pair instead of
    # the dropped surrogate id column. The JOIN matches on both PK components.
    return (
        "UPDATE game_positions gp "
        "SET eval_cp = v.cp, eval_mate = v.mate "
        f"FROM (VALUES {values}) AS v(game_id, ply, cp, mate) "
        "WHERE gp.game_id = v.game_id AND gp.ply = v.ply "
        "AND gp.eval_cp IS NULL AND gp.eval_mate IS NULL"
    )


async def _flush_writes(
    session: AsyncSession,
    writes: list[tuple[int, int, int | None, int | None]],
) -> None:
    """Apply pending (game_id, ply, eval_cp, eval_mate) writes as one batched UPDATE."""
    if not writes:
        return
    sql = _build_batch_update_sql(len(writes))
    params: dict[str, int | None] = {}
    for i, (gid, ply, cp, mate) in enumerate(writes):
        params[f"gid_{i}"] = gid
        params[f"ply_{i}"] = ply
        params[f"cp_{i}"] = cp
        params[f"mate_{i}"] = mate
    # The CAST happens via the column types on game_positions; psycopg/asyncpg
    # binds None as SQL NULL natively, and the UPDATE's column types coerce.
    await session.execute(text(sql), params)


async def _stream_eval_target_rows(
    session_maker: async_sessionmaker[AsyncSession],
    stmt: Select[Any],
    games_per_batch: int,
) -> AsyncIterator[list[Any]]:
    """Stream query rows from a server-side cursor, yielding game-batched lists.

    The result set's ORDER BY (game_id, ply) means rows for one game are
    contiguous, so we can detect a new game by checking game_id and flush
    a batch as soon as we cross `games_per_batch` distinct game_ids. Postgres
    holds the cursor state; only one batch is alive in Python at a time.

    Replaces `(await session.execute(stmt)).all()` which OOM'd at 2M rows
    by materializing the entire result set with full PGN strings up front.
    """
    async with session_maker() as read_session:
        result = await read_session.stream(stmt)
        batch: list[Any] = []
        seen_games: set[int] = set()
        async for row in result:
            gid = row.game_id
            if gid not in seen_games:
                if len(seen_games) >= games_per_batch:
                    yield batch
                    batch = []
                    seen_games = set()
                seen_games.add(gid)
            batch.append(row)
        if batch:
            yield batch


async def _evaluate_and_write_streaming(
    session_maker: async_sessionmaker[AsyncSession],
    stmt: Select[Any],
    *,
    db: str,
    eval_kind: Literal["endgame_span_entry", "middlegame_entry"],
    pool: EnginePool,
    games_per_batch: int = EVAL_GAMES_PER_BATCH,
) -> tuple[int, int, int, int]:
    """Stream rows in game-batches and run the eval+write loop on each batch.

    Returns (rows_seen, evaluated, skipped_no_board, skipped_engine_err).
    Pool, write session, and intra-batch chunking are reused across batches —
    only the upstream row buffer is bounded.
    """
    rows_seen = 0
    evaluated_total = 0
    no_board_total = 0
    engine_err_total = 0
    batch_idx = 0
    async with session_maker() as write_session:
        async for batch in _stream_eval_target_rows(session_maker, stmt, games_per_batch):
            batch_idx += 1
            ev, nb, ee = await _evaluate_and_write_rows(
                batch,
                write_session,
                db=db,
                eval_kind=eval_kind,
                pool=pool,
            )
            rows_seen += len(batch)
            evaluated_total += ev
            no_board_total += nb
            engine_err_total += ee
            _log(
                f"  [{eval_kind}] batch {batch_idx} done "
                f"({len(batch)} rows; cumulative seen={rows_seen}, "
                f"evaluated={evaluated_total}, "
                f"skipped_no_board={no_board_total}, "
                f"skipped_engine_err={engine_err_total})"
            )
    return rows_seen, evaluated_total, no_board_total, engine_err_total


async def _evaluate_and_write_rows(
    rows: Sequence[Any],
    session: AsyncSession,
    *,
    db: str,
    eval_kind: Literal["endgame_span_entry", "middlegame_entry"],
    pool: EnginePool,
) -> tuple[int, int, int]:
    """Evaluate and write eval_cp / eval_mate for a batch of rows.

    Shared between the endgame-span and middlegame-entry eval passes.
    eval_kind is set on Sentry as a tag so the two row sets are filterable.

    Concurrency: each chunk fan-outs `EVAL_BATCH_SIZE` evaluate() calls via
    asyncio.gather; the EnginePool's internal queue caps in-flight analyses
    at `pool.size`, so a 1-worker pool serializes (legacy behavior) while a
    10-worker pool gets ~10× throughput. Writes are deferred to a single
    batched UPDATE per chunk → one round-trip instead of EVAL_BATCH_SIZE.

    Returns (evaluated_count, skipped_no_board, skipped_engine_err).
    """
    resolved = _resolve_boards_grouped(rows)
    skipped_no_board = 0
    eval_targets: list[tuple[Any, chess.Board]] = []
    for row, board in resolved:
        if board is None:
            skipped_no_board += 1
            _log(f"WARNING: could not replay PGN for game_id={row.game_id} ply={row.ply}; skipping")
            continue
        eval_targets.append((row, board))

    evaluated = 0
    skipped_engine_err = 0
    total = len(eval_targets)

    for chunk_start in range(0, total, EVAL_BATCH_SIZE):
        chunk = eval_targets[chunk_start : chunk_start + EVAL_BATCH_SIZE]
        results = await asyncio.gather(*(pool.evaluate(b) for _, b in chunk))

        writes: list[tuple[int, int, int | None, int | None]] = []
        for (row, _board), (eval_cp, eval_mate) in zip(chunk, results):
            if eval_cp is None and eval_mate is None:
                skipped_engine_err += 1
                sentry_sdk.set_context(
                    "backfill_eval",
                    {
                        "game_id": row.game_id,
                        "ply": row.ply,
                        "db_target": db,
                    },
                )
                sentry_sdk.set_tag("source", "backfill")
                sentry_sdk.set_tag("eval_kind", eval_kind)
                sentry_sdk.capture_message(
                    "backfill engine returned (None, None) tuple", level="warning"
                )
                continue
            writes.append((row.game_id, row.ply, eval_cp, eval_mate))
            evaluated += 1

        await _flush_writes(session, writes)
        await session.commit()
        _log(
            f"  [{eval_kind}] committed {min(chunk_start + len(chunk), total)}/{total} rows "
            f"(evaluated={evaluated}, "
            f"skipped_no_board={skipped_no_board}, "
            f"skipped_engine_err={skipped_engine_err})"
        )

    return evaluated, skipped_no_board, skipped_engine_err


async def run_backfill(
    *,
    db: str,
    user_id: int | None,
    dry_run: bool,
    limit: int | None,
    workers: int = DEFAULT_WORKERS,
    timeout: float | None = None,
    _session_maker: async_sessionmaker[AsyncSession] | None = None,
    _pool: EnginePool | None = None,
) -> None:
    """FILL-01/02/03 backfill driver. Public callable for testability.

    Idempotency (FILL-02 relaxed per D-10): row-level WHERE eval_cp IS NULL
    AND eval_mate IS NULL.  No cross-row hash dedup.

    Resume: same WHERE clause naturally picks up uncommitted rows on the
    next run after a mid-run kill (D-09 COMMIT-every-100 bounds data loss).

    main() parses argv and calls this function with keyword-only args.

    workers: size of the Stockfish EnginePool. Default 1 = legacy serial
    behavior. Raise on hosts with spare CPU/RAM (e.g. 10 on a 16 vCPU box).
    Do NOT raise on the prod server — the live import path uses the engine
    module's singleton and would compete for CPU.

    timeout: per-eval timeout in seconds. None = use engine module default
    (_TIMEOUT_S = 2.0). Raise to recover positions that consistently time out
    at depth 15 (typically dense early-endgame positions with queens + rooks
    + minor pieces + many pawns). The override mutates the engine module's
    _TIMEOUT_S global before the pool is started; pool workers read the
    global at every evaluate() call so the override applies to all workers.

    _session_maker / _pool: internal test hooks. Production callers omit both;
    the production path builds its own engine from _db_url(db) and starts an
    EnginePool of `workers` Stockfish processes.
    """
    if timeout is not None:
        _engine_module._TIMEOUT_S = timeout
        _log(f"Engine per-eval timeout overridden: {timeout}s (default 2.0s)")

    dispose_engine = _session_maker is None
    if _session_maker is None:
        url = _db_url(db)
        async_engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(async_engine, expire_on_commit=False)
    else:
        async_engine = None  # type: ignore[assignment]  # not created here; nothing to dispose
        session_maker = _session_maker

    # SEED-055: the PHASE-FILL-01 phase backfill that once lived here computed
    # `phase` from the piece_count / backrank_sparse / mixedness columns, which
    # have now been dropped. `phase` is populated by the import path going forward
    # (zobrist.assign_game_phases) and was already backfilled across all
    # environments, so this driver no longer touches `phase`.

    # Phase 78: endgame span-entry eval pass.
    # Phase 79 PHASE-FILL-02: middlegame entry eval pass.
    # Both passes stream rows from server-side cursors in game-batches; the
    # previous .all()-based path materialized the full result set (with PGN
    # per row) and OOM'd on the benchmark DB at ~2M rows / ~15 GB RSS.
    span_stmt = _build_span_entry_stmt(user_id, limit)
    midgame_stmt = _build_middlegame_entry_stmt(user_id, limit)

    if dry_run:
        async with session_maker() as count_session:
            span_count = (
                await count_session.execute(select(func.count()).select_from(span_stmt.subquery()))
            ).scalar_one()
            midgame_count = (
                await count_session.execute(
                    select(func.count()).select_from(midgame_stmt.subquery())
                )
            ).scalar_one()
        _log(f"Endgame span-entry eval: {span_count} rows queued")
        _log(f"Middlegame entry eval: {midgame_count} rows queued")
        _log(f"--dry-run: would evaluate {span_count} endgame span-entry rows")
        _log(f"--dry-run: would evaluate {midgame_count} middlegame entry rows")
        _log("--dry-run: exiting without starting engine or writing")
        if dispose_engine and async_engine is not None:
            await async_engine.dispose()
        return

    _log(f"Endgame span-entry eval: streaming rows in batches of {EVAL_GAMES_PER_BATCH} games")
    _log(f"Middlegame entry eval: streaming rows in batches of {EVAL_GAMES_PER_BATCH} games")

    # Eval + write phase: spin up an EnginePool of `workers` Stockfish processes.
    # _pool is a test hook; production builds its own from `workers`. We start
    # the pool unconditionally (cheap — N process spawns) since streaming
    # defers the "are there any rows?" question to the cursor.
    dispose_pool = _pool is None
    if _pool is None:
        pool = EnginePool(workers)
        await pool.start()
        _log(f"EnginePool started with {workers} worker(s).")
    else:
        pool = _pool

    try:
        (
            endgame_seen,
            endgame_evaluated,
            endgame_no_board,
            endgame_engine_err,
        ) = await _evaluate_and_write_streaming(
            session_maker,
            span_stmt,
            db=db,
            eval_kind="endgame_span_entry",
            pool=pool,
        )
        if endgame_seen:
            _log(
                f"Endgame span-entry eval complete: "
                f"rows={endgame_seen}, "
                f"evaluated={endgame_evaluated}, "
                f"skipped_no_board={endgame_no_board}, "
                f"skipped_engine_err={endgame_engine_err}"
            )
        else:
            _log("No endgame span-entry rows to evaluate.")

        (
            mid_seen,
            mid_evaluated,
            mid_no_board,
            mid_engine_err,
        ) = await _evaluate_and_write_streaming(
            session_maker,
            midgame_stmt,
            db=db,
            eval_kind="middlegame_entry",
            pool=pool,
        )
        if mid_seen:
            _log(
                f"Middlegame entry eval complete: "
                f"rows={mid_seen}, "
                f"evaluated={mid_evaluated}, "
                f"skipped_no_board={mid_no_board}, "
                f"skipped_engine_err={mid_engine_err}"
            )
        else:
            _log("No middlegame entry rows to evaluate.")
    finally:
        if dispose_pool:
            await pool.stop()

    # VACUUM ANALYZE outside a transaction (cannot run inside transaction block).
    # Skipped when using an injected session maker (test mode: VACUUM not meaningful
    # inside a rolled-back transaction and the engine reference is not available).
    if dispose_engine and async_engine is not None:
        _log("Running VACUUM ANALYZE game_positions...")
        async with async_engine.connect() as conn:
            await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(text("VACUUM ANALYZE game_positions"))
        _log("VACUUM ANALYZE complete.")
        await async_engine.dispose()


def parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments (D-08)."""
    parser = argparse.ArgumentParser(
        description="Backfill Stockfish eval into endgame span-entry rows (Phase 78 FILL-01/02/03)."
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help=(
            "Database target.  dev=localhost:5432, benchmark=localhost:5433, "
            "prod=localhost:15432 (via bin/prod_db_tunnel.sh).  REQUIRED (T-78-12)."
        ),
    )
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        dest="user_id",
        metavar="N",
        help="Limit backfill to a single user ID.  Default: all users.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Count rows and print count; do not start engine or write anything.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Cap evaluations at N rows.  Useful for smoke checks and staging rounds.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        metavar="N",
        help=(
            f"Number of parallel Stockfish workers (default {DEFAULT_WORKERS}). "
            "Each worker is its own UCI process configured Threads=1, so N×1 "
            "scales much better than 1×N for independent positions. On a 16 vCPU "
            "workstation, 10–12 is a good upper bound. Do NOT raise this on the "
            "prod server (4 vCPU / 8 GB) — the live import path uses the engine "
            "module's singleton."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        metavar="SECONDS",
        help=(
            "Override the engine's per-eval timeout (default 2.0s in "
            "app/services/engine.py:_TIMEOUT_S). Raise to recover positions "
            "that time out at depth 15 — typically dense early-endgame "
            "positions with queens + rooks + minor pieces + many pawns. "
            "Applies to every pool worker."
        ),
    )
    args = parser.parse_args()
    if args.workers < 1:
        parser.error(f"--workers must be >= 1, got {args.workers}")
    if args.timeout is not None and args.timeout <= 0:
        parser.error(f"--timeout must be > 0, got {args.timeout}")
    return args


async def main() -> None:
    """Entry point: parse CLI args, init Sentry, run backfill."""
    args = parse_args()

    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    _log(
        f"Starting backfill: db={args.db} user_id={args.user_id} "
        f"dry_run={args.dry_run} limit={args.limit} workers={args.workers} "
        f"timeout={args.timeout}"
    )
    await run_backfill(
        db=args.db,
        user_id=args.user_id,
        dry_run=args.dry_run,
        limit=args.limit,
        workers=args.workers,
        timeout=args.timeout,
    )
    _log("Done.")


if __name__ == "__main__":
    asyncio.run(main())
