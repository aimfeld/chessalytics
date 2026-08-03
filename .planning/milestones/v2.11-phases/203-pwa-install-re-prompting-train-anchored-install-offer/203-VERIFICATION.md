---
phase: 203-pwa-install-re-prompting-train-anchored-install-offer
verified: 2026-08-02T23:15:00Z
status: passed
score: 15/15 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification: null
---

# Phase 203: PWA Install Re-prompting & Train-Anchored Install Offer Verification Report

**Phase Goal:** A user who declines the install prompt once can be offered it again on a bounded
schedule instead of never, and the moment they opt into Train reminders becomes the surface that
routes them onto their phone — by install offer (Android tabbed), by Add-to-Home-Screen
instructions (iOS tabbed, today a blank slot), or by a dismissible desktop→phone QR handoff.

**Verified:** 2026-08-02T23:15:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Method note

This verification does not take SUMMARY.md's narrative at face value. Every truth below was
checked against HEAD source, not against plan/summary prose. The single highest-risk claim in
this phase — that OFFER-02's Android install offer, found dead-on-arrival by 203-REVIEW.md
(CR-02), is now actually fixed — was confirmed by **mutation testing**: the module-singleton fix
in `useInstallPrompt.ts` was temporarily reverted to the old per-hook-instance state, the
regression test `cross-instance event sharing (CR-02 regression) > a consumer mounting AFTER the
event already fired still observes canInstall === true` was re-run and failed exactly as
predicted, and the file was restored. This proves the fix is load-bearing, not merely present.

Per CONTEXT.md D-01, the iOS branch ships deliberately unverified on real hardware (the operator
has no iPhone). This is **not** recorded as a gap. What was verified instead is that every iOS
code path fails safe (unknown/unavailable/throwing signal → today's behavior, never a crash or
half-rendered state) — confirmed by reading `matchesStandaloneMediaQuery`'s try/catch,
`useReminderResurface`'s subscription-probe `.catch()`, and the fail-safe regression tests in
`useReminderResurface.test.ts` ("either probe unresolved", "subscription probe throwing").

Three placement deviations recorded in 203-04-SUMMARY.md's Post-Review Fixes section (D-13
button-row invariant, D-15 iOS instructions moved below the row, Phase 202 D-03 confirmed line
moved below the row) were verified as intentional and consistently applied — `TrainReminderButton.tsx`'s
`control`/`belowRow` split puts every non-interactive element below the row, confirmed by reading
`TrainScoreScreen.tsx`'s consumption of both return values.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | INSTALL-01: dismissal is a bounded 14-day/3-attempt cooldown, not a permanent veto, via named constants | ✓ VERIFIED | `frontend/src/lib/installCooldown.ts:20-21` (`INSTALL_COOLDOWN_DAYS = 14`, `INSTALL_MAX_ATTEMPTS = 3`), `resolveInstallOfferState` checks cap before elapsed time; `installCooldown.test.ts` covers boundary inclusivity, DST-safe ms arithmetic, cap-wins-over-cooldown ordering |
| 2 | INSTALL-02: superseded, not silently dropped | ✓ VERIFIED (deviation recorded) | REQUIREMENTS.md line 85 marks it `[ ]` with an explicit `[Superseded by Phase 203 CONTEXT.md D-03...]` annotation, per CONTEXT.md's explicit instruction to the planner |
| 3 | INSTALL-03: push before install, structurally, via Train-route suppression | ✓ VERIFIED | `InstallPromptBanner.tsx:22-25` (`pathname.startsWith('/train') && !isHandoffActive()` → render null); `InstallPromptBanner.test.tsx` covers suppression and the D-11 override |
| 4 | INSTALL-04: dismiss retains the captured event; only accepted install nulls it | ✓ VERIFIED | `useInstallPrompt.ts:116-140` (`dismissAndroid` never calls `setCapturedPromptEvent`), `triggerInstall` at 102-114 nulls only on `outcome === 'accepted'`; regression tests confirm cross-instance sharing survives dismissal |
| 5 | INSTALL-05: `isStandalone` ORs `navigator.standalone` with the media query, 4-case truth table | ✓ VERIFIED | `useInstallPrompt.ts:164-176`, wrapped in try/catch for a missing/throwing `matchMedia`; `Navigator` type augmentation at lines 16-20 |
| 6 | INSTALL-06: no notification/reminder/push promise off iOS | ✓ VERIFIED | `InstallPromptBanner.tsx:37` drawer copy ("faster loads and instant access... home screen" — no push claim); `TrainInstallQr.tsx:72` caption names opening the phone, not reminders |
| 7 | OFFER-01: five (six incl. hidden) explicit named states, pure resolver, old 8-condition cascade removed | ✓ VERIFIED | `frontend/src/lib/reminderSlotState.ts` — pure function, no imports, fixed priority order; `TrainReminderButton.tsx:147-158` is the sole call site; old cascade gone (confirmed by reading the full file) |
| 8 | OFFER-02: confirmed state is the upsell surface (QR desktop / install-offer Android), previously dead code, now fixed | ✓ VERIFIED (mutation-tested) | `TrainReminderButton.tsx:162-205` (`showAndroidOffer`/`showDesktopQr` branches); root cause (per-hook-instance `beforeinstallprompt` capture) fixed via module-level singleton + subscriber set in `useInstallPrompt.ts:46-69,88-100`; **fix confirmed load-bearing by reverting it and observing the CR-02 regression test fail**, then restoring |
| 9 | OFFER-03: iOS-tabbed slot renders a real button instead of `null`, honest two-step copy, intent write fires before UI transition | ✓ VERIFIED | `TrainReminderButton.tsx:207-273` — `btn-train-ios-reminders`, synchronous `save()` call in `handleIosTap` before `onSettled` reveals `train-ios-reminder-instructions`; copy at 265-268 states "add to home screen... then open it and turn on reminders" (no shorthand); `reminderSlotState.ts:90` evaluates `ios-tabbed` before the shared hidden gate |
| 10 | OFFER-04: standalone-unsubscribed shows plain confirmed span, no install offer attached | ✓ VERIFIED | `TrainReminderButton.tsx:166-167`: `showAndroidOffer` requires `isMobile && !isIOS && !isStandalone`; `showDesktopQr` requires `!isMobile && !isStandalone` — both structurally false when `isStandalone` is true, leaving `upsell = null` |
| 11 | OFFER-05: standalone re-surface routes to `/train` and shows a reminder prompt, clearing on subscribe/dismiss | ✓ VERIFIED | `useReminderResurface.ts` (pure decision + router-only redirect split), `useReminderResurfaceRedirect` wired in `App.tsx:558`; `TrainReminderResurfaceBanner.tsx` mounted first (above `TrainStreakCard`/`TrainStatsCard`) at `TrainStartScreen.tsx:259,266,293`; fail-safe paths (`unresolved probe`, `throwing subscription probe`) behaviorally tested in `useReminderResurface.test.ts` |
| 12 | HANDOFF-01: QR payload is a plain URL, no credential | ✓ VERIFIED | `TrainInstallQr.tsx:43,55`: `HANDOFF_QR_PATH = '/train?src=handoff'`, payload = `window.location.origin + HANDOFF_QR_PATH` — no token/session/user id |
| 13 | HANDOFF-02: `?src=handoff` survives Google SSO via sessionStorage, drives the flow on `/train` | ✓ VERIFIED | `handoffMarker.ts` (sessionStorage capture/read/clear), captured in `App.tsx:587-589` at `ProtectedLayout`'s stable post-redirect mount point, consumed by `InstallPromptBanner.tsx:22` and `useInstallPrompt.ts:187,203-204` |
| 14 | HANDOFF-03: dismissible/ignorable structurally, no dismiss control or persisted flag added | ✓ VERIFIED (deviation recorded) | `TrainInstallQr.tsx` has no X/dismiss control (confirmed by reading the full component); REQUIREMENTS.md line 102 carries the D-13 structural-satisfaction annotation |
| 15 | HANDOFF-04: permanent, non-nagging QR home in `TrainScheduleSettings`, correctly platform-gated | ✓ VERIFIED | `TrainScheduleSettings.tsx:420-524` — three mutually exclusive branches (`showQr`/`showMobileInstallButton`/`showPhoneSection`); post-review fix (item 5) confirmed: a phone no longer sees a QR of its own screen, an already-standalone PWA sees nothing |

**Score:** 15/15 truths verified (0 present-but-behavior-unverified)

### Post-Review Fixes — Verified in Code (not just claimed)

| Item | Claim | Verified? | Evidence |
|------|-------|-----------|----------|
| 1 (Critical, CR-02) | Module-singleton fix for dead Android install offer | ✓ Verified, mutation-tested | See truth #8 above |
| 2 (Critical, CR-01) | Guest 403 storm fixed via `enabled` gate threaded through 3 hooks | ✓ Verified | `useTrainSettings.ts:50-57`, `useReminderResurface.ts:82-84,154-155`, `App.tsx:558` (`enabled: profile != null && !profile.is_guest`) |
| 3 (UAT) | "Not now" now ends the handoff override on dismiss | ✓ Verified | `useInstallPrompt.ts:139,149` — `clearHandoffMarker()` called in both `dismissAndroid`/`dismissIOS` |
| 4 (UAT) | Reminder toggle moved left of its label | ✓ Verified | `TrainScheduleSettings.tsx:239-248` — `Switch` before `<p>` label |
| 5 (UAT) | Settings QR gated off mobile/standalone | ✓ Verified | `TrainScheduleSettings.tsx:420-422`, `TrainInstallQr.tsx` docstring updated to match |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `app/models/train_settings.py` | `reminder_intent_at` column | ✓ VERIFIED | `DateTime(timezone=True)`, nullable, no backfill (line 124-126) |
| `alembic/versions/20260802_174733_6e7e50844af5_phase_203_reminder_intent.py` | Reversible migration | ✓ VERIFIED | `add_column`/`drop_column`, no data migration |
| `app/schemas/train.py` | `reminder_intent_at` on both Response/Update | ✓ VERIFIED | Lines 216, 242; `Update` has no default (required-but-nullable, 422 on omission — confirmed by passing test `test_put_settings_rejects_missing_reminder_intent_at_422`) |
| `app/repositories/train_repository.py` | Threaded through `TrainSettingsRow`/`get_settings`/`upsert_settings` | ✓ VERIFIED | Lines 153, 248, 290, 308, 321, 400, 410, 451, 696 |
| `app/routers/train.py` | Mapped in GET/PUT response constructors | ✓ VERIFIED | Lines 252, 299, 309 |
| `frontend/src/types/train.ts` | `reminder_intent_at` on both TS interfaces | ✓ VERIFIED | Lines 144, 161 |
| `frontend/src/hooks/useTrainSettings.ts` | `reminderIntentAt` on draft, `enabled` gate | ✓ VERIFIED | Lines 35, 50-57, 65-73 |
| `frontend/src/lib/installCooldown.ts` | Pure resolver + named constants | ✓ VERIFIED | Full file read; 96 lines, no storage/clock access in resolver |
| `frontend/src/lib/handoffMarker.ts` | sessionStorage capture/read/clear | ✓ VERIFIED | Full file read; 55 lines, sessionStorage only, never localStorage |
| `frontend/src/hooks/useInstallPrompt.ts` | Cooldown, event retention, isStandalone OR, module singleton | ✓ VERIFIED | Full file read; 217 lines |
| `frontend/src/components/install/InstallPromptBanner.tsx` | Train-route suppression, handoff override | ✓ VERIFIED | Full file read; 88 lines |
| `frontend/src/lib/reminderSlotState.ts` | Pure five(+hidden)-state resolver | ✓ VERIFIED | Full file read; 113 lines, no imports |
| `frontend/src/components/train/TrainInstallQr.tsx` | Shared QR block, testId-injected | ✓ VERIFIED | Full file read; 77 lines, lazy-loaded `qrcode.react` |
| `frontend/src/components/train/TrainReminderButton.tsx` | Five-state rendering + upsells + iOS branch | ✓ VERIFIED | Full file read; 353 lines |
| `frontend/src/hooks/useReminderResurface.ts` | Decision hook + router-only redirect hook | ✓ VERIFIED | Full file read; 168 lines, two exported hooks per design |
| `frontend/src/components/train/TrainReminderResurfaceBanner.tsx` | OFFER-05 banner | ✓ VERIFIED | Full file read; 106 lines |
| `frontend/src/components/train/TrainStartScreen.tsx` | Banner mounted first, above streak/stats | ✓ VERIFIED | Lines 259, 266, 293 — precedes `TrainStreakCard`/`TrainStatsCard` in all three branches |
| `frontend/package.json` | `qrcode.react` dependency | ✓ VERIFIED | Confirmed via `TrainInstallQr.tsx:38` dynamic import `import('qrcode.react')` resolving in test/build |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `useTrainSettings.ts` | `app/routers/train.py` | PUT full-replace body carrying `reminder_intent_at` | ✓ WIRED | `useTrainSettings.ts:67-74` builds the full body every call |
| `app/routers/train.py` | `app/repositories/train_repository.py` | `upsert_settings(reminder_intent_at=...)` | ✓ WIRED | `train.py:299` → `train_repository.py:400,410` (`ON CONFLICT DO UPDATE set_`) |
| `useInstallPrompt.ts` | `installCooldown.ts` | imports `resolveInstallOfferState` + constants | ✓ WIRED | `useInstallPrompt.ts:2-10,188-197` |
| `InstallPromptBanner.tsx` | `handoffMarker.ts` | `isHandoffActive()` drives suppression bypass | ✓ WIRED | `InstallPromptBanner.tsx:9,22` |
| `App.tsx` | `handoffMarker.ts` | `captureHandoffMarker` at stable post-redirect mount | ✓ WIRED | `App.tsx:39,587-589` |
| `TrainReminderButton.tsx` | `reminderSlotState.ts` | `resolveReminderSlotState` single call | ✓ WIRED | `TrainReminderButton.tsx:68,147-158` |
| `TrainReminderButton.tsx` | `useTrainSettings.ts` | explicit immediate save for iOS intent, outside debounce | ✓ WIRED | `TrainReminderButton.tsx:223-243` (no debounce hook involved) |
| `useReminderResurface.ts` | `lib/push.ts` | `getDeviceSubscription`/`ensureDeviceSubscribed` | ✓ WIRED | `useReminderResurface.ts:29,93`; `TrainReminderResurfaceBanner.tsx:32,56` |
| `App.tsx` | `useReminderResurface.ts` | `ProtectedLayout` fires the active route push, guest-gated | ✓ WIRED | `App.tsx:558` |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full targeted frontend test suite for every file this phase touched | `npm test -- --run <12 files>` | 168/168 passed, 12/12 files | ✓ PASS |
| CR-02 fix is load-bearing (not just present) | Revert module singleton to per-instance state, re-run the exact regression test, restore | Test failed as predicted (`expected false to be true`) with the reversion, passed after restore | ✓ PASS |
| Backend `reminder_intent_at` round-trip contract tests | `uv run pytest tests/routers/test_train.py -k reminder_intent_at` | 3 passed, 58 deselected | ✓ PASS |
| Frontend lint | `npm run lint` | 0 errors (3 unrelated warnings in generated `coverage/` files) | ✓ PASS |
| Debt-marker scan on every phase-modified file | grep TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER | Zero hits (the 4 "placeholder" matches are descriptive prose, e.g. "never a placeholder") | ✓ PASS |

### Requirements Coverage

All 15 requirement IDs (INSTALL-01..06, OFFER-01..05, HANDOFF-01..04) cross-referenced against
`.planning/REQUIREMENTS.md` lines 84-104 and against ROADMAP.md's Phase 203 section (including
its strikethrough/supersession notes for D-01/D-02/D-03).

| Requirement | Status | Evidence |
|-------------|--------|----------|
| INSTALL-01 | ✓ SATISFIED | Truth #1 |
| INSTALL-02 | ✓ SATISFIED (recorded deviation, D-03) | Truth #2 — REQUIREMENTS.md correctly shows `[ ]` with a superseded annotation, not silently Pending |
| INSTALL-03 | ✓ SATISFIED | Truth #3 |
| INSTALL-04 | ✓ SATISFIED | Truth #4 |
| INSTALL-05 | ✓ SATISFIED | Truth #5 |
| INSTALL-06 | ✓ SATISFIED | Truth #6 |
| OFFER-01 | ✓ SATISFIED | Truth #7 |
| OFFER-02 | ✓ SATISFIED (post-review fix, mutation-tested) | Truth #8 |
| OFFER-03 | ✓ SATISFIED | Truth #9. Note: Plan 01's frontmatter listed OFFER-03/OFFER-05 but only landed the backend substrate (correctly left `[ ]` in Plan 01's own tracking); Plan 04 is where the actual UI ships — confirmed by reading Plan 04's diff, not by trusting the checkbox |
| OFFER-04 | ✓ SATISFIED | Truth #10 |
| OFFER-05 | ✓ SATISFIED | Truth #11 |
| HANDOFF-01 | ✓ SATISFIED | Truth #12 |
| HANDOFF-02 | ✓ SATISFIED | Truth #13 |
| HANDOFF-03 | ✓ SATISFIED (recorded deviation, D-13) | Truth #14 |
| HANDOFF-04 | ✓ SATISFIED | Truth #15 |

No orphaned requirements — REQUIREMENTS.md's Phase 203 block contains exactly these 15 IDs, all traced.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `frontend/src/hooks/usePushCapability.ts` | 9-11 | Stale docstring (203-REVIEW.md WR-02) still says "scoped to two consuming components" — `TrainReminderResurfaceBanner` is now a third | ℹ️ Info | Cosmetic; endpoint is unauthenticated so a third consumer is functionally harmless. Not fixed in the post-review pass. Does not affect any must-have. |
| `frontend/src/components/train/TrainReminderResurfaceBanner.tsx` | 44-51 | 203-REVIEW.md WR-01 (false "couldn't turn on reminders" if tapped before the VAPID-key probe resolves) — not addressed in the post-review fixes | ⚠️ Warning | Narrow timing window, self-recoverable on next tap once the probe resolves; not gated by any must-have in Plan 04's frontmatter. Recommend a follow-up note, not a phase gap. |

Neither finding blocks the phase goal — both are pre-existing-severity Warning/Info items from
203-REVIEW.md that were correctly left unaddressed (the post-review fix pass targeted the two
Criticals plus three UAT items, not every Warning/Info).

### Human Verification Required

None. The iOS branch's real-device behavior is explicitly deferred per CONTEXT.md D-01 (the
operator has no iPhone; the passive signal is whether iOS standalone devices appear in
`push_subscriptions` post-deploy) — this is a recorded, accepted decision, not an open
verification item. Every iOS code path was confirmed to fail safe by direct code reading plus
passing fail-safe regression tests (unresolved probe, throwing probe, missing `matchMedia`).

### Gaps Summary

None. All 15 requirement IDs are satisfied (with 2 recorded, deliberate deviations — INSTALL-02
and HANDOFF-03 — correctly annotated in REQUIREMENTS.md per CONTEXT.md's explicit instruction).
The single highest-risk item in this phase (OFFER-02's previously-dead Android install offer) was
independently confirmed fixed via mutation testing, not just code reading. Two low-severity
Warning/Info anti-patterns from 203-REVIEW.md remain open but are not must-haves and do not block
the phase goal.

---

_Verified: 2026-08-02T23:15:00Z_
_Verifier: Claude (gsd-verifier)_
