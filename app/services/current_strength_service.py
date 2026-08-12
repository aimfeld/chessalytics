"""Current-strength estimate for opponent matching (Quick 260811-u11, SEED-147).

There are two distinct rating quantities in this codebase and they must
stay distinct:

  - The ``user_rating_anchors`` career-median anchor (36-month window,
    Phase 94.4/167) answers "how does this user compare over the long run" --
    it is the join key into the benchmark cohort CDF for the percentile chip,
    and is read here ONLY as the D-07 fallback (never recomputed).
  - The current-strength estimate this module computes answers "who should
    I play right now" -- a 90-day / 20-game-median estimate on whichever
    (platform, TC) rung the user has actually been playing most recently.

CONTEXT (260811-u11-CONTEXT.md, "Cross-platform disagreement is an
artifact"): once every rung is normalized to the Lichess-blitz scale via
``normalize_to_lichess_blitz``, cross-platform "disagreement" all but
vanishes (39 points apart, not the ~400 a naive native-rating comparison
suggests). That is why there is no platform/TC *preference* ladder here --
recency is the only ordering signal, with a native-Lichess-blitz tiebreak
because that rung carries zero conversion error.

UI DEFAULT ONLY (BOT-03): the value resolved here seeds the Bots page's
PersonaGrid rating line, the custom-bot ELO default, and the analysis
board's free-play ELO default. It must never be fed into a bot's move
selection.
"""

from __future__ import annotations

import datetime
import statistics
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user_rating_anchors import TimeControlBucket
from app.repositories.current_strength_repository import RecentRungRow, fetch_recent_rungs
from app.repositories.user_rating_anchors_repository import RatingAnchorRow
from app.schemas.users import CurrentStrengthResponse, CurrentStrengthRung
from app.services.chesscom_to_lichess import normalize_to_lichess_blitz

# D-01: a rung is eligible only with >=20 qualifying games in the last 90
# days. Rationale (CONTEXT): for prod user 3 this cleanly separates the real
# rungs (chess.com blitz 317, lichess blitz 152, lichess rapid 75) from a
# noise rung (chess.com rapid 11).
WINDOW_DAYS = 90
MIN_QUALIFYING_GAMES = 20

# D-02: the estimator is the median of the last 20 qualifying games on the
# selected rung. Rationale (CONTEXT): user 3's last-100 rating range was
# 1482-1567, so a single most-recent sample carries ~±40 of noise; a
# 20-game median damps that while still reacting to a climb within ~20
# games.
MEDIAN_SAMPLE_SIZE = 20

# P-02 (revised 2026-08-11 against real prod data): a native Lichess-blitz
# rung wins over a more-recent rung when it is within this many days of the
# leader's most recent game -- because a native-blitz rung IS the target
# scale and so carries zero conversion error.
#
# There is deliberately NO point-gap condition. The original P-02 also
# required the two normalized estimates to agree within 50 points, which was
# backwards: it made the tiebreak fire exactly when the choice did not
# matter (the rungs agree) and abstain exactly when it did (they disagree).
# Prod user 3 proved the cost -- chess.com blitz normalized to 1467 vs a
# native lichess blitz 1554, an 87-point gap that skipped the tiebreak and
# published the converted number, an 87-point under-estimate of a rating we
# can read natively. A large gap is evidence the ChessGoals conversion is
# off for this user, which argues FOR the native rung, not against it.
#
# The lag bound stays: it is what keeps a genuinely stale native rung from
# beating a currently-played one. The threshold is a Claude's-discretion
# pick (CONTEXT), not from the seed.
NATIVE_BLITZ_TIEBREAK_MAX_LAG_DAYS = 7


def _normalized_estimate(rung: RecentRungRow) -> int | None:
    """Return the rung's median rating normalized to the Lichess-blitz scale, or None.

    ``is_correspondence=False`` is unconditional here because
    ``current_strength_repository.fetch_recent_rungs`` already drops
    correspondence rows via ``normalization.is_correspondence_time_control``
    before any rung is built -- a rung reaching this function is never
    correspondence.
    """
    # statistics.median interpolates (averages the two middle values) on an
    # even-sized sample, which agrees with the anchor pipeline's
    # percentile_cont -- the two estimators stay comparable in kind, even
    # though they run over different windows.
    median = round(statistics.median(rung.recent_ratings))
    return normalize_to_lichess_blitz(
        median,
        rung.platform,
        rung.time_control_bucket,
        is_correspondence=False,
    )


def _is_native_lichess_blitz(rung: RecentRungRow) -> bool:
    return rung.platform == "lichess" and rung.time_control_bucket == "blitz"


def _anchor_fallback(
    anchors: dict[TimeControlBucket, RatingAnchorRow],
) -> CurrentStrengthResponse | None:
    """D-07 fallback: the blitz-bucket anchor, or None.

    A user with only rapid/classical anchors correctly gets None here -- the
    blitz-bucket-only semantic is deliberate, carried over from the helper
    this module replaces (``_lichess_blitz_equivalent_rating``).
    """
    blitz_anchor = anchors.get("blitz")
    if blitz_anchor is None:
        return None
    return CurrentStrengthResponse(
        rating=blitz_anchor.anchor_rating, source="rating_anchor", rung=None
    )


def resolve_current_strength(
    rungs: Sequence[RecentRungRow],
    anchors: dict[TimeControlBucket, RatingAnchorRow],
) -> CurrentStrengthResponse | None:
    """Pure selection policy (D-01 through D-03, D-07, P-02) over pre-fetched rows.

    Args:
        rungs: Every (platform, TC) rung the user has games in within the
            window, as returned by ``fetch_recent_rungs`` (not yet floor-
            filtered).
        anchors: The caller's already-fetched
            ``user_rating_anchors_repository.fetch_anchors_for_user`` result,
            reused rather than re-queried.

    Returns:
        A recent-games-sourced estimate when at least one rung passes the
        floor and converts; otherwise the D-07 anchor fallback; otherwise
        None (guest / newly registered user with neither).
    """
    survivors = [rung for rung in rungs if rung.n_games >= MIN_QUALIFYING_GAMES]

    # Refuse rather than guess: a rung whose median falls outside the
    # published ChessGoals conversion range is dropped rather than
    # extrapolated.
    candidates: list[tuple[RecentRungRow, int]] = []
    for rung in survivors:
        estimate = _normalized_estimate(rung)
        if estimate is not None:
            candidates.append((rung, estimate))

    if not candidates:
        return _anchor_fallback(anchors)

    leader_rung, leader_estimate = max(candidates, key=lambda item: item[0].latest_played_at)

    selected_rung, selected_estimate = leader_rung, leader_estimate
    native_blitz = next(
        (item for item in candidates if _is_native_lichess_blitz(item[0])),
        None,
    )
    if native_blitz is not None and native_blitz[0] is not leader_rung:
        native_rung, native_estimate = native_blitz
        # leader_rung.latest_played_at is the max over all candidates by
        # construction, so this lag is always >= 0 ("trails the leader's").
        lag = leader_rung.latest_played_at - native_rung.latest_played_at
        if lag <= datetime.timedelta(days=NATIVE_BLITZ_TIEBREAK_MAX_LAG_DAYS):
            # Wins because it carries zero conversion error, not because it
            # is more recent -- the recency check above already failed. How
            # far it sits from the leader's estimate is deliberately NOT
            # consulted; see the NATIVE_BLITZ_TIEBREAK_MAX_LAG_DAYS comment.
            selected_rung, selected_estimate = native_rung, native_estimate

    return CurrentStrengthResponse(
        rating=selected_estimate,
        source="recent_games",
        rung=CurrentStrengthRung(
            platform=selected_rung.platform,
            time_control_bucket=selected_rung.time_control_bucket,
            n_games=selected_rung.n_games,
            window_days=WINDOW_DAYS,
            converted=not _is_native_lichess_blitz(selected_rung),
        ),
    )


async def resolve_current_strength_for_user(
    session: AsyncSession,
    *,
    user_id: int,
    now_utc: datetime.datetime,
    anchors: dict[TimeControlBucket, RatingAnchorRow],
) -> CurrentStrengthResponse | None:
    """Async wrapper: fetch this user's rungs as of ``now_utc`` and resolve.

    ``now_utc`` is always supplied by the caller (the router's
    ``dev_now_utc`` dependency) -- this function must never read a clock
    itself (CLAUDE.md dev-clock rule: the profile endpoint becomes
    time-dependent with this change).

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (keyword-only, mirroring
            the repository's V4 access-control convention).
        now_utc: The current instant, from ``dev_now_utc``.
        anchors: The caller's already-fetched anchors dict (reused, not
            re-queried).
    """
    since = (now_utc - datetime.timedelta(days=WINDOW_DAYS)).date()
    rungs = await fetch_recent_rungs(
        session, user_id=user_id, since=since, sample_size=MEDIAN_SAMPLE_SIZE
    )
    return resolve_current_strength(rungs, anchors)


__all__ = ["resolve_current_strength", "resolve_current_strength_for_user"]
