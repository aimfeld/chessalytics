---
phase: 207-self-serve-password-reset
plan: 03
subsystem: auth
tags: [resend, dns, dkim, spf, dmarc, email, password-reset]

requires:
  - phase: 207-01
    provides: "Backend spine (routes, rate limit, email service, eligibility gate) that the operator's Step 0 turns on"
  - phase: 207-02
    provides: "Frontend forms and the real end-to-end flow proven against Resend's sandbox sender at the Plan 02 checkpoint"
provides:
  - ".env.example RESEND_API_KEY/MAIL_FROM placeholders with the unconfigured-is-a-no-op contract"
  - "docs/email-resend-runbook.md — durable Step 0 procedure, key rotation, failure diagnosis, Enable-Sending-not-Receiving warning"
  - "CHANGELOG.md [Unreleased] bullet for self-serve password reset"
  - "RESET-01 and RESET-07 recorded PASSED with live evidence against the verified flawchess.com apex domain (not the sandbox sender)"
  - "RESET-05's real-mailbox observation recorded honestly as NOT PERFORMED, with automated coverage standing in its place"
affects: []

actuals:
  tokens: 4400
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Additive-only DNS change verified byte-for-byte against the authoritative nameserver (not a caching resolver) both before and after publishing, closing T-207-20"

key-files:
  created: []
  modified:
    - .env.example
    - docs/email-resend-runbook.md
    - CHANGELOG.md
    - .planning/phases/207-self-serve-password-reset/207-VALIDATION.md

key-decisions:
  - "DKIM landed at the apex (resend._domainkey.flawchess.com), not scoped under send. — the documented MAIL_FROM=noreply@send.flawchess.com fallback was never needed; MAIL_FROM stays noreply@flawchess.com."
  - "RESET-05's real-mailbox eligibility check (plan step 9) was NOT performed and is recorded honestly as such — not flattened into a manual pass and not silently omitted. Automated coverage (TestPasswordResetEligibility) is what the criterion rests on."
  - "RESET-03's manual repetition (6 requests to trigger the rate limit) was declined by the operator as redundant given mutation-tested automated coverage — recorded as 'covered by automated + mutation test', not as a manual pass or a gap."
  - "Added a runbook warning (beyond the plan's original scope) about Resend's 'Enable Receiving' toggle: it publishes inbound MX records that would collide with the existing Swizzonic MX on the apex, reproducing the T-207-20 failure mode. This project has zero inbound-email handling, so only 'Enable Sending' should ever be checked."

requirements-completed: [RESET-01, RESET-07]

coverage:
  - id: D1
    description: ".env.example carries RESEND_API_KEY/MAIL_FROM placeholders and docs/email-resend-runbook.md documents Step 0, key rotation, and failure diagnosis"
    verification:
      - kind: other
        ref: "test -f docs/email-resend-runbook.md && grep -q RESEND_API_KEY .env.example (Task 1 acceptance criteria, all passed at commit c28403876)"
        status: pass
    human_judgment: false
  - id: D2
    description: "RESET-07 — apex SPF record unchanged, Swizzonic mail still delivers, after the Resend DNS records were published"
    requirement: "RESET-07"
    verification:
      - kind: manual_procedural
        ref: "dig +short TXT/MX flawchess.com against dns1.swizzonic.ch (authoritative), plus a received AWS SES -> Swizzonic MX chain message; see RESET-07 evidence below"
        status: pass
    human_judgment: true
    rationale: "DNS state and mail delivery are outside the repository; no automated proxy exists. Verified live by the operator during the Task 2 checkpoint with raw dig output recorded."
  - id: D3
    description: "RESET-01 — a real reset email arrives at a real mailbox via the verified flawchess.com apex domain, with DKIM/SPF/DMARC passing, and the link sets a working new password"
    requirement: "RESET-01"
    verification:
      - kind: manual_procedural
        ref: "email_service.send_password_reset_email() -> support@flawchess.com inbox, Gmail Authentication-Results (direct and Sieve-forwarded paths), full forgot->email->link->new password->login walkthrough"
        status: pass
    human_judgment: true
    rationale: "Requires a live Resend account, published DNS, and a real mailbox; a mocked send proves call shape, not deliverability. Verified live by the operator with headers recorded verbatim."
  - id: D4
    description: "RESET-05 — a no-password (Google-only) account produces zero sends with identical confirmation copy, observed against a real mailbox"
    requirement: "RESET-05"
    verification: []
    human_judgment: true
    rationale: "The real-mailbox observation was NOT performed at this checkpoint. Automated coverage (TestPasswordResetEligibility, including test_google_only_dispatches_zero_sends_indistinguishable and test_google_only_no_side_channel) is the evidence this criterion rests on; recorded honestly as automated-only, not as an observed pass. Logged to WINDOWS.md as unrun-verify."

duration: 15min
completed: 2026-08-08
status: complete
---

# Phase 207 Plan 3: Operator Handoff and Step-0-Gated Verification Summary

**Resend account fully live against the verified `flawchess.com` apex domain — DKIM landed at apex level (no `send.` fallback needed), apex SPF confirmed byte-identical post-change, and a real password-reset email passed DKIM/SPF/DMARC end-to-end on both a direct and a forwarded delivery path; RESET-05's real-mailbox eligibility observation is the one criterion honestly recorded as not performed.**

## Performance

- **Duration:** ~15 min (Task 2 bookkeeping only — Task 1 executed and committed in a prior session)
- **Started:** 2026-08-08 (Task 1); checkpoint answered 2026-08-08
- **Completed:** 2026-08-08
- **Tasks:** 2 (1 auto + 1 checkpoint:human-verify)
- **Files modified:** 4 (`.env.example`, `docs/email-resend-runbook.md`, `CHANGELOG.md`, `207-VALIDATION.md`)

## Accomplishments

- `.env.example` documents `RESEND_API_KEY`/`MAIL_FROM` with the unconfigured-is-a-no-op contract, matching the VAPID precedent.
- `docs/email-resend-runbook.md` is the durable Step 0 / key-rotation / failure-diagnosis procedure, now amended with a warning about Resend's "Enable Receiving" toggle (see Deviations).
- `CHANGELOG.md` carries the user-facing `[Unreleased]` bullet for Phase 207.
- **Step 0 is complete.** The operator finished DNS setup during this checkpoint: DKIM confirmed at the apex (`resend._domainkey.flawchess.com`), so the `MAIL_FROM=noreply@send.flawchess.com` fallback documented in the runbook was never needed.
- **RESET-07 (apex SPF regression) — PASSED**, verified against Swizzonic's own authoritative nameserver, not a caching resolver.
- **RESET-01 (real mailbox) — PASSED**, verified against the verified `flawchess.com` apex domain (superseding the sandbox-sender evidence recorded in 207-02-SUMMARY.md, which was explicitly out of scope there), on both a direct and an SRS-forwarded delivery path.
- **RESET-05's real-mailbox observation — NOT PERFORMED**, recorded honestly rather than inferred from RESET-01's pass. Automated coverage stands in its place.

## Task Commits

Each task was committed atomically:

1. **Task 1: Config surface, operator runbook, and changelog** — `c28403876` (docs)
2. **Task 2: Step-0-gated verification of RESET-01/RESET-07** — `checkpoint:human-verify`, ANSWERED (bookkeeping-only; runbook amendment + SUMMARY + VALIDATION.md mirror committed with plan metadata)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `.env.example` — `RESEND_API_KEY=` / `MAIL_FROM=noreply@flawchess.com` placeholders (Task 1, committed prior session)
- `docs/email-resend-runbook.md` — Step 0 procedure, key rotation, failure diagnosis (Task 1, committed prior session); amended in this task with an "Enable Sending, not Receiving" warning
- `CHANGELOG.md` — one `[Unreleased] / Added` bullet for Phase 207 (Task 1, committed prior session)
- `.planning/phases/207-self-serve-password-reset/207-VALIDATION.md` — Manual-Only Verifications table updated with RESET-01/RESET-05/RESET-07 verdicts and evidence pointers
- `.planning/WINDOWS.md` — one `unrun-verify` entry for RESET-05's un-performed real-mailbox observation

## Decisions Made

- DKIM landed at the apex, so the `send.` `MAIL_FROM` fallback documented in the runbook was never activated — `MAIL_FROM` stays `noreply@flawchess.com`.
- RESET-05's real-mailbox observation and RESET-03's manual repetition are both recorded as their own distinct verdicts, not folded into RESET-01's pass — see the "Eligibility observed in practice" and "Rate limit observed in practice" sections below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added an "Enable Sending, not Receiving" warning to the runbook**
- **Found during:** Task 2 checkpoint — the operator hit Resend's domain page and asked about the two separate "Enable Sending" / "Enable Receiving" toggles, which the original runbook text did not address.
- **Issue:** Enabling "Receiving" publishes MX records for inbound mail; on the apex domain this would collide with the existing `10 mx.swizzonic.email.` record and break all inbound flawchess.com mail — precisely the T-207-20 failure mode the runbook exists to prevent. This project has zero inbound-email handling (verified: the app touches exactly one Resend endpoint, `https://api.resend.com/emails`, in `app/services/email_service.py`), so there is never a reason to enable Receiving.
- **Fix:** Added a two-sentence warning block immediately after the three additive-record bullets in `docs/email-resend-runbook.md` § Step 0.
- **Files modified:** `docs/email-resend-runbook.md`
- **Verification:** Manual read-through; consistent with the file's existing warning-block style (the superseded-guidance callout a few lines above it).
- **Committed in:** this task's plan-metadata commit

---

**Total deviations:** 1 auto-fixed (1 missing critical — a real operational trap encountered live, addressed before it could recur for the next operator to touch this runbook)
**Impact on plan:** Necessary correctness addition to the runbook's own stated purpose (letting an operator who has never touched Resend avoid re-deriving anything). No scope creep — the amendment stays inside `docs/email-resend-runbook.md` § Step 0 as instructed.

## Issues Encountered

None beyond the documented RESET-05/RESET-03 scope decisions (see "Decisions Made").

## Step 0 Status

**DONE — 2026-08-08.** The operator completed the Resend account creation, apex-domain verification, and DNS publication during this checkpoint (continuing from the sandbox-sender setup begun at the Plan 02 checkpoint, per 207-02-SUMMARY.md). DKIM confirmed landing at the apex level (`resend._domainkey.flawchess.com`), so the `MAIL_FROM=noreply@send.flawchess.com` fallback documented in the runbook was not needed — `MAIL_FROM` remains `noreply@flawchess.com`.

## RESET-07 Evidence — PASSED

Apex records verified against Swizzonic's **authoritative** nameserver (`dns1.swizzonic.ch`), not a caching resolver, **after** the DNS change — byte-identical to the pre-change baseline:

```
dig +short TXT flawchess.com  ->  "v=spf1 a mx include:spf.webapps.net ~all"
dig +short MX  flawchess.com  ->  10 mx.swizzonic.email.
```

The apex SPF record was never edited — confirmed both by the raw `dig` output above and by the fact that the four new records (see below) were all published at `send.`, `resend._domainkey.`, and `_dmarc.`, never at the apex.

Delivery half of the criterion also satisfied: a message originating outside the infrastructure (AWS SES) was received at `support@flawchess.com` through Swizzonic's own MX chain:

```
a3-27.smtp-out.eu-west-1.amazonses.com -> cmsmtp -> montisb-dir03.it.dadainternal -> montisb-be01.it.dadainternal
```

Inbound mail to flawchess.com demonstrably still works post-change.

Four additive records were published (all confirmed resolving on 8.8.8.8, 1.1.1.1, and 9.9.9.9):

| Record | Value |
|---|---|
| `TXT resend._domainkey` | `p=MIGfMA0G...` (218 chars, **apex level**, not scoped under `send.`) |
| `MX send` | `feedback-smtp.eu-west-1.amazonses.com` priority 10 (only MX there) |
| `TXT send` | `v=spf1 include:amazonses.com ~all` |
| `TXT _dmarc` | `v=DMARC1; p=none; rua=mailto:support@flawchess.com` |

Because DKIM landed at apex level, the documented `MAIL_FROM=noreply@send.flawchess.com` fallback was **not** needed. `MAIL_FROM` is `noreply@flawchess.com`.

## RESET-01 Evidence — PASSED

Domain `flawchess.com` verified in Resend. Sends made through the project's **own** `email_service.send_password_reset_email()` (not the Resend SDK directly), returning `True` (2xx).

**Arrival:** INBOX, not spam. Confirmed by the operator at `support@flawchess.com`.

**Gmail's `Authentication-Results` on the DIRECT send** (SES → Gmail, no forwarding hop):

```
Authentication-Results: mx.google.com;
   dkim=pass header.i=@flawchess.com header.s=resend header.b=gqT15iqE;
   dkim=pass header.i=@amazonses.com header.s=shh3fegwg5fppqsuzphvschd53n6ihuv header.b=4OEYUUGr;
   spf=pass (google.com: domain of 0102019fe186fc6b-...@send.flawchess.com designates
             54.240.3.29 as permitted sender)
             smtp.mailfrom=0102019fe186fc6b-...@send.flawchess.com;
   dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=flawchess.com
```

**Gmail's `Authentication-Results` on a FORWARDED path** (`support@flawchess.com` Sieve-redirected to Gmail, with SRS envelope rewriting by register.it):

```
Authentication-Results: mx.google.com;
   dkim=pass header.i=@flawchess.com header.s=resend header.b=HOvxyjbj;
   arc=pass (i=1 dkim=pass dkdomain=flawchess.com dkim=pass dkdomain=amazonses.com);
   spf=pass (google.com: domain of srs0=tyujzxrh=gb=send.flawchess.com=...@flawchess.com
             designates 81.88.63.132 as permitted sender);
   dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=flawchess.com
```

**Two findings worth recording explicitly — they are the phase's design being confirmed empirically, not incidental trivia:**

1. On the **direct** path, SPF evaluated against `send.flawchess.com` (the `send.` subdomain SPF authorizing SES), and the apex SPF was never consulted — exactly D-05's design. DMARC passed on strict DKIM alignment (DKIM `d=flawchess.com` == `header.from=flawchess.com`).
2. On the **forwarded** path, register.it applied SRS, rewriting the envelope-from to the apex (`@flawchess.com`). SPF was therefore evaluated against the apex record and passed, because `include:spf.webapps.net` authorizes the forwarder at `81.88.63.132`. In other words: the **untouched apex SPF record is what made the forwarded message pass SPF.** Had Step 0 followed the superseded seed guidance and merged Resend's include into the apex, this is exactly the path that could have broken. T-207-20's mitigation is confirmed by observation, not just by intent. DKIM also survived the forwarding hop intact.

**Link behavior:** the operator completed forgot-password → email → link → set new password → new password logs in and the old one does not, end to end over a Tailscale tunnel (recorded in 207-02-SUMMARY.md). Email template confirmed rendering correctly in both `text/plain` and `text/html` parts with the reset URL intact.

## Rate Limit Observed in Practice — covered by automated + mutation test, not manually re-tested

The operator declined the manual repetition. `_RESET_PASSWORD_MAX_REQUESTS = 5` would have required six by-hand requests, and the exact procedure is covered by `test_boundary_nth_dispatches_n_plus_1th_does_not`, mutation-tested per RESET-08 (see 207-01-SUMMARY.md's mutation table, row 1). Recorded as "covered by automated + mutation test; manual repetition judged redundant by the operator" — **not** as a manual pass, **not** as a gap.

## Eligibility Observed in Practice (RESET-05) — NOT PERFORMED

The real-mailbox observation described in plan step 9 (request a reset for an operator-controlled address with no stored password, confirm zero sends and identical confirmation copy) was **not performed** at this checkpoint. Automated coverage stands and is strong: `TestPasswordResetEligibility`'s four cases, including `test_google_only_dispatches_zero_sends_indistinguishable` and `test_google_only_no_side_channel`. Stated plainly: the real-mailbox observation of the eligibility gate was not made, so this criterion rests on automated evidence only. This is not presented as passed-by-observation, and it is not quietly omitted — it is logged to `.planning/WINDOWS.md` as an `unrun-verify` entry.

## User Setup Required

None remaining — Step 0 is complete. See `docs/email-resend-runbook.md` for key rotation and failure diagnosis going forward.

## Next Phase Readiness

Phase 207 is functionally complete: backend spine (207-01), frontend forms (207-02), and operator handoff + Step-0-gated verification (207-03) are all done. RESET-01 and RESET-07 are PASSED with live evidence against the verified `flawchess.com` apex domain. RESET-05's real-mailbox observation remains an open, honestly-logged item (`.planning/WINDOWS.md`) — automated coverage is strong, but a future operator revisit could close it by requesting a reset against a real no-password mailbox. No blockers to closing the phase.

---
*Phase: 207-self-serve-password-reset*
*Completed: 2026-08-08*

## Self-Check: PASSED

`docs/email-resend-runbook.md` found on disk with the new "Enable Sending, not Receiving" warning present (confirmed via Read after Edit). `.planning/phases/207-self-serve-password-reset/207-VALIDATION.md` found on disk with the updated Manual-Only Verifications table and per-task status row. Commit `c28403876` (Task 1) found in `git log --oneline --all`.
