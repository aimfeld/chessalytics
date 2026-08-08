---
phase: 207-self-serve-password-reset
plan: 02
subsystem: auth
tags: [react, vitest, react-router, sentry, axios, password-reset]

requires:
  - phase: 207-01
    provides: "Exact HTTP contract (routes, bodies, statuses, error codes) for /auth/forgot-password and /auth/reset-password"
provides:
  - "ForgotPasswordForm + ForgotPasswordPage at /auth/forgot-password (public route)"
  - "ResetPasswordForm + ResetPasswordPage at /auth/reset-password?token= (public route)"
  - "'Forgot password?' entry link on LoginForm"
  - "Vitest suites for both forms, each behavior pinned by a named case that goes red on revert (RESET-08)"
affects: [207-03-real-mailbox-uat]

actuals:
  tokens: 6799
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Anti-enumeration by construction: ForgotPasswordForm's handleSubmit distinguishes only 'resolved' vs 'rejected at transport level', never response.status/data, so no branch could leak account existence"
    - "Single error-slot ordering: ResetPasswordForm holds one `error` state that client validation and server response both write into, never stack, matching RESET-06/ordering"
    - "Token passed as a prop (ResetPasswordForm) not read internally, keeping the component testable without a router while the page owns useSearchParams"

key-files:
  created:
    - frontend/src/components/auth/ForgotPasswordForm.tsx
    - frontend/src/components/auth/ResetPasswordForm.tsx
    - frontend/src/pages/ForgotPasswordPage.tsx
    - frontend/src/pages/ResetPasswordPage.tsx
    - frontend/src/components/auth/__tests__/ForgotPasswordForm.test.tsx
    - frontend/src/components/auth/__tests__/ResetPasswordForm.test.tsx
  modified:
    - frontend/src/components/auth/LoginForm.tsx
    - frontend/src/App.tsx

key-decisions:
  - "Confirmation copy is one static string covering both the anti-enumeration hedge and the Google-only dead end ('If an account exists for that address, we've sent a reset link. Signed up with Google? Use the Sign in with Google button instead.'), per the operator's 2026-08-08 decision recorded in the plan — pinned by Case B's textContent equality assertion across a 202 and a 404 run."
  - "Client-side password length/equality checks are advisory only; the server's 400 `reason` string is always what's rendered, so a client-accepted/server-rejected value never produces a silent no-op (RESET-06/encoding)."
  - "Neither page copies Auth.tsx's authenticated-visitor redirect — a user may legitimately be resetting from a second device while signed in on another."

requirements-completed: [RESET-02, RESET-05, RESET-06, RESET-08]

coverage:
  - id: D1
    description: "Forgot-password form submits once, renders one confirmation, and that confirmation is provably identical for a 202 and a 404 response"
    requirement: "RESET-02"
    verification:
      - kind: unit
        ref: "frontend/src/components/auth/__tests__/ForgotPasswordForm.test.tsx#Case A: submitting issues exactly one POST"
        status: pass
      - kind: unit
        ref: "frontend/src/components/auth/__tests__/ForgotPasswordForm.test.tsx#Case B: a mocked 202 and a mocked 404 render byte-identical confirmation text"
        status: pass
    human_judgment: false
  - id: D2
    description: "Confirmation string carries both the anti-enumeration hedge and the Google-account redirection, with no status-dependent branch producing an alternative"
    requirement: "RESET-05"
    verification:
      - kind: unit
        ref: "frontend/src/components/auth/__tests__/ForgotPasswordForm.test.tsx#Case C2: the confirmation contains both the hedge and the Google redirection sentence"
        status: pass
    human_judgment: false
  - id: D3
    description: "Transport failure on forgot-password renders an explicit error affordance (never the confirmation) and reports to Sentry once"
    requirement: "RESET-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/auth/__tests__/ForgotPasswordForm.test.tsx#Case C: a rejected request renders the error affordance"
        status: pass
    human_judgment: false
  - id: D4
    description: "Reset-password form: missing/empty token renders invalid-link state with zero requests; mismatched passwords block submission client-side; equal passwords submit exactly once"
    requirement: "RESET-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/auth/__tests__/ResetPasswordForm.test.tsx#Case D / Case E"
        status: pass
    human_judgment: false
  - id: D5
    description: "Success navigates to /login with a toast; a 400 renders the server reason inline without reporting to Sentry; any other status reports to Sentry; client-passing/server-rejecting passwords still surface the server reason"
    requirement: "RESET-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/auth/__tests__/ResetPasswordForm.test.tsx#Case F / Case G / Case H / Case I"
        status: pass
    human_judgment: false
  - id: D6
    description: "Every frontend production behavior in this plan is mutation-tested (revert -> named Vitest case goes red)"
    requirement: "RESET-08"
    verification: []
    human_judgment: true
    rationale: "The mutation table below is a manual revert-and-confirm log performed during execution (Tasks 1-2) and independently proved by the checkpoint operator for all 4 rows before approving Task 3 — a human signature on the table's honesty is the appropriate verification, matching 207-01-SUMMARY.md's D6 precedent."
  - id: D7
    description: "Both pages render correctly at the 375px mobile floor (no overflow, all controls reachable/tappable)"
    requirement: "RESET-06"
    verification: []
    human_judgment: true
    rationale: "jsdom has no layout engine; this is the one behavior in the plan with no automated backstop and was verified live by the operator at the Task 3 checkpoint."
  - id: D8
    description: "Real end-to-end flow (forgot-password -> real mailbox -> reset link -> new password -> login) against a live Resend account and a Tailscale-tunneled dev stack"
    requirement: "RESET-01, RESET-05 (observed evidence only — formal verdict is Plan 03's Task 2)"
    verification: []
    human_judgment: true
    rationale: "This exceeds Plan 02's scope (which anticipated a mocked send) and formally belongs to Plan 03's real-mailbox UAT. Recorded here as observed evidence per the operator's explicit instruction; DKIM/DMARC alignment against the verified flawchess.com apex is still unproven (send went out via Resend's resend.dev sandbox sender), so RESET-01/RESET-07 are NOT marked passed here."

duration: 25min
completed: 2026-08-08
status: complete
---

# Phase 207 Plan 2: Frontend Password Reset Forms Summary

**ForgotPasswordForm and ResetPasswordForm ship the two public routes the backend spine already proved, with a single anti-enumeration-safe confirmation string, advisory-only client validation, and a mutation-tested Vitest suite for each form — verified at 375px and, beyond plan scope, against a real mailbox over a live Resend send.**

## Performance

- **Duration:** ~25 min (Tasks 1-2 execution; Task 3 checkpoint wait time excluded)
- **Started:** 2026-08-08T11:46:10Z (approx, from STATE.md handoff after 207-01)
- **Completed:** 2026-08-08 (checkpoint approved same day)
- **Tasks:** 3 (2 auto + 1 checkpoint:human-verify)
- **Files modified:** 8 (6 created, 2 modified)

## Accomplishments

- `/auth/forgot-password` renders a single email field, POSTs once to the backend's proven contract, and shows one confirmation region that is provably identical whether the address is registered, unregistered, inactive, rate-limited, or ineligible (empty-hash/Google-only) — Case B asserts byte-identical `textContent` across a mocked 202 and a mocked 404 run, which goes red the instant a distinguishing branch is added.
- The confirmation string is the operator's exact 2026-08-08 wording, covering both the RESET-02 anti-enumeration hedge and the RESET-05 Google-account redirection in one literal with no conditional — pinned by Case C2.
- `/auth/reset-password?token=…` renders a two-field new-password form; validation order is load-bearing (client checks short-circuit before any request, a subsequent server error replaces rather than stacks beside a client error, held in one `error` slot) — proven by Cases E and G.
- A missing or empty `token` query param renders an explicit invalid-link state with a "Request a new link" button (brand-outline variant) routing back to forgot-password, issuing zero requests — Case D.
- Expected failures (400 from an expired/used token, or invalid-password reasons) render the server's own message inline and are NOT reported to Sentry, per CLAUDE.md's skip-expected-failures rule; unexpected failures (500, transport errors) ARE reported — Cases G/H/I.
- The "Forgot password?" link is live on `LoginForm`, placed below the submit button, styled like the existing "Create one" link.
- Both routes sit in `App.tsx`'s public block above `ProtectedLayout` and deliberately do not copy `Auth.tsx`'s authenticated-visitor redirect, since a user may be resetting from a second device.
- **Beyond this plan's scope:** the checkpoint operator additionally drove a real end-to-end send through a live Resend account to a real mailbox over a Tailscale tunnel to the dev stack — see "Manual Evidence (operator-verified)" below for full attribution and the explicit RESET-01/RESET-07 scope boundary.

## Task Commits

Each task was committed atomically:

1. **Task 1: ForgotPasswordForm, its page and route, and the LoginForm entry point** - `c33592766` (feat)
2. **Task 2: ResetPasswordForm and the token-bearing /auth/reset-password route** - `763e7b7d2` (feat)
3. **Task 3: 375px and end-to-end walkthrough against the running dev stack** - `checkpoint:human-verify`, APPROVED (no code commit — verification-only task)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `frontend/src/components/auth/ForgotPasswordForm.tsx` — single-field form, anti-enumeration-safe confirmation, transport-error affordance
- `frontend/src/components/auth/ResetPasswordForm.tsx` — new-password + confirm fields, advisory client validation, invalid-link state, single error slot
- `frontend/src/pages/ForgotPasswordPage.tsx` — centered logo shell wrapping `ForgotPasswordForm`
- `frontend/src/pages/ResetPasswordPage.tsx` — centered logo shell reading `?token=` via `useSearchParams`, forwarding it verbatim
- `frontend/src/components/auth/__tests__/ForgotPasswordForm.test.tsx` — Cases A, B, C, C2 (4 tests)
- `frontend/src/components/auth/__tests__/ResetPasswordForm.test.tsx` — Cases D (×2), E (×2), F, G, H, I (8 tests)
- `frontend/src/components/auth/LoginForm.tsx` — added "Forgot password?" link
- `frontend/src/App.tsx` — registered both public routes, added page imports

## Decisions Made

- **Confirmation copy is one static string, not a template.** Both the anti-enumeration hedge and the Google-account redirection live in the same literal; the plan called out that D-04's reversal (an account with no stored password receives no email) means the backend deliberately cannot tell the client which case applied, so the copy has to cover every case rather than branch on one.
- **Token is a prop on `ResetPasswordForm`, not read internally.** The page reads `useSearchParams` and forwards the value verbatim (no trim/re-encode/decode); the component itself stays testable without a router context beyond the `MemoryRouter` wrapper the tests already use for `Link`/`useNavigate`.
- **Client password checks are explicitly advisory.** A code comment at the length check records that JavaScript string length (UTF-16 code units) is not the server's password-policy authority, and the server's `reason` string is always what's shown — Case I proves a client-passing/server-rejecting value still surfaces the server's message rather than a silent no-op.

## Deviations from Plan

None — plan executed exactly as written. No Rule 1-4 auto-fixes were needed; both tasks' acceptance criteria (testid coverage, type floor, button variants, route parity, no hand-rolled colors, no token persistence) passed as specified.

## Manual Evidence (operator-verified at the Task 3 checkpoint)

The Task 3 `checkpoint:human-verify` gate was approved by the operator on 2026-08-08. What follows is recorded as accurately and specifically as the operator's own report, without flattening distinct findings into a single "manual check passed" line.

**1. 375px layout — PASS (RESET-06/boundary, this plan's scope).**
Operator confirmed both `/auth/forgot-password` and `/auth/reset-password` render correctly at the 375px mobile floor: no horizontal overflow, no clipped or overlapping text, every input and button fully visible and tappable, no text smaller than the surrounding body copy. This is the one behavior in this plan with no automated backstop (jsdom has no layout engine) — see coverage item D7.

**2. Real end-to-end send against a REAL MAILBOX — PASS, exceeds this plan's scope.**
The plan anticipated a mocked send for Plan 02 and deferred real-mailbox verification to Plan 03. During this checkpoint the operator additionally completed the first stage of Plan 03's Step 0:
- Created a Resend account (`support@flawchess.com`) and a sending-scoped API key.
- Configured `RESEND_API_KEY`, `MAIL_FROM=onboarding@resend.dev` (Resend's sandbox sender), and `FRONTEND_URL=https://ai-slim.tailb91388.ts.net` (a Tailscale `serve` tunnel, tailnet-only, mapping to the Vite dev server on `127.0.0.1:5173`; Vite proxies `/api` to `:8000` so SPA and API are same-origin).
- A test send through `email_service.send_password_reset_email()` returned `True` (Resend 2xx) and delivered to the real mailbox.
- Registered `support@flawchess.com` in the dev DB, then completed the full flow over the tunnel: forgot-password → email arrived → followed the link → set a new password → the new password logs in and the old one does not.

**Scope note (explicit, per operator instruction):** this item's formal verdict for RESET-01 and RESET-05 (real-mailbox delivery) belongs to **Plan 03's Task 2 checkpoint**, not this plan. It is recorded here as observed evidence only. **RESET-01 and RESET-07 are NOT marked passed by this plan** — the send went out from Resend's `resend.dev` sandbox sender, not from the verified `flawchess.com` apex, so DKIM/DMARC alignment against the real domain is still unproven. Plan 03's Step 0 DNS work (SPF/DKIM/DMARC on `flawchess.com`) remains outstanding.

**3. Rate limit (RESET-03) — NOT manually re-tested, deliberately.**
The operator accepted the automated coverage in place of a manual repeat: `TestForgotPasswordRateLimit::test_boundary_nth_dispatches_n_plus_1th_does_not` (207-01, backend) covers exactly the manual procedure the plan's how-to-verify describes (`_RESET_PASSWORD_MAX_REQUESTS = 5`, so six requests would have been needed by hand), and it is mutation-tested per RESET-08 (see 207-01-SUMMARY.md's mutation table, row 1). This is covered by automated + mutation test; manual repetition was judged redundant, not skipped as a gap.

**4. Anti-enumeration / eligibility copy against three real addresses — NOT fully manually testable in this configuration.**
Resend's sandbox sender (`onboarding@resend.dev`) only delivers to the account's own signup address, so the operator could not send to three distinct real mailboxes (registered-with-password, unregistered, Google-only) to visually compare copy. Automated coverage stands in its place: `TestForgotPasswordIndistinguishability` (207-01, backend) and `TestPasswordResetEligibility`'s four cases (207-01, backend), including `test_google_only_dispatches_zero_sends_indistinguishable` and `test_google_only_no_side_channel`, plus this plan's own Case B (202 vs 404 byte-identical `textContent`) and Case C2 (both copy halves present). Recorded honestly as automated-only for the manual dimension, with the sandbox limitation as the stated reason — not claimed as a manual pass.

## Mutation Table (RESET-08)

Every row was proven live during Tasks 1-2 (revert → confirm the named case goes red → restore → diff identical to baseline before recommitting) and independently re-confirmed by the operator before approving the Task 3 checkpoint.

### Task 1 — ForgotPasswordForm (2 rows required)

| # | Production change reverted | Test that goes red | Result |
|---|---|---|---|
| 1 | Add a status-dependent branch to the success copy (e.g. render different text for a simulated 202 vs 404) | `Case B: a mocked 202 and a mocked 404 render byte-identical confirmation text` | CONFIRMED RED — the two captured `textContent` values differ, exactly the guard Case B exists to catch |
| 2 | Remove the "Signed up with Google?" sentence from the confirmation string | `Case C2: the confirmation contains both the hedge and the Google redirection sentence` | CONFIRMED RED — the `/signed up with google/i` match fails |

### Task 2 — ResetPasswordForm (2 rows required)

| # | Production change reverted | Test that goes red | Result |
|---|---|---|---|
| 3 | Remove the equality check between the two password fields in `validate()` | `Case E: equal passwords issue exactly one request` counterpart — specifically `Case E: passwords differing by one character render a mismatch error and issue zero requests` | CONFIRMED RED — with the equality check gone, the mismatched pair submits and `apiClient.post` is called, failing the zero-requests assertion |
| 4 | Move the `Sentry.captureException` call so it also fires on the 400 branch (not just the unexpected-status branch) | `Case G: a 400 with a reason renders it verbatim, replaces a prior client error, and does not report to Sentry` | CONFIRMED RED — `expect(Sentry.captureException).not.toHaveBeenCalled()` fails once the 400 branch also reports |

All four production changes were restored after confirmation; the working tree at commit time matches the mutation-free baseline. No rows are unreproducible or corrected against a wrong prediction in this plan (unlike 207-01's two documented findings) — all four went red exactly as the plan predicted.

## 375px Evidence

Written confirmation from the Task 3 checkpoint operator (see "Manual Evidence" item 1 above): both `/auth/forgot-password` and `/auth/reset-password?token=…` render with no horizontal overflow, no clipped/overlapping text, all inputs/buttons fully visible and tappable, and no text below the surrounding body copy's size, at a 375px-wide viewport. No screenshot artifact was captured by the executor; the operator's live confirmation is the recorded evidence per this plan's `<output>` requirement (screenshots OR explicit written confirmation).

## Testid Inventory

All 16 values specified in the plan's `<output>` section are present in the shipped components, confirmed by grep against the four new files:

| `data-testid` | File | Element |
|---|---|---|
| `forgot-password-page` | `ForgotPasswordPage.tsx` | page container |
| `forgot-password-form` | `ForgotPasswordForm.tsx` | `FormCard` (both the pre-submit and confirmation renderings reuse this id) |
| `forgot-password-email` | `ForgotPasswordForm.tsx` | email `Input` |
| `btn-forgot-password-submit` | `ForgotPasswordForm.tsx` | submit `Button` |
| `forgot-password-sent` | `ForgotPasswordForm.tsx` | confirmation region `<p>` |
| `forgot-password-error` | `ForgotPasswordForm.tsx` | transport-error region `<p>` |
| `link-forgot-password-back-to-login` | `ForgotPasswordForm.tsx` | "Back to sign in" link (both states) |
| `link-forgot-password` | `LoginForm.tsx` | "Forgot password?" entry link |
| `reset-password-page` | `ResetPasswordPage.tsx` | page container |
| `reset-password-form` | `ResetPasswordForm.tsx` | `FormCard` (form state) |
| `reset-password-new` | `ResetPasswordForm.tsx` | new-password `Input` |
| `reset-password-confirm` | `ResetPasswordForm.tsx` | confirm-password `Input` |
| `btn-reset-password-submit` | `ResetPasswordForm.tsx` | submit `Button` |
| `reset-password-error` | `ResetPasswordForm.tsx` | error region `<p>` |
| `reset-password-invalid-link` | `ResetPasswordForm.tsx` | `FormCard` (invalid-link state) |
| `btn-reset-password-request-new` | `ResetPasswordForm.tsx` | "Request a new link" `Button` |

Two additional testids exist beyond the plan's specified list, both on the logo/home link in each page shell (not part of the plan's required inventory but present for completeness): `forgot-password-logo-home`, `reset-password-logo-home`.

## Issues Encountered

None during Tasks 1-2. At the Task 3 checkpoint, the operator's manual anti-enumeration walkthrough (item 4 above) could not be completed exactly as the plan's how-to-verify described, because the Resend sandbox sender only delivers to the account's own address — this is a constraint of using the sandbox sender rather than a defect; automated coverage substitutes.

## User Setup Required

None for this plan's own scope — no new environment variables were introduced by Tasks 1-2 (frontend-only, no config). Note: an uncommitted `.env.example` change (documenting `RESEND_API_KEY`/`MAIL_FROM` with a pointer to `docs/email-resend-runbook.md`) is present in the working tree, made by the operator during their Step 0 exploration at the checkpoint. `docs/email-resend-runbook.md` does not yet exist. Both belong to **Plan 03's Task 1** (operator handoff: `.env.example` entries + runbook) and were deliberately left uncommitted by this plan's final commit — Plan 03 should pick them up rather than this plan claiming credit for Step 0 work.

## Next Phase Readiness

Plan 03 (operator handoff + real-mailbox UAT) can proceed directly: the operator has already completed the Resend-account and sandbox-sender portion of Step 0 and proven the full flow works end to end over a real send. What remains for Plan 03: the apex-domain DNS work (SPF/DKIM/DMARC alignment on `flawchess.com` itself, not the sandbox sender) needed before RESET-01 and RESET-07 can be formally marked passed, plus committing the `.env.example` documentation and writing `docs/email-resend-runbook.md`. No blockers from this plan.

---
*Phase: 207-self-serve-password-reset*
*Completed: 2026-08-08*

## Self-Check: PASSED

Both referenced commit hashes (`c33592766`, `763e7b7d2`) found in `git log --oneline --all`. All 6 created files and 2 modified files found on disk (confirmed via Read during SUMMARY authoring). Both new Vitest test files re-run green (2 files, 12 tests passed) immediately before writing this SUMMARY.
