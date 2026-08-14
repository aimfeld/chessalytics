"""DB tests for current_strength_repository.fetch_recent_rungs (Quick 260811-u11, SEED-147).

Data isolation: uses the rollback-scoped ``db_session`` fixture and
``ensure_test_user`` exactly as tests/repositories/test_pasted_platform_exclusion.py
does. Nothing is committed, so the tier-3 eval lottery (which reads only
committed rows) never observes these rows and no explicit cleanup is needed.
"""

from __future__ import annotations

import datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.repositories.current_strength_repository import fetch_recent_rungs
from tests.conftest import ensure_test_user

_TEST_USER_ID = 92403  # unique ID for this test module
_OTHER_USER_ID = 92404  # second user for the scoping test

pytestmark = pytest.mark.asyncio

_UTC = datetime.timezone.utc
_NOW = datetime.datetime.now(_UTC)
_TODAY = _NOW.date()
_SINCE = _TODAY - datetime.timedelta(days=90)


async def _seed_game(
    db_session: AsyncSession,
    *,
    user_id: int,
    platform_game_id: str,
    platform: str,
    rated: bool,
    is_computer_game: bool,
    user_color: str,
    white_rating: int | None,
    black_rating: int | None,
    time_control_str: str | None,
    time_control_bucket: str | None,
    played_at: datetime.datetime,
) -> None:
    game = Game(
        user_id=user_id,
        platform=platform,
        platform_game_id=platform_game_id,
        pgn="1. e4 e5 1-0",
        result="1-0",
        user_color=user_color,
        rated=rated,
        is_computer_game=is_computer_game,
        white_rating=white_rating,
        black_rating=black_rating,
        time_control_str=time_control_str,
        time_control_bucket=time_control_bucket,
        played_at=played_at,
    )
    db_session.add(game)
    await db_session.flush()


async def _seed_qualifying_lichess_blitz(
    db_session: AsyncSession,
    *,
    user_id: int,
    count: int,
    rating: int,
    id_prefix: str,
    played_at: datetime.datetime | None = None,
) -> None:
    for i in range(count):
        await _seed_game(
            db_session,
            user_id=user_id,
            platform_game_id=f"{id_prefix}-{i}",
            platform="lichess",
            rated=True,
            is_computer_game=False,
            user_color="white",
            white_rating=rating,
            black_rating=rating - 100,
            time_control_str="180+2",
            time_control_bucket="blitz",
            played_at=played_at or (_NOW - datetime.timedelta(days=i)),
        )


class TestFilterHolds:
    """The regression proof: reverting any single apply_game_filters arm must fail this."""

    async def test_only_rated_human_lichess_blitz_survives(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)

        # The signal: 25 rated human lichess blitz games at 1500.
        await _seed_qualifying_lichess_blitz(
            db_session, user_id=_TEST_USER_ID, count=25, rating=1500, id_prefix="signal"
        )
        # Noise 1: FlawChess bot-practice games (DEFAULT_EXCLUDED_PLATFORMS).
        for i in range(25):
            await _seed_game(
                db_session,
                user_id=_TEST_USER_ID,
                platform_game_id=f"flawchess-{i}",
                platform="flawchess",
                rated=False,
                is_computer_game=True,
                user_color="white",
                white_rating=1340,
                black_rating=1340,
                time_control_str="180+2",
                time_control_bucket="blitz",
                played_at=_NOW - datetime.timedelta(days=i),
            )
        # Noise 2: unrated human lichess blitz games.
        for i in range(25):
            await _seed_game(
                db_session,
                user_id=_TEST_USER_ID,
                platform_game_id=f"unrated-{i}",
                platform="lichess",
                rated=False,
                is_computer_game=False,
                user_color="white",
                white_rating=1900,
                black_rating=1900,
                time_control_str="180+2",
                time_control_bucket="blitz",
                played_at=_NOW - datetime.timedelta(days=i),
            )
        # Noise 3: rated games against a computer.
        for i in range(25):
            await _seed_game(
                db_session,
                user_id=_TEST_USER_ID,
                platform_game_id=f"vs-computer-{i}",
                platform="lichess",
                rated=True,
                is_computer_game=True,
                user_color="white",
                white_rating=1900,
                black_rating=1900,
                time_control_str="180+2",
                time_control_bucket="blitz",
                played_at=_NOW - datetime.timedelta(days=i),
            )
        # Noise 4: pasted games (DEFAULT_EXCLUDED_PLATFORMS).
        for i in range(25):
            await _seed_game(
                db_session,
                user_id=_TEST_USER_ID,
                platform_game_id=f"pgn-{i}",
                platform="pgn",
                rated=True,
                is_computer_game=False,
                user_color="white",
                white_rating=1900,
                black_rating=1900,
                time_control_str="180+2",
                time_control_bucket="blitz",
                played_at=_NOW - datetime.timedelta(days=i),
            )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert len(rungs) == 1
        rung = rungs[0]
        assert (rung.platform, rung.time_control_bucket) == ("lichess", "blitz")
        assert rung.n_games == 25
        assert all(rating == 1500 for rating in rung.recent_ratings)


class TestWindowBoundary:
    async def test_89_days_counted_91_days_not(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)
        included_at = datetime.datetime.combine(
            _TODAY - datetime.timedelta(days=89), datetime.time(12, 0), tzinfo=_UTC
        )
        excluded_at = datetime.datetime.combine(
            _TODAY - datetime.timedelta(days=91), datetime.time(12, 0), tzinfo=_UTC
        )
        await _seed_game(
            db_session,
            user_id=_TEST_USER_ID,
            platform_game_id="within-window",
            platform="lichess",
            rated=True,
            is_computer_game=False,
            user_color="white",
            white_rating=1500,
            black_rating=1400,
            time_control_str="180+2",
            time_control_bucket="blitz",
            played_at=included_at,
        )
        await _seed_game(
            db_session,
            user_id=_TEST_USER_ID,
            platform_game_id="outside-window",
            platform="lichess",
            rated=True,
            is_computer_game=False,
            user_color="white",
            white_rating=1500,
            black_rating=1400,
            time_control_str="180+2",
            time_control_bucket="blitz",
            played_at=excluded_at,
        )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert len(rungs) == 1
        assert rungs[0].n_games == 1


class TestSampleSizeAndOrdering:
    async def test_40_games_sample_size_20(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)
        for i in range(40):
            await _seed_game(
                db_session,
                user_id=_TEST_USER_ID,
                platform_game_id=f"ordering-{i}",
                platform="lichess",
                rated=True,
                is_computer_game=False,
                user_color="white",
                white_rating=2000 - i,
                black_rating=1400,
                time_control_str="180+2",
                time_control_bucket="blitz",
                played_at=_NOW - datetime.timedelta(days=i),
            )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert len(rungs) == 1
        rung = rungs[0]
        assert rung.n_games == 40
        assert len(rung.recent_ratings) == 20
        assert rung.recent_ratings == tuple(2000 - i for i in range(20))


class TestUserSideRatingColorCorrect:
    async def test_returns_own_side_rating_never_opponents(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)
        await _seed_game(
            db_session,
            user_id=_TEST_USER_ID,
            platform_game_id="white-1",
            platform="lichess",
            rated=True,
            is_computer_game=False,
            user_color="white",
            white_rating=1500,
            black_rating=1900,
            time_control_str="180+2",
            time_control_bucket="blitz",
            played_at=_NOW - datetime.timedelta(days=1),
        )
        await _seed_game(
            db_session,
            user_id=_TEST_USER_ID,
            platform_game_id="black-1",
            platform="lichess",
            rated=True,
            is_computer_game=False,
            user_color="black",
            white_rating=2000,
            black_rating=1600,
            time_control_str="180+2",
            time_control_bucket="blitz",
            played_at=_NOW - datetime.timedelta(days=2),
        )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert len(rungs) == 1
        ratings = set(rungs[0].recent_ratings)
        assert ratings == {1500, 1600}
        assert 1900 not in ratings
        assert 2000 not in ratings


class TestCorrespondenceExcluded:
    async def test_correspondence_games_never_form_a_rung(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)
        for i in range(25):
            await _seed_game(
                db_session,
                user_id=_TEST_USER_ID,
                platform_game_id=f"correspondence-{i}",
                platform="lichess",
                rated=True,
                is_computer_game=False,
                user_color="white",
                white_rating=1500,
                black_rating=1400,
                time_control_str="1/172800",  # 2 days per move
                time_control_bucket="classical",
                played_at=_NOW - datetime.timedelta(days=i),
            )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert rungs == []


class TestNullExclusions:
    async def test_null_tc_bucket_and_null_rating_excluded(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)
        await _seed_game(
            db_session,
            user_id=_TEST_USER_ID,
            platform_game_id="null-bucket",
            platform="chess.com",
            rated=True,
            is_computer_game=False,
            user_color="white",
            white_rating=1500,
            black_rating=1400,
            time_control_str="180+2",
            time_control_bucket=None,
            played_at=_NOW - datetime.timedelta(days=1),
        )
        await _seed_game(
            db_session,
            user_id=_TEST_USER_ID,
            platform_game_id="null-rating",
            platform="chess.com",
            rated=True,
            is_computer_game=False,
            user_color="white",
            white_rating=None,
            black_rating=1400,
            time_control_str="1800",
            time_control_bucket="classical",
            played_at=_NOW - datetime.timedelta(days=1),
        )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert rungs == []


class TestUserScoping:
    async def test_other_users_games_never_appear(self, db_session: AsyncSession) -> None:
        await ensure_test_user(db_session, _TEST_USER_ID)
        await ensure_test_user(db_session, _OTHER_USER_ID)
        await _seed_qualifying_lichess_blitz(
            db_session, user_id=_TEST_USER_ID, count=25, rating=1500, id_prefix="mine"
        )
        await _seed_qualifying_lichess_blitz(
            db_session, user_id=_OTHER_USER_ID, count=25, rating=1800, id_prefix="theirs"
        )

        rungs = await fetch_recent_rungs(
            db_session, user_id=_TEST_USER_ID, since=_SINCE, sample_size=20
        )

        assert len(rungs) == 1
        assert rungs[0].n_games == 25
        assert 1800 not in rungs[0].recent_ratings
