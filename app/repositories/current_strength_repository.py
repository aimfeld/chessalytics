"""Repository for the current-strength estimate (Quick 260811-u11, SEED-147).

A "rung" is one (platform, time_control_bucket) combination the user has
played recently -- e.g. ("lichess", "blitz") or ("chess.com", "rapid"). This
module is the ONLY new games-reading path added for the opponent-matching
current-strength estimate; it composes its WHERE clause entirely through
``apply_game_filters`` rather than restating the predicate. That composition
is what excludes FlawChess's own bot-game rating stamps, unrated games, and
pasted PGNs from the qualifying-games set -- the deleted
``get_current_rating_by_platform`` bypassed ``apply_game_filters`` and read
FlawChess's own bot-game rating back as the user's rating (1340 for prod
user 3). A future edit that hand-rolls a games predicate here instead of
routing through ``apply_game_filters`` reintroduces that exact regression.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass
from typing import cast

from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.repositories.query_utils import AnalyticsPlatform, apply_game_filters
from app.schemas.normalization import TimeControlBucket
from app.services.normalization import is_correspondence_time_control

# Upper bound on rows read per fetch_recent_rungs call. Rows are ordered by
# played_at DESC, so this bound keeps exactly the most recent games -- which
# is all the 90-day activity floor and the recency ranking ever care about.
# ix_games_user_played_at (user_id, played_at DESC) serves this as a range
# scan, so a hyper-active account cannot turn this into an unbounded read.
_MAX_ROWS_SCANNED = 2000


@dataclass(frozen=True)
class RecentRungRow:
    """One (platform, time_control_bucket) rung's recent-games summary.

    Fields:
      platform: The rung's analytics platform (chess.com or lichess -- the
        other two Platform members are already excluded by
        ``apply_game_filters(platform=None)``).
      time_control_bucket: The rung's TC bucket.
      n_games: The full qualifying-game count inside the window -- used for
        the activity floor (D-01) and for display (n_games in the popover).
      recent_ratings: The user's own-side rating for up to ``sample_size``
        most recent qualifying games in this rung, most-recent-first.
      latest_played_at: The ``played_at`` of the rung's single most recent
        qualifying game -- the recency-ranking signal (D-03).
    """

    platform: AnalyticsPlatform
    time_control_bucket: TimeControlBucket
    n_games: int
    recent_ratings: tuple[int, ...]
    latest_played_at: datetime.datetime


async def fetch_recent_rungs(
    session: AsyncSession,
    *,
    user_id: int,
    since: datetime.date,
    sample_size: int,
) -> list[RecentRungRow]:
    """Return every (platform, TC) rung the user has qualifying games in since ``since``.

    V4 Information Disclosure mitigation (mirrors
    ``user_rating_anchors_repository.fetch_anchors_for_user``): ``user_id`` is
    keyword-only and MUST be sourced by the caller from the authenticated
    ``current_active_user`` dependency -- never accepted as a query, path, or
    body parameter.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK.
        since: Inclusive lower bound on ``played_at`` (the 90-day window
            start, derived by the caller from the current instant).
        sample_size: Max games per rung kept in ``recent_ratings`` (most
            recent first). ``n_games`` on the returned row is unaffected --
            it always reflects the FULL in-window count.

    Returns:
        One ``RecentRungRow`` per (platform, TC) combination with at least
        one qualifying game since ``since``, in the order their most recent
        qualifying game was played (descending).
    """
    user_rating = case(
        (Game.user_color == "white", Game.white_rating),
        else_=Game.black_rating,
    )
    stmt = select(
        Game.platform,
        Game.time_control_bucket,
        Game.played_at,
        Game.time_control_str,
        user_rating.label("user_rating"),
    ).where(Game.user_id == user_id)
    # Qualifying-games definition (D-04): these four apply_game_filters
    # arguments are the WHOLE definition of a qualifying game. Loosening any
    # one of rated=True / opponent_type="human" / platform=None reintroduces
    # the bot-game rating echo described in the module docstring above.
    stmt = apply_game_filters(
        stmt,
        time_control=None,
        platform=None,
        rated=True,
        opponent_type="human",
        from_date=since,
        to_date=None,
    )
    stmt = stmt.where(
        Game.time_control_bucket.isnot(None),
        user_rating.isnot(None),
    )
    stmt = stmt.order_by(Game.played_at.desc()).limit(_MAX_ROWS_SCANNED)

    result = await session.execute(stmt)
    rows = result.all()

    # Group survivors by (platform, tc_bucket), preserving the descending
    # played_at order already established by the ORDER BY above -- each
    # group's first entry is therefore its rung's most recent game.
    grouped: dict[tuple[str, str], list[tuple[datetime.datetime, int]]] = {}
    order: list[tuple[str, str]] = []
    for row in rows:
        platform, tc_bucket, played_at, time_control_str, rating = row
        if is_correspondence_time_control(time_control_str):
            continue
        key = (platform, tc_bucket)
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append((played_at, rating))

    rungs: list[RecentRungRow] = []
    for key in order:
        entries = grouped[key]
        platform, tc_bucket = key
        rungs.append(
            RecentRungRow(
                # Sound because apply_game_filters(platform=None) has already
                # excluded every Platform member outside AnalyticsPlatform.
                platform=cast(AnalyticsPlatform, platform),
                time_control_bucket=cast(TimeControlBucket, tc_bucket),
                n_games=len(entries),
                recent_ratings=tuple(rating for _, rating in entries[:sample_size]),
                latest_played_at=entries[0][0],
            )
        )
    return rungs


__all__ = ["RecentRungRow", "fetch_recent_rungs"]
