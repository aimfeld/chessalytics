"""Dev-only clock override for time-dependent endpoints (Train scheduling).

WHY
    Train's whole value surface is calendar-shaped: `weekday_mask` decides
    which days a session exists, `session_window`/`is_session_expired` decide
    when it lapses, the `drill_items.due_date` ladder spaces repeats out by
    days, and the per-scheduled-day tick machine judges each elapsed
    scheduled day to move the depletable shield and session streak.
    Verifying any of that by hand would otherwise mean waiting real days.

    Every Train handler already takes the current instant as an injected
    `now_utc` argument rather than reading the clock deep inside the
    repository, so a single request-scoped dependency can shift "now" for a
    whole browser session without touching any business logic.

HOW
    The frontend sends `X-Dev-Clock-Offset-Minutes: <signed int>` (see
    `frontend/src/lib/devClock.ts`); this dependency adds it to the real UTC
    instant. Minutes rather than days on purpose — landing on a specific
    weekday AND hour is what exercises the local-midnight boundaries in
    `train_scheduler.local_today`.

FAIL-CLOSED
    The header is honoured ONLY when `ENVIRONMENT == "development"`. In every
    other environment this returns the real clock and the header is ignored
    entirely, so a forged header against production is inert. This mirrors the
    existing `ENVIRONMENT` gate on the default-SECRET_KEY check in
    `app/core/config.py`. A malformed or out-of-range value degrades to the
    real clock rather than raising — a broken dev tool must never turn a
    working endpoint into a 4xx.

CAVEAT (dev workflow, not a code issue)
    Rows written while the clock is shifted persist with the shifted dates. So
    after time-travelling forward, returning to the real clock leaves drill
    items dated in the future. `scripts/reset_train_state.py` clears a user's
    Train state to get back to a clean slate.
"""

from __future__ import annotations

import datetime

from fastapi import Request

from app.core.config import settings

#: Request header carrying the signed offset, in minutes, from the real clock.
DEV_CLOCK_OFFSET_HEADER = "X-Dev-Clock-Offset-Minutes"

#: Sanity bound (~2 years each way). Not a security control — the
#: ENVIRONMENT gate is — just a guard against an absurd value producing dates
#: outside what `datetime`/PostgreSQL `DATE` handle sensibly.
MAX_DEV_CLOCK_OFFSET_MINUTES = 2 * 366 * 24 * 60


def dev_now_utc(request: Request) -> datetime.datetime:
    """Return the current UTC instant, shifted by the dev clock offset in dev.

    Args:
        request: The incoming request, read for `DEV_CLOCK_OFFSET_HEADER`.

    Returns:
        The real UTC instant in every non-development environment, or when no
        usable offset header is present; otherwise that instant plus the
        clamped offset.
    """
    real_now = datetime.datetime.now(datetime.timezone.utc)
    if settings.ENVIRONMENT != "development":
        return real_now
    raw = request.headers.get(DEV_CLOCK_OFFSET_HEADER)
    if not raw:
        return real_now
    try:
        offset_minutes = int(raw)
    except ValueError:
        return real_now
    clamped = max(-MAX_DEV_CLOCK_OFFSET_MINUTES, min(MAX_DEV_CLOCK_OFFSET_MINUTES, offset_minutes))
    return real_now + datetime.timedelta(minutes=clamped)


__all__ = ["DEV_CLOCK_OFFSET_HEADER", "MAX_DEV_CLOCK_OFFSET_MINUTES", "dev_now_utc"]
