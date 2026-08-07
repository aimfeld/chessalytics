"""Static sharp-puzzle filler set for Train (Phase 206, D-10/D-14).

A committed CC0 lichess puzzle set loaded once at import time into a
module-level constant, mirroring `app.services.opening_lookup`'s
committed-data-file -> module-level-constant shape. No DB table, no seeding
script, no per-environment sync (D-10) — the referent is a file, which is
why `DrillSolve.sharp_puzzle_id` carries no `ForeignKey`.

Serve-order contract (D-14), a literal mirror of `train_pool.herring_stmt`'s
documented exhaustion contract (`app/services/train_pool.py:683-686`):

    Exhaustion contract: `pick_sharp_fillers` filters `SHARP_SET` to ids not
    yet served to this user. When that filtered list is empty (every id has
    been served), it falls back to the full unfiltered `SHARP_SET`, allowing
    repeats — that fallback lives with the selector's own contract, not
    duplicated at call sites.

`SHARP_SET` is a TOTAL, stable order (ascending `puzzle_id`) — the in-memory
analog of `herring_stmt`'s total `ORDER BY`, and what makes "no repeats until
exhausted" observable at all.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from sqlalchemy import Select, select

from app.models.drill_solve import DrillSolve, DrillSource

SHARP_FILLER_DATA_PATH: Path = (
    Path(__file__).resolve().parent.parent / "data" / "sharp_filler_puzzles.csv"
)


@dataclass(frozen=True)
class SharpPuzzle:
    """One row of the committed sharp-filler data file (D-10)."""

    puzzle_id: str
    fen: str
    first_move_uci: str
    solution_uci: str
    ply: int
    side_to_move: Literal["white", "black"]
    motif: str
    rating: int
    themes: str


def _load_sharp_set(path: Path = SHARP_FILLER_DATA_PATH) -> tuple[SharpPuzzle, ...]:
    """Parse the committed sharp-filler CSV into a stable-ordered tuple.

    Fails closed (T-206-03): a missing file or a file with zero data rows
    raises `RuntimeError` rather than silently yielding an empty set — an
    empty `SHARP_SET` would degrade composition back to today's all-herring
    session with no signal, the exact defect this phase removes. Lines
    starting with `#` (the append-only-contract header comment) are skipped
    before the CSV header row.

    Args:
        path: Data file path — parameterized only so tests can monkeypatch
            `SHARP_FILLER_DATA_PATH` to a missing/degenerate path.

    Returns:
        A tuple of `SharpPuzzle`, sorted ascending by `puzzle_id` (a total,
        stable order — D-14).

    Raises:
        RuntimeError: the file is missing, unreadable, or parses to zero
            data rows.
    """
    if not path.exists():
        raise RuntimeError(f"Sharp filler data file not found: {path}")

    with open(path, encoding="utf-8") as f:
        data_lines = [line for line in f if not line.lstrip().startswith("#")]

    reader = csv.DictReader(data_lines)
    puzzles = [
        SharpPuzzle(
            puzzle_id=row["puzzle_id"],
            fen=row["fen"],
            first_move_uci=row["first_move_uci"],
            solution_uci=row["solution_uci"],
            ply=int(row["ply"]),
            side_to_move="white" if row["side_to_move"] == "white" else "black",
            motif=row["motif"],
            rating=int(row["rating"]),
            themes=row["themes"],
        )
        for row in reader
    ]
    if not puzzles:
        raise RuntimeError(f"Sharp filler data file has zero data rows: {path}")
    return tuple(sorted(puzzles, key=lambda p: p.puzzle_id))


# Built once at module load time (mirrors app.services.opening_lookup._TRIE).
SHARP_SET: tuple[SharpPuzzle, ...] = _load_sharp_set()
SHARP_SET_BY_ID: dict[str, SharpPuzzle] = {p.puzzle_id: p for p in SHARP_SET}


def sharp_filler_available() -> bool:
    """True when the sharp set has at least one puzzle. Consumed by plan 03's
    warm-up-label eligibility check."""
    return len(SHARP_SET) > 0


def served_sharp_ids_stmt(user_id: int) -> Select[tuple[str | None]]:
    """`sharp_puzzle_id` values already served to `user_id` as a `SHARP_FILLER`
    (D-14's exclusion source — the sharp-set analog of `herring_stmt`'s
    `exclude_served` clause, `app/services/train_pool.py:731-740`).

    Args:
        user_id: Authenticated user's internal PK (V4: never client-supplied
            — callers must source this from `current_active_user.id`).

    Returns:
        A SQLAlchemy Select yielding this user's already-served
        `sharp_puzzle_id` values (a scalar column, turn into a `set[str]`).
    """
    return select(DrillSolve.sharp_puzzle_id).where(
        DrillSolve.user_id == user_id, DrillSolve.source == DrillSource.SHARP_FILLER
    )


def pick_sharp_fillers(served_ids: set[str], *, limit: int) -> list[SharpPuzzle]:
    """D-14's pure selector: deterministic order, exclude served, repeat on
    exhaustion.

    Exhaustion contract (unchanged from `pick_sharp_fillers`'s own docstring
    above — copied here per `herring_stmt`'s discipline of keeping the
    fallback documented with the selector, not duplicated at call sites):
    filter `SHARP_SET` to ids not in `served_ids`; if that filtered list is
    empty, fall back to the full unfiltered `SHARP_SET` (repeats allowed).

    `user_id`-independent by construction — it takes no `user_id` argument,
    only the caller-resolved `served_ids` set (from `served_sharp_ids_stmt`).

    Args:
        served_ids: `sharp_puzzle_id` values already served to this user.
        limit: Maximum number of puzzles to return.

    Returns:
        Up to `limit` `SharpPuzzle` entries, in `SHARP_SET`'s ascending
        `puzzle_id` order. Never raises — a `limit` larger than the (possibly
        repeat-eligible) pool simply returns everything available.
    """
    unserved = [p for p in SHARP_SET if p.puzzle_id not in served_ids]
    pool = unserved if unserved else SHARP_SET
    return list(pool[:limit])


__all__ = [
    "SHARP_FILLER_DATA_PATH",
    "SHARP_SET",
    "SHARP_SET_BY_ID",
    "SharpPuzzle",
    "pick_sharp_fillers",
    "served_sharp_ids_stmt",
    "sharp_filler_available",
]
