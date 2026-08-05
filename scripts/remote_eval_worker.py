"""Headless remote eval worker for the trusted operator eval pipeline (Phase 120 SEED-048).

Runs on a trusted off-box machine. Loops: lease the next eval game (tier-1 > tier-2 >
tier-3) from the FlawChess API, evaluate all its FENs locally via EnginePool, and
batch-submit the results — tier-1/tier-2 claims echo a job token so the server stamps
the eval_jobs row complete on submit (Phase 121 SEED-048). The server
owns the SEED-044 storage convention (post-move shift, ply keying) — this worker passes
engine results through UNCHANGED (D-2 / pitfall 1: no client-side post-move shift).

The operator token is read from EVAL_OPERATOR_TOKEN in the environment or the .env
file (loaded via app settings); --token overrides it for one-off runs. --base-url
defaults to the production API, so with the token in .env the worker needs no flags.

Usage:
    # Connectivity test (lease + eval only, no submit):
    uv run python scripts/remote_eval_worker.py --dry-run --once

    # Single game then exit:
    uv run python scripts/remote_eval_worker.py --once

    # Continuous loop (default), against the production API:
    uv run python scripts/remote_eval_worker.py

    # Point at a local/staging server:
    uv run python scripts/remote_eval_worker.py --base-url http://localhost:8000
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import FrameType
from typing import Any, Literal, TypeVar, cast

import chess
import httpx
import sentry_sdk

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Import ORM model registry so the SQLAlchemy mapper fully configures. Required by
# any app.* import chain that transitively touches FastAPI-Users' relationship
# (User.oauth_accounts → OAuthAccount). Pattern from scripts/resweep_holed_games.py.
import app.models.oauth_account  # noqa: E402, F401
import app.models.user  # noqa: E402, F401

from app.core.config import settings  # noqa: E402
from app.models.game_position import GamePosition  # noqa: E402
from app.services.engine import PV_CAP_PLIES, EnginePool, get_stockfish_version  # noqa: E402

# Phase 147 SEED-074 Part B: worker-side hint classification + PV walk reuse the
# fat `app.*` client pattern already established for _eval_flaw_blob_positions —
# this worker imports server-internal helpers directly rather than duplicating them.
# _walk_pv_boards / _run_all_moves_pass are leading-underscore "module-private" by
# convention only; app/routers/eval_remote.py already imports _derive_atomic_sentinel_lines
# the same way (precedent), so this is consistent cross-module reuse, not a layering break.
from app.services.eval_drain import _walk_pv_boards  # noqa: E402
from app.services.flaws_service import _run_all_moves_pass  # noqa: E402

# ─── Named constants (no magic numbers) ──────────────────────────────────────

DEFAULT_BASE_URL: str = "https://flawchess.com"
DEFAULT_WORKERS: int = 4
# Lowered from 5.0 to 1.0 (Phase 121): only the empty-queue / 204 path sleeps,
# so this affects only idle-pickup latency for a freshly-enqueued tier-1 job.
# The busy path (a game was leased) is already a tight loop — unchanged.
DEFAULT_IDLE_SLEEP: float = 1.0
HTTP_TIMEOUT_S: float = 30.0
# How long a streak of *expected transient* cycle failures (502/ReadTimeout/ConnectError
# etc.) must persist before the worker escalates ONE Sentry event. A continuous polling
# daemon rides out deploys, backend restarts, and load-balancer hiccups routinely — those
# are operational churn, not bugs, so capturing each one floods Sentry and burns the error
# quota (hundreds of near-identical 502/ReadError events that told us nothing). 300s clears
# any normal deploy/restart window, so only a genuine sustained outage escalates. See
# _is_expected_transient / _run_loop.
TRANSIENT_FAILURE_ALERT_S: float = 300.0
# HTTP status codes treated as transient alongside all 5xx: 401 (stale-token / rotation
# race), 404 (lease already taken by another worker), 409 (claim conflict), 425/429
# (too-early / rate-limited). A persistent one still escalates via the streak timer.
_TRANSIENT_HTTP_STATUSES: frozenset[int] = frozenset({401, 404, 409, 425, 429})
# D-10 (Phase 123 SEED-051): worker IDs must fit VARCHAR(16) on games.entry_eval_leased_by.
# Random default is ~8 base36 chars; operator override is validated < 10 chars.
WORKER_ID_MAX_LEN: int = 9  # exclusive upper bound: len < 10
_WORKER_ID_ALPHABET: str = "0123456789abcdefghijklmnopqrstuvwxyz"
_WORKER_ID_DEFAULT_LEN: int = 8

# Phase 147 SEED-074 Part B (Q5, RESEARCH.md "Claude's Discretion"): observability
# and stale-worker rejection ONLY on /atomic-submit — the server never gates
# correctness on this value there, it always re-classifies authoritatively. Bump
# when the atomic submit payload shape changes in a way the server should be able
# to distinguish.
#
# Phase 177 PROTO-01/S-03: bumped 1 -> 2 AND now gates /atomic-lease itself (both
# scope=explicit and scope=idle, sent as a query param, not just on submit) —
# a v1 (or version-omitting) worker binary gets 204 (no work) on the WHOLE atomic
# lane and idles harmlessly until upgraded, rather than leasing tier-1/2/3 work it
# cannot compute the new fresh-lane second_best[] for. See WORKER_SCHEMA_VERSION_MIN
# in app/routers/eval_remote.py (the server-side gate this value must clear).
WORKER_SCHEMA_VERSION: int = 2

# SEED-063 D3: internal marker distinguishing the supervisor (parent, no marker) from
# the child (marker set) it spawns. NOT an argparse flag — kept out of --help (D3).
_CHILD_MARKER_ENV: str = "_FLAWCHESS_WORKER_CHILD"
_CHILD_MARKER_VALUE: str = "1"
# Fixed-small backoff before relaunching a crashed/wedged child (SEED-063: fixed, NOT
# capped-exponential -- predictable behavior for volunteers watching the logs).
SUPERVISOR_BACKOFF_S: float = 3.0

# SEED-139 D-05: one extra, longer-wall-clock pass over positions whose first
# search returned the all-None engine-failure tuple. 3x the pool's 5s default
# guard — long enough that a merely-oversubscribed box's retry succeeds, short
# enough to stay a bounded wall-clock allowance, not a second search budget.
EVAL_RETRY_TIMEOUT_S: float = 15.0
# Per CYCLE (shared across ALL passes _eval_atomic_game runs — D-05), NOT per
# pass: a per-pass cap would multiply by the three passes and blow the
# STALL_THRESHOLD_S headroom below. 8 positions x 15s = 120s worst-case added
# wall clock at --workers 1.
EVAL_RETRY_MAX_POSITIONS: int = 8

# SEED-063 watchdog: 10 minutes, NOT seconds. Must clear the slowest LEGITIMATE cycle
# so a slow-but-healthy worker is never killed. A tier-1 game = 100 positions; with
# _NODES_TIMEOUT_S=5s the worst case is ~(100 / --workers) x 5s if every position times
# out -- ~125s at --workers 4, but ~250s at --workers 2 and up to ~500s at --workers 1.
# The original 240s tripped on slower boxes / low worker counts doing honest work (a
# false restart also discards in-progress analysis and forces an EnginePool rebuild, so
# it makes a slow machine contribute even less). 600s leaves generous headroom even for
# --workers 1. Raising it only delays recovery from a GENUINE wedge (the
# InvalidStateError storm's future never resolves), so it can never mask a real hang.
#
# SEED-139 D-05: raised 600.0 -> 720.0 to absorb the worker-side retry pass added
# above. Worst legitimate cycle is still ~500s at --workers 1 (unchanged — the
# retry only fires on ALREADY-failed positions, it never widens the first-pass
# timeout); the retry pass adds at most EVAL_RETRY_MAX_POSITIONS *
# EVAL_RETRY_TIMEOUT_S = 8 * 15.0 = 120s on top of that, so the worst case rises
# to ~620s. 720s preserves the same ~100s margin the 600s value had over its own
# ~500s worst case. Raising it only delays recovery from a genuine wedge, so it
# can never mask a real hang (same invariant as before).
STALL_THRESHOLD_S: float = 720.0
# How often the watchdog checker task wakes to compare now vs. last_progress.
WATCHDOG_POLL_INTERVAL_S: float = 15.0
# Override env var for the heartbeat file path (used by the Docker healthcheck so it
# agrees with the worker on the same path).
HEARTBEAT_FILE_ENV: str = "FLAWCHESS_WORKER_HEARTBEAT_FILE"
_DEFAULT_HEARTBEAT_FILE: Path = Path(tempfile.gettempdir()) / "flawchess-worker.heartbeat"


# ─── Logging helper ───────────────────────────────────────────────────────────


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


# ─── SEED-139 D-05: bounded per-cycle worker-side retry of timed-out positions ─

_ResultTuple = TypeVar("_ResultTuple", bound=tuple[Any, ...])


@dataclass
class _RetryBudget:
    """Mutable per-CYCLE retry allowance, shared across all passes `_eval_atomic_game`
    runs (D-05). NOT per-pass — a per-pass cap would multiply by the three passes
    and blow the STALL_THRESHOLD_S headroom. Construct via `_fresh_retry_budget()`.
    """

    remaining: int = field(default=EVAL_RETRY_MAX_POSITIONS)


def _fresh_retry_budget() -> _RetryBudget:
    """A budget seeded from EVAL_RETRY_MAX_POSITIONS, for a standalone call/test
    that does not thread a shared budget through `_eval_atomic_game`."""
    return _RetryBudget(remaining=EVAL_RETRY_MAX_POSITIONS)


def _is_engine_failure(result: tuple[Any, ...]) -> bool:
    """An engine-failure tuple is one whose first TWO elements (eval_cp, eval_mate)
    are both None. Identical for the 4-tuple (evaluate_nodes_with_pv) and 7-tuple
    (evaluate_nodes_multipv2) shapes, and correctly does NOT flag a mate-only
    score (eval_cp None, eval_mate set is a real result, not a failure)."""
    return result[0] is None and result[1] is None


async def _retry_timed_out(
    analyse: Callable[[chess.Board], Coroutine[Any, Any, _ResultTuple]],
    boards: list[chess.Board],
    results: list[_ResultTuple],
    budget: _RetryBudget,
) -> list[_ResultTuple]:
    """Re-run, at a longer wall clock, only the positions whose first search
    returned the all-None engine-failure tuple (SEED-139 items 1-2).

    `analyse` is the caller-bound retry call (e.g. a lambda closing over
    `pool.evaluate_nodes_with_pv(board, timeout_s=EVAL_RETRY_TIMEOUT_S)`), so this
    helper stays result-shape-agnostic (4-tuple or 7-tuple, via the TypeVar).

    Selects the failed indices, truncates the selection to `budget.remaining`,
    decrements the budget by however many are actually retried, logs one summary
    line, and re-runs only those boards via `asyncio.gather` (safe here — no
    `AsyncSession` is open in the worker process). A successful retry replaces the
    failure in a COPY of `results`; a retry that fails again leaves the original
    all-None tuple in place (still submitted as a hole, as before — never garbage,
    never dropped).

    Returns `results` unchanged, and issues ZERO engine calls, when nothing failed
    or the budget is already exhausted.
    """
    failed_indices = [i for i, r in enumerate(results) if _is_engine_failure(r)]
    if not failed_indices or budget.remaining <= 0:
        return results

    retry_indices = failed_indices[: budget.remaining]
    budget.remaining -= len(retry_indices)
    _log(
        f"retrying {len(retry_indices)} timed-out position(s) at "
        f"{EVAL_RETRY_TIMEOUT_S}s (budget remaining after: {budget.remaining})"
    )
    retry_results = await asyncio.gather(*(analyse(boards[i]) for i in retry_indices))

    merged = list(results)
    for idx, retried in zip(retry_indices, retry_results):
        if not _is_engine_failure(retried):
            merged[idx] = retried
    return merged


# ─── Worker-ID helper ────────────────────────────────────────────────────────


def _generate_worker_id() -> str:
    """Generate a random ~8-char base36 worker ID for D-10 / SEED-051.

    Uses secrets.randbelow for each character to ensure cryptographic randomness.
    Result is guaranteed < 10 chars, fitting VARCHAR(16) with headroom (D-09).
    """
    return "".join(
        _WORKER_ID_ALPHABET[secrets.randbelow(len(_WORKER_ID_ALPHABET))]
        for _ in range(_WORKER_ID_DEFAULT_LEN)
    )


# ─── Eval helper ─────────────────────────────────────────────────────────────


async def _eval_positions(
    pool: EnginePool,
    positions: list[dict[str, object]],
    budget: _RetryBudget | None = None,
) -> list[dict[str, object]]:
    """Evaluate all positions from a lease response via EnginePool fan-out.

    Returns a list of eval dicts keyed by ply. Results are passed through
    UNCHANGED from the engine — NO post-move shift, NO transformation.
    The server owns the SEED-044 storage convention (D-2 / pitfall 1).

    Phase 146 D-03 consequence: reduced to MultiPV-1 (evaluate_nodes_with_pv, 4-tuple) now
    that per-ply second-best was dropped from SubmitEval. The tier-4 blob rung
    (_eval_flaw_blob_positions) still evaluates at MultiPV-2 where the blob contract
    requires second-best.

    Each position dict contains: ply, fen, is_terminal.
    Each output dict contains:  ply, eval_cp, eval_mate, best_move, pv.

    SEED-139 items 1-2: this is THE hole source, so it is the first of the four
    passes retried once at EVAL_RETRY_TIMEOUT_S on a failed position. `budget`
    defaults to a fresh one when omitted (standalone calls, existing tests);
    `_eval_atomic_game` passes ONE shared budget across all three of its passes.
    """
    boards: list[chess.Board] = [chess.Board(str(pos["fen"])) for pos in positions]
    results = list(await asyncio.gather(*(pool.evaluate_nodes_with_pv(b) for b in boards)))
    results = await _retry_timed_out(
        lambda b: pool.evaluate_nodes_with_pv(b, timeout_s=EVAL_RETRY_TIMEOUT_S),
        boards,
        results,
        budget if budget is not None else _fresh_retry_budget(),
    )
    return [
        {
            "ply": pos["ply"],
            "eval_cp": r[0],
            "eval_mate": r[1],
            "best_move": r[2],
            "pv": r[3],
        }
        for pos, r in zip(positions, results)
    ]


async def _eval_flaw_blob_positions(
    pool: EnginePool,
    positions: list[dict[str, object]],
    budget: _RetryBudget | None = None,
) -> list[dict[str, object]]:
    """Evaluate flaw-blob positions at MultiPV=2 and echo tokens (D-04a).

    Worker stays token-opaque: the token is echoed unchanged from the lease response;
    the server holds the flaw-structure reassembly map. Returns dicts with keys:
    {token, best_cp, best_mate, second_cp, second_mate, second_uci}.

    The MultiPV-2 engine call returns a 7-tuple:
        (eval_cp, eval_mate, best_move, pv, second_cp, second_mate, second_uci)
    Indices r[2] (best_move) and r[3] (pv) are intentionally NOT included in the
    output — these are PV-continuation FENs, not game plies. Indices are mapped
    explicitly to avoid off-by-one errors (RESEARCH Pitfall 3).

    asyncio.gather is safe here — no AsyncSession is open in the worker process.
    The CLAUDE.md gather rule applies to the server only (RESEARCH Pitfall 6).

    SEED-139 items 1-2: retried once at EVAL_RETRY_TIMEOUT_S on a failed
    position. `budget` defaults to a fresh one when omitted — this rung is a
    standalone tier-4 pass, not one of `_eval_atomic_game`'s three.
    """
    boards: list[chess.Board] = [chess.Board(str(pos["fen"])) for pos in positions]
    results = list(await asyncio.gather(*(pool.evaluate_nodes_multipv2(b) for b in boards)))
    results = await _retry_timed_out(
        lambda b: pool.evaluate_nodes_multipv2(b, timeout_s=EVAL_RETRY_TIMEOUT_S),
        boards,
        results,
        budget if budget is not None else _fresh_retry_budget(),
    )
    return [
        {
            "token": str(pos["token"]),  # echoed unchanged (D-04a)
            "best_cp": r[0],
            "best_mate": r[1],
            "second_cp": r[4],
            "second_mate": r[5],
            "second_uci": r[6],
        }
        for pos, r in zip(positions, results)
    ]


# ─── Atomic eval+blob helpers (Phase 147 SEED-074 Part B) ────────────────────


def _hint_flaw_plies(evals: list[dict[str, object]]) -> set[int]:
    """LOCAL flaw-ply HINT via `_run_all_moves_pass` (mistake/blunder only).

    Builds lightweight in-memory `GamePosition` objects (never persisted — no
    session, no flush, no DB round-trip) carrying only the ply-indexed
    `eval_cp`/`eval_mate` this worker just computed in the full-ply MultiPV-1
    pass, matching the SEED-044 post-move eval convention `_run_all_moves_pass`
    expects. No PGN, no `Game` row needed (Q4/RESEARCH A2 — the narrower hint).

    This is a HINT ONLY (T-147-03): it decides which plies get a MultiPV-2
    continuation blob walked below, nothing more. The server re-runs
    `classify_game_flaws` authoritatively on its own `game_positions` and never
    trusts which plies this function returns.
    """
    eval_by_ply: dict[int, dict[str, object]] = {int(cast(int, e["ply"])): e for e in evals}
    if not eval_by_ply:
        return set()
    max_ply = max(eval_by_ply)

    # CR-02 fix: evals is POSITION-keyed (eval OF the board at `ply`), but
    # _run_all_moves_pass expects ROW-keyed / POST-MOVE values — row `m` must
    # hold pos_eval[m + 1], matching _post_move_eval (app/services/eval_drain.py).
    # Without this +1 shift, hint_positions[k] == db_row[k-1], which
    # systematically reports the flaw one ply off (see CR-02, 147-REVIEW.md).
    hint_positions: list[GamePosition] = []
    for row_ply in range(max_ply):  # one hint row per real move (0..max_ply-1)
        pos = GamePosition()
        pos.ply = row_ply
        e = eval_by_ply.get(row_ply + 1)
        pos.eval_cp = cast("int | None", e["eval_cp"]) if e is not None else None
        pos.eval_mate = cast("int | None", e["eval_mate"]) if e is not None else None
        hint_positions.append(pos)

    all_moves = _run_all_moves_pass(hint_positions)
    return {
        ply
        for ply, (_mover, severity, _es_before, _es_after) in all_moves.items()
        if severity in ("mistake", "blunder")
    }


def _build_blob_walk_targets(
    positions: list[dict[str, object]],
    evals: list[dict[str, object]],
    flaw_plies: set[int],
) -> tuple[list[chess.Board], list[str]]:
    """Walk the missed/allowed PV lines for each hinted flaw ply.

    Mirrors the server's own walk (`_derive_atomic_sentinel_lines`,
    `app/services/eval_drain.py`): missed line starts at the board for
    `flaw_ply` (the position the flaw-maker faced), allowed line starts at the
    board for `flaw_ply + 1` (the position after the flaw move — the
    refutation's starting point). D-04a token scheme reused: `"{flaw_ply}:{line}:{node_k}"`.

    A line whose start ply has no FEN in this lease payload (e.g. flaw_ply is
    the game's last ply, so flaw_ply + 1 does not exist) is simply skipped —
    the server independently re-derives sentinel status for any line this
    worker could not walk (T-147-03; never trusts which lines were sent).
    """
    fen_by_ply: dict[int, str] = {int(cast(int, p["ply"])): str(p["fen"]) for p in positions}
    pv_by_ply: dict[int, str | None] = {
        int(cast(int, e["ply"])): cast("str | None", e.get("pv")) for e in evals
    }

    boards: list[chess.Board] = []
    tokens: list[str] = []
    for flaw_ply in sorted(flaw_plies):
        for line, node0_ply in (("missed", flaw_ply), ("allowed", flaw_ply + 1)):
            start_fen = fen_by_ply.get(node0_ply)
            if start_fen is None:
                continue
            walk = _walk_pv_boards(chess.Board(start_fen), pv_by_ply.get(node0_ply), PV_CAP_PLIES)
            for k, board in enumerate(walk):
                boards.append(board)
                tokens.append(f"{flaw_ply}:{line}:{k}")
    return boards, tokens


async def _eval_atomic_blob_nodes(
    pool: EnginePool,
    boards: list[chess.Board],
    tokens: list[str],
    budget: _RetryBudget | None = None,
) -> list[dict[str, object]]:
    """Evaluate walked continuation boards at MultiPV=2, echoing tokens (D-04a).

    Mirrors `_eval_flaw_blob_positions`' index mapping exactly (r[0]/r[1]/r[4]/
    r[5]/r[6]; r[2]=best_move and r[3]=pv are intentionally excluded — these are
    PV-continuation FENs, not game plies). `asyncio.gather` is safe here — no
    `AsyncSession` is open in the worker process (CLAUDE.md gather rule applies
    to the server only, RESEARCH Pitfall 6).

    SEED-139 items 1-2: retried once at EVAL_RETRY_TIMEOUT_S on a failed
    position. `budget` defaults to a fresh one when omitted; `_eval_atomic_game`
    passes its own shared budget here (one of its three passes).
    """
    results = list(await asyncio.gather(*(pool.evaluate_nodes_multipv2(b) for b in boards)))
    results = await _retry_timed_out(
        lambda b: pool.evaluate_nodes_multipv2(b, timeout_s=EVAL_RETRY_TIMEOUT_S),
        boards,
        results,
        budget if budget is not None else _fresh_retry_budget(),
    )
    return [
        {
            "token": token,
            "best_cp": r[0],
            "best_mate": r[1],
            "second_cp": r[4],
            "second_mate": r[5],
            "second_uci": r[6],
        }
        for token, r in zip(tokens, results)
    ]


async def _eval_targeted_second_best(
    pool: EnginePool,
    positions: list[dict[str, object]],
    evals: list[dict[str, object]],
    budget: _RetryBudget | None = None,
) -> list[dict[str, object]]:
    """Targeted MultiPV-2 runner-up search for fresh-lane gem candidates (PROTO-02).

    For every leased position whose `move_uci` (the move actually PLAYED at this
    ply, Phase 177 lease field) equals this worker's OWN MultiPV-1 best move (from
    `evals`, the just-completed full-ply pass), run a SECOND, separate
    `evaluate_nodes_multipv2` search and collect the runner-up eval. This is purely
    additive: it never widens the full-ply pass itself (which stays MultiPV-1 —
    Phase 146 D-03 invariant, see `test_eval_positions_uses_multipv1_no_second_best`
    / `test_eval_atomic_game_full_ply_pass_stays_multipv1`).

    A candidate with no `move_uci` (the terminal donor, or a v1-shaped lease
    response) is never a candidate — `move_uci is None` never equals a real UCI
    string. Positions whose own best move differs from the played move (played !=
    best) are excluded entirely — they were never gem candidates in the first place.

    SEED-139 items 1-2: the retry runs BEFORE the drop-on-failure filter below, so
    a transient failure no longer costs the candidate — only a position that fails
    TWICE (first search AND retry) is dropped. `budget` defaults to a fresh one
    when omitted; `_eval_atomic_game` passes its own shared budget here.

    A search that still fails after the retry (the all-None 7-tuple
    `evaluate_nodes_multipv2` returns when the pool isn't started or the engine
    errors) DROPS that ply from the returned list rather than submitting garbage or
    failing the whole submit (T-177-14) — the server's own Pitfall-1 fallback
    (`_build_best_move_candidates`) covers the gap for that one ply.

    `asyncio.gather` is safe here — no `AsyncSession` is open in the worker process
    (CLAUDE.md gather rule applies to the server only).
    """
    best_by_ply: dict[int, str | None] = {
        int(cast(int, e["ply"])): cast("str | None", e.get("best_move")) for e in evals
    }
    candidates: list[dict[str, object]] = [
        pos
        for pos in positions
        if (move_uci := cast("str | None", pos.get("move_uci"))) is not None
        and best_by_ply.get(int(cast(int, pos["ply"]))) == move_uci
    ]
    if not candidates:
        return []

    boards = [chess.Board(str(pos["fen"])) for pos in candidates]
    results = list(await asyncio.gather(*(pool.evaluate_nodes_multipv2(b) for b in boards)))
    results = await _retry_timed_out(
        lambda b: pool.evaluate_nodes_multipv2(b, timeout_s=EVAL_RETRY_TIMEOUT_S),
        boards,
        results,
        budget if budget is not None else _fresh_retry_budget(),
    )

    second_best: list[dict[str, object]] = []
    for pos, r in zip(candidates, results):
        if _is_engine_failure(r):
            continue  # failed twice (search + retry) — drop, server fallback covers it
        second_best.append(
            {
                "ply": pos["ply"],
                "second_cp": r[4],
                "second_mate": r[5],
                "second_uci": r[6],
            }
        )
    return second_best


async def _eval_atomic_game(
    pool: EnginePool,
    positions: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]], list[dict[str, object]]]:
    """Evaluate full-ply (MultiPV-1), then locally hint + blob flaw plies (Part B),
    then run the Phase 177 targeted second-best re-search (PROTO-02).

    The full-ply pass reuses `_eval_positions` UNCHANGED (MultiPV-1 — Phase 146
    D-03 invariant; MUST NOT regress to MultiPV-2, see
    `test_eval_positions_uses_multipv1_no_second_best`). The local hint
    (`_hint_flaw_plies`) is computed purely from the just-evaluated eval_cp/
    eval_mate and is NEVER submitted or trusted as authoritative (T-147-03) — it
    only decides which plies get a MultiPV-2 continuation blob walked and
    evaluated for the server to use as gate input in its own independent
    classify. The targeted second-best re-search (`_eval_targeted_second_best`)
    runs AFTER both of those, over the played==best plies only (S-01).

    SEED-139 D-05: creates ONE `_RetryBudget` here and shares it across all three
    passes — the retry budget is per CYCLE, not per pass.

    Returns (evals, blob_nodes, second_best) — all three go straight into the
    /atomic-submit body.
    """
    budget = _fresh_retry_budget()
    evals = await _eval_positions(pool, positions, budget)
    flaw_plies = _hint_flaw_plies(evals)
    boards, tokens = _build_blob_walk_targets(positions, evals, flaw_plies)
    blob_nodes = await _eval_atomic_blob_nodes(pool, boards, tokens, budget) if boards else []
    second_best = await _eval_targeted_second_best(pool, positions, evals, budget)
    return evals, blob_nodes, second_best


# SEED-139 D-06: the worker-side retry pass covers exactly the four passes the
# seed named — _eval_positions, _eval_flaw_blob_positions, _eval_atomic_blob_nodes,
# _eval_targeted_second_best (all above). Deliberately EXCLUDED, below:
# `_eval_entry_positions` (depth-15 cold entry-ply lane, its own `_TIMEOUT_S` guard
# — not the node-budget Path-C mechanism the seed measured) and
# `_eval_bestmove_positions` (tier-4b gem-candidate rung — a miss there costs a
# candidate the server's own fallback already covers). Neither can produce a
# `game_positions` eval hole, so retrying them would add wall clock for zero
# hole-prevention benefit.


async def _eval_entry_positions(
    pool: EnginePool,
    positions: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Evaluate entry-ply positions at depth-15 via EnginePool fan-out.

    CRITICAL: uses pool.evaluate (depth-15), NOT pool.evaluate_nodes_with_pv
    (the 1M-node full-ply mode). Mixing modes makes entry-ply 10x slower
    and uses the wrong eval budget (D-2 / RESEARCH Anti-pattern).

    Entry-ply carries no best_move/pv — depth-15 returns only (cp, mate).
    The server owns the SEED-044 storage convention; the worker passes
    eval_cp/eval_mate through UNCHANGED (D-2 / pitfall 1).

    Each position dict contains: game_id, ply, fen.
    Each output dict contains:  game_id, ply, eval_cp, eval_mate.
    """
    boards: list[chess.Board] = [chess.Board(str(pos["fen"])) for pos in positions]
    results = await asyncio.gather(*(pool.evaluate(b) for b in boards))
    return [
        {
            "game_id": pos["game_id"],
            "ply": pos["ply"],
            "eval_cp": r[0],
            "eval_mate": r[1],
        }
        for pos, r in zip(positions, results)
    ]


# ─── Watchdog (SEED-063: converts a HANG into a process exit) ───────────────


def _is_stalled(now: float, last_progress: float, threshold_s: float) -> bool:
    """Pure predicate: True once no cycle has completed for more than threshold_s.

    Never calls os._exit -- side-effect-free and safe to unit test directly.
    """
    return (now - last_progress) > threshold_s


class _Heartbeat:
    """Tracks wall-clock "last progress" and optionally freshens a heartbeat file.

    Uses wall-clock `time.time()` (NOT monotonic) so a laptop sleep/resume produces
    a huge gap -> instant restart on resume (SEED-063).
    """

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.last_progress: float = time.time()

    def mark(self) -> None:
        """Record progress now; best-effort freshen the heartbeat file's mtime.

        A file-write failure must NEVER kill the worker -- the heartbeat file is
        observability-only (it feeds the Docker healthcheck); the actual stall
        decision uses `self.last_progress` in memory, not the file.
        """
        self.last_progress = time.time()
        if self.path is not None:
            try:
                self.path.write_text(str(self.last_progress))
            except OSError:
                pass


def _heartbeat_file_path() -> Path:
    """Resolve the heartbeat file path: env override, else the default tmp path."""
    override = os.environ.get(HEARTBEAT_FILE_ENV)
    return Path(override) if override else _DEFAULT_HEARTBEAT_FILE


async def _watchdog_checker(
    heartbeat: _Heartbeat,
    threshold_s: float,
    poll_interval_s: float,
) -> None:
    """Periodically checks for a stalled worker and forces a process exit.

    `os._exit(1)` intentionally bypasses cleanup: the process is wedged with dead
    engines that cannot be cleanly stopped (the InvalidStateError storm scenario,
    SEED-063). The supervisor relaunches the child with a fresh EnginePool.
    """
    while True:
        await asyncio.sleep(poll_interval_s)
        if _is_stalled(time.time(), heartbeat.last_progress, threshold_s):
            _log(f"No progress for >{threshold_s:.0f}s — forcing restart.")
            sentry_sdk.capture_message("Remote eval worker stalled; forcing restart")
            os._exit(1)


def _loop_exception_handler(
    loop: asyncio.AbstractEventLoop,
    context: dict[str, object],
) -> None:
    """asyncio loop exception handler for callback exceptions that bypass
    `_run_loop`'s try/except entirely -- e.g. the InvalidStateError storm fired
    from the event loop's `_call_connection_lost` callback when all Stockfish
    subprocesses die at once (SEED-063 root cause). Sentry groups identical storm
    entries, so per-callback capture is safe here -- no N-in-window fast-path is
    needed (deferred; the stall timer alone is sufficient to force a restart).
    """
    exc = context.get("exception")
    if isinstance(exc, BaseException):
        sentry_sdk.capture_exception(exc)
    else:
        sentry_sdk.capture_message("Remote eval worker asyncio loop callback exception")
    _log(f"Loop exception handler: {context.get('message', 'unknown')}")


# ─── Main worker loop ─────────────────────────────────────────────────────────


def _is_expected_transient(exc: BaseException) -> bool:
    """True for operational churn a continuous polling daemon rides out silently.

    A worker looping against the API across deploys, backend restarts, and load-balancer
    hiccups WILL routinely see 5xx (Caddy 502/503 mid-restart), auth/claim races (401/404/
    409), and transport blips (ConnectError, ReadError, ReadTimeout, connection refused).
    None are bugs. Capturing each on every failed cycle floods Sentry and burns the error
    quota, and violates the CLAUDE.md "retry loops: capture on last attempt only" rule.
    These are ridden out; only a streak that persists past TRANSIENT_FAILURE_ALERT_S (a
    genuine sustained outage, not a deploy blip) escalates one event — see _run_loop.

    Anything NOT matched here (e.g. a pydantic ValidationError on a lease/submit payload,
    a bad-FEN ValueError, an unexpected type) is a real defect and captured immediately.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return code >= 500 or code in _TRANSIENT_HTTP_STATUSES
    # httpx.TransportError covers ConnectError/ReadError/ReadTimeout/ConnectTimeout;
    # the builtin ConnectionError covers a raw ConnectionRefusedError that reaches here
    # unwrapped.
    return isinstance(exc, (httpx.TransportError, ConnectionError))


async def _run_loop(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    idle_sleep: float,
    dry_run: bool,
    loop: bool,
    heartbeat: _Heartbeat | None = None,
) -> None:
    """Inner lease → eval → submit loop.

    On 204 (empty queue): sleep `idle_sleep` seconds and continue if `loop`,
    else return. On 2xx lease response: evaluate all positions, then submit
    unless `dry_run`. Exits cleanly when `not loop` after one game cycle.

    Each cycle is wrapped in an exception boundary: a transient network error,
    a 5xx (raise_for_status), or a bad FEN must not kill a continuous daemon. When
    looping, the worker backs off `idle_sleep` and retries. When not looping the
    exception propagates so --once surfaces failures with a non-zero exit.

    Sentry policy (quota hygiene): expected transient failures (_is_expected_transient)
    are logged locally and NOT captured per-cycle — only ONE event escalates once a
    failure streak has persisted past TRANSIENT_FAILURE_ALERT_S (a real sustained outage,
    not a deploy blip). Unexpected exceptions (a genuine bug) are captured immediately.
    A successful cycle resets the streak. `--once` runs surface everything.

    SEED-063: `heartbeat.mark()` is called after each `_run_cycle` that returns
    WITHOUT raising -- BEFORE the stop check. A clean 204 idle cycle returns
    normally, so it counts as progress (an idle worker with an empty queue is
    healthy, not stalled). A failed cycle (the except branch) is NOT progress.
    """
    # Transient-failure streak tracking: start timestamp of the current uninterrupted
    # run of expected-transient failures, and whether we've already escalated it once.
    streak_start: float | None = None
    streak_alerted: bool = False
    while True:
        try:
            stop = await _run_cycle(client, pool, sf_version, idle_sleep, dry_run, loop)
        except (KeyboardInterrupt, asyncio.CancelledError):
            raise
        except Exception as exc:
            # --once (manual run): surface everything, then re-raise for a non-zero exit.
            if not loop:
                sentry_sdk.capture_exception(exc)
                raise
            if _is_expected_transient(exc):
                streak_start, streak_alerted = _handle_transient_failure(
                    exc, streak_start, streak_alerted
                )
            else:
                # Genuine defect (bad payload, ValidationError, unexpected type): capture now.
                sentry_sdk.capture_exception(exc)
                _log("Cycle failed (unexpected); see Sentry. Backing off...")
            await asyncio.sleep(idle_sleep)
            continue

        # Success: reset the transient-failure streak.
        streak_start = None
        streak_alerted = False
        if heartbeat is not None:
            heartbeat.mark()
        if stop:
            return


def _handle_transient_failure(
    exc: BaseException,
    streak_start: float | None,
    streak_alerted: bool,
) -> tuple[float, bool]:
    """Log a transient cycle failure; escalate ONE Sentry event if the streak persists.

    Returns the updated (streak_start, streak_alerted). The first transient failure of a
    streak stamps `streak_start`; once the streak has run continuously past
    TRANSIENT_FAILURE_ALERT_S we capture exactly one warning (variable data goes in the
    Sentry context, not the message, to preserve grouping) and set `streak_alerted`.
    """
    now = time.time()
    if streak_start is None:
        streak_start = now
        streak_alerted = False
    elapsed = now - streak_start
    if elapsed >= TRANSIENT_FAILURE_ALERT_S and not streak_alerted:
        sentry_sdk.set_context(
            "worker_outage", {"streak_seconds": round(elapsed), "error": repr(exc)}
        )
        sentry_sdk.set_tag("source", "remote_eval_worker")
        sentry_sdk.capture_message(
            "Remote eval worker: transient failures persisting past threshold",
            level="warning",
        )
        streak_alerted = True
    _log(f"Cycle failed (transient, {round(elapsed)}s streak). Backing off...")
    return streak_start, streak_alerted


async def _run_cycle(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    idle_sleep: float,
    dry_run: bool,
    loop: bool,
) -> bool:
    """Run one D-06 ladder cycle. Returns True when the loop should stop.

    D-06 ladder, now FIVE rungs (Phase 123 SEED-051; rung 4 added Phase 146 D-04;
    rung 5 added Phase 177 BACK-02/03). Rungs 1 and 3 upgraded to the atomic
    (versioned) eval+blob pair in Phase 147 SEED-074 Part B — this worker now
    exclusively leases/submits its full-ply tiers via /atomic-lease + /atomic-submit
    so a leased game is never written with a raw/ungated tactic tag (D-01). The old
    /lease + /submit pair (and this file's own now-removed full-ply response
    handler, which called it) has been deleted server-side and here — Phase 149-03
    PRUNE-01, after confirming zero legacy traffic across the fleet:
      1. POST /atomic-lease?scope=explicit&worker_schema_version=2 (tier-1/2 only)
         200 → eval full-ply (MultiPV-1) + local flaw-ply hint + MultiPV-2 blobs +
               the Phase 177 targeted second-best re-search, submit to
               /atomic-submit, done.
         204 → fall to rung 2.
      2. POST /entry-lease (entry-ply, gated by D-5 backlog probe server-side)
         200 → eval at depth-15, submit to /entry-submit, done.
         204 → fall to rung 3.
      3. POST /atomic-lease?scope=idle&worker_schema_version=2 (tier-3 only)
         200 → same atomic eval+blob+second-best+submit path as rung 1.
         204 → fall to rung 4.
      4. POST /flaw-blob-lease (tier-4 blob drain, Phase 146 D-04)
         200 → eval continuation FENs at MultiPV-2, submit to /flaw-blob-submit, done.
         204 → fall to rung 5.
      5. POST /bestmove-lease (tier-4b best-move backfill, Phase 177 BACK-02/03)
         200 → eval leased candidate-ply FENs at MultiPV-2 ONLY (no full pass, no
               blob walk), submit to /bestmove-submit, done.
         204 → all queues empty; sleep idle_sleep.

    Rung 5 is placed strictly AFTER rung 4 (Pitfall 6) so blob backfill (server
    tier 4) is always attempted before best-move backfill (server tier 5,
    TIER_BESTMOVE_BACKFILL) — the worker's ladder ordering mirrors the server's
    own tier-number priority even though the worker never sees the tier numbers
    themselves.

    Both /atomic-lease calls send worker_schema_version=WORKER_SCHEMA_VERSION as a
    query param (Phase 177 PROTO-01/S-03/Pitfall 4) — a v1 (or version-omitting)
    worker binary would be gated to 204 on this WHOLE lane by the server, not just
    the new tier-4b path.

    Busy paths (tier-1, entry-ply) stay at 1-2 calls. Only the fully-idle path
    makes all 5 round-trips. Entry-ply is always-on (D-08); the server D-5 gate
    makes it cost nothing when there's no big import.

    Returns True only in non-loop mode after a completed cycle (or an idle 204);
    in loop mode it always returns False so _run_loop keeps draining.
    """
    # ── Rung 1: explicit tier-1/2 (atomic eval+blob pair, Phase 147 Part B) ──
    lease_resp = await client.post(
        "/api/eval/remote/atomic-lease",
        params={"scope": "explicit", "worker_schema_version": WORKER_SCHEMA_VERSION},
    )

    if lease_resp.status_code != 204:
        # Got a tier-1/2 game — eval + hint + blob + submit atomically.
        return await _handle_atomic_response(client, pool, sf_version, dry_run, loop, lease_resp)

    # ── Rung 2: entry-ply (gated by D-5 backlog probe server-side) ───────────
    entry_resp = await client.post("/api/eval/remote/entry-lease")

    if entry_resp.status_code != 204:
        # Got entry-ply positions — eval at depth-15, submit to /entry-submit.
        return await _handle_entry_ply_response(client, pool, sf_version, dry_run, loop, entry_resp)

    # ── Rung 3: idle tier-3 (atomic eval+blob pair) ──────────────────────────
    idle_resp = await client.post(
        "/api/eval/remote/atomic-lease",
        params={"scope": "idle", "worker_schema_version": WORKER_SCHEMA_VERSION},
    )

    if idle_resp.status_code == 204:
        # Rung 4: tier-3 empty → try tier-4 flaw-blob drain (Phase 146 D-04).
        blob_resp = await client.post("/api/eval/remote/flaw-blob-lease")
        if blob_resp.status_code == 204:
            # Rung 5: tier-4 blob empty → try tier-4b best-move backfill
            # (Phase 177 BACK-02/03, Pitfall 6: strictly AFTER rung 4).
            bestmove_resp = await client.post("/api/eval/remote/bestmove-lease")
            if bestmove_resp.status_code == 204:
                _log("Queue fully empty (204). Sleeping...")
                await asyncio.sleep(idle_sleep)
                return not loop
            return await _handle_bestmove_response(
                client, pool, sf_version, dry_run, loop, bestmove_resp
            )
        return await _handle_flaw_blob_response(client, pool, sf_version, dry_run, loop, blob_resp)

    return await _handle_atomic_response(client, pool, sf_version, dry_run, loop, idle_resp)


async def _handle_atomic_response(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    dry_run: bool,
    loop: bool,
    lease_resp: httpx.Response,
) -> bool:
    """Handle a 200 response from /atomic-lease (Phase 147 SEED-074 Part B).

    Evaluates full-ply at MultiPV-1 (unchanged `_eval_positions`), derives a
    LOCAL flaw-ply HINT via `_run_all_moves_pass` (mistake/blunder only —
    never trusted as authoritative, T-147-03), walks + evaluates MultiPV-2
    continuation blobs for those hinted plies, runs the Phase 177 targeted
    second-best re-search for played==best plies (PROTO-02), then POSTs the
    full-ply evals, blob nodes, AND second_best TOGETHER to /atomic-submit in
    one request. The server re-runs `classify_game_flaws` authoritatively there
    and writes gated tactic tags + both completion markers in one transaction —
    this rung closes the ungated-window gap the Gen-1 /lease + /submit pair used
    to leave open (D-01, pair deleted server-side and here in Phase 149-03
    PRUNE-01): this worker's hint only decides WHICH plies get blobbed, never
    WHAT gets persisted.
    """
    lease_resp.raise_for_status()
    data = lease_resp.json()
    game_id = data["game_id"]
    positions = data["positions"]
    # Opaque job token from the lease response (eval_jobs.id for tier-1/2, None for tier-3).
    # The worker stores and echoes it without interpreting it; the server uses it to stamp
    # eval_jobs.status='completed' when the submit is clean and no holes remain.
    job_id = data.get("job_id")

    _log(f"Atomic-leased game_id={game_id} ({len(positions)} positions). Evaluating...")
    evals, blob_nodes, second_best = await _eval_atomic_game(pool, positions)

    if dry_run:
        _log(
            f"--dry-run: evaluated {len(evals)} positions + {len(blob_nodes)} blob nodes + "
            f"{len(second_best)} second_best for game_id={game_id}; skipping submit."
        )
        return not loop

    submit_resp = await client.post(
        "/api/eval/remote/atomic-submit",
        json={
            "game_id": game_id,
            "sf_version": sf_version,
            "worker_schema_version": WORKER_SCHEMA_VERSION,
            "evals": evals,
            "blob_nodes": blob_nodes,
            "second_best": second_best,
            "job_id": job_id,
        },
    )
    submit_resp.raise_for_status()
    result = submit_resp.json()
    _log(
        f"Atomic-submitted game_id={game_id}: flaws_written={result.get('flaws_written')}, "
        f"blobs_written={result.get('blobs_written')}"
    )
    return not loop


async def _handle_entry_ply_response(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    dry_run: bool,
    loop: bool,
    entry_resp: httpx.Response,
) -> bool:
    """Handle a 200 response from /entry-lease (depth-15 entry-ply path)."""
    entry_resp.raise_for_status()
    data = entry_resp.json()
    positions = data["positions"]

    _log(f"Leased {len(positions)} entry-ply position(s). Evaluating at depth-15...")
    evals = await _eval_entry_positions(pool, positions)

    if dry_run:
        _log(f"--dry-run: evaluated {len(evals)} entry-ply positions; skipping submit.")
        return not loop

    submit_resp = await client.post(
        "/api/eval/remote/entry-submit",
        json={
            "sf_version": sf_version,
            "evals": evals,
        },
    )
    submit_resp.raise_for_status()
    result = submit_resp.json()
    _log(
        f"Entry-submit complete: game_ids={result.get('game_ids')}, "
        f"stamped_count={result.get('stamped_count')}"
    )
    return not loop


async def _handle_flaw_blob_response(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    dry_run: bool,
    loop: bool,
    blob_lease_resp: httpx.Response,
) -> bool:
    """Handle a 200 response from /flaw-blob-lease (tier-4 blob drain path, D-04).

    Evaluates each leased FEN at MultiPV=2, then POSTs the results to
    /flaw-blob-submit. The server assembles PvNode blobs and runs the per-game
    gated retag (_classify_tactic_gated, D-07). Token is echoed unchanged (D-04a).
    """
    blob_lease_resp.raise_for_status()
    data = blob_lease_resp.json()
    game_id = data["game_id"]
    positions = data["positions"]

    # Positions are FENs expanded from each flaw's two PV walks (missed + allowed);
    # token format is "{flaw_ply}:{line}:{k}", so unique flaw plies = the flaw count
    # that blobs_written will report on submit. Log both so the counts share a frame.
    flaw_count = len({str(pos["token"]).split(":", 1)[0] for pos in positions})
    _log(
        f"Flaw-blob lease game_id={game_id} ({len(positions)} FENs across {flaw_count} flaws). "
        "Evaluating at MultiPV=2..."
    )
    evals = await _eval_flaw_blob_positions(pool, positions)

    if dry_run:
        _log(
            f"--dry-run: evaluated {len(evals)} flaw-blob positions for game_id={game_id}; skipping submit."
        )
        return not loop

    submit_resp = await client.post(
        "/api/eval/remote/flaw-blob-submit",
        json={"game_id": game_id, "sf_version": sf_version, "evals": evals},
    )
    submit_resp.raise_for_status()
    result = submit_resp.json()
    _log(f"Flaw-blob submit game_id={game_id}: blobs_written={result.get('blobs_written')}")
    return not loop


# ─── Rung-5 tier-4b best-move backfill helpers (Phase 177 BACK-02/03) ────────


async def _eval_bestmove_positions(
    pool: EnginePool,
    positions: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Evaluate tier-4b candidate-ply FENs at MultiPV=2 ONLY (rung 5, S-05).

    No full-ply pass, no blob walk — the server has ALREADY validated played==best
    candidacy server-side from its own stored data before leasing these FENs (Open
    Question #3, RESEARCH.md); the worker's only job here is the targeted MultiPV-2
    search. We submit r[4]/r[5]/r[6] (runner-up) AND r[0]/r[1] (fresh best cp/mate,
    Quick 260719-fsz): for lichess-eval games the server's stored eval_cp is LICHESS
    %eval, so it needs our fresh Stockfish best_cp for the divergence guard — see
    _apply_bestmove_submit. r[2]/r[3] (best_move/pv) are still not needed (the server
    keeps the stored best_move as the identity key).

    `asyncio.gather` is safe here — no `AsyncSession` is open in the worker process
    (CLAUDE.md gather rule applies to the server only).

    BUG FIX (177-REVIEW WR-01): a failed search (engine failure -> the all-None
    7-tuple `evaluate_nodes_multipv2` returns when the pool isn't started or the
    engine errors) is DROPPED from the returned list rather than submitted as a
    real (second_cp=None, second_mate=None) result. Without this filter, the
    server's `_apply_bestmove_submit` keys `second_best_map` on presence, not on
    non-None values, so the Pitfall-1 fallback never fires for that ply — instead
    the all-None tuple flows into `passes_inaccuracy_gate` (which returns False on
    any None eval) and the candidate is silently and permanently dropped instead
    of falling through to the server's own retry safety net. Mirrors the
    identical drop-on-failure filter in `_eval_targeted_second_best` above.
    """
    boards: list[chess.Board] = [chess.Board(str(pos["fen"])) for pos in positions]
    results = await asyncio.gather(*(pool.evaluate_nodes_multipv2(b) for b in boards))
    out: list[dict[str, object]] = []
    for pos, r in zip(positions, results):
        if r[0] is None and r[1] is None:
            continue  # engine failure (all-None 7-tuple) — drop, server fallback covers it
        out.append(
            {
                "ply": pos["ply"],
                "second_cp": r[4],
                "second_mate": r[5],
                "second_uci": r[6],
                # Quick 260719-fsz: fresh Stockfish best (MultiPV-2 line 1) so the
                # server does not fall back to the stored (lichess) eval as best_cp.
                "best_cp": r[0],
                "best_mate": r[1],
            }
        )
    return out


async def _handle_bestmove_response(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    dry_run: bool,
    loop: bool,
    bestmove_lease_resp: httpx.Response,
) -> bool:
    """Handle a 200 response from /bestmove-lease (tier-4b best-move backfill, D-02).

    Evaluates each leased candidate-ply FEN at MultiPV=2 only, then POSTs the
    per-ply runner-up evals to /bestmove-submit. The server writes ONLY
    game_best_moves rows + stamps best_moves_completed_at (S-06) — it never
    reclassifies or touches game_flaws (T-177-07). Mirrors
    `_handle_flaw_blob_response`'s shape; no token to echo here (the lease is
    already ply-keyed, no PV-walk reassembly needed — S-05).
    """
    bestmove_lease_resp.raise_for_status()
    data = bestmove_lease_resp.json()
    game_id = data["game_id"]
    positions = data["positions"]

    _log(
        f"Bestmove-leased game_id={game_id} ({len(positions)} candidate plies). "
        "Evaluating at MultiPV=2..."
    )
    evals = await _eval_bestmove_positions(pool, positions)

    if dry_run:
        _log(
            f"--dry-run: evaluated {len(evals)} bestmove candidate plies for "
            f"game_id={game_id}; skipping submit."
        )
        return not loop

    submit_resp = await client.post(
        "/api/eval/remote/bestmove-submit",
        json={"game_id": game_id, "sf_version": sf_version, "evals": evals},
    )
    submit_resp.raise_for_status()
    result = submit_resp.json()
    _log(f"Bestmove-submit game_id={game_id}: rows_written={result.get('rows_written')}")
    return not loop


# ─── Worker entrypoint ────────────────────────────────────────────────────────


async def run_worker(
    base_url: str,
    token: str,
    worker_id: str,
    workers: int,
    idle_sleep: float,
    dry_run: bool,
    loop: bool,
    heartbeat: _Heartbeat | None = None,
) -> None:
    """Start an EnginePool, read the SF version, then run the lease/eval/submit loop.

    worker_id is sent on every request via X-Worker-Id (D-10 / SEED-051) so that
    eval_jobs.leased_by and games.entry_eval_leased_by are per-worker in prod.

    `heartbeat` (SEED-063) defaults to None so existing callers/tests are unaffected;
    the supervised "child" role passes a `_Heartbeat` instance so `_run_loop` marks
    progress on every completed cycle for the watchdog checker.

    Handles KeyboardInterrupt gracefully — logs the interruption and ensures the
    pool is stopped via the finally block.
    """
    pool = EnginePool(workers)
    await pool.start()
    _log(f"EnginePool started with {workers} worker(s).")

    try:
        sf_version = await get_stockfish_version()
        _log(f"Stockfish version: {sf_version}")

        async with httpx.AsyncClient(
            base_url=base_url,
            # D-10: X-Worker-Id set once alongside X-Operator-Token — no per-call change.
            headers={"X-Operator-Token": token, "X-Worker-Id": worker_id},
            timeout=HTTP_TIMEOUT_S,
        ) as client:
            await _run_loop(
                client=client,
                pool=pool,
                sf_version=sf_version,
                idle_sleep=idle_sleep,
                dry_run=dry_run,
                loop=loop,
                heartbeat=heartbeat,
            )
    except KeyboardInterrupt:
        _log("Interrupted by user. Shutting down...")
    finally:
        await pool.stop()
        _log("EnginePool stopped.")


# ─── Supervisor (SEED-063: self-supervising auto-restart) ───────────────────


def _worker_role(once: bool, child_marker: bool) -> Literal["once", "supervisor", "child"]:
    """Pure dispatch predicate (SEED-063 D3).

    `--once` always bypasses supervision, regardless of the child marker. Otherwise
    the internal child-marker env var distinguishes the spawned child ("child") from
    the top-level, always-on supervisor ("supervisor").
    """
    if once:
        return "once"
    return "child" if child_marker else "supervisor"


def _run_supervisor() -> int:
    """Synchronous supervisor loop (SEED-063 D1/D3/D4/D5).

    Spawns a child copy of this script (internal marker env var, NOT an argparse
    flag) and relaunches it with a fixed backoff whenever it exits for ANY reason,
    unless the supervisor itself was asked to stop (SIGINT/SIGTERM). No max-restart
    cap -- keeps trying forever, matching Docker's `restart: unless-stopped`.

    Plain synchronous loop (subprocess + signal + time.sleep) -- NOT asyncio; there
    is no concurrent work here, only process supervision.
    """
    stop_requested = False
    child_proc: subprocess.Popen[bytes] | None = None

    def _handle_stop_signal(signum: int, frame: FrameType | None) -> None:
        nonlocal stop_requested
        stop_requested = True
        # D6 PID-1 correctness: forward SIGINT to the live child for a clean
        # EnginePool shutdown. POSIX only -- on Windows the console Ctrl-C already
        # reaches the whole process group, and Popen.send_signal(SIGINT) raises there.
        if os.name == "posix" and child_proc is not None:
            with contextlib.suppress(ProcessLookupError, OSError):
                child_proc.send_signal(signal.SIGINT)

    # NEVER loop.add_signal_handler() -- Unix-only, raises NotImplementedError on
    # Windows' ProactorEventLoop (SEED-063 resolved question).
    signal.signal(signal.SIGINT, _handle_stop_signal)
    signal.signal(signal.SIGTERM, _handle_stop_signal)

    while not stop_requested:
        child_proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]],
            env={**os.environ, _CHILD_MARKER_ENV: _CHILD_MARKER_VALUE},
        )
        code = child_proc.wait()  # reaps the direct child (PID-1 zombie reaping)

        if stop_requested:
            break  # intentional stop -- no relaunch

        _log(f"Child worker exited (code={code}). Relaunching in {SUPERVISOR_BACKOFF_S}s...")
        # D4: grandchild Stockfish processes are either already dead (the wedge case
        # the watchdog converts into this exit) or cleanly quit by EnginePool.stop()
        # (the graceful case) -- no broader process reaping is needed here.
        time.sleep(SUPERVISOR_BACKOFF_S)

    _log("Supervisor stopping (no relaunch).")
    return 0


# ─── CLI ─────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    """Parse and validate CLI arguments."""
    parser = argparse.ArgumentParser(
        description=(
            "Headless remote eval worker: lease next game (tier-1 > tier-2 > tier-3) → "
            "eval via EnginePool → batch submit (Phase 121 SEED-048)."
        )
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        metavar="URL",
        help=f"Base URL of the FlawChess API (default {DEFAULT_BASE_URL}).",
    )
    parser.add_argument(
        "--token",
        default=None,
        metavar="TOKEN",
        help=(
            "Operator token for X-Operator-Token auth. Optional — overrides the "
            "EVAL_OPERATOR_TOKEN value from the environment or the .env file."
        ),
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        metavar="N",
        help=(
            f"Number of parallel Stockfish workers (default {DEFAULT_WORKERS}). "
            "Each worker is an independent UCI process configured Threads=1."
        ),
    )
    parser.add_argument(
        "--idle-sleep",
        type=float,
        default=DEFAULT_IDLE_SLEEP,
        dest="idle_sleep",
        metavar="SECONDS",
        help=(f"Seconds to sleep when the queue is empty / 204 (default {DEFAULT_IDLE_SLEEP})."),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Lease and evaluate positions but never submit. Useful for connectivity testing.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Process one game (or one idle cycle) then exit. Default loops forever.",
    )
    parser.add_argument(
        "--worker-id",
        default=None,
        dest="worker_id",
        metavar="ID",
        help=(
            "Distinctive worker identity written to leased_by / entry_eval_leased_by columns "
            "for prod observability (D-10 / SEED-051). Must be < 10 chars (fits VARCHAR(16)). "
            "Default: random ~8-char base36 generated at startup."
        ),
    )
    args = parser.parse_args()
    if args.workers < 1:
        parser.error(f"--workers must be >= 1, got {args.workers}")
    if args.idle_sleep <= 0:
        parser.error(f"--idle-sleep must be > 0, got {args.idle_sleep}")
    if args.worker_id is not None and len(args.worker_id) >= 10:
        parser.error(
            f"--worker-id must be < 10 chars, got {len(args.worker_id)} ({args.worker_id!r})"
        )
    return args


# ─── Entry point ─────────────────────────────────────────────────────────────


async def _run_async(
    args: argparse.Namespace,
    token: str,
    worker_id: str,
    supervised: bool,
) -> None:
    """Run the worker body for the "child" or "once" role.

    SEED-063: when `supervised` (the "child" role under the supervisor), installs
    the watchdog -- a heartbeat, an asyncio loop exception handler for the
    InvalidStateError storm, and a checker task that forces `os._exit(1)` on a
    stall. A bounded `--once` run needs no supervision at all, so it passes
    `heartbeat=None` and skips the checker task entirely.
    """
    if not supervised:
        await run_worker(
            base_url=args.base_url,
            token=token,
            worker_id=worker_id,
            workers=args.workers,
            idle_sleep=args.idle_sleep,
            dry_run=args.dry_run,
            loop=not args.once,
            heartbeat=None,
        )
        return

    heartbeat = _Heartbeat(_heartbeat_file_path())
    asyncio.get_running_loop().set_exception_handler(_loop_exception_handler)
    checker = asyncio.create_task(
        _watchdog_checker(heartbeat, STALL_THRESHOLD_S, WATCHDOG_POLL_INTERVAL_S)
    )
    try:
        await run_worker(
            base_url=args.base_url,
            token=token,
            worker_id=worker_id,
            workers=args.workers,
            idle_sleep=args.idle_sleep,
            dry_run=args.dry_run,
            loop=not args.once,
            heartbeat=heartbeat,
        )
    finally:
        checker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await checker


def main() -> int:
    """Entry point: parse CLI args, init Sentry, dispatch to supervisor/child/once.

    SEED-063 D3: the script is ALWAYS the supervisor unless `--once` is passed.
    Token presence is checked BEFORE role dispatch so a missing token fails fast
    (return 1) in BOTH the supervisor and the child -- a missing token must never
    become an infinite relaunch loop.
    """
    args = parse_args()

    # Token resolution: an explicit --token wins; otherwise fall back to
    # settings.EVAL_OPERATOR_TOKEN, which pydantic-settings populates from the OS
    # environment OR the .env / .prod.env file. Resolved after parse so the secret
    # is never bound as an argparse default (kept out of --help and the namespace).
    token = args.token or settings.EVAL_OPERATOR_TOKEN
    if not token:
        print(
            "ERROR: operator token is required. Pass --token <TOKEN>, or set "
            "EVAL_OPERATOR_TOKEN in the environment or the .env file.",
            file=sys.stderr,
        )
        return 1

    if settings.SENTRY_DSN:
        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            environment=settings.ENVIRONMENT,
        )
        sentry_sdk.set_context("worker", {"source": "remote_eval_worker"})
        sentry_sdk.set_tag("source", "remote_eval_worker")

    role = _worker_role(
        once=args.once,
        child_marker=os.environ.get(_CHILD_MARKER_ENV) == _CHILD_MARKER_VALUE,
    )

    if role == "supervisor":
        _log("Starting remote eval worker: supervisor (auto-restart on crash/hang)")
        return _run_supervisor()

    # D-10 (Phase 123 SEED-051): generate a random worker ID at startup when none given.
    # The ID is sent via X-Worker-Id so prod can distinguish workers in leased_by columns.
    worker_id: str = args.worker_id if args.worker_id is not None else _generate_worker_id()

    # Log startup info — NEVER log the token value (T-120-01).
    _log(
        f"Starting remote eval worker: base_url={args.base_url} "
        f"workers={args.workers} worker_id={worker_id}"
    )

    asyncio.run(_run_async(args, token, worker_id, supervised=(role == "child")))
    _log("Done.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # Ctrl-C (interactive) or SIGINT (Docker STOPSIGNAL) — run_worker's finally
        # has already stopped the EnginePool. The child is a fresh subprocess with
        # DEFAULT signal handlers, so SIGINT there raises KeyboardInterrupt straight
        # into this handler. Swallow it so the worker exits 0 without dumping a
        # traceback that reads as a crash.
        pass
