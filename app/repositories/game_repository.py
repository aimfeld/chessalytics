"""Game repository: bulk insert with ON CONFLICT DO NOTHING and position insertion."""

import datetime
from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.game import Game
from app.models.game_position import GamePosition
from app.schemas.normalization import Color

# Explicit column list for asyncpg copy_records_to_table. Must be set-equal to
# {c.name for c in GamePosition.__table__.columns if c.name != "id"} — enforced
# by test_bulk_insert_positions_column_coverage. The ordering here is the
# functional contract: each row tuple is built by iterating over this tuple, so
# if a future column is added to GamePosition without updating this constant the
# CI test will fail and surfaced as a column-drift error before any data is written.
# IN-01 fix: promote the chunk size to a module-level constant so the test file
# can import it instead of duplicating the literal (`_CHUNK_SIZE = 1700` in
# tests/test_game_repository_bulk_insert_positions.py). Keeps the chunking
# boundary test honest if this value is ever tuned.
_POSITION_CHUNK_SIZE: int = 1700

POSITION_COPY_COLUMNS: tuple[str, ...] = (
    "game_id",
    "user_id",
    "ply",
    "full_hash",
    "white_hash",
    "black_hash",
    "move_san",
    "clock_seconds",
    "phase",
    "eval_cp",
    "eval_mate",
    "best_move",
    "pv",
    "endgame_class",
)


async def bulk_insert_games(session: AsyncSession, game_rows: list[dict]) -> list[int]:
    """Insert games, skipping duplicates. Returns list of newly inserted game IDs.

    Uses ON CONFLICT DO NOTHING on the unique constraint (user_id, platform, platform_game_id).
    Only returns IDs for rows that were actually inserted (not skipped).

    Args:
        session: AsyncSession to use for the insert.
        game_rows: List of dicts matching Game model columns.

    Returns:
        List of integer IDs for newly inserted games. Empty list if all are duplicates.
    """
    if not game_rows:
        return []

    stmt = (
        pg_insert(Game)
        .values(game_rows)
        .on_conflict_do_nothing(constraint="uq_games_user_platform_game_id")
        .returning(Game.id)
    )
    result = await session.execute(stmt)
    await session.flush()
    return [row[0] for row in result.fetchall()]


async def get_game_id_by_platform_game_id(
    session: AsyncSession,
    user_id: int,
    platform: str,
    platform_game_id: str,
) -> int | None:
    """Return the game id for (user_id, platform, platform_game_id), or None.

    Phase 167 (STORE-01/05): `_flush_batch` (bulk_insert_games's ON CONFLICT DO
    NOTHING path) returns only a *count* of newly inserted games, never an id —
    on EITHER the newly-inserted or the idempotent-duplicate path. This single
    lookup serves both: the caller always does one follow-up SELECT keyed on
    the uq_games_user_platform_game_id columns to get the id for the response
    and for the bot_game_settings insert (RESEARCH Pitfall 2).

    Args:
        session: AsyncSession to use.
        user_id: Internal user PK (scopes the lookup — never cross-user).
        platform: Platform string (e.g. "flawchess").
        platform_game_id: The platform-scoped game id (client UUID for bot games).

    Returns:
        The game's internal id, or None if no matching row exists.
    """
    result = await session.execute(
        select(Game.id).where(
            Game.user_id == user_id,
            Game.platform == platform,
            Game.platform_game_id == platform_game_id,
        )
    )
    return result.scalar_one_or_none()


async def get_pasted_game_by_identity(
    session: AsyncSession,
    *,
    user_id: int,
    platform_game_id: str,
) -> Game | None:
    """Return the caller's existing pasted-game row for a D-16 identity hash, or None.

    Phase 208 (D-17): the pre-insert identity lookup that makes a re-paste of
    the same game reuse its existing row instead of colliding on
    uq_games_user_platform_game_id. Scoped by BOTH user_id and platform_game_id
    (the hash) so ownership is enforced at the query level — two users pasting
    the same game never see each other's row.

    Args:
        session: AsyncSession to use.
        user_id: Internal user PK (scopes the lookup — never cross-user).
        platform_game_id: The D-16 SHA-256 identity hash.

    Returns:
        The matching Game row, or None if no pasted row exists for this
        (user_id, platform_game_id).
    """
    result = await session.execute(
        select(Game).where(
            Game.user_id == user_id,
            Game.platform == "pgn",
            Game.platform_game_id == platform_game_id,
        )
    )
    return result.scalar_one_or_none()


async def update_game_user_color(
    session: AsyncSession, *, game_id: int, user_id: int, user_color: Color
) -> None:
    """Update a game's user_color in place (Phase 208, D-18).

    Filtered on BOTH id and user_id so a caller can never repoint another
    user's row's orientation. Does NOT commit — the caller owns the
    transaction. Re-pasting the same game with the other side selected
    updates the existing row rather than inserting a second one; game_flaws
    stores both players' flaws regardless, so nothing needs recomputation —
    only which side reads as "yours" changes.

    Args:
        session: AsyncSession to use.
        game_id: The row's internal id.
        user_id: Internal user PK — the row must belong to this user.
        user_color: The new "white" | "black" value.
    """
    await session.execute(
        update(Game)
        .where(Game.id == game_id, Game.user_id == user_id)
        .values(user_color=user_color)
    )


async def update_bot_game_pgn_and_url(
    session: AsyncSession, game_id: int, pgn: str, platform_url: str
) -> None:
    """Write a stored bot game's `pgn` + `platform_url` (quick-260714-qaj / D-07).

    Both values embed the row's own auto-increment `games.id` (the PGN's
    `[Site]` header, and the column itself), which does not exist at
    `normalize_flawchess_game` time — so both are written in a single targeted
    UPDATE after the INSERT. They come from the same
    `bot_game_pgn.build_bot_game_url`, so they cannot diverge. Does NOT commit
    — the caller owns the transaction (D-10).

    Args:
        session: AsyncSession to use.
        game_id: The row's internal id (already scoped to the caller's user
            by the preceding lookup).
        pgn: The fully re-serialized PGN string to write.
        platform_url: The bot game's self-referential in-app URL.
    """
    await session.execute(
        update(Game).where(Game.id == game_id).values(pgn=pgn, platform_url=platform_url)
    )


async def count_games_for_user(session: AsyncSession, user_id: int) -> int:
    """Return total number of games imported by the given user."""
    result = await session.execute(
        select(func.count()).select_from(Game).where(Game.user_id == user_id)
    )
    return result.scalar_one()


async def count_pending_evals(session: AsyncSession, user_id: int) -> int:
    """Return count of games not yet Stockfish-evaluated for the given user."""
    result = await session.execute(
        select(func.count())
        .select_from(Game)
        .where(Game.user_id == user_id, Game.evals_completed_at.is_(None))
    )
    return result.scalar_one()


async def count_fully_analyzed_games(session: AsyncSession, user_id: int) -> int:
    """Return count of games FlawChess has fully analyzed (full_evals_completed_at SET).

    Badge numerator for GET /imports/eval-coverage. This is the SAME definition the
    per-game Library cards use for `analysis_state` ("analyzed" → no "Analyze"
    button): ``full_evals_completed_at IS NOT NULL`` (see
    library_repository._analyzed_game_ids_subquery). Keeping the badge and the cards
    on one column is the point — otherwise they disagree.

    Why NOT Game.is_analyzed (white_blunders IS NOT NULL): a lichess game imported
    with an embedded `analysis` block gets white_blunders populated at import time
    (normalization.py), so it satisfies is_analyzed instantly — before FlawChess's
    own full-eval drain has touched it. The card still (correctly) shows "Analyze",
    but the old is_analyzed-based badge counted it as analyzed, so the badge read
    "X of X" while unanalyzed cards were plainly visible (the bug this fixes).

    X-of-X reachability is preserved: a permanently-degenerate game (too short /
    coverage-capped) still gets full_evals_completed_at stamped by the drain, so it
    counts here as analyzed — matching its card, which shows no "Analyze" button.
    """
    result = await session.execute(
        select(func.count())
        .select_from(Game)
        .where(Game.user_id == user_id, Game.full_evals_completed_at.isnot(None))
    )
    return result.scalar_one()


async def users_with_zero_pending(
    session: AsyncSession,
    user_ids: Sequence[int],
) -> list[int]:
    """Return the subset of ``user_ids`` where:

    1. Pending-eval count is zero (no games with evals_completed_at IS NULL), AND
    2. No active (pending or in_progress) import_jobs row exists for the user.

    Both conditions must hold to fire Stage B (Plan 13 gap-closure). Without
    condition 2, Stage B fires multiple times during an active import as eval
    batches drain and the per-user pending-eval count flickers between zero and
    non-zero. Each re-fire produces a different intermediate value because the
    canonical-slice CTE input set has grown. User 28's achievable_score_gap was
    observed to flip between -0.0511 and +0.1204 in a 20-second window due to
    this re-fire pattern (documented in 94.1-13-PLAN.md gap_source).

    Issued as ONE aggregated SQL statement (WR-01 contract preserved). Construction:
    an inline VALUES table over ``user_ids``, WHERE NOT EXISTS (active import),
    LEFT JOIN'd to ``games`` on (uid = games.user_id AND
    games.evals_completed_at IS NULL), GROUP BY uid, HAVING count(games.id) = 0.

    Args:
        session: AsyncSession (read-only is fine).
        user_ids: Sequence of internal user PKs to check. Empty input
            short-circuits to ``[]`` without issuing any SQL (avoids a
            Postgres ``VALUES ()`` syntax error and an unnecessary round-trip).

    Returns:
        List of user_ids (subset of input) where both (eval drain done) AND
        (no active import) conditions hold. Order is unspecified.
        Empty list if no input users satisfy both conditions.
    """
    if not user_ids:
        return []

    from app.models.import_job import ImportJob

    uid_col = sa.column("uid", sa.Integer)
    uids_vt = sa.values(uid_col, name="input_uids").data([(int(u),) for u in user_ids])

    # Plan 13 Stage B gate: exclude users with an active (pending/in_progress) import.
    # Without this gate, Stage B fires during transient eval-drain states mid-import,
    # producing partial intermediate values visible on the chip (94.1-13-PLAN.md).
    active_import_exists = sa.exists(
        sa.select(sa.literal(1)).where(
            sa.and_(
                ImportJob.user_id == uid_col,
                ImportJob.status.in_(["pending", "in_progress"]),
            )
        )
    )

    # Inline values-table over the input user_ids. LEFT JOIN preserves users
    # who have no games at all (count(games.id) IS NULL → 0 via the outer agg).
    stmt = (
        sa.select(uid_col)
        .select_from(
            uids_vt.outerjoin(
                Game,
                sa.and_(
                    Game.user_id == uid_col,
                    Game.evals_completed_at.is_(None),
                ),
            )
        )
        .where(sa.not_(active_import_exists))
        .group_by(uid_col)
        .having(sa.func.count(Game.id) == 0)
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def delete_all_games_for_user(session: AsyncSession, user_id: int) -> int:
    """Delete all games and positions for the given user.

    Deletes game_positions first (child rows), then games. Returns the count of deleted games.

    Args:
        session: AsyncSession to use for the deletes.
        user_id: The user whose data should be deleted.

    Returns:
        Number of games deleted.
    """
    await session.execute(delete(GamePosition).where(GamePosition.user_id == user_id))
    result = await session.execute(delete(Game).where(Game.user_id == user_id).returning(Game.id))
    return len(result.fetchall())


async def update_bot_game_persona_id(session: AsyncSession, game_id: int, persona_id: str) -> None:
    """Write a stored bot game's `persona_id` (Phase 185, T-185-01).

    Mirrors update_bot_game_pgn_and_url's shape exactly — a single-column
    targeted UPDATE. Does NOT commit — the caller owns the transaction (D-10).
    Called only from the `if created:` branch of store_bot_game_service, so a
    duplicate resubmit never re-writes persona_id (D-11 idempotency).

    Args:
        session: AsyncSession to use.
        game_id: The row's internal id (already scoped to the caller's user
            by the preceding lookup).
        persona_id: The client-supplied persona identifier to persist.
    """
    await session.execute(update(Game).where(Game.id == game_id).values(persona_id=persona_id))


async def count_wins_by_persona(session: AsyncSession, user_id: int) -> dict[str, int]:
    """Return win counts grouped by persona_id for the given user (Phase 185, T-185-02).

    Excludes draws, losses, and rows where persona_id IS NULL (custom-mode
    games never earn a persona win). The `platform == "flawchess"` predicate
    is defense-in-depth (Open Question 2 in 185-RESEARCH.md) — persona_id is
    only ever set on flawchess-platform rows, but this guards against a future
    bug where persona_id might accidentally get set on a non-flawchess path.

    win_cond mirrors stats_repository.query_results_by_time_control's
    win_cond VERBATIM — do not redefine a third divergent copy of this logic
    (project has a history of color-parity bugs).

    Args:
        session: AsyncSession to use.
        user_id: Internal user PK, scoping the aggregation (never cross-user).

    Returns:
        Dict mapping persona_id -> win count. Personas with zero wins for
        this user are simply absent from the dict (not present as 0).
    """
    win_cond = or_(
        and_(Game.result == "1-0", Game.user_color == "white"),
        and_(Game.result == "0-1", Game.user_color == "black"),
    )
    win_count = func.count().filter(win_cond)
    result = await session.execute(
        select(Game.persona_id, win_count.label("wins"))
        .where(
            Game.user_id == user_id,
            Game.persona_id.is_not(None),
            Game.platform == "flawchess",
        )
        .group_by(Game.persona_id)
        # WR-01 fix: without this HAVING, a persona group with played-but-never-won
        # games still produced a ("persona_id", 0) row, contradicting the docstring
        # above ("zero-win personas are simply absent") — filter them out in SQL
        # rather than just correcting the prose, since the docstring's contract is
        # also what the response payload should uphold.
        .having(win_count > 0)
    )
    return {row[0]: row[1] for row in result.all()}


async def count_games_by_platform(session: AsyncSession, user_id: int) -> dict[str, int]:
    """Return game counts grouped by platform for the given user."""
    result = await session.execute(
        select(Game.platform, func.count())
        .select_from(Game)
        .where(Game.user_id == user_id)
        .group_by(Game.platform)
    )
    return {row[0]: row[1] for row in result.all()}


async def count_backlog_by_platform_and_tc(
    session: AsyncSession, user_id: int, anchor: datetime.datetime
) -> dict[str, dict[str, int]]:
    """Return {platform: {tc_bucket: count}} for the user's PRE-ANCHOR backlog.

    Phase 186 Plan 01 (IMPORT-04, D-01/D-02/D-15). `anchor` is `users.created_at`
    -- the per-user backlog boundary (D-02): games played AT/AFTER the anchor are
    always imported uncapped and never counted here. Derived aggregate over the
    existing `games` table -- no denormalized counter (186-RESEARCH.md Pattern 1,
    Don't-Hand-Roll). Used for the settings response's backlog-count chips (Plan
    03 UI) and, later, the backward walk's per-(platform, TC) stop condition.

    NULL-bucket games are omitted entirely from the result (D-15 -- they bypass
    the TC filter and count against no budget).

    Args:
        session: AsyncSession.
        user_id: Internal database user ID.
        anchor: users.created_at for this user.

    Returns:
        Dict keyed by platform, values are dicts keyed by TC bucket -> count.
        A platform/TC combination with zero pre-anchor games is simply absent,
        not present as 0.
    """
    result = await session.execute(
        select(Game.platform, Game.time_control_bucket, func.count())
        .select_from(Game)
        .where(Game.user_id == user_id, Game.played_at < anchor)
        .group_by(Game.platform, Game.time_control_bucket)
    )
    out: dict[str, dict[str, int]] = {}
    for platform, tc_bucket, count in result.all():
        if tc_bucket is None:
            continue  # D-15: NULL-bucket games count against no budget
        out.setdefault(platform, {})[tc_bucket] = count
    return out


async def count_imported_by_platform_and_tc(
    session: AsyncSession, user_id: int
) -> dict[str, dict[str, int]]:
    """Return {platform: {tc_bucket: count}} for ALL of the user's imported games.

    UAT follow-up to Phase 186 Plan 03: unlike
    ``count_backlog_by_platform_and_tc`` (which counts only the pre-anchor,
    cap-eligible backlog and drives the backward-walk stop condition), this is
    the true per-(platform, TC) distribution of everything the user has
    imported -- no `created_at` anchor filter. It backs the settings response's
    per-TC chips so those numbers read as an honest breakdown of the header's
    total game count, not a subset that silently omits post-signup games. The
    two functions are intentionally distinct: the display wants "what do I
    have", the import walk wants "what still counts against the cap".

    NULL-bucket games (untimed chess.com bot/coach games with no clock, D-15)
    are reported under the pseudo-bucket key "untimed" so the chips sum to the
    header's raw total. "untimed" is a display-only key — it is NOT a value of
    the time_control_bucket enum and never enters the TC filter or cap budgets.

    Args:
        session: AsyncSession.
        user_id: Internal database user ID.

    Returns:
        Dict keyed by platform, values are dicts keyed by TC bucket (or
        "untimed") -> count. A platform/TC combination with zero games is
        simply absent, not 0.
    """
    result = await session.execute(
        select(Game.platform, Game.time_control_bucket, func.count())
        .select_from(Game)
        .where(Game.user_id == user_id)
        .group_by(Game.platform, Game.time_control_bucket)
    )
    out: dict[str, dict[str, int]] = {}
    for platform, tc_bucket, count in result.all():
        out.setdefault(platform, {})[tc_bucket or "untimed"] = count
    return out


async def get_platform_game_ids_for_user(
    session: AsyncSession, user_id: int, platform: str
) -> frozenset[str]:
    """Return every `platform_game_id` already stored for (user_id, platform).

    Bug fix (CR-01, code-review 186): the backward-walk budget counter used to
    increment for every TC-matching game *fetched*, even ones the forward pass
    (or a prior sync) had already imported -- `bulk_insert_games`'s
    `ON CONFLICT DO NOTHING` silently no-ops those, but the fetch-time counter
    had no way to know that. Loading the full existing-id set once per backward
    pass (this query) lets the per-game counter (`_record_backward_game`) skip
    true duplicates in real time, which the D-07 stop-condition semantics
    require (the walk must react mid-fetch, not only after a batch flush).
    Served by the `uq_games_user_platform_game_id` unique index (user_id,
    platform, platform_game_id prefix), so this is a single indexed scan.

    Args:
        session: AsyncSession.
        user_id: Internal database user ID.
        platform: 'chess.com' or 'lichess'.

    Returns:
        Frozenset of platform_game_id strings already stored for this user+platform.
    """
    result = await session.execute(
        select(Game.platform_game_id).where(Game.user_id == user_id, Game.platform == platform)
    )
    return frozenset(row[0] for row in result.all())


async def bulk_insert_positions(session: AsyncSession, position_rows: list[dict]) -> None:
    """Bulk insert GamePosition rows via asyncpg's binary COPY protocol.

    Should only be called for game IDs returned by bulk_insert_games (new games only).
    No conflict handling — positions are only inserted for newly inserted games.

    Uses asyncpg's copy_records_to_table, which streams rows as a binary blob
    and runs with roughly constant per-backend Postgres parser/executor memory
    regardless of row count — unlike INSERT ... VALUES which materialises up to
    rows × columns bound parameters in Postgres memory.

    The COPY runs on the asyncpg Connection underlying the SQLAlchemy AsyncSession,
    so it participates in the session's active transaction. A session-level rollback
    after a successful COPY will undo the inserted rows.

    Chunking at _POSITION_CHUNK_SIZE (1700) is retained to bound peak Python-side list memory
    and to give asyncio a yield point between chunks. The 32k-bound-parameter
    ceiling of INSERT ... VALUES does not apply to COPY.

    Args:
        session: AsyncSession to use for the insert.
        position_rows: List of dicts with keys matching POSITION_COPY_COLUMNS.
                       Missing optional keys default to None.
    """
    if not position_rows:
        return

    sa_conn = await session.connection()
    raw_wrapper = await sa_conn.get_raw_connection()
    # driver_connection is the asyncpg.Connection inside SQLAlchemy's async wrapper.
    # It is always set after get_raw_connection() when using the asyncpg dialect.
    raw_conn = raw_wrapper.driver_connection
    # IN-03 fix: explicit runtime check (not `assert`) so the guard survives
    # `python -O` / `PYTHONOPTIMIZE=1`, which strips asserts. Under -O the
    # original `assert` would silently call `.copy_records_to_table` on None
    # and raise an unhelpful AttributeError. This branch should be unreachable
    # in practice (SQLAlchemy's asyncpg adapter always sets driver_connection
    # after get_raw_connection()), but if the adapter ever changes we get a
    # specific, debuggable error instead.
    if raw_conn is None:
        raise RuntimeError("asyncpg driver_connection is None — SQLAlchemy adapter changed")

    for i in range(0, len(position_rows), _POSITION_CHUNK_SIZE):
        chunk = position_rows[i : i + _POSITION_CHUNK_SIZE]
        records = [tuple(row.get(col) for col in POSITION_COPY_COLUMNS) for row in chunk]
        await raw_conn.copy_records_to_table(
            "game_positions",
            records=records,
            columns=POSITION_COPY_COLUMNS,
        )
    await session.flush()
