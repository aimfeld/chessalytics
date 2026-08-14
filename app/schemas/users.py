"""Pydantic v2 schemas for user profile API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, field_validator

from app.core.platform_usernames import extract_platform_username
from app.repositories.query_utils import AnalyticsPlatform
from app.schemas.admin import ImpersonationContext
from app.schemas.normalization import TimeControlBucket


class CurrentStrengthRung(BaseModel):
    """Provenance of a recent-games-derived current-strength estimate.

    Quick 260811-u11 (SEED-147). ``converted`` is False only for a native
    Lichess blitz rung; every other rung was mapped onto the Lichess blitz
    scale by ``normalize_to_lichess_blitz`` before comparison, so it always
    carries some conversion error.
    """

    platform: AnalyticsPlatform
    time_control_bucket: TimeControlBucket
    n_games: int
    window_days: int
    converted: bool


class CurrentStrengthResponse(BaseModel):
    """The opponent-matching current-strength estimate (Quick 260811-u11, SEED-147).

    Separate from the ``user_rating_anchors`` career-median anchor the
    percentile chip reads -- this value answers "who should I play right
    now", not "how do I compare over the long run". ``rung`` is non-None
    exactly when ``source == "recent_games"``; when no rung passes the
    90-day/20-game activity floor, ``source`` is "rating_anchor" and ``rung``
    is None.

    UI DEFAULT ONLY -- never fed into bot move selection (BOT-03). This
    value seeds the Bots page's PersonaGrid rating line, the custom-bot ELO
    default, and the analysis board's free-play ELO default; it must never
    reach the bot's move-selection budget.
    """

    rating: int
    source: Literal["recent_games", "rating_anchor"]
    rung: CurrentStrengthRung | None


class UserProfileResponse(BaseModel):
    """Response for GET/PUT /users/me/profile."""

    email: str
    is_superuser: bool
    is_guest: bool
    chess_com_username: str | None
    lichess_username: str | None
    created_at: datetime
    last_login: datetime | None
    chess_com_game_count: int
    lichess_game_count: int
    chess_com_last_sync_at: datetime | None = None
    lichess_last_sync_at: datetime | None = None
    # D-22: populated when the request's JWT has is_impersonation=true.
    # Frontend uses this to render the header pill (phase 62).
    impersonation: ImpersonationContext | None = None
    # BETA-01: beta_enabled flag (e.g. Endgame Insights). Default false; flipped via direct DB op.
    beta_enabled: bool
    # Quick 260811-u11 (SEED-147): the opponent-matching current-strength
    # estimate, replacing `lichess_blitz_equivalent_rating` (P-01) -- that
    # field had zero readers left once all three opponent-matching surfaces
    # repointed here, and the anchor fallback (D-07) now happens server-side
    # inside this field's resolution instead of at each call site. None for
    # guests, for users with no anchor at all, and for users with anchors
    # only in non-blitz buckets and no qualifying recent games (deliberate,
    # not a bug); the frontend falls back to 1500. UI DEFAULT ONLY -- never
    # fed into bot move selection (BOT-03).
    current_strength: CurrentStrengthResponse | None = None


class UserProfileUpdate(BaseModel):
    """Request body for PUT /users/me/profile."""

    chess_com_username: str | None = None
    lichess_username: str | None = None

    # D-03: per-field validators pinned to that field's own platform, so a
    # chess.com URL pasted into lichess_username (or vice versa) is not
    # silently rewritten -- it is left unchanged and rejected downstream by
    # the platform API instead.
    @field_validator("chess_com_username", mode="before")
    @classmethod
    def _extract_chess_com_username(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return extract_platform_username(value, "chess.com")

    @field_validator("lichess_username", mode="before")
    @classmethod
    def _extract_lichess_username(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return extract_platform_username(value, "lichess")


class GameCountResponse(BaseModel):
    """Response for GET /users/games/count."""

    count: int


class ImportSettingsResponse(BaseModel):
    """Response for GET/PATCH /users/me/import-settings.

    Phase 186 Plan 01 (IMPORT-01/IMPORT-04). `game_cap` is a `Literal`, never
    a bare `int` (CLAUDE.md V5 rule) -- mirrors the DB
    `ck_user_import_settings_cap` CHECK constraint at the schema boundary.
    """

    tc_bullet: bool
    tc_blitz: bool
    tc_rapid: bool
    tc_classical: bool
    game_cap: Literal[1000, 3000, 5000]
    # Per-(platform, TC) count of ALL imported games (not just the pre-anchor
    # backlog), e.g. {"chess.com": {"blitz": 2705, "rapid": 1643}}. Populated by
    # count_imported_by_platform_and_tc so the per-TC chips read as an honest
    # breakdown of the header's total game count (UAT follow-up to Plan 03).
    # NULL-bucket games are omitted (no TC chip); empty dict is a valid "no
    # games yet" response, not a sentinel for "not computed".
    imported_counts: dict[str, dict[str, int]]


class ImportSettingsUpdate(BaseModel):
    """Request body for PATCH /users/me/import-settings."""

    tc_bullet: bool
    tc_blitz: bool
    tc_rapid: bool
    tc_classical: bool
    game_cap: Literal[1000, 3000, 5000]
