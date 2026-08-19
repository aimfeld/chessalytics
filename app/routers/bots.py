"""Bots router: POST /api/bots/games endpoint (Phase 167, STORE-01..06).

HTTP layer only — validation, auth, service call, response/422 mapping. All
persistence/rating-derivation logic lives in store_bot_game_service.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.models.user import User
from app.repositories import game_repository
from app.schemas.bots import PersonaWinsResponse, StoreBotGameRequest, StoreBotGameResponse
from app.services import store_bot_game_service
from app.users import current_active_user

router = APIRouter(prefix="/bots", tags=["bots"])

# Static prose half of the 422 body; the machine-readable half is the
# FlawchessRejectReason the service returns.
_INVALID_PGN_MESSAGE = "Invalid PGN or missing [%clk] annotations"


@router.post("/games", response_model=StoreBotGameResponse, status_code=200)
async def store_game(
    data: StoreBotGameRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> StoreBotGameResponse:
    """Persist a finished bot game as a platform='flawchess' Library game.

    user_id is derived from the authenticated JWT — never from the request
    body (ASVS V4). current_active_user covers guests too (D-13) — same
    dependency, no special-casing.

    Returns 422 when the PGN is invalid: unparseable, missing per-move
    [%clk] on either color (STORE-02/D-15), or no recognized Result header.
    The body carries a closed-vocabulary `reason` (FlawchessRejectReason)
    alongside the static message: the frontend captures the response `detail`
    into its Sentry event (lib/queryClient.ts), and without a reason every
    rejection looked identical in Sentry and the cause had to be inferred
    from the code. The message stays variable-free so Sentry grouping is
    unaffected (CLAUDE.md Sentry rule).
    """
    result = await store_bot_game_service.store_bot_game(session, user.id, data)
    if isinstance(result, str):
        raise HTTPException(
            status_code=422,
            detail={"reason": result, "message": _INVALID_PGN_MESSAGE},
        )
    return result


@router.get("/persona-wins", response_model=PersonaWinsResponse, status_code=200)
async def get_persona_wins(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> PersonaWinsResponse:
    """Return per-persona win counts for the authenticated user (Phase 185, T-185-02).

    user_id is derived from the authenticated JWT — never from a request
    parameter (ASVS V4). No cross-user win-count leakage: current_active_user
    is the only source of scope.
    """
    return await game_repository.count_wins_by_persona(session, user.id)
