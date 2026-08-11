# Phase 209: Traffic-Surge Quick Wins - Context

**Gathered:** 2026-08-10 (in-conversation scoping with the operator; no separate discuss-phase round)
**Status:** Ready for planning

<domain>
## Phase Boundary

The quick-win cut of SEED-146: make a sudden traffic spike (YouTube mention, Show HN,
press) unable to take the *whole site* down through any cheap-to-fix bottleneck. The
operator's selection criterion, verbatim intent: "I only want to implement quick-wins and
not overprepare for a surge spike which might never come. But it would be bad to lose many
users in such a spike event, if we could have prevented it easily by fixing an obvious
bottleneck beforehand."

Five work items: readiness-poll backoff + duration cap, one `to_thread` around the
password hash in our own service code, a CDN in front of the vendored ML runtime
(operator DNS work), a global import-concurrency cap with a visible bare "queued" state,
and a semaphore on the post-import percentile computes.

Survival, not throughput. No migration expected. The seed
(`.planning/seeds/SEED-146-traffic-surge-readiness.md`) carries measured facts verified
2026-08-10 — do not re-derive them — plus one **correction block** (also dated 2026-08-10)
that supersedes its item-2 funnel claim; see D-02.

</domain>

<decisions>
## Implementation Decisions

Decision index (details in the sections below):

- **D-01:** Quick-win cut only — register/login hashing, queue position/ETA UX, and all of seed item 6 are deferred by operator decision 2026-08-10.
- **D-02:** Argon2 correction — guest creation never hashes; `to_thread` wraps only `promote_guest_with_password` (`guest_service.py:94`).
- **D-03:** Item 4 thin slice — global import semaphore + bare "queued" state + reaper exemption; no position/ETA; outbound rate limiters untouched.
- **D-04:** CDN via Cloudflare free in front of the existing domain — operator-only DNS work, planned as checkpoint/runbook; mail records survive DNS-only.
- **D-05:** Readiness poll — frontend-first backoff + total-duration cap; the emitted interval sequence is the tested artifact.
- **D-06:** Percentile compute gate — `Semaphore(2–3)` covering `compute_stage_a`/`compute_stage_b`.
- **D-07:** Mutation-test discipline — every production change proven by revert-goes-red.

### D-01: Quick-win cut only (operator decision 2026-08-10, do not re-open)

Scope is seed items 1, 2 (our-code half), 3, 5, plus a THIN slice of item 4. Explicitly
deferred, and not to be scope-crept back in during planning or execution:

- Register/login async hashing (`UserManager` override, M-sized) — see D-02 for why this
  deferral got *stronger* after the correction.
- Queue position numbers + ETA display (the seed's "agreed UX" for item 4).
- All of seed item 6: `to_thread` PGN parse, `uvicorn --workers`, API rate limiting.
- Web Push as the readiness signal (rejected in the seed), staging/load-test rig
  (rejected), Postgres tuning (not the bottleneck), analysis/eval throughput (out of
  scope by seed design).

### D-02: Argon2 correction — guest CREATION never hashes (verified in code 2026-08-10)

The seed's item-2 funnel claim is wrong and carries a dated correction block.
Verified facts the plan must be written against:

- `POST /auth/guest/create` → `create_guest_user` (`app/routers/auth.py:319` →
  `app/services/guest_service.py:26`) writes `hashed_password=""` — **zero hashing cost**
  on the "Use as Guest" button. The seed's "100 clicks ≈ 6.6 s frozen loop" scenario does
  not exist.
- The 65.9 ms `_password_helper.hash(password)` call at `guest_service.py:94` is in
  `promote_guest_with_password`, reached from `POST /auth/guest/promote/email`
  (`auth.py:511`).
- **The fix:** `await asyncio.to_thread(...)` around that one call. Nothing else.
- Register/login hash inside fastapi-users (`BaseUserManager.create()` /
  `authenticate()`; `PasswordHelperProtocol` methods are sync, a custom password helper
  cannot fix it) and stay untouched. Hashing load is proportional to
  register/login/promotion volume, far below guest-click volume in a spike, so this
  deferral is comfortable, not risky.
- Tuning Argon2 cost parameters downward is a security trade and NOT the plan (seed).

### D-03: Item 4 thin slice — semaphore + bare "queued", nothing more

- A global concurrency cap on import execution (`asyncio.Semaphore`, module-level,
  same pattern family as `app/core/rate_limiters.py`).
- A visible "queued" job state the frontend can render — bare label only. NO queue
  position number, NO ETA math ("#37, starting in ~8 minutes" is the deferred medium
  feature). Silent stalling and spurious failure are both unacceptable; a plain
  "Import queued — starting shortly" is the whole UX.
- **Reaper exemption is load-bearing:** a job waiting on the semaphore past
  `IMPORT_TIMEOUT_SECONDS` (3 h) must NOT be marked failed by the periodic orphan reaper
  while its task is alive and queued. Either start the timeout clock at slot acquisition
  or exempt the queued state — planner's choice, but it must be mutation-tested.
- **Do not remove or loosen `CHESSCOM_SEMAPHORE_LIMIT` / `LICHESS_SEMAPHORE_LIMIT` (= 3)**
  in `app/core/rate_limiters.py` — they keep ~6 imports actively buffering instead of 100
  and are load-bearing for the 4 GB backend memory limit (historical OOM cause).
  — **Reversibility:** the new global cap is one-way-ish only in its user-visible
  "queued" state; the semaphore itself is trivially removable.

### D-04: CDN approach — Cloudflare free plan in front of the existing domain (operator work)

The only variant that keeps the seed's "DNS, not code" sizing. Locked approach:

- Cloudflare free account, add `flawchess.com`, import existing Swizzonic-hosted records
  (authoritative today: `dns1.swizzonic.ch`).
- **Mail records must survive exactly and stay DNS-only (grey-cloud):** apex MX/SPF
  (`v=spf1 a mx include:spf.webapps.net ~all`, Swizzonic MX) plus Phase 207's Resend set
  (`send.` MX + SPF TXT, `resend._domainkey` DKIM at apex level, `_dmarc`). Re-verify
  with `dig` against Cloudflare after cutover and send a test email. This is the one
  genuinely delicate step.
- Nameserver switch at Swizzonic → Cloudflare pair. Proxy (orange-cloud) the site record.
- SSL/TLS mode **Full (strict)**. Caddy keeps auto-TLS (HTTP-01 passes through the
  proxy); fallback if renewal ever fights the proxy is a Cloudflare origin certificate.
- Cache Rule for `/maia/*` and `/engine/*`: cache-eligible, Edge TTL **"respect origin
  headers"** — honors the existing 30-day `max-age` on `@vendored_runtime` AND the
  `no-cache` on `@maiaworker` (`/maia/maia-worker.js`) with zero Caddyfile changes. Do
  not blanket-cache `/maia/*` with a TTL override.
- The 45.68 MB model is under the free plan's 512 MB per-file cache limit.
- **This is operator work.** The plan may include it only as a checkpoint/runbook task
  (`checkpoint:human` or equivalent); it must not block the code plans, and no executor
  may attempt DNS changes.
  — **Reversibility:** nameserver move is revertible but slow (TTL propagation); treat
  the cutover as a one-way door needing operator presence.

### D-05: Readiness poll — frontend-first, interval sequence is the tested artifact

- `frontend/src/hooks/useReadiness.ts`: keep 3 s cadence while `tier1` is false (import
  phase, seconds-to-minutes); once `tier1` is true and only `tier2` is outstanding, back
  off hard (exponential decay); cap total poll duration so a tab open for hours goes
  quiet. Exact curve and cap are planner/executor discretion (see below).
- Optionally stop at tier1 for the surge-relevant UI and let tier2 surfaces refresh on
  next navigation — acceptable if it simplifies, not required.
- Cheapen `GET /imports/readiness` (`app/routers/imports.py:216`, `count_pending_evals`)
  ONLY if trivial while in there; the poll fix must not depend on backend changes.
- **The test asserts the emitted interval sequence itself** (fake timers), not the
  existence of a backoff constant — a backoff that silently never engages type-checks
  perfectly (`tsc`/eslint/knip are all blind to it). Reverting the backoff must turn the
  test red.

### D-06: Percentile compute gate

`asyncio.Semaphore(2–3)` (exact value discretionary) around the per-import-completion
`compute_stage_a` / `compute_stage_b` fires at `app/services/import_service.py:716` —
the 1,111.7 ms query at the top of `pg_stat_statements` must never hold more than
2–3 of the 20 pooled connections at once under burst completions.

### D-07: Mutation-test discipline (per `feedback_mutation_test_gap_closures`)

Every production change in this phase is proven by reverting it and confirming a test
goes red — never by symbol presence, grep, or type-checking. Applies to: the poll
backoff (interval sequence), the `to_thread` wrapper, the import cap + queued state +
reaper exemption, and the percentile semaphore. The CDN item is exempt (operator-verified
by response headers instead).

### Claude's Discretion

- Exact backoff curve, decay factor, and total-duration cap values for the poll.
- Exact global import cap value (seed analysis suggests low single digits given the
  outbound limiters already gate at 3 per platform).
- Percentile semaphore size within 2–3.
- Wire format of the "queued" state (new job status enum value vs. derived flag) and its
  frontend rendering, provided it is a bare label with no position/ETA.
- Test file placement and structure, following existing patterns.

</decisions>

<deferred_ideas>
## Deferred Ideas (recorded, not planned)

- Register/login async hashing via `UserManager.create()`/`authenticate()` override —
  first pickup if a spike becomes concretely plausible.
- Queue position + ETA UX for imports (seed item 4's full feature).
- Seed item 6 wholesale: `to_thread` PGN parse, `uvicorn --workers` (blocked on
  per-process module state), API rate limiting.
</deferred_ideas>
