"""Unit tests for the shared `_SlidingWindowRateLimiter` (F-17/SEED-161).

Exercises the shared class directly, on a fresh instance per test rather than
any module-level singleton, so no test leaks state into another. Time is
driven by seeding the internal timestamp list with already-stale values
instead of sleeping out a real window, so this suite stays fast.
"""

import time

from app.core.ip_rate_limiter import _SlidingWindowRateLimiter

_TEST_MAX_REQUESTS = 3
_TEST_WINDOW_SECONDS = 60


def _make_limiter() -> _SlidingWindowRateLimiter:
    return _SlidingWindowRateLimiter(_TEST_MAX_REQUESTS, _TEST_WINDOW_SECONDS)


def _stale_timestamp() -> float:
    """A monotonic timestamp guaranteed to already be outside the test window."""
    return time.monotonic() - (_TEST_WINDOW_SECONDS + 10)


def test_allows_up_to_max_then_rejects() -> None:
    limiter = _make_limiter()
    ip = "203.0.113.1"

    for _ in range(_TEST_MAX_REQUESTS):
        assert limiter.is_allowed(ip) is True

    assert limiter.is_allowed(ip) is False


def test_key_within_limit_stays_present() -> None:
    limiter = _make_limiter()
    ip = "203.0.113.2"

    limiter.is_allowed(ip)

    assert ip in limiter._timestamps
    assert len(limiter._timestamps[ip]) == 1


def test_stale_key_is_evicted_then_a_later_call_allows_and_recreates_it() -> None:
    """Black-box regression check: behavior across a window gap is unaffected.

    This alone does NOT prove the eviction fix (the final dict state here is
    identical whether or not the key was deleted mid-call, since the accept
    path always re-populates the entry) — see
    `test_pruned_to_empty_deletes_key_before_defaultdict_recreates_it` for the
    test that actually isolates the fix's effect.
    """
    limiter = _make_limiter()
    ip = "203.0.113.3"

    limiter._timestamps[ip] = [_stale_timestamp()]

    result = limiter.is_allowed(ip)

    assert result is True
    assert ip in limiter._timestamps
    assert len(limiter._timestamps[ip]) == 1


def test_pruned_to_empty_deletes_key_before_defaultdict_recreates_it() -> None:
    """Proves the eviction fix by counting `defaultdict` factory invocations.

    The final dict state after `is_allowed()` is identical with or without the
    fix (the accept path always re-populates the entry with a fresh
    timestamp), so asserting on final state alone proves nothing — a test
    that passes both with and without the fix is not a real test.

    The fix's actual, observable effect is *how* that final entry gets
    created: without the fix, the pruned-to-empty list is left in place by
    plain dict assignment (`self._timestamps[ip] = []`), so the subsequent
    `self._timestamps[ip]` reads are normal lookups against an already-present
    key and the `defaultdict`'s `default_factory` is never invoked. With the
    fix, `del self._timestamps[ip]` removes the key entirely, so the very
    next `self._timestamps[ip]` read finds it missing and `defaultdict`
    invokes `default_factory()` to recreate it. Counting factory calls
    therefore distinguishes "key was actually deleted" from "key was merely
    left holding an empty list."

    Manually reverted the `del` line and re-ran this test: it failed with
    `assert 0 == 1` (factory never invoked), confirming this test is not
    vacuous.
    """
    limiter = _make_limiter()
    ip = "203.0.113.4"
    limiter._timestamps[ip] = [_stale_timestamp()]

    factory_calls = 0

    def _counting_list_factory() -> list[float]:
        nonlocal factory_calls
        factory_calls += 1
        return []

    limiter._timestamps.default_factory = _counting_list_factory

    limiter.is_allowed(ip)

    assert factory_calls == 1
    # And the entry that DOES exist afterward holds only the fresh timestamp
    # from this call, not the stale one that was pruned away.
    assert len(limiter._timestamps[ip]) == 1
