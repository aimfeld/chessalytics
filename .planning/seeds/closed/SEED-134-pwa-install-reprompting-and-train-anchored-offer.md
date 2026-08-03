---
id: SEED-134
status: implemented
planted: 2026-08-02
planted_during: /gsd-explore session on getting users onto the mobile PWA (post phases 201/202)
promoted: 2026-08-02
promoted_to: Phase 203 (v2.11) — full seed in one phase, QR handoff not split off
trigger_when: next Train / retention-focused milestone, or whenever mobile conversion comes up
scope: medium-large (one phase, or two if the QR handoff is split off)
supersedes_part_of: SEED-132 Phase B (install promotion + iOS push)
---

# SEED-134: PWA install re-prompting + Train-anchored install offer

## Why This Matters

Phases 201/202 shipped web push and a score-screen reminder opt-in. The
reminder now works, but it lands on whichever device the user happened to be
using, and for most users that is a desktop browser. A desktop reminder at
18:00 arrives when the machine is asleep or the browser is quit, so it is
delivered on the next browser launch: at that point the user is already at the
computer and the notification has missed the moment it existed to create. A
phone reminder reaches the user wherever they are, which is also where a
5-puzzle Train session is most likely to actually get done.

Getting FlawChess onto phones is therefore the highest-leverage follow-up to
201/202. Install promotion already exists but is structurally incapable of
doing that job.

### Two premises to NOT re-derive

Both were checked in this session and both cut against the intuitive framing:

1. **Desktop push does not require an open FlawChess tab.** It wakes the
   service worker. What it requires is the browser *process* running; if the
   browser is fully quit the message is queued by the push service and
   delivered on next launch, within TTL. "Desktop reminders are weaker" is
   correct, but the reason is delivery *timing* and notification-centre
   triage, not a tab requirement.
2. **On Android, installing the PWA buys nothing for push.** Chrome on Android
   delivers push to an ordinary tabbed site. This restates SEED-132 decision
   A.2. Install-gates-push is true on **iOS only**. Any install copy that
   promises notifications is therefore false on every platform except iOS.

## The actual defect: the install prompt is burned permanently, by us

`frontend/src/hooks/useInstallPrompt.ts` already exists and
`frontend/src/components/install/InstallPromptBanner.tsx` is mounted globally
in `App.tsx` (both layout branches, lines 613 and 638). So install promotion is
not greenfield. It fails for three compounding reasons:

1. **Permanent dismissal.** `dismissAndroid` / `dismissIOS` (lines 38-47) write
   a bare `'true'` to `localStorage` with no expiry, and
   `showAndroidPrompt` / `showIOSBanner` read it as an absolute veto. One swat,
   gone forever, on both platforms.
2. **Worst-possible timing.** The drawer fires the instant
   `beforeinstallprompt` arrives, on whatever page the user is on, most likely
   during a first session before they have any reason to want an icon. Highest
   dismissal probability, and by (1) that dismissal is unrecoverable.
3. **Desktop users never see it at all.** `showAndroidPrompt` gates on
   `isMobile` (line 54), a UA test. On desktop the event is captured and the
   banner suppressed, so there is no desktop-to-phone bridge of any kind.

The critical asymmetry with what 201/202 built: **notification permission is
genuinely one-shot** (browser-enforced, no in-app recovery, which is the whole
reason SEED-132 decision 11 mandated the pre-prompt indirection). **The install
prompt is not.** Chrome re-fires `beforeinstallprompt`; we are the ones
discarding it.

## Locked decisions (from the /gsd-explore session, 2026-08-02)

### A. Re-prompting

1. **Replace the boolean dismissal with a timestamped cooldown plus an attempt
   cap.** Re-offer after N days, at most M times, then stop for good. This
   satisfies SEED-132 decision 19's dismissal-persistence requirement, and the
   cadence must live in our own state regardless because the platform
   guarantees nothing in either direction (see Research finding 1).
2. **Retime the first offer behind demonstrated value** rather than firing on
   arrival. Fewer prompts, each worth more, and by (1) each dismissal costs
   less.
3. **Grant push first, offer install second**, wherever both are available on
   the same device (Android tabbed). Permission is the non-renewable resource
   and is available immediately; install is re-offerable. Never spend the
   peak-intent moment on the recoverable ask.

### B. The Train reminder opt-in becomes the second-chance install surface

4. **Do not replace the desktop grant with a QR modal.** A QR is a
   high-friction ask (find phone, unlock, camera, scan) at the exact moment the
   user wanted a one-tap outcome, and it would regress 201/202 for the
   desktop-only user who is content with desktop reminders.
5. **The confirmed state is the upsell surface.**
   `TrainReminderButton.tsx:51-61` already renders a success span; that is
   where the QR offer (desktop) or the install offer (Android tabbed) belongs.
   Peak receptiveness, zero cost to ignore.
6. **On iOS tabbed, fill the currently-empty slot.** `capability.available` is
   false without `PushManager`, so the guard at `TrainReminderButton.tsx:67-78`
   returns `null` and the iOS user in a tab sees no button at all. Honest, but
   a dead end. iOS is the one platform where install genuinely unlocks
   something, so that slot should carry an install affordance routing into the
   existing Share to Add-to-Home-Screen instructions.
7. **This absorbs SEED-132's iOS two-session cliff.** Install then later visit
   then permission stops being an awkward standalone flow and becomes the
   natural continuation of a reminder opt-in the user already asked for. The
   mitigation for the cliff is to proactively re-surface the reminder prompt on
   the next standalone launch, not to hope the user hunts for the button. See
   Open question 1 for what that depends on.

### C. Desktop to phone handoff

8. **QR encodes a plain URL with a `?src=handoff` marker**, not a credential.
   The phone logs in via Google SSO (already supported, roughly two taps),
   lands on `/train`, and the marker drives the install plus reminder flow
   immediately.
9. **Rejected for v1: a signed one-time handoff token in the QR URL.** It would
   log the phone straight in and convert far better, but it renders a scannable
   credential on a screen. A screen-share, a shoulder-surf, or a photo of the
   monitor is account takeover. If revisited it needs short TTL, single-use,
   and rate limiting, and it should be scoped as an auth change rather than a
   UX detail.
10. **A QR dependency does not exist in the project** (checked 2026-08-02, no
    `qrcode` / `qrcode.react` in `frontend/package.json`). This adds a new
    frontend dependency, small but knip-relevant.
11. **The QR must be dismissible and never blocking.** A desktop-only user
    without a smartphone, or without the wish to use one, has to be able to
    ignore it permanently.

### D. The real complexity is the state machine, not the QR

12. `TrainReminderButton` grows from one state to five, derived from three
    signals (`available`, `isStandalone`, `isIOS`) plus subscription state:

    | State | Behavior |
    |---|---|
    | Desktop, unsubscribed | grant → confirmed + QR offer |
    | Android tabbed, unsubscribed | grant → confirmed + install offer |
    | iOS tabbed | cannot grant → install instructions (today: renders nothing) |
    | Any standalone, unsubscribed | grant → confirmed, no install offer |
    | Subscribed | current confirmed span |

    Naming this up front is worth more than the QR discussion. It is the piece
    that would otherwise surface halfway through execution.

### E. Amendment 2026-08-02 — ship the iOS branch unverified, fail safe

Added after an attempt to settle Open question 1 came up short. The operator
has no iPhone and no iPad; a test on macOS Brave was run and **does not
count** — Chromium desktop PWAs have always shared storage with the browser
profile, so staying logged in there was the expected outcome and says nothing
about iOS WebKit's historical tab-vs-home-screen storage partitioning. It did
confirm one minor thing: the *desktop* install path does not log the user out.

13. **Proceed without pre-verification.** Phase 203 ships the iOS branch on an
    unverified assumption, and an iPhone owner is asked to test after deploy.
    Accepted deliberately: the iOS branch is one slice, and the Android +
    desktop + re-prompting work carries most of the value and is ungated.
    Plan 203 so the iOS slice is separable, so a bad answer costs one plan
    rather than the phase.
14. **The reminder intent lives server-side, never in `localStorage`.** A
    `reminder_intent_at` column on `train_settings` (a table this work already
    touches) survives regardless of how the storage question resolves. If iOS
    storage turns out to be shared it is harmless redundancy; if it is not, it
    is what lets the flow resume after a forced re-login instead of the intent
    vanishing silently. Same cost either way. **This is the rule that makes
    decision 13 cheap — do not substitute a `localStorage` flag for it.**
15. **iOS copy must stay true if the user lands logged out.** "Add FlawChess to
    your home screen, then open it and turn on reminders" survives a re-login.
    "Add to home screen and you'll get reminders" does not. Write the honest
    one even though it is longer.
16. **The answer arrives passively after deploy.** If iOS standalone devices
    never appear in `push_subscriptions`, that is the signal, with no tester
    required. The one-off iPhone check only gets there faster. Worth a look at
    the table a few weeks post-deploy before assuming the branch works.

## Research findings (2026-08-02, with sources)

1. **Chrome's ~90-day cooldown is keyed to the mini-infobar, not the event.**
   Since Chrome 76 `preventDefault()` suppresses that infobar outright, so a
   user dismissing *our* drawer never reaches it. **[ASSUMED]** No
   authoritative source documents a cooldown triggered by dismissing your own
   custom UI, in either direction. Practically this is fine because it forces
   the cadence into our own state, which decision A.1 wants anyway.
   ([mini-infobar-update](https://developer.chrome.com/blog/mini-infobar-update),
   [a2hs-updates](https://developer.chrome.com/blog/a2hs-updates) — the latter
   predates Chrome 76 and its `preventDefault()` claim is stale.)
2. **No engagement heuristic gate.** Chrome removed it. The only documented
   reasons `beforeinstallprompt` will not fire are: already installed,
   installability criteria unmet, unsupported browser. After a native-dialog
   dismissal it typically re-fires immediately.
   ([update-install-criteria](https://developer.chrome.com/blog/update-install-criteria),
   [customize-install](https://web.dev/articles/customize-install))
3. **The event is single-use and dies with the document.** `prompt()` may only
   be called once per `BeforeInstallPromptEvent` instance, and the event must be
   re-captured on each page load. **This breaks the planned flow as currently
   coded**: `dismissAndroid` calls `setPromptEvent(null)`
   (`useInstallPrompt.ts:41`), and FlawChess is an SPA where route changes are
   not page loads, so no replacement event arrives. A user who swats the drawer
   on Home, then trains, then reaches the score screen finds the Install button
   a dead no-op for the rest of that session. Fix: on dismiss keep the event and
   move only the cooldown state; null it solely after a successful install.
   ([MDN prompt()](https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent/prompt))
4. **iOS: gate on feature detection, not display mode.** WebKit's own guidance
   is `'Notification' in window && 'PushManager' in window`. Web Push is
   Home-Screen-web-apps-only on iOS 16.4+, and the permission call must come
   from direct user interaction such as a button tap.
   ([Web Push for iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
   [Safari 16.4 features](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/))

## Known defects in existing code (independent of this seed)

Both are wrong today whether or not this seed is ever built:

- **`isStandalone` misses iOS.** `useInstallPrompt.ts:50` checks only
  `matchMedia('(display-mode: standalone)')`. The historically reliable iOS
  signal is `navigator.standalone`, and finding 4 could not confirm the media
  query works there. If it does not, every iOS user who already installed
  FlawChess keeps seeing the "tap Share then Add to Home Screen" banner
  permanently. Fix: OR both checks.
- **`setPromptEvent(null)` on dismiss** (line 41) — finding 3 above.

## Open questions (resolve during phase research)

1. **Does localStorage survive the iOS Safari-tab to standalone transition?**
   **Unverified assumption — the design must tolerate both outcomes** (see
   decision 13; this was a blocker until the 2026-08-02 amendment downgraded
   it). Historically iOS home-screen web apps had a storage container separate
   from Safari. If that is still true then **the auth token in `localStorage`
   dies and the PWA launches logged out** — larger than this feature, since it
   would mean every iOS install lands on a login screen, and it independently
   weakens the QR handoff. The intent flag is already immunised by decision 14;
   the auth question is not, and has no cheap mitigation beyond honest copy
   (decision 15). Checkable only on a real iPhone or iPad, or possibly the
   Xcode Simulator (free, Apple-Silicon native, no Developer Program needed,
   but its Add-to-Home-Screen and Web Push support are undocumented and a
   Simulator pointed at a LAN dev server has no secure context, so it must be
   pointed at `flawchess.com`). Do not re-run this against a desktop Chromium
   browser — that answers a different question.
2. **Empirically confirm finding 1** — that Chrome re-fires
   `beforeinstallprompt` on a subsequent visit after the user dismissed our
   `preventDefault()`ed custom UI. Undocumented in both directions; needs a run
   in a real Chrome profile, not more doc-reading. The cooldown design in A.1
   rests on it.
3. **What counts as "demonstrated value" for decision A.2?** Candidates: has
   imported games, has completed one Train session, has completed N sessions.
   Needs a call, and it interacts with where the banner is allowed to mount.
4. **Cooldown constants** for A.1: the N days and M attempts. No data to pick
   from; start conservative and make them named constants, not literals.
5. **Does the Train solve loop hold up on a mid-range phone?** The grading step
   runs Stockfish WASM client-side. Driving users to mobile is only a win if
   the session is actually pleasant there. Worth a measurement before promoting
   mobile hard.

## Implementation anchors (current code)

- `frontend/src/hooks/useInstallPrompt.ts` — the whole re-prompting rewrite
  lands here: dismissal state (lines 38-47), the `isMobile` desktop gate (54),
  `isStandalone` (50), and the event-nulling defect (41).
- `frontend/src/components/install/InstallPromptBanner.tsx` — Android drawer
  plus iOS instructional banner. Copy currently reads "faster load, full
  screen, offline assets", which is generic and not tied to Train value.
- `frontend/src/App.tsx:613,638` — the two global mount points.
- `frontend/src/components/train/TrainReminderButton.tsx` — the five-state
  machine of decision D.12. Confirmed span at 51-61 (decision B.5), capability
  guard at 67-78 (decision B.6), `handleClick` at 80-119.
- `frontend/src/lib/push.ts` — single call site of
  `Notification.requestPermission()`; `usePushCapability` supplies `available`.
- `frontend/src/components/train/TrainScheduleSettings.tsx` — permanent
  non-nagging home for the QR offer, alongside the toggle and hour picker.
- `frontend/vite.config.ts:57` — `devOptions: { enabled: true }`, so the SW
  registers in dev and localhost is installable. Note dev and prod are separate
  origins with separate install state and separate localStorage, which is why
  a prod install is invisible to dev testing.

## Out of scope

- Removing or weakening desktop push. 201/202 shipped it, SEED-132 decision A.1
  keeps it first-class, and a desktop-only user is a real user.
- A signed handoff credential in the QR (decision C.9).
- Switching the service worker to `injectManifest` (SEED-132 decision 15 still
  holds).
- Any notification type beyond the Train reminder (SEED-132 out-of-scope still
  holds).
