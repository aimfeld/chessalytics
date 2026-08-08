"""Save-and-enqueue service for POST /imports/paste (Phase 208, PASTE-04/06/07).

Orchestrates: normalize_pasted_game (D-16 identity hash) -> a pre-insert
identity lookup (D-17) -> either reuse-with-user_color-update (D-18) on a
hash HIT, or `_flush_batch` insert (D-09 reuse) on a MISS -> a post-insert
game-id lookup (no id in `_flush_batch`'s return, mirrors
store_bot_game_service's Pitfall 2) -> a single commit (the service owns the
transaction; `_flush_batch` itself never commits, WR-05) -> a POST-COMMIT
tier-1 enqueue (D-08). The enqueue call is deliberately OUTSIDE the
persistence try/except and carries its own non-propagating handler: see
"SC-7 post-commit failure window" in 208-03-PLAN.md for why a raised
exception there must not fail the request or roll back the already-committed
row.
"""

import io

import chess.pgn
import sentry_sdk
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories import game_repository
from app.schemas.imports import SavePastedGameRequest, SavePastedGameResponse
from app.services.eval_queue_service import enqueue_tier1_game
from app.services.import_service import _flush_batch
from app.services.normalization import normalize_pasted_game

# Platform constant — the one value this service ever writes/looks up (D-05/D-17).
_PASTE_PLATFORM = "pgn"


async def store_pasted_game(
    session: AsyncSession,
    user_id: int,
    request: SavePastedGameRequest,
) -> SavePastedGameResponse | None:
    """Persist one pasted game as a platform='pgn' Library game and enqueue tier-1.

    Returns None when the PGN is invalid (unparseable, no moves, exceeds
    MAX_PASTED_PGN_PLIES, or has no honest result) — this is an EXPECTED
    validation failure; the caller (imports router) maps None to a 422. No
    Sentry capture and no DB write happen on this path.

    Idempotent on the D-16 identity hash (normalized mainline SAN + canonical
    root FEN, headers and user_color excluded): re-invoking with the same
    game resolves to the existing row (D-17) rather than inserting a second
    one. A re-paste with the OTHER user_color updates the existing row's
    user_color in place (D-18) instead of creating a second row.

    Args:
        session: AsyncSession. This function commits once (on the persistence
            path) — the caller (router) must not also commit.
        user_id: Internal user PK, sourced from current_active_user, never
            from the request body (ASVS V4, T-208-10).
        request: The validated SavePastedGameRequest.

    Returns:
        SavePastedGameResponse with the (new or existing) game_id, a created
        flag, and an eval_status describing the post-commit enqueue outcome
        ("enqueued" | "already_queued" | "already_analyzed" |
        "enqueue_failed" — the last one is still a 200, see the module
        docstring), or None on invalid PGN input.
    """
    normalized = normalize_pasted_game(request.pgn, user_id, request.user_color)
    if normalized is None:
        return None  # expected validation failure — no Sentry capture, no write

    try:
        # D-17: pre-insert identity lookup — a hash HIT reuses the existing
        # row instead of re-normalizing/inserting.
        existing = await game_repository.get_pasted_game_by_identity(
            session, user_id=user_id, platform_game_id=normalized.platform_game_id
        )

        if existing is not None:
            created = False
            game_id = existing.id
            already_analyzed = existing.full_evals_completed_at is not None
            if existing.user_color != request.user_color:
                # D-18: the user's row, their call which side they are
                # studying. game_flaws stores both players' flaws regardless,
                # so nothing needs recomputation — only orientation changes.
                await game_repository.update_game_user_color(
                    session, game_id=game_id, user_id=user_id, user_color=request.user_color
                )
        else:
            # MISS: insert via the existing hot-lane persistence path.
            # Guard against a genuine concurrent race on the same identity:
            # if a duplicate raises IntegrityError on
            # uq_games_user_platform_game_id, roll back to the savepoint,
            # re-run the identity lookup, and continue on the reuse path —
            # a concurrent duplicate must resolve to the existing row with a
            # 2xx, never a 500.
            try:
                async with session.begin_nested():
                    inserted_count = await _flush_batch(session, [normalized], user_id)
                created = inserted_count == 1
                game_id = await game_repository.get_game_id_by_platform_game_id(
                    session, user_id, _PASTE_PLATFORM, normalized.platform_game_id
                )
                if game_id is None:
                    # Should be unreachable: _flush_batch just inserted this
                    # row (or it already existed as a duplicate) under the
                    # same platform_game_id. Never interpolate variables into
                    # the message string (Sentry grouping rule) — attach via
                    # set_context instead.
                    reparsed = chess.pgn.read_game(io.StringIO(normalized.pgn))
                    ply_count = len(list(reparsed.mainline())) if reparsed is not None else None
                    sentry_sdk.set_context(
                        "store_pasted_game", {"user_id": user_id, "ply_count": ply_count}
                    )
                    raise RuntimeError("pasted game row not found after _flush_batch")
                already_analyzed = False
            except IntegrityError:
                existing_after_race = await game_repository.get_pasted_game_by_identity(
                    session, user_id=user_id, platform_game_id=normalized.platform_game_id
                )
                if existing_after_race is None:
                    raise  # genuinely unexpected — not the identity-collision race
                created = False
                game_id = existing_after_race.id
                already_analyzed = existing_after_race.full_evals_completed_at is not None
    except Exception:
        sentry_sdk.set_context("store_pasted_game", {"user_id": user_id})
        sentry_sdk.capture_exception()
        raise

    # This service owns the single transaction — _flush_batch never commits
    # (WR-05); commit the game + positions rows together.
    await session.commit()

    # SC-7 post-commit failure window: the game row is already durably
    # committed above, so an exception here must NOT propagate as a 500 (that
    # would leave a platform='pgn' row with no eval_jobs row and a NULL
    # full_evals_completed_at — precisely the state SC-7 forbids). D-17: skip
    # the call entirely when the reused row is already fully analyzed (no
    # re-enqueue, no wasted engine budget). In every other case call it
    # unconditionally — it is idempotent via on_conflict_do_nothing on the
    # active-job partial index, so an already-queued game is a no-op, and
    # calling it heals a row whose earlier job was purged.
    if already_analyzed:
        return SavePastedGameResponse(
            game_id=game_id, created=created, eval_status="already_analyzed"
        )

    try:
        inserted = await enqueue_tier1_game(game_id=game_id, user_id=user_id)
    except Exception:
        sentry_sdk.set_context(
            "store_pasted_game_enqueue", {"user_id": user_id, "game_id": game_id}
        )
        sentry_sdk.capture_exception()
        # Healing path: re-submitting the same PGN resolves to the same row
        # via the D-16 identity hash (get_pasted_game_by_identity above) and
        # re-enqueues, because this branch is only skipped (already_analyzed)
        # once full_evals_completed_at is set. See 208-03-PLAN.md's
        # "SC-7 post-commit failure window" for why a background sweep cannot
        # be relied on for a guest's orphaned row.
        return SavePastedGameResponse(
            game_id=game_id, created=created, eval_status="enqueue_failed"
        )

    eval_status = "enqueued" if inserted else "already_queued"
    return SavePastedGameResponse(game_id=game_id, created=created, eval_status=eval_status)
