"""Per-email sliding window rate limiter for password-reset requests.

Reuses the in-process _SlidingWindowRateLimiter from ip_rate_limiter. Keyed by
lowercased email address (not user_id — this call site is inside
UserManager.on_after_forgot_password, where a User is available, but keying
by email keeps this limiter meaningful even if the call site ever moves).
In-process limiter resets on restart — acceptable for single-process Uvicorn
deployment (mirrors feedback_limiter's posture).

Deviation from both existing call sites (guest_create_limiter, feedback_limiter):
this instance's call site deliberately does NOT raise on rejection. Both of
those reject with an HTTP "too many requests" error when is_allowed() returns
False. Here, a rejected request must return the router's identical 202 with
zero enumeration signal (RESET-02) — the caller silently skips the send instead.
"""

from app.core.ip_rate_limiter import _SlidingWindowRateLimiter

_RESET_PASSWORD_MAX_REQUESTS = 5
_RESET_PASSWORD_WINDOW_SECONDS = (
    3600  # 1 hour — matches guest_create_limiter/feedback_limiter precedent
)

# Module-level singleton keyed by lowercased email
reset_password_limiter = _SlidingWindowRateLimiter(
    _RESET_PASSWORD_MAX_REQUESTS,
    _RESET_PASSWORD_WINDOW_SECONDS,
)
