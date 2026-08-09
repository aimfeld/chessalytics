"""Shared username normalization for pasted chess.com / lichess profile URLs.

Users routinely paste their profile URL (e.g. copied from a browser address
bar) into a username field instead of their bare handle. Sent verbatim, that
string fails the downstream platform API lookup with an unhelpful "user not
found". This module is the single normalizer shared by `ImportRequest.username`
(app/schemas/imports.py) and `UserProfileUpdate.chess_com_username` /
`.lichess_username` (app/schemas/users.py) (D-03).

Mirrors `frontend/src/lib/platformUsername.ts` case-for-case — keep the two
implementations structurally identical when editing either.
"""

import re
from typing import Literal

UsernamePlatform = Literal["chess.com", "lichess"]

# Username character class shared by both platforms: alphanumerics, underscore,
# hyphen. Anchoring the capture to this class means trailing slash, extra path
# segments, query string, and fragment are all ignored without extra branching.
_USERNAME_CHARS = r"[A-Za-z0-9_-]+"

# Anchored, optional scheme, optional `www.`, host, platform marker segment,
# captured username. Flat alternation (no nested quantifiers) keeps matching
# linear-time (T-IQ1-01).
_OPTIONAL_SCHEME_AND_WWW = r"(?:https?://)?(?:www\.)?"
_CHESS_COM_HOST = r"chess\.com"
_CHESS_COM_MARKER = r"/member/"
_LICHESS_HOST = r"lichess\.org"
_LICHESS_MARKER = r"/@/"

_CHESS_COM_USERNAME_RE = re.compile(
    rf"^{_OPTIONAL_SCHEME_AND_WWW}{_CHESS_COM_HOST}{_CHESS_COM_MARKER}({_USERNAME_CHARS})",
    re.IGNORECASE,
)
_LICHESS_USERNAME_RE = re.compile(
    rf"^{_OPTIONAL_SCHEME_AND_WWW}{_LICHESS_HOST}{_LICHESS_MARKER}({_USERNAME_CHARS})",
    re.IGNORECASE,
)

_PLATFORM_REGEXES: dict[UsernamePlatform, re.Pattern[str]] = {
    "chess.com": _CHESS_COM_USERNAME_RE,
    "lichess": _LICHESS_USERNAME_RE,
}


def extract_platform_username(value: str, platform: UsernamePlatform | None = None) -> str:
    """Extracts the bare username from `value`.

    When `platform` is given, only that platform's URL shape is recognized;
    an unrecognized string (including a profile URL for the OTHER platform)
    is returned stripped and unchanged (D-01).

    When `platform` is None, both platforms' URL shapes are tried in a fixed
    order (chess.com, then lichess) — the D-03 fallback for the case where the
    schema itself couldn't determine the platform (e.g. `ImportRequest.platform`
    failed its own validation).

    Non-`str` input is returned untouched so Pydantic's own type error still
    surfaces.
    """
    if not isinstance(value, str):
        return value

    stripped = value.strip()
    regexes = (
        [_PLATFORM_REGEXES[platform]] if platform is not None else list(_PLATFORM_REGEXES.values())
    )
    for regex in regexes:
        match = regex.match(stripped)
        if match:
            return match.group(1)
    return stripped
