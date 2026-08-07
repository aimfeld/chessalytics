"""Tests for app.services.sharp_filler (Phase 206, D-10/D-14).

Coverage:
- TestLoadSharpSet    : the fail-closed loader — missing file and
                        header-only (zero data row) file both raise
                        RuntimeError (T-206-03).
- TestPickSharpFillers: D-14's exhaustion contract — ascending puzzle-id
                        order, user_id-independence, exclude-served,
                        repeat-on-exhaustion.
- test_served_sharp_ids_stmt_* : the DB-backed exclusion source, scoped by
                        user_id and DrillSource.SHARP_FILLER.
- test_sharp_filler_available_true_for_the_real_committed_set : the real
                        committed app/data/sharp_filler_puzzles.csv loads
                        successfully at import time (a live smoke test for
                        the fail-closed loader's happy path).
- TestCommittedSharpSetDataIntegrity : Task 2 (206-02) — re-verifies every
                        D-12/D-13/D-18 constraint against the REAL committed
                        200+ row file, not a monkeypatched fixture. `SHARP_SET`
                        is a module-level constant loaded once per process, so
                        each `uv run pytest ...` invocation re-parses whatever
                        is currently on disk at SHARP_FILLER_DATA_PATH — the
                        mutation checks below rely on exactly this.
- TestNoAppRuntimeReferenceToTaggerFixtures : D-11's own mechanical review —
                        no module under app/ may reference the tactic-tagger
                        fixture directory path.
"""

from __future__ import annotations

import datetime
import uuid
from collections import Counter
from pathlib import Path

import chess
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillSolve, DrillSource
from app.services import sharp_filler as sharp_filler_module
from app.services.best_move_candidates import mover_color_for_ply
from app.services.sharp_filler import (
    SHARP_FILLER_DATA_PATH,
    SHARP_SET,
    SharpPuzzle,
    _load_sharp_set,
    pick_sharp_fillers,
    served_sharp_ids_stmt,
    sharp_filler_available,
)
from scripts.gen_sharp_filler_set import (
    MOTIF_LABELS,
    PER_MOTIF_CAP,
    RATING_MAX,
    RATING_MIN,
)
from tests.conftest import ensure_test_user

# Task 2 acceptance criterion: "between 12 and PER_MOTIF_CAP inclusive" — the
# measured floor for the thinnest-supply motifs after the D-13 engine gate,
# not a hard requirement the authoring script itself enforces (it targets
# PER_MOTIF_CAP; this is the data-integrity re-check's own acceptance floor).
_MIN_MOTIF_ROWS: int = 12

# D-12's mate exclusion plus every named mate-pattern theme RESEARCH Pitfall 4
# measured as fully subsumed by it (each is also tagged mateIn2 in-band).
_EXCLUDED_MATE_THEMES: frozenset[str] = frozenset(
    {
        "mateIn1",
        "mateIn2",
        "oneMove",
        "backRankMate",
        "anastasiaMate",
        "smotheredMate",
        "arabianMate",
        "bodenMate",
        "hookMate",
    }
)

_USER_ID = 93200

_TEST_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def _make_puzzle(puzzle_id: str) -> SharpPuzzle:
    return SharpPuzzle(
        puzzle_id=puzzle_id,
        fen=_TEST_FEN,
        first_move_uci="e2e4",
        solution_uci="d2d4",
        ply=0,
        side_to_move="white",
        motif="Fork",
        rating=1200,
        themes="fork short",
    )


class TestLoadSharpSet:
    def test_missing_file_raises_runtime_error(self, tmp_path: Path) -> None:
        missing = tmp_path / "does-not-exist.csv"
        with pytest.raises(RuntimeError, match="not found"):
            _load_sharp_set(missing)

    def test_header_only_file_raises_runtime_error(self, tmp_path: Path) -> None:
        header_only = tmp_path / "header-only.csv"
        header_only.write_text(
            "puzzle_id,fen,first_move_uci,solution_uci,ply,side_to_move,motif,rating,themes\n",
            encoding="utf-8",
        )
        with pytest.raises(RuntimeError, match="zero data rows"):
            _load_sharp_set(header_only)

    def test_comment_lines_are_skipped_before_the_header(self, tmp_path: Path) -> None:
        data_file = tmp_path / "with-comment.csv"
        data_file.write_text(
            "# append-only contract comment\n"
            "puzzle_id,fen,first_move_uci,solution_uci,ply,side_to_move,motif,rating,themes\n"
            f"z1,{_TEST_FEN},e2e4,d2d4,0,white,Fork,1200,fork short\n",
            encoding="utf-8",
        )
        loaded = _load_sharp_set(data_file)
        assert len(loaded) == 1
        assert loaded[0].puzzle_id == "z1"

    def test_committed_file_loads_successfully(self) -> None:
        """Live smoke test: the real committed app/data/sharp_filler_puzzles.csv
        (SHARP_SET, already loaded at module import time) is non-empty."""
        assert len(SHARP_SET) > 0


class TestPickSharpFillers:
    def test_ascending_puzzle_id_order(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fixture = (_make_puzzle("c3"), _make_puzzle("a1"), _make_puzzle("b2"))
        monkeypatch.setattr(
            sharp_filler_module, "SHARP_SET", tuple(sorted(fixture, key=lambda p: p.puzzle_id))
        )
        picks = pick_sharp_fillers(set(), limit=3)
        assert [p.puzzle_id for p in picks] == ["a1", "b2", "c3"]

    def test_user_id_independent_signature(self) -> None:
        """pick_sharp_fillers takes no user_id argument at all — D-14's
        determinism is structural, not merely observed."""
        import inspect

        params = inspect.signature(pick_sharp_fillers).parameters
        assert "user_id" not in params

    def test_excludes_already_served_ids(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fixture = tuple(_make_puzzle(f"p{i}") for i in range(5))
        monkeypatch.setattr(sharp_filler_module, "SHARP_SET", fixture)
        picks = pick_sharp_fillers({"p0", "p1"}, limit=5)
        assert [p.puzzle_id for p in picks] == ["p2", "p3", "p4"]

    def test_repeats_when_every_id_served(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fixture = tuple(_make_puzzle(f"p{i}") for i in range(3))
        monkeypatch.setattr(sharp_filler_module, "SHARP_SET", fixture)
        served = {p.puzzle_id for p in fixture}
        picks = pick_sharp_fillers(served, limit=2)
        # Exhausted -> falls back to the full unfiltered SHARP_SET, not empty.
        assert len(picks) == 2
        assert [p.puzzle_id for p in picks] == ["p0", "p1"]

    def test_limit_larger_than_pool_returns_everything_available(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fixture = tuple(_make_puzzle(f"p{i}") for i in range(3))
        monkeypatch.setattr(sharp_filler_module, "SHARP_SET", fixture)
        picks = pick_sharp_fillers(set(), limit=10)
        assert len(picks) == 3


@pytest.mark.asyncio
async def test_served_sharp_ids_stmt_returns_only_this_users_sharp_filler_ids(
    db_session: AsyncSession,
) -> None:
    """Scoped by user_id AND DrillSource.SHARP_FILLER — an SR/herring row's
    NULL sharp_puzzle_id, and another user's served id, are both excluded."""
    other_user_id = _USER_ID + 1
    await ensure_test_user(db_session, _USER_ID)
    await ensure_test_user(db_session, other_user_id)

    session_row = DrillSession(
        user_id=_USER_ID,
        session_date=datetime.date(2026, 1, 15),
        status="open",
        puzzle_count=2,
        requested_count=2,
        expires_on=datetime.date(2026, 1, 16),
    )
    db_session.add(session_row)
    await db_session.flush()
    db_session.add_all(
        [
            DrillSolve(
                session_id=session_row.id,
                position=0,
                user_id=_USER_ID,
                game_id=None,
                ply=0,
                source=DrillSource.SHARP_FILLER,
                herring_pool_id=None,
                sharp_puzzle_id=f"served-{uuid.uuid4().hex[:8]}",
                solved_at=None,
            ),
            DrillSolve(
                session_id=session_row.id,
                position=1,
                user_id=_USER_ID,
                game_id=None,
                ply=2,
                source=DrillSource.SR_ITEM,
                herring_pool_id=None,
                sharp_puzzle_id=None,
                solved_at=None,
            ),
        ]
    )
    await db_session.flush()

    served_ids = set((await db_session.execute(served_sharp_ids_stmt(_USER_ID))).scalars().all())
    assert None not in served_ids
    assert len(served_ids) == 1

    other_served_ids = (
        (await db_session.execute(served_sharp_ids_stmt(other_user_id))).scalars().all()
    )
    assert other_served_ids == []


def test_sharp_filler_available_true_for_the_real_committed_set() -> None:
    assert sharp_filler_available() is True


class TestCommittedSharpSetDataIntegrity:
    """Re-verifies every D-12/D-13/D-18 constraint against the REAL committed
    `app/data/sharp_filler_puzzles.csv` (via the module-level `SHARP_SET`
    constant — never a monkeypatched fixture)."""

    def test_at_least_200_rows(self) -> None:
        assert len(SHARP_SET) >= 200

    def test_puzzle_ids_are_unique(self) -> None:
        ids = [p.puzzle_id for p in SHARP_SET]
        assert len(set(ids)) == len(ids)

    def test_exactly_13_motifs_all_drawn_from_motif_labels(self) -> None:
        motifs = {p.motif for p in SHARP_SET}
        assert len(motifs) == 13
        assert motifs <= set(MOTIF_LABELS.values())

    def test_every_motif_row_count_between_floor_and_cap(self) -> None:
        counts = Counter(p.motif for p in SHARP_SET)
        assert set(counts) == set(MOTIF_LABELS.values())
        for motif, count in counts.items():
            assert _MIN_MOTIF_ROWS <= count <= PER_MOTIF_CAP, (motif, count)

    def test_rating_within_band(self) -> None:
        ratings = [p.rating for p in SHARP_SET]
        assert min(ratings) >= RATING_MIN
        assert max(ratings) <= RATING_MAX

    def test_no_row_carries_a_mate_theme(self) -> None:
        for p in SHARP_SET:
            theme_set = set(p.themes.split())
            assert not (theme_set & _EXCLUDED_MATE_THEMES), p.puzzle_id

    def test_ply_parity_matches_side_to_move_and_fen(self) -> None:
        for p in SHARP_SET:
            board = chess.Board(p.fen)
            assert board.turn == (p.side_to_move == "white"), p.puzzle_id
            assert (p.ply % 2 == 0) == (p.side_to_move == "white"), p.puzzle_id
            assert mover_color_for_ply(p.ply) == p.side_to_move, p.puzzle_id

    def test_solution_uci_is_legal_in_its_own_fen(self) -> None:
        for p in SHARP_SET:
            board = chess.Board(p.fen)
            move = chess.Move.from_uci(p.solution_uci)
            assert move in board.legal_moves, p.puzzle_id

    def test_first_move_uci_is_consistent_with_the_position_it_arrives_at(self) -> None:
        """The committed file stores only `fen` (the position AFTER
        `first_move_uci` was played), not the preceding position — fully
        reconstructing the preceding FEN would need the captured piece and
        castling-rights data that isn't persisted (RESEARCH Pitfall 5). This
        checks the structurally-verifiable invariant instead: the piece that
        supposedly just arrived at `first_move_uci`'s to-square is actually
        present there in `fen`, and belongs to the mover (the side that is
        NOT now to move)."""
        for p in SHARP_SET:
            board = chess.Board(p.fen)
            move = chess.Move.from_uci(p.first_move_uci)
            piece = board.piece_at(move.to_square)
            assert piece is not None, p.puzzle_id
            assert piece.color != board.turn, p.puzzle_id


class TestNoAppRuntimeReferenceToTaggerFixtures:
    """D-11's own mechanical review (RESEARCH: a runtime reference would
    break silently on the next tagger-fixture regen)."""

    def test_sharp_filler_data_path_resolves_under_app_data(self) -> None:
        assert SHARP_FILLER_DATA_PATH.parent.name == "data"
        assert SHARP_FILLER_DATA_PATH.parent.parent.name == "app"

    def test_no_app_module_references_the_tagger_fixture_path(self) -> None:
        app_dir = Path(__file__).resolve().parent.parent.parent / "app"
        # Gate hygiene: kept as a runtime-built fragment (not a literal
        # docstring mention) so this test file itself can never trip its own
        # scan if it were ever moved under app/.
        forbidden_fragment = "fixtures" + "/" + "tagger"
        offenders: list[str] = []
        for py_file in app_dir.rglob("*.py"):
            text = py_file.read_text(encoding="utf-8")
            stripped = "\n".join(
                line for line in text.splitlines() if not line.lstrip().startswith("#")
            )
            if forbidden_fragment in stripped:
                offenders.append(str(py_file))
        assert offenders == []
