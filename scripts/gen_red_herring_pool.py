"""Generate herring_pool rows via a real MultiPV-5 Stockfish search (Phase 192).

Phase 192 replaces the structurally-broken superseded herring source
(non-gem `game_best_moves` rows, POOL-03 amended): a red herring is now a
`herring_pool` row sampled across ALL signed-up users' `game_positions`,
confirmed by a real MultiPV-5 search whose raw 5-move ladder is stored on the
row. This script is the ONLY writer of that table.

Plan 03 (this revision) completes the Plan 01 tracer: phase-balanced thirds
(D-19), bounded oversampling, resumable top-up (D-14), and this Rollout
section. It also adds `--measure` (Task 2), the one-off instrumentation mode
that produced the PV0-PV1/PV0-PV4 expected-score gap histograms Plan 03 used
to re-pin `HERRING_LOOSE_BAND_ES` and pin `HERRING_DEGENERATE_MIN_GAP_ES`
(app/services/train_pool.py) — see those constants' comments for the basis.

DB target host:port mapping (CLAUDE.md):
    dev:       localhost:5432  (Docker compose flawchess-dev)
    benchmark: localhost:5433  (Docker compose flawchess-benchmark)
    prod:      localhost:15432 (via bin/prod_db_tunnel.sh)

The URL for each target comes from the DATABASE_URL_{DEV,BENCHMARK,PROD} env
vars (.env), resolved via app.core.config.db_url_for_target.

D-11: `--db` is required with no default — no run can silently target
production. A local Stockfish binary must resolve via
`app.services.engine._resolve_stockfish_path` (STOCKFISH_PATH env var, the
prod Docker path, or the dev install location).

Sampling implementation: candidates are paged with a keyset scan over
`game_positions`' `(user_id, game_id, ply)` composite PK — never a
skip-N-rows page parameter, which degrades linearly on a table this size
(prod: millions of rows per phase). Each bucket's scan starts from a RANDOM
`user_id` (bounded by `MIN(users.id)`/`MAX(users.id)`) and walks forward in
two passes
(`user_id >= start`, then `user_id < start`) so the full candidate range is
covered exactly once per bucket regardless of where the random start lands.
Randomizing the start is not required for correctness (a fixed start would
also terminate correctly) — it gives topped-up re-runs a different slice of
the frame each time instead of always re-scanning (and re-rejecting) the
same low-user_id positions first, which is what a plain ascending scan from
the beginning would do on every invocation.

Resumable top-up (D-14, ROADMAP SC2): before scanning a phase bucket, this
script counts existing `herring_pool` rows for that phase and targets only
the shortfall (`target - existing`, floored at 0). Combined with
`ON CONFLICT (user_id, game_id, ply) DO NOTHING`, a re-run with the same
`--n-positions` tops up rather than restarting, and a re-run whose random
scan happens to re-encounter an already-stored candidate does not count that
conflict toward the shortfall (`INSERT ... RETURNING`'s row count is checked
per candidate). Commits happen every `HERRING_COMMIT_EVERY` accepted rows,
not once at the end, so an interrupted run leaves only whole, valid rows
behind.

Rollout (D-11/D-13/D-14):
  - D-11: production is generated with LOCAL Stockfish against the prod DB
    over `bin/prod_db_tunnel.sh` (`--db prod`, port 15432). Never run this
    script on the prod server (CLAUDE.md's only sanctioned SSH-side
    operation is deploy) and never wire it into the backend as a background
    tier — it is a standalone offline process, zero prod CPU consumed by the
    search itself.
  - D-13: deploy the herring_stmt source swap FIRST, then run this script.
    The empty-pool window (minutes to an hour) needs no new logic —
    `compose_and_materialize_session`'s cross-backfill already fills the
    shortfall from the SR pool and `waiting_count` degrades honestly.
    RECORD the window's start/end timestamps in the phase SUMMARY — guess-
    accuracy data collected during it is unusable (with no herrings, "one
    critical move" is always the correct guess) and must be excluded from
    any later anti-tell analysis.
  - D-14: one-shot with manual top-up on demand. No cron, no scheduler, no
    depletion monitoring — nothing erodes the pool now that the source-game
    link nulls (D-01) instead of cascading.
  - Per-environment: game ids are not portable across databases, so each
    environment (dev/benchmark/prod) gets its own independent run. Dev has
    zero rows in the superseded `game_best_moves` table, so this script is
    what makes red herrings locally testable for the first time.

Usage:
    # Phase-balanced thirds (recommended for a real rollout):
    uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 30
    uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 30 --dry-run

    # A single phase only:
    uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 10 --phase middlegame

    # Measurement mode (Task 2): scan up to --n-positions SEARCHED candidates
    # per phase bucket (or one bucket with --phase), log PV0-PV1/PV0-PV4
    # expected-score gap histograms, write NOTHING to the database.
    uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 300 --measure
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import chess
import chess.engine
import sentry_sdk
from sqlalchemy import ColumnElement, func, select, tuple_
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import db_url_for_target, settings  # noqa: E402
from app.models.game import Game  # noqa: E402
from app.models.game_position import GamePosition  # noqa: E402
from app.models.herring_pool import HerringPool  # noqa: E402

# Game.user_id has a FK to users.id; importing only Game leaves the users table
# unregistered and select(...).join(User, ...) raises NoReferencedTableError at
# compile time. User in turn declares a relationship to OAuthAccount, so both
# must be imported (pattern from scripts/backfill_flaws.py).
from app.models.oauth_account import OAuthAccount  # noqa: E402, F401
from app.models.user import User  # noqa: E402
from app.services.best_move_candidates import mover_color_for_ply  # noqa: E402
from app.services.engine import EnginePool, _score_to_cp_mate  # noqa: E402
from app.services.train_pool import (  # noqa: E402
    HERRING_LADDER_SIZE,
    HERRING_LOOSE_BAND_ES,
    HERRING_MIN_PLY,
    HERRING_MIN_QUALIFYING_MOVES,
    HERRING_PREFERRED_QUALIFYING_MOVES,
    HERRING_PREFILTER_ABS_CP,
    expected_score_for,
    fen_and_last_move_at_ply,
)

# ─── Named constants (no magic numbers, CLAUDE.md) ───────────────────────────

PhaseName = Literal["opening", "middlegame", "endgame"]

# Phase -> PHASE_CODES SmallInteger, matching GamePosition.phase / HerringPool.phase
# (Lichess Divider.scala classification: 0=opening, 1=middlegame, 2=endgame).
PHASE_CODES: dict[PhaseName, int] = {
    "opening": 0,
    "middlegame": 1,
    "endgame": 2,
}

# D-19: iteration order for the thirds split — the first bucket absorbs the
# remainder when --n-positions doesn't divide evenly by 3.
_PHASE_THIRDS_ORDER: tuple[PhaseName, ...] = ("opening", "middlegame", "endgame")

# Candidate-frame scan bound: most sampled positions get rejected (too few
# legal moves, fail the loose qualifying-moves band, or turn out to be a
# duplicate already in the pool), so the scan must examine several times the
# per-bucket target to have a realistic chance of filling it. Bounds the scan
# (T-192-05 DoS mitigation) instead of walking the whole game_positions table
# unbounded. Starting value from the Plan 01 tracer's measured accept rate
# (5 stored / 6 scanned on a 100-row LIMIT frame, i.e. close to 1:1) plus
# headroom for the stricter oversample needed once ply-mismatch/dup rejects
# are accounted for at scale.
HERRING_OVERSAMPLE_FACTOR: int = 20

# Commit every N processed candidates — OOM-safe batching (CLAUDE.md import
# memory-pressure history), independent of how many of those candidates
# actually qualified and were written.
HERRING_COMMIT_EVERY: int = 50

# Single sequential Stockfish worker — this is a standalone process (like
# scripts/remote_eval_worker.py), not the FastAPI app's pooled singleton.
HERRING_GENERATOR_WORKERS: int = 1

# Keyset page size: bounds per-round-trip memory/row count while still
# amortizing DB round-trips across many candidates per page.
HERRING_SCAN_PAGE_SIZE: int = 500

# Measurement mode (Task 2, D-15/D-17): histogram bucket width in expected-
# score units for the PV0-PV1 / PV0-PV4 gap histograms.
HERRING_MEASURE_BUCKET_ES: float = 0.01


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description="Generate herring_pool rows via a real MultiPV-5 Stockfish search"
    )
    parser.add_argument(
        "--db",
        choices=["dev", "benchmark", "prod"],
        required=True,
        help="DB target: dev (localhost:5432), benchmark (localhost:5433), prod (via SSH tunnel).",
    )
    parser.add_argument(
        "--n-positions",
        type=int,
        required=True,
        dest="n_positions",
        help="Target rows to store this run (split into phase thirds when --phase is omitted). "
        "In --measure mode: target SEARCHED candidates per phase bucket instead.",
    )
    parser.add_argument(
        "--phase",
        choices=["opening", "middlegame", "endgame"],
        default=None,
        help="Sample only this game phase. Omit to split --n-positions into phase-balanced "
        "thirds (D-19) — each bucket has its own independent target and shortfall.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Run the full scan and log the accept/reject tally without writing. "
        "Ignored (implied) when --measure is set.",
    )
    parser.add_argument(
        "--measure",
        action="store_true",
        help="Measurement mode (Task 2): scan up to --n-positions SEARCHED candidates per "
        "phase bucket, log PV0-PV1/PV0-PV4 expected-score gap histograms, write nothing.",
    )
    return parser.parse_args()


def _build_ladder(
    info_list: list[chess.engine.InfoDict],
) -> list[dict[str, Any]] | None:
    """Build the 5-element ladder blob from a MultiPV-5 `analyse()` result.

    Each element is `{"move_uci": str, "cp": int | None, "mate": int | None}`,
    white POV, ordered best-first as Stockfish returned them (D-16). Returns
    None if any entry lacks a PV move — the ladder-shape CHECK constraint
    requires every entry to have a real move_uci, so such a candidate must be
    rejected rather than stored with a broken entry.
    """
    ladder: list[dict[str, Any]] = []
    for info in info_list:
        pv = info.get("pv")
        if not pv:
            return None
        cp, mate = _score_to_cp_mate(info)
        ladder.append({"move_uci": pv[0].uci(), "cp": cp, "mate": mate})
    return ladder


def _thirds_split(n_positions: int) -> dict[PhaseName, int]:
    """Split `n_positions` into three independent phase-bucket targets (D-19).

    The remainder (when n_positions isn't divisible by 3) goes to the first
    bucket (opening) — each bucket's shortfall is computed independently by
    the caller, so a shortfall in one bucket never absorbs another's quota.
    """
    base = n_positions // 3
    remainder = n_positions - base * len(_PHASE_THIRDS_ORDER)
    targets: dict[PhaseName, int] = dict.fromkeys(_PHASE_THIRDS_ORDER, base)
    targets["opening"] += remainder
    return targets


# ─── Candidate scanning (shared by generation and measurement) ──────────────


def _candidate_frame_stmt(
    *,
    phase_code: int,
    extra_where: ColumnElement[bool],
    after: tuple[int, int, int] | None,
    limit: int,
):
    """Build one keyset-paginated page of the candidate frame.

    Joins `game_positions` -> `games` -> `users`, requiring `is_guest = false`
    (D-02, generation-time only) and the shared ply-floor/eval pre-filter.
    `extra_where` scopes one of the two random-start passes (see module
    docstring); `after` is the `(user_id, game_id, ply)` keyset cursor for
    the next page within that pass — never a skip-N-rows page parameter.
    """
    stmt = (
        select(GamePosition, Game)
        .join(Game, Game.id == GamePosition.game_id)
        .join(User, User.id == Game.user_id)
        .where(
            User.is_guest.is_(False),  # D-02: generation time only
            GamePosition.phase == phase_code,
            GamePosition.ply >= HERRING_MIN_PLY,
            func.abs(GamePosition.eval_cp) <= HERRING_PREFILTER_ABS_CP,
            extra_where,
        )
    )
    if after is not None:
        stmt = stmt.where(
            tuple_(GamePosition.user_id, GamePosition.game_id, GamePosition.ply) > after
        )
    return stmt.order_by(GamePosition.user_id, GamePosition.game_id, GamePosition.ply).limit(limit)


async def _user_id_bounds(session: AsyncSession) -> tuple[int, int] | None:
    """`(MIN(users.id), MAX(users.id))`, or None when there are no users at all."""
    row = (await session.execute(select(func.min(User.id), func.max(User.id)))).one()
    if row[0] is None:
        return None
    return row[0], row[1]


def _random_start_passes(
    min_uid: int, max_uid: int
) -> tuple[ColumnElement[bool], ColumnElement[bool]]:
    """Two WHERE predicates covering [min_uid, max_uid] exactly once, starting
    from a random point (module docstring's "randomized starting key")."""
    start_uid = random.randint(min_uid, max_uid)  # noqa: S311 - sampling spread, not security
    return (GamePosition.user_id >= start_uid), (GamePosition.user_id < start_uid)


@dataclass
class _Outcome:
    """One candidate's classification. `kind="stored"` carries the accepted
    ladder/board data; every other kind is a rejection reason."""

    kind: Literal["unreconstructable", "legal_moves", "ply_mismatch", "band_reject", "stored"]
    ladder: list[dict[str, Any]] | None = None
    fen: str | None = None
    last_move_uci: str | None = None
    mover_color: Literal["white", "black"] | None = None
    qualifying: int = 0


async def _evaluate_candidate(
    pool: EnginePool,
    position: GamePosition,
    game: Game,
    *,
    measure: bool,
) -> _Outcome:
    """Reconstruct the board, apply D-18's legal-move-count reject, search via
    MultiPV-5, and classify the result.

    In measurement mode (`measure=True`) the loose-band qualifying-moves gate
    (D-15) is skipped entirely — every candidate that survives the legal-move
    reject and a successful search is returned as `kind="stored"` so the
    caller can build the gap histograms over the full searched population,
    not just what would have been accepted for storage.
    """
    reconstructed = fen_and_last_move_at_ply(game.pgn, position.ply)
    if reconstructed is None:
        return _Outcome(kind="unreconstructable")
    fen, last_move_uci = reconstructed
    board = chess.Board(fen)

    if len(list(board.legal_moves)) < HERRING_LADDER_SIZE:
        return _Outcome(kind="legal_moves")

    expected_mover = mover_color_for_ply(position.ply)
    actual_mover: Literal["white", "black"] = "white" if board.turn else "black"
    if expected_mover != actual_mover:
        # SEED-120 Pitfall 1: the ply-indexing convention can drift on
        # old/malformed imports. Log-and-skip, not a bug worth a Sentry event.
        return _Outcome(kind="ply_mismatch")

    info_list = await pool.evaluate_nodes_multipv5(board)
    if info_list is None or len(info_list) != HERRING_LADDER_SIZE:
        return _Outcome(kind="legal_moves")  # engine failure — same bucket, no crash

    ladder = _build_ladder(info_list)
    if ladder is None:
        return _Outcome(kind="legal_moves")

    best_es = expected_score_for(ladder[0]["cp"], ladder[0]["mate"], actual_mover)
    if best_es is None:
        return _Outcome(kind="band_reject")

    if measure:
        return _Outcome(
            kind="stored",
            ladder=ladder,
            fen=fen,
            last_move_uci=last_move_uci,
            mover_color=actual_mover,
        )

    qualifying = sum(
        1
        for entry in ladder
        if (entry_es := expected_score_for(entry["cp"], entry["mate"], actual_mover)) is not None
        and best_es - entry_es <= HERRING_LOOSE_BAND_ES
    )
    if qualifying < HERRING_MIN_QUALIFYING_MOVES:
        return _Outcome(kind="band_reject")

    return _Outcome(
        kind="stored",
        ladder=ladder,
        fen=fen,
        last_move_uci=last_move_uci,
        mover_color=actual_mover,
        qualifying=qualifying,
    )


# ─── Generation (writes herring_pool) ────────────────────────────────────────


@dataclass
class _Tally:
    scanned: int = 0
    rejected_legal_moves: int = 0
    rejected_ply_mismatch: int = 0
    rejected_unreconstructable: int = 0
    rejected_band: int = 0
    duplicate_skipped: int = 0
    stored: int = 0


async def _write_candidate(
    session: AsyncSession,
    outcome: _Outcome,
    *,
    game: Game,
    position: GamePosition,
    phase_code: int,
    dry_run: bool,
) -> bool:
    """UPSERT one accepted candidate. Returns True iff a NEW row was written
    (False on a dry-run "would store" or an ON CONFLICT no-op — both must NOT
    count toward a bucket's shortfall, or a rerun would over-count progress)."""
    if dry_run:
        return True
    insert_stmt = (
        pg_insert(HerringPool)
        .values(
            user_id=game.user_id,
            game_id=game.id,
            ply=position.ply,
            mover_color=outcome.mover_color,
            fen=outcome.fen,
            arriving_move_uci=outcome.last_move_uci,
            phase=phase_code,
            source_played_at=game.played_at,
            ladder=outcome.ladder,
        )
        .on_conflict_do_nothing(constraint="uq_herring_pool_source")
    )
    result = await session.execute(insert_stmt)
    return (result.rowcount or 0) > 0  # ty: ignore[unresolved-attribute]  # DML result carries rowcount


async def _process_candidate(
    session: AsyncSession,
    pool: EnginePool,
    position: GamePosition,
    game: Game,
    *,
    phase_code: int,
    dry_run: bool,
    tally: _Tally,
) -> None:
    """Evaluate, classify, and (if accepted) write one candidate. Per-candidate
    isolation: any exception here is logged + Sentry-captured, never aborts
    the run (mirrors backfill_flaws.py's per-game isolation)."""
    try:
        outcome = await _evaluate_candidate(pool, position, game, measure=False)
    except Exception as exc:  # noqa: BLE001 - per-candidate isolation
        sentry_sdk.set_context("gen_red_herring_pool", {"game_id": game.id, "ply": position.ply})
        sentry_sdk.capture_exception(exc)
        _log(f"  ERROR: candidate failed game_id={game.id} ply={position.ply}: {exc}")
        return

    if outcome.kind == "unreconstructable":
        tally.rejected_unreconstructable += 1
        return
    if outcome.kind == "legal_moves":
        tally.rejected_legal_moves += 1
        return
    if outcome.kind == "ply_mismatch":
        tally.rejected_ply_mismatch += 1
        _log(f"  SKIP ply-mismatch: game_id={game.id} ply={position.ply}")
        return
    if outcome.kind == "band_reject":
        tally.rejected_band += 1
        return

    inserted = await _write_candidate(
        session, outcome, game=game, position=position, phase_code=phase_code, dry_run=dry_run
    )
    if not inserted:
        tally.duplicate_skipped += 1
        return
    tally.stored += 1
    if outcome.qualifying >= HERRING_PREFERRED_QUALIFYING_MOVES:
        _log(
            f"  ACCEPT (preferred): game_id={game.id} ply={position.ply} "
            f"qualifying={outcome.qualifying}/{HERRING_LADDER_SIZE}"
        )


async def _scan_pass(
    session: AsyncSession,
    pool: EnginePool,
    *,
    base_predicate: ColumnElement[bool],
    phase_code: int,
    target: int,
    budget_remaining: int,
    dry_run: bool,
    tally: _Tally,
    stored_at_pass_start: int,
) -> int:
    """Keyset-walk one pass of the frame (see module docstring's two-pass
    random-start scan). Returns the number of candidates examined."""
    after: tuple[int, int, int] | None = None
    examined = 0
    while examined < budget_remaining and (tally.stored - stored_at_pass_start) < target:
        page_limit = min(HERRING_SCAN_PAGE_SIZE, budget_remaining - examined)
        stmt = _candidate_frame_stmt(
            phase_code=phase_code, extra_where=base_predicate, after=after, limit=page_limit
        )
        page = (await session.execute(stmt)).all()
        if not page:
            break
        for position, game in page:
            examined += 1
            tally.scanned += 1
            await _process_candidate(
                session, pool, position, game, phase_code=phase_code, dry_run=dry_run, tally=tally
            )
            if (tally.stored - stored_at_pass_start) >= target or examined >= budget_remaining:
                break
            if not dry_run and tally.stored > 0 and tally.stored % HERRING_COMMIT_EVERY == 0:
                await session.commit()
        last_position, _ = page[-1]
        after = (last_position.user_id, last_position.game_id, last_position.ply)
    return examined


async def _scan_bucket(
    session: AsyncSession,
    pool: EnginePool,
    *,
    phase: PhaseName,
    phase_code: int,
    target: int,
    dry_run: bool,
    tally: _Tally,
) -> None:
    """Fill up to `target` new rows for one phase bucket via the two-pass
    random-start keyset scan, bounded by HERRING_OVERSAMPLE_FACTOR * target
    candidates examined."""
    frame_limit = target * HERRING_OVERSAMPLE_FACTOR
    bounds = await _user_id_bounds(session)
    if bounds is None:
        _log(f"  No candidates for phase={phase} (no users in this database)")
        return
    stored_before = tally.stored
    examined = 0
    for base_predicate in _random_start_passes(*bounds):
        if (tally.stored - stored_before) >= target or examined >= frame_limit:
            break
        examined += await _scan_pass(
            session,
            pool,
            base_predicate=base_predicate,
            phase_code=phase_code,
            target=target,
            budget_remaining=frame_limit - examined,
            dry_run=dry_run,
            tally=tally,
            stored_at_pass_start=stored_before,
        )
    stored_this_bucket = tally.stored - stored_before
    gave_up = " (gave up: oversample budget exhausted)" if stored_this_bucket < target else ""
    _log(
        f"  Bucket {phase}: target={target} stored={stored_this_bucket} examined={examined}{gave_up}"
    )


async def _existing_count(session: AsyncSession, phase_code: int) -> int:
    """Current `herring_pool` row count for one phase — the resumable top-up base."""
    stmt = select(func.count()).select_from(HerringPool).where(HerringPool.phase == phase_code)
    return (await session.execute(stmt)).scalar_one()


def _log_generation_summary(tally: _Tally, dry_run: bool) -> None:
    _log("")
    _log("Generation complete:")
    _log(f"  Scanned: {tally.scanned}")
    _log(
        f"  Rejected (fewer than {HERRING_LADDER_SIZE} legal moves / engine failure): "
        f"{tally.rejected_legal_moves}"
    )
    _log(f"  Rejected (ply-mover mismatch): {tally.rejected_ply_mismatch}")
    _log(f"  Rejected (FEN unreconstructable): {tally.rejected_unreconstructable}")
    _log(f"  Rejected (below loose qualifying-moves band): {tally.rejected_band}")
    _log(f"  Duplicate (already in pool, ON CONFLICT skipped): {tally.duplicate_skipped}")
    _log(f"  Stored {'(dry-run, not written)' if dry_run else 'and written'}: {tally.stored}")


async def run_generation(
    *,
    db: str,
    n_positions: int,
    phase: PhaseName | None,
    dry_run: bool,
    session_maker: async_sessionmaker[AsyncSession] | None = None,
    pool: EnginePool | None = None,
) -> None:
    """Scan `game_positions` and write real MultiPV-5-confirmed herring_pool rows.

    Args:
        db: DB target string ("dev", "benchmark", "prod").
        n_positions: Target number of rows to store this run (split into
            phase-balanced thirds when `phase` is None, D-19).
        phase: Sample only this game phase, or None for the thirds split.
        dry_run: If True, scan and tally without writing.
        session_maker: Injectable session factory for testing. When None, a
            real engine is created from db_url_for_target(db).
        pool: Injectable EnginePool for testing. When None, a real pool of
            HERRING_GENERATOR_WORKERS is started and stopped by this function.
    """
    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    owns_pool = pool is None
    if pool is None:
        pool = EnginePool(HERRING_GENERATOR_WORKERS)
        await pool.start()

    _log(f"Target: {db}, phase={phase or 'all (thirds split)'}, n_positions={n_positions}")
    _log(f"Mode: {'--dry-run (no writes)' if dry_run else 'write'}")

    targets: dict[PhaseName, int] = (
        {phase: n_positions} if phase is not None else _thirds_split(n_positions)
    )
    tally = _Tally()

    try:
        async with session_maker() as session:
            for phase_name, target in targets.items():
                phase_code = PHASE_CODES[phase_name]
                existing = await _existing_count(session, phase_code)
                shortfall = max(0, target - existing)
                _log(
                    f"Phase {phase_name}: target={target} existing={existing} shortfall={shortfall}"
                )
                if shortfall == 0:
                    continue
                await _scan_bucket(
                    session,
                    pool,
                    phase=phase_name,
                    phase_code=phase_code,
                    target=shortfall,
                    dry_run=dry_run,
                    tally=tally,
                )
            if not dry_run:
                await session.commit()
    finally:
        if owns_pool:
            await pool.stop()

    _log_generation_summary(tally, dry_run)


# ─── Measurement (Task 2, no writes) ─────────────────────────────────────────


@dataclass
class _GapHistograms:
    """PV0-PV1 / PV0-PV4 expected-score gap histograms, bucketed at
    HERRING_MEASURE_BUCKET_ES-wide bins (bucket index = floor(gap / width))."""

    pv1_gap: Counter[int] = field(default_factory=Counter)
    pv4_gap: Counter[int] = field(default_factory=Counter)
    searched: int = 0


def _bucket_index(gap_es: float) -> int:
    return max(0, int(gap_es / HERRING_MEASURE_BUCKET_ES))


def _record_gap_histogram(
    ladder: list[dict[str, Any]], mover_color: Literal["white", "black"], hist: _GapHistograms
) -> None:
    best_es = expected_score_for(ladder[0]["cp"], ladder[0]["mate"], mover_color)
    if best_es is None:
        return
    pv1_es = expected_score_for(ladder[1]["cp"], ladder[1]["mate"], mover_color)
    pv4_es = expected_score_for(ladder[4]["cp"], ladder[4]["mate"], mover_color)
    if pv1_es is not None:
        hist.pv1_gap[_bucket_index(best_es - pv1_es)] += 1
    if pv4_es is not None:
        hist.pv4_gap[_bucket_index(best_es - pv4_es)] += 1
    hist.searched += 1


async def _measure_bucket(
    session: AsyncSession,
    pool: EnginePool,
    *,
    phase: PhaseName,
    phase_code: int,
    sample_size: int,
    hist: _GapHistograms,
) -> int:
    """Scan up to `sample_size` SEARCHED candidates for one phase bucket,
    recording gap histograms. Never writes to the database."""
    frame_limit = sample_size * HERRING_OVERSAMPLE_FACTOR
    bounds = await _user_id_bounds(session)
    if bounds is None:
        return 0
    examined = 0
    for base_predicate in _random_start_passes(*bounds):
        if hist.searched >= sample_size or examined >= frame_limit:
            break
        after: tuple[int, int, int] | None = None
        while examined < frame_limit and hist.searched < sample_size:
            page_limit = min(HERRING_SCAN_PAGE_SIZE, frame_limit - examined)
            stmt = _candidate_frame_stmt(
                phase_code=phase_code, extra_where=base_predicate, after=after, limit=page_limit
            )
            page = (await session.execute(stmt)).all()
            if not page:
                break
            for position, game in page:
                examined += 1
                await _measure_one_candidate(pool, position, game, hist=hist)
                if hist.searched >= sample_size:
                    break
            last_position, _ = page[-1]
            after = (last_position.user_id, last_position.game_id, last_position.ply)
    return examined


async def _measure_one_candidate(
    pool: EnginePool, position: GamePosition, game: Game, *, hist: _GapHistograms
) -> None:
    try:
        outcome = await _evaluate_candidate(pool, position, game, measure=True)
    except Exception as exc:  # noqa: BLE001 - per-candidate isolation
        sentry_sdk.set_context(
            "gen_red_herring_pool_measure", {"game_id": game.id, "ply": position.ply}
        )
        sentry_sdk.capture_exception(exc)
        return
    if outcome.kind == "stored" and outcome.ladder is not None and outcome.mover_color is not None:
        _record_gap_histogram(outcome.ladder, outcome.mover_color, hist)


def _log_gap_table(label: str, counts: Counter[int], total: int) -> None:
    _log(f"  {label}:")
    if total == 0 or not counts:
        _log("    (no data)")
        return
    cumulative = 0
    for bucket in range(0, max(counts) + 1):
        n = counts.get(bucket, 0)
        if n == 0:
            continue
        cumulative += n
        lo = bucket * HERRING_MEASURE_BUCKET_ES
        hi = lo + HERRING_MEASURE_BUCKET_ES
        pct_cum = 100.0 * cumulative / total
        _log(f"    [{lo:.2f}, {hi:.2f}): n={n}  cumulative<={hi:.2f}: {pct_cum:.1f}%")


def _log_histogram(phase: PhaseName, hist: _GapHistograms) -> None:
    _log(f"Phase {phase}: searched={hist.searched}")
    _log_gap_table("PV0->PV1 gap (ES)", hist.pv1_gap, hist.searched)
    _log_gap_table("PV0->PV4 gap (ES)", hist.pv4_gap, hist.searched)


async def run_measurement(
    *,
    db: str,
    sample_size: int,
    phase: PhaseName | None,
    session_maker: async_sessionmaker[AsyncSession] | None = None,
    pool: EnginePool | None = None,
) -> dict[PhaseName, _GapHistograms]:
    """Measure the PV0-PV1/PV0-PV4 expected-score gap distributions (Task 2).

    Never writes to herring_pool — this is a one-off instrumentation run used
    to pick HERRING_LOOSE_BAND_ES (D-15) and HERRING_DEGENERATE_MIN_GAP_ES
    (D-17) from real data rather than guessing them.

    Args:
        db: DB target string ("dev", "benchmark", "prod").
        sample_size: Target SEARCHED candidates per phase bucket (or the
            single bucket named by `phase`).
        phase: Measure only this phase, or None for all three.
        session_maker: Injectable session factory for testing.
        pool: Injectable EnginePool for testing.

    Returns:
        Per-phase `_GapHistograms`, for programmatic inspection in addition
        to the logged tables.
    """
    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    if session_maker is None:
        url = db_url_for_target(db)
        engine = create_async_engine(url, pool_pre_ping=True)
        session_maker = async_sessionmaker(engine, expire_on_commit=False)

    owns_pool = pool is None
    if pool is None:
        pool = EnginePool(HERRING_GENERATOR_WORKERS)
        await pool.start()

    phases: tuple[PhaseName, ...] = (phase,) if phase is not None else _PHASE_THIRDS_ORDER
    _log(f"Measure target: {db}, phase(s)={phases}, sample_size={sample_size} per phase")

    histograms: dict[PhaseName, _GapHistograms] = {}
    try:
        async with session_maker() as session:
            for phase_name in phases:
                hist = _GapHistograms()
                await _measure_bucket(
                    session,
                    pool,
                    phase=phase_name,
                    phase_code=PHASE_CODES[phase_name],
                    sample_size=sample_size,
                    hist=hist,
                )
                histograms[phase_name] = hist
                _log_histogram(phase_name, hist)
    finally:
        if owns_pool:
            await pool.stop()

    return histograms


if __name__ == "__main__":
    args = _parse_args()
    if args.measure:
        asyncio.run(run_measurement(db=args.db, sample_size=args.n_positions, phase=args.phase))
    else:
        asyncio.run(
            run_generation(
                db=args.db, n_positions=args.n_positions, phase=args.phase, dry_run=args.dry_run
            )
        )
