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
from app.models.train_settings import TrainSettings
from app.services.best_move_candidates import mover_color_for_ply
from app.services.train_pool import (
    answer_key_present,
    blob_pending_stmt,
    classify_puzzle_type,
    compose_slots,
    fen_and_last_move_at_ply,
    full_fen_at_ply,
    herring_stmt,
    pool_entry_stmt,
)
from app.services.train_scheduler import (
    DEFAULT_PUZZLES_PER_SESSION,
    DEFAULT_TIMEZONE,
    DEFAULT_WEEKDAY_MASK,
    FlameState,
    ItemState,
    SettledStreak,
    StreakView,
    apply_result,
    is_session_expired,
    local_today,
    required_sessions_per_week,
    session_window,
    settle_weeks,
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


@dataclass(frozen=True)
class TrainSettingsRow:
    """Internal dataclass for a single train_settings row.

    Frozen (immutable) per CLAUDE.md internal-structured-data rule. Mirrors
    `app.repositories.user_import_settings_repository.ImportSettingsRow`.

    `streak_count`/`flame_state`/`streak_settled_through` are the Phase 191
    D-18 settled-streak snapshot fields (added alongside the original D-06/
    D-07/D-08 fields, not a separate row type).
    """

    timezone: str
    weekday_mask: int
    puzzles_per_session: int
    streak_count: int
    flame_state: FlameState | None
    streak_settled_through: datetime.date | None


@dataclass(frozen=True)
class ComposedPuzzle:
    """Internal dataclass for one puzzle within a composed/resumed session."""

    position: int
    game_id: int
    ply: int
    fen: str
    side_to_move: Literal["white", "black"]
    last_move_uci: str | None


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
        streak_count=row.streak_count,
        flame_state=FlameState(row.flame_state) if row.flame_state is not None else None,
        streak_settled_through=row.streak_settled_through,
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
        # D-18: a brand-new row's settled-streak snapshot is all-null —
        # exactly the state that triggers a full-history replay on first
        # settlement (D-05 retroactivity).
        streak_count=0,
        flame_state=None,
        streak_settled_through=None,
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
        flame_state=None,
        streak_settled_through=None,
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

    D-18 settle-before-mutate (Phase 191 Plan 02, Task 3): settlement runs
    STRICTLY BEFORE any new value is applied, judged against the OLD mask and
    OLD timezone:

    1. `old_row = await get_or_create_settings(...)` — reading this BEFORE
       applying any new value is load-bearing. Reading it AFTER would settle
       every fully-elapsed unsettled week against the NEW schedule instead of
       the one that was actually in force, silently reintroducing the
       retroactive re-judging D-18 forbids. A user who was inactive for
       several elapsed weeks and then reschedules must have those weeks
       judged by the OLD schedule.
    2. `today = local_today(old_row.timezone, now_utc)` — resolved from the
       OLD timezone, because a timezone change moves Mon-Sun week
       boundaries, and the elapsed weeks being settled belong to the old
       frame, not the new one.
    3. `await settle_streak_snapshot(..., settings_row=old_row, today=today)`
       — Plan 01's single settlement entry point, reused verbatim; no second
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
    # RETURNING: this UPDATE never touches streak_count/flame_state/
    # streak_settled_through — the settle-before-mutate step above is the
    # only writer of those three columns in this function — so read back
    # whatever the row holds after that settlement (either the brand-new
    # insert's server defaults or an existing row's just-settled snapshot)
    # rather than fabricating a value here.
    stmt = stmt.returning(
        TrainSettings.streak_count, TrainSettings.flame_state, TrainSettings.streak_settled_through
    )
    result = await session.execute(stmt)
    streak_count, flame_state, streak_settled_through = result.one()
    return TrainSettingsRow(
        timezone=timezone,
        weekday_mask=weekday_mask,
        puzzles_per_session=puzzles_per_session,
        streak_count=streak_count,
        flame_state=FlameState(flame_state) if flame_state is not None else None,
        streak_settled_through=streak_settled_through,
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

    No enum-to-wire mapping table is needed: `FlameState` is a `StrEnum`
    whose members already equal the TEXT column values and the wire
    literals.
    """

    settled_streak_weeks: int
    flame_state: FlameState | None
    current_week_completed: int
    current_week_required: int | None
    streak_lost_last_week: bool
    mastered_count: int
    parked_count: int
    waiting_count: int
    pool_state: Literal["no_material", "exhausted", "available"]
    next_due_date: datetime.date | None


async def settle_streak_snapshot(
    session: AsyncSession, *, user_id: int, settings_row: TrainSettingsRow, today: datetime.date
) -> StreakView:
    """Settle any fully-elapsed unsettled weeks and persist the advance (D-18).

    THE SINGLE settlement entry point, shared by `GET /train/progress` (here)
    and `PUT /train/settings` (Plan 04's settle-before-mutate). Reads the
    user's `status='completed'` `drill_sessions.session_date` values (no
    ordering needed — `settle_weeks` buckets internally), builds the input
    `SettledStreak` from `settings_row`'s three snapshot fields, calls
    `settle_weeks`, and persists the advanced snapshot IF AND ONLY IF
    `view.changed` is True.

    This is a read endpoint that writes, so it is documented plainly here:
    the write is a **compare-and-set UPDATE** guarded on the settlement
    boundary strictly advancing (`streak_settled_through IS NULL OR <
    new_settled_through`). Two concurrent callers that both settle the same
    weeks compute identical results from the same input snapshot, so a
    duplicate write is harmless — the guard exists only to stop a slower
    request from writing an OLDER boundary over a newer one.
    `streak_settled_through` therefore only ever moves forward, and a call
    with `changed=False` issues no statement at all.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        settings_row: The user's current `TrainSettingsRow` (already
            resolved via `get_or_create_settings`).
        today: The local calendar day (from `local_today`).
    """
    dates_result = await session.execute(
        select(DrillSession.session_date).where(
            DrillSession.user_id == user_id, DrillSession.status == "completed"
        )
    )
    completed_session_dates = [row[0] for row in dates_result.all()]

    snapshot = SettledStreak(
        streak_count=settings_row.streak_count,
        flame_state=settings_row.flame_state,
        settled_through=settings_row.streak_settled_through,
    )
    view = settle_weeks(
        snapshot,
        completed_session_dates,
        weekday_mask=settings_row.weekday_mask,
        today=today,
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
                flame_state=(
                    view.settled.flame_state.value if view.settled.flame_state is not None else None
                ),
                streak_settled_through=new_settled_through,
            )
        )

    return view


async def get_progress(
    session: AsyncSession, *, user_id: int, now_utc: datetime.datetime
) -> ProgressSnapshot:
    """Return the full Train progress read-model (PROG-01/PROG-04).

    Sequential awaits only — never `asyncio.gather` on this `AsyncSession`
    (CLAUDE.md). Steps: `get_or_create_settings`, resolve today's local date,
    `settle_streak_snapshot` (the only write this function can reach besides
    the settings create-on-first-touch), then two `_count_drill_items_by_status`
    calls for mastered/parked. `current_week_required` is `None` when
    `weekday_mask == 0` ("train anytime" has no denominator to show), else
    `required_sessions_per_week(weekday_mask)`.

    `flame_state` in the returned snapshot is `view.display_flame` (the D-03
    overlay) — NOT `view.settled.flame_state`. The persisted value and the
    displayed value differ by design during an unsettled first week (D-03:
    the minimum flame lights immediately after the first completed session,
    while the count and the stored snapshot stay at their pre-settlement
    values).

    `waiting_count`/`pool_state`/`next_due_date` (Phase 191 Plan 02) reuse
    the same already-resolved `settings_row`/`today` — `get_waiting_puzzle_count`
    is never called with a freshly re-fetched settings row or a re-derived
    date within this function.

    Args:
        session: AsyncSession. Caller commits.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        now_utc: The current UTC instant (converted to a local date via
            `local_today` — called exactly ONCE in this path).
    """
    settings_row = await get_or_create_settings(session, user_id=user_id)
    today = local_today(settings_row.timezone, now_utc)

    view = await settle_streak_snapshot(
        session, user_id=user_id, settings_row=settings_row, today=today
    )

    mastered_count = await _count_drill_items_by_status(
        session, user_id=user_id, status=DrillStatus.MASTERED
    )
    parked_count = await _count_drill_items_by_status(
        session, user_id=user_id, status=DrillStatus.PARKED
    )

    current_week_required = (
        None
        if settings_row.weekday_mask == 0
        else required_sessions_per_week(settings_row.weekday_mask)
    )

    blob_pending_count = (await session.execute(blob_pending_stmt(user_id))).scalar_one()
    waiting_count = await get_waiting_puzzle_count(
        session, user_id=user_id, settings_row=settings_row, today=today
    )
    pool_state = await _pool_state(
        session,
        user_id=user_id,
        waiting_count=waiting_count,
        blob_pending_count=blob_pending_count,
    )
    next_due_date = await _next_due_date(session, user_id=user_id, today=today)

    return ProgressSnapshot(
        settled_streak_weeks=view.settled.streak_count,
        flame_state=view.display_flame,
        current_week_completed=view.current_week_completed,
        current_week_required=current_week_required,
        streak_lost_last_week=view.streak_lost_last_week,
        mastered_count=mastered_count,
        parked_count=parked_count,
        waiting_count=waiting_count,
        pool_state=pool_state,
        next_due_date=next_due_date,
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
    session: AsyncSession, *, user_id: int, waiting_count: int, blob_pending_count: int
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
        session: AsyncSession.
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        waiting_count: The result of `get_waiting_puzzle_count` for this
            request (resolved once by the caller, never re-derived here).
        blob_pending_count: The result of `blob_pending_stmt` for this
            request (resolved once by the caller, never re-derived here).
    """
    has_drill_items = (
        await session.execute(
            select(select(DrillItem.user_id).where(DrillItem.user_id == user_id).exists())
        )
    ).scalar_one()
    has_pool_candidates = (
        await session.execute(select(pool_entry_stmt(user_id).exists()))
    ).scalar_one()

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
    frozen composition order), joined to `games` for the PGN and rebuilt into
    a `ComposedPuzzle` via `fen_and_last_move_at_ply`. Scoped by `user_id` in the WHERE
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
    """
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

    Compares against the session's OWN `requested_count` snapshot, NEVER its
    `puzzle_count` — a session can legitimately serve fewer puzzles than
    requested when the pool is short on material (the D-14 "short session"
    state), and re-checking that same shortfall on every subsequent call
    would churn the session_id for no reason. `requested_count is None`
    (pre-migration rows, or a test fixture that seeds a session directly
    without going through composition) is always treated as "not resized" —
    the conservative default of resuming as-is.
    """
    if drill_session.requested_count is None or drill_session.requested_count == requested_count:
        return False
    solved_count_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .where(DrillSolve.session_id == drill_session.id, DrillSolve.solved_at.isnot(None))
    )
    solved_so_far = (await session.execute(solved_count_stmt)).scalar_one()
    if solved_so_far > 0:
        return False
    await session.execute(delete(DrillSession).where(DrillSession.id == drill_session.id))
    return True


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

    # --- Reconstruct FENs + arriving move, dropping (never backfilling)
    # unparseable puzzles ---
    reconstructed: list[tuple[int, int, str, str | None, Literal["white", "black"], int]] = []
    for game_id, ply, game in sr_candidates:
        result = fen_and_last_move_at_ply(game.pgn, ply)
        if result is None:
            continue
        fen, last_move_uci = result
        reconstructed.append(
            (game_id, ply, fen, last_move_uci, mover_color_for_ply(ply), DrillSource.SR_ITEM)
        )
    for game_id, ply, game in herring_candidates:
        result = fen_and_last_move_at_ply(game.pgn, ply)
        if result is None:
            continue
        fen, last_move_uci = result
        reconstructed.append(
            (game_id, ply, fen, last_move_uci, mover_color_for_ply(ply), DrillSource.RED_HERRING)
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
        )

    # D-09: deterministic (user_id, session_date)-seeded shuffle so a red
    # herring's slot is never inferable from a fixed SR-then-herring layout,
    # and re-composition (e.g. this same call) is reproducible.
    random.Random(f"{user_id}:{today.isoformat()}").shuffle(reconstructed)

    surviving_sr_keys = {
        (gid, ply)
        for gid, ply, _fen, _last_move_uci, _side, source in reconstructed
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
                requested_count=n,
                expires_on=session_window(today, settings_row.weekday_mask),
            )
            session.add(drill_session)
            # Populate drill_session.id for the DrillSolve FK below, and
            # surface uq_drill_sessions_user_open here if a concurrent
            # request already won the race.
            await session.flush()

            puzzles: list[ComposedPuzzle] = []
            for position, (game_id, ply, fen, last_move_uci, side_to_move, source) in enumerate(
                reconstructed
            ):
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
                        last_move_uci=last_move_uci,
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

    "Still servable" excludes `drill_solves` rows whose `games` row has since
    vanished (mirrors `load_session_puzzles`'s lazy-eviction posture — a
    deleted game can never be attempted, so it must not block completion).

    Bug fix (WR-02): ALSO excludes SR-source rows whose backing `game_flaws`
    row has vanished under reclassification. `load_session_puzzles` already
    documents this as "lazy eviction" (a delete-then-insert reclassify can
    drop the flaw row a `drill_solves` SR item points at) and simply skips
    serving such a row rather than deleting it — leaving it `solved_at IS
    NULL` forever. Before this fix, this count still treated that row as
    outstanding, so `remaining` could never reach 0 and the session got stuck
    showing "resume" indefinitely (only self-healing once `expires_on`
    passed). The LEFT OUTER JOIN mirrors `load_session_puzzles`'s own
    `existing_flaw_keys` check, keyed the same way: (user_id, game_id, ply).
    Red herrings carry no `game_flaws` row by design (source != SR_ITEM), so
    they're never excluded here regardless of the join's outcome.

    The `status = 'open'` guard makes the UPDATE a no-op on a session that's
    already completed, so re-running this after an idempotent re-submit never
    stomps a real `completed_at` with a later timestamp.
    """
    remaining_stmt = (
        select(func.count())
        .select_from(DrillSolve)
        .join(Game, Game.id == DrillSolve.game_id)
        .outerjoin(
            GameFlaw,
            and_(
                GameFlaw.user_id == DrillSolve.user_id,
                GameFlaw.game_id == DrillSolve.game_id,
                GameFlaw.ply == DrillSolve.ply,
            ),
        )
        .where(
            DrillSolve.session_id == session_id,
            DrillSolve.solved_at.is_(None),
            or_(
                DrillSolve.source != DrillSource.SR_ITEM,
                GameFlaw.game_id.isnot(None),
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
        if stored.move_quality is not None:
            stored_move_quality = _MOVE_QUALITY_LITERAL[DrillMoveQuality(stored.move_quality)]
        else:
            # Legacy row recorded before SEED-119: no stored tier exists, so
            # degrade from the stored boolean — True maps to the good tier
            # (the pre-tiering era only ever recorded a full move point),
            # False maps to the wrong tier.
            stored_move_quality = "good" if stored_correct_move else "wrong"
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
    """Internal dataclass returned by `reveal_for_puzzle` on a solved puzzle."""

    game_id: int
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
            select(GamePosition.move_san).where(
                GamePosition.user_id == user_id,
                GamePosition.game_id == solve.game_id,
                GamePosition.ply == solve.ply,
            )
        )
    ).one_or_none()
    played_in_game_san = position_row.move_san if position_row is not None else None

    # P-03: game_flaws.fen is board_fen() only (no castling/en-passant) —
    # reconstruct the full FEN the same way composition did.
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
