"""Integration tests for app.repositories.flaws_repository.

Uses a real PostgreSQL database through the db_session fixture (rolled-back
transaction per test). Covers:
- fetch_game_positions_ordered: returns [] for unknown game_id
- fetch_game_positions_ordered: returns positions sorted by ply ASC even if inserted out of order
- fetch_game_positions_ordered: user_id ownership guard (different user returns [])
- flaw_record_to_row: output must not contain es_before/es_after/move_san (Phase 112 D-07)
"""

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.repositories.flaws_repository import fetch_game_positions_ordered
from app.repositories.game_flaws_repository import flaw_record_to_row
from app.services.flaws_service import FlawRecord


# ---------------------------------------------------------------------------
# Seed helpers
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture(autouse=True)
async def _create_test_users(db_session: AsyncSession) -> None:
    """Ensure test user IDs exist in the users table (FK constraint)."""
    from tests.conftest import ensure_test_user

    for uid in [99999, 99998]:
        await ensure_test_user(db_session, uid)


async def _seed_game(session: AsyncSession, *, user_id: int = 99999) -> Game:
    """Insert a Game row and flush to obtain an ID."""
    game = Game(
        user_id=user_id,
        platform="lichess",
        platform_game_id=str(uuid.uuid4()),
        platform_url="https://lichess.org/test",
        pgn="1. e4 e5 *",
        result="1-0",
        user_color="white",
        time_control_str="600+0",
        time_control_bucket="blitz",
        time_control_seconds=600,
        base_time_seconds=600,
        increment_seconds=0.0,
        rated=True,
        is_computer_game=False,
    )
    session.add(game)
    await session.flush()
    return game


async def _seed_position(
    session: AsyncSession,
    *,
    game: Game,
    ply: int,
    eval_cp: int | None = None,
    eval_mate: int | None = None,
    clock_seconds: float | None = None,
    phase: int = 1,
    move_san: str | None = None,
) -> GamePosition:
    """Insert a GamePosition row and flush."""
    pos = GamePosition(
        game_id=game.id,
        user_id=game.user_id,
        ply=ply,
        full_hash=hash(f"{game.id}-{ply}"),
        white_hash=hash(f"w-{game.id}-{ply}"),
        black_hash=hash(f"b-{game.id}-{ply}"),
        move_san=move_san,
        clock_seconds=clock_seconds,
        phase=phase,
        eval_cp=eval_cp,
        eval_mate=eval_mate,
        endgame_class=None,
    )
    session.add(pos)
    await session.flush()
    return pos


# ---------------------------------------------------------------------------
# TestFetchGamePositionsOrdered
# ---------------------------------------------------------------------------


class TestFetchGamePositionsOrdered:
    """Tests for fetch_game_positions_ordered repository function."""

    @pytest.mark.asyncio
    async def test_returns_empty_for_unknown_game(self, db_session: AsyncSession) -> None:
        """An unknown game_id returns an empty list."""
        rows = await fetch_game_positions_ordered(
            db_session,
            game_id=999999999,
            user_id=99999,
        )
        assert rows == []

    @pytest.mark.asyncio
    async def test_positions_sorted_by_ply_asc(self, db_session: AsyncSession) -> None:
        """Positions are returned sorted by ply ASC even when inserted out of order."""
        game = await _seed_game(db_session)

        # Insert out of order: ply 2, 0, 1
        await _seed_position(db_session, game=game, ply=2, eval_cp=50)
        await _seed_position(db_session, game=game, ply=0, eval_cp=0)
        await _seed_position(db_session, game=game, ply=1, eval_cp=30)

        rows = await fetch_game_positions_ordered(db_session, game_id=game.id, user_id=99999)
        assert len(rows) == 3
        plies = [r.ply for r in rows]
        assert plies == [0, 1, 2], f"Expected [0,1,2] ply order, got {plies}"

    @pytest.mark.asyncio
    async def test_ownership_guard_different_user_returns_empty(
        self, db_session: AsyncSession
    ) -> None:
        """A different user_id returns [] even though the game_id exists.

        This is the T-105-03 Information Disclosure mitigation: one user cannot
        read another user's game positions via the repository.
        """
        game = await _seed_game(db_session, user_id=99999)
        await _seed_position(db_session, game=game, ply=0)
        await _seed_position(db_session, game=game, ply=1, eval_cp=50)

        # Attempt to fetch game's positions with a different user_id
        rows = await fetch_game_positions_ordered(
            db_session,
            game_id=game.id,
            user_id=99998,  # different user
        )
        assert rows == [], "A different user_id must not be able to fetch another user's positions"


# ---------------------------------------------------------------------------
# TestFlawRecordToRow (Phase 112-01 Task 3)
# ---------------------------------------------------------------------------


class TestFlawRecordToRow:
    """Phase 112 D-07: flaw_record_to_row must not persist es_before/es_after/move_san."""

    def test_flaw_record_to_row_omits_dropped_columns(self) -> None:
        """flaw_record_to_row output must not contain es_before, es_after, or move_san.

        Phase 112 (D-07): these three keys were removed from the DB schema; writing
        them to the row dict would cause an insert failure after the migration.
        The FlawRecord TypedDict still carries them for internal kernel use
        (Pitfall 6 in 112-CONTEXT.md) — this test guards the write-path.
        """
        flaw: FlawRecord = {
            "ply": 4,
            "fen": "rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR",
            "side": "white",
            "severity": "blunder",
            "tags": ["middlegame", "reversed"],
            "es_before": 0.75,  # still in TypedDict (kernel-internal)
            "es_after": 0.20,  # still in TypedDict (kernel-internal)
            "move_san": "Nxd4",  # still in TypedDict (kernel-internal)
            # Phase 128: renamed tactic_* → allowed_tactic_* (D-02); added missed_tactic_* (D-01).
            "allowed_tactic_motif_int": None,
            "allowed_tactic_piece": None,
            "allowed_tactic_confidence": None,
            "allowed_tactic_depth": None,
            "missed_tactic_motif_int": None,
            "missed_tactic_piece": None,
            "missed_tactic_confidence": None,
            "missed_tactic_depth": None,
        }

        row = flaw_record_to_row(user_id=1, game_id=42, flaw=flaw)

        # These keys must NOT appear in the DB row dict (dropped in Phase 112 D-07)
        assert "es_before" not in row, (
            "flaw_record_to_row must not write es_before to DB (Phase 112 D-07)"
        )
        assert "es_after" not in row, (
            "flaw_record_to_row must not write es_after to DB (Phase 112 D-07)"
        )
        assert "move_san" not in row, (
            "flaw_record_to_row must not write move_san to DB (Phase 112 D-07)"
        )

        # fen must still be present (Pitfall 4: cannot be dropped)
        assert "fen" in row, "fen must still be present in the DB row dict"
        assert row["fen"] == flaw["fen"]

        # Core identity fields must still be present
        assert row["user_id"] == 1
        assert row["game_id"] == 42
        assert row["ply"] == 4


class TestFlawRecordToRowTacticMapping:
    """Phase 128 D-06: flaw_record_to_row must write all 8 tactic columns.

    Verifies that the write-path row dict carries all 8 DB-column keys with
    correct mappings from the renamed/new FlawRecord keys:
      - allowed_tactic_motif  ← allowed_tactic_motif_int  (int→column name shift)
      - allowed_tactic_piece  ← allowed_tactic_piece
      - allowed_tactic_confidence ← allowed_tactic_confidence
      - allowed_tactic_depth  ← allowed_tactic_depth
      - missed_tactic_motif   ← missed_tactic_motif_int   (int→column name shift)
      - missed_tactic_piece   ← missed_tactic_piece
      - missed_tactic_confidence ← missed_tactic_confidence
      - missed_tactic_depth   ← missed_tactic_depth
    """

    def _make_flaw_with_tactics(
        self,
        allowed_motif: int | None = 3,
        allowed_piece: int | None = 4,
        allowed_confidence: int | None = 85,
        allowed_depth: int | None = 2,
        missed_motif: int | None = 1,
        missed_piece: int | None = 2,
        missed_confidence: int | None = 90,
        missed_depth: int | None = 1,
    ) -> FlawRecord:
        return FlawRecord(
            ply=6,
            fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR",
            side="white",
            severity="blunder",
            tags=["middlegame"],
            es_before=0.70,
            es_after=0.25,
            move_san="e4",
            allowed_tactic_motif_int=allowed_motif,
            allowed_tactic_piece=allowed_piece,
            allowed_tactic_confidence=allowed_confidence,
            allowed_tactic_depth=allowed_depth,
            missed_tactic_motif_int=missed_motif,
            missed_tactic_piece=missed_piece,
            missed_tactic_confidence=missed_confidence,
            missed_tactic_depth=missed_depth,
        )

    def test_all_8_tactic_keys_present_in_row(self) -> None:
        """flaw_record_to_row output must contain all 8 tactic DB-column keys."""
        flaw = self._make_flaw_with_tactics()
        row = flaw_record_to_row(user_id=1, game_id=42, flaw=flaw)

        expected_tactic_keys = {
            "allowed_tactic_motif",
            "allowed_tactic_piece",
            "allowed_tactic_confidence",
            "allowed_tactic_depth",
            "missed_tactic_motif",
            "missed_tactic_piece",
            "missed_tactic_confidence",
            "missed_tactic_depth",
        }
        missing = expected_tactic_keys - row.keys()
        assert not missing, f"flaw_record_to_row row dict is missing tactic keys: {missing}"

    def test_allowed_tactic_values_mapped_correctly(self) -> None:
        """allowed_* keys in row dict carry the FlawRecord allowed_* values."""
        flaw = self._make_flaw_with_tactics(
            allowed_motif=3, allowed_piece=4, allowed_confidence=85, allowed_depth=2
        )
        row = flaw_record_to_row(user_id=1, game_id=42, flaw=flaw)

        assert row["allowed_tactic_motif"] == 3
        assert row["allowed_tactic_piece"] == 4
        assert row["allowed_tactic_confidence"] == 85
        assert row["allowed_tactic_depth"] == 2

    def test_missed_tactic_values_mapped_correctly(self) -> None:
        """missed_* keys in row dict carry the FlawRecord missed_* values."""
        flaw = self._make_flaw_with_tactics(
            missed_motif=1, missed_piece=2, missed_confidence=90, missed_depth=1
        )
        row = flaw_record_to_row(user_id=1, game_id=42, flaw=flaw)

        assert row["missed_tactic_motif"] == 1
        assert row["missed_tactic_piece"] == 2
        assert row["missed_tactic_confidence"] == 90
        assert row["missed_tactic_depth"] == 1

    def test_null_tactic_values_map_to_none(self) -> None:
        """NULL (None) tactic values in FlawRecord map to None in the row dict."""
        flaw = self._make_flaw_with_tactics(
            allowed_motif=None,
            allowed_piece=None,
            allowed_confidence=None,
            allowed_depth=None,
            missed_motif=None,
            missed_piece=None,
            missed_confidence=None,
            missed_depth=None,
        )
        row = flaw_record_to_row(user_id=1, game_id=42, flaw=flaw)

        for key in [
            "allowed_tactic_motif",
            "allowed_tactic_piece",
            "allowed_tactic_confidence",
            "allowed_tactic_depth",
            "missed_tactic_motif",
            "missed_tactic_piece",
            "missed_tactic_confidence",
            "missed_tactic_depth",
        ]:
            assert row[key] is None, f"Expected row['{key}'] to be None for null tactic"

    def test_old_tactic_keys_no_longer_in_row(self) -> None:
        """The renamed tactic_* keys must not appear in the row dict (Phase 128 D-02).

        Verifies that the pre-Phase-128 tactic_motif / tactic_piece / tactic_confidence /
        tactic_depth DB column names are gone from the write path — writing them would
        cause an insert failure since the columns were renamed in migration b6e2978df54f.
        """
        flaw = self._make_flaw_with_tactics()
        row = flaw_record_to_row(user_id=1, game_id=42, flaw=flaw)

        for old_key in ["tactic_motif", "tactic_piece", "tactic_confidence", "tactic_depth"]:
            assert old_key not in row, (
                f"flaw_record_to_row must not write old DB column '{old_key}' "
                f"(renamed to allowed_* in Phase 128 migration b6e2978df54f)"
            )
