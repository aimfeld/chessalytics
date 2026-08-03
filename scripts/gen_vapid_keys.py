"""One-shot VAPID keypair generator (Phase 201, PUSH-03, D-03).

Prints a fresh VAPID keypair as paste-ready .env lines. This script touches no
database -- VAPID keys are never auto-generated into Postgres (that would put
the private key in every DB dump, violating PUSH-03).

The keys are PEM, which is multi-line, but a raw PEM block pasted under a bare
`VAPID_PRIVATE_KEY=` does NOT parse: python-dotenv reads the value as empty and
drops the PEM lines (they contain no `=`), and D-03 then disables push silently.
So we emit each key as a single double-quoted line with `\\n` escapes -- a form
both python-dotenv (local `.env`) and Docker Compose's `env_file:` (prod) decode
back to a real multi-line PEM.

Single-line is deliberate over a quoted multi-line block: both parse, but on a
hand-edited /opt/flawchess/.env one missing closing quote makes a multi-line
value swallow every variable after it, including the DB password.

Rotating the key invalidates every existing subscription (D-02): rotate only
on key compromise, and truncate push_subscriptions when you do, so the 410
prune sweep is not the only cleanup.

Usage:
    uv run python scripts/gen_vapid_keys.py
"""

import sys
from pathlib import Path

# Bootstrap project root so `app.*` imports resolve when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.services.push_crypto import generate_keypair  # noqa: E402

DEFAULT_SUBJECT = "push@flawchess.com"


def as_env_value(pem: str) -> str:
    """Render a multi-line PEM as a single double-quoted, `\\n`-escaped .env value."""
    return '"' + pem.replace("\n", "\\n") + '"'


if __name__ == "__main__":
    private_key, public_key, application_server_key = generate_keypair()

    print("# Paste these three lines verbatim, quotes included, into your .env.")
    print("# Do NOT paste the raw PEM block -- an unquoted multi-line value parses")
    print("# as empty and push then disables itself silently (D-03).")
    print()
    print(f"VAPID_PUBLIC_KEY={as_env_value(public_key.decode())}")
    print(f"VAPID_PRIVATE_KEY={as_env_value(private_key.decode())}")
    print(f"VAPID_SUBJECT={DEFAULT_SUBJECT}")
    print()
    print("# Prod: /opt/flawchess/.env only, never committed.")
    print("# Local dev: optional -- leave the keys empty and push stays cleanly")
    print("# disabled (subscribe 503s, the public-key endpoint 404s, nothing sends),")
    print("# so tests and CI need zero setup. Set them only to exercise push")
    print("# locally, and generate a SEPARATE pair -- never copy the prod private key.")
    print()
    print("# Application server key (informational only -- NOT an .env var; the")
    print("# backend derives it from VAPID_PUBLIC_KEY at runtime via")
    print("# app.services.push_send.application_server_key(), so it can never drift")
    print("# out of sync with the PEM). This is the value PushManager.subscribe()")
    print("# needs as applicationServerKey:")
    print(f"#   {application_server_key}")
