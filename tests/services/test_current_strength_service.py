"""Pure tests for current_strength_service.resolve_current_strength (Quick 260811-u11, SEED-147).

No DB — builds RecentRungRow fixtures directly and calls the pure selection
function. DB-backed qualifying-games filtering is covered separately by
tests/repositories/test_current_strength_repository.py.
"""

from __future__ import annotations

import datetime

from app.repositories.current_strength_repository import RecentRungRow
from app.repositories.query_utils import AnalyticsPlatform
from app.repositories.user_rating_anchors_repository import RatingAnchorRow
from app.schemas.normalization import TimeControlBucket
from app.services.chesscom_to_lichess import normalize_to_lichess_blitz
from app.services.current_strength_service import (
    MIN_QUALIFYING_GAMES,
    resolve_current_strength,
)

_UTC = datetime.timezone.utc


def _rung(
    platform: AnalyticsPlatform,
    tc: TimeControlBucket,
    n_games: int,
    rating: int,
    latest_played_at: datetime.datetime,
    *,
    sample_size: int = 20,
) -> RecentRungRow:
    return RecentRungRow(
        platform=platform,
        time_control_bucket=tc,
        n_games=n_games,
        recent_ratings=tuple([rating] * min(n_games, sample_size)),
        latest_played_at=latest_played_at,
    )


def _anchor(rating: int) -> RatingAnchorRow:
    return RatingAnchorRow(
        anchor_rating=rating,
        n_chesscom_games=0,
        n_lichess_games=30,
        chesscom_median_native=None,
        lichess_median_native=rating,
    )


class TestFloorBoundary:
    """D-01: exactly the 20th game flips a rung from ignored to selected."""

    def test_19_games_is_ignored(self) -> None:
        rung = _rung(
            "lichess",
            "blitz",
            MIN_QUALIFYING_GAMES - 1,
            1500,
            datetime.datetime(2026, 8, 1, tzinfo=_UTC),
        )

        result = resolve_current_strength([rung], anchors={})

        assert result is None

    def test_20_games_is_selected(self) -> None:
        rung = _rung(
            "lichess",
            "blitz",
            MIN_QUALIFYING_GAMES,
            1500,
            datetime.datetime(2026, 8, 1, tzinfo=_UTC),
        )

        result = resolve_current_strength([rung], anchors={})

        assert result is not None
        assert result.source == "recent_games"
        assert result.rating == 1500
        assert result.rung is not None
        assert result.rung.n_games == MIN_QUALIFYING_GAMES


class TestRecencyRanking:
    """D-03: the rung with the latest latest_played_at wins, absent a tiebreak."""

    def test_most_recent_rung_wins(self) -> None:
        rung_a = _rung("chess.com", "blitz", 25, 1400, datetime.datetime(2026, 8, 1, tzinfo=_UTC))
        rung_b = _rung("chess.com", "rapid", 25, 1400, datetime.datetime(2026, 8, 5, tzinfo=_UTC))
        # A native lichess-blitz rung, but far enough behind the leader (35
        # days > the 7-day tiebreak lag bound) that it cannot win the tiebreak.
        rung_c = _rung("lichess", "blitz", 25, 1300, datetime.datetime(2026, 7, 1, tzinfo=_UTC))

        result = resolve_current_strength([rung_a, rung_b, rung_c], anchors={})

        assert result is not None
        assert result.rung is not None
        assert result.rung.platform == "chess.com"
        assert result.rung.time_control_bucket == "rapid"


class TestNativeBlitzTiebreak:
    """D-03/P-02: the CONTEXT-approved worked example, plus the lag negative.

    P-02 was revised on 2026-08-11 against real prod data: the tiebreak has
    NO point-gap condition. Only the lag bound can stop it.
    """

    def test_positive_tiebreak_prefers_native_blitz(self) -> None:
        # chess.com blitz, native 1118 -> ~1493; most recent (2026-08-11).
        cc_blitz = _rung(
            "chess.com", "blitz", 317, 1118, datetime.datetime(2026, 8, 11, tzinfo=_UTC)
        )
        # lichess blitz, native/identity 1532; one day behind, within the
        # 7-day lag bound.
        li_blitz = _rung("lichess", "blitz", 152, 1532, datetime.datetime(2026, 8, 10, tzinfo=_UTC))

        result = resolve_current_strength([cc_blitz, li_blitz], anchors={})

        assert result is not None
        assert result.rating == 1532
        assert result.rung is not None
        assert result.rung.platform == "lichess"
        assert result.rung.time_control_bucket == "blitz"
        assert result.rung.converted is False

    def test_wide_point_gap_does_not_block_the_tiebreak(self) -> None:
        # The revised-P-02 regression. cc's native 700 normalizes hundreds of
        # points away from li's 1532 -- under the original 50-point bound the
        # converted rung won. A wide gap is evidence the ChessGoals conversion
        # is off for this user, so the native rung must still win.
        cc_blitz = _rung(
            "chess.com", "blitz", 317, 700, datetime.datetime(2026, 8, 11, tzinfo=_UTC)
        )
        li_blitz = _rung("lichess", "blitz", 152, 1532, datetime.datetime(2026, 8, 10, tzinfo=_UTC))
        cc_normalized = normalize_to_lichess_blitz(
            700, "chess.com", "blitz", is_correspondence=False
        )
        assert cc_normalized is not None
        # Guard the premise: this fixture must stay a genuinely wide gap, so
        # the test cannot silently degrade into the narrow-gap case above.
        assert abs(cc_normalized - 1532) > 50

        result = resolve_current_strength([cc_blitz, li_blitz], anchors={})

        assert result is not None
        assert result.rating == 1532
        assert result.rung is not None
        assert result.rung.platform == "lichess"
        assert result.rung.time_control_bucket == "blitz"
        assert result.rung.converted is False

    def test_prod_user_3_regression(self) -> None:
        """The real 2026-08-11 prod snapshot that motivated the P-02 revision.

        chess.com blitz led on recency by ~8 hours and normalized to 1467;
        native lichess blitz sat at 1554, an 87-point gap that the original
        50-point bound rejected -- publishing an 87-point under-estimate of a
        rating readable natively. Expected answer: 1554.
        """
        cc_blitz = _rung(
            "chess.com",
            "blitz",
            315,
            1086,
            datetime.datetime(2026, 8, 11, 16, 2, 20, tzinfo=_UTC),
        )
        li_blitz = _rung(
            "lichess",
            "blitz",
            152,
            1554,
            datetime.datetime(2026, 8, 11, 7, 40, 17, tzinfo=_UTC),
        )
        li_rapid = _rung(
            "lichess",
            "rapid",
            75,
            1655,
            datetime.datetime(2026, 8, 11, 7, 10, 17, tzinfo=_UTC),
        )
        # 8 games -- below the 20-game floor, must never be selected.
        cc_rapid = _rung("chess.com", "rapid", 8, 1387, datetime.datetime(2026, 8, 2, tzinfo=_UTC))

        result = resolve_current_strength([cc_blitz, li_blitz, li_rapid, cc_rapid], anchors={})

        assert result is not None
        assert result.rating == 1554
        assert result.rung is not None
        assert result.rung.platform == "lichess"
        assert result.rung.time_control_bucket == "blitz"
        assert result.rung.n_games == 152
        assert result.rung.converted is False

    def test_negative_on_lag_top_rung_wins(self) -> None:
        # The one condition that still blocks the tiebreak: li's latest game
        # is 10 days behind cc's, past the 7-day lag bound.
        cc_blitz = _rung(
            "chess.com", "blitz", 317, 1118, datetime.datetime(2026, 8, 11, tzinfo=_UTC)
        )
        li_blitz = _rung("lichess", "blitz", 152, 1532, datetime.datetime(2026, 8, 1, tzinfo=_UTC))

        result = resolve_current_strength([cc_blitz, li_blitz], anchors={})

        assert result is not None
        assert result.rung is not None
        assert result.rung.platform == "chess.com"
        assert result.rung.time_control_bucket == "blitz"
        assert result.rung.converted is True


class TestFallback:
    """D-07: falls back to the blitz-bucket anchor when no rung survives."""

    def test_no_qualifying_rung_falls_back_to_blitz_anchor(self) -> None:
        below_floor = _rung(
            "lichess",
            "blitz",
            MIN_QUALIFYING_GAMES - 1,
            1500,
            datetime.datetime(2026, 8, 1, tzinfo=_UTC),
        )

        result = resolve_current_strength([below_floor], anchors={"blitz": _anchor(1370)})

        assert result is not None
        assert result.rating == 1370
        assert result.source == "rating_anchor"
        assert result.rung is None

    def test_unconvertible_rung_is_dropped_and_falls_back(self) -> None:
        # 100 is below the published [500, 3000] chess.com Blitz range --
        # genuinely out of range, asserted directly so this fixture cannot
        # silently drift into range.
        assert (
            normalize_to_lichess_blitz(100, "chess.com", "blitz", is_correspondence=False) is None
        )
        unconvertible = _rung(
            "chess.com",
            "blitz",
            MIN_QUALIFYING_GAMES,
            100,
            datetime.datetime(2026, 8, 1, tzinfo=_UTC),
        )

        result = resolve_current_strength([unconvertible], anchors={"blitz": _anchor(1370)})

        assert result is not None
        assert result.rating == 1370
        assert result.source == "rating_anchor"
        assert result.rung is None

    def test_no_rung_and_no_anchor_returns_none(self) -> None:
        result = resolve_current_strength([], anchors={})

        assert result is None

    def test_non_blitz_anchors_do_not_rescue_the_fallback(self) -> None:
        result = resolve_current_strength(
            [], anchors={"rapid": _anchor(1600), "classical": _anchor(1550)}
        )

        assert result is None
