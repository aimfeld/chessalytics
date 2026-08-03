---
phase: 202-reminder-permission-ux
plan: 02
subsystem: ui
tags: [react, tanstack-query, web-push, train, settings]

# Dependency graph
requires:
  - phase: 202-reminder-permission-ux
    plan: "202-01"
    provides: "ensureDeviceSubscribed(), usePushCapability, DeviceSubscribeResult union, reminder_enabled/reminder_hour threaded through TrainSettingsResponse/Update and the Draft"
provides:
  - "The permanent PERM-03/PERM-04 recovery surface: TrainScheduleSettings' master 'Remind me to train' Switch and 24-hour 'Remind at' Select"
  - "The D-09 documented async exception to the debounced-draft pattern (toggle-ON only), and the D-07 toggle-OFF guarantee that off touches nothing but reminder_enabled"
  - "The D-11 render-only per-device blocked state that never mutates account-wide reminder_enabled on mount reconciliation"
affects: []

# Actuals (#2632)
actuals:
  tokens: 7700
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Documented asynchronous exception to an otherwise-synchronous debounced-draft pattern (toggle-ON only), with a file-header docstring warning a later reader not to 'fix' it into consistency"

key-files:
  created: []
  modified:
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx

key-decisions:
  - "Toggle-ON is the one asynchronous exception to the debounced-draft pattern (D-09): reminderEnabled is only written into the draft after ensureDeviceSubscribed() resolves 'subscribed'. Toggle-OFF and hour changes ride the existing 600ms debounce unchanged, exactly as the plan specified."
  - "D-11 mount-time reconciliation of a per-device block is render-only — no PUT is ever issued to silence the account-wide setting on behalf of one blocked browser (D-05: the block is per-device, reminder_enabled is account-wide)."

patterns-established: []

requirements-completed: [PERM-03, PERM-04]

coverage:
  - id: D1
    description: "TrainScheduleSettings hosts a master 'Remind me to train' Switch and, when on, a 24-hour 'Remind at' Select; both auto-save through the existing debounced draft exactly like the weekday chips and puzzle-count picker (PERM-03)"
    requirement: "PERM-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#toggling on with a granted prompt and a resolving subscribe produces exactly one updateSettings call with reminder_enabled: true"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#hour-change test asserting the single captured body has the chosen reminder_hour and unchanged weekday_mask/puzzles_per_session"
        status: pass
    human_judgment: false
  - id: D2
    description: "Toggle-ON never writes reminder_enabled into the draft until the browser grant and POST /push/subscribe have both succeeded (D-09); denied, dismissed and subscribe-rejected all produce zero PUTs"
    requirement: "PERM-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#denied/dismissed/subscribe-rejected each assert trainApi.updateSettings was not called"
        status: pass
    human_judgment: false
  - id: D3
    description: "Toggle-OFF writes reminder_enabled: false through the existing debounced draft and calls neither pushApi.subscribe nor the browser subscription's unsubscribe() (D-07/PERM-04) — turning reminders back on needs no second permission prompt"
    requirement: "PERM-04"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#toggle-off test asserting subscriptionUnsubscribe and pushApi.subscribe were never called"
        status: pass
    human_judgment: false
  - id: D4
    description: "A per-device browser block (Notification.permission === 'denied') renders the toggle off/disabled with the D-11 blocked sentence and issues no PUT, including on mount-time reconciliation against a server-true reminder_enabled — a blocked device never silently disables reminders on the user's other devices (D-05)"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#Notification.permission stubbed 'denied': Switch disabled/unchecked, train-reminder-blocked renders, filter-reminder-hour absent, updateSettings not called"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#mounting with reminder_enabled: true from the server and permission 'denied' asserts updateSettings was not called"
        status: pass
    human_judgment: false
  - id: D5
    description: "The whole reminder block is structurally absent (no explanatory copy, no disabled placeholder) when push is unsupported or the VAPID key query resolves to no key (D-10/D-12), and the weekday chips/puzzle presets are unaffected"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#VAPID key 404: filter-reminder-enabled is null, weekday chips still render"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#PushManager not stubbed on the global: filter-reminder-enabled is null"
        status: pass
    human_judgment: false
  - id: D6
    description: "Live-browser UAT of the complete Phase 202 permission flow end to end: real Notification prompt (dismiss then grant), real service-worker subscribe, real settings-card toggle/hour save, real off-then-on with no second prompt, real block-and-reload with no stray PUT, real notification delivery via the dev-only trigger endpoint"
    verification: []
    human_judgment: true
    rationale: "Automated tests stub every browser API and jsdom cannot render or drive a real permission prompt or deliver a real push notification. The user ran the full 11-step protocol in the plan's Task 3 and approved on 2026-08-02 (resume-signal 'approved')."

# Metrics
duration: ~35min (across two sessions, split by the Task 3 checkpoint)
completed: 2026-08-02
status: complete
---

# Phase 202 Plan 2: Reminder Settings Toggle & Hour Picker Summary

**`TrainScheduleSettings` becomes the permanent PERM-03/PERM-04 recovery surface — a master "Remind me to train" Switch and 24-hour "Remind at" Select that auto-save like the weekday chips, with toggle-ON as the one documented asynchronous exception gated on a real browser grant plus `POST /push/subscribe`.**

## Performance

- **Duration:** ~35 min across two sessions (Tasks 1-2 autonomous, Task 3 a blocking human-verify checkpoint that paused for a live-browser UAT round)
- **Completed:** 2026-08-02
- **Tasks:** 3 (2 code tasks + 1 checkpoint)
- **Files modified:** 3 (2 in Task 1's scope, +1 out-of-scope fixture touched by Task 2's deviation)

## Accomplishments
- Added the third sibling block to `TrainScheduleSettings.tsx`: a `ReminderControls` sub-component hosting the master Switch, the D-08 24-hour Select (`REMINDER_HOUR_OPTIONS`/`formatReminderHour` from `lib/push.ts`), the D-11 blocked sentence, and the D-13 `reminder-error` `IndicatorState` branch in the existing `ScheduleCardShell` header slot.
- Implemented D-09's documented async exception in `onCheckedChange`: toggle-ON only writes `reminderEnabled: true` into the draft after `ensureDeviceSubscribed()` resolves `'subscribed'`; toggle-OFF and hour changes ride the existing 600ms debounce unchanged, exactly like the weekday chips and puzzle-count picker.
- Wired `usePushCapability()` to gate the whole block structurally absent on unsupported browsers or a 404'd VAPID key (D-10/D-12), with a local `deniedNow` flag so a denial mid-session takes effect immediately without a remount.
- Extended `TrainScheduleSettings.test.tsx` with the full behavior matrix from Task 1, including three negative-assertion tests specifically framed to catch silent regressions: PERM-04's toggle-off must never call `pushApi.subscribe` or the stubbed subscription's `unsubscribe`; D-09's denied/dismissed/subscribe-rejected paths must produce zero `trainApi.updateSettings` calls; and D-11's mount-time reconciliation (server `reminder_enabled: true` + permission `'denied'`) must also produce zero PUTs, proving the per-device block never silences the account-wide setting.
- Closed Task 3's blocking human-verify checkpoint: the user ran the full 11-step live-browser UAT protocol (dismiss-then-grant prompt, score-screen confirmation, settings-card toggle/hour save, off-then-on with no second prompt, block-and-reload with no stray PUT, real notification delivery) and approved on 2026-08-02.

## Task Commits

Each code task was committed atomically; Task 3 is a checkpoint with no code deliverable of its own:

1. **Task 1: Master reminder toggle, hour picker and blocked state** - `3426447a` (feat)
2. **Task 2: Settings coverage — auto-save, spring-back and the toggle-off negatives** - `953b0aa1` (test)
3. **Task 3: Live-browser UAT of the full permission flow** - checkpoint, no commit; human-verified and approved 2026-08-02 (see Checkpoint Resolution below)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP/REQUIREMENTS update)

## Files Created/Modified
- `frontend/src/components/train/TrainScheduleSettings.tsx` - `ReminderControls` sub-component (Switch + Select + blocked row), D-09 async toggle-ON exception, D-13 `reminder-error` indicator branch
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` - Full behavior matrix: gating, denied/dismissed/error branches, toggle-off negatives, hour-change body assertions, 24-option coverage, in-flight disabled state
- `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` - Deviation fix (see below): `usePushCapability` mocked so the file's 12 pre-existing tests keep passing

## Checkpoint Resolution

Task 3 (`checkpoint:human-verify`, `gate="blocking"`) required a real-browser round trip that automated tests structurally cannot cover: an actual `Notification.requestPermission()` prompt, an actual service-worker subscribe, and actual push delivery. There is no code deliverable attached to this task in the plan — it is the UAT gate itself.

**Resolution:** the user ran the plan's 11-step verification protocol (score-screen "Remind me" dismiss-then-grant, in-place confirmation naming the hour, settings-card toggle/hour auto-save, toggle off-then-on with no second permission prompt, a rapid off/on inside the debounce window settling on ON after reload, a real notification delivered via the dev-only trigger endpoint, and a browser-level block leaving both surfaces absent/disabled with no stray `PUT /train/settings`) and responded **"approved"**. Per the plan's own resolution ladder this closes PERM-03 and PERM-04's only remaining human-judgment coverage item (D6 above) with no further action needed.

## Decisions Made
- **D-09 applied exactly as specified:** toggle-ON is the sole asynchronous exception to the debounced-draft pattern; the component's file-header docstring records why, so a later reader does not "fix" it into consistency with the other controls.
- **D-11 reconciliation is render-only:** a per-device `Notification.permission === 'denied'` never issues a PUT to flip the account-wide `reminder_enabled` off, even when the server's stored value is `true` at mount — the block is per-device (D-05), the setting is account-wide, and only the browser-native re-grant flow (outside this app) can recover a blocked device.
- **Out-of-plan admin test card** (see Deviations) was accepted mid-checkpoint as a user-requested UAT convenience, not a plan requirement.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `TrainStartScreen.test.tsx` needed `usePushCapability` mocked**
- **Found during:** Task 2 (extending `TrainScheduleSettings.test.tsx`)
- **Issue:** `TrainScheduleSettings` (rendered by `TrainStartScreen`) began calling `usePushCapability()`, which issues a `useQuery`. `TrainStartScreen.test.tsx` renders the component tree without a `QueryClientProvider` by design (its own scope predates push), so all 12 of its existing tests started throwing `No QueryClient set, use QueryClientProvider to set one`.
- **Fix:** Added `vi.mock('@/hooks/usePushCapability')` returning `{ available: false, isResolved: true, permission: 'default', vapidPublicKey: null }`, keeping the reminder block structurally absent in that file's tests without requiring a query client.
- **Files modified:** `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx`
- **Verification:** all 12 pre-existing tests in the file pass; full suite green (210 files / 3120 tests).
- **Committed in:** `953b0aa1` (Task 2 commit)

### Out-of-Plan Work (user-requested, not scoped to this plan)

**`848b3c197` — dev-only Train reminder test card (admin panel)**

Mid-checkpoint, the user requested a clickable UAT convenience in place of a hand-copied-bearer-token `curl` for step 9 of the verification protocol. This commit adds:
- `frontend/src/components/admin/TrainReminderTestCard.tsx` (+ its test)
- `pushApi.devTriggerReminder` client method and a `DevTriggerReminderResponse` type in `frontend/src/api/client.ts` / `frontend/src/types/push.ts`
- An `import.meta.env.DEV`-gated section in `frontend/src/pages/Admin.tsx`, tree-shaken from the production bundle the same way `TrainDevClock` is

This work is **not** claimed against PERM-03/PERM-04 in the traceability table above and carries no `must_haves`/acceptance-criteria coverage of its own — it is out of this plan's file scope (`TrainScheduleSettings.tsx` + its test only) and out of the phase's frontend-only boundary in spirit only insofar as it touches `Admin.tsx`/`client.ts` rather than the two files the plan named. It is called out here so the verifier is not surprised by files in the branch diff that do not map to a plan task.

---

**Total deviations:** 1 auto-fixed (blocking test-infra fix, in-scope) + 1 out-of-plan commit (user-requested UAT tooling, explicitly not claimed against requirements).
**Impact on plan:** The blocking fix was necessary to keep the full suite green. The out-of-plan admin card does not affect PERM-03/PERM-04 delivery or this plan's `must_haves`/verification — it is additive tooling for the human verifier only.

## Issues Encountered
None beyond the deviation and out-of-plan item above.

## User Setup Required
None going forward. The one setup step this plan's UAT depended on (`uv run python scripts/gen_vapid_keys.py` output in `.env`) was already satisfied before the checkpoint ran, per the resume signal.

## Next Phase Readiness
- PERM-01 through PERM-04 are all Complete. Phase 202 has no further plans — this closes the phase.
- v2.11's three phases (200, 201, 202) are all complete; `/gsd-complete-milestone` is the next natural step once any remaining LEGEND-06/EXPLORE-07 375px mobile UAT items (tracked as Pending in REQUIREMENTS.md against Phase 200, not this plan) are resolved or explicitly deferred.
- No blockers.

---
*Phase: 202-reminder-permission-ux*
*Completed: 2026-08-02*

## Self-Check: PASSED

All 3 modified files found on disk; both task commits (`3426447a`, `953b0aa1`) found in git history; the out-of-plan commit (`848b3c197`) also found in git history and correctly disclosed above.
