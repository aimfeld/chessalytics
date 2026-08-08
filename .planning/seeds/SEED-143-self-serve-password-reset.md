---
id: SEED-143
status: active
planted: 2026-08-08
planted_during: /gsd-explore — "there's currently no way for a user to recover their signed-up
  accounts if they lost their password"
trigger_when: Any time. No dependencies on other work. The only blocker is the manual Resend
  account + DNS setup (Step 0 below), which must land before any code is written.
scope: small (backend is ~15 lines of fastapi-users wiring plus a ~30-line email module; the
  frontend is two small forms; the DNS step is manual and carries the only real risk)
---

# SEED-143: Self-serve password reset for signed-up accounts

## Why This Matters

There is currently **no account recovery path at all**. A user who signs up with email +
password and forgets it is permanently locked out. Their only option is to register again with
a different address (the existing one returns `EMAIL_ALREADY_REGISTERED`, see
`app/routers/auth.py:383,468,508`) and re-import their entire game history, losing bookmarks
and Train state.

Guest accounts are explicitly **out of scope** — they are ephemeral by design
(`guest_<uuid4hex>@guest.local`, `hashed_password=""`, `app/services/guest_service.py:21,37`)
and are not meant to be recoverable.

### Population (prod, measured 2026-08-08)

| | count |
|---|---|
| guest accounts | 304 |
| signed-up | 216 |
| ...with a password | **172** |
| ...Google-only (empty hash) | 44 |

At 172 password accounts, expect **single-digit reset requests per year**. Every decision below
is calibrated to that: the flow must be cheap to build, cheap to maintain, and must not rot
silently between uses.

## Current State (verified 2026-08-08)

The backend is closer than it looks — the token secrets are already configured, nothing consumes
them:

- `UserManager.reset_password_token_secret` is set at `app/users.py:64-65`.
- `get_reset_password_router()` is **absent entirely** — not mounted, not commented out. Repo-wide
  grep over `app/`, `tests/`, `docs/`, `frontend/src` returns zero hits.
- `on_after_forgot_password` is **not overridden** on `UserManager` (`app/users.py:63`). The
  fastapi-users base is a no-op, so no token is ever emitted.
- **Email delivery capability is 100% absent**: no library, no config key, no env var, no
  template, no send call anywhere in the repo. (`email-validator` appears only as a transitive
  dep at `uv.lock:519`, for `EmailStr` validation.)
- Frontend has **no forgot-password UI** of any kind. `frontend/src/components/auth/` contains
  exactly two files: `LoginForm.tsx`, `RegisterForm.tsx`.

Routers currently mounted (`app/routers/auth.py`, included at `app/main.py:235`):
`get_auth_router` (`:42-46`), `get_register_router` (`:49-53`). Google OAuth is a fully custom
implementation, not `get_oauth_router`.

## Locked Decisions

### D-01 — Fully self-serve, not human-in-the-loop

Standard flow: user clicks "Forgot password", receives an emailed token link, sets a new
password. No involvement from the operator. Rejected: a "email the maintainer" manual path,
despite the tiny volume making it viable.

### D-02 — Do NOT self-host a mail server

Installing Postfix on the Hetzner CPX42 is an afternoon; making it *deliver* is not, and the
failure mode is silent:

- Hetzner Cloud blocks outbound **25 and 465** by default. Unblocking requires ≥1 month account
  age + first invoice paid, then a case-by-case limit-increase request. (**587 is explicitly
  open** and is Hetzner's documented path for relaying via an external provider — so SMTP relay
  was never actually blocked. Moot given D-03.)
- Even unblocked, a cold IP in a Hetzner range must earn reputation with Gmail/Outlook. **IP
  reputation is earned by volume, and this flow has none** — ~5 sends/year never warms anything.
  It does not get better over time.
- A reset email that lands in spam is a silent total failure. Nobody reports it; the user just
  gives up. At this frequency it could be broken for a year unnoticed.

### D-03 — Resend, via raw `httpx` HTTP API

Free tier 3,000/mo, 100/day, permanent — roughly 60x headroom over the realistic ceiling.
No account review. HTTPS:443, so Hetzner's port policy is irrelevant.

Skip the official `resend` Python SDK; it adds nothing over one `httpx.AsyncClient` POST, and
`httpx` is already a project-wide dependency:

```
POST https://api.resend.com/emails
Authorization: Bearer <RESEND_API_KEY>
{"from": "...", "to": ["..."], "subject": "...", "html": "...", "text": "..."}
```

**Alternatives evaluated and rejected:**

| Provider | Verdict |
|---|---|
| **Brevo** | **Disqualified.** Deletes free-plan accounts after **4 months of inactivity**. At ~5 sends/year this trips constantly — the exact silent-rot failure this flow must avoid. Mailjet has the same policy. |
| **Amazon SES** | SES-specific free tier **ended for new customers 21 Jul 2026** (now a $200/6mo credit). Plus a sandbox-exit ticket. Highest friction. |
| **Mailgun** | Flex pricing doubled to $2/1K in Dec 2025; free tier was killed in 2023 and restored in 2024. Churny vendor. |
| **Postmark** | Genuine runner-up — 100/mo free forever, best-in-class transactional inbox placement. Rejected only for the manual new-account review. Swap to this if Resend deliverability ever disappoints. |

Neither Resend nor Postmark publishes an inactivity-purge policy, but **neither guarantees
survival either** — see the Known Risks section.

### D-04 — Google-only accounts get a normal reset link

The 44 accounts with an empty `hashed_password` (Google SSO) receive the standard reset email.
They end up with both login methods on one account. No special-casing, no second template.

Not a security downgrade: the flow still requires control of the mailbox. Arguably a feature —
it gives SSO users a password fallback.

### D-05 — Merge into the apex SPF record; From = `noreply@flawchess.com`

**flawchess.com already sends and receives mail.** Measured 2026-08-08:

```
MX        10 mx.swizzonic.email.
TXT       "v=spf1 a mx include:spf.webapps.net ~all"
_dmarc    (none)
```

A domain may have **exactly one** SPF TXT record. Publishing a second one breaks SPF for *both*
senders, including the existing Swizzonic mail. So this is a careful in-place merge of one
string, not an added record.

Rejected alternative: verifying a `send.flawchess.com` subdomain, which would leave the apex
untouched at zero risk but forces a `noreply@send.flawchess.com` From address. The cleaner From
address was judged worth the (contained) risk.

### D-06 — In scope beyond the core flow

- **Per-email rate limit.** The forgot-password endpoint is unauthenticated. Without a cooldown,
  flooding it burns the 100/day Resend cap and breaks the flow for everyone, and lets a known
  user be mail-bombed. ~10 lines.
- **Sentry capture on send failure.** Already mandated by CLAUDE.md for `app/services/`. Wrap
  the Resend call, `capture_exception` on failure, pass user_id via `set_context` (never
  interpolate variables into the message — it fragments grouping).

### D-07 — Deliberately OUT of scope

- **Periodic canary send.** A scheduled send to an owned mailbox is the only thing that catches a
  revoked key or DNS drift *before* a real user hits it. Judged over-engineering at ~5 sends/year.
  Accepted consequence: the first person to discover a broken flow is a locked-out user. See
  Known Risks.
- **Explicit guest-account guard.** A `is_guest` / `@guest.local` check in the hook would prevent
  a guaranteed Resend error on a `.local` address. Skipped: guest emails are unguessable uuid4
  sentinels, so the path is not reachable in practice, and D-06's Sentry capture covers the
  residual.
- **Email verification on registration.** See Adjacent Gap below.

## Step 0 — Manual prerequisite (blocks all code)

This is operator work, not executor work, and it must land first:

1. Create a Resend account; verify **flawchess.com** (apex, per D-05).
2. Add the DKIM record(s) Resend issues. These are additive — no conflict risk.
3. **Merge** the Resend SPF include into the existing TXT record. Roughly:
   `"v=spf1 a mx include:spf.webapps.net include:_spf.resend.com ~all"`
   **Confirm the exact include token in the Resend dashboard at setup time** — the value above is
   from research, not verified against a live Resend account. Edit the existing string; do not
   publish a second SPF record.
4. Verify Swizzonic mail still delivers after the SPF edit. This is the one step that can break
   something already working.
5. Add a DMARC record at `_dmarc.flawchess.com`: `v=DMARC1; p=none; rua=mailto:<addr>`. Purely
   additive, no conflict. Not strictly required at this volume — Gmail/Yahoo's 2024 bulk-sender
   rules only mandate DMARC above 5,000/day — but Gmail increasingly penalizes domains without it.
6. Put `RESEND_API_KEY` in `/opt/flawchess/.env` (via the local `.prod.env` that `bin/deploy.sh:28-29`
   scps up). Never commit it.

## Implementation Sketch

**Backend**
- `app/services/email_service.py` (new) — one `httpx` POST to Resend, Sentry capture on failure.
- `app/users.py` — override `on_after_forgot_password` on `UserManager` (`:63`) to build the reset
  URL from `settings.FRONTEND_URL` and send.
- `app/routers/auth.py` — mount `fastapi_users.get_reset_password_router()` under the `/auth`
  prefix, alongside the register router at `:49-53`.
- `app/core/config.py` — add `RESEND_API_KEY` and `MAIL_FROM` to `Settings`.
- Per-email rate limit on the forgot-password path.

**Frontend**
- `frontend/src/components/auth/ForgotPasswordForm.tsx` (new).
- A `/auth/reset-password` route reading `?token=`, registered near `App.tsx:845-847`.
- A "Forgot password?" link on `LoginForm.tsx`.
- Standard project rules apply: `data-testid` on every interactive element, `text-sm` floor,
  mobile-first, `variant="brand-outline"` for secondary actions, and an `isError` branch on any
  query-driven state.

**Note:** fastapi-users' `forgot_password` already returns `202` regardless of whether the email
exists, so there is no enumeration leak to fix. Default token TTL is 3600s — fine as-is.

## Known Risks

- **Silent rot.** With no canary (D-07), a revoked API key, an expired Resend account, or DNS
  drift stays invisible until a locked-out user hits it. This is a consciously accepted trade.
  If a reset ever fails in the wild, revisit the canary decision rather than debugging in place.
- **The SPF merge (D-05, Step 0.3)** is the only step that can break something currently working.
  Verify Swizzonic delivery immediately after editing.

## Adjacent Gap (captured, not scoped here)

**There is no email verification on registration either.** `get_verify_router()` is equally absent,
and `on_after_register` (`app/users.py:67-77`) only stamps `last_login`. A user can register with a
typo'd address they do not control.

Today that is merely untidy. **Once password reset ships, it becomes load-bearing**: the reset link
goes to a mailbox that isn't theirs, making that account *permanently* unrecoverable — a strictly
worse outcome than today's "no recovery for anyone", because the user reasonably expects recovery
to work.

The infrastructure to fix it (Resend client, email templates, config) lands with this seed, so the
marginal cost of adding verification afterwards is small. Worth a follow-up seed once this ships.
