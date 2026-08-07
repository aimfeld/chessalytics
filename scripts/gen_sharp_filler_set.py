"""One-off authoring pass: verify a Stockfish-sharp, motif-balanced sharp-filler
puzzle set for Train (Phase 206, D-12/D-13/D-18).

Selects candidates from the committed tactic-tagger fixtures
(`fixtures/tagger/detector_fixture_{train,test}.csv`), applies D-12's rating /
PV-length / mate-exclusion band, assigns each survivor exactly one primary
motif (priority order below), then verifies EVERY candidate with a real
offline Stockfish MultiPV-5 search (D-13) before it may be committed —
because D-12 excludes mates, "this position is sharp" is no longer provable
from the theme label alone, and the server unconditionally asserts
`puzzle_type = "sharp"` for every filler (D-15), so this pass is what makes
that constant assertion provably true rather than assumed.

This script is a ONE-OFF authoring tool (D-13): it runs once, is never
shipped, scheduled, or imported by `app/`, and its only output is the
committed `app/data/sharp_filler_puzzles.csv` — never a database write.

Why `backRankMate` (and every other named mate-pattern theme) is absent from
`TARGET_MOTIFS`: measured against the committed fixtures at authoring time,
every `backRankMate` / `anastasiaMate` / `smotheredMate` / `arabianMate` /
`bodenMate` / `hookMate` row in the 1000-1400 / 3-ply band is ALSO tagged
`mateIn2`, so D-12's own mate exclusion nets zero for them — including one
would silently produce a permanently-empty bucket (RESEARCH Pitfall 4).
`sacrifice`, `doubleCheck`, and `xRayAttack` are excluded too: their raw
in-band candidate supply (25 / 48 / 62 rows respectively) is too thin to
reliably clear `PER_MOTIF_CAP` once the MultiPV-5 sharpness gate below
rejects every position with more than one genuinely winning try.

Column mapping (RESEARCH Pitfall 5 — do not get this backwards): the
fixture's `FEN` column is already the position AFTER the arriving move (the
position Train serves); `PreFlawFEN` is the position BEFORE and is never used
here. `FirstMove` is the arriving move (UCI, the move to highlight).
`PV.split()[0]` is the move the user must play to solve the puzzle
(`solution_uci`).

Usage:
    uv run python scripts/gen_sharp_filler_set.py --dry-run
    uv run python scripts/gen_sharp_filler_set.py
    uv run python scripts/gen_sharp_filler_set.py --limit-candidates 5  # fast smoke run
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import chess
import chess.engine
import sentry_sdk

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.config import settings  # noqa: E402
from app.services.engine import (  # noqa: E402
    _score_to_cp_mate,
    evaluate_nodes_multipv5,
    start_engine,
    stop_engine,
)
from app.services.eval_utils import (  # noqa: E402
    eval_cp_to_expected_score,
    eval_mate_to_expected_score,
)
from app.services.flaws_service import INACCURACY_DROP  # noqa: E402
from app.services.sharp_filler import SharpPuzzle  # noqa: E402

# ─── Named constants (no magic numbers, CLAUDE.md) ───────────────────────────

RATING_MIN: int = 1000
RATING_MAX: int = 1400
PV_PLY_LENGTH: int = 3  # the "short" band: your move, reply, your move (D-12)
PER_MOTIF_CAP: int = 16
MIN_LEGAL_MOVES: int = 5  # evaluate_nodes_multipv5's documented caller contract

EXCLUDED_THEMES: frozenset[str] = frozenset({"mateIn1", "mateIn2", "oneMove"})

# Floating-point tolerance for the ES-gap boundary comparison below. Without
# it, a literal boundary case like best_es=0.60/second_es=0.55 (gap exactly
# INACCURACY_DROP) fails the >= check because 0.60 - 0.55 == 0.04999999999999993
# in IEEE-754 double precision, not exactly 0.05 -- a false rejection at the
# gate's own documented boundary.
_ES_GAP_EPSILON: float = 1e-9

_FIXTURE_DIR: Path = Path(__file__).resolve().parent.parent / "fixtures" / "tagger"
FIXTURE_PATHS: tuple[Path, ...] = (
    _FIXTURE_DIR / "detector_fixture_train.csv",
    _FIXTURE_DIR / "detector_fixture_test.csv",
)

DEFAULT_OUT_PATH: Path = (
    Path(__file__).resolve().parent.parent / "app" / "data" / "sharp_filler_puzzles.csv"
)

# D-12 priority order (also the group-fill order): earlier entries win a
# multi-motif row via assign_primary_motif, so a row is counted at most once
# and the endgame/promotion tail can never be over-weighted by double-counting.
TARGET_MOTIFS: tuple[str, ...] = (
    "fork",
    "pin",
    "skewer",
    "discoveredAttack",
    "discoveredCheck",
    "deflection",
    "attraction",
    "hangingPiece",
    "trappedPiece",
    "capturingDefender",
    "intermezzo",
    "interference",
    "clearance",
)

MOTIF_LABELS: dict[str, str] = {
    "fork": "Fork",
    "pin": "Pin",
    "skewer": "Skewer",
    "discoveredAttack": "Discovered attack",
    "discoveredCheck": "Discovered check",
    "deflection": "Deflection",
    "attraction": "Attraction",
    "hangingPiece": "Hanging piece",
    "trappedPiece": "Trapped piece",
    "capturingDefender": "Capturing the defender",
    "intermezzo": "Intermezzo",
    "interference": "Interference",
    "clearance": "Clearance",
}

CSV_HEADER_COMMENT: str = (
    "# Phase 206 (D-10/D-11): committed CC0 lichess puzzle set for Train's sharp\n"
    "# filler. Rows are COPIED from fixtures/tagger/detector_fixture_{train,test}.csv\n"
    "# and are APPEND-ONLY -- never delete a row, since an in-flight drill_solves row\n"
    "# may reference its puzzle_id (D-10's no-repeat key). Generated once by\n"
    "# scripts/gen_sharp_filler_set.py; every row cleared a real offline Stockfish\n"
    "# MultiPV-5 sharpness check (D-13) before being committed here.\n"
)
CSV_FIELDNAMES: tuple[str, ...] = (
    "puzzle_id",
    "fen",
    "first_move_uci",
    "solution_uci",
    "ply",
    "side_to_move",
    "motif",
    "rating",
    "themes",
)


def _log(msg: str = "") -> None:
    """Print a message prefixed with a UTC timestamp (second precision)."""
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


# ─── Pure logic (unit-tested, no engine, no database) ───────────────────────


def passes_sharpness_gate(best_es: float, second_es: float) -> bool:
    """D-13's ES-gap gate: the boundary value itself passes (`>=`, not `>`).

    Mirrors the standard `herring_pool`'s generator applies from the other
    direction — `INACCURACY_DROP` is imported from `app.services.flaws_service`,
    never re-declared as a second `0.05` literal.
    """
    return best_es - second_es >= INACCURACY_DROP - _ES_GAP_EPSILON


def assign_primary_motif(themes: set[str]) -> str | None:
    """Return the first `TARGET_MOTIFS` entry present in `themes`, in priority
    order, or `None` when no target motif is present (D-12).

    A row tagged only `advancedPawn`, `promotion`, or an `*Endgame` theme (or
    any theme outside `TARGET_MOTIFS`) returns `None` here and is therefore
    never selected — this is what keeps the set from skewing to the fixture's
    endgame/promotion tail.
    """
    for motif in TARGET_MOTIFS:
        if motif in themes:
            return motif
    return None


def ply_from_fen(fen: str) -> tuple[int, Literal["white", "black"]]:
    """D-18: `ply = (fullmove_number - 1) * 2 + (0 if white to move else 1)`,
    read directly off `fen`'s own move-number/side-to-move fields, so
    composition does no FEN parsing at runtime."""
    board = chess.Board(fen)
    side_to_move: Literal["white", "black"] = "white" if board.turn else "black"
    ply = (board.fullmove_number - 1) * 2 + (0 if board.turn else 1)
    return ply, side_to_move


def _expected_score(
    cp: int | None, mate: int | None, mover_color: Literal["white", "black"]
) -> float | None:
    """ES conversion via the ONE shared sigmoid (never a second one): a mate
    score routes through `eval_mate_to_expected_score`, a cp score through
    `eval_cp_to_expected_score`, both from `mover_color`'s perspective."""
    if mate is not None:
        return eval_mate_to_expected_score(mate, mover_color)
    if cp is not None:
        return eval_cp_to_expected_score(cp, mover_color)
    return None


# ─── D-12 selection (file I/O only, no engine, no database) ─────────────────


@dataclass(frozen=True)
class _Candidate:
    """One D-12-surviving fixture row, prior to the D-13 engine gate."""

    puzzle_id: str
    fen: str
    first_move_uci: str
    solution_uci: str
    rating: int
    themes: str
    motif: str


def _read_fixture_rows(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def select_candidates(
    fixture_paths: tuple[Path, ...] = FIXTURE_PATHS,
) -> dict[str, list[_Candidate]]:
    """D-12 selection: read both fixtures, dedupe on `PuzzleId`, keep rows in
    the rating/PV-length band with no `EXCLUDED_THEMES` overlap, assign each
    survivor exactly one primary motif, group by motif, and sort each group
    ascending by `PuzzleId` (a stable, reproducible order — never `random`).
    """
    seen_ids: set[str] = set()
    grouped: dict[str, list[_Candidate]] = defaultdict(list)
    for path in fixture_paths:
        for row in _read_fixture_rows(path):
            puzzle_id = row["PuzzleId"]
            if puzzle_id in seen_ids:
                continue
            try:
                rating = int(row["Rating"])
            except ValueError:
                continue
            if not (RATING_MIN <= rating <= RATING_MAX):
                continue
            pv_tokens = row["PV"].split()
            if len(pv_tokens) != PV_PLY_LENGTH:
                continue
            themes_raw = row["Themes"]
            theme_set = set(themes_raw.split())
            if theme_set & EXCLUDED_THEMES:
                continue
            motif = assign_primary_motif(theme_set)
            if motif is None:
                continue
            seen_ids.add(puzzle_id)
            grouped[motif].append(
                _Candidate(
                    puzzle_id=puzzle_id,
                    fen=row["FEN"],
                    first_move_uci=row["FirstMove"],
                    solution_uci=pv_tokens[0],
                    rating=rating,
                    themes=themes_raw,
                    motif=motif,
                )
            )
    for candidates in grouped.values():
        candidates.sort(key=lambda c: c.puzzle_id)
    return grouped


# ─── D-13 engine verification (async, one candidate at a time) ──────────────


async def _verify_candidate(candidate: _Candidate) -> SharpPuzzle | None:
    """D-13's MultiPV-5 offline verification gate for one D-12 candidate.

    Returns the ready-to-commit `SharpPuzzle` on acceptance, or `None` for an
    ordinary rejection (too few legal moves, PV0 disagrees with the fixture's
    own solution, both PV0/PV1 are mates, or the ES gap fails
    `passes_sharpness_gate`). Never raises for an ordinary rejection — only a
    genuine parse/engine failure propagates to the caller's exception
    handling.
    """
    board = chess.Board(candidate.fen)
    if len(list(board.legal_moves)) < MIN_LEGAL_MOVES:
        return None
    try:
        solution_move = chess.Move.from_uci(candidate.solution_uci)
    except ValueError:
        return None
    if solution_move not in board.legal_moves:
        return None

    mover_color: Literal["white", "black"] = "white" if board.turn else "black"
    info_list = await evaluate_nodes_multipv5(board)
    if info_list is None or len(info_list) < 2:
        return None

    pv0, pv1 = info_list[0], info_list[1]
    pv0_moves = pv0.get("pv")
    if not pv0_moves or pv0_moves[0].uci() != candidate.solution_uci:
        # D-13: a disagreement between lichess's solution and our own engine
        # is exactly the mismatch this gate exists to catch.
        return None

    best_cp, best_mate = _score_to_cp_mate(pv0)
    second_cp, second_mate = _score_to_cp_mate(pv1)
    if best_mate is not None and second_mate is not None:
        # Both PV0 and PV1 are forced mates -- the gap is unmeasurable and
        # the position may have two independently winning mates.
        return None

    best_es = _expected_score(best_cp, best_mate, mover_color)
    second_es = _expected_score(second_cp, second_mate, mover_color)
    if best_es is None or second_es is None:
        return None
    if best_mate is None or second_mate is not None:
        # NOT the unconditional-accept case (PV0 mate, PV1 not) -- apply the
        # ordinary ES-gap gate.
        if not passes_sharpness_gate(best_es, second_es):
            return None
    # else: PV0 is a forced mate and PV1 is not -- unconditional accept
    # (D-13). A raw ES gap can understate a mate's true sharpness: a mate
    # scores exactly 1.0, but a strong non-mate alternative can sit close
    # enough to 1.0 that the ES gap alone would wrongly fail the gate.

    ply, side_to_move = ply_from_fen(candidate.fen)
    return SharpPuzzle(
        puzzle_id=candidate.puzzle_id,
        fen=candidate.fen,
        first_move_uci=candidate.first_move_uci,
        solution_uci=candidate.solution_uci,
        ply=ply,
        side_to_move=side_to_move,
        motif=MOTIF_LABELS[candidate.motif],
        rating=candidate.rating,
        themes=candidate.themes,
    )


@dataclass
class _MotifResult:
    accepted: list[SharpPuzzle]
    candidates_seen: int
    candidates_fed: int


async def _fill_motif(
    motif: str,
    candidates: list[_Candidate],
    *,
    per_motif_cap: int,
    limit_candidates: int | None,
) -> _MotifResult:
    """Feed one motif's D-12-sorted candidates through the D-13 engine gate,
    in ascending `puzzle_id` order, until `per_motif_cap` accept or the group
    (or `limit_candidates`) is exhausted."""
    accepted: list[SharpPuzzle] = []
    fed = 0
    for candidate in candidates:
        if len(accepted) >= per_motif_cap:
            break
        if limit_candidates is not None and fed >= limit_candidates:
            break
        fed += 1
        try:
            puzzle = await _verify_candidate(candidate)
        except Exception as exc:  # noqa: BLE001 - per-candidate isolation
            sentry_sdk.set_context(
                "gen_sharp_filler_set", {"puzzle_id": candidate.puzzle_id, "motif": motif}
            )
            sentry_sdk.capture_exception(exc)
            _log(f"  ERROR: candidate failed puzzle_id={candidate.puzzle_id}: {exc}")
            continue
        if puzzle is not None:
            accepted.append(puzzle)
    return _MotifResult(accepted=accepted, candidates_seen=len(candidates), candidates_fed=fed)


# ─── Output + reporting ──────────────────────────────────────────────────────


def _print_candidate_table(grouped: dict[str, list[_Candidate]], per_motif_cap: int) -> None:
    _log("Per-motif D-12 candidate counts (pre-engine selection only):")
    for motif in TARGET_MOTIFS:
        count = len(grouped.get(motif, []))
        flag = "" if count >= per_motif_cap else "  ** SHORT OF CAP (pre-engine) **"
        _log(f"  {MOTIF_LABELS[motif]:<24} ({motif}): {count} candidates{flag}")
    total = sum(len(v) for v in grouped.values())
    _log(f"Total D-12 candidates across all target motifs: {total}")


def _log_result_table(results: dict[str, _MotifResult], per_motif_cap: int) -> list[str]:
    """Print the per-motif accepted-vs-cap table. Returns the target motifs
    that ended below `per_motif_cap` (RESEARCH Pitfall 4 warning sign: never
    silently redistribute a shortfall — the caller exits non-zero when this
    list is non-empty)."""
    short_motifs: list[str] = []
    _log("")
    _log("Per-motif results (accepted / cap, candidates fed):")
    for motif in TARGET_MOTIFS:
        result = results.get(motif)
        accepted_n = len(result.accepted) if result else 0
        fed_n = result.candidates_fed if result else 0
        seen_n = result.candidates_seen if result else 0
        short = accepted_n < per_motif_cap
        if short:
            short_motifs.append(motif)
        flag = "  ** SHORT **" if short else ""
        _log(
            f"  {MOTIF_LABELS[motif]:<24} ({motif}): {accepted_n}/{per_motif_cap} "
            f"accepted (fed {fed_n}/{seen_n} candidates){flag}"
        )
    return short_motifs


def _write_csv(puzzles: list[SharpPuzzle], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        f.write(CSV_HEADER_COMMENT)
        # csv.writer defaults to "\r\n" line terminators regardless of
        # platform; force LF so the committed file matches the repo's LF-only
        # convention (and the plain-text CSV_HEADER_COMMENT written above).
        writer = csv.DictWriter(f, fieldnames=list(CSV_FIELDNAMES), lineterminator="\n")
        writer.writeheader()
        for p in sorted(puzzles, key=lambda p: p.puzzle_id):
            writer.writerow(
                {
                    "puzzle_id": p.puzzle_id,
                    "fen": p.fen,
                    "first_move_uci": p.first_move_uci,
                    "solution_uci": p.solution_uci,
                    "ply": p.ply,
                    "side_to_move": p.side_to_move,
                    "motif": p.motif,
                    "rating": p.rating,
                    "themes": p.themes,
                }
            )
    _log(f"Wrote {len(puzzles)} rows to {out_path}")


# ─── CLI ──────────────────────────────────────────────────────────────────────


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="One-off authoring pass: verify a Stockfish-sharp, motif-balanced "
        "sharp-filler puzzle set from the tactic-tagger fixtures (Phase 206, D-12/D-13)."
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT_PATH,
        help=f"Output CSV path (default: {DEFAULT_OUT_PATH})",
    )
    parser.add_argument(
        "--per-motif-cap",
        type=int,
        default=PER_MOTIF_CAP,
        dest="per_motif_cap",
        help=f"Target accepted rows per motif (default: {PER_MOTIF_CAP})",
    )
    parser.add_argument(
        "--limit-candidates",
        type=int,
        default=None,
        dest="limit_candidates",
        help="Cap the number of per-motif candidates fed to the engine (for a fast smoke run).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="Do the D-12 selection and print the per-motif candidate table without "
        "starting the engine or writing a file.",
    )
    return parser.parse_args()


async def main() -> None:
    args = _parse_args()
    grouped = select_candidates()

    if args.dry_run:
        _print_candidate_table(grouped, args.per_motif_cap)
        return

    if settings.SENTRY_DSN:
        sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT)

    await start_engine()
    try:
        results: dict[str, _MotifResult] = {}
        for motif in TARGET_MOTIFS:
            candidates = grouped.get(motif, [])
            _log(
                f"Motif {motif} ({MOTIF_LABELS[motif]}): {len(candidates)} D-12 candidates, "
                f"verifying via MultiPV-5..."
            )
            result = await _fill_motif(
                motif,
                candidates,
                per_motif_cap=args.per_motif_cap,
                limit_candidates=args.limit_candidates,
            )
            results[motif] = result
            _log(f"  -> accepted {len(result.accepted)}/{args.per_motif_cap}")
    finally:
        await stop_engine()

    short_motifs = _log_result_table(results, args.per_motif_cap)
    all_puzzles = [p for result in results.values() for p in result.accepted]
    _write_csv(all_puzzles, args.out)

    if short_motifs:
        _log("")
        _log(f"FAILED: motif(s) short of --per-motif-cap ({args.per_motif_cap}): {short_motifs}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
