"""Store-on-finish service for POST /bots/games (Phase 167, STORE-01/03/05/06).

Orchestrates: server-side rating derivation (D-05/D-06/D-07) -> PGN-only
normalization (normalize_flawchess_game_or_reason) -> the existing hot-lane persistence
path (import_service._flush_batch, D-09) -> a game-id lookup (Pitfall 2, no id
in _flush_batch's return) -> a post-insert PGN header stamp + targeted UPDATE
(quick-260714-qaj, D-07 — the `Site` deep link needs the auto-increment
`games.id`) -> the one-to-one bot_game_settings insert -> a single commit
(D-10). The service owns the transaction boundary; _flush_batch itself never
commits (WR-05).
"""

import sentry_sdk
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.bot_game_settings import BotGameSettings
from app.repositories import game_repository, user_rating_anchors_repository, user_repository
from app.schemas.bots import RatingSource, StoreBotGameRequest, StoreBotGameResponse
from app.services.bot_game_pgn import build_bot_game_url, stamp_bot_game_headers
from app.services.import_service import _flush_batch
from app.services.normalization import (
    FLAWCHESS_BOT_USERNAME,
    FLAWCHESS_PLAYER_FALLBACK_USERNAME,
    FlawchessRejectReason,
    normalize_flawchess_game_or_reason,
    parse_time_control,
)

# Platform constant — the one value this service ever writes/looks up (D-04/D-17).
_FLAWCHESS_PLATFORM = "flawchess"


def _derive_rating_source(
    n_lichess_games: int,
    n_chesscom_games: int,
) -> RatingSource:
    """Derive rating_source from anchor provenance (D-07).

    Only called when an anchor row exists, so at least one of the two counts
    is guaranteed to be > 0 (fetch_anchors_for_user never persists a row with
    both zero).
    """
    if n_lichess_games > 0 and n_chesscom_games > 0:
        return "blended"
    if n_lichess_games > 0:
        return "lichess"
    return "chesscom"


def resolve_player_username(
    lichess_username: str | None,
    chess_com_username: str | None,
) -> str:
    """Resolve the display name for the human side of a stored bot game.

    Precedence (quick-260714-pnk): lichess_username -> chess_com_username ->
    FLAWCHESS_PLAYER_FALLBACK_USERNAME ("You"). A blank or whitespace-only
    column is treated as absent (falls through to the next link in the
    chain) — the users table columns are nullable String(100) with no
    non-empty CHECK, so an empty string is reachable via the profile-update
    endpoint.

    Args:
        lichess_username: The user's lichess username, or None/blank.
        chess_com_username: The user's chess.com username, or None/blank.

    Returns:
        The resolved, stripped display name.
    """
    stripped_lichess = (lichess_username or "").strip()
    if stripped_lichess:
        return stripped_lichess

    stripped_chesscom = (chess_com_username or "").strip()
    if stripped_chesscom:
        return stripped_chesscom

    return FLAWCHESS_PLAYER_FALLBACK_USERNAME


async def store_bot_game(
    session: AsyncSession,
    user_id: int,
    request: StoreBotGameRequest,
) -> StoreBotGameResponse | FlawchessRejectReason:
    """Persist one finished bot game as a platform='flawchess' Library game.

    Returns a FlawchessRejectReason (a plain string, never a StoreBotGameResponse)
    when the PGN is invalid (unparseable, missing [%clk] on either color, or no
    recognized Result header) — this is an EXPECTED validation failure
    (STORE-02/D-15); the caller (bots router) maps the reason to a 422 body. No
    Sentry capture and no DB write happen on this path.

    Idempotent on request.game_uuid (D-11): re-invoking with the same
    game_uuid returns the existing game_id with created=False, and does NOT
    insert a second games row or a second bot_game_settings row.

    Args:
        session: AsyncSession. This function commits once (D-10) — the caller
            (router) must not also commit.
        user_id: Internal user PK, sourced from current_active_user (D-13),
            never from the request body (ASVS V4).
        request: The validated StoreBotGameRequest.

    Returns:
        StoreBotGameResponse with the (new or existing) game_id and a
        created flag, or a FlawchessRejectReason on invalid PGN input.
    """
    # D-05/D-06: player rating is server-computed from the user's rating
    # anchor for the game's TC bucket; NULL when no anchor (guest or no
    # imported games in that bucket). D-07: rating_source derived from the
    # anchor's platform provenance.
    tc_bucket, _ = parse_time_control(request.tc_preset)
    anchors = await user_rating_anchors_repository.fetch_anchors_for_user(session, user_id=user_id)
    anchor_row = anchors.get(tc_bucket) if tc_bucket is not None else None

    player_rating: int | None
    rating_source: RatingSource | None
    if anchor_row is None:
        player_rating = None
        rating_source = None
    else:
        player_rating = anchor_row.anchor_rating
        rating_source = _derive_rating_source(
            anchor_row.n_lichess_games, anchor_row.n_chesscom_games
        )

    # quick-260714-pnk: resolve the player's display name from their own
    # profile (never the request body — T-pnk-01 spoofing mitigation). The
    # row is guaranteed to exist: games.user_id is an FK, so a missing row
    # is already a hard failure today.
    user = await user_repository.get_profile(session, user_id)
    player_username = resolve_player_username(user.lichess_username, user.chess_com_username)

    # quick-260722-ucc: persona games store the persona's own name + CALIBRATED
    # ELO instead of the generic "FlawChess Bot" / the raw engine dial. Both
    # fields are None for a Custom-mode game, preserving current behavior.
    bot_username = request.persona_name or FLAWCHESS_BOT_USERNAME
    bot_rating = request.bot_rating if request.bot_rating is not None else request.bot_elo

    normalized = normalize_flawchess_game_or_reason(
        request.pgn,
        request.game_uuid,
        user_id,
        request.user_color,
        bot_rating,
        player_rating,
        player_username,
        request.tc_preset,
        bot_username=bot_username,
    )
    if isinstance(normalized, str):
        # A FlawchessRejectReason — STORE-02/D-15, expected: no Sentry capture,
        # no commit. Handed straight to the router, which puts it in the 422
        # body so a rejection is diagnosable from the client-side Sentry event.
        return normalized

    try:
        inserted_count = await _flush_batch(session, [normalized], user_id)
        created = inserted_count == 1

        game_id = await game_repository.get_game_id_by_platform_game_id(
            session, user_id, _FLAWCHESS_PLATFORM, request.game_uuid
        )
        if game_id is None:
            # Should be unreachable: _flush_batch just inserted this row (or it
            # already existed as a duplicate) under the same platform_game_id.
            raise RuntimeError("flawchess game row not found after _flush_batch")

        if created:
            # D-11: guard so a duplicate re-submit (created=False) never
            # double-inserts the one-to-one settings row NOR rewrites the
            # already-stored PGN (T-qaj-03).
            session.add(
                BotGameSettings(
                    game_id=game_id,
                    nominal_elo=request.bot_elo,
                    play_style_blend=request.play_style_blend,
                    tc_preset=request.tc_preset,
                    rating_source=rating_source,
                )
            )

            # quick-260714-qaj/D-07: both the PGN's `Site` header and the
            # `platform_url` column need the row's real auto-increment
            # `games.id`, which only exists post-INSERT — so both are written
            # here, once, in a second targeted UPDATE, from the same
            # build_bot_game_url so they cannot diverge. _flush_batch's Stage 5
            # position parse already ran against the raw client PGN and is
            # unaffected (header-only change, the mainline is untouched).
            stamped_pgn = stamp_bot_game_headers(
                normalized=normalized,
                game_id=game_id,
                tc_preset=request.tc_preset,
                rating_source=rating_source,
                play_style_blend=request.play_style_blend,
            )
            await game_repository.update_bot_game_pgn_and_url(
                session, game_id, stamped_pgn, build_bot_game_url(game_id)
            )

            # Phase 185 (T-185-01): persist persona_id here too, same
            # created-gate, same "no data no-op on duplicate resubmit"
            # reasoning (D-11). None (custom-mode games) is a no-op — the
            # column stays NULL, matching its default.
            if request.persona_id is not None:
                await game_repository.update_bot_game_persona_id(
                    session, game_id, request.persona_id
                )
    except Exception:
        sentry_sdk.set_context(
            "store_bot_game", {"user_id": user_id, "game_uuid": request.game_uuid}
        )
        sentry_sdk.capture_exception()
        raise

    # D-10: this service owns the single transaction — _flush_batch never
    # commits (WR-05); commit the game + positions + settings row together.
    await session.commit()

    return StoreBotGameResponse(game_id=game_id, created=created)
