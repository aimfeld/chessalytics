"""Tests for scripts.gen_sharp_filler_set (Phase 206, D-12/D-13/D-18).

Pure-logic coverage only — no engine, no database. `select_candidates` reads
real files but never starts Stockfish or touches Postgres, so its exclusion
behavior (D-12) is also covered here against tiny, self-contained fixture
files (never the real ~26k-row committed fixtures, to keep this file fast).
The engine-backed `_verify_candidate`/`_fill_motif` pass itself is exercised
by Task 2's `--dry-run`/real-run acceptance criteria, not by this file.
"""

from __future__ import annotations

import csv
from pathlib import Path

from app.services.flaws_service import INACCURACY_DROP
from scripts.gen_sharp_filler_set import (
    TARGET_MOTIFS,
    assign_primary_motif,
    passes_sharpness_gate,
    ply_from_fen,
    select_candidates,
)

_FIXTURE_HEADER: list[str] = [
    "PuzzleId",
    "FEN",
    "PreFlawFEN",
    "FirstMove",
    "PV",
    "Themes",
    "Rating",
]

# A real starting-adjacent position, arbitrary but legal and reused across
# fixture rows below — only PV/Themes/Rating vary per test.
_FEN_SAMPLE = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 12"
_PV_SAMPLE = "d2d4 d7d5 e4e5"  # 3 tokens -> PV_PLY_LENGTH


def _fixture_row(
    puzzle_id: str,
    *,
    themes: str,
    rating: str = "1200",
    pv: str = _PV_SAMPLE,
    fen: str = _FEN_SAMPLE,
) -> dict[str, str]:
    return {
        "PuzzleId": puzzle_id,
        "FEN": fen,
        "PreFlawFEN": fen,
        "FirstMove": "e2e4",
        "PV": pv,
        "Themes": themes,
        "Rating": rating,
    }


def _write_fixture(path: Path, rows: list[dict[str, str]]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_FIXTURE_HEADER)
        writer.writeheader()
        writer.writerows(rows)


class TestSharpnessGate:
    def test_sharpness_gate_boundary_value_passes(self) -> None:
        assert passes_sharpness_gate(0.60, 0.60 - INACCURACY_DROP) is True

    def test_sharpness_gate_just_below_boundary_fails(self) -> None:
        assert passes_sharpness_gate(0.60, 0.60 - INACCURACY_DROP + 0.0001) is False

    def test_sharpness_gate_well_above_boundary_passes(self) -> None:
        assert passes_sharpness_gate(0.90, 0.10) is True

    def test_sharpness_gate_literal_acceptance_example(self) -> None:
        # From the plan's own acceptance criteria.
        assert passes_sharpness_gate(0.60, 0.55) is True
        assert passes_sharpness_gate(0.60, 0.5501) is False


class TestAssignPrimaryMotif:
    def test_returns_earlier_target_motif_when_two_present(self) -> None:
        # fork precedes pin in TARGET_MOTIFS' priority order.
        assert assign_primary_motif({"pin", "fork", "middlegame"}) == "fork"

    def test_returns_none_for_endgame_only_themes(self) -> None:
        assert assign_primary_motif({"advancedPawn", "promotion", "rookEndgame"}) is None

    def test_returns_none_when_no_target_motif_present(self) -> None:
        assert assign_primary_motif({"middlegame", "short", "crushing"}) is None

    def test_priority_order_matches_first_match_in_target_motifs(self) -> None:
        # skewer precedes discoveredAttack in TARGET_MOTIFS' priority order.
        assert assign_primary_motif({"skewer", "discoveredAttack"}) == "skewer"

    def test_every_target_motif_is_individually_selectable(self) -> None:
        for motif in TARGET_MOTIFS:
            assert assign_primary_motif({motif}) == motif


class TestPlyFromFen:
    def test_white_to_move_fullmove_12(self) -> None:
        fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 4 12"
        ply, side_to_move = ply_from_fen(fen)
        assert ply == 22
        assert side_to_move == "white"

    def test_black_to_move_fullmove_12(self) -> None:
        fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 4 12"
        ply, side_to_move = ply_from_fen(fen)
        assert ply == 23
        assert side_to_move == "black"


class TestSelectCandidatesExclusions:
    def test_mate_in_2_row_is_excluded(self, tmp_path: Path) -> None:
        path = tmp_path / "fixture.csv"
        _write_fixture(
            path,
            [
                _fixture_row("m1", themes="fork mateIn2 middlegame short"),
                _fixture_row("m2", themes="fork middlegame short"),
            ],
        )
        grouped = select_candidates((path,))
        ids = {c.puzzle_id for candidates in grouped.values() for c in candidates}
        assert "m1" not in ids
        assert "m2" in ids

    def test_out_of_band_rating_is_excluded(self, tmp_path: Path) -> None:
        path = tmp_path / "fixture.csv"
        _write_fixture(
            path,
            [
                _fixture_row("r1", themes="fork short", rating="900"),
                _fixture_row("r2", themes="fork short", rating="1401"),
                _fixture_row("r3", themes="fork short", rating="1200"),
            ],
        )
        grouped = select_candidates((path,))
        ids = {c.puzzle_id for candidates in grouped.values() for c in candidates}
        assert ids == {"r3"}

    def test_non_short_pv_is_excluded(self, tmp_path: Path) -> None:
        path = tmp_path / "fixture.csv"
        _write_fixture(
            path,
            [
                _fixture_row("p1", themes="fork short", pv="d2d4 d7d5"),
                _fixture_row("p2", themes="fork short", pv="d2d4 d7d5 e4e5 e7e5"),
                _fixture_row("p3", themes="fork short", pv="d2d4 d7d5 e4e5"),
            ],
        )
        grouped = select_candidates((path,))
        ids = {c.puzzle_id for candidates in grouped.values() for c in candidates}
        assert ids == {"p3"}

    def test_endgame_promotion_only_row_is_excluded(self, tmp_path: Path) -> None:
        path = tmp_path / "fixture.csv"
        _write_fixture(
            path,
            [_fixture_row("e1", themes="advancedPawn promotion rookEndgame short")],
        )
        grouped = select_candidates((path,))
        ids = {c.puzzle_id for candidates in grouped.values() for c in candidates}
        assert ids == set()

    def test_duplicate_puzzle_id_across_fixtures_is_deduped(self, tmp_path: Path) -> None:
        train_path = tmp_path / "train.csv"
        test_path = tmp_path / "test.csv"
        _write_fixture(train_path, [_fixture_row("d1", themes="fork short")])
        _write_fixture(test_path, [_fixture_row("d1", themes="fork short")])
        grouped = select_candidates((train_path, test_path))
        ids = [c.puzzle_id for candidates in grouped.values() for c in candidates]
        assert ids.count("d1") == 1

    def test_multi_motif_row_assigned_to_earlier_priority_motif_only(self, tmp_path: Path) -> None:
        path = tmp_path / "fixture.csv"
        _write_fixture(path, [_fixture_row("f1", themes="fork pin short")])
        grouped = select_candidates((path,))
        assert [c.puzzle_id for c in grouped.get("fork", [])] == ["f1"]
        assert grouped.get("pin", []) == []

    def test_groups_are_sorted_ascending_by_puzzle_id(self, tmp_path: Path) -> None:
        path = tmp_path / "fixture.csv"
        _write_fixture(
            path,
            [
                _fixture_row("z9", themes="fork short"),
                _fixture_row("a1", themes="fork short"),
                _fixture_row("m5", themes="fork short"),
            ],
        )
        grouped = select_candidates((path,))
        assert [c.puzzle_id for c in grouped["fork"]] == ["a1", "m5", "z9"]
