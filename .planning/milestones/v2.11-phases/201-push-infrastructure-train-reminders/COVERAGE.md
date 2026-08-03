# Phase 201 — External API Coverage Matrix

**External API integrated:** the Web Push Protocol — RFC 8030 (HTTP Web Push),
RFC 8291 (`aes128gcm` message encryption) and RFC 8292 (VAPID) — spoken directly
to whichever push service the subscribing browser named (`fcm.googleapis.com`,
`updates.push.services.mozilla.com`, `web.push.apple.com`). No vendor SDK sits
in between, and no third-party web-push package either: `app/services/push_crypto.py`
(vendored, MIT, from webpush-py 1.0.6) produces headers and ciphertext in-process
on `cryptography` + `pyjwt`, and our own `httpx.AsyncClient` performs the POST.

Detector: `api-coverage.cjs --json` returned `detected: true`.

Baseline is **full coverage**; every row below starts as `INTEGRATE` and this
table is the subtraction record.

| capability | decision | reason |
|---|---|---|
| `POST` an encrypted message to a subscription endpoint (RFC 8030 §5) | `INTEGRATE` | — |
| `aes128gcm` payload encryption (RFC 8291) | `INTEGRATE` | — |
| VAPID `Authorization: vapid t=…, k=…` ES256 JWT (RFC 8292 §3) | `INTEGRATE` | — |
| VAPID `sub` contact claim (RFC 8292 §2.1) | `INTEGRATE` | — |
| `TTL` header (RFC 8030 §5.2) | `INTEGRATE` | — |
| `Content-Encoding: aes128gcm` header | `INTEGRATE` | — |
| 201 / 202 success handling | `INTEGRATE` | — |
| 404 `Subscription Expired` → prune | `INTEGRATE` | — |
| 410 `Gone` → prune | `INTEGRATE` | — |
| 400 / 401 / 403 / 413 error handling | `INTEGRATE` | — |
| 429 rate-limit handling | `INTEGRATE` | — |
| 5xx handling | `INTEGRATE` | — |
| Application-server public key endpoint for `PushManager.subscribe` | `INTEGRATE` | — |
| Subscription persistence, 1-to-many per user | `INTEGRATE` | — |
| Fan-out to every live subscription of a user | `INTEGRATE` | — |
| `push` service-worker event → `showNotification` | `INTEGRATE` | — |
| `notificationclick` service-worker event | `INTEGRATE` | — |
| Notification `tag` collapsing + `renotify` control | `INTEGRATE` | — |
| `Urgency` header (RFC 8030 §5.3) | `OPT-OUT` | RFC 8030 defaults to `normal` server-side when absent, and a once-a-day encouragement reminder needs no delivery-priority control. |
| `Topic` header / server-side collapse key (RFC 8030 §5.4) | `OPT-OUT` | Client-side `tag: 'train-reminder'` (D-14) collapses, and `train_settings.reminder_last_sent_on` (D-06) gives server-side idempotency; `Topic` would be a third mechanism for the same outcome. |
| `Retry-After` honouring on 429 | `OPT-OUT` | D-04 rejects retry semantics: a reminder is worthless an hour late and the next scheduled day brings another. Honouring `Retry-After` needs the backoff state that decision exists to avoid. |
| Delivery retry on 5xx / timeout | `OPT-OUT` | Same as above — D-04, and D-07's claim-then-send makes a re-send structurally impossible within the same local day by design. |
| `Prefer: respond-async` + push message receipts (RFC 8030 §10) | `OPT-OUT` | Not implemented by any major push service; there is no consumer for a receipt and no product behaviour depends on delivery confirmation. |
| Push message resource `DELETE` (cancel an undelivered message, RFC 8030 §6) | `OPT-OUT` | No cancellation use case: the message is already stale by the end of the user's local day, and D-04 accepts fire-and-forget. |
| Payload-less push (`Content-Length: 0`) | `OPT-OUT` | The body carries the D-10 day number; a payload-less push would render generic copy and defeat the decision. |
| Legacy `aesgcm` content encoding (pre-RFC-8291) | `OPT-OUT` | Superseded. Every browser this phase targets (Chrome ≥50, Firefox ≥55, Safari ≥16.4) supports `aes128gcm`. |
| VAPID key rotation / dual-key overlap window | `OPT-OUT` | D-02: one keypair; rotation is accepted mass invalidation — rotate only on key compromise and truncate `push_subscriptions`. A `vapid_key_id` overlap window is machinery for a hypothetical event. |
| Push-service endpoint host allowlist | `OPT-OUT` | New push-service hosts appear over time; an allowlist would silently break browsers. SSRF is bounded instead by `https`-only validation, `follow_redirects=False`, and a bounded timeout (T-201-01). |
| `PushManager.subscribe()` client-side call, permission prompt, unsubscribe UI | `OPT-OUT` | Explicitly Phase 202's scope (PERM-01..04). Phase 201 ships the public-key endpoint and the subscribe/unsubscribe endpoints so 202 is purely frontend (D-18). |
| `pushsubscriptionchange` service-worker event | `OPT-OUT` | **Known gap.** No client subscribe code exists until Phase 202, so nothing can re-subscribe. A rotated subscription 410s on the next send and is pruned — correct, just silent. Phase 202 handles it. |
| iOS / Safari-on-iPhone push (home-screen install prerequisite) | `OPT-OUT` | SEED-132 Phase B, deferred on a BrowserStack dependency. Desktop Safari 16.4+ is not excluded by anything here but is untested. |
| Notification `actions`, `image`, `vibrate`, `requireInteraction`, `silent` | `OPT-OUT` | Not needed for a single-CTA reminder; each adds cross-browser inconsistency for no product gain, and extra payload against the ~4 KB ciphertext ceiling. |
| Notification types other than the Train reminder (import, analysis, marketing) | `OPT-OUT` | Out of scope per SEED-132: notification permission is a one-shot, non-renewable resource, and each additional type raises revocation risk. |
