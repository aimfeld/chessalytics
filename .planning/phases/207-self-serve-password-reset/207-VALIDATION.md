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
| 207-01-03 | 01 | 1 | RESET-05, RESET-08 | — | Empty-hash account completes the flow with zero special-casing; empty hash is never an account-type predicate | integration + invariant | `uv run pytest tests/test_password_reset.py tests/test_users_account_type_invariant.py -x -q` | ❌ W0 | ⬜ pending |
| 207-02-01 | 02 | 2 | RESET-02, RESET-06, RESET-08 | T-207-14 | One confirmation rendering, provably identical for 202 and 404 | frontend (vitest) | `cd frontend && npm test -- --run src/components/auth/__tests__/ForgotPasswordForm.test.tsx` | ❌ W0 | ⬜ pending |
| 207-02-02 | 02 | 2 | RESET-06, RESET-08 | T-207-16 / T-207-17 | Client validation short-circuits; 400 rendered inline and not sent to Sentry; token never persisted | frontend (vitest) | `cd frontend && npm test -- --run src/components/auth/__tests__/ResetPasswordForm.test.tsx` | ❌ W0 | ⬜ pending |
| 207-02-03 | 02 | 2 | RESET-06 | — | 375px layout, no overflow, all controls reachable | HUMAN-UAT (checkpoint) | N/A — manual, jsdom has no layout | N/A | ⬜ pending |
| 207-03-01 | 03 | 3 | — | T-207-19 | No live key committed; runbook carries the correct include token and the additive-only rule | doc/config gate | `test -f docs/email-resend-runbook.md && grep -q RESEND_API_KEY .env.example` | ❌ | ⬜ pending |
| 207-03-02 | 03 | 3 | RESET-01, RESET-07 | T-207-20 / T-207-21 / T-207-22 | Apex SPF byte-identical, Swizzonic still delivers; real mail arrives with `dkim=pass`/`dmarc=pass` | HUMAN-UAT (Step-0 gated) | N/A — see Manual-Only Verifications | N/A | ⬜ pending (deferrable) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/test_password_reset.py` — new test module; stubs for RESET-02, RESET-03, RESET-04, RESET-05
- [ ] `tests/conftest.py` — **register the new forgot-password rate limiter in the existing autouse reset fixture** (`tests/conftest.py:446-463`). The two existing `_SlidingWindowRateLimiter` instances are process-lifetime singletons and are cleared there specifically because they otherwise leak across tests and flake serial CI. A third limiter that skips this fixture reproduces a previously-hit bug class in this exact repo.
- [ ] Resend HTTP client stub/fixture — the email service takes an injected `httpx.AsyncClient` (the `app/services/push_send.py` idiom), so no global patching is needed.

---

## Manual-Only Verifications

**Both rows below are gated on operator Step 0 (Resend account + DNS), which has NOT been done. Neither is an executor task.**

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A real reset email arrives and its link sets a new password end-to-end | RESET-01 | Requires a live Resend account, published DNS, and a real mailbox. No automated proxy exists — a mocked send proves the call shape, not deliverability. | After Step 0: request a reset for a real address, confirm the mail arrives (check spam), follow the link, set a new password, log in with it. |
| Apex SPF record unchanged and Swizzonic mail still delivers | RESET-07 | DNS state is outside the repo; the check is that an *unrelated* mail path still works. | `dig +short TXT flawchess.com` must still return exactly `v=spf1 a mx include:spf.webapps.net ~all`. Then send a message to a flawchess.com address and confirm receipt. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
