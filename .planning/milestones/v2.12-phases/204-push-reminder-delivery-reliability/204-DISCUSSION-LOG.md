# Phase 204: Push Reminder Delivery Reliability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-03
**Phase:** 204-push-reminder-delivery-reliability
**Areas discussed:** none interactively — the single question asked was answered "You decide"

---

## Area selection (the only question asked)

**Question:** "Which areas do you want to discuss for Phase 204?" (multi-select)

| Option | Description | Selected |
|--------|-------------|----------|
| D2 — re-sync trigger & cadence | Where the blind re-POST fires (Train mount / app load / both), throttling, and whether a prune flips `reminder_enabled` false | |
| D5 — TTL value | Remaining seconds in the user's local day vs a flat few hours | |
| D4 — VAPID mismatch vs PERM-01 | Repair needs `subscribe()`, which ROADMAP criterion 2 forbids on the passive path | |
| D3 — claim release carve-out | Release the day's claim on a total non-delivery, or leave D-07 untouched | |

**User's choice:** "You decide" (free text via Other)
**Notes:** Read as a full delegation — Claude selected all four areas and made every call, rather than re-asking. All decisions are recorded in CONTEXT.md with their reasoning so any of them can be overridden at planning time.

---

## Claude's Discretion

The entire phase. Calls made, with the reasoning stated in CONTEXT.md:

| Area | Call | Key reason |
|---|---|---|
| D5 TTL value | Remaining seconds in the user's local day (D-01) | A flat TTL can deliver a stale reminder the next morning alongside that day's own; D-14's tag does not stop a lone stale arrival |
| D5 plumbing | Keyword-only defaulted `ttl_seconds` (D-02); helper in `train_scheduler.py` (D-03) | Mirrors D1's `subscription_id`; keeps tz arithmetic in one module (D-16) |
| D4 scope | Key comparison + repair in the gesture path only (D-04, D-05) | Phase 201's D-02 locked rotation as accepted mass invalidation and explicitly rejected a self-heal; the real bug is that `existing ??` broke manual recovery too |
| D4 runbook | Written down this phase (D-06) | ROADMAP criterion 4's second half; the D-02 note currently survives only in an archived CONTEXT.md |
| D2 placement | App-wide in `ProtectedLayout`, own hook (D-07, D-08) | The dark user is the one who stopped visiting Train, so a Train-mount trigger gates the fix on the behavior it exists to restore |
| D2 cadence | Once per app load, module-scoped guard (D-09) | A `localStorage` throttle adds a fourth push storage key to save one POST/load at ~50 users/day |
| D2 transport | Blind idempotent re-POST, new `push.ts` export (D-10, D-11) | `upsert_subscription` is already `ON CONFLICT DO UPDATE`; PERM-01 keeps the one-shot resource in one file |
| Prune → `reminder_enabled` | Does not flip it (D-12) | Discards real intent over a transient hiccup and charges a Settings trip; the self-heal is strictly better than an honest lie |
| D3 carve-out | Release only on `attempted == 0 or attempted == pruned` (D-13, D-14) | 404/410 are terminal — nothing was delivered, so no double-send window; conditional UPDATE keeps the invariant structural |
| D3 predicate width | `failed` excluded (D-15) | Defensible to include; the seed's narrow condition is easier to reason about |
| Evidence ordering | No metric, alert, or delivery ack this phase (D-16) | While TTL 0 stands, a discard and a delivery are byte-identical server-side |

**Flagged for a second look:** D-04 narrows ROADMAP success criterion 4 from
"devices detect the mismatch and re-subscribe" to "…on the next reminder
gesture". The escape hatch (a passive repair guarded on
`Notification.permission === 'granted'`, which provably cannot spend the
one-shot permission) is documented in CONTEXT.md D-04 so reversing the call
needs no re-research.

## Deferred Ideas

- Passive-path VAPID repair guarded on `permission === 'granted'`
- Releasing the claim on `failed` as well as `pruned`
- Client-side delivery ack (a service-worker POST proving a notification was shown)
- Push-health metrics and a Sentry alert rule on `source=push_send`
- Distinguishing "Chrome dropped it" from "user revoked permission" (both 410)
- Per-subscription `last_seen_at` / device labelling (carried over from 201)

## Reviewed Todos (not folded)

`todo.match-phase 204` returned three matches — WR-01 Tailwind score-axis label
(0.9), `172-deferred-review-findings` (0.6), bitboard storage (0.6). All generic
keyword hits with no push relation; the same three matched Phase 201 and were
declined then. None folded.
