"""Insights router: HTTP endpoint for LLM-generated endgame insights.

Endpoint (mounted under /api):
- POST /insights/endgame: returns EndgameInsightsResponse with the LLM report.

The router is deliberately thin per CONTEXT.md D-33 — all cache /
LLM-call / logging logic lives in app.services.insights_llm.generate_insights().
This router: auth + session dep + query-param-to-FilterContext + one service
call + exception-to-HTTP status mapping (D-16).

v8: reject requests with any non-default filter other than opponent_strength
(400) so a report is only generated over the user's full history. Frontend
already disables the button in these cases; the server-side check is a
defensive safety net against callers that bypass the UI.
"""

import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.models.user import User
from app.schemas.insights import (
    EndgameInsightsResponse,
    FilterContext,
    InsightsErrorResponse,
)
from app.schemas.opening_insights import (
    OpeningInsightsRequest,
    OpeningInsightsResponse,
)
from app.core.config import settings
from app.repositories.import_job_repository import (
    get_latest_completed_import_with_games_at,
)
from app.repositories.llm_log_repository import get_latest_successful_log_for_user
from app.schemas.insights import EndgameInsightsReport
from app.services import insights_llm
from app.services.insights_llm import (
    INSIGHTS_CACHE_MAX_AGE,
    InsightsProviderError,
    InsightsValidationFailure,
)
from app.core.opponent_strength import derive_preset
from app.services.opening_insights_service import compute_insights
from app.users import current_active_user

router = APIRouter(prefix="/insights", tags=["insights"])


def _validate_full_history_filters(filters: FilterContext) -> None:
    """Raise 400 when any filter other than opponent_strength is non-default.

    v8 allows only opponent_strength to vary — it genuinely changes which
    games feed the findings, so it's a legitimate cross-section. All other
    filters (date range, time controls, platforms, rated) move the dataset
    away from the default population and would produce a report that doesn't
    match the system prompt's "your full history" framing.

    "Default" for `rated` means rated-only, NOT unfiltered. SEED-163 (2a)
    flipped the frontend's `DEFAULT_FILTERS.rated` from `null` (all) to `true`
    so the analytics population matches the percentile benchmark cohort
    (`g.rated AND NOT g.is_computer_game`); `opponent_type` is already pinned
    to "human" inside compute_findings. The gate exists to hold the findings
    population at ONE value — the LLM cache key is
    (user_id, prompt_version, model, opponent_strength) and does not carry any
    filter — so it has to track whatever that default is.

    BUG (FLAWCHESS-AG): this check used to be `if filters.rated_only`, which
    after the SEED-163 flip rejected exactly the state the default filters
    produce. The frontend gate (EndgameInsightsBlock.getBlockedReason) compares
    against DEFAULT_FILTERS and so left the button enabled, and every Generate
    Insights click 400'd with "Remove Rated filter" on a filter the user had
    never touched and could not clear.

    `color` is intentionally NOT gated here — it's ignored by the findings
    pipeline (compute_findings doesn't forward it), so the frontend's
    `color='white'` default has no effect on the report.
    """
    blocking: list[str] = []
    if filters.from_date is not None or filters.to_date is not None:
        blocking.append("Clear Custom date range filter")
    if filters.time_controls:
        blocking.append("Remove Time control filter")
    if filters.platforms:
        blocking.append("Remove Platform filter")
    if not filters.rated_only:
        blocking.append("Set the Rated filter to Rated")
    if blocking:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "filters_not_supported",
                "message": (
                    "Insights can only be generated for your full rated game "
                    "history. " + blocking[0] + "."
                ),
                "blocking": blocking,
            },
        )


@router.post("/endgame", response_model=EndgameInsightsResponse)
async def get_endgame_insights(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    time_control: list[str] | None = Query(default=None),
    platform: list[str] | None = Query(default=None),
    from_date: datetime.date | None = Query(default=None),
    to_date: datetime.date | None = Query(default=None),
    rated: bool = Query(default=True),
    opponent_gap_min: int | None = Query(default=None),
    opponent_gap_max: int | None = Query(default=None),
    color: Literal["all", "white", "black"] = Query(default="all"),
) -> EndgameInsightsResponse | JSONResponse:
    """Return the LLM-generated EndgameInsightsReport for the authenticated user.

    Query params mirror /api/endgames/overview so the Phase 66 frontend can share
    query-string builders with useEndgames.ts (D-31). `color` and `rated_only`
    flow into findings but NOT into the LLM prompt (INS-03). v8: all filters
    other than opponent_strength must be at defaults — see
    `_validate_full_history_filters`.

    `rated` defaults to True, matching the frontend's `DEFAULT_FILTERS.rated`
    (SEED-163 2a): an omitted param means the default rated-only population,
    not "all games". A client that means "all" therefore gets the rated-only
    report rather than a 400 — the UI can't produce that request (its button
    is gated on the same default), and pinning beats silently widening the
    population behind an unchanged cache key.

    Opponent strength is accepted as a (gap_min, gap_max) pair to mirror the
    range slider. Only the four preset ranges (any/stronger/similar/weaker) are
    permitted here so the LLM cache key (keyed on preset name) stays stable —
    custom ranges return 400.

    Returns:
        200: EndgameInsightsResponse with status in {fresh, cache_hit}.
        400: filters_not_supported (any non-default filter other than opponent_strength
             — including `rated=false`, since the default population is rated-only —
             or custom (non-preset) opponent gap range).
        502: InsightsErrorResponse(error='provider_error' | 'validation_failure').
    """
    preset = derive_preset(opponent_gap_min, opponent_gap_max)
    if preset == "custom":
        raise HTTPException(
            status_code=400,
            detail={
                "error": "filters_not_supported",
                "message": (
                    "Insights only support the preset opponent strength buckets "
                    "(Any / Stronger / Similar / Weaker). Snap the slider to a "
                    "preset to generate a report."
                ),
                "blocking": ["Snap opponent strength to a preset"],
            },
        )
    filter_context = FilterContext(
        from_date=from_date,
        to_date=to_date,
        opponent_strength=preset,
        color=color,
        time_controls=time_control or [],
        platforms=platform or [],
        rated_only=rated,
    )
    _validate_full_history_filters(filter_context)
    try:
        return await insights_llm.generate_insights(filter_context, user.id, session)
    except InsightsValidationFailure:
        return JSONResponse(
            status_code=502,
            content=InsightsErrorResponse(
                error="validation_failure",
            ).model_dump(),
        )
    except InsightsProviderError:
        return JSONResponse(
            status_code=502,
            content=InsightsErrorResponse(
                error="provider_error",
            ).model_dump(),
        )


@router.get("/endgame/cached", response_model=EndgameInsightsResponse)
async def get_cached_endgame_insights(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    time_control: list[str] | None = Query(default=None),
    platform: list[str] | None = Query(default=None),
    from_date: datetime.date | None = Query(default=None),
    to_date: datetime.date | None = Query(default=None),
    rated: bool = Query(default=True),
    opponent_gap_min: int | None = Query(default=None),
    opponent_gap_max: int | None = Query(default=None),
    color: Literal["all", "white", "black"] = Query(default="all"),
) -> EndgameInsightsResponse:
    """Cache-only lookup of the Tier-1 structural insights cache.

    Mirrors the Tier-1 logic from `app.services.insights_llm.generate_insights`
    (insights_llm.py:1830-1857) without invoking compute_findings or the LLM,
    and without consuming any rate-limit budget. Used by the frontend to
    auto-render a previously-generated report when the Endgames page mounts.

    Query params mirror POST /insights/endgame for hook reuse, but
    `_validate_full_history_filters` is intentionally NOT called: any
    non-default filter (or a custom non-preset opponent gap) simply produces
    a 404 because no cache row matches that combination.

    Returns:
        200: EndgameInsightsResponse(status='cache_hit') when a fresh,
             non-stale (no qualifying import since written) cache row exists
             for (user_id, prompt_version, model, opponent_strength).
        404: when no qualifying cache row exists.
    """
    preset = derive_preset(opponent_gap_min, opponent_gap_max)
    if preset == "custom":
        raise HTTPException(status_code=404, detail="no_cached_report")

    # color, time_controls, platforms, rated_only do not affect the structural
    # cache key — opponent_strength is the only filter dimension that does.
    # Build a FilterContext purely to keep the param-derivation contract
    # symmetric with POST; the lookup below only consults `preset`.
    _ = FilterContext(
        from_date=from_date,
        to_date=to_date,
        opponent_strength=preset,
        color=color,
        time_controls=time_control or [],
        platforms=platform or [],
        rated_only=rated,
    )

    model = settings.PYDANTIC_AI_MODEL_INSIGHTS
    cached = await get_latest_successful_log_for_user(
        session,
        user_id=user.id,
        prompt_version=insights_llm._PROMPT_VERSION,
        model=model,
        opponent_strength=preset,
        max_age=INSIGHTS_CACHE_MAX_AGE,
    )
    if cached is None:
        raise HTTPException(status_code=404, detail="no_cached_report")

    last_import_at = await get_latest_completed_import_with_games_at(session, user.id)
    if last_import_at is not None and last_import_at > cached.created_at:
        raise HTTPException(status_code=404, detail="no_cached_report")

    report = EndgameInsightsReport.model_validate(cached.response_json)
    return EndgameInsightsResponse(
        report=insights_llm._maybe_strip_overview(report),
        status="cache_hit",
    )


@router.post("/openings", response_model=OpeningInsightsResponse)
async def get_opening_insights(
    request: OpeningInsightsRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> OpeningInsightsResponse:
    """Phase 70 (v1.13) opening insights — POST /api/insights/openings.

    Authenticated, user-scoped. Returns a four-section
    OpeningInsightsResponse under the active filter set.

    Per CONTEXT.md D-14, this route does NOT inherit
    _validate_full_history_filters — every filter reshapes findings.
    """
    return await compute_insights(
        session=session,
        user_id=user.id,
        request=request,
    )
