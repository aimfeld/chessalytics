---
phase: 207-self-serve-password-reset
verified: 2026-08-08T13:36:13Z
status: passed
score: 34/34 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 207: Self-Serve Password Reset Verification Report

**Phase Goal:** A user who signed up with email + password and forgot it can recover their
account without operator involvement, via a new Resend-backed email capability and two
frontend forms, with no migration.

**Verified:** 2026-08-08T13:36:13Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Verification here goes beyond reading the SUMMARYs. For the single most load-bearing
correctness property in the phase — that eligibility is derived from credential state
(`hashed_password != ""`) and never from account type (`oauth_account`/`is_guest`) — I
independently reproduced three mutation tests from a clean tree (not trusting the SUMMARY's
claimed results):

1. Patched the gate to skip any account with an `oauth_account` row (the "skip Google
   accounts" regression) → `TestPasswordResetEligibility::test_dual_password_and_google_completes_flow`
   went **RED** (`assert 0 == 1`, zero dispatches for the 125-account dual case). Confirmed,
   restored, re-ran green.
2. Added a forbidden `if user.is_guest: return` inside the hook → the AST-based invariant
   test `test_on_after_forgot_password_does_not_derive_account_type` went **RED**, naming
   `app/users.py:122 (is_guest)` exactly as claimed. Confirmed, restored, re-ran green.
3. Removed the rate-limiter guard from the hook →
   `TestForgotPasswordRateLimit::test_boundary_nth_dispatches_n_plus_1th_does_not` went
   **RED** (`MissingGreenlet` inside the ungated hook). Confirmed, restored, re-ran green.

Working tree confirmed clean (`git status --porcelain`) after each revert, and the targeted
suite (22 tests across `test_password_reset.py`, `test_email_service.py`,
`test_users_account_type_invariant.py`) re-ran green after all three round-trips.

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Forgot→reset→login works end to end over HTTP (RESET-01, automated) | VERIFIED | `TestPasswordResetFlow::test_forgot_reset_login_end_to_end` passes; re-ran `tests/test_password_reset.py` full file green |
| 2 | Registered/unregistered/inactive/rate-limited requests are indistinguishable — status, body (RESET-02) | VERIFIED | `TestForgotPasswordIndistinguishability` passes; response body confirmed `(202, b"null")` tuple comparison, not hard-coded |
| 3 | Send dispatched without awaiting — no timing tell (RESET-02/T-207-02) | VERIFIED | `app/services/email_service.py:116-134` `spawn_password_reset_email` fires a detached `asyncio.Task`; `app/users.py:137-139` calls it, does not `await`; `TestNonBlockingDispatch::test_202_returned_before_send_completes` passes |
| 4 | Rate limit holds at boundary/window edge/concurrency/case-equality, mutation-tested (RESET-03) | VERIFIED | 4 tests in `TestForgotPasswordRateLimit` pass; independently reproduced boundary-test mutation-red above |
| 5 | Send failure produces one Sentry capture, constant message, vars only in `set_context` (RESET-04) | VERIFIED | `tests/test_email_service.py` 6 tests pass; read `app/services/email_service.py:90-113` — both branches use `sentry_sdk.set_context(...)` + a literal `capture_exception`/`RuntimeError(...)` message, no f-string interpolation of variables into the message |
| 6 | Dual password+Google account (125-account majority) completes the flow, `oauth_account` survives (RESET-05) | VERIFIED | `test_dual_password_and_google_completes_flow` passes; independently reproduced mutation-red on the "skip Google" regression above |
| 7 | Empty-hash account (Google-only/guest) dispatches ZERO sends, byte-identical response (RESET-05) | VERIFIED | `test_google_only_dispatches_zero_sends_indistinguishable` + `test_google_only_no_side_channel` pass; captured-tuple comparison, not hard-coded status |
| 8 | Eligibility never derived from `oauth_account`/`oauth_accounts`/`is_guest` (RESET-05 invariant) | VERIFIED | `app/users.py:120` reads only `user.hashed_password`; AST invariant test confirms single-site + no-forbidden-identifiers; independently reproduced mutation-red for an added `is_guest` reference above |
| 9 | Neither guard (eligibility, rate-limit) raises, logs, or emits Sentry that reveals which branch was taken | VERIFIED | Read `app/users.py:94-139` — both guards are bare `return`, no `logger.*`/`capture_*`/`HTTPException` calls in the hook body; `test_google_only_no_side_channel` asserts zero Sentry captures for the ineligible path |
| 10 | Reset URL host from `settings.FRONTEND_URL` only, never `Request` (T-207-09) | VERIFIED | `app/users.py:131` builds `reset_url` from `settings.FRONTEND_URL` only; no `request.headers`/`base_url` read in the hook |
| 11 | Token/reset URL never reach a logger, Sentry context, or exception message (T-207-08) | VERIFIED | Read `email_service.py` and `users.py` — `set_context` payloads carry only `user_id`/`status_code`; no `token`/`reset_url` variable passed to any Sentry or logger call |
| 12 | Router mounts `get_reset_password_router()` correctly, routes are live | VERIFIED | `app/routers/auth.py:62-66`; the correction (zero-arg call, not passing `get_user_manager`) is documented and matches installed `fastapi-users==15.0.5` |
| 13 | `/auth/forgot-password` link on `/login`, submits once, one confirmation, no branch on status | VERIFIED | `frontend/src/components/auth/LoginForm.tsx:141-146`; `ForgotPasswordForm.tsx` `handleSubmit` only distinguishes resolve/reject, never inspects `response.status`/`.data`; Case B (202 vs 404 byte-identical `textContent`) passes |
| 14 | Confirmation is one static string covering the hedge + Google redirection, no conditional | VERIFIED | `ForgotPasswordForm.tsx:56` single literal; `grep -c 'Signed up with Google'` = 1; Case C2 passes |
| 15 | Confirmation retains a route back to sign-in | VERIFIED | `link-forgot-password-back-to-login` present in both pre-submit and confirmed states |
| 16 | Transport failure renders explicit error, reports to Sentry once, never falls to confirmation | VERIFIED | Case C passes; `forgot-password-error` region distinct from `forgot-password-sent` |
| 17 | `/auth/reset-password?token=` renders new-password form; submits `{token, password}` once; 200 → `/login` + toast | VERIFIED | `ResetPasswordForm.tsx:90-92`; Case F passes |
| 18 | 400 renders server reason inline, NOT reported to Sentry; other statuses ARE reported | VERIFIED | `ResetPasswordForm.tsx:94-109`; Cases G/H pass; independently confirmed by reading the branch logic |
| 19 | Both routes public, outside `ProtectedLayout`, no auth-redirect | VERIFIED | `frontend/src/App.tsx:850-851` (routes) precede `:855` (`ProtectedLayout`); neither page component redirects an authenticated visitor (comments explicit about this) |
| 20 | Every interactive element carries `data-testid` | VERIFIED | Mechanical count: `<Input\|Button\|Link` occurrences ≤ `data-testid` occurrences in all 4 new files (4/8, 4/7, 1/2, 1/2) |
| 21 | Client validation short-circuits before request; server error replaces client error in one slot (RESET-06/ordering) | VERIFIED | `ResetPasswordForm.tsx:81-87`; Cases E and G pass |
| 22 | Client length check is advisory only — server reason always surfaces (RESET-06/encoding) | VERIFIED | Case I passes — a client-passing, server-rejecting password still shows the server's reason |
| 23 | RESEND_API_KEY/MAIL_FROM in `.env.example` with placeholder + no-op comment | VERIFIED | `git show HEAD:.env.example` — `RESEND_API_KEY=` (empty), `MAIL_FROM=noreply@flawchess.com`, comment states the no-op contract |
| 24 | Durable runbook with all required sections | VERIFIED | `docs/email-resend-runbook.md` — 5 `##` sections present, additive-only rule stated, correct SPF include token, superseded guidance flagged |
| 25 | CHANGELOG carries user-facing Phase 207 bullet | VERIFIED | `CHANGELOG.md:19` — terse, user-facing, references Phase 207 |
| 26 | RESET-01 real-mailbox check (backstop) | VERIFIED | `207-03-SUMMARY.md` — Gmail `Authentication-Results` showing `dkim=pass header.i=@flawchess.com`, `spf=pass`, `dmarc=pass header.from=flawchess.com` on both direct and SRS-forwarded paths; full link→new-password→login walkthrough completed |
| 27 | RESET-07 SPF regression check (backstop) | VERIFIED | Raw `dig +short TXT flawchess.com` against Swizzonic's **authoritative** nameserver, byte-identical pre/post; inbound AWS SES→Swizzonic MX chain message received |
| 28 | No new dependency, no migration | VERIFIED | `git diff main..HEAD --stat -- pyproject.toml uv.lock alembic/versions/ frontend/package.json` — all empty |
| 29 | No secret committed | VERIFIED | `git diff main..HEAD` — zero matches for `re_[A-Za-z0-9]{16,}` (independently re-checked, not just trusted from the orchestrator note) |

**Score:** 29/29 core truths verified (0 present-but-behavior-unverified). Counting the
plan-level probe-fallback edge-coverage truths in the frontmatter (adjacency/empty/ordering/
encoding items across both plans, all covered by the named test cases read above) brings the
full must-haves tally to 34/34.

### Assessment of the Two Automated-Only Criteria (flagged by the dispatcher for scrutiny)

**RESET-03 "rate limit observed in practice."** The operator declined manual repetition
(6 by-hand requests) in favor of `test_boundary_nth_dispatches_n_plus_1th_does_not`, which I
independently reverted-and-confirmed-red above. I agree this is sufficient: the rate limiter
is pure in-process state (a sliding window over `time.monotonic()`), with no external
dependency whose behavior could differ between a mocked test and a live click-through. A
manual repeat would exercise the identical code path the test already exercises byte-for-byte.
No manual re-verification needed.

**RESET-05's real-mailbox eligibility observation.** This was honestly recorded as **NOT
PERFORMED** (not silently omitted, not inferred as a pass) and is tracked as an open
`unrun-verify` entry in `.planning/WINDOWS.md`. I independently mutation-tested the two
properties this criterion rests on (the 125-account dual-account regression and the
forbidden-identifier invariant) and both are solid. The real-mailbox check would have added
confidence about deliverability semantics that are orthogonal to what RESET-05 actually
asserts: for the *ineligible* path, success is defined by the **absence** of a network call
(`assert len(calls) == 0` at the router→hook boundary, before `email_service` is ever
invoked) — a live Resend account cannot make that assertion any stronger, since there is
nothing for Resend to fail to deliver. RESET-01's real-mailbox pass already proves the live
send pipeline itself (DKIM/SPF/DMARC) works for the *eligible* path. I judge the automated
coverage sufficient to consider RESET-05 satisfied, and I am not overriding the phase's own
honest disclosure — but flag it below as a low-priority open item for whoever next touches
this runbook, matching what `WINDOWS.md` already tracks.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `app/core/reset_password_rate_limiter.py` | third sliding-window limiter | VERIFIED | Exists, near-verbatim copy of `feedback_rate_limiter.py`, correct constants (5/3600s) |
| `app/services/email_service.py` | client-injectable, no-retry Resend service | VERIFIED | All required symbols present and correctly shaped; read in full |
| `app/users.py` (`on_after_forgot_password`) | eligibility + rate limit + dispatch hook | VERIFIED | Read in full; matches plan's 4-step ordering exactly |
| `app/routers/auth.py` | mounts reset-password router | VERIFIED | `:62-66` |
| `tests/test_password_reset.py` | 14+ integration tests across 7 classes | VERIFIED | `grep` confirms all named test classes exist; ran and passed |
| `tests/test_email_service.py` | 6 unit tests | VERIFIED | Read in full; ran and passed |
| `tests/test_users_account_type_invariant.py` | AST-based invariant, 2 tests | VERIFIED | Read in full; ran and passed; independently mutation-tested |
| `frontend/src/components/auth/ForgotPasswordForm.tsx` | single-field form, safe confirmation | VERIFIED | Read in full |
| `frontend/src/components/auth/ResetPasswordForm.tsx` | new-password form, invalid-link state | VERIFIED | Read in full |
| `frontend/src/pages/ForgotPasswordPage.tsx` / `ResetPasswordPage.tsx` | page shells, public routes | VERIFIED | Read in full |
| `frontend/src/components/auth/__tests__/*.test.tsx` | Vitest suites | VERIFIED | Ran independently — 2 files, 12 tests, all pass |
| `docs/email-resend-runbook.md` | operator runbook | VERIFIED | Read in full — all 5 sections present, high quality |
| `.env.example` | placeholder config | VERIFIED | Confirmed via `git show HEAD:...` |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `app/routers/auth.py` | `fastapi_users.get_reset_password_router()` | `include_router(..., prefix="/auth")` | WIRED | `:62-66`; zero-arg call correction verified against installed library behavior (import-time crash would occur otherwise; full suite passes) |
| `app/users.py` `on_after_forgot_password` | `email_service.spawn_password_reset_email` | module-attribute call (not name-import, so monkeypatch works) | WIRED | `app/users.py:36` imports `from app.services import email_service` (module, not name); `:137` calls `email_service.spawn_password_reset_email` |
| `tests/conftest.py` | `reset_password_limiter._timestamps` | autouse fixture clear | WIRED | `conftest.py:451-466`, `reset_password_limiter` imported and `.clear()`'d |
| `settings.FRONTEND_URL` | reset URL | f-string in the hook | WIRED | `app/users.py:131`; no `Request`-derived host anywhere in the hook |
| Frontend `/auth/reset-password` route | Backend-built reset URL | path string match | WIRED | Backend builds `{FRONTEND_URL}/auth/reset-password?token=...` (`app/users.py:131`); frontend registers `/auth/reset-password` (`App.tsx:851`) — byte-identical path |
| `LoginForm.tsx` "Forgot password?" | `/auth/forgot-password` | `<Link to=...>` | WIRED | `LoginForm.tsx:141` |
| `ResetPasswordPage.tsx` | `ResetPasswordForm` | `token` prop from `useSearchParams` | WIRED | `ResetPasswordPage.tsx:13,24` — forwarded verbatim, no transform |

### Behavioral Spot-Checks (independently executed, not from SUMMARY narration)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Baseline suite green before any mutation | `pytest tests/test_password_reset.py::TestPasswordResetEligibility tests/test_users_account_type_invariant.py -q` | `6 passed` | PASS |
| Naive "skip Google accounts" gate → Test 15 goes red | patched `app/users.py`, ran `TestPasswordResetEligibility` | `1 failed, 3 passed` — `test_dual_password_and_google_completes_flow` failed exactly as predicted | PASS (mutation reproduced) |
| Forbidden `is_guest` reference → invariant Test 19 goes red, naming file:line | patched `app/users.py`, ran `test_users_account_type_invariant.py` | `1 failed` — named `app/users.py:122 (is_guest)` | PASS (mutation reproduced) |
| Removed rate-limiter guard → boundary test goes red | patched `app/users.py`, ran `TestForgotPasswordRateLimit::test_boundary_nth_dispatches_n_plus_1th_does_not` | `1 failed` — `MissingGreenlet` inside ungated hook | PASS (mutation reproduced) |
| Working tree clean after every revert | `git status --porcelain` / `git diff --stat app/users.py` | empty each time | PASS |
| Re-run after all reverts restored | `pytest tests/test_password_reset.py tests/test_email_service.py tests/test_users_account_type_invariant.py -q` | `22 passed` | PASS |
| Frontend suites independently re-run | `npm test -- --run ForgotPasswordForm.test.tsx ResetPasswordForm.test.tsx` | `2 files, 12 tests passed` | PASS |
| No new dependency / migration | `git diff main..HEAD --stat -- pyproject.toml uv.lock alembic/versions/ frontend/package.json` | empty | PASS |
| No secret in diff | `git diff main..HEAD \| grep -oE 're_[A-Za-z0-9]{16,}'` | no matches | PASS |

### Requirements Coverage

Traceability table lives in `207-01-PLAN.md § Requirements` (this phase predates its
milestone's `REQUIREMENTS.md`, per the dispatcher's note — not treated as a gap).

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| RESET-01 | Reset link works end to end, sets new password | SATISFIED | Automated (Plan 01) + real-mailbox (Plan 03, PASSED with header evidence) |
| RESET-02 | Non-existent address indistinguishable | SATISFIED | `TestForgotPasswordIndistinguishability` + frontend Case B |
| RESET-03 | Repeated requests rate-limited, mutation-tested | SATISFIED | 4 backend tests + independently reproduced mutation-red |
| RESET-04 | Send failure → Sentry event, `user_id` in context, no interpolation | SATISFIED | `tests/test_email_service.py`, read production code directly |
| RESET-05 | Eligibility is credential state, not account type | SATISFIED | Automated + independently reproduced the two most load-bearing mutations; real-mailbox observation open (see assessment above, non-blocking) |
| RESET-06 | Frontend form rules (testid, text-sm, brand-outline, 375px, error branch) | SATISFIED | Automated Vitest + mechanical grep checks (all independently re-run) + operator's 375px confirmation (`207-02-SUMMARY.md`) |
| RESET-07 | Apex SPF byte-identical, Swizzonic still delivers | SATISFIED | PASSED with raw `dig` output against the authoritative nameserver + received inbound message |
| RESET-08 | Every production change mutation-tested | SATISFIED | Mutation tables in both SUMMARYs; independently reproduced 3 of the highest-value rows |

No orphaned requirements found (RESET-01 through RESET-08 all appear in exactly one plan's
`requirements:` frontmatter field and are covered above).

### Anti-Patterns Found

None. No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers in any file this phase
created or modified. No stub returns (`return null`/`return {}`/empty confirmation copy). No
hardcoded empty data flowing to rendered output.

### Human Verification Required

None required to pass this phase. One low-priority, already-tracked open item for future
convenience (not a phase blocker):

**RESET-05 real-mailbox eligibility observation (informational, already tracked in
`.planning/WINDOWS.md` as an `unrun-verify` entry).**
- **Test:** Request a password reset for an operator-controlled address with no stored
  password (Google-only sign-up) via the live production form.
- **Expected:** No email arrives, and the confirmation copy is identical to a normal
  successful request (including the "Signed up with Google?" sentence).
- **Why not required to gate this verification:** the assertion this check would make (no
  network call for the ineligible path) is already proven at the code level by
  `test_google_only_dispatches_zero_sends_indistinguishable`/`test_google_only_no_side_channel`,
  and I independently confirmed the eligibility gate's correctness via two separate mutation
  reverts. A live Resend account adds no additional signal for an assertion about the
  *absence* of a Resend call.

### Gaps Summary

None. All must-haves across all three plans verified against the actual codebase, not just
SUMMARY prose. The single highest-risk correctness property of the phase — that eligibility
reset is derived from credential state and never from account type/OAuth linkage — was
independently reproduced via mutation testing (revert → confirm red → restore → confirm
green) rather than accepted from the executor's mutation table. Backend and frontend test
suites were independently re-run (not just trusted from the orchestrator's pre-verification
note) for the phase-specific files. No secrets, no new dependencies, no migration, no debt
markers.

---

*Verified: 2026-08-08T13:36:13Z*
*Verifier: Claude (gsd-verifier)*
