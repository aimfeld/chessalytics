"""Pydantic schema for normalized game data from chess.com and lichess.

Created per D-01: Pydantic models at system boundaries (external API input).
"""

import datetime
from typing import Literal

from pydantic import BaseModel

# Literal types for fields with fixed value sets (per CLAUDE.md)
# "flawchess" and "pgn" are analytics-excluded values — see
# app.repositories.query_utils.DEFAULT_EXCLUDED_PLATFORMS, the single seam
# that decides analytics eligibility for every Platform member (Phase 208 D-05).
Platform = Literal["chess.com", "lichess", "flawchess", "pgn"]
GameResult = Literal["1-0", "0-1", "1/2-1/2"]
Color = Literal["white", "black"]
Termination = Literal["checkmate", "resignation", "timeout", "draw", "abandoned", "unknown"]
TimeControlBucket = Literal["bullet", "blitz", "rapid", "classical"]


class NormalizedGame(BaseModel):
    """Typed representation of a normalized game from chess.com or lichess.

    Created per D-01: Pydantic models at system boundaries (external API input).
    Uses Literal types for fixed-value fields per CLAUDE.md.
    """

    user_id: int
    platform: Platform
    platform_game_id: str
    platform_url: str | None
    pgn: str
    result: GameResult
    user_color: Color
    termination_raw: str  # Raw platform-specific string, no fixed set
    termination: Termination
    time_control_str: str | None
    time_control_bucket: TimeControlBucket | None
    time_control_seconds: int | None
    rated: bool
    is_computer_game: bool
    white_username: str
    black_username: str
    white_rating: int | None
    black_rating: int | None
    opening_name: str | None
    opening_eco: str | None
    white_accuracy: float | None
    black_accuracy: float | None
    played_at: datetime.datetime | None
    # per-game base clock fields (optional, default None)
    base_time_seconds: int | None = None
    increment_seconds: float | None = None
    # lichess-only analysis fields (optional, default None)
    white_acpl: int | None = None
    black_acpl: int | None = None
    white_inaccuracies: int | None = None
    black_inaccuracies: int | None = None
    white_mistakes: int | None = None
    black_mistakes: int | None = None
    white_blunders: int | None = None
    black_blunders: int | None = None
