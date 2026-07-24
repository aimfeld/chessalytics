"""Backfill lichess-compatible accuracy/ACPL for already-analyzed games (Phase 178 D-06).

Why this script exists
-----------------------
Phase 178 Plans 01-03 shipped the migration (repurposed `white_accuracy` /
`black_accuracy` / `white_acpl` / `black_acpl` as our uniform computed columns,
preserving the platform-reported values in the new `*_imported` columns), the
pure compute module (`app.services.accuracy_acpl.compute_game_accuracy_acpl`),
and the live-hook wiring (`eval_apply.py::_classify_and_fill_oracle`) that fills
the four canonical columns for every game as it finishes full-eval analysis
going forward. This script fills the EXISTING corpus of already-analyzed games
(~718k on prod) that finished analysis before Plan 03 shipped.

Single-path guarantee (D-06/SEED-110 SS4): this script calls the EXACT SAME
`compute_game_accuracy_acpl` the live hook uses. No formula logic is
re-implemented here — the only responsibility of this script is candidate
selection, streaming, and writing the result.

Read path (two-phase, index-driven, bounded memory)
----------------------------------------------------
BUG-FIX HISTORY: the original design used ONE server-side cursor
(`session.stream(...)`) over a `game_positions JOIN games` SELECT ordered by
`(game_id, ply)`. There is no index on `game_positions(game_id, ply)` (the PK
leads with `user_id`), so at prod scale that ORDER BY compiles to a BLOCKING
Sort over ~34M joined rows. A Sort emits no rows until it finishes, so the
"stream" materialized a multi-GB result set into Python before the first batch
ever committed — it OOM-froze the operator's machine and filled zero games.
`backfill_best_move_pv.py`'s identical streaming pattern happens to survive
only because its candidate set is far smaller.

The fix is a two-phase, chunked read that never sorts the whole table:
  1. Load candidate `games.id`s ONCE (one seq-scan of `games` returning just
     the ~464k 4-byte ids, ordered by id — a few MB in Python, released
     immediately).
  2. For each chunk of `GAMES_PER_BATCH` ids, fetch that chunk's position rows
     via `WHERE game_id = ANY(:ids) ORDER BY game_id, ply`, which uses
     `ix_game_positions_game_id` (Index Scan + a tiny incremental sort of only
     the chunk's rows). Group with `itertools.groupby`, compute, write, commit.

This is NOT the rejected N+1 pattern: it is one indexed SELECT per CHUNK
(~100 games), not one per game. Memory is bounded to a single chunk
(~100 games x ~40 plies) regardless of corpus size.

Candidate gate (coarse SQL, not authoritative)
-----------------------------------------------
The candidate-id SELECT filters by `Game.white_blunders.isnot(None)` (the
`is_analyzed` sentinel) plus `Game.white_accuracy.is_(None)` for resumability —
it deliberately does NOT filter on `eval_cp`/`eval_mate` presence, because the
compute function's own interior-hole Complete-Sequence Gate is the ONLY
authority on whether a game's eval sequence is hole-free (178-RESEARCH.md
SS "Complete-Sequence Gate"). A presence filter here would silently hide holes
and wrongly treat a holed game as complete.

What it writes
---------------
For each candidate game: `UPDATE games SET white_accuracy=..., black_accuracy=...,
white_acpl=..., black_acpl=... WHERE id = <game_id>`, using the compute
result's fields directly. When the compute returns None (interior eval hole,
or a 0-move game), the game's four columns are left as-is (already NULL —
selection is gated on `white_accuracy IS NULL`, so there is nothing to write).

Idempotent / resumable
-----------------------
Selection is gated on `white_accuracy IS NULL`, so a dropped SSH tunnel or
Ctrl-C -> just re-run; already-filled games drop out of the candidate set.
A holed game's four columns stay NULL and it is re-attempted on every run
(harmless — the compute is cheap, pure Python, no engine calls).

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

Usage:
    # Size it first:
    uv run python scripts/backfill_accuracy_acpl.py --db dev --dry-run

    # Smoke on dev (first 500 candidate games):
    uv run python scripts/backfill_accuracy_acpl.py --db dev --limit 500

    # Scope to a single user:
    uv run python scripts/backfill_accuracy_acpl.py --db dev --user-id 13

    # Full prod backfill from the local machine (pure Python, zero engine load):
    bin/prod_db_tunnel.sh
    uv run python scripts/backfill_accuracy_acpl.py --db prod

Running the ~718k-game prod backfill is a separate operator step and is NOT
gated on phase completion (D-06 — see 178-04-PLAN.md must_haves).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Sequence
from datetime import datetime, timezone
from itertools import groupby
from pathlib import Path
from typing import Any

import sentry_sdk
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.sql import Select

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.game import Game  # noqa: E402
from app.models.game_position import GamePosition  # noqa: E402

# Joining Game forces SQLAlchemy to configure the mapper chain, and User in turn
# declares a relationship to OAuthAccount, so both must be imported/registered
# or mapper configuration fails at query time (pattern from backfill_full_evals.py
# / backfill_best_move_pv.py).
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402, F401
from app.services.accuracy_acpl import compute_game_accuracy_acpl  # noqa: E402

# Commit cadence in game-units, mirroring backfill_full_evals.py's
# ENQUEUE_GAMES_PER_BATCH / backfill_best_move_pv.py's GAMES_PER_BATCH. Keeps
# the SSH tunnel to prod responsive and bounds work lost to a mid-run kill to
# one batch (re-running is idempotent — see module docstring).
GAMES_PER_BATCH = 100


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _db_url(target: str) -> str:
    """Resolve the asyncpg URL for the chosen --db target (via .env)."""
    return db_url_for_target(target)


def _build_candidate_ids_stmt(user_id: int | None, limit: int | None) -> Select[tuple[int]]:
    """Build the SELECT of candidate `games.id`s to backfill.

    Selects `Game.id` for every analyzed game still missing canonical
    accuracy/ACPL:
    1. `Game.white_blunders.isnot(None)` — the `is_analyzed` sentinel (coarse
       candidate filter, not authoritative — see module docstring).
    2. `Game.white_accuracy.is_(None)` — resumability: already-filled games
       drop out of the candidate set on a re-run.
    3. `Game.user_id == user_id` when `--user-id` is given.

    Deliberately does NOT filter on `eval_cp`/`eval_mate` presence — the
    compute function's own Complete-Sequence Gate is authoritative on holes.

    Returns only the 4-byte `id` (no join to `game_positions`), so the result
    is a few MB even at full prod scale — the per-chunk position fetch below is
    what pulls eval rows, and only one chunk at a time. `--limit` caps the
    number of candidate GAMES (useful for smoke checks).
    """
    stmt = select(Game.id).where(
        Game.white_blunders.isnot(None),
        Game.white_accuracy.is_(None),
    )

    if user_id is not None:
        stmt = stmt.where(Game.user_id == user_id)

    stmt = stmt.order_by(Game.id)

    if limit is not None:
        stmt = stmt.limit(limit)

    return stmt


async def _load_candidate_game_ids(
    session: AsyncSession, user_id: int | None, limit: int | None
) -> list[int]:
    """Fetch all candidate `games.id`s in one query (id-ordered, memory-trivial)."""
    result = await session.execute(_build_candidate_ids_stmt(user_id, limit))
    return list(result.scalars().all())


async def _fetch_chunk_positions(session: AsyncSession, game_ids: Sequence[int]) -> list[Any]:
    """Fetch every position row for a chunk of games, ordered `(game_id, ply)`.

    `game_id = ANY(:ids)` uses `ix_game_positions_game_id` (Index Scan) and the
    `(game_id, ply)` ORDER BY becomes a tiny incremental sort over only this
    chunk's rows — NOT a full-table sort (see the module docstring's bug-fix
    history). The `(game_id, ply)` order keeps each game's rows contiguous so
    the caller can group with `itertools.groupby`.
    """
    result = await session.execute(
        select(
            GamePosition.user_id,
            GamePosition.game_id,
            GamePosition.ply,
            GamePosition.eval_cp,
            GamePosition.eval_mate,
        )
        .where(GamePosition.game_id.in_(game_ids))
        .order_by(GamePosition.game_id, GamePosition.ply)
    )
    return list(result.all())


async def _process_batch(
    rows: Sequence[Any],
    session: AsyncSession,
    *,
    dry_run: bool,
) -> tuple[int, int, int]:
    """Compute + (unless --dry-run) write accuracy/ACPL for one game-batch.

    Groups the (already game_id-ordered) rows with `itertools.groupby` — one
    contiguous block per game — and calls `compute_game_accuracy_acpl` on
    each group directly (the streamed rows expose `.ply`/`.eval_cp`/
    `.eval_mate`, structurally matching the compute module's `PositionLike`
    protocol; no re-implemented formula logic, single-path guarantee).

    Returns (processed, filled, skipped_none): `processed` is the number of
    distinct games seen in this batch; `filled` is the number whose compute
    returned a result (written unless dry_run); `skipped_none` is the number
    whose compute returned None (interior hole or 0-move game — left NULL).
    """
    processed = 0
    filled = 0
    skipped_none = 0
    games_table = Game.__table__

    for game_id, group_iter in groupby(rows, key=lambda r: r.game_id):
        processed += 1
        group = list(group_iter)
        result = compute_game_accuracy_acpl(group)

        if result is None:
            skipped_none += 1
            continue

        filled += 1
        if not dry_run:
            await session.execute(
                update(games_table)  # ty: ignore[invalid-argument-type]
                .where(games_table.c.id == game_id)
                .values(
                    white_accuracy=result.white_accuracy,
                    black_accuracy=result.black_accuracy,
                    white_acpl=result.white_acpl,
                    black_acpl=result.black_acpl,
                )
            )

    if not dry_run:
        await session.commit()

    return processed, filled, skipped_none


async def run_backfill(
    *,
    db: str,
    user_id: int | None,
    dry_run: bool,
    limit: int | None,
    _session_maker: async_sessionmaker[AsyncSession] | None = None,
) -> None:
    """Phase 178 D-06 backfill driver. Public callable for testability.

    Idempotency / resume: selection is gated on `white_accuracy IS NULL`, so a
    re-run after a mid-run kill naturally continues (per-batch commit bounds
    the loss to one batch).

    `_session_maker` is an internal test hook; production callers omit it.
    """
    dispose_engine = _session_maker is None
    if _session_maker is None:
        async_engine = create_async_engine(_db_url(db), pool_pre_ping=True)
        session_maker = async_sessionmaker(async_engine, expire_on_commit=False)
    else:
        async_engine = None  # type: ignore[assignment]  # not created here; nothing to dispose
        session_maker = _session_maker

    rows_seen = 0
    games_processed = 0
    games_filled = 0
    games_skipped_none = 0
    batch_idx = 0

    async with session_maker() as write_session:
        game_ids = await _load_candidate_game_ids(write_session, user_id, limit)
        total_candidates = len(game_ids)
        _log(f"{total_candidates} candidate games; processing in chunks of {GAMES_PER_BATCH}.")
        if dry_run:
            _log("--dry-run: computing but NOT writing any UPDATEs.")

        for chunk_start in range(0, total_candidates, GAMES_PER_BATCH):
            batch_idx += 1
            chunk_ids = game_ids[chunk_start : chunk_start + GAMES_PER_BATCH]
            batch = await _fetch_chunk_positions(write_session, chunk_ids)
            processed, filled, skipped_none = await _process_batch(
                batch, write_session, dry_run=dry_run
            )
            rows_seen += len(batch)
            games_processed += processed
            games_filled += filled
            games_skipped_none += skipped_none
            _log(
                f"  chunk {batch_idx} done ({len(chunk_ids)} games, {len(batch)} rows; "
                f"cumulative processed={games_processed}/{total_candidates}, "
                f"filled={games_filled}, skipped_none={games_skipped_none})"
            )

    if games_processed:
        _log(
            f"Backfill {'(dry-run) ' if dry_run else ''}complete: "
            f"rows={rows_seen}, processed={games_processed}, "
            f"filled={games_filled}, skipped_none={games_skipped_none}"
        )
    else:
        _log("No candidate games found (no-op).")

    if dispose_engine and async_engine is not None:
        await async_engine.dispose()


def parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Backfill lichess-compatible accuracy/ACPL for already-analyzed games (Phase 178 D-06)."
        )
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
        help="Limit backfill to a single user ID. Default: all analyzed users.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Compute and log processed/filled/skipped-none counts; write nothing.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Cap at N candidate games. Useful for smoke checks.",
    )
    return parser.parse_args()


async def main() -> None:
    """Entry point: parse CLI args, init Sentry, run backfill."""
    args = parse_args()

    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    _log(
        f"Starting accuracy/ACPL backfill: db={args.db} user_id={args.user_id} "
        f"dry_run={args.dry_run} limit={args.limit}"
    )
    await run_backfill(
        db=args.db,
        user_id=args.user_id,
        dry_run=args.dry_run,
        limit=args.limit,
    )
    _log("Done.")


if __name__ == "__main__":
    asyncio.run(main())
