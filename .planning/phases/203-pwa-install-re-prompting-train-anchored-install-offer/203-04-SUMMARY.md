---
phase: 203-pwa-install-re-prompting-train-anchored-install-offer
plan: 04
subsystem: ui
tags: [pwa, install-prompt, ios, service-worker, react-router, vitest]

# Dependency graph
requires:
  - phase: 203-01
    provides: reminder_intent_at round-trip on train_settings (the iOS tap writes it synchronously)
  - phase: 203-02
    provides: useInstallPrompt's isIOS/isStandalone/isMobile signals, consumed directly by both new surfaces
  - phase: 203-03
    provides: resolveReminderSlotState's ios-tabbed branch (named but null) and TrainInstallQr, both extended/reused here
provides:
  - "The iOS-tabbed reminder slot filled: a real install affordance with a synchronous reminder_intent_at write and honest two-step Add-to-Home-Screen instructions (OFFER-03)"
  - "useReminderResurface / useReminderResurfaceRedirect: the OFFER-05 standalone re-surface decision, its per-device dismiss flag, and the active route push to /train from ProtectedLayout"
  - "TrainReminderResurfaceBanner: the non-blocking re-surface prompt mounted at the top of TrainStartScreen's landing content"
  - "useTrainReminderSlot: the score-screen slot's whole state machine extracted to a hook returning { control, belowRow }, so the row keeps a fixed two-cell shape no matter which platform state is active"
  - "A fixed useInstallPrompt bug: window.matchMedia() called without an existence/throw guard, which crashed the app-wide useReminderResurface consumer in an environment lacking a matchMedia polyfill"
affects: []

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 19400
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Row-cell vs. below-row split: a screen-slot hook returns { control, belowRow } from ONE state instance so a cramped max-w-sm flex row never has to cram overflow content (error copy, multi-step instructions, upsell blocks) into one flex-1 cell — the row only ever holds a pressable control; everything else renders as a full-width line below it."
    - "Two-hook split for a router-driven side effect: useReminderResurface (pure decision, no router dependency, independently testable) + useReminderResurfaceRedirect (router-only wiring, called with zero arguments from the layout) — keeps the decision hook mockable without a Router wrapper."

key-files:
  created:
    - frontend/src/hooks/useReminderResurface.ts
    - frontend/src/hooks/__tests__/useReminderResurface.test.ts
    - frontend/src/components/train/TrainReminderResurfaceBanner.tsx
    - frontend/src/components/train/__tests__/TrainReminderResurfaceBanner.test.tsx
  modified:
    - frontend/src/components/train/TrainReminderButton.tsx
    - frontend/src/components/train/__tests__/TrainReminderButton.test.tsx
    - frontend/src/components/train/TrainScoreScreen.tsx
    - frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx
    - frontend/src/components/train/TrainStartScreen.tsx
    - frontend/src/components/train/__tests__/TrainStartScreen.test.tsx
    - frontend/src/App.tsx
    - frontend/src/hooks/useInstallPrompt.ts

key-decisions:
  - "Combined UAT-round deviation (D-13, D-15/UI-SPEC row 33, Phase 202 D-03/UI-SPEC E2), all on direct user instruction across three checkpoint rounds — see the dedicated section below."
  - "useTrainReminderSlot is the sole exported symbol that renders anything from TrainReminderButton.tsx — the file's original wrapper component was deleted mid-plan (UAT round 3) once it became production-dead: TrainScoreScreen calls the hook directly and TrainReminderResurfaceBanner imports only ERROR_COPY. Its own test file now uses a local harness component instead."
  - "useInstallPrompt.ts's isStandalone computation gained a matchMedia existence/throw guard (Rule 1 bug fix, not in this plan's files_modified) — surfaced by useReminderResurface becoming an app-wide consumer (mounted in ProtectedLayout) that reached a code path Train.solveLoop.test.tsx exercises without a matchMedia polyfill."
  - "The eslint-config react-refresh exemption added in UAT round 1 for TrainReminderButton.tsx's co-exported hook+component was removed again in round 3 once the component itself was deleted — the file exports no component, so the rule no longer applies (confirmed: lint passes clean without the exemption)."

patterns-established:
  - "Any future score-screen or other cramped-row slot should follow useTrainReminderSlot's { control, belowRow } shape: the row holds only a pressable control, every non-interactive or overflow element renders below it — stated as one invariant in the module docstring, not a list of exceptions."

requirements-completed: [OFFER-03, OFFER-05]

coverage:
  - id: D1
    description: "The iOS-tabbed reminder slot (previously null) shows a 'Get reminders' button; tapping it fires an immediate PUT /train/settings with a non-null reminder_intent_at (never the debounced draft path), never calls the subscribe/permission APIs, and reveals honest two-step Add-to-Home-Screen instructions below the row regardless of the write's outcome (OFFER-03)"
    requirement: "OFFER-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderButton.test.tsx#iOS-tabbed slot (OFFER-03, D-14/D-15)"
        status: pass
      - kind: manual_procedural
        ref: "Task 3 checkpoint — desktop Chrome, iPhone Safari UA override, approved 2026-08-02"
        status: pass
    human_judgment: true
    rationale: "CONTEXT.md D-01 / SEED-134 amendment E: this iOS branch ships without real-device verification by design (the operator has no iPhone). Desktop-Chrome UA emulation and unit tests prove the code paths, but whether the real Add-to-Home-Screen → standalone flow works end to end on an actual iPhone is a passive post-deploy signal (iOS standalone devices appearing in push_subscriptions), not something this plan can automate or a human can currently click through."
  - id: D2
    description: "A standalone launch with reminder_intent_at set and no device subscription actively routes to /train and shows a non-blocking re-surface banner; it clears on subscribe (no reload) or per-device dismiss, and every unresolved/unavailable/throwing signal fails safe to no redirect and no banner (OFFER-05)"
    requirement: "OFFER-05"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useReminderResurface.test.ts"
        status: pass
      - kind: unit
        ref: "frontend/src/components/train/__tests__/TrainReminderResurfaceBanner.test.tsx"
        status: pass
      - kind: manual_procedural
        ref: "Task 3 checkpoint — desktop Chrome, approved 2026-08-02"
        status: pass
    human_judgment: true
    rationale: "Same CONTEXT.md D-01 caveat as D1: the real Add-to-Home-Screen → standalone launch → active route push → subscribe flow on a physical iPhone cannot be exercised here. The fail-safe-to-false decision logic and the banner's own behavior are unit-tested and desktop-verified; the real-device round trip is a passive post-deploy signal only."

duration: ~1h20m (across three UAT/checkpoint rounds)
completed: 2026-08-02
status: complete
---

# Phase 203 Plan 04: iOS Install Affordance & Standalone Re-Surface Banner Summary

**The iOS-tabbed reminder slot gets a real "Get reminders" affordance with a synchronous `reminder_intent_at` write and honest two-step instructions, and a standalone launch with recorded install intent actively routes to `/train` and shows a non-blocking re-surface banner — closing the install→reminder two-session cliff — with the whole score-screen slot refactored into a `{ control, belowRow }` hook after three UAT rounds converged on one placement invariant.**

## Performance

- **Duration:** ~1h20m (across three checkpoint rounds — see Deviations)
- **Started:** 2026-08-02T19:00:00Z (approx.)
- **Completed:** 2026-08-02T20:22:00Z
- **Tasks:** 3 (2 code tasks + 1 human-verify checkpoint)
- **Files modified:** 12 (4 created, 8 modified)

## Accomplishments

- The `ios-tabbed` branch — named by Plan 03's resolver but rendering `null` — now shows a "Get reminders" button. Tapping it fires one explicit, immediate `PUT /train/settings` carrying a fresh `reminder_intent_at` (before any UI transition, never the 600ms debounced draft path), never touches the subscribe/permission APIs, and reveals honest two-step Add-to-Home-Screen instructions regardless of the write's outcome (fail-open).
- `useReminderResurface`/`useReminderResurfaceRedirect`: the OFFER-05 decision (standalone + intent set + no device subscription + not dismissed) drives an active, once-per-mount route push to `/train` from `ProtectedLayout`, plus a self-contained `TrainReminderResurfaceBanner` mounted at the top of `TrainStartScreen`'s landing content. Every unresolved/unavailable/throwing signal fails safe to no redirect and no banner, per the phase's fail-safe requirement.
- A real, pre-existing bug fixed as a direct consequence of this plan's new app-wide consumer: `useInstallPrompt`'s `isStandalone` computation called `window.matchMedia()` with no existence/throw guard, crashing in an environment lacking a `matchMedia` polyfill (`Train.solveLoop.test.tsx`) once `useReminderResurface` started calling the hook from `ProtectedLayout`.
- Three rounds of UAT feedback on the score-screen slot converged on one invariant, extracted into `useTrainReminderSlot()`: **the row only ever holds a pressable reminder control; every non-interactive or overflow element renders below it.** The row keeps a fixed two-cell shape (`control` | "Done") in every state; a `null` control (confirmed or hidden) leaves "Done" spanning the row alone.
- The `TrainReminderButton` wrapper component, made production-dead by the round-3 refactor, was deleted; its test file now uses a local harness component, and the round-1 eslint exemption for the file's co-exported hook+component was removed once the component no longer existed (lint passes clean without it).

## Task Commits

Each task was committed atomically, plus two post-checkpoint fix commits from UAT feedback:

1. **Task 1: Fill the ios-tabbed branch — install affordance, synchronous intent write, honest two-step instructions** - `658d98fca` (feat)
2. **Task 2: Standalone re-surface — the decision hook, the banner, and the active route push** - `541dda327` (feat)
3. **UAT round 1 fix: keep the score-screen reminder control in the row, move overflow below it** - `5eeda049c` (fix)
4. **UAT round 3 fix: move the confirmed reminder line below the row too; drop dead wrapper** - `99846dcad` (fix)
5. **Task 3: Human verification of the whole phase in desktop Chrome** — checkpoint, approved 2026-08-02, no artifact of its own to commit

**Plan metadata:** committed in this step (docs: complete plan)

## Files Created/Modified

- `frontend/src/hooks/useReminderResurface.ts` - the OFFER-05/D-16 decision hook (`useReminderResurface`) plus the router-only `useReminderResurfaceRedirect` wiring, and `TRAIN_RESURFACE_DISMISSED_KEY` (new)
- `frontend/src/hooks/__tests__/useReminderResurface.test.ts` - fail-safe truth table + redirect-once coverage (new)
- `frontend/src/components/train/TrainReminderResurfaceBanner.tsx` - the self-contained re-surface Card, reusing `ensureDeviceSubscribed` and `TrainReminderButton`'s `ERROR_COPY` (new)
- `frontend/src/components/train/__tests__/TrainReminderResurfaceBanner.test.tsx` - subscribe/dismiss/error-path coverage (new)
- `frontend/src/components/train/TrainReminderButton.tsx` - the `ios-tabbed` branch filled; whole state machine extracted to `useTrainReminderSlot()` returning `{ control, belowRow }`; the wrapper component deleted (UAT round 3)
- `frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` - iOS-tabbed coverage added; existing assertions updated for the row/below-row split; local `ReminderSlotHarness` replaces the deleted component import
- `frontend/src/components/train/TrainScoreScreen.tsx` - calls `useTrainReminderSlot()` directly, placing `control` in the row and `belowRow` on a full-width line beneath it
- `frontend/src/components/train/__tests__/TrainScoreScreen.test.tsx` - row-shape and below-row placement coverage, including the confirmed-state null-control/full-width-Done case
- `frontend/src/components/train/TrainStartScreen.tsx` - mounts `<TrainReminderResurfaceBanner />` as the first element in the landing content, additive (not a seventh `resolveLandingState` branch)
- `frontend/src/components/train/__tests__/TrainStartScreen.test.tsx` - DOM-order coverage for the banner ahead of the streak card
- `frontend/src/App.tsx` - `ProtectedLayout` calls `useReminderResurfaceRedirect()`
- `frontend/src/hooks/useInstallPrompt.ts` - `isStandalone`'s `matchMedia` call guarded against absence/throw (Rule 1 bug fix)

## Decisions Made

- See `key-decisions` in the frontmatter, plus the dedicated Deviations section below for the three-round layout deviation.

## Deviations from Plan

### Combined UAT-round deviation: the score-screen slot's placement rules (checkpoint rounds 1-3, direct user instruction)

The plan's `must_haves.truths` specified in-place replacement for the error copy (D-13), the iOS instructions (D-15/UI-SPEC row 33), and left the confirmed line's row placement as Phase 202's existing shape (D-03/UI-SPEC E2). Live human verification in desktop Chrome (Task 3) found that `TrainScoreScreen`'s `flex w-full max-w-sm items-center gap-2` two-cell row (reminder control | "Done") has no room for a full sentence or a stacked upsell block — content either clipped or produced a tall, misaligned column. Across three checkpoint rounds the user redirected the placement, converging on one rule:

**Round 1 (D-13, D-15/UI-SPEC row 33):** the error copy and the iOS two-step instructions no longer replace their button in place. The button keeps its label ("Remind me" / "Get reminders") and stays pressable; the overflow text renders as its own full-width line below the row. D-15's load-bearing part is preserved unchanged — the synchronous `reminder_intent_at` write still fires on the tap before any UI transition, and the reveal is still unconditional (fires in the mutation's `onSettled`, on both success and failure). Only the DISPLAY PLACEMENT of the resulting instructions moved; the write timing and fail-open guarantee did not.

**Round 2 (scope amendment, same round):** the iOS "Get reminders" button, which previously stayed disabled forever after the tap, was changed to re-enable once the write settles (`onSettled` resets `iosPending`) — re-tapping fires another harmless write.

**Round 3 (Phase 202 D-03/UI-SPEC E2):** the confirmed "Reminders on — HH:MM on your training days" line — non-interactive, nothing left to press — moved out of the row into the same below-row slot, ahead of its platform upsell (Android install offer or desktop QR). In the confirmed state `control` is `null`, leaving "Done" as the row's sole `flex-1` child, verified by a dedicated test that the row has exactly one child and "Done" spans the row with no dead space.

**Resulting invariant**, stated once in `TrainReminderButton.tsx`'s module docstring rather than as three separate carve-outs: **the row only ever holds a pressable reminder control; every non-interactive or overflow element renders below it.**

- **Mechanism:** `useTrainReminderSlot()` — extracted from the original single-return-value `TrainReminderButton` component — returns `{ control, belowRow }` from ONE hook call, so `TrainScoreScreen` can place them in two different rows of a `flex-col` wrapper without instantiating two independent copies of the same state (a requirement the user stated explicitly: "one state instance is non-negotiable").
- **Dead-code follow-up (also round 3):** once `TrainScoreScreen` called the hook directly, the original `TrainReminderButton` wrapper component became reachable only from its own test file — production-dead by CLAUDE.md's standard. Deleted; `TrainReminderButton.test.tsx` now renders a local `ReminderSlotHarness` component instead. The round-1 `eslint.config.js` exemption for the file's co-exported hook+component (`react-refresh/only-export-components`) was removed in the same pass — confirmed via a clean lint run that the rule no longer fires once the file exports no component.
- **Files modified beyond the plan's own `files_modified` list:** `frontend/eslint.config.js` (added then fully reverted across rounds 1 and 3 — net zero diff against pre-plan `HEAD`).
- **Verification:** full frontend gate (`npm run lint`, `npm run knip`, `npm test -- --run`, `npm run build`) re-run clean after each round; final state has 3229 passing tests (218 files) vs. 3223 before this plan.
- **Impact on plan:** No scope expansion beyond the score-screen slot's own layout — every change stayed inside `TrainReminderButton.tsx`, `TrainScoreScreen.tsx`, their test files, and the temporary eslint-config round-trip. All three deviations were explicit, direct user instructions during live verification, not autonomous judgment calls.

### Auto-fixed Issues

**1. [Rule 1 - Bug] `useInstallPrompt`'s `isStandalone` crashed on a missing `window.matchMedia`**
- **Found during:** Task 2, running the full frontend test suite after mounting `useReminderResurface` app-wide in `ProtectedLayout`
- **Issue:** `useInstallPrompt.ts` called `window.matchMedia('(display-mode: standalone)').matches` unconditionally whenever `typeof window !== 'undefined'`, with no guard for `matchMedia` being absent or throwing. `Train.solveLoop.test.tsx` doesn't stub `window.matchMedia` and had never previously triggered a `useInstallPrompt()` call from a code path it exercises — this plan's new `TrainReminderResurfaceBanner` (mounted unconditionally in `TrainStartScreen`) was the first consumer to reach it there, crashing 7 tests.
- **Fix:** Wrapped the `matchMedia` read in a small guarded function checking `typeof window.matchMedia === 'function'` and catching any throw, degrading to "not standalone" — exactly the phase's own fail-safe requirement for an unavailable iOS signal.
- **Files modified:** `frontend/src/hooks/useInstallPrompt.ts` (not in this plan's `files_modified`)
- **Verification:** `npm test -- --run` — 3223/3223 passed (later 3229/3229 after round 1/3 test additions)
- **Committed in:** `541dda327` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed bug (Rule 1) + 1 combined three-round layout deviation on direct user instruction (rounds 1-3, not an autonomous deviation rule)
**Impact on plan:** The bug fix was necessary for correctness and is scoped to the exact signal the plan's fail-safe requirement already covers. The layout deviation changed only placement/enablement of already-planned content — no new feature, no scope creep — driven entirely by live human verification the plan itself required.

## Known Stubs

None.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers — no new endpoint, no new authorization surface, and the automatic route push destination remains a hardcoded `'/train'` literal (T-203-14's mitigation), unaffected by the layout changes.

## Issues Encountered

- Three rounds of checkpoint feedback on the same score-screen slot (see Deviations) — each round's fix was verified with the full frontend gate before re-presenting the checkpoint, so no regression accumulated across rounds.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

This is the last plan in Phase 203. All 46 phase requirements (INSTALL-01..06, OFFER-01..05, HANDOFF-01..04) are now either Complete or recorded as deliberate deviations (INSTALL-02 superseded by D-03, HANDOFF-03 satisfied structurally per D-13, both from Plan 02/03). OFFER-03 and OFFER-05 close out with this plan.

**Standing caveat, carried forward from CONTEXT.md D-01 / SEED-134 amendment E:** the real-device iOS behavior — the Add-to-Home-Screen → standalone launch → active route push → subscribe round trip — ships UNVERIFIED by design. The operator has no iPhone; everything verified in this plan (unit tests plus the Task 3 checkpoint) was desktop Chrome with UA/media-query emulation, not a real device. The passive, post-deploy signal is whether iOS standalone devices begin appearing in `push_subscriptions` in the weeks after this phase ships. No further action is blocked on this — it is an accepted, explicitly-scoped gap per the phase's own design, not a phase-closing task.

No blockers for phase close.

---
*Phase: 203-pwa-install-re-prompting-train-anchored-install-offer*
*Completed: 2026-08-02*

## Self-Check: PASSED

- FOUND: `frontend/src/hooks/useReminderResurface.ts`
- FOUND: `frontend/src/hooks/__tests__/useReminderResurface.test.ts`
- FOUND: `frontend/src/components/train/TrainReminderResurfaceBanner.tsx`
- FOUND: `frontend/src/components/train/__tests__/TrainReminderResurfaceBanner.test.tsx`
- FOUND: `.planning/phases/203-pwa-install-re-prompting-train-anchored-install-offer/203-04-SUMMARY.md`
- FOUND commit: `658d98fca` (Task 1)
- FOUND commit: `541dda327` (Task 2)
- FOUND commit: `5eeda049c` (UAT round 1 fix)
- FOUND commit: `99846dcad` (UAT round 3 fix)

## Post-Review Fixes

Five post-execution fixes (203-REVIEW.md's two Critical findings, plus three
UAT items from operator testing on a real Android device), each committed
atomically. Executed inline per a dedicated brief, not a new PLAN.md.

### Item 1 (Critical, CR-02) — the Android install offer was dead code

**Root cause:** `useInstallPrompt.ts` captured the one-shot
`beforeinstallprompt` event into per-hook-instance React state. The event
fires at most once per page load, early — only the first mounted instance
(`InstallPromptBanner`, mounted once in `ProtectedLayout`) ever saw it.
`TrainReminderButton`'s score-screen instance (`useTrainReminderSlot()` →
`useInstallPrompt()`) mounts much later, once a puzzle session completes,
and its own listener registered too late to catch the already-fired,
non-repeating event — `promptEvent` stayed `null` forever there, so
`canInstall` was permanently `false` and the Android confirmed-state
install offer (OFFER-04) never rendered in production.

**Fix:** Hoisted the captured event to a module-level singleton with a
subscriber set, registered once at module load (a top-level side effect,
not inside a component effect — this is what makes it survive React
StrictMode's mount/unmount/mount cycle without dropping or
double-registering). Every `useInstallPrompt()` instance seeds its local
state from the shared singleton on mount and subscribes for later updates,
so a late-mounting consumer observes `canInstall === true` if the event
already fired, and an accepted install (the one correct null site,
INSTALL-04) clears the event for every mounted consumer at once, not just
the instance that triggered it. `dismissAndroid` still does not null it
(Plan 02's original bug fix, preserved unchanged).

**Files:** `frontend/src/hooks/useInstallPrompt.ts`,
`frontend/src/hooks/__tests__/useInstallPrompt.test.ts`
**Commit:** `66498aaed`
**Tests:** two new regression tests — a consumer mounting after the event
already fired still sees `canInstall === true`; an accepted install nulls
the event for every mounted consumer, not just the one that triggered it.
Both verified to fail without the fix.

### Item 2 (Critical, CR-01) — guest 403 storm on every protected route

**Root cause:** `useReminderResurfaceRedirect()` is mounted unconditionally
in `ProtectedLayout` for every protected route and every account, and its
`useTrainSettings()` query had no `enabled` gate. Guests hit
`_reject_guest`'s 403 on `GET /train/settings` on every page view and every
window refocus, each captured by the global `QueryCache.onError` Sentry
reporter — drowning real signal, in direct contradiction of CLAUDE.md's
"skip expected failures" rule and the codebase's own precedent for this
exact failure mode (`useTrainProgress`'s `enabled` option, T-191-21).

**Fix:** Threaded an `options.enabled` flag through
`useTrainSettings` → `useReminderResurface` → `useReminderResurfaceRedirect`,
defaulting to `enabled: true` at every layer so the two pre-existing call
sites (`TrainReminderButton`, `TrainScheduleSettings` — already
Train-page-scoped, guests cannot reach them without games) are unaffected.
`ProtectedLayout`, which already fetches the profile via `useUserProfile()`,
supplies `enabled: profile != null && !profile.is_guest`. Kept as an
explicit caller-supplied flag rather than a `useUserProfile()` call inside
`useReminderResurfaceRedirect` itself, so that hook's existing
router-mocked test suite (no `QueryClientProvider` wrapper) stays green.

**Files:** `frontend/src/hooks/useTrainSettings.ts`,
`frontend/src/hooks/useReminderResurface.ts`, `frontend/src/App.tsx`,
`frontend/src/hooks/__tests__/useReminderResurface.test.ts`,
`frontend/src/hooks/__tests__/useTrainSettings.test.ts` (new)
**Commit:** `9b8cdb32e`
**Tests:** new `useTrainSettings.test.ts` covers the enabled gate directly
(query never fires when `enabled: false`, fires when `true` or omitted); a
new `useReminderResurface.test.ts` case proves the flag propagates through
the redirect hook and the disabled query never triggers a resurface
redirect. Both verified to fail without the fix.

### Item 3 (UAT) — "Not now" did nothing in the mobile install drawer (Brave/Android, reached via QR handoff)

**Hypothesis confirmed as stated in the brief.** `showAndroidPrompt` and
`showIOSBanner` both OR the D-04 cooldown with `handoffActive` (D-11) — a
scanned handoff QR (`/train?src=handoff`) is meant to bypass a prior
on-device dismissal for that one load. `dismissAndroid`/`dismissIOS` only
ever recorded the cooldown; neither ever cleared the handoff marker, so
`isHandoffActive()` (re-read fresh on every render) kept returning `true`
and the Drawer's controlled `open` prop stayed derived-true on the very
next render — the drawer never actually closed. The operator most likely
arrived via the QR scan, which fits the report exactly.

**Fix:** An explicit dismissal now ends the handoff override the same way
a completed install does (`clearHandoffMarker()`), so the just-recorded
cooldown state actually takes effect. Applied to both `dismissAndroid` and
`dismissIOS`, which carry the identical bypass term.

**Files:** `frontend/src/hooks/useInstallPrompt.ts`,
`frontend/src/hooks/__tests__/useInstallPrompt.test.ts`
**Commit:** `3f4cd061a`
**Tests:** two new regression tests (`dismissAndroid`/`dismissIOS` each
clear the handoff marker so `showAndroidPrompt`/`showIOSBanner` drop to
`false` on the very next render). Verified both fail with the exact
"drawer stays open" symptom when the `clearHandoffMarker()` calls are
reverted.

### Item 4 (UAT) — reminder toggle position

**Fix:** Swapped the JSX order of the `Switch` and its "Remind me to
train" label in `TrainScheduleSettings.tsx`'s `ReminderControls` so the
Switch renders on the left, dropping the now-unneeded `justify-between` in
favor of a left-aligned group. Same `aria-label` and `data-testid`
preserved. This component has a single call site for the row (no separate
desktop/mobile branch), so there was no duplicate markup to update.

**Files:** `frontend/src/components/train/TrainScheduleSettings.tsx`
**Commit:** `09049fb18`
**Tests:** existing `TrainScheduleSettings.test.tsx` suite re-verified
green (28/28); no new test needed since this is a pure layout swap with no
new behavior branch.

### Item 5 (UAT) — the Settings QR rendered on mobile and inside the installed PWA

**Root cause:** `TrainScheduleSettings.tsx` mounted `<TrainInstallQr>`
unconditionally at its permanent Settings-card mount point — no
`isMobile`/`isStandalone` guard — so a phone visiting its own Settings
page rendered a QR asking the user to scan their own screen with the same
phone, and the installed standalone PWA offered to install itself again.

**Fix:** Three mutually exclusive branches on `useInstallPrompt`'s
`isMobile`/`isStandalone`/`canInstall`: desktop keeps the QR unchanged; a
mobile browser that can actually install (`canInstall` true) gets a
primary (`variant="default"`) "Install FlawChess" button instead;
everything else — standalone, or mobile with no live
`beforeinstallprompt` (iOS) — renders nothing for the whole section,
heading included (structural absence over a dead button, this phase's
established fail-safe idiom). No dismiss control added (D-13 still
applies). Confirmed `TrainReminderButton`'s own
`showDesktopQr = !isMobile && !isStandalone` mount point already guarded
correctly and needed no change. Updated `TrainInstallQr`'s docstring,
which the review flagged as stale — it now accurately states the
component only ever mounts on the desktop branch at both call sites.

**Files:** `frontend/src/components/train/TrainScheduleSettings.tsx`,
`frontend/src/components/train/TrainInstallQr.tsx`,
`frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx`
**Commit:** `317337a30`
**Tests:** four new regression tests (mobile+`canInstall` renders the
button and wires `triggerInstall`; mobile without `canInstall` renders
nothing; standalone renders nothing) plus the two pre-existing HANDOFF-04
tests renamed to clarify they exercise the desktop-shaped default rather
than "unconditional on platform". All four new tests verified to fail
without the fix.

### Gate

Full frontend gate re-run after all five fixes: `npm run lint` (0
errors), `npm run knip` (clean), `npm test -- --run` (3241/3241 passed,
219 files — up from 3229/218 at Plan 04 close), `npm run build` (`tsc -b`
zero errors, `vite build` clean). Backend untouched by all five items.

**Total: 5 commits, 5 fixes, 0 deferred items.**
