---
phase: 204-push-reminder-delivery-reliability
plan: 01
subsystem: push-notifications
tags: [react, push-api, service-worker, fastapi, pytest, vitest]

requires:
  - phase: 201-push-infrastructure-train-reminders
    provides: "push_subscriptions table with ON CONFLICT DO UPDATE upsert on endpoint; POST /push/subscribe; ensureDeviceSubscribed as PERM-01's single call site"
  - phase: 202-reminder-permission-ux
    provides: "the PERM-01 one-shot permission discipline and ensureDeviceSubscribed's WR-01/CR-01 error handling"
provides:
  - "subscriptionKeyMatches — byte-compares a live PushSubscription's applicationServerKey against the current VAPID key (D-04 detection half)"
  - "resyncExistingSubscription — blind idempotent re-POST of an already-live subscription, PERM-01-safe by construction"
  - "useDevicePushResync — app-wide hook mounted in ProtectedLayout that restores a pruned device's server-side row with zero user gesture (D-07/D-08/D-09)"
  - "usePushCapability's options.enabled gate, so an app-wide consumer can suppress the VAPID-key query for guests"
  - "an HTTP-level integration test proving the desync-and-recover round trip through the real router/repository stack"
affects: [204-02-backend-ttl-and-claim-release, 204-03-vapid-repair-and-rotation-runbook]

actuals:
  tokens: 8129
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Module-private helper extraction (postSubscription) shared by two public entry points to prevent behavioral drift (D-11)"
    - "Module-scoped (not useRef) cadence guard for a hook that must survive a full component unmount/remount within one page load"
    - "Fail-safe browser probe: every unresolved/thrown signal degrades to 'do nothing', never to a default action"

key-files:
  created:
    - frontend/src/hooks/useDevicePushResync.ts
    - frontend/src/hooks/__tests__/useDevicePushResync.test.ts
  modified:
    - frontend/src/lib/push.ts
    - frontend/src/lib/__tests__/push.test.ts
    - frontend/src/hooks/usePushCapability.ts
    - frontend/src/App.tsx
    - tests/routers/test_push.py

key-decisions:
  - "D-04/D-05 narrowing implemented as designed: subscriptionKeyMatches is wired as a suppressor ONLY on the passive path — a mismatch skips the re-POST, never calls unsubscribe(). The repair (unsubscribe + re-subscribe) stays out of scope for this plan, deferred to Plan 03's gesture path."
  - "Cadence guard is a module-scoped `let`, burned synchronously before the async probe starts — a deliberate deviation from the research code example's late-set useRef+module-guard combo, closing a double-fire window between two near-simultaneous mounts."
  - "ensureDeviceSubscribed's `existing ?? subscribe(...)` line was left untouched in this plan — only its tail was extracted into postSubscription. The D-04 repair (replacing `existing ??` with a key-match check) belongs to Plan 03, not here."

patterns-established:
  - "Shared POST-body-builder extraction pattern: when two entry points must post the same shape, extract a module-private function rather than duplicating the endpoint/keys mapping."
  - "Guest-gate threading: an app-wide hook mounted unconditionally on every protected route must thread its own `enabled` option down through every underlying query hook (useTrainSettings, usePushCapability), never call a `useUserProfile()` internally."

requirements-completed: [PUSHREL-01, PUSHREL-02, PUSHREL-04, PUSHREL-06]

coverage:
  - id: D1
    description: "A device holding a live PushSubscription that the server pruned re-registers itself on the next app load, with zero user interaction (PUSHREL-01)"
    requirement: "PUSHREL-01"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useDevicePushResync.test.ts#happy path: all gates pass -> resyncExistingSubscription called once with the fixture subscription"
        status: pass
      - kind: integration
        ref: "tests/routers/test_push.py#test_resubscribe_after_prune_restores_delivery"
        status: pass
    human_judgment: false
  - id: D2
    description: "The re-sync path never calls Notification.requestPermission() or PushManager.subscribe() (PERM-01/PUSHREL-02)"
    requirement: "PUSHREL-02"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useDevicePushResync.test.ts#PERM-01: the same happy path never touches requestPermission or pushManager.subscribe"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useDevicePushResync.test.ts — fail-safe suppression matrix (all six cases assert requestPermission/subscribe call count 0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "subscriptionKeyMatches detects a VAPID mismatch and fails closed on every unreadable input (PUSHREL-04 detection half); the passive path suppresses on mismatch without repairing (D-05)"
    requirement: "PUSHREL-04"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/push.test.ts#subscriptionKeyMatches (5 cases: exact match, flipped byte, length mismatch, null key, throwing getter)"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useDevicePushResync.test.ts#subscriptionKeyMatches returns false (D-05: detect only) -> zero resync calls and unsubscribe is never called"
        status: pass
    human_judgment: false
  - id: D4
    description: "The desync-and-recover round trip is proven end to end at the HTTP layer, and this plan's production changes are mutation-tested rather than accepted on symbol presence (PUSHREL-06, this plan's share)"
    requirement: "PUSHREL-06"
    verification:
      - kind: integration
        ref: "tests/routers/test_push.py#test_resubscribe_after_prune_restores_delivery"
        status: pass
      - kind: unit
        ref: "3 mutation tests recorded in this SUMMARY's Mutation Testing section — all confirmed red then restored green"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-03
status: complete
---

# Phase 204 Plan 01: Device Push Re-sync Summary

**A pruned device's push subscription silently re-registers itself on the next app load — no permission prompt, no user gesture, proven end to end from the browser probe through the HTTP layer to the idempotent upsert.**

## Performance

- **Duration:** 55 min
- **Tasks:** 3
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments

- `push.ts` gained `subscriptionKeyMatches` (D-04 detection half, fails closed on `null`/mismatch/throw) and `resyncExistingSubscription` (blind idempotent re-POST), with the shared POST tail extracted into a module-private `postSubscription` so the two entry points can't drift on the `endpoint`/`keys` mapping.
- A new app-wide hook, `useDevicePushResync`, mounted in `ProtectedLayout` beside `useReminderResurfaceRedirect` with the identical guest gate, restores a pruned device's server-side row on the next protected-route load — fail-safe on every unresolved or negative signal (guest, unresolved settings, `reminder_enabled` false, no device subscription, unresolved or mismatched VAPID key).
- `usePushCapability` gained an `options.enabled` gate so the new app-wide consumer suppresses `GET /push/vapid-public-key` for guests (mirrors the existing CR-01 pattern).
- The desync-and-recover round trip is proven at the HTTP layer: subscribe → row removed (standing in for a prune) → dev-trigger reports `attempted == 0` → identical re-POST → dev-trigger reports `attempted == 1` (not 2), the `ON CONFLICT DO UPDATE` idempotency proof.
- Three mutation tests recorded and confirmed (see below); the frontend suite (43 tests across the two touched files, 3282 across the full suite) and the backend push router suite (9 tests) are green.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end device re-sync** — `7be0b4ec5` (feat)
2. **Task 2: Fail-safe matrix** — `0e7666308` (test)
3. **Task 3: Desync-and-recover HTTP proof + frontend gate** — `01cd673e9` (test)

_No separate plan-metadata commit yet — this SUMMARY/STATE/ROADMAP update is committed next as the final metadata commit._

## Files Created/Modified

- `frontend/src/lib/push.ts` — added `subscriptionKeyMatches`, `resyncExistingSubscription`, extracted module-private `postSubscription`
- `frontend/src/lib/__tests__/push.test.ts` — added `subscriptionKeyMatches` (5 cases) and `resyncExistingSubscription` (3 cases) test blocks
- `frontend/src/hooks/usePushCapability.ts` — added `options?: { enabled?: boolean }`
- `frontend/src/hooks/useDevicePushResync.ts` (NEW) — the app-wide re-sync hook
- `frontend/src/hooks/__tests__/useDevicePushResync.test.ts` (NEW) — tracer + fail-safe matrix + cadence proof
- `frontend/src/App.tsx` — imports and mounts `useDevicePushResync` in `ProtectedLayout`
- `tests/routers/test_push.py` — added `test_resubscribe_after_prune_restores_delivery`

## Decisions Made

- Kept `ensureDeviceSubscribed`'s `existing ??` line untouched (per D-11/anti-drift): this plan only extracts its POST tail into `postSubscription`. The D-04 repair (replacing `existing ??` with a key-match-then-repair check) is explicitly Plan 03's responsibility, on the gesture path only — implementing it here would have satisfied the unnarrowed ROADMAP wording that CONTEXT.md D-04 deliberately narrows.
- Chose to burn the module-scoped cadence guard (`hasResyncedThisPageLoad = true`) synchronously, before starting the async `getDeviceSubscription()` probe, rather than inside the `.then()` as the research code example showed — closes a double-fire window where two near-simultaneous mounts could both pass the synchronous gates before either probe resolved.
- The test harness for the module-scoped guard follows the plan's mandated `vi.resetModules()` + dynamic re-import pattern per test; additionally had to explicitly `mockReset()` the `vi.mock()`-factory-produced mock functions in `beforeEach`, since those persist as the same object across `resetModules()` cycles (only the hook module's own `let` binding is truly fresh) — undocumented in the plan, discovered by a failing first run (2 accumulated calls instead of 0) and fixed before any assertions were trusted.

## Deviations from Plan

None beyond the test-harness detail above (not a production-code deviation, a test-authoring correction) — plan executed as written.

## Mutation Testing (ROADMAP criterion 6)

All three mutations were actually reverted, run, confirmed red, then restored and confirmed green — no grep or symbol-presence substitutions.

1. **Resync call (Task 1):** replaced `resyncExistingSubscription(subscription)` with a bare `return;` in `useDevicePushResync.ts`.
   - Ran `npm test -- --run src/hooks/__tests__/useDevicePushResync.test.ts`.
   - **RED:** both the happy-path test and the PERM-01 test failed (`expected "vi.fn()" to be called 1 times, but got 0 times`).
   - Restored; **GREEN:** all 28 tests in the combined run passed.

2. **`subscriptionKeyMatches` null branch (Task 2):** changed `if (existingKey === null) return false;` to `return true;` in `push.ts`.
   - Ran `npm test -- --run src/lib/__tests__/push.test.ts`.
   - **RED:** exactly the `'applicationServerKey: null -> false'` test failed (`expected true to be false`); the other 32 tests in the file stayed green.
   - Restored; **GREEN:** all 33 tests passed.

3. **Cadence guard scope (Task 2):** moved `hasResyncedThisPageLoad` from a module-scoped `let` into the hook body as a `useRef`.
   - Ran `npm test -- --run src/hooks/__tests__/useDevicePushResync.test.ts`.
   - **RED:** only the cadence test ("an unmount followed by a fresh mount... produces exactly one resync attempt in total") failed (`expected 1 times, but got 2 times`); the other 9 tests in the file stayed green — confirming the mutation isolates cleanly to that one invariant.
   - Restored; **GREEN:** all 10 tests passed.

4. **Idempotent recovery (Task 3):** commented out the second (re-POST) `client.post(SUBSCRIBE_ENDPOINT, ...)` call in `test_resubscribe_after_prune_restores_delivery`.
   - Ran `uv run pytest tests/routers/test_push.py -k resubscribe_after_prune -x`.
   - **RED:** failed on `assert 0 == 1` (the `attempted == 1` assertion).
   - Restored; **GREEN:** all 9 tests in `tests/routers/test_push.py` passed.

## Accepted Coverage Gap (named, not papered over)

**The `App.tsx` mount line's mutation is NOT claimed.** No test harness in this repo renders `ProtectedLayout` — `App.test.tsx` renders exported sub-components only, and the project has previously recorded that a full `<App />` render is impractical. Deleting the `useDevicePushResync({ enabled: ... })` mount line would turn no automated test red. This is the plan's own stated exception, backstopped by Plan 03's `checkpoint:human-verify` (reload the PWA, confirm the row reappears) plus a passing `npm run build`, which does at least prove the call site type-checks against the hook's real signature.

## Issues Encountered

None beyond the mock-reset discovery documented above under Decisions Made.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 02 (backend TTL + claim release) shares zero files with this plan and can land independently; the composition CONTEXT.md describes (prune → re-sync restores the row → Plan 02's released claim lets the same-day tick send) now has its first half proven.
- Plan 03 (VAPID repair on the gesture path + rotation runbook) can build directly on `subscriptionKeyMatches` and the extracted `postSubscription` helper — both are already exported/available and both are covered by branch tests, so Plan 03's repair logic has a tested detection primitive to call rather than reimplementing the byte comparison.
- No blockers.

## Self-Check: PASSED

All 6 created/modified files confirmed present on disk; all 3 task commit
hashes (`7be0b4ec5`, `0e7666308`, `01cd673e9`) confirmed present in
`git log --oneline --all`.

---
*Phase: 204-push-reminder-delivery-reliability*
*Completed: 2026-08-03*
