"""Per-IP sliding window rate limiter for guest account creation.

In-process limiter — resets on server restart. Acceptable for single-process
Uvicorn deployment. For multi-process or distributed deployments, replace with
a Redis-backed solution.
"""

import time
from collections import defaultdict

_GUEST_CREATE_MAX_REQUESTS = 5
_GUEST_CREATE_WINDOW_SECONDS = 3600  # 1 hour


class _SlidingWindowRateLimiter:
    """Sliding window rate limiter keyed by IP address.

    Stores timestamps of allowed requests in memory. On each call to
    `is_allowed`, evicts timestamps outside the window, then checks if the
    count is below the maximum.
    """

    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        # Keyed by IP string; values are sorted lists of monotonic timestamps
        self._timestamps: defaultdict[str, list[float]] = defaultdict(list)

    def is_allowed(self, ip: str) -> bool:
        """Return True if the request from `ip` is within the rate limit, else False."""
        now = time.monotonic()
        cutoff = now - self._window_seconds

        # Evict timestamps outside the sliding window
        timestamps = self._timestamps[ip]
        self._timestamps[ip] = [t for t in timestamps if t > cutoff]

        # Bug fix (F-17/SEED-161): a pruned-to-empty entry was never removed
        # from the dict, so every IP that ever hit this limiter stayed in
        # memory for the process lifetime. An empty list can never satisfy
        # the count check below, so deleting it here doesn't change the
        # accept/reject outcome — the defaultdict transparently re-creates
        # the key on the .append(now) call a few lines down.
        if not self._timestamps[ip]:
            del self._timestamps[ip]

        if len(self._timestamps[ip]) >= self._max_requests:
            return False

        self._timestamps[ip].append(now)
        return True


# Module-level singleton used by the guest creation endpoint
guest_create_limiter = _SlidingWindowRateLimiter(
    _GUEST_CREATE_MAX_REQUESTS,
    _GUEST_CREATE_WINDOW_SECONDS,
)
