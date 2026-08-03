"""Web Push send path: VAPID signing + aes128gcm encryption + the outbound POST.

Phase 201 (PUSH-01/PUSH-02/PUSH-03/PUSH-04, D-01/D-02/D-03/D-04).
`app.services.push_crypto` (D-01) does the VAPID JWT signing and RFC 8291
aes128gcm payload encryption in-process; this module owns the actual
`httpx.AsyncClient` POST to the browser-supplied endpoint -- the whole point
of D-01 is that no blocking HTTP client (e.g. `requests`, which PUSH-04
forbids on this path) ever touches the event loop.

D-03: an unset VAPID keypair means push is gracefully disabled everywhere in
this module -- never an exception at import time, never a startup abort.

D-04: only a 404/410 response means "prune this subscription" (PUSH-02).
Every other non-2xx status, and every transport error, is logged +
`sentry_sdk.capture_exception`-ed and left alone -- no retry, no deletion.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

import httpx
import sentry_sdk
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.repositories import push_repository
from app.services import push_crypto

logger = logging.getLogger(__name__)

# RFC 8292: exp MUST NOT exceed 24h. 12h is the conventional value.
_VAPID_EXPIRATION_SECONDS = 12 * 60 * 60

# Status codes meaning "the push service will never accept this endpoint
# again" (PUSH-02, RFC 8030 Sec. 7) -- everything else is either a bug in our
# own send path (400/401/403/413) or transient (429/5xx), per D-04.
_PRUNE_STATUS_CODES = frozenset({404, 410})

# Bounded so one slow/unreachable push service can never stall a fan-out.
_PUSH_TIMEOUT_SECONDS = 10.0

# RFC 8030 TTL. 0 = deliver only if the device is reachable right now, never
# stored by the push service. A reminder is worthless once its hour has passed
# (D-04/D-08 already own lateness), so we do not ask for retention.
_PUSH_TTL_SECONDS = 0


@dataclass(frozen=True)
class PushFanoutResult:
    """The outcome of fanning one payload out to a user's live subscriptions."""

    attempted: int
    pruned: int
    failed: int


def is_push_configured() -> bool:
    """True only when both VAPID key settings are non-empty (D-03)."""
    return bool(settings.VAPID_PUBLIC_KEY) and bool(settings.VAPID_PRIVATE_KEY)


def application_server_key() -> str | None:
    """Return the base64url application server key `PushManager.subscribe()` needs.

    Derived from `VAPID_PUBLIC_KEY` at call time rather than stored as a
    fourth env var -- a PEM and a hand-pasted base64url value that drift
    apart would silently 403 every send. Returns None when push is
    unconfigured (D-03).
    """
    if not settings.VAPID_PUBLIC_KEY:
        return None
    return push_crypto.application_server_key_from_pem(settings.VAPID_PUBLIC_KEY.encode())


def push_http_client() -> httpx.AsyncClient:
    """Build the outbound client for push sends.

    `follow_redirects=False` is an SSRF mitigation (T-201-01, ASVS V4): the
    endpoint is client-supplied, so an outbound redirect must never be
    chased to a different host.
    """
    return httpx.AsyncClient(timeout=_PUSH_TIMEOUT_SECONDS, follow_redirects=False)


async def send_to_subscription(
    client: httpx.AsyncClient,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    payload: dict[str, object],
) -> bool:
    """Send one push message. Returns True if the subscription should be pruned.

    D-04: only 404/410 return True (prune). Every other non-2xx is logged +
    reported to Sentry and left alone -- no retry, no deletion.
    """
    if not is_push_configured():
        return False  # D-03: VAPID unconfigured, no-op
    encrypted = push_crypto.encrypt_aes128gcm(
        payload=json.dumps(payload).encode(), p256dh=p256dh, auth=auth
    )
    headers = {
        "ttl": str(_PUSH_TTL_SECONDS),
        "content-encoding": "aes128gcm",
        "authorization": push_crypto.vapid_authorization(
            endpoint=endpoint,
            subject=settings.VAPID_SUBJECT,
            private_key_pem=settings.VAPID_PRIVATE_KEY.encode(),
            public_key_pem=settings.VAPID_PUBLIC_KEY.encode(),
            expiration_seconds=_VAPID_EXPIRATION_SECONDS,
            now=int(time.time()),
        ),
    }
    try:
        resp = await client.post(endpoint, content=encrypted, headers=headers)
    except httpx.HTTPError:
        logger.exception("Push send transport error")
        sentry_sdk.set_tag("source", "push_send")
        sentry_sdk.capture_exception()
        return False

    if resp.status_code in _PRUNE_STATUS_CODES:
        return True
    # Anything outside 2xx is a non-delivery. The bound is 300, not 400: we send
    # with follow_redirects=False (an SSRF mitigation on a client-supplied
    # endpoint), so a 3xx arrives here as an unfollowed redirect and the message
    # was NOT delivered. A >= 400 bound let 3xx fall through and return False,
    # making a silent non-delivery indistinguishable from a real 201.
    if resp.status_code >= 300:  # 3xx unfollowed redirect + 400/401/403/413/429/5xx per D-04
        logger.warning("Push send failed with status %d", resp.status_code)
        sentry_sdk.set_tag("source", "push_send")
        sentry_sdk.set_context("push_send", {"status_code": resp.status_code})
        sentry_sdk.capture_exception(RuntimeError("Push send returned a non-success status"))
    return False


async def send_to_user(
    session: AsyncSession, *, user_id: int, payload: dict[str, object]
) -> PushFanoutResult:
    """Fan `payload` out to every one of `user_id`'s live subscriptions (D-05).

    Opens ONE `push_http_client()` for the whole fan-out (connection pooling
    across a user's devices). Iterates subscriptions sequentially -- never
    `asyncio.gather` on one `AsyncSession` (CLAUDE.md) -- and isolates each
    subscription's failure in its own try/except so one bad device never
    starves the rest of the fan-out. Commits once at the end.

    Args:
        session: AsyncSession. Commits internally (prune deletes + this
            function's own transaction boundary).
        user_id: Authenticated user's internal PK (V4: never client-supplied).
        payload: The notification payload (see
            `app.services.train_reminder_service.build_reminder_payload`).
    """
    if not is_push_configured():
        return PushFanoutResult(attempted=0, pruned=0, failed=0)

    subscriptions = await push_repository.list_subscriptions(session, user_id=user_id)
    attempted = 0
    pruned = 0
    failed = 0
    async with push_http_client() as client:
        for subscription in subscriptions:
            attempted += 1
            try:
                should_prune = await send_to_subscription(
                    client,
                    endpoint=subscription.endpoint,
                    p256dh=subscription.p256dh,
                    auth=subscription.auth,
                    payload=payload,
                )
            except Exception:
                # Per-subscription isolation: a construction/encryption error
                # on one device must never stop the rest of the fan-out.
                logger.exception("Push send raised unexpectedly")
                sentry_sdk.set_tag("source", "push_send")
                sentry_sdk.capture_exception()
                failed += 1
                continue
            if should_prune:
                await push_repository.delete_subscription_by_id(
                    session, subscription_id=subscription.id
                )
                pruned += 1
            # else: either delivered, or a non-prune failure already logged
            # + captured inside send_to_subscription (D-04: leave it alone).
    await session.commit()
    return PushFanoutResult(attempted=attempted, pruned=pruned, failed=failed)


__all__ = [
    "PushFanoutResult",
    "is_push_configured",
    "application_server_key",
    "push_http_client",
    "send_to_subscription",
    "send_to_user",
]
