"""Schemas for the push router (Phase 201, PUSH-01/PUSH-03).

No request schema carries a `user_id` field -- the owner is always
`current_active_user.id` (V4/IDOR guard, T-201-03).
"""

from __future__ import annotations

from pydantic import AnyHttpUrl, BaseModel, field_validator


class PushSubscriptionKeys(BaseModel):
    """The two base64url key blobs a `PushSubscription` carries in the browser."""

    p256dh: str
    auth: str


class PushSubscribeRequest(BaseModel):
    """Body for POST /push/subscribe -- the raw `PushSubscriptionJSON` shape."""

    endpoint: AnyHttpUrl
    keys: PushSubscriptionKeys

    @field_validator("endpoint")
    @classmethod
    def _require_https(cls, value: AnyHttpUrl) -> AnyHttpUrl:
        """ASVS V5 / T-201-01 (SSRF): the backend later POSTs to this URL."""
        if value.scheme != "https":
            raise ValueError("endpoint must use https")
        return value


class PushUnsubscribeRequest(BaseModel):
    """Body for POST /push/unsubscribe."""

    endpoint: AnyHttpUrl


class PushSubscribeResponse(BaseModel):
    """Response for POST /push/subscribe."""

    subscription_id: int


class VapidPublicKeyResponse(BaseModel):
    """Response for GET /push/vapid-public-key."""

    application_server_key: str


class DevTriggerReminderResponse(BaseModel):
    """Response for POST /push/dev/trigger-reminder (REMIND-08, D-17)."""

    attempted: int
    pruned: int


__all__ = [
    "PushSubscriptionKeys",
    "PushSubscribeRequest",
    "PushUnsubscribeRequest",
    "PushSubscribeResponse",
    "VapidPublicKeyResponse",
    "DevTriggerReminderResponse",
]
