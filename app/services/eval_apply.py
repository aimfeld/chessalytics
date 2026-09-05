"""Shared write-path orchestration for the full-ply eval pipeline (Phase 150 R7 / WRITE-04).

Physically relocated (not re-exported) from `app/services/eval_drain.py` and
`app/routers/eval_remote.py` so both live write lanes -- the in-process
`_full_drain_tick` (eval_drain.py) and the atomic-submit worker endpoint
(`_apply_atomic_submit`, eval_remote.py) -- consume ONE shared implementation of:

    - the classify preamble (`_classify_with_overlay`, R4),
    - the flaw diff/upsert (`_classify_and_fill_oracle`, R3),
    - the Path A/B/C completion decision (`apply_completion_decision`, R1),
    - the full-ply eval write + flaw-blob assembly primitives these depend on, and
    - `apply_full_eval(...)`, the shared write_session body both lanes call.

Dependency direction (Pitfall 3, RESEARCH.md): this module is a LEAF. It must
NEVER import from `app.services.eval_drain` or `app.routers.eval_remote` --
both of those import FROM here. `eval_drain.py` re-imports a subset of the
symbols below (for its own full-lane orchestration AND to preserve backward
compatibility for existing test/script imports that reference
`app.services.eval_drain.<symbol>` -- those names are simply re-bound into
eval_drain's namespace via import, not re-defined, so external callers are
unaffected by the physical relocation).

`_build_flaw_blob_lease_positions` (the tier-4 flaw-blob-only lane) is also
relocated here even though RESEARCH.md's R7 section marks the tier-4 lane as
functionally isolated from the live-submit path (D-04 isolation boundary) --
that isolation is about NOT sharing write semantics with the live path, not
about which file the code lives in. Moving it here (rather than leaving it in
eval_drain.py) is what makes eval_remote.py's private-helper import block
disappear entirely (Task 1 acceptance criterion), without merging its logic
with apply_full_eval.
"""

import asyncio
import io
import json
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, cast

import chess
import chess.pgn
import sentry_sdk
import sqlalchemy as sa
from fastapi import HTTPException, status
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session_maker
from app.models.eval_jobs import EvalJob
from app.models.game import Game
from app.models.game_best_move import GameBestMove
from app.models.game_flaw import GameFlaw
from app.models.game_position import DEDUP_MAX_PLY, GamePosition
from app.models.opening_position_eval import OpeningPositionEval
from app.repositories.game_flaws_repository import (
    FLAW_BLOB_COLUMNS,
    bulk_insert_game_flaws,
    bulk_update_game_flaw_rows,
    delete_flaw_plies,
    flaw_record_to_row,
)
from app.repositories.worker_heartbeat_repository import upsert_worker_heartbeat
from app.schemas.eval_remote import (
    AtomicBlobNode,
    BestMoveLeasePosition,
    BestMoveSubmitRequest,
    BestMoveSubmitResponse,
    FlawBlobLeasePosition,
    FlawBlobSubmitEval,
)
from app.schemas.normalization import Platform, TimeControlBucket
from app.services import engine as engine_service
from app.services import maia_engine
from app.services.accuracy_acpl import compute_game_accuracy_acpl
from app.services.best_move_candidates import (
    mover_color_for_ply,
    passes_inaccuracy_gate,
    pinned_elo_for_mover,
)
from app.services.flaws_service import (
    FlawRecord,
    GameFlawsResult,
    classify_game_flaws,
    count_game_severities,
)
from app.services.eval_utils import derive_is_lichess_eval_game
from app.services.forcing_line_gate import PvNode
from app.services.maia_engine import score_move
from app.services.normalization import is_correspondence_time_control
from app.services.opening_lookup import find_opening_ply_count

# Phase 119 SEED-045: max drain ticks that may leave a non-terminal hole before
# the game is stamped complete anyway (with one aggregated warning/Sentry event).
# D-116-07 intent: a deterministically-unevaluable ply cannot loop forever. Pool
# outages (all-fail circuit breaker WR-05) do NOT consume attempts, so a
# transient outage cannot exhaust the budget and silently drop coverage.
#
# SEED-139 item 4: raised 3 -> 5. Nearly free since SEED-076 made re-leases
# incremental — a retry re-sends only the still-missing plies, so an extra
# attempt costs a handful of positions, not a whole game. Prod measured 9,988
# games reaching the 3rd attempt, ALL of them hole-free afterwards with no 4th
# attempt behind them: the budget, not the engine, was the binding constraint.
MAX_EVAL_ATTEMPTS: int = 5

# Phase 116 EVAL-03 / D-116-02: dedup only in the opening region. WR-08: aliased
# from the model constant (single source of truth) so this boundary can never
# drift from the ply <= N predicate of the ix_gp_full_hash_opening partial index.
_DEDUP_MAX_PLY: int = DEDUP_MAX_PLY

# 260825-v8g (FLAWCHESS-9F / FLAWCHESS-8G): namespace for the per-game write
# advisory-lock key space (see `_game_write_lock_key` below), packed into the
# HIGH 32 bits of a bigint key. Value is the ASCII bytes of "FLAW" read as one
# big-endian uint32 (0x46='F', 0x4C='L', 0x41='A', 0x57='W'). Exists so this key
# space can never collide with another advisory-lock user of this database —
# `tests/conftest.py`'s template-clone serialization already occupies
# `_TEMPLATE_ADVISORY_LOCK_KEY = 7_777_777_777`, which is far below
# `_GAME_WRITE_LOCK_NAMESPACE << 32` (~5.07e18), so the two spaces are provably
# disjoint.
_GAME_WRITE_LOCK_NAMESPACE: int = 0x464C4157
# Low-32-bit mask applied to game_id when packing the key (see
# `_game_write_lock_key`).
_GAME_WRITE_LOCK_MASK: int = 0xFFFFFFFF


def _game_write_lock_key(game_id: int) -> int:
    """Pack `game_id` into a single bigint key for `pg_advisory_xact_lock(bigint)`.

    (1) Why the single-argument bigint form rather than the two-argument
    `pg_advisory_xact_lock(int4, int4)` form: `games.id` is BIGINT in the actual
    schema (`alembic/versions/20260311_133123_dcef507678d8_initial_schema.py`
    line 25), so a game id is not guaranteed to fit in int4 — even though
    today's max game id is far below the int4 ceiling.

    (2) PostgreSQL keeps the int8 and two-int4 advisory key spaces separate
    internally (`pg_locks.objsubid` is 1 for the single-bigint form vs 2 for the
    two-int4 form), so packing a namespace into the high bits here deliberately
    mirrors the two-argument form's classid/objid split without sharing its
    key space.

    (3) The `& _GAME_WRITE_LOCK_MASK` means two game ids congruent modulo 2**32
    would share a key — harmless in practice (that is 4.29 billion games apart)
    but stated here so nobody has to re-derive it from the bit math.
    """
    return (_GAME_WRITE_LOCK_NAMESPACE << 32) | (game_id & _GAME_WRITE_LOCK_MASK)


# ---------------------------------------------------------------------------
# Phase 116 full-ply drain: dataclass + helpers
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _FullPlyEvalTarget:
    """One position scheduled for full-ply eval (Phase 116 EVAL-01).

    ply: game_positions.ply (0-indexed; 0 = initial position before first move)
    full_hash: for dedup batch-lookup at ply <= _DEDUP_MAX_PLY (EVAL-03)
    board: board snapshot for the engine call (if not dedup'd)
    eval_cp / eval_mate: the row's CURRENT stored values from the DB. Carried so
        the drain can skip engine calls for plies whose result would be
        discarded by the D-116-04 preservation gate anyway (WR-01), and so the
        write path's belt-and-braces preservation check needs no row re-scan.
    best_move: Phase 117 EVAL-04 — populated from engine result or dedup transplant.
    is_terminal: SEED-044 — True for the post-game terminal-position target. Under
        the post-move convention the eval stored at the LAST played move's row is
        the eval of the position AFTER that move (the terminal position), so the
        terminal board is evaluated as an eval-only donor. A terminal target has
        NO game_positions row of its own (no move was played from it): it is never
        written, never dedup'd, and contributes only its position eval as the
        pos_eval[k+1] donor for the last real row.
    """

    game_id: int
    ply: int
    full_hash: int
    board: chess.Board
    eval_cp: int | None
    eval_mate: int | None
    best_move: str | None = None
    is_terminal: bool = False
    ends_game: bool = False
    """SEED-049 — True for the single real (non-terminal) row whose move ENDS the game
    (resulting position is_game_over()). Under post-move storage its after-eval is the
    game-over terminal, which is deliberately unevaluable and never gets a donor, so its
    NULL post-move eval is legitimate — never counted as a hole."""

    move_uci: str | None = None
    """Phase 174 GEMS-03 — the UCI of the move PLAYED from this ply's board, captured
    during the existing PGN walk in _collect_full_ply_targets (Pitfall 3/4: no re-parse,
    no fresh query). Compared against the ply's Stockfish best_move to find played==best
    gem candidates. None for the terminal donor (no move is played from it)."""

    move_san: str | None = None
    """Phase 174 GEMS-03 — the SAN of the move PLAYED from this ply's board, in the same
    dialect openings.tsv uses (via chess.Board.san). Feeds find_opening_ply_count's
    out-of-book test without re-parsing the PGN (Pitfall 3). None for the terminal donor."""

    stored_best_move: str | None = None
    """WR-01 — the row's CURRENT stored best_move from the DB (game_positions.best_move),
    the lichess-eval analog of eval_cp/eval_mate above. Threaded ONLY by the atomic-submit
    path (which alone passes preserve_existing_evals=True); the local drain leaves it None
    (default) since it re-evaluates the whole game each tick. Used by
    `_is_lichess_best_move_hole` to skip counting an already-resolved lichess ply that a
    re-lease worker transiently re-fails — eval_cp/eval_mate is useless as that signal for
    lichess rows (they always carry a non-NULL %eval from import)."""


def _collect_full_ply_targets(
    game_id: int,
    pgn_text: str,
    game_positions_rows: Sequence[tuple[int, int, int | None, int | None]],
    include_terminal: bool = False,
    stored_best_move_by_ply: dict[int, str | None] | None = None,
) -> list[_FullPlyEvalTarget]:
    """Collect one target per ply, with an optional terminal eval-donor (EVAL-01, SEED-044).

    game_positions_rows: (ply, full_hash, eval_cp, eval_mate) loaded from DB.

    stored_best_move_by_ply (WR-01): optional ply -> current DB best_move map. Only the
    atomic-submit path (preserve_existing_evals=True) passes it, to seed each target's
    `stored_best_move` so the lichess-eval hole-counter can skip an already-resolved ply
    that a re-lease worker transiently re-fails. The drain omits it (default None) — its
    targets keep stored_best_move=None, which is a no-op under preserve_existing_evals=False.

    Per-ply targets snapshot the PRE-PUSH board (the position BEFORE the move at
    that ply), so the engine's eval is the eval OF that position and its best_move
    is the best move FROM it — both position-/decision-keyed. The POST-MOVE storage
    shift (eval stored at row k = eval of the position AFTER move k) is applied
    later, at write time, in `_post_move_eval`.

    include_terminal (SEED-044): when True, append ONE extra terminal target for
    the post-game board (the position after the final push). Under the post-move
    convention the last played move's stored eval is the eval of that terminal
    position, so it must be evaluated. The terminal target has `is_terminal=True`,
    `ply = <number of plies played>` (one past the last real row), and no DB row of
    its own — it is an eval-only donor (never written, never dedup'd). Engine games
    pass include_terminal=True; lichess `%eval` games pass False (their evals are
    preserved, never shifted, so no terminal donor is needed).

    Returns [] on PGN parse failure or None game.
    """
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception as exc:
        # The PGN was already parsed at import; a raise here is a bug or data
        # corruption, and returning [] silently leaves a permanent eval hole.
        sentry_sdk.set_tag("source", "full_eval")
        sentry_sdk.set_context("full_eval", {"game_id": game_id, "stage": "pgn_parse"})
        sentry_sdk.capture_exception(exc)
        return []
    if game is None:
        return []

    # Build ply -> (full_hash, eval_cp, eval_mate) lookup from DB rows
    ply_meta: dict[int, tuple[int, int | None, int | None]] = {
        ply: (fh, cp, mt) for ply, fh, cp, mt in game_positions_rows
    }

    stored_bm = stored_best_move_by_ply or {}
    board = game.board()
    targets: list[_FullPlyEvalTarget] = []
    ply_count = 0
    for ply, node in enumerate(game.mainline()):
        ply_count = ply + 1
        meta = ply_meta.get(ply)
        if meta is not None:
            fh, cp, mt = meta
            # Phase 174 GEMS-03: capture the played move's UCI/SAN from the SAME walk
            # (Pitfall 3/4 — no re-parse, no fresh query). SAN is computed on the
            # pre-push board so it uses openings.tsv's dialect (O-O castling etc.).
            move_san: str | None
            try:
                move_san = board.san(node.move)
            except Exception as exc:
                # Illegal moves never reach the mainline (read_game stops and
                # records them in game.errors), so a SAN failure here is a
                # genuine bug; None only drops the played-move badge.
                sentry_sdk.set_tag("source", "full_eval")
                sentry_sdk.set_context("full_eval", {"game_id": game_id, "ply": ply})
                sentry_sdk.capture_exception(exc)
                move_san = None
            targets.append(
                _FullPlyEvalTarget(
                    game_id=game_id,
                    ply=ply,
                    full_hash=fh,
                    board=board.copy(),
                    eval_cp=cp,
                    eval_mate=mt,
                    stored_best_move=stored_bm.get(ply),
                    move_uci=node.move.uci(),
                    move_san=move_san,
                )
            )
        board.push(node.move)
    # board is now the terminal position. Under post-move storage it is the
    # after-eval donor for the last played move (SEED-044). full_hash is 0 (unused:
    # terminal targets are excluded from dedup and never written by full_hash).
    #
    # Skip a GAME-OVER terminal (checkmate/stalemate/insufficient material): the
    # engine cannot search a finished position (evaluate_nodes_multipv2 would error
    # or return a degenerate result), and a mating/stalemating final move is the
    # best move, never a flaw to assess. Games that ended by resignation/timeout
    # leave a normal (not game-over) final board, so the last move IS assessable
    # (a pre-resignation blunder gets its after-eval).
    if include_terminal and ply_count > 0 and not board.is_game_over():
        targets.append(
            _FullPlyEvalTarget(
                game_id=game_id,
                ply=ply_count,
                full_hash=0,
                board=board.copy(),
                eval_cp=None,
                eval_mate=None,
                is_terminal=True,
            )
        )
    elif include_terminal and ply_count > 0 and board.is_game_over():
        # SEED-049: the final board is game-over (checkmate/stalemate/insufficient
        # material), which means the last real move was the game-ending move. Its
        # post-move eval is the unevaluable terminal position — legitimately NULL,
        # not a hole. Mark ends_game=True on the last real target (ply = ply_count - 1)
        # so _apply_full_eval_results skips it in the failed_ply_count counter.
        game_ending_ply = ply_count - 1
        for target in reversed(targets):
            if target.ply == game_ending_ply:
                target.ends_game = True
                break
    return targets


async def _fetch_dedup_evals(
    session: AsyncSession,
    full_hashes: Sequence[int],
) -> dict[int, tuple[int | None, int | None, str | None, str | None]]:
    """Batch-fetch a position's OWN eval + best_move + pv for opening-region hashes (EVAL-03, D-116-02).

    SEED-053 / D-123.1-05: reads the position-keyed opening_position_eval cache instead
    of the former self-join on game_positions. The cache is a hash-unique relation keyed by
    full_hash, so the lookup collapses to a PK index scan (~1-5 ms) versus the ~8.4 s
    DISTINCT-ON self-join (see CONTEXT.md for EXPLAIN evidence). Column semantics are
    identical to the self-join result: eval_cp/eval_mate are the eval OF the requested
    position and best_move is the engine's decision FROM it.

    Read-side guards (ply <= DEDUP_MAX_PLY, not in flaw_engine_plies, not is_terminal)
    remain entirely in the caller — UNCHANGED. This function only changes which table
    backs the lookup.

    Returns {full_hash: (eval_cp, eval_mate, best_move, pv)} for hashes present in the
    cache. pv is the cached PV string FROM the position (SEED-076 follow-up); it may
    be None for cache rows written before the pv column existed or not yet backfilled.
    """
    if not full_hashes:
        return {}
    result = await session.execute(
        select(
            OpeningPositionEval.full_hash,
            OpeningPositionEval.eval_cp,
            OpeningPositionEval.eval_mate,
            OpeningPositionEval.best_move,
            OpeningPositionEval.pv,
        ).where(OpeningPositionEval.full_hash.in_(full_hashes))
    )
    return {row[0]: (row[1], row[2], row[3], row[4]) for row in result.all()}


def _resolve_full_eval(
    target: _FullPlyEvalTarget,
    dedup_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
) -> tuple[int | None, int | None, str | None, str | None]:
    """Resolve a target's POSITION-keyed eval + decision best_move/pv (pure; WR-04).

    Returns (eval_cp, eval_mate, best_move, pv_string) where eval_cp/eval_mate are
    the eval OF this target's own position (the engine evaluated the pre-push
    board, or the dedup map supplies the same position-keyed value) and
    best_move/pv are the engine's best move + PV FROM this position. This function
    does NOT apply the post-move storage shift — that is done at write time in
    `_post_move_eval` (SEED-044), so the same +1 lives in exactly one place.

    Priority: dedup hit (EVAL-03, opening region only) > engine result >
    (None, None, None, None) hole (D-116-07). pv_string is always None for dedup'd
    positions here — the dedup map's cached pv (element [3]) is intentionally NOT
    surfaced through this function, which only feeds _apply_full_eval_results'
    eval/best_move writes. The cached pv is merged into engine_result_map upstream
    at submit time instead (SEED-076 follow-up), so flaw-adjacent PV writes still
    happen elsewhere.
    """
    if not target.is_terminal and target.ply <= _DEDUP_MAX_PLY and target.full_hash in dedup_map:
        eval_cp, eval_mate, best_move, _pv = dedup_map[target.full_hash]
        return eval_cp, eval_mate, best_move, None
    return engine_result_map.get(target.ply, (None, None, None, None))


def _post_move_eval(
    pos_eval: dict[int, tuple[int | None, int | None]],
    ply: int,
) -> tuple[int | None, int | None]:
    """Post-move storage shift — the SINGLE site of the +1 (SEED-044).

    Under the post-move convention the eval stored at row `ply` is the eval of
    the position AFTER the move at `ply`, i.e. the eval of the NEXT position
    (`ply + 1`). `pos_eval` is the position-keyed eval map (eval OF each ply's
    position, including the terminal ply that follows the last move). For the
    last real row, `ply + 1` is the terminal position. A missing next-ply eval
    (engine hole at ply+1, or no terminal donor) yields a (None, None) NULL hole.
    """
    return pos_eval.get(ply + 1, (None, None))


async def _batch_update_best_move_rows(
    session: AsyncSession,
    game_id: int,
    bm_rows: list[tuple[int, str]],
) -> None:
    """Emit ONE batched UPDATE for best_move-only rows (FLAWCHESS-6B).

    Used by _apply_full_eval_results for:
    - lichess-eval game plies (best_move only; evals preserved untouched)
    - engine-game plies that have a best_move but a NULL post-move eval (hole rows
      where best_move is still available — written independently of eval, per SEED-044)

    Uses CAST() instead of :: cast syntax: asyncpg's named-param rewrite ($N)
    occurs before the server parses the SQL, so `::` adjacent to a $N placeholder
    raises a syntax error. CAST() is the portable equivalent.

    Guard: empty input is a no-op (no zero-row VALUES UPDATE is emitted).
    Sequential execute on caller-owned session — no asyncio.gather (CLAUDE.md).
    """
    if not bm_rows:
        return
    params: dict[str, int | str] = {"game_id": game_id}
    values_parts: list[str] = []
    for i, (ply, bm) in enumerate(bm_rows):
        params[f"ply_{i}"] = ply
        params[f"bm_{i}"] = bm
        values_parts.append(f"(CAST(:ply_{i} AS smallint), CAST(:bm_{i} AS varchar))")
    values_sql = ", ".join(values_parts)
    sql = sa.text(
        f"UPDATE game_positions"  # noqa: S608 — no user input; params are bound
        f" SET best_move = v.best_move"
        f" FROM (VALUES {values_sql}) AS v(ply, best_move)"
        f" WHERE game_positions.game_id = :game_id"
        f" AND game_positions.ply = v.ply"
    )
    await session.execute(sql, params)


async def _batch_update_pv_rows(
    session: AsyncSession,
    game_id: int,
    pv_rows: list[tuple[int, str]],
) -> None:
    """Emit ONE batched UPDATE writing pv (principal variation) for the given plies.

    Shared by the live drain (_classify_and_fill_oracle) and the SEED-054 backfill
    (scripts/backfill_best_move_pv.py) so the (game_id, ply) keying is identical by
    construction. pv is unbounded Text (PostgreSQL won't reject it at the column
    level).

    Does NOT catch exceptions — callers decide fault tolerance. The drain wraps the
    call in its own try/except so a PV write failure never aborts the flaw rows +
    oracle counts already written in the same transaction (T-108-04 / WR-01).

    Uses CAST() rather than :: cast syntax for asyncpg compatibility (same reason
    as _batch_update_best_move_rows). Guard: empty input is a no-op (no zero-row
    VALUES UPDATE). Sequential execute on caller-owned session — no asyncio.gather
    (CLAUDE.md).
    """
    if not pv_rows:
        return
    params: dict[str, int | str] = {"game_id": game_id}
    values_parts: list[str] = []
    for i, (ply, pv) in enumerate(pv_rows):
        params[f"ply_{i}"] = ply
        params[f"pv_{i}"] = pv
        values_parts.append(f"(CAST(:ply_{i} AS smallint), CAST(:pv_{i} AS text))")
    values_sql = ", ".join(values_parts)
    sql = sa.text(
        f"UPDATE game_positions"  # noqa: S608 — no user input; params are bound
        f" SET pv = v.pv"
        f" FROM (VALUES {values_sql}) AS v(ply, pv)"
        f" WHERE game_positions.game_id = :game_id"
        f" AND game_positions.ply = v.ply"
    )
    await session.execute(sql, params)


async def _batch_update_eval_rows(
    session: AsyncSession,
    game_id: int,
    eval_rows: list[tuple[int, int | None, int | None, str | None]],
) -> None:
    """Emit ONE batched UPDATE for eval-bearing engine rows (FLAWCHESS-6B).

    Each row carries (ply, eval_cp, eval_mate, best_move). eval_cp/eval_mate are
    always non-NULL (at least one is set) and overwrite unconditionally. best_move
    may be NULL: it is sourced from THIS ply's resolution while the eval is the
    post-move eval of ply+1 (a different resolution), so an eval-bearing row can
    legitimately carry best_move=None. We must NOT clobber a previously-written
    best_move in that case (re-submit / retry path), so best_move is written via
    COALESCE(v.best_move, existing) — exactly matching the pre-batch semantics
    where best_move was only ever written when present (FLAWCHESS-6B).

    Uses CAST() instead of :: cast syntax for asyncpg compatibility (same reason
    as _batch_update_best_move_rows).

    Guard: empty input is a no-op (no zero-row VALUES UPDATE is emitted).
    Sequential execute on caller-owned session — no asyncio.gather (CLAUDE.md).
    """
    if not eval_rows:
        return
    params: dict[str, int | str | None] = {"game_id": game_id}
    values_parts: list[str] = []
    for i, (ply, eval_cp, eval_mate, bm) in enumerate(eval_rows):
        params[f"ply_{i}"] = ply
        params[f"ecp_{i}"] = eval_cp
        params[f"emt_{i}"] = eval_mate
        params[f"bm_{i}"] = bm
        values_parts.append(
            f"(CAST(:ply_{i} AS smallint),"
            f" CAST(:ecp_{i} AS smallint),"
            f" CAST(:emt_{i} AS smallint),"
            f" CAST(:bm_{i} AS varchar))"
        )
    values_sql = ", ".join(values_parts)
    sql = sa.text(
        f"UPDATE game_positions"  # noqa: S608 — no user input; params are bound
        f" SET eval_cp = v.eval_cp, eval_mate = v.eval_mate,"
        f" best_move = COALESCE(v.best_move, game_positions.best_move)"
        f" FROM (VALUES {values_sql}) AS v(ply, eval_cp, eval_mate, best_move)"
        f" WHERE game_positions.game_id = :game_id"
        f" AND game_positions.ply = v.ply"
    )
    await session.execute(sql, params)


def _is_engine_hole(
    target: _FullPlyEvalTarget,
    preserve_existing_evals: bool,
    stored_eval_predates_engine: bool = False,
) -> bool:
    """Decide whether a NULL post-move eval is a genuine engine hole (WR-04).

    Extracted from `_apply_full_eval_results`'s per-target loop to drop one
    nesting level (the original `if target.ends_game / elif
    preserve_existing_evals / else` sat inside `if eval_cp is None and eval_mate
    is None` inside `for target in targets`, reaching depth 4). Pure decision,
    no I/O and no side effects — behavior is unchanged from the inlined version.

    Returns False (not a hole — do not count, do not overwrite) when:
    - target.ends_game: the after-position is the game-over terminal, a
      deliberately unevaluable position (SEED-049), not a transient failure.
    - preserve_existing_evals and NOT stored_eval_predates_engine and the row
      already carries a non-NULL DB eval: an incremental re-lease (SEED-076)
      omitted this position because it was already filled by a prior partial
      submit; the worker's None here is "not resent," not a fresh failure.

    stored_eval_predates_engine (tier3-branch-b-one-ply-stamp fix,
    derive_raw_lichess_eval_game — homogenization-invariant, see its docstring):
    True means this target's pre-existing DB eval_cp/eval_mate, if any, was
    written by lichess IMPORT, never by this pipeline's own engine — the
    "already resolved by a prior round" trust above does NOT apply, so a NULL
    result here is a genuine hole even though the row's stale imported eval_cp
    is non-NULL. Without this guard (the pre-fix behavior — this parameter
    defaulted away entirely), a homogenized lichess-arm game's every un-leased
    ply looked "already resolved" via its untouched import eval_cp, so
    failed_ply_count came back 0 and the game was stamped complete after a
    single analyzed ply regardless of length. Defaults to False (a genuine
    engine game never has import-sourced data, so this is always correctly
    False for that population — zero blast radius there).

    Returns True (a genuine hole, counted toward failed_ply_count) otherwise.
    """
    if target.ends_game:
        return False
    if (
        preserve_existing_evals
        and not stored_eval_predates_engine
        and (target.eval_cp is not None or target.eval_mate is not None)
    ):
        return False
    return True


def _is_lichess_best_move_hole(target: _FullPlyEvalTarget, preserve_existing_evals: bool) -> bool:
    """Decide whether a NULL best_move on a lichess-eval ply is a genuine hole (WR-01).

    The lichess-eval analog of `_is_engine_hole`. A lichess-eval game always re-leases
    its FULL position set (the SEED-076 redundancy filter is bypassed for these games in
    `_build_lease_positions`), so a NULL best_move normally means the worker genuinely
    FAILED this ply — a real hole that must hold the game back for a bounded Path-B retry.

    The ONE exception (mirrors `_is_engine_hole`'s existing-eval guard): under an
    incremental re-lease (preserve_existing_evals=True) a ply whose best_move was already
    written in a prior attempt can still be re-leased and transiently re-fail on the SAME
    ply that already has a good value stored. That is not a fresh failure, so it must not
    be counted — otherwise a game with complete best-move coverage burns an unneeded retry
    cycle. `target.stored_best_move` (not eval_cp/eval_mate — lichess rows always carry a
    non-NULL %eval from import) is the correct "already resolved" signal here.

    Returns True (a genuine hole, counted toward failed_ply_count) otherwise.
    """
    if preserve_existing_evals and target.stored_best_move is not None:
        return False
    return True


def _count_prior_holes(
    targets: Sequence[_FullPlyEvalTarget],
    is_lichess_eval_game: bool,
    stored_eval_predates_engine: bool = False,
) -> int:
    """Count plies that were ALREADY unresolved in the DB before this write (SEED-139 D-02).

    Mirrors `_is_engine_hole` / `_is_lichess_best_move_hole` exactly, but reads the
    target's PRE-WRITE snapshot fields (`eval_cp`/`eval_mate`/`stored_best_move` —
    the row's DB values loaded by `_collect_full_ply_targets` BEFORE this pass wrote
    anything) instead of a post-write query. A post-write query would read the state
    this same write just produced and could never show progress, so `targets` is the
    ONLY correct source for the prior count. Pure — no I/O, no session.

    lichess-eval games (is_lichess_eval_game=True) OR stored_eval_predates_engine=True
    (tier3-branch-b-one-ply-stamp fix — derive_raw_lichess_eval_game, homogenization-
    invariant: True for a homogenized lichess-arm game even though is_lichess_eval_game
    reads False for it): a target counts as a prior hole when its `stored_best_move`
    is None (mirrors `_is_lichess_best_move_hole`'s resolved-ply signal) — eval_cp is
    NOT a trustworthy "already resolved" signal for either population, since it is
    populated at IMPORT time, not by an engine call. Plain engine games (neither flag
    set): a target counts when it is not `ends_game` and both `eval_cp` and
    `eval_mate` are None (mirrors `_is_engine_hole`'s hole signal). The terminal
    donor target has no game_positions row and is never counted.
    """
    prior_holes = 0
    for target in targets:
        if target.is_terminal:
            continue
        if is_lichess_eval_game or stored_eval_predates_engine:
            if target.stored_best_move is None:
                prior_holes += 1
        elif not target.ends_game and target.eval_cp is None and target.eval_mate is None:
            prior_holes += 1
    return prior_holes


async def _apply_full_eval_results(
    session: AsyncSession,
    targets: Sequence[_FullPlyEvalTarget],
    dedup_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    is_lichess_eval_game: bool,
    preserve_existing_evals: bool = False,
    stored_eval_predates_engine: bool = False,
) -> int:
    """Write POST-MOVE evals + best_move to GamePosition rows (WR-04; SEED-044).

    preserve_existing_evals (SEED-076): submit paths that use an INCREMENTAL re-lease
    (only the still-missing positions are handed to the worker) pass True. An engine-game
    row that already carries a non-NULL DB eval but resolves to None this pass — because
    its filling position was omitted from the re-lease and the worker did not resend it —
    is then treated as already-resolved: NOT counted as a hole and NOT overwritten. The
    local drain leaves this False (it re-evaluates the whole game each tick), so its
    behavior is unchanged (zero blast radius).

    stored_eval_predates_engine (tier3-branch-b-one-ply-stamp fix — see
    derive_raw_lichess_eval_game and `_is_engine_hole`'s docstrings): threaded through
    to `_is_engine_hole` so a homogenized lichess-arm game's import-populated eval_cp
    (present even though is_lichess_eval_game reads False for it under
    BENCHMARK_HOMOGENIZE_EVAL_SOURCE) is never mistaken for "already resolved by a
    prior engine round." Defaults to False — zero blast radius for real engine games,
    which never have import-sourced data.

    Batched single-round-trip writes replace the former per-row UPDATE loop
    (FLAWCHESS-6B N+1 fix). UPDATEs run sequentially against the caller-owned
    session (CLAUDE.md hard rule: AsyncSession is not safe under asyncio.gather);
    the caller commits.

    Convention (SEED-044): a row stores the eval of the position AFTER its move
    (post-move), matching lichess `%eval` and the flaw classifier. We resolve a
    position-keyed eval for every target (incl. the terminal eval-donor), then
    write row k's eval from `pos_eval[k + 1]` via `_post_move_eval` — the single
    +1 shift site. best_move stays decision-ply-keyed (best move FROM row k's
    position), so it is NOT shifted.

    is_lichess_eval_game gate (lichess_evals_at IS NOT NULL, D-117-07):
    - is_lichess_eval_game=True: lichess %evals are already post-move and
      authoritative — NEVER shifted or overwritten. Only best_move
      (engine-supplied; lichess lacks it) is written, for every non-terminal ply
      the full MultiPV-2 pass covers (Phase 174-06 / SEED-109 — the prior
      flaw-adjacent-only write is retired). A ply the engine genuinely failed on
      counts as a hole (see the is_lichess_eval_game branch below) instead of
      being silently left NULL forever.
    - is_lichess_eval_game=False: engine games get the full post-move eval written.

    Returns the number of failed (NULL-hole) plies — engine games AND, since
    Phase 174-06, lichess-eval games too (a NULL best_move on an engine-covered
    ply). Sentry reporting is the caller's responsibility — ONE aggregated event
    per game, never per ply (WR-05).
    """
    # Position-keyed resolve for every target (incl. the terminal eval-donor),
    # then the post-move +1 shift at write time (SEED-044).
    pos_eval: dict[int, tuple[int | None, int | None]] = {}
    best_move_by_ply: dict[int, str | None] = {}
    for target in targets:
        eval_cp, eval_mate, best_move, _pv_string = _resolve_full_eval(
            target, dedup_map, engine_result_map
        )
        # _pv_string intentionally discarded here: pv is written ONLY at flaw-adjacent
        # plies (ply = flaw_ply + 1) in _classify_and_fill_oracle below (D-117-02).
        pos_eval[target.ply] = (eval_cp, eval_mate)
        if not target.is_terminal:
            best_move_by_ply[target.ply] = best_move

    # Collect write-rows in one pass; emit batched UPDATEs after the loop.
    # Two groups (FLAWCHESS-6B):
    #   bm_only_rows  — lichess plies (best_move-only) + engine hole-rows w/ best_move
    #   eval_rows     — engine plies with a resolved eval (eval_cp/eval_mate + best_move)
    # failed_ply_count is accumulated in the same pass (pure Python; no DB I/O here).
    game_id = next((t.game_id for t in targets if not t.is_terminal), 0)
    bm_only_rows: list[tuple[int, str]] = []
    eval_rows: list[tuple[int, int | None, int | None, str | None]] = []
    failed_ply_count = 0

    for target in targets:
        if target.is_terminal:
            # Eval-only donor: its eval already lives in pos_eval as the last
            # real row's after-eval. It has no game_positions row to write.
            continue

        ply = target.ply
        best_move = best_move_by_ply.get(ply)

        if is_lichess_eval_game:
            # Preserve lichess %evals (post-move, authoritative); write best_move only.
            #
            # Hole-counting parity (Phase 174-06 / SEED-109 item 3): under the full
            # MultiPV-2 pass (Task 1) every non-terminal ply of a lichess-eval game is
            # ALWAYS engine-evaluated (dedup_map is always empty for these games), so a
            # NULL best_move here means the engine genuinely FAILED on this ply, not
            # "filtered out and never attempted." Count it as a hole so
            # apply_completion_decision holds the game back for a bounded retry (Path
            # B/C, SEED-045), exactly like an engine-game hole — otherwise a single
            # genuine Stockfish failure would self-terminate the game out of the
            # 174-07 best-move-coverage lottery with a permanent NULL best_move and no
            # retry, on the SAME tick that stamps full_pv_completed_at.
            #
            # WR-01: the hole decision is gated through `_is_lichess_best_move_hole`
            # (parity with the engine branch's `_is_engine_hole` below) so an
            # already-resolved ply that a re-lease worker transiently re-fails under
            # preserve_existing_evals is not miscounted as a fresh hole.
            if best_move is not None:
                bm_only_rows.append((ply, best_move))
            elif _is_lichess_best_move_hole(target, preserve_existing_evals):
                failed_ply_count += 1
            continue

        # Engine game: store the POST-MOVE eval (eval of the position AFTER this
        # move = pos_eval[ply + 1]); best_move stays decision-ply-keyed. best_move is
        # written whenever available, INDEPENDENT of the eval — an engine hole at the
        # after-position (ply + 1) must not drop this row's own best_move (SEED-044).
        eval_cp, eval_mate = _post_move_eval(pos_eval, ply)

        if eval_cp is None and eval_mate is None:
            # WR-04: hole-vs-legitimate-NULL decision extracted to `_is_engine_hole`
            # (SEED-049 ends_game / SEED-076 preserve_existing_evals cases return
            # False; D-116-07 genuine engine hole returns True — see that function's
            # docstring for the full rationale). best_move is written whenever
            # available in EVERY case here, independent of hole status (SEED-044) —
            # only failed_ply_count's increment is conditional on the hole decision.
            if _is_engine_hole(target, preserve_existing_evals, stored_eval_predates_engine):
                failed_ply_count += 1
            if best_move is not None:
                bm_only_rows.append((ply, best_move))
        else:
            # Eval resolved: include best_move in the eval group (may be None — writing
            # NULL over NULL is safe; both values come from the same target pass so no
            # in-flight best_move is discarded).
            eval_rows.append((ply, eval_cp, eval_mate, best_move))

    # Emit batched UPDATEs — O(1) round-trips per game (FLAWCHESS-6B).
    # Empty lists are guarded inside each helper (no zero-row VALUES statement).
    await _batch_update_best_move_rows(session, game_id, bm_only_rows)
    await _batch_update_eval_rows(session, game_id, eval_rows)

    return failed_ply_count


async def _mark_full_evals_completed(session: AsyncSession, game_id: int) -> None:
    """Mark one game as fully analyzed (EVAL-05, Phase 119 SEED-045).

    Called only when no non-terminal holes remain (failed_ply_count == 0) OR when
    full_eval_attempts reaches MAX_EVAL_ATTEMPTS (cap path). D-116-07 invariant
    preserved: a deterministically-unevaluable ply cannot loop forever — the cap
    stamps anyway after MAX_EVAL_ATTEMPTS ticks. One UPDATE per game (single tick).
    """
    now_ts = datetime.now(timezone.utc)
    games_table = Game.__table__
    stmt = (
        update(games_table)  # ty: ignore[invalid-argument-type]
        .where(games_table.c.id == game_id)
        .values(full_evals_completed_at=now_ts)
    )
    await session.execute(stmt)


async def _mark_full_pv_completed(session: AsyncSession, game_id: int) -> None:
    """Mark one game's best_move/PV as written (D-117-12 second completion dimension).

    Mirrors _mark_full_evals_completed. Set after best_move is written for all
    plies and flaw PVs are written at flaw-adjacent positions.
    """
    now_ts = datetime.now(timezone.utc)
    games_table = Game.__table__
    stmt = (
        update(games_table)  # ty: ignore[invalid-argument-type]
        .where(games_table.c.id == game_id)
        .values(full_pv_completed_at=now_ts)
    )
    await session.execute(stmt)


async def _mark_best_moves_completed(session: AsyncSession, game_id: int) -> None:
    """Mark one game's best-move pass as attempted (Phase 176 BACK-01/D-01).

    Mirrors _mark_full_pv_completed exactly. Called from apply_completion_decision
    on Path A/C ONLY when maia_available is True (the guardrail) — a Maia-absent
    backend must never stamp this, or the game would be permanently excluded from
    the tier-4b backfill lottery with zero best-move rows.
    """
    now_ts = datetime.now(timezone.utc)
    games_table = Game.__table__
    stmt = (
        update(games_table)  # ty: ignore[invalid-argument-type]
        .where(games_table.c.id == game_id)
        .values(best_moves_completed_at=now_ts)
    )
    await session.execute(stmt)


async def apply_completion_decision(
    write_session: AsyncSession,
    *,
    game_id: int,
    job_id: int | None,
    failed_ply_count: int,
    current_attempts: int,
    source: Literal["full_eval_drain", "remote_eval_worker"],
    on_path_c_capacity_reached: Callable[[int, int, int, str], None],
    maia_available: bool = False,
    prior_failed_ply_count: int | None = None,
) -> bool:
    """Apply the shared Path A/B'/B/C completion decision + guarded eval_jobs stamp (R1).

    Both live write lanes (_full_drain_tick / _apply_atomic_submit, via apply_full_eval
    below) branch on the identical SEED-045 bounded-retry invariant — this function is
    that shared decision, called inside the caller's own write_session (T-117-11: all
    writes commit atomically with the evals/flaws already written this tick).

    Decision tree:
      A.  failed_ply_count == 0 -> no holes: stamp both completion markers, plus
          best_moves_completed_at IFF maia_available (Phase 176 BACK-01/D-01
          guardrail — see maia_available below). full_eval_attempts unchanged.
      B'. made_progress (SEED-139 item 3) -> the persistent DB hole count strictly
          DECREASED this round. Leave pending, do NOT write full_eval_attempts at
          all (no UPDATE on the games row), and do NOT reach Path C. A submit that
          is making progress must never be charged nor capped.
      B.  failed_ply_count > 0 AND NOT made_progress AND current_attempts + 1 <
          MAX_EVAL_ATTEMPTS -> under cap: do NOT stamp either marker. Increment
          full_eval_attempts so the game is re-picked next tick with a fresh look
          at the same budget.
      C.  failed_ply_count > 0 AND NOT made_progress AND current_attempts + 1 >=
          MAX_EVAL_ATTEMPTS -> cap reached: stamp anyway (D-116-07 no-infinite-loop
          invariant), including best_moves_completed_at IFF maia_available, and
          invoke the caller-supplied on_path_c_capacity_reached callback exactly
          once. This is the EXPECTED terminal state of the bounded-retry drain,
          not an error.

    SEED-139 item 3 — why the charge is per-ROUND, not per-SUBMIT: prod logs
    showed one game Path-C-submitted by two different workers seconds apart — a
    slow worker overran LEASE_TTL_SECONDS = 120, a second worker re-claimed the
    same lease, and BOTH submitted, spending two of the three attempts in a
    single round even though the second submit only re-confirmed work the first
    had already done. `made_progress` (`prior_failed_ply_count is not None and
    failed_ply_count < prior_failed_ply_count`) removes exactly that waste: a
    submit that reduces the game's persistent hole count is never charged.

    D-03 termination proof (verbatim in substance): under `preserve_existing_evals
    =True` the write never replaces a non-NULL eval with NULL (see `_is_engine_hole`
    / `_is_lichess_best_move_hole`), so `failed_ply_count < prior_failed_ply_count`
    implies the game's persistent DB hole count strictly decreased. That count is
    bounded below by 0, so at most `ply_count` charge-free (B') rounds can occur;
    every round that does NOT reduce it charges an attempt (B/C), so the game
    still reaches Path C after at most `ply_count + MAX_EVAL_ATTEMPTS` submits.
    The retry loop still terminates.

    prior_failed_ply_count contract: None means "unknown, charge as before" — any
    caller that does not thread it through (the drain lane, D-01: its
    failed_ply_count is not a comparable snapshot — see apply_full_eval's D-01
    comment) keeps today's per-submit-charge behavior with zero blast radius.

    maia_available (Phase 176 BACK-01/D-01, THE guardrail): whether the process-
    wide Maia session was loaded (maia_engine.is_maia_available()) at the time
    apply_full_eval built best_move_rows. best_moves_completed_at is stamped on
    Path A/C ONLY when this is True — a Maia-absent backend must NEVER stamp it,
    or the game would be permanently excluded from the tier-4b backfill lottery
    with zero best-move rows (_build_best_move_candidates returns [] for BOTH
    "Maia ran, zero candidates" and "Maia absent" — row count alone cannot
    distinguish them). The stamp is source-agnostic (fires regardless of
    is_lichess_eval_game) — the lichess exclusion lives ONLY in the tier-4b
    lottery predicate, never here, mirroring full_pv_completed_at's own
    unconditional stamping. Defaults to False so any caller that does not thread
    this through explicitly gets the SAFE behavior (never stamps).

    Path-C reporting is deliberately NOT unified: eval_drain.py's in-process tick
    uses logger.warning (FLAWCHESS-5V — an earlier per-tick Sentry call burned the
    error quota reporting this expected, non-bug outcome); eval_remote.py's atomic
    submit uses sentry_sdk.capture_message. on_path_c_capacity_reached is the
    caller-injected callback so each lane keeps its own mechanism; source is
    threaded through to the callback (e.g. for a Sentry tag) rather than used to
    branch reporting behavior here.

    eval_jobs stamp: only when stamp_complete AND job_id is not None (tier-3
    derived claims have no job row). The `WHERE status = 'leased'` guard makes a
    late/expired-lease submit (lease already re-claimed or already completed) a
    safe no-op — it can never complete an unrelated job (T-150-LEASE).

    Returns:
        stamp_complete — True when both completion markers were stamped this
        call (Path A or C); False when the game is left pending (Path B).
    """
    new_attempts = current_attempts + 1
    games_table = Game.__table__
    made_progress = prior_failed_ply_count is not None and failed_ply_count < prior_failed_ply_count

    if failed_ply_count == 0:
        # Path A: no holes — stamp both markers complete.
        await _mark_full_evals_completed(write_session, game_id)
        await _mark_full_pv_completed(write_session, game_id)
        if maia_available:
            await _mark_best_moves_completed(write_session, game_id)
        stamp_complete = True
    elif made_progress:
        # Path B' (SEED-139 item 3): holes remain but the persistent DB hole
        # count strictly decreased this round — charge-free. No UPDATE on the
        # games row at all (full_eval_attempts untouched), and Path C can never
        # fire on a progress-making submit.
        stamp_complete = False
    elif new_attempts < MAX_EVAL_ATTEMPTS:
        # Path B: holes remain, no progress, under cap — increment attempts,
        # leave pending. Do NOT stamp full_evals_completed_at or
        # full_pv_completed_at.
        await write_session.execute(
            update(games_table)  # ty: ignore[invalid-argument-type]
            .where(games_table.c.id == game_id)
            .values(full_eval_attempts=new_attempts)
        )
        stamp_complete = False
    else:
        # Path C: holes remain AND cap reached — stamp anyway (D-116-07 no-loop
        # invariant). Reporting is caller-injected — see docstring above.
        await _mark_full_evals_completed(write_session, game_id)
        await _mark_full_pv_completed(write_session, game_id)
        if maia_available:
            await _mark_best_moves_completed(write_session, game_id)
        on_path_c_capacity_reached(game_id, failed_ply_count, new_attempts, source)
        stamp_complete = True

    # QUEUE-06: report the leased job as complete only when stamp_complete (Path
    # A/C). Path B (holes remain) is deliberately NOT stamped — the eval_jobs row
    # stays 'leased' until the sweep requeues it after the TTL. The WHERE
    # status='leased' guard (T-150-LEASE) makes a late/expired-lease submit a
    # no-op — it never corrupts an unrelated job. Tier-3 derived claims have no
    # job row (job_id is None), so this block is skipped and the game is
    # naturally re-derived next tick.
    if stamp_complete and job_id is not None:
        jobs_table = EvalJob.__table__
        now_ts = datetime.now(timezone.utc)
        await write_session.execute(
            update(jobs_table)  # ty: ignore[invalid-argument-type]
            .where(
                jobs_table.c.id == job_id,
                jobs_table.c.status == "leased",
            )
            .values(status="completed", completed_at=now_ts)
        )

    return stamp_complete


async def _classify_and_fill_oracle(
    session: AsyncSession,
    game_id: int,
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    flaw_pv_blobs: dict[int, tuple[list[PvNode], list[PvNode]]] | None = None,
    blobs_pending: bool = False,
) -> None:
    """Classify game_flaws and fill oracle count columns for one engine-analyzed game (EVAL-06).

    Runs inside the Step 4 write session (same transaction as _apply_full_eval_results)
    so flaw rows, oracle counts, and flaw PVs commit atomically with the evals (T-117-11).

    Steps:
    1. Load game + ordered positions from the write session.
    2. classify_game_flaws — emits FlawRecord for M+B across both players.
    3. Phase 150 R3: per-ply 4-way diff/upsert against the existing game_flaws rows
       (replaces the old delete-then-insert) — see "Diff/upsert" below.
    4. count_game_severities × 2 (white then black) to get inaccuracy counts.
    5. UPDATE games oracle columns (white/black inaccuracies/mistakes/blunders).
    6. For each FlawRecord at ply N, write game_positions.pv at ply N+1 (D-117-02,
       Pitfall 4 off-by-one: pv belongs to the position AFTER the flaw was played).

    Diff/upsert (D-01..D-04, replaces delete_flaws_for_game + bulk_insert_game_flaws):
    the full/oracle pass is still authoritative and still fully REPLACES the
    non-blob columns of any entry-pass row (see the "entry-pass replaced" scenario
    in tests/services/test_flaw_upsert_equivalence.py), but blob/tactic-tag
    preservation is now a NATIVE property of the write instead of a caller-side
    snapshot/restore compensation layer (D-03). `freshly_blobbed` — plies this
    pass produced a REAL continuation blob for (allowed or missed non-empty in
    flaw_pv_blobs) — is the fresh-vs-preserve discriminator, computed here from
    the flaw_pv_blobs parameter directly (no longer read back from a caller-side
    snapshot). Partitioned into 4 buckets against `existing_plies` (SELECT ply
    FROM game_flaws WHERE game_id/user_id, read before mutating):
      1. DELETE `existing_plies - desired_plies` (no longer a flaw) — a clean
         per-ply `DELETE ... WHERE ply IN (...)`, never a bulk-update-by-PK (that
         asserts exactly one row matched and raises StaleDataError on a 0-row
         match — FLAWCHESS-8D).
      2. INSERT `desired_plies - existing_plies` (brand new flaws) via the
         unchanged flaw_record_to_row + bulk_insert_game_flaws — nothing to
         preserve for a ply that never existed before.
      3/4. UPDATE `desired_plies & existing_plies`, split by freshly_blobbed:
         freshly-blobbed rows get the full row (fresh tactic-tag columns too);
         not-freshly-blobbed rows get the row with FLAW_BLOB_COLUMNS keys
         EXCLUDED from the dict entirely — SQLAlchemy's ORM bulk-update-by-PK
         only SETs columns present in each row dict, so the 8 tactic-tag columns
         are simply never mentioned in the SQL SET clause (preservation-by-
         omission). The 2 PV-line JSONB columns are handled the same way, folded
         into the blob write below rather than a separate caller-side restore —
         never a `COALESCE(EXCLUDED.col, ...)` upsert (a bound Python None
         serializes as a real json `null`, not SQL NULL, via asyncpg —
         project_asyncpg_jsonb_null_vs_sql_null — which would silently wipe
         every preserved blob on the first upsert).
    The PV-line write (allowed_pv_lines/missed_pv_lines) runs INSIDE this
    function immediately after the row partition, via _batch_update_flaw_pv_lines,
    filtered to exclude "preserve" plies (existing, not freshly blobbed) — a
    ply's blob columns are therefore never even written a D-06 `[]` sentinel in
    the first place when it should be preserved, so there is nothing to restore
    afterward. This folds what used to be the caller's separate _run_multipv2_pass
    call into the diff/upsert itself (D-03: the write is fully self-contained);
    callers no longer call _run_multipv2_pass separately (deleted, Plan 04).

    Args:
        session: Write session (same transaction as _apply_full_eval_results).
        game_id: The game being classified.
        engine_result_map: {ply -> (eval_cp, eval_mate, best_move, pv_string)} from
            the engine pass — PVs are not yet in game_positions at classify time.
        flaw_pv_blobs: Optional {flaw_ply -> (allowed_blob, missed_blob)} MultiPV-2
            blobs built in memory by _build_flaw_multipv2_blobs (Phase 142, D-02).
            MUST be passed from the call site — blobs are NOT yet in the DB when
            classify runs (Pitfall 4: classify precedes the blob write below).
            When None (old games without blobs, or nothing assembled this pass),
            the gate is skipped for all flaws and freshly_blobbed is empty (every
            existing ply's blob/tactic columns are preserved-by-omission).
        blobs_pending: Phase 147 (D-01/D-03) — forwarded unchanged to
            classify_game_flaws. Defaults to False (local drain / discovery
            behavior unchanged, D-05). The remote go-forward call site — the
            /atomic-submit handler in app/routers/eval_remote.py (named
            _apply_submit before Phase 149-03 PRUNE-01 deleted the Gen-1 pair) —
            passes True so cp-based flaws whose continuation blob is deferred to
            the tier-4 pass are suppressed to NULL instead of persisted
            raw/ungated.

    Errors in the flaw delete/insert/update statements and the oracle-count UPDATE
    are intentionally NOT caught here — they must propagate to the caller so the
    write-session transaction is aborted and the completion markers
    (_mark_full_evals_completed / _mark_full_pv_completed) are NOT committed
    (WR-01). Only the per-flaw PV writes (both game_positions.pv below and the
    game_flaws blob write above) are individually fault-tolerant (a single bad PV
    row must not abort the whole game).

    T-108-04 still applies at the drain-tick level: _full_drain_tick wraps the entire
    write phase in its own exception boundary so one bad game never aborts the drain.
    """
    loaded = await _load_game_and_positions(session, game_id)
    if loaded is None:
        return
    game, positions = loaded

    flaw_result, freshly_blobbed = await _classify_flaw_rows(
        game, positions, engine_result_map, flaw_pv_blobs, blobs_pending
    )
    if "reason" in flaw_result:
        # GameNotAnalyzed: insufficient eval coverage — skip.
        return
    flaw_list = flaw_result  # list[FlawRecord]

    # existing_plies / already_blobbed_plies MUST be read here, in the orchestrator,
    # BEFORE _diff_upsert_flaw_rows runs its DELETE — this is the read-before-delete
    # ordering the split must preserve (RESEARCH.md "eval_apply.py -- three
    # verified/corrected invariants" #1; PATTERNS.md "Hazard -- ordering constraint").
    # Passed as arguments so the ordering survives the function boundary rather than
    # being re-derived (and potentially re-read post-delete) inside the helper.
    existing_plies = set(
        (
            await session.scalars(
                select(GameFlaw.ply).where(
                    GameFlaw.game_id == game.id,
                    GameFlaw.user_id == game.user_id,
                )
            )
        ).all()
    )
    # Only a ply that ALREADY carries a real blob (allowed_pv_lines IS NOT NULL) has
    # anything worth preserving — mirrors the gate the deleted caller-side snapshot
    # helper used to apply (see the diff/upsert docstring section above).
    already_blobbed_plies = set(
        (
            await session.scalars(
                select(GameFlaw.ply).where(
                    GameFlaw.game_id == game.id,
                    GameFlaw.user_id == game.user_id,
                    GameFlaw.allowed_pv_lines.isnot(None),
                )
            )
        ).all()
    )

    await _diff_upsert_flaw_rows(
        session,
        game,
        flaw_list,
        existing_plies,
        already_blobbed_plies,
        freshly_blobbed,
        flaw_pv_blobs,
    )

    oracle_counts_written = await _write_oracle_counts(session, game, positions)
    if not oracle_counts_written:
        # Shouldn't happen (same coverage gate as classify_game_flaws), but be defensive.
        return

    # Stage 5 (D-117-02 / SEED-054): flaw PV write, dedup by ply, one batched UPDATE.
    # Extracted to _write_flaw_pvs — see its docstring for the full ply-N/ply-N+1
    # rationale and the fault-tolerance reasoning for the try/except boundary.
    await _write_flaw_pvs(session, game_id, flaw_list, engine_result_map)

    # SEED-125: unconditional, end-of-function refresh of the games-side blob
    # completion stamp. Deliberately NOT hooked onto the `if flaw_pv_blobs:`
    # branch inside _diff_upsert_flaw_rows (its _batch_update_flaw_pv_lines call)
    # -- a submit carrying zero blobs (the local-drain `blobs_pending=True` path)
    # can insert NULL-blob plies (via _diff_upsert_flaw_rows above) without ever
    # entering that branch, which would leave a reclassified game wrongly stamped
    # complete. This is also the clear-direction site for tier-3 branch (b):
    # it picks lichess-eval games whose full_evals_completed_at is already
    # stamped, and the diff/upsert reclassification above can insert a fresh
    # NULL-blob ply on a game that already carries a blobs_completed_at stamp
    # from an earlier tier-4 pass.
    # (Comment fixed 214-05 Task 2: this used to say "delete-then-insert
    # reclassification" -- stale since the Phase 150 R3 diff/upsert rewrite; see
    # the diff/upsert docstring above for what the write actually does.)
    await _refresh_blobs_completed(session, game_id)


async def _load_game_and_positions(
    session: AsyncSession, game_id: int
) -> tuple[Game, list[GamePosition]] | None:
    """Stage 1 of `_classify_and_fill_oracle`: load the game row and its ordered positions.

    Returns None when the game does not exist (mirrors the orchestrator's original
    `if game is None: return` guard) so positions are never queried for a missing game.
    """
    game_result = await session.execute(select(Game).where(Game.id == game_id))
    game = game_result.scalar_one_or_none()
    if game is None:
        return None

    positions_result = await session.execute(
        select(GamePosition)
        .where(
            GamePosition.game_id == game.id,
            GamePosition.user_id == game.user_id,
        )
        .order_by(GamePosition.ply)
    )
    positions = list(positions_result.scalars().all())
    return game, positions


async def _classify_flaw_rows(
    game: Game,
    positions: list[GamePosition],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    flaw_pv_blobs: dict[int, tuple[list[PvNode], list[PvNode]]] | None,
    blobs_pending: bool,
) -> tuple[GameFlawsResult, set[int]]:
    """Stage 2 of `_classify_and_fill_oracle`: classify_game_flaws + freshly_blobbed.

    Returns the raw `GameFlawsResult` (list[FlawRecord] or a GameNotAnalyzed "reason"
    dict) unchanged so the orchestrator keeps its own "reason" in flaw_result guard,
    plus the freshly_blobbed ply set used by the diff/upsert stage.
    """
    # Live tactic tagging (260618-aiq): the freshly-computed PVs in
    # engine_result_map are NOT yet written to game_positions at this point (the
    # batched PV UPDATE below runs after classify). _detect_tactic_for_flaw reads
    # the PV at flaw_ply+1, so without this override every live classify would see
    # pv=NULL and tag tactic_motif=NULL until a later backfill_flaws.py run. Pass
    # the in-memory PVs (ply -> pv_string) so the drain tags tactics on the fly.
    pv_by_ply: dict[int, str] = {
        ply: entry[3] for ply, entry in engine_result_map.items() if entry[3] is not None
    }

    # Phase 143 D-02: pass in-memory blobs to route classify through _classify_tactic_gated.
    # Blobs are NOT yet in the DB here (Pitfall 4: classify precedes the blob write below).
    flaw_result = classify_game_flaws(
        game,
        positions,
        pv_by_ply=pv_by_ply,
        flaw_pv_blobs=flaw_pv_blobs,
        blobs_pending=blobs_pending,
    )
    if "reason" in flaw_result:
        return flaw_result, set()

    # D-03: freshly_blobbed — plies this pass produced a REAL (non-empty) blob
    # for on at least one line — is the fresh-vs-preserve discriminator. A ply
    # present in flaw_pv_blobs with BOTH lines empty (the D-06 "un-walkable this
    # pass" sentinel) is NOT freshly blobbed: if it already had a real blob from a
    # prior pass, that blob must survive, not be overwritten by the sentinel.
    freshly_blobbed: set[int] = (
        {ply for ply, (allowed, missed) in flaw_pv_blobs.items() if allowed or missed}
        if flaw_pv_blobs
        else set()
    )
    return flaw_result, freshly_blobbed


async def _diff_upsert_flaw_rows(
    session: AsyncSession,
    game: Game,
    flaw_list: Sequence[FlawRecord],
    existing_plies: set[int],
    already_blobbed_plies: set[int],
    freshly_blobbed: set[int],
    flaw_pv_blobs: dict[int, tuple[list[PvNode], list[PvNode]]] | None,
) -> None:
    """Stage 3 of `_classify_and_fill_oracle`: the 4-way diff/upsert against
    `existing_plies` (Phase 150 R3) -- DELETE / INSERT / UPDATE-fresh /
    UPDATE-preserve-by-omission, plus the PV-line blob write. See the diff/upsert
    docstring on `_classify_and_fill_oracle` for the full column-preservation
    rationale. `existing_plies` and `already_blobbed_plies` are received as
    arguments -- the orchestrator reads them BEFORE calling this function, and this
    function's own DELETE below must never re-derive them post-delete.
    """
    rows_by_ply: dict[int, dict[str, Any]] = {
        flaw["ply"]: flaw_record_to_row(user_id=game.user_id, game_id=game.id, flaw=flaw)
        for flaw in flaw_list
    }
    desired_plies = set(rows_by_ply)
    # D-03: a ply preserves its blob + tactic-tag columns only if it already had a
    # real blob AND this pass did not freshly re-blob it.
    preserve_plies = already_blobbed_plies - freshly_blobbed

    # 1. Delete plies no longer classified as flaws — clean per-ply DELETE, never a
    # bulk-update-by-PK (FLAWCHESS-8D: a 0-row-matched bulk update raises
    # StaleDataError, not the silent no-op an earlier docstring assumed).
    # Bug fix (WR-01): DB errors here MUST propagate — see docstring above.
    await delete_flaw_plies(
        session,
        game_id=game.id,
        user_id=game.user_id,
        plies=existing_plies - desired_plies,
    )

    # 2. Insert newly-classified plies (nothing to preserve — they never existed).
    # Bug fix (WR-01): DB errors here MUST propagate — a failure at this point
    # means no flaw rows were inserted; catching it would let the caller commit
    # the completion markers and permanently mark the game done with no flaws.
    new_plies = desired_plies - existing_plies
    await bulk_insert_game_flaws(session, [rows_by_ply[ply] for ply in new_plies])

    # 3/4. Update plies that survive as flaws across both passes, split by
    # preserve_plies: preserved rows get FLAW_BLOB_COLUMNS keys excluded entirely
    # from the dict so those 8 tactic-tag columns are never mentioned in the SQL
    # SET clause (preservation-by-omission, D-03/D-04); every other update-ply
    # (freshly blobbed, or never had a real blob to protect) gets the full row.
    update_plies = desired_plies & existing_plies
    fresh_rows = [rows_by_ply[ply] for ply in update_plies if ply not in preserve_plies]
    preserve_rows = [
        {k: v for k, v in rows_by_ply[ply].items() if k not in FLAW_BLOB_COLUMNS}
        for ply in update_plies
        if ply in preserve_plies
    ]
    await bulk_update_game_flaw_rows(session, fresh_rows)
    await bulk_update_game_flaw_rows(session, preserve_rows)

    # PV-line blob write (allowed_pv_lines/missed_pv_lines): folds the old
    # caller-side _run_multipv2_pass call into the diff/upsert itself (D-03 — the
    # write is fully self-contained). Filtered to exclude preserve_plies so an
    # already-blobbed ply this pass did not re-blob never even gets a D-06 `[]`
    # sentinel written over its real blob in the first place — there is nothing
    # to restore afterward, unlike the old snapshot-then-restore compensation layer.
    if flaw_pv_blobs:
        blobs_to_write = {
            ply: blob for ply, blob in flaw_pv_blobs.items() if ply not in preserve_plies
        }
        await _batch_update_flaw_pv_lines(session, game.id, blobs_to_write)


async def _write_oracle_counts(
    session: AsyncSession, game: Game, positions: list[GamePosition]
) -> bool:
    """Stage 4 of `_classify_and_fill_oracle`: the two `count_game_severities` calls
    and the single `UPDATE games` oracle-column write.

    Returns False (skipping the UPDATE) when either color's counts carry a "reason"
    key -- the orchestrator's own guard mirrors this return value, matching the
    original inline `if "reason" in counts_white or "reason" in counts_black: return`.

    Takes `game` only (no separate `game_id` param, WR-01, 214-REVIEW.md): the
    caller always loads `game` via `select(Game).where(Game.id == game_id)`, so
    a second parameter carrying the same value could silently desync from
    `game.id` on a future edit. `game.id` is used directly in the `WHERE` clause.
    """
    # Oracle count columns: count_game_severities reads only game.user_color.
    # Call twice with a swapped-color view (no DB I/O in count_game_severities —
    # it's pure Python over already-loaded positions).
    counts_white = count_game_severities(
        _GameColorView(game, "white"),  # ty: ignore[invalid-argument-type]  # reads only user_color
        positions,
    )
    counts_black = count_game_severities(
        _GameColorView(game, "black"),  # ty: ignore[invalid-argument-type]  # reads only user_color
        positions,
    )

    # Use "reason" key as the TypedDict discriminator (isinstance on TypedDict raises TypeError).
    if "reason" in counts_white or "reason" in counts_black:
        # Shouldn't happen (same coverage gate as classify_game_flaws), but be defensive.
        return False

    # Phase 178 Plan 03: lichess-compatible accuracy/ACPL (D-01/D-03/D-04). Reuses
    # the SAME already-loaded `positions` list — zero extra query — and calls the
    # single shared compute path (Plan 02) that the backfill script also uses.
    # The compute's own Complete-Sequence Gate is authoritative: it returns None on
    # an interior eval hole (or a 0-move game) regardless of this pass's completion
    # stamp, so a holed game correctly leaves all four columns NULL (D-03) while the
    # oracle-count UPDATE below still executes unconditionally.
    accuracy_acpl_result = compute_game_accuracy_acpl(positions)

    games_table = Game.__table__
    # Bug fix (WR-01): DB errors here MUST propagate — if the oracle-count UPDATE
    # fails the game must be retried, not silently marked complete with NULL counts.
    await session.execute(
        update(games_table)  # ty: ignore[invalid-argument-type]
        .where(games_table.c.id == game.id)
        .values(
            white_inaccuracies=counts_white["inaccuracy"],
            white_mistakes=counts_white["mistake"],
            white_blunders=counts_white["blunder"],
            black_inaccuracies=counts_black["inaccuracy"],
            black_mistakes=counts_black["mistake"],
            black_blunders=counts_black["blunder"],
            white_accuracy=(
                accuracy_acpl_result.white_accuracy if accuracy_acpl_result is not None else None
            ),
            black_accuracy=(
                accuracy_acpl_result.black_accuracy if accuracy_acpl_result is not None else None
            ),
            white_acpl=(
                accuracy_acpl_result.white_acpl if accuracy_acpl_result is not None else None
            ),
            black_acpl=(
                accuracy_acpl_result.black_acpl if accuracy_acpl_result is not None else None
            ),
        )
    )
    return True


async def _write_flaw_pvs(
    session: AsyncSession,
    game_id: int,
    flaw_list: Sequence[FlawRecord],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
) -> None:
    """Stage 5 of `_classify_and_fill_oracle`: flaw PV write, dedup by ply (D-117-02 /
    SEED-054), one batched UPDATE.

    For each FlawRecord at ply N, write pv at BOTH ply N and ply N+1:
      - ply N    = the ideal-continuation line from the pre-blunder decision board
                   (latent until a frontend surface renders it — SEED-054 Part 2).
      - ply N+1  = the refutation line from the post-blunder board (D-117-02, the
                   SEED-039 tactic-motif input).
    Each pv_string comes from engine_result_map at its OWN ply. Post-174-06 (SEED-109
    Option C) lichess-eval games run the full MultiPV-2 pass, so ply N is engine-evaluated
    like every other ply (the old _flaw_engine_plies selective path is retired); for
    chess.com every ply already ran. Opening dedup-transplanted plies are absent
    from engine_result_map → pv stays NULL there (acceptable per SEED-054). Deduped
    by ply: consecutive flaws can make one flaw's ply N collide with another's N+1.

    FLAWCHESS-6B: collect surviving (ply, pv_string) pairs, then ONE batched UPDATE
    via _batch_update_pv_rows.

    Fault tolerance rationale: batching trades per-row isolation for one round-trip —
    acceptable because pv is unbounded Text (PostgreSQL won't reject it at the column
    level), so the realistic failure mode is a DB connection error that would have
    invalidated the whole session anyway, not a single bad row. The surviving rows
    commit atomically with the flaw rows and oracle counts written by the caller
    (T-117-11). If the batched execute fails, flaw rows + oracle counts are NOT
    rolled back — both the old code and this function are inside the caller's
    write_session transaction; asyncpg-level errors invalidate the whole session
    regardless.
    """
    flaw_pv_by_ply: dict[int, str] = {}
    for flaw in flaw_list:
        flaw_ply_val: int = flaw["ply"]
        for cand_ply in (flaw_ply_val, flaw_ply_val + 1):
            if cand_ply in flaw_pv_by_ply:
                continue
            engine_entry = engine_result_map.get(cand_ply)
            if engine_entry is None:
                continue
            _cp, _mt, _bm, pv_string = engine_entry
            if pv_string is None:
                continue
            flaw_pv_by_ply[cand_ply] = pv_string

    if flaw_pv_by_ply:
        try:
            await _batch_update_pv_rows(session, game_id, list(flaw_pv_by_ply.items()))
        except Exception as exc:
            # T-108-04 / WR-01: PV write failure must not abort flaw rows + oracle
            # counts already written by the caller. Capture for visibility without
            # embedding variables in the message string (CLAUDE.md Sentry grouping rule).
            sentry_sdk.set_context(
                "classify_oracle",
                {"game_id": game_id},
            )
            sentry_sdk.set_tag("source", "full_eval_drain")
            sentry_sdk.capture_exception(exc)


async def _classify_with_overlay(
    game_id: int,
    session: AsyncSession,
    *,
    overlay: bool,
    pos_eval: dict[int, tuple[int | None, int | None]] | None = None,
) -> list[FlawRecord] | None:
    """R4: shared classify preamble — load Game + ordered GamePosition rows, optionally
    overlay in-memory post-move evals, then classify_game_flaws (used by 4 call sites).

    overlay=True (`_missing_flaw_pv_targets`, `_build_flaw_multipv2_blobs`,
    `_derive_atomic_sentinel_lines`): runs the `_post_move_eval` mutation loop,
    OVERWRITING pos.eval_cp/pos.eval_mate for every position from the caller's
    `pos_eval` map (required — `pos_eval` must be passed). Correct here because at
    this pipeline stage the DB genuinely has NULL evals for these engine-game
    positions (the batched eval write hasn't run yet), so overlaying is a required
    fill, not a destructive overwrite.

    overlay=False: skips the mutation loop entirely and classifies directly on
    whatever is already stored in game_positions. Phase 174-06: this branch has no
    current caller (the lichess-eval flaw pre-classification path that used it,
    `_flaw_engine_plies`/D-117-13, was retired once lichess-eval games moved to the
    full MultiPV-2 pass — SEED-109 Option C) — kept as a documented, tested mode
    for a future direct-classify caller, not dead weight. It remains REQUIRED
    reading for anyone tempted to re-add it for an is_lichess_eval_game game: the
    overlay=True mutation loop would build `pos_eval` from an empty/pre-gather
    engine_result_map and overwrite every lichess %eval with None, so
    classify_game_flaws would see an all-NULL game and return GameNotAnalyzed for
    every lichess game — the exact regression Phase 117's post-deploy sanity check
    caught ("0% flaw-PV coverage for analyzed lichess games").

    Uses the caller's own `session` (managed by the caller — either a short-lived
    session opened just for this load, or an already-open session the caller is
    reusing) rather than opening one internally, since call sites differ in
    session lifecycle (the 3 overlay=True sites each open+close their own).

    Returns None when the game is missing or classify reports insufficient eval
    coverage ("reason" in result — GameNotAnalyzed); otherwise the flaw list.
    """
    game = await session.scalar(select(Game).where(Game.id == game_id))
    if game is None:
        return None
    positions_result = await session.execute(
        select(GamePosition)
        .where(GamePosition.game_id == game_id, GamePosition.user_id == game.user_id)
        .order_by(GamePosition.ply)
    )
    positions = list(positions_result.scalars().all())

    if overlay:
        for pos in positions:
            cp, mate = _post_move_eval(pos_eval or {}, pos.ply)
            pos.eval_cp = cp
            pos.eval_mate = mate

    flaw_result = classify_game_flaws(game, positions)
    if "reason" in flaw_result:
        return None
    return flaw_result


def _reconstruct_pos_eval(
    targets: Sequence[_FullPlyEvalTarget],
    dedup_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
) -> dict[int, tuple[int | None, int | None]]:
    """Position-keyed eval map (eval OF each ply's position) assembled in-memory from
    the just-completed gather + the dedup transplants (SEED-056).

    Mirrors what _apply_full_eval_results will write, but with no DB round-trip, so the
    drain can pre-classify an engine game's flaws BEFORE the write session. Opening
    plies are mutually exclusive across the two maps by construction (engine_targets in
    _full_drain_tick excludes any opening ply with a dedup hit), so source precedence
    never matters here.
    """
    pos_eval: dict[int, tuple[int | None, int | None]] = {}
    for t in targets:
        engine_entry = engine_result_map.get(t.ply)
        if engine_entry is not None:
            pos_eval[t.ply] = (engine_entry[0], engine_entry[1])
        elif not t.is_terminal and t.ply <= _DEDUP_MAX_PLY and t.full_hash in dedup_map:
            cp, mate, _bm, _pv = dedup_map[t.full_hash]
            pos_eval[t.ply] = (cp, mate)
    return pos_eval


def _walk_pv_boards(
    start_board: chess.Board,
    pv_string: str | None,
    cap: int,
) -> list[chess.Board]:
    """Phase 142 MPV-02: return boards at each PV node (Option B server-side walk).

    Yields independent board copies: node 0 = copy of start_board, node k = position
    after k PV moves. Stops when a move is illegal, a UCI is malformed, or cap nodes
    are reached (cap limits nodes 1..N, so the list has at most cap+1 entries).
    """
    boards: list[chess.Board] = [start_board.copy()]
    if not pv_string:
        return boards
    for move_uci in pv_string.split()[:cap]:
        try:
            move = chess.Move.from_uci(move_uci)
            if not boards[-1].is_legal(move):
                break
            next_board = boards[-1].copy()
            next_board.push(move)
            boards.append(next_board)
        except ValueError, AssertionError:
            break
    return boards


def _placeholder_defender_node() -> PvNode:
    """SEED-079: the slim-blob odd-index (defender) placeholder node.

    The forcing-line gate reads only solver nodes (even indices, D-10), so defender
    continuation nodes are no longer engine-evaluated. To keep the gate's index-parity
    convention intact (even = solver, odd = defender), every skipped odd index is
    filled with this all-None PvNode so the stored list keeps its original indices
    and length. su must be str, never None (Pitfall 3).
    """
    return PvNode(b=None, bm=None, s=None, sm=None, su="")


def _build_line_blobs(
    flaw_ply: int,
    line: str,
    walk: list[chess.Board],
    pos_eval: dict[int, tuple[int | None, int | None]],
    second_best_map: dict[int, tuple[int | None, int | None, str | None]],
    node_eval: dict[
        tuple[int, str, int],
        tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None],
    ],
) -> list[PvNode]:
    """Phase 142 MPV-02: assemble PvNode list for one line (allowed or missed) of a flaw.

    Node 0 evals come from pos_eval + second_best_map (no engine call needed).
    SEED-079 slim scheme: only EVEN continuation nodes (2, 4, ...) come from node_eval
    (batch-gathered in _build_flaw_multipv2_blobs — odd defender boards are never
    engine-evaluated); each skipped odd index is filled with the all-None placeholder
    so the gate's index-parity convention (even = solver) stays intact. A missing even
    node_eval entry is a gap (stop), so the blob always ends on a real even node.
    su='' is the no-second-move sentinel (Pitfall 3: never None in PvNode).
    """
    if not walk:
        return []
    nodes: list[PvNode] = []
    node0_ply = flaw_ply if line == "missed" else flaw_ply + 1
    best_cp, best_mate = pos_eval.get(node0_ply, (None, None))
    second = second_best_map.get(node0_ply)
    scp, smt, su_raw = second if second else (None, None, "")
    su: str = su_raw if su_raw is not None else ""
    nodes.append(PvNode(b=best_cp, bm=best_mate, s=scp, sm=smt, su=su))
    for k in range(2, len(walk), 2):
        res = node_eval.get((flaw_ply, line, k))
        if res is None:
            break
        nodes.append(_placeholder_defender_node())  # The skipped odd index k-1.
        # su must be str (Pitfall 3): engine failure yields (None,)*7 → res[6]=None → "".
        su_k: str = res[6] if res[6] is not None else ""
        nodes.append(PvNode(b=res[0], bm=res[1], s=res[4], sm=res[5], su=su_k))
    return nodes


async def _build_flaw_multipv2_blobs(
    game_id: int,
    targets: Sequence[_FullPlyEvalTarget],
    dedup_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    second_best_map: dict[int, tuple[int | None, int | None, str | None]],
) -> dict[int, tuple[list[PvNode], list[PvNode]]]:
    """Phase 142 MPV-02: build PvNode blobs for the allowed/missed lines of each flaw.

    Loads game + positions (own read session, closed before gather), overlays in-memory
    evals (same pattern as the R4 preamble), classifies flaws, walks each flaw's PV
    using _walk_pv_boards, then evaluates ALL continuation nodes (1..N) across all flaws
    and both lines in ONE asyncio.gather. MUST be called with NO session open (CLAUDE.md
    hard rule). Returns {} on DB miss or no flaws.

    Return type: dict[flaw_ply -> (allowed_blobs, missed_blobs)].
    Node 0 of missed = position at flaw_ply; node 0 of allowed = position at flaw_ply + 1.
    """
    # R4: overlay=True (same pattern as the entry-lane PV-gap fill) so classify_game_flaws
    # sees the newly-computed evals, not the NULLs still in the DB at this point.
    pos_eval = _reconstruct_pos_eval(targets, dedup_map, engine_result_map)
    targets_by_ply = {t.ply: t for t in targets}

    async with async_session_maker() as session:
        flaw_result = await _classify_with_overlay(
            game_id, session, overlay=True, pos_eval=pos_eval
        )
    if flaw_result is None:
        return {}

    cap = engine_service.PV_CAP_PLIES

    # Collect boards for continuation nodes (k >= 1) across all flaws and both lines.
    # Batching into one gather avoids repeated session opens (CLAUDE.md).
    gather_boards: list[chess.Board] = []
    gather_keys: list[tuple[int, str, int]] = []  # (flaw_ply, "allowed"|"missed", node_k)
    walks: dict[tuple[int, str], list[chess.Board]] = {}

    for flaw in flaw_result:
        flaw_ply: int = flaw["ply"]
        if flaw_ply not in targets_by_ply:
            continue

        # SEED-079: only EVEN continuation indices (2, 4, ...) are gathered — the gate
        # reads only solver (even) nodes (D-10), so defender (odd) continuation evals
        # are dead weight. Node 0 is not gathered (comes from pos_eval).
        # Missed line: PV walk from the flaw position (board at flaw_ply).
        board_missed = targets_by_ply[flaw_ply].board.copy()
        pv_missed = engine_result_map.get(flaw_ply, (None, None, None, None))[3]
        missed_walk = _walk_pv_boards(board_missed, pv_missed, cap)
        walks[(flaw_ply, "missed")] = missed_walk
        for k in range(2, len(missed_walk), 2):
            gather_boards.append(missed_walk[k])
            gather_keys.append((flaw_ply, "missed", k))

        # Allowed line: PV walk from the position after the flaw move (board at flaw_ply + 1).
        allowed_start = flaw_ply + 1
        if allowed_start not in targets_by_ply:
            walks[(flaw_ply, "allowed")] = []
            continue
        board_allowed = targets_by_ply[allowed_start].board.copy()
        pv_allowed = engine_result_map.get(allowed_start, (None, None, None, None))[3]
        allowed_walk = _walk_pv_boards(board_allowed, pv_allowed, cap)
        walks[(flaw_ply, "allowed")] = allowed_walk
        for k in range(2, len(allowed_walk), 2):
            gather_boards.append(allowed_walk[k])
            gather_keys.append((flaw_ply, "allowed", k))

    # Evaluate all continuation boards in one gather (NO session open — CLAUDE.md hard rule).
    continuation_results: Sequence[
        tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None]
    ]
    if gather_boards:
        continuation_results = await asyncio.gather(
            *(engine_service.evaluate_nodes_multipv2(b) for b in gather_boards)
        )
    else:
        continuation_results = []

    node_eval: dict[
        tuple[int, str, int],
        tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None],
    ] = {}
    for key, res in zip(gather_keys, continuation_results, strict=True):
        node_eval[key] = res

    # Assemble PvNode blobs for each flaw.
    blobs: dict[int, tuple[list[PvNode], list[PvNode]]] = {}
    for flaw in flaw_result:
        flaw_ply = flaw["ply"]
        allowed = _build_line_blobs(
            flaw_ply,
            "allowed",
            walks.get((flaw_ply, "allowed"), []),
            pos_eval,
            second_best_map,
            node_eval,
        )
        missed = _build_line_blobs(
            flaw_ply,
            "missed",
            walks.get((flaw_ply, "missed"), []),
            pos_eval,
            second_best_map,
            node_eval,
        )
        if allowed or missed:
            blobs[flaw_ply] = (allowed, missed)
    return blobs


async def _derive_atomic_sentinel_lines(
    game_id: int,
    targets: Sequence[_FullPlyEvalTarget],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
) -> set[tuple[int, str]]:
    """Phase 147 SEED-074 Part B: re-derive un-walkable (flaw_ply, line) pairs for one
    atomic-submit game, entirely from the worker's OWN submitted evals/PVs (D-01/D-02).

    Mirrors _build_flaw_multipv2_blobs's classify+walk preamble (overlay in-memory
    evals, classify_game_flaws, walk each flaw's PV via _walk_pv_boards) but makes NO
    engine calls and stops before any continuation-node gather — the atomic-submit
    worker already supplies the MultiPV-2 continuation nodes via body.blob_nodes, so
    the caller (_apply_atomic_submit) assembles those directly via
    _assemble_flaw_blobs_from_submit. This function only classifies (server-
    authoritative, T-147-03: never trusts the worker's local hint-classify) and
    determines which (flaw_ply, line) pairs are structurally un-walkable (< 2-node
    PV walk or missing start board — D-06 sentinel semantics), independent of which
    blob_nodes tokens the worker happened to submit.

    A flaw_ply with a walkable line the worker did NOT submit any token for is
    deliberately left OUT of the returned set (not sentineled) — the caller's
    _assemble_flaw_blobs_from_submit then omits that flaw entirely from blob_map,
    letting classify_game_flaws' blobs_pending=True suppression net it to NULL
    (T-147-08 "flaw the server found but the worker did not blob" case) rather than
    incorrectly treating it as a D-06 structural sentinel.

    Opens and closes its own read session (positions with in-memory eval overlay,
    same pattern as _build_flaw_multipv2_blobs); makes no asyncio.gather calls at
    all (CLAUDE.md hard rule: AsyncSession is not safe for concurrent use — trivially
    satisfied here since there is no gather to begin with).
    """
    # R4: overlay=True (same pattern as _build_flaw_multipv2_blobs).
    pos_eval = _reconstruct_pos_eval(targets, {}, engine_result_map)
    targets_by_ply = {t.ply: t for t in targets}

    async with async_session_maker() as session:
        flaw_result = await _classify_with_overlay(
            game_id, session, overlay=True, pos_eval=pos_eval
        )
    if flaw_result is None:
        return set()

    cap = engine_service.PV_CAP_PLIES
    sentinel_lines: set[tuple[int, str]] = set()

    for flaw in flaw_result:
        flaw_ply: int = flaw["ply"]
        for line, node0_ply in [("missed", flaw_ply), ("allowed", flaw_ply + 1)]:
            start_target = targets_by_ply.get(node0_ply)
            if start_target is None:
                sentinel_lines.add((flaw_ply, line))
                continue
            pv = engine_result_map.get(node0_ply, (None, None, None, None))[3]
            walk = _walk_pv_boards(start_target.board, pv, cap)
            if len(walk) < 2:
                sentinel_lines.add((flaw_ply, line))

    return sentinel_lines


async def _batch_update_flaw_pv_lines(
    session: AsyncSession,
    game_id: int,
    blob_map: dict[int, tuple[list[PvNode], list[PvNode]]],
) -> None:
    """Phase 142 MPV-02: write allowed_pv_lines + missed_pv_lines for each flaw ply.

    One batched UPDATE mirroring _batch_update_pv_rows: CAST(:param AS jsonb) syntax for
    asyncpg compatibility (not :: cast). Does NOT catch exceptions — caller decides fault
    tolerance. Guard: empty blob_map is a no-op.
    """
    if not blob_map:
        return
    params: dict[str, Any] = {"game_id": game_id}
    values_parts: list[str] = []
    for i, (ply, (allowed_blobs, missed_blobs)) in enumerate(blob_map.items()):
        params[f"ply_{i}"] = ply
        params[f"allowed_{i}"] = json.dumps(allowed_blobs)
        params[f"missed_{i}"] = json.dumps(missed_blobs)
        values_parts.append(
            f"(CAST(:ply_{i} AS smallint), CAST(:allowed_{i} AS jsonb), CAST(:missed_{i} AS jsonb))"
        )
    values_sql = ", ".join(values_parts)
    sql = sa.text(
        f"UPDATE game_flaws"  # noqa: S608 — no user input; params are bound
        f" SET allowed_pv_lines = v.allowed_pv_lines,"
        f"     missed_pv_lines = v.missed_pv_lines"
        f" FROM (VALUES {values_sql}) AS v(ply, allowed_pv_lines, missed_pv_lines)"
        f" WHERE game_flaws.game_id = :game_id"
        f" AND game_flaws.ply = v.ply"
    )
    await session.execute(sql, params)


async def _refresh_blobs_completed(session: AsyncSession, game_id: int) -> None:
    """SEED-125: maintain `games.blobs_completed_at` BIDIRECTIONALLY.

    Probes for any remaining NULL-blob flaw ply (index-only via
    ix_game_flaws_blob_backfill, sub-ms) and stamps the games-side column
    accordingly: `now()` when no NULL-blob ply remains, NULL when one does.

    Load-bearing rule: the invariant runs in BOTH directions. A stamp-only-if-empty
    design would silently drop a reclassified game out of the tier-4 blob-backfill
    population forever — tier-3 branch (b) picks lichess-eval games whose
    full_evals_completed_at is already stamped, and _classify_and_fill_oracle's
    delete-then-insert reclassification can insert a fresh NULL-blob ply on a game
    that already carries a blobs_completed_at stamp from an earlier tier-4 pass.
    Without the clear direction that game would never be re-picked.

    Does NOT commit — the caller owns the transaction (mirrors
    _batch_update_flaw_pv_lines, not _stamp_best_moves_completed_directly).
    """
    probe = await session.execute(
        sa.text(
            "SELECT 1 FROM game_flaws WHERE game_id = :game_id AND allowed_pv_lines IS NULL LIMIT 1"
        ),
        {"game_id": game_id},
    )
    has_null_blob_flaw = probe.first() is not None
    stamp_value = None if has_null_blob_flaw else datetime.now(timezone.utc)
    await session.execute(
        sa.text("UPDATE games SET blobs_completed_at = :value WHERE id = :game_id"),
        {"value": stamp_value, "game_id": game_id},
    )


async def _build_flaw_blob_lease_positions(
    game_id: int,
) -> tuple[list[FlawBlobLeasePosition], set[tuple[int, str]]]:
    """Phase 145 SHIP-01: build lease positions for one game's NULL-blob flaws (D-04).

    Opens a READ session, loads the game PGN, flaw rows (allowed_pv_lines IS NULL),
    and game_positions PV strings at {flaw_ply, flaw_ply+1} for each flaw.
    Closes the session, then replays the PGN to a per-ply board map and, for each
    flaw's two lines ("missed" at flaw_ply, "allowed" at flaw_ply+1), calls
    _walk_pv_boards with the stored game_positions.pv string.

    Returns (lease_positions, sentinel_lines):
    - lease_positions: FlawBlobLeasePosition list. Token = "{flaw_ply}:{line}:{node_k}".
      fen = board.fen() for each EVEN (solver) node k in a walkable PV (walk length
      >= 2). Odd (defender) nodes are never leased (SEED-079): the gate only reads
      solver nodes, so defender continuation evals are dead weight.
    - sentinel_lines: set of (flaw_ply, line) for lines with NULL pv, missing start board,
      or < 2-node walks (un-fillable; caller writes [] sentinel for these via D-06).

    Engine and lichess %eval games are handled identically (D-09/D-09a): no is_lichess
    branch in the PV walk — game_positions.pv is populated for both at flaw plies.
    Only flaws with allowed_pv_lines IS NULL are considered (predicate consistency with
    the tier-4 lottery in _claim_tier4_blob).

    No asyncio.gather, no engine calls — all CPU work (PGN replay, PV walk) happens after
    the session closes. CLAUDE.md hard rule: AsyncSession is not safe for concurrent use.

    Relocated from eval_drain.py in Phase 150 R7 (WRITE-04): this is the tier-4
    flaw-blob-only lane, functionally isolated from the live-submit path (D-04
    isolation boundary) — the relocation is a file move only, it does not merge
    this function's behavior with apply_full_eval below.
    """
    # ── Read phase: load game, flaws, and per-ply PV strings ──────────────────
    async with async_session_maker() as session:
        game = await session.scalar(select(Game).where(Game.id == game_id))
        if game is None:
            return [], set()

        pgn_text: str = game.pgn

        # Only flaws that still need blobs (predicate consistency with tier-4 lottery).
        flaw_plies_result = await session.execute(
            sa.select(GameFlaw.ply).where(
                GameFlaw.game_id == game_id,
                GameFlaw.allowed_pv_lines.is_(None),
            )
        )
        flaw_plies: list[int] = list(flaw_plies_result.scalars().all())

        if not flaw_plies:
            return [], set()

        # PV walk uses boards at {flaw_ply (missed start), flaw_ply+1 (allowed start)}.
        target_plies: list[int] = []
        for ply in flaw_plies:
            target_plies.append(ply)
            target_plies.append(ply + 1)

        pv_result = await session.execute(
            sa.select(GamePosition.ply, GamePosition.pv).where(
                GamePosition.game_id == game_id,
                GamePosition.user_id == game.user_id,
                GamePosition.ply.in_(target_plies),
            )
        )
        pv_at_ply: dict[int, str | None] = {row.ply: row.pv for row in pv_result.all()}
    # read_session closed — no sessions open during CPU work below

    # ── CPU phase: replay PGN to build per-ply board map ──────────────────────
    try:
        pgn_game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception as exc:
        # Same reasoning as _collect_full_ply_targets: stored PGN, so a raise is
        # a bug, and the empty result silently skips the whole tier-4 blob.
        sentry_sdk.set_tag("source", "full_eval_drain")
        sentry_sdk.set_context("flaw_blob", {"game_id": game_id, "stage": "pgn_parse"})
        sentry_sdk.capture_exception(exc)
        return [], set()
    if pgn_game is None:
        return [], set()

    board_at_ply: dict[int, chess.Board] = {}
    board = pgn_game.board()
    for ply, node in enumerate(pgn_game.mainline()):
        board_at_ply[ply] = board.copy()
        board.push(node.move)

    cap = engine_service.PV_CAP_PLIES
    lease_positions: list[FlawBlobLeasePosition] = []
    sentinel_lines: set[tuple[int, str]] = set()

    for flaw_ply in flaw_plies:
        for line, node0_ply in [("missed", flaw_ply), ("allowed", flaw_ply + 1)]:
            start_board = board_at_ply.get(node0_ply)
            if start_board is None:
                # Board beyond the game end or PGN parse gap → un-fillable sentinel.
                sentinel_lines.add((flaw_ply, line))
                continue
            pv = pv_at_ply.get(node0_ply)
            walk = _walk_pv_boards(start_board, pv, cap)
            if len(walk) < 2:
                # NULL pv → 1-node walk (just start_board); gate discards 1-node blobs (D-06).
                sentinel_lines.add((flaw_ply, line))
                continue
            # SEED-079: only solver (even) nodes are gate-read (D-10), so defender (odd)
            # nodes are never leased — halves the tier-4 continuation-eval compute. The
            # assembler fills skipped odd indices with all-None placeholders at submit.
            for k in range(0, len(walk), 2):
                token = f"{flaw_ply}:{line}:{k}"
                lease_positions.append(FlawBlobLeasePosition(token=token, fen=walk[k].fen()))

    return lease_positions, sentinel_lines


def _parse_token(token: str) -> tuple[int, str, int]:
    """Phase 145 SHIP-01: parse a "{flaw_ply}:{line}:{node_k}" reassembly token (D-04a).

    Args:
        token: The opaque server-issued token echoed by the worker on submit.

    Returns:
        (flaw_ply, line, node_k) where line ∈ {"missed", "allowed"}.

    Raises:
        ValueError: On malformed token (wrong number of parts, non-integer
            flaw_ply/node_k, or line not in {"missed", "allowed"}).
    """
    parts = token.split(":", 2)
    if len(parts) != 3:
        raise ValueError(f"Token must have 3 colon-separated parts: {token!r}")
    flaw_ply_str, line, node_k_str = parts
    if line not in ("missed", "allowed"):
        raise ValueError(f"Token line must be 'missed' or 'allowed': {token!r}")
    return int(flaw_ply_str), line, int(node_k_str)


def _assemble_one_line_blob(
    flaw_ply: int,
    line: str,
    node_results: dict[tuple[int, str, int], FlawBlobSubmitEval | AtomicBlobNode],
    sentinel_lines: set[tuple[int, str]],
) -> list[PvNode]:
    """Assemble one PvNode list for a flaw line from indexed worker results (slim scheme).

    Sentinel lines (from _build_flaw_blob_lease_positions) and lines missing
    a node-0 result both return []. SEED-079 slim blobs: only EVEN (solver) node_k
    are leased/evaluated, so the walk steps k = 0, 2, 4, ... and inserts an all-None
    placeholder PvNode for each skipped odd (defender) index, keeping the gate's
    index-parity convention intact. A missing EVEN node is a gap (stop); the result
    therefore always ends on a real even solver node — never a trailing placeholder —
    preserving _strip_trailing_only_moves' "last solver node is real" assumption.

    Odd-k entries in node_results (old fat-lease/atomic workers still submitting
    defender nodes) are intentionally never read — server-authoritative discard
    (SEED-079 item 5). su='' maps from None second_uci (Pitfall 3).
    """
    if (flaw_ply, line) in sentinel_lines:
        return []
    node0 = node_results.get((flaw_ply, line, 0))
    if node0 is None:
        return []
    nodes: list[PvNode] = []
    k = 0
    while True:
        res = node_results.get((flaw_ply, line, k))
        if res is None:
            break  # Missing EVEN node = gap; missing odd nodes are placeholders below.
        if k > 0:
            nodes.append(_placeholder_defender_node())  # The skipped odd index k-1.
        su: str = res.second_uci if res.second_uci is not None else ""
        nodes.append(
            PvNode(b=res.best_cp, bm=res.best_mate, s=res.second_cp, sm=res.second_mate, su=su)
        )
        k += 2
    return nodes


def _assemble_flaw_blobs_from_submit(
    game_id: int,
    submit_evals: Sequence[FlawBlobSubmitEval | AtomicBlobNode],
    sentinel_lines: set[tuple[int, str]],
) -> dict[int, tuple[list[PvNode], list[PvNode]]]:
    """Phase 145 SHIP-01 / Phase 147 Part B: assemble PvNode blobs from worker MultiPV=2
    results (D-04 tier-4 submit path AND the atomic-submit path, D-02).

    Pure CPU helper — no engine calls, no DB sessions. Parses tokens, groups by
    (flaw_ply, line, node_k), and builds list[PvNode] per line. Lines in
    sentinel_lines and lines missing a node-0 result both get [].

    All (flaw_ply, line) pairs found across submitted evals and sentinel_lines
    appear in the returned blob_map. The caller writes [] for sentinels via
    _batch_update_flaw_pv_lines (D-06 sentinel write clears the IS NULL predicate).
    A flaw_ply with NEITHER a submitted token NOR a sentinel_lines entry for EITHER
    line is intentionally left OUT of the returned blob_map entirely (Phase 147
    Part B): the caller's classify_game_flaws sees flaw_pv_blobs.get(flaw_ply) is
    None for that flaw and, with blobs_pending=True, suppresses its tag to NULL
    instead of persisting it raw/ungated (T-147-08).

    Token format: "{flaw_ply}:{line}:{node_k}" (D-04a). All three components
    are used as the index key so "10:missed:2" and "10:allowed:2" remain distinct
    (Pitfall 5). su='' maps from None second_uci on the wire (Pitfall 3).

    Args:
        game_id: Owning game (informational — not used in the pure CPU path).
        submit_evals: Worker evaluation results, each carrying an echoed token.
            FlawBlobSubmitEval (tier-4) and AtomicBlobNode (Phase 147 Part B) share
            the identical field set (token/best_cp/best_mate/second_cp/second_mate/
            second_uci) so either submit shape can be assembled here unchanged.
        sentinel_lines: Set of (flaw_ply, line) pairs identified as un-fillable
            by the lease builder (NULL PV or < 2-node walk). These get [] blobs.

    Returns:
        blob_map: {flaw_ply → (allowed_pv_lines_value, missed_pv_lines_value)}
        where each value is a list[PvNode] (possibly [] for sentinels).
    """
    # Index worker results by (flaw_ply, line, node_k) — all three components.
    node_results: dict[tuple[int, str, int], FlawBlobSubmitEval | AtomicBlobNode] = {}
    for e in submit_evals:
        try:
            key = _parse_token(e.token)
        except ValueError, IndexError:
            # Malformed token: skip silently; endpoint validates tokens upstream.
            continue
        node_results[key] = e

    # Collect all unique flaw plies from submitted evals + sentinel_lines.
    flaw_plies_from_evals: set[int] = {fp for fp, _ln, _k in node_results}
    flaw_plies_from_sentinels: set[int] = {fp for fp, _ln in sentinel_lines}
    all_flaw_plies = flaw_plies_from_evals | flaw_plies_from_sentinels

    blob_map: dict[int, tuple[list[PvNode], list[PvNode]]] = {}
    for flaw_ply in all_flaw_plies:
        allowed_blob = _assemble_one_line_blob(flaw_ply, "allowed", node_results, sentinel_lines)
        missed_blob = _assemble_one_line_blob(flaw_ply, "missed", node_results, sentinel_lines)
        blob_map[flaw_ply] = (allowed_blob, missed_blob)

    return blob_map


# Minimal duck-typed view so count_game_severities can be called with a
# synthetic user_color without mutating the ORM Game object.
class _GameColorView:
    """Provides the user_color attribute for count_game_severities (D-117-08).

    count_game_severities reads only game.user_color; this thin wrapper avoids
    mutating the ORM object and avoids deepcopy overhead. Named with a leading
    underscore — internal to eval_apply, not exported.
    """

    def __init__(self, game: Game, user_color: str) -> None:
        self._game = game
        self.user_color = user_color

    def __getattr__(self, name: str) -> object:
        return getattr(self._game, name)


# Module-level set for per-user flaw completion signals (D-117-11).
# Phase 118 wires real cache invalidation against this set. For Phase 117,
# it is a lightweight append-only set that future cache middleware can poll.
_recently_flaw_completed_users: set[int] = set()


def _signal_flaw_completion(user_id: int) -> None:
    """Mark a user as having newly-completed flaw analysis (D-117-11 hook).

    Phase 117: no-op beyond a set insert. Phase 118 will wire cache
    invalidation here (debounced per-user asyncio.Task pattern).
    The set is intentionally not bounded — at 8.4k games/day and ~few hundred
    users, it stays small in practice.
    """
    _recently_flaw_completed_users.add(user_id)


# ---------------------------------------------------------------------------
# apply_full_eval — the shared write_session body (Phase 150 R7 / WRITE-04)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Phase 174 GEMS-03: best-move candidate rows (Gem/Great detection)
# ---------------------------------------------------------------------------


def _contiguous_san_prefix(targets: Sequence[_FullPlyEvalTarget]) -> list[str]:
    """The game's COMPLETE SAN move order, for find_opening_ply_count (CR-01 fix).

    Reconstructed from the DEEPEST non-terminal target's `board.move_stack` — a
    chess.Board snapshot carries its own full push history regardless of which
    OTHER targets happen to be present in `targets` — plus that target's own
    `move_san` (the move about to be played FROM that position, i.e. its ply's
    own contribution to the prefix). Every target in a single game's `targets`
    shares the same linear move history by construction (`_collect_full_ply_targets`
    walks the PGN exactly once), so reconstructing the prefix from the single
    deepest target is sufficient — no need to walk every target.

    Book moves are always a prefix from ply 0, and find_opening_ply_count stops at
    the first non-book move, so only this prefix matters.

    Robustness (CR-01, 174-REVIEW): the prior implementation built the prefix by
    walking `targets` ply-by-ply from 0 using each target's own `move_san` field
    (`{t.ply: t.move_san ...}`, `while ply in san_by_ply`). That walk depended on
    ply 0 being PRESENT as its own entry in `targets` — a sparse/pre-filtered
    `targets` list missing ply 0 (the historical local-drain lichess-eval shape,
    before Phase 174-06 Task 1 retired that filter) made the walk stop
    immediately, silently collapsing book depth to 0 and misclassifying a
    genuinely in-book ply as out-of-book. This implementation never depends on
    ply 0 being present in `targets` — only on the deepest target's own board
    carrying real history, true for every real call site (both `_full_drain_tick`
    and `_apply_atomic_submit` build boards via one continuous PGN/game walk).
    After Task 1 both production lanes pass full/contiguous ply-0-anchored
    targets anyway, so this is defense-in-depth for a sparse/future caller, not
    load-bearing for either lane today (174-REVIEW CR-01 reframed).

    Returns [] when `targets` has no non-terminal entries.
    """
    non_terminal = [t for t in targets if not t.is_terminal]
    if not non_terminal:
        return []
    deepest = max(non_terminal, key=lambda t: t.ply)
    # "From position" games (lichess standard variant with a custom initial FEN —
    # user-facing imports don't filter these) carry a move_stack that is legal only
    # from their own root, not the standard start. Replaying it from chess.Board()
    # raised AssertionError in san() (FLAWCHESS-8W). Such games have no standard
    # opening theory, so book_plies is 0 by definition — return an empty prefix.
    # Mirrors the custom-FEN-survivor handling in opening_insights_service.py.
    if deepest.board.root().fen() != chess.STARTING_FEN:
        return []
    replay_board = chess.Board()
    sans: list[str] = []
    for move in deepest.board.move_stack:
        sans.append(replay_board.san(move))
        replay_board.push(move)
    if deepest.move_san is not None:
        sans.append(deepest.move_san)
    return sans


async def _build_best_move_candidates(
    game_id: int,
    targets: Sequence[_FullPlyEvalTarget],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    second_best_map: dict[int, tuple[int | None, int | None, str | None]] | None,
    source: str = "drain-local",
) -> list[dict[str, Any]]:
    """Build game_best_moves candidate rows for the game (GEMS-03), off any session.

    For each out-of-book ply where the played move == Stockfish's best move AND the
    move beats the runner-up by >= INACCURACY_DROP in expected score (GEMS-02), score
    the played move with backend Maia-3 at the mover's pinned+clamped ELO (GEMS-05)
    and emit a candidate row (raw continuous storage — the Gem/Great tier is decided
    at query time, GEMS-01/07).

    Session discipline (CLAUDE.md hard rule, mirrors _build_flaw_multipv2_blobs):
      - candidate identification is pure in-memory (targets + engine_result_map),
      - the Pitfall-1 targeted evaluate_nodes_multipv2 fallback runs in ONE
        asyncio.gather with NO session open,
      - the game's rating metadata is read in a short session that is CLOSED before
        any Maia inference,
      - the returned rows are UPSERTed later by apply_full_eval in its own late write
        session, so they land in the SAME commit as the rest of the eval (T-174-12).

    Pitfall 1: a ply missing from second_best_map (None/empty map, or a ply the map
    simply doesn't cover) gets a bounded, backend-owned evaluate_nodes_multipv2(board)
    fallback — NOT a worker-protocol change (the extra Stockfish `go` runs on the
    backend's own SCHED_IDLE pool). Phase 177 PROTO-03 made this the RARE case for
    the remote-worker lane (v2 workers submit their own second-best data via
    `second_best`, threaded through by the caller); it stays the COMMON case for a
    tier-4b/local-drain caller that hasn't computed second-best itself.

    source (Phase 177 D-06/OBS-01): a caller-supplied label (e.g. "drain-local",
    "worker-submit-fallback") tagged on the Sentry event emitted when the fallback
    branch fires, so a worker-submit-path fallback (the S-04 regression signal,
    expected ~zero post-shift) is queryable independent of the expected drain-local
    fallback noise. Defaults to "drain-local" for the existing local-drain/tier-4b
    call sites, which do not (yet) pass this explicitly.

    Returns [] (no rows, no crash) when Maia is disabled (score_move returns None
    because onnxruntime is absent), the game is gone, or anything unexpected fails —
    a lean/misconfigured backend must never abort eval-apply over gem detection.
    """
    if not targets:
        return []
    second_best_map = second_best_map or {}
    try:
        book_plies = _out_of_book_ply_count(targets)

        candidate_targets = _identify_candidate_targets(targets, engine_result_map, book_plies)
        if not candidate_targets:
            return []

        fallback_by_ply = await _fetch_multipv2_fallback(
            game_id, candidate_targets, second_best_map, source
        )

        rating_metadata = await _fetch_rating_metadata(game_id)
        if rating_metadata is None:
            return []
        white_rating, black_rating, platform, tc_bucket, is_correspondence = rating_metadata

        return _assemble_candidate_rows(
            game_id,
            candidate_targets,
            engine_result_map,
            second_best_map,
            fallback_by_ply,
            white_rating,
            black_rating,
            platform,
            tc_bucket,
            is_correspondence,
        )
    except Exception:
        # Gem detection is a secondary concern: it must never abort the primary eval
        # write. Report and yield no rows (the eval + flaws still commit).
        sentry_sdk.set_context("best_move_candidates", {"game_id": game_id})
        sentry_sdk.capture_exception()
        return []


def _out_of_book_ply_count(targets: Sequence[_FullPlyEvalTarget]) -> int:
    """Stage 1 of `_build_best_move_candidates`: out-of-book test (pure, in-memory —
    no re-parse, Pitfall 3).
    """
    return find_opening_ply_count(_contiguous_san_prefix(targets))


def _identify_candidate_targets(
    targets: Sequence[_FullPlyEvalTarget],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    book_plies: int,
) -> list[_FullPlyEvalTarget]:
    """Stage 2 of `_build_best_move_candidates`: identify candidates — out-of-book
    plies where the played move == Stockfish's best move.
    """
    candidate_targets: list[_FullPlyEvalTarget] = []
    for t in targets:
        if t.is_terminal or t.move_uci is None or t.ply < book_plies:
            continue
        entry = engine_result_map.get(t.ply)
        if entry is None:
            continue
        best_uci = entry[2]
        if best_uci is None or best_uci != t.move_uci:
            continue
        candidate_targets.append(t)
    return candidate_targets


async def _fetch_multipv2_fallback(
    game_id: int,
    candidate_targets: Sequence[_FullPlyEvalTarget],
    second_best_map: dict[int, tuple[int | None, int | None, str | None]],
    source: str,
) -> dict[
    int, tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None]
]:
    """Stage 3 of `_build_best_move_candidates`: Pitfall-1 fallback — plies lacking a
    runner-up get a targeted MultiPV-2 Stockfish call. ONE gather, NO session open
    (CLAUDE.md hard rule).
    """
    fallback_targets = [t for t in candidate_targets if t.ply not in second_best_map]
    fallback_by_ply: dict[
        int,
        tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None],
    ] = {}
    if fallback_targets:
        # Phase 177 D-06/OBS-01: tag by source so a worker-submit-path fallback
        # (the regression signal, expected ~zero post-shift) is queryable
        # independent of the expected drain-local fallback noise. Variables go
        # in set_context, never the message string (CLAUDE.md Sentry rules).
        sentry_sdk.set_tag("source", source)
        sentry_sdk.set_context(
            "best_move_candidates_fallback",
            {"game_id": game_id, "fallback_ply_count": len(fallback_targets)},
        )
        results = await asyncio.gather(
            *(engine_service.evaluate_nodes_multipv2(t.board) for t in fallback_targets)
        )
        for t, res in zip(fallback_targets, results, strict=True):
            fallback_by_ply[t.ply] = res
    return fallback_by_ply


async def _fetch_rating_metadata(
    game_id: int,
) -> tuple[int | None, int | None, Platform, "TimeControlBucket | None", bool] | None:
    """Stage 4 of `_build_best_move_candidates`: rating metadata — short read session,
    CLOSED before any Maia inference (session-discipline hard rule, see this
    function's own docstring).
    """
    async with async_session_maker() as read_session:
        game_row = (
            await read_session.execute(
                select(
                    Game.white_rating,
                    Game.black_rating,
                    Game.platform,
                    Game.time_control_bucket,
                    Game.time_control_str,
                ).where(Game.id == game_id)
            )
        ).one_or_none()
    if game_row is None:
        return None
    white_rating, black_rating, platform_raw, tc_bucket_raw, tc_str = game_row
    is_correspondence = is_correspondence_time_control(tc_str)
    platform = cast(Platform, platform_raw)
    tc_bucket = cast("TimeControlBucket | None", tc_bucket_raw)
    return white_rating, black_rating, platform, tc_bucket, is_correspondence


def _assemble_candidate_rows(
    game_id: int,
    candidate_targets: Sequence[_FullPlyEvalTarget],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    second_best_map: dict[int, tuple[int | None, int | None, str | None]],
    fallback_by_ply: dict[
        int,
        tuple[int | None, int | None, str | None, str | None, int | None, int | None, str | None],
    ],
    white_rating: int | None,
    black_rating: int | None,
    platform: Platform,
    tc_bucket: "TimeControlBucket | None",
    is_correspondence: bool,
) -> list[dict[str, Any]]:
    """Stage 5 of `_build_best_move_candidates`: gate + Maia inference + row
    assembly — NO session open.
    """
    rows: list[dict[str, Any]] = []
    for t in candidate_targets:
        played_uci = t.move_uci
        if played_uci is None:  # unreachable (filtered above); narrows for ty
            continue
        best_cp, best_mate, _best_uci, _pv = engine_result_map[t.ply]
        second = second_best_map.get(t.ply)
        if second is not None:
            second_cp, second_mate = second[0], second[1]
        else:
            fb = fallback_by_ply.get(t.ply)
            if fb is None:
                continue
            second_cp, second_mate = fb[4], fb[5]

        mover = mover_color_for_ply(t.ply)
        if not passes_inaccuracy_gate(best_cp, best_mate, second_cp, second_mate, mover):
            continue

        raw_rating = white_rating if mover == "white" else black_rating
        if raw_rating is None:
            # No rating for the mover — can't pin the Maia ELO; skip gracefully.
            continue
        elo = pinned_elo_for_mover(
            raw_rating=raw_rating,
            platform=platform,
            time_control_bucket=tc_bucket,
            is_correspondence=is_correspondence,
        )
        prob = score_move(t.board.fen(), elo, played_uci)
        if prob is None:
            # Maia disabled (no onnxruntime) or move not in the policy — no candidate.
            continue
        rows.append(
            {
                "game_id": game_id,
                "ply": t.ply,
                "maia_prob": float(prob),
                "best_cp": best_cp,
                "best_mate": best_mate,
                "second_cp": second_cp,
                "second_mate": second_mate,
            }
        )
    return rows


async def _upsert_best_move_rows(session: AsyncSession, rows: Sequence[dict[str, Any]]) -> None:
    """Idempotently UPSERT candidate rows on the (game_id, ply) natural key (T-174-12).

    Re-analysis can revisit a game, so ON CONFLICT DO UPDATE refreshes the stored
    continuous values rather than raising a duplicate-PK error. Does NOT commit — the
    caller's write_session owns the commit, so rows land in the same transaction as
    the rest of apply_full_eval.
    """
    if not rows:
        return
    stmt = pg_insert(GameBestMove).values(list(rows))
    stmt = stmt.on_conflict_do_update(
        index_elements=["game_id", "ply"],
        set_={
            "maia_prob": stmt.excluded.maia_prob,
            "best_cp": stmt.excluded.best_cp,
            "best_mate": stmt.excluded.best_mate,
            "second_cp": stmt.excluded.second_cp,
            "second_mate": stmt.excluded.second_mate,
        },
    )
    await session.execute(stmt)


# ---------------------------------------------------------------------------
# Phase 177 BACK-02/03: tier-4b dedicated lease/submit (worker-side MultiPV-2)
# ---------------------------------------------------------------------------


def _eval_of_position_map(
    gp_rows: Sequence[tuple[int, int | None, int | None]],
) -> dict[int, tuple[int | None, int | None]]:
    """Invert `_post_move_eval`'s +1 forward post-move shift (Pitfall 1, SEED-044).

    `_post_move_eval` reads row `ply`'s STORED (eval_cp, eval_mate) as the eval of
    position `ply + 1` (the position AFTER the move played at `ply`). A tier-4b
    game has no fresh position-keyed engine pass to build `engine_result_map` from
    (unlike every other call site, which builds it from `_resolve_full_eval` over a
    FRESH search) — it only has this already-shifted stored data, so this function
    builds the position-keyed INVERSE: `eval_of_position[ply]` = the eval OF
    position `ply`, sourced from row `ply - 1`'s stored value.

    `eval_of_position[0]` is never populated (no row -1 exists) — callers MUST
    read via `.get(ply, (None, None))`, never index directly, so ply=0 resolves
    to "no eval available" rather than a KeyError.

    gp_rows: (ply, eval_cp, eval_mate) exactly as stored in game_positions
    (post-move shifted, unmodified — this function does the un-shifting).
    """
    return {ply + 1: (eval_cp, eval_mate) for ply, eval_cp, eval_mate in gp_rows}


async def _build_bestmove_lease_positions(game_id: int) -> list[BestMoveLeasePosition]:
    """Phase 177 BACK-02: reconstruct one tier-4b game's candidate-ply FENs from
    already-stored full-pass data — no engine calls here (the worker runs the N
    targeted runner-up searches, S-05).

    A tier-4b game already has a complete MultiPV=1 full-ply pass
    (`full_pv_completed_at IS NOT NULL`, the `_claim_tier4_bestmove` predicate) but
    no best-move backfill row yet (`best_moves_completed_at IS NULL`). The
    candidate-ply set mirrors `_build_best_move_candidates`'s steps 1-2 loop SHAPE
    (RESEARCH "Don't Hand-Roll" — `_contiguous_san_prefix` + `find_opening_ply_count`
    + the played==best test), reconstructed from `game_positions.best_move`
    (decision-keyed, un-shifted — row `ply`'s OWN best_move) instead of a fresh
    engine_result_map.

    Does NOT apply the inaccuracy MARGIN gate (`passes_inaccuracy_gate` needs a
    runner-up eval, which does not exist until the worker computes it at
    `/bestmove-submit` time) — only the availability half of that gate's None
    guard: a ply whose `eval_of_position` (Pitfall 1's inverse-shift reconstruction)
    is entirely missing can never pass the margin gate regardless of what second
    the worker later computes, so it is excluded here too, before ever leasing a
    FEN for it (an efficiency filter, not a correctness requirement — the margin
    gate itself is re-applied authoritatively at submit time via
    `_build_best_move_candidates`, D-03 stateless recompute).

    Returns [] (no candidates, no crash) for a missing game, an unparseable PGN,
    or a game with no stored positions.
    """
    async with async_session_maker() as session:
        game = await session.scalar(select(Game).where(Game.id == game_id))
        if game is None:
            return []
        pgn_text: str = game.pgn
        gp_result = await session.execute(
            select(
                GamePosition.ply,
                GamePosition.best_move,
                GamePosition.eval_cp,
                GamePosition.eval_mate,
            ).where(
                GamePosition.game_id == game_id,
                GamePosition.user_id == game.user_id,
            )
        )
        gp_rows = gp_result.all()
    # session closed — no CPU work needs a session open

    if not gp_rows:
        return []

    stored_best_move_by_ply: dict[int, str | None] = {r.ply: r.best_move for r in gp_rows}
    eval_of_position = _eval_of_position_map([(r.ply, r.eval_cp, r.eval_mate) for r in gp_rows])

    # _collect_full_ply_targets needs (ply, full_hash, eval_cp, eval_mate) rows —
    # full_hash is unused here (no dedup at play in this lane), passed as 0.
    gp_full_rows: list[tuple[int, int, int | None, int | None]] = [
        (r.ply, 0, r.eval_cp, r.eval_mate) for r in gp_rows
    ]
    targets = _collect_full_ply_targets(
        game_id=game_id,
        pgn_text=pgn_text,
        game_positions_rows=gp_full_rows,
        include_terminal=False,
        stored_best_move_by_ply=stored_best_move_by_ply,
    )
    if not targets:
        return []

    book_plies = find_opening_ply_count(_contiguous_san_prefix(targets))

    positions: list[BestMoveLeasePosition] = []
    for t in targets:
        if t.is_terminal or t.move_uci is None or t.ply < book_plies:
            continue
        stored_best = t.stored_best_move
        if stored_best is None or stored_best != t.move_uci:
            continue
        best_cp, best_mate = eval_of_position.get(t.ply, (None, None))
        if best_cp is None and best_mate is None:
            # Pitfall 1 None guard: no usable eval at this position (includes
            # ply=0, which has no row -1) — can never pass the margin gate later.
            continue
        positions.append(BestMoveLeasePosition(ply=t.ply, fen=t.board.fen()))
    return positions


async def _stamp_best_moves_completed_directly(game_id: int) -> None:
    """Phase 177 Pitfall 2: stamp `best_moves_completed_at` directly, bypassing the
    full `apply_completion_decision` Path A/C machinery (S-06 — tier-4b touches
    nothing else).

    Used at LEASE time for a zero-candidate or over-`MAX_SUBMIT_EVALS` pick so the
    `_claim_tier4_bestmove` ES lottery never re-draws the same un-fillable game
    forever (mirrors `/flaw-blob-lease`'s all-sentinel forward-progress write).
    Safe regardless of Maia availability (Phase 176 D-01's guardrail concern):
    there are zero (or un-leasable) candidates either way, so Maia would never be
    invoked for this game regardless of whether it is loaded.

    Opens its own short session, commits, closes — a minimal one-column write,
    never batched with any other table's write (structural isolation, T-177-07).
    """
    async with async_session_maker() as session:
        await _mark_best_moves_completed(session, game_id)
        await session.commit()


async def _apply_bestmove_submit(
    game_id: int,
    body: BestMoveSubmitRequest,
    worker_id: str,
    last_ip: str | None,
) -> BestMoveSubmitResponse:
    """Apply a tier-4b submit: recompute candidates server-side, score with Maia,
    write ONLY `game_best_moves` rows + stamp `best_moves_completed_at` (S-06/D-02).

    Structurally isolated from `_apply_atomic_submit` / `apply_full_eval` (T-177-07):
    no shared write-session code, no `_classify_and_fill_oracle`, `game_flaws` is
    never read or written here.

    Flow:
    1. Read phase (short session, closed before CPU work): Game (pgn, user_id) +
       GamePosition rows (ply, best_move, eval_cp, eval_mate). 404 if the game
       is gone.
    2. Rebuild `targets` + the inverse-shift `engine_result_map` (Pitfall 1) —
       the SAME `_eval_of_position_map` + `_collect_full_ply_targets` primitives
       `_build_bestmove_lease_positions` uses (D-03: lease and submit reconstruct
       from the identical source of truth, so they structurally agree).
    3. Tamper guard (T-177-05): a submitted ply outside `[0, game_length)` is
       422'd before any write. An in-range ply that is NOT a real candidate is
       intentionally NOT rejected here (T-177-06) — `_build_best_move_candidates`
       independently recomputes the candidate-ply set from `targets` +
       `engine_result_map` (never from `second_best_map`'s keys), so a foreign
       ply's submitted second-best is simply never read at the map lookup,
       mirroring the established second_best guard precedent (177-01-SUMMARY.md).
    4. Delegates to `_build_best_move_candidates` (reused verbatim — the margin
       gate + pinned-ELO Maia scoring are NOT re-derived here) with the worker's
       submitted evals as `second_best_map`.
    5. Write phase: ONE session UPSERTs `game_best_moves` rows + stamps
       `best_moves_completed_at`, then commits. Nothing else.
    """
    async with async_session_maker() as read_session:
        game = await read_session.scalar(select(Game).where(Game.id == game_id))
        if game is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Game not found",
            )
        pgn_text: str = game.pgn
        # Quick 260719-fsz: needed for the best_cp source decision below.
        # Phase 212 D-03: routed through the single derivation point so
        # BENCHMARK_HOMOGENIZE_EVAL_SOURCE can force this False everywhere.
        is_lichess_eval_game = derive_is_lichess_eval_game(game.lichess_evals_at)
        gp_result = await read_session.execute(
            select(
                GamePosition.ply,
                GamePosition.best_move,
                GamePosition.eval_cp,
                GamePosition.eval_mate,
            ).where(
                GamePosition.game_id == game_id,
                GamePosition.user_id == game.user_id,
            )
        )
        gp_rows = gp_result.all()
    # read_session closed — no sessions open during CPU work below

    stored_best_move_by_ply: dict[int, str | None] = {r.ply: r.best_move for r in gp_rows}
    eval_of_position = _eval_of_position_map([(r.ply, r.eval_cp, r.eval_mate) for r in gp_rows])

    gp_full_rows: list[tuple[int, int, int | None, int | None]] = [
        (r.ply, 0, r.eval_cp, r.eval_mate) for r in gp_rows
    ]
    targets = _collect_full_ply_targets(
        game_id=game_id,
        pgn_text=pgn_text,
        game_positions_rows=gp_full_rows,
        include_terminal=False,
        stored_best_move_by_ply=stored_best_move_by_ply,
    )
    game_length = len(targets)

    # Position-keyed surrogate for a fresh engine pass (Pitfall 1): best_cp/mate
    # come from the inverse-shift reconstruction; best_uci is the row's OWN
    # (un-shifted) stored best_move; pv is unavailable (never used by the
    # candidate/gate logic below).
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]] = {
        t.ply: (
            *eval_of_position.get(t.ply, (None, None)),
            stored_best_move_by_ply.get(t.ply),
            None,
        )
        for t in targets
    }

    # Quick 260719-fsz — best_cp source parity for LICHESS games. The base map above
    # takes best_cp/best_mate from eval_of_position = stored game_positions.eval_cp,
    # which for a lichess-eval game holds LICHESS %eval, not our Stockfish. Left
    # as-is, the query-time gem/great divergence guard (library_service.py) compares
    # that lichess best_cp against post_move_cp (also lichess) — it never fires and
    # over-badges gems. Engine games are unaffected (their stored eval IS our
    # Stockfish), so ONLY lichess games are rewritten here.
    #   - New workers (Option B) submit their fresh best_cp/best_mate → use them.
    #   - Old workers (pre-260719-fsz) omit them → re-search the affected candidate
    #     plies here. This is a transient, backward-compatible fallback that stops
    #     firing once every worker submits best_cp. NO session is open (read_session
    #     closed above), so the gather obeys the CLAUDE.md rule.
    if is_lichess_eval_game:
        targets_by_ply = {t.ply: t for t in targets}
        stale_targets: list[_FullPlyEvalTarget] = []
        for e in body.evals:
            if e.ply not in targets_by_ply:
                continue
            if e.best_cp is not None or e.best_mate is not None:
                engine_result_map[e.ply] = (
                    e.best_cp,
                    e.best_mate,
                    stored_best_move_by_ply.get(e.ply),
                    None,
                )
            else:
                stale_targets.append(targets_by_ply[e.ply])
        if stale_targets:
            fresh_results = await asyncio.gather(
                *(engine_service.evaluate_nodes_multipv2(t.board) for t in stale_targets)
            )
            for t, res in zip(stale_targets, fresh_results, strict=True):
                engine_result_map[t.ply] = (
                    res[0],
                    res[1],
                    stored_best_move_by_ply.get(t.ply),
                    None,
                )

    # T-177-05: structural in-range tamper guard, before any write.
    for e in body.evals:
        if not (0 <= e.ply < game_length):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Unknown or foreign ply",
            )

    # T-177-06: the server never trusts WHICH plies the worker chose to send —
    # `_build_best_move_candidates` below independently recomputes candidacy from
    # `targets`/`engine_result_map`, so a foreign-but-in-range ply's submitted
    # second-best is simply never read.
    second_best_map: dict[int, tuple[int | None, int | None, str | None]] = {
        e.ply: (e.second_cp, e.second_mate, e.second_uci) for e in body.evals
    }

    best_move_rows = await _build_best_move_candidates(
        game_id, targets, engine_result_map, second_best_map, source="tier4b-backfill"
    )

    # BUG FIX (177-REVIEW CR-01): this wire endpoint bypasses
    # apply_completion_decision entirely (it has its own write session), so it
    # never inherited the Phase 176 D-01 maia_available guardrail the way
    # _tier4b_minimal_drain_tick (app/services/eval_drain.py) did in Plan 03.
    # best_moves_completed_at must be stamped ONLY when a Maia session was
    # actually loaded — never inferred from best_move_rows being empty/non-empty,
    # since _build_best_move_candidates returns [] for BOTH "Maia ran, zero
    # candidates" and "Maia absent" (row count alone can't distinguish them). A
    # Maia-absent backend must never stamp, or the game is permanently excluded
    # from the tier-4b lottery (best_moves_completed_at IS NULL) with zero rows
    # and no resweep/backfill path.
    maia_available = maia_engine.is_maia_available()

    async with async_session_maker() as write_session:
        await _upsert_best_move_rows(write_session, best_move_rows)
        if maia_available:
            await _mark_best_moves_completed(write_session, game_id)
        await upsert_worker_heartbeat(
            write_session,
            worker_id=worker_id,
            last_ip=last_ip,
            sf_version=body.sf_version,
            worker_schema_version=None,  # bestmove-submit never sends this (D-03)
            n_evals=len(body.evals),
        )
        await write_session.commit()

    return BestMoveSubmitResponse(game_id=game_id, rows_written=len(best_move_rows))


async def apply_full_eval(
    write_session: AsyncSession,
    *,
    game_id: int,
    job_id: int | None,
    targets: Sequence[_FullPlyEvalTarget],
    dedup_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    engine_result_map: dict[int, tuple[int | None, int | None, str | None, str | None]],
    is_lichess_eval_game: bool,
    flaw_pv_blobs: dict[int, tuple[list[PvNode], list[PvNode]]] | None,
    current_attempts: int,
    source: Literal["full_eval_drain", "remote_eval_worker"],
    on_path_c_capacity_reached: Callable[[int, int, int, str], None],
    preserve_existing_evals: bool = False,
    stored_eval_predates_engine: bool = False,
    blobs_pending: bool = False,
    update_opening_cache: bool = False,
    upsert_opening_cache_fn: (
        Callable[
            [
                AsyncSession,
                list[_FullPlyEvalTarget],
                dict[int, tuple[int | None, int | None, str | None, str | None]],
            ],
            Coroutine[Any, Any, None],
        ]
        | None
    ) = None,
    engine_targets_for_cache: Sequence[_FullPlyEvalTarget] | None = None,
    count_flaws_written: bool = False,
    record_heartbeat: bool = False,
    heartbeat_worker_id: str | None = None,
    heartbeat_last_ip: str | None = None,
    heartbeat_sf_version: str | None = None,
    heartbeat_worker_schema_version: int | None = None,
    heartbeat_n_evals: int = 0,
    best_move_rows: Sequence[dict[str, Any]] | None = None,
) -> tuple[int, bool, int]:
    """Apply one game's full-ply evals -> authoritative classify (+ blobs) -> both
    completion markers, inside the CALLER's write_session (T-117-11 — one commit).

    This is the post-R1/R3/R4 `_apply_atomic_submit` write-session body, generalized
    so BOTH `_full_drain_tick` (eval_drain.py) and the router's `_apply_atomic_submit`
    (eval_remote.py) call this ONE function for the shared write phase, instead of each
    inlining its own copy of "evals -> classify -> oracle -> completion -> heartbeat".

    Does NOT open or commit the session — the caller owns session lifecycle (mirrors
    apply_completion_decision's existing convention) so per-module test monkeypatches
    of `async_session_maker` continue to route to the correct session exactly as
    before the move (eval_drain.py's own async_session_maker for the drain tick,
    eval_remote.py's own async_session_maker for the router).

    Per-game write lock (260825-v8g, FLAWCHESS-9F / FLAWCHESS-8G, 2026-08-23): on
    2026-08-23 08:02:04/05 three concurrent atomic-submits for the SAME game_id
    (2361356) landed at once and produced one PostgreSQL deadlock cycle across two
    Sentry issues. `_apply_full_eval_results` emits two separate
    `UPDATE game_positions ... FROM (VALUES ...)` statements —
    `_batch_update_best_move_rows` then `_batch_update_eval_rows` — whose ply sets
    partially overlap; row-lock acquisition order across two separate statements is
    planner-dependent, so one transaction can hold ply 9 and want ply 55 while
    another holds 55 and wants 9. The same window's `_classify_and_fill_oracle`
    per-ply flaw diff/upsert (delete/insert/update against `game_flaws`, see its own
    docstring) is a correctness hazard under the same same-game race, not merely a
    deadlock one — which is why the lock below wraps this whole function body
    rather than just the two UPDATEs.

    The lock is taken here, at the very top of `apply_full_eval`, and not in the
    router (`_apply_atomic_submit`), because Phase 150 R7 already funnels BOTH live
    write lanes — the router and `_full_drain_tick` (eval_drain.py) — through this
    one shared function; a router-only lock would leave the drain lane racing. It
    is `pg_advisory_xact_lock` (transaction-scoped), not `pg_advisory_lock`
    (session-scoped), because `apply_full_eval` never owns or commits the
    write_session — an xact-scoped lock releases automatically at the caller's
    COMMIT or ROLLBACK with no explicit unlock call and no leak path, which also
    keeps it safe under the WR-01 fail-closed contract (an exception here
    propagates and aborts the caller's transaction, releasing the lock with it).
    The one behavioral consequence worth knowing: submits for the SAME game now
    serialize instead of racing, while different games are completely unaffected;
    no new deadlock cycle is introduced because the lock is always the FIRST
    statement on every path into this function, with the identical key derivation
    (`_game_write_lock_key`) every time.

    Sequencing (unchanged from the pre-move _apply_atomic_submit / _full_drain_tick
    write phases): _apply_full_eval_results -> _classify_and_fill_oracle -> optional
    flaws_written count -> optional opening-cache upsert -> apply_completion_decision
    -> optional worker-heartbeat upsert. All inside the same write_session (T-117-11);
    none of these calls are wrapped in try/except here (WR-01 fail-closed contract —
    errors must propagate to abort the caller's transaction).

    update_opening_cache / upsert_opening_cache_fn (Pitfall 4): `_full_drain_tick`
    passes update_opening_cache=True with `_upsert_opening_cache` (eval_drain.py,
    NOT moved here — it stays full-lane-only) as upsert_opening_cache_fn, preserving
    its current behavior. `_apply_atomic_submit` leaves update_opening_cache=False
    (its current behavior — the opening cache is NOT populated from atomic-submit
    workers). This is a deliberate, explicit parameter (not silently unified) per
    RESEARCH.md Pitfall 4 / D-05.

    record_heartbeat / heartbeat_*: `_full_drain_tick` does not call
    upsert_worker_heartbeat today (leaves record_heartbeat=False); the router's
    atomic-submit wrapper passes record_heartbeat=True with its worker_id/last_ip/
    sf_version/worker_schema_version/n_evals (PRUNE-06 telemetry — a sibling call to
    apply_completion_decision, not folded into it).

    count_flaws_written: the atomic-submit wrapper needs flaws_written for its
    response payload (a cheap indexed COUNT); the drain tick has no such need and
    defaults this off to avoid adding an unnecessary query to its per-tick cost.

    stored_eval_predates_engine (tier3-branch-b-one-ply-stamp fix): threaded to both
    `_apply_full_eval_results` (via `_is_engine_hole`) and `_count_prior_holes` below
    — see `_is_engine_hole`'s docstring. Only `_apply_atomic_submit` (the only caller
    that ever passes preserve_existing_evals=True) needs to pass a real value; the
    drain tick's default (False) is inert because it never sets preserve_existing_evals.

    Returns:
        (failed_ply_count, stamp_complete, flaws_written) — flaws_written is 0
        when count_flaws_written is False.
    """
    # 260825-v8g (FLAWCHESS-9F / FLAWCHESS-8G): serialize same-game writers for the
    # whole write session before any row work runs — see the docstring paragraph
    # above for the deadlock/correctness rationale.
    await write_session.execute(
        sa.text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": _game_write_lock_key(game_id)},
    )

    failed_ply_count = await _apply_full_eval_results(
        write_session,
        targets,
        dedup_map,
        engine_result_map,
        is_lichess_eval_game,
        preserve_existing_evals=preserve_existing_evals,
        stored_eval_predates_engine=stored_eval_predates_engine,
    )

    await _classify_and_fill_oracle(
        write_session,
        game_id,
        engine_result_map,
        flaw_pv_blobs,
        blobs_pending=blobs_pending,
    )

    # Phase 174 GEMS-03: persist best-move candidate rows (built off-session by
    # _build_best_move_candidates) in THIS write_session so they commit atomically
    # with the eval + flaws (T-174-12). Both lanes funnel through here.
    if best_move_rows:
        await _upsert_best_move_rows(write_session, best_move_rows)

    # Phase 176 BACK-01/D-01: independent Maia-availability signal for the
    # completion-marker guardrail below — NEVER inferred from best_move_rows
    # being empty (RESEARCH Pitfall 1: _build_best_move_candidates returns []
    # for both "Maia ran, zero candidates" and "Maia absent").
    maia_available = maia_engine.is_maia_available()

    flaws_written = 0
    if count_flaws_written:
        flaws_written = (
            await write_session.scalar(
                sa.select(sa.func.count()).select_from(GameFlaw).where(GameFlaw.game_id == game_id)
            )
        ) or 0

    if update_opening_cache:
        # WR-01: update_opening_cache=True implies both upsert_opening_cache_fn and
        # engine_targets_for_cache must be supplied. Fail loudly on a future caller
        # mistake instead of silently no-op'ing the opening-cache write (the prior
        # `and upsert_opening_cache_fn is not None` guard swallowed that mistake).
        assert upsert_opening_cache_fn is not None, (
            "update_opening_cache=True requires upsert_opening_cache_fn"
        )
        assert engine_targets_for_cache is not None, (
            "update_opening_cache=True requires engine_targets_for_cache"
        )
        # SEED-053 / D-123.1-04: fill the opening-eval cache with freshly-computed
        # misses. Runs inside the same write txn — cache write + eval write commit
        # atomically. Skipped for lichess-eval games (no engine_targets generated).
        await upsert_opening_cache_fn(
            write_session, list(engine_targets_for_cache), engine_result_map
        )

    # SEED-139 D-01: the no-progress carve-out is threaded ONLY for the atomic
    # lane (preserve_existing_evals=True). The drain lane's failed_ply_count is
    # NOT a comparable snapshot: under preserve_existing_evals=False the write
    # does not NULL out a row's surviving stored eval, so failed_ply_count
    # over-counts relative to the DB, and the drain never threads
    # stored_best_move, so on a lichess-eval game its prior count would be
    # EVERY non-terminal ply — post < prior would hold on every tick and the
    # loop would never charge an attempt (a D-116-07 violation). Passing None
    # keeps the drain's existing per-submit charge with zero blast radius.
    prior_failed_ply_count = (
        _count_prior_holes(targets, is_lichess_eval_game, stored_eval_predates_engine)
        if preserve_existing_evals
        else None
    )

    # R1: shared Path A/B'/B/C completion decision + guarded eval_jobs stamp.
    stamp_complete = await apply_completion_decision(
        write_session,
        game_id=game_id,
        job_id=job_id,
        failed_ply_count=failed_ply_count,
        current_attempts=current_attempts,
        source=source,
        on_path_c_capacity_reached=on_path_c_capacity_reached,
        maia_available=maia_available,
        prior_failed_ply_count=prior_failed_ply_count,
    )

    if record_heartbeat:
        # PRUNE-06: passive telemetry only (D-01/D-04) — no gate, submits only.
        #
        # 260725-da3 (FLAWCHESS-8B): n_holes/n_plies_leased give a per-worker hole
        # RATE, the only mechanism that can answer "is it one slow worker?" — the
        # holed population is tier-3 idle-lottery derived, so eval_jobs.leased_by is
        # NULL for all of it. Deliberately counted on EVERY attempt (Path A/B/C
        # alike), not just the Path-C cap path: per-attempt telemetry makes a slow
        # worker visible before it burns all MAX_EVAL_ATTEMPTS. Only the atomic lane
        # sets record_heartbeat=True, so the rate's denominator stays lane-pure.
        await upsert_worker_heartbeat(
            write_session,
            worker_id=heartbeat_worker_id or "",
            last_ip=heartbeat_last_ip,
            sf_version=heartbeat_sf_version,
            worker_schema_version=heartbeat_worker_schema_version,
            n_evals=heartbeat_n_evals,
            n_holes=failed_ply_count,
            n_plies_leased=heartbeat_n_evals,
        )

    # _signal_flaw_completion is deliberately NOT called here: both pre-move call
    # sites invoke it only AFTER their own session-owning `async with` block commits
    # (Phase 117 D-117-11 — never fire the completion signal for a partially-
    # committed game). Since this function does not own/commit the session, the
    # caller calls _signal_flaw_completion(user_id) itself, gated on stamp_complete,
    # after its own commit succeeds.
    return failed_ply_count, stamp_complete, flaws_written
