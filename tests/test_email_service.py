"""Unit tests for app.services.email_service (Phase 207, RESET-04).

Structured like tests/test_push_send.py: a `_mock_client` helper building an
AsyncMock whose `.post` is an AsyncMock, and `monkeypatch.setattr` against the
settings object to toggle configuration per test. `sentry_sdk.capture_exception`
and `sentry_sdk.set_context` are patched where email_service imports them.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

import app.services.email_service as email_service
from app.core.config import settings as config_settings

_RESET_URL = "http://localhost:5173/auth/reset-password?token=abc123"


def _mock_client(status_code: int | None = None, *, side_effect: object = None) -> AsyncMock:
    client = AsyncMock()
    if side_effect is not None:
        client.post = AsyncMock(side_effect=side_effect)
    else:
        client.post = AsyncMock(return_value=MagicMock(status_code=status_code))
    return client


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default every test to a configured RESEND_API_KEY; individual tests override."""
    monkeypatch.setattr(config_settings, "RESEND_API_KEY", "test-resend-key")
    monkeypatch.setattr(config_settings, "MAIL_FROM", "noreply@flawchess.com")


# ---------------------------------------------------------------------------
# Test 1: success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_success_returns_true_one_post_correct_payload() -> None:
    client = _mock_client(200)
    result = await email_service.send_password_reset_email(
        client, to="user@example.com", reset_url=_RESET_URL, user_id=42
    )
    assert result is True
    assert client.post.call_count == 1
    _, kwargs = client.post.call_args
    body = kwargs["json"]
    assert body["from"] == "FlawChess <noreply@flawchess.com>"
    assert body["to"] == ["user@example.com"]


# ---------------------------------------------------------------------------
# Test 2: transport error
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_transport_error_returns_false_one_capture() -> None:
    client = _mock_client(side_effect=httpx.ConnectError("boom"))
    with (
        patch("app.services.email_service.sentry_sdk.capture_exception") as mock_capture,
        patch("app.services.email_service.sentry_sdk.set_context") as mock_set_context,
    ):
        result = await email_service.send_password_reset_email(
            client, to="user@example.com", reset_url=_RESET_URL, user_id=42
        )
    assert result is False
    assert mock_capture.call_count == 1
    # Test 2 also pins the transport branch's own set_context call — dropping
    # it entirely (distinct from the non-2xx branch's set_context, covered by
    # Test 3) must be independently red here.
    assert mock_set_context.call_count == 1
    ctx_payload = mock_set_context.call_args.args[1]
    assert ctx_payload["user_id"] == 42


# ---------------------------------------------------------------------------
# Test 3: non-2xx (422) — context carries status_code and user_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_422_returns_false_context_has_status_and_user_id() -> None:
    client = _mock_client(422)
    with (
        patch("app.services.email_service.sentry_sdk.capture_exception") as mock_capture,
        patch("app.services.email_service.sentry_sdk.set_context") as mock_set_context,
    ):
        result = await email_service.send_password_reset_email(
            client, to="user@example.com", reset_url=_RESET_URL, user_id=99
        )
    assert result is False
    assert mock_capture.call_count == 1
    assert mock_set_context.call_count == 1
    _, ctx_kwargs_or_args = mock_set_context.call_args
    ctx_payload = mock_set_context.call_args.args[1]
    assert ctx_payload["status_code"] == 422
    assert ctx_payload["user_id"] == 99


# ---------------------------------------------------------------------------
# Test 4: constant message — no interpolation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_non2xx_capture_message_is_constant_across_calls() -> None:
    client_a = _mock_client(422)
    client_b = _mock_client(500)
    with patch("app.services.email_service.sentry_sdk.capture_exception") as mock_capture:
        await email_service.send_password_reset_email(
            client_a, to="a@example.com", reset_url=_RESET_URL, user_id=1
        )
        await email_service.send_password_reset_email(
            client_b, to="b@example.com", reset_url=_RESET_URL, user_id=2
        )
    assert mock_capture.call_count == 2
    message_a = str(mock_capture.call_args_list[0].args[0])
    message_b = str(mock_capture.call_args_list[1].args[0])
    assert message_a == message_b


# ---------------------------------------------------------------------------
# Test 5: unconfigured — no-op
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_unconfigured_returns_false_never_posts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_settings, "RESEND_API_KEY", "")
    client = _mock_client(200)
    result = await email_service.send_password_reset_email(
        client, to="user@example.com", reset_url=_RESET_URL, user_id=42
    )
    assert result is False
    client.post.assert_not_awaited()


# ---------------------------------------------------------------------------
# Test 6: no retry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_500_no_retry_exactly_one_post() -> None:
    client = _mock_client(500)
    await email_service.send_password_reset_email(
        client, to="user@example.com", reset_url=_RESET_URL, user_id=42
    )
    assert client.post.call_count == 1
