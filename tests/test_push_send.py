"""Tests for app.services.push_send (Phase 201, PUSH-02/PUSH-04, T-201-02).

Coverage:
- Status-branch table (one test per status, mirrors test_chesscom_client.py's
  granularity): 201/200 -> no prune, no Sentry; 404/410 -> prune, no Sentry;
  400/401/403/413/429/500/503 -> no prune, exactly one Sentry capture whose
  message carries no status-code digits (the code lives in set_context only).
- A transport error (httpx.ConnectError) -> no prune, one Sentry capture, no
  exception escapes.
- test_no_key_leak_* : neither error branch ever leaks the configured VAPID
  private key into a captured exception, its str()/repr(), or any
  `sentry_sdk.set_context` value (T-201-02).
- send_to_user: fan-out counts, idempotent pruning across two calls, and the
  zero-result short-circuit when VAPID is unconfigured.

Uses dependency injection for `send_to_subscription`'s `client` parameter
(the signature already takes it -- cleaner than patching `httpx.AsyncClient`,
per 201-PATTERNS.md Pattern 4) and patches `httpx.AsyncClient.post` for
`send_to_user`, which builds its own client internally and is never driven
through an outer ASGI-transport client in this file.
"""

from __future__ import annotations

import ast
import base64
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.push_crypto import generate_keypair

import app.services.push_send as push_send
from app.core.config import settings as config_settings
from app.models.user import User
from app.repositories import push_repository

REPO_ROOT = Path(__file__).resolve().parent.parent

_ENDPOINT = "https://fcm.googleapis.com/fcm/send/status-branch-endpoint"
_PAYLOAD: dict[str, object] = {"title": "Time to train", "body": "Day 1 is waiting."}

# Statuses that mean "the push service will never accept this endpoint again"
# (PUSH-02) -- everything else is either a bug in our own request (4xx) or
# transient (429/5xx), per D-04.
_PRUNE_STATUSES = (404, 410)
_SUCCESS_STATUSES = (200, 201)
_ERROR_STATUSES = (400, 401, 403, 413, 429, 500, 503)


def _fresh_subscription_keys() -> tuple[str, str]:
    """A real EC public key + random secret, base64url-encoded (no padding)."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    p256dh = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode()
    auth = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
    return p256dh, auth


@pytest.fixture
def vapid_keypair(monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """Configure a freshly generated VAPID keypair for the duration of one test."""
    private_key, public_key, _application_server_key = generate_keypair()
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", private_key.decode())
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", public_key.decode())
    return private_key.decode(), public_key.decode()


def _mock_client(status_code: int | None = None, *, side_effect: object = None) -> AsyncMock:
    client = AsyncMock()
    if side_effect is not None:
        client.post = AsyncMock(side_effect=side_effect)
    else:
        client.post = AsyncMock(return_value=MagicMock(status_code=status_code))
    return client


# ---------------------------------------------------------------------------
# send_to_subscription: status-branch table
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_201_no_prune_no_capture() -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(201)
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is False
    assert mock_capture.call_count == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_200_no_prune_no_capture() -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(200)
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is False
    assert mock_capture.call_count == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_404_prunes_no_capture() -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(404)
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is True
    assert mock_capture.call_count == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_410_prunes_no_capture() -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(410)
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is True
    assert mock_capture.call_count == 0


async def _assert_error_status_captures_once(status_code: int) -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(status_code)
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is False
    assert mock_capture.call_count == 1
    captured_exc = mock_capture.call_args.args[0]
    # The status code must never appear in the exception's own message --
    # it lives only in sentry_sdk.set_context (CLAUDE.md: never embed
    # variables in error messages, which fragments Sentry grouping).
    assert str(status_code) not in str(captured_exc)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_301_captures_once() -> None:
    # We POST with follow_redirects=False, so a 3xx is an unfollowed redirect
    # and the push was NOT delivered. It must be reported, never silently
    # treated as a success alongside a real 201.
    await _assert_error_status_captures_once(301)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_302_captures_once() -> None:
    await _assert_error_status_captures_once(302)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_400_captures_once() -> None:
    await _assert_error_status_captures_once(400)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_401_captures_once() -> None:
    await _assert_error_status_captures_once(401)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_403_captures_once() -> None:
    await _assert_error_status_captures_once(403)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_413_captures_once() -> None:
    await _assert_error_status_captures_once(413)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_429_captures_once() -> None:
    await _assert_error_status_captures_once(429)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_500_captures_once() -> None:
    await _assert_error_status_captures_once(500)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_status_503_captures_once() -> None:
    await _assert_error_status_captures_once(503)


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_subscription_transport_error_captures_once_no_escape() -> None:
    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(side_effect=httpx.ConnectError("connection refused"))
    with patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture:
        should_prune = await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    assert should_prune is False
    assert mock_capture.call_count == 1


# ---------------------------------------------------------------------------
# T-201-02: no key material ever reaches Sentry
# ---------------------------------------------------------------------------


def _pem_body_lines(pem: str) -> list[str]:
    """The base64 body lines of a PEM block (excludes the -----BEGIN/END----- markers)."""
    lines = pem.strip().splitlines()
    return [line for line in lines if line and not line.startswith("-----")]


@pytest.mark.asyncio
async def test_no_key_leak_on_error_status_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    private_key, public_key, _key = generate_keypair()
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", private_key.decode())
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", public_key.decode())
    private_key_lines = _pem_body_lines(private_key.decode())

    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(500)
    with (
        patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture,
        patch("app.services.push_send.sentry_sdk.set_context") as mock_set_context,
    ):
        await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    captured_exc = mock_capture.call_args.args[0]
    haystack = f"{captured_exc!s}{captured_exc!r}"
    for context_call in mock_set_context.call_args_list:
        haystack += str(context_call.args) + str(context_call.kwargs)
    for line in private_key_lines:
        assert line not in haystack


@pytest.mark.asyncio
async def test_no_key_leak_on_transport_error_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    private_key, public_key, _key = generate_keypair()
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", private_key.decode())
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", public_key.decode())
    private_key_lines = _pem_body_lines(private_key.decode())

    p256dh, auth = _fresh_subscription_keys()
    client = _mock_client(side_effect=httpx.ConnectError("connection refused"))
    with (
        patch("app.services.push_send.sentry_sdk.capture_exception") as mock_capture,
        patch("app.services.push_send.sentry_sdk.set_context") as mock_set_context,
    ):
        await push_send.send_to_subscription(
            client, endpoint=_ENDPOINT, p256dh=p256dh, auth=auth, payload=_PAYLOAD
        )
    haystack = ""
    for capture_call in mock_capture.call_args_list:
        haystack += str(capture_call.args) + str(capture_call.kwargs)
    for context_call in mock_set_context.call_args_list:
        haystack += str(context_call.args) + str(context_call.kwargs)
    for line in private_key_lines:
        assert line not in haystack


# ---------------------------------------------------------------------------
# send_to_user: fan-out, idempotent prune, unconfigured short-circuit
# ---------------------------------------------------------------------------


async def _seed_subscriptions(session: AsyncSession, *, user_id: int, count: int) -> list[str]:
    endpoints = []
    for i in range(count):
        p256dh, auth = _fresh_subscription_keys()
        endpoint = f"https://fcm.googleapis.com/fcm/send/fanout-{user_id}-{i}"
        await push_repository.upsert_subscription(
            session, user_id=user_id, endpoint=endpoint, p256dh=p256dh, auth=auth, user_agent=None
        )
        endpoints.append(endpoint)
    await session.flush()
    return endpoints


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_user_fan_out_prunes_only_the_410_not_the_500(
    db_session: AsyncSession,
) -> None:
    """3 subscriptions: 201 (delivered), 410 (prune), 500 (transient, leave alone).

    Proves both halves of PUSH-02's prune contract in one fan-out: the 410
    response deletes exactly its row, and the 500 response deletes none.
    """
    user = User(email="push-fanout@example.com", hashed_password="fakehash")
    db_session.add(user)
    await db_session.flush()
    endpoints = await _seed_subscriptions(db_session, user_id=user.id, count=3)

    responses = [MagicMock(status_code=201), MagicMock(status_code=410), MagicMock(status_code=500)]
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = responses
        result = await push_send.send_to_user(db_session, user_id=user.id, payload=_PAYLOAD)

    assert result.attempted == 3
    assert result.pruned == 1
    assert result.failed == 0

    remaining = await push_repository.list_subscriptions(db_session, user_id=user.id)
    assert len(remaining) == 2
    remaining_endpoints = {row.endpoint for row in remaining}
    assert endpoints[0] in remaining_endpoints  # 201 -- delivered, untouched
    assert endpoints[1] not in remaining_endpoints  # 410 -- pruned
    assert endpoints[2] in remaining_endpoints  # 500 -- transient, left alone


@pytest.mark.asyncio
@pytest.mark.usefixtures("vapid_keypair")
async def test_send_to_user_prune_is_idempotent_across_two_calls(
    db_session: AsyncSession,
) -> None:
    user = User(email="push-idempotent@example.com", hashed_password="fakehash")
    db_session.add(user)
    await db_session.flush()
    await _seed_subscriptions(db_session, user_id=user.id, count=1)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = MagicMock(status_code=410)
        first = await push_send.send_to_user(db_session, user_id=user.id, payload=_PAYLOAD)

    assert first.attempted == 1
    assert first.pruned == 1

    # Second pass: the subscription is already gone, so nothing is attempted
    # and nothing raises -- this IS the idempotency contract (PUSH-02).
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post_2:
        second = await push_send.send_to_user(db_session, user_id=user.id, payload=_PAYLOAD)

    assert second.attempted == 0
    assert second.pruned == 0
    mock_post_2.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_to_user_unconfigured_returns_zero_result(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Email must not collide with any literal registered via a real POST
    # /api/auth/register elsewhere in the suite (those commit outside this
    # fixture's rollback scope). tests/routers/test_push.py owns
    # "push-unconfigured@example.com"; under serial CI collection the two
    # would hit ix_users_email. See CLAUDE.md: CI runs serially (D-02).
    user = User(email="push-send-unconfigured@example.com", hashed_password="fakehash")
    db_session.add(user)
    await db_session.flush()
    await _seed_subscriptions(db_session, user_id=user.id, count=2)

    # Force the D-03 unconfigured state rather than inheriting it from the
    # machine's `.env` -- otherwise this passes only where push is NOT set up,
    # i.e. it goes red on any machine configured to actually exercise push.
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", "")
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", "")
    assert not push_send.is_push_configured()
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        result = await push_send.send_to_user(db_session, user_id=user.id, payload=_PAYLOAD)

    assert result.attempted == 0
    assert result.pruned == 0
    assert result.failed == 0
    mock_post.assert_not_awaited()


# ---------------------------------------------------------------------------
# PUSH-04 evidence: requests never enters the push send code path (Task 3)
# ---------------------------------------------------------------------------


def test_push_send_module_never_imports_requests_at_runtime() -> None:
    """Importing app.services.push_send in a clean interpreter never loads
    the `requests` module -- the real PUSH-04 contract. `requests` IS present
    in the resolved dependency tree (pulled in transitively by
    pydantic-ai-slim[google] -> google-genai -> google-auth[requests]), so
    asserting its absence from the tree would be false; the contract this
    phase must hold is that it never enters THIS code path."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import app.services.push_send, sys; "
            "assert 'requests' not in sys.modules, 'requests leaked into push_send import'",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_push_send_source_declares_no_top_level_requests_import() -> None:
    """AST-level (not substring) check that none of the three push modules
    declares `import requests` / `from requests import ...` at module scope."""
    modules = [
        REPO_ROOT / "app" / "services" / "push_send.py",
        REPO_ROOT / "app" / "routers" / "push.py",
        REPO_ROOT / "app" / "services" / "train_reminder_service.py",
    ]
    for module_path in modules:
        tree = ast.parse(module_path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert not any(alias.name == "requests" for alias in node.names), module_path
            elif isinstance(node, ast.ImportFrom):
                assert node.module != "requests", module_path
