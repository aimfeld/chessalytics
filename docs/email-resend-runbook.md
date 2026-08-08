---
title: Resend transactional email runbook
date: 2026-08-08
context: operator procedure for the Resend account, DNS records, and API key that back
  the self-serve password reset flow. Written as part of Phase 207 (Self-Serve Password
  Reset). This is the durable form of the ROADMAP "Blocking pre-planning gate — Step 0"
  text and SEED-143, both of which get archived at milestone close — this document is
  what survives.
source: app/services/email_service.py, app/users.py, app/core/config.py,
  .planning/ROADMAP.md (Phase 207, D-05 supersession)
---

# Resend transactional email runbook

This is the procedure for the Resend account, DNS records, and API key that let
FlawChess send its one transactional email — the password reset link.

## What this covers and why it exists

The project sends exactly one kind of message (password reset), to a target
population of ~172 accounts, roughly five times a year. There is deliberately no
periodic canary send (D-07 — see `COVERAGE.md` § 7): building one to catch a revoked
key or DNS drift before a real user hits it was judged over-engineering at this
volume. **The accepted consequence is that the first person to discover a broken flow
is a locked-out user.** This document is the recovery path for that moment — it needs
to let an operator who has never touched Resend or this phase before diagnose and fix
a failure without re-deriving anything.

If a reset ever does fail in the wild, that is the trigger to revisit the canary
decision (D-07), not to debug in place a second time.

## Step 0 — first-time setup

**None of this is automated, and none of it should be** (see "Deliberately not
automated" below — key lifecycle and domain lifecycle in an app's own hands is a
privilege-escalation surface, not a convenience).

1. Create a Resend account (`support@flawchess.com` or equivalent) at
   [resend.com](https://resend.com).
2. **Add `flawchess.com` — the apex, not a subdomain — as a domain** in
   Resend Dashboard → Domains → Add Domain. Read the exact records the dashboard
   issues before publishing anything; expect three, all additive:
   - `MX` on `send.flawchess.com` → `feedback-smtp.<region>.amazonses.com`, priority 10
   - `TXT` on `send.flawchess.com` → `v=spf1 include:amazonses.com ~all`
   - `TXT` on `resend._domainkey.flawchess.com` → the DKIM public key

   > **Warning — the domain page has two separate toggles: "Enable Sending" and
   > "Enable Receiving". Only enable Sending.** This project has zero inbound-email
   > handling (verified: the app touches exactly one Resend endpoint,
   > `https://api.resend.com/emails`, in `app/services/email_service.py`). Enabling
   > Receiving publishes MX records for inbound mail, which on the apex would collide
   > with the existing `10 mx.swizzonic.email.` and break all inbound flawchess.com
   > mail — exactly the T-207-20 failure mode this document exists to prevent.

   **The apex SPF record is never modified and never edited** (`flawchess.com` itself: `v=spf1 a mx include:spf.webapps.net ~all` — this apex value is never read at runtime and Step 0 does not touch it). Why: SPF is evaluated against the
   *envelope-from*, and Resend (which runs on SES) sets the Return-Path to
   `bounces@send.flawchess.com` — so SPF only ever needs to live on the `send.`
   subdomain. DKIM signs with `d=flawchess.com` at the apex, and `From:
   noreply@flawchess.com` passes DMARC on **strict DKIM alignment** (SPF also aligns,
   relaxed, same org domain, but DKIM is the one doing the work). All three records
   above are additive to a domain that carries no prior Resend configuration.

   > **Warning — superseded guidance, do not follow.** An earlier version of this
   > phase's design (SEED-143, before the 2026-08-08 D-05 supersession) assumed the
   > apex SPF record had to be *merged* with a Resend include, and named the token as
   > `include:_spf.resend.com`. Both are wrong: merging the apex SPF is unnecessary
   > (see above) and actively counterproductive (it burns one of SPF's 10-lookup
   > budget for no benefit), and the correct include token for Resend-on-SES is
   > `include:amazonses.com`, not `_spf.resend.com`. If an archived copy of the seed
   > or an old planning doc turns up, do not follow its DNS instructions — this
   > document is the current source of truth.

3. **Confirm DKIM landed at the apex.** Run:
   ```bash
   dig +short TXT resend._domainkey.flawchess.com
   ```
   This must return a value (Resend's public key). Apex-level DKIM is the one
   load-bearing detail that makes `noreply@flawchess.com` align under DMARC.
   **If DKIM is instead scoped under `send.`** (i.e. the dashboard shows it at
   `resend._domainkey.send.flawchess.com` and the apex lookup above is empty), the
   fallback is to set `MAIL_FROM=noreply@send.flawchess.com` in the deployed
   `.env` — **do not** "fix" this by merging the apex SPF record; that reopens the
   exact mistake described in the warning above.
4. **Confirm `send.flawchess.com` has no pre-existing MX** before publishing
   Resend's bounce MX record:
   ```bash
   dig +short MX send.flawchess.com
   ```
   Must be empty. Resend requires its bounce MX to be the only MX on the sending
   subdomain. (The Swizzonic mail exchanger lives on the apex, `flawchess.com`, not
   on `send.`, so no conflict is expected.)
5. **Add DMARC** — `_dmarc.flawchess.com` → `v=DMARC1; p=none; rua=mailto:<your
   monitoring address>`. Purely additive; no DMARC record exists on the domain today.
6. **Create a sending-permission-only API key** in Resend Dashboard → API Keys →
   Create API Key. Sending permission is deliberately narrow — see "Diagnosing a
   reported failure" below for what that scope looks like from the outside.
7. Put the key in the **local** `.prod.env` (never the repo, never `.env.example`)
   that `bin/deploy.sh` scps to `/opt/flawchess/.env`:
   ```bash
   RESEND_API_KEY=re_...
   MAIL_FROM=noreply@flawchess.com   # or noreply@send.flawchess.com per step 3
   ```
   A key present only in a local dev `.env` works in dev and silently no-ops in
   production — it must reach `/opt/flawchess/.env` via `.prod.env` and a real
   deploy.

## Key rotation

1. Create a new sending-permission-only key in Resend Dashboard → API Keys.
2. Put it in the local `.prod.env` (the same file `bin/deploy.sh:28-29` scps to
   `/opt/flawchess/.env`). **Never SSH-edit `/opt/flawchess/.env` directly** —
   that edit doesn't survive the next deploy and isn't tracked anywhere.
3. Run `bin/deploy.sh` (the only sanctioned deploy path — never deploy by direct
   SSH).
4. Verify: submit `/auth/forgot-password` for an operator-controlled address and
   confirm the message arrives (see RESET-01 verification steps in
   `207-03-SUMMARY.md` for the full procedure, including header checks).
5. Delete the old key in the Resend dashboard once the new one is confirmed
   working.

## Diagnosing a reported failure

**Lead with the check that is not a failure at all.** An account with no stored
password (Google-only sign-up, or a guest) receives **no reset email by design**
(Phase 207's eligibility gate, `app/users.py`), and the UI deliberately says nothing
that distinguishes this from a normal send — the confirmation copy is byte-identical
either way. So "I requested a reset and nothing arrived" from a user who signed up
with Google is **expected behavior, not a bug**. Confirm it by querying the
account's stored password rather than guessing:

```sql
SELECT email, (hashed_password = '') AS no_password FROM "user" WHERE email = '<address>';
```

If `no_password` is true, point the user at "Sign in with Google" — there is
nothing to fix.

**Only once that's ruled out, work the real failure checks in order:**

1. **Sentry.** Check the `email_service` tag in the FlawChess Sentry project for
   captures around the reported time, and read the `status_code` in the attached
   context (CLAUDE.md's Sentry rules mean every send failure — transport error or
   non-2xx — produces exactly one capture with a constant message, variables only
   in context).
2. **Key presence.** Confirm `RESEND_API_KEY` is actually set in
   `/opt/flawchess/.env` on the server (`ssh flawchess "cd /opt/flawchess &&
   grep -c RESEND_API_KEY .env"` should show a non-empty value — do not print the
   value itself).
3. **Domain verification.** Confirm `flawchess.com` still shows verified in
   Resend Dashboard → Domains — a DNS change elsewhere (e.g. a registrar migration)
   can silently un-verify a previously-working domain.
4. **DNS still resolving.** Re-run the three `dig` checks from Step 0 above; a
   record can be dropped by an unrelated DNS panel change.
5. **Suppression list.** A hard-bounced address gets silently suppressed by
   Resend and stops receiving mail with no error on our side. Check Resend
   Dashboard for the address.

**Mapping Resend response codes to causes**, for the `status_code` recorded in the
Sentry context above:

| Status | Likely cause |
|---|---|
| `401` / `403` | Key missing, revoked, or scoped to the wrong permission |
| `422` | `MAIL_FROM`'s domain does not match the domain actually verified in Resend (see the DKIM-scoping fallback in Step 0.3) |
| `429` | Per-team send rate exceeded (10 req/s) — our own per-email limiter caps far below this; a 429 here is unusual and worth a second look rather than routine retry |

**Two related Resend key-verification error shapes, easy to confuse:**

- A **sending-permission-only key** (the correct, intentionally narrow key type
  for this project) returns `401 "This API key is restricted to only send
  emails"` on any non-send endpoint, e.g. `GET /domains`. **That response means
  the key is correctly scoped — it is not a misconfiguration** and does not need
  fixing.
- A **malformed or truncated key** (e.g. a stray character appended during a
  copy-paste) instead returns `400 "API key is invalid"`. This one genuinely
  needs fixing — but the fix is correcting the key string, not recreating the
  key from scratch.

## Deliberately not automated

See `COVERAGE.md` for the full reasoning behind each opt-out (2 `INTEGRATE`, 24
reasoned `OPT-OUT`, 0 unreasoned). In short, none of the following exist and none
should be added without revisiting the underlying decision:

- **No canary or scheduled send** (D-07). This runbook is the accepted
  alternative — see "What this covers" above. If a reset ever fails in the wild,
  **revisit the canary decision rather than debugging in place a second time.**
- **No webhooks or delivery/bounce events.** Would require a new public
  unauthenticated endpoint plus signature verification plus persisting an email
  id (a migration, an explicit non-goal). At ~5 sends/year the operational value
  is close to zero; Sentry already captures the failure mode we can act on
  (send-time errors).
- **No retry.** One attempt, capture on failure, move on — matching
  `app/services/push_send.py`'s existing precedent. A retried reset mail is also
  a mail-bombing amplifier.
- **No official `resend` SDK.** One `httpx.AsyncClient` POST, no new dependency
  (D-03).
- **No key- or domain-lifecycle automation.** Creating/rotating/deleting keys and
  domains stays dashboard-driven, operator-only work — an app that can mint its
  own credentials is a privilege-escalation surface.

**Provider fallback, decided in advance so it is never re-derived under
pressure:** if Resend deliverability ever disappoints, **Postmark is the
designated fallback** (D-03) — it was disqualified here only for its manual
new-account review, not for any technical shortcoming.
