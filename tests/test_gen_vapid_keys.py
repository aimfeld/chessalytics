"""The keygen script must emit .env lines that actually parse back to a usable PEM.

Regression guard for the silent-disable trap: a raw multi-line PEM pasted under
a bare `VAPID_PRIVATE_KEY=` parses as an empty string, and D-03 then turns push
off with no error anywhere. These tests round-trip the script's real output
through python-dotenv (the parser pydantic-settings uses for `.env`) and hand
the result to the production key loaders.
"""

import subprocess
import sys
from pathlib import Path

from dotenv import dotenv_values

from scripts.gen_vapid_keys import as_env_value

REPO_ROOT = Path(__file__).resolve().parents[1]

_PEM = "-----BEGIN PRIVATE KEY-----\nMIGHAGEAMBMGByqGSM49\nAwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n"


def _parse_env_line(tmp_path: Path, line: str) -> str | None:
    env_file = tmp_path / "probe.env"
    env_file.write_text(f"VAPID_PRIVATE_KEY={line}\n")
    return dotenv_values(env_file).get("VAPID_PRIVATE_KEY")


def test_as_env_value_round_trips_through_dotenv(tmp_path: Path) -> None:
    assert _parse_env_line(tmp_path, as_env_value(_PEM)) == _PEM


def test_raw_pem_does_not_round_trip(tmp_path: Path) -> None:
    """The trap this script exists to avoid: unquoted PEM parses to empty.

    Pinning the BROKEN behavior keeps `as_env_value`'s quoting load-bearing --
    drop the quotes/escaping and the test above fails for this exact reason.
    """
    assert _parse_env_line(tmp_path, f"\n{_PEM}") != _PEM


def test_script_output_parses_and_loads_as_real_keys(tmp_path: Path) -> None:
    """End-to-end: run the script, parse its output, load both keys for real."""
    result = subprocess.run(
        [sys.executable, "scripts/gen_vapid_keys.py"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )

    env_file = tmp_path / "generated.env"
    env_file.write_text(result.stdout)
    values = dotenv_values(env_file)

    private_pem = values["VAPID_PRIVATE_KEY"]
    public_pem = values["VAPID_PUBLIC_KEY"]
    assert private_pem is not None and public_pem is not None
    # Decoded back to a genuine multi-line PEM, not a literal backslash-n blob.
    assert private_pem.startswith("-----BEGIN PRIVATE KEY-----\n")
    assert public_pem.startswith("-----BEGIN PUBLIC KEY-----\n")
    assert "\\n" not in private_pem
    assert values["VAPID_SUBJECT"] == "push@flawchess.com"

    # The production loaders accept them (this is what would 403 every send if
    # the PEM were truncated by a bad paste).
    from cryptography.hazmat.primitives.serialization import (
        load_pem_private_key,
        load_pem_public_key,
    )

    assert load_pem_private_key(private_pem.encode(), password=None) is not None
    assert load_pem_public_key(public_pem.encode()) is not None
