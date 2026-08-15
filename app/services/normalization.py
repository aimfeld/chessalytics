"""Platform-agnostic normalization utilities.

Converts chess.com and lichess game objects into NormalizedGame Pydantic models (D-01).
"""

import datetime
import hashlib
import io
import re
from collections.abc import Mapping, Sequence
from typing import cast

import chess.pgn
import sentry_sdk

from app.schemas.normalization import (
    Color,
    GameResult,
    NormalizedGame,
    Platform,
    Termination,
    TimeControlBucket,
)
from app.services.opening_lookup import find_opening


# Per-move time-control separator used in chess.com "daily" format ("1/86400")
# and in the lichess correspondence normalization ("1/{daysPerTurn*86400}").
# The presence of this separator in a non-empty, non-"-" time-control string
# is the canonical signal that a game is daily/correspondence.
CORRESPONDENCE_TC_SEPARATOR = "/"


def is_correspondence_time_control(time_control_str: str | None) -> bool:
    """Return True when *time_control_str* represents a daily / correspondence game.

    Daily (chess.com) and correspondence (lichess) games encode a per-move time
    allowance as "1/{seconds_per_move}" (e.g. "1/86400" for one day per move).
    The CORRESPONDENCE_TC_SEPARATOR ("/") in a non-empty, non-"-" string is the
    single identifying feature shared by both platforms after normalization.

    Returns False for classical, rapid, blitz, and bullet strings ("1800",
    "600+5", "60+0", "10+0.1") and for None / "" / "-".
    """
    if not time_control_str or time_control_str == "-":
        return False
    return CORRESPONDENCE_TC_SEPARATOR in time_control_str


def _normalize_tc_str(tc_str: str) -> str | None:
    """Normalize time control string: drop +0 suffix when increment is 0."""
    if not tc_str or tc_str == "-":
        return None
    if "+" in tc_str:
        base, inc = tc_str.split("+", 1)
        if inc == "0":
            return base
    return tc_str


def parse_time_control(tc_str: str) -> tuple[TimeControlBucket | None, int | None]:
    """Parse a time control string into (bucket, estimated_seconds).

    Examples:
        '600+0'   -> ('rapid', 600)
        '180+2'   -> ('blitz', 260)   # 180 + 2*40 = 260
        '60+0'    -> ('bullet', 60)
        '900+10'  -> ('rapid', 1300)  # 900 + 10*40 = 1300
        '1/259200' -> ('classical', None)  # daily format
        '-'       -> (None, None)
        ''        -> (None, None)

    Thresholds (estimated duration):
        < 180s   -> bullet
        < 600s   -> blitz
        <= 1800s -> rapid
        else     -> classical
    """
    if not tc_str or tc_str == "-":
        return None, None

    try:
        if "+" in tc_str:
            base_str, increment_str = tc_str.split("+", 1)
            # Use float: chess.com emits fractional increments like "10+0.1" (0.1s bonus).
            # Previously `int("0.1")` raised ValueError, leaving the bucket NULL.
            base = float(base_str)
            increment = float(increment_str)
        elif "/" in tc_str:
            # Daily format like "1/259200" — classify as classical
            return "classical", None
        else:
            base = float(tc_str)
            increment = 0.0
    except (ValueError, AttributeError):
        return None, None

    estimated = int(base + increment * 40)

    if estimated < 180:
        return "bullet", estimated
    elif estimated < 600:
        return "blitz", estimated
    elif estimated <= 1800:
        return "rapid", estimated
    else:
        return "classical", estimated


def parse_base_and_increment(tc_str: str) -> tuple[int | None, float | None]:
    """Parse a time control string into (base_time_seconds, increment_seconds).

    Returns the actual starting clock (int seconds) and per-move increment (float).
    Unlike parse_time_control, this does NOT multiply increment by 40.

    Increment is a float because chess.com emits fractional increments like "10+0.1".

    Examples:
        '600'      -> (600, 0.0)
        '600+0'    -> (600, 0.0)
        '600+5'    -> (600, 5.0)
        '900+10'   -> (900, 10.0)
        '10+0.1'   -> (10, 0.1)
        '1/259200' -> (None, None)  # daily format — no fixed starting clock
        ''         -> (None, None)
        '-'        -> (None, None)
    """
    if not tc_str or tc_str == "-":
        return None, None

    try:
        if "+" in tc_str:
            base_str, increment_str = tc_str.split("+", 1)
            base = float(base_str)
            increment = float(increment_str)
        elif "/" in tc_str:
            # Daily format like "1/259200" — no fixed base clock
            return None, None
        else:
            base = float(tc_str)
            increment = 0.0
    except (ValueError, AttributeError):
        return None, None

    return int(round(base)), increment


# chess.com termination string mapping (losing player's result -> normalized termination)
_CHESSCOM_TERMINATION_MAP: dict[str, Termination] = {
    "checkmated": "checkmate",
    "resigned": "resignation",
    "timeout": "timeout",
    "timevsinsufficient": "draw",
    "agreed": "draw",
    "stalemate": "draw",
    "insufficient": "draw",
    "repetition": "draw",
    "50move": "draw",
    "abandoned": "abandoned",
}

# lichess game status -> normalized termination
_LICHESS_STATUS_MAP: dict[str, Termination] = {
    "mate": "checkmate",
    "resign": "resignation",
    "outoftime": "timeout",
    "draw": "draw",
    "stalemate": "draw",
    "threefoldRepetition": "draw",
    "fiftyMoves": "draw",
    "unknownFinish": "draw",
    "aborted": "abandoned",
    "timeout": "abandoned",
    "noStart": "abandoned",
    "cheat": "unknown",
}

# chess.com PGN Event tag values that indicate a game against a computer
_CHESSCOM_COMPUTER_EVENTS = {"Play vs Coach", "Play vs Computer"}

# chess.com result strings that mean the player won
_CHESSCOM_WIN_RESULTS = {"win"}

# chess.com result strings that mean the game was a draw
_CHESSCOM_DRAW_RESULTS = {
    "agreed",
    "stalemate",
    "insufficient",
    "repetition",
    "timevsinsufficient",
    "50move",
}


def _normalize_chesscom_result(white_result: str, black_result: str) -> GameResult | None:
    """Convert chess.com result strings to standard "1-0"/"0-1"/"1/2-1/2".

    chess.com stores results from each player's perspective:
    - "win" means that player won
    - "checkmated", "resigned", "timeout" etc. mean that player lost
    - "agreed", "stalemate", etc. mean draw

    The actual game outcome is "1-0" if white won, "0-1" if black won,
    "1/2-1/2" for draws.

    Returns None (PRUNE-03 / D-07) when neither side's result string is
    recognized as a win or a draw. The public GameResult literal is
    intentionally NOT widened with an "unknown" member (D-07) — None signals
    the unknown case out-of-band so the caller can skip the game instead.
    """
    if white_result in _CHESSCOM_WIN_RESULTS:
        return "1-0"
    elif black_result in _CHESSCOM_WIN_RESULTS:
        return "0-1"
    elif white_result in _CHESSCOM_DRAW_RESULTS or black_result in _CHESSCOM_DRAW_RESULTS:
        return "1/2-1/2"
    else:
        # FIX (PRUNE-03): this branch used to silently return "1/2-1/2" as a
        # fallback, fabricating a draw for any unrecognized white/black result
        # pair. That corrupted the position-precise WDL stats this product is
        # built on (a malformed/unmapped chess.com result string looked exactly
        # like a genuine draw). Signal "unknown" out-of-band instead — the
        # caller (normalize_chesscom_game) skips the game + Sentry-captures.
        return None


def normalize_chesscom_game(game: dict, username: str, user_id: int) -> NormalizedGame | None:
    """Normalize a chess.com JSON game object to a dict matching Game model columns.

    Returns None if the game is not a standard chess variant.

    Args:
        game: Raw chess.com game object from their API.
        username: The user's chess.com username (case-insensitive comparison).
        user_id: Internal user ID for the database.
    """
    # Filter non-standard variants
    if game.get("rules", "chess") != "chess":
        return None

    white = game["white"]
    black = game["black"]
    white_username = white["username"]
    black_username = black["username"]

    # Determine user's color (case-insensitive)
    username_lower = username.lower()
    if white_username.lower() == username_lower:
        user_color = "white"
        opponent_player = black
    else:
        user_color = "black"
        opponent_player = white

    # PGN string (used for both computer detection and opening lookup)
    pgn_str = game.get("pgn", "") or ""

    # Computer detection via API field
    is_computer_game = bool(opponent_player.get("is_computer", False))
    # Fallback: detect via PGN Event tag (e.g. "Play vs Coach", "Play vs Computer")
    if not is_computer_game:
        event_match = re.search(r'\[Event\s+"([^"]+)"\]', pgn_str)
        if event_match and event_match.group(1) in _CHESSCOM_COMPUTER_EVENTS:
            is_computer_game = True

    # Normalize result
    white_result_str = white.get("result", "")
    black_result_str = black.get("result", "")
    result = _normalize_chesscom_result(white_result_str, black_result_str)
    if result is None:
        # PRUNE-03: unrecognized white/black result combination. Skip the game
        # (flows through the same `if normalized is not None` gate in
        # chesscom_client.py that already skips non-standard variants) rather
        # than persisting a fabricated draw. Variables go in set_context only —
        # never interpolated into the message string (Sentry grouping rule).
        sentry_sdk.set_context(
            "chesscom_result",
            {"white_result": white_result_str, "black_result": black_result_str},
        )
        sentry_sdk.capture_message("Unrecognized chess.com result combination")
        return None

    # Determine termination from the losing side's result string
    if result == "1/2-1/2":
        termination_raw = white_result_str  # both sides have same draw string
    elif result == "1-0":
        termination_raw = black_result_str  # loser's result describes termination
    else:  # 0-1
        termination_raw = white_result_str
    termination = _CHESSCOM_TERMINATION_MAP.get(termination_raw, "unknown")

    # Time control
    tc_str = game.get("time_control", "")
    tc_bucket, tc_seconds = parse_time_control(tc_str)
    base_time_seconds, increment_seconds = parse_base_and_increment(tc_str)

    # Timestamps
    end_time = game.get("end_time")
    played_at = None
    if end_time is not None:
        played_at = datetime.datetime.fromtimestamp(end_time, tz=datetime.timezone.utc)

    # Opening via longest-prefix match against openings.tsv
    opening_eco, opening_name = find_opening(pgn_str)

    # Engine analysis: game-level accuracy (only present for analyzed games)
    accuracies = game.get("accuracies", {})
    white_accuracy: float | None = accuracies.get("white")
    black_accuracy: float | None = accuracies.get("black")

    return NormalizedGame(
        user_id=user_id,
        platform="chess.com",
        platform_game_id=game["uuid"],
        platform_url=game.get("url"),
        pgn=pgn_str,
        result=result,
        user_color=user_color,
        termination_raw=termination_raw,
        termination=termination,
        time_control_str=_normalize_tc_str(tc_str),
        time_control_bucket=tc_bucket,
        time_control_seconds=tc_seconds,
        base_time_seconds=base_time_seconds,
        increment_seconds=increment_seconds,
        rated=bool(game.get("rated", True)),
        is_computer_game=is_computer_game,
        white_username=white_username,
        black_username=black_username,
        white_rating=white.get("rating"),
        black_rating=black.get("rating"),
        opening_name=opening_name,
        opening_eco=opening_eco,
        white_accuracy=white_accuracy,
        black_accuracy=black_accuracy,
        played_at=played_at,
        initial_fen=extract_initial_fen(pgn_str),
    )


def normalize_lichess_game(game: dict, username: str, user_id: int) -> NormalizedGame | None:
    """Normalize a lichess NDJSON game object to a NormalizedGame model.

    Returns None if the game is not a standard chess variant.

    Args:
        game: Raw lichess NDJSON game object.
        username: The user's lichess username (case-insensitive comparison).
        user_id: Internal user ID for the database.
    """
    # Filter non-standard variants
    variant = game.get("variant", {})
    if isinstance(variant, dict):
        variant_key = variant.get("key", "standard")
    else:
        variant_key = str(variant)

    if variant_key != "standard":
        return None

    players = game.get("players", {})
    white_player = players.get("white", {})
    black_player = players.get("black", {})

    # Lichess AI opponents have no `user` object — only `aiLevel`. Surface them
    # with the same display name lichess uses in PGN headers ("lichess AI level N")
    # instead of an empty string.
    def _player_name(player: dict) -> str:
        user = player.get("user") or {}
        name = user.get("name", "")
        if name:
            return name
        ai_level = player.get("aiLevel")
        if ai_level is not None:
            return f"lichess AI level {ai_level}"
        return ""

    white_username = _player_name(white_player)
    black_username = _player_name(black_player)

    # Determine user's color (case-insensitive)
    username_lower = username.lower()
    if white_username.lower() == username_lower:
        user_color: Color = "white"
        opponent_player = black_player
    else:
        user_color = "black"
        opponent_player = white_player

    # Computer detection: opponent is either a BOT-titled account or an `aiLevel` bot.
    # Previously we only checked the BOT title, so stockfish aiLevel games leaked through
    # as human games.
    opponent_title = (opponent_player.get("user") or {}).get("title", "")
    is_computer_game = opponent_title.upper() == "BOT" or opponent_player.get("aiLevel") is not None

    # Result from winner field
    winner = game.get("winner")
    if winner == "white":
        result: GameResult = "1-0"
    elif winner == "black":
        result = "0-1"
    else:
        result = "1/2-1/2"

    # Termination from status field
    status = game.get("status", "unknown")
    termination_raw = status
    termination = _LICHESS_STATUS_MAP.get(status, "unknown")

    # Time control from clock
    clock = game.get("clock")
    tc_bucket: TimeControlBucket | None
    base_time_seconds: int | None
    increment_seconds: float | None
    if clock:
        clock_initial = clock.get("initial", 0)
        clock_increment = clock.get("increment", 0)
        tc_str_raw = f"{clock_initial}+{clock_increment}"
        tc_bucket, tc_seconds = parse_time_control(tc_str_raw)
        tc_str = _normalize_tc_str(tc_str_raw)
        base_time_seconds, increment_seconds = parse_base_and_increment(tc_str_raw)
    elif game.get("speed") == "correspondence":
        # Correspondence games have no clock field — lichess uses daysPerTurn instead.
        # Normalize to chess.com's PGN daily format (1/{seconds_per_move}) so both platforms
        # share a single representation, and bucket as classical (same as chess.com daily).
        days_per_turn = game.get("daysPerTurn")
        tc_str = f"1/{days_per_turn * 86400}" if days_per_turn else None
        tc_bucket = "classical"
        tc_seconds = None
        base_time_seconds = None
        increment_seconds = None
    else:
        tc_str = None
        tc_bucket = None
        tc_seconds = None
        base_time_seconds = None
        increment_seconds = None

    # Timestamp: createdAt is in milliseconds
    created_at_ms = game.get("createdAt")
    if created_at_ms is not None:
        played_at = datetime.datetime.fromtimestamp(created_at_ms / 1000, tz=datetime.timezone.utc)
    else:
        played_at = None

    # PGN (requires pgnInJson=true parameter on lichess request)
    pgn = game.get("pgn", "")

    # Opening via longest-prefix match against openings.tsv
    opening_eco, opening_name = find_opening(pgn)

    game_id = game["id"]

    # Engine analysis: per-player accuracy (only present for analyzed games)
    white_analysis = white_player.get("analysis", {})
    black_analysis = black_player.get("analysis", {})

    return NormalizedGame(
        user_id=user_id,
        platform="lichess",
        platform_game_id=game_id,
        platform_url=f"https://lichess.org/{game_id}",
        pgn=pgn,
        result=result,
        user_color=user_color,
        termination_raw=termination_raw,
        termination=termination,
        time_control_str=tc_str,
        time_control_bucket=tc_bucket,
        time_control_seconds=tc_seconds,
        base_time_seconds=base_time_seconds,
        increment_seconds=increment_seconds,
        rated=bool(game.get("rated", True)),
        is_computer_game=is_computer_game,
        white_username=white_username,
        black_username=black_username,
        white_rating=white_player.get("rating"),
        black_rating=black_player.get("rating"),
        opening_name=opening_name,
        opening_eco=opening_eco,
        white_accuracy=white_analysis.get("accuracy"),
        black_accuracy=black_analysis.get("accuracy"),
        white_acpl=white_analysis.get("acpl"),
        black_acpl=black_analysis.get("acpl"),
        white_inaccuracies=white_analysis.get("inaccuracy"),
        black_inaccuracies=black_analysis.get("inaccuracy"),
        white_mistakes=white_analysis.get("mistake"),
        black_mistakes=black_analysis.get("mistake"),
        white_blunders=white_analysis.get("blunder"),
        black_blunders=black_analysis.get("blunder"),
        played_at=played_at,
        initial_fen=extract_initial_fen(pgn),
    )


# Phase 167 (STORE-01..06): fixed bot username, never a magic string inline (D-08).
FLAWCHESS_BOT_USERNAME = "FlawChess Bot"
# Phase quick-260714-pnk: fallback used for the player-color username column
# when the caller-resolved player_username is unavailable — the caller
# (store_bot_game_service.resolve_player_username) prefers the user's own
# lichess/chess.com username and only falls through to this literal when
# neither is set (D-08 fallback decision).
FLAWCHESS_PLAYER_FALLBACK_USERNAME = "You"

# chess.com/lichess-recognized game result strings (mirrors _CHESSCOM_WIN_RESULTS/
# _LICHESS_STATUS_MAP's closed-vocab convention above).
_VALID_GAME_RESULTS: frozenset[str] = frozenset({"1-0", "0-1", "1/2-1/2"})

# A PGN [Termination "..."] header, when present, maps 1:1 to the Termination
# Literal (RESEARCH Open Question 1 / plan Assumption A1 — Phase 169 coordination
# point: the request schema (D-14) has no explicit termination field, so this is
# the only channel for resignation/timeout/abandoned; checkmate/draw are also
# derivable from the final board state as a fallback below).
_FLAWCHESS_TERMINATION_HEADER_MAP: dict[str, Termination] = {
    "checkmate": "checkmate",
    "resignation": "resignation",
    "timeout": "timeout",
    "draw": "draw",
    "abandoned": "abandoned",
    "unknown": "unknown",
}


def _clock_presence_by_color(
    clock_present: list[bool], start_white_to_move: bool
) -> tuple[bool, bool]:
    """Return (white_has_clock, black_has_clock) for a mainline's per-node clock presence.

    WR-02 fix: `clock_present[i]` is a per-ply flag in mainline order; which color
    played ply `i` depends on `start_white_to_move` (from `game.board().turn`), NOT
    a fixed even=White/odd=Black assumption. A client-supplied SetUp/FEN header pair
    can start the mainline from a Black-to-move position, which would otherwise
    silently swap the color labels attached to each parity group.
    """
    white_has_clock = any(
        present for i, present in enumerate(clock_present) if (i % 2 == 0) == start_white_to_move
    )
    black_has_clock = any(
        present for i, present in enumerate(clock_present) if (i % 2 == 0) != start_white_to_move
    )
    return white_has_clock, black_has_clock


def normalize_flawchess_game(
    pgn_text: str,
    game_uuid: str,
    user_id: int,
    user_color: Color,
    bot_elo: int,
    player_rating: int | None,
    player_username: str,
    tc_str: str,
    *,
    bot_username: str = FLAWCHESS_BOT_USERNAME,
) -> NormalizedGame | None:
    """Build a NormalizedGame from a client-POSTed finished bot-game PGN (D-14).

    PGN-only normalizer — unlike normalize_chesscom_game/normalize_lichess_game,
    there is no platform JSON payload. Every derived field (result, termination,
    clocks-presence gate, ply_count, result_fen, opening) comes from a single
    chess.pgn.read_game() parse; the remaining fields (user_color, bot_elo,
    player_rating, tc_str) are supplied by the caller (store_bot_game_service),
    which derives player_rating server-side from user_rating_anchors (D-05/D-06)
    and never trusts the client for it.

    Returns None (never raises past this function) when the PGN is unparseable,
    has no mainline moves, is missing per-move [%clk] on either color (STORE-02/
    D-15), or has no recognized Result header ("1-0"/"0-1"/"1/2-1/2") — the router
    maps None to a 422. These are expected validation outcomes, NOT bugs: no
    Sentry capture for them (only for a genuinely unexpected parse exception).

    Args:
        pgn_text: The client-submitted PGN (already length-bounded by the
            request schema's MAX_BOT_PGN_LENGTH).
        game_uuid: Client-minted UUID; becomes platform_game_id (D-14, drives
            idempotency via uq_games_user_platform_game_id, D-11).
        user_id: Internal user PK (server-derived from the JWT upstream, D-13).
        user_color: The human player's color in this game.
        bot_elo: The bot's rating for the opponent-color rating column (D-08).
            For a Custom-mode game this is the raw engine dial; for a persona
            game the caller (store_bot_game_service) passes the persona's
            CALIBRATED ELO instead (quick-260722-ucc) — this function itself
            has no opinion, it just places whatever value it receives.
        player_rating: Server-computed converted rating for the player-color
            column, or None when the user has no anchor for this TC bucket
            (D-05/D-06).
        player_username: The human player's display name for the player-color
            username column, already resolved by the caller (store_bot_game_
            service.resolve_player_username: lichess_username -> chess_com_
            username -> "You"). This function never resolves it itself — it
            stays a pure PGN normalizer with no session and no User access.
        tc_str: Time-control string in the same base_seconds+increment_seconds
            format parse_time_control/parse_base_and_increment already expect
            everywhere else in this module (e.g. "180+2") — NOT a minutes-based
            display label.
        bot_username: The bot-color username column value (keyword-only,
            default FLAWCHESS_BOT_USERNAME). The caller passes the persona's
            name for a persona game (quick-260722-ucc); any other caller is
            unaffected by the default.

    Returns:
        A NormalizedGame with platform="flawchess", rated=False,
        is_computer_game=True (D-04), or None on any invalid-input case above.
    """
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        # Genuinely unexpected parse exception (not the expected-None case) —
        # Sentry per the module's set_context convention (Sentry rule).
        sentry_sdk.set_context("flawchess_normalize", {"game_uuid": game_uuid})
        sentry_sdk.capture_exception()
        return None

    if game is None:
        return None  # unparseable PGN — expected 422 case, no Sentry capture

    nodes = list(game.mainline())
    if not nodes:
        return None  # no moves — expected 422 case

    # [%clk] presence gate (STORE-02/D-15) — require at least one clock reading
    # for BOTH colors. WR-02 fix: derive the starting side-to-move from the
    # board (game.board().turn) instead of assuming White always moves first —
    # a client-supplied SetUp/FEN header pair can start the mainline from a
    # Black-to-move position, which would otherwise silently swap the
    # even/odd-index-to-color mapping (even indices are only White's plies
    # when White moves first).
    clock_present = [node.clock() is not None for node in nodes]
    white_has_clock, black_has_clock = _clock_presence_by_color(
        clock_present, start_white_to_move=game.board().turn
    )
    if not (white_has_clock and black_has_clock):
        return None  # expected 422 case, no Sentry capture

    result_str = game.headers.get("Result", "")
    if result_str not in _VALID_GAME_RESULTS:
        return None  # no/invalid Result header — expected 422 case
    result: GameResult = cast(GameResult, result_str)

    # Termination: prefer a closed-vocab [Termination "..."] header (Phase 169
    # coordination point); else derive from the final board state; else "unknown".
    board = game.end().board()
    termination_header = game.headers.get("Termination")
    termination: Termination
    if termination_header is not None and termination_header in _FLAWCHESS_TERMINATION_HEADER_MAP:
        termination = _FLAWCHESS_TERMINATION_HEADER_MAP[termination_header]
        termination_raw = termination_header
    else:
        # CR-02 fix: an unrecognized [Termination "..."] header used to be stored
        # verbatim into termination_raw, unbounded by the length/vocabulary check
        # that gates the `termination` enum. A crafted header longer than 50 chars
        # (games.termination_raw is String(50)) reached the INSERT and crashed
        # _flush_batch with an unhandled Postgres DataError (500) instead of a 422.
        # Never trust an unrecognized/unbounded header string for termination_raw —
        # fall back to the closed-vocabulary board-derived `termination` value.
        if board.is_checkmate():
            termination = "checkmate"
        elif (
            board.is_stalemate()
            or board.is_insufficient_material()
            or board.is_fifty_moves()
            or board.is_repetition(3)
        ):
            termination = "draw"
        else:
            termination = "unknown"
        termination_raw = termination

    tc_bucket, tc_seconds = parse_time_control(tc_str)
    base_time_seconds, increment_seconds = parse_base_and_increment(tc_str)

    # ply_count / result_fen are NOT NormalizedGame fields — _flush_batch's Stage 5
    # (_collect_position_rows -> process_game_pgn) re-parses the PGN and bulk-UPDATEs
    # both columns for every newly inserted game, this one included (D-09 reuse).
    opening_eco, opening_name = find_opening(pgn_text)

    # D-08: converted player rating goes in the player-color column; the bot's
    # nominal ELO goes in the opponent-color column. Bot username is fixed;
    # player username is the caller-resolved platform username (or "You").
    if user_color == "white":
        white_username = player_username
        black_username = bot_username
        white_rating = player_rating
        black_rating = bot_elo
    else:
        white_username = bot_username
        black_username = player_username
        white_rating = bot_elo
        black_rating = player_rating

    return NormalizedGame(
        user_id=user_id,
        platform="flawchess",
        platform_game_id=game_uuid,
        platform_url=None,
        pgn=pgn_text,
        result=result,
        user_color=user_color,
        termination_raw=termination_raw,
        termination=termination,
        time_control_str=_normalize_tc_str(tc_str),
        time_control_bucket=tc_bucket,
        time_control_seconds=tc_seconds,
        base_time_seconds=base_time_seconds,
        increment_seconds=increment_seconds,
        rated=False,
        is_computer_game=True,
        white_username=white_username,
        black_username=black_username,
        white_rating=white_rating,
        black_rating=black_rating,
        opening_name=opening_name,
        opening_eco=opening_eco,
        white_accuracy=None,
        black_accuracy=None,
        played_at=datetime.datetime.now(datetime.timezone.utc),
        # Phase 210 (SEED-042): bot games are always played from the standard
        # start — the Bots page has no custom-position entry point — so this
        # stays NULL rather than being derived from the generated PGN.
        initial_fen=None,
    )


# ---------------------------------------------------------------------------
# Pasted-PGN normalization (Phase 208, PASTE-05 / D-16)
# ---------------------------------------------------------------------------
# Each ply becomes a game_positions row (_flush_batch Stage 5), so this is a
# named write-amplification ceiling on a pasted game's mainline length — no
# magic numbers (CLAUDE.md). 1000 plies is roughly twice the longest recorded
# serious game.
MAX_PASTED_PGN_PLIES = 1000

# The one value normalize_pasted_game ever writes to games.platform (D-05).
_PASTE_PLATFORM_VALUE: Platform = "pgn"

# Fallback username when a [White]/[Black] header is absent or the PGN
# default placeholder "?" — NormalizedGame.white_username/black_username are
# non-optional columns, unlike platform_url/played_at.
_PASTE_UNKNOWN_USERNAME = "Unknown"

# PGN's own placeholder for an unset header (chess.pgn.Headers defaults
# White/Black/Event/Site/Round to this value when absent).
_PGN_UNSET_HEADER_PLACEHOLDER = "?"


def canonical_root_fen(fen: str) -> str:
    """Return the identity-relevant subset of *fen*: piece placement, side to
    move, and castling rights only (D-16).

    The halfmove clock and fullmove number are counters, not identity, and
    the en-passant field is inconsistently produced in the wild — some
    producers emit the ep square on every pawn double-step, others only when
    a capture is actually available. Two sources publishing the same
    [SetUp] position can therefore emit different FEN strings for an
    identical position, which would otherwise defeat D-16's dedup.

    Accepted consequence: a root where an en-passant capture is genuinely
    available hashes identically to the same root without it.

    The FULL, unmodified FEN is still what the board and the stored PGN use —
    only the identity hash sees this canonical form.
    """
    fields = fen.split()
    return " ".join(fields[:3])


# Phase 210 (SEED-042): the [SetUp "1"]/[FEN "..."] header pair that marks a
# PGN as starting from a non-standard position. Both are required — per the PGN
# spec a [FEN] tag without [SetUp "1"] does not establish a custom start, and
# some producers emit a stray [FEN] alongside a standard game.
_PGN_SETUP_MARKER_RE = re.compile(r'\[\s*SetUp\s+"1"\s*\]')
_PGN_FEN_HEADER_RE = re.compile(r'\[\s*FEN\s+"([^"]*)"\s*\]')


def non_standard_root_fen(fen: str) -> str | None:
    """Return *fen* if it is a genuinely non-standard start, else None (D-05).

    Phase 210 (SEED-042). The single place that decides "is this root actually
    custom?", shared by `extract_initial_fen` (header-sourced, chess.com and
    lichess) and `normalize_pasted_game` (board-sourced, already parsed). An
    unparseable FEN is treated as standard: NULL is the safe reading, since the
    game still participates in position matching and only loses its eligibility
    as a SAN-replay root.

    Compares via `canonical_root_fen` so the halfmove clock, fullmove number and
    the inconsistently-emitted en-passant field can't make a standard start look
    custom.
    """
    try:
        chess.Board(fen)
    except ValueError:
        return None

    if canonical_root_fen(fen) == canonical_root_fen(chess.STARTING_FEN):
        return None

    return fen


def extract_initial_fen(pgn: str) -> str | None:
    """Return the game's non-standard starting FEN, or None for a standard start.

    Phase 210 (SEED-042). `games.initial_fen IS NULL` is the canonical "this game
    starts from the standard position" predicate, so this returns None for every
    game that is *effectively* standard, not merely for games lacking the header:

    - No `[SetUp "1"]` marker, or no `[FEN]` header → None.
    - A `[SetUp "1"]`/`[FEN]` pair naming the standard starting position → None
      (D-05). Producers do emit this, and such a game is not custom-start: it
      must stay eligible as an opening-transition sample representative.
    - An unparseable FEN → None rather than a raise (a malformed header is not
      worth failing an import over, and NULL is the safe reading: the game keeps
      contributing to position matching, it just isn't trusted as a SAN root).

    Comparison uses `canonical_root_fen` so the halfmove clock, fullmove number
    and the inconsistently-emitted en-passant field can't make a standard start
    look custom.

    This is the single source of truth for the header shape. The Phase 210
    migration's SQL backfill mirrors it and is pinned by a test asserting the two
    agree on the same inputs (D-06).
    """
    if not _PGN_SETUP_MARKER_RE.search(pgn):
        return None

    match = _PGN_FEN_HEADER_RE.search(pgn)
    if match is None:
        return None

    return non_standard_root_fen(match.group(1).strip())


def pasted_game_identity_hash(root_fen: str, sans: Sequence[str]) -> str:
    """Return a deterministic SHA-256 hex digest identifying a pasted game (D-16).

    The input is the canonical root FEN, a "|" separator, and the mainline
    SAN moves joined by single spaces. Headers are deliberately EXCLUDED: the
    seed's corpus evidence records one player spelled twelve ways, so any
    header-inclusive hash would mean the same game re-pasted from a
    different source produces a second row, defeating D-16's whole point.
    user_color is deliberately excluded too (D-18). Move numbers, annotation
    glyphs and comments never enter the input because the SAN list is
    expected to come from python-chess's own node.san(), which is a function
    of the position alone.

    Accepted residual collision: two genuinely different short games with
    identical moves from identical roots (e.g. a four-move mate) map to one
    row — judged acceptable. The 64 hex characters fit
    games.platform_game_id's String(100), and the unique constraint is
    per-user, so two users pasting the same game never collide.
    """
    input_str = f"{canonical_root_fen(root_fen)}|{' '.join(sans)}"
    return hashlib.sha256(input_str.encode("utf-8")).hexdigest()


# A date/time component containing this marker is PGN's conventional
# "unknown" placeholder (e.g. "????.??.??", "??:??:??") — never a real value.
_PGN_UNKNOWN_DATE_MARKER = "?"


def parse_pgn_played_at(headers: Mapping[str, str]) -> datetime.datetime | None:
    """Derive a tz-aware UTC played_at from PGN headers, or None (D-16 support).

    Prefers UTCDate (+ UTCTime when present and parseable), else falls back
    to Date. Never falls back to the current wall-clock time the way the
    bot-game normalizer does (datetime.now()) — a pasted historical game
    must carry its own date; stamping it with today's date would sort it
    wrongly in the Library and misrepresent the game. Returns None when the
    header is absent, empty, or carries the conventional unknown marker "?"
    in any component.
    """
    utc_date = headers.get("UTCDate")
    if utc_date and _PGN_UNKNOWN_DATE_MARKER not in utc_date:
        utc_time = headers.get("UTCTime")
        if utc_time and _PGN_UNKNOWN_DATE_MARKER not in utc_time:
            try:
                naive = datetime.datetime.strptime(f"{utc_date} {utc_time}", "%Y.%m.%d %H:%M:%S")
                return naive.replace(tzinfo=datetime.timezone.utc)
            except ValueError:
                pass  # fall through to date-only parsing below
        try:
            naive = datetime.datetime.strptime(utc_date, "%Y.%m.%d")
            return naive.replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            pass  # fall through to the Date header below

    date_header = headers.get("Date")
    if date_header and _PGN_UNKNOWN_DATE_MARKER not in date_header:
        try:
            naive = datetime.datetime.strptime(date_header, "%Y.%m.%d")
            return naive.replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            return None

    return None


def _parse_optional_elo(elo_str: str | None) -> int | None:
    """Parse a PGN [WhiteElo]/[BlackElo] header value, or None when absent/unparseable."""
    if not elo_str:
        return None
    try:
        return int(elo_str)
    except ValueError:
        return None


def _resolve_pasted_username(header_value: str | None) -> str:
    """Return *header_value*, or the named fallback when absent/PGN-default "?"."""
    if not header_value or header_value == _PGN_UNSET_HEADER_PLACEHOLDER:
        return _PASTE_UNKNOWN_USERNAME
    return header_value


def normalize_pasted_game(
    pgn_text: str,
    user_id: int,
    user_color: Color,
) -> NormalizedGame | None:
    """Build a NormalizedGame from an arbitrary pasted PGN (Phase 208, D-05/D-07/D-16).

    Derived from normalize_flawchess_game with deliberate divergences: no
    [%clk]-for-both-colors gate (a pasted PGN is untimed by definition,
    D-07), every time-control field forced to None, a deterministic
    D-16 identity hash instead of a caller-supplied UUID, and termination
    ALWAYS derived from the final board state (never a header string,
    CR-02's exact bug class — an untrusted pasted PGN is precisely the
    source that would reproduce it).

    Returns None (never raises past this function) when the PGN is
    unparseable, has no mainline moves, exceeds MAX_PASTED_PGN_PLIES
    (T-208-07 write-amplification bound), or has no honest result (no
    recognized [Result] header AND a non-terminal final board). These are
    expected validation outcomes, NOT bugs: no Sentry capture for them
    (only for a genuinely unexpected parse exception), matching
    normalize_flawchess_game's split.

    Args:
        pgn_text: The pasted PGN text (already length-bounded by the request
            schema, T-208-07's outer bound).
        user_id: Internal user PK.
        user_color: The side the user is studying (D-06 default White,
            D-18 updatable in place on a hash hit without affecting the
            hash itself).

    Returns:
        A NormalizedGame with platform="pgn", rated=False,
        is_computer_game=False, or None on any invalid-input case above.
    """
    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
    except Exception:
        # Genuinely unexpected parse exception (not an expected-None case) —
        # Sentry per the module's set_context convention (never interpolate
        # variable data into the message string).
        sentry_sdk.set_context("pasted_game_normalize", {"user_id": user_id})
        sentry_sdk.capture_exception()
        return None

    if game is None:
        return None  # unparseable PGN — expected case, no Sentry capture

    nodes = list(game.mainline())
    if not nodes:
        return None  # no moves — expected case, no Sentry capture

    if len(nodes) > MAX_PASTED_PGN_PLIES:
        return None  # T-208-07 write-amplification bound — expected case

    # WR-02: derive the root FEN from game.board() (honors [SetUp]/[FEN],
    # including a Black-to-move root) rather than assuming the standard
    # start. SANs come from node.san() — a function of the position alone,
    # never the raw movetext (D-16: no move numbers/glyphs/comments).
    root_fen = game.board().fen()
    sans = [node.san() for node in nodes]

    board = game.end().board()
    result_str = game.headers.get("Result", "")
    result: GameResult
    if result_str in _VALID_GAME_RESULTS:
        result = cast(GameResult, result_str)
    elif board.is_checkmate():
        # board.turn is the side TO MOVE at the final position, i.e. the side
        # that has just been checkmated and therefore lost.
        result = "0-1" if board.turn else "1-0"
    elif (
        board.is_stalemate()
        or board.is_insufficient_material()
        or board.is_fifty_moves()
        or board.is_repetition(3)
    ):
        result = "1/2-1/2"
    else:
        # No recognized [Result] header and a non-terminal final board — no
        # honest value exists (games.result is NOT NULL over a 3-value enum,
        # unlike GameResult which stays unwidened per D-07 elsewhere in this
        # module). Expected case for an unfinished broadcast game — no
        # Sentry capture.
        return None

    # Termination: ALWAYS the board-derived closed-vocabulary value, never a
    # [Termination] header lookup (CR-02 fix carried forward — an
    # unrecognized/oversized header string reaching termination_raw crashed
    # the INSERT with an unhandled Postgres DataError instead of a
    # validation failure, and arbitrary pasted PGN is exactly the untrusted
    # source that reproduces it).
    termination: Termination
    if board.is_checkmate():
        termination = "checkmate"
    elif (
        board.is_stalemate()
        or board.is_insufficient_material()
        or board.is_fifty_moves()
        or board.is_repetition(3)
    ):
        termination = "draw"
    else:
        termination = "unknown"
    termination_raw = termination

    opening_eco, opening_name = find_opening(pgn_text)

    return NormalizedGame(
        user_id=user_id,
        platform=_PASTE_PLATFORM_VALUE,
        platform_game_id=pasted_game_identity_hash(root_fen, sans),
        platform_url=None,
        pgn=pgn_text,
        result=result,
        user_color=user_color,
        termination_raw=termination_raw,
        termination=termination,
        time_control_str=None,
        time_control_bucket=None,
        time_control_seconds=None,
        base_time_seconds=None,
        increment_seconds=None,
        rated=False,
        is_computer_game=False,
        white_username=_resolve_pasted_username(game.headers.get("White")),
        black_username=_resolve_pasted_username(game.headers.get("Black")),
        white_rating=_parse_optional_elo(game.headers.get("WhiteElo")),
        black_rating=_parse_optional_elo(game.headers.get("BlackElo")),
        opening_name=opening_name,
        opening_eco=opening_eco,
        white_accuracy=None,
        black_accuracy=None,
        # Never fall back to wall-clock time (unlike normalize_flawchess_game)
        # — a pasted historical game must carry its own date; today's date
        # would sort it wrongly in the Library and misrepresent the game.
        played_at=parse_pgn_played_at(game.headers),
        # Phase 210 (SEED-042): root_fen is already derived from game.board()
        # above (WR-02, honoring [SetUp]/[FEN]) for the identity hash — persist
        # it here too, so a pasted custom-start game seeds /analysis from its own
        # root. Board-sourced rather than header-sourced, so it only needs the
        # standard-start check, not the header parse.
        initial_fen=non_standard_root_fen(root_fen),
    )
