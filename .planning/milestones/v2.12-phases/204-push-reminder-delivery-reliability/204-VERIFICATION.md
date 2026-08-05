---
phase: 204-push-reminder-delivery-reliability
verified: 2026-08-03T18:31:26Z
status: passed
score: 6/6 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 204: Push Reminder Delivery Reliability Verification Report

**Phase Goal:** A Train push reminder that fails to arrive stops being permanent and
invisible. A device whose subscription the server pruned re-registers itself without
spending the one-shot notification permission; a message is no longer discarded by the
push service the instant the phone is unreachable; a VAPID key rotation cannot silently
kill every device; and a fan-out that delivered to nobody does not consume the day's
reminder claim. Backend + frontend, no migration expected.

**Verified:** 2026-08-03T18:31:26Z
**Status:** passed
**Re-verification:** No — initial verification

**Note on requirement traceability:** there is no active `.planning/REQUIREMENTS.md` for
this phase by design — the v2.11 set is archived at
`.planning/milestones/v2.11-REQUIREMENTS.md`. PUSHREL-01..06 were minted at planning time
and are defined in `204-01-PLAN.md` § "Phase 204 requirement IDs", registered on the
ROADMAP's `**Requirements**:` line. Traceability below is checked against those sources,
not against a REQUIREMENTS.md file, per the task instructions.

## Goal Achievement

### Observable Truths (against ROADMAP's six success criteria, criterion 4 narrowed per D-04)

| # | Truth (ROADMAP criterion) | Status | Evidence |
|---|---|---|---|
| 1 | A device with a live `PushSubscription` that the server pruned re-registers itself on app load/mount with no user action, and a reminder scheduled after that point can arrive | ✓ VERIFIED | `useDevicePushResync` (`frontend/src/hooks/useDevicePushResync.ts`) mounted in `App.tsx:562` `ProtectedLayout` with the guest gate; `resyncExistingSubscription`/`postSubscription` in `push.ts`; HTTP-level round trip proven by `tests/routers/test_push.py::test_resubscribe_after_prune_restores_delivery` (ran locally: PASS — `attempted==0` after prune-equivalent, `attempted==1` after re-POST); real-device confirmation in `204-03-SUMMARY.md` § Real-Device Verification scenario A (row restored, no permission prompt) |
| 2 | The re-sync path can never call `Notification.requestPermission()` or `PushManager.subscribe()` (PERM-01); it only re-POSTs an existing subscription and stays inside `push.ts` | ✓ VERIFIED | `resyncExistingSubscription` only calls `postSubscription` (a plain HTTP POST); `useDevicePushResync` imports only `getDeviceSubscription`, `resyncExistingSubscription`, `subscriptionKeyMatches` from `@/lib/push` — never `ensureDeviceSubscribed`. 49 frontend tests (`useDevicePushResync.test.ts` + `push.test.ts`) ran locally: PASS, including the PERM-01 negative and the 6-case fail-safe suppression matrix, each asserting `requestPermission`/`subscribe` call count 0 |
| 3 | A reminder sent while the phone is briefly unreachable is still delivered on wake within the TTL bound, and the fixed tag still collapses a backlog to one notification | ✓ VERIFIED | `seconds_until_end_of_local_day` in `train_scheduler.py:166` (23:59:59-local, not next-midnight, no floor/cap) threaded through `push_send.send_to_subscription`/`send_to_user`'s keyword-only `ttl_seconds` (module default `3600`, never `0`); `_process_candidate` computes and passes it (`train_reminder_service.py:194-197`). Ran locally: `tests/services/test_train_scheduler.py -k end_of_local_day` (4 passed) and `tests/test_push_send.py -k ttl` (2 passed). Real-device scenario B in `204-03-SUMMARY.md`: 3 offline sends collapsed to exactly 1 notification on reconnect (with the honestly-recorded caveat that this exercised the 3600s module default, not the scheduler helper directly — scenario C exercises the real scheduler path) |
| 4 (narrowed per D-04) | A VAPID key change is detected by byte-comparing `applicationServerKey`; the **gesture path** repairs it (`unsubscribe()` + `subscribe()`); the passive path detects only; the rotation procedure is written down | ✓ VERIFIED | `subscriptionKeyMatches` (`push.ts:207-221`, fails closed on null/mismatch/throw) wired as a suppressor-only in the passive path (`useDevicePushResync.ts:77`, no re-POST/unsubscribe on mismatch) and as a reuse-vs-repair branch in the gesture path `ensureDeviceSubscribed` (`push.ts:162-181`, mismatch → `unsubscribe()` then `subscribe()`). `docs/push-vapid-rotation-runbook.md` exists, states the D-04 narrowing explicitly, is referenced from `push_send.py`'s module docstring and `CLAUDE.md:207`, contains no PEM material or real endpoint (`grep -c "BEGIN .*PRIVATE KEY"` → 0, `grep -c "fcm.googleapis.com"` → 0) |
| 5 | The D3 decision is recorded with its reasoning in the phase decision log, and the D-07 double-send invariant demonstrably holds either way | ✓ VERIFIED | `204-DECISIONS.md` records the question, resolution, two-guard safety argument, rejected alternatives, reversibility rating, and the exact test node id; `release_reminder_claim`'s own docstring (`train_reminder_repository.py:100-131`) restates the reasoning in the code itself. `_process_candidate` step 8 (`train_reminder_service.py:198-213`) sits after `send_to_user` returns normally, inside the same session block, unreachable from the outer per-candidate `except Exception` at line 251 — confirmed both by reading the code and by independently reverting the release call and the D-07 mutation (moving release into an except arm) and observing the named tests go red, then restoring to green (see Behavioral Spot-Checks below) |
| 6 | Tests cover the desync-and-recover path end to end, and each production change is mutation-tested (revert, confirm red, restore) | ✓ VERIFIED | See Behavioral Spot-Checks — 4 mutations independently re-run by this verifier (3 backend, 1 frontend) all reproduced the claimed red/green transitions. Additional mutations claimed in SUMMARYs (11 total across the 3 plans) are consistent with the code shape observed; a representative sample across all three plans was independently re-run rather than accepted on narrative alone |

**Score:** 6/6 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `frontend/src/lib/push.ts` | `subscriptionKeyMatches`, `resyncExistingSubscription` exported; `postSubscription` private; `ensureDeviceSubscribed` repair branch | ✓ VERIFIED | All present, wired, substantive (read in full) |
| `frontend/src/hooks/useDevicePushResync.ts` | App-wide hook, module-scoped cadence guard | ✓ VERIFIED | Present, matches D-07/D-08/D-09 exactly |
| `frontend/src/hooks/usePushCapability.ts` | `options.enabled` gate | ✓ VERIFIED | Present, threads guest gate |
| `frontend/src/App.tsx` | Mounts `useDevicePushResync` in `ProtectedLayout` | ✓ VERIFIED | Line 562, same `enabled` expression as `useReminderResurfaceRedirect` |
| `tests/routers/test_push.py` | Desync-and-recover HTTP integration test | ✓ VERIFIED | `test_resubscribe_after_prune_restores_delivery` present, ran PASS |
| `app/services/train_scheduler.py` | `seconds_until_end_of_local_day` + 3 constants | ✓ VERIFIED | Present at line 166, in `__all__` |
| `app/services/push_send.py` | `_DEFAULT_PUSH_TTL_SECONDS`, `ttl_seconds` param | ✓ VERIFIED | Present, non-zero default (3600) |
| `app/repositories/train_reminder_repository.py` | `release_reminder_claim` | ✓ VERIFIED | Present at line 100, guarded UPDATE, docstring carries full D3 reasoning |
| `.planning/phases/204.../204-DECISIONS.md` | D3 decision log | ✓ VERIFIED | Present, full reasoning, rejected alternatives, test node id named |
| `docs/push-vapid-rotation-runbook.md` | Operator runbook | ✓ VERIFIED | Present, all required sections, no key material/endpoints |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `App.tsx` | `useDevicePushResync.ts` | mount with guest gate | ✓ WIRED | Confirmed at line 562 |
| `useDevicePushResync.ts` | `push.ts` | `getDeviceSubscription → subscriptionKeyMatches → resyncExistingSubscription` | ✓ WIRED | Confirmed in hook body |
| `push.ts` | `app/routers/push.py` | `postSubscription → pushApi.subscribe → POST /push/subscribe` | ✓ WIRED | Confirmed by passing HTTP integration test |
| `train_reminder_service.py` | `train_scheduler.py` | `seconds_until_end_of_local_day(row.timezone, now_utc)` | ✓ WIRED | Confirmed at `train_reminder_service.py:194` |
| `train_reminder_service.py` | `push_send.py` | `send_to_user(..., ttl_seconds=...)` | ✓ WIRED | Confirmed at line 195-197 |
| `train_reminder_service.py` | `train_reminder_repository.py` | step 8 `release_reminder_claim(session, user_id=..., today=today)` | ✓ WIRED | Confirmed at line 209-213, same `today` reused, no exception path reaches it |
| `push.ts` (`ensureDeviceSubscribed`) | `push.ts` (`subscriptionKeyMatches`) | reuse-vs-repair decision | ✓ WIRED | Confirmed at line 162 |
| `app/services/push_send.py` | `docs/push-vapid-rotation-runbook.md` | module docstring pointer | ✓ WIRED | Confirmed at line 34-35 |

### Behavioral Spot-Checks (independent mutation re-verification, not accepted from SUMMARY narrative)

Per user-memory guidance ("prove a gap fix by reverting it and confirming tests fail; never accept symbol presence"), this verifier independently reproduced a representative sample of the claimed mutation tests, rather than trusting the SUMMARY logs:

| Mutation | File | Command | Result before restore | Result after restore |
|---|---|---|---|---|
| Deleted `release_reminder_claim` call (step 8) | `app/services/train_reminder_service.py` | `uv run pytest tests/services/test_train_reminder_service.py -k ClaimReleaseOnTotalNonDelivery -q` | ❌ RED — `test_all_subscriptions_pruned_releases_the_claim` failed (`assert datetime.date(2026, 8, 1) is None`) | ✅ GREEN — 3 passed |
| Moved release into an `except` arm around `send_to_user` | `app/services/train_reminder_service.py` | `uv run pytest tests/services/test_train_reminder_service.py -k ClaimReleaseOnTotalNonDelivery -q` | ❌ RED — `test_raising_send_to_user_does_not_release_the_claim` failed (claim was released despite the crash) | ✅ GREEN — 3 passed |
| Removed key-match check in `ensureDeviceSubscribed` (always reuse `existing`) | `frontend/src/lib/push.ts` | `npm test -- --run src/lib/__tests__/push.test.ts` | ❌ RED — 3 tests failed (null-key repair, rejecting-unsubscribe, and one more) | ✅ GREEN — 39 passed |

Additionally ran (not mutated, confirming current green state): `tests/services/test_train_scheduler.py -k end_of_local_day` (4 passed), `tests/test_push_send.py -k ttl` (2 passed), `tests/routers/test_push.py -k resubscribe_after_prune` (1 passed), full `useDevicePushResync.test.ts` + `push.test.ts` (49 passed), `uv run ruff check app/ tests/` (clean), `uv run ty check app/ tests/` (clean), `cd frontend && npm run lint` (0 errors), `npm run knip` (clean), `npm run build` (succeeds).

All files were restored to their pre-mutation state after each check and `git status`/`git diff --stat` confirmed zero residual diff.

### Anti-Patterns Found

None. Scanned all production files modified by this phase
(`app/services/{push_send,train_reminder_service,train_scheduler}.py`,
`app/repositories/train_reminder_repository.py`,
`frontend/src/{lib/push.ts,hooks/useDevicePushResync.ts,hooks/usePushCapability.ts}`,
`docs/push-vapid-rotation-runbook.md`) for `TBD|FIXME|XXX` — zero matches. No stub returns,
no hardcoded empty data flowing to a rendered value, no scope-creep (grepped the full diff
since the phase's context-capture commit for new metrics/counters/alert rules/Sentry
captures in production files — zero hits, consistent with CONTEXT.md D-16 and the ROADMAP
non-goals).

### Requirements Coverage (PUSHREL-01..06, defined in 204-01-PLAN.md)

| Requirement | Definition | Owning plan(s) | Status | Evidence |
|---|---|---|---|---|
| PUSHREL-01 | Device re-registers on app load, no user action | 204-01 | ✓ SATISFIED | Truth 1 above |
| PUSHREL-02 | Re-sync path never calls the one-shot permission APIs (PERM-01) | 204-01 | ✓ SATISFIED | Truth 2 above |
| PUSHREL-03 | TTL bounded by end of local day, backlog still collapses | 204-02 | ✓ SATISFIED | Truth 3 above |
| PUSHREL-04 | VAPID mismatch detected + gesture-path repair + runbook (narrowed) | 204-01 (detection), 204-03 (repair+runbook) | ✓ SATISFIED | Truth 4 above |
| PUSHREL-05 | D3 decision recorded, D-07 invariant demonstrably intact | 204-02 | ✓ SATISFIED | Truth 5 above |
| PUSHREL-06 | Desync-and-recover covered end to end; mutation-tested | 204-01, 204-02, 204-03 | ✓ SATISFIED | Truth 6 above |

No orphaned requirements — all six IDs registered on the ROADMAP's `**Requirements**:` line
are claimed by exactly one or more of the three plans, and all six are satisfied.

### Human Verification Required

None outstanding. The two manual-only behaviors (D5 offline retention, D2 prune self-heal)
and the D2+D3 same-day-recovery composition were already executed on a real Android device
by the plan's own `checkpoint:human-verify` gate (204-03 Task 3) and are recorded with a
full transcript in `204-03-SUMMARY.md` § Real-Device Verification and cross-referenced in
`204-VALIDATION.md`'s Manual-Only Verifications table. This verifier reviewed that record
for honesty rather than re-running the device test: it explicitly states the TTL-default
caveat (scenario B exercised `_DEFAULT_PUSH_TTL_SECONDS=3600`, not
`seconds_until_end_of_local_day`, which remains unit-tested only) and an initial false
alarm in scenario A (navigating between tabs instead of reloading) that was correctly
identified as expected behavior, not a defect — both are the kind of honest disclosure this
verification process looks for, not evidence of a gap.

### Gaps Summary

None. All six ROADMAP success criteria (criterion 4 evaluated against its documented
narrowing) are verified in the codebase, not merely claimed in SUMMARY.md. Independent
mutation-test reversion (3 backend, 1 frontend) confirms the safety-critical invariants
(D-07 double-send prevention, D-04/D-05 PERM-01 preservation) are actually pinned by tests
rather than accepted on narrative. No scope creep against the ROADMAP non-goals (no
retries, no partial-failure release, no Chrome-vs-user-revoked distinction, no new push
metrics/Sentry alert rules). No debt markers, no stubs, no orphaned requirements.

---

*Verified: 2026-08-03T18:31:26Z*
*Verifier: Claude (gsd-verifier)*
