---
phase: 207-self-serve-password-reset
plan: 01
subsystem: auth
tags: [fastapi-users, httpx, resend, rate-limiter, sentry, jwt, password-reset]

requires: []
provides:
  - "POST /api/auth/forgot-password and POST /api/auth/reset-password mounted and working end to end"
  - "app.services.email_service — client-injectable, no-retry Resend email service with non-blocking dispatch"
  - "app.core.reset_password_rate_limiter.reset_password_limiter — third in-process sliding-window limiter"
  - "UserManager.on_after_forgot_password — eligibility gate (credential state) + rate limit + dispatch"
  - "Exact HTTP contract (routes, bodies, statuses, error codes) for Plan 02's frontend forms"
affects: [207-02-frontend-forms, 207-03-real-mailbox-uat]

actuals:
  tokens: 13907
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "Client-injectable httpx service (email_service mirrors push_send.py) for testability without patching global httpx.AsyncClient"
    - "Fire-and-forget dispatch via asyncio.Task + a strong-reference registry (_pending_sends) to defeat a timing-oracle, with a drain_pending_sends() test-only utility"
    - "Silent-no-op guard shape (no raise/log/Sentry) shared by both the eligibility gate and the rate limiter, deliberately deviating from the two existing raising limiter call sites"
    - "AST-based (not regex/substring) source-invariant tests that ignore docstrings/comments, avoiding false positives on prose that names the very identifiers the code must not read"

key-files:
  created:
    - app/core/reset_password_rate_limiter.py
    - app/services/email_service.py
    - tests/test_password_reset.py
    - tests/test_email_service.py
    - tests/test_users_account_type_invariant.py
  modified:
    - app/core/config.py
    - app/users.py
    - app/routers/auth.py
    - tests/conftest.py

key-decisions:
  - "fastapi_users.get_reset_password_router() (bound instance method) takes NO arguments — it already closes over self.get_user_manager and delegates to the module-level factory. RESEARCH/PATTERNS assumed it forwards get_user_manager positionally like get_register_router's schema args; verified against installed fastapi-users==15.0.5 and fixed at the mount call site."
  - "The forgot-password 202 response body is the literal `null` (4 bytes), not truly empty — FastAPI's default JSONResponse serializing a None return with no response_model. Both eligible and ineligible/unregistered/inactive/rate-limited requests share this exact body, which is what RESET-02's indistinguishability is proven against."
  - "Kept user.email.lower() in the rate-limiter call as defense-in-depth even though it is not currently load-bearing at this call site — see Deviations for why."

requirements-completed: [RESET-01, RESET-02, RESET-03, RESET-04, RESET-05, RESET-08]

coverage:
  - id: D1
    description: "Forgot-password -> reset-password -> login-with-new-password works end to end over HTTP with the Resend send mocked"
    requirement: "RESET-01"
    verification:
      - kind: integration
        ref: "tests/test_password_reset.py::TestPasswordResetFlow::test_forgot_reset_login_end_to_end"
        status: pass
    human_judgment: false
  - id: D2
    description: "Registered / unregistered / inactive / rate-limited forgot-password requests are indistinguishable by status and body"
    requirement: "RESET-02"
    verification:
      - kind: integration
        ref: "tests/test_password_reset.py::TestForgotPasswordIndistinguishability::test_registered_unregistered_inactive_ratelimited_identical"
        status: pass
    human_judgment: false
  - id: D3
    description: "Per-email rate limit holds at its boundary, across the window edge, under concurrency, and by case-insensitive key — non-blocking dispatch proven by a timing test"
    requirement: "RESET-03"
    verification:
      - kind: integration
        ref: "tests/test_password_reset.py::TestForgotPasswordRateLimit (4 tests) + TestNonBlockingDispatch::test_202_returned_before_send_completes"
        status: pass
    human_judgment: false
  - id: D4
    description: "A send failure (transport error and non-2xx) each produce one Sentry capture with a constant message and variables only in context"
    requirement: "RESET-04"
    verification:
      - kind: unit
        ref: "tests/test_email_service.py (6 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Eligibility is credential state: a password+Google dual account (125-account majority) resets normally; an empty-hash account (Google-only/guest) is a byte-identical silent no-op; an invariant test blocks both re-fusing account-type onto the hash and deriving eligibility from oauth_account/is_guest"
    requirement: "RESET-05"
    verification:
      - kind: integration
        ref: "tests/test_password_reset.py::TestPasswordResetEligibility (4 tests)"
        status: pass
      - kind: unit
        ref: "tests/test_users_account_type_invariant.py (2 tests, AST-based)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Every production change in this plan is mutation-tested (revert -> named test goes red), recorded in the table below"
    requirement: "RESET-08"
    verification: []
    human_judgment: true
    rationale: "The mutation table is a manual revert-and-confirm log performed during execution, not itself an automated CI check — a human/reviewer signature on the table's honesty (including the two corrected rows) is the appropriate verification here."

duration: 65min
completed: 2026-08-08
status: complete
---

# Phase 207 Plan 1: Backend Password Reset Spine Summary

**Dormant fastapi-users reset-password router wired end to end with a new Resend email service, a third silent-no-op rate limiter, and a credential-state-only eligibility gate — all mutation-tested, with two plan-authored mutation predictions corrected against actual measured behavior.**

## Performance

- **Duration:** 65 min
- **Started:** 2026-08-08T11:08:00Z (approx, from prior commit `91642908b`)
- **Completed:** 2026-08-08T11:43:00Z
- **Tasks:** 3
- **Files modified:** 9 (4 production files, 5 test files)

## Accomplishments

- A registered user can be driven from `POST /api/auth/forgot-password` through a captured token to `POST /api/auth/reset-password` and a successful JWT login with the new password, entirely over HTTP with Resend mocked.
- Fixed the T-207-02 timing oracle: the tracer's hook originally awaited the Resend POST in-request; `email_service.spawn_password_reset_email` now fires it as a detached `asyncio.Task` so an existing address costs the requester nothing extra.
- Eligibility is credential state, not account type: a user holding BOTH a password and a linked Google account (the 125-account prod majority) resets normally with the `oauth_account` row surviving untouched; an empty-hash account (Google-only or guest) is a silent no-op indistinguishable at the HTTP layer.
- An AST-based invariant test (not regex/substring) pins two facts about `app/users.py`: the empty-hash comparison exists at exactly one site, and `on_after_forgot_password`'s own code (not its docstring) never references `oauth_account`/`oauth_accounts`/`is_guest`.
- Every production change is mutation-tested: 9 rows total (6 in Task 2, 3 in Task 3), each a real revert-and-confirm-red cycle from a clean tree — including two rows where the plan's own prediction was wrong and had to be corrected against actual behavior (see Deviations).
- Found and fixed a real test-infrastructure bug along the way: direct-DB test fixture helpers were importing `async_session_maker` at module top level, binding the pre-patch object before `tests/conftest.py`'s per-run-database fixture swaps it in, so writes were silently landing outside the test database.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end tracer** - `e361d3836` (feat)
2. **Task 2: Rate limit, non-blocking dispatch, Sentry contract** - `b4c64d205` (feat), `65643b464` (test — closed a mutation-coverage gap)
3. **Task 3: Eligibility is credential state** - `1e0f2af91` (test), `9623464eb` (test — invariant failure now names file:line)

_Note: Tasks 2 and 3 each carry a follow-up commit closing a gap discovered while running the mutation-test proof required by their own acceptance criteria — not new scope, tightening of the same task's tests._

## Files Created/Modified

- `app/core/config.py` — `RESEND_API_KEY: str = ""`, `MAIL_FROM: str = "noreply@flawchess.com"` (empty = unconfigured, mirrors `VAPID_*`)
- `app/core/reset_password_rate_limiter.py` — third `_SlidingWindowRateLimiter` instance (5/3600s), silent-no-op call-site contract documented in the module docstring
- `app/services/email_service.py` — `is_email_configured`, `email_http_client`, `send_password_reset_email`, `spawn_password_reset_email`, `drain_pending_sends`, `_pending_sends`
- `app/users.py` — `UserManager.on_after_forgot_password`: eligibility gate -> rate limit -> reset URL -> non-blocking dispatch, all silent no-ops on rejection
- `app/routers/auth.py` — mounts `fastapi_users.get_reset_password_router()` under `/auth`
- `tests/conftest.py` — `reset_password_limiter._timestamps.clear()` added to the autouse `reset_in_process_rate_limiters` fixture
- `tests/test_password_reset.py` — 14 integration tests across 7 classes (tracer, rate limit x4, indistinguishability, non-blocking dispatch, empty/invalid input, adjacency, eligibility x4)
- `tests/test_email_service.py` — 6 unit tests (success, transport error, non-2xx context, constant message, unconfigured, no-retry)
- `tests/test_users_account_type_invariant.py` — 2 AST-based invariant tests

## Decisions Made

- **`get_reset_password_router()` mount fix.** The installed `fastapi-users==15.0.5`'s `FastAPIUsers.get_reset_password_router` is a zero-argument bound method (`def get_reset_password_router(self) -> APIRouter: return get_reset_password_router(self.get_user_manager)`), not a pass-through requiring `get_user_manager` as an argument the way RESEARCH/PATTERNS assumed by analogy with `get_register_router`. Fixed at the mount call site; documented with a comment citing the verified source.
- **Response body is `null`, not empty.** `POST /api/auth/forgot-password`'s handler returns `None` with no `response_model`; FastAPI's default `JSONResponse` serializes that as the 4-byte literal `null`, not a zero-byte body. All tests assert `content == b"null"` and RESET-02's indistinguishability is proven as a `(status_code, content)` tuple comparison, not a hard-coded status alone.
- **`user.email.lower()` retained as defense-in-depth, not as the enforcing mechanism.** See Deviations #2 below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `get_reset_password_router()` call signature was wrong**
- **Found during:** Task 1
- **Issue:** `app.routers.auth` imported and called `fastapi_users.get_reset_password_router(get_user_manager)`, following RESEARCH/PATTERNS' assumption that the instance method forwards `get_user_manager` positionally (by analogy with `get_register_router`'s two schema-type arguments). The installed library raised `TypeError: FastAPIUsers.get_reset_password_router() takes 1 positional argument but 2 were given` at import time, breaking the entire app.
- **Fix:** Changed the call to `fastapi_users.get_reset_password_router()` (no arguments) — the bound instance method already closes over `self.get_user_manager` internally.
- **Files modified:** `app/routers/auth.py`
- **Committed in:** `e361d3836` (Task 1 commit)

**2. [Rule 1 - Bug] Direct-DB test helpers wrote to the wrong database**
- **Found during:** Task 3, while writing the eligibility fixtures
- **Issue:** `_set_user_active`, `_create_direct_user`, `_oauth_account_exists`, and `_get_hashed_password` all imported `async_session_maker` at the TOP of `tests/test_password_reset.py`. `tests/conftest.py`'s session-scoped `override_get_async_session` fixture patches `app.core.database.async_session_maker` to a per-run-test-database-bound maker, but that patch happens AFTER module-level imports run at collection time — so the module-level import in my test file had already bound the stale, pre-patch object (pointed at whatever `settings.DATABASE_URL` was at app-import time, not the isolated per-run clone). Writes from these helpers were silently landing outside the test database the ASGI client actually queries. This meant Task 2's `test_registered_unregistered_inactive_ratelimited_identical` (Test 11) was NOT actually exercising the inactive-user code path — the `_set_user_active(..., active=False)` write was a no-op against the real test DB, so the test passed for the wrong reason (both the "still active" and "genuinely inactive" code paths return the same 202/`null` tuple, masking the bug).
- **Fix:** Moved every `from app.core.database import async_session_maker` import inside the function body that uses it, matching the existing convention in `tests/seed_fixtures.py:317`. Re-ran the affected test after the fix to confirm it still passes for the RIGHT reason.
- **Files modified:** `tests/test_password_reset.py`
- **Committed in:** `1e0f2af91` (Task 3 commit, though the bug originated in Task 2's test code)

**3. [Rule 1 - Bug, test coverage gap] Test 2 didn't assert on the transport branch's own `set_context` call**
- **Found during:** Task 2's mutation-test proof, running row 6 ("drop `set_context` entirely from the transport branch")
- **Issue:** The plan predicted this mutation makes "Test 2 still passes but Test 3 goes red." Running it showed ALL 6 tests still passed — Test 2 (`test_send_transport_error_returns_false_one_capture`) only asserted `capture_exception` was called once, never checking `set_context`'s call count or payload, so dropping it was invisible to the suite.
- **Fix:** Added a `set_context` mock and assertion (call count + `user_id` payload check) to Test 2, closing the coverage gap.
- **Files modified:** `tests/test_email_service.py`
- **Committed in:** `65643b464`

### Documented Findings (not fixed — plan prediction corrected against measured behavior)

**4. [RESET-08 mutation row 2] "Change the limiter key to the raw submitted casing" does not reproduce a red Test 10 at this call site**
- **Found during:** Task 2's mutation-test proof
- **What I found:** Mutating `reset_password_limiter.is_allowed(user.email.lower())` to `reset_password_limiter.is_allowed(user.email)` left `test_case_equality_shares_one_bucket` (Test 10) green. Traced why: `fastapi_users_db_sqlalchemy.SQLAlchemyUserDatabase.get_by_email` compares `func.lower(email) == func.lower(query)`, so it is ALREADY case-insensitive — the router resolves `user` via this lookup before `on_after_forgot_password` ever runs. `user.email` inside the hook is therefore always the single canonical, DB-stored casing, invariant regardless of what casing was submitted in the request body. There is also no "raw submitted casing" available inside the hook to fall back to — its signature is `(user, token, request)`, never the raw email string; that value was already consumed and normalized upstream. Case-insensitive uniqueness at registration (`create()` also checks `get_by_email` before inserting) means two accounts can never even exist as case-variants of one address.
- **Conclusion:** `.lower()` at this call site is defense-in-depth (protects against a future fastapi-users version or refactor that stops normalizing), not the mechanism actually enforcing case-equality today — that guarantee comes structurally from `get_by_email`'s own case-insensitive lookup. Left the code as the plan specified (`.lower()` present); this is a report on why the specific mutation cell can't go red, not a call to change production code.
- **Impact:** None on shipped behavior — RESET-03/case-equality's truth ("case variants of one address share a single bucket") still holds and is proven by Test 10; the row in the mutation table below documents the finding honestly instead of a fabricated red result.

**5. [RESET-08 mutation row 6] The mutation makes Test 2 go red, not Test 3**
- **Found during:** same run as #3/#4 above
- **What I found:** The plan's row description said dropping the transport branch's `set_context` makes "Test 2 still passes but Test 3 goes red." Test 3 (`test_send_422_returns_false_context_has_status_and_user_id`) exercises the SEPARATE non-2xx branch's own `set_context` call and is structurally unaffected by a change confined to the transport (`httpx.HTTPError`) branch. After closing the coverage gap in #3 above, the correct mutation-red result is: Test 2 goes red (0 == 1 on the newly added `set_context` assertion), Test 3 stays green.
- **Conclusion:** Documented the corrected test id in the mutation table below rather than reproducing the plan's stated (incorrect) target test.

---

**Total deviations:** 3 auto-fixed (all Rule 1 bugs), 2 documented findings (mutation-test predictions corrected against measured behavior, no production code change).
**Impact on plan:** All three auto-fixes were necessary for correctness (one was an app-breaking import-time crash, one was a silently-broken test, one was a coverage gap in a test the plan itself required to be mutation-tested). The two documented findings are honest corrections to the plan's own predictions, not scope creep — no production code changed as a result of either.

## Mutation Table (RESET-08)

One row per production change. Each reverted in isolation from a clean tree, confirmed, then restored.

### Task 2 (6 rows required)

| # | Production change reverted | Test that goes red | Result |
|---|---|---|---|
| 1 | Remove the rate-limiter guard from the hook | `TestForgotPasswordRateLimit::test_boundary_nth_dispatches_n_plus_1th_does_not` (Test 7) | CONFIRMED RED — `MissingGreenlet` inside the hook once the limiter no longer gates the dispatch |
| 2 | Change the limiter key from `user.email.lower()` to `user.email` (raw casing) | *(plan predicted Test 10)* | **NOT REPRODUCIBLE at this call site** — see Deviation #4. `fastapi-users`' `get_by_email()` already normalizes case before the hook runs, so `user.email` is invariant regardless of submitted casing; `test_case_equality_shares_one_bucket` (Test 10) stays green under this mutation. `.lower()` kept as defense-in-depth. |
| 3 | Replace `spawn_password_reset_email(...)` with an awaited `send_password_reset_email(...)` | `TestNonBlockingDispatch::test_202_returned_before_send_completes` (Test 12) | CONFIRMED RED — times out inside `asyncio.wait_for(..., timeout=2.0)` |
| 4 | Interpolate `resp.status_code` into the non-2xx `capture_exception` message | `test_send_non2xx_capture_message_is_constant_across_calls` (Test 4) | CONFIRMED RED — the two captured messages differ (`...status 422` vs `...status 500`) |
| 5 | Drop `user_id` from the non-2xx `set_context` payload | `test_send_422_returns_false_context_has_status_and_user_id` (Test 3) | CONFIRMED RED — `KeyError: 'user_id'` |
| 6 | Drop `set_context` entirely from the transport (`httpx.HTTPError`) branch | *(plan predicted Test 3)* → **actually** `test_send_transport_error_returns_false_one_capture` (Test 2) | CONFIRMED RED (after closing the coverage gap in Deviation #3) — see Deviation #5 for why the plan named the wrong test |

### Task 3 (3 rows required)

| # | Production change reverted | Test that goes red | Result |
|---|---|---|---|
| 7 | Change the eligibility gate to skip accounts that have any `oauth_account` row (naive "skip Google accounts") | `TestPasswordResetEligibility::test_dual_password_and_google_completes_flow` (Test 15) | CONFIRMED RED — **the 125-account regression**, the single most important row in this table |
| 8 | Remove the eligibility gate entirely | `TestPasswordResetEligibility::test_google_only_dispatches_zero_sends_indistinguishable` (Test 17) | CONFIRMED RED — the Google-only account now dispatches a send (`assert 2 == 1`) |
| 9 | Add `if user.is_guest: return` inside the hook (a forbidden account-type reference) | `test_on_after_forgot_password_does_not_derive_account_type` (Test 19, invariant 2) | CONFIRMED RED, naming the exact site — `app/users.py:122 (is_guest)` |

## Assumption-Delta Audit (Task 3)

Re-run against the tree as it stands after Tasks 1-2, per the plan's requirement to paste raw output.

**1. Every occurrence of `hashed_password` in `app/`:**

```
$ grep -rn "hashed_password" app/
app/users.py:120:        if not user.hashed_password:
app/services/guest_service.py:31:    - An empty hashed_password (guest accounts cannot log in with a password)
app/services/guest_service.py:40:        hashed_password="",
app/services/guest_service.py:94:    hashed_password = _password_helper.hash(password)
app/services/guest_service.py:101:            hashed_password=hashed_password,
app/services/guest_service.py:132:    email, and clears hashed_password (Google users authenticate via OAuth only).
app/services/guest_service.py:156:            hashed_password="",  # Google users have no password
```

Classification: `app/users.py:120` is the ONE eligibility gate (comparison/branch — this phase's new read). All `guest_service.py` occurrences are write targets (keyword-argument assignments at guest creation / password promotion / Google promotion) or comments describing those writes — no other reads.

**2. Any derived account-type helper (a name suggesting OAuth-only, Google-only, has-password, or password-set semantics):**

```
$ grep -rniE "(oauth_only|google_only|has_password|password_set)" app/
(no output)
```

None found.

**3. The same family of names in `frontend/src/`, plus any client-side notion of "this account has no password":**

```
$ grep -rniE "(hashed_password|oauth_only|google_only|has_password|password_set|no.password)" frontend/src/
frontend/src/pages/Home.tsx:176:      'Only your games — no passwords or personal information. Your games are publicly accessible via their APIs, and FlawChess reads them just like any other analysis tool.',
```

The one hit is unrelated marketing copy on the homepage (privacy messaging about not needing chess.com/lichess account passwords for import), not a client-side eligibility concept. **Result matches the expected outcome: exactly one new read (the gate) and nothing in the frontend.**

## Interface Handed to Plan 02

**Routes (mounted under `/api/auth` per `app/main.py`'s router prefix):**

- `POST /api/auth/forgot-password` — body `{"email": str}` (Pydantic `EmailStr`, so empty/whitespace/missing all return `422`) → always `202`, body is the literal `null` (4 bytes, `b"null"`), regardless of registered/unregistered/inactive/rate-limited/ineligible.
- `POST /api/auth/reset-password` — body `{"token": str, "password": str}` (missing either key returns `422`) → `200` with the updated user object on success, or `400` with:
  - `detail="RESET_PASSWORD_BAD_TOKEN"` (bad/expired/already-used token, or the invoking user no longer exists/is inactive)
  - `detail={"code": "RESET_PASSWORD_INVALID_PASSWORD", "reason": str}` (password fails the manager's validation, e.g. too short)

**Captured eligible-response tuple** (used by Tests 11 and 17-19 as the ground truth for indistinguishability, rather than a hard-coded status):

```
(202, b"null")
```

Every one of the following forgot-password requests produces this EXACT tuple, with zero HTTP-observable difference: a registered eligible account, an unregistered email, an inactive account, a rate-limited account, AND an ineligible (empty-hash / Google-only / guest) account. **State explicitly for Plan 02:** the frontend cannot and must not attempt to distinguish "your account can't be reset this way" from "check your email" — there is no server signal to build that copy on. Plan 02's success-state copy must be the single generic message ("If that address is registered, you'll receive a reset link") for all five cases, matching RESEARCH's own recommendation.

## Issues Encountered

Both resolved inline — see Deviations above (#2, the stale `async_session_maker` import; #3/#5, the mutation-table test-id corrections).

## User Setup Required

None — no external service configuration required. `RESEND_API_KEY`/`MAIL_FROM` default to unconfigured (`is_email_configured()` returns `False`); every dev/test/CI run works with zero setup, matching the `VAPID_*` precedent. Real Resend account provisioning is Plan 03's HUMAN-UAT-gated concern.

## Next Phase Readiness

Plan 02 (frontend forms) can build directly against the interface documented above — exact routes, request bodies, success/error statuses, and the two error `detail` shapes are all proven by a passing, mutation-tested backend suite. The eligible-response tuple `(202, b"null")` gives Plan 02's success-state copy a verified ground truth rather than a guess. No blockers.

---
*Phase: 207-self-serve-password-reset*
*Completed: 2026-08-08*

## Self-Check: PASSED

All 9 referenced files (4 production, 5 test) found on disk; all 5 referenced commit hashes (`e361d3836`, `b4c64d205`, `65643b464`, `1e0f2af91`, `9623464eb`) found in `git log --oneline --all`.
