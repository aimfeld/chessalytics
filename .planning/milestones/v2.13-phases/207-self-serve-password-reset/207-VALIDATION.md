---
phase: 207
slug: self-serve-password-reset
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-08
---

# Phase 207 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 8.x (backend, `-n auto` via pytest-xdist) + vitest (frontend) |
| **Config file** | `pyproject.toml` (backend), `frontend/vitest.config.ts` (frontend) |
| **Quick run command** | `uv run pytest tests/test_password_reset.py -q` |
| **Full suite command** | `uv run pytest -n auto -x` then `( cd frontend && npm run lint && npm test -- --run )` |
| **Estimated runtime** | ~5 s quick · full backend suite is the project's standard pre-merge gate |

---

## Sampling Rate

- **After every task commit:** Run the quick command above
- **After every plan wave:** Run the full suite command
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds (quick), full suite at wave boundaries

---

## Per-Task Verification Map

*Seeded at plan time — the planner fills one row per task once PLAN.md files exist.*

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 207-01-01 | 01 | 1 | RESET-01, RESET-02 | T-207-01 / T-207-08 / T-207-09 | Routes mounted; reset URL built only from `FRONTEND_URL`; token never reaches a log or Sentry | integration (tracer) | `uv run pytest tests/test_password_reset.py -x -q` | ❌ W0 | ⬜ pending |
| 207-01-02 | 01 | 1 | RESET-03, RESET-04, RESET-08 | T-207-02 / T-207-04 / T-207-10 | Per-email limit silently no-ops (never 429); send dispatched without awaiting (no timing tell); Sentry message a constant, variables via `set_context`; API key in exactly two files | integration + unit | `uv run pytest tests/test_email_service.py tests/test_password_reset.py -x -q` | ❌ W0 | ⬜ pending |
| 207-01-03 | 01 | 1 | RESET-05, RESET-08 | T-207-24 / T-207-25 | Password+Google (125 prod accounts) completes the flow; empty-hash account gets zero sends with a byte-identical response; eligibility never derived from `oauth_account`/`is_guest` | integration + invariant | `uv run pytest tests/test_password_reset.py tests/test_users_account_type_invariant.py -x -q` | ❌ W0 | ⬜ pending |
| 207-02-01 | 02 | 2 | RESET-02, RESET-05, RESET-06, RESET-08 | T-207-14 | One confirmation rendering, provably identical for 202 and 404, carrying the static "Signed up with Google?" sentence that closes the no-password dead end | frontend (vitest) | `cd frontend && npm test -- --run src/components/auth/__tests__/ForgotPasswordForm.test.tsx` | ❌ W0 | ⬜ pending |
| 207-02-02 | 02 | 2 | RESET-06, RESET-08 | T-207-16 / T-207-17 | Client validation short-circuits; 400 rendered inline and not sent to Sentry; token never persisted | frontend (vitest) | `cd frontend && npm test -- --run src/components/auth/__tests__/ResetPasswordForm.test.tsx` | ❌ W0 | ⬜ pending |
| 207-02-03 | 02 | 2 | RESET-06 | — | 375px layout, no overflow, all controls reachable | HUMAN-UAT (checkpoint) | N/A — manual, jsdom has no layout | N/A | ⬜ pending |
| 207-03-01 | 03 | 3 | — | T-207-19 | No live key committed; runbook carries the correct include token and the additive-only rule | doc/config gate | `test -f docs/email-resend-runbook.md && grep -q RESEND_API_KEY .env.example` | ✅ | ✅ green |
| 207-03-02 | 03 | 3 | RESET-01, RESET-05, RESET-07 | T-207-20 / T-207-21 / T-207-22 | Apex SPF byte-identical, Swizzonic still delivers; real mail arrives with `dkim=pass`/`dmarc=pass`; a no-password account receives nothing with identical copy | HUMAN-UAT (Step-0 gated) | N/A — see Manual-Only Verifications | N/A | ✅ green* |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
**\* row 207-03-02:** RESET-01 and RESET-07 PASSED with full evidence (Step 0 completed
2026-08-08). RESET-05's real-mailbox observation specifically was NOT PERFORMED — automated
coverage (`TestPasswordResetEligibility`) stands in its place; see the Manual-Only
Verifications table and `207-03-SUMMARY.md`.

---

## Wave 0 Requirements

- [ ] `tests/test_password_reset.py` — new test module; stubs for RESET-02, RESET-03, RESET-04, RESET-05
- [ ] `tests/conftest.py` — **register the new forgot-password rate limiter in the existing autouse reset fixture** (`tests/conftest.py:446-463`). The two existing `_SlidingWindowRateLimiter` instances are process-lifetime singletons and are cleared there specifically because they otherwise leak across tests and flake serial CI. A third limiter that skips this fixture reproduces a previously-hit bug class in this exact repo.
- [ ] Resend HTTP client stub/fixture — the email service takes an injected `httpx.AsyncClient` (the `app/services/push_send.py` idiom), so no global patching is needed.

---

## Manual-Only Verifications

**Step 0 (Resend account + DNS) was completed by the operator on 2026-08-08 during the
Plan 03 Task 2 checkpoint. Verdicts below are recorded from that live session; see
`207-03-SUMMARY.md` for full evidence (raw `dig` output, `Authentication-Results` headers).**

| Behavior | Requirement | Why Manual | Verdict | Evidence |
|----------|-------------|------------|---------|----------|
| A real reset email arrives and its link sets a new password end-to-end | RESET-01 | Requires a live Resend account, published DNS, and a real mailbox. No automated proxy exists — a mocked send proves the call shape, not deliverability. | **PASSED** | Sent via `email_service.send_password_reset_email()`, arrived INBOX at support@flawchess.com. Gmail `Authentication-Results` on the direct path: `dkim=pass header.i=@flawchess.com header.s=resend`, `spf=pass ... smtp.mailfrom=...@send.flawchess.com`, `dmarc=pass (p=NONE) header.from=flawchess.com`. Also confirmed on a Sieve-forwarded (SRS-rewritten) path: `dkim=pass`, `spf=pass` (evaluated against the untouched apex SPF via `include:spf.webapps.net`), `dmarc=pass`. Full forgot→email→link→new password→login flow completed end-to-end (see 207-02-SUMMARY.md for the Tailscale-tunneled walkthrough). See 207-03-SUMMARY.md §RESET-01. |
| Apex SPF record unchanged and Swizzonic mail still delivers | RESET-07 | DNS state is outside the repo; the check is that an *unrelated* mail path still works. | **PASSED** | `dig +short TXT flawchess.com` on Swizzonic's authoritative NS (dns1.swizzonic.ch) post-change: `"v=spf1 a mx include:spf.webapps.net ~all"` — byte-identical to pre-change baseline, never edited. `dig +short MX flawchess.com` → `10 mx.swizzonic.email.`, unchanged. Inbound delivery confirmed: a message from AWS SES arrived at support@flawchess.com through Swizzonic's own MX chain. See 207-03-SUMMARY.md §RESET-07. |
| A no-password (Google-only) account produces zero sends with identical confirmation copy, observed against a real mailbox | RESET-05 | Requires an operator-controlled Google-only account and a live send attempt to distinguish "gated silently" from "sent but undelivered". | **NOT PERFORMED** | Automated coverage stands (`TestPasswordResetEligibility`, including `test_google_only_dispatches_zero_sends_indistinguishable` and `test_google_only_no_side_channel`), but the real-mailbox observation itself was not made. See 207-03-SUMMARY.md §Eligibility. Logged to WINDOWS.md. |
| Rate limit observably stops mail after the configured maximum while the form still shows the same confirmation | RESET-03 (in-practice) | Manual repetition (6 requests) judged redundant by the operator given mutation-tested automated coverage. | **NOT MANUALLY RE-TESTED (by design)** | Covered by `test_boundary_nth_dispatches_n_plus_1th_does_not` (mutation-tested per RESET-08). Operator declined the manual repeat as redundant. See 207-03-SUMMARY.md §Rate limit. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
