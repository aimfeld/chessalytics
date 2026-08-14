---
title: Cloudflare CDN cutover runbook
date: 2026-08-10
updated: 2026-08-11
context: operator procedure for putting a Cloudflare free-plan CDN in front of
  flawchess.com so the ~82 MB of vendored ML runtime (Maia ONNX model, onnxruntime-web
  builds, Stockfish wasm) stops being served off the origin's single NIC. Written as
  part of Phase 209 (Traffic-Surge Quick Wins), item 3 of SEED-146, D-04. This is
  operator-only work by explicit decision — no mutating DNS, registrar, or Cloudflare
  action has been performed by any agent. Read-only `dig` lookups were run during the
  2026-08-11 revision to verify live record state; those results are recorded below.
source: deploy/Caddyfile, docs/email-resend-runbook.md,
  .planning/phases/209-traffic-surge-quick-wins/209-CONTEXT.md (D-04),
  .planning/seeds/SEED-146-traffic-surge-readiness.md (item 3)
---

# Cloudflare CDN cutover runbook

This is the procedure for putting a free-plan Cloudflare CDN in front of
`flawchess.com` so the vendored ML runtime under `/maia/*` and `/engine/*` is served
from edge cache instead of the origin box's single NIC, while every mail record
(the Swizzonic mail exchanger, its client-autoconfiguration records, and the Phase
207 Resend record set) survives the nameserver move byte-for-byte.

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
mail records (apex MX/SPF, the mail-client autoconfiguration records, and the Phase
207 Resend set) must stay DNS-only (grey-clouded) for mail to keep working, which
means the origin IP remains discoverable through them at all times. No security
control — DDoS mitigation, WAF, origin concealment — is assumed or claimed from this
change. If that is ever wanted, it is a separate decision with its own trade-offs.

## 2. Pre-flight record inventory

Before touching anything, capture the current authoritative answers from
`dns1.swizzonic.ch` (today's authoritative nameserver for `flawchess.com`) to a
file. This file is both the reconciliation reference for the Cloudflare import and
the rollback record if anything needs to be reverted.

**The dig block below is a confirmation tool, not a discovery tool.** It can only
check names someone already thought to list, and `AXFR` against `dns1.swizzonic.ch`
is refused, so there is no way to enumerate the zone from outside. **The
authoritative enumeration is the Swizzonic control panel's own record list** (new
panel → DNS page for `flawchess.com`). Export or screenshot that full list first and
treat it as the source of truth; the dig block then verifies the records that are
known to be load-bearing. A guessed-name probe already turned up four CNAMEs and an
SRV record that the first version of this runbook did not know about — assume there
may be more.

The capture is split into two files on purpose. The **site block** records values
that are *supposed* to change at cutover (the apex and `www` move to Cloudflare
anycast), so it is a rollback reference only and is never diffed. The **mail block**
records values that must survive the cutover unchanged, and it is reproduced
verbatim in Section 9 so the two outputs diff clean.

```bash
NS=dns1.swizzonic.ch
STAMP=$(date +%Y%m%d)

# Site + registry state — rollback reference. NOT diffed after the cutover.
{
  echo "=== DS at .com registry (DNSSEC state, see Section 3) ==="
  dig @a.gtld-servers.net DS flawchess.com +norec +short
  echo "=== current NS delegation (rollback values) ==="
  dig @a.gtld-servers.net NS flawchess.com +norec +short
  echo "=== apex A ==="
  dig @$NS +short A flawchess.com
  echo "=== apex AAAA ==="
  dig @$NS +short AAAA flawchess.com
  echo "=== www A/AAAA/CNAME (if present) ==="
  dig @$NS +short A www.flawchess.com
  dig @$NS +short AAAA www.flawchess.com
  dig @$NS +short CNAME www.flawchess.com
} | tee "cloudflare-cutover-site-$STAMP.txt"
```

**The block below is reproduced verbatim in Section 9.** Only `$NS` and the output
filename differ there. If you edit one, edit both — the Section 9 `diff` is the
acceptance gate, and any wording or loop-breadth drift between the two makes it
report differences that are not real.

```bash
# Mail inventory — must be identical before and after. VERBATIM COPY IN SECTION 9.
{
  echo "=== apex MX ==="
  dig @$NS +short MX flawchess.com
  echo "=== apex TXT (SPF) ==="
  dig @$NS +short TXT flawchess.com
  echo "=== mail client autoconfiguration CNAMEs ==="
  for n in autoconfig autodiscover mail webmail smtp imap pop; do
    printf '%s: ' "$n"; dig @$NS +short CNAME $n.flawchess.com
  done
  echo "=== mail client autoconfiguration SRV ==="
  for s in _autodiscover._tcp _submission._tcp _submissions._tcp \
           _imaps._tcp _imap._tcp _pop3s._tcp; do
    printf '%s: ' "$s"; dig @$NS +short SRV $s.flawchess.com
  done
  echo "=== send.flawchess.com MX (Resend bounce) ==="
  dig @$NS +short MX send.flawchess.com
  echo "=== send.flawchess.com TXT (Resend SPF) ==="
  dig @$NS +short TXT send.flawchess.com
  echo "=== resend._domainkey.flawchess.com TXT (Resend DKIM, apex-level) ==="
  dig @$NS +short TXT resend._domainkey.flawchess.com
  echo "=== _dmarc.flawchess.com TXT ==="
  dig @$NS +short TXT _dmarc.flawchess.com
} | tee "cloudflare-cutover-mail-preflight-$STAMP.txt"
```

The CNAME and SRV loops deliberately probe names that probably do not exist. A name
with no record prints an empty line in both captures and diffs clean, so the wider
net costs nothing and catches a record nobody remembered.

Expected values, per the record set observed on 2026-08-11 and
`docs/email-resend-runbook.md`:

- Apex `A`: `178.104.89.1` (the origin box; matches the `HostName` for the
  `flawchess` entry in the operator's SSH config).
- Apex `NS`: `dns1.swizzonic.ch` / `dns2.swizzonic.ch`.
- Apex `TXT` (SPF): `v=spf1 a mx include:spf.webapps.net ~all` — never edited by
  this procedure or any other.
- Apex `MX`: `10 mx.swizzonic.email.` — Swizzonic-hosted mailbox service. Swizzonic
  support confirmed (2026-08-11) that the mailbox service itself survives a move to
  external nameservers; only the DNS records must be recreated at the new provider.
- **Mail client autoconfiguration records** — these break mail *clients* (not mail
  delivery) if lost, which is why the Section 9 checks alone would not catch it:
  - `autoconfig.flawchess.com` `CNAME` → `tb-ch.securemail.pro.`
  - `smtp.flawchess.com` `CNAME` → `smtp.swizzonic.email.`
  - `imap.flawchess.com` `CNAME` → `imap.swizzonic.email.`
  - `pop.flawchess.com` `CNAME` → `pop.swizzonic.email.`
  - `_autodiscover._tcp.flawchess.com` `SRV` → `10 10 443 ms-ch.securemail.pro.`
- `send.flawchess.com` `MX`: `feedback-smtp.<region>.amazonses.com`, priority 10
  (observed: `eu-west-1`).
- `send.flawchess.com` `TXT` (SPF): `v=spf1 include:amazonses.com ~all`.
- `resend._domainkey.flawchess.com` `TXT`: Resend's DKIM public key. **This is the
  load-bearing detail behind DMARC alignment for `noreply@flawchess.com`** — DKIM
  signs with `d=flawchess.com` at the apex, and losing this record silently breaks
  DMARC alignment and, in turn, password-reset delivery, with no obvious symptom
  until a user reports a missing email.
- `_dmarc.flawchess.com` `TXT`: `v=DMARC1; p=none; rua=mailto:<monitoring address>`.

Do not proceed without this file saved **and** the panel's full record list
exported.

## 3. DNSSEC teardown (start this first)

`flawchess.com` was DNSSEC-signed at the registry when this procedure was written.
A `DS` record in the `.com` zone tells validating resolvers to verify the zone's
answers against Swizzonic's keys. Cloudflare does not have those keys. **Flipping
nameservers while the DS is still published makes every validating resolver return
SERVFAIL for the entire zone** — website and mail both go dark simultaneously, and
the Section 10 rollback is TTL-bound and therefore slow. This is the
largest-blast-radius failure mode in the procedure and the one with the longest lead
time, which is why it is here rather than next to the flip.

Two clocks run in sequence, and both must finish before Section 8:

1. **Registrar → registry.** Swizzonic queues DNSSEC deactivation as a request
   (`Eine Anfrage vom Typ Deaktivieren DNSSEC wurde gefunden: Es ist nicht möglich,
   die Einstellungen zu ändern, bis die Anfrage abgeschlossen ist`) and locks other
   domain settings until it completes. No duration is stated or predictable —
   observed once at roughly 10 minutes, but do not plan on that. Poll the registry
   rather than waiting on the panel.
2. **DS TTL.** The `.com` DS record carries a TTL of **86400s (24h)**. A resolver
   that cached the DS immediately before removal keeps it that long, so the wait
   starts when the registry goes empty, not when the request is submitted.

Steps:

1. Record the current DS value into the Section 2 site file
   (`cloudflare-cutover-site-<date>.txt`; it is part of the rollback picture).
2. Disable DNSSEC: Swizzonic new panel → DNS page for **`flawchess.com`** → DNSSEC
   toggle off. Check the domain name in the page header — the account also holds
   `flawchess.ch` (a separate, differently-pointed domain), and its DNS page looks
   identical.
3. Poll the registry until the DS is gone:
   ```bash
   dig @a.gtld-servers.net DS flawchess.com +norec +short   # empty == removed
   ```
   Confirm against a second gTLD server (`m.gtld-servers.net`) and a few public
   resolvers (`1.1.1.1`, `8.8.8.8`, `9.9.9.9`). Resolver answers going empty is
   encouraging but not sufficient on its own — it only speaks for those resolvers.
4. **Wait a further 24h from the moment the registry went empty.** Sections 4-7 are
   unblocked during this window and should be done then; only Section 8 is gated.

**Expect a partial outage from the disable itself, and schedule it accordingly.**
The safe teardown order is remove-DS → wait out its TTL → *then* unsign the zone.
Swizzonic does both at once: within minutes of the request completing, the zone had
no `DNSKEY` and no `RRSIG` while resolvers still held the cached DS. Those resolvers
demand signatures from a zone that no longer has them and return **SERVFAIL** for
`flawchess.com` — website and mail — until their cached DS expires, up to 24h later.
This was observed on 2026-08-11: the origin kept serving 200, every public resolver
probed was clean, and the site was nonetheless unreachable from the operator's own
resolver. Symptoms and triage:

```bash
dig flawchess.com          # SERVFAIL from an affected resolver
dig flawchess.com +cd      # +cd disables validation — succeeds, confirming the cause
dig @1.1.1.1 flawchess.com # bypasses the affected resolver — succeeds
```

**Rebooting a local router usually does nothing**, and the TTL tells you why: if the
cached DS is served with a TTL that *counts down* between two queries a few seconds
apart, it is being aged by an upstream cache (the ISP resolver), and the local device
just re-inherits it. Only a resolver that fetches fresh from the registry gets the
correct empty answer.

```bash
dig @<local-resolver> DS flawchess.com +noall +answer   # run twice, compare the TTL
```

The remaining TTL is also the exact countdown to recovery for that resolver — during
this cutover the operator's ISP resolver read 26100s at 20:38, i.e. clear at ~03:53,
well before the 24h worst case.

There is no fix, only drainage: it clears within 24h of the DS leaving the registry.
Do not attempt to "repair" it by re-enabling DNSSEC — that republishes a DS against
keys that no longer sign the zone and makes matters strictly worse. Affected
operators can switch their own machine to `1.1.1.1` and flush local caches
(`resolvectl flush-caches`, plus a browser restart) to see the site meanwhile.

**Do not use the nameserver form's advertised shortcut.** Swizzonic's DNS
configuration page states `Jede DNS-Änderungsoperation deaktiviert automatisch
DnsSec` — any DNS change auto-disables DNSSEC. Disabling and flipping in the same
operation does not help: resolvers still holding the cached DS will validate the new
Cloudflare answers against keys nobody has, which is exactly the SERVFAIL scenario
above. The disable must be a separate, earlier action.

**Re-enabling afterwards is optional and separate, and must not happen during
propagation.** While delegation is still spreading, both nameserver sets answer:
some resolvers reach Cloudflare, others still reach Swizzonic's now-unsigned zone.
Publishing a new DS in that window makes every resolver in the second group
SERVFAIL — a fresh, self-inflicted outage on top of whatever is already draining.
It also does nothing for resolvers holding the *old* DS, which mismatches the new
one just as badly. Wait until all three are true: delegation resolves to Cloudflare
everywhere, the old DS has drained, and Section 9 is green. Then Cloudflare → DNS →
Settings → Enable DNSSEC produces a DS record to register at Swizzonic. It is not
part of this procedure.

## 4. Cloudflare setup

1. Create a free Cloudflare account with **2FA enabled** before adding anything —
   the nameserver delegation is the single highest-leverage credential for the
   whole domain (T-209-04-01 in the phase's threat register), so the account itself
   must be hardened first.
2. Add the `flawchess.com` zone (dash.cloudflare.com → Add a domain). Choose
   **"Connect a domain"**, not "Transfer a domain": connecting makes Cloudflare the
   authoritative DNS while registration stays at Swizzonic, which is all this
   procedure needs. Transferring moves the *registration* to Cloudflare Registrar —
   it costs a renewal year, locks the domain for 60 days, needs an auth code, and
   would compromise the Section 10 rollback, which depends on being able to revert
   nameservers at Swizzonic within minutes. Select the **Free** plan, then let
   Cloudflare scan and import the existing records.
3. **Diff the imported record set against the inventory file and the panel export
   from Section 2.** Hand-add anything the scan missed — DNS scanners routinely miss
   `TXT` records with unusual names (`resend._domainkey`, `_dmarc`), `SRV` records
   (`_autodiscover._tcp`), and under-scan subdomains like `send.`.
4. **Every mail record stays DNS-only (grey cloud), with no exceptions:** apex MX,
   apex SPF TXT, the `autoconfig` / `smtp` / `imap` / `pop` CNAMEs, the
   `_autodiscover._tcp` SRV, `send.` MX, `send.` SPF TXT, `resend._domainkey` DKIM
   TXT, and `_dmarc` TXT. Proxying (orange cloud) only ever applies to the site
   records — the apex A/AAAA record and `www` if present.

   Two distinct reasons, both worth stating: Cloudflare's proxy does not forward
   arbitrary DNS record types the way it forwards HTTP(S), so a proxied MX or TXT
   record is not just pointless but actively wrong. And **Cloudflare's importer
   tends to default CNAMEs to proxied** — a proxied `imap.flawchess.com` resolves to
   Cloudflare anycast IPs, which do not speak IMAP, so every mail client configured
   against that hostname stops connecting while mail delivery itself looks fine.
   Check the cloud icon on each of the four mail CNAMEs explicitly after import.

## 5. SSL/TLS

Set the SSL/TLS mode to **Full (strict)** in Cloudflare → flawchess.com →
SSL/TLS → Overview. This is the locked choice (D-04) and a minted prohibition: a
mode that terminates TLS at the edge without validating the origin certificate
(Flexible, or Full without "strict") is not acceptable, because it would silently
downgrade the edge-to-origin leg to unauthenticated HTTP or an unvalidated
certificate (T-209-04-02).

**The edge certificate is not instant, and its absence is an outage.** After the
flip, Cloudflare → SSL/TLS → Edge Certificates will show the Universal certificate
as **Pending Validation (TXT)** until domain control validation completes, which
cannot happen until the nameserver delegation has propagated widely enough for the
CA to see Cloudflare's DCV record. Until it goes **Active**, the edge has no
certificate to present for `flawchess.com` and every proxied request fails with a
TLS `handshake_failure` — while port 80 still issues a 308 to HTTPS, so the site is
simply down for anyone whose resolver has already moved to Cloudflare. Observed
once at roughly 20 minutes; it can take hours.

Mitigation while it provisions: **grey-cloud the apex `A` and `www`**. Both halves
of the propagating population then resolve to the origin and the site works
normally, with Caddy serving its own certificate. This does not stall issuance —
DCV is a DNS check against the zone Cloudflare is authoritative for, and proxy
status has no bearing on it. Re-proxy once the certificate reads Active, and
confirm Full (strict) is set *before* doing so: on Flexible, Caddy's HTTP→HTTPS
redirect becomes an infinite redirect loop.

Caddy keeps its existing auto-TLS behavior; HTTP-01 challenge validation continues
to pass through the Cloudflare proxy exactly as it did through any other
reverse-proxying intermediary, so no origin change is required for certificate
issuance or renewal to keep working. **If renewal ever fights the proxy** (e.g.
Cloudflare's own edge certificate interferes with HTTP-01 validation reaching the
origin), the documented fallback is to switch to a **Cloudflare origin
certificate** installed on Caddy instead of relying on Caddy's public ACME
issuance — this keeps Full (strict) intact rather than downgrading the TLS mode.

## 6. Cache configuration

### 6a. Zone-level Browser Cache TTL (do this first)

**Cloudflare → flawchess.com → Caching → Configuration → Browser Cache TTL →
"Respect Existing Headers".**

This is a zone-wide setting, separate from the cache rule below, and leaving it at
its default silently breaks the worker glue file. The default is **4 hours
(14400s)** and it behaves as a *floor*: any origin `Cache-Control` weaker than the
setting gets promoted to it, while anything stronger passes through untouched.
Observed live on 2026-08-11, before the setting was changed:

```
maia-worker.js   origin: cache-control: no-cache               (Caddyfile:43)
                 edge:   cache-control: max-age=14400          ← rewritten
onnx / wasm      origin: cache-control: public, max-age=2592000
                 edge:   cache-control: public, max-age=2592000  ← untouched
```

That rewrite is T-209-04-03 realized: browsers cache the non-content-hashed worker
for four hours, so a deploy can leave clients running a stale worker against a new
app bundle, silently breaking the Maia integration. **Leaving the cache rule's own
Browser TTL unset is not sufficient** — the zone default overrides independently of
the rule, and the edge-side `cf-cache-status` looks healthy while it happens, so
only an explicit header comparison catches it (Section 9).

### 6b. Cache Rule

Add exactly one Cache Rule:

- **Match:** custom filter expression (below)
- **Then:** Cache eligibility → Eligible for cache
- **Edge TTL:** leave unset — do NOT add an override TTL
- **Browser TTL:** leave unset — same reasoning

Location: Cloudflare → flawchess.com → Caching → Cache Rules.

The expression field takes the Cloudflare Rules language, not a path glob. Paste
exactly this (lowercase `or`; the language is Wireshark-style):

```
starts_with(http.request.uri.path, "/maia/") or starts_with(http.request.uri.path, "/engine/")
```

No hostname clause is needed — the rule is already scoped to the `flawchess.com`
zone.

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
  (T-209-04-03). Leaving both TTL settings unset is what makes the edge respect the
  origin's own distinction between the two — and leaving Browser TTL unset matters
  for the same file, since an override there would stomp the worker's `no-cache` on
  the client side.

The 45.68 MB Maia model is comfortably under the Cloudflare free plan's 512 MB
per-file cache limit.

**No `deploy/Caddyfile` change is needed or permitted** for this step — the cache
rule works entirely by deferring to headers the origin already sends.

## 7. Verify BEFORE flipping nameservers

This is the one genuinely delicate step. During nameserver propagation, **both the
old (Swizzonic) and new (Cloudflare) authoritative sets answer simultaneously**
depending on which resolver a given query hits — so they must agree on every
record before the flip, not just after.

```bash
CF_NS=<assigned-cloudflare-ns-1>   # from the Cloudflare dashboard

dig @$CF_NS +short A flawchess.com
dig @$CF_NS +short AAAA flawchess.com
dig @$CF_NS +short A www.flawchess.com
dig @$CF_NS +short MX flawchess.com
dig @$CF_NS +short TXT flawchess.com
dig @$CF_NS +short CNAME autoconfig.flawchess.com
dig @$CF_NS +short CNAME smtp.flawchess.com
dig @$CF_NS +short CNAME imap.flawchess.com
dig @$CF_NS +short CNAME pop.flawchess.com
dig @$CF_NS +short SRV _autodiscover._tcp.flawchess.com
dig @$CF_NS +short MX send.flawchess.com
dig @$CF_NS +short TXT send.flawchess.com
dig @$CF_NS +short TXT resend._domainkey.flawchess.com
dig @$CF_NS +short TXT _dmarc.flawchess.com
```

Compare every line against Section 2's two capture files — mail records against
`cloudflare-cutover-mail-preflight-<date>.txt`, the apex and `www` against
`cloudflare-cutover-site-<date>.txt`. **Stop here if anything differs** — do not
proceed to Section 8 until the Cloudflare-side answers match record-for-record
(mail records match exactly; the proxied apex A/AAAA record legitimately differs,
since it now points at Cloudflare's anycast IPs instead of the origin — that
difference is expected and correct).

This is an eyeball comparison, not the Section 9 `diff`: these queries hit
Cloudflare directly by IP before delegation has moved, so they are shaped for
reading rather than for byte-comparison.

## 8. The flip

**Gate:** do not start this section until Section 3's 24h DS wait has elapsed and
Section 7 passes.

Location at Swizzonic: classic control panel → **DOMAIN und DNS** → **DNS-Konfiguration**
→ *Autoritative DNS der Domain verwalten: ändern Sie die für die Domainauflösung
verwendeten Nameserver*. Do not use *Domains transferieren* or *AuthInfo-Code* —
those are the registrar-transfer path ruled out in Section 4.

**Record the outgoing values before overwriting them.** These are what Section 10
needs typed back in:

```
DNS1  dns1.swizzonic.ch  81.88.61.5
DNS2  dns2.swizzonic.ch  81.88.58.219
```

Replace them with the Cloudflare-assigned pair from Section 7.

**Glue IP fields.** The form has an IP column beside each hostname. Leave it blank:
glue records are only needed when a nameserver lives inside the domain it serves
(`ns1.flawchess.com` serving `flawchess.com`), and Cloudflare's nameservers live in
`cloudflare.com`, which any resolver can look up independently. If the form rejects
a blank field (observed: `Falsches IP Format`), pair each Cloudflare hostname with
one of *its own* resolved A records — never leave the Swizzonic IPs sitting beside
Cloudflare hostnames, which would publish mismatched glue pointing a Cloudflare
nameserver at a Swizzonic address. Cloudflare returns several rotating anycast IPs
per nameserver, and the `.com` registry discards glue for out-of-bailiwick
nameservers, so treat any value entered here as satisfying the form rather than as
something that will be published — and verify that in Section 9.

Propagation is not instantaneous — expect the change to take anywhere from minutes
to (rarely) 24-48 hours to fully propagate across all resolvers, governed by the
TTLs of the old records. **Leave the Swizzonic zone configuration intact and
unmodified** — do not delete or clear it. It is the rollback path (Section 10), and
a nameserver revert is only as fast as this zone still existing and being correct
when needed.

## 9. Post-cutover verification

Work through all of these; this is the acceptance gate for the checkpoint.

**Delegation and glue:**

```bash
dig @a.gtld-servers.net NS flawchess.com +norec
```

The AUTHORITY section must list the two Cloudflare nameservers. The ADDITIONAL
section must be empty of glue or show Cloudflare addresses — any `81.88.x.x` there
means the registrar published bad glue from the Section 8 form and needs a support
ticket.

**Mail inventory, re-verified:**

**This block is a verbatim copy of the Section 2 mail block** — only `$NS` and the
output filename differ. Do not "improve" it here: any wording or loop-breadth drift
from Section 2 shows up as a phantom difference and destroys the value of the
`diff`. Do not capture the site records here either; those are supposed to have
changed, and Section 2 keeps them in a separate file for exactly that reason.

```bash
NS=<assigned-cloudflare-ns-1>
STAMP=$(date +%Y%m%d)

# Mail inventory — must be identical before and after. VERBATIM COPY OF SECTION 2.
{
  echo "=== apex MX ==="
  dig @$NS +short MX flawchess.com
  echo "=== apex TXT (SPF) ==="
  dig @$NS +short TXT flawchess.com
  echo "=== mail client autoconfiguration CNAMEs ==="
  for n in autoconfig autodiscover mail webmail smtp imap pop; do
    printf '%s: ' "$n"; dig @$NS +short CNAME $n.flawchess.com
  done
  echo "=== mail client autoconfiguration SRV ==="
  for s in _autodiscover._tcp _submission._tcp _submissions._tcp \
           _imaps._tcp _imap._tcp _pop3s._tcp; do
    printf '%s: ' "$s"; dig @$NS +short SRV $s.flawchess.com
  done
  echo "=== send.flawchess.com MX (Resend bounce) ==="
  dig @$NS +short MX send.flawchess.com
  echo "=== send.flawchess.com TXT (Resend SPF) ==="
  dig @$NS +short TXT send.flawchess.com
  echo "=== resend._domainkey.flawchess.com TXT (Resend DKIM, apex-level) ==="
  dig @$NS +short TXT resend._domainkey.flawchess.com
  echo "=== _dmarc.flawchess.com TXT ==="
  dig @$NS +short TXT _dmarc.flawchess.com
} | tee "cloudflare-cutover-mail-postflight-$STAMP.txt"

diff cloudflare-cutover-mail-preflight-*.txt cloudflare-cutover-mail-postflight-*.txt
```

**The `diff` must be empty.** Not "empty apart from the headers", not "empty apart
from a trailing newline" — empty. Every line the two captures produce is either a
record that must survive the cutover or a section label that is identical by
construction, so there is no such thing as an expected difference here. Any output
at all is a stop-the-line failure; see Section 10.

**Outbound mail — password-reset email, end-to-end proof that apex DKIM survived:**
request a password reset for an operator-controlled account
(`docs/email-resend-runbook.md` has the full procedure) and confirm the email
arrives. This is the one check that proves DMARC alignment — and therefore DKIM —
survived the cutover intact, not just that the DNS record text matches.

**Inbound mail — proof the Swizzonic mailbox still receives.** Send a message from
an external account (not `@flawchess.com`) to the mailbox served by
`mx.swizzonic.email` and confirm it arrives. The password-reset check above only
exercises *outbound* mail via Resend and would pass even if inbound delivery were
broken. Then open the mailbox in a real mail client to confirm the `imap.` / `smtp.`
CNAMEs still resolve and connect — a proxied CNAME (Section 4, step 4) breaks the
client while leaving delivery untouched, so neither check substitutes for the other.

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

**Cache behavior — the worker glue file is NOT served stale:**

```bash
curl -sI https://flawchess.com/maia/maia-worker.js
```

Two separate things must both hold, and they fail independently:

**The `cache-control` header must still read `no-cache`.** If it comes back as
`max-age=14400` (or any other `max-age`), the zone's Browser Cache TTL is
overriding the origin — go fix Section 6a. This is the check that actually caught
the defect on 2026-08-11, and nothing else would have: the edge-side status looked
correct throughout. Compare the two sides directly rather than trusting the edge
alone:

```bash
curl -sI --resolve flawchess.com:443:<origin-ip> https://flawchess.com/maia/maia-worker.js | grep -i cache-control
curl -sI https://flawchess.com/maia/maia-worker.js | grep -i cache-control
```

The two lines must be identical.

**The `cf-cache-status` must NOT be `HIT`, `EXPIRED`, or `STALE`.** `DYNAMIC`,
`BYPASS`, and `REVALIDATED` all pass: `Cache-Control: no-cache` means "may store,
must revalidate", so `REVALIDATED` is the origin being contacted and freshness
confirmed, which is correct behavior rather than a failure (this is what the live
zone returns). **If this shows a plain `HIT`, the cache rule is too broad and must
be narrowed before the item is accepted** — re-check Section 6b (this is the
outcome the unset-TTL settings exist specifically to prevent, and the plan's
fallback assumption A3 flags this exact check as unverified against live Cloudflare
behavior).

**Site + API smoke check:**

```bash
curl -sI https://flawchess.com
curl -sI https://flawchess.com/api/health   # or any known-responding /api/ route
```

Both must return a successful status. Confirm `https://flawchess.com` also loads
correctly in a real browser and that the SSL/TLS mode still shows Full (strict)
with a valid certificate served (no browser warning).

## 10. Rollback

If any post-cutover check in Section 9 fails — especially a mail-record mismatch, a
missing password-reset email, or undelivered inbound mail — revert the nameservers
at Swizzonic to the values recorded in Section 8 (`dns1.swizzonic.ch` /
`dns2.swizzonic.ch`). This is why the Swizzonic zone was left intact in Section 8.

The rollback is **slow, not instant** — it is governed by the same TTL propagation
window as the original flip, so expect the same delay before all resolvers pick up
the reverted authoritative set. **Watch mail during the rollback too**, not just
during the forward cutover: a resolver that has cached the Cloudflare answer will
keep using it until its TTL expires, so mail delivery can still transiently hit
whichever record set a given sender's resolver currently has cached.

DNSSEC stays off through a rollback. Re-signing is a separate decision to revisit
only once the domain is stable on whichever nameservers it ends up on.

## 11. Non-actions

- **No `deploy/Caddyfile` edit is part of this procedure.** The origin's
  `@vendored_runtime` and `@maiaworker` headers are already correct, and the
  Section 6 cache rule is written specifically to defer to them rather than
  replace them.
- **No deploy is required for this change.** It is entirely DNS and Cloudflare
  dashboard configuration; nothing in the application changes.
- **No registrar transfer.** Registration stays at Swizzonic (Section 4, step 2).
- **Deployments in general go through `bin/deploy.sh` via CI, never direct SSH**
  (CLAUDE.md) — unrelated to this procedure, but stated here so this document
  stays self-contained and does not imply an SSH step exists anywhere in it.

## Record of what was actually done

_Fill this section in during/after the cutover. Any deviation from the procedure
above — an extra record found during reconciliation, a different TTL choice, a
fallback to a Cloudflare origin certificate, an unexpected propagation delay —
belongs here so this document stays the durable truth of what the domain actually
looks like, not just what was planned._

**DNSSEC teardown (Section 3):**

- DNSSEC deactivation requested at Swizzonic: 2026-08-11
- DS value removed: `51402 13 2 93FCBB549706E92BB7AD7A2500D56CB6AF979FE39EE3BCE84AC7F196BA4E2231`
- DS confirmed gone from the `.com` registry: 2026-08-11 19:53 (request-to-registry
  took roughly 10 minutes)
- Swizzonic unsigned the zone at the same time (no `DNSKEY`, no `RRSIG`), causing
  the SERVFAIL-for-stale-DS-resolvers outage described in Section 3. Site
  unreachable from the operator's resolver while the origin served 200 throughout.
  Drains by 2026-08-12 ~19:55.
- DNSSEC left off through the cutover itself: **yes**, deliberately.
- DNSSEC re-enabled on Cloudflare afterwards: **yes**, 2026-08-13, once all three
  Section 3 gates were met (delegation stable on Cloudflare, old DS fully drained,
  Section 9 green). Cloudflare signs with algorithm 13 (ECDSAP256SHA256). The KSK
  published at enable time yields DS key tag `2371`, digest type 2 (SHA-256),
  `8C644680A5F6A8A21642EE32AA004673632B6A8F5C671311C113130AE1FA67F4` — computed
  independently from the zone's published `DNSKEY`, so it can be checked against
  both the Cloudflare panel and whatever ends up at the registry.
- Registry publication of the DS is **not instant** (Cloudflare warns up to an
  hour). Until the DS appears in `.com`, the zone is signed but the delegation is
  insecure: resolvers see RRSIGs, have no trust anchor, and treat the zone as
  unsigned. Nothing breaks in that window — verified 2026-08-13 with 1.1.1.1,
  8.8.8.8, 9.9.9.9 and the local resolver all answering normally while the DS was
  still absent.
- **Cloudflare cannot publish the DS for a domain registered elsewhere.** Its
  "DNSSEC is pending while we wait for the DS to be added to your registrar"
  message means it is polling the registry, not working a queue — the panel will
  sit there indefinitely until someone enters the DS at Swizzonic by hand.
  Cloudflare does publish `CDS`/`CDNSKEY` (RFC 7344/8078) for automated pickup, and
  the `CDS` matched the independently computed DS exactly, but `.com` leaves CDS
  scanning to the registrar and Swizzonic does not appear to do it. Entering the DS
  manually was required.
- **DS live and chain validating: 2026-08-13.** Confirmed at both `a.gtld-servers.net`
  and `m.gtld-servers.net`, matching the computed value. `delv @1.1.1.1
  flawchess.com A` reports `; fully validated`; the `ad` flag is set by 1.1.1.1,
  8.8.8.8 and 9.9.9.9; signed negative answers validate; every mail record still
  resolves and the site returns 200.
- Expect a lag of up to the record TTL (300s here) before a given resolver sets
  `ad`, because one that cached an answer as *insecure* just before the DS landed
  keeps serving it that way until expiry. Observed on 9.9.9.9: the apex answer had
  276s remaining and showed no `ad`, while an uncached name under the same zone
  validated immediately. Not a fault, and it clears itself.
- The failure mode to watch for is the reverse of the teardown: a strict validator
  (9.9.9.9) going quiet while a lenient one still answers means the chain is broken,
  and the DS should be pulled at Swizzonic immediately rather than waited out.

**Cutover:**

- Date of cutover: 2026-08-11, ~20:00
- Cloudflare nameserver pair assigned: `julissa.ns.cloudflare.com` /
  `tate.ns.cloudflare.com`
- Glue IP fields: the form rejected blanks with `Falsches IP Format`, so each
  hostname was paired with one of its own A records (`172.64.34.105`,
  `172.64.35.191`). The registry published Cloudflare's own addresses; no
  `81.88.x.x` glue appeared.
- Delegation + glue verified at `a.gtld-servers.net`: yes, both Cloudflare
  nameservers in AUTHORITY, clean ADDITIONAL
- **Deviations from the procedure above:**
  1. The flip was submitted the same evening, **before** the 24h DS wait had
     elapsed and before Section 7 verification had been run. In this instance it
     caused no additional DNSSEC harm — the zone was already unsigned with the DS
     already withdrawn, so the stale-DS population was failing regardless of which
     nameservers answered — but that was luck, not design. The gate stands.
  2. Universal SSL sat at **Pending Validation (TXT)** from the flip until 20:06,
     during which every proxied request failed with TLS `handshake_failure` while
     port 80 still 308'd to HTTPS. Certificate issued at 20:06 (`CN=flawchess.com`,
     Google Trust Services WE1). This is now written up in Section 5 with the
     grey-cloud mitigation.
  3. Zone-level **Browser Cache TTL** was at its 4-hour default and rewrote the
     worker glue file's `no-cache` to `max-age=14400`. Switched to "Respect
     Existing Headers" and re-verified. Now Section 6a.
  4. All four mail CNAMEs (`autoconfig`, `smtp`, `imap`, `pop`) came out of the
     import **proxied**, returning Cloudflare anycast addresses instead of their
     targets. Caught by comparing against Swizzonic rather than by any check of the
     website, which stayed green throughout. Set to DNS-only and re-verified. This
     is why Section 4 step 4 says to check the cloud icon on each CNAME explicitly.
  5. The `_autodiscover._tcp` SRV record was first re-created at the **apex**
     (`flawchess.com. IN SRV 10 10 443 ms-ch.securemail.pro.`) rather than under
     `_autodiscover._tcp`, because the current Cloudflare SRV form has a single
     Name field instead of separate Service/Protocol fields. Priority, weight,
     port, and target were all correct; only the owner name was wrong, so the
     record resolved nowhere. Fixed by setting Name to `_autodiscover._tcp`.
     A dashboard record count alone would not have caught this — only a `dig` at
     the fully-qualified service name does.
- Pre-flight inventory file:
- Panel record-list export:
- Post-flight inventory file:

**Mail verification (Section 9):**

- **DNS-level reconciliation: PASS** (2026-08-11). Every mail record answered by
  Cloudflare matches `dns1.swizzonic.ch` byte-for-byte — apex MX and SPF TXT, the
  four autoconfiguration CNAMEs, the `_autodiscover._tcp` SRV, `send.` MX and SPF
  TXT, the Resend DKIM key, and `_dmarc`. The only differing records are the three
  proxied site records (`flawchess.com`, `www`, `analytics`), which is expected.
- Password-reset (outbound) email verification result: **pass** (2026-08-13).
- Inbound mail to the Swizzonic mailbox verification result: **pass** (2026-08-13) —
  mail to `support@flawchess.com` arrives, and replies send.
- IMAP/SMTP client connection via `imap.` / `smtp.` CNAMEs: **pass** (2026-08-13),
  verified by TLS handshake rather than a configured client. All four ports connect
  with valid certificates: `imap.` :993, `pop.` :995, `smtp.` :465 and :587.

Two mail findings from that verification are **pre-existing Swizzonic behavior, not
cutover damage.** Both were checked against `dns1.swizzonic.ch`, which still serves
the old zone, so the comparison is direct rather than inferred:

1. **Outbound mail from the Swizzonic mailbox is not DKIM-signed, so DMARC fails on
   any forwarded copy.** A reply from `support@flawchess.com` that is forwarded (a
   Sieve redirect, in the observed case) arrives with `dmarc=fail`, because SRS
   rewrites the envelope sender to the forwarder's domain and SPF then aligns to
   that domain instead of `flawchess.com` — with no DKIM signature to fall back on.
   This is not a lost record: probing 18 candidate selectors against the old
   Swizzonic zone and against Cloudflare found **no DKIM selector on either side**.
   The only DKIM key the domain has ever had is `resend._domainkey`, which covers
   Resend's transactional mail and is intact. Direct (unforwarded) mail from the
   mailbox still passes DMARC via SPF: the outbound host `81.88.49.227` is covered
   by `81.88.49.224/27` in `spf2.webapps.net`. DMARC is `p=none`, so nothing is
   rejected either way. Fixing it would mean asking Swizzonic to sign outbound for
   the domain and publishing their selector — out of scope here.
2. **The `imap.` / `smtp.` / `pop.` CNAMEs do not match the certificates their
   targets present.** `smtp.swizzonic.email` serves a cert for
   `smtp.mail.webnode.com` + `*.securemail.pro`; `imap.swizzonic.email` serves
   `*.securemail.pro`. Neither covers `*.flawchess.com` *or* `*.swizzonic.email`, so
   a strict client pointed at either name gets a name mismatch. The only hostnames
   that validate are the `*.securemail.pro` ones, which is what the `autoconfig`
   CNAME (`tb-ch.securemail.pro`) hands out. The CNAME targets and their
   certificates are untouched by this procedure, so this predates the cutover.

One genuine cutover side effect, low impact: the apex SPF record's `a` mechanism now
resolves to Cloudflare's anycast addresses (`188.114.96.12` / `188.114.97.12`)
instead of the origin `178.104.89.1`, because the apex is proxied. Nothing sends
mail directly from the origin — the app sends through Resend and aligns via DKIM —
so no delivery path depends on it. It does mean the record authorizes shared
Cloudflare addresses rather than a box under our control. Dropping `a` from the SPF
record is a reasonable cleanup, but it is a change to a working mail setup and
should not be bundled into a cutover.

**Cache verification (Section 9), measured 2026-08-11 after the 6a fix:**

- `maia3_simplified.onnx`: `MISS` → `HIT` → `HIT`, `cache-control: public,
  max-age=2592000` preserved
- `stockfish-18-lite-single.wasm`: `MISS` → `HIT` → `HIT`, same header preserved
- `maia-worker.js`: `cache-control: no-cache` (matches origin),
  `cf-cache-status: REVALIDATED` — passing
- Apex and `www` proxied (`172.67.194.196` / `104.21.20.236`); `https://flawchess.com`
  and `/api/health` both 200 through the edge; origin 200 direct
