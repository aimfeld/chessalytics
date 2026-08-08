# Phase 207: Self-Serve Password Reset - Pattern Map

**Mapped:** 2026-08-08
**Files analyzed:** 12
**Analogs found:** 12 / 12

## Drift check against RESEARCH.md

- `frontend/src/App.tsx` routes: RESEARCH cites `:845-847` for the login/callback region. Verified: `<Route path="/login" .../>` is at `:845`, `<Route path="/auth/callback" .../>` is at `:847` — accurate, not drift. The `<Routes>` block opens at `:841`, public routes (`/`, `/privacy`, `/login`, `/auth/callback`) sit at `:843-847`. Insert the new `/auth/reset-password` route in this same public block (before the `<Route element={<ProtectedLayout />}>` wrapper at `:849`) since a user resetting a password is by definition not authenticated (mirrors A4 in RESEARCH).
- Everything else RESEARCH cited (`ip_rate_limiter.py:15-49`, `feedback_rate_limiter.py` full file, `push_send.py` shapes, `users.py:63-96`, `routers/auth.py:49-53`, `config.py` Settings, `conftest.py:446-463`) verified byte-accurate against the current files read this session. No further drift found.
- One correction to RESEARCH's file list: `FRONTEND_URL` already exists in `app/core/config.py:36` (`http://localhost:5173` default) — RESEARCH already says this correctly, confirming no new config field is needed for it. Only `RESEND_API_KEY` and `MAIL_FROM` are net-new settings.
- No `SecretStr` usage exists anywhere in `Settings` today — every secret-shaped field (`SECRET_KEY`, `GOOGLE_OAUTH_CLIENT_SECRET`, `EVAL_OPERATOR_TOKEN`, `VAPID_PRIVATE_KEY`) is a plain `str = ""` default. `RESEND_API_KEY` should follow this idiom exactly (plain `str`, empty-string default = "unconfigured"), not introduce `pydantic.SecretStr` as a new convention.
- `frontend/src/components/auth/RegisterForm.tsx` test files do not appear to exist (no `LoginForm.test.tsx`/`RegisterForm.test.tsx` found) — RESEARCH's Wave-0-gap note is confirmed: there is no frontend test precedent to mirror for the new forms; write them fresh using Testing Library conventions used elsewhere in `frontend/src/components/**/*.test.tsx` if any exist, otherwise treat as net-new test scaffolding (flag to planner, not blocking).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/services/email_service.py` | service | request-response (single outbound POST) | `app/services/push_send.py` | exact |
| `app/core/reset_password_rate_limiter.py` | utility | in-process state | `app/core/feedback_rate_limiter.py` | exact |
| `app/users.py` (`on_after_forgot_password` override) | model/manager hook | event-driven (post-hook) | `app/users.py`'s own `on_after_register`/`on_after_login` | exact |
| `app/routers/auth.py` (mount reset router) | router | request-response | same file's existing `include_router` calls (`:42-53`) | exact |
| `app/core/config.py` (add settings) | config | — | same file's existing `str = ""` secret fields (`VAPID_PRIVATE_KEY`, `EVAL_OPERATOR_TOKEN`) | exact |
| `tests/conftest.py` (extend fixture) | test fixture | — | same fixture's existing two-limiter reset (`:446-463`) | exact |
| `frontend/src/components/auth/ForgotPasswordForm.tsx` | component | request-response | `frontend/src/components/auth/LoginForm.tsx` | exact |
| `frontend/src/pages/ResetPasswordPage.tsx` (or component) | component | request-response + query-param read | `frontend/src/pages/Auth.tsx` (query param) + `LoginForm.tsx` (form/submit shape) | role-match (composite) |
| `frontend/src/App.tsx` (new route) | route registration | — | same file's existing public `<Route>` entries (`:843-847`) | exact |
| `frontend/src/components/auth/LoginForm.tsx` (add link) | component | — | itself (add a `<Link>` near the existing "Create one" link, `:139-144`) | exact |
| `tests/test_password_reset.py` | test | integration | `tests/test_auth.py` (`TestRegistration`/`TestLogin` classes) + `tests/test_push_send.py` (Sentry/mock-client structure) | exact (composite of two analogs) |

## Pattern Assignments

### `app/services/email_service.py` (service, request-response)

**Analog:** `app/services/push_send.py` (full file read this session)

**Imports pattern** (mirror `push_send.py:51-67`):
```python
from __future__ import annotations

import logging

import httpx
import sentry_sdk

from app.core.config import settings

logger = logging.getLogger(__name__)
```

**Configured-gate pattern** (mirror `push_send.py:103-105`, `is_push_configured`):
```python
def is_email_configured() -> bool:
    """True only when RESEND_API_KEY is set (mirrors is_push_configured's D-03 gate)."""
    return bool(settings.RESEND_API_KEY)
```

**Client-injectable constructor** (mirror `push_send.py:127-134`):
```python
_EMAIL_TIMEOUT_SECONDS = 10.0

def email_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_EMAIL_TIMEOUT_SECONDS)
```
Note: `push_send.py` sets `follow_redirects=False` as an SSRF mitigation because its endpoint is client-supplied. The Resend endpoint (`api.resend.com`) is a fixed constant (RESEARCH's Security Domain table confirms this explicitly) — `follow_redirects` default is fine here, no SSRF concern to replicate.

**Core send function, client-as-parameter** (mirror `push_send.py:137-149,198-205`):
```python
async def send_password_reset_email(
    client: httpx.AsyncClient,
    *,
    to: str,
    reset_url: str,
    user_id: int,
) -> bool:
    """Send the password-reset email via Resend. Returns True on 2xx, False otherwise.

    No retry (mirrors push_send.py — a single transactional send, not a bulk client).
    """
    if not is_email_configured():
        return False  # unconfigured — no-op, mirrors is_push_configured() gate
    payload = {
        "from": f"FlawChess <{settings.MAIL_FROM}>",
        "to": [to],
        "subject": "Reset your FlawChess password",
        "html": f'<p>Click <a href="{reset_url}">here</a> to reset your password. This link expires in 1 hour.</p>',
        "text": f"Reset your password: {reset_url} (expires in 1 hour)",
    }
    headers = {"Authorization": f"Bearer {settings.RESEND_API_KEY}"}
    try:
        resp = await client.post("https://api.resend.com/emails", json=payload, headers=headers)
    except httpx.HTTPError:
        logger.exception("Password reset email transport error")
        sentry_sdk.set_tag("source", "email_service")
        sentry_sdk.set_context("email_service", {"user_id": user_id})
        sentry_sdk.capture_exception()
        return False

    if resp.status_code >= 300:
        logger.warning("Password reset email send failed with status %d", resp.status_code)
        sentry_sdk.set_tag("source", "email_service")
        # Never interpolate status_code/user_id into the exception MESSAGE — set_context
        # only (CLAUDE.md: "Never embed variables in error messages" — fragments Sentry
        # grouping). Mirrors push_send.py:240-244 exactly.
        sentry_sdk.set_context(
            "email_service", {"status_code": resp.status_code, "user_id": user_id}
        )
        sentry_sdk.capture_exception(RuntimeError("Password reset email send returned a non-success status"))
        return False
    return True
```

**Error handling summary:** exactly `push_send.py`'s two-branch shape — `httpx.HTTPError` (transport) captured via `capture_exception()` (bare, exception is ambient from the `except` block), and a non-2xx response captured via `capture_exception(RuntimeError("fixed literal string"))` so Sentry groups by the constant message, with `status_code` and `user_id` only ever in `set_context`, never string-interpolated (RESET-04 requirement, CLAUDE.md rule).

---

### `app/core/reset_password_rate_limiter.py` (utility, in-process state)

**Analog:** `app/core/feedback_rate_limiter.py` (full file, 17 lines — copy near-verbatim per RESEARCH Pattern 2)

```python
"""Per-email sliding window rate limiter for password-reset requests.

Reuses the in-process _SlidingWindowRateLimiter from ip_rate_limiter.
Keyed by lowercased email address (not user_id — the router hasn't resolved
a user at rate-limit-check time in some designs, and this specifically must
run inside on_after_forgot_password per RESEARCH Pitfall 1, where a User IS
available, but keying by email keeps this limiter meaningful even if the
call site ever moves). In-process limiter resets on restart — acceptable
for single-process Uvicorn deployment (mirrors feedback_limiter's D-07/A5
posture).
"""

from app.core.ip_rate_limiter import _SlidingWindowRateLimiter

_RESET_PASSWORD_MAX_REQUESTS = 5
_RESET_PASSWORD_WINDOW_SECONDS = 3600  # 1 hour — matches guest_create_limiter/feedback_limiter precedent (RESEARCH Open Question 1 recommends matching, not tightening)

reset_password_limiter = _SlidingWindowRateLimiter(
    _RESET_PASSWORD_MAX_REQUESTS,
    _RESET_PASSWORD_WINDOW_SECONDS,
)
```

**Construction signature (verified, `app/core/ip_rate_limiter.py:23-42`):** `_SlidingWindowRateLimiter(max_requests: int, window_seconds: int)`, exposing `.is_allowed(key: str) -> bool`. Internally: `defaultdict[str, list[float]]` keyed by whatever string is passed to `is_allowed` (an IP for `guest_create_limiter`, `str(user_id)` for `feedback_limiter`, `email.lower()` here). **Throttle rejection today is a plain `bool` return, never an exception** — the two existing call sites both do `if not <limiter>.is_allowed(<key>): raise HTTPException(429, ...)` (see `routers/auth.py:294-299` for `guest_create_limiter`). For this phase, the `False` branch must NOT raise/429 — it must silently skip the send (Pitfall 1), which is a deliberate deviation from both existing call sites' behavior; call this out explicitly in the plan so the executor doesn't copy the 429-raising idiom by reflex.

---

### `app/users.py` — `on_after_forgot_password` override (manager hook, event-driven)

**Analog:** the same class's existing `on_after_register`/`on_after_login` (`:67-90`) for the override shape/placement; `push_send.py` fan-out for the client-context-manager idiom.

```python
# Add imports at top of app/users.py:
from app.core.reset_password_rate_limiter import reset_password_limiter
from app.services import email_service

# Add inside class UserManager, alongside on_after_register/on_after_login:
async def on_after_forgot_password(
    self,
    user: User,
    token: str,
    request: Request | None = None,
) -> None:
    """Send the reset email, rate-limited per email (D-06).

    Runs only for a real, active user — the router already filtered
    UserNotExists/UserInactive upstream (router/reset.py:51-59), so a
    throttled request here still returns the router's identical 202 with
    zero enumeration signal (RESET-02). Never raise/429 from this hook.
    """
    if not reset_password_limiter.is_allowed(user.email.lower()):
        return
    reset_url = f"{settings.FRONTEND_URL}/auth/reset-password?token={token}"
    async with email_service.email_http_client() as client:
        await email_service.send_password_reset_email(
            client, to=user.email, reset_url=reset_url, user_id=user.id
        )
```

**Placement:** insert after `on_after_login` (`:90`), before `get_user_manager` (`:93`) — keeps all three `on_after_*` hooks grouped, matching the existing ordering convention.

---

### `app/routers/auth.py` — mount `get_reset_password_router()` (router, request-response)

**Analog:** the file's own existing `include_router` calls (`:42-53`)

```python
# Insert immediately after the existing registration mount (app/routers/auth.py:49-53):
router.include_router(
    fastapi_users.get_reset_password_router(get_user_manager),
    prefix="/auth",
    tags=["auth"],
)
```

**Pitfall 3 (verified, RESEARCH):** unlike `get_register_router(fapi_schemas.BaseUser[int], fapi_schemas.BaseUserCreate)` which takes two schema type args, `get_reset_password_router()` takes exactly one argument, `get_user_manager` — already imported in this file at `:35` from `app.users`. No new import needed for the router mount itself.

---

### `app/core/config.py` — new settings (config)

**Analog:** existing plain-`str`-default secret fields in the same class (`VAPID_PRIVATE_KEY: str = ""` at `:120`, `EVAL_OPERATOR_TOKEN: str = ""` at `:103`) — confirms the project idiom is a bare `str` with empty-string = "unconfigured" sentinel, never `pydantic.SecretStr` (zero uses of `SecretStr` found anywhere in this file).

```python
# Insert near the other integration secrets (e.g. after VAPID_* block, :119-121):

# Resend transactional email (Phase 207, D-03). Empty string = unconfigured:
# email_service.is_email_configured() returns False and every send is a no-op,
# mirroring VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY's "empty = disabled" contract
# above. Every dev/test/CI run works with zero setup.
RESEND_API_KEY: str = ""
MAIL_FROM: str = "noreply@flawchess.com"
```

`FRONTEND_URL: str = "http://localhost:5173"` already exists at `:36` — no change needed, just a new consumer (`on_after_forgot_password`'s reset URL).

---

### `tests/conftest.py` — extend `reset_in_process_rate_limiters` (test fixture)

**Analog:** the fixture's own existing two-limiter body (`:446-463`)

```python
@pytest.fixture(autouse=True)
def reset_in_process_rate_limiters() -> None:
    """Clear the in-process sliding-window limiters before every test.

    ... (existing docstring — extend it to mention the third limiter) ...
    """
    from app.core.feedback_rate_limiter import feedback_limiter
    from app.core.ip_rate_limiter import guest_create_limiter
    from app.core.reset_password_rate_limiter import reset_password_limiter

    guest_create_limiter._timestamps.clear()
    feedback_limiter._timestamps.clear()
    reset_password_limiter._timestamps.clear()
```

**Pitfall 2 (verified, RESEARCH):** this is a documented, previously-hit bug class in this exact codebase (the fixture's own docstring explains it) — do this in the same commit that creates `reset_password_rate_limiter.py`, not as a follow-up.

---

### `tests/test_password_reset.py` (new test file, integration)

**Analog A — user/client setup:** `tests/test_auth.py:1-41` (full helpers section)
```python
# Source: tests/test_auth.py:10-41, VERIFIED this session
import uuid
import httpx
import pytest
from app.main import app

def unique_email(prefix: str = "test") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"

async def register_user(client: httpx.AsyncClient, email: str, password: str) -> httpx.Response:
    resp = await client.post("/api/auth/register", json={"email": email, "password": password})
    return resp

# New helpers to add, following the exact same shape:
async def forgot_password(client: httpx.AsyncClient, email: str) -> httpx.Response:
    return await client.post("/api/auth/forgot-password", json={"email": email})

async def reset_password(client: httpx.AsyncClient, token: str, password: str) -> httpx.Response:
    return await client.post("/api/auth/reset-password", json={"token": token, "password": password})
```
Test class shape mirrors `TestRegistration`/`TestLogin` (`:49-110`): `@pytest.mark.asyncio` methods, each building its own `async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:` block. Unique emails via `uuid4` avoid cross-test collisions (no rollback fixture is used for auth tests per the file's own top-of-file NOTE).

**Analog B — mocking the email send / asserting Sentry, no live Resend call:** `tests/test_push_send.py:81-96` (`vapid_keypair` fixture pattern + `_mock_client` helper) — for password reset, mock `email_service.email_http_client()` to return an `AsyncMock` with `.post` stubbed (`AsyncMock(return_value=MagicMock(status_code=200))`), exactly as `_mock_client` does, rather than hitting `api.resend.com`. To capture the actual token issued by `forgot_password`, either (a) monkeypatch `email_service.send_password_reset_email` to capture its `reset_url` argument and extract the token via `urllib.parse.parse_qs`, or (b) monkeypatch `app.users.email_service.send_password_reset_email` directly with a `MagicMock` that records call args — the latter is simpler and avoids needing a real Resend-shaped mock client at all for most tests; reserve the `AsyncMock`-client approach specifically for `test_email_service.py`'s own unit tests of `send_password_reset_email` in isolation (mirroring `test_push_send.py`'s separation of `send_to_subscription`-level tests from `send_to_user`-level fan-out tests).

**RESET-03 (rate limit) mutation-test shape**, mirroring `test_push_send.py`'s status-branch-table discipline: call `forgot_password()` N+1 times for the same email inside the window, assert the mocked send function's call count is capped at N (the `_RESET_PASSWORD_MAX_REQUESTS` constant), then literally comment out/remove the `if not reset_password_limiter.is_allowed(...)` guard and confirm the test goes red (RESET-08's mutation-test discipline, matching `feedback_mutation_test_gap_closures` project convention already in MEMORY.md).

**RESET-05 (eligibility) setup — REVISED 2026-08-08, D-04 reversed.** This previously described a Google-only account completing forgot→reset→login. **That is now the opposite of the requirement:** an empty-`hashed_password` account must receive **zero** sends. Two fixtures are needed, and the first is the important one:

1. **Dual account (the 125-account prod majority): a real `$argon2id$` hash AND an `oauth_account` row.** Must reset normally. This is the regression a naive "skip Google accounts" implementation causes — gating on an `oauth_account` row would strand 125 of the 172 eligible accounts.
2. **Ineligible account: `hashed_password=""`.** Zero sends, response byte-identical to an eligible one (capture and compare; never hard-code the status).

For fixture 2's field set, `app/services/guest_service.py:156` remains the right in-repo idiom for an empty-hash row. For fixture 1, add an `oauth_account` row using the construction at `guest_service.py:166-175`. Eligibility must be read from the password's presence only — never from `oauth_account`, `is_guest`, or a hash prefix.

---

### `frontend/src/components/auth/ForgotPasswordForm.tsx` (component, request-response)

**Analog:** `frontend/src/components/auth/LoginForm.tsx` (full file, 172 lines, read this session)

**Full representative excerpt to mirror** (imports, state, submit handler, axios call, error handling, toast, `data-testid`, Button variant):
```tsx
// Adapt from LoginForm.tsx:1-58 — same skeleton, one field instead of two,
// and a single generic success message regardless of whether the email
// exists (RESET-02's anti-enumeration contract — the FORM must not branch
// on existence either, only on transport-level failure).
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import axios from 'axios';
import * as Sentry from '@sentry/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormCard, FormCardContent, FormCardDescription, FormCardHeader, FormCardTitle } from '@/components/ui/form-card';
import { apiClient } from '@/api/client';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiClient.post('/auth/forgot-password', { email });
      // Always show the same generic message — mirrors the backend's own
      // no-enumeration 202 (RESET-02). No isAxiosError branch that reveals
      // "not found" vs "found" — only an UNEXPECTED-error branch below.
      setSubmitted(true);
    } catch (err: unknown) {
      Sentry.captureException(err, { tags: { source: 'auth' } });
      toast.error('Something went wrong. Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <FormCard className="w-full max-w-sm" data-testid="forgot-password-form">
        <FormCardHeader>
          <FormCardTitle>Check your email</FormCardTitle>
          <FormCardDescription>
            If that address is registered, you'll receive a password reset link shortly.
          </FormCardDescription>
        </FormCardHeader>
      </FormCard>
    );
  }

  return (
    <FormCard className="w-full max-w-sm" data-testid="forgot-password-form">
      <FormCardHeader>
        <FormCardTitle>Reset your password</FormCardTitle>
        <FormCardDescription>Enter your email and we'll send you a reset link.</FormCardDescription>
      </FormCardHeader>
      <FormCardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              data-testid="forgot-password-email"
            />
          </div>
          <Button type="submit" className="w-full" disabled={submitting} data-testid="btn-forgot-password-submit">
            {submitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link to="/login" className="underline underline-offset-4 hover:text-primary">
            Back to sign in
          </Link>
        </p>
      </FormCardContent>
    </FormCard>
  );
}
```
Note: this form's success case has no `isError`/empty-state ternary chain (it's a plain `useState` submit, not a `useQuery`) — CLAUDE.md's `isError` rule is a TanStack-Query-specific pattern; this form's "isError branch" equivalent is exactly the `catch` block's `toast.error`, per RESEARCH RESET-06's own clarifying note.

---

### `frontend/src/pages/ResetPasswordPage.tsx` (component, request-response + query param)

**Analog A (query param):** `frontend/src/pages/Auth.tsx:1,10,17` (full pattern, verified)
```tsx
// Source: frontend/src/pages/Auth.tsx:1,10 (VERIFIED this session)
import { useSearchParams } from 'react-router';
const [searchParams] = useSearchParams();
const token = searchParams.get('token');
```
**Analog B (form/submit skeleton):** `LoginForm.tsx` handleSubmit shape (above) — two password fields (new + confirm), client-side `password.length < 8` check mirroring `RegisterForm.tsx:67` (`if (password.length < 8) return 'Password must be at least 8 characters.';`), POST to `/api/auth/reset-password` with `{ token, password }`, `axios.isAxiosError(err) && err.response?.status === 400` branch showing the server's `RESET_PASSWORD_BAD_TOKEN`/`RESET_PASSWORD_INVALID_PASSWORD` detail (expected — excluded from Sentry per CLAUDE.md's "skip expected failures" rule), `Sentry.captureException` only on the unexpected branch. On success, redirect to `/login` via `navigate('/login', { replace: true })` (mirrors `LoginForm.tsx:43`'s post-login navigate) with a `toast.success('Password reset. Please sign in.')`.

If `token` is `null` on mount, render an inline error state (`data-testid="reset-password-invalid-link"`) rather than attempting a submit — this is the page-level `isError`-equivalent branch CLAUDE.md's data-loading ternary rule implies, applied to a missing-param case rather than a query error.

---

### `frontend/src/App.tsx` (route registration)

**Analog:** the existing public-route block, `:843-847`
```tsx
// Insert alongside the other unauthenticated routes (App.tsx:843-847),
// NOT inside <Route element={<ProtectedLayout />}> (:849) — a user resetting
// a password is by definition logged out (or possibly on another device,
// per RESEARCH A4 — do not gate this on auth state the way AuthPage.tsx
// gates itself with `if (token) return <Navigate to="/" replace />`).
<Route path="/" element={<HomePage />} />
<Route path="/privacy" element={<PrivacyPage />} />
<Route path="/login" element={<AuthPage />} />
<Route path="/auth/reset-password" element={<ResetPasswordPage />} />
<Route path="/auth/callback" element={<OAuthCallbackPage />} />
```
Add the matching `import { ResetPasswordPage } from '@/pages/ResetPasswordPage';` near the file's other page imports (grep the existing `import { AuthPage }` line for exact placement convention).

---

### `frontend/src/components/auth/LoginForm.tsx` (add "Forgot password?" link)

**Analog:** the file's own existing "Create one" link (`:139-144`)
```tsx
// Insert near the password field (LoginForm.tsx, inside the space-y-2 div
// around :122-134) or directly below the submit button, following the
// existing muted-link style used at :139-144:
<p className="mt-2 text-center text-sm text-muted-foreground">
  <Link to="/auth/reset-password-request" className="underline underline-offset-4 hover:text-primary" data-testid="link-forgot-password">
    Forgot password?
  </Link>
</p>
```
Naming note: if `ForgotPasswordForm.tsx` is mounted at its own route (e.g. `/auth/forgot-password`) rather than reusing `AuthPage`'s tab mechanism, register that route in `App.tsx` too, alongside `/auth/reset-password` — RESEARCH's Recommended Project Structure implies a page per form; confirm final route naming (`/auth/forgot-password` vs. folding into `AuthPage`'s existing `Tabs`) at plan time since ROADMAP text only mandates the `/auth/reset-password` route explicitly.

## Shared Patterns

### No-retry, client-injected outbound HTTP with Sentry capture
**Source:** `app/services/push_send.py:127-149,198-245` (full pattern, read this session)
**Apply to:** `app/services/email_service.py` — the entire file's shape, not just an excerpt. Client-as-parameter (never internally constructed and hidden), zero retry loop, `httpx.HTTPError` and non-2xx handled as two distinct branches, `sentry_sdk.set_context` for variable data, `capture_exception` never given an f-string message.

### In-process sliding-window rate limiter reuse
**Source:** `app/core/ip_rate_limiter.py:15-42` (the generic class) + `app/core/feedback_rate_limiter.py` (the one-purpose-per-file instantiation convention)
**Apply to:** `app/core/reset_password_rate_limiter.py` — do not reinvent the limiter class; only add a new module-level singleton instance file. **Deviation to flag explicitly in the plan:** unlike the two existing call sites (which `raise HTTPException(429, ...)` on `is_allowed() == False`), this phase's call site (`on_after_forgot_password`) must swallow the `False` case silently — see Pitfall 1.

### Plain-`useState` auth form idiom (no form library)
**Source:** `frontend/src/components/auth/LoginForm.tsx` (full file) + `RegisterForm.tsx:65-67` (client-side length validation)
**Apply to:** both new frontend files. `axios.isAxiosError` branching in `catch`, `sonner` toasts, `Sentry.captureException` only on the unexpected branch, `data-testid` on every input/button, `variant="outline"`/default `Button` per `components/ui/button.tsx` variants (no hand-rolled colors, per CLAUDE.md).

### `?token=` query param reads via `react-router`
**Source:** `frontend/src/pages/Auth.tsx:1,10,17` (`useSearchParams`)
**Apply to:** `ResetPasswordPage.tsx`.

## No Analog Found

None — every file in this phase's scope has a strong, concretely-cited in-repo analog. This phase is pure wiring against already-established patterns (confirmed by RESEARCH's own "Key insight" summary).

## Metadata

**Analog search scope:** `app/core/`, `app/services/`, `app/routers/`, `app/users.py`, `app/core/config.py`, `tests/conftest.py`, `tests/test_auth.py`, `tests/test_push_send.py`, `frontend/src/components/auth/`, `frontend/src/pages/`, `frontend/src/App.tsx`
**Files scanned/read in full or targeted section this session:** `app/core/ip_rate_limiter.py`, `app/core/feedback_rate_limiter.py`, `app/users.py`, `app/routers/auth.py`, `app/core/config.py`, `app/services/push_send.py`, `tests/conftest.py:430-469`, `tests/test_push_send.py:1-100`, `tests/test_auth.py:1-120`, `frontend/src/components/auth/LoginForm.tsx`, `frontend/src/pages/Auth.tsx`, `frontend/src/App.tsx` (grep + targeted region)
**Pattern extraction date:** 2026-08-08
