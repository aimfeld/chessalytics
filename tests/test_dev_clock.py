"""Unit tests for the dev-only clock override (`app.core.dev_clock`).

The security-relevant property is the FAIL-CLOSED environment gate: the
`X-Dev-Clock-Offset-Minutes` header must be completely inert outside
`ENVIRONMENT == "development"`. A forged header against production must not be
able to shift a user's Train schedule (which would let them, e.g., fabricate a
streak). The remaining tests cover the degrade-to-real-clock behaviour on
malformed input and the sanity clamp.
"""

from __future__ import annotations

import datetime

import pytest
from fastapi import Request

from app.core.config import settings
from app.core.dev_clock import (
    DEV_CLOCK_OFFSET_HEADER,
    MAX_DEV_CLOCK_OFFSET_MINUTES,
    dev_now_utc,
)

# Tolerance for "the real clock" — dev_now_utc reads datetime.now() itself, so
# assertions compare against a locally sampled instant.
_SLACK = datetime.timedelta(seconds=5)


def _request_with_header(value: str | None) -> Request:
    """Build a minimal ASGI Request carrying (or omitting) the offset header."""
    headers: list[tuple[bytes, bytes]] = []
    if value is not None:
        headers.append((DEV_CLOCK_OFFSET_HEADER.lower().encode(), value.encode()))
    return Request({"type": "http", "method": "GET", "path": "/", "headers": headers})


@pytest.mark.parametrize("environment", ["production", "staging"])
def test_header_ignored_outside_development(monkeypatch, environment: str) -> None:
    """The offset header is inert in every non-development environment."""
    monkeypatch.setattr(settings, "ENVIRONMENT", environment)
    before = datetime.datetime.now(datetime.timezone.utc)

    result = dev_now_utc(_request_with_header(str(30 * 24 * 60)))

    assert abs(result - before) < _SLACK


def test_offset_applied_in_development(monkeypatch) -> None:
    """In development the header shifts "now" by exactly that many minutes."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    offset_minutes = 3 * 24 * 60
    before = datetime.datetime.now(datetime.timezone.utc)

    result = dev_now_utc(_request_with_header(str(offset_minutes)))

    expected = before + datetime.timedelta(minutes=offset_minutes)
    assert abs(result - expected) < _SLACK


def test_negative_offset_applied_in_development(monkeypatch) -> None:
    """A negative offset travels backwards (needed to undo an over-shoot)."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    before = datetime.datetime.now(datetime.timezone.utc)

    result = dev_now_utc(_request_with_header(str(-24 * 60)))

    assert abs(result - (before - datetime.timedelta(days=1))) < _SLACK


@pytest.mark.parametrize("raw", [None, "", "not-a-number", "1.5", "12h"])
def test_missing_or_malformed_header_degrades_to_real_clock(monkeypatch, raw: str | None) -> None:
    """A broken dev tool must never turn a working endpoint into an error."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    before = datetime.datetime.now(datetime.timezone.utc)

    result = dev_now_utc(_request_with_header(raw))

    assert abs(result - before) < _SLACK


@pytest.mark.parametrize("sign", [1, -1])
def test_absurd_offset_is_clamped(monkeypatch, sign: int) -> None:
    """An out-of-range offset clamps to the ~2-year bound instead of overflowing."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    before = datetime.datetime.now(datetime.timezone.utc)

    result = dev_now_utc(_request_with_header(str(sign * 999_999_999)))

    expected = before + datetime.timedelta(minutes=sign * MAX_DEV_CLOCK_OFFSET_MINUTES)
    assert abs(result - expected) < _SLACK
