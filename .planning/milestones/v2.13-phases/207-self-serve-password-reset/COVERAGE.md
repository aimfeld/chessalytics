# Phase 207 — Resend API Coverage Matrix

**External API:** Resend (`https://api.resend.com`)
**Integration surface in this phase:** exactly one call — `POST /emails`
**Authored:** 2026-08-08 (planning)
**Gate:** `workflow.api_coverage_gate` — every capability starts as `INTEGRATE`; every `OPT-OUT` carries a written reason. This file is the subtraction record.

> **Framing.** This phase sends one transactional message roughly five times a year
> (SEED-143 prod population: 172 password accounts). Almost every capability below is a
> reasoned `OPT-OUT`, and that is the correct outcome — but the opt-outs are written down
> here rather than left implied, so a future phase that wants webhooks, batch send, or a
> canary can see exactly what was declined and why.

---

## 1. Emails

| Capability | Endpoint | Disposition | Reason |
|---|---|---|---|
| Send email | `POST /emails` | **INTEGRATE** | The entire point of the phase. Implemented in `app/services/email_service.py::send_password_reset_email`. |
| Retrieve email | `GET /emails/:id` | OPT-OUT | We do not persist the returned email id (no migration — ROADMAP non-goal), so there is nothing to retrieve it by. Delivery status is not surfaced to the user by design. |
| Update / reschedule email | `PATCH /emails/:id` | OPT-OUT | Requires `scheduled_at` (also opted out). A password reset is immediate by definition. |
| Cancel scheduled email | `POST /emails/:id/cancel` | OPT-OUT | Nothing is ever scheduled — see `scheduled_at` below. |
| Batch send | `POST /emails/batch` | OPT-OUT | Exactly one recipient per request. Batching a single-recipient transactional send adds payload shape for zero benefit. |
| Scheduled send (`scheduled_at`) | field on `POST /emails` | OPT-OUT | A reset link has a 1-hour TTL (fastapi-users default); delaying delivery would eat the TTL. |
| Idempotency (`Idempotency-Key` header) | header on `POST /emails` | OPT-OUT | Idempotency keys exist to dedupe **retried** requests. RESEARCH's Anti-Patterns section explicitly rejects retry logic here (`push_send.py` precedent: one attempt, capture, move on). With no retry there is nothing to dedupe. Revisit only if retry is ever added. |
| Attachments | `attachments[]` | OPT-OUT | The message is a heading, one paragraph and a link. No attachment is wanted, and an attachment on a password-reset mail is a phishing-shaped signal. |
| CC / BCC | `cc`, `bcc` | OPT-OUT | A reset link must reach exactly one mailbox. Copying it anywhere else is a credential-disclosure bug, not a feature. |
| Reply-To | `reply_to` | OPT-OUT | `noreply@flawchess.com` has no inbox to route replies to. Adding a `reply_to` that also has no inbox would be worse (silent drop with a reply affordance). |
| Tags (`tags[]`) | field on `POST /emails` | OPT-OUT | Tags exist to segment analytics across message types. There is exactly one message type. |
| Custom headers (`headers`) | field on `POST /emails` | OPT-OUT | No List-Unsubscribe (transactional, not bulk), no custom threading headers needed. |
| Plain-text alternative (`text`) | field on `POST /emails` | **INTEGRATE** | Sent alongside `html`. A text part materially improves inbox placement and is the only thing a plain-text client can act on. Costs one dict key. |

## 2. Domains

| Capability | Endpoint | Disposition | Reason |
|---|---|---|---|
| Create domain | `POST /domains` | OPT-OUT | Operator Step 0 does this once in the dashboard. Automating a one-time manual setup step is the definition of over-engineering here. |
| Retrieve / list domains | `GET /domains(/:id)` | OPT-OUT | Same — no runtime need to enumerate our single verified domain. |
| Verify domain | `POST /domains/:id/verify` | OPT-OUT | Step 0, dashboard-driven. The DKIM-at-apex question (ROADMAP Step 0.2) is settled visually in the dashboard, not by API. |
| Update domain (open/click tracking, TLS) | `PATCH /domains/:id` | OPT-OUT | Open/click tracking rewrites links, which on a **password reset link** is an active harm (rewritten URL, extra hop, phishing-shaped). Leave defaults. |
| Delete domain | `DELETE /domains/:id` | OPT-OUT | Destructive, one-time, operator-only. |

## 3. API Keys

| Capability | Endpoint | Disposition | Reason |
|---|---|---|---|
| Create / list / delete API key | `/api-keys` | OPT-OUT | Key lifecycle is operator work (`.prod.env` → `bin/deploy.sh` → `/opt/flawchess/.env`). An app that can mint its own credentials is a privilege-escalation surface, not a convenience. Rotation is manual, documented in `docs/email-resend-runbook.md` (Plan 03). |

## 4. Audiences & Contacts

| Capability | Endpoint | Disposition | Reason |
|---|---|---|---|
| Audiences CRUD | `/audiences` | OPT-OUT | Audiences back **marketing** broadcasts. FlawChess sends no marketing email and storing a contact list would create a GDPR surface this phase deliberately does not open. |
| Contacts CRUD | `/audiences/:id/contacts` | OPT-OUT | Same. Recipients are resolved from our own `users` table at send time and never mirrored into Resend. |

## 5. Broadcasts

| Capability | Endpoint | Disposition | Reason |
|---|---|---|---|
| Broadcasts create / send / list / delete | `/broadcasts` | OPT-OUT | Bulk marketing send. Out of scope by product intent, and would drag in unsubscribe-header obligations. |

## 6. Webhooks & Events

| Capability | Mechanism | Disposition | Reason |
|---|---|---|---|
| Delivery / bounce / complaint webhooks | Resend → our endpoint | OPT-OUT | Would require a new public unauthenticated endpoint plus signature verification plus (to be useful) a persisted email id — i.e. a migration, which is an explicit ROADMAP non-goal. At ~5 sends/year the operational value is near zero; Sentry already captures *send-time* failure (RESET-04), which is the failure mode we can act on. |
| Open / click tracking events | domain setting | OPT-OUT | See "Update domain" — link rewriting on a credential-reset URL is actively undesirable. |
| Suppression list read | (dashboard) | OPT-OUT | A hard bounce suppressing a single address is visible in the dashboard. No runtime branch depends on it. |

## 7. Cross-cutting

| Capability | Disposition | Reason |
|---|---|---|
| Official `resend` Python SDK | OPT-OUT | Locked decision D-03 — one `httpx.AsyncClient` POST, no new dependency. |
| Retry / exponential backoff | OPT-OUT | RESEARCH Anti-Patterns: `push_send.py` (single transactional send) has zero retry; the import clients' backoff loops are the wrong analog. A retried reset mail is also a mail-bombing amplifier. |
| Rate-limit handling (Resend `429`, 10 req/s per team) | OPT-OUT (handled generically) | Our own per-email limiter caps us far below Resend's ceiling. A `429` from Resend lands in the generic non-2xx branch → Sentry with `status_code` in context. No special-casing, and a code comment says so, so nobody "fixes" it later by adding retry. |
| Periodic canary send | OPT-OUT | Locked decision D-07. **Accepted consequence, restated: the first person to discover a broken flow is a locked-out user.** If a reset ever fails in the wild, revisit this row before debugging in place. |

---

## Summary

| Disposition | Count |
|---|---|
| INTEGRATE | 2 (`POST /emails`; the `text` alternative part) |
| OPT-OUT | 24 |
| Unreasoned | **0** |
