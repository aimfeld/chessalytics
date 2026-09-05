"""Shared query utilities for repository filter operations."""

import datetime
from collections.abc import Sequence
from typing import Any, Literal, cast, get_args

from sqlalchemy import and_, case, literal, or_
from sqlalchemy.sql.elements import ColumnElement

from app.models.game import Game

# ---------------------------------------------------------------------------
# Ply-parity convention (single source — CONTEXT D-01, Phase 113)
# ---------------------------------------------------------------------------
# Even ply → white mover; odd ply → black mover.
# This mirrors _run_all_moves_pass in flaws_service.py (line ~227):
#     mover = "white" if n % 2 == 0 else "black"
# A prior off-by-one bug lived here (see CONTEXT D-01 / RESEARCH Pitfall 1).
# Do NOT scatter ply % 2 math across query sites — always use is_opponent_expr.
_PLY_EVEN_MOVER_WHITE = 0  # ply % 2 == 0 means white moved

# ---------------------------------------------------------------------------
# Default platform exclusion (single source — CONTEXT D-02, Phase 167; extended
# Phase 208 D-05/D-11)
# ---------------------------------------------------------------------------
# Flawchess bot-practice games must stay invisible to every default analytics
# population (STORE-07) while remaining reachable by any caller that passes an
# explicit platform list including "flawchess" (e.g. library_service's
# get_library_games opt-in, D-03). This is the ONE central seam — do not
# scatter per-router platform checks.
#
# Phase 208 (PASTE-05): a pasted PGN (platform="pgn") is excluded for the same
# reason and the same way. Pasted games are frequently NOT the user's own — a
# broadcast game, a friend's PGN, a scouted opponent — so they must never
# reach an analytics population. A pasted game that genuinely IS the user's
# own doesn't count either: import it from the platform it was actually
# played on. Unlike "flawchess", "pgn" has no default opt-in anywhere
# (D-11/D-12) — the Library's "Pasted" filter chip opts back in by passing an
# explicit `platform=["pgn"]` list, which the existing `platform is not None`
# branch below already honors with no new plumbing.
DEFAULT_EXCLUDED_PLATFORMS = ("flawchess", "pgn")

# Every value of the Platform Literal (app/schemas/normalization.py) must
# appear in EXACTLY ONE of DEFAULT_EXCLUDED_PLATFORMS or
# ANALYTICS_INCLUDED_PLATFORMS — a future platform value that is added to one
# without a decision for the other is a silent analytics-eligibility bug.
# tests/repositories/test_query_utils.py::test_every_platform_has_an_analytics_disposition
# enforces this invariant by comparing typing.get_args(Platform) against the
# union of the two tuples.
#
# Quick 260811-u11: AnalyticsPlatform is the type-level twin of the tuple
# below, derived via get_args() so the two are structurally impossible to
# drift apart (rather than merely documented as agreeing). Exported for
# current_strength_repository / current_strength_service to import and cast
# a raw platform string once apply_game_filters(platform=None) has already
# excluded every other Platform member.
AnalyticsPlatform = Literal["chess.com", "lichess"]
ANALYTICS_INCLUDED_PLATFORMS: tuple[str, ...] = get_args(AnalyticsPlatform)


def mover_is_white_at_ply(ply: int) -> bool:
    """Return True when the mover at *ply* is White (Python read-path helper).

    Mirrors the SQL convention in is_opponent_expr — both derive from the same
    _PLY_EVEN_MOVER_WHITE constant so the Python and SQL paths agree on ply parity.
    Use this instead of bare ``ply % 2 == 0`` to keep the single source intact.
    """
    return ply % 2 == _PLY_EVEN_MOVER_WHITE


def is_opponent_expr(
    ply_col: Any,
    user_color_col: Any,
) -> ColumnElement[bool]:
    """Return a SQL expression that is True when the mover at ply_col is the OPPONENT.

    Convention (mirrors _run_all_moves_pass in flaws_service.py):
        even ply → white mover → is_opponent iff user_color == 'black'
        odd ply  → black mover → is_opponent iff user_color == 'white'

    Single source of the ply-parity convention. Unit-tested for all 4
    (ply parity × user_color) combinations (TestIsOpponentExpr). A prior
    off-by-one bug lived here — see CONTEXT D-01 / RESEARCH Pitfall 1.

    Args:
        ply_col: A column or literal expression resolving to the ply integer.
                 Accepts ColumnElement[int] or ORM InstrumentedAttribute[int]
                 (typed as Any because ty does not recognise InstrumentedAttribute
                 as a ColumnElement subtype — they share SQLColumnExpression lineage).
        user_color_col: A column or literal expression resolving to 'white'/'black'.
                 Same Any widening reason as ply_col.

    Returns:
        A SQLAlchemy ColumnElement[bool] usable in WHERE/FILTER clauses.
    """
    return case(
        (ply_col % 2 == _PLY_EVEN_MOVER_WHITE, user_color_col == "black"),
        else_=user_color_col == "white",
    )


def mover_color_expr(ply_col: Any) -> ColumnElement[str]:
    """Return a SQL expression yielding the mover's color ('white'/'black') at ply_col.

    SQL twin of `mover_color_for_ply` (app/services/best_move_candidates.py:65-68):
    even ply -> white, odd ply -> black. It exists so a caller that has a ply
    column but no `Game` join can still name the mover — e.g. Train's dead-band
    predicate (`app/services/train_pool.py`'s `dead_band_admissible`), which is
    applied at a COUNT statement that deliberately drops the `Game` join
    (`get_waiting_puzzle_count`'s due-count statement). This module is already
    documented as the single source of the ply-parity convention (see the module
    docstring above) — a second parity expression elsewhere is exactly what
    CLAUDE.md's "never hand-roll `ply % 2`" rule forbids. Its two output values
    are the same two strings `expected_score_sql`'s `user_color_col` argument
    compares against ('white'/'black').

    Args:
        ply_col: A column or literal expression resolving to the ply integer.
                 Accepts ColumnElement[int] or ORM InstrumentedAttribute[int]
                 (typed as Any because ty does not recognise InstrumentedAttribute
                 as a ColumnElement subtype — they share SQLColumnExpression lineage).

    Returns:
        A SQLAlchemy ColumnElement[str] yielding 'white' or 'black'.
    """
    return case(
        (ply_col % 2 == _PLY_EVEN_MOVER_WHITE, literal("white")),
        else_=literal("black"),
    )


def player_only_gate(
    ply_col: Any,
    user_color_col: Any,
) -> ColumnElement[bool]:
    """Convenience inverse of is_opponent_expr — True when the mover is the PLAYER.

    Use at read-gating call sites (D-04) so intent reads as 'player only'
    rather than a negation. Equivalent to ~is_opponent_expr(...).

    Args:
        ply_col: A column or literal expression resolving to the ply integer.
                 Accepts ColumnElement[int] or ORM InstrumentedAttribute[int].
        user_color_col: A column or literal expression resolving to 'white'/'black'.

    Returns:
        A SQLAlchemy ColumnElement[bool] for player-only filtering.
    """
    return ~is_opponent_expr(ply_col, user_color_col)


def apply_game_filters(
    stmt: Any,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None = None,
    *,
    # SEED-163 2b: keyword-only, default-False so every existing caller keeps
    # today's behavior unchanged; only library_repository's two Library-surface
    # query functions set it True.
    native_games_bypass_opponent_and_rated: bool = False,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
    flaw_severity: Sequence[str] | None = None,
    flaw_tags: Sequence[str] | None = None,
    tactic_families: Sequence[str] | None = None,
    user_id: int | None = None,
    # Quick 260621-sm8 follow-up: neutral default is "either" (was "allowed"). With
    # the tactic EXISTS now gated on _tactic_controls_active (orientation alone can
    # activate it), an "allowed" default would make every non-tactic caller
    # (endgame/openings/stats, which pass no orientation) wrongly filter to games
    # with an allowed tactic. "either" matches build_flaw_filter_clauses' default.
    orientation: Literal["either", "missed", "allowed"] = "either",
    min_tactic_depth: int | None = None,
    max_tactic_depth: int | None = None,
    has_gem: bool | None = None,
    has_great: bool | None = None,
) -> Any:
    """Apply standard game filter WHERE clauses to a SELECT statement.

    Args:
        stmt: The base SELECT statement to add filters to.
        time_control: Filter by time control buckets (bullet, blitz, rapid, classical).
        platform: Filter by platform (chess.com, lichess). None = default
                 population, which excludes DEFAULT_EXCLUDED_PLATFORMS
                 ("flawchess", "pgn") — D-02 (Phase 167, STORE-07) and D-05
                 (Phase 208, PASTE-05). Pass an explicit list including
                 "flawchess" or "pgn" to opt in (D-03 / D-11/D-12).
                 ANALYTICS_INCLUDED_PLATFORMS is the explicit-list equivalent
                 of the `platform is None` default: passing
                 `platform=list(ANALYTICS_INCLUDED_PLATFORMS)` returns the
                 same rows as `platform=None`. The
                 test_every_platform_has_an_analytics_disposition invariant
                 test is what keeps the two readings equal — the `notin_`
                 default admits any future platform value by omission, while
                 an explicit `in_` list excludes it, so the two only agree
                 while every Platform member has a declared disposition in
                 exactly one of DEFAULT_EXCLUDED_PLATFORMS /
                 ANALYTICS_INCLUDED_PLATFORMS.
        rated: Filter by rated/unrated. None = no filter.
        opponent_type: "human", "bot", or "all".
        from_date: Include games played on or after this date (inclusive). None = no lower bound.
        to_date: Include games played on or before this date (inclusive, shifted +1 day
                 in SQL so ``played_at < to_date + 1 day`` covers the whole day).
                 None = no upper bound.
        color: Filter by user's piece color ("white"/"black"). None = no color filter
               (used by endgame and stats repos where color is not applicable).
        native_games_bypass_opponent_and_rated: Only the Library Games and Flaws
                 surfaces set this flag. When True, rows whose platform is in
                 DEFAULT_EXCLUDED_PLATFORMS ignore the Opponent and Rated filters
                 unconditionally (including an explicit user selection), because
                 those games are stored rated=False and, for "flawchess",
                 is_computer_game=True — so the new Human+Rated analytics
                 defaults would otherwise hide a game the user just finished
                 from the only place it is browsable. Those rows remain
                 governed by the Platform filter and, for "pgn", by the
                 Library "pasted" control (D-14). This extends Phase 167
                 D-03's "always here" guarantee from the platform axis to the
                 opponent/rated axes. Default False = today's behavior.
        opponent_gap_min: Lower bound (inclusive) on opponent_rating - user_rating.
                         None = unbounded below.
        opponent_gap_max: Upper bound (inclusive) on opponent_rating - user_rating.
                         None = unbounded above.
        flaw_severity: When set (e.g. ["blunder"] or ["mistake"]), restrict to games
                         containing >=1 flaw in game_flaws whose severity is one of the
                         listed values (set membership / IN, not a min-threshold; e.g.
                         ["mistake"] matches mistakes only, not blunders). None (default)
                         leaves the statement unchanged — all existing callers are unaffected.
                         Requires user_id (T-108-07: EXISTS must be user-scoped).
        flaw_tags: When set (e.g. ["low-clock", "reversed"]), additionally
                         restrict to games containing a SINGLE flaw satisfying ALL
                         selected tag families (single-flaw EXISTS semantics, SEED-038).
                         OR within family, AND across families. Phase tags are ignored.
                         None (default) leaves the statement unchanged.
                         Requires user_id when either flaw_severity or flaw_tags is set.
        tactic_families: When set (e.g. ["fork", "skewer"]), restrict to games
                         containing >=1 flaw whose tactic motif int (in the orientation's
                         column) is in the union of FAMILY_TO_MOTIF_INTS values for the
                         selected families. Unknown family keys yield no ints (no-op),
                         never raw SQL (T-126-02). None (default) leaves the statement
                         unchanged. Uses lazy import of FAMILY_TO_MOTIF_INTS from
                         library_repository to avoid a circular import (Phase 126 D-06).
        user_id: The authenticated user's id — required when flaw_severity or
                         flaw_tags is set, to scope the EXISTS subquery's game_flaws read
                         (T-108-07). Ignored otherwise.
        orientation: Which tactic column set to query (Phase 128/129).
                         "either" (default) → OR across both column sets — the neutral
                         default (Quick 260621-sm8; was "allowed", changed so non-tactic
                         callers don't accidentally filter once the tactic EXISTS is
                         gated on _tactic_controls_active).
                         "allowed" → allowed_tactic_motif only.
                         "missed"  → missed_tactic_motif only.
                         FAMILY_TO_MOTIF_INTS is reused unchanged for all orientations.
                         Orientation is a closed Literal enum — never raw column-name
                         interpolation (T-128-05/T-129-01).
        min_tactic_depth / max_tactic_depth: Inclusive depth-range bounds (0-based
                         ply) on the active orientation's depth column (Quick
                         260620-l5k / Phase 130). Each side optional; None = unbounded
                         that side. Mates obey the range too (the Phase 129 D-04
                         exemption was removed). Note: this site does NOT gate on
                         confidence (Pitfall 3 preserved).
        has_gem: When True, restrict to games containing >=1 of the USER's own
                         plies (D-04 player-parity scoping) whose stored
                         game_best_moves candidate classifies as 'gem' via the
                         SAME classifier the board uses (best_move_tier_sql /
                         classify_best_move, GEMS-07/D-03b). None/False = no
                         gem filter. Composed via a single correlated EXISTS
                         (best_move_exists_from_table) — never a parallel path
                         (D-05a, FILT-01).
        has_great: Same as has_gem for the 'great' tier. has_gem=True AND
                         has_great=True is a UNION (gem OR great on the single
                         EXISTS), mirroring the flaw-family EXISTS union (D-05).

    Notes:
        When either gap bound is set, games with missing white/black ratings
        are excluded.

        Date boundary fuzz: ``played_at`` is a TIMESTAMPTZ column stored in UTC;
        ``from_date`` / ``to_date`` are plain DATE values without timezone. The
        comparison uses the server's session timezone (UTC in production), which
        is correct for UTC-normalised timestamps. Games close to midnight in
        non-UTC timezones may straddle the boundary by up to ~24 h — this is an
        accepted trade-off per D-16 (no client_timezone param to avoid scope creep).

    Returns:
        The statement with WHERE clauses appended.
    """
    if time_control is not None:
        stmt = stmt.where(Game.time_control_bucket.in_(time_control))
    if platform is not None:
        stmt = stmt.where(Game.platform.in_(platform))
    else:
        # D-02 (Phase 167): default population (no explicit platform filter)
        # excludes flawchess bot-practice games from every analytics surface,
        # including the opponent_type='bot' explicit-filter case (STORE-07,
        # RESEARCH Pitfall 1). Callers that want flawchess must pass it
        # explicitly in `platform` (e.g. library_service.get_library_games).
        stmt = stmt.where(Game.platform.notin_(DEFAULT_EXCLUDED_PLATFORMS))
    # SEED-163 2b: opponent_type and rated are composed into ONE predicate (rather
    # than independent .where() calls) so native_games_bypass_opponent_and_rated
    # can wrap the whole thing in a platform-exemption OR. When the flag is False
    # the AND of active conditions is equivalent to the old one-where-per-predicate
    # shape — same observable row set.
    opponent_rated_conditions: list[ColumnElement[bool]] = []
    if rated is not None:
        opponent_rated_conditions.append(Game.rated == rated)  # noqa: E712
    if opponent_type == "human":
        opponent_rated_conditions.append(Game.is_computer_game == False)  # noqa: E712
    elif opponent_type == "bot":
        opponent_rated_conditions.append(Game.is_computer_game == True)  # noqa: E712
    if opponent_rated_conditions:
        combined_condition = and_(*opponent_rated_conditions)
        if native_games_bypass_opponent_and_rated:
            # Library-only exemption (SEED-163 2b): flawchess/pgn rows are stored
            # rated=False (and flawchess is_computer_game=True), so a Human+Rated
            # default would otherwise hide a game from the only surface that
            # browses it. The Platform filter above still governs these rows.
            stmt = stmt.where(
                or_(Game.platform.in_(DEFAULT_EXCLUDED_PLATFORMS), combined_condition)
            )
        else:
            stmt = stmt.where(combined_condition)
    # D-10: apply date bounds only when set. to_date is shifted +1 day so the
    # comparison ``played_at < to_date + 1 day`` covers the full to_date day.
    if from_date is not None:
        stmt = stmt.where(Game.played_at >= from_date)
    if to_date is not None:
        stmt = stmt.where(Game.played_at < to_date + datetime.timedelta(days=1))
    if color is not None:
        stmt = stmt.where(Game.user_color == color)
    if opponent_gap_min is not None or opponent_gap_max is not None:
        user_rating = case(
            (Game.user_color == "white", Game.white_rating),
            else_=Game.black_rating,
        )
        opp_rating = case(
            (Game.user_color == "white", Game.black_rating),
            else_=Game.white_rating,
        )
        # Exclude games with missing ratings when filtering by opponent gap.
        stmt = stmt.where(Game.white_rating.isnot(None), Game.black_rating.isnot(None))
        gap = opp_rating - user_rating
        if opponent_gap_min is not None:
            stmt = stmt.where(gap >= opponent_gap_min)
        if opponent_gap_max is not None:
            stmt = stmt.where(gap <= opponent_gap_max)
    # Flaw + tactic filters form ONE family: a single game_flaws row must satisfy
    # ALL selected conditions (severity, context tags, AND tactic motif/orientation/
    # depth) together. flaw_exists_from_table ANDs the whole build_flaw_filter_clauses
    # list onto one row, the same single-row AND semantics the Flaws list uses
    # (query_flaws).
    #
    # BUG FIXED (Quick 260621): previously this emitted TWO separate correlated
    # EXISTS — one for severity/context tags, one for tactics — so a game matched
    # when one flaw was a depth-1-2 fork and a DIFFERENT flaw was low-clock. The
    # tactic and context filters were ANDed at the game level, not the flaw-row
    # level, diverging from the Flaws tab. A single EXISTS over the full clause list
    # restores the expected "one flaw is BOTH a fork AND low-clock" semantics.
    #
    # Lazy import avoids a query_utils <-> library_repository import cycle
    # (mirrors endgame_repository's in-function import pattern).
    from app.repositories.library_repository import (
        FAMILY_TO_MOTIF_INTS,
        _tactic_controls_active,
        best_move_exists_from_table,
        flaw_exists_from_table,
    )
    from app.services.flaws_service import FlawSeverity, FlawTag

    # The tactic EXISTS must apply whenever ANY tactic control is active (family,
    # orientation, OR depth) — mirroring build_flaw_filter_clauses for the Flaws
    # list. resolved_families drop unknown keys (no-op, T-126-02), so an unknown-only
    # selection with default orientation/depth does not trigger a filter.
    families_seq: Sequence[str] = tactic_families or ()
    resolved_families: Sequence[str] = [fam for fam in families_seq if fam in FAMILY_TO_MOTIF_INTS]
    tactic_active = _tactic_controls_active(
        resolved_families, orientation, min_tactic_depth, max_tactic_depth
    )
    if flaw_severity or flaw_tags or tactic_active:
        if user_id is None:
            # Message intentionally omits variable values to preserve Sentry grouping
            # (T-108-07: scoping requires an authenticated user_id).
            raise ValueError("flaw/tactic filter requires user_id for EXISTS scoping")
        # Callers pass validated Literal values; cast narrows Sequence[str].
        severities = cast(Sequence[FlawSeverity], flaw_severity or [])
        tag_list = cast(Sequence[FlawTag], flaw_tags or [])
        exists_pred = flaw_exists_from_table(
            user_id=user_id,
            severity=severities,
            tags=tag_list,
            tactic_families=families_seq,
            orientation=orientation,
            min_tactic_depth=min_tactic_depth,
            max_tactic_depth=max_tactic_depth,
        )
        # flaw_exists_from_table returns true() only when no clause is produced;
        # this path is reached only when a filter is active, so exists_pred is a
        # real EXISTS predicate here (not true()).
        stmt = stmt.where(exists_pred)

    # has_gem / has_great (FILT-01, D-04/D-05/D-05a): a single correlated EXISTS
    # composed alongside (not replacing) the flaw/tactic EXISTS above — both
    # booleans build ONE tiers list so has_gem=True AND has_great=True is a
    # UNION (gem OR great on the same row-set), never an intersection.
    best_move_tiers: list[Literal["gem", "great"]] = []
    if has_gem:
        best_move_tiers.append("gem")
    if has_great:
        best_move_tiers.append("great")
    if best_move_tiers:
        stmt = stmt.where(best_move_exists_from_table(best_move_tiers))
    return stmt
