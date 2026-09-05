"""Openings repository: DB queries for position-based W/D/L lookups."""

import ctypes
import datetime
from collections.abc import Sequence
from typing import Any, Literal

import chess
import chess.polyglot
from sqlalchemy import Float, and_, case, cast, func, or_, select
from sqlalchemy.dialects.postgresql import array as pg_array
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.game import Game
from app.models.game_position import MAX_EXPLORER_PLY, GamePosition
from app.models.opening import Opening
from app.repositories.query_utils import apply_game_filters
from app.services.opening_insights_constants import (
    OPENING_INSIGHTS_MAX_ENTRY_PLY,
    OPENING_INSIGHTS_MIN_ENTRY_PLY,
    OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE,
    OPENING_INSIGHTS_MINOR_EFFECT,
    OPENING_INSIGHTS_SCORE_PIVOT,
)

# Note: the SQL gate below uses OPENING_INSIGHTS_MINOR_EFFECT only; the
# major-vs-minor distinction is applied downstream in
# opening_insights_service._classify_row (which uses MAJOR_EFFECT).

# Maps match_side values to the corresponding GamePosition hash column.
HASH_COLUMN_MAP = {
    "white": GamePosition.white_hash,
    "black": GamePosition.black_hash,
    "full": GamePosition.full_hash,
}

# query_opening_transitions is now a flat aggregation (no CTE, no window functions,
# no standard-start subquery). See PR #89 + Alembic migration e925558020b9 (extended
# statistics) for the belt-and-suspenders planner hint that preceded this refactor.
#
# Custom-FEN ply-0 games: ~176 of 344,013 prod ply-0 rows (0.05%) come from
# chess.com thematic tournaments and chess.com custom-position "Let's Play!" games
# that carry [SetUp "1"][FEN ...] PGN headers. These are NOT puzzles, NOT themed
# events, and NOT chess variants — variants are already filtered at import in
# app/services/normalization.py. The flat query does not pre-filter them, because
# they legitimately reached these positions and belong in the W/D/L counts.
# Phase 210 (SEED-042) instead marks them at import (games.initial_fen) and
# excludes them from the sample-representative aggregate only, so the SAN prefix
# is always replayable. _wrap_transition_row's guards remain for the residual
# all-custom group (warning-level Sentry message, never a 500).
#
# STARTING_POSITION_HASH is no longer used by the production query path after this
# refactor but is retained here for potential future callers (e.g. custom tooling
# that needs to check whether a game starts from the standard position).
STARTING_POSITION_HASH: int = ctypes.c_int64(chess.polyglot.zobrist_hash(chess.Board())).value


def _build_base_query(
    select_entity: Any,
    user_id: int,
    hash_column: Any | None,
    target_hash: int | None,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> Any:
    """Build a filtered SELECT that joins game_positions -> games.

    When ``target_hash`` is None, queries all games for the user directly from
    the ``games`` table without a position filter.  When ``target_hash`` is
    provided, joins ``game_positions`` and filters by hash, using DISTINCT ON
    game.id to avoid counting a game multiple times when the target hash appears
    at more than one ply.

    ``select_entity`` may be a single ORM entity/column or a list of columns.
    When a list is provided the columns are unpacked into ``select()``.
    """
    entities = select_entity if isinstance(select_entity, list) else [select_entity]

    if target_hash is not None and hash_column is not None:
        # Position-filtered query: join game_positions and filter by hash.
        # ply <= MAX_EXPLORER_PLY ensures the partial hash index is used (SEED-033).
        base = (
            select(*entities)
            .join(GamePosition, GamePosition.game_id == Game.id)
            .where(
                GamePosition.user_id == user_id,
                hash_column == target_hash,
                GamePosition.ply <= MAX_EXPLORER_PLY,
            )
            .distinct(Game.id)
        )
    else:
        # All-games query: no position filter, query games table directly
        base = select(*entities).where(Game.user_id == user_id)

    # Routes through the single documented filter seam (query_utils.py) instead
    # of a hand-rolled block, which restores the default-population exclusion
    # of "flawchess" / "pgn" (SEED-163 §1) — this call site previously had no
    # `else` branch and never excluded them when platform=None.
    base = apply_game_filters(
        base,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )

    return base


async def query_time_series(
    session: AsyncSession,
    user_id: int,
    hash_column: Any,
    target_hash: int,
    color: str | None,
    time_control: Sequence[str] | None = None,
    platform: Sequence[str] | None = None,
    rated: bool | None = None,
    opponent_type: str = "human",
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> list[Row[Any]]:
    """Return (played_at, result, user_color) tuples for matching games, ordered chronologically.

    Returns per-game rows ordered by played_at ASC so the service can compute
    rolling window win rates over trailing games.

    DISTINCT by Game.id prevents games with the target hash at multiple plies
    from being counted more than once.  Games without played_at are excluded.

    D-19: no date filter on this path — the rolling-window chart covers the
    full game history so that context games before the window anchor rolling
    averages correctly.
    """
    stmt = (
        select(Game.played_at, Game.result, Game.user_color)
        .join(GamePosition, GamePosition.game_id == Game.id)
        .where(
            GamePosition.user_id == user_id,
            hash_column == target_hash,
            # ply <= MAX_EXPLORER_PLY ensures the partial hash index is used (SEED-033).
            GamePosition.ply <= MAX_EXPLORER_PLY,
            Game.played_at.isnot(None),
        )
        .distinct(Game.id)
        .order_by(Game.id, Game.played_at)
    )
    # Routes through the single documented filter seam (query_utils.py) instead
    # of a hand-rolled block, which restores the default-population exclusion
    # of "flawchess" / "pgn" (SEED-163 §1). from_date/to_date are pinned to
    # None: D-19 — this path intentionally has no date bounds so the
    # rolling-window chart has context games from before its anchor.
    stmt = apply_game_filters(
        stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=None,
        to_date=None,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )

    # Wrap in subquery so outer query can order by played_at ASC after DISTINCT ON Game.id
    subq = stmt.subquery()
    ordered = select(subq).order_by(subq.c.played_at.asc())
    rows = await session.execute(ordered)
    return list(rows.all())


async def query_all_results(
    session: AsyncSession,
    user_id: int,
    hash_column: Any | None,
    target_hash: int | None,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> list[Row[Any]]:
    """Return (result, user_color) tuples for ALL matching games (for stats).

    Lightweight — only fetches the two columns needed for W/D/L computation.
    DISTINCT by game_id prevents transposition double-counting.
    """
    # Pass columns as a list so _build_base_query can splat them into select().
    stmt = _build_base_query(
        select_entity=[Game.result, Game.user_color],
        user_id=user_id,
        hash_column=hash_column,
        target_hash=target_hash,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )
    rows = await session.execute(stmt)
    return list(rows.all())


async def query_wdl_counts(
    session: AsyncSession,
    user_id: int,
    hash_column: Any | None,
    target_hash: int | None,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> Row[Any]:
    """Return a single row (total, wins, draws, losses, last_played_at) via SQL aggregation.

    Wraps _build_base_query() as a subquery to get deduplicated (result,
    user_color, played_at) tuples, then applies func.count().filter() on the
    subquery columns to compute W/D/L counts and func.max() to capture the
    most recent played_at across the surviving games — all in a single SQL
    round-trip.

    Always returns exactly one row even when no games match (counts = 0,
    last_played_at IS NULL).
    Uses the same win/draw/loss conditions as stats_repository.py to ensure
    consistent counting across all W/D/L aggregations in the codebase.
    """
    # Deduplicated (result, user_color, played_at) tuples — one row per game
    # (DISTINCT by game_id). played_at is carried so the outer query can
    # compute MAX(played_at) for the "Last played: <relative>" tooltip line.
    dedup = _build_base_query(
        select_entity=[Game.result, Game.user_color, Game.played_at],
        user_id=user_id,
        hash_column=hash_column,
        target_hash=target_hash,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    ).subquery("dedup")

    # W/D/L conditions on the subquery columns (same logic as stats_repository.py)
    win_cond = or_(
        and_(dedup.c.result == "1-0", dedup.c.user_color == "white"),
        and_(dedup.c.result == "0-1", dedup.c.user_color == "black"),
    )
    draw_cond = dedup.c.result == "1/2-1/2"
    loss_cond = or_(
        and_(dedup.c.result == "0-1", dedup.c.user_color == "white"),
        and_(dedup.c.result == "1-0", dedup.c.user_color == "black"),
    )

    stmt = select(
        func.count().label("total"),
        func.count().filter(win_cond).label("wins"),
        func.count().filter(draw_cond).label("draws"),
        func.count().filter(loss_cond).label("losses"),
        func.max(dedup.c.played_at).label("last_played_at"),
    ).select_from(dedup)

    result = await session.execute(stmt)
    return result.one()


async def query_matching_games(
    session: AsyncSession,
    user_id: int,
    hash_column: Any | None,
    target_hash: int | None,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    offset: int,
    limit: int,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> tuple[list[Game], int]:
    """Return a paginated list of Game objects and the total matching count.

    The total count reflects all matches (before pagination) and is derived
    from the same filtered query so it stays consistent with the stats.
    """
    # Count subquery — wrap the deduplicated game IDs to count distinct games.
    count_subq = _build_base_query(
        select_entity=Game.id,
        user_id=user_id,
        hash_column=hash_column,
        target_hash=target_hash,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    ).subquery()
    count_stmt = select(func.count()).select_from(count_subq)
    total: int = (await session.execute(count_stmt)).scalar_one()

    # Paginated game objects, ordered most-recent first.
    # When DISTINCT ON is used (position-filtered queries), PostgreSQL requires
    # the DISTINCT ON expression first in ORDER BY, preventing direct date sorting.
    # Wrap as subquery to deduplicate first, then sort by played_at in outer query.
    dedup_subq = _build_base_query(
        select_entity=Game,
        user_id=user_id,
        hash_column=hash_column,
        target_hash=target_hash,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )
    if target_hash is not None:
        # DISTINCT ON needs id-first ordering for dedup; outer query re-sorts
        dedup_subq = dedup_subq.order_by(Game.id)
        dedup_cte = dedup_subq.cte("deduped_games")
        page_stmt = (
            select(Game)
            .join(dedup_cte, Game.id == dedup_cte.c.id)
            .order_by(Game.played_at.desc())
            .offset(offset)
            .limit(limit)
        )
    else:
        page_stmt = dedup_subq.order_by(Game.played_at.desc()).offset(offset).limit(limit)
    result = await session.execute(page_stmt)
    games = list(result.scalars().all())

    return games, total


async def query_next_moves(
    session: AsyncSession,
    user_id: int,
    target_hash: int,
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> list[Any]:
    """Aggregate next moves for a given position with per-move W/D/L stats.

    Uses a self-join on game_positions (gp1=source, gp2=next ply) to obtain
    both move_san and the resulting position's full_hash in a single query.
    COUNT(DISTINCT game_id) with CASE WHEN handles transposition dedup and
    W/D/L categorization simultaneously.

    Returns a list of rows with columns:
        (move_san, result_hash, game_count, wins, draws, losses)
    Rows with NULL move_san (final position) are excluded.
    """
    gp1 = aliased(GamePosition, name="gp1")
    gp2 = aliased(GamePosition, name="gp2")

    # CASE expressions: yield Game.id when condition is true, else NULL.
    # COUNT(DISTINCT ...) counts distinct non-NULL values.
    win_case = case(
        (
            ((Game.result == "1-0") & (Game.user_color == "white"))
            | ((Game.result == "0-1") & (Game.user_color == "black")),
            Game.id,
        ),
        else_=None,
    )
    draw_case = case(
        (Game.result == "1/2-1/2", Game.id),
        else_=None,
    )
    loss_case = case(
        (
            ((Game.result == "1-0") & (Game.user_color == "black"))
            | ((Game.result == "0-1") & (Game.user_color == "white")),
            Game.id,
        ),
        else_=None,
    )

    stmt = (
        select(
            gp1.move_san,
            gp2.full_hash.label("result_hash"),
            func.count(Game.id.distinct()).label("game_count"),
            func.count(win_case.distinct()).label("wins"),
            func.count(draw_case.distinct()).label("draws"),
            func.count(loss_case.distinct()).label("losses"),
            # Latest played_at across all games contributing to this (move, result_hash)
            # bucket; surfaces "Last played: <relative>" in the score-confidence tooltip.
            func.max(Game.played_at).label("last_played_at"),
        )
        .join(Game, Game.id == gp1.game_id)
        .join(gp2, (gp2.game_id == gp1.game_id) & (gp2.ply == gp1.ply + 1))
        .where(
            gp1.user_id == user_id,
            gp1.full_hash == target_hash,
            # ply <= MAX_EXPLORER_PLY: ensures the partial hash index is used (SEED-033).
            # gp2.ply == gp1.ply + 1, so gp2 is implicitly <= MAX_EXPLORER_PLY + 1 —
            # only gp1 needs the predicate for index selection.
            gp1.ply <= MAX_EXPLORER_PLY,
            gp1.move_san.isnot(None),
        )
        .group_by(gp1.move_san, gp2.full_hash)
    )

    stmt = apply_game_filters(
        stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )

    rows = await session.execute(stmt)
    return list(rows.all())


async def query_resulting_position_wdl(
    session: AsyncSession,
    user_id: int,
    hash_list: list[int],
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    color: str | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> dict[int, tuple[int, int, int, datetime.datetime | None]]:
    """Return {resulting_full_hash: (wins, draws, losses)} for Opening Insights.

    Phase 80.1 D-06: Opening Insights findings show resulting-position WDL.
    Same SQL shape as historic query_transposition_wdl (deleted; see quick
    task 260512-p5p) but the parameter is named
    `hash_list` to reflect the call-site semantics (list of
    `resulting_full_hash` values from query_opening_transitions).

    Filters MUST be identical to query_opening_transitions for consistency.
    The caller (compute_insights) passes color=None to apply_game_filters,
    mirroring query_opening_transitions' filter behavior — both white-perspective
    and black-perspective games visiting the same position contribute to the
    same resulting-position summary the user lands on.

    Kept as a separate function (not a default-named alias) so call sites in
    openings_service vs opening_insights_service stay visually distinct, and so
    future filter divergence between the two surfaces lands cleanly.

    Returns ``{full_hash: (wins, draws, losses, last_played_at)}``. The
    last_played_at element is ``MAX(games.played_at)`` across the games that
    contributed to the WDL counts; it is ``None`` when every contributing game
    has a NULL played_at (rare; the column is nullable on Game).

    Missing hashes (no games match under filters) are omitted from the dict.
    """
    if not hash_list:
        return {}

    win_case = case(
        (
            ((Game.result == "1-0") & (Game.user_color == "white"))
            | ((Game.result == "0-1") & (Game.user_color == "black")),
            Game.id,
        ),
        else_=None,
    )
    draw_case = case((Game.result == "1/2-1/2", Game.id), else_=None)
    loss_case = case(
        (
            ((Game.result == "1-0") & (Game.user_color == "black"))
            | ((Game.result == "0-1") & (Game.user_color == "white")),
            Game.id,
        ),
        else_=None,
    )

    stmt = (
        select(
            GamePosition.full_hash.label("result_hash"),
            func.count(win_case.distinct()).label("wins"),
            func.count(draw_case.distinct()).label("draws"),
            func.count(loss_case.distinct()).label("losses"),
            # MAX(played_at) for the "Last played: <relative>" tooltip line.
            func.max(Game.played_at).label("last_played_at"),
        )
        .join(Game, Game.id == GamePosition.game_id)
        .where(
            GamePosition.user_id == user_id,
            GamePosition.full_hash.in_(hash_list),
            # ply <= MAX_EXPLORER_PLY: ensures the partial hash index is used (SEED-033).
            GamePosition.ply <= MAX_EXPLORER_PLY,
        )
        .group_by(GamePosition.full_hash)
    )

    stmt = apply_game_filters(
        stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=color,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )

    rows = await session.execute(stmt)
    return {row.result_hash: (row.wins, row.draws, row.losses, row.last_played_at) for row in rows}


async def query_opening_transitions(
    session: AsyncSession,
    user_id: int,
    color: Literal["white", "black"],
    time_control: Sequence[str] | None,
    platform: Sequence[str] | None,
    rated: bool | None,
    opponent_type: str,
    from_date: datetime.date | None,
    to_date: datetime.date | None,
    opponent_gap_min: int | None = None,
    opponent_gap_max: int | None = None,
) -> list[Row[Any]]:
    """Flat aggregation of (entry_hash, candidate_san) transitions for one user & color.

    Single SELECT-GROUP-BY-HAVING: no CTE, no window functions, no subquery JOIN.
    Eliminates the structural complexity that caused planner misestimation (see
    PR #89 debug session). Alembic migration e925558020b9 (extended statistics)
    remains as belt-and-suspenders.

    Custom-FEN games (chess.com thematic tournaments and custom-position "Let's
    Play!" games with [SetUp "1"][FEN ...] PGN headers — ~176 of 344k prod
    ply-0 rows, 0.05%) are NOT excluded here: they legitimately reached these
    positions and must keep contributing to n/w/d/l. Phase 210 (SEED-042)
    excludes them from the *sample representative* aggregate only, so the SAN
    prefix handed to the service layer is always replayable from a standard
    board. Before that fix they were preferred as the representative (shallower
    ply) and took the whole transition down with them.

    Returns one Row per surviving (entry_hash, move_san) pair with attrs:
        entry_hash: int        (gp.full_hash, never NULL in output)
        move_san: str          (candidate move SAN, never NULL)
        sample_pair: list[int] | None
                               (paired [ply, game_id] from one real STANDARD-START
                                row in the group; see comment on sample_pair below
                                — for prefix lookup. NULL when every game in the
                                group is custom-start, which the service layer
                                drops.)
        n: int                 (count of distinct games)
        w: int, d: int, l: int (filtered counts)
        last_played_at: datetime | None

    entry_san_sequence and resulting_full_hash are derived in the Python service
    layer via query_transition_prefixes + _replay_san_sequence + _signed_full_hash.

    Returns [] when the user has no qualifying transitions.
    """
    # Win/Loss/Draw conditions (same as stats_repository.query_top_openings_sql_wdl).
    win_cond = or_(
        and_(Game.result == "1-0", Game.user_color == "white"),
        and_(Game.result == "0-1", Game.user_color == "black"),
    )
    draw_cond = Game.result == "1/2-1/2"
    loss_cond = or_(
        and_(Game.result == "0-1", Game.user_color == "white"),
        and_(Game.result == "1-0", Game.user_color == "black"),
    )

    n_games = func.count(func.distinct(Game.id))
    wins = func.count(func.distinct(Game.id)).filter(win_cond)
    draws = func.count(func.distinct(Game.id)).filter(draw_cond)
    losses = func.count(func.distinct(Game.id)).filter(loss_cond)

    # Phase 75 D-08: score-based effect-size gate. score = (W + 0.5·D) / N.
    # Minor-effect threshold drives the SQL gate; major findings are a post-filter
    # in Python (_classify_row). Symmetric on both sides → OR keeps the gate simple.
    score_expr = (cast(wins, Float) + 0.5 * cast(draws, Float)) / cast(n_games, Float)
    weakness_threshold = OPENING_INSIGHTS_SCORE_PIVOT - OPENING_INSIGHTS_MINOR_EFFECT  # 0.45
    strength_threshold = OPENING_INSIGHTS_SCORE_PIVOT + OPENING_INSIGHTS_MINOR_EFFECT  # 0.55

    stmt = (
        select(
            GamePosition.full_hash.label("entry_hash"),
            GamePosition.move_san.label("move_san"),
            # Sample [ply, game_id] from one real row in the group, used by
            # query_transition_prefixes to resolve the SAN prefix that reached this
            # entry position. Paired into a single ARRAY[] aggregate so MIN() picks
            # the (ply, game_id) of one actual row — independent MIN(game_id) and
            # MIN(ply) would de-correlate under transposition (same entry_hash
            # reached at different plies in different games via different move
            # orders), producing a (game_id, ply) sample that doesn't refer to any
            # real row. PG ARRAY MIN is lexicographic, so the smallest array IS
            # one of the input arrays. Sorted (ply, game_id) so smaller ply wins
            # the tiebreak — gives the shallowest reachable prefix.
            #
            # Phase 210 (SEED-042): FILTER to standard-start games. A custom-FEN
            # game reaches a shared entry position at a SHALLOWER ply than
            # standard games (it skips the opening half-moves baked into its
            # [SetUp]/[FEN] header), so an unfiltered MIN(ply) systematically
            # preferred it as the representative — and its SAN prefix is
            # unreplayable from chess.Board(), which dropped the ENTIRE
            # transition, every game included (prod: a 50-game W34/D0/L16 Evans
            # Gambit line, Sentry FLAWCHESS-5E). The filter is on THIS aggregate
            # ONLY: custom-start games legitimately reached the position and must
            # keep contributing to n/w/d/l below. Yields NULL when every game in
            # the group is custom-start — handled explicitly in
            # opening_insights_service._wrap_transition_row.
            func.min(pg_array([GamePosition.ply, GamePosition.game_id]))
            .filter(Game.initial_fen.is_(None))
            .label("sample_pair"),
            n_games.label("n"),
            wins.label("w"),
            draws.label("d"),
            losses.label("l"),
            func.max(Game.played_at).label("last_played_at"),
        )
        .join(Game, Game.id == GamePosition.game_id)
        .where(
            GamePosition.user_id == user_id,
            GamePosition.ply.between(
                OPENING_INSIGHTS_MIN_ENTRY_PLY,
                OPENING_INSIGHTS_MAX_ENTRY_PLY,
            ),
            GamePosition.move_san.isnot(None),
            Game.user_color == color,  # explicit per-color filter
        )
        .group_by(GamePosition.full_hash, GamePosition.move_san)
        .having(
            and_(
                n_games >= OPENING_INSIGHTS_MIN_GAMES_PER_CANDIDATE,
                or_(
                    score_expr <= weakness_threshold,
                    score_expr >= strength_threshold,
                ),
            )
        )
    )
    # color=None passed to apply_game_filters because per-color is already explicit above.
    stmt = apply_game_filters(
        stmt,
        time_control=time_control,
        platform=platform,
        rated=rated,
        opponent_type=opponent_type,
        from_date=from_date,
        to_date=to_date,
        color=None,
        opponent_gap_min=opponent_gap_min,
        opponent_gap_max=opponent_gap_max,
    )

    result = await session.execute(stmt)
    return list(result.all())


async def query_transition_prefixes(
    session: AsyncSession,
    user_id: int,
    samples: Sequence[tuple[int, int]],
) -> dict[tuple[int, int], list[str]]:
    """Batch-resolve SAN prefixes for a set of (sample_game_id, sample_ply) pairs.

    Returns {(game_id, ply): [san_0, san_1, ..., san_{ply-1}]} — the sequence of
    move_san values played BEFORE the entry position at the given ply. For ply=0
    samples the list is always [] (no preceding moves). Empty input returns {} immediately.

    Used by opening_insights_service._collect_attribution_hashes to reconstruct
    entry_san_sequence in Python after query_opening_transitions dropped the window
    function that previously computed it in SQL.
    """
    if not samples:
        return {}

    distinct_game_ids = list({gid for gid, _ in samples})
    max_ply = max(ply for _, ply in samples)

    # Fetch all move_san rows for the relevant games up to max_ply in one query.
    # ORDER BY (game_id, ply) ensures move_san values are appended in play order.
    stmt = (
        select(
            GamePosition.game_id,
            GamePosition.ply,
            GamePosition.move_san,
        )
        .where(
            GamePosition.user_id == user_id,
            GamePosition.game_id.in_(distinct_game_ids),
            GamePosition.ply < max_ply,
            GamePosition.move_san.isnot(None),
        )
        .order_by(GamePosition.game_id, GamePosition.ply)
    )
    db_rows = await session.execute(stmt)

    # Bucket (ply, move_san) by game_id so each sample can be sliced to its own depth.
    by_game: dict[int, list[tuple[int, str]]] = {}
    for row in db_rows:
        by_game.setdefault(row.game_id, []).append((row.ply, row.move_san))

    # For each (sample_game_id, sample_ply), return the prefix covering plies 0..ply-1.
    # ply=0 samples always get [] since there are no moves before ply 0.
    result: dict[tuple[int, int], list[str]] = {}
    for game_id, ply in samples:
        if ply == 0:
            result[(game_id, ply)] = []
            continue
        game_rows = by_game.get(game_id, [])
        # Keep only moves played strictly before the entry ply, in ply order.
        result[(game_id, ply)] = [san for row_ply, san in game_rows if row_ply < ply]

    return result


async def query_openings_by_hashes(
    session: AsyncSession,
    full_hashes: list[int],
) -> dict[int, Opening]:
    """Return {full_hash: deepest matching Opening} for each input hash.

    "Deepest" = MAX(ply_count) among rows whose Opening.full_hash matches.
    Hashes with no match are absent from the result dict (the service
    falls back to lineage walk per D-23).

    See CONTEXT.md D-22, RESEARCH.md Pitfall 6 (NULL full_hash filter).
    """
    if not full_hashes:
        return {}
    stmt = select(Opening).where(
        Opening.full_hash.is_not(None),
        Opening.full_hash.in_(full_hashes),
    )
    rows = await session.execute(stmt)
    by_hash: dict[int, Opening] = {}
    for opening in rows.scalars():
        if opening.full_hash is None:
            continue  # should be unreachable given SQL IS NOT NULL filter; guard for ty narrowing
        existing = by_hash.get(opening.full_hash)
        if existing is None or opening.ply_count > existing.ply_count:
            by_hash[opening.full_hash] = opening
    return by_hash
