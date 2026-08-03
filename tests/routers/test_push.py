"""Integration tests for the push router (Phase 201, PUSH-01..05, REMIND-08).

Coverage:
- test_dev_trigger_sends_real_encrypted_push_end_to_end : the whole chain
  (Task 1 tracer), subscribe -> dev trigger -> a real VAPID-signed,
  aes128gcm-encrypted POST.
- test_unsubscribe_removes_own_endpoint / test_unsubscribe_foreign_endpoint_removes_nothing :
  unsubscribe is scoped to the caller (V4/IDOR).
- test_vapid_public_key_200_when_configured / test_vapid_public_key_404_when_unconfigured :
  D-03's graceful-disable contract at the public-key endpoint.
- test_subscribe_503_when_unconfigured : D-03 at the subscribe endpoint.
- test_dev_trigger_404_outside_development : T-201-04's fail-closed gate.
- test_dev_trigger_reminder_body_names_day_one_for_zero_streak : D-10's "+1"
  framing removes the streak-0 case.

Follows `tests/routers/test_train.py`'s register-and-login-over-HTTP pattern.

Mocking note (deviation from the plan's literal "patch httpx.AsyncClient.post"
instruction, Rule 1 -- the literal instruction is not viable here): this file
drives the outer HTTP request through `httpx.AsyncClient` + `ASGITransport`
(the established router-test pattern). Patching `httpx.AsyncClient.post` at
the class level would ALSO intercept that outer driving call, since it is the
exact same class/method the router's internal `push_send` client uses --
there is no way to distinguish "the test's own call into the app" from "the
app's outbound push send" once both go through the same patched class method.
Instead, `app.services.push_send.push_http_client` (the factory the send path
calls to build its own outbound client) is patched to return a fake client
whose `.post` is the assertable mock -- this targets only the outbound push
send, leaving the test's own ASGI-transport request untouched.
"""

from __future__ import annotations

import base64
import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from app.services.push_crypto import generate_keypair

from app.core.config import settings as config_settings
from app.main import app
from app.services import train_reminder_service

SUBSCRIBE_ENDPOINT = "/api/push/subscribe"
UNSUBSCRIBE_ENDPOINT = "/api/push/unsubscribe"
VAPID_PUBLIC_KEY_ENDPOINT = "/api/push/vapid-public-key"
DEV_TRIGGER_ENDPOINT = "/api/push/dev/trigger-reminder"


class _FakePushHttpClient:
    """A minimal async-context-manager stand-in for `push_send.push_http_client()`.

    Delegates `.post(...)` to an injected `AsyncMock` so tests get the usual
    `assert_awaited_once()` / `.await_args` assertions without touching the
    real `httpx.AsyncClient` class (see module docstring).
    """

    def __init__(self, post_mock: AsyncMock) -> None:
        self._post_mock = post_mock

    async def __aenter__(self) -> "_FakePushHttpClient":
        return self

    async def __aexit__(self, *_exc_info: object) -> None:
        return None

    async def post(self, *args: Any, **kwargs: Any) -> Any:
        return await self._post_mock(*args, **kwargs)


async def _register_and_login(email: str, password: str = "testpass123!") -> tuple[int, str]:
    """Register a user via HTTP and return (user_id, auth_token)."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        reg = await client.post("/api/auth/register", json={"email": email, "password": password})
        assert reg.status_code in (200, 201), f"register failed: {reg.text}"
        user_id = int(reg.json()["id"])

        login = await client.post(
            "/api/auth/jwt/login",
            data={"username": email, "password": password},
        )
        assert login.status_code == 200, f"login failed: {login.text}"
        token = str(login.json()["access_token"])
    return user_id, token


def _fresh_subscription_keys() -> tuple[str, str]:
    """A realistic (p256dh, auth) pair -- a real EC public key + random secret,
    both base64url-encoded, matching what a real `PushSubscription.toJSON()`
    returns and what a browser's decryption will accept."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    p256dh = base64.urlsafe_b64encode(public_bytes).rstrip(b"=").decode()
    auth = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()
    return p256dh, auth


@pytest.fixture
def unconfigured_vapid(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force the D-03 unconfigured state regardless of the machine's `.env`.

    Without this the "unconfigured" tests silently depend on the developer's
    `.env` having no VAPID keys -- so they pass in CI and on a fresh checkout,
    but fail permanently on any machine set up to actually exercise push (which
    is exactly the machine running the phase UAT).
    """
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", "")
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", "")


@pytest.fixture
def vapid_keypair(monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """Configure a freshly generated VAPID keypair for the duration of one test."""
    private_key, public_key, _application_server_key = generate_keypair()
    monkeypatch.setattr(config_settings, "VAPID_PRIVATE_KEY", private_key.decode())
    monkeypatch.setattr(config_settings, "VAPID_PUBLIC_KEY", public_key.decode())
    return private_key.decode(), public_key.decode()


@pytest.mark.usefixtures("vapid_keypair")
async def test_dev_trigger_sends_real_encrypted_push_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The tracer: subscribe over HTTP, dev-trigger fans out one real send.

    Asserts the outbound POST target, the VAPID authorization header, the
    aes128gcm content-encoding header, and that the encrypted body is
    non-empty binary distinct from the plaintext JSON payload.
    """
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "development")
    _user_id, token = await _register_and_login("push-tracer@example.com")
    auth_header = {"Authorization": f"Bearer {token}"}
    p256dh, auth = _fresh_subscription_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/tracer-endpoint-id"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        sub_resp = await client.post(
            SUBSCRIBE_ENDPOINT,
            headers=auth_header,
            json={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
        )
        assert sub_resp.status_code == 201, sub_resp.text

        mock_post = AsyncMock(return_value=MagicMock(status_code=201))
        fake_client = _FakePushHttpClient(mock_post)
        with patch("app.services.push_send.push_http_client", return_value=fake_client):
            trigger_resp = await client.post(DEV_TRIGGER_ENDPOINT, headers=auth_header)

    assert trigger_resp.status_code == 200, trigger_resp.text
    body = trigger_resp.json()
    assert body["attempted"] == 1
    assert body["pruned"] == 0

    mock_post.assert_awaited_once()
    call = mock_post.await_args
    assert call is not None
    assert call.args[0] == endpoint
    headers = call.kwargs["headers"]
    assert headers["authorization"].startswith("vapid")
    assert headers["content-encoding"] == "aes128gcm"
    content = call.kwargs["content"]
    assert isinstance(content, bytes)
    assert len(content) > 0
    assert b"Day 1 is waiting" not in content
    assert b"train-reminder" not in content


@pytest.mark.usefixtures("vapid_keypair")
async def test_resubscribe_after_prune_restores_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PUSHREL-01/PUSHREL-06 (Phase 204, SEED-135 D2): the desync-and-recover
    round trip at the HTTP layer.

    The unsubscribe call stands in for a server-side prune's row deletion --
    the resulting server state (no `push_subscriptions` row, device still
    holds the subscription) is identical either way, and the prune path
    itself is already covered by `tests/test_push_send.py`'s status-branch
    table. Re-POSTing the identical body is exactly what
    `resyncExistingSubscription` (`frontend/src/lib/push.ts`) does -- a
    blind, idempotent re-POST to the existing `POST /push/subscribe`, relying
    on `upsert_subscription`'s `ON CONFLICT DO UPDATE` on `endpoint`.
    """
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "development")
    _user_id, token = await _register_and_login("push-resubscribe@example.com")
    auth_header = {"Authorization": f"Bearer {token}"}
    p256dh, auth = _fresh_subscription_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/resubscribe-endpoint"
    subscribe_body = {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        sub_resp = await client.post(SUBSCRIBE_ENDPOINT, headers=auth_header, json=subscribe_body)
        assert sub_resp.status_code == 201, sub_resp.text

        # Stands in for a 404/410 prune -- leaves the exact state a pruned
        # device is in: no server-side row, device still holds the
        # subscription.
        unsub_resp = await client.post(
            UNSUBSCRIBE_ENDPOINT, headers=auth_header, json={"endpoint": endpoint}
        )
        assert unsub_resp.status_code == 204, unsub_resp.text

        mock_post = AsyncMock(return_value=MagicMock(status_code=201))
        fake_client = _FakePushHttpClient(mock_post)
        with patch("app.services.push_send.push_http_client", return_value=fake_client):
            # The dark state SEED-135 describes: the device is unreachable.
            dark_trigger_resp = await client.post(DEV_TRIGGER_ENDPOINT, headers=auth_header)
        assert dark_trigger_resp.status_code == 200, dark_trigger_resp.text
        assert dark_trigger_resp.json()["attempted"] == 0

        # The blind idempotent re-POST `resyncExistingSubscription` performs
        # -- the identical body, no new endpoint.
        resync_resp = await client.post(
            SUBSCRIBE_ENDPOINT, headers=auth_header, json=subscribe_body
        )
        assert resync_resp.status_code == 201, resync_resp.text

        mock_post_after_resync = AsyncMock(return_value=MagicMock(status_code=201))
        fake_client_after_resync = _FakePushHttpClient(mock_post_after_resync)
        with patch(
            "app.services.push_send.push_http_client", return_value=fake_client_after_resync
        ):
            recovered_trigger_resp = await client.post(DEV_TRIGGER_ENDPOINT, headers=auth_header)

    assert recovered_trigger_resp.status_code == 200, recovered_trigger_resp.text
    recovered_body = recovered_trigger_resp.json()
    # attempted == 1, not 2 -- the ON CONFLICT DO UPDATE idempotency proof.
    # A duplicate row from the re-POST would make this 2.
    assert recovered_body["attempted"] == 1
    assert recovered_body["pruned"] == 0


# ---------------------------------------------------------------------------
# Unsubscribe scoping (V4/IDOR)
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("vapid_keypair")
async def test_unsubscribe_removes_own_endpoint() -> None:
    _user_id, token = await _register_and_login("push-unsub-owner@example.com")
    auth_header = {"Authorization": f"Bearer {token}"}
    p256dh, auth = _fresh_subscription_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/unsub-owner-endpoint"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        sub_resp = await client.post(
            SUBSCRIBE_ENDPOINT,
            headers=auth_header,
            json={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
        )
        assert sub_resp.status_code == 201, sub_resp.text

        unsub_resp = await client.post(
            UNSUBSCRIBE_ENDPOINT, headers=auth_header, json={"endpoint": endpoint}
        )
    assert unsub_resp.status_code == 204


@pytest.mark.usefixtures("vapid_keypair")
async def test_unsubscribe_foreign_endpoint_removes_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # This test proves the point via the dev-trigger endpoint, which is gated on
    # ENVIRONMENT == "development" and 404s otherwise. It passed locally (dev .env)
    # but failed in CI, where ENVIRONMENT is not development -- the gate has to be
    # forced here the same way the other dev-trigger tests do it.
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "development")
    _owner_id, owner_token = await _register_and_login("push-unsub-victim@example.com")
    owner_header = {"Authorization": f"Bearer {owner_token}"}
    _attacker_id, attacker_token = await _register_and_login("push-unsub-attacker@example.com")
    attacker_header = {"Authorization": f"Bearer {attacker_token}"}
    p256dh, auth = _fresh_subscription_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/unsub-victim-endpoint"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        sub_resp = await client.post(
            SUBSCRIBE_ENDPOINT,
            headers=owner_header,
            json={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
        )
        assert sub_resp.status_code == 201, sub_resp.text

        # The attacker's unsubscribe call carries the victim's endpoint --
        # it returns 204 (no IDOR-revealing distinction) but removes nothing.
        attacker_unsub_resp = await client.post(
            UNSUBSCRIBE_ENDPOINT, headers=attacker_header, json={"endpoint": endpoint}
        )
        assert attacker_unsub_resp.status_code == 204

        mock_post = AsyncMock(return_value=MagicMock(status_code=201))
        fake_client = _FakePushHttpClient(mock_post)
        with patch("app.services.push_send.push_http_client", return_value=fake_client):
            # The owner's own dev-trigger still reaches their still-live
            # subscription -- proof the attacker's call removed nothing.
            trigger_resp = await client.post(
                DEV_TRIGGER_ENDPOINT,
                headers=owner_header,
            )
    assert trigger_resp.status_code == 200
    assert trigger_resp.json()["attempted"] == 1


# ---------------------------------------------------------------------------
# D-03: graceful disable when VAPID is unconfigured
# ---------------------------------------------------------------------------


async def test_vapid_public_key_200_when_configured(vapid_keypair: tuple[str, str]) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get(VAPID_PUBLIC_KEY_ENDPOINT)
    assert resp.status_code == 200
    assert resp.json()["application_server_key"]


@pytest.mark.usefixtures("unconfigured_vapid")
async def test_vapid_public_key_404_when_unconfigured() -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get(VAPID_PUBLIC_KEY_ENDPOINT)
    assert resp.status_code == 404


@pytest.mark.usefixtures("unconfigured_vapid")
async def test_subscribe_503_when_unconfigured() -> None:
    _user_id, token = await _register_and_login("push-unconfigured@example.com")
    auth_header = {"Authorization": f"Bearer {token}"}
    p256dh, auth = _fresh_subscription_keys()

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            SUBSCRIBE_ENDPOINT,
            headers=auth_header,
            json={
                "endpoint": "https://fcm.googleapis.com/fcm/send/unconfigured",
                "keys": {"p256dh": p256dh, "auth": auth},
            },
        )
    assert resp.status_code == 503


# ---------------------------------------------------------------------------
# Dev trigger (T-201-04, D-10)
# ---------------------------------------------------------------------------


async def test_dev_trigger_404_outside_development(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "production")
    _user_id, token = await _register_and_login("push-dev-trigger-prod@example.com")
    auth_header = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(DEV_TRIGGER_ENDPOINT, headers=auth_header)
    assert resp.status_code == 404


@pytest.mark.usefixtures("vapid_keypair")
async def test_dev_trigger_reminder_body_names_day_one_for_zero_streak(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D-10: a brand-new user (streak_count == 0) reads "Day 1", never "Day 0"."""
    monkeypatch.setattr(config_settings, "ENVIRONMENT", "development")
    _user_id, token = await _register_and_login("push-day-one@example.com")
    auth_header = {"Authorization": f"Bearer {token}"}
    p256dh, auth = _fresh_subscription_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/day-one-endpoint"

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        sub_resp = await client.post(
            SUBSCRIBE_ENDPOINT,
            headers=auth_header,
            json={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
        )
        assert sub_resp.status_code == 201, sub_resp.text

        # The encrypted body is opaque, so spy on build_reminder_payload
        # (the router calls it directly) to see both the streak_count it was
        # given AND the exact plaintext body that produces.
        captured_body: dict[str, object] = {}

        def _spy_build_reminder_payload(*, streak_count: int) -> dict[str, object]:
            result = train_reminder_service.build_reminder_payload(streak_count=streak_count)
            captured_body.update(result)
            return result

        with patch(
            "app.routers.push.build_reminder_payload", side_effect=_spy_build_reminder_payload
        ) as mock_build_payload:
            mock_post = AsyncMock(return_value=MagicMock(status_code=201))
            fake_client = _FakePushHttpClient(mock_post)
            with patch("app.services.push_send.push_http_client", return_value=fake_client):
                trigger_resp = await client.post(DEV_TRIGGER_ENDPOINT, headers=auth_header)

    assert trigger_resp.status_code == 200, trigger_resp.text
    mock_build_payload.assert_called_once_with(streak_count=0)
    assert captured_body["body"] == "Day 1 is waiting."
