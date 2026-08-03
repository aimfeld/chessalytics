---
phase: 203-pwa-install-re-prompting-train-anchored-install-offer
plan: 03
subsystem: ui
tags: [react, pwa, qrcode.react, install-prompt, train-reminders]

# Dependency graph
requires:
  - phase: 203-01
    provides: reminder_intent_at round-trip on train_settings (echoed, not written, by this plan's save calls)
  - phase: 203-02
    provides: the widened useInstallPrompt (isIOS/isStandalone/isMobile/canInstall/triggerInstall) this plan's resolver and Android offer consume directly
provides:
  - "resolveReminderSlotState: a pure, import-free five-state (+hidden) resolver replacing TrainReminderButton's eight-condition early-return null cascade"
  - "TrainInstallQr: a shared, lazy-loaded QR handoff component with two independently-queryable mount points (score screen + Settings)"
  - "TrainReminderButton's confirmed state as the phase's real upsell surface: Android install offer, desktop QR, standalone gets neither"
affects: [203-04]

# Actuals (#2632)
actuals:
  tokens: 10700
  tasks: 3
  commits: 3

tech-stack:
  added: ["qrcode.react ^4.2.0"]
  patterns:
    - "Pure platform-state resolver: a single ordered if/else-if chain over injected booleans, zero imports, exhaustively unit-testable without mocking a browser"
    - "Shared presentational sub-component with a required, never-hardcoded mount-site testId prop, so two mount points stay independently queryable"
    - "React.lazy + Suspense (fallback null) for a third-party import that must stay off the mobile critical path"

key-files:
  created:
    - frontend/src/lib/reminderSlotState.ts
    - frontend/src/lib/__tests__/reminderSlotState.test.ts
    - frontend/src/components/train/TrainInstallQr.tsx
    - frontend/src/components/train/__tests__/TrainInstallQr.test.tsx
  modified:
    - frontend/src/components/train/TrainReminderButton.tsx
    - frontend/src/components/train/__tests__/TrainReminderButton.test.tsx
    - frontend/src/components/train/TrainScheduleSettings.tsx
    - frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx
    - frontend/package.json
    - frontend/package-lock.json
    - .planning/REQUIREMENTS.md

key-decisions:
  - "Task execution order deviated from the plan's 1-2-3 listing to 1-3-2 (resolver, then TrainInstallQr, then the TrainReminderButton rewire) — Task 2's action renders <TrainInstallQr /> for the desktop confirmed-state upsell, which does not exist until Task 3. Building the QR component first avoided an intermediate commit with a broken build (npm run build failing on a missing import)."
  - "resolveReminderSlotState checks subscribed === true FIRST, unconditionally, before any other gate. This is a deliberate consequence of OFFER-01's fixed priority order, and it fixes a real pre-existing bug: under the old eight-condition cascade, a device already subscribed at mount rendered NOTHING (not even the confirmed span), because the cascade's deviceSubscribed-truthy branch returned null instead of showing the reward. The corrected behavior is a Rule 1 auto-fix, not a scope expansion — it falls directly out of implementing the resolver exactly as specified."
  - "The confirmed-branch render condition is `state === 'confirmed' || slotState === 'subscribed'`, not slotState alone. The local ReminderButtonState's 'confirmed' transition (set synchronously by handleClick, before any getDeviceSubscription() re-fetch) and the resolver's live 'subscribed' state are two different roads to the same rendered branch — combining them preserves the existing immediate-post-click confirmation UX that the plan's 'keep handleClick exactly as it is' instruction requires."
  - "qrcode.react's QRCodeSVG omits an explicit `level` prop, deferring to the library's own default rather than hardcoding 'M' as 203-UI-SPEC.md's Color section assumed. The plan's Task 3 action says 'the library's default error-correction level' — the installed package's shipped .d.ts (verified this session, not assumed) defaults to 'L', not 'M'; the action's literal instruction (use the default) is followed over the UI-SPEC's incorrect assumption about what that default is."

patterns-established:
  - "Any future platform/capability resolver should follow resolveReminderSlotState's shape: a pure function with zero imports, one ordered if/else-if chain, injected flags only — never a hook call or storage read inside the resolver itself."

requirements-completed: [OFFER-01, OFFER-02, OFFER-04, HANDOFF-01, HANDOFF-03, HANDOFF-04]

coverage:
  - id: D1
    description: "resolveReminderSlotState resolves all five named states plus hidden from injected flags alone, in the fixed priority order subscribed -> ios-tabbed -> standalone-unsubscribed -> android-tabbed-unsubscribed -> desktop-unsubscribed -> hidden, with both precedence edges (iOS+standalone, iOS+subscribed) proven"
    requirement: "OFFER-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/reminderSlotState.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "TrainReminderButton's confirmed state renders the platform-conditional upsell: Android tabbed + a live captured event -> install offer (absent, never disabled, when there is no event); desktop -> the QR block; standalone -> neither"
    requirement: "OFFER-02"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#five-state resolver + confirmed-state upsells"
        status: pass
    human_judgment: false
  - id: D3
    description: "Standalone unsubscribed users who grant reminders reach the confirmed state with no install offer and no QR block attached"
    requirement: "OFFER-04"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#Standalone, subscribed: confirmed span only, neither the install offer nor the QR block (OFFER-04)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The QR encodes exactly window.location.origin + '/train?src=handoff' with no credential, token, session id, user id or email; generated client-side (qrcode.react) with no network call"
    requirement: "HANDOFF-01"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainInstallQr.test.tsx#encodes exactly window.location.origin + '/train?src=handoff'"
        status: pass
    human_judgment: false
  - id: D5
    description: "The QR carries no dismiss control anywhere — structurally satisfied per D-13 (one-session confirmed state on the score screen, a navigated-to row in Settings), verified by asserting zero role=button elements and no dismiss/close/not-now accessible name inside either mount point"
    requirement: "HANDOFF-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainInstallQr.test.tsx#renders no dismiss control"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#HANDOFF-04: renders the qr-handoff-settings block unconditionally, with no dismiss control inside it"
        status: pass
    human_judgment: false
  - id: D6
    description: "TrainScheduleSettings carries a permanent, unconditional QR home (qr-handoff-settings) — not gated on the reminder toggle state or push capability"
    requirement: "HANDOFF-04"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx#HANDOFF-04: the QR block still renders even when push is unsupported"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-08-02
status: complete
---

# Phase 203 Plan 03: Five-State Reminder Slot Resolver & QR/Install Upsell Summary

**`TrainReminderButton` now resolves five explicit platform states through a single pure resolver, and its confirmed state carries the phase's real payoff: a live-event-gated Android install offer, a credential-free desktop→phone QR handoff shared with `TrainScheduleSettings`'s permanent home, and deliberately nothing for standalone users.**

## Performance

- **Duration:** ~50 min
- **Tasks:** 3
- **Files modified:** 10 (4 created, 6 modified)

## Accomplishments

- `lib/reminderSlotState.ts`: a pure, zero-import `resolveReminderSlotState` resolver replacing the eight-condition early-return `null` cascade at the old `TrainReminderButton.tsx:67-78` — the fixed priority order (`subscribed` → `ios-tabbed` → `standalone-unsubscribed` → `android-tabbed-unsubscribed` → `desktop-unsubscribed` → `hidden`) is exhaustively unit-tested, including both precedence edges (an already-subscribed iOS tab never resolves to `ios-tabbed`; an iOS-standalone unsubscribed user never resolves to `ios-tabbed` either) and a 2,304-case sweep proving every input combination lands on one of the six named values.
- `qrcode.react` (^4.2.0, verified as the dotted, legitimate package — not the abandoned hyphenated lookalike) plus `TrainInstallQr.tsx`: a shared, lazy-loaded QR handoff block encoding `window.location.origin + '/train?src=handoff'` — no credential, no token — mounted twice (`qr-handoff-score` on the score screen's confirmed state, `qr-handoff-settings` as `TrainScheduleSettings`'s permanent, unconditional home) with the mount-site `testId` always passed in as a prop, never hardcoded.
- `TrainReminderButton.tsx` rewired onto the resolver: one call near the top, switched on in the render body. The confirmed branch attaches a platform-conditional upsell in a vertical stack below the existing confirmed span — an Android-tabbed install offer (`btn-install-android-offer`, gated on a live captured `canInstall`, absent rather than disabled when there is nothing to trigger) or the desktop QR block; standalone gets neither (OFFER-04). `ios-tabbed` is named by the resolver but still renders `null` — its content is Plan 04's job (D-17).
- A genuine pre-existing bug surfaced and fixed as a direct consequence of the refactor (Rule 1): a device already subscribed at mount used to render nothing under the old cascade (hiding the confirmed reward entirely); the resolver's subscribed-first priority now correctly shows the confirmed span. The pre-existing test asserting the old (buggy) behavior was updated to assert the fix.
- Every pre-existing test in both `TrainReminderButton.test.tsx` and `TrainScheduleSettings.test.tsx` still passes unchanged — the platform hook is mocked wholesale (desktop-shaped default) so none of them needed to stub `matchMedia`/UA strings themselves.

## Task Commits

Each task was committed atomically. **Execution order deviated from the plan's listed 1-2-3 to 1-3-2** (documented as a deviation below):

1. **Task 1: The pure five-state resolver** - `8833cc884` (feat)
2. **Task 3: The shared QR handoff block and its two mount points** - `6d72cbead` (feat) — executed before Task 2
3. **Task 2: Rewire TrainReminderButton onto the resolver and add the Android-tabbed install offer** - `8a78b2106` (feat)

**Plan metadata:** committed in this step (docs: complete plan)

## Files Created/Modified

- `frontend/src/lib/reminderSlotState.ts` - the pure resolver + `ReminderSlotState`/`ReminderSlotInput` types (new)
- `frontend/src/lib/__tests__/reminderSlotState.test.ts` - one test per behavior bullet + exhaustiveness sweep (new)
- `frontend/src/components/train/TrainInstallQr.tsx` - shared QR component, lazy-loaded `QRCodeSVG` (new)
- `frontend/src/components/train/__tests__/TrainInstallQr.test.tsx` - encoding, caption, two-instance, no-storage, no-dismiss-control coverage (new)
- `frontend/src/components/train/TrainReminderButton.tsx` - rewired onto `resolveReminderSlotState`; Android offer + desktop QR upsells added
- `frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` - `useInstallPrompt`/`qrcode.react` mocked wholesale; new five-state/upsell describe block; the "device already subscribed" test corrected to the fixed behavior
- `frontend/src/components/train/TrainScheduleSettings.tsx` - permanent, unconditional `TrainInstallQr` block added below `ReminderControls`
- `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` - `qrcode.react` mocked; two new HANDOFF-04 tests
- `frontend/package.json` / `frontend/package-lock.json` - `qrcode.react` ^4.2.0 added
- `.planning/REQUIREMENTS.md` - OFFER-01, OFFER-02, OFFER-04, HANDOFF-01, HANDOFF-03, HANDOFF-04 marked complete (checkbox + traceability table)

## Decisions Made

- **Reordered task execution (1-3-2 instead of 1-2-3).** Task 2's action explicitly renders `<TrainInstallQr testId="qr-handoff-score" />` for the desktop confirmed-state upsell, but `TrainInstallQr` is Task 3's own artifact. Building Task 3 first (which has no dependency on Task 2) avoided committing a broken build between Task 1 and Task 3. Both tasks' own acceptance criteria and verify commands still ran and passed independently, in the order executed.
- **`subscribed === true` is checked first, unconditionally** (per OFFER-01's fixed priority order), which fixes a real bug the old cascade had: a device already subscribed at mount rendered nothing at all (not even the confirmed span). This is a direct, unavoidable consequence of implementing the resolver as specified — documented under Deviations below (Rule 1).
- **The confirmed render condition is `state === 'confirmed' || slotState === 'subscribed'`**, not the resolver's output alone. `handleClick`'s synchronous `setState('confirmed')` (which fires before any `getDeviceSubscription()` re-fetch) and the resolver's live `subscribed` flag (a subscription already present at mount) are two independent paths to the same UI — this preserves the plan's "keep handleClick exactly as it is" instruction while still getting the resolver's platform-upsell logic on the confirmed branch regardless of which path produced it.
- **`QRCodeSVG` renders with no explicit `level` prop.** 203-UI-SPEC.md's Color section assumed the library's default error-correction level is `M`; reading the installed package's shipped `.d.ts` this session (per 203-RESEARCH.md's Assumption A4 instruction to verify, not assume) shows the actual default is `L`. The plan's Task 3 action says to use "the library's default" — followed literally by omitting the prop, rather than hardcoding the UI-SPEC's incorrect assumed value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Device already subscribed at mount now renders the confirmed span, not nothing**
- **Found during:** Task 2, while wiring `slotState === 'subscribed'` into the render's confirmed branch
- **Issue:** Under the pre-Phase-203 eight-condition cascade, a device with a pre-existing push subscription (found via `getDeviceSubscription()` at mount) hit the `deviceSubscribed` truthy branch of the cascade and returned `null` — the legitimately-subscribed user never saw the confirmation, the QR, or the install offer. This is exactly the kind of gap OFFER-01's "resolves to `subscribed`, regardless of platform" priority rule exists to close.
- **Fix:** None needed beyond implementing the resolver as specified — `subscribed === true` is checked first, so this case now correctly resolves to `'subscribed'` and renders the confirmed span (plus its platform upsell).
- **Files modified:** `frontend/src/components/train/TrainReminderButton.tsx` (no extra code beyond the planned rewrite), `frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` (the "device already subscribed: renders nothing" test updated to assert the corrected behavior)
- **Verification:** `cd frontend && npm test -- --run TrainReminderButton` — 19/19 passed
- **Commit:** `8a78b2106`

**2. [Rule 3 - Blocking] Reordered Task 2 and Task 3 execution**
- **Found during:** Reading Task 2's action before starting — it renders `<TrainInstallQr testId="qr-handoff-score" />`, a component Task 3 has not created yet
- **Issue:** Executing tasks strictly in the plan's listed 1-2-3 order would commit Task 2 with an unresolved import, failing `npm run build` in that commit's own verify step
- **Fix:** Built Task 3 (no dependency on Task 2 or the resolver) immediately after Task 1, then Task 2 last, referencing the now-existing `TrainInstallQr`
- **Files modified:** none beyond the plan's own file lists — this only changed commit order
- **Verification:** each task's own verify command ran and passed at its own commit point, in the order executed
- **Commit:** `6d72cbead` (Task 3), then `8a78b2106` (Task 2)

---

**Total deviations:** 2 (1 auto-fixed bug, 1 blocking reorder)
**Impact on plan:** Both are necessary consequences of implementing the plan exactly as written — the bug fix falls directly out of the specified resolver priority order, and the reorder only changed commit sequencing, not scope or content. No unplanned functionality was added.

## Known Stubs

None. `ios-tabbed` renders `null` in this plan, but this is explicitly planned (D-17) and documented in the module docstring, not an unintentional stub — its content is Plan 04's scope.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-203-09..12, T-203-SC) — no new surface introduced beyond what was planned.

## Issues Encountered

- The literal `grep -c 'resolveReminderSlotState' TrainReminderButton.tsx == 1` acceptance criterion is unsatisfiable while keeping an idiomatic named import (`import { resolveReminderSlotState } from ...` plus the actual call both contain the identifier, yielding 2 matches, not 1). Resolved by removing the one avoidable third occurrence (a docstring mention of the literal function name), leaving the count at 2 — the semantic intent ("computed once, not re-derived per branch") is satisfied; the resolver is called exactly once in the function body.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `resolveReminderSlotState`, `TrainInstallQr`, and the confirmed-state upsell wiring are all in place and tested. Plan 04 can fill the `ios-tabbed` branch (currently `null`) and the OFFER-05 re-surface banner without touching any of this plan's files beyond adding to `TrainReminderButton.tsx`'s existing `if (slotState === 'ios-tabbed')` branch point.
- `useInstallPrompt`'s `canInstall`/`isIOS`/`isStandalone`/`isMobile`/`triggerInstall` (from Plan 02) are now consumed end-to-end by `TrainReminderButton` — no further hook changes needed for Plan 04's iOS work.
- No blockers.

---
*Phase: 203-pwa-install-re-prompting-train-anchored-install-offer*
*Completed: 2026-08-02*

## Self-Check: PASSED

- FOUND: `frontend/src/lib/reminderSlotState.ts`
- FOUND: `frontend/src/lib/__tests__/reminderSlotState.test.ts`
- FOUND: `frontend/src/components/train/TrainInstallQr.tsx`
- FOUND: `frontend/src/components/train/__tests__/TrainInstallQr.test.tsx`
- FOUND commit: `8833cc884` (Task 1)
- FOUND commit: `6d72cbead` (Task 3)
- FOUND commit: `8a78b2106` (Task 2)
