"""Push router: subscribe / unsubscribe / VAPID public key / dev trigger (Phase 201).

D-03 (LOCKED): an unconfigured VAPID keypair means push is gracefully
disabled -- `GET /vapid-public-key` 404s, `POST /subscribe` 503s.

Every handler scopes to `current_active_user.id` -- never a client-supplied
`user_id` (V4/IDOR guard, T-201-03). The dev trigger endpoint (D-17) never
accepts a target user id in body, path, or query, and is unreachable outside
`ENVIRONMENT == "development"` (T-201-04), mirroring
`app/core/dev_clock.py`'s fail-closed gate.
"""

from __future__ import annotations

from typing import Annotated

import sentry_sdk
from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_async_session
from app.models.user import User
from app.repositories import push_repository, train_repository
from app.schemas.push import (
    DevTriggerReminderResponse,
    PushSubscribeRequest,
    PushSubscribeResponse,
    PushUnsubscribeRequest,
    VapidPublicKeyResponse,
)
from app.services import push_send
from app.services.train_reminder_service import build_reminder_payload
from app.users import current_active_user

router = APIRouter(prefix="/push", tags=["push"])


@router.post("/subscribe", response_model=PushSubscribeResponse, status_code=201)
async def subscribe(
    body: PushSubscribeRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
    user_agent: Annotated[str | None, Header(alias="User-Agent")] = None,
) -> PushSubscribeResponse:
    """Store a browser push subscription against the calling user (PUSH-01).

    Returns 503 when VAPID is unconfigured (D-03) -- a subscription stored
    with no keypair to sign sends with would be dead on arrival.
    """
    if not push_send.is_push_configured():
        raise HTTPException(status_code=503, detail="Push is not configured")
    try:
        subscription_id = await push_repository.upsert_subscription(
            session,
            user_id=user.id,
            endpoint=str(body.endpoint),
            p256dh=body.keys.p256dh,
            auth=body.keys.auth,
            user_agent=user_agent,
        )
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("push", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    return PushSubscribeResponse(subscription_id=subscription_id)


@router.post("/unsubscribe", status_code=204)
async def unsubscribe(
    body: PushUnsubscribeRequest,
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> None:
    """Remove the calling user's own subscription by endpoint.

    Scoped to the owner -- a foreign endpoint matches zero rows and still
    returns 204 (no IDOR-revealing distinction between "not yours" and "not
    found").
    """
    try:
        await push_repository.delete_subscription_by_endpoint(
            session, user_id=user.id, endpoint=str(body.endpoint)
        )
        await session.commit()
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("push", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise


@router.get("/vapid-public-key", response_model=VapidPublicKeyResponse)
async def vapid_public_key() -> VapidPublicKeyResponse:
    """Return the application server key `PushManager.subscribe()` needs.

    404 when VAPID is unconfigured (D-03) -- there is no key to hand out.
    """
    key = push_send.application_server_key()
    if key is None:
        raise HTTPException(status_code=404, detail="Push is not configured")
    return VapidPublicKeyResponse(application_server_key=key)


@router.post("/dev/trigger-reminder", response_model=DevTriggerReminderResponse)
async def dev_trigger_reminder(
    session: Annotated[AsyncSession, Depends(get_async_session)],
    user: Annotated[User, Depends(current_active_user)],
) -> DevTriggerReminderResponse:
    """Fire the Train reminder for the calling user immediately (REMIND-08, D-17).

    Dev-only (mirrors `app/core/dev_clock.py`'s fail-closed gate) so a forged
    call against production is inert. Bypasses the hour/weekday/already-
    trained/already-sent checks deliberately, and never writes
    `train_settings.reminder_last_sent_on` -- firing it cannot consume the
    real scheduler's daily claim (plan 201-04 owns that column), so firing it
    twice sends twice, on purpose.
    """
    if settings.ENVIRONMENT != "development":
        raise HTTPException(status_code=404)
    try:
        settings_row = await train_repository.get_or_create_settings(session, user_id=user.id)
        await session.commit()
        payload = build_reminder_payload(streak_count=settings_row.streak_count)
        result = await push_send.send_to_user(session, user_id=user.id, payload=payload)
    except Exception:
        await session.rollback()
        sentry_sdk.set_context("push", {"user_id": str(user.id)})
        sentry_sdk.capture_exception()
        raise
    return DevTriggerReminderResponse(attempted=result.attempted, pruned=result.pruned)


__all__ = ["router"]
