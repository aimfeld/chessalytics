"""Position bookmarks router: CRUD + reorder endpoints for position bookmarks.

HTTP layer only — all DB operations go through position_bookmark_repository.
"""

import io
from typing import Annotated

import chess
import chess.pgn
import sentry_sdk
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.models.game import Game
from app.models.game_position import GamePosition
from app.models.user import User
from app.repositories import position_bookmark_repository
from app.schemas.position_bookmarks import (
    Color,
    MatchSideUpdateRequest,
    PositionBookmarkCreate,
    PositionBookmarkReorderRequest,
    PositionBookmarkResponse,
    PositionBookmarkUpdate,
    PositionSuggestion,
    SuggestionsResponse,
)
from app.services.opening_lookup import find_opening
from app.users import current_active_user

router = APIRouter(prefix="/position-bookmarks", tags=["position-bookmarks"])


async def _build_position_suggestion(
    session: AsyncSession,
    user_id: int,
    color: Color,
    white_hash: int,
    black_hash: int,
    full_hash: int,
    game_count: int,
) -> PositionSuggestion | None:
    """Build one suggestion for a most-played position, or `None` to signal skip.

    Extracted from get_suggestions's per-position loop body, including the FEN
    reconstruction try/except (216-06, zero behavior change): same skip
    conditions (no representative game row, no PGN, unparseable/malformed
    PGN), same Sentry capture on the FEN-reconstruction exception. Kept in
    this router module rather than a service module: position_bookmarks has
    no existing service layer (only position_bookmark_repository), and this
    phase is a depth fix, not a layering refactor.
    """
    # Find a representative game for this position
    stmt = (
        select(GamePosition.game_id, GamePosition.ply)
        .where(
            GamePosition.full_hash == full_hash,
            GamePosition.user_id == user_id,
        )
        .limit(1)
    )
    gp_result = await session.execute(stmt)
    gp_row = gp_result.first()
    if gp_row is None:
        return None

    game_id, ply = gp_row.game_id, gp_row.ply

    pgn_stmt = select(Game.pgn).where(Game.id == game_id)
    pgn_result = await session.execute(pgn_stmt)
    pgn = pgn_result.scalar_one_or_none()
    if pgn is None:
        return None

    # Reconstruct FEN and SAN moves at the target ply using python-chess
    try:
        game = chess.pgn.read_game(io.StringIO(pgn))
        if game is None:
            return None
        board = game.board()
        san_moves: list[str] = []
        for i, move in enumerate(game.mainline_moves()):
            if i >= ply:
                break
            san_moves.append(board.san(move))
            board.push(move)
        position_fen = board.fen()
    except Exception:
        sentry_sdk.set_context("suggestion", {"game_id": game_id, "ply": ply})
        sentry_sdk.set_tag("source", "api")
        sentry_sdk.capture_exception()
        return None

    # Look up opening name from SAN moves
    opening_pgn = " ".join(san_moves)
    opening_eco, opening_name = find_opening(opening_pgn)

    return PositionSuggestion(
        white_hash=str(white_hash),
        black_hash=str(black_hash),
        full_hash=str(full_hash),
        fen=position_fen,
        moves=san_moves,
        color=color,
        game_count=game_count,
        opening_name=opening_name,
        opening_eco=opening_eco,
    )


# NOTE: /suggestions MUST be defined BEFORE /{id} so FastAPI does not attempt to
# parse "suggestions" as an integer bookmark ID.
@router.get("/suggestions", response_model=SuggestionsResponse)
async def get_suggestions(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> SuggestionsResponse:
    """Return up to 5 white + 5 black position bookmark suggestions from most-played openings.

    Suggestions are derived from the user's most frequently played positions in ply range 6-14.
    Already-bookmarked positions are excluded. Each suggestion includes FEN, SAN moves,
    opening name/ECO, game count, and a recommended piece filter (mine vs both).
    """
    PLY_MIN = 2
    PLY_MAX = 8
    LIMIT_PER_COLOR = 5

    # Get target_hashes of positions already bookmarked (for deduplication)
    existing_target_hashes = await position_bookmark_repository.get_existing_target_hashes(
        session, user.id
    )

    suggestions: list[PositionSuggestion] = []

    for color in ("white", "black"):
        top_positions = await position_bookmark_repository.get_top_positions_for_color(
            session,
            user_id=user.id,
            color=color,
            ply_min=PLY_MIN,
            ply_max=PLY_MAX,
            limit=LIMIT_PER_COLOR,
            exclude_target_hashes=existing_target_hashes,
        )

        for white_hash, black_hash, full_hash, game_count in top_positions:
            suggestion = await _build_position_suggestion(
                session, user.id, color, white_hash, black_hash, full_hash, game_count
            )
            if suggestion is not None:
                suggestions.append(suggestion)

    return SuggestionsResponse(suggestions=suggestions)


@router.get("", response_model=list[PositionBookmarkResponse])
async def list_bookmarks(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> list[PositionBookmarkResponse]:
    """Return all position bookmarks for the current user, ordered by sort_order."""
    bookmarks = await position_bookmark_repository.get_bookmarks(session, user.id)
    return [PositionBookmarkResponse.model_validate(b) for b in bookmarks]


@router.post("", response_model=PositionBookmarkResponse, status_code=201)
async def create_bookmark(
    data: PositionBookmarkCreate,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> PositionBookmarkResponse:
    """Create a new position bookmark for the current user."""
    bookmark = await position_bookmark_repository.create_bookmark(session, user.id, data)
    return PositionBookmarkResponse.model_validate(bookmark)


# NOTE: /reorder MUST be defined BEFORE /{id} so FastAPI does not interpret
# "reorder" as an integer bookmark ID.
@router.put("/reorder", response_model=list[PositionBookmarkResponse])
async def reorder_bookmarks(
    data: PositionBookmarkReorderRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> list[PositionBookmarkResponse]:
    """Reorder position bookmarks by assigning sort_order 0..N-1 in the provided order."""
    bookmarks = await position_bookmark_repository.reorder_bookmarks(session, user.id, data.ids)
    return [PositionBookmarkResponse.model_validate(b) for b in bookmarks]


@router.put("/{bookmark_id}", response_model=PositionBookmarkResponse)
async def update_bookmark(
    bookmark_id: int,
    data: PositionBookmarkUpdate,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> PositionBookmarkResponse:
    """Update label and/or sort_order for a position bookmark owned by the current user."""
    bookmark = await position_bookmark_repository.update_bookmark(
        session, user.id, bookmark_id, data
    )
    if bookmark is None:
        raise HTTPException(status_code=404, detail="Position bookmark not found")
    return PositionBookmarkResponse.model_validate(bookmark)


@router.delete("/{bookmark_id}", status_code=204)
async def delete_bookmark(
    bookmark_id: int,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> Response:
    """Delete a position bookmark owned by the current user."""
    deleted = await position_bookmark_repository.delete_bookmark(session, user.id, bookmark_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Position bookmark not found")
    return Response(status_code=204)


@router.patch(
    "/{bookmark_id}/match-side",
    response_model=PositionBookmarkResponse,
)
async def update_match_side(
    bookmark_id: int,
    data: MatchSideUpdateRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> PositionBookmarkResponse:
    """Update match_side for a position bookmark, recomputing target_hash from the stored FEN."""
    bookmark = await position_bookmark_repository.update_match_side(
        session, bookmark_id, user.id, data.match_side
    )
    if bookmark is None:
        raise HTTPException(status_code=404, detail="Position bookmark not found")
    return PositionBookmarkResponse.model_validate(bookmark)
