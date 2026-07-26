"""Train router: session composition (Phase 189).

D-05 (LOCKED): Train is not available to guest accounts. Every handler calls
`_reject_guest` as its FIRST statement — an explicit 403 gate, not an
inference from an empty pool result (Pitfall 7 in 189-RESEARCH.md).
"""

from __future__ import annotations

import datetime
from typing import Annotated

import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.models.user import User
from app.repositories import train_repository
from app.schemas.train import (
    PuzzleRevealResponse,
    SolveRequest,
    SolveResponse,
    TrainPuzzle,
    TrainSessionResponse,
    TrainSettingsResponse,
    TrainSettingsUpdate,
)
from app.users import current_active_user

router = APIRouter(prefix="/train", tags=["train"])


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
) -> TrainSessionResponse:
    """Compose a Train session from the user's own qualifying blunders (POOL-01/07).

    The user id always comes from `current_active_user.id` — never from a
    request body or path parameter (V4/IDOR guard, T-189-01).
    """
    _reject_guest(user)
    try:
        composed = await train_repository.compose_and_materialize_session(
            session, user_id=user.id, now_utc=datetime.datetime.now(datetime.timezone.utc)
        )
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("train", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    return TrainSessionResponse(
        session_id=composed.session_id,
        session_date=composed.session_date,
        expires_on=composed.expires_on,
        puzzle_count=composed.puzzle_count,
        requested_count=composed.requested_count,
        solved_count=composed.solved_count,
        blob_pending_count=composed.blob_pending_count,
        puzzles=[
            TrainPuzzle(
                position=p.position,
                game_id=p.game_id,
                ply=p.ply,
                fen=p.fen,
                side_to_move=p.side_to_move,
                last_move_uci=p.last_move_uci,
            )
            for p in composed.puzzles
        ],
    )


@router.post("/sessions/{session_id}/solve", response_model=SolveResponse)
async def solve_puzzle(
    session_id: int,
    body: SolveRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
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
            correct_move=body.correct_move,
            now_utc=datetime.datetime.now(datetime.timezone.utc),
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
        puzzle_type=recorded.puzzle_type,
        item_status=recorded.item_status,
        streak=recorded.streak,
        due_date=recorded.due_date,
        session_complete=recorded.session_complete,
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
    )


@router.put("/settings", response_model=TrainSettingsResponse)
async def update_train_settings(
    body: TrainSettingsUpdate,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> TrainSettingsResponse:
    """Persist the user's Train settings (timezone, weekday mask, session size).

    Deliberately does NOT re-snap existing `drill_items.due_date` values when
    `weekday_mask` changes: a due date landing on a newly unscheduled day
    simply means the item is already due (`due_date <= today`), which
    composition already handles correctly — a re-snap would add a
    migration-shaped side effect for no behavioral gain (the one place this
    handler deliberately does NOT follow `users.py`'s diff-driven-side-effect
    pattern).
    """
    _reject_guest(user)
    settings_row = await train_repository.upsert_settings(
        session,
        user_id=user.id,
        timezone=body.timezone,
        weekday_mask=body.weekday_mask,
        puzzles_per_session=body.puzzles_per_session,
    )
    await session.commit()
    return TrainSettingsResponse(
        timezone=settings_row.timezone,
        weekday_mask=settings_row.weekday_mask,
        puzzles_per_session=settings_row.puzzles_per_session,
    )


__all__ = ["router"]
