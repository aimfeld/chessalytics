"""Train router: session composition (Phase 189).

D-05 (LOCKED): Train is not available to guest accounts. Every handler calls
`_reject_guest` as its FIRST statement — an explicit 403 gate, not an
inference from an empty pool result (Pitfall 7 in 189-RESEARCH.md).

Every time-dependent handler takes "now" from the `dev_now_utc` dependency
rather than calling `datetime.now()` inline, so the dev clock override can
shift the whole Train calendar (weekday mask, session expiry, due-date
ladder, streak weeks) without waiting real days. Outside
`ENVIRONMENT == "development"` that dependency IS the real clock — see
`app/core/dev_clock.py`.
"""

from __future__ import annotations

import datetime
from typing import Annotated

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.dev_clock import dev_now_utc
from app.models.user import User
from app.repositories import train_repository
from app.schemas.train import (
    PuzzleRevealResponse,
    SolveRequest,
    SolveResponse,
    SolvedResult,
    TrainProgressResponse,
    TrainPuzzle,
    TrainSessionResponse,
    TrainSettingsResponse,
    TrainSettingsUpdate,
    VettedMove,
)
from app.users import current_active_user

router = APIRouter(prefix="/train", tags=["train"])

#: The current UTC instant, dev-clock-shiftable. Real clock outside development.
NowUtc = Annotated[datetime.datetime, Depends(dev_now_utc)]


def _reject_guest(user: User) -> None:
    """D-05: explicit gate, not an empty-result inference.

    Every /train/* handler calls this before touching any pool/session/
    settings repository — centralized so no route can forget it (Pitfall 7).
    """
    if user.is_guest:
        raise HTTPException(status_code=403, detail="Train requires a full account")


@router.post("/sessions", response_model=TrainSessionResponse)
async def compose_or_resume_session(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    now_utc: NowUtc,
) -> TrainSessionResponse:
    """Compose a Train session from the user's own qualifying blunders (POOL-01/07).

    The user id always comes from `current_active_user.id` — never from a
    request body or path parameter (V4/IDOR guard, T-189-01).
    """
    _reject_guest(user)
    try:
        composed = await train_repository.compose_and_materialize_session(
            session, user_id=user.id, now_utc=now_utc
        )
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("train", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    puzzles: list[TrainPuzzle] = []
    for p in composed.puzzles:
        # Phase 192 Plan 02: `ComposedPuzzle.game_id` and `TrainPuzzle.game_id`
        # are both `int | None` (D-01/D-05) — a herring composed from an
        # already-orphaned pool row (its source game deleted before this
        # composition ran) legitimately has `game_id=None` here. No narrowing
        # needed; the client hides the (n/a) Analyze deep-link for a null
        # game_id (D-09).
        puzzles.append(
            TrainPuzzle(
                position=p.position,
                game_id=p.game_id,
                ply=p.ply,
                fen=p.fen,
                side_to_move=p.side_to_move,
                last_move_uci=p.last_move_uci,
            )
        )
    solved_results = [
        SolvedResult(correct_guess=r.correct_guess, move_quality=r.move_quality)
        for r in composed.solved_results
    ]
    return TrainSessionResponse(
        session_id=composed.session_id,
        session_date=composed.session_date,
        expires_on=composed.expires_on,
        puzzle_count=composed.puzzle_count,
        requested_count=composed.requested_count,
        solved_count=composed.solved_count,
        blob_pending_count=composed.blob_pending_count,
        puzzles=puzzles,
        solved_results=solved_results,
        is_warmup=composed.is_warmup,
    )


@router.post("/sessions/{session_id}/solve", response_model=SolveResponse)
async def solve_puzzle(
    session_id: int,
    body: SolveRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    now_utc: NowUtc,
) -> SolveResponse:
    """Record one puzzle's outcome and advance the interval ladder (POOL-08).

    The user id always comes from `current_active_user.id` — never from a
    request body or path parameter (V4/IDOR guard, T-189-16), mirroring
    `app/routers/users.py`'s update handlers.
    """
    _reject_guest(user)
    try:
        recorded = await train_repository.record_solve(
            session,
            user_id=user.id,
            session_id=session_id,
            position=body.position,
            guess=body.guess,
            played_move=body.played_move,
            move_quality=body.move_quality,
            now_utc=now_utc,
        )
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("train", {"user_id": str(user.id), "session_id": session_id})
        sentry_sdk.capture_exception()
        raise
    if recorded is None:
        await session.rollback()
        raise HTTPException(status_code=404, detail="Puzzle not found")
    await session.commit()
    return SolveResponse(
        correct_guess=recorded.correct_guess,
        correct_move=recorded.correct_move,
        move_quality=recorded.move_quality,
        puzzle_type=recorded.puzzle_type,
        source=recorded.source,
        item_status=recorded.item_status,
        streak=recorded.streak,
        due_date=recorded.due_date,
        session_complete=recorded.session_complete,
        # Phase 211 (D-01/D-03): the domain VettedMove maps field-by-field
        # onto its wire twin — only uci/quality cross the wire.
        vetted_moves=[VettedMove(uci=v.uci, quality=v.quality) for v in recorded.vetted_moves],
        graded_es_before=recorded.graded_es_before,
        graded_es_after=recorded.graded_es_after,
    )


@router.get("/sessions/{session_id}/puzzles/{position}/reveal", response_model=PuzzleRevealResponse)
async def reveal_puzzle(
    session_id: int,
    position: int,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> PuzzleRevealResponse:
    """Return the post-attempt answer key for one puzzle (POOL-10 reveal gate).

    409 while `solved_at` is still NULL (T-189-17): the answer key, puzzle
    type, and in-game move are unreachable before the attempt is recorded.
    """
    _reject_guest(user)
    try:
        result = await train_repository.reveal_for_puzzle(
            session, user_id=user.id, session_id=session_id, position=position
        )
    except Exception:
        sentry_sdk.set_context("train", {"user_id": str(user.id), "session_id": session_id})
        sentry_sdk.capture_exception()
        raise
    if result == "not_found":
        raise HTTPException(status_code=404, detail="Puzzle not found")
    if result == "not_attempted":
        raise HTTPException(status_code=409, detail="Puzzle not yet attempted")
    return PuzzleRevealResponse(
        game_id=result.game_id,
        ply=result.ply,
        fen=result.fen,
        played_in_game_san=result.played_in_game_san,
        played_in_game_move_uci=result.played_in_game_move_uci,
        puzzle_type=result.puzzle_type,
        source=result.source,
        has_tactic_lines=result.has_tactic_lines,
        motif=result.motif,
    )


@router.get("/progress", response_model=TrainProgressResponse)
async def get_train_progress(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    now_utc: NowUtc,
) -> TrainProgressResponse:
    """Return the per-day tick snapshot + honest mastered/parked counts (PROG-01/PROG-04).

    This GET legitimately commits: settlement is lazy-on-read, so a
    successful call may advance `train_settings.streak_count`/
    `shield_level`/`streak_settled_through`/`pool_eligible_since` (a
    guarded, monotonic, idempotent write — see
    `train_repository.settle_streak_snapshot`/`_stamp_pool_eligibility`) in
    addition to the ordinary settings create-on-first-touch.
    """
    _reject_guest(user)
    try:
        progress = await train_repository.get_progress(session, user_id=user.id, now_utc=now_utc)
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("train", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    return TrainProgressResponse(
        session_streak_count=progress.session_streak_count,
        shield_level=progress.shield_level,
        current_week_completed=progress.current_week_completed,
        current_week_required=progress.current_week_required,
        streak_reset_notice=progress.streak_reset_notice,
        mastered_count=progress.mastered_count,
        parked_count=progress.parked_count,
        waiting_count=progress.waiting_count,
        pool_state=progress.pool_state,
        next_due_date=progress.next_due_date,
        badge_visible=progress.badge_visible,
    )


@router.get("/settings", response_model=TrainSettingsResponse)
async def get_train_settings(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> TrainSettingsResponse:
    """Return the user's Train settings, creating the D-06/D-07/D-08 defaults on first touch."""
    _reject_guest(user)
    settings_row = await train_repository.get_or_create_settings(session, user_id=user.id)
    await session.commit()
    return TrainSettingsResponse(
        timezone=settings_row.timezone,
        weekday_mask=settings_row.weekday_mask,
        puzzles_per_session=settings_row.puzzles_per_session,
        reminder_enabled=settings_row.reminder_enabled,
        reminder_hour=settings_row.reminder_hour,
        reminder_intent_at=settings_row.reminder_intent_at,
    )


@router.put("/settings", response_model=TrainSettingsResponse)
async def update_train_settings(
    body: TrainSettingsUpdate,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    now_utc: NowUtc,
) -> TrainSettingsResponse:
    """Persist the user's Train settings (timezone, weekday mask, session size).

    Deliberately does NOT re-snap existing `drill_items.due_date` values when
    `weekday_mask` changes: a due date landing on a newly unscheduled day
    simply means the item is already due (`due_date <= today`), which
    composition already handles correctly — a re-snap would add a
    migration-shaped side effect for no behavioral gain (the one place this
    handler deliberately does NOT follow `users.py`'s diff-driven-side-effect
    pattern).

    D-18 (Phase 191 Plan 02): this PUT settles every fully-elapsed unsettled
    week using the OLD `weekday_mask`/timezone BEFORE persisting the new
    values (`train_repository.upsert_settings`'s settle-before-mutate step),
    so a user who reschedules after several inactive weeks has those weeks
    judged by the schedule that was actually in force.

    Phase 201 D-18: this endpoint also round-trips `reminder_enabled`/
    `reminder_hour`, so the whole reminder configuration is exercisable with
    curl before Phase 202 builds any UI -- no backend work leaks into that
    UI phase.

    Phase 203 (OFFER-03/D-02): also round-trips `reminder_intent_at`. It is
    required-but-nullable on `TrainSettingsUpdate` (not defaulted), so a
    body that omits the key 422s rather than silently clearing a
    previously-recorded install intent -- the full-replace contract's
    loud-failure guarantee.
    """
    _reject_guest(user)
    settings_row = await train_repository.upsert_settings(
        session,
        user_id=user.id,
        timezone=body.timezone,
        weekday_mask=body.weekday_mask,
        puzzles_per_session=body.puzzles_per_session,
        reminder_enabled=body.reminder_enabled,
        reminder_hour=body.reminder_hour,
        reminder_intent_at=body.reminder_intent_at,
        now_utc=now_utc,
    )
    await session.commit()
    return TrainSettingsResponse(
        timezone=settings_row.timezone,
        weekday_mask=settings_row.weekday_mask,
        puzzles_per_session=settings_row.puzzles_per_session,
        reminder_enabled=settings_row.reminder_enabled,
        reminder_hour=settings_row.reminder_hour,
        reminder_intent_at=settings_row.reminder_intent_at,
    )


__all__ = ["router"]
