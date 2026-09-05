"""Integration tests for the openings repository.

All tests use a real PostgreSQL database through the db_session fixture,
which wraps each test in a rolled-back transaction for isolation.

Coverage:
- ANL-02: match_side routes to correct hash column (white/black/full)
- FLT-01: time_control filter
- FLT-02: rated filter
- FLT-03: recency filter
- FLT-04: color filter
- Combined filters (intersection behavior)
- Transposition deduplication (game counted once even with multi-ply match)
- Pagination (offset, limit, total count)
- MEXP-04: query_next_moves returns per-move W/D/L aggregation
- MEXP-05: transposition dedup (same game at multiple plies counted once per move)
- MEXP-10: batch transposition counts (derived from query_resulting_position_wdl
  since quick task 260512-p5p collapsed the trio into one query)
"""

import datetime
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.repositories.openings_repository import (
    HASH_COLUMN_MAP,
    query_all_results,
    query_matching_games,
)


@pytest_asyncio.fixture(autouse=True)
async def _create_test_users(db_session: AsyncSession) -> None:
    """Ensure test user IDs exist in the users table (FK constraint)."""
    from tests.conftest import ensure_test_user

    for uid in [1, 2]:
        await ensure_test_user(db_session, uid)


# ---------------------------------------------------------------------------
# Seed helper
# ---------------------------------------------------------------------------

_COUNTER = 0


def _unique_game_id() -> str:
    """Return a unique platform_game_id for each call."""
    return str(uuid.uuid4())


async def _seed_game(
    session: AsyncSession,
    *,
    user_id: int = 1,
    platform: str = "chess.com",
    result: str = "1-0",
    user_color: str = "white",
    rated: bool = True,
    time_control_bucket: str = "blitz",
    played_at: datetime.datetime | None = None,
    white_username: str = "testuser",
    black_username: str = "opponent",
    platform_url: str | None = "https://chess.com/game/123",
    full_hash: int = 9999,
    white_hash: int = 1111,
    black_hash: int = 2222,
    move_san: str | None = None,
) -> tuple[Game, GamePosition]:
    """Insert one Game + one GamePosition row and flush to obtain IDs.

    Returns (game, position) so callers can inspect generated IDs or add more
    positions to the same game.
    """
    if played_at is None:
        played_at = datetime.datetime.now(tz=datetime.timezone.utc)

    game = Game(
        user_id=user_id,
        platform=platform,
        platform_game_id=_unique_game_id(),
        platform_url=platform_url,
        pgn="1. e4 e5 *",
        result=result,
        user_color=user_color,
        time_control_str="600+0",
        time_control_bucket=time_control_bucket,
        time_control_seconds=600,
        rated=rated,
        white_username=white_username,
        black_username=black_username,
    )
    game.played_at = played_at
    session.add(game)
    await session.flush()  # obtain game.id

    position = GamePosition(
        game_id=game.id,
        user_id=user_id,
        ply=1,
        full_hash=full_hash,
        white_hash=white_hash,
        black_hash=black_hash,
        move_san=move_san,
    )
    session.add(position)
    await session.flush()

    return game, position


async def _add_position(
    session: AsyncSession,
    game_id: int,
    user_id: int,
    ply: int,
    full_hash: int,
    white_hash: int = 0,
    black_hash: int = 0,
    move_san: str | None = None,
) -> GamePosition:
    """Insert an additional GamePosition for an existing game and flush."""
    position = GamePosition(
        game_id=game_id,
        user_id=user_id,
        ply=ply,
        full_hash=full_hash,
        white_hash=white_hash,
        black_hash=black_hash,
        move_san=move_san,
    )
    session.add(position)
    await session.flush()
    return position


# ---------------------------------------------------------------------------
# TestMatchSide — ANL-02
# ---------------------------------------------------------------------------


class TestMatchSide:
    """Verify that match_side routes queries to the correct hash column."""

    @pytest.mark.asyncio
    async def test_match_side_white(self, db_session: AsyncSession) -> None:
        """Query on white_hash column returns the matching game."""
        await _seed_game(db_session, white_hash=1234, black_hash=0, full_hash=0)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["white"],
            target_hash=1234,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1

    @pytest.mark.asyncio
    async def test_match_side_black(self, db_session: AsyncSession) -> None:
        """Query on black_hash column returns the matching game."""
        await _seed_game(db_session, white_hash=0, black_hash=5678, full_hash=0)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["black"],
            target_hash=5678,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1

    @pytest.mark.asyncio
    async def test_match_side_full(self, db_session: AsyncSession) -> None:
        """Query on full_hash column returns the matching game."""
        await _seed_game(db_session, white_hash=0, black_hash=0, full_hash=9876)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=9876,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1

    @pytest.mark.asyncio
    async def test_match_side_no_match(self, db_session: AsyncSession) -> None:
        """Querying a hash that does not exist returns 0 results."""
        await _seed_game(db_session, full_hash=1111)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=9999999,  # hash that was never inserted
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 0
        assert len(games) == 0


# ---------------------------------------------------------------------------
# TestFilters — FLT-01 through FLT-04
# ---------------------------------------------------------------------------

TARGET_HASH = 42424242  # shared hash value for filter tests


class TestFilters:
    """Verify each filter narrows results correctly."""

    @pytest.mark.asyncio
    async def test_time_control_filter(self, db_session: AsyncSession) -> None:
        """FLT-01: Only games matching the requested time_control bucket returned."""
        await _seed_game(db_session, time_control_bucket="bullet", full_hash=TARGET_HASH)
        await _seed_game(db_session, time_control_bucket="blitz", full_hash=TARGET_HASH)
        await _seed_game(db_session, time_control_bucket="rapid", full_hash=TARGET_HASH)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TARGET_HASH,
            time_control=["blitz"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1
        assert games[0].time_control_bucket == "blitz"

    @pytest.mark.asyncio
    async def test_rated_filter(self, db_session: AsyncSession) -> None:
        """FLT-02: Only rated (or unrated) games returned when filter applied."""
        await _seed_game(db_session, rated=True, full_hash=TARGET_HASH)
        await _seed_game(db_session, rated=False, full_hash=TARGET_HASH)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TARGET_HASH,
            time_control=None,
            platform=None,
            rated=True,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1
        assert games[0].rated is True

    @pytest.mark.asyncio
    async def test_recency_filter(self, db_session: AsyncSession) -> None:
        """FLT-03: Games played before the from_date are excluded."""
        now = datetime.datetime.now(tz=datetime.timezone.utc)
        two_years_ago = now - datetime.timedelta(days=730)
        from_date = (now - datetime.timedelta(days=30)).date()

        await _seed_game(db_session, played_at=now, full_hash=TARGET_HASH)
        await _seed_game(db_session, played_at=two_years_ago, full_hash=TARGET_HASH)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TARGET_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=from_date,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1

    @pytest.mark.asyncio
    async def test_color_filter(self, db_session: AsyncSession) -> None:
        """FLT-04: Only games where user played the requested color returned."""
        await _seed_game(db_session, user_color="white", full_hash=TARGET_HASH)
        await _seed_game(db_session, user_color="black", full_hash=TARGET_HASH)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TARGET_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1
        assert games[0].user_color == "white"

    @pytest.mark.asyncio
    async def test_combined_filters(self, db_session: AsyncSession) -> None:
        """Multiple filters applied simultaneously narrow to the intersection."""
        # Matches all three filters
        await _seed_game(
            db_session,
            time_control_bucket="blitz",
            rated=True,
            user_color="white",
            full_hash=TARGET_HASH,
        )
        # Misses time_control
        await _seed_game(
            db_session,
            time_control_bucket="bullet",
            rated=True,
            user_color="white",
            full_hash=TARGET_HASH,
        )
        # Misses rated
        await _seed_game(
            db_session,
            time_control_bucket="blitz",
            rated=False,
            user_color="white",
            full_hash=TARGET_HASH,
        )
        # Misses color
        await _seed_game(
            db_session,
            time_control_bucket="blitz",
            rated=True,
            user_color="black",
            full_hash=TARGET_HASH,
        )

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TARGET_HASH,
            time_control=["blitz"],
            platform=None,
            rated=True,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
            offset=0,
            limit=50,
        )

        assert total == 1
        assert len(games) == 1


# ---------------------------------------------------------------------------
# TestDeduplication
# ---------------------------------------------------------------------------


class TestDeduplication:
    """Verify that transpositions are counted once per game."""

    @pytest.mark.asyncio
    async def test_transposition_counts_once(self, db_session: AsyncSession) -> None:
        """A game whose target hash appears at two different plies is counted once."""
        DEDUP_HASH = 77777777

        game = Game(
            user_id=1,
            platform="chess.com",
            platform_game_id=_unique_game_id(),
            platform_url=None,
            pgn="1. e4 e5 2. Nf3 *",
            result="1-0",
            user_color="white",
            time_control_str="600+0",
            time_control_bucket="blitz",
            time_control_seconds=600,
            rated=True,
            white_username="testuser",
            black_username="opp",
        )
        game.played_at = datetime.datetime.now(tz=datetime.timezone.utc)
        db_session.add(game)
        await db_session.flush()

        # Two positions at different plies with the SAME hash
        for ply in (2, 4):
            pos = GamePosition(
                game_id=game.id,
                user_id=1,
                ply=ply,
                full_hash=DEDUP_HASH,
                white_hash=0,
                black_hash=0,
            )
            db_session.add(pos)
        await db_session.flush()

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=DEDUP_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=0,
            limit=50,
        )

        assert total == 1, "Game with transposition should be counted once"
        assert len(games) == 1

        # Also verify query_all_results de-duplicates
        rows = await query_all_results(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=DEDUP_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert len(rows) == 1


# ---------------------------------------------------------------------------
# TestPagination
# ---------------------------------------------------------------------------

PAGINATION_HASH = 55555555


class TestPagination:
    """Verify offset/limit pagination and total count accuracy."""

    @pytest.mark.asyncio
    async def test_pagination_offset_limit(self, db_session: AsyncSession) -> None:
        """Seed 5 games, request 2 at offset 2 — returns 2 with total=5."""
        for _ in range(5):
            await _seed_game(db_session, full_hash=PAGINATION_HASH)

        games, total = await query_matching_games(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=PAGINATION_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
            offset=2,
            limit=2,
        )

        assert total == 5
        assert len(games) == 2


# ---------------------------------------------------------------------------
# TestTimeSeries — BKM-03, BKM-04
# ---------------------------------------------------------------------------

TS_HASH = 12345  # fixed Zobrist hash for all time-series tests


class TestTimeSeries:
    """Verify query_time_series returns correct monthly (month_dt, result, user_color) tuples."""

    @pytest.mark.asyncio
    async def test_returns_monthly_buckets(self, db_session: AsyncSession) -> None:
        """BKM-03: 3 games in Jan 2025 (2W 1L) and 2 games in Mar 2025 (1W 1D) → 2 rows."""
        from app.repositories.openings_repository import query_time_series

        jan = datetime.datetime(2025, 1, 15, tzinfo=datetime.timezone.utc)
        mar = datetime.datetime(2025, 3, 10, tzinfo=datetime.timezone.utc)

        # Jan: 2 wins, 1 loss
        await _seed_game(
            db_session, played_at=jan, result="1-0", user_color="white", full_hash=TS_HASH
        )
        await _seed_game(
            db_session, played_at=jan, result="1-0", user_color="white", full_hash=TS_HASH
        )
        await _seed_game(
            db_session, played_at=jan, result="0-1", user_color="white", full_hash=TS_HASH
        )
        # Mar: 1 win, 1 draw
        await _seed_game(
            db_session, played_at=mar, result="1-0", user_color="white", full_hash=TS_HASH
        )
        await _seed_game(
            db_session, played_at=mar, result="1/2-1/2", user_color="white", full_hash=TS_HASH
        )

        rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TS_HASH,
            color=None,
        )

        # Group by month
        from collections import defaultdict

        by_month: dict[str, list] = defaultdict(list)
        for month_dt, result, user_color in rows:
            key = month_dt.strftime("%Y-%m")
            by_month[key].append((result, user_color))

        assert set(by_month.keys()) == {"2025-01", "2025-03"}
        assert len(by_month["2025-01"]) == 3
        assert len(by_month["2025-03"]) == 2

        # Verify win_rate for Jan: 2/3 ≈ 0.667
        jan_wins = sum(1 for r, c in by_month["2025-01"] if r == "1-0" and c == "white")
        assert jan_wins == 2

    @pytest.mark.asyncio
    async def test_gap_months(self, db_session: AsyncSession) -> None:
        """BKM-04: Feb 2025 has no games — it must NOT appear in results."""
        from app.repositories.openings_repository import query_time_series

        jan = datetime.datetime(2025, 1, 20, tzinfo=datetime.timezone.utc)
        mar = datetime.datetime(2025, 3, 5, tzinfo=datetime.timezone.utc)

        await _seed_game(db_session, played_at=jan, full_hash=TS_HASH)
        await _seed_game(db_session, played_at=mar, full_hash=TS_HASH)

        rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TS_HASH,
            color=None,
        )

        months = {row[0].strftime("%Y-%m") for row in rows}
        assert "2025-02" not in months, "Feb gap month must not appear in results"

    @pytest.mark.asyncio
    async def test_user_isolation(self, db_session: AsyncSession) -> None:
        """Games belonging to user B do not appear in user A's time series."""
        from app.repositories.openings_repository import query_time_series

        played = datetime.datetime(2025, 6, 1, tzinfo=datetime.timezone.utc)

        # User A game
        await _seed_game(db_session, user_id=1, played_at=played, full_hash=TS_HASH)
        # User B game (different user_id)
        await _seed_game(db_session, user_id=2, played_at=played, full_hash=TS_HASH)

        rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TS_HASH,
            color=None,
        )

        assert len(rows) == 1, "Only user A's game should be returned"

    @pytest.mark.asyncio
    async def test_color_filter(self, db_session: AsyncSession) -> None:
        """When color='white', only games where user_color='white' are counted."""
        from app.repositories.openings_repository import query_time_series

        played = datetime.datetime(2025, 7, 1, tzinfo=datetime.timezone.utc)

        await _seed_game(db_session, played_at=played, user_color="white", full_hash=TS_HASH)
        await _seed_game(db_session, played_at=played, user_color="black", full_hash=TS_HASH)

        rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=TS_HASH,
            color="white",
        )

        assert len(rows) == 1
        _, _, user_color = rows[0]
        assert user_color == "white"

    @pytest.mark.asyncio
    async def test_match_side_white(self, db_session: AsyncSession) -> None:
        """hash_column=GamePosition.white_hash: only games with matching white_hash returned."""
        from app.repositories.openings_repository import query_time_series

        played = datetime.datetime(2025, 8, 15, tzinfo=datetime.timezone.utc)

        # Game with matching white_hash
        await _seed_game(
            db_session, played_at=played, white_hash=TS_HASH, full_hash=0, black_hash=0
        )
        # Game without matching white_hash
        await _seed_game(db_session, played_at=played, white_hash=99999, full_hash=0, black_hash=0)

        rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["white"],
            target_hash=TS_HASH,
            color=None,
        )

        assert len(rows) == 1


# ---------------------------------------------------------------------------
# TestNextMoves — MEXP-04
# ---------------------------------------------------------------------------

NM_SOURCE_HASH = 100  # queried source position hash
NM_E4_HASH = 200  # result hash after e4
NM_D4_HASH = 300  # result hash after d4


class TestNextMoves:
    """MEXP-04: query_next_moves returns per-move W/D/L aggregation."""

    @pytest.mark.asyncio
    async def test_basic_next_moves(self, db_session: AsyncSession) -> None:
        """3 games at same position: 2 play e4 (1W 1D), 1 plays d4 (1L).

        Expected:
        - e4: game_count=2, wins=1, draws=1, losses=0, result_hash=NM_E4_HASH
        - d4: game_count=1, wins=0, draws=0, losses=1, result_hash=NM_D4_HASH
        """
        from app.repositories.openings_repository import query_next_moves

        # Game 1: e4 → win
        game1, _ = await _seed_game(
            db_session,
            result="1-0",
            user_color="white",
            full_hash=NM_SOURCE_HASH,
            move_san="e4",
        )
        await _add_position(db_session, game1.id, 1, ply=2, full_hash=NM_E4_HASH)

        # Game 2: e4 → draw
        game2, _ = await _seed_game(
            db_session,
            result="1/2-1/2",
            user_color="white",
            full_hash=NM_SOURCE_HASH,
            move_san="e4",
        )
        await _add_position(db_session, game2.id, 1, ply=2, full_hash=NM_E4_HASH)

        # Game 3: d4 → loss
        game3, _ = await _seed_game(
            db_session,
            result="0-1",
            user_color="white",
            full_hash=NM_SOURCE_HASH,
            move_san="d4",
        )
        await _add_position(db_session, game3.id, 1, ply=2, full_hash=NM_D4_HASH)

        rows = await query_next_moves(
            db_session,
            user_id=1,
            target_hash=NM_SOURCE_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        # Build lookup by move_san
        by_move = {row.move_san: row for row in rows}

        assert len(by_move) == 2, f"Expected 2 moves, got {len(by_move)}: {list(by_move.keys())}"

        e4 = by_move["e4"]
        assert e4.game_count == 2
        assert e4.wins == 1
        assert e4.draws == 1
        assert e4.losses == 0
        assert e4.result_hash == NM_E4_HASH

        d4 = by_move["d4"]
        assert d4.game_count == 1
        assert d4.wins == 0
        assert d4.draws == 0
        assert d4.losses == 1
        assert d4.result_hash == NM_D4_HASH

    @pytest.mark.asyncio
    async def test_next_moves_last_played_at_max(self, db_session: AsyncSession) -> None:
        """Quick task 260508-r61: query_next_moves returns MAX(games.played_at)
        per (move_san, result_hash) so the FE can render the
        "Last played: <relative>" line in the Score popover.
        """
        from app.repositories.openings_repository import query_next_moves

        # Three games at the same source playing e4. Pick distinct played_at
        # values so we can pin which one is the MAX.
        old_date = datetime.datetime(2024, 1, 1, tzinfo=datetime.timezone.utc)
        mid_date = datetime.datetime(2024, 6, 1, tzinfo=datetime.timezone.utc)
        recent_date = datetime.datetime(2024, 12, 1, tzinfo=datetime.timezone.utc)

        for played_at in (old_date, mid_date, recent_date):
            game, _ = await _seed_game(
                db_session,
                result="1-0",
                user_color="white",
                full_hash=NM_SOURCE_HASH,
                move_san="e4",
                played_at=played_at,
            )
            await _add_position(db_session, game.id, 1, ply=2, full_hash=NM_E4_HASH)

        rows = await query_next_moves(
            db_session,
            user_id=1,
            target_hash=NM_SOURCE_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert len(rows) == 1
        assert rows[0].move_san == "e4"
        assert rows[0].game_count == 3
        # MAX(played_at) = the most recent of the three seeded games.
        assert rows[0].last_played_at == recent_date


# ---------------------------------------------------------------------------
# TestNextMovesTranspositions — MEXP-05
# ---------------------------------------------------------------------------

NM_TRANS_SOURCE_HASH = 400
NM_TRANS_RESULT_HASH = 401


class TestNextMovesTranspositions:
    """MEXP-05: game with same move_san at multiple plies counted once per move."""

    @pytest.mark.asyncio
    async def test_transposition_counted_once(self, db_session: AsyncSession) -> None:
        """1 game visits source_hash at ply 2 and ply 6, plays 'Nf3' both times.

        query_next_moves must return game_count=1 for 'Nf3', not 2.
        """
        from app.repositories.openings_repository import query_next_moves

        game = Game(
            user_id=1,
            platform="chess.com",
            platform_game_id=_unique_game_id(),
            platform_url=None,
            pgn="1. Nf3 Nf6 2. Nf3 Nf6 *",
            result="1-0",
            user_color="white",
            time_control_str="600+0",
            time_control_bucket="blitz",
            time_control_seconds=600,
            rated=True,
            white_username="testuser",
            black_username="opp",
        )
        game.played_at = datetime.datetime.now(tz=datetime.timezone.utc)
        db_session.add(game)
        await db_session.flush()

        # Same source position at ply 2 and ply 6
        await _add_position(
            db_session, game.id, 1, ply=2, full_hash=NM_TRANS_SOURCE_HASH, move_san="Nf3"
        )
        await _add_position(
            db_session, game.id, 1, ply=3, full_hash=NM_TRANS_RESULT_HASH
        )  # result at ply 3
        await _add_position(
            db_session, game.id, 1, ply=6, full_hash=NM_TRANS_SOURCE_HASH, move_san="Nf3"
        )
        await _add_position(
            db_session, game.id, 1, ply=7, full_hash=NM_TRANS_RESULT_HASH
        )  # result at ply 7

        rows = await query_next_moves(
            db_session,
            user_id=1,
            target_hash=NM_TRANS_SOURCE_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert len(rows) == 1
        assert rows[0].move_san == "Nf3"
        assert rows[0].game_count == 1, f"Expected game_count=1, got {rows[0].game_count}"


# ---------------------------------------------------------------------------
# TestNextMovesFilters — MEXP-04 filter application
# ---------------------------------------------------------------------------

NM_FILTER_HASH = 500
NM_FILTER_RESULT_HASH = 501


class TestNextMovesFilters:
    """Filter application narrows next-moves results correctly."""

    @pytest.mark.asyncio
    async def test_time_control_filter(self, db_session: AsyncSession) -> None:
        """2 games at same position (blitz vs rapid), filter blitz → only blitz counted."""
        from app.repositories.openings_repository import query_next_moves

        # Blitz game plays e4
        game_blitz, _ = await _seed_game(
            db_session,
            time_control_bucket="blitz",
            full_hash=NM_FILTER_HASH,
            move_san="e4",
        )
        await _add_position(db_session, game_blitz.id, 1, ply=2, full_hash=NM_FILTER_RESULT_HASH)

        # Rapid game plays e4
        game_rapid, _ = await _seed_game(
            db_session,
            time_control_bucket="rapid",
            full_hash=NM_FILTER_HASH,
            move_san="e4",
        )
        await _add_position(db_session, game_rapid.id, 1, ply=2, full_hash=NM_FILTER_RESULT_HASH)

        rows = await query_next_moves(
            db_session,
            user_id=1,
            target_hash=NM_FILTER_HASH,
            time_control=["blitz"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert len(rows) == 1
        assert rows[0].game_count == 1

    @pytest.mark.asyncio
    async def test_rated_filter(self, db_session: AsyncSession) -> None:
        """2 games at same position (rated vs unrated), filter rated=True → only rated counted."""
        from app.repositories.openings_repository import query_next_moves

        # Rated game
        game_rated, _ = await _seed_game(
            db_session,
            rated=True,
            full_hash=NM_FILTER_HASH,
            move_san="d4",
        )
        await _add_position(
            db_session, game_rated.id, 1, ply=2, full_hash=NM_FILTER_RESULT_HASH + 1
        )

        # Unrated game plays same move
        game_unrated, _ = await _seed_game(
            db_session,
            rated=False,
            full_hash=NM_FILTER_HASH,
            move_san="d4",
        )
        await _add_position(
            db_session, game_unrated.id, 1, ply=2, full_hash=NM_FILTER_RESULT_HASH + 1
        )

        rows = await query_next_moves(
            db_session,
            user_id=1,
            target_hash=NM_FILTER_HASH,
            time_control=None,
            platform=None,
            rated=True,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        # Only the rated game should be counted for d4
        by_move = {row.move_san: row for row in rows}
        assert "d4" in by_move
        assert by_move["d4"].game_count == 1


# ---------------------------------------------------------------------------
# TestTranspositionCounts — MEXP-10
# ---------------------------------------------------------------------------

TC_RESULT_HASH = 600


class TestTranspositionCounts:
    """MEXP-10: transposition counts derived from query_resulting_position_wdl.

    Post quick task 260512-p5p (Task 1): query_transposition_counts was deleted
    in favor of deriving total = w + d + lo from query_resulting_position_wdl.
    These tests preserve the batch-count coverage on the surviving query.
    """

    @pytest.mark.asyncio
    async def test_batch_transposition_count(self, db_session: AsyncSession) -> None:
        """2 games both reach result_hash=600 (via different source positions).

        Deriving total from query_resulting_position_wdl must return 2.
        """
        from app.repositories.openings_repository import query_resulting_position_wdl

        # Game A: plays e4 from source_hash=100 → result_hash=600
        game_a, _ = await _seed_game(db_session, full_hash=100, move_san="e4")
        await _add_position(db_session, game_a.id, 1, ply=2, full_hash=TC_RESULT_HASH)

        # Game B: plays c4 from source_hash=150 → result_hash=600 (transposition)
        game_b = Game(
            user_id=1,
            platform="chess.com",
            platform_game_id=_unique_game_id(),
            platform_url=None,
            pgn="1. c4 e5 *",
            result="1-0",
            user_color="white",
            time_control_str="600+0",
            time_control_bucket="blitz",
            time_control_seconds=600,
            rated=True,
            white_username="testuser",
            black_username="opp",
        )
        game_b.played_at = datetime.datetime.now(tz=datetime.timezone.utc)
        db_session.add(game_b)
        await db_session.flush()

        await _add_position(db_session, game_b.id, 1, ply=1, full_hash=150, move_san="c4")
        await _add_position(db_session, game_b.id, 1, ply=2, full_hash=TC_RESULT_HASH)

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TC_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert TC_RESULT_HASH in wdl
        w, d, lo, _last = wdl[TC_RESULT_HASH]
        assert w + d + lo == 2, f"Expected 2, got {w + d + lo}"

    @pytest.mark.asyncio
    async def test_empty_hash_list(self, db_session: AsyncSession) -> None:
        """Empty hash_list returns empty dict."""
        from app.repositories.openings_repository import query_resulting_position_wdl

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert wdl == {}


# ---------------------------------------------------------------------------
# TestNextMovesNullMoveExcluded — NULL move_san excluded
# ---------------------------------------------------------------------------

NM_NULL_HASH = 700


class TestNextMovesNullMoveExcluded:
    """NULL move_san rows (final position) must not appear in next-moves results."""

    @pytest.mark.asyncio
    async def test_null_move_san_excluded(self, db_session: AsyncSession) -> None:
        """Seed a game where position at NM_NULL_HASH has move_san=None.

        query_next_moves must return no rows for this source hash.
        """
        from app.repositories.openings_repository import query_next_moves

        # Game with only a NULL move_san position (final position)
        game, _ = await _seed_game(
            db_session,
            full_hash=NM_NULL_HASH,
            move_san=None,  # explicitly NULL — final position
        )

        rows = await query_next_moves(
            db_session,
            user_id=1,
            target_hash=NM_NULL_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert rows == [], f"Expected no rows, got: {rows}"


# ---------------------------------------------------------------------------
# TestQueryWDLCounts — SQL aggregation replacing Python W/D/L loops
# ---------------------------------------------------------------------------

WDL_TARGET_HASH = 800000  # distinct hash for WDL count tests


class TestQueryWDLCounts:
    """query_wdl_counts() returns correct (total, wins, draws, losses) from SQL aggregation.

    Coverage:
    - BOPT-01: SQL aggregation returns same W/D/L as manual Python counting
    - target_hash=None (all-games mode) returns correct counts
    - Filter parameters (time_control, color) narrow counts correctly
    - No matching games returns (0, 0, 0, 0)
    - Transposition dedup: game counted once even if hash appears at multiple plies
    """

    @pytest.mark.asyncio
    async def test_basic_wdl_counts_with_target_hash(self, db_session: AsyncSession) -> None:
        """Seed 3 games (1W 1D 1L) at WDL_TARGET_HASH, assert SQL aggregate matches."""
        from app.repositories.openings_repository import query_wdl_counts
        from app.models.game_position import GamePosition

        await _seed_game(db_session, result="1-0", user_color="white", full_hash=WDL_TARGET_HASH)
        await _seed_game(
            db_session, result="1/2-1/2", user_color="white", full_hash=WDL_TARGET_HASH
        )
        await _seed_game(db_session, result="0-1", user_color="white", full_hash=WDL_TARGET_HASH)

        row = await query_wdl_counts(
            db_session,
            user_id=1,
            hash_column=GamePosition.full_hash,
            target_hash=WDL_TARGET_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert row.total == 3
        assert row.wins == 1
        assert row.draws == 1
        assert row.losses == 1

    @pytest.mark.asyncio
    async def test_wdl_counts_no_target_hash(self, db_session: AsyncSession) -> None:
        """target_hash=None (all-games mode) sums all user's games regardless of position.

        Per-run isolation bug: target_hash=None queries ALL games for a given
        user_id with no position filter.  Under xdist, each worker gets its own
        fresh DB clone, and module-scoped fixtures (e.g. seeded_user) that
        commit games for dynamically-registered users can produce user_id=1 or
        user_id=2 in a fresh sequence.  Those committed games persist for the
        worker's lifetime and are visible inside the db_session transaction,
        causing the count to exceed the 2 games seeded here.

        Fix: use dedicated high-range user IDs (830001, 830002) that are outside
        the range used by any other test, seeded_user, or auto-increment.  These
        are created via ensure_test_user inside the rollback-scoped db_session,
        so they are cleaned up automatically and cannot collide with other tests.
        """
        from app.repositories.openings_repository import query_wdl_counts
        from tests.conftest import ensure_test_user

        # Dedicated user IDs for this test only — high range to avoid any
        # collision with seeded_user (dynamic sequence), test_aggregation_sanity
        # (700-series), or other hardcoded IDs across the test suite.
        _USER_A = 830001
        _USER_B = 830002

        await ensure_test_user(db_session, _USER_A)
        await ensure_test_user(db_session, _USER_B)

        # Seed 2 wins for user A (at different hashes — no position filter)
        await _seed_game(
            db_session,
            user_id=_USER_A,
            result="1-0",
            user_color="white",
            full_hash=WDL_TARGET_HASH + 1,
        )
        await _seed_game(
            db_session,
            user_id=_USER_A,
            result="1-0",
            user_color="white",
            full_hash=WDL_TARGET_HASH + 2,
        )
        # Seed 1 loss for user B (must not appear in user A's count)
        await _seed_game(
            db_session,
            user_id=_USER_B,
            result="0-1",
            user_color="white",
            full_hash=WDL_TARGET_HASH + 1,
        )

        row = await query_wdl_counts(
            db_session,
            user_id=_USER_A,
            hash_column=None,
            target_hash=None,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert row.wins == 2
        assert row.losses == 0

    @pytest.mark.asyncio
    async def test_wdl_counts_with_filters(self, db_session: AsyncSession) -> None:
        """time_control and color filters narrow the aggregate correctly."""
        from app.repositories.openings_repository import query_wdl_counts
        from app.models.game_position import GamePosition

        # Blitz win as white
        await _seed_game(
            db_session,
            result="1-0",
            user_color="white",
            time_control_bucket="blitz",
            full_hash=WDL_TARGET_HASH + 10,
        )
        # Rapid loss as white (excluded by time_control filter)
        await _seed_game(
            db_session,
            result="0-1",
            user_color="white",
            time_control_bucket="rapid",
            full_hash=WDL_TARGET_HASH + 10,
        )
        # Blitz win as black (excluded by color filter)
        await _seed_game(
            db_session,
            result="0-1",
            user_color="black",
            time_control_bucket="blitz",
            full_hash=WDL_TARGET_HASH + 10,
        )

        row = await query_wdl_counts(
            db_session,
            user_id=1,
            hash_column=GamePosition.full_hash,
            target_hash=WDL_TARGET_HASH + 10,
            time_control=["blitz"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )

        assert row.total == 1
        assert row.wins == 1
        assert row.draws == 0
        assert row.losses == 0

    @pytest.mark.asyncio
    async def test_wdl_counts_no_matches_returns_zeros(self, db_session: AsyncSession) -> None:
        """When no games match, query_wdl_counts returns (0, 0, 0, 0) — not an empty result."""
        from app.repositories.openings_repository import query_wdl_counts
        from app.models.game_position import GamePosition

        row = await query_wdl_counts(
            db_session,
            user_id=1,
            hash_column=GamePosition.full_hash,
            target_hash=999999999,  # hash that was never inserted
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert row.total == 0
        assert row.wins == 0
        assert row.draws == 0
        assert row.losses == 0

    @pytest.mark.asyncio
    async def test_wdl_counts_transposition_dedup(self, db_session: AsyncSession) -> None:
        """A game with target hash at two plies is counted once (not twice)."""
        from app.repositories.openings_repository import query_wdl_counts
        from app.models.game_position import GamePosition

        DEDUP_WDL_HASH = 801000

        game = Game(
            user_id=1,
            platform="chess.com",
            platform_game_id=_unique_game_id(),
            platform_url=None,
            pgn="1. e4 e5 2. Nf3 *",
            result="1-0",
            user_color="white",
            time_control_str="600+0",
            time_control_bucket="blitz",
            time_control_seconds=600,
            rated=True,
            white_username="testuser",
            black_username="opp",
        )
        game.played_at = datetime.datetime.now(tz=datetime.timezone.utc)
        db_session.add(game)
        await db_session.flush()

        # Same hash appears at two different plies
        for ply in (2, 4):
            pos = GamePosition(
                game_id=game.id,
                user_id=1,
                ply=ply,
                full_hash=DEDUP_WDL_HASH,
                white_hash=0,
                black_hash=0,
            )
            db_session.add(pos)
        await db_session.flush()

        row = await query_wdl_counts(
            db_session,
            user_id=1,
            hash_column=GamePosition.full_hash,
            target_hash=DEDUP_WDL_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert row.total == 1, f"Expected total=1 (dedup), got {row.total}"
        assert row.wins == 1
        assert row.draws == 0
        assert row.losses == 0


# ---------------------------------------------------------------------------
# TestQueryTranspositionWdl — Phase 80.1 D-02
# ---------------------------------------------------------------------------

# Unique hashes for the new transposition WDL tests (avoid collisions with
# other tests in this file).
TWDL_SOURCE_HASH = 0xAA01
TWDL_OTHER_SOURCE_HASH = 0xAA02
TWDL_RESULT_HASH = 0xAA03
TWDL_OTHER_RESULT_HASH = 0xAA04
TWDL_UNUSED_HASH = 0xAA99


async def _seed_path_to_result_hash(
    db_session: AsyncSession,
    *,
    user_id: int,
    result: str,
    user_color: str,
    source_hash: int,
    source_move_san: str,
    result_hash: int,
    rated: bool = True,
    time_control_bucket: str = "blitz",
    time_control_seconds: int = 600,
) -> Game:
    """Seed one game whose ply-1 hash is `source_hash` (with `source_move_san`)
    and whose ply-2 hash is `result_hash`.
    """
    game, _ = await _seed_game(
        db_session,
        user_id=user_id,
        result=result,
        user_color=user_color,
        full_hash=source_hash,
        move_san=source_move_san,
        rated=rated,
        time_control_bucket=time_control_bucket,
    )
    # _seed_game inserts at ply=1; manually patch the time_control_seconds on
    # the game row to support filter-parity tests with non-blitz buckets.
    if time_control_seconds != 600:
        game.time_control_seconds = time_control_seconds
        db_session.add(game)
        await db_session.flush()
    await _add_position(db_session, game.id, user_id, ply=2, full_hash=result_hash, move_san=None)
    return game


class TestQueryTranspositionWdl:
    """Phase 80.1 D-02: resulting-position WDL via query_resulting_position_wdl.

    Post quick task 260512-p5p (Task 1): query_transposition_wdl was deleted
    after query_resulting_position_wdl converged on the same SQL shape with
    one extra column (last_played_at). These tests preserve coverage by
    targeting the surviving function and slicing the 4-tuple to compare W/D/L.
    """

    @pytest.mark.asyncio
    async def test_query_transposition_wdl_convergence_two_games(
        self, db_session: AsyncSession
    ) -> None:
        """Phase 80.1 D-02 / Validation case #1: convergence.

        Game A plays e4 from SOURCE_HASH → RESULT_HASH (win, white).
        Game B plays d4 from OTHER_SOURCE_HASH → RESULT_HASH (loss, white) via
        a different move order. Combined WDL across both games.
        """
        from app.repositories.openings_repository import query_resulting_position_wdl

        # Game A: e4 from SOURCE_HASH → RESULT_HASH, win for white
        await _seed_path_to_result_hash(
            db_session,
            user_id=1,
            result="1-0",
            user_color="white",
            source_hash=TWDL_SOURCE_HASH,
            source_move_san="e4",
            result_hash=TWDL_RESULT_HASH,
        )
        # Game B: d4 from OTHER_SOURCE_HASH → RESULT_HASH (transposition), loss for white
        await _seed_path_to_result_hash(
            db_session,
            user_id=1,
            result="0-1",
            user_color="white",
            source_hash=TWDL_OTHER_SOURCE_HASH,
            source_move_san="d4",
            result_hash=TWDL_RESULT_HASH,
        )

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )

        # 2 distinct games visit the resulting position: 1 win + 1 loss.
        assert wdl[TWDL_RESULT_HASH][:3] == (1, 0, 1)

    @pytest.mark.asyncio
    async def test_query_transposition_wdl_single_order(self, db_session: AsyncSession) -> None:
        """Single game visiting RESULT_HASH; pos WDL == move-played WDL."""
        from app.repositories.openings_repository import query_resulting_position_wdl

        await _seed_path_to_result_hash(
            db_session,
            user_id=1,
            result="1-0",
            user_color="white",
            source_hash=TWDL_SOURCE_HASH,
            source_move_san="e4",
            result_hash=TWDL_RESULT_HASH,
        )

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )

        assert wdl[TWDL_RESULT_HASH][:3] == (1, 0, 0)

    @pytest.mark.asyncio
    async def test_query_transposition_wdl_filter_parity_drops_games(
        self, db_session: AsyncSession
    ) -> None:
        """Filter parity: time_control filter drops games symmetrically.

        Two games converge on RESULT_HASH (one rapid win, one blitz loss).
        Filter time_control=["rapid"] → only the rapid win remains; without
        the filter, both games contribute.
        """
        from app.repositories.openings_repository import query_resulting_position_wdl

        # Game A: rapid (time_control_seconds=600 → bucket="rapid"), win
        await _seed_path_to_result_hash(
            db_session,
            user_id=1,
            result="1-0",
            user_color="white",
            source_hash=TWDL_SOURCE_HASH,
            source_move_san="e4",
            result_hash=TWDL_RESULT_HASH,
            time_control_bucket="rapid",
        )
        # Game B: blitz, loss (transposition path)
        await _seed_path_to_result_hash(
            db_session,
            user_id=1,
            result="0-1",
            user_color="white",
            source_hash=TWDL_OTHER_SOURCE_HASH,
            source_move_san="d4",
            result_hash=TWDL_RESULT_HASH,
            time_control_bucket="blitz",
        )

        # No filter → both games count
        wdl_all = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TWDL_RESULT_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )
        assert wdl_all[TWDL_RESULT_HASH][:3] == (1, 0, 1)

        # Filter rapid only → blitz loss is dropped
        wdl_rapid = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TWDL_RESULT_HASH],
            time_control=["rapid"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )
        assert wdl_rapid[TWDL_RESULT_HASH][:3] == (1, 0, 0)

        # Filter blitz only → rapid win is dropped (symmetric)
        wdl_blitz = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TWDL_RESULT_HASH],
            time_control=["blitz"],
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color="white",
        )
        assert wdl_blitz[TWDL_RESULT_HASH][:3] == (0, 0, 1)

    @pytest.mark.asyncio
    async def test_query_transposition_wdl_empty_list(self, db_session: AsyncSession) -> None:
        """Empty hash_list returns {} immediately (no DB round trip)."""
        from app.repositories.openings_repository import query_resulting_position_wdl

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert wdl == {}

    @pytest.mark.asyncio
    async def test_query_transposition_wdl_unknown_hash(self, db_session: AsyncSession) -> None:
        """Hash not present in any game is omitted from the dict (NOT (0,0,0))."""
        from app.repositories.openings_repository import query_resulting_position_wdl

        # Seed one unrelated game so the DB is non-empty
        await _seed_path_to_result_hash(
            db_session,
            user_id=1,
            result="1-0",
            user_color="white",
            source_hash=TWDL_SOURCE_HASH,
            source_move_san="e4",
            result_hash=TWDL_RESULT_HASH,
        )

        wdl = await query_resulting_position_wdl(
            db_session,
            user_id=1,
            hash_list=[TWDL_UNUSED_HASH],
            time_control=None,
            platform=None,
            rated=None,
            opponent_type="both",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert wdl == {}


# ---------------------------------------------------------------------------
# TestDefaultPlatformExclusion — SEED-163 §1
# ---------------------------------------------------------------------------

# Dedicated hash so this class cannot collide with TS_HASH or any other fixed
# hash constant in this file.
PLATFORM_EXCL_HASH = 44444444


class TestDefaultPlatformExclusion:
    """_build_base_query and query_time_series must exclude DEFAULT_EXCLUDED_PLATFORMS
    by default, mirroring apply_game_filters (query_utils.py:276-316).

    Data isolation: uses the rollback-scoped ``db_session`` fixture only, and
    nothing is committed. The tier-3 eval lottery reads only committed rows,
    so it never observes these rows and no ``finally`` cleanup block is
    needed (mirrors tests/repositories/test_pasted_platform_exclusion.py).
    """

    async def _seed_three_platforms(self, db_session: AsyncSession) -> None:
        # Each seeded game keeps is_computer_game at the model default (False,
        # app/models/game.py:169). The platform exclusion must be the SOLE
        # discriminator here: if the flawchess row were flagged as a computer
        # game, the default opponent_type="human" filter would hide the leak,
        # which is exactly the accident that has been masking this defect in
        # production (SEED-163 §1).
        await _seed_game(
            db_session,
            platform="chess.com",
            result="1-0",
            full_hash=PLATFORM_EXCL_HASH,
        )
        await _seed_game(
            db_session,
            platform="flawchess",
            result="0-1",
            full_hash=PLATFORM_EXCL_HASH,
        )
        await _seed_game(
            db_session,
            platform="pgn",
            result="1/2-1/2",
            full_hash=PLATFORM_EXCL_HASH,
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize("opponent_type", ["human", "all"])
    async def test_query_all_results_default_excludes_flawchess_and_pgn(
        self, db_session: AsyncSession, opponent_type: str
    ) -> None:
        """platform=None: query_all_results returns only the chess.com row.

        Parametrized over opponent_type to rule out the human-filter masking
        the leak (every seeded game is a non-computer game).
        """
        await self._seed_three_platforms(db_session)

        rows = await query_all_results(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=PLATFORM_EXCL_HASH,
            time_control=None,
            platform=None,
            rated=None,
            opponent_type=opponent_type,
            from_date=None,
            to_date=None,
            color=None,
        )

        assert {(result, user_color) for result, user_color in rows} == {("1-0", "white")}

    @pytest.mark.asyncio
    async def test_query_time_series_default_excludes_flawchess_and_pgn(
        self, db_session: AsyncSession
    ) -> None:
        """platform=None: query_time_series returns only the chess.com row."""
        from app.repositories.openings_repository import query_time_series

        await self._seed_three_platforms(db_session)

        rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=PLATFORM_EXCL_HASH,
            color=None,
            platform=None,
        )

        assert {(result, user_color) for _played_at, result, user_color in rows} == {
            ("1-0", "white")
        }

    @pytest.mark.asyncio
    async def test_explicit_flawchess_opt_in_reaches_excluded_rows_both_functions(
        self, db_session: AsyncSession
    ) -> None:
        """platform=["flawchess"]: only the flawchess row, through both functions (D-03)."""
        from app.repositories.openings_repository import query_time_series

        await self._seed_three_platforms(db_session)

        all_results_rows = await query_all_results(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=PLATFORM_EXCL_HASH,
            time_control=None,
            platform=["flawchess"],
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
        )
        assert {(result, user_color) for result, user_color in all_results_rows} == {
            ("0-1", "white")
        }

        time_series_rows = await query_time_series(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=PLATFORM_EXCL_HASH,
            color=None,
            platform=["flawchess"],
        )
        assert {(result, user_color) for _played_at, result, user_color in time_series_rows} == {
            ("0-1", "white")
        }

    @pytest.mark.asyncio
    async def test_explicit_all_platforms_returns_all_three_rows(
        self, db_session: AsyncSession
    ) -> None:
        """platform=["chess.com", "flawchess", "pgn"]: all three rows via query_all_results."""
        await self._seed_three_platforms(db_session)

        rows = await query_all_results(
            db_session,
            user_id=1,
            hash_column=HASH_COLUMN_MAP["full"],
            target_hash=PLATFORM_EXCL_HASH,
            time_control=None,
            platform=["chess.com", "flawchess", "pgn"],
            rated=None,
            opponent_type="all",
            from_date=None,
            to_date=None,
            color=None,
        )

        assert {(result, user_color) for result, user_color in rows} == {
            ("1-0", "white"),
            ("0-1", "white"),
            ("1/2-1/2", "white"),
        }
