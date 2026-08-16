---
id: SEED-148
status: closed
closed: 2026-08-16
closed_by: quick task 260816-i4m (.planning/quick/260816-i4m-sentry-signal-hygiene-and-small-prod-fix/)
planted: 2026-08-15
planted_during: Sentry unresolved-issue triage (15 open issues reviewed against code)
trigger_when: any milestone with appetite for a small observability/cleanup track, or the
  next time a real production bug is hard to triage because the Sentry issue list is noisy
scope: small — four independent fixes, each ~15-60 min. No migration, no schema change, no
  product surface. Items 1-3 are config/instrumentation; item 4 is a one-line frontend guard.
  Can ship as a single `/gsd-quick`, or item by item.
---

# SEED-148: Sentry signal hygiene — stop dev noise, add missing triage context, guard the Maia WebGPU teardown

## Why This Matters

A 2026-08-15 sweep of the 15 unresolved Sentry issues found that **8 of them are not
production bugs at all**: local-dev events from a laptop, third-party analytics code, and
deliberate `capture_message` telemetry. The two genuinely actionable production issues in
the list (FLAWCHESS-96 / FLAWCHESS-5E, both → SEED-042) were 3 and 74 events respectively,
sitting below noise that has no fix.

The cost is not quota. It is that **the issue list stops being a place you can look**. The
one issue with the highest event count in the whole project (FLAWCHESS-64, 55 events)
currently **cannot be triaged at all** because the events don't record which request failed.
Each item below either removes a category of non-signal or restores missing signal.

Split from the SEED-042 triage deliberately: those two issues share a real root cause and a
real fix; these four share only the moment they were found.

## The Four Items

### 1. Gate Sentry init on environment (removes 4 issues, prevents the class)

`app/main.py:209` and `scripts/remote_eval_worker.py:1426` both initialize Sentry on
`if settings.SENTRY_DSN:` with **no environment check**. The dev `.env` carries the DSN, so
the local backend and the local 4-worker box ship their errors to production Sentry.

What that produced:
- **FLAWCHESS-8X + FLAWCHESS-8N** (24 events) — `InvalidStateError: invalid state` in
  `chess.engine`, with a `KeyboardInterrupt` as the chained cause. This is Ctrl-C on the
  local worker, nothing more. Grouped into two separate issues, so it costs two list slots.
- **FLAWCHESS-8Y** (5 events) — remote eval worker transient-failure threshold, `environment:
  development`, from `ws80s-macbook-pro.tail1a7c2.ts.net`.
- **FLAWCHESS-8Z** (1 event) — `[Errno 48] Address already in use`, i.e. a local uvicorn port
  collision on `--reload`.

Fix: gate both init sites on `settings.ENVIRONMENT != "development"` (or drop dev events in
`before_send`). Note the worker's `sentry_sdk.init` has **no `before_send` at all**, unlike
`app/main.py`, so a filter-based approach needs to be added in two places while a gate needs
one condition each. Prefer the gate.

Judgement call worth making explicitly when this is planned: is *any* dev-environment
reporting wanted? The four issues above suggest no. If some is wanted later, the worker is
the interesting one (it runs unattended on a real box) and should keep reporting while the
`--reload` dev server should not.

### 2. Attach the failing request URL to axios errors (unblocks the largest open issue)

**FLAWCHESS-64** — `AxiosError: Request failed with status code 429`, **55 events**, the
highest-volume unresolved issue in the project. Tags say `source: tanstack-mutation`,
`transaction: /analysis`. `transaction` is the *page* the user was on, not the endpoint that
429'd, and the event carries no request context — so **which endpoint is being rate-limited
cannot be determined from Sentry.**

There are exactly three client-facing 429 sources in the codebase:
- `app/routers/auth.py:316` — guest creation, 5/hour **per IP** (`ip_rate_limiter.py:11-12`)
- `app/routers/feedback.py:37` — feedback, 5/hour **per user** (`feedback_rate_limiter.py:10-11`)
- `app/services/lichess_client.py:179` — import-internal only, never reaches a browser

Both candidates matter if real: guest-create at 5/hour/IP would lock out real users behind
CGNAT or a shared office/school NAT, which is a genuine acquisition bug, not noise. Feedback
at 5/hour/user is far more benign.

Fix: in `sentryBeforeSend` (`frontend/src/instrument.ts:52`), attach `error.config?.method`
and `error.config?.url` to the event context for axios-like errors. The duck-typed
`AxiosLikeError` interface at `:5` needs a `config?: { url?: string; method?: string }` field.
**Then re-triage FLAWCHESS-64** — this item is instrumentation, and the actual fix (if any)
depends on what it reveals. Do not guess and raise a limit blind.

### 3. Close the remaining hole in the offline-noise filter (removes 2 issues)

`instrument.ts:27-49` already suppresses response-less axios failures, but only when
`isUnloading || navigator.onLine === false || visibilityState === 'hidden'`. `navigator.onLine`
reports `true` on a half-dead connection, so the residual still ships.

- **FLAWCHESS-24** (`AxiosError: Network Error`, 58 events lifetime)
- **FLAWCHESS-54** (`Failed to update a ServiceWorker for scope … sw.js`, 21 events)

Evidence they are one event, not two: the sampled events share
`trace_id e55880900b57435cb15b80f900d5ccc5` — one user in Warsaw whose connection dropped,
producing both the XHR failure and a failed `sw.js` revalidation in the same instant.

Fix: add `/Failed to update a ServiceWorker/` to `Sentry.init`'s `ignoreErrors`
(`instrument.ts:92-95`, which already carries two browser-extension patterns). A `sw.js`
fetch failing is unactionable by construction — it means the network is gone.

**Deliberately do NOT widen the axios filter further.** The existing comment at `:22-26`
explains that the foreground+online variant is kept because it is the only signal that would
catch a real Caddy/host outage — an outage the backend's own Sentry can never report. That
reasoning still holds. The right disposition for FLAWCHESS-24 is to **archive the issue** and
let a genuine outage re-surface as an escalating spike, not to stop collecting it.

### 4. Guard the Maia WebGPU teardown (1 real bug, low volume)

**FLAWCHESS-9D** — `Maia worker inference error (inference)`, 6 events, still firing.
The wrapper message hides the real one, which is in the `maia` context:

```
rawMessage: "Cannot read properties of undefined (reading 'destroy')"
backend: webgpu, os: Android 10, browser: Chrome Mobile 151
```

A WebGPU resource is being destroyed after it has already been released. The failure already
degrades gracefully (the worker reports and the app continues), which is why this is item 4
and not its own seed.

Fix: optional-chain the `destroy()` call in the Maia worker teardown, and/or fall back to the
wasm backend when a WebGPU session dies mid-inference.

Distinct from `project_maia_ios_two_failure_populations` — that memory covers the iOS
no-SIMD and low-memory populations. This is the **Android + WebGPU** population, a third one.
Worth adding to that memory's picture once fixed.

## Adjacent, deliberately NOT in this seed

Recorded so they aren't lost, not proposed as work here:

- **FLAWCHESS-9R / 9Q** (`.at is not a function`, 1 event each) — frames are entirely inside
  `/beacon.min.js` (Cloudflare Web Analytics) on Chrome 79 from 2019, almost certainly a bot.
  Not our code. A `denyUrls: [/beacon\.min\.js/]` line in `Sentry.init` would prevent recurrence
  and touches the same file as items 2-3, so fold it in if that file is already open.
- **FLAWCHESS-66** ("feedback submitted") and **FLAWCHESS-9N** ("Push send returned a prune
  status") — deliberate `capture_message(level="info")` telemetry
  (`feedback_service.py:41`, `push_send.py:233`). Working as designed. These need a **Sentry
  console action, not a code change**: archive forever and reach them via an alert rule or a
  saved search, so they stop holding slots in the unresolved list. `9N` is a push 410 Gone,
  which is precisely the expected prune signal.
- **FLAWCHESS-9G** (Stockfish grading watchdog timeout, 2 events, Android) — the watchdog is
  behaving correctly (posts `stop`, reports, recovers). Two events in 13 days on mobile is
  plausibly a slow device. Leave open and watch; act only if the rate climbs or it appears on
  desktop.

## Expected Outcome

Unresolved issues drop from 15 to roughly 4-5, and every survivor is either a real production
bug or a deliberate watch item. FLAWCHESS-64 becomes triageable for the first time.

## Breadcrumbs

Backend:
- `app/main.py:209` — `if settings.SENTRY_DSN:` init, no environment gate (item 1)
- `app/main.py:71` — `_sentry_before_send`, currently only fingerprints transient DB errors
- `scripts/remote_eval_worker.py:1426` — worker init, no gate and no `before_send` (item 1)
- `app/routers/auth.py:316` + `app/core/ip_rate_limiter.py:11` — guest-create 429, 5/h per IP (item 2)
- `app/routers/feedback.py:37` + `app/core/feedback_rate_limiter.py:10` — feedback 429, 5/h per user (item 2)
- `app/services/feedback_service.py:41`, `app/services/push_send.py:233` — by-design info-level captures

Frontend:
- `frontend/src/instrument.ts:5` — `AxiosLikeError` duck type, needs a `config` field (item 2)
- `frontend/src/instrument.ts:52` — `sentryBeforeSend` (items 2, 3)
- `frontend/src/instrument.ts:27-49` — existing offline-noise filter + its "keep the outage signal" rationale (item 3)
- `frontend/src/instrument.ts:92-95` — `ignoreErrors` array (item 3)
- `frontend/src/hooks/useAuth.ts:146` — guest create call site, tagged `guest-login` not `tanstack-mutation` (item 2 evidence)

Other:
- Sentry issues: FLAWCHESS-8X, 8N, 8Y, 8Z (item 1) · 64 (item 2) · 24, 54 (item 3) · 9D (item 4)
- `deploy/Caddyfile` — confirmed no edge rate limiting, so every client 429 is one of ours (item 2)

## Resolution (2026-08-16, quick task 260816-i4m)

Commits `10f51601`, `754b3631`, `931c3368`. Frontend-only, zero backend files changed.

- **Item 1 — DROPPED by operator decision, not implemented.** Dev-environment reporting is kept
  deliberately; it is disabled by unsetting `SENTRY_DSN` in the dev `.env` when not wanted. No
  `ENVIRONMENT` gate and no `before_send` dev-drop was added to `app/main.py` or
  `scripts/remote_eval_worker.py`. Accepted consequence: FLAWCHESS-8X / 8N (Ctrl-C
  `InvalidStateError`, 24 events) keep recurring from the local worker box. If that becomes
  annoying, the fix that preserves dev signal is to skip capture in the worker when the chained
  cause is `KeyboardInterrupt` / `CancelledError` — deliberately not done here.
- **Item 2 — done as specified, instrumentation only.** `AxiosLikeError` gained
  `config?: { url?: string; method?: string }`; `sentryBeforeSend` attaches url + uppercased
  method to `event.request`. No rate limit touched. **Open follow-up: re-triage FLAWCHESS-64
  once this is deployed and has collected events** — the actual fix (if any) depends on whether
  the 429s are guest-create (5/h per IP, an acquisition bug behind CGNAT) or feedback
  (5/h per user, benign).
- **Item 3 — done as specified.** `/Failed to update a ServiceWorker/` added to `ignoreErrors`.
  The axios offline filter and its "keep the outage signal" rationale were left byte-identical,
  as the seed required. FLAWCHESS-24 still needs the Sentry-console archive action.
- **Item 4 — premise was wrong; fixed via the seed's second clause instead.** There is no
  `destroy()` call anywhere in our Maia code to optional-chain: `maia-worker.js` teardown already
  guards `session?.release?.()` (:208) and `t.dispose?.()` (:274-275). The throw originates inside
  the vendored onnxruntime-web WebGPU bundle (`ort-wasm-simd-threaded.asyncify.mjs`), which we do
  not patch. Fixed by extending `maiaWorkerHost.ts`'s existing wasm-pinned respawn machinery to a
  post-ready branch: a mid-inference WebGPU death now respawns pinned to wasm. Self-limiting
  (gated on `backend === 'webgpu'`, the replacement reports `wasm`), so no respawn loop is
  possible; the Sentry capture still fires tagged `backend=webgpu`.
- **Folded in from "Adjacent":** `denyUrls: [/beacon\.min\.js/]` (FLAWCHESS-9R / 9Q).
- **Still open, console actions not code:** archive FLAWCHESS-66, 9N, 24 in the Sentry UI;
  keep watching FLAWCHESS-9G.

## Notes

Captured 2026-08-15 from a full triage of the unresolved Sentry list. Every claim was checked
against code rather than inferred from the issue title — the chess.js-throws finding that
confirmed SEED-042 came out of the same sweep.

The two issues NOT in this seed (FLAWCHESS-96 analysis-board crash, FLAWCHESS-5E insights
eviction) share one root cause — custom-start games replayed from the standard start — and
belong to **SEED-042**, which was updated the same day with the production confirmation.

Prod DB was not queried during this triage (tunnel down), so the ~176 custom-FEN prod rows
figure is still the one carried in SEED-042 from `openings_repository.py:610-614`, not a fresh
count. Not needed for anything in this seed.
