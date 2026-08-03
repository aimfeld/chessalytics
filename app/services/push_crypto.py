"""Web Push cryptography: VAPID (RFC 8292) signing and aes128gcm (RFC 8291) payloads.

Vendored from the `webpush` package (https://github.com/delvinru/webpush-py,
MIT, v1.0.6) rather than taken as a dependency. The upstream project is ~330
lines of which we used ~110, adds no transitive packages we do not already
have, and has low commit activity -- so carrying it as a third-party dependency
bought us little and left us exposed to abandonment. Vendoring is not
hand-rolling: every primitive below comes from `cryptography` and `pyjwt`, and
`tests/services/test_push_crypto.py` pinned this module byte-for-byte against
the upstream implementation before the dependency was removed.

Upstream copyright (c) delvinru, MIT License.

Known deviation from strict RFC 8292: the JWT `aud` claim is built as
`scheme://hostname`, omitting a non-default port. This matches upstream (and
therefore what has been exercised against real push services); every real push
endpoint -- FCM, Mozilla autopush, Apple -- is https on the default port.
"""

import base64
import os
import struct
from urllib.parse import urlparse

import jwt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_public_key,
)

# RFC 8188 record size advertised in the aes128gcm header. Upstream's value;
# our payloads are ~200 bytes, far below it.
_RECORD_SIZE = 4096

# RFC 8291 requires a single 0x02 delimiter byte appended before encryption.
_PADDING_DELIMITER = b"\x02"

_SALT_BYTES = 16
_CONTENT_ENCODING_KEY_BYTES = 16
_NONCE_BYTES = 12
_IKM_BYTES = 32


def _b64url_decode(value: str) -> bytes:
    """Decode an unpadded base64url string (subscription keys arrive unpadded)."""
    if (remainder := len(value) % 4) != 0:
        value += "=" * (4 - remainder)
    return base64.urlsafe_b64decode(value)


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def encrypt_aes128gcm(*, payload: bytes, p256dh: str, auth: str) -> bytes:
    """Encrypt `payload` for one subscription, returning a full aes128gcm record.

    RFC 8291: ECDH against the subscription's public key, a two-stage HKDF
    (auth secret -> IKM, then content-encryption key + nonce), AES-GCM, and the
    aes128gcm header `salt || record_size || key_id_len || ephemeral_pubkey`.

    Args:
        payload: Plaintext body (already serialized).
        p256dh: The subscription's base64url P-256 public key.
        auth: The subscription's base64url auth secret.
    """
    auth_secret = _b64url_decode(auth)
    subscription_public_bytes = _b64url_decode(p256dh)

    salt = os.urandom(_SALT_BYTES)
    ephemeral_key = ec.generate_private_key(ec.SECP256R1())
    ephemeral_public_bytes = ephemeral_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    subscription_public_key = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), subscription_public_bytes
    )

    shared_secret = ephemeral_key.exchange(ec.ECDH(), subscription_public_key)

    # Stage 1: the auth secret salts the shared secret into the IKM. The info
    # string binds both public keys, so a record cannot be replayed at another
    # subscription.
    ikm = HKDF(
        algorithm=hashes.SHA256(),
        length=_IKM_BYTES,
        salt=auth_secret,
        info=b"WebPush: info\x00" + subscription_public_bytes + ephemeral_public_bytes,
    ).derive(shared_secret)

    # Stage 2: the record salt splits the IKM into key and nonce.
    content_encryption_key = HKDF(
        algorithm=hashes.SHA256(),
        length=_CONTENT_ENCODING_KEY_BYTES,
        salt=salt,
        info=b"Content-Encoding: aes128gcm\x00",
    ).derive(ikm)
    nonce = HKDF(
        algorithm=hashes.SHA256(),
        length=_NONCE_BYTES,
        salt=salt,
        info=b"Content-Encoding: nonce\x00",
    ).derive(ikm)

    ciphertext = AESGCM(content_encryption_key).encrypt(
        nonce, payload + _PADDING_DELIMITER, associated_data=None
    )

    return (
        salt
        + struct.pack("!L", _RECORD_SIZE)
        + struct.pack("!B", len(ephemeral_public_bytes))
        + ephemeral_public_bytes
        + ciphertext
    )


def vapid_authorization(
    *,
    endpoint: str,
    subject: str,
    private_key_pem: bytes,
    public_key_pem: bytes,
    expiration_seconds: int,
    now: int,
) -> str:
    """Build the `Authorization: vapid t=<jwt>, k=<key>` header value (RFC 8292).

    Args:
        endpoint: The subscription endpoint; its origin becomes the `aud` claim.
        subject: Contact address for the `sub` claim (rendered as `mailto:`).
        private_key_pem: VAPID private key, PEM.
        public_key_pem: VAPID public key, PEM.
        expiration_seconds: Lifetime of the token. RFC 8292 caps this at 24h;
            the caller enforces that bound.
        now: Current UNIX time. Passed in rather than read here so the value is
            testable and the module stays free of ambient clock reads.
    """
    parsed = urlparse(endpoint)
    token = jwt.encode(
        payload={
            "aud": f"{parsed.scheme}://{parsed.hostname}",
            "exp": now + expiration_seconds,
            "sub": f"mailto:{subject}",
        },
        key=private_key_pem,
        algorithm="ES256",
    )
    return f"vapid t={token}, k={application_server_key_from_pem(public_key_pem)}"


def application_server_key_from_pem(public_key_pem: bytes) -> str:
    """Return the base64url X9.62 uncompressed point `PushManager.subscribe()` needs."""
    public_key = load_pem_public_key(public_key_pem)
    return _b64url_encode(public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))


def generate_keypair() -> tuple[bytes, bytes, str]:
    """Generate a fresh VAPID keypair: (private PEM, public PEM, application server key)."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()
    public_pem = public_key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
    return (
        private_key.private_bytes(
            Encoding.PEM, PrivateFormat.PKCS8, encryption_algorithm=NoEncryption()
        ),
        public_pem,
        application_server_key_from_pem(public_pem),
    )
