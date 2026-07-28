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
from collections import Counter
from dataclasses import dataclass
from typing import Literal, cast

import chess
from sqlalchemy import and_, delete, exists, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models.drill_item import DrillItem, DrillStatus
from app.models.drill_session import DrillSession
from app.models.drill_solve import DrillGuess, DrillMoveQuality, DrillSolve, DrillSource
from app.models.game import Game
from app.models.game_flaw import GameFlaw
from app.models.game_position import GamePosition
from app.models.herring_pool import HerringPool
from app.models.train_settings import TrainSettings
from app.services.best_move_candidates import mover_color_for_ply
from app.services.train_pool import (
    MAX_ITEMS_PER_GAME_PER_SESSION,
    answer_key_present,
    blob_pending_stmt,
    classify_puzzle_type,
    compose_slots,
    fen_and_last_move_at_ply,
    full_fen_at_ply,
    herring_stmt,
    pick_one_per_game,
    pool_entry_stmt,
)
from app.services.train_scheduler import (
    DEFAULT_PUZZLES_PER_SESSION,
    DEFAULT_TIMEZONE,
    DEFAULT_WEEKDAY_MASK,
    DayOutcome,
    ItemState,
    TickSnapshot,
    TickView,
    _judge_one_day,
    apply_result,
    is_scheduled_day,
    is_session_expired,
    local_today,
    scheduled_days_per_week,
    session_window,
    tick_days,
)

# item_status wire literal <-> DrillStatus enum. Single mapping so the
# repository and its tests never re-derive this pairing independently.
_STATUS_LITERAL: dict[DrillStatus, Literal["active", "mastered", "parked"]] = {
    DrillStatus.ACTIVE: "active",
    DrillStatus.MASTERED: "mastered",
    DrillStatus.PARKED: "parked",
}

# move_quality wire literal <-> DrillMoveQuality enum (SEED-119). Bidirectional
# so the repository never re-derives either direction independently.
_MOVE_QUALITY_LITERAL: dict[DrillMoveQuality, Literal["good", "inaccuracy", "wrong"]] = {
    DrillMoveQuality.GOOD: "good",
    DrillMoveQuality.INACCURACY: "inaccuracy",
    DrillMoveQuality.WRONG: "wrong",
}
_MOVE_QUALITY_ENUM: dict[Literal["good", "inaccuracy", "wrong"], DrillMoveQuality] = {
    literal: enum_member for enum_member, literal in _MOVE_QUALITY_LITERAL.items()
}


def _resolve_move_quality_tier(
    move_quality: int | None, correct_move: bool
) -> Literal["good", "inaccuracy", "wrong"]:
    """Resolve a stored `drill_solves` row's move-quality tier (SEED-119).

    A non-NULL `move_quality` maps through `_MOVE_QUALITY_LITERAL`. A NULL
    `move_quality` means the row predates SEED-119 (go-forward only, no
    backfill) — degrade from the stored `correct_move` boolean instead: True
    maps to the good tier (the pre-tiering era only ever recorded a full move
    point), False maps to the wrong tier. These legacy rows predate SEED-119
    and cannot actually reach the landing-screen display path — the landing
    screen only ever shows the CURRENT window's session — so this mapping
    exists purely to make the type total; build nothing further for it.
    Shared by `record_solve`'s lost-claim re-read and `_resume_session`'s
    `solved_results` builder so the rule exists in exactly one place.
    """
    if move_quality is not None:
        return _MOVE_QUALITY_LITERAL[DrillMoveQuality(move_quality)]
    return "good" if correct_move else "wrong"

# Quick task 260728-pgp: due_stmt over-fetches by this factor before the
# session-wide per-game cap is applied in Python (it must span both SR
# sources — due drill_items AND fresh pool picks — so it cannot be a bare
# SQL LIMIT). A plain `.limit(sr_slots)` would under-fill the SR side by
# exactly the number of same-game duplicates in the fetched window; prod's
# worst observed same-game (game_id, due_date) drill_items cluster is 6
# items, so 8x leaves headroom while keeping the query BOUNDED —
# deliberately not an unbounded scan.
_DUE_OVERFETCH_FACTOR: int = 8


@dataclass(frozen=True)
class TrainSettingsRow:
    """Internal dataclass for a single train_settings row.

    Frozen (immutable) per CLAUDE.md internal-structured-data rule. Mirrors
    `app.repositories.user_import_settings_repository.ImportSettingsRow`.

    `streak_count`/`shield_level`/`streak_settled_through`/`pool_eligible_since`
    are the Phase 193 per-day tick snapshot fields (added alongside the
    original D-06/D-07/D-08 fields, not a separate row type).
    """

    timezone: str
    weekday_mask: int
    puzzles_per_session: int
    streak_count: int
    shield_level: int
    streak_settled_through: datetime.date | None
    pool_eligible_since: datetime.date | None


@dataclass(frozen=True)
class ComposedPuzzle:
    """Internal dataclass for one puzzle within a composed/resumed session.

    Phase 192: `game_id` is `int | None` — a puzzle's source game link is
    nullable provenance (D-01/D-05), not the puzzle's identity
    (`herring_pool_id` is, for a herring). `drill_solves.game_id` itself went
    nullable in Plan 02 (the phase's one-way door, `ondelete="SET NULL"`), so
    `None` here is a real, servable case — not merely forward-compat typing.
    """

    position: int
    game_id: int | None
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]
    last_move_uci: str | None
    herring_pool_id: int | None = None


@dataclass(frozen=True)
class ComposedSolvedResult:
    """Internal dataclass for one recorded solve within a composed/resumed session.

    Quick task 260728-tgc (BUGFIX-TRAIN-SCORE-CROSSDEVICE): mirrors
    `app.schemas.train.SolvedResult` field-for-field — the router maps one
    directly onto the other, same convention as `ComposedPuzzle` ->
    `TrainPuzzle`. `correct_guess`/`move_quality` are the RECORDED OUTCOME of
    an attempt (the same values `record_solve` already wrote to this row),
    never a server-computed score — this dataclass carries no score field and
    the repository must not import from `app.schemas`.
    """

    correct_guess: bool
    move_quality: Literal["good", "inaccuracy", "wrong"]


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

    `solved_results` (260728-tgc) is one `ComposedSolvedResult` per recorded
    solve, in `position` order — `[]` for a fresh composition and for the
    nothing-qualified case. `solved_count` always equals its length.
    """

    session_id: int | None
    session_date: datetime.date
    expires_on: datetime.date
    puzzle_count: int
    requested_count: int
    solved_count: int
    blob_pending_count: int
    puzzles: list[ComposedPuzzle]
    solved_results: list[ComposedSolvedResult]


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
        streak_count=row.streak_count,
        shield_level=row.shield_level,
        streak_settled_through=row.streak_settled_through,
        pool_eligible_since=row.pool_eligible_since,
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
        # A brand-new row's tick snapshot starts at zero/never-settled —
        # exactly the state that triggers a full-history replay on first
        # settlement (mirrors Phase 191's D-05 retroactivity mechanism).
        # pool_eligible_since stays NULL until _stamp_pool_eligibility finds
        # real material (D-06).
        streak_count=0,
        shield_level=0,
        streak_settled_through=None,
        pool_eligible_since=None,
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
        streak_count=0,
        shield_level=0,
        streak_settled_through=None,
        pool_eligible_since=None,
    )


async def upsert_settings(
    session: AsyncSession,
    *,
    user_id: int,
    timezone: str,
    weekday_mask: int,
    puzzles_per_session: int,
    now_utc: datetime.datetime,
) -> TrainSettingsRow:
    """Insert or update one user's `train_settings` row (PUT /train/settings).

    `INSERT ... ON CONFLICT (user_id) DO UPDATE`, mirroring
    `user_import_settings_repository.upsert_settings`'s atomic-idempotent
    shape. The caller (Pydantic `TrainSettingsUpdate`) has already validated
    `timezone` resolves via `zoneinfo.ZoneInfo` and that `weekday_mask`/
    `puzzles_per_session` are within the table's CHECK bounds — this function
    trusts that and does no re-validation.

    Settle-before-mutate (carried forward from Phase 191 D-18, now at
    per-day tick granularity): settlement runs STRICTLY BEFORE any new value
    is applied, judged against the OLD mask and OLD timezone:

    1. `old_row = await get_or_create_settings(...)` — reading this BEFORE
       applying any new value is load-bearing. Reading it AFTER would settle
       every elapsed unsettled scheduled day against the NEW schedule
       instead of the one that was actually in force, silently
       reintroducing the retroactive re-judging a settled day must never
       suffer. A user who was inactive for several elapsed days and then
       reschedules must have those days judged by the OLD schedule.
    2. `today = local_today(old_row.timezone, now_utc)` — resolved from the
       OLD timezone, because a timezone change moves day boundaries, and the
       elapsed days being settled belong to the old frame, not the new one.
    3. `await settle_streak_snapshot(..., settings_row=old_row, today=today)`
       — the single settlement entry point, reused verbatim; no second
       settlement implementation exists here.
    4. Only then is the `INSERT ... ON CONFLICT DO UPDATE` applying the new
       `timezone`/`weekday_mask`/`puzzles_per_session` issued.

    Both the settlement UPDATE (if any) and this settings UPSERT run
    sequentially on the same `AsyncSession`, inside the caller's one
    transaction — never `asyncio.gather` (CLAUDE.md) — so a failure in
    either rolls back both, and the snapshot can never advance against a
    schedule that was never persisted.

    Deliberately does NOT re-snap existing `drill_items.due_date` values when
    `weekday_mask` changes (unchanged from the router's prior documented
    behaviour).

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        timezone: A validated IANA timezone string.
        weekday_mask: 7-bit scheduled-day mask, 0-127.
        puzzles_per_session: Requested session size, 1-50.
        now_utc: The current UTC instant. Used ONLY to resolve `today` from
            the OLD (pre-mutation) timezone for the settle-before-mutate
            step — never converted against the NEW timezone being applied.
    """
    old_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(old_row.timezone, now_utc)
    await settle_streak_snapshot(session, user_id=user_id, settings_row=old_row, today=today)

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
    # RETURNING: this UPDATE never touches streak_count/shield_level/
    # streak_settled_through/pool_eligible_since — the settle-before-mutate
    # step above is the only writer of those four columns in this function —
    # so read back whatever the row holds after that settlement (either the
    # brand-new insert's server defaults or an existing row's just-settled
    # snapshot) rather than fabricating a value here.
    stmt = stmt.returning(
        TrainSettings.streak_count,
        TrainSettings.shield_level,
        TrainSettings.streak_settled_through,
        TrainSettings.pool_eligible_since,
    )
    result = await session.execute(stmt)
    streak_count, shield_level, streak_settled_through, pool_eligible_since = result.one()
    return TrainSettingsRow(
        timezone=timezone,
        weekday_mask=weekday_mask,
        puzzles_per_session=puzzles_per_session,
        streak_count=streak_count,
        shield_level=shield_level,
        streak_settled_through=streak_settled_through,
        pool_eligible_since=pool_eligible_since,
    )


# ---------------------------------------------------------------------------
# Progress (PROG-01/PROG-04, Phase 191 Plan 01, D-18)
# ---------------------------------------------------------------------------


async def _count_drill_items_by_status(
    session: AsyncSession, *, user_id: int, status: DrillStatus
) -> int:
    """Count a user's `drill_items` rows in a given status (mastered/parked counts).

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        status: The `DrillStatus` to count.
    """
    stmt = (
        select(func.count())
        .select_from(DrillItem)
        .where(DrillItem.user_id == user_id, DrillItem.status == status)
    )
    return (await session.execute(stmt)).scalar_one()


@dataclass(frozen=True)
class ProgressSnapshot:
    """Internal dataclass mirroring `app.schemas.train.TrainProgressResponse`.

    `session_streak_count` (Phase 193, was `settled_streak_weeks`) counts
    completed scheduled-day sessions. `shield_level` (was `flame_state`) is
    the plain 0-`SHIELD_CAP` persisted value — there is no display overlay
    any more (the eager-write model this plan adds makes the persisted
    value always current). `streak_reset_notice` (was `streak_lost_last_week`)
    is derived from the resulting state, so it survives a page reload.
    `badge_visible` (Plan 02, D-09/D-10) is a display hint only — it gates no
    server-side authorization; the badge's own number still comes from
    `waiting_count`.
    """

    session_streak_count: int
    shield_level: int
    current_week_completed: int
    current_week_required: int | None
    streak_reset_notice: bool
    mastered_count: int
    parked_count: int
    waiting_count: int
    pool_state: Literal["no_material", "exhausted", "available"]
    next_due_date: datetime.date | None
    badge_visible: bool


async def _material_flags(session: AsyncSession, *, user_id: int) -> tuple[bool, bool]:
    """Return `(has_drill_items, has_pool_candidates)` — the two EXISTS
    signals `_pool_state` already needed, factored out so `get_progress` can
    also use them (resolved exactly once per request) to decide whether to
    stamp the D-06 `pool_eligible_since` watermark.

    `blob_pending_count > 0` alone is deliberately EXCLUDED from "qualifying
    material": a blunder still awaiting tier-4 analysis has no answer key
    yet, so it is not yet drillable under D-06's own wording.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
    """
    has_drill_items = (
        await session.execute(
            select(select(DrillItem.user_id).where(DrillItem.user_id == user_id).exists())
        )
    ).scalar_one()
    has_pool_candidates = (
        await session.execute(select(pool_entry_stmt(user_id).exists()))
    ).scalar_one()
    return has_drill_items, has_pool_candidates


async def _stamp_pool_eligibility(
    session: AsyncSession,
    *,
    user_id: int,
    settings_row: TrainSettingsRow,
    today: datetime.date,
    has_material: bool,
) -> datetime.date | None:
    """D-06: stamp the eligibility watermark once, the first time qualifying
    material is observed; never overwrite an existing one.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        settings_row: The user's current `TrainSettingsRow`.
        today: The local calendar day (from `local_today`).
        has_material: `has_drill_items OR has_pool_candidates` from
            `_material_flags`, resolved once by the caller.

    Returns:
        `settings_row.pool_eligible_since` unchanged when already set;
        `today` when it was NULL and `has_material` is True (the SAME
        request's tick machine gets a usable floor immediately, rather than
        waiting for the next read); `None` when it was NULL and there is
        still no material.
    """
    if settings_row.pool_eligible_since is not None:
        return settings_row.pool_eligible_since
    if not has_material:
        return None
    # Guarded on IS NULL: a concurrent stamp from another request racing
    # this one is harmless — both would write the same `today` (or the
    # slower one is simply a no-op UPDATE matching zero rows).
    await session.execute(
        update(TrainSettings)
        .where(TrainSettings.user_id == user_id, TrainSettings.pool_eligible_since.is_(None))
        .values(pool_eligible_since=today)
    )
    return today


async def settle_streak_snapshot(
    session: AsyncSession, *, user_id: int, settings_row: TrainSettingsRow, today: datetime.date
) -> TickView:
    """Advance the per-day tick snapshot over every elapsed scheduled day and
    persist the advance (PROG-01).

    THE SINGLE settlement entry point, shared by `GET /train/progress` (here)
    and `PUT /train/settings` (settle-before-mutate). Reads the user's
    `status='completed'` `drill_sessions.session_date` values (order-
    insensitive — `tick_days` buckets internally), builds the input
    `TickSnapshot` from `settings_row`'s three snapshot fields, calls
    `tick_days` (passing `settings_row.pool_eligible_since` as the D-06
    watermark), and persists the advanced snapshot IF AND ONLY IF
    `view.changed` is True.

    This is a read endpoint that writes, so it is documented plainly here:
    the write is a **compare-and-set UPDATE** guarded on the settlement
    boundary strictly advancing (`streak_settled_through IS NULL OR <
    new_settled_through`). Two concurrent callers that both settle the same
    days compute identical results from the same input snapshot, so a
    duplicate write is harmless — the guard exists only to stop a slower
    request from writing an OLDER boundary over a newer one.
    `streak_settled_through` therefore only ever moves forward, and a call
    with `changed=False` issues no statement at all.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        settings_row: The user's current `TrainSettingsRow` (already
            resolved via `get_or_create_settings`, and — for `get_progress`'s
            caller — already carrying a just-stamped `pool_eligible_since`
            from `_stamp_pool_eligibility` in the SAME transaction).
        today: The local calendar day (from `local_today`).
    """
    dates_result = await session.execute(
        select(DrillSession.session_date).where(
            DrillSession.user_id == user_id, DrillSession.status == "completed"
        )
    )
    completed_session_dates = [row[0] for row in dates_result.all()]

    snapshot = TickSnapshot(
        streak_count=settings_row.streak_count,
        shield_level=settings_row.shield_level,
        settled_through=settings_row.streak_settled_through,
    )
    view = tick_days(
        snapshot,
        completed_session_dates,
        weekday_mask=settings_row.weekday_mask,
        today=today,
        pool_eligible_since=settings_row.pool_eligible_since,
    )

    if view.changed:
        new_settled_through = view.settled.settled_through
        await session.execute(
            update(TrainSettings)
            .where(
                TrainSettings.user_id == user_id,
                or_(
                    TrainSettings.streak_settled_through.is_(None),
                    TrainSettings.streak_settled_through < new_settled_through,
                ),
            )
            .values(
                streak_count=view.settled.streak_count,
                shield_level=view.settled.shield_level,
                streak_settled_through=new_settled_through,
            )
        )

    return view


async def get_progress(
    session: AsyncSession, *, user_id: int, now_utc: datetime.datetime
) -> ProgressSnapshot:
    """Return the full Train progress read-model (PROG-01/PROG-04).

    Sequential awaits only — never `asyncio.gather` on this `AsyncSession`
    (CLAUDE.md). Steps: `get_or_create_settings` -> resolve today's local
    date -> `_material_flags` -> `_stamp_pool_eligibility` (so the very call
    that discovers material gives the tick machine a usable floor, D-06) ->
    `settle_streak_snapshot` (with a settings row carrying the just-stamped
    watermark) -> mastered/parked counts -> `current_week_required` ->
    `blob_pending_count` -> `waiting_count` -> `_pool_state` (now passed the
    two already-resolved material flags) -> `_next_due_date`.

    `current_week_required` is `scheduled_days_per_week(weekday_mask)` —
    `None` at `weekday_mask == 0` ("train anytime" has no denominator to
    show), else the plain popcount (no special-casing: nothing gates on this
    value any more).

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        now_utc: The current UTC instant (converted to a local date via
            `local_today` — called exactly ONCE in this path).
    """
    settings_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(settings_row.timezone, now_utc)

    has_drill_items, has_pool_candidates = await _material_flags(session, user_id=user_id)
    has_material = has_drill_items or has_pool_candidates
    stamped_pool_eligible_since = await _stamp_pool_eligibility(
        session,
        user_id=user_id,
        settings_row=settings_row,
        today=today,
        has_material=has_material,
    )
    if stamped_pool_eligible_since != settings_row.pool_eligible_since:
        settings_row = TrainSettingsRow(
            timezone=settings_row.timezone,
            weekday_mask=settings_row.weekday_mask,
            puzzles_per_session=settings_row.puzzles_per_session,
            streak_count=settings_row.streak_count,
            shield_level=settings_row.shield_level,
            streak_settled_through=settings_row.streak_settled_through,
            pool_eligible_since=stamped_pool_eligible_since,
        )

    view = await settle_streak_snapshot(
        session, user_id=user_id, settings_row=settings_row, today=today
    )

    mastered_count = await _count_drill_items_by_status(
        session, user_id=user_id, status=DrillStatus.MASTERED
    )
    parked_count = await _count_drill_items_by_status(
        session, user_id=user_id, status=DrillStatus.PARKED
    )

    current_week_required = scheduled_days_per_week(settings_row.weekday_mask)

    blob_pending_count = (await session.execute(blob_pending_stmt(user_id))).scalar_one()
    waiting_count = await get_waiting_puzzle_count(
        session, user_id=user_id, settings_row=settings_row, today=today
    )
    pool_state = await _pool_state(
        session,
        user_id=user_id,
        waiting_count=waiting_count,
        blob_pending_count=blob_pending_count,
        has_drill_items=has_drill_items,
        has_pool_candidates=has_pool_candidates,
    )
    next_due_date = await _next_due_date(session, user_id=user_id, today=today)

    # D-09/D-10 (Plan 02): the nav badge shows only on a scheduled session
    # day, UNLESS an already-open unexpired session still has unsolved
    # puzzles left to rescue (only reachable under a narrowed mask, where
    # session_window can leave a session open across an unscheduled day).
    # is_scheduled_day is the SAME bit-test the D-07 off-day tick branch
    # uses — one predicate, two call sites, never re-derived here.
    badge_visible = waiting_count > 0 and (
        is_scheduled_day(today, settings_row.weekday_mask)
        or await _open_unfinished_exists(session, user_id=user_id, today=today)
    )

    return ProgressSnapshot(
        session_streak_count=view.settled.streak_count,
        shield_level=view.settled.shield_level,
        current_week_completed=view.current_week_completed,
        current_week_required=current_week_required,
        streak_reset_notice=view.streak_reset_notice,
        mastered_count=mastered_count,
        parked_count=parked_count,
        waiting_count=waiting_count,
        pool_state=pool_state,
        next_due_date=next_due_date,
        badge_visible=badge_visible,
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


async def completed_session_in_window(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> DrillSession | None:
    """Return the user's latest `status='completed'` session still inside its D-10 window.

    Bug fix (190.1 pre-deploy): completing a session flips it to
    `status='completed'` (`_mark_session_complete_if_done`), so the D-12
    resume path — which only looks at `status='open'` rows — stopped seeing
    it, and the very next compose call built a brand-new session on the same
    day. That defeated the D-10 session window ("one session until the next
    scheduled day") and made the 'completed' landing state unreachable after
    a page reload. Compose must treat a completed-but-unexpired session
    exactly like an open one: return it, don't recompose.

    In-window means `expires_on > today` — the strict inequality mirrors
    `is_session_expired`'s inclusive boundary (`today >= expires_on` means
    expired). `expire_stale_sessions` never touches completed rows (it only
    flips `open` -> `expired`), so `status='completed'` rows keep their
    status forever and this date predicate is the only window authority.

    Ordered by id DESC because pre-fix data may legitimately hold several
    completed sessions inside one window; the newest one is the user's
    current recap.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The local calendar day (from `local_today`).
    """
    result = await session.execute(
        select(DrillSession)
        .where(
            DrillSession.user_id == user_id,
            DrillSession.status == "completed",
            DrillSession.expires_on > today,
        )
        .order_by(DrillSession.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _is_untouched_and_resized(
    session: AsyncSession, *, drill_session: DrillSession, requested_count: int
) -> bool:
    """Whether `drill_session` is untouched AND its frozen size has drifted
    from `requested_count` — i.e. whether the next
    `compose_and_materialize_session` call will DISCARD it and compose fresh.

    Read-only: issues one COUNT and never writes. The single source of truth
    for this predicate, shared by the write path
    (`_discard_if_untouched_and_resized`, which acts on it) and the read path
    (`get_waiting_puzzle_count`, which must merely *predict* it). Keeping one
    implementation is load-bearing: when the two drifted, the nav badge kept
    advertising a stale frozen count for a session the very next composition
    was going to throw away.

    Compares against the session's OWN `requested_count` snapshot, NEVER its
    `puzzle_count` — a session can legitimately serve fewer puzzles than
    requested when the pool is short on material (the D-14 "short session"
    state), and re-checking that same shortfall on every call would churn the
    session for no reason. `requested_count is None` (pre-migration rows, or a
    test fixture seeding a session directly without going through composition)
    is always treated as "not resized" — the conservative default.

    Only a session with ZERO recorded solves qualifies: once any puzzle has
    been solved, `puzzle_count` is load-bearing for the SOLV-04/D-13 frozen
    progress denominator and must never move out from under an in-progress
    solve loop.
    """
    if drill_session.requested_count is None or drill_session.requested_count == requested_count:
        return False
    solved_count_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .where(DrillSolve.session_id == drill_session.id, DrillSolve.solved_at.isnot(None))
    )
    solved_so_far = (await session.execute(solved_count_stmt)).scalar_one()
    return solved_so_far == 0


async def get_waiting_puzzle_count(
    session: AsyncSession, *, user_id: int, settings_row: TrainSettingsRow, today: datetime.date
) -> int:
    """Read-only estimate of puzzles waiting for the nav badge (SCHD-02/D-07).

    NEVER calls `compose_and_materialize_session` and NEVER calls
    `expire_stale_sessions` — this whole function is a read. Takes
    `settings_row`/`today` as parameters rather than re-resolving them, so a
    caller resolves `get_or_create_settings`/`local_today` exactly once per
    request (191-RESEARCH.md Pitfall 2).

    Branch order, all sequential awaits (never `asyncio.gather` on this
    `AsyncSession`, CLAUDE.md):

    1. An open session that is NOT expired -> its `puzzle_count` minus its
       solved `drill_solves` count (floored at 0, mirroring `_resume_session`'s
       solved-count predicate). An expired-but-still-`open` row is skipped in
       Python here, never flipped to `'expired'` — that write belongs solely
       to `expire_stale_sessions`, never to this read path.
       EXCEPTION: an open session that `_is_untouched_and_resized` reports as
       doomed (zero solves + a `requested_count` that no longer matches the
       current `puzzles_per_session`) falls through to branch 3 instead. The
       next composition will discard and recompose it, so its frozen count is
       already dead — reporting it made the badge advertise a size the user had
       just changed away from. Predicting the discard is read-only; the delete
       stays in `_discard_if_untouched_and_resized`.
    2. Otherwise a completed session still inside its D-10 window -> 0 (D-07:
       the badge hides once today's session is done).
    3. Otherwise an estimate of available fresh material, capped at
       `settings_row.puzzles_per_session`: due `drill_items` (mirroring
       `compose_and_materialize_session`'s `due_stmt` eligibility predicates
       exactly, in COUNT-only form) + untracked `pool_entry_stmt` candidates
       (excluding already-tracked `(game_id, ply)` pairs via a SQL `NOT
       EXISTS` against `drill_items`, never materializing the pair set in
       Python) + `herring_stmt(..., exclude_served=False)` candidates.

    Never imports `classify_puzzle_type`, a `missed_pv_lines` reader,
    `fen_and_last_move_at_ply`, or any other answer-key/classification
    helper — this function needs counts and dates only (191-RESEARCH.md
    Pitfall 5). Never issues `session.add`/`session.flush`/INSERT/UPDATE/
    DELETE.

    The returned number is an UPPER BOUND, never a promise of exact session
    size: it applies composition's own eligibility predicates and the
    `puzzles_per_session` cap, but skips per-puzzle FEN reconstruction — a
    puzzle composition would later drop as unreconstructable can still be
    counted here. That is acceptable for an attention signal.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        settings_row: The caller's already-resolved `TrainSettingsRow`.
        today: The local calendar day (from `local_today`, resolved once per
            request by the caller).
    """
    open_session = await open_session_for_user(session, user_id=user_id)
    if open_session is not None and not is_session_expired(open_session.expires_on, today):
        # Bug fix: an UNTOUCHED open session whose size has drifted from the
        # current `puzzles_per_session` is about to be discarded and recomposed
        # by the next `compose_and_materialize_session` call
        # (`_discard_if_untouched_and_resized`). Reporting its frozen
        # `puzzle_count` here made the nav badge advertise a number the user had
        # just changed and that no session would ever serve — the count only
        # corrected itself once they pressed Start. Falling through to the
        # fresh-material estimate below predicts the recomposition instead.
        # A session with any recorded solve is NEVER resized (the predicate
        # requires zero solves), so an in-progress session keeps counting down
        # from its own frozen denominator.
        if not await _is_untouched_and_resized(
            session,
            drill_session=open_session,
            requested_count=settings_row.puzzles_per_session,
        ):
            solved_stmt = (
                select(func.count())
                .select_from(DrillSolve)
                .where(DrillSolve.session_id == open_session.id, DrillSolve.solved_at.isnot(None))
            )
            solved_count = (await session.execute(solved_stmt)).scalar_one()
            return max(0, open_session.puzzle_count - solved_count)

    completed = await completed_session_in_window(session, user_id=user_id, today=today)
    if completed is not None:
        return 0

    # Due drill_items — mirrors compose_and_materialize_session's due_stmt
    # eligibility exactly (status/due_date/flaw-row-presence/answer-key),
    # minus the Game join (not needed for a count).
    due_count_stmt = (
        select(func.count())
        .select_from(DrillItem)
        .outerjoin(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillItem.user_id,
                GameFlaw.game_id == DrillItem.game_id,
                GameFlaw.ply == DrillItem.ply,
            ),
        )
        .where(
            DrillItem.user_id == user_id,
            DrillItem.status == DrillStatus.ACTIVE,
            DrillItem.due_date <= today,
            GameFlaw.ply.isnot(None),
            answer_key_present(GameFlaw.missed_pv_lines),
        )
    )
    due_count = (await session.execute(due_count_stmt)).scalar_one()

    # Untracked pool_entry_stmt candidates — a NOT EXISTS against drill_items
    # expressed in SQL, never materializing the pair set in Python.
    pool_subq = pool_entry_stmt(user_id).subquery()
    untracked_pool_stmt = (
        select(func.count())
        .select_from(pool_subq)
        .where(
            ~exists(
                select(DrillItem.game_id).where(
                    DrillItem.user_id == user_id,
                    DrillItem.game_id == pool_subq.c.game_id,
                    DrillItem.ply == pool_subq.c.ply,
                )
            )
        )
    )
    untracked_pool_count = (await session.execute(untracked_pool_stmt)).scalar_one()

    herring_count_stmt = select(func.count()).select_from(
        herring_stmt(user_id, exclude_served=False).subquery()
    )
    herring_count = (await session.execute(herring_count_stmt)).scalar_one()

    return min(settings_row.puzzles_per_session, due_count + untracked_pool_count + herring_count)


async def _open_unfinished_exists(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> bool:
    """D-10: whether the user has an open, unexpired session with unsolved
    puzzles left — the nav-badge carve-out that keeps the badge lit on an
    off-day when a half-finished session is still rescuable.

    Deliberately mirrors branch 1 of `get_waiting_puzzle_count` (the open-
    session-not-expired case) as a standalone read-only boolean, rather than
    widening that function's return type — the cost is two extra indexed
    single-row lookups on the progress path, accepted for the smaller diff.
    Never flips an expired-but-still-open row to `'expired'` here; that write
    belongs solely to `expire_stale_sessions`. Window-based (`expires_on`)
    only — D-10 cares whether the session is still open, not whether today
    happens to be a scheduled day.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The local calendar day (from `local_today`).
    """
    open_session = await open_session_for_user(session, user_id=user_id)
    if open_session is None or is_session_expired(open_session.expires_on, today):
        return False
    solved_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .where(DrillSolve.session_id == open_session.id, DrillSolve.solved_at.isnot(None))
    )
    solved_count = (await session.execute(solved_stmt)).scalar_one()
    return solved_count < open_session.puzzle_count


async def _next_due_date(
    session: AsyncSession, *, user_id: int, today: datetime.date
) -> datetime.date | None:
    """PROG-05: the earliest due date among the user's still-ACTIVE items due
    strictly in the future — the "All caught up!" empty state's date.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        today: The local calendar day (from `local_today`).

    Returns:
        The minimum `drill_items.due_date` among ACTIVE items with
        `due_date > today`, or None when nothing will resurface (`func.min`
        over zero rows is already NULL/None — no special-casing needed).
    """
    stmt = select(func.min(DrillItem.due_date)).where(
        DrillItem.user_id == user_id,
        DrillItem.status == DrillStatus.ACTIVE,
        DrillItem.due_date > today,
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _pool_state(
    session: AsyncSession,
    *,
    user_id: int,
    waiting_count: int,
    blob_pending_count: int,
    has_drill_items: bool,
    has_pool_candidates: bool,
) -> Literal["no_material", "exhausted", "available"]:
    """PROG-05/D-16: discriminate cold-start ("never had material") from a
    genuinely exhausted pool from an available one — the single server-side
    discriminant the two empty-state surfaces branch on (no client-side
    arithmetic).

    Resolution order:
    1. `"no_material"` — the user has zero `drill_items` rows AND zero
       `pool_entry_stmt` candidates AND `blob_pending_count == 0`: never had
       any qualifying material, not even material still being analyzed.
    2. `"exhausted"` — `waiting_count == 0` AND `blob_pending_count == 0`:
       had (or has) material, but nothing is waiting right now and nothing
       is still analyzing.
    3. `"available"` — every other case, including a zero-`drill_items` user
       whose blunders are still being analyzed (`blob_pending_count > 0`):
       that is "catching up", not a cold start.

    Args:
        session: AsyncSession (unused directly — kept in the signature to
            match every other repository function's shape; the two EXISTS
            queries this used to run itself now live in `_material_flags`).
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        waiting_count: The result of `get_waiting_puzzle_count` for this
            request (resolved once by the caller, never re-derived here).
        blob_pending_count: The result of `blob_pending_stmt` for this
            request (resolved once by the caller, never re-derived here).
        has_drill_items: The result of `_material_flags` for this request
            (resolved once by the caller — Phase 193, also feeds the D-06
            `_stamp_pool_eligibility` check — never re-derived here).
        has_pool_candidates: The result of `_material_flags` for this
            request (same "resolved once" contract as `has_drill_items`).
    """
    if not has_drill_items and not has_pool_candidates and blob_pending_count == 0:
        return "no_material"
    if waiting_count == 0 and blob_pending_count == 0:
        return "exhausted"
    return "available"


async def load_session_puzzles(
    session: AsyncSession, *, user_id: int, session_id: int
) -> list[ComposedPuzzle]:
    """Return the ordered, not-yet-attempted puzzles for a session (D-09/D-12 resume path).

    `drill_solves` rows with `solved_at IS NULL`, ordered by `position` (the
    frozen composition order), OUTER-joined to `games` (Phase 192 D-05:
    `game_id` can be NULL after a source-game deletion, so this can no longer
    be an INNER JOIN without silently dropping puzzles) and to `herring_pool`
    for a herring's FEN/arriving move. Scoped by `user_id` in the WHERE
    clause IN ADDITION to `session_id` — a session id arriving from a request
    body/path parameter is untrusted client input (T-189-12 / V4 IDOR guard);
    a foreign session id resolves to zero rows rather than another user's
    puzzles.

    Two independent lazy-eviction paths, opposite reasons:
    - A `RED_HERRING` row reads its FEN/arriving move straight off the
      `herring_pool` row (D-03 — the only herring path, alive game-link or
      not) and is skipped only if the pool row itself is gone, handled
      identically to a broken FEN: drop, never serve. This DOES happen —
      every session composed before the pool was first generated carried a
      NULL `herring_pool_id` (prod, 2026-07-28), and `drill_solves
      .herring_pool_id` is `ON DELETE SET NULL`, so any future pool prune
      orphans in-flight rows the same way. `_mark_session_complete_if_done`
      carries the matching exclusion (SEED-123) so a dropped herring cannot
      pin the session open forever.
    - An `SR_ITEM` row is skipped when its `games` row has vanished (D-05:
      the row now survives its source game's deletion with `game_id` NULL
      instead of being CASCADE-deleted, so an orphaned SR row is unservable
      but must not be served or crash — mirrors the pre-D-05 CASCADE
      behavior) OR when its backing `game_flaws` row has since vanished under
      reclassification (pre-existing D-02 lazy eviction, unchanged).

    Rows whose FEN will not reconstruct are also skipped. The session's
    frozen `puzzle_count` is returned UNCHANGED by this function — callers
    must not derive it from `len(puzzles)` here, so `solved_count +
    len(puzzles)` may legitimately be less than `puzzle_count` after an
    eviction.

    Args:
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        session_id: The `drill_sessions.id` to load remaining puzzles for.
    """
    stmt = (
        select(DrillSolve, Game, HerringPool)
        .outerjoin(Game, Game.id == DrillSolve.game_id)
        .outerjoin(HerringPool, HerringPool.id == DrillSolve.herring_pool_id)
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

    sr_game_ids = {
        solve.game_id
        for solve, _game, _herring in rows
        if solve.source == DrillSource.SR_ITEM and solve.game_id is not None
    }
    existing_flaw_keys: set[tuple[int, int]] = set()
    if sr_game_ids:
        flaw_rows = await session.execute(
            select(GameFlaw.game_id, GameFlaw.ply).where(
                GameFlaw.user_id == user_id, GameFlaw.game_id.in_(sr_game_ids)
            )
        )
        existing_flaw_keys = {(gid, ply) for gid, ply in flaw_rows.all()}

    puzzles: list[ComposedPuzzle] = []
    for solve, game, herring_row in rows:
        if solve.source == DrillSource.RED_HERRING:
            if herring_row is None:
                continue  # pool row itself is gone — drop, never serve broken
            puzzles.append(
                ComposedPuzzle(
                    position=solve.position,
                    game_id=solve.game_id,
                    ply=solve.ply,
                    fen=herring_row.fen,
                    side_to_move=mover_color_for_ply(solve.ply),
                    last_move_uci=herring_row.arriving_move_uci,
                    herring_pool_id=solve.herring_pool_id,
                )
            )
            continue

        # SR_ITEM
        if game is None:
            continue  # orphaned by a source-game deletion (D-05): lazily evicted
        # The outer join above guarantees game.id == solve.game_id here, so
        # solve.game_id is non-None whenever game is not None — narrowed
        # explicitly for ty rather than suppressed.
        assert solve.game_id is not None
        if (solve.game_id, solve.ply) not in existing_flaw_keys:
            continue  # lazy eviction: the backing flaw row vanished (D-02)
        result = fen_and_last_move_at_ply(game.pgn, solve.ply)
        if result is None:
            continue  # never serve a puzzle whose FEN can't reconstruct
        fen, last_move_uci = result
        puzzles.append(
            ComposedPuzzle(
                position=solve.position,
                game_id=solve.game_id,
                ply=solve.ply,
                fen=fen,
                side_to_move=mover_color_for_ply(solve.ply),
                last_move_uci=last_move_uci,
                herring_pool_id=solve.herring_pool_id,
            )
        )
    return puzzles


async def _resume_session(
    session: AsyncSession,
    *,
    user_id: int,
    drill_session: DrillSession,
    requested_count: int,
    blob_pending_count: int,
) -> ComposedSession:
    """Build a `ComposedSession` for an existing session row.

    Serves both the D-12 resume path (an open session: unsolved puzzles
    returned for the loop to continue) and the completed-in-window path (a
    `status='completed'` session: `load_session_puzzles` returns [] and the
    landing screen renders the D-03 recap from `solved_count`/`expires_on`).

    Quick task 260728-tgc (BUGFIX-TRAIN-SCORE-CROSSDEVICE): the former
    `solved_count`-only `func.count()` query is widened into a row select of
    `correct_guess`/`move_quality`/`correct_move`, ordered by `position` —
    still ONE query, no second round-trip. `solved_count` is now derived as
    `len(solved_results)` rather than a separate COUNT.
    """
    puzzles = await load_session_puzzles(session, user_id=user_id, session_id=drill_session.id)
    solved_rows_stmt = (
        select(DrillSolve.correct_guess, DrillSolve.move_quality, DrillSolve.correct_move)
        .where(DrillSolve.session_id == drill_session.id, DrillSolve.solved_at.isnot(None))
        .order_by(DrillSolve.position)
    )
    solved_rows = (await session.execute(solved_rows_stmt)).all()
    solved_results = [
        ComposedSolvedResult(
            correct_guess=bool(row.correct_guess),
            move_quality=_resolve_move_quality_tier(row.move_quality, bool(row.correct_move)),
        )
        for row in solved_rows
    ]
    return ComposedSession(
        session_id=drill_session.id,
        session_date=drill_session.session_date,
        expires_on=drill_session.expires_on,
        puzzle_count=drill_session.puzzle_count,
        requested_count=requested_count,
        solved_count=len(solved_results),
        blob_pending_count=blob_pending_count,
        puzzles=puzzles,
        solved_results=solved_results,
    )


async def _discard_if_untouched_and_resized(
    session: AsyncSession, *, drill_session: DrillSession, requested_count: int
) -> bool:
    """Discard `drill_session` iff it is untouched AND its frozen size has
    drifted from `requested_count`. Returns True if the row was deleted
    (caller must fall through to fresh composition), False if it should be
    resumed exactly as-is.

    Bug fix (191-06 UAT checkpoint round, SCHD-01): `Train.tsx` auto-fires
    `POST /train/sessions` as a status read on page MOUNT (see
    `useTrainSession.ts`'s module docstring), which can happen BEFORE the
    user has a chance to edit `TrainScheduleSettings` on the same visit.
    Pressing Start/Resume never calls this endpoint again, so a session
    materialized under a stale `puzzles_per_session` stayed frozen at the
    old size for the rest of the day even after the user changed the
    setting — "starting a session" kept showing the old requested count.

    Only a session with ZERO recorded solves is eligible: once any puzzle
    has been solved, `puzzle_count`/`session_id` are load-bearing for the
    SOLV-04/D-13 frozen progress denominator and must never move out from
    under an in-progress solve loop. Deleting an untouched
    `drill_sessions` row cascades its placeholder `drill_solves` rows
    (`ondelete="CASCADE"`); any `drill_items` padding rows created during the
    original composition are left alone — they are real, valid ACTIVE items
    and the fresh composition below will naturally pick them back up as due.

    The untouched-and-resized test itself lives in `_is_untouched_and_resized`
    (shared with `get_waiting_puzzle_count`, which must predict this discard
    without performing it); see that function for the `requested_count`-vs-
    `puzzle_count` and zero-solves rationale. This function is the WRITE half:
    predicate, then delete.
    """
    if not await _is_untouched_and_resized(
        session, drill_session=drill_session, requested_count=requested_count
    ):
        return False
    await session.execute(delete(DrillSession).where(DrillSession.id == drill_session.id))
    return True


@dataclass(frozen=True)
class _ReconstructedPuzzle:
    """One puzzle after FEN/arriving-move reconstruction, pre-shuffle/pre-insert.

    Phase 192: replaces the former 7-tuple `reconstructed` element (seven
    positional fields is past readable as a tuple). `herring_pool_id` is
    non-None only for a `RED_HERRING` row (D-04); an `SR_ITEM` row always
    carries `herring_pool_id=None`.
    """

    game_id: int | None
    ply: int
    fen: str
    last_move_uci: str | None
    side_to_move: Literal["white", "black"]
    source: int
    herring_pool_id: int | None


async def compose_and_materialize_session(
    session: AsyncSession, *, user_id: int, now_utc: datetime.datetime
) -> ComposedSession:
    """Compose or resume a Train session at the full POOL-07 75/25 mix.

    1. Resolve `train_settings` (create-on-first-touch), today's local date,
       and the `(sr_slots, herring_slots)` split (`compose_slots`).
    1b. D-06 (Plan 02): stamp the `pool_eligible_since` watermark if it is
       still NULL and real material (`_material_flags`) is present — a user
       whose first `drill_items` row is created by THIS composition call
       also gets the eligibility floor immediately, without waiting for a
       `GET /train/progress` read to discover it. Reuses the same
       `_material_flags`/`_stamp_pool_eligibility` pair `get_progress`
       already calls; stamp-if-null only, never an overwrite.
    2. D-11: `expire_stale_sessions` closes out a stale open session before
       anything else runs.
    3. D-12: if an open session still exists after expiry, RESUME it
       (`load_session_puzzles`) rather than composing a new one — this is the
       only path taken on a second call inside an open session's window,
       including an ad-hoc "train now" request from a future phase that hits
       this same endpoint. EXCEPTION (191-06 UAT bug fix,
       `_discard_if_untouched_and_resized`): an open session with ZERO
       recorded solves whose frozen `puzzle_count` no longer matches the
       CURRENT `puzzles_per_session` is discarded instead, falling through to
       fresh composition below — this is what lets a same-day settings edit
       actually take effect before the first puzzle is solved.
    3b. D-10 guard (190.1 bug fix): if a COMPLETED session's window still
       covers today (`completed_session_in_window`), return it instead of
       composing fresh — completing a session must not unlock an immediate
       replacement on reload; the next session arrives when the window rolls
       over. Phase 191's ad-hoc "train now" (SCHD-03) will need an explicit
       opt-out of this guard, not a bypass of the open-session resume above.
    4. Otherwise compose fresh: due `drill_items` (most-overdue-first) padded
       from `pool_entry_stmt` up to `sr_slots`, plus `herring_stmt` up to
       `herring_slots` (retried with `exclude_served=False` when the source
       is exhausted). Cross-backfill (Pitfall 4): if one side comes up short,
       the OTHER side fills the gap up to `n`, so a lopsided pool still
       yields a full session whenever enough total material exists.

       Quick task 260728-pgp: both SR sources are capped at
       `MAX_ITEMS_PER_GAME_PER_SESSION` per `game_id`, SESSION-WIDE, via one
       shared `per_game_counts` Counter threaded through the due loop, the
       `sr_needed` padding loop, and the herring-shortfall cross-backfill
       loop. A due item deferred by the cap is skipped for THIS session only
       and left completely untouched (`status` stays `ACTIVE`, `due_date` is
       not modified, nothing deleted) — it resurfaces `due_date`-first next
       session. The fresh-pool side's within-game choice is instead a
       seeded UNIFORM RANDOM pick (`pick_one_per_game`), never earliest-ply
       — a permanently-tracked `drill_items` row makes an earliest-ply bias
       there permanent, unlike the due side's transient ordering. A
       cap-shortened SR side still routes through the existing
       cross-backfill above rather than relaxing the cap.
    5. Reconstruct each puzzle's full FEN + arriving move via
       `fen_and_last_move_at_ply`; a puzzle whose FEN cannot be
       reconstructed is dropped rather than served broken (never
       backfilled — the slot arithmetic already ran).
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

    has_drill_items, has_pool_candidates = await _material_flags(session, user_id=user_id)
    await _stamp_pool_eligibility(
        session,
        user_id=user_id,
        settings_row=settings_row,
        today=today,
        has_material=has_drill_items or has_pool_candidates,
    )

    await expire_stale_sessions(session, user_id=user_id, today=today)

    blob_pending_count = (await session.execute(blob_pending_stmt(user_id))).scalar_one()

    open_session = await open_session_for_user(session, user_id=user_id)
    if open_session is not None:
        if await _discard_if_untouched_and_resized(
            session, drill_session=open_session, requested_count=n
        ):
            open_session = None
        else:
            return await _resume_session(
                session,
                user_id=user_id,
                drill_session=open_session,
                requested_count=n,
                blob_pending_count=blob_pending_count,
            )

    # Step 3b (190.1 bug fix): a completed session still inside its D-10
    # window blocks fresh composition — without this, a reload right after
    # finishing a session composed a brand-new one (status='completed' rows
    # are invisible to the open-session resume above), granting unlimited
    # same-day sessions and draining the pool.
    completed = await completed_session_in_window(session, user_id=user_id, today=today)
    if completed is not None:
        return await _resume_session(
            session,
            user_id=user_id,
            drill_session=completed,
            requested_count=n,
            blob_pending_count=blob_pending_count,
        )

    sr_slots, herring_slots = compose_slots(n)

    # Quick task 260728-pgp: the SINGLE session-wide per-game count, threaded
    # through every SR take-site below (the due loop, the sr_needed padding
    # loop, and the herring-shortfall cross-backfill loop) — this shared
    # Counter IS the session-wide 1-per-game guarantee, since due items and
    # fresh pool picks are otherwise resolved independently.
    per_game_counts: Counter[int] = Counter()

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
        # Quick task 260728-pgp: over-fetch (bounded by _DUE_OVERFETCH_FACTOR,
        # never unbounded) because the session-wide per-game cap below is
        # applied in Python AFTER this fetch — it must span both SR sources,
        # so a bare .limit(sr_slots) would under-fill the SR side by exactly
        # the number of same-game duplicates in the fetched window.
        .limit(sr_slots * _DUE_OVERFETCH_FACTOR)
    )
    due_rows = (await session.execute(due_stmt)).all()
    sr_candidates: list[tuple[int, int, Game]] = []
    for drill_item, game in due_rows:
        if len(sr_candidates) >= sr_slots:
            break
        if per_game_counts[drill_item.game_id] >= MAX_ITEMS_PER_GAME_PER_SESSION:
            # Quick task 260728-pgp: this due item is deferred for THIS
            # session only, mirroring the lazy-eviction comment above — it
            # is left completely untouched (status stays ACTIVE, due_date is
            # not modified, nothing is deleted), so due_date ASC puts it
            # first next session and the game self-drains at
            # MAX_ITEMS_PER_GAME_PER_SESSION/session. The due side's order
            # is TRANSIENT (a deferred item comes back next session), unlike
            # the fresh pool's PERMANENT drill_items row — that's why this
            # side stays deterministic most-overdue-first instead of the
            # pool's seeded uniform pick.
            continue
        sr_candidates.append((drill_item.game_id, drill_item.ply, game))
        per_game_counts[drill_item.game_id] += 1

    # --- SR padding pool: fresh qualifying flaws not yet tracked as drill_items ---
    existing_pairs_result = await session.execute(
        select(DrillItem.game_id, DrillItem.ply).where(DrillItem.user_id == user_id)
    )
    existing_pairs = {(gid, ply) for gid, ply in existing_pairs_result.all()}

    pool_stmt = pool_entry_stmt(user_id).order_by(
        Game.played_at.desc().nulls_last(), GameFlaw.game_id.desc(), GameFlaw.ply.asc()
    )
    pool_rows = (await session.execute(pool_stmt)).all()
    deduped_pool: list[tuple[int, int, Game]] = []
    for flaw, game in pool_rows:
        key = (flaw.game_id, flaw.ply)
        if key in existing_pairs:
            continue
        deduped_pool.append((flaw.game_id, flaw.ply, game))
        existing_pairs.add(key)
    # Quick task 260728-pgp: cap the fresh pool at MAX_ITEMS_PER_GAME_PER_SESSION
    # per game_id BEFORE it's consumed below. pick_one_per_game groups by
    # game_id in first-appearance order, so the Game.played_at DESC ordering
    # across games above is unchanged — only the WITHIN-game choice (which
    # ply of a blunder-heavy game) is randomized.
    sr_pool = pick_one_per_game(deduped_pool, user_id=user_id, session_date=today)

    # pool-sourced picks that need a brand-new drill_items row (never the
    # already-tracked due items above).
    new_sr_items: list[tuple[int, int, Game]] = []
    pool_idx = 0
    sr_needed = sr_slots - len(sr_candidates)
    while sr_needed > 0 and pool_idx < len(sr_pool):
        pick = sr_pool[pool_idx]
        pool_idx += 1
        # Quick task 260728-pgp: session-wide guard — sr_pool already holds
        # at most one entry per game (Task 1's pick_one_per_game), so this
        # is what stops a fresh-pool pick from colliding with a game the
        # DUE side above already claimed.
        if per_game_counts[pick[0]] >= MAX_ITEMS_PER_GAME_PER_SESSION:
            continue
        per_game_counts[pick[0]] += 1
        sr_candidates.append(pick)
        new_sr_items.append(pick)
        sr_needed -= 1

    # --- Herring side (Phase 192, D-03): HerringPool rows carry their own FEN/
    # arriving-move/mover_color — no Game join, no PGN reconstruction. ---
    herring_rows: list[HerringPool] = list(
        (await session.execute(herring_stmt(user_id, exclude_served=True).limit(n))).scalars()
    )
    if not herring_rows:
        # Source exhausted (every candidate already served this user) — repeats allowed.
        herring_rows = list(
            (await session.execute(herring_stmt(user_id, exclude_served=False).limit(n))).scalars()
        )
    herring_candidates = herring_rows[:herring_slots]
    herring_idx = herring_slots

    # --- Cross-backfill (Pitfall 4): a short side never silently shrinks the
    # session while the OTHER side has spare material. ---
    shortfall = n - (len(sr_candidates) + len(herring_candidates))
    if shortfall > 0:
        if len(sr_candidates) < sr_slots:
            # SR side came up short -> pull extra herrings, continuing the same
            # deterministic herring_stmt ordering from where herring_slots left off.
            herring_candidates = (
                herring_candidates + herring_rows[herring_idx : herring_idx + shortfall]
            )
        elif len(herring_candidates) < herring_slots:
            # Herring side came up short -> pull extra SR, continuing the same
            # pool_entry_stmt scan from where sr_slots left off.
            while shortfall > 0 and pool_idx < len(sr_pool):
                pick = sr_pool[pool_idx]
                pool_idx += 1
                # Quick task 260728-pgp: same session-wide guard as the
                # sr_needed padding loop above — never relax the cap even
                # when backfilling a herring shortfall.
                if per_game_counts[pick[0]] >= MAX_ITEMS_PER_GAME_PER_SESSION:
                    continue
                per_game_counts[pick[0]] += 1
                sr_candidates.append(pick)
                new_sr_items.append(pick)
                shortfall -= 1

    # --- Reconstruct FENs + arriving move, dropping (never backfilling)
    # unparseable puzzles ---
    reconstructed: list[_ReconstructedPuzzle] = []
    for game_id, ply, game in sr_candidates:
        result = fen_and_last_move_at_ply(game.pgn, ply)
        if result is None:
            continue
        fen, last_move_uci = result
        reconstructed.append(
            _ReconstructedPuzzle(
                game_id=game_id,
                ply=ply,
                fen=fen,
                last_move_uci=last_move_uci,
                side_to_move=mover_color_for_ply(ply),
                source=DrillSource.SR_ITEM,
                herring_pool_id=None,
            )
        )
    # D-10: own-game herrings are permitted, so a position can legitimately be
    # both a several-fine-moves pool row and the user's own blunder ply —
    # drop the herring before insert rather than colliding on
    # uq_drill_solves_session_puzzle and raising IntegrityError mid-composition.
    sr_keys = {(puzzle.game_id, puzzle.ply) for puzzle in reconstructed}
    for pool_row in herring_candidates:
        if (pool_row.game_id, pool_row.ply) in sr_keys:
            continue
        reconstructed.append(
            _ReconstructedPuzzle(
                game_id=pool_row.game_id,
                ply=pool_row.ply,
                fen=pool_row.fen,
                last_move_uci=pool_row.arriving_move_uci,
                side_to_move=cast(Literal["white", "black"], pool_row.mover_color),
                source=DrillSource.RED_HERRING,
                herring_pool_id=pool_row.id,
            )
        )
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
            solved_results=[],
        )

    # D-09: deterministic (user_id, session_date)-seeded shuffle so a red
    # herring's slot is never inferable from a fixed SR-then-herring layout,
    # and re-composition (e.g. this same call) is reproducible.
    random.Random(f"{user_id}:{today.isoformat()}").shuffle(reconstructed)

    surviving_sr_keys = {
        (puzzle.game_id, puzzle.ply)
        for puzzle in reconstructed
        if puzzle.source == DrillSource.SR_ITEM
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
                requested_count=n,
                expires_on=session_window(today, settings_row.weekday_mask),
            )
            session.add(drill_session)
            # Populate drill_session.id for the DrillSolve FK below, and
            # surface uq_drill_sessions_user_open here if a concurrent
            # request already won the race.
            await session.flush()

            puzzles: list[ComposedPuzzle] = []
            for position, puzzle in enumerate(reconstructed):
                # Phase 192 Plan 02: `drill_solves.game_id` is now nullable
                # (D-05) — a herring composed from an already-orphaned pool
                # row (its source game deleted before this composition ran)
                # legitimately has `game_id=None` here. SR items always carry
                # a non-None `game_id` (sourced via an INNER JOIN to `games`
                # above), so this is never a real NULL constraint violation.
                session.add(
                    DrillSolve(
                        session_id=drill_session.id,
                        position=position,
                        user_id=user_id,
                        game_id=puzzle.game_id,
                        ply=puzzle.ply,
                        source=puzzle.source,
                        herring_pool_id=puzzle.herring_pool_id,
                        solved_at=None,
                    )
                )
                puzzles.append(
                    ComposedPuzzle(
                        position=position,
                        game_id=puzzle.game_id,
                        ply=puzzle.ply,
                        fen=puzzle.fen,
                        side_to_move=puzzle.side_to_move,
                        last_move_uci=puzzle.last_move_uci,
                        herring_pool_id=puzzle.herring_pool_id,
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
        return await _resume_session(
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
        solved_results=[],
    )


# ---------------------------------------------------------------------------
# Solve (POOL-08, Plan 05 Task 1)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RecordedSolve:
    """Internal dataclass returned by `record_solve`.

    `move_quality` (SEED-119) is the three-way scoring tier; `correct_move`
    keeps its exact prior meaning (the SR ladder verdict, `move_quality !=
    "wrong"`). Both are always populated with the FIRST recorded outcome,
    even on a re-submit with a different tier.
    """

    correct_guess: bool
    correct_move: bool
    move_quality: Literal["good", "inaccuracy", "wrong"]
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

    "Still servable" now means two DIFFERENT things depending on `source`
    (Phase 192, D-05 — `drill_solves.game_id` went from `NOT NULL` +
    `CASCADE` to nullable + `SET NULL`, so a deleted game no longer deletes
    the row):

    - `SR_ITEM`: excluded from `remaining` when EITHER its `games` row OR its
      `game_flaws` row has vanished. An orphaned SR row can never be
      attempted (the game it drills is gone), so it must not block
      completion — this is the WR-02 fix's exact reasoning, extended from
      "flaw row gone" to also cover "game row gone". Bug-fix note: this
      `Game.id.isnot(None)` clause is MANDATORY, not optional.
      189-RESEARCH.md's assumption A2 (that the outer join needed no
      parallel `or_` guard here) is wrong: before this phase, a deleted game
      CASCADE-deleted the `drill_solves` row, which is what let `remaining`
      reach 0 in the first place. After `SET NULL`, an orphaned SR row
      survives forever with `solved_at IS NULL` and would pin `remaining`
      above zero, reproducing the exact stuck-session bug WR-02 fixed.
    - `RED_HERRING`: never excluded by EITHER of the two SR clauses below (an
      unsolved herring with a nulled game link is still perfectly servable off
      its `herring_pool` row, D-03, and must keep counting toward `remaining`
      until solved — the opposite of the SR-orphan treatment above). It is
      excluded by its OWN third clause when the `herring_pool` row itself does
      not resolve; see the SEED-123 bug-fix note below.

    Bug fix (SEED-123, 2026-07-28): a herring whose `herring_pool` row does not
    resolve is now excluded from `remaining`. `load_session_puzzles` has always
    skipped such a row ("drop, never serve broken"), so counting it here made it
    unservable AND unsatisfiable: `remaining` could never reach 0 and the session
    stuck on "resume" until `expires_on` passed. This is the same stuck-session
    shape as WR-02 and D-05 above, and it is reachable in normal operation, not
    just across a migration — `drill_solves.herring_pool_id` is `ON DELETE SET
    NULL`, so deleting ANY `herring_pool` row (a prune, a regeneration) orphans
    the pointer on every in-flight session that drew it. The clause tests the
    JOINED ROW (`HerringPool.id`), not `DrillSolve.herring_pool_id`, so a stale
    non-NULL id pointing at a deleted pool row is caught too. Observed in prod on
    2026-07-28: every session composed before the pool was first generated
    carried `herring_pool_id IS NULL` and was unfinishable.

    Bug fix (WR-02, pre-Phase-192): excludes SR-source rows whose backing
    `game_flaws` row has vanished under reclassification. `load_session_puzzles`
    documents this as "lazy eviction" (a delete-then-insert reclassify can
    drop the flaw row a `drill_solves` SR item points at) and simply skips
    serving such a row rather than deleting it — leaving it `solved_at IS
    NULL` forever. Before this fix, this count still treated that row as
    outstanding, so `remaining` could never reach 0 and the session got stuck
    showing "resume" indefinitely (only self-healing once `expires_on`
    passed). The LEFT OUTER JOIN mirrors `load_session_puzzles`'s own
    `existing_flaw_keys` check, keyed the same way: (user_id, game_id, ply).

    The `status = 'open'` guard makes the UPDATE a no-op on a session that's
    already completed, so re-running this after an idempotent re-submit never
    stomps a real `completed_at` with a later timestamp.
    """
    remaining_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .outerjoin(Game, Game.id == DrillSolve.game_id)
        .outerjoin(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillSolve.user_id,
                GameFlaw.game_id == DrillSolve.game_id,
                GameFlaw.ply == DrillSolve.ply,
            ),
        )
        .outerjoin(HerringPool, HerringPool.id == DrillSolve.herring_pool_id)
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.solved_at.is_(None),
            or_(
                DrillSolve.source != DrillSource.SR_ITEM,
                GameFlaw.game_id.isnot(None),
            ),
            # Phase 192 (D-05): mandatory parallel leniency clause — an
            # orphaned SR row (source-game deleted) must be excluded here the
            # same way an orphaned herring must NOT be. See docstring above.
            or_(
                DrillSolve.source != DrillSource.SR_ITEM,
                Game.id.isnot(None),
            ),
            # SEED-123: the herring's own leniency clause, mirroring
            # `load_session_puzzles`'s `if herring_row is None: continue`. A
            # herring that cannot be served must not block completion. Tests
            # the JOINED ROW, not `DrillSolve.herring_pool_id` — the pool row
            # can be deleted out from under a live non-NULL id (SET NULL fires
            # on the FK, but a stale id would still read non-NULL to a naive
            # column check on a row loaded earlier in the same transaction).
            or_(
                DrillSolve.source != DrillSource.RED_HERRING,
                HerringPool.id.isnot(None),
            ),
        )
    )
    remaining = (await session.execute(remaining_stmt)).scalar_one()
    if remaining == 0:
        await session.execute(
            update(DrillSession)
            .where(DrillSession.id == session_id, DrillSession.status == "open")
            .values(status="completed", completed_at=now_utc)
        )
    return remaining == 0


async def _apply_completion_tick(
    session: AsyncSession, *, user_id: int, session_id: int, now_utc: datetime.datetime
) -> None:
    """D-03: tick the shield/count IMMEDIATELY when a session completes,
    correctly composed with the lazy miss walk so neither path can
    double-count or skip a scheduled day.

    Both branches below route through `_judge_one_day` — the SAME shared
    primitive `tick_days`'s lazy walk uses — so this function derives NO
    shield or count value of its own; a divergence gate greps for exactly
    one shield-credit clamp occurrence in the whole `app/` tree, in
    `app/services/train_scheduler.py`.

    Order of operations, all sequential awaits on this ONE `AsyncSession`
    (CLAUDE.md — never `asyncio.gather`):

    1. Resolve `session_date` scoped by `(id, user_id)` together (T-193-07
       IDOR guard) — a foreign or invented `session_id` resolves to nothing
       and this function returns without writing.
    2. `get_or_create_settings` + `local_today` for the current settings row.
    3. `settle_streak_snapshot` FIRST — the lazy walk runs before the
       completion is applied, so every scheduled day whose window has
       already closed is judged before this write, and a completion on a
       later day can never let an earlier missed scheduled day escape
       judgement (RESEARCH.md Pitfall 2). `session_window(today, mask)` is
       strictly after `today`, so today's own scheduled day is never judged
       by this walk — there is no conflict between the two paths on the
       current day.
    4. Choose exactly ONE `DayOutcome` from the POST-settle snapshot
       (`view.settled`), never a stale pre-settle one:
       `"fulfilled"` when `session_date` is scheduled AND
       (`settled_through` is None OR `session_date > settled_through`);
       otherwise `"credit_only"` — an off-day session (D-07) or a late
       completion of an already-frozen day (RESEARCH.md Pitfall 2, Phase 191
       D-18). `"credit_only"` returns `streak_count`/`settled_through`
       unchanged by construction, so the two branches differ ONLY in which
       discriminant is passed.
    5. Persist the already-bounded integers `_judge_one_day` returned — never
       a SQL-side `shield_level + 1` expression, which would bypass the cap
       and could violate `ck_train_settings_shield_level`. The fulfilled
       write keeps the same compare-and-set guard `settle_streak_snapshot`
       uses (so a concurrent settler cannot be overwritten with an older
       boundary); the credit-only write needs no boundary guard because it
       never moves the boundary.

    D-08 needs no code here: only `status='completed'` sessions ever reach
    this function (the caller gates on the claim that just completed the
    session), so a started-and-abandoned session is judged by the lazy walk
    as a plain missed scheduled day, never by this eager path.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        session_id: The `drill_sessions.id` that just completed (untrusted
            client input upstream — resolved only in combination with
            `user_id`).
        now_utc: The current UTC instant.
    """
    session_date_row = (
        await session.execute(
            select(DrillSession.session_date).where(
                DrillSession.id == session_id, DrillSession.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    if session_date_row is None:
        return
    session_date: datetime.date = session_date_row

    settings_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(settings_row.timezone, now_utc)

    view = await settle_streak_snapshot(
        session, user_id=user_id, settings_row=settings_row, today=today
    )
    settled = view.settled

    fulfilled = is_scheduled_day(session_date, settings_row.weekday_mask) and (
        settled.settled_through is None or session_date > settled.settled_through
    )
    outcome: DayOutcome = "fulfilled" if fulfilled else "credit_only"
    judged = _judge_one_day(settled, day=session_date, outcome=outcome)

    if outcome == "fulfilled":
        new_settled_through = judged.settled_through
        await session.execute(
            update(TrainSettings)
            .where(
                TrainSettings.user_id == user_id,
                or_(
                    TrainSettings.streak_settled_through.is_(None),
                    TrainSettings.streak_settled_through < new_settled_through,
                ),
            )
            .values(
                streak_count=judged.streak_count,
                shield_level=judged.shield_level,
                streak_settled_through=new_settled_through,
            )
        )
    else:
        await session.execute(
            update(TrainSettings)
            .where(TrainSettings.user_id == user_id)
            .values(shield_level=judged.shield_level)
        )


async def record_solve(
    session: AsyncSession,
    *,
    user_id: int,
    session_id: int,
    position: int,
    guess: Literal["critical", "several"],
    played_move: str,
    move_quality: Literal["good", "inaccuracy", "wrong"],
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
    6. D-03 (Plan 02): when THIS call's claim (`solved_at IS NULL` -> now
       set) is what just completed the session, call
       `_apply_completion_tick` inside the SAME transaction — a rollback can
       never leave a half-applied tick. Gated on `claimed AND
       session_complete`, not `session_complete` alone: a lost-claim
       re-submit of an already-solved final puzzle also sees
       `session_complete=True` but must not apply a second tick.

    Sequential awaits only — never `asyncio.gather` on this `AsyncSession`.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        session_id: The `drill_sessions.id` the puzzle belongs to (untrusted
            client input — resolved only in combination with `user_id`).
        position: The puzzle's frozen 0-based order within the session.
        guess: The user's pre-attempt "critical vs several fine" guess.
        played_move: The move the user actually played (UCI).
        move_quality: The three-way move-quality tier asserted by the client
            (T-189-18, accepted per SEED-037; SEED-119 widened the boolean to
            a tier). `correct_move` — what feeds `apply_result` and the SR
            ladder — is derived here as `move_quality != "wrong"`, keeping
            the ladder's pass/fail semantics byte-identical to pre-SEED-119
            (an inaccuracy passed then and passes now).
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
    # SEED-119: correct_move is DERIVED from move_quality — this is what
    # keeps the SR ladder's semantics identical to pre-SEED-119 (an
    # inaccuracy passed then and passes now, since it derives to True here).
    correct_move = move_quality != "wrong"
    move_quality_int = int(_MOVE_QUALITY_ENUM[move_quality])

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
            move_quality=move_quality_int,
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
        stored_correct_guess, stored_correct_move, stored_move_quality = (
            correct_guess,
            correct_move,
            move_quality,
        )
        # Phase 192 (D-05): `solve_row.game_id` is `int | None` now that the
        # column is nullable. `DrillItem.game_id` stays NOT NULL + CASCADE
        # (SR items are always sourced from the user's own live or lazily
        # evicted game), so when an SR row's game link has been nulled, the
        # backing `drill_items` row was never created in the first place for
        # this puzzle to exist in a servable session (load_session_puzzles
        # already excludes orphaned SR rows) — there is nothing to advance.
        if is_sr and solve_row.game_id is not None:
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
        # (possibly different) guess/correct_move/move_quality arguments.
        stored = (
            await session.execute(
                select(
                    DrillSolve.correct_guess, DrillSolve.correct_move, DrillSolve.move_quality
                ).where(
                    DrillSolve.session_id == session_id,
                    DrillSolve.position == position,
                    DrillSolve.user_id == user_id,
                )
            )
        ).one()
        stored_correct_guess = bool(stored.correct_guess)
        stored_correct_move = bool(stored.correct_move)
        # Legacy-tier fallback (SEED-119) lives once in _resolve_move_quality_tier
        # — shared with _resume_session's solved_results builder.
        stored_move_quality = _resolve_move_quality_tier(stored.move_quality, stored_correct_move)
        # Same nullability narrowing as the claimed branch above.
        if is_sr and solve_row.game_id is not None:
            item_state = await _read_drill_item_state(
                session, user_id=user_id, game_id=solve_row.game_id, ply=solve_row.ply
            )
            if item_state is not None:
                item_status, streak, due_date = item_state

    session_complete = await _mark_session_complete_if_done(
        session, session_id=session_id, now_utc=now_utc
    )
    # D-03 eager tick: only when THIS call's claim is what just completed the
    # session. `claimed=True` means `solved_at` was NULL before this call
    # (T-193-06's `solved_at IS NULL` claim guard), so before this call the
    # session could not yet have been complete; if it is complete now, this
    # is exactly the transition point, and `_mark_session_complete_if_done`'s
    # own `status = 'open'` guard means that UPDATE fires at most once. A
    # lost-claim / re-submit call (claimed=False) can still see
    # session_complete=True on an already-completed session — gating on
    # `claimed` too is what keeps that resubmit from applying a second tick
    # (the acceptance test this guards: re-submitting an already-solved
    # final puzzle must not grant another shield credit).
    if claimed and session_complete:
        await _apply_completion_tick(
            session, user_id=user_id, session_id=session_id, now_utc=now_utc
        )

    return RecordedSolve(
        correct_guess=stored_correct_guess,
        correct_move=stored_correct_move,
        move_quality=stored_move_quality,
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
    """Internal dataclass returned by `reveal_for_puzzle` on a solved puzzle.

    `game_id` is `int | None` (Phase 192, D-01/D-05): `None` means the
    puzzle's source game has since been deleted — only reachable for a
    `RED_HERRING` row (an orphaned `SR_ITEM` row returns `RevealNotFound`
    instead, see the function docstring).
    """

    game_id: int | None
    ply: int
    fen: str
    played_in_game_san: str | None
    # 190.1-01, D-05: the game move as UCI (SAN -> UCI derivation below) so
    # the client can dispatch its own reveal-time engine search. Same
    # post-attempt 409 gate as every other answer-key field.
    played_in_game_move_uci: str | None
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
    (T-189-17): the puzzle type and in-game move are unreachable before the
    attempt is recorded.

    Phase 192 (D-01/D-05): `Game` and `HerringPool` are now OUTER joins — a
    `RED_HERRING` row's source game can be gone (still fully revealable off
    its `herring_pool` row, D-03), and an `SR_ITEM` row's source game can
    also be gone (D-05, `SET NULL`). AFTER the `not_attempted` gate: when
    `game is None` and `solve.source == SR_ITEM`, this returns `"not_found"`
    — this preserves the exact pre-D-05 behavior, where a deleted game
    CASCADE-deleted the whole `drill_solves` row and the reveal query
    returned no row at all. There is no "reveal an orphaned SR item" state to
    invent; the puzzle simply cannot be re-shown once its source game is
    gone.

    190.1-03 (D-01/D-05): the answer key here is deliberately thin — the
    puzzle type, the in-game move (SAN + UCI), and a tactic-lines pointer.
    The best move, the best line, and every displayed eval are computed
    CLIENT-SIDE by the grading engine (`useTrainGradingEngine.ts`'s
    `gradeMove` and reveal-time searches) — never derived here, never stored,
    never sent over the wire — because a server-stored Stockfish eval and the
    client's own WASM search are not guaranteed to agree bit-for-bit
    (project_eval_nondeterminism), and this endpoint must never be a second,
    contradicting source of truth for a number the reveal panel displays.

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
            select(DrillSolve, Game, HerringPool)
            .outerjoin(Game, Game.id == DrillSolve.game_id)
            .outerjoin(HerringPool, HerringPool.id == DrillSolve.herring_pool_id)
            .where(
                DrillSolve.session_id == session_id,
                DrillSolve.position == position,
                DrillSolve.user_id == user_id,
            )
        )
    ).one_or_none()
    if row is None:
        return "not_found"
    solve, game, herring_row = row
    if solve.solved_at is None:
        return "not_attempted"
    if game is None and solve.source == DrillSource.SR_ITEM:
        # D-05: an orphaned SR row is unservable/unrevealable — this is the
        # exact pre-D-05 CASCADE outcome (the row, and therefore this query's
        # result, used to not exist at all). Never invent a new "reveal with
        # an empty FEN" state for this case.
        return "not_found"

    # D-06 (T-192-02 mitigation): the position lookup resolves the SOURCE
    # GAME'S OWNER (`game.user_id`), not the solving `user_id` — a red
    # herring can be drawn from another user's game, and the pre-D-06 filter
    # returned None (silently degrading `played_in_game_san`) for every
    # cross-user herring even though the game row was perfectly alive. The
    # owner id is resolved server-side from the outer-joined `Game` row,
    # never from request input, so no IDOR seam is opened — and the select
    # list stays exactly `GamePosition.move_san`, never the whole entity or
    # any other column, which is what makes this widening safe rather than a
    # cross-user data leak (a security control, not an optimization). Skipped
    # entirely when `game is None` (only reachable for a herring at this
    # point) — `played_in_game_san` degrades to None per D-08.
    played_in_game_san: str | None = None
    if game is not None:
        position_row = (
            await session.execute(
                select(GamePosition.move_san).where(
                    GamePosition.user_id == game.user_id,
                    GamePosition.game_id == game.id,
                    GamePosition.ply == solve.ply,
                )
            )
        ).one_or_none()
        played_in_game_san = position_row.move_san if position_row is not None else None

    # P-03: game_flaws.fen is board_fen() only (no castling/en-passant) —
    # reconstruct the full FEN the same way composition did. D-03: a herring
    # always reads its FEN off the pool row (never the PGN), alive game-link
    # or not — the only exception to "game is None -> degrade" above.
    if solve.source == DrillSource.RED_HERRING:
        fen = herring_row.fen if herring_row is not None else ""
    else:
        # The not_found gate above already excluded (game is None and
        # source == SR_ITEM), so game is guaranteed non-None here — narrowed
        # explicitly for ty rather than suppressed.
        assert game is not None
        fen = full_fen_at_ply(game.pgn, solve.ply) or ""

    # 190.1-01, D-05: the game move as UCI — SAN -> UCI, never-raise contract,
    # same house try/except shape (app/services/library_service.py:135,
    # app/services/flaws_service.py:407,515).
    played_in_game_move_uci: str | None = None
    if fen and played_in_game_san is not None:
        try:
            board = chess.Board(fen)
            played_in_game_move_uci = board.parse_san(played_in_game_san).uci()
        except (ValueError, chess.IllegalMoveError, AssertionError):
            played_in_game_move_uci = None  # never raise on an unparseable move_san

    if solve.source == DrillSource.RED_HERRING:
        puzzle_type: Literal["sharp", "soft", "herring"] = "herring"
        has_tactic_lines = False
    else:
        # Same not_found-gate invariant as above: source == SR_ITEM implies
        # game is not None by this point.
        assert game is not None
        flaw_row = (
            await session.execute(
                select(GameFlaw)
                .options(undefer(GameFlaw.missed_pv_lines))
                .where(
                    GameFlaw.user_id == user_id,
                    GameFlaw.game_id == game.id,
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
        played_in_game_san=played_in_game_san,
        played_in_game_move_uci=played_in_game_move_uci,
        puzzle_type=puzzle_type,
        source="sr_item" if solve.source == DrillSource.SR_ITEM else "red_herring",
        has_tactic_lines=has_tactic_lines,
    )


__all__ = [
    "ComposedPuzzle",
    "ComposedSession",
    "ProgressSnapshot",
    "RecordedSolve",
    "RevealedPuzzle",
    "TrainSettingsRow",
    "completed_session_in_window",
    "compose_and_materialize_session",
    "expire_stale_sessions",
    "get_or_create_settings",
    "get_progress",
    "get_settings",
    "get_waiting_puzzle_count",
    "load_session_puzzles",
    "open_session_for_user",
    "record_solve",
    "reveal_for_puzzle",
    "settle_streak_snapshot",
    "upsert_settings",
]
