"""Repository for the Train tables: settings + session composition (Phase 189).

Phase 189 Plan 01 (POOL-01/POOL-04/POOL-07/POOL-10, D-01/D-02/D-06/D-07/D-08/D-09)
built the SR-only composition skeleton. Phase 189 Plan 04 Task 1 widened it to
the full POOL-07 75/25 mix with honest cross-backfill; Task 2 layers the
D-09/D-10/D-11/D-12 session lifecycle on top — resume, expiry, and lazy
eviction on resume.

V4 Information Disclosure mitigation: every function requires `user_id` as a
keyword-only argument. Callers MUST pass the authenticated user's ID (from
the FastAPI-Users `current_active_user` dependency); never accept `user_id`
as a query/path parameter from the client. Mirrors
`app/repositories/user_import_settings_repository.py`.
"""

from __future__ import annotations

import datetime
import random
from dataclasses import dataclass
from typing import Literal

import chess
from sqlalchemy import and_, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.drill_item import DrillItem, DrillStatus
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillGuess, DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.train_settings import TrainSettings
from app.services.best_move_candidates import mover_color_for_ply
from app.services.train_pool import (
    answer_key_present,
    blob_pending_stmt,
    classify_puzzle_type,
    compose_slots,
    full_fen_at_ply,
    herring_stmt,
    pool_entry_stmt,
)
from app.services.train_scheduler import (
    DEFAULT_PUZZLES_PER_SESSION,
    DEFAULT_TIMEZONE,
    DEFAULT_WEEKDAY_MASK,
    ItemState,
    apply_result,
    local_today,
    session_window,
)

# item_status wire literal <-> DrillStatus enum. Single mapping so the
# repository and its tests never re-derive this pairing independently.
_STATUS_LITERAL: dict[DrillStatus, Literal["active", "mastered", "parked"]] = {
    DrillStatus.ACTIVE: "active",
    DrillStatus.MASTERED: "mastered",
    DrillStatus.PARKED: "parked",
}


@dataclass(frozen=True)
class TrainSettingsRow:
    """Internal dataclass for a single train_settings row.

    Frozen (immutable) per CLAUDE.md internal-structured-data rule. Mirrors
    `app.repositories.user_import_settings_repository.ImportSettingsRow`.
    """

    timezone: str
    weekday_mask: int
    puzzles_per_session: int


@dataclass(frozen=True)
class ComposedPuzzle:
    """Internal dataclass for one puzzle within a composed/resumed session."""

    position: int
    game_id: int
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]


@dataclass(frozen=True)
class ComposedSession:
    """Internal dataclass returned by `compose_and_materialize_session`.

    `session_id` is `None` when nothing qualified and no `drill_sessions` row
    was written (the plan's explicit "return zero puzzles and write NO
    session row when nothing qualifies" contract) — `session_date` and
    `expires_on` remain populated in that case since they are pure functions
    of `(today, weekday_mask)` and cost nothing to compute regardless of
    whether a row was persisted.

    A caller seeing `puzzle_count < requested_count` must read
    `blob_pending_count` to distinguish a session that's short because
    opportunistic tier-4 analysis hasn't caught up yet from a genuinely
    exhausted pool (Pitfall 4) — see `app.schemas.train.TrainSessionResponse`
    for the wire-level contract this mirrors.
    """

    session_id: int | None
    session_date: datetime.date
    expires_on: datetime.date
    puzzle_count: int
    requested_count: int
    solved_count: int
    blob_pending_count: int
    puzzles: list[ComposedPuzzle]


async def get_settings(session: AsyncSession, *, user_id: int) -> TrainSettingsRow | None:
    """Return the user's train_settings row, or None if it does not exist yet.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
    """
    result = await session.execute(select(TrainSettings).where(TrainSettings.user_id == user_id))
    row = result.scalar_one_or_none()
    if row is None:
        return None
    return TrainSettingsRow(
        timezone=row.timezone,
        weekday_mask=row.weekday_mask,
        puzzles_per_session=row.puzzles_per_session,
    )


async def get_or_create_settings(session: AsyncSession, *, user_id: int) -> TrainSettingsRow:
    """Return the user's train_settings, creating a default row on first touch (D-07).

    Mirrors `user_import_settings_repository.get_or_create_settings`'s
    create-on-first-touch shape, using the D-06/D-07/D-08 defaults from
    `app.services.train_scheduler`.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
    """
    existing = await get_settings(session, user_id=user_id)
    if existing is not None:
        return existing
    stmt = pg_insert(TrainSettings).values(
        user_id=user_id,
        timezone=DEFAULT_TIMEZONE,
        weekday_mask=DEFAULT_WEEKDAY_MASK,
        puzzles_per_session=DEFAULT_PUZZLES_PER_SESSION,
    )
    # ON CONFLICT DO NOTHING: a concurrent first-touch may have already
    # inserted the row between the get_settings check above and this insert;
    # the row's values win either way since they're the same defaults.
    stmt = stmt.on_conflict_do_nothing(index_elements=["user_id"])
    await session.execute(stmt)
    return TrainSettingsRow(
        timezone=DEFAULT_TIMEZONE,
        weekday_mask=DEFAULT_WEEKDAY_MASK,
        puzzles_per_session=DEFAULT_PUZZLES_PER_SESSION,
    )


async def upsert_settings(
    session: AsyncSession,
    *,
    user_id: int,
    timezone: str,
    weekday_mask: int,
    puzzles_per_session: int,
) -> TrainSettingsRow:
    """Insert or update one user's `train_settings` row (PUT /train/settings).

    `INSERT ... ON CONFLICT (user_id) DO UPDATE`, mirroring
    `user_import_settings_repository.upsert_settings`'s atomic-idempotent
    shape. The caller (Pydantic `TrainSettingsUpdate`) has already validated
    `timezone` resolves via `zoneinfo.ZoneInfo` and that `weekday_mask`/
    `puzzles_per_session` are within the table's CHECK bounds — this function
    trusts that and does no re-validation.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        timezone: A validated IANA timezone string.
        weekday_mask: 7-bit scheduled-day mask, 0-127.
        puzzles_per_session: Requested session size, 1-50.
    """
    stmt = pg_insert(TrainSettings).values(
        user_id=user_id,
        timezone=timezone,
        weekday_mask=weekday_mask,
        puzzles_per_session=puzzles_per_session,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id"],
        set_={
            "timezone": stmt.excluded.timezone,
            "weekday_mask": stmt.excluded.weekday_mask,
            "puzzles_per_session": stmt.excluded.puzzles_per_session,
        },
    )
    await session.execute(stmt)
    return TrainSettingsRow(
        timezone=timezone, weekday_mask=weekday_mask, puzzles_per_session=puzzles_per_session
    )


async def expire_stale_sessions(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> None:
    """D-11: close out any of the user's open sessions whose window has elapsed.

    `UPDATE drill_sessions SET status='expired' WHERE user_id = :user_id AND
    status = 'open' AND expires_on <= :today`. Touches nothing else: recorded
    `drill_solves` results stay exactly as they are, and unsolved SR items
    keep their existing `due_date` on `drill_items` so they simply resurface
    most-overdue-first next time — no deletion, no leftover puzzle list
    carried forward.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The local calendar day to check expiry against (from
            `local_today`).
    """
    await session.execute(
        update(DrillSession)
        .where(
            DrillSession.user_id == user_id,
            DrillSession.status == "open",
            DrillSession.expires_on <= today,
        )
        .values(status="expired")
    )


async def open_session_for_user(session: AsyncSession, *, user_id: int) -> DrillSession | None:
    """Return the user's single `status='open'` `drill_sessions` row, or None.

    At most one row can match: `uq_drill_sessions_user_open` (a partial
    unique index on `user_id` WHERE `status = 'open'`) is the DB-level
    guarantee this query relies on.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
    """
    result = await session.execute(
        select(DrillSession).where(DrillSession.user_id == user_id, DrillSession.status == "open")
    )
    return result.scalar_one_or_none()


async def load_session_puzzles(
    session: AsyncSession, *, user_id: int, session_id: int
) -> list[ComposedPuzzle]:
    """Return the ordered, not-yet-attempted puzzles for a session (D-09/D-12 resume path).

    `drill_solves` rows with `solved_at IS NULL`, ordered by `position` (the
    frozen composition order), joined to `games` for the PGN and rebuilt into
    a `ComposedPuzzle` via `full_fen_at_ply`. Scoped by `user_id` in the WHERE
    clause IN ADDITION to `session_id` — a session id arriving from a request
    body/path parameter is untrusted client input (T-189-12 / V4 IDOR guard);
    a foreign session id resolves to zero rows rather than another user's
    puzzles.

    Rows whose backing `game_flaws` row has since vanished under
    reclassification (SR source only — herrings carry no such row) are
    skipped rather than served or deleted (lazy eviction, D-02), and so are
    rows whose FEN will not reconstruct. The session's frozen `puzzle_count`
    is returned UNCHANGED by this function — callers must not derive it from
    `len(puzzles)` here, so `solved_count + len(puzzles)` may legitimately be
    less than `puzzle_count` after an eviction.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        session_id: The `drill_sessions.id` to load remaining puzzles for.
    """
    stmt = (
        select(DrillSolve, Game)
        .join(Game, Game.id == DrillSolve.game_id)
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.user_id == user_id,
            DrillSolve.solved_at.is_(None),
        )
        .order_by(DrillSolve.position.asc())
    )
    rows = (await session.execute(stmt)).all()
    if not rows:
        return []

    sr_game_ids = {solve.game_id for solve, _game in rows if solve.source == DrillSource.SR_ITEM}
    existing_flaw_keys: set[tuple[int, int]] = set()
    if sr_game_ids:
        flaw_rows = await session.execute(
            select(GameFlaw.game_id, GameFlaw.ply).where(
                GameFlaw.user_id == user_id, GameFlaw.game_id.in_(sr_game_ids)
            )
        )
        existing_flaw_keys = {(gid, ply) for gid, ply in flaw_rows.all()}

    puzzles: list[ComposedPuzzle] = []
    for solve, game in rows:
        if (
            solve.source == DrillSource.SR_ITEM
            and (solve.game_id, solve.ply) not in existing_flaw_keys
        ):
            continue  # lazy eviction: the backing flaw row vanished (D-02)
        fen = full_fen_at_ply(game.pgn, solve.ply)
        if fen is None:
            continue  # never serve a puzzle whose FEN can't reconstruct
        puzzles.append(
            ComposedPuzzle(
                position=solve.position,
                game_id=solve.game_id,
                ply=solve.ply,
                fen=fen,
                side_to_move=mover_color_for_ply(solve.ply),
            )
        )
    return puzzles


async def _resume_open_session(
    session: AsyncSession,
    *,
    user_id: int,
    drill_session: DrillSession,
    requested_count: int,
    blob_pending_count: int,
) -> ComposedSession:
    """Build a `ComposedSession` for an already-open session (D-12 resume path)."""
    puzzles = await load_session_puzzles(session, user_id=user_id, session_id=drill_session.id)
    solved_count_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .where(DrillSolve.session_id == drill_session.id, DrillSolve.solved_at.isnot(None))
    )
    solved_count = (await session.execute(solved_count_stmt)).scalar_one()
    return ComposedSession(
        session_id=drill_session.id,
        session_date=drill_session.session_date,
        expires_on=drill_session.expires_on,
        puzzle_count=drill_session.puzzle_count,
        requested_count=requested_count,
        solved_count=solved_count,
        blob_pending_count=blob_pending_count,
        puzzles=puzzles,
    )


async def compose_and_materialize_session(
    session: AsyncSession, *, user_id: int, now_utc: datetime.datetime
) -> ComposedSession:
    """Compose or resume a Train session at the full POOL-07 75/25 mix.

    1. Resolve `train_settings` (create-on-first-touch), today's local date,
       and the `(sr_slots, herring_slots)` split (`compose_slots`).
    2. D-11: `expire_stale_sessions` closes out a stale open session before
       anything else runs.
    3. D-12: if an open session still exists after expiry, RESUME it
       (`load_session_puzzles`) rather than composing a new one — this is the
       only path taken on a second call inside an open session's window,
       including an ad-hoc "train now" request from a future phase that hits
       this same endpoint.
    4. Otherwise compose fresh: due `drill_items` (most-overdue-first) padded
       from `pool_entry_stmt` up to `sr_slots`, plus `herring_stmt` up to
       `herring_slots` (retried with `exclude_served=False` when the source
       is exhausted). Cross-backfill (Pitfall 4): if one side comes up short,
       the OTHER side fills the gap up to `n`, so a lopsided pool still
       yields a full session whenever enough total material exists.
    5. Reconstruct each puzzle's full FEN via `full_fen_at_ply`; a puzzle
       whose FEN cannot be reconstructed is dropped rather than served
       broken (never backfilled — the slot arithmetic already ran).
    6. If nothing survives, return zero puzzles and write NO `drill_sessions`
       row. Otherwise shuffle deterministically by `(user_id, today)` (D-09:
       a red herring's position must not be inferable from ordering) and
       materialize the session header plus one pre-inserted `DrillSolve` per
       puzzle.
    7. The `DrillSession` insert (plus any new `drill_items` padding rows) is
       wrapped in a SAVEPOINT (`session.begin_nested()`). A concurrent second
       composition winning the `uq_drill_sessions_user_open` race — or
       colliding on a `drill_items` primary key from the same simultaneous
       padding scan — raises `IntegrityError`; that partial unique index is
       the authority for "at most one open session per user" (T-189-14), so
       the loser resumes the winner's session instead of erroring.

    Sequential awaits only — never `asyncio.gather` on this `AsyncSession`
    (CLAUDE.md: AsyncSession is not safe for concurrent use).

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        now_utc: The current UTC instant (D-06: converted to a local date via
            `local_today` using the user's stored timezone).
    """
    settings_row = await get_or_create_settings(session, user_id=user_id)
    n = settings_row.puzzles_per_session
    today = local_today(settings_row.timezone, now_utc)

    await expire_stale_sessions(session, user_id=user_id, today=today)

    blob_pending_count = (await session.execute(blob_pending_stmt(user_id))).scalar_one()

    open_session = await open_session_for_user(session, user_id=user_id)
    if open_session is not None:
        return await _resume_open_session(
            session,
            user_id=user_id,
            drill_session=open_session,
            requested_count=n,
            blob_pending_count=blob_pending_count,
        )

    sr_slots, herring_slots = compose_slots(n)

    # --- SR side: due drill_items first, most-overdue-first ---
    due_stmt = (
        select(DrillItem, Game)
        .join(Game, Game.id == DrillItem.game_id)
        .join(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillItem.user_id,
                GameFlaw.game_id == DrillItem.game_id,
                GameFlaw.ply == DrillItem.ply,
            ),
            isouter=True,
        )
        .where(
            DrillItem.user_id == user_id,
            DrillItem.status == DrillStatus.ACTIVE,
            DrillItem.due_date <= today,
            GameFlaw.ply.isnot(None),  # lazy eviction: flaw row still exists (D-02)
            # 189-REVIEW.md WR-04 / 189-06: the flaw row can survive a
            # reclassify with its blob reset to NULL or rewritten as the D-06
            # empty-array sentinel; without this clause an already-tracked
            # item is re-served with a degenerate answer key that
            # classify_puzzle_type silently degrades to "soft" — the entry
            # gate (pool_entry_stmt) and this re-serve scan must apply the
            # same answer-key standard. Such an item is skipped for this
            # session but stays ACTIVE/due (lazy eviction, same as a missing
            # flaw row above), so it resurfaces automatically if a later
            # re-analysis restores a real blob — no deletion or status
            # change is introduced here.
            answer_key_present(GameFlaw.missed_pv_lines),
        )
        .order_by(DrillItem.due_date.asc(), DrillItem.game_id.asc(), DrillItem.ply.asc())
        .limit(sr_slots)
    )
    due_rows = (await session.execute(due_stmt)).all()
    sr_candidates: list[tuple[int, int, Game]] = [
        (drill_item.game_id, drill_item.ply, game) for drill_item, game in due_rows
    ]

    # --- SR padding pool: fresh qualifying flaws not yet tracked as drill_items ---
    existing_pairs_result = await session.execute(
        select(DrillItem.game_id, DrillItem.ply).where(DrillItem.user_id == user_id)
    )
    existing_pairs = {(gid, ply) for gid, ply in existing_pairs_result.all()}

    pool_stmt = pool_entry_stmt(user_id).order_by(
        Game.played_at.desc().nulls_last(), GameFlaw.game_id.desc(), GameFlaw.ply.asc()
    )
    pool_rows = (await session.execute(pool_stmt)).all()
    sr_pool: list[tuple[int, int, Game]] = []
    for flaw, game in pool_rows:
        key = (flaw.game_id, flaw.ply)
        if key in existing_pairs:
            continue
        sr_pool.append((flaw.game_id, flaw.ply, game))
        existing_pairs.add(key)

    # pool-sourced picks that need a brand-new drill_items row (never the
    # already-tracked due items above).
    new_sr_items: list[tuple[int, int, Game]] = []
    pool_idx = 0
    sr_needed = sr_slots - len(sr_candidates)
    while sr_needed > 0 and pool_idx < len(sr_pool):
        pick = sr_pool[pool_idx]
        pool_idx += 1
        sr_candidates.append(pick)
        new_sr_items.append(pick)
        sr_needed -= 1

    # --- Herring side ---
    herring_rows = (
        await session.execute(herring_stmt(user_id, exclude_served=True).limit(n))
    ).all()
    if not herring_rows:
        # Source exhausted (every candidate already served this user) — repeats allowed.
        herring_rows = (
            await session.execute(herring_stmt(user_id, exclude_served=False).limit(n))
        ).all()
    herring_pool: list[tuple[int, int, Game]] = [
        (best_move.game_id, best_move.ply, game) for best_move, game in herring_rows
    ]
    herring_candidates = herring_pool[:herring_slots]
    herring_idx = herring_slots

    # --- Cross-backfill (Pitfall 4): a short side never silently shrinks the
    # session while the OTHER side has spare material. ---
    shortfall = n - (len(sr_candidates) + len(herring_candidates))
    if shortfall > 0:
        if len(sr_candidates) < sr_slots:
            # SR side came up short -> pull extra herrings, continuing the same
            # deterministic herring_stmt ordering from where herring_slots left off.
            herring_candidates = (
                herring_candidates + herring_pool[herring_idx : herring_idx + shortfall]
            )
        elif len(herring_candidates) < herring_slots:
            # Herring side came up short -> pull extra SR, continuing the same
            # pool_entry_stmt scan from where sr_slots left off.
            while shortfall > 0 and pool_idx < len(sr_pool):
                pick = sr_pool[pool_idx]
                pool_idx += 1
                sr_candidates.append(pick)
                new_sr_items.append(pick)
                shortfall -= 1

    # --- Reconstruct FENs, dropping (never backfilling) unparseable puzzles ---
    reconstructed: list[tuple[int, int, str, Literal["white", "black"], int]] = []
    for game_id, ply, game in sr_candidates:
        fen = full_fen_at_ply(game.pgn, ply)
        if fen is None:
            continue
        reconstructed.append((game_id, ply, fen, mover_color_for_ply(ply), DrillSource.SR_ITEM))
    for game_id, ply, game in herring_candidates:
        fen = full_fen_at_ply(game.pgn, ply)
        if fen is None:
            continue
        reconstructed.append((game_id, ply, fen, mover_color_for_ply(ply), DrillSource.RED_HERRING))
    reconstructed = reconstructed[:n]  # defensive cap; slot arithmetic already sums to <= n

    if not reconstructed:
        return ComposedSession(
            session_id=None,
            session_date=today,
            expires_on=session_window(today, settings_row.weekday_mask),
            puzzle_count=0,
            requested_count=n,
            solved_count=0,
            blob_pending_count=blob_pending_count,
            puzzles=[],
        )

    # D-09: deterministic (user_id, session_date)-seeded shuffle so a red
    # herring's slot is never inferable from a fixed SR-then-herring layout,
    # and re-composition (e.g. this same call) is reproducible.
    random.Random(f"{user_id}:{today.isoformat()}").shuffle(reconstructed)

    surviving_sr_keys = {
        (gid, ply)
        for gid, ply, _fen, _side, source in reconstructed
        if source == DrillSource.SR_ITEM
    }

    try:
        async with session.begin_nested():
            for gid, ply, _game in new_sr_items:
                if (gid, ply) not in surviving_sr_keys:
                    continue  # dropped for a broken FEN — never track a puzzle we can't serve
                session.add(
                    DrillItem(
                        user_id=user_id,
                        game_id=gid,
                        ply=ply,
                        status=DrillStatus.ACTIVE,
                        streak=0,
                        due_date=today,
                        fail_count=0,
                        ever_correct=False,
                    )
                )

            drill_session = DrillSession(
                user_id=user_id,
                session_date=today,
                status="open",
                puzzle_count=len(reconstructed),
                expires_on=session_window(today, settings_row.weekday_mask),
            )
            session.add(drill_session)
            # Populate drill_session.id for the DrillSolve FK below, and
            # surface uq_drill_sessions_user_open here if a concurrent
            # request already won the race.
            await session.flush()

            puzzles: list[ComposedPuzzle] = []
            for position, (game_id, ply, fen, side_to_move, source) in enumerate(reconstructed):
                session.add(
                    DrillSolve(
                        session_id=drill_session.id,
                        position=position,
                        user_id=user_id,
                        game_id=game_id,
                        ply=ply,
                        source=source,
                        solved_at=None,
                    )
                )
                puzzles.append(
                    ComposedPuzzle(
                        position=position,
                        game_id=game_id,
                        ply=ply,
                        fen=fen,
                        side_to_move=side_to_move,
                    )
                )
            await session.flush()
    except IntegrityError:
        # uq_drill_sessions_user_open (the partial unique index enforcing
        # D-12's at-most-one-open-session invariant) is the authority here —
        # a concurrent request won the race, or a simultaneous padding scan
        # collided on a drill_items primary key from the same underlying
        # race. Resume the winner's session instead of surfacing a 500
        # (T-189-14).
        resumed = await open_session_for_user(session, user_id=user_id)
        if resumed is None:
            raise
        return await _resume_open_session(
            session,
            user_id=user_id,
            drill_session=resumed,
            requested_count=n,
            blob_pending_count=blob_pending_count,
        )

    return ComposedSession(
        session_id=drill_session.id,
        session_date=drill_session.session_date,
        expires_on=drill_session.expires_on,
        puzzle_count=len(puzzles),
        requested_count=n,
        solved_count=0,
        blob_pending_count=blob_pending_count,
        puzzles=puzzles,
    )


# ---------------------------------------------------------------------------
# Solve (POOL-08, Plan 05 Task 1)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RecordedSolve:
    """Internal dataclass returned by `record_solve`."""

    correct_guess: bool
    correct_move: bool
    puzzle_type: Literal["sharp", "soft", "herring"]
    item_status: Literal["active", "mastered", "parked"] | None
    streak: int | None
    due_date: datetime.date | None
    session_complete: bool


async def _classify_solve_puzzle_type(
    session: AsyncSession, *, solve: DrillSolve
) -> Literal["sharp", "soft", "herring"]:
    """Server-side puzzle-type classification at solve/reveal time (D-01).

    A red herring is always `"herring"` (no `game_flaws` row exists for it).
    An SR-source row reads the LIVE `game_flaws.missed_pv_lines` blob — never
    a snapshot — so a reclassified-away flaw naturally falls through
    `classify_puzzle_type`'s None-blob default of `"soft"` rather than
    failing the solve.
    """
    if solve.source == DrillSource.RED_HERRING:
        return "herring"
    flaw_row = (
        await session.execute(
            select(GameFlaw)
            .options(undefer(GameFlaw.missed_pv_lines))
            .where(
                GameFlaw.user_id == solve.user_id,
                GameFlaw.game_id == solve.game_id,
                GameFlaw.ply == solve.ply,
            )
        )
    ).scalar_one_or_none()
    missed_pv_lines = flaw_row.missed_pv_lines if flaw_row is not None else None
    return classify_puzzle_type(missed_pv_lines, mover_color_for_ply(solve.ply))


def _compute_correct_guess(
    guess: Literal["critical", "several"], puzzle_type: Literal["sharp", "soft", "herring"]
) -> bool:
    """P-02: grade the metacognition guess against the server-computed puzzle type.

    "critical" is correct only for a sharp puzzle; "several" is correct for
    both "soft" (avoid-the-blunder) and "herring" (several fine moves) —
    those two share the same correct answer to this guess.
    """
    if puzzle_type == "sharp":
        return guess == "critical"
    return guess == "several"


async def _advance_drill_item(
    session: AsyncSession,
    *,
    user_id: int,
    game_id: int,
    ply: int,
    correct_move: bool,
    now_utc: datetime.datetime,
) -> tuple[Literal["active", "mastered", "parked"], int, datetime.date]:
    """Advance one `drill_items` row's SR state after a claimed SR-source solve.

    Loads the current `TrainSettingsRow` (create-on-first-touch — a session
    could not have been composed without one, but this stays defensive),
    converts `now_utc` to the user's local session day, and delegates the
    actual state transition to the pure `apply_result` (POOL-04/05/06).
    """
    settings_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(settings_row.timezone, now_utc)
    item_row = (
        await session.execute(
            select(DrillItem).where(
                DrillItem.user_id == user_id,
                DrillItem.game_id == game_id,
                DrillItem.ply == ply,
            )
        )
    ).scalar_one()
    state = ItemState(
        status=DrillStatus(item_row.status),
        streak=item_row.streak,
        due_date=item_row.due_date,
        fail_count=item_row.fail_count,
        ever_correct=item_row.ever_correct,
    )
    new_state = apply_result(
        state, correct_move=correct_move, today=today, weekday_mask=settings_row.weekday_mask
    )
    await session.execute(
        update(DrillItem)
        .where(DrillItem.user_id == user_id, DrillItem.game_id == game_id, DrillItem.ply == ply)
        .values(
            status=int(new_state.status),
            streak=new_state.streak,
            due_date=new_state.due_date,
            fail_count=new_state.fail_count,
            ever_correct=new_state.ever_correct,
        )
    )
    return _STATUS_LITERAL[new_state.status], new_state.streak, new_state.due_date


async def _read_drill_item_state(
    session: AsyncSession, *, user_id: int, game_id: int, ply: int
) -> tuple[Literal["active", "mastered", "parked"], int, datetime.date] | None:
    """Read a `drill_items` row's current (item_status, streak, due_date), or None."""
    item_row = (
        await session.execute(
            select(DrillItem).where(
                DrillItem.user_id == user_id,
                DrillItem.game_id == game_id,
                DrillItem.ply == ply,
            )
        )
    ).scalar_one_or_none()
    if item_row is None:
        return None
    return _STATUS_LITERAL[DrillStatus(item_row.status)], item_row.streak, item_row.due_date


async def _mark_session_complete_if_done(
    session: AsyncSession, *, session_id: int, now_utc: datetime.datetime
) -> bool:
    """Complete the session once every still-servable puzzle has been recorded.

    "Still servable" excludes `drill_solves` rows whose `games` row has since
    vanished (mirrors `load_session_puzzles`'s lazy-eviction posture — a
    deleted game can never be attempted, so it must not block completion).
    The `status = 'open'` guard makes the UPDATE a no-op on a session that's
    already completed, so re-running this after an idempotent re-submit never
    stomps a real `completed_at` with a later timestamp.
    """
    remaining_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .join(Game, Game.id == DrillSolve.game_id)
        .where(DrillSolve.session_id == session_id, DrillSolve.solved_at.is_(None))
    )
    remaining = (await session.execute(remaining_stmt)).scalar_one()
    if remaining == 0:
        await session.execute(
            update(DrillSession)
            .where(DrillSession.id == session_id, DrillSession.status == "open")
            .values(status="completed", completed_at=now_utc)
        )
    return remaining == 0


async def record_solve(
    session: AsyncSession,
    *,
    user_id: int,
    session_id: int,
    position: int,
    guess: Literal["critical", "several"],
    played_move: str,
    correct_move: bool,
    now_utc: datetime.datetime,
) -> RecordedSolve | None:
    """Record one puzzle's outcome and advance the interval ladder (POOL-08).

    1. Resolve the `drill_solves` row by `(session_id, position)`, scoped by
       `user_id` in the WHERE clause (T-189-16 / IDOR guard) — a foreign or
       invented `session_id` resolves to nothing, so this returns None and
       the router raises 404.
    2. Compute `correct_guess` server-side from the LIVE blob
       (`_classify_solve_puzzle_type`) — the client can never assert either
       verdict it does not own (P-02).
    3. Claim the row with a conditional UPDATE carrying `solved_at IS NULL`
       in its WHERE clause. This is the WHOLE concurrency guarantee
       (T-189-19): under READ COMMITTED, a second concurrent UPDATE blocks on
       the row lock, then re-evaluates its WHERE clause against the first
       transaction's now-committed row once unblocked — so at most one
       transaction ever claims a zero-to-nonzero `solved_at` transition.
       When the claim affects zero rows, the puzzle was already recorded:
       re-read the stored outcome and skip `apply_result` entirely — no
       second ladder advance.
    4. For an SR-source row ONLY, advance `drill_items` via `apply_result`
       (`_advance_drill_item` on a win, `_read_drill_item_state` on a loss —
       either way returning the CURRENT state, never a stale pre-solve one).
       A red-herring row touches no `drill_items` row (POOL-08).
    5. Recompute session completion (`_mark_session_complete_if_done`) after
       every call, win or lose — idempotent via the `status = 'open'` guard.

    Sequential awaits only — never `asyncio.gather` on this `AsyncSession`.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        session_id: The `drill_sessions.id` the puzzle belongs to (untrusted
            client input — resolved only in combination with `user_id`).
        position: The puzzle's frozen 0-based order within the session.
        guess: The user's pre-attempt "critical vs several fine" guess.
        played_move: The move the user actually played (UCI).
        correct_move: Whether the played move matched the puzzle's answer —
            asserted by the client (T-189-18, accepted per SEED-037).
        now_utc: The current UTC instant.

    Returns:
        `RecordedSolve`, or None when no `(session_id, position)` row exists
        for this `user_id` (the router maps this to 404).
    """
    solve_row = (
        await session.execute(
            select(DrillSolve).where(
                DrillSolve.session_id == session_id,
                DrillSolve.position == position,
                DrillSolve.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if solve_row is None:
        return None

    puzzle_type = await _classify_solve_puzzle_type(session, solve=solve_row)
    correct_guess = _compute_correct_guess(guess, puzzle_type)
    guess_int = int(DrillGuess.CRITICAL if guess == "critical" else DrillGuess.SEVERAL)

    claim_result = await session.execute(
        update(DrillSolve)
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.position == position,
            DrillSolve.user_id == user_id,
            DrillSolve.solved_at.is_(None),
        )
        .values(
            guess=guess_int,
            played_move=played_move,
            correct_move=correct_move,
            correct_guess=correct_guess,
            solved_at=now_utc,
        )
    )
    claimed = claim_result.rowcount == 1  # ty: ignore[unresolved-attribute]  # SQLAlchemy DML result carries rowcount

    item_status: Literal["active", "mastered", "parked"] | None = None
    streak: int | None = None
    due_date: datetime.date | None = None
    is_sr = solve_row.source == DrillSource.SR_ITEM

    if claimed:
        stored_correct_guess, stored_correct_move = correct_guess, correct_move
        if is_sr:
            item_status, streak, due_date = await _advance_drill_item(
                session,
                user_id=user_id,
                game_id=solve_row.game_id,
                ply=solve_row.ply,
                correct_move=correct_move,
                now_utc=now_utc,
            )
    else:
        # Lost the claim race (or this is a plain re-submit): the FIRST
        # recorded outcome wins — re-read it rather than trusting this call's
        # (possibly different) guess/correct_move arguments.
        stored = (
            await session.execute(
                select(DrillSolve.correct_guess, DrillSolve.correct_move).where(
                    DrillSolve.session_id == session_id,
                    DrillSolve.position == position,
                    DrillSolve.user_id == user_id,
                )
            )
        ).one()
        stored_correct_guess = bool(stored.correct_guess)
        stored_correct_move = bool(stored.correct_move)
        if is_sr:
            item_state = await _read_drill_item_state(
                session, user_id=user_id, game_id=solve_row.game_id, ply=solve_row.ply
            )
            if item_state is not None:
                item_status, streak, due_date = item_state

    session_complete = await _mark_session_complete_if_done(
        session, session_id=session_id, now_utc=now_utc
    )

    return RecordedSolve(
        correct_guess=stored_correct_guess,
        correct_move=stored_correct_move,
        puzzle_type=puzzle_type,
        item_status=item_status,
        streak=streak,
        due_date=due_date,
        session_complete=session_complete,
    )


# ---------------------------------------------------------------------------
# Reveal (POOL-10, Plan 05 Task 2)
# ---------------------------------------------------------------------------

# Sentinel strings the router maps to 404/409 — kept distinct from a real
# RevealedPuzzle so a caller can never mistake one for the other.
RevealNotFound = Literal["not_found"]
RevealNotAttempted = Literal["not_attempted"]


@dataclass(frozen=True)
class RevealedPuzzle:
    """Internal dataclass returned by `reveal_for_puzzle` on a solved puzzle."""

    game_id: int
    ply: int
    fen: str
    best_move: str | None
    best_move_san: str | None
    played_in_game_san: str | None
    puzzle_type: Literal["sharp", "soft", "herring"]
    source: Literal["sr_item", "red_herring"]
    has_tactic_lines: bool


async def reveal_for_puzzle(
    session: AsyncSession, *, user_id: int, session_id: int, position: int
) -> RevealedPuzzle | RevealNotFound | RevealNotAttempted:
    """Return the post-attempt answer key for one puzzle (POOL-10 reveal gate).

    Resolves the `drill_solves` row scoped by `user_id` AND `session_id`
    (T-189-16 / IDOR guard) — a foreign or invented `(session_id, position)`
    returns `"not_found"`. `solved_at IS NULL` returns `"not_attempted"`
    (T-189-17): the answer key, puzzle type, and in-game move are
    unreachable before the attempt is recorded.

    `has_tactic_lines` is a pointer, not a payload — the client fetches the
    steppable PV line from the pre-existing
    `GET /api/library/flaws/{game_id}/{ply}/tactic-lines` endpoint; this
    function does not re-derive any PV-to-SAN walk.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        session_id: The `drill_sessions.id` the puzzle belongs to.
        position: The puzzle's frozen 0-based order within the session.
    """
    row = (
        await session.execute(
            select(DrillSolve, Game)
            .join(Game, Game.id == DrillSolve.game_id)
            .where(
                DrillSolve.session_id == session_id,
                DrillSolve.position == position,
                DrillSolve.user_id == user_id,
            )
        )
    ).one_or_none()
    if row is None:
        return "not_found"
    solve, game = row
    if solve.solved_at is None:
        return "not_attempted"

    position_row = (
        await session.execute(
            select(GamePosition.best_move, GamePosition.move_san).where(
                GamePosition.user_id == user_id,
                GamePosition.game_id == solve.game_id,
                GamePosition.ply == solve.ply,
            )
        )
    ).one_or_none()
    best_move = position_row.best_move if position_row is not None else None
    played_in_game_san = position_row.move_san if position_row is not None else None

    # P-03: game_flaws.fen is board_fen() only (no castling/en-passant) —
    # reconstruct the full FEN the same way composition did.
    fen = full_fen_at_ply(game.pgn, solve.ply) or ""

    best_move_san: str | None = None
    if fen and best_move is not None:
        try:
            board = chess.Board(fen)
            best_move_san = board.san(chess.Move.from_uci(best_move))
        except (ValueError, chess.IllegalMoveError, AssertionError):
            best_move_san = None  # never raise on an unparseable best_move (Task 2 contract)

    if solve.source == DrillSource.RED_HERRING:
        puzzle_type: Literal["sharp", "soft", "herring"] = "herring"
        has_tactic_lines = False
    else:
        flaw_row = (
            await session.execute(
                select(GameFlaw)
                .options(undefer(GameFlaw.missed_pv_lines))
                .where(
                    GameFlaw.user_id == user_id,
                    GameFlaw.game_id == solve.game_id,
                    GameFlaw.ply == solve.ply,
                )
            )
        ).scalar_one_or_none()
        missed_pv_lines = flaw_row.missed_pv_lines if flaw_row is not None else None
        puzzle_type = classify_puzzle_type(missed_pv_lines, mover_color_for_ply(solve.ply))
        has_tactic_lines = flaw_row is not None and (
            flaw_row.missed_tactic_motif is not None or flaw_row.allowed_tactic_motif is not None
        )

    return RevealedPuzzle(
        game_id=solve.game_id,
        ply=solve.ply,
        fen=fen,
        best_move=best_move,
        best_move_san=best_move_san,
        played_in_game_san=played_in_game_san,
        puzzle_type=puzzle_type,
        source="sr_item" if solve.source == DrillSource.SR_ITEM else "red_herring",
        has_tactic_lines=has_tactic_lines,
    )


__all__ = [
    "ComposedPuzzle",
    "ComposedSession",
    "RecordedSolve",
    "RevealedPuzzle",
    "TrainSettingsRow",
    "compose_and_materialize_session",
    "expire_stale_sessions",
    "get_or_create_settings",
    "get_settings",
    "load_session_puzzles",
    "open_session_for_user",
    "record_solve",
    "reveal_for_puzzle",
    "upsert_settings",
]
