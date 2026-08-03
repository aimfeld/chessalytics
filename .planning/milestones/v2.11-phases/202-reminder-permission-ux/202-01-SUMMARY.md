---
phase: 202-reminder-permission-ux
plan: 01
subsystem: ui
tags: [react, tanstack-query, web-push, service-worker, train]

# Dependency graph
requires:
  - phase: 201-push-infrastructure-train-reminders
    provides: "POST /push/subscribe, GET /push/vapid-public-key, reminder_enabled/reminder_hour on GET/PUT /train/settings"
provides:
  - "The only browser-side push subscription path in the app: lib/push.ts's ensureDeviceSubscribed(), the single call site for Notification.requestPermission()/PushManager.subscribe()"
  - "TrainReminderButton — the D-01..D-05/D-13 score-screen opt-in slot, live per-device"
  - "usePushCapability — the D-12 VAPID-key + feature-detect gate, shared by this plan and Plan 02"
  - "reminder_enabled/reminder_hour threaded through TrainSettingsResponse/Update, useTrainSettings, and TrainScheduleSettings's Draft (pass-through only; Plan 02 adds the controls)"
affects: [202-02-settings-toggle-and-hour-picker]

# Actuals (#2632)
actuals:
  tokens: 12934
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Single call-site pattern for one-shot browser permission APIs (lib/push.ts owns Notification.requestPermission()/PushManager.subscribe() exclusively)"
    - "Live-derived visibility (no localStorage/decline-history) for a one-shot browser resource, mirroring D-01"

key-files:
  created:
    - frontend/src/types/push.ts
    - frontend/src/lib/push.ts
    - frontend/src/lib/__tests__/push.test.ts
    - frontend/src/hooks/usePushCapability.ts
    - frontend/src/components/train/TrainReminderButton.tsx
    - frontend/src/components/train/__tests__/TrainReminderButton.test.tsx
  modified:
    - frontend/src/types/train.ts
    - frontend/src/api/client.ts
    - frontend/src/hooks/useTrainSettings.ts
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/TrainScoreScreen.tsx
    - frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx
    - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx

key-decisions:
  - "D-04 override applied in place: TrainScoreScreen's Done button is now variant=\"default\" (moved right), the SEED-122 brand-outline rationale is corrected at the docstring site rather than left contradicting the code"
  - "urlBase64ToUint8Array built via new Uint8Array(n) + an index loop, not Uint8Array.from(...) — the latter's Uint8Array<ArrayBufferLike> generic is not assignable to PushSubscriptionOptionsInit's BufferSource under this project's TS/DOM-lib version"
  - "padding=3 in the base64url padding formula is structurally unreachable for well-formed content (only len%4 in {0,2,3} occurs in real unpadded base64), so push.test.ts documents and tests the three real cases (0,1,2) instead of asserting a nonsensical 'decodes without throwing' claim for malformed input"

patterns-established:
  - "ensureDeviceSubscribed()'s DeviceSubscribeResult discriminated union ({subscribed}/{dismissed}/{denied}/{unsupported}/{error}) is the contract both TrainReminderButton and Plan 02's Settings toggle branch on"

requirements-completed: [PERM-01, PERM-02]

coverage:
  - id: D1
    description: "Pressing 'Remind me' on the Train score screen requests the browser permission, subscribes this device via POST /push/subscribe, persists reminder_enabled: true through the full-replace settings PUT, and swaps the button in place for a confirmation naming the hour (D-01..D-03)"
    requirement: "PERM-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#happy path: press -> grant -> subscribe -> persist -> confirmation names the hour"
        status: pass
    human_judgment: false
  - id: D2
    description: "Notification.requestPermission() is reachable only from the button's click handler — never on mount, never on an automatic retry, and disabled for the whole promise lifetime so a double-press cannot issue two prompts"
    requirement: "PERM-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/push.test.ts#already denied: does not prompt"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#mounting without a click never calls Notification.requestPermission"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#while subscribing, the button is disabled and a second click during that window issues only one requestPermission call"
        status: pass
    human_judgment: false
  - id: D3
    description: "A dismissed browser prompt ('default' after requestPermission()) leaves the button standing with no error and writes nothing — no decline history is ever persisted anywhere in the opt-in path"
    requirement: "PERM-02"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/push.test.ts#prompt dismissed: status is \"dismissed\", not \"denied\", and no subscribe happens (PERM-02)"
        status: pass
      - kind: unit
        ref: "frontend/src/lib/__tests__/push.test.ts#the dismissed and denied arms never call localStorage.setItem"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#prompt dismissed: the button remains present and enabled, with no error copy"
        status: pass
    human_judgment: false
  - id: D4
    description: "Both surfaces are structurally absent (no skeleton/message) when push is unsupported, the VAPID key 404s, permission is 'denied', or this device is already subscribed"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#unsupported browser: renders nothing"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#VAPID key endpoint 404s: renders nothing"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#device already subscribed: renders nothing"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#D-05: reminder_enabled true from the server plus no local subscription still renders the button (per-device asymmetry, not a bug to reconcile)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A failed subscribe or a failed settings PUT after a successful subscribe never writes reminder_enabled and shows the D-13 error copy with the button still enabled"
    requirement: "PERM-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#pushApi.subscribe rejects: shows the D-13 error copy, stays enabled, and never calls updateSettings"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#trainApi.updateSettings rejects after a successful subscribe: shows the D-13 error copy (never claims reminders are on when the server did not confirm)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Score-screen row hierarchy: Remind me (brand-outline, left) then Done (default, right), and Done alone (flex-1) when the slot is hidden — matches UI-SPEC E1/E2"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx#with the slot present, the row is Remind me first then Done, in that DOM order"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx#with the slot hidden, the row has exactly one element child and it is Done, with flex-1"
        status: pass
    human_judgment: false
  - id: D7
    description: "Manual verification of the real end-to-end flow in a browser with a configured VAPID key (real Notification prompt, real service worker, real delivery-adjacent state) — automated tests stub every browser API and cannot prove the real permission UI or a real subscribe round-trip"
    verification: []
    human_judgment: true
    rationale: "VAPID keys are unset on this dev machine by default (201 D-03) and jsdom cannot render or drive a real browser permission prompt; a human with scripts/gen_vapid_keys.py output in .env must click the real button once to confirm the live path, per the plan's own landmine #3."

# Metrics
duration: ~20min
completed: 2026-08-02
status: complete
---

# Phase 202 Plan 1: End-to-End Remind-Me Opt-In Summary

**Complete browser-side Web Push subscription path (`lib/push.ts`) landed on the Train score screen as a persistent, per-device "Remind me" button that requests permission, subscribes, persists `reminder_enabled` through the existing settings PUT, and confirms in place naming the hour.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-02T12:05:00Z
- **Tasks:** 3
- **Files modified:** 13 (6 created, 7 modified)

## Accomplishments
- Built the app's first and only browser Web Push orchestration module (`lib/push.ts`): feature detection, the single `Notification.requestPermission()`/`PushManager.subscribe()` call site, device-subscription probing via `navigator.serviceWorker.ready`, base64url VAPID key decoding, and the shared `HH:00` hour formatter.
- `usePushCapability` — D-12's gate combining feature detection with a `staleTime: Infinity` VAPID-key query that treats a 404 as "unconfigured" rather than a Sentry-reported error.
- `TrainReminderButton` — the score-screen slot implementing D-01 (persistent, live-derived visibility), D-02 (press is the pre-prompt), D-03 (in-place confirmation naming the hour), D-04 (Done promoted to primary/right), D-05 (per-device asymmetry), and D-13 (inline retry-able error).
- Threaded `reminder_enabled`/`reminder_hour` through the full-replace `TrainSettingsUpdate` PUT body (`types/train.ts`, `useTrainSettings.ts`, `TrainScheduleSettings.tsx`'s `Draft`) so every existing save stays green ahead of Plan 02's controls.
- 47 new/extended automated tests across three files pin the entire branch matrix: the shared subscribe routine, the button's gating ladder, and the score-screen row's hierarchy — including the D-05 asymmetry and the double-press guard as their own explicit, un-reconcilable-away tests.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "Remind me" on the score screen — one path only** - `3b73de9f` (feat)
2. **Task 2: Branch matrix for the shared subscribe routine** - `1cd307c6` (test)
3. **Task 3: Score-screen row, hierarchy and gating assertions** - `46303344` (test)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP update)

## Files Created/Modified
- `frontend/src/types/push.ts` - Field-for-field mirror of `app/schemas/push.py`
- `frontend/src/lib/push.ts` - The single call site of `Notification.requestPermission()`/`PushManager.subscribe()`, feature detection, device-subscription probing, base64url key decoding, hour formatter
- `frontend/src/lib/__tests__/push.test.ts` - Full branch matrix for `ensureDeviceSubscribed` + `urlBase64ToUint8Array` + `formatReminderHour`/`REMINDER_HOUR_OPTIONS`
- `frontend/src/hooks/usePushCapability.ts` - D-12's VAPID-key + feature-detect gate
- `frontend/src/components/train/TrainReminderButton.tsx` - The D-01..D-05/D-13 score-screen slot
- `frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` - End-to-end happy path plus the full hidden/error/in-flight gating matrix
- `frontend/src/types/train.ts` - `reminder_enabled`/`reminder_hour` added to `TrainSettingsResponse`/`TrainSettingsUpdate`
- `frontend/src/api/client.ts` - `pushApi` group (`getVapidPublicKey`, `subscribe` — deliberately no `unsubscribe`)
- `frontend/src/hooks/useTrainSettings.ts` - `TrainSettingsDraft` + `mutationFn` carry the two new fields
- `frontend/src/components/train/TrainScheduleSettings.tsx` - Local `Draft`/seed effect/save-guard extended (pass-through only)
- `frontend/src/components/train/TrainScoreScreen.tsx` - Two-child button row (Remind me + Done), Done promoted to `variant="default"`
- `frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx` - Mutable `TrainReminderButton` mock + row hierarchy/variant assertions
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` - Fixture extended with the two new required fields (deviation, see below)

## Decisions Made
- **D-04 applied, not reconciled:** `TrainScoreScreen`'s `onDone` docstring now records that Phase 202 overrides the SEED-122 "Done is `brand-outline`, it is an exit" rationale, since Done now shares a row with a primary opt-in action.
- **`DeviceSubscribeResult` has no `subscription` field**, unlike an earlier draft in `202-PATTERNS.md` — followed the PLAN.md task text (the authoritative spec for this task) literally, since no downstream consumer in this plan needs the raw subscription payload.
- **`urlBase64ToUint8Array` returns `Uint8Array<ArrayBuffer>`** (not the DOM lib's default `Uint8Array<ArrayBufferLike>`) and is built with `new Uint8Array(n)` + an index loop rather than `Uint8Array.from(...)`, to satisfy `PushSubscriptionOptionsInit.applicationServerKey`'s `BufferSource` type under this project's TS/DOM-lib version.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `TrainScheduleSettings.test.tsx`'s `BASE_SETTINGS` fixture needed the two new required fields**
- **Found during:** Task 1 verification (`npm run build`)
- **Issue:** `TrainSettingsResponse` gained `reminder_enabled`/`reminder_hour` as required fields; the existing fixture object literal in `TrainScheduleSettings.test.tsx` (not in this task's `files_modified` list) failed to compile against the extended type.
- **Fix:** Added `reminder_enabled: false, reminder_hour: 18` to the fixture, with a comment explaining these are pass-through-only in this plan.
- **Files modified:** `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx`
- **Verification:** `npm run build` exits 0; the existing 13 tests in that file all still pass.
- **Committed in:** `3b73de9f` (Task 1 commit)

**2. [Rule 1 - Bug] `urlBase64ToUint8Array`'s TS generic mismatch broke `npm run build`**
- **Found during:** Task 1 verification (`npm run build`)
- **Issue:** `Uint8Array.from(...)`'s inferred `Uint8Array<ArrayBufferLike>` return type is not assignable to `PushSubscriptionOptionsInit.applicationServerKey`'s `BufferSource` (`ArrayBufferView<ArrayBuffer>`) under this project's TS/DOM-lib version — `SharedArrayBuffer` is a member of `ArrayBufferLike` but not of the narrower `BufferSource` union.
- **Fix:** Rebuilt the function via `new Uint8Array(rawData.length)` + an index-assignment loop (always backed by a concrete `ArrayBuffer`) and gave the function an explicit `Uint8Array<ArrayBuffer>` return type.
- **Files modified:** `frontend/src/lib/push.ts`
- **Verification:** `npm run build` exits 0; `push.test.ts`'s decoding tests confirm identical byte output.
- **Committed in:** `3b73de9f` (Task 1 commit)

**3. [Rule 1 - Bug] Plan's literal "0, 1, 2 and 3 padding characters" test spec described an unreachable case**
- **Found during:** Task 2 (`push.test.ts` authoring)
- **Issue:** The base64url padding formula `(4 - len%4) % 4` yields `3` only when `len % 4 === 1`, which never occurs for well-formed unpadded base64/base64url content (valid unpadded lengths are only `len % 4 ∈ {0, 2, 3}`). A test asserting "decodes without throwing" for a length-5 input legitimately throws (`InvalidCharacterError`) because the input is malformed, not because of a bug.
- **Fix:** Tested the three genuinely reachable padding cases (0, 1, 2) instead, with a comment documenting why padding=3 is structurally excluded rather than silently dropping the requirement.
- **Files modified:** `frontend/src/lib/__tests__/push.test.ts`
- **Verification:** All 18 tests in the file pass.
- **Committed in:** `1cd307c6` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking type error from an out-of-scope test fixture, 1 blocking build error from a TS/DOM-lib generic mismatch, 1 bug in the plan's own literal test spec).
**Impact on plan:** All three were necessary to keep the build/test suite green; none expanded scope beyond what the plan already required (extending the reminder fields' shape, decoding VAPID keys correctly, and testing only reachable cases).

## Issues Encountered
None beyond the three deviations above.

## User Setup Required
None for this plan's automated verification. Manual UAT of the *real* end-to-end flow (a real browser permission prompt, a real service-worker subscribe, a real Chrome/Brave delivery-adjacent check) requires `uv run python scripts/gen_vapid_keys.py` output in `.env` — VAPID keys are unset on this dev machine by default (201 D-03), so both surfaces render nothing until that's set, which is the intended D-12 behavior, not a bug. See coverage item D7.

## Next Phase Readiness
- `ensureDeviceSubscribed()`'s `DeviceSubscribeResult` contract, `usePushCapability`, and the extended `TrainSettingsDraft`/PUT body are all in place and tested — Plan 02 (Settings master toggle + hour picker, PERM-03/PERM-04) can consume them directly with no further plumbing.
- No blockers. The one open item is the manual VAPID-configured browser UAT noted above (D7), which is independent of Plan 02's scope.

---
*Phase: 202-reminder-permission-ux*
*Completed: 2026-08-02*

## Self-Check: PASSED

All 7 created/key files found on disk; all 3 task commits (`3b73de9f`, `1cd307c6`, `46303344`) found in git history.
