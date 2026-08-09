"""Pydantic v2 schemas for user profile API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, field_validator

from app.core.platform_usernames import extract_platform_username
from app.schemas.admin import ImpersonationContext


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
    # MAIA-04 / D-07: rating from the user's most-recent game (across platforms),
    # read-only, index-backed. Feeds the free-play ELO-selector default. None
    # when the user has no games or their most recent game is unrated.
    current_rating: int | None = None
    # Phase 171 D-07: the caller's own blitz-bucket `user_rating_anchors.anchor_rating`
    # -- the blended lichess-equivalent median Phase 167 already trusts for bot-game
    # rating derivation. None for guests, for users with no anchor at all, and for
    # users with anchors only in non-blitz buckets (rapid/classical-only players
    # included -- deliberate, not a bug); the frontend falls back to 1500.
    # UI DEFAULT ONLY -- never fed into bot move selection (BOT-03).
    lichess_blitz_equivalent_rating: int | None = None


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
