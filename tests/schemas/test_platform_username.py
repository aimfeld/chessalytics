"""Schema tests for pasted chess.com/lichess profile-URL username normalization
(quick 260809-iq1, D-01/D-03/D-04).

Covers the shared `extract_platform_username` helper plus the two schemas that
wire it in: `ImportRequest.username` and `UserProfileUpdate.chess_com_username`
/ `.lichess_username`. Pure schema tests, no DB, matching the existing
`tests/schemas/` files.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.platform_usernames import UsernamePlatform, extract_platform_username
from app.schemas.imports import ImportRequest
from app.schemas.users import UserProfileUpdate

# ── extract_platform_username ──────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "platform", "expected"),
    [
        ("https://www.chess.com/member/hikaru", "chess.com", "hikaru"),
        ("chess.com/member/hikaru", "chess.com", "hikaru"),
        ("http://chess.com/member/hikaru/", "chess.com", "hikaru"),
        ("https://www.chess.com/member/hikaru?tab=stats", "chess.com", "hikaru"),
        ("https://www.chess.com/member/hikaru/stats#games", "chess.com", "hikaru"),
        ("https://lichess.org/@/DrNykterstein", "lichess", "DrNykterstein"),
        ("lichess.org/@/DrNykterstein/perf/blitz", "lichess", "DrNykterstein"),
        ("  hikaru  ", "chess.com", "hikaru"),
        ("  hikaru  ", "lichess", "hikaru"),
        ("", "chess.com", ""),
        # Cross-platform mismatch: passed through unchanged (trimmed), not extracted.
        ("https://lichess.org/@/foo", "chess.com", "https://lichess.org/@/foo"),
        # Case-insensitive host/path matching, casing of the username preserved.
        ("CHESS.COM/Member/Hikaru", "chess.com", "Hikaru"),
    ],
)
def test_extract_platform_username(value: str, platform: UsernamePlatform, expected: str) -> None:
    assert extract_platform_username(value, platform) == expected


def test_extract_platform_username_platform_none_accepts_either_form() -> None:
    assert extract_platform_username("https://lichess.org/@/foo", platform=None) == "foo"
    assert extract_platform_username("https://www.chess.com/member/bar", platform=None) == "bar"


def test_extract_platform_username_non_str_input_untouched() -> None:
    # Non-str input is returned untouched so Pydantic's own type error still
    # surfaces. Deliberately pass non-str values to exercise the runtime
    # isinstance guard -- ty: ignore[invalid-argument-type] is the sanctioned
    # suppression for a call that intentionally violates its own signature.
    assert extract_platform_username(None, "chess.com") is None  # ty: ignore[invalid-argument-type]
    assert extract_platform_username(123, "chess.com") == 123


# ── ImportRequest ───────────────────────────────────────────────────────────


def test_import_request_extracts_chess_com_url() -> None:
    req = ImportRequest(platform="chess.com", username="https://www.chess.com/member/hikaru")
    assert req.username == "hikaru"


def test_import_request_extracts_lichess_url() -> None:
    req = ImportRequest(platform="lichess", username="https://lichess.org/@/DrNykterstein")
    assert req.username == "DrNykterstein"


def test_import_request_plain_username_unchanged() -> None:
    req = ImportRequest(platform="chess.com", username="hikaru")
    assert req.username == "hikaru"


def test_import_request_long_url_normalized_before_max_length_check() -> None:
    # Proves the validator runs in `before` mode: a >100-char pasted URL is
    # shortened to the bare username rather than rejected by max_length=100.
    long_query = "?ref=" + "x" * 150
    url = f"https://www.chess.com/member/hikaru{long_query}"
    assert len(url) > 100
    req = ImportRequest(platform="chess.com", username=url)
    assert req.username == "hikaru"


def test_import_request_whitespace_only_still_rejected() -> None:
    with pytest.raises(ValidationError):
        ImportRequest(platform="chess.com", username="   ")


# ── UserProfileUpdate ────────────────────────────────────────────────────────


def test_user_profile_update_extracts_chess_com_url() -> None:
    update = UserProfileUpdate(chess_com_username="https://www.chess.com/member/hikaru")
    assert update.chess_com_username == "hikaru"


def test_user_profile_update_extracts_lichess_url() -> None:
    update = UserProfileUpdate(lichess_username="https://lichess.org/@/DrNykterstein")
    assert update.lichess_username == "DrNykterstein"


def test_user_profile_update_none_does_not_crash() -> None:
    update = UserProfileUpdate(chess_com_username=None)
    assert update.chess_com_username is None


def test_user_profile_update_field_pinned_to_its_own_platform() -> None:
    # A chess.com URL pasted into lichess_username is left unchanged -- the
    # per-field validator only recognizes that field's own platform (D-03).
    update = UserProfileUpdate(lichess_username="https://lichess.org/@/foo")
    assert update.lichess_username == "foo"

    unchanged = UserProfileUpdate(chess_com_username="https://lichess.org/@/foo")
    assert unchanged.chess_com_username == "https://lichess.org/@/foo"
