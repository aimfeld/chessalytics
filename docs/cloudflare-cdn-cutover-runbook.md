---
title: Cloudflare CDN cutover runbook
date: 2026-08-10
context: operator procedure for putting a Cloudflare free-plan CDN in front of
  flawchess.com so the ~82 MB of vendored ML runtime (Maia ONNX model, onnxruntime-web
  builds, Stockfish wasm) stops being served off the origin's single NIC. Written as
  part of Phase 209 (Traffic-Surge Quick Wins), item 3 of SEED-146, D-04. This is
  operator-only work by explicit decision — no executor agent performed any DNS,
  registrar, or Cloudflare action while writing this document.
source: deploy/Caddyfile, docs/email-resend-runbook.md,
  .planning/phases/209-traffic-surge-quick-wins/209-CONTEXT.md (D-04),
  .planning/seeds/SEED-146-traffic-surge-readiness.md (item 3)
---

# Cloudflare CDN cutover runbook

This is the procedure for putting a free-plan Cloudflare CDN in front of
`flawchess.com` so the vendored ML runtime under `/maia/*` and `/engine/*` is served
from edge cache instead of the origin box's single NIC, while every mail record
(the Swizzonic mail exchanger and the Phase 207 Resend record set) survives the
nameserver move byte-for-byte.

## 1. Why this exists

FlawChess vendors ~82 MB of version-pinned ML runtime on the origin: the 45.68 MB
Maia ONNX model, two onnxruntime-web builds (24.25 MB + 13.48 MB), and the 7.30 MB
Stockfish wasm. All of it is correctly `lazy()`-loaded and cached 30 days
(`deploy/Caddyfile`'s `@vendored_runtime` rule), but the problem is first-visit
concurrency off a single 1 Gbps NIC: roughly 45 MB per new user means the link
saturates at about **2.8 users/sec** — on the same box that also runs Postgres and
the backend.

This matters more than it would otherwise because of the agreed wait-time UX: while
a user's import runs, the app suggests playing a bot game, which is exactly the path
that pulls in the 45.68 MB Maia model. A first-time visitor arriving from a traffic
spike (YouTube mention, Show HN, press) hits that download at precisely the moment
the origin is under the most load. Good UX instinct, bad infrastructure moment,
unless the bytes come from somewhere else.

**State plainly: this is a bandwidth measure, not an origin-hiding measure.** The
mail records (apex MX/SPF, and the Phase 207 Resend set) must stay DNS-only
(grey-clouded) for mail to keep working, which means the origin IP remains
discoverable through them at all times. No security control — DDoS mitigation,
WAF, origin concealment — is assumed or claimed from this change. If that is ever
wanted, it is a separate decision with its own trade-offs.

## 2. Pre-flight record inventory

Before touching anything, capture the current authoritative answers from
`dns1.swizzonic.ch` (today's authoritative nameserver for `flawchess.com`) to a
file. This file is both the reconciliation reference for the Cloudflare import and
the rollback record if anything needs to be reverted.

```bash
NS=dns1.swizzonic.ch
OUT=cloudflare-cutover-preflight-$(date +%Y%m%d).txt

{
  echo "=== apex A ==="
  dig @$NS +short A flawchess.com
  echo "=== apex AAAA ==="
  dig @$NS +short AAAA flawchess.com
  echo "=== www A/AAAA/CNAME (if present) ==="
  dig @$NS +short A www.flawchess.com
  dig @$NS +short AAAA www.flawchess.com
  dig @$NS +short CNAME www.flawchess.com
  echo "=== apex MX ==="
  dig @$NS +short MX flawchess.com
  echo "=== apex TXT (SPF) ==="
  dig @$NS +short TXT flawchess.com
  echo "=== send.flawchess.com MX (Resend bounce) ==="
  dig @$NS +short MX send.flawchess.com
  echo "=== send.flawchess.com TXT (Resend SPF) ==="
  dig @$NS +short TXT send.flawchess.com
  echo "=== resend._domainkey.flawchess.com TXT (Resend DKIM, apex-level) ==="
  dig @$NS +short TXT resend._domainkey.flawchess.com
  echo "=== _dmarc.flawchess.com TXT ==="
  dig @$NS +short TXT _dmarc.flawchess.com
} | tee "$OUT"
```

Expected values, per the current record set (`docs/email-resend-runbook.md`):

- Apex `TXT` (SPF): `v=spf1 a mx include:spf.webapps.net ~all` — never edited by
  this procedure or any other.
- `send.flawchess.com` `MX`: `feedback-smtp.<region>.amazonses.com`, priority 10.
- `send.flawchess.com` `TXT` (SPF): `v=spf1 include:amazonses.com ~all`.
- `resend._domainkey.flawchess.com` `TXT`: Resend's DKIM public key. **This is the
  load-bearing detail behind DMARC alignment for `noreply@flawchess.com`** — DKIM
  signs with `d=flawchess.com` at the apex, and losing this record silently breaks
  DMARC alignment and, in turn, password-reset delivery, with no obvious symptom
  until a user reports a missing email.
- `_dmarc.flawchess.com` `TXT`: `v=DMARC1; p=none; rua=mailto:<monitoring address>`.

Do not proceed to Cloudflare setup without this file saved.

## 3. Cloudflare setup

1. Create a free Cloudflare account with **2FA enabled** before adding anything —
   the nameserver delegation is the single highest-leverage credential for the
   whole domain (T-209-04-01 in the phase's threat register), so the account itself
   must be hardened first.
2. Add the `flawchess.com` zone (dash.cloudflare.com → Add a site). Let Cloudflare
   scan and import the existing records.
3. **Diff the imported record set against the inventory file from Section 2.**
   Hand-add anything the scan missed — DNS scanners routinely miss `TXT` records
   with unusual names (`resend._domainkey`, `_dmarc`) or under-scan subdomains like
   `send.`.
4. **Every mail record stays DNS-only (grey cloud), with no exceptions:** apex MX,
   apex SPF TXT, `send.` MX, `send.` SPF TXT, `resend._domainkey` DKIM TXT, and
   `_dmarc` TXT. Proxying (orange cloud) only ever applies to the site records —
   the apex A/AAAA record and `www` if present. Cloudflare's proxy does not forward
   arbitrary DNS record types the way it forwards HTTP(S), so a proxied MX or TXT
   record is not just pointless but actively wrong.

## 4. SSL/TLS

Set the SSL/TLS mode to **Full (strict)** in Cloudflare → flawchess.com →
SSL/TLS → Overview. This is the locked choice (D-04) and a minted prohibition: a
mode that terminates TLS at the edge without validating the origin certificate
(Flexible, or Full without "strict") is not acceptable, because it would silently
downgrade the edge-to-origin leg to unauthenticated HTTP or an unvalidated
certificate (T-209-04-02).

Caddy keeps its existing auto-TLS behavior; HTTP-01 challenge validation continues
to pass through the Cloudflare proxy exactly as it did through any other
reverse-proxying intermediary, so no origin change is required for certificate
issuance or renewal to keep working. **If renewal ever fights the proxy** (e.g.
Cloudflare's own edge certificate interferes with HTTP-01 validation reaching the
origin), the documented fallback is to switch to a **Cloudflare origin
certificate** installed on Caddy instead of relying on Caddy's public ACME
issuance — this keeps Full (strict) intact rather than downgrading the TLS mode.

## 5. Cache Rule

Add exactly one Cache Rule:

- **Match:** `/maia/*` OR `/engine/*`
- **Then:** Cache eligibility → Eligible for cache
- **Edge TTL:** **"Respect origin headers"** — do NOT set an override TTL.

Location: Cloudflare → flawchess.com → Caching → Cache Rules.

Why an override TTL is wrong: `deploy/Caddyfile` already distinguishes two cases
under this path prefix and the edge must defer to both, verbatim:

- `@vendored_runtime` (`/maia/*` and `/engine/*`, excluding
  `/maia/maia-worker.js`): `Cache-Control: public, max-age=2592000` (30 days).
- `@maiaworker` (`/maia/maia-worker.js` specifically): `Cache-Control: no-cache`.
  This file is our own glue code, not content-hashed, and its message protocol
  changes with the app bundle — every deploy can change it. A blanket TTL override
  at the edge would cache this file anyway (it matches the same path prefix),
  serving a stale worker to every client until the override TTL expires, silently
  breaking the Maia integration for anyone who hits a cached copy
  (T-209-04-03). "Respect origin headers" is the only setting that reproduces the
  origin's own distinction between the two.

The 45.68 MB Maia model is comfortably under the Cloudflare free plan's 512 MB
per-file cache limit.

**No `deploy/Caddyfile` change is needed or permitted** for this step — the cache
rule works entirely by deferring to headers the origin already sends.

## 6. Verify BEFORE flipping nameservers

This is the one genuinely delicate step. During nameserver propagation, **both the
old (Swizzonic) and new (Cloudflare) authoritative sets answer simultaneously**
depending on which resolver a given query hits — so they must agree on every
record before the flip, not just after.

```bash
CF_NS=<assigned-cloudflare-ns-1>   # from the Cloudflare dashboard, e.g. ns1.cloudflare.com

dig @$CF_NS +short A flawchess.com
dig @$CF_NS +short AAAA flawchess.com
dig @$CF_NS +short A www.flawchess.com
dig @$CF_NS +short MX flawchess.com
dig @$CF_NS +short TXT flawchess.com
dig @$CF_NS +short MX send.flawchess.com
dig @$CF_NS +short TXT send.flawchess.com
dig @$CF_NS +short TXT resend._domainkey.flawchess.com
dig @$CF_NS +short TXT _dmarc.flawchess.com
```

Compare every line against the pre-flight file from Section 2. **Stop here if
anything differs** — do not proceed to Section 7 until the Cloudflare-side answers
match record-for-record (mail records match exactly; the proxied apex A/AAAA
record legitimately differs, since it now points at Cloudflare's anycast IPs
instead of the origin — that difference is expected and correct).

## 7. The flip

Change the authoritative nameservers for `flawchess.com` at the Swizzonic control
panel (flawchess.com → nameservers) from `dns1.swizzonic.ch` (and its pair) to the
Cloudflare-assigned pair from Section 6.

Propagation is not instantaneous — expect the change to take anywhere from minutes
to (rarely) 24-48 hours to fully propagate across all resolvers, governed by the
TTLs of the old records. **Leave the Swizzonic zone configuration intact and
unmodified** — do not delete or clear it. It is the rollback path (Section 9), and
a nameserver revert is only as fast as this zone still existing and being correct
when needed.

## 8. Post-cutover verification

Work through all of these; this is the acceptance gate for the checkpoint.

**Mail inventory, re-verified:**

```bash
NS=<assigned-cloudflare-ns-1>
OUT=cloudflare-cutover-postflight-$(date +%Y%m%d).txt

{
  echo "=== apex MX ==="
  dig @$NS +short MX flawchess.com
  echo "=== apex TXT (SPF) ==="
  dig @$NS +short TXT flawchess.com
  echo "=== send.flawchess.com MX ==="
  dig @$NS +short MX send.flawchess.com
  echo "=== send.flawchess.com TXT (SPF) ==="
  dig @$NS +short TXT send.flawchess.com
  echo "=== resend._domainkey.flawchess.com TXT ==="
  dig @$NS +short TXT resend._domainkey.flawchess.com
  echo "=== _dmarc.flawchess.com TXT ==="
  dig @$NS +short TXT _dmarc.flawchess.com
} | tee "$OUT"

diff cloudflare-cutover-preflight-*.txt "$OUT"
```

The mail-record lines must be byte-identical to the pre-flight file. Any diff on a
mail record is a stop-the-line failure — see Section 9.

**Password-reset email, end-to-end proof that apex DKIM survived:** request a
password reset for an operator-controlled account (`docs/email-resend-runbook.md`
has the full procedure) and confirm the email arrives. This is the one check that
proves DMARC alignment — and therefore DKIM — survived the cutover intact, not
just that the DNS record text matches.

**Cache behavior — the vendored runtime is served from edge cache:**

```bash
curl -sI https://flawchess.com/maia/maia3_simplified.onnx
curl -sI https://flawchess.com/maia/maia3_simplified.onnx
```

The **second** response must show `cf-cache-status: HIT` and must still carry
`cache-control: public, max-age=2592000` (the origin header, unaltered by the
edge).

```bash
curl -sI https://flawchess.com/engine/stockfish-18-lite-single.wasm
curl -sI https://flawchess.com/engine/stockfish-18-lite-single.wasm
```

Same expectation: the second fetch shows `cf-cache-status: HIT`.

**Cache behavior — the worker glue file is NOT cached:**

```bash
curl -sI https://flawchess.com/maia/maia-worker.js
```

Must show `cache-control: no-cache` and a `cf-cache-status` that is **NOT** `HIT`
(expect `DYNAMIC` or `BYPASS`, not `HIT`, `EXPIRED`, or `STALE`). **If this shows a
hit, the cache rule is too broad and must be narrowed before the item is accepted**
— re-check Section 5 (this is the outcome the "respect origin headers" TTL setting
exists specifically to prevent, and the plan's fallback assumption A3 flags this
exact check as unverified against live Cloudflare behavior).

**Site + API smoke check:**

```bash
curl -sI https://flawchess.com
curl -sI https://flawchess.com/api/health   # or any known-responding /api/ route
```

Both must return a successful status. Confirm `https://flawchess.com` also loads
correctly in a real browser and that the SSL/TLS mode still shows Full (strict)
with a valid certificate served (no browser warning).

## 9. Rollback

If any post-cutover check in Section 8 fails — especially a mail-record mismatch
or a missing password-reset email — revert the nameservers at Swizzonic back to
`dns1.swizzonic.ch` and its pair. This is why the Swizzonic zone was left intact
in Section 7.

The rollback is **slow, not instant** — it is governed by the same TTL propagation
window as the original flip, so expect the same delay before all resolvers pick up
the reverted authoritative set. **Watch mail during the rollback too**, not just
during the forward cutover: a resolver that has cached the Cloudflare answer will
keep using it until its TTL expires, so mail delivery can still transiently hit
whichever record set a given sender's resolver currently has cached.

## 10. Non-actions

- **No `deploy/Caddyfile` edit is part of this procedure.** The origin's
  `@vendored_runtime` and `@maiaworker` headers are already correct, and the
  Section 5 cache rule is written specifically to defer to them rather than
  replace them.
- **No deploy is required for this change.** It is entirely DNS and Cloudflare
  dashboard configuration; nothing in the application changes.
- **Deployments in general go through `bin/deploy.sh` via CI, never direct SSH**
  (CLAUDE.md) — unrelated to this procedure, but stated here so this document
  stays self-contained and does not imply an SSH step exists anywhere in it.

## Record of what was actually done

_Fill this section in during/after the cutover. Any deviation from the procedure
above — an extra record found during reconciliation, a different TTL choice, a
fallback to a Cloudflare origin certificate, an unexpected propagation delay —
belongs here so this document stays the durable truth of what the domain actually
looks like, not just what was planned._

- Date of cutover:
- Cloudflare nameserver pair assigned:
- Pre-flight inventory file:
- Post-flight inventory file:
- Deviations from the procedure above (or "None"):
- Password-reset email verification result:
- `maia3_simplified.onnx` second-fetch `cf-cache-status`:
- `stockfish-18-lite-single.wasm` second-fetch `cf-cache-status`:
- `maia-worker.js` `cf-cache-status` (must not be `HIT`):
