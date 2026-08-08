"""Transactional email send path: password-reset emails via Resend.

Phase 207 (RESET-01, D-03). Mirrors app/services/push_send.py's shape: a
client-injectable, no-retry, single-outbound-POST service. RESEND_API_KEY
empty means email is gracefully disabled everywhere in this module — never
an exception at import time, never a startup abort (mirrors is_push_configured).

D-03: raw httpx POST to Resend, not the official `resend` SDK — one POST call
doesn't need a dependency.

Unlike push_send.py, the destination is the fixed constant _RESEND_ENDPOINT,
never client-supplied, so there is no SSRF surface to mitigate here (no
follow_redirects=False needed — push_send.py's endpoint is attacker-supplied,
this one is not).

T-207-02 (Task 2, Change A): the caller (UserManager.on_after_forgot_password)
must never await the Resend POST directly, or an existing address costs a
network round-trip that a non-existent address never pays — a measurable
enumeration oracle. `spawn_password_reset_email` fires the send as a detached
asyncio.Task, registered in `_pending_sends` (a strong reference is required
or the task can be garbage-collected mid-flight). This exists for the timing-
oracle reason, not for throughput — do not "simplify" it back to an await.
The residual differential (fastapi-users hashes the stored password with
Argon2 to build the token fingerprint, which an unregistered address never
pays) is accepted threat T-207-03; removing it would require forking
`get_reset_password_router`.
"""

from __future__ import annotations

import asyncio
import logging

import httpx
import sentry_sdk

from app.core.config import settings

logger = logging.getLogger(__name__)

_EMAIL_TIMEOUT_SECONDS = 10.0

_RESEND_ENDPOINT = "https://api.resend.com/emails"

# Strong references to in-flight fire-and-forget sends (T-207-02) so they are
# never garbage-collected mid-flight. Discarded on completion via the task's
# own done callback.
_pending_sends: set[asyncio.Task[bool]] = set()


def is_email_configured() -> bool:
    """True only when RESEND_API_KEY is set (mirrors is_push_configured's D-03 gate)."""
    return bool(settings.RESEND_API_KEY)


def email_http_client() -> httpx.AsyncClient:
    """Build the outbound client for transactional email sends."""
    return httpx.AsyncClient(timeout=_EMAIL_TIMEOUT_SECONDS)


async def send_password_reset_email(
    client: httpx.AsyncClient,
    *,
    to: str,
    reset_url: str,
    user_id: int,
) -> bool:
    """Send the password-reset email via Resend. Returns True on 2xx, False otherwise.

    No retry (mirrors push_send.py — a single transactional send, not a bulk
    client). A Resend 429 (10 req/s per team) is expected to land in the
    non-2xx branch below and must NOT be "fixed" later by adding retry — see
    COVERAGE.md § 7 / RESEARCH Anti-Patterns.
    """
    if not is_email_configured():
        return False  # unconfigured — no-op, mirrors is_push_configured() gate

    payload = {
        "from": f"FlawChess <{settings.MAIL_FROM}>",
        "to": [to],
        "subject": "Reset your FlawChess password",
        "html": (
            f'<p>Click <a href="{reset_url}">here</a> to reset your FlawChess password. '
            "This link expires in 1 hour.</p>"
        ),
        "text": f"Reset your FlawChess password: {reset_url} (expires in 1 hour)",
    }
    headers = {"Authorization": f"Bearer {settings.RESEND_API_KEY}"}

    try:
        resp = await client.post(_RESEND_ENDPOINT, json=payload, headers=headers)
    except httpx.HTTPError:
        logger.exception("Password reset email transport error")
        sentry_sdk.set_tag("source", "email_service")
        sentry_sdk.set_context("email_service", {"user_id": user_id})
        sentry_sdk.capture_exception()
        return False

    if resp.status_code >= 300:
        logger.warning("Password reset email send failed with status %d", resp.status_code)
        sentry_sdk.set_tag("source", "email_service")
        # Never interpolate status_code/user_id into the exception MESSAGE —
        # set_context only (CLAUDE.md: "Never embed variables in error
        # messages" fragments Sentry grouping). Mirrors push_send.py.
        sentry_sdk.set_context(
            "email_service", {"status_code": resp.status_code, "user_id": user_id}
        )
        sentry_sdk.capture_exception(
            RuntimeError("Password reset email send returned a non-success status")
        )
        return False

    return True


def spawn_password_reset_email(*, to: str, reset_url: str, user_id: int) -> asyncio.Task[bool]:
    """Fire the password-reset send without the caller awaiting it (T-207-02).

    Opens its own `email_http_client()` inside the spawned coroutine — the
    caller no longer opens one. Registers the task in `_pending_sends` (a
    strong reference) and discards it via a done callback once it completes,
    so `drain_pending_sends()` can be awaited in tests without a real sleep.
    """

    async def _run() -> bool:
        async with email_http_client() as client:
            return await send_password_reset_email(
                client, to=to, reset_url=reset_url, user_id=user_id
            )

    task = asyncio.ensure_future(_run())
    _pending_sends.add(task)
    task.add_done_callback(_pending_sends.discard)
    return task


async def drain_pending_sends() -> None:
    """Await every currently-outstanding spawned send (test-only utility).

    Production code never calls this — the whole point of `spawn_password_reset_email`
    is that the request handler does not wait. Tests call this to make dispatch-count
    assertions deterministic instead of racing a background task.
    """
    pending = list(_pending_sends)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


__all__ = [
    "is_email_configured",
    "email_http_client",
    "send_password_reset_email",
    "spawn_password_reset_email",
    "drain_pending_sends",
]
