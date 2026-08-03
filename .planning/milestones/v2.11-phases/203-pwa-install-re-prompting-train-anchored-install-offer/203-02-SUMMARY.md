---
phase: 203-pwa-install-re-prompting-train-anchored-install-offer
plan: 02
subsystem: ui
tags: [pwa, install-prompt, localStorage, sessionStorage, react-router, vitest]

# Dependency graph
requires:
  - phase: 203-01
    provides: reminder_intent_at round-trip on train_settings (unrelated substrate, no file overlap)
provides:
  - "resolveInstallOfferState: a pure 14-day/3-attempt cooldown resolver replacing the permanent-veto boolean"
  - "handoffMarker: a one-shot sessionStorage marker for the desktop→phone QR handoff, surviving the OAuth redirect"
  - "useInstallPrompt: event retention on dismiss (INSTALL-04), isStandalone OR (INSTALL-05), cooldown-gated visibility, canInstall/isIOS/isStandalone/isMobile exposed for Plan 03"
  - "InstallPromptBanner: Train-route suppression with a handoff override (D-07/D-11), rewritten drawer copy (INSTALL-06)"
affects: [203-03, 203-04]

# Actuals (#2632)
actuals:
  tokens: 8900
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Pure cooldown resolver (resolveInstallOfferState) with cap-checked-before-elapsed evaluation order, injected clock/state — no Date/storage access inside the pure function itself"
    - "One-shot sessionStorage marker (handoffMarker) mirroring the existing pending_toast/promote_intent capture-before-redirect pattern"
    - "React purity fix: Date.now() captured once via a lazy useState initializer + refreshed inside event handlers, never called directly during render (react-hooks/purity)"

key-files:
  created:
    - frontend/src/lib/installCooldown.ts
    - frontend/src/lib/handoffMarker.ts
    - frontend/src/lib/__tests__/installCooldown.test.ts
    - frontend/src/lib/__tests__/handoffMarker.test.ts
    - frontend/src/hooks/__tests__/useInstallPrompt.test.ts
    - frontend/src/components/install/__tests__/InstallPromptBanner.test.tsx
  modified:
    - frontend/src/hooks/useInstallPrompt.ts
    - frontend/src/components/install/InstallPromptBanner.tsx
    - frontend/src/App.tsx
    - .planning/REQUIREMENTS.md

key-decisions:
  - "Handoff-bypass (D-11) applies symmetrically to both Android and iOS cooldown state inside useInstallPrompt, not just the Android drawer — the truths block's 'cooldown/attempt state is bypassed for that load' reads as platform-general, and Task 3's route suppression already treats both surfaces the same way."
  - "Date.now() is impure per this project's react-hooks/purity lint rule and cannot be called in the render body. Captured once via a useState lazy initializer (allowed — verified empirically) and refreshed inside dismissAndroid/dismissIOS event handlers, which run outside render."

patterns-established:
  - "Cooldown/cap resolvers for any future re-offer surface should follow resolveInstallOfferState's shape: pure function, cap-before-elapsed evaluation order, injected {dismissedAt, attemptCount, now}."

requirements-completed: [INSTALL-01, INSTALL-03, INSTALL-04, INSTALL-05, INSTALL-06, HANDOFF-02]

coverage:
  - id: D1
    description: "resolveInstallOfferState pure resolver — 14-day cooldown, 3-attempt cap, cap evaluated before elapsed window, inclusive boundary, corrupt-value coercion"
    requirement: "INSTALL-01"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/installCooldown.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "handoffMarker one-shot sessionStorage marker — exact-match capture, OAuth-redirect survival, explicit clear, never touches localStorage"
    requirement: "HANDOFF-02"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/handoffMarker.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "useInstallPrompt: dismissal no longer nulls the captured BeforeInstallPromptEvent; only an 'accepted' outcome clears it"
    requirement: "INSTALL-04"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useInstallPrompt.test.ts#event retention (INSTALL-04): dismissing keeps the captured event alive for a later triggerInstall()"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useInstallPrompt.test.ts#triggerInstall clears the captured event only on outcome \"accepted\""
        status: pass
    human_judgment: false
  - id: D4
    description: "isStandalone ORs navigator.standalone with the display-mode media query — full four-case truth table"
    requirement: "INSTALL-05"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useInstallPrompt.test.ts#isStandalone truth table (INSTALL-05)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Drawer/cap gating: hidden at the attempt cap, shown when the handoff marker overrides an in-window dismissal, never shown on a desktop UA"
    requirement: "INSTALL-01"
    verification:
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useInstallPrompt.test.ts#hides the drawer once attemptCount is at the cap, even with a live captured event (D-04)"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useInstallPrompt.test.ts#shows the drawer when the handoff marker is active despite an in-window dismissal (D-11)"
        status: pass
      - kind: unit
        ref: "frontend/src/hooks/__tests__/useInstallPrompt.test.ts#a desktop UA yields showAndroidPrompt === false even with a live captured event and no dismissal history (D-06)"
        status: pass
    human_judgment: false
  - id: D6
    description: "InstallPromptBanner: both install surfaces suppressed on every /train* route (prefix match), handoff marker overrides the suppression, drawer copy carries no notification/push vocabulary"
    requirement: "INSTALL-03"
    verification:
      - kind: unit
        ref: "frontend/src/components/install/__tests__/InstallPromptBanner.test.tsx"
        status: pass
    human_judgment: false
  - id: D7
    description: "Android drawer copy names a concrete Train benefit with no notification/reminder/alert/push promise (INSTALL-06)"
    requirement: "INSTALL-06"
    verification:
      - kind: unit
        ref: "frontend/src/components/install/__tests__/InstallPromptBanner.test.tsx#the drawer body makes no notification/reminder/alert/push promise (INSTALL-06)"
        status: pass
    human_judgment: false
  - id: D8
    description: "End-to-end phone-scan → SSO → /train handoff flow (HANDOFF-02) — per-step logic is unit-tested but the real Google SSO round-trip on a physical device cannot be exercised in vitest"
    human_judgment: true
    rationale: "203-CONTEXT.md's flagged assumption for HANDOFF-02: sessionStorage survival across the real OAuth redirect chain on a scanning phone is HUMAN-UAT only, same as noted in the plan's edge-probe table."

duration: 25min
completed: 2026-08-02
status: complete
---

# Phase 203 Plan 02: Install Cooldown, Event Retention & Train-Route Suppression Summary

**14-day/3-attempt cooldown resolver replaces the permanent install-dismissal veto, the captured `BeforeInstallPromptEvent` survives dismissal, `isStandalone` now ORs `navigator.standalone`, and the drawer/banner are suppressed on Train routes unless a scanned QR's `?src=handoff` marker overrides it.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-02T20:15:00Z (approx.)
- **Completed:** 2026-08-02T20:28:29Z
- **Tasks:** 3
- **Files modified:** 10 (6 created, 4 modified)

## Accomplishments

- `installCooldown.ts`: pure `resolveInstallOfferState` resolver (cap checked before the elapsed window, inclusive 14-day boundary, no `Date`/calendar arithmetic) plus `readInstallCooldown`/`recordInstallDismissal` storage helpers that coerce corrupt values to absent rather than `NaN`.
- `handoffMarker.ts`: one-shot `sessionStorage` marker capturing `?src=handoff` via exact-string equality, surviving the query-string-stripping OAuth redirect, never touching `localStorage`.
- `useInstallPrompt.ts` rewritten: the three shipped bugs (permanent dismissal, event nulled on dismiss, `isStandalone` missing the iOS signal) are fixed; the hook now exposes `canInstall`/`isIOS`/`isStandalone`/`isMobile` for Plan 03's confirmed-state offer, and a `Navigator.standalone` type augmentation makes the hook compile under strict `tsc -b`.
- `InstallPromptBanner.tsx`: both install surfaces render nothing on any `/train*` route unless the handoff marker overrides it; the Android drawer body now names a concrete Train benefit with no off-iOS notification promise.
- `App.tsx`: `captureHandoffMarker(window.location.search)` wired into `ProtectedLayout`'s existing mount-effect block, next to `pending_toast`.
- `.planning/REQUIREMENTS.md`: INSTALL-02 marked superseded by D-03 and HANDOFF-03's "dismissible" wording marked satisfied structurally per D-13, per the plan's explicit instruction — neither checkbox state nor requirement text was altered.
- Two Wave-0 test-coverage gaps closed: `useInstallPrompt.test.ts` (9 tests) and `InstallPromptBanner.test.tsx` (5 tests) — both files had zero automated coverage before this plan.

## Task Commits

1. **Task 1: Pure cooldown resolver + handoff marker module** - `4706135ac` (feat)
2. **Task 2: Rewrite useInstallPrompt — cooldown cadence, event retention, isStandalone OR** - `e441ef32b` (fix)
3. **Task 3: Route-aware InstallPromptBanner, handoff capture wiring, REQUIREMENTS deviation record** - `8eae7e5fd` (feat)

_No separate RED/GREEN/REFACTOR commits — each `tdd="true"` task was implemented and tested together in one commit per the codebase's existing single-commit-per-task convention (matches Plan 01's precedent)._

## Files Created/Modified

- `frontend/src/lib/installCooldown.ts` - pure cooldown/cap resolver + storage helpers (new)
- `frontend/src/lib/handoffMarker.ts` - one-shot sessionStorage QR-handoff marker (new)
- `frontend/src/lib/__tests__/installCooldown.test.ts` - resolver + storage-helper coverage (new)
- `frontend/src/lib/__tests__/handoffMarker.test.ts` - marker lifecycle coverage (new)
- `frontend/src/hooks/useInstallPrompt.ts` - rewritten: cooldown state, event retention, isStandalone OR, new return fields
- `frontend/src/hooks/__tests__/useInstallPrompt.test.ts` - Wave-0 gap closure (new)
- `frontend/src/components/install/InstallPromptBanner.tsx` - Train-route suppression + handoff override, rewritten drawer copy
- `frontend/src/components/install/__tests__/InstallPromptBanner.test.tsx` - Wave-0 gap closure (new)
- `frontend/src/App.tsx` - handoff marker capture in `ProtectedLayout`'s mount effect
- `.planning/REQUIREMENTS.md` - INSTALL-02/HANDOFF-03 deviation notes

## Decisions Made

- D-11's handoff bypass is applied symmetrically to both the Android and iOS cooldown checks inside `useInstallPrompt`, not just the Android path — the CONTEXT.md truths block phrases it platform-generally ("the cooldown/attempt state is bypassed for that load"), and both install surfaces are suppressed identically at the route level in Task 3.
- `Date.now()` cannot be called directly in a hook's render body under this project's `react-hooks/purity` ESLint rule (verified: it flagged the first draft). Fixed by capturing `now` once via a `useState` lazy initializer (confirmed empirically not to trigger the rule) and refreshing it inside `dismissAndroid`/`dismissIOS`, which run as event handlers outside render — matches the existing `useBotGame.ts` precedent for the same constraint.

## Deviations from Plan

None beyond the two explicitly instructed by CONTEXT.md/the plan itself (INSTALL-02 superseded by D-03, HANDOFF-03 satisfied structurally per D-13 — both recorded in REQUIREMENTS.md as the plan's Task 3 required). No unplanned auto-fixes were needed; the only implementation adjustment (the `Date.now()` purity fix) was a straightforward application of an existing project-wide lint constraint, not a deviation from the plan's design.

## Known Stubs

None.

## Issues Encountered

- `npm run lint` initially failed with a `react-hooks/purity` error on a direct `Date.now()` call inside `useInstallPrompt`'s render body. Fixed by moving the timestamp capture to a lazy `useState` initializer plus refreshing it inside the two dismiss handlers (see Decisions Made). Verified fix with a scratch-file lint probe before applying it to the hook.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `useInstallPrompt` now exposes `canInstall`, `isIOS`, `isStandalone`, `isMobile` — everything Plan 03's `TrainReminderButton` five-state resolver and Android confirmed-state install offer need, with no further hook changes required.
- `handoffMarker.ts`'s `isHandoffActive()`/`clearHandoffMarker()` are ready for the QR-handoff component (Plan 03/04) to consume without any new plumbing.
- HANDOFF-02's real end-to-end phone-scan → Google SSO → `/train` flow remains HUMAN-UAT only (flagged in the plan's edge-probe table) — no blocker for subsequent plans, but should be exercised manually once the QR component exists.

## Self-Check: PASSED

All 10 created/modified files verified present on disk; all 4 commit hashes (`4706135ac`, `e441ef32b`, `8eae7e5fd`, `c6ea96697`) verified present in git history.

---
*Phase: 203-pwa-install-re-prompting-train-anchored-install-offer*
*Completed: 2026-08-02*
