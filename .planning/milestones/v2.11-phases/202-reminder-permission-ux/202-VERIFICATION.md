---
phase: 202-reminder-permission-ux
verified: 2026-08-02T16:50:00Z
status: passed
score: 4/4 roadmap success criteria verified; both plans' must_haves truth lists (61 items) verified via source read + passing tests
behavior_unverified: 0
overrides_applied: 0
known_deviations:
  - must_have: "ROADMAP SC1 literal wording: 'custom in-app pre-prompt on TrainScoreScreen with Yes / Not now'"
    resolution: "Superseded by locked decision D-02 in 202-CONTEXT.md — the 'Remind me' button press IS the pre-prompt; no intermediate dialog. Recorded in both PLAN.md files as an intentional, user-approved deviation. Verified against D-02's actual requirement instead (single call site for Notification.requestPermission(), reachable only from an explicit user gesture) — see Observable Truths #1."
additional_findings:
  - id: "CR-01-residual"
    severity: info
    description: "202-REVIEW.md's CR-01 named two failure modes: (a) Notification.requestPermission() rejecting, and (b) navigator.serviceWorker.ready never settling (hanging). Commit 5dafeb57d fixed (a) — the try now wraps the whole function body and both call sites (TrainReminderButton.tsx:86, TrainScheduleSettings.tsx:348) carry a .catch() backstop, proven by a dedicated test ('resolves to error when Notification.requestPermission() rejects', push.test.ts). It did NOT add the bounded timeout (e.g. Promise.race) around navigator.serviceWorker.ready that the review's own suggested fix included — grep confirms no 'timeout'/'race' anywhere in lib/push.ts. A hang there (not a rejection — verified: no code path can produce one) still leaves the control disabled forever with no recovery short of a page reload. This is a real but narrow edge case (an environment where serviceWorker.ready resolves per spec but never actually settles), does not violate the phase's core PERM-01/02 invariant (it is not a browser-level denial, and the permission is not silently mis-recorded), and is not covered by any must_haves truth in either PLAN.md. Recorded here for an honest record since the task briefing described CR-01 as fixed without this nuance; does not block the phase."
---

# Phase 202: Reminder Permission UX Verification Report

**Phase Goal:** A user who has just proven Train is worth their time can opt into push reminders through a flow that can never trigger a permanent browser-level denial, and can manage that choice from Settings at any point afterward.
**Verified:** 2026-08-02
**Status:** passed
**Re-verification:** No — initial verification

## Known Deviation (read first)

SC1's literal wording ("a custom in-app pre-prompt with Yes / Not now") is deliberately superseded by locked decision **D-02** in `202-CONTEXT.md`, recorded in both `202-01-PLAN.md`'s `<objective>` and `202-01-SUMMARY.md`'s Decisions. The "Remind me" button press IS the pre-prompt. This is not scored as a miss — SC1 is judged against what D-02 actually requires (see Truth #1 below).

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | (SC1/D-02) `Notification.requestPermission()` has exactly one call site in the app, reachable only from the score-screen button's `onClick` and the Settings `Switch`'s `onCheckedChange` — never a mount effect, render path, route transition, or query callback | ✓ VERIFIED | `grep -rn "requestPermission" src/` shows exactly one call site (`lib/push.ts:137`, inside `ensureDeviceSubscribed`). Callers: `TrainReminderButton.tsx:86` (`handleClick`, bound to `onClick={() => void handleClick()}` at line 127) and `TrainScheduleSettings.tsx:348` (`handleReminderToggle`, bound to `Switch`'s `onCheckedChange` at line 220/458). No mount `useEffect` calls `ensureDeviceSubscribed`. |
| 2 | (SC1/PERM-01) Pressing "Remind me" requests the browser permission, subscribes this device, persists `reminder_enabled: true`, and swaps to a confirmation naming the hour | ✓ VERIFIED | `TrainReminderButton.tsx:80-119`; happy-path test in `TrainReminderButton.test.tsx` asserts the rendered text `Reminders on — 18:00 on your training days` and that `trainApi.updateSettings` was called once with `reminder_enabled: true`. Both phase test files pass (80/80 tests, see below). |
| 3 | (SC2/PERM-02) "Not now" (a dismissed browser prompt) leaves the user able to opt in later and is never repeated as a nag; no decline history is persisted anywhere | ✓ VERIFIED | `ensureDeviceSubscribed` returns `{status:'dismissed'}` distinct from `{status:'denied'}` (`lib/push.ts:99-104`, `136-140`); `TrainReminderButton.tsx:112-116` returns to `'idle'` with nothing written. `grep -rn localStorage` across the push module and both components: zero writes. `useUserFlag` (the app's only decline-history primitive) is not imported by any push-related file. `push.test.ts` has a dedicated `expect(setItem).not.toHaveBeenCalled()` assertion across the dismissed/denied arms. |
| 4 | (SC3/PERM-03) `TrainScheduleSettings` hosts a master reminder toggle and an hour picker with the same auto-saving behavior as the weekday/session-size pickers | ✓ VERIFIED | `TrainScheduleSettings.tsx:201-251` (`ReminderControls`) renders `data-testid="filter-reminder-enabled"` (Switch) and, when checked, `filter-reminder-hour` (Select, 24 options `filter-reminder-hour-0`..`-23`, `formatReminderHour`-labeled). Hour changes ride the same `debouncedDraft`/`hasEditedRef`/save-effect machine as weekday chips (`onHourChange` → `setDraft` → existing debounce effect, lines 366-369 + 288-317). Test: "hour-change test asserting the single captured body has the chosen reminder_hour and unchanged weekday_mask/puzzles_per_session" passes. |
| 5 | (SC4/PERM-04) Turning the master toggle off immediately silences reminders without touching the browser permission grant, so turning it back on later is instant | ✓ VERIFIED | `handleReminderToggle`'s off-branch (`TrainScheduleSettings.tsx:337-341`) only writes `reminderEnabled: false` into the draft — no call to `PushSubscription.unsubscribe()`, no call to any unsubscribe endpoint. `pushApi` (`api/client.ts:299-306`) exposes exactly `getVapidPublicKey`, `subscribe`, `devTriggerReminder` — no `unsubscribe` method exists anywhere in the client. Tests assert `subscriptionUnsubscribe` and `pushApi.subscribe` were never called after toggle-off. |
| 6 | `reminder_enabled` is never persisted `true` unless BOTH the browser grant and `POST /push/subscribe` resolved successfully | ✓ VERIFIED | Both callers write `reminderEnabled: true` (or call `save(...)`) only inside the `result.status === 'subscribed'` branch, which `ensureDeviceSubscribed` only returns after `Notification.requestPermission()` resolved `'granted'` (or permission was already granted) AND `pushApi.subscribe(body)` resolved without throwing (`lib/push.ts:130-169`). Denied/dismissed/error branches in both components explicitly do not write the field. Tests assert zero `updateSettings` calls on denied/dismissed/subscribe-rejected paths in both plan's test suites. |
| 7 | No counter, threshold, session-count, or persisted "declined" state exists anywhere in the opt-in path | ✓ VERIFIED | See Truth #3. No such field exists in `Draft`, `TrainSettingsDraft`, `TrainSettingsResponse`/`Update`, or any push-related module. `useUserFlag` deliberately not reused (per 202-CONTEXT.md "Deliberately NOT used" and confirmed absent from all push files). |
| 8 | Toggle-OFF writes `reminder_enabled: false` and calls neither `POST /push/unsubscribe` nor `PushSubscription.unsubscribe()` (D-07) | ✓ VERIFIED | Same as Truth #5. `git grep unsubscribe` in app code (non-test) returns only the docstring comment in `client.ts` explaining the deliberate omission. |
| 9 | "This device is reachable" is determined as `registration.pushManager.getSubscription() !== null`, never inferred from `Notification.permission` alone and never cached | ✓ VERIFIED | `lib/push.ts:82-90` (`getDeviceSubscription`) is the sole such mechanism; called fresh on mount in `TrainReminderButton.tsx:41-49` (no caching, no localStorage) and reused inside `ensureDeviceSubscribed` (line 142). `TrainReminderButton`'s D-05 test explicitly proves `reminder_enabled: true` from the server plus `getSubscription()` resolving `null` still renders the button (asymmetry preserved, not reconciled away). |
| 10 | Both surfaces are structurally absent (no skeleton, no message) when push is unsupported or the VAPID key 404s | ✓ VERIFIED | `usePushCapability.ts` treats a 404 as `available: false` without throwing (`HTTP_NOT_FOUND` branch); both components gate on `capability.isResolved && capability.available` before rendering anything. Tests for "unsupported browser: renders nothing" and "VAPID key endpoint 404s: renders nothing" pass in both component test files. |
| 11 | A per-device browser block (`Notification.permission === 'denied'`) never mutates the account-wide setting | ✓ VERIFIED | `TrainScheduleSettings.tsx`'s `blocked` computation is render-only (lines 327-330); no PUT is issued as a side effect. Test: "D-11 mount-time reconciliation: reminder_enabled true from the server plus permission denied never issues a PUT" passes. |

**Score:** 11/11 representative truths verified (drawn from the 4 ROADMAP success criteria plus the highest-risk must_haves and prohibitions in both PLAN.md frontmatters — the full ~61-item must_haves lists across both plans were also cross-checked against source and are consistent with this table; no contradicting evidence found).

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `frontend/src/types/push.ts` | Field-for-field mirror of `app/schemas/push.py` | ✓ VERIFIED | Exports `PushSubscriptionKeys`, `PushSubscribeRequest`, `PushSubscribeResponse`, `VapidPublicKeyResponse` (+ disclosed out-of-plan `DevTriggerReminderResponse`) |
| `frontend/src/lib/push.ts` | Single call site + feature detection + hour formatter | ✓ VERIFIED | All 7 declared exports present (`isPushSupported`, `readPermission`, `urlBase64ToUint8Array`, `getDeviceSubscription`, `ensureDeviceSubscribed`, `formatReminderHour`, `REMINDER_HOUR_OPTIONS`). 341-line test file, exceeds `min_lines: 120`. |
| `frontend/src/hooks/usePushCapability.ts` | D-12 VAPID gate | ✓ VERIFIED | `usePushCapability`, `PUSH_VAPID_QUERY_KEY` exported and used by both `TrainReminderButton` and `TrainScheduleSettings` |
| `frontend/src/components/train/TrainReminderButton.tsx` | D-01..D-05/D-13 score-screen slot | ✓ VERIFIED | Imported and rendered by `TrainScoreScreen.tsx:158` |
| `frontend/src/components/train/TrainScheduleSettings.tsx` | PERM-03/04 master toggle + hour picker | ✓ VERIFIED | `filter-reminder-enabled` and `filter-reminder-hour` test IDs present; 465-line file |
| `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` | ≥380 lines | ✓ VERIFIED | 661 lines |

### Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| `TrainReminderButton.tsx` | `lib/push.ts` | `ensureDeviceSubscribed(vapidPublicKey)` in `onClick` | ✓ WIRED (line 86) |
| `lib/push.ts` | `api/client.ts` | `pushApi.subscribe(subscription.toJSON())` | ✓ WIRED (line 160) |
| `TrainReminderButton.tsx` | `useTrainSettings.ts` | `save({...reminderEnabled: true})` on `'subscribed'` | ✓ WIRED (line 93-104) |
| `useTrainSettings.ts` | `types/train.ts` | full-replace PUT body carries `reminder_enabled`/`reminder_hour` | ✓ WIRED (client.ts mutationFn lines 50-56) |
| `TrainScheduleSettings.tsx` | `lib/push.ts` | `ensureDeviceSubscribed(vapidPublicKey)` in Switch's `onCheckedChange`, toggle-ON only | ✓ WIRED (line 348) |
| `TrainScheduleSettings.tsx` | `usePushCapability.ts` | gates the whole block | ✓ WIRED (line 258, 327) |
| `TrainScheduleSettings.tsx` | `useTrainSettings.ts` | debounced save carrying `reminderHour` | ✓ WIRED (line 300-317) |

### Behavioral Spot-Checks / Automated Test Run

| Suite | Command | Result | Status |
|---|---|---|---|
| Phase 202 test files (4 files) | `npx vitest run src/lib/__tests__/push.test.ts src/components/train/__tests__/TrainReminderButton.test.tsx src/components/train/__tests__/TrainScoreScreen.test.tsx src/components/train/__tests__/TrainScheduleSettings.test.tsx` | 4 files, 80 tests, all pass | ✓ PASS |
| Frontend lint | `npm run lint` | 0 errors (3 warnings, all in generated `coverage/` artifacts, unrelated to this phase) | ✓ PASS |
| Frontend build (tsc) | `npm run build` | exits 0, PWA precache generated | ✓ PASS |
| Frontend dead-code | `npm run knip` | 0 issues | ✓ PASS |
| Backend path isolation | `git diff --stat 848b3c197~1 5dafeb57d -- app/ alembic/ frontend/public/push-sw.js frontend/vite.config.ts` (phase 202's own commit range) | empty diff | ✓ PASS — no forbidden path touched by this phase's own commits |
| Anti-pattern scan | `grep -n -E "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across all 9 phase-modified/created source files | no matches | ✓ PASS |

### Live-Browser UAT (Task 3, 202-02-PLAN.md)

Blocking `checkpoint:human-verify` — treated as passed per verification instructions. The user ran the full 11-step protocol (dismiss-then-grant prompt, score-screen confirmation naming the hour, settings-card toggle/hour auto-save, toggle off-then-on with no second prompt, rapid off/on inside the debounce window settling correctly, real notification delivery via `POST /push/dev/trigger-reminder`, browser-level block leaving both surfaces absent/disabled with no stray PUT) and responded "approved" on 2026-08-02. Not re-run.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|---|---|---|---|
| PERM-01 | 202-01 | ✓ SATISFIED | Truths #1, #2, #6 above; REQUIREMENTS.md marks `[x]` and traceability table `Complete` |
| PERM-02 | 202-01 | ✓ SATISFIED | Truths #3, #7 above |
| PERM-03 | 202-02 | ✓ SATISFIED | Truth #4 above |
| PERM-04 | 202-02 | ✓ SATISFIED | Truths #5, #8, #11 above |

No orphaned requirements: `.planning/REQUIREMENTS.md` maps PERM-01..04 to Phase 202 only, matching both PLAN.md `requirements:` frontmatter fields exactly.

### Code-Review Follow-Up (202-REVIEW.md)

| Finding | Severity | Disposition | Verification |
|---|---|---|---|
| CR-01 (rejection escaping `ensureDeviceSubscribed`, stranding the control) | critical | Fixed for the rejection sub-case (commit `5dafeb57d`) | `try` now wraps the whole function body; both call sites carry `.catch()` backstops; dedicated regression test exists. **Residual gap**: the review's second named failure mode — `navigator.serviceWorker.ready` hanging (never settling) rather than rejecting — has no bounded timeout guard; see `additional_findings` in frontmatter. Info-level, not a must-have, not blocking. |
| WR-01 (subscribe failures never reached Sentry) | warning | Fixed (commit `5dafeb57d`) | `Sentry.captureException(error, { tags: { source: 'push' } })` added inside `ensureDeviceSubscribed`'s catch (`lib/push.ts:166`) |
| WR-02 (stale-cache overwrite of `weekday_mask`/`puzzles_per_session` on the score-screen save) | warning | Deliberately OPEN by user decision | Confirmed still present in code (`TrainReminderButton.tsx:95-96` reads from the React Query cache, not a fresh fetch); no code comment acknowledging the tradeoff was added (the review's "at minimum" suggestion), but this is a disclosed, accepted-open item per 202-02-SUMMARY.md's framing — not scored as a phase gap |
| WR-03 (no automated regression test for the rapid off-then-on-inside-debounce race) | warning | Deliberately OPEN by user decision | Confirmed absent from `TrainScheduleSettings.test.tsx` (only individual toggle-on/toggle-off tests exist); covered by the already-approved live-browser UAT instead — not scored as a phase gap |
| IN-01, IN-02 (info-level) | info | Not addressed | Cosmetic/minor; not requirements-relevant |

## Gaps Summary

No must-have truth failed, no artifact is missing or stub, no key link is unwired, and no blocker anti-pattern was found. Both roadmap-declared and plan-declared must-haves for PERM-01..04 hold in the actual source, backed by 80 passing automated tests plus an already-approved live-browser UAT round. The one deliberate scope deviation (SC1's literal "Yes/Not now" wording, superseded by D-02) is intentional and user-approved, not a miss. Two warning-level code-review items (WR-02, WR-03) remain open by explicit user decision and are disclosed above rather than hidden. One additional, previously-undisclosed nuance was found during verification: the CR-01 fix closes the "rejection" failure mode but not the "hang" failure mode the same review item named — recorded as an info-level finding for an honest record; it does not violate any must-have and does not block phase completion.

---

_Verified: 2026-08-02_
_Verifier: Claude (gsd-verifier)_
