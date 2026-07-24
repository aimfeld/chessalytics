"""Backfill engine best_move + pv at flaw plies for stored games (SEED-054).

Why this script exists
----------------------
The Flaw card / Library Game card render a blue "better alternative" arrow from
`game_positions[flaw_ply].best_move` — the engine's best move FROM the pre-blunder
decision board. The live drain (pre-SEED-054) only ever engine-evaluated
`flaw_ply + 1` (the opponent's reply), which left two holes in already-stored games:

- **lichess-eval games** (`lichess_evals_at IS NOT NULL`): `best_move` AND `pv` are
  NULL at `flaw_ply` (lichess supplies %eval but no best_move/no PV) — the arrow
  silently doesn't render.
- **engine-analyzed games** (chess.com etc., `lichess_evals_at IS NULL`): `best_move`
  is already set at every ply (the engine ran on all of them), but `pv` is NULL at
  `flaw_ply` — only `flaw_ply + 1`'s refutation pv was written (D-117-02). The arrow
  works there; the missing piece is the ideal-continuation `pv[flaw_ply]`.

SEED-054 fixes the drain to also evaluate `flaw_ply` going forward; this script
backfills BOTH holes for games already stored. It runs from a local machine targeting
prod over the SSH tunnel and writes the columns IN PLACE — it never touches the
completion markers (`full_evals_completed_at` / `full_pv_completed_at`), so games
never drop out of the Library / stats analyzed-gate mid-run (the decisive reason for a
dedicated script over a worker re-enqueue — see SEED-054).

Scope is "already-analyzed games" by construction: it only touches positions that have
`game_flaws` rows, which exist only after a full drain tick. So the engine compute was
already spent; this run merely completes the best_move/pv columns on those games. No
guest-account filter — a guest who ran on-demand "Analyze" on a lichess game hit the
same broken arrow, so they should get the fix too.

What it writes
--------------
For each game position at a flaw ply or flaw+1, the engine runs a 1M-node search and
the script writes, per row, ONLY the column(s) that were actually NULL:
- best_move (the better alternative / refutation move) — when it was NULL and the
  engine returns one.
- pv (the principal-variation line) — when it was NULL and the engine returns one.
- NEVER eval_cp / eval_mate: a lichess %eval or a prior engine eval at this ply is
  authoritative and preserved (same is_lichess_eval_game discipline as
  eval_drain._apply_full_eval_results). Writing only the originally-NULL column means
  an engine game's existing best_move is never clobbered by a (non-deterministic) fresh
  search — only its missing pv is filled.

The write keying is identical to the live drain by construction: this script reuses
`eval_drain._batch_update_best_move_rows` and `eval_drain._batch_update_pv_rows`.

Idempotent / resumable
----------------------
Selection is gated on `best_move IS NULL OR pv IS NULL`, so a dropped SSH tunnel or
Ctrl-C → just re-run; filled positions drop out of the predicate. This subsumes the
SEED-043 cohort (never-reprocessed lichess games, NULL at both flaw plies), the
SEED-054 lichess keying gap (best_move NULL at flaw_ply), AND the engine-game pv gap
(best_move set, pv NULL at flaw_ply) in one pass.

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

Stockfish binary: auto-discovered by app.services.engine (STOCKFISH_PATH, else
/usr/local/bin/stockfish, else ~/.local/stockfish/sf, else `stockfish` on PATH).

Usage:
    # Size it first (tunnel up):
    uv run python scripts/backfill_best_move_pv.py --db prod --dry-run

    # Smoke on dev:
    uv run python scripts/backfill_best_move_pv.py --db dev --limit 50 --workers 4

    # Scope to a single user (--user-id) — handy to size/verify one account before
    # the full prod pass (e.g. user 13):
    uv run python scripts/backfill_best_move_pv.py --db prod --user-id 13 --dry-run
    uv run python scripts/backfill_best_move_pv.py --db prod --user-id 13 --workers 10

    # Full prod backfill from the local machine (zero prod compute):
    bin/prod_db_tunnel.sh
    uv run python scripts/backfill_best_move_pv.py --db prod --workers 10

Parallelism (--workers, default 1):
    Runs N independent Stockfish processes (Threads=1 each) via EnginePool. On a
    16 vCPU workstation, 10-12 is a good upper bound (leave headroom for the SSH
    tunnel + OS). The engine runs on the LOCAL machine → zero prod compute impact,
    so there is no prod 4g-container constraint to respect here. Do NOT run this
    script ON the prod server with a high --workers.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import sys
from collections.abc import AsyncIterator, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import chess
import chess.pgn
import sentry_sdk
from sqlalchemy import exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.sql import Select

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.game import Game  # noqa: E402
from app.models.game_flaw import GameFlaw  # noqa: E402
from app.models.game_position import GamePosition  # noqa: E402

# Joining Game forces SQLAlchemy to configure the mapper chain, and User in turn
# declares a relationship to OAuthAccount, so OAuthAccount must be imported/registered
# or mapper configuration fails at query time (pattern from scripts/backfill_flaws.py).
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.services import engine as _engine_module  # noqa: E402
from app.services.engine import EnginePool  # noqa: E402

# Reuse the live drain's batched write helpers so the (game_id, ply) keying for
# best_move / pv is identical to the in-process drain by construction (SEED-054).
from app.services.eval_apply import (  # noqa: E402
    _batch_update_best_move_rows,
    _batch_update_pv_rows,
)

# Commit cadence in game-units. Each game's writes collapse to two batched UPDATEs
# (best_move + pv); committing every 100 games keeps the SSH tunnel responsive and
# bounds the work lost to a mid-run disconnect to one batch (SEED-054).
GAMES_PER_BATCH = 100

# Default single-worker mode. CLI --workers overrides; a 16 vCPU workstation can
# comfortably run 10-12 (the engine runs locally — no prod constraint applies).
DEFAULT_WORKERS = 1

# Eval fan-out chunk: number of evaluate_nodes_with_pv() calls gathered at once.
# The EnginePool queue caps in-flight analyses at pool.size, so a 1-worker pool
# serializes while an N-worker pool gets ~Nx throughput.
EVAL_CHUNK_SIZE = 200


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _db_url(target: str) -> str:
    """Resolve the asyncpg URL for the chosen --db target (via .env)."""
    return db_url_for_target(target)


def _boards_at_plies(pgn_text: str, plies: Sequence[int]) -> dict[int, chess.Board]:
    """Replay PGN once, return {ply: board} (pre-push board) for all requested plies.

    Board state BEFORE the move at that ply — the decision position whose best_move
    we want. ply >= mainline length → final position. Returns an empty dict if the
    PGN cannot be parsed; callers treat missing keys as a skip. Mirrors the
    same-named helper in scripts/backfill_eval.py.
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
    # Any requested ply >= mainline length → final position (after the last push).
    for ply in plies_set:
        captured.setdefault(ply, board)
    return captured


def _build_target_stmt(
    user_id: int | None, limit: int | None
) -> Select[tuple[int, int, str, bool, bool]]:
    """Build the SELECT for flaw positions needing best_move and/or pv (SEED-054).

    Selects (game_id, ply, pgn, need_bm, need_pv) for GamePosition rows where:
    1. best_move IS NULL OR pv IS NULL  (idempotent / resumable — see module docstring;
       covers the lichess best_move hole AND the engine-game pv hole in one pass)
    2. the ply is a flaw ply OR a flaw+1 ply: EXISTS a game_flaws row at gp.ply
       (flaw_ply itself) or at gp.ply - 1 (gp.ply is flaw_ply + 1).

    The flaw-row EXISTS also bounds scope to already-analyzed games (flaw rows are only
    written by a full drain tick), so no analyzed-gate / guest filter is needed.

    need_bm / need_pv are per-row "this column was NULL" flags so the writer fills only
    the missing column and never clobbers an engine game's existing best_move with a
    fresh (non-deterministic) search. Selecting the booleans (not pv itself) avoids
    streaming the large pv text for rows that already have it.

    Ordered recency-first: Game.played_at DESC (NULLS LAST for undated games), then
    (game_id, ply) as tiebreakers. Recent games are backfilled before older ones so
    the most-likely-to-be-viewed Library games get their best_move/pv arrows soonest
    during a long run. Because played_at is a game-level column, all rows of one game
    share the same played_at, so adding game_id/ply tiebreakers keeps each game's rows
    contiguous → the streaming reader can batch by game and replay each PGN exactly once.
    """
    flaw_match = exists(
        select(GameFlaw.ply).where(
            GameFlaw.game_id == GamePosition.game_id,
            ((GameFlaw.ply == GamePosition.ply) | (GameFlaw.ply == GamePosition.ply - 1)),
        )
    )

    stmt = (
        select(
            GamePosition.game_id,
            GamePosition.ply,
            Game.pgn,
            GamePosition.best_move.is_(None).label("need_bm"),
            GamePosition.pv.is_(None).label("need_pv"),
        )
        .join(Game, Game.id == GamePosition.game_id)
        .where(
            (GamePosition.best_move.is_(None)) | (GamePosition.pv.is_(None)),
            flaw_match,
        )
    )

    if user_id is not None:
        stmt = stmt.where(GamePosition.user_id == user_id)

    # Recency-first (see docstring): most recently played games first, undated last,
    # with (game_id, ply) tiebreakers preserving per-game row contiguity for batching.
    stmt = stmt.order_by(
        Game.played_at.desc().nulls_last(),
        GamePosition.game_id,
        GamePosition.ply,
    )

    if limit is not None:
        stmt = stmt.limit(limit)

    return stmt


async def _stream_game_batches(
    session_maker: async_sessionmaker[AsyncSession],
    stmt: Select[Any],
    games_per_batch: int,
) -> AsyncIterator[list[Any]]:
    """Stream rows from a server-side cursor, yielding game-batched lists.

    The recency-first ORDER BY (played_at DESC, game_id, ply) keeps each game's rows
    contiguous (all rows of a game share its played_at), so we flush a batch as soon
    as we cross `games_per_batch` distinct game_ids. Postgres holds the cursor; only
    one batch is alive in Python at a time (mirrors backfill_eval).
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


def _resolve_boards(rows: Sequence[Any]) -> list[tuple[int, int, chess.Board, bool, bool]]:
    """Replay each game's PGN once → list of (game_id, ply, board, need_bm, need_pv) targets.

    Rows arrive ordered by (game_id, ply); itertools.groupby gives one contiguous
    block per game so each PGN is parsed a single time. Plies whose board cannot be
    materialized (PGN parse failure) are dropped (counted by the caller as
    skipped_no_board). need_bm / need_pv are carried through from the query so the
    writer fills only the originally-NULL column.
    """
    from itertools import groupby

    out: list[tuple[int, int, chess.Board, bool, bool]] = []
    for _gid, group_iter in groupby(rows, key=lambda r: r.game_id):
        group = list(group_iter)
        plies = [r.ply for r in group]
        boards = _boards_at_plies(group[0].pgn, plies)
        for r in group:
            board = boards.get(r.ply)
            if board is not None:
                out.append((r.game_id, r.ply, board, r.need_bm, r.need_pv))
    return out


async def _process_batch(
    rows: Sequence[Any],
    session: AsyncSession,
    *,
    db: str,
    pool: EnginePool,
) -> tuple[int, int, int, int]:
    """Evaluate + write best_move/pv for one game-batch.

    Returns (written_bm, written_pv, no_board, engine_err).

    For each target ply: run a 1M-node search, then write ONLY the originally-NULL
    column(s) — best_move when need_bm, pv when need_pv — via the shared drain
    helpers. This never clobbers an engine game's existing best_move. eval_cp /
    eval_mate are NEVER written (lichess %eval / prior engine eval preserved). Writes
    are grouped per game (the helpers are game-scoped) and the whole batch commits once.
    """
    targets = _resolve_boards(rows)
    no_board = len(rows) - len(targets)
    if no_board:
        _log(f"  WARNING: {no_board} position(s) had an unparseable PGN — skipped")

    # Per-game accumulators: {game_id: [(ply, best_move)]} and {game_id: [(ply, pv)]}.
    bm_by_game: dict[int, list[tuple[int, str]]] = {}
    pv_by_game: dict[int, list[tuple[int, str]]] = {}
    written_bm = 0
    written_pv = 0
    engine_err = 0

    for chunk_start in range(0, len(targets), EVAL_CHUNK_SIZE):
        chunk = targets[chunk_start : chunk_start + EVAL_CHUNK_SIZE]
        results = await asyncio.gather(
            *(pool.evaluate_nodes_with_pv(board) for _gid, _ply, board, _nb, _np in chunk)
        )
        for (game_id, ply, _board, need_bm, need_pv), (_cp, _mt, best_move, pv) in zip(
            chunk, results, strict=True
        ):
            if best_move is None:
                # (None, None, None, None) — genuine engine failure (a legal position
                # always yields a best move). pv is None too; nothing to write.
                engine_err += 1
                sentry_sdk.set_context(
                    "backfill_best_move_pv",
                    {"game_id": game_id, "ply": ply, "db_target": db},
                )
                sentry_sdk.set_tag("source", "backfill")
                sentry_sdk.capture_message(
                    "backfill_best_move_pv: engine returned no best_move", level="warning"
                )
                continue
            # Fill only the column that was originally NULL (never clobber an existing
            # best_move / pv). best_move is present here; pv may still be None.
            if need_bm:
                bm_by_game.setdefault(game_id, []).append((ply, best_move))
                written_bm += 1
            if need_pv and pv is not None:
                pv_by_game.setdefault(game_id, []).append((ply, pv))
                written_pv += 1

    # One pair of batched UPDATEs per game (keying identical to the drain), then a
    # single commit for the whole batch.
    for game_id, bm_rows in bm_by_game.items():
        await _batch_update_best_move_rows(session, game_id, bm_rows)
    for game_id, pv_rows in pv_by_game.items():
        await _batch_update_pv_rows(session, game_id, pv_rows)
    await session.commit()

    return written_bm, written_pv, no_board, engine_err


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
    """SEED-054 backfill driver. Public callable for testability.

    Idempotency / resume: selection is gated on (best_move IS NULL OR pv IS NULL), so a
    re-run after a mid-run kill naturally continues (per-batch commit bounds the loss).

    _session_maker / _pool are internal test hooks; production callers omit both.
    """
    if timeout is not None:
        _engine_module._TIMEOUT_S = timeout
        _log(f"Engine per-eval timeout overridden: {timeout}s (default 2.0s)")

    dispose_engine = _session_maker is None
    if _session_maker is None:
        async_engine = create_async_engine(_db_url(db), pool_pre_ping=True)
        session_maker = async_sessionmaker(async_engine, expire_on_commit=False)
    else:
        async_engine = None  # type: ignore[assignment]  # not created here; nothing to dispose
        session_maker = _session_maker

    stmt = _build_target_stmt(user_id, limit)

    if dry_run:
        async with session_maker() as count_session:
            count = (
                await count_session.execute(select(func.count()).select_from(stmt.subquery()))
            ).scalar_one()
        _log(
            f"--dry-run: {count} flaw position(s) need best_move and/or pv "
            "(best_move IS NULL OR pv IS NULL)."
        )
        _log("--dry-run: exiting without starting engine or writing.")
        if dispose_engine and async_engine is not None:
            await async_engine.dispose()
        return

    _log(f"Streaming target rows in batches of {GAMES_PER_BATCH} games.")

    dispose_pool = _pool is None
    if _pool is None:
        pool = EnginePool(workers)
        await pool.start()
        _log(f"EnginePool started with {workers} worker(s).")
    else:
        pool = _pool

    rows_seen = 0
    written_bm_total = 0
    written_pv_total = 0
    no_board_total = 0
    engine_err_total = 0
    batch_idx = 0
    try:
        async with session_maker() as write_session:
            async for batch in _stream_game_batches(session_maker, stmt, GAMES_PER_BATCH):
                batch_idx += 1
                wbm, wpv, nb, ee = await _process_batch(batch, write_session, db=db, pool=pool)
                rows_seen += len(batch)
                written_bm_total += wbm
                written_pv_total += wpv
                no_board_total += nb
                engine_err_total += ee
                _log(
                    f"  batch {batch_idx} done ({len(batch)} rows; cumulative "
                    f"seen={rows_seen}, written_best_move={written_bm_total}, "
                    f"written_pv={written_pv_total}, skipped_no_board={no_board_total}, "
                    f"engine_err={engine_err_total})"
                )
    finally:
        if dispose_pool:
            await pool.stop()

    if rows_seen:
        _log(
            f"Backfill complete: rows={rows_seen}, written_best_move={written_bm_total}, "
            f"written_pv={written_pv_total}, skipped_no_board={no_board_total}, "
            f"engine_err={engine_err_total}"
        )
    else:
        _log("No flaw positions needed best_move or pv (no-op).")

    if dispose_engine and async_engine is not None:
        await async_engine.dispose()


def parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Backfill engine best_move + pv at flaw plies for stored games (SEED-054)."
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help=(
            "Database target. dev=localhost:5432, benchmark=localhost:5433, "
            "prod=localhost:15432 (via bin/prod_db_tunnel.sh). REQUIRED."
        ),
    )
    parser.add_argument(
        "--user-id",
        type=int,
        default=None,
        dest="user_id",
        metavar="N",
        help=(
            "Limit backfill to a single user ID (e.g. --user-id 13). Default: all "
            "users. Useful to size/verify one account before the full prod pass."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Count target positions and print; do not start engine or write anything.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Cap at N target positions. Useful for smoke checks.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        metavar="N",
        help=(
            f"Number of parallel local Stockfish workers (default {DEFAULT_WORKERS}). "
            "Each is its own UCI process configured Threads=1. On a 16 vCPU "
            "workstation, 10-12 is a good upper bound. The engine runs locally, so "
            "no prod memory constraint applies. Do NOT raise this when running ON "
            "the prod server."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=None,
        metavar="SECONDS",
        help=(
            "Override the engine's per-eval timeout (default 2.0s in "
            "app/services/engine.py:_TIMEOUT_S). Applies to every pool worker."
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
        f"Starting best_move/pv backfill: db={args.db} user_id={args.user_id} "
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
