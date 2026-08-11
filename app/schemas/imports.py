"""Pydantic v2 schemas for the import API endpoints."""

from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationInfo, field_validator

from app.core.platform_usernames import extract_platform_username
from app.schemas.normalization import Color

# SURGE-04/D-03 (Phase 209): the five exhaustive values import_jobs.status can
# take. "queued" is in-memory only (import_service.JobStatus.QUEUED) -- never
# written to the DB row -- but flows through the same response fields as the
# other four, so it belongs in the same wire type. The only writers of
# import_jobs.status are the create path ("pending"), the first batch flush
# ("in_progress"), completion ("completed"), and the two failure paths plus
# the reaper ("failed").
ImportJobStatusLiteral = Literal["pending", "queued", "in_progress", "completed", "failed"]


class ImportRequest(BaseModel):
    platform: Literal["chess.com", "lichess"]
    username: str = Field(min_length=1, max_length=100)

    @field_validator("username", mode="before")
    @classmethod
    def _extract_username(cls, value: Any, info: ValidationInfo) -> Any:
        # mode="before" is load-bearing (D-03/T-IQ1-02): it must run ahead of
        # max_length=100 so a long pasted profile URL is shortened to the bare
        # username instead of rejected. `platform` is declared before
        # `username`, so it is already validated and present here -- except
        # when `platform` itself failed validation, in which case we fall
        # back to accepting either platform's URL form.
        platform = info.data.get("platform")
        return extract_platform_username(value, platform)


class ImportStartedResponse(BaseModel):
    job_id: str
    status: ImportJobStatusLiteral


class ImportStatusResponse(BaseModel):
    job_id: str
    platform: str
    username: str
    status: ImportJobStatusLiteral
    games_fetched: int
    games_imported: int
    error: str | None = None
    other_importers: int = 0  # Count of other users importing from same platform (D-23)

    @classmethod
    def from_dict(cls, data: dict) -> "ImportStatusResponse":
        return cls(
            job_id=data["job_id"],
            platform=data["platform"],
            username=data["username"],
            status=data["status"],
            games_fetched=data.get("games_fetched", 0),
            games_imported=data.get("games_imported", 0),
            error=data.get("error") or data.get("error_message"),
        )


class DeleteGamesResponse(BaseModel):
    """Response for DELETE /imports/games."""

    deleted_count: int


class EnqueueTier1Response(BaseModel):
    """Response for POST /imports/eval/tier1/{game_id} (and re-exported to admin).

    Phase 117 D-117-05 built the internal/admin trigger; Phase 118 adds the
    user-facing endpoint. Moved here from admin.py (D-118-12) so imports.py
    owns the full eval-enqueue schema set.
    """

    status: Literal["enqueued", "skipped_guest", "already_queued"]
    game_id: int


class EvalCoverageResponse(BaseModel):
    """Response for GET /imports/eval-coverage (D-118-12 extension).

    Extended in Phase 118 with analyzed_count. Existing fields (pending_count,
    total_count, pct_complete) are unchanged for backward compatibility with
    Endgames/Openings/GlobalStats readiness gates. in_flight_count removed in
    Phase 119-03: tier-3 derived picks have no eval_jobs rows, so the count was
    structurally blind to the dominant backlog drain and never an honest signal.
    """

    pending_count: int
    total_count: int
    pct_complete: int  # 0-100, rounded
    analyzed_count: int  # white_blunders IS NOT NULL (is_analyzed — flaw-surface denominator)


# Phase 208 (T-208-12): bounds the DoS surface of a client-POSTed pasted PGN —
# mirrors MAX_BOT_PGN_LENGTH's convention (app/schemas/bots.py). Rejected at
# schema validation, before any chess.pgn parse.
MAX_PASTED_PGN_LENGTH = 100_000


class SavePastedGameRequest(BaseModel):
    """Request body for POST /imports/paste (Phase 208, PASTE-04).

    No owner field of any kind — the principal is server-derived from
    current_active_user (ASVS V4, T-208-10); a body carrying a foreign
    user_id-shaped field is simply ignored by the schema.
    """

    pgn: str = Field(min_length=1, max_length=MAX_PASTED_PGN_LENGTH)
    user_color: Color


class SavePastedGameResponse(BaseModel):
    """Response for POST /imports/paste.

    eval_status distinguishes four post-save outcomes: "enqueued" (a fresh
    tier-1 job was inserted), "already_queued" (an active job already
    existed, D-17 no-op), "already_analyzed" (the reused row was already
    fully analyzed, D-17 no re-enqueue), and "enqueue_failed" (the game row
    IS durably saved, but the post-commit enqueue_tier1_game call raised —
    the SC-7 post-commit failure window; see 208-03-PLAN.md's dedicated
    section). "enqueue_failed" is still a 200 — the save genuinely
    succeeded.
    """

    game_id: int
    created: bool
    eval_status: Literal["enqueued", "already_queued", "already_analyzed", "enqueue_failed"]


class ReadinessResponse(BaseModel):
    """Response for GET /imports/readiness.

    Two-tier readiness signal for gating eval-dependent features:

    Tier 1 (tier1=True): no active import job in-flight for this user.
        False while a PENDING or IN_PROGRESS import exists in-memory.
        NOTE: In-memory only — orphaned DB jobs after server restart are not
        detected here (RESEARCH Open Question 1 / A3). Out of scope.

    Tier 2 (tier2=True): tier1 AND pending evals == 0 AND
        (user has no games OR at least one user_benchmark_percentiles row exists).
        The "no games" escape prevents a below-floor user from being locked out
        forever when Stage B has nothing to compute (Pitfall 1).
        Row existence is the post-commit Stage-B signal — computed_at is
        refreshed on every upsert, so no Stage-B race with create_task.
    """

    tier1: bool
    tier2: bool
    pending_count: int
    total_count: int
