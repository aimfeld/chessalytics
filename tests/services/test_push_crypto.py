"""Tests for the vendored Web Push crypto (RFC 8291 / RFC 8292).

The decisive test here is `test_matches_upstream_webpush_byte_for_byte`, which
pins `app.services.push_crypto` against the `webpush` package it was vendored
from. It runs only while that package is installed, which it no longer is in
the normal dependency set -- so it SKIPS by default and is meant to be run
deliberately:

    uv run --with webpush==1.0.6 pytest tests/services/test_push_crypto.py -v

That is how the vendoring was verified before the dependency was dropped, and
how it should be re-verified if this module is ever changed. The remaining
tests are self-contained and run in the normal suite: they decrypt our own
output with an independent implementation of the receiver side, which catches
any RFC-level mistake without needing upstream at all.
"""

import base64
import struct
import time

import jwt
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.services import push_crypto

_ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
_SUBJECT = "push@flawchess.com"
_EXPIRATION = 12 * 60 * 60


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _make_subscription_keys() -> tuple[ec.EllipticCurvePrivateKey, str, str]:
    """A recipient keypair plus the (p256dh, auth) a browser would hand us."""
    recipient = ec.generate_private_key(ec.SECP256R1())
    p256dh = _b64url(
        recipient.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    )
    auth = _b64url(b"0123456789abcdef")
    return recipient, p256dh, auth


def _decrypt_as_recipient(record: bytes, recipient: ec.EllipticCurvePrivateKey, auth: str) -> bytes:
    """Independent receiver-side implementation of RFC 8291.

    Deliberately written from the spec's perspective (parse header, redo the
    ECDH + two-stage HKDF, open the AEAD) rather than by calling into
    push_crypto, so a bug in the sender cannot cancel itself out here.
    """
    salt = record[:16]
    key_id_len = struct.unpack("!B", record[20:21])[0]
    sender_public_bytes = record[21 : 21 + key_id_len]
    ciphertext = record[21 + key_id_len :]

    recipient_public_bytes = recipient.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    shared = recipient.exchange(
        ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), sender_public_bytes)
    )
    ikm = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=push_crypto._b64url_decode(auth),
        info=b"WebPush: info\x00" + recipient_public_bytes + sender_public_bytes,
    ).derive(shared)
    key = HKDF(
        algorithm=hashes.SHA256(),
        length=16,
        salt=salt,
        info=b"Content-Encoding: aes128gcm\x00",
    ).derive(ikm)
    nonce = HKDF(
        algorithm=hashes.SHA256(), length=12, salt=salt, info=b"Content-Encoding: nonce\x00"
    ).derive(ikm)

    plaintext = AESGCM(key).decrypt(nonce, ciphertext, associated_data=None)
    assert plaintext.endswith(b"\x02"), "RFC 8291 padding delimiter missing"
    return plaintext[:-1]


# ---------------------------------------------------------------------------
# Round-trip: a real receiver can decrypt what we produce.
# ---------------------------------------------------------------------------


def test_payload_round_trips_through_an_independent_receiver() -> None:
    recipient, p256dh, auth = _make_subscription_keys()
    payload = b'{"title":"FlawChess","body":"Day 4 is waiting."}'

    record = push_crypto.encrypt_aes128gcm(payload=payload, p256dh=p256dh, auth=auth)

    assert _decrypt_as_recipient(record, recipient, auth) == payload


def test_record_header_layout_is_rfc8188() -> None:
    _recipient, p256dh, auth = _make_subscription_keys()

    record = push_crypto.encrypt_aes128gcm(payload=b"x", p256dh=p256dh, auth=auth)

    assert len(record[:16]) == 16  # salt
    assert struct.unpack("!L", record[16:20])[0] == 4096  # record size
    assert struct.unpack("!B", record[20:21])[0] == 65  # uncompressed P-256 point


def test_each_call_uses_a_fresh_salt_and_ephemeral_key() -> None:
    """Reusing either would leak plaintext across sends to the same device."""
    _recipient, p256dh, auth = _make_subscription_keys()

    first = push_crypto.encrypt_aes128gcm(payload=b"same", p256dh=p256dh, auth=auth)
    second = push_crypto.encrypt_aes128gcm(payload=b"same", p256dh=p256dh, auth=auth)

    assert first[:16] != second[:16]  # salt
    assert first[21:86] != second[21:86]  # ephemeral public key
    assert first != second


def test_wrong_auth_secret_fails_to_decrypt() -> None:
    recipient, p256dh, auth = _make_subscription_keys()
    record = push_crypto.encrypt_aes128gcm(payload=b"secret", p256dh=p256dh, auth=auth)

    with pytest.raises(Exception):
        _decrypt_as_recipient(record, recipient, _b64url(b"fedcba9876543210"))


# ---------------------------------------------------------------------------
# VAPID
# ---------------------------------------------------------------------------


def test_vapid_authorization_claims_and_signature() -> None:
    private_pem, public_pem, application_server_key = push_crypto.generate_keypair()
    now = int(time.time())

    header = push_crypto.vapid_authorization(
        endpoint=_ENDPOINT,
        subject=_SUBJECT,
        private_key_pem=private_pem,
        public_key_pem=public_pem,
        expiration_seconds=_EXPIRATION,
        now=now,
    )

    assert header.startswith("vapid t=")
    token, key_part = header.removeprefix("vapid t=").split(", k=")
    assert key_part == application_server_key

    # Verified with the PUBLIC key -- proves the signature is genuine ES256,
    # not just a well-shaped string.
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    claims = jwt.decode(
        token,
        key=load_pem_public_key(public_pem),  # ty: ignore[invalid-argument-type]
        algorithms=["ES256"],
        audience="https://fcm.googleapis.com",
    )
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert claims["sub"] == f"mailto:{_SUBJECT}"
    assert claims["exp"] == now + _EXPIRATION


def test_application_server_key_is_uncompressed_point() -> None:
    _private_pem, public_pem, application_server_key = push_crypto.generate_keypair()

    raw = push_crypto._b64url_decode(application_server_key)

    assert len(raw) == 65 and raw[0] == 0x04
    assert push_crypto.application_server_key_from_pem(public_pem) == application_server_key


def test_generate_keypair_emits_loadable_pem() -> None:
    from cryptography.hazmat.primitives.serialization import (
        load_pem_private_key,
        load_pem_public_key,
    )

    private_pem, public_pem, _key = push_crypto.generate_keypair()

    assert private_pem.startswith(b"-----BEGIN PRIVATE KEY-----")
    assert public_pem.startswith(b"-----BEGIN PUBLIC KEY-----")
    assert load_pem_private_key(private_pem, password=None) is not None
    assert load_pem_public_key(public_pem) is not None


# ---------------------------------------------------------------------------
# Differential test against the package this module was vendored from.
# ---------------------------------------------------------------------------


def test_matches_upstream_webpush_byte_for_byte(monkeypatch: pytest.MonkeyPatch) -> None:
    """Our output must equal `webpush`'s given identical randomness.

    Run with:  uv run --with webpush==1.0.6 pytest tests/services/test_push_crypto.py -v

    Both implementations draw randomness from `os.urandom` and
    `ec.generate_private_key`, so pinning those two makes the comparison exact
    rather than structural.
    """
    webpush = pytest.importorskip(
        "webpush",
        reason="upstream `webpush` is intentionally not a dependency; see module docstring",
    )

    private_pem, public_pem, _key = push_crypto.generate_keypair()
    _recipient, p256dh, auth = _make_subscription_keys()
    fixed_salt = b"\x11" * 16
    fixed_ephemeral = ec.generate_private_key(ec.SECP256R1())
    now = 1_800_000_000

    monkeypatch.setattr(push_crypto.os, "random_unused", None, raising=False)
    monkeypatch.setattr("os.urandom", lambda n: fixed_salt[:n])
    monkeypatch.setattr(ec, "generate_private_key", lambda *a, **kw: fixed_ephemeral)
    monkeypatch.setattr(time, "time", lambda: now)

    payload = {"title": "FlawChess", "body": "Day 4 is waiting."}

    upstream = webpush.WebPush(
        private_key=private_pem,
        public_key=public_pem,
        subscriber=_SUBJECT,
        expiration=_EXPIRATION,
    ).get(
        message=payload,
        subscription=webpush.WebPushSubscription(
            endpoint=_ENDPOINT,
            keys=webpush.types.WebPushKeys(p256dh=p256dh, auth=auth),
        ),
    )

    import json

    ours_encrypted = push_crypto.encrypt_aes128gcm(
        payload=json.dumps(payload).encode(), p256dh=p256dh, auth=auth
    )
    ours_authorization = push_crypto.vapid_authorization(
        endpoint=_ENDPOINT,
        subject=_SUBJECT,
        private_key_pem=private_pem,
        public_key_pem=public_pem,
        expiration_seconds=_EXPIRATION,
        now=now,
    )

    assert ours_encrypted == upstream.encrypted
    # ES256 is randomized, so the JWTs differ byte-wise by design; compare the
    # claims and the `k=` key, which are what a push service actually checks.
    assert ours_authorization.split(", k=")[1] == upstream.headers["authorization"].split(", k=")[1]
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    verify_key = load_pem_public_key(public_pem)
    ours_claims = jwt.decode(
        ours_authorization.removeprefix("vapid t=").split(", k=")[0],
        key=verify_key,  # ty: ignore[invalid-argument-type]
        algorithms=["ES256"],
        audience="https://fcm.googleapis.com",
    )
    upstream_claims = jwt.decode(
        upstream.headers["authorization"].removeprefix("vapid t=").split(", k=")[0],
        key=verify_key,  # ty: ignore[invalid-argument-type]
        algorithms=["ES256"],
        audience="https://fcm.googleapis.com",
    )
    assert ours_claims == upstream_claims
