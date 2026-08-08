# Phase 207: Self-Serve Password Reset - Research

**Researched:** 2026-08-08
**Domain:** fastapi-users password reset wiring, transactional email (Resend/httpx), unauthenticated-endpoint rate limiting, small React auth forms
**Confidence:** HIGH (backend — verified by reading the pinned fastapi-users 15.0.5 source directly; frontend/rate-limit/email — verified against in-repo precedent; Resend API shape — CITED against official docs)

## Summary

This phase is almost entirely wiring, not new mechanism. The two token secrets fastapi-users needs (`reset_password_token_secret`) are already configured at `app/users.py:64`; the router that would consume them (`get_reset_password_router()`) is verified absent (zero hits) and `on_after_forgot_password` is verified to be the unmodified no-op base method. Reading the actual installed `fastapi_users` 15.0.5 source (not docs, not training memory) resolved every version-sensitive question this phase depends on: the router's exact two routes and their status codes, the exact `on_after_forgot_password(user, token, request)` signature, and — critically — that `forgot_password()`/`reset_password()` work unmodified for a Google-only account with `hashed_password=""`, because `PasswordHelper.hash("")` (Argon2) hashes the empty string like any other, so D-04 needs zero special-casing.

The codebase already contains a working, project-idiomatic answer to every "how do I..." question this phase raises, once you look in the right place: `_SlidingWindowRateLimiter` (`app/core/ip_rate_limiter.py`) is a generic, already-reused class (a second instance backs `feedback_limiter`) — the D-06 rate limit is a five-line third instance, not new infrastructure. `app/services/push_send.py` is the closest existing analog to the new email service: single `httpx.AsyncClient` POST, no retry, `sentry_sdk.capture_exception` on transport error, `set_context` never string-interpolation, and — the load-bearing pattern — the client is *threaded in as a parameter* specifically so tests can pass an `AsyncMock` instead of patching global `httpx.AsyncClient`. `LoginForm.tsx`/`RegisterForm.tsx` establish the exact frontend idiom to copy: plain `useState`, no form library (none is installed), `axios.isAxiosError` branching, `sonner` toasts, `Sentry.captureException` only on the *unexpected* branch. `FRONTEND_URL` already exists in `Settings` (used today for OAuth redirects) — no new config concept, just a new consumer.

One structural gotcha that isn't obvious from the seed: `tests/conftest.py:446-463` has an **autouse** `reset_in_process_rate_limiters` fixture that manually clears `guest_create_limiter` and `feedback_limiter` before every test, specifically because these are process-lifetime module singletons that bleed state across serial-CI tests. A third rate limiter for password reset MUST be added to this fixture or its own tests (and any other test that happens to trigger `forgot_password` for the same email twice) will flake exactly the way the fixture's own docstring describes.

**Primary recommendation:** Mount `get_reset_password_router()` unmodified; do the rate-limiting inside `UserManager.on_after_forgot_password` (never in a router-level dependency) so a throttled request still returns 202 with zero enumeration signal; build `email_service.py` as a thin, no-retry, client-injectable wrapper mirroring `push_send.py`; and register the new limiter singleton in `tests/conftest.py`'s existing autouse fixture on day one.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Token issuance/validation (JWT, stateless) | API / Backend | — | `fastapi_users.manager.BaseUserManager.forgot_password`/`reset_password` — already-vendored library logic, not custom code |
| Router mounting (`/auth/forgot-password`, `/auth/reset-password`) | API / Backend | — | `app/routers/auth.py`, alongside the existing `get_register_router`/`get_auth_router` mounts |
| Rate limiting | API / Backend | — | In-process, keyed by submitted email; lives in `UserManager.on_after_forgot_password`, not middleware — must run before any Resend call is attempted |
| Outbound email send | API / Backend | External (Resend) | New `app/services/email_service.py`; Backend owns building the reset URL and the request payload, Resend owns delivery |
| Forgot-password / reset-password forms | Browser / Client | API / Backend (validation) | New `ForgotPasswordForm.tsx` + `/auth/reset-password` route; client does no password-strength validation beyond mirroring `RegisterForm`'s `password.length < 8` check — the server is the authority via `InvalidPasswordException` |
| DNS / domain verification (SPF/DKIM/DMARC) | External (DNS provider) | — | Step 0, operator-only, outside this phase's code |

## User Constraints (from ROADMAP.md Phase 207 section — no separate CONTEXT.md exists yet)

<user_constraints>

### Locked Decisions (D-01..D-07, from SEED-143, D-05 superseded per ROADMAP)

- **D-01 — Fully self-serve.** Emailed token link, user sets a new password, zero operator involvement. The "email the maintainer" manual path was considered and rejected.
- **D-02 — No self-hosted mail server.** Rejected on deliverability (cold IP, zero volume to warm it), not effort.
- **D-03 — Resend, free tier, raw HTTP via `httpx`.** 3,000/mo · 100/day. Skip the official `resend` SDK — `httpx.AsyncClient` is already project-wide. Postmark is the named fallback if Resend deliverability ever disappoints (not to be built now).
- **D-04 — Google-only accounts (empty `hashed_password`) get the standard reset link.** No special-casing, no second template. **Verified this session** (see Code Examples) that the library handles this correctly with zero special-casing required.
- **D-05 — SUPERSEDED 2026-08-08.** From address is `noreply@flawchess.com` (apex). Resend/SES sets Return-Path to `bounces@send.flawchess.com`; SPF is evaluated against the envelope-from (the `send.` subdomain), DKIM signs at the apex (`resend._domainkey.flawchess.com`) — so DMARC passes on strict DKIM alignment and the **existing apex SPF record (`v=spf1 a mx include:spf.webapps.net ~all`) is never read or modified.** Do not re-derive this; do not propose the apex-merge alternative from the original seed text, which is retained in SEED-143 for the record only and is factually wrong.
- **D-06 — In scope beyond the core flow:** per-email rate limit (~10 lines) and Sentry capture on send failure (mandated by CLAUDE.md for `app/services/` already).
- **D-07 — Deliberately out of scope:** periodic canary send, explicit guest-account guard (unreachable `.local` addresses), email verification on registration (captured as a follow-up seed once this ships, not scoped here).

### Claude's Discretion

Not explicitly delegated in the ROADMAP text, but implied by "no design-system additions" (UI hint) and the small scope: exact copy/wording on the forgot-password and reset-password forms, exact rate-limit window/threshold (D-06 says "~10 lines," not a specific number), exact email HTML/text template content, and whether the rate limiter keys on lowercased email vs raw email as submitted.

### Deferred Ideas (OUT OF SCOPE — do not implement)

- Periodic canary send (D-07).
- Explicit guest-account guard in the hook (D-07 — unreachable in practice).
- Email verification on registration (`get_verify_router()`, `on_after_register` — captured as a follow-up seed, "Adjacent Gap" in SEED-143).
- Self-hosting mail (D-02).
- Alternative providers beyond Resend/Postmark-as-fallback (bake-off closed).
- A templating engine or second email template.
- Any database migration (fastapi-users reset token is stateless JWT).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (from ROADMAP.md Success Criteria, in order) | Research Support |
|----|-------------|------------------|
| RESET-01 | A user with a password who submits their address receives a working reset link and can set a new password with it (verified end-to-end against a real mailbox, not mocked) | `get_reset_password_router()` exact routes verified (Code Examples); `email_service.py` pattern from `push_send.py`; this criterion is HUMAN-UAT gated on Step 0 (Resend account not yet created) |
| RESET-02 | Submitting a non-existent address is indistinguishable (same 202, same UI copy, no timing tell) | Verified in `router/reset.py:46-61` — `UserNotExists` returns `None` (202) with no send attempted; no code change needed, just don't break it |
| RESET-03 | Repeated requests for the same address are rate-limited, proven by a mutation test | `_SlidingWindowRateLimiter` reuse pattern (Common Pitfalls + Code Examples); MUST also update `tests/conftest.py`'s autouse fixture |
| RESET-04 | A Resend send failure produces a Sentry event with `user_id` in context, no interpolated message | `push_send.py` pattern (Code Examples) — exact template to copy |
| RESET-05 | A Google-only account (empty `hashed_password`) completes the flow and can then log in by either method | Verified via `fastapi_users/password.py` + `manager.py` reading — Argon2 hashes `""` fine, `_update` unconditionally rewrites `hashed_password` (Code Examples) |
| RESET-06 | Frontend forms: `data-testid` everywhere, `text-sm` floor, `variant="brand-outline"` for secondary actions, usable at 375px, `isError` branch instead of empty-state fallthrough | `LoginForm.tsx`/`RegisterForm.tsx` precedent (Architecture Patterns); note: these forms use plain `useState`+`axios` catch blocks, not TanStack Query, so "isError branch" maps to the existing axios-catch pattern with an explicit inline error state, not a `useQuery` `isError` flag |
| RESET-07 | Existing apex SPF record byte-identical pre/post phase; Swizzonic mail still delivers | Entirely Step 0 (operator, outside code) — see D-05 above; nothing in this phase's code can violate this since no code touches DNS |
| RESET-08 | Each production change is mutation-tested (revert it, confirm the test goes red) | Applies to rate limiter (RESET-03) and Sentry capture (RESET-04) primarily — both have concrete `push_send.py`/`test_push_send.py` precedent for how this project structures such tests |

</phase_requirements>

## Standard Stack

### Core

| Library | Version (pinned/verified) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastapi-users[oauth,sqlalchemy]` | **15.0.5** `[VERIFIED: uv.lock]` | Auth framework already in use; supplies `get_reset_password_router()` and `BaseUserManager.forgot_password`/`reset_password` | Already the project's auth framework — this phase activates dormant functionality, doesn't add a dependency |
| `httpx` | already a dependency (`>=0.27.0`) `[VERIFIED: pyproject.toml]` | The Resend HTTP call | D-03: explicitly chosen over the `resend` SDK; already project-wide for `chesscom_client`/`lichess_client`/`push_send` |

### Supporting

No new packages. `email-validator` (used by Pydantic `EmailStr`) is already a transitive dependency `[VERIFIED: SEED-143's grep of uv.lock:519, re-confirmed via `router/reset.py:2` importing `EmailStr` from `pydantic`]`.

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw `httpx` POST to Resend | Official `resend` Python SDK | D-03 rejects it — adds a dependency for one POST call, no meaningful convenience over `httpx.AsyncClient` |
| Resend | Postmark | Named fallback (D-03) if Resend deliverability ever disappoints — not to be implemented speculatively |
| In-process `_SlidingWindowRateLimiter` | Redis-backed rate limiter | Rejected implicitly by the existing pattern (`ip_rate_limiter.py`'s own docstring: "For multi-process or distributed deployments, replace with a Redis-backed solution") — moot here since prod runs a single Uvicorn process (see Environment Availability) |

**Installation:** none — zero new packages.

**Version verification:** `fastapi-users` pinned at `15.0.5` in `uv.lock` `[VERIFIED: uv.lock, grep 2026-08-08]`; router/manager behavior below is read directly from the **installed** `.venv/lib/python3.13/site-packages/fastapi_users/` source at that exact version, not from generic fastapi-users docs (which routinely lag or diverge across major versions on the token-generation surface).

## Package Legitimacy Audit

No new external packages are introduced by this phase (see Standard Stack — `fastapi-users` and `httpx` are both already-installed, already-audited project dependencies). This section is not applicable; skipping the full audit table per the "Required whenever this phase installs external packages" gate — it does not.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────┐     POST /api/auth/forgot-password      ┌──────────────────────┐
│ ForgotPasswordForm│ ─────────{ email }─────────────────────▶│  fastapi-users router │
│  (new, frontend) │                                          │  (forgot_password)    │
└─────────────────┘                                          └──────────┬────────────┘
                                                                          │ get_by_email()
                                                                          │ (UserNotExists → 202, no-op)
                                                                          ▼
                                                              ┌──────────────────────┐
                                                              │  UserManager          │
                                                              │  .forgot_password()   │──▶ generates JWT
                                                              │  (library, unmodified)│    (aud=reset_password)
                                                              └──────────┬────────────┘
                                                                          │ on_after_forgot_password(user, token, request)
                                                                          ▼
                                                              ┌──────────────────────────────┐
                                                              │ UserManager                   │
                                                              │ .on_after_forgot_password()   │ (OVERRIDE — new code)
                                                              │  1. rate-limit check (email)  │──▶ if throttled: no-op, return
                                                              │  2. build reset URL           │     (still 202 upstream — D-06
                                                              │     (settings.FRONTEND_URL)   │      preserves anti-enumeration)
                                                              │  3. email_service.send(...)   │
                                                              └──────────┬───────────────────┘
                                                                          │ httpx.AsyncClient POST
                                                                          ▼
                                                              ┌──────────────────────┐
                                                              │  Resend API           │──▶ on failure: sentry_sdk
                                                              │  api.resend.com/emails│    .capture_exception()
                                                              └──────────┬────────────┘    (user_id via set_context)
                                                                          │ (delivery, outside this phase)
                                                                          ▼
                                                              ┌──────────────────────┐
┌─────────────────┐   POST /api/auth/reset-password         │  User's mailbox       │
│ ResetPasswordForm│ ◀────── clicks link with ?token= ───────┤  (Step 0 gated)       │
│  (new, frontend) │                                          └──────────────────────┘
└────────┬────────┘
         │ { token, password }
         ▼
┌──────────────────────┐
│  fastapi-users router │
│  (reset_password)     │──▶ decode_jwt (aud check) → verify password_fgpt → _update()
└──────────────────────┘      (library, unmodified; 400 RESET_PASSWORD_BAD_TOKEN / _INVALID_PASSWORD on failure)
```

### Recommended Project Structure

```
app/
├── core/
│   └── reset_password_rate_limiter.py   # new — mirrors feedback_rate_limiter.py exactly
├── services/
│   └── email_service.py                  # new — mirrors push_send.py's shape (client-injectable, no retry)
├── users.py                              # MODIFIED — override on_after_forgot_password
├── routers/
│   └── auth.py                           # MODIFIED — mount get_reset_password_router()
└── core/config.py                        # MODIFIED — add RESEND_API_KEY, MAIL_FROM

frontend/src/
├── components/auth/
│   ├── ForgotPasswordForm.tsx            # new
│   ├── ResetPasswordForm.tsx             # new (or inline in a ResetPasswordPage)
│   └── LoginForm.tsx                     # MODIFIED — add "Forgot password?" link
├── pages/
│   └── ResetPasswordPage.tsx             # new — reads ?token= via useSearchParams
└── App.tsx                               # MODIFIED — register /auth/reset-password route near :845-847

tests/
├── test_auth.py                          # extend with forgot/reset-password test classes
└── conftest.py                           # MODIFIED — register new limiter in reset_in_process_rate_limiters
```

### Pattern 1: Client-injectable httpx service (for testability)

**What:** The outbound-HTTP function takes `client: httpx.AsyncClient` as an explicit parameter rather than constructing one internally and hiding it.
**When to use:** Any new service making one outbound HTTP call that needs to be unit-testable without patching global `httpx.AsyncClient` methods.
**Example (verified pattern — read from the actual file this session):**
```python
# Source: app/services/push_send.py:127-134, 137-149 (VERIFIED: read this session)
def push_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_PUSH_TIMEOUT_SECONDS, follow_redirects=False)

async def send_to_subscription(
    client: httpx.AsyncClient,
    *,
    endpoint: str,
    ...
) -> bool:
    ...
    try:
        resp = await client.post(endpoint, content=encrypted, headers=headers)
    except httpx.HTTPError:
        logger.exception("Push send transport error")
        sentry_sdk.set_tag("source", "push_send")
        sentry_sdk.capture_exception()
        return False
```
The test file (`tests/test_push_send.py:90-95`, verified this session) then builds an `AsyncMock()` and assigns `client.post = AsyncMock(return_value=MagicMock(status_code=...))` — no `unittest.mock.patch` of `httpx.AsyncClient` needed for this path. Follow this exact shape for `email_service.py`.

### Pattern 2: In-process sliding-window rate limiter, reused not reinvented

**What:** `_SlidingWindowRateLimiter` (`app/core/ip_rate_limiter.py:15-42`, VERIFIED this session) is a generic class already instantiated twice — `guest_create_limiter` (keyed by IP) and `feedback_limiter` (keyed by `str(user_id)`, in its own file `app/core/feedback_rate_limiter.py`).
**When to use:** Any new unauthenticated-or-cheap-to-abuse endpoint needing a simple per-key cooldown, on a single-process deployment.
**Example:**
```python
# Source: app/core/feedback_rate_limiter.py (VERIFIED this session, full file — 17 lines)
"""Per-user sliding window rate limiter for feedback submissions.

Reuses the in-process _SlidingWindowRateLimiter from ip_rate_limiter.
Keyed by user_id (str), not IP address. In-process limiter resets on restart —
acceptable for single-process Uvicorn deployment (D-07 / A5).
"""
from app.core.ip_rate_limiter import _SlidingWindowRateLimiter

_FEEDBACK_MAX_REQUESTS = 5
_FEEDBACK_WINDOW_SECONDS = 3600  # 1 hour

feedback_limiter = _SlidingWindowRateLimiter(
    _FEEDBACK_MAX_REQUESTS,
    _FEEDBACK_WINDOW_SECONDS,
)
```
The new `reset_password_rate_limiter.py` should be a near-verbatim copy of this file, keyed by the **submitted email address, lowercased** (not `user_id` — the endpoint is unauthenticated and pre-existence-check, so there is no `user_id` available at the point rate limiting must happen; see Pitfall 1 below for exactly where to call it).

### Pattern 3: Plain-`useState` auth forms, no form library

**What:** `LoginForm.tsx`/`RegisterForm.tsx` (both read in full this session) use `useState` per field, a `validate()` function returning `string | null`, `axios.isAxiosError` branching in the catch block, `sonner`'s `toast.error`/`toast.success`, and `Sentry.captureException` **only** on the unexpected-error branch (expected 400/401 responses are excluded from Sentry per CLAUDE.md).
**When to use:** `ForgotPasswordForm.tsx` and the reset-password form — no `react-hook-form`/`zod`/`formik` is installed in `frontend/package.json` `[VERIFIED: grep frontend/package.json, zero hits]`, so introducing one here would be a scope-creeping, unrequested dependency.
**Example:**
```tsx
// Source: frontend/src/components/auth/LoginForm.tsx:38-58 (VERIFIED this session)
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  setSubmitting(true);
  try {
    await login(email, password);
    navigate('/', { replace: true });
  } catch (err: unknown) {
    let message = 'Login failed. Please check your credentials.';
    if (axios.isAxiosError(err) && (err.response?.status === 400 || err.response?.status === 401)) {
      message = 'Invalid email or password.';
    } else {
      Sentry.captureException(err, { tags: { source: 'auth' } });
    }
    toast.error(message);
  } finally {
    setSubmitting(false);
  }
};
```
For `ForgotPasswordForm`, the 202-always-regardless-of-existence contract (RESET-02) means the success branch should show one generic "If that address is registered, you'll receive a reset link" message — never a distinct "not found" branch — mirroring how the backend itself refuses to distinguish.

### Pattern 4: Reading a route's `?token=` query param

**What:** `useSearchParams` from `react-router` (already used in `pages/Auth.tsx:1,10,17` for the `?tab=register` param, VERIFIED this session).
**When to use:** The new `/auth/reset-password` route reading `?token=`.
**Example:**
```tsx
// Pattern from frontend/src/pages/Auth.tsx:1,10 (VERIFIED this session)
import { useSearchParams } from 'react-router';
const [searchParams] = useSearchParams();
const token = searchParams.get('token');
```

### Anti-Patterns to Avoid

- **Adding a FastAPI dependency to the mounted sub-router to read the request body for rate limiting.** `get_reset_password_router()`'s `/forgot-password` route declares `email: EmailStr = Body(..., embed=True)` directly in the endpoint function (`router/reset.py:48`, VERIFIED this session) — there is no clean seam to intercept the body via `include_router(..., dependencies=[...])` without risky reliance on FastAPI's body-merging behavior across separate callables, which is unverified for this exact case. Do the rate-limit check inside the `on_after_forgot_password` override instead (Pattern 2 + Pitfall 1) — it already receives the `user`, and skipping the send there preserves the no-enumeration 202 contract for free.
- **Raising a custom exception from `on_after_forgot_password` to surface a 429.** The router only catches `exceptions.UserInactive` from `user_manager.forgot_password()` (`router/reset.py:56-59`, VERIFIED); anything else propagates as an unhandled 500. Since RESET-02's anti-enumeration contract means a throttled response should look identical to a normal one anyway (202, generic copy), there is no reason to want a 429 here — just skip the send silently when throttled.
- **Retry-with-backoff on the Resend call.** `chesscom_client.py`/`lichess_client.py` have heavyweight exponential-backoff retry loops appropriate for bulk import; `push_send.py` (the correct analog for a single transactional send) has **zero retry** — one attempt, capture on failure, move on. Follow `push_send.py`, not the import clients.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Reset token generation/validation, expiry, audience-scoping | A custom JWT reset-token scheme | `fastapi_users`'s `forgot_password()`/`reset_password()` (already vendored, already wired to `reset_password_token_secret`) | Exactly what D-01/the ROADMAP scope calls for; re-deriving this is the definition of scope creep here |
| Per-key request throttling | A new `dict`/`Counter`-based limiter from scratch | `_SlidingWindowRateLimiter` (`app/core/ip_rate_limiter.py`) | Already generic, already tested via two other call sites, already has an eviction/window contract |
| Enumeration-safe "does this email exist" response | A custom same-response-shape trick | fastapi-users' own `forgot_password` router (`UserNotExists` → `None` → 202) | Already correct out of the box (SEED-143's own "Note") — building anything here is wasted, riskier code |

**Key insight:** every piece of this phase that *looks* like it needs new logic already has a load-bearing library or in-repo precedent. The actual new code is: one rate-limiter file (~15 lines), one email-service file (~30-40 lines), one `on_after_forgot_password` override (~10-15 lines), two small frontend forms, and one route registration. Anything larger than that is scope creep.

## Common Pitfalls

### Pitfall 1: Rate-limiting in the wrong place breaks the no-enumeration contract

**What goes wrong:** If the rate-limit check is a FastAPI dependency in front of the whole `/forgot-password` route, a throttled *existing* email and a throttled *non-existent* email are indistinguishable from each other, but the transition from "not throttled" → "throttled" for the same email IS a distinguishable state, and if that check runs before `get_by_email`, an attacker submitting the same nonexistent address 6 times learns nothing new, but if it's implemented as a global-body-dependency returning 429 explicitly, it's a new distinguishable status code an attacker could correlate against known-vs-unknown timing.
**Why it happens:** The natural instinct is "check the rate limit first, before doing anything else" — which is correct for `guest_create`/`feedback` (both are authenticated-adjacent, no enumeration concern) but wrong here because RESET-02 explicitly requires the response to carry no signal at all.
**How to avoid:** Check the rate limiter **inside `on_after_forgot_password`**, which only ever fires for a real, active user (the router already filtered out `UserNotExists`/`UserInactive` upstream, `router/reset.py:51-59`). If throttled, skip the `email_service.send(...)` call and return normally — the router still returns 202 either way, with identical latency characteristics for both "throttled" and "sent" (send happens fire-and-forget from the caller's perspective either way since `on_after_forgot_password` is awaited but nothing in the router branches on its result).
**Warning signs:** A test asserting a 429 status code for repeated forgot-password calls — that's the wrong shape for this endpoint; the right assertion is "the email service's send was called at most once in the window."

### Pitfall 2: Forgetting to register the new rate limiter in `conftest.py`'s autouse fixture

**What goes wrong:** `tests/conftest.py:446-463` (`reset_in_process_rate_limiters`, VERIFIED this session, full docstring read) already documents this exact failure mode for the two existing limiters: under serial CI execution, one shared process means the sliding window accumulates across unrelated tests until it silently trips, producing a mysterious `KeyError` or similar downstream failure instead of an obvious rate-limit error. This is called out as a **known, previously-hit bug class** for this exact mechanism, not a hypothetical.
**Why it happens:** The rate limiter is a module-level singleton that lives for the whole pytest process; new limiter files are easy to forget adding to a fixture defined elsewhere.
**How to avoid:** The moment `reset_password_rate_limiter.py` (or whatever it's named) is created, add its `_timestamps.clear()` call to `reset_in_process_rate_limiters` in the same commit/task.
**Warning signs:** Password-reset tests pass in isolation but fail when run as part of the full serial suite (`uv run pytest -x`, no `-n auto`) — exactly the asymmetry CLAUDE.md's own memory notes call out for other rate limiters in this project.

### Pitfall 3: Assuming `get_reset_password_router()` needs schema arguments like `get_register_router()` does

**What goes wrong:** `get_register_router(fapi_schemas.BaseUser[int], fapi_schemas.BaseUserCreate)` (the existing call at `app/routers/auth.py:50`) takes two Pydantic schema type arguments. `get_reset_password_router()` does **not** — it takes only `get_user_manager` (`router/reset.py:35-37`, VERIFIED this session: `def get_reset_password_router(get_user_manager: UserManagerDependency[...]) -> APIRouter`). Assuming symmetry with the register-router call site and trying to pass schema types will fail to type-check.
**Why it happens:** Surface-level pattern-matching against the adjacent `get_register_router` call.
**How to avoid:** `router.include_router(fastapi_users.get_reset_password_router(get_user_manager), prefix="/auth", tags=["auth"])` — one argument.
**Warning signs:** `ty check` failing on an extra-positional-argument error at the new `include_router` call.

### Pitfall 4: Building a special-case branch for Google-only (empty-hash) accounts

**What goes wrong:** It's tempting to add an `if not user.hashed_password: ...` guard in `on_after_forgot_password` or the frontend, "just in case" empty-hash breaks the token fingerprinting.
**Why it happens:** Reasonable-looking defensive instinct — "surely hashing an empty string is a footgun."
**How to avoid:** It isn't one, here — verified by reading `fastapi_users/password.py` (VERIFIED this session): `PasswordHelper.hash(password)` delegates to `pwdlib`'s `Argon2Hasher`, which hashes any `str` including `""` without special-casing. `forgot_password()` computes `password_fgpt = self.password_helper.hash(user.hashed_password)` (`manager.py:376`) and embeds it in the token; `reset_password()` later calls `verify_and_update(user.hashed_password, password_fingerprint)` (`manager.py:425-427`) which will correctly validate since both sides use the same (empty-string) input. `_update(user, {"password": password})` then unconditionally rewrites `hashed_password` to the new password's hash — Google-only accounts end up with both login methods, exactly per D-04, no code changes needed to support this case.
**Warning signs:** Any new `if user.hashed_password == ""` check anywhere in this phase's new code is very likely unnecessary scope creep — flag it for removal unless a test demonstrates an actual failure without it.

## Runtime State Inventory

Not applicable — this phase adds new capability, it is not a rename/refactor/migration phase. No renamed identifiers, no stored-data migration.

## Code Examples

### `get_reset_password_router()` — exact routes, verified from installed source

```python
# Source: .venv/lib/python3.13/site-packages/fastapi_users/router/reset.py
# (VERIFIED this session — read in full, fastapi-users==15.0.5 per uv.lock)

def get_reset_password_router(get_user_manager) -> APIRouter:
    router = APIRouter()

    @router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED, name="reset:forgot_password")
    async def forgot_password(request: Request, email: EmailStr = Body(..., embed=True), user_manager=Depends(get_user_manager)):
        try:
            user = await user_manager.get_by_email(email)
        except exceptions.UserNotExists:
            return None  # 202, no send attempted — RESET-02's anti-enumeration guarantee
        try:
            await user_manager.forgot_password(user, request)
        except exceptions.UserInactive:
            pass
        return None

    @router.post("/reset-password", name="reset:reset_password", responses=RESET_PASSWORD_RESPONSES)
    async def reset_password(request: Request, token: str = Body(...), password: str = Body(...), user_manager=Depends(get_user_manager)):
        try:
            await user_manager.reset_password(token, password, request)
        except (exceptions.InvalidResetPasswordToken, exceptions.UserNotExists, exceptions.UserInactive):
            raise HTTPException(status_code=400, detail=ErrorCode.RESET_PASSWORD_BAD_TOKEN)
        except exceptions.InvalidPasswordException as e:
            raise HTTPException(status_code=400, detail={"code": ErrorCode.RESET_PASSWORD_INVALID_PASSWORD, "reason": e.reason})

    return router
```

Routes, verified: `POST /forgot-password` (body `{"email": "..."}`, always 202/`None`), `POST /reset-password` (body `{"token": "...", "password": "..."}`, 200 with updated user on success, 400 with `detail="RESET_PASSWORD_BAD_TOKEN"` or `detail={"code": "RESET_PASSWORD_INVALID_PASSWORD", "reason": "..."}` on failure). Error code strings, verified from `router/common.py:15-24`: `ErrorCode.RESET_PASSWORD_BAD_TOKEN = "RESET_PASSWORD_BAD_TOKEN"`, `ErrorCode.RESET_PASSWORD_INVALID_PASSWORD = "RESET_PASSWORD_INVALID_PASSWORD"`.

Mount alongside the existing routers:

```python
# Source: app/routers/auth.py:49-53 (VERIFIED this session, existing pattern to copy)
router.include_router(
    fastapi_users.get_register_router(fapi_schemas.BaseUser[int], fapi_schemas.BaseUserCreate),
    prefix="/auth",
    tags=["auth"],
)
# New:
router.include_router(
    fastapi_users.get_reset_password_router(get_user_manager),
    prefix="/auth",
    tags=["auth"],
)
```

### `on_after_forgot_password` — exact signature, verified from installed source

```python
# Source: .venv/lib/python3.13/site-packages/fastapi_users/manager.py:561-574 (VERIFIED this session)
async def on_after_forgot_password(
    self, user: models.UP, token: str, request: Request | None = None
) -> None:
    """Perform logic after successful forgot password request.
    *You should overload this method to add your own logic.*
    """
    return  # pragma: no cover  <- current no-op base; app/users.py:63 has NOT overridden this
```

Recommended override shape (new code, following Pattern 1 + Pattern 2):

```python
# app/users.py — new override on UserManager, alongside the existing on_after_register/on_after_login
async def on_after_forgot_password(
    self, user: User, token: str, request: Request | None = None
) -> None:
    if not reset_password_rate_limiter.is_allowed(user.email.lower()):
        return  # D-06: silently skip the send; router still returns 202 either way (RESET-02)
    reset_url = f"{settings.FRONTEND_URL}/auth/reset-password?token={token}"
    async with email_service.email_http_client() as client:
        await email_service.send_password_reset_email(client, to=user.email, reset_url=reset_url, user_id=user.id)
```

### Token TTL / audience — verified defaults, no change needed

```python
# Source: .venv/lib/python3.13/site-packages/fastapi_users/manager.py:32-34 (VERIFIED this session)
reset_password_token_secret: SecretType             # app/users.py:64 sets this = settings.SECRET_KEY
reset_password_token_lifetime_seconds: int = 3600   # 1 hour — SEED-143 D-05/"Note" says "fine as-is", confirmed as the library default, no override needed
reset_password_token_audience: str = "fastapi-users:reset"  # distinct audience — safe to share SECRET_KEY across JWT purposes (auth, OAuth state, impersonation, guest, reset) because decode_jwt strictly validates `aud`
```

### `send_to_subscription` shape to mirror in `email_service.py`

See Pattern 1 above (full excerpt) — `app/services/push_send.py:127-134,137-149,198-204`, VERIFIED this session. Copy: client-as-parameter, `try/except httpx.HTTPError`, `sentry_sdk.set_tag("source", "email_service")` + `capture_exception()` on transport failure, non-2xx handled explicitly (Resend's error shape below), no retry loop.

### Resend `POST /emails` — request/response/error shape

```
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
Content-Type: application/json

{"from": "FlawChess <noreply@flawchess.com>", "to": ["user@example.com"], "subject": "...", "html": "...", "text": "..."}
```
[CITED: resend.com/docs — llms-full.txt, fetched via Context7 this session]

- Success: `200`, body `{"id": "<email-id>"}`.
- Auth errors: `401` (missing API key or a send-only-restricted key used for a non-send action), `403` (invalid/insufficient-permission key).
- Validation: `422`, body shape `{"statusCode": 422, "name": "validation_error", "message": "..."}` — e.g. malformed `from`, missing required field.
- Rate limit: `429` — Resend enforces 10 req/s **per team** (not per key/domain), far above this phase's realistic volume (~5/year) but worth a code comment so nobody "fixes" a future false-positive by adding retry logic here.
- Optional `Idempotency-Key` header exists (dedupes retried requests with the same key) — not needed given D-07's rejection of retry logic, but worth knowing it exists if a future canary send (currently rejected) is ever reconsidered.

### Reading `?token=` on the reset-password route

See Pattern 4 above — `useSearchParams` from `react-router`, exact usage verified at `frontend/src/pages/Auth.tsx:1,10,17`.

## State of the Art

Not applicable in the "old vs. new library version" sense — this is a first-time integration of dormant, already-pinned functionality, not a migration off something. Nothing about fastapi-users' reset-password surface has changed within the pinned `15.0.5`; the "old approach" (nothing at all) is simply the current gap this phase closes.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The rate-limiter should key on the submitted email address, lowercased, rather than the request IP. | Architecture Patterns / Pattern 2 | If wrong, a single IP could still flood distinct addresses (mail-bombing multiple known users) without being throttled per-target; conversely, keying by IP alone would let a proxy/NAT'd office throttle unrelated users. Low risk given "~5 sends/year" realistic volume (SEED-143), but worth a one-line confirmation at plan time — D-06's own text says "lets a known user be mail-bombed," implying per-email is the intended key. |
| A2 | The rate-limit threshold/window (e.g. 1 request per 5 minutes, or similar) is Claude's discretion, not specified by any locked decision. | Architecture Patterns / Pattern 2 | If the planner picks a threshold that's too aggressive, a legitimate user retrying after a slow email arrival gets silently no-op'd on the second attempt; too loose and it doesn't meaningfully protect the 100/day Resend cap. Recommend something like 3 requests / 15 minutes per email as a starting point — cheap to change since it's one module constant, not a schema/migration. |
| A3 | `reset_password_rate_limiter` should live in a new `app/core/reset_password_rate_limiter.py` file (mirroring `feedback_rate_limiter.py`'s one-purpose-per-file convention) rather than being added inline to `ip_rate_limiter.py`. | Architecture Patterns / Recommended Project Structure | Purely a file-organization call; either way works functionally. Low risk — easy to move later. |
| A4 | The reset-password frontend route is a full page (`ResetPasswordPage.tsx`) rather than a tab within the existing `AuthPage.tsx` Tabs component. | Recommended Project Structure | The ROADMAP text says "a `/auth/reset-password` route reading `?token=`" (singular new route), which reads as a standalone page, not a third tab — `AuthPage`'s tab logic is specifically login-vs-register and redirects already-authenticated users away, which reset-password should NOT do (a user could be resetting a password while still logged in on another device/tab, though rare). Recommend a separate page component. If wrong, minor refactor, no data-model impact. |

## Open Questions (RESOLVED at planning, 2026-08-08)

> All three were resolved in the Phase 207 plans. Resolutions recorded inline below; the plans are authoritative.
>
> 1. **RESOLVED — match precedent: 5 requests / 3600s**, as named constants `_RESET_PASSWORD_MAX_REQUESTS` / `_RESET_PASSWORD_WINDOW_SECONDS` (207-01-PLAN.md Task 2). Not tightened: the flow's realistic volume is single-digit per year, so a stricter limit buys nothing and risks locking out a legitimate retry.
> 2. **RESOLVED — plain-text-forward HTML**, no logo, no CDN dependency, no templating engine (207-01-PLAN.md Task 1).
> 3. **RESOLVED — copy `push_send.py`'s context-not-message convention verbatim** (207-01-PLAN.md Task 2, threat T-207-10). Status code and user_id go in `sentry_sdk.set_context`; the exception message is a constant so Sentry grouping stays intact.

1. **Exact rate-limit threshold/window for D-06.**
   - What we know: D-06 says "~10 lines," implying reuse of the existing `_SlidingWindowRateLimiter` shape (which takes `max_requests, window_seconds`); `feedback_limiter` uses 5/3600s, `guest_create_limiter` uses 5/3600s.
   - What's unclear: whether password-reset should be stricter (fewer requests, since it's a lower-volume/higher-sensitivity flow) than the existing 5/hour precedent.
   - Recommendation: default to matching precedent unless the planner/user wants something tighter; flag as a one-constant decision, not a design question.

2. **Email HTML/text template content and branding.**
   - What we know: D-03 rejects a templating engine; the seed's implementation sketch implies inline strings.
   - What's unclear: exact subject line, exact copy, whether to include the FlawChess logo/branding inline (no CDN/image-hosting infrastructure decision has been made for transactional email).
   - Recommendation: plain-text-forward HTML (a heading, one paragraph, one button/link, footer) — matches the "no templating engine" constraint and avoids scope creep into email-design work not requested.

3. **Whether `email_service.py` needs to distinguish "Resend down" from "Resend rejected the request" for Sentry grouping purposes** (RESET-04's "no variable interpolated into the message" requirement, similar to `push_send.py`'s status-code-in-context-not-message pattern).
   - What we know: `push_send.py` puts `status_code` in `set_context`, never in the message string, to preserve Sentry grouping (`app/services/push_send.py:240-244`, VERIFIED).
   - What's unclear: nothing really — this is a solved pattern to copy, listed here only so the planner doesn't reinvent a different approach.
   - Recommendation: copy `push_send.py`'s exact context-not-message convention verbatim.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Resend account + API key | RESET-01 (real send) | ✗ (Step 0 not yet done, per ROADMAP "Blocking pre-planning gate") | — | None for the live-mailbox UAT item — RESET-01 must be scoped as HUMAN-UAT gated on Step 0 completing; all other criteria (rate limit, Sentry capture, Google-only flow, frontend forms) can be built and tested (mocked) without it |
| DNS records (SPF/MX/DKIM/DMARC on `send.`/apex) | RESET-01, RESET-07 | ✗ (Step 0) | — | Same as above |
| `httpx` | email_service.py | ✓ | `>=0.27.0` `[VERIFIED: pyproject.toml]` | — |
| Single-process Uvicorn (no `--workers` flag) | In-process rate limiter soundness (RESET-03) | ✓ | `deploy/entrypoint.sh:10` `exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'` `[VERIFIED this session — no --workers flag]` | N/A — this IS the fallback already in use; if prod ever moves to multi-worker Uvicorn, every existing in-process limiter (`guest_create_limiter`, `feedback_limiter`) breaks identically, not just this new one |

**Missing dependencies with no fallback:**
- Resend account/API key + DNS records (Step 0). RESET-01 (real end-to-end mailbox delivery) cannot be executed until Step 0 lands — plan this as a `checkpoint:human-verify`/HUMAN-UAT item, not an automated executor task. Per CLAUDE.md project memory (`feedback_no_dev_db_reset_in_plans` analog reasoning), do not gate the rest of the phase's completion on this external step; the code can be built, unit-tested (mocked Resend calls), and merged with `RESEND_API_KEY`/`MAIL_FROM` as unset-safe config defaults (mirroring how `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` default to `""` and gracefully no-op — see `is_push_configured()` in `push_send.py:103-105` for the exact precedent pattern to copy for an `is_email_configured()` equivalent).

**Missing dependencies with fallback:** none beyond the above — everything else needed is already present in the repo/environment.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest + pytest-asyncio, `[VERIFIED: CLAUDE.md commands section + tests/conftest.py structure read this session]` |
| Config file | `pyproject.toml` (pytest config) / `tests/conftest.py` (fixtures) |
| Quick run command | `uv run pytest tests/test_auth.py -x` |
| Full suite command | `uv run pytest -n auto` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RESET-01 | Full forgot→email→reset→login flow (mocked Resend) | integration | `uv run pytest tests/test_auth.py::TestPasswordReset -x` | ❌ new test class needed |
| RESET-01 (real mailbox) | End-to-end against a real Resend send | HUMAN-UAT | N/A — manual, gated on Step 0 | N/A |
| RESET-02 | Non-existent email returns identical 202 | integration | same file, `test_forgot_password_nonexistent_email_returns_202` | ❌ new |
| RESET-03 | Repeated same-email requests rate-limited; mutation-tested | integration + unit | asserts `email_service.send_*` call count ≤ 1 across N rapid requests; revert the rate-limit check and confirm the test goes red | ❌ new; **must also update `tests/conftest.py`'s `reset_in_process_rate_limiters` fixture** |
| RESET-04 | Sentry capture on send failure, `user_id` in context, no interpolation | unit | mirrors `tests/test_push_send.py`'s `patch("...sentry_sdk.capture_exception")` pattern | ❌ new; `tests/test_push_send.py` is the direct template to copy structurally |
| RESET-05 | Google-only account completes flow, logs in both ways afterward | integration | register-via-Google-simulation (or directly construct a `hashed_password=""` user, mirroring `guest_service.py:156`'s pattern) then forgot→reset→login with password | ❌ new |
| RESET-06 | Frontend `data-testid`/`text-sm`/`brand-outline`/375px/`isError` | frontend (Vitest) + manual 375px check | `npm test -- --run` for component tests; 375px is a manual/browser-automation check (`claude-in-chrome` skill available) | ❌ new components, no existing tests |
| RESET-07 | Apex SPF byte-identical, Swizzonic still delivers | HUMAN-UAT (DNS, outside code) | N/A | N/A |
| RESET-08 | Mutation-tested production changes | process, not a single test | Applies the "revert and confirm red" discipline to RESET-03/04's own tests | N/A |

### Sampling Rate
- **Per task commit:** `uv run pytest tests/test_auth.py -x`
- **Per wave merge:** `uv run pytest -n auto`
- **Phase gate:** Full suite green before `/gsd-verify-work`; frontend `npm run lint && npm test -- --run`

### Wave 0 Gaps
- [ ] No existing `tests/test_auth.py` coverage for password reset — needs a new `TestPasswordReset` class (or a new `test_password_reset.py` file, consistent with `test_oauth_csrf.py` being its own file rather than folded into `test_auth.py`).
- [ ] No existing `tests/test_email_service.py` — needs the `push_send.py`-mirroring unit tests (client-injection, Sentry capture, no-retry).
- [ ] `tests/conftest.py`'s `reset_in_process_rate_limiters` fixture needs the new limiter added (see Pitfall 2) — this is a one-line addition to an existing fixture, not a new file, but it's easy to miss since it's not "this phase's" file.
- [ ] Frontend: no existing test file for `ForgotPasswordForm`/reset-password form — check whether `LoginForm.test.tsx`/`RegisterForm.test.tsx` exist as precedent (not confirmed present or absent this session; grep `frontend/src/components/auth/*.test.tsx` at plan time).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Stateless JWT reset token, 1h TTL, distinct `aud` claim (`fastapi-users:reset`) preventing cross-purpose token replay against other endpoints that share `SECRET_KEY` — all library-standard, verified this session |
| V3 Session Management | no | This flow doesn't touch session/JWT-auth tokens directly (it precedes a fresh login) |
| V4 Access Control | n/a | Endpoint is intentionally unauthenticated by design (you can't be logged in if you forgot your password) |
| V5 Input Validation | yes | `EmailStr` (Pydantic) on the email field, library-enforced; new password validated by `InvalidPasswordException`/`PasswordHelper` server-side — do not add a weaker client-only check that could diverge |
| V6 Cryptography | yes | Password hashing (Argon2 via `pwdlib`) is entirely library-owned — never hand-roll |
| V7 Error Handling / Logging | yes | RESET-04's Sentry rule directly maps here — no variable interpolation into messages, consistent with the project's existing Sentry conventions across `app/services/` |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| User enumeration via forgot-password response | Information Disclosure | Already solved: `router/reset.py` returns identical 202/`None` regardless of email existence (RESET-02) — do not weaken this by, e.g., returning a different message when the rate limiter throttles vs. when it doesn't |
| Reset-endpoint mail-bombing / cap exhaustion | Denial of Service | D-06's per-email rate limiter (Pitfall 1/2) |
| Token replay across purposes (reset token reused as an auth token) | Tampering / Elevation of Privilege | Already mitigated by fastapi-users' `aud` claim checking in `decode_jwt` — verified this session, no new code needed |
| SSRF via the outbound Resend call | Tampering | Not applicable — the destination URL (`api.resend.com`) is a fixed constant, never client-supplied, unlike `push_send.py`'s client-controlled endpoint (which is why THAT module needs `follow_redirects=False`); this phase's email service does not need the same SSRF mitigation, but should still set a bounded `timeout` |

## Sources

### Primary (HIGH confidence — read directly this session)

- `.venv/lib/python3.13/site-packages/fastapi_users/router/reset.py` — full file, `fastapi-users==15.0.5`
- `.venv/lib/python3.13/site-packages/fastapi_users/manager.py` — `forgot_password`, `reset_password`, `on_after_forgot_password`, `on_after_reset_password`, token TTL/audience defaults
- `.venv/lib/python3.13/site-packages/fastapi_users/password.py` — `PasswordHelper.hash`, Argon2/bcrypt hashers
- `.venv/lib/python3.13/site-packages/fastapi_users/router/common.py` — `ErrorCode` enum values
- `app/users.py`, `app/routers/auth.py`, `app/core/config.py`, `app/core/ip_rate_limiter.py`, `app/core/feedback_rate_limiter.py`, `app/routers/feedback.py`, `app/services/push_send.py`, `app/services/guest_service.py` (partial), `tests/test_auth.py`, `tests/test_push_send.py` (partial), `tests/conftest.py` (partial) — all read in full or targeted-section this session
- `frontend/src/components/auth/LoginForm.tsx`, `RegisterForm.tsx`, `frontend/src/pages/Auth.tsx`, `frontend/src/App.tsx` (routes section), `frontend/src/api/client.ts`, `frontend/src/components/ui/button.tsx` — all read this session
- `docker-compose.yml`, `Dockerfile`, `deploy/entrypoint.sh` — confirmed single-process Uvicorn, no `--workers` flag
- `bin/deploy.sh:28-29` — confirmed `.prod.env` scp anchor matches ROADMAP citation exactly, no drift
- `uv.lock` — `fastapi-users==15.0.5`, `httpx>=0.27.0`

### Secondary (MEDIUM confidence)

- Resend API docs via Context7 (`/websites/resend`) — `POST /emails` request/response/error shape, rate limits (10 req/s per team), idempotency keys. `[CITED: resend.com/docs]`

### Tertiary (LOW confidence)

None — every claim in this document is either read from the pinned library/repo source this session, or cited against Resend's own documentation. No claim rests on unverified training-data recall.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new packages, all versions read from `uv.lock`
- Architecture: HIGH — every backend pattern verified by reading the pinned library source and the closest in-repo analog (`push_send.py`) in full
- Pitfalls: HIGH — Pitfall 2 (conftest fixture) is a documented, previously-hit bug class in this exact codebase, not a hypothetical
- Frontend: HIGH — `LoginForm.tsx`/`RegisterForm.tsx` read in full, zero ambiguity about the idiom to follow
- Resend API shape: MEDIUM — CITED against official docs via Context7, not independently probed against a live account (Step 0 not done)

**Research date:** 2026-08-08
**Valid until:** 30 days for the in-repo patterns (stable, slow-moving auth code); the Resend API shape should be re-confirmed against the live dashboard during Step 0 execution regardless of this document's age, since Step 0 itself instructs reading exact values off the dashboard rather than trusting research.
