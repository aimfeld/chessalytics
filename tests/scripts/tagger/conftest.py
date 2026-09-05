"""Shared fixtures for the tagger validation harness.

This harness is entirely offline: it reads the committed fixture CSVs
(fixtures/tagger/detector_fixture_train.csv and detector_fixture_test.csv) and
runs the detector against them. No database connection, no asyncio, no network.

Train/test split (anti-overfitting): the self-improvement loop and the CI floor
gate optimize/measure against the TRAIN set; the TEST set is held out for honest
validation (scored but never used to tune detectors or set floors). Both files are
produced by scripts/select_tagger_fixtures.py with a deterministic PuzzleId-hash
split, so a puzzle never leaks across the two sets.

CC0/AGPL boundary (SC#4, D-11): the puzzle data is CC0 / Public Domain
(database.lichess.org). The puzzle labels were produced by
lichess-puzzler/tagger/cook.py (AGPL-3.0). We use only the published CC0
dataset; cook.py is neither vendored nor ported here.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Literal, TypedDict

import chess
import pytest

Split = Literal["train", "test"]

# Paths to the committed fixture CSVs, relative to the project root.
_FIXTURE_DIR = Path(__file__).resolve().parents[3] / "fixtures" / "tagger"
_FIXTURE_PATHS: dict[Split, Path] = {
    "train": _FIXTURE_DIR / "detector_fixture_train.csv",
    "test": _FIXTURE_DIR / "detector_fixture_test.csv",
}


class PuzzleRow(TypedDict):
    """A single row from a committed fixture CSV."""

    puzzle_id: str
    fen: str  # board-after-flaw FEN (Moves[0] already applied)
    pre_flaw_fen: str  # published pre-blunder FEN (cook's game.board())
    first_move: str  # UCI string: the blunder that created the puzzle position
    pv: str  # space-joined UCI refutation moves (Moves[1:])
    themes: list[str]  # space-split theme names from the CSV Themes column
    rating: int


def _load_split(split: Split) -> list[PuzzleRow]:
    """Read a committed fixture CSV ('train' or 'test'). No DB, no network."""
    rows: list[PuzzleRow] = []
    with open(_FIXTURE_PATHS[split], newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            rows.append(
                PuzzleRow(
                    puzzle_id=raw["PuzzleId"],
                    fen=raw["FEN"],
                    pre_flaw_fen=raw["PreFlawFEN"],
                    first_move=raw["FirstMove"],
                    pv=raw["PV"],
                    themes=raw["Themes"].split() if raw["Themes"] else [],
                    rating=int(raw["Rating"]),
                )
            )
    return rows


def build_detector_board(row: PuzzleRow) -> chess.Board:
    """Build the detector input board the SAME way production calls it.

    Production (flaws_service "allowed" pass) builds the board as board_before.copy()
    then push(flaw_move), so the flaw move sits on the board's move stack. The detector's
    cook-faithful predicates (hanging-piece recapture exclusion, first-move intermezzo)
    read that flaw move from boards[0].move_stack. Rebuilding from the pre-flaw FEN + the
    flaw move reproduces that exact board (position AND one-move stack), so the gate verifies
    the detector identically to production rather than on a bare, stackless FEN.

    Falls back to the post-flaw FEN (stackless) if the pre-flaw reconstruction is unavailable
    or illegal — matching production's "missed" pass, which passes a stackless board.
    """
    pre = row["pre_flaw_fen"]
    first_move = row["first_move"]
    if pre and first_move:
        try:
            board = chess.Board(pre)
            board.push(chess.Move.from_uci(first_move))
            return board
        except ValueError, chess.IllegalMoveError, AssertionError:
            pass
    return chess.Board(row["fen"])


def _load_fixture(split: Split = "train") -> list[PuzzleRow]:
    """Back-compat loader. Defaults to the TRAIN set (the optimization set)."""
    return _load_split(split)


@pytest.fixture(scope="session")
def detector_fixture_train() -> list[PuzzleRow]:
    """Session-scoped TRAIN fixture: the floor-gated optimization set."""
    return _load_split("train")


@pytest.fixture(scope="session")
def detector_fixture_test() -> list[PuzzleRow]:
    """Session-scoped held-out TEST fixture: scored for validation, not gated."""
    return _load_split("test")
