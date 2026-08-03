# Phase 202: Reminder Permission UX - Research

**Researched:** 2026-08-02
**Domain:** Browser Push API subscription flow (frontend-only, native Web APIs, no new packages) integrated into two existing React/TanStack surfaces
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

SEED-132 already locked: ask on the score screen after a completed session
(decision 11), `TrainScheduleSettings` as the permanent fallback surface
(decision 12), the master toggle outranking the hour picker (decision 9),
asking on Train landing or at import completion rejected (decision 13), and
guests out of scope. Those are NOT restated as decisions here — read the seed.

- **D-01:** A persistent secondary "Remind me" button beside Done — not a
  one-shot card and not a modal. Renders on every score screen for as long
  as this device is not reachable, disappears once it is. Visibility is
  derived from live state (is this device subscribed?), not persisted
  history. Rejected: an inline `Card` (needs seen/declined state machine),
  a `Dialog` modal (interrupts the confetti moment).
- **D-02:** Pressing "Remind me" goes straight to
  `Notification.requestPermission()`. The button press IS the pre-prompt.
  **Deliberate, recorded deviation from PERM-01/ROADMAP SC1's literal
  "Yes / Not now" wording** — the planner must NOT "restore" a Yes/Not-now
  step. Rejected: button → explainer with Yes/Not now; button + permanent
  caption.
- **D-03:** On successful grant + subscribe, the button swaps in place to an
  inline confirmation naming the hour (e.g. "Reminders on — 18:00 on your
  training days"), reusing the `Check` icon + muted-text treatment
  `TrainScheduleSettings`'s "Saved" indicator uses. Rejected: silent
  disappearance, a sonner toast.
- **D-04:** Button hierarchy: Done promoted to primary (`variant="default"`),
  moves RIGHT; "Remind me" is `brand-outline`, LEFT. **Overrides**
  `TrainScoreScreen.tsx`'s existing SEED-122 docstring rationale for Done
  being `brand-outline` — the planner must apply this override.
- **D-05:** Visibility is per-device; the button appears on each new device
  independently (subscriptions are per-device-per-browser; `reminder_enabled`
  is account-wide). This asymmetry is intended.
- **D-06:** Toggling the master switch ON when `Notification.permission` is
  `'default'` fires the browser prompt via the same shared "ensure this
  device is subscribed" routine the score-screen button calls — one code
  path, two entry points. If the user denies, the toggle springs back off
  with a stated reason — it must never read on while nothing can be
  delivered. Rejected: a toggle that writes only `reminder_enabled` plus a
  separate "Enable on this device" control; a toggle disabled until the
  device is subscribed (dead-end UI).
- **D-07:** Toggling OFF flips `reminder_enabled` to false and KEEPS the
  `push_subscriptions` row — PERM-04 verbatim. Rejected: calling
  `POST /push/unsubscribe` on toggle-off; calling browser-side
  `PushSubscription.unsubscribe()` while keeping the row.
- **D-08:** The hour picker is a Radix `Select` (`ui/select.tsx`) with all 24
  hours, local-time labels, mapping 1:1 to `reminder_hour` (backend CHECK
  0..23). Rejected: preset chip set; native `<select>`.
- **D-09:** Hour changes and toggle-OFF ride the existing 600ms debounced
  draft in `TrainScheduleSettings` — one `PUT /train/settings`, existing
  "Saved"/"Couldn't save. Try again." indicator. **Toggle-ON is the one
  asynchronous exception**: request permission → `POST /push/subscribe` →
  only on success set `reminder_enabled` in the draft. A denial or failed
  subscribe never writes `true`. Rejected: an immediate non-debounced save
  for the toggle; firing the permission request in parallel with the
  debounced PUT.
- **D-10:** Push genuinely unsupported → hide BOTH surfaces entirely.
  Feature-detect `'serviceWorker' in navigator && 'PushManager' in window`.
  Covers iOS Safari outside standalone. Rejected: keeping an explanatory
  Settings row with per-platform copy.
- **D-11:** `Notification.permission === 'denied'` → hide the score-screen
  button, but show a DISABLED row in `TrainScheduleSettings` naming the
  cause ("Reminders are blocked in your browser settings") — no per-browser
  un-block instructions. Rejected: hiding both; showing both and explaining
  on press.
- **D-12:** VAPID-unconfigured detected by querying the key up front — a
  TanStack `useQuery` on `GET /push/vapid-public-key` with
  `staleTime: Infinity`, resolved before either surface renders. A 404 hides
  both surfaces like D-10. **This is the default state on a fresh dev
  machine and in CI** — must be stated in the plan's UAT setup, not
  discovered. Rejected: lazy fetch on press; a Vite build-time env flag.
- **D-13:** Grant succeeded but `PushManager.subscribe()` threw or
  `POST /push/subscribe` failed → inline error in place, permission spent,
  `reminder_enabled` never written true. Score screen: "Couldn't turn on
  reminders. Try again.", stays pressable. Settings: toggle springs back off
  with the same message. Sentry capture comes free via the global
  `MutationCache.onError` — do NOT add a duplicate `Sentry.captureException`.
  Rejected: special-casing Brave's `AbortError`; a generic toast leaving the
  control unchanged.

### Claude's Discretion

- Whether the hour picker is hidden or disabled when the master toggle is off.
- Exact copy and icon for the "Remind me" button (a bell icon was floated,
  not locked) and for the D-03 confirmation line.
- Where the shared "ensure this device is subscribed" routine lives (a hook
  vs. a `lib/` module) and how it obtains the service worker registration.
- Whether the score-screen surface warrants its own component file or stays
  inline in `TrainScoreScreen.tsx`.
- Test strategy for `PushManager` / `Notification.permission` under jsdom,
  and whether the base64url → `Uint8Array` VAPID key conversion gets its own
  unit test.
- Placement of the toggle + hour picker within the existing "Train schedule"
  card, relative to the weekday chips and puzzles-per-session group.

### Deferred Ideas (OUT OF SCOPE)

- A value-proposition pitch for the opt-in (a sentence of copy a card would
  have carried). Revisit as a caption or one-time explainer if conversion is
  poor; do not revisit as a dismissible card.
- Re-asking after a long gap ("show once more after 30 days / 10 sessions").
  Moot under D-01; turns into a nag if a threshold is ever tuned down.
- Brave-specific `AbortError` guidance. Revisit only if Sentry shows real
  users hitting it.
- A per-device management list ("your devices", last-seen labels) — needs
  columns 201 D-05 deferred.
- SEED-132 Phase B — install promotion, desktop→phone QR handoff, Android
  `beforeinstallprompt`, the iOS install-then-permission path. Out of this
  milestone on a BrowserStack dependency.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PERM-01 | After the user's first completed session, `TrainScoreScreen` shows a custom in-app pre-prompt with Yes / Not now; only the Yes path calls the real browser permission API. **(D-01/D-02 deliberately satisfy this via a persistent "Remind me" button, not a literal Yes/Not-now dialog — see User Constraints above.)** | `ensureDeviceSubscribed()` (Architecture Patterns, Pattern 1) is the single call site for `Notification.requestPermission()`; Pattern 2 grounds the button's live-state visibility derivation (D-01); Validation Architecture maps a unit test asserting `requestPermission` fires only on click. |
| PERM-02 | "Not now" stays recoverable and is never a nag — the user is never pushed toward the one browser prompt that can permanently deny them. | D-01's visibility-from-live-state design (no persisted "declined" flag) is the mechanism; Common Pitfalls names the `useUserFlag` anti-pattern explicitly rejected; Validation Architecture includes a negative-assertion test (no `localStorage.setItem` on decline). |
| PERM-03 | `TrainScheduleSettings` hosts a master reminder toggle and hour picker with the same auto-saving behavior as the existing pickers, so a user who declined can subscribe later. | Pattern 3 + the Code Examples section ground the exact debounce-extension mechanics against the verbatim existing save effect (`TrainScheduleSettings.tsx:172-194`); Don't-Hand-Roll section names the Radix `Select`/`Switch` primitives already in the repo (D-08). |
| PERM-04 | Turning the master toggle off silences reminders inside FlawChess without touching the browser permission grant, keeping the user reachable. | D-07 grounded directly against `app/routers/push.py`'s unsubscribe endpoint (verified NOT to be called on toggle-off); Security Domain's threat-pattern table names the toggle-off/unsubscribe-conflation risk explicitly with its test mitigation; Validation Architecture maps a spy-based negative-assertion test. |
</phase_requirements>

## Summary

This phase adds zero new dependencies and zero backend work. It is entirely
about wiring three already-shipped native browser APIs
(`Notification.requestPermission()`, `ServiceWorkerRegistration.pushManager`,
`PushManager.subscribe()`) into two existing, well-understood React
components (`TrainScoreScreen`, `TrainScheduleSettings`) against an
already-shipped backend surface (`app/routers/push.py`). The CONTEXT.md
decisions (D-01 through D-13) are exhaustive and load-bearing — this research
does not need to relitigate any of them, only ground the implementation
mechanics they assume.

The central engineering problem is not the browser API itself (it's three
well-documented calls) but state coherence: three independent pieces of
truth — server `reminder_enabled` (TanStack cache), server subscription
existence (implicit — no GET endpoint exists to query it), and browser
`Notification.permission` (a live, un-cacheable, poll-on-read global) — must
never be allowed to drift into a state where the UI claims "reminders on"
while the browser cannot actually deliver one. D-06/D-07/D-09/D-13 already
specify the exact resolution: permission and subscribe are gated together
behind one shared routine, `reminder_enabled` is only ever written `true`
after a *verified* successful subscribe round-trip, and toggling off never
touches the browser grant.

**Primary recommendation:** build one shared async routine —
`ensureDeviceSubscribed()` in a `lib/push.ts` module (not a hook, since both
call sites need it as an imperative action inside a click handler / mutation,
not a rendered value) — that performs: feature-detect → check
`Notification.permission` → request if `'default'` → get/wait for SW
registration → check `getSubscription()` (idempotent if already subscribed)
→ `pushManager.subscribe()` → `POST /push/subscribe`. Both `TrainScoreScreen`'s
button and `TrainScheduleSettings`'s toggle call this one function; only
their *display logic* around it differs (D-06's spring-back, D-13's inline
error strings).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Browser permission prompt (`Notification.requestPermission`) | Browser / Client | — | Native browser API, cannot be proxied or simulated server-side |
| Push subscription creation (`PushManager.subscribe`) | Browser / Client | — | Requires the live SW registration + VAPID key in-browser; produces an endpoint+keys blob only the browser can generate |
| Subscription persistence | API / Backend | Database | `POST /push/subscribe` (Phase 201, unchanged) — client never talks to Postgres directly |
| `reminder_enabled` / `reminder_hour` state | API / Backend | Database | `PUT /train/settings` (Phase 201, unchanged) — single source of truth for "should this account receive reminders" |
| Detecting "is *this device* currently subscribed" | Browser / Client | — | No backend endpoint returns this (Phase 201 shipped no GET-subscription-status route); the client derives it live from `Notification.permission` + `getSubscription()`, not from a server round-trip |
| Score-screen opt-in surface (D-01..D-05) | Browser / Client (React) | — | Pure UI state driven by the live permission/subscription check above |
| Settings toggle + hour picker (D-06..D-13) | Browser / Client (React) | API / Backend (via existing `useTrainSettings`) | UI orchestration client-side; persistence via the existing settings PUT, unchanged shape extended with 2 fields |
| Service worker push/notificationclick handling | Browser / Client (SW) | — | `push-sw.js`, already shipped Phase 201 — out of scope, do not touch |

**Key implication for planning:** because no backend endpoint reports
"is this device subscribed," the device-level subscription state used for
D-01/D-05's button visibility and D-11's Settings row is **derived, not
fetched** — `Notification.permission` (`'default'` / `'granted'` /
`'denied'`) combined with `registration.pushManager.getSubscription()`
(returns `null` when this browser profile holds no subscription, even if
`granted`). This is a client-only computation; the planner must not invent a
new backend query for it.

## Standard Stack

### Core

No new libraries. Every capability in scope is a native browser API already
available in the target browsers (Chrome/Edge/Firefox desktop, Android
Chrome — iOS explicitly out per D-10):

| API | Purpose | Support surface |
|-----|---------|-----------------|
| `Notification.requestPermission()` | Fires the one-shot browser permission dialog [CITED: MDN Notification API] | Chrome, Edge, Firefox, Android Chrome; **not exposed** on iOS Safari outside installed-PWA standalone mode (SEED-132 Phase A premise, `.planning/REQUIREMENTS.md` line 15) |
| `navigator.serviceWorker.ready` / `getRegistration()` | Obtains the `ServiceWorkerRegistration` handle `pushManager` hangs off of | Same as above; already used in `frontend/src/main.tsx:38` [VERIFIED: frontend/src/main.tsx:38] `const reg = await navigator.serviceWorker.getRegistration();` |
| `PushManager.subscribe({userVisibleOnly, applicationServerKey})` | Creates the subscription; returns a `PushSubscription` | `userVisibleOnly: true` is mandatory — Chrome/Edge reject the promise otherwise [CITED: web.dev/articles/push-notifications-subscribing-a-user] |
| `PushSubscription.toJSON()` | Yields `{endpoint, expirationTime, keys: {p256dh, auth}}` — the exact shape `PushSubscribeRequest` expects | Standard, matches `app/schemas/push.py::PushSubscriptionKeys` field names 1:1 [VERIFIED: app/schemas/push.py:12-16] `class PushSubscriptionKeys(BaseModel): p256dh: str; auth: str` |
| `registration.pushManager.getSubscription()` | Returns the existing `PushSubscription` or `null` — the mechanism for "is this device already subscribed" | [CITED: web.dev/articles/push-notifications-subscribing-a-user] — documented resubscription-check pattern |

### Supporting

No supporting libraries beyond what's already in the repo:

| Component | Purpose | Already present |
|-----------|---------|------------------|
| `@tanstack/react-query` | `useMutation` for the subscribe/unsubscribe/settings-save flows | Yes — `useTrainSettings.ts` pattern to extend |
| Radix `Select` (`ui/select.tsx`) | Hour picker (D-08) | Yes, present, used elsewhere |
| Radix `Switch` (`ui/switch.tsx`) | Master toggle | Yes, used in `pages/Analysis.tsx`, `MaiaHumanPanel.tsx` [VERIFIED: frontend/src/components/ui/switch.tsx:18-37] |
| `axios` (via `apiClient`) | New `pushApi` group | Yes — extend `frontend/src/api/client.ts` following the `trainApi` pattern [VERIFIED: frontend/src/api/client.ts:264-279] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Deriving subscription state client-side via `getSubscription()` | A new `GET /push/subscription-status` backend endpoint | Rejected implicitly by CONTEXT.md scope ("No backend work belongs in this phase") — and `getSubscription()` is strictly more correct anyway, since it reflects *this device's* browser-level truth, not a DB row that could be stale relative to a browser-level revoke the server never learns about |
| One shared `ensureDeviceSubscribed()` function | Duplicating the subscribe flow in both `TrainScoreScreen` and `TrainScheduleSettings` | Rejected — CONTEXT.md D-06 explicitly says "the same shared 'ensure this device is subscribed' routine the score-screen button calls. One code path, two entry points." |
| `lib/push.ts` plain module | A `usePushSubscription()` hook | Left to Claude's discretion (CONTEXT.md). A plain async function is easier to call imperatively from inside a `TanStack useMutation`'s `mutationFn` (needed for D-13's error-state integration) than a hook, which cannot be called conditionally/imperatively. Recommend the module, wrapped by a thin mutation hook per call site for D-09's async/debounce split. |

**Installation:** none — no `npm install` needed. This section is present per
the output contract but has nothing to add.

**Version verification:** N/A — zero new packages. Existing packages already
pinned in `package.json`: `vite-plugin-pwa@1.3.0` [VERIFIED: `npm ls
vite-plugin-pwa` → `vite-plugin-pwa@1.3.0`], `@tanstack/react-query` (already
in use, version unchanged by this phase), `radix-ui` (unchanged).

## Package Legitimacy Audit

**Not applicable — this phase installs no external packages.** Every
capability (`Notification`, `ServiceWorkerRegistration.pushManager`,
`PushManager.subscribe`, `PushSubscription.toJSON()`) is a native browser Web
API. No `npm install` command appears anywhere in this phase's plan. The
Package Legitimacy Gate is skipped per its own trigger condition ("whenever
this phase installs external packages").

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser (client tier)                                                │
│                                                                        │
│  TrainScoreScreen           TrainScheduleSettings                     │
│  "Remind me" button    ┌──▶  master Switch                            │
│        │                │        │                                   │
│        ▼                │        ▼                                   │
│  ┌─────────────────────┴──────────────────────┐                      │
│  │  ensureDeviceSubscribed()  (lib/push.ts)     │                      │
│  │  1. feature-detect (serviceWorker+PushMgr)   │                      │
│  │  2. Notification.permission check            │                      │
│  │     - 'granted' → skip to 4                  │                      │
│  │     - 'denied'  → return DENIED (no prompt)  │                      │
│  │     - 'default' → requestPermission()        │                      │
│  │  3. permission denied by user → return DENIED│                      │
│  │  4. navigator.serviceWorker.ready             │                      │
│  │  5. registration.pushManager.subscribe(       │                      │
│  │       {userVisibleOnly:true,                  │                      │
│  │        applicationServerKey})                 │                      │
│  │  6. POST /push/subscribe  ───────────────────┼──▶ app/routers/push.py│
│  │  7. return SUBSCRIBED | DENIED | ERROR         │      (Phase 201,    │
│  └──────────────────┬─────────────────────────┘      unchanged)       │
│                     │ on SUBSCRIBED                                    │
│                     ▼                                                  │
│         PUT /train/settings {reminder_enabled:true, reminder_hour} ───┼──▶ app/routers/train.py
│                                                                        │      (Phase 201, extend
│  GET /push/vapid-public-key ──── useQuery(staleTime:Infinity) ────────┼──▶  schema only)
│  (resolved BEFORE either surface renders — D-12 gate)                 │
└─────────────────────────────────────────────────────────────────────┘
                     │
                     ▼ (async, out of band — background scheduler)
┌─────────────────────────────────────────────────────────────────────┐
│ Server (already shipped, Phase 201, untouched this phase)             │
│  train_reminder scheduler → push_send.send_to_user() → push-sw.js     │
│  push handler → showNotification() → notificationclick → focus/open   │
└─────────────────────────────────────────────────────────────────────┘
```

A reader can trace D-01→D-13 along this diagram: the button/toggle both
funnel into the single `ensureDeviceSubscribed()` box, which is the only
place `Notification.requestPermission()` or `pushManager.subscribe()` is
ever called (PERM-01's "only the Yes path calls the real browser permission
API").

### Recommended Project Structure

```
frontend/src/
├── lib/
│   └── push.ts                    # ensureDeviceSubscribed(), getDevicePushState(),
│                                   # urlBase64ToUint8Array(), feature-detect helper
├── hooks/
│   ├── usePushSubscribe.ts        # thin useMutation wrapper around
│   │                               # ensureDeviceSubscribed(), shared by both call sites
│   └── useTrainSettings.ts        # EXTEND: draft gains reminderEnabled/reminderHour,
│                                   # PUT body gains the two fields
├── types/
│   ├── train.ts                   # EXTEND: TrainSettingsResponse/Update +2 fields
│   └── push.ts                    # NEW: PushSubscriptionKeys, VapidPublicKeyResponse
│                                   # mirrors matching app/schemas/push.py
├── api/
│   └── client.ts                  # EXTEND: pushApi {subscribe, unsubscribe, getVapidKey}
└── components/train/
    ├── TrainScoreScreen.tsx       # EXTEND: button row, D-01..D-05
    └── TrainScheduleSettings.tsx  # EXTEND: toggle + hour Select, D-06..D-13
```

Whether `TrainScoreScreen`'s reminder button becomes its own component file
or stays inline is explicitly Claude's discretion per CONTEXT.md — given the
button carries D-01 (visibility derivation), D-02 (permission-request
click handler), D-03 (post-success inline confirmation naming the hour), and
D-13 (inline error state), it is roughly the same shape/complexity as the
`ScheduleCardShell` extraction already used in `TrainScheduleSettings.tsx` —
recommend extracting a small `TrainReminderButton` component so
`TrainScoreScreen.tsx` doesn't absorb ~60-80 logic LOC of state machine
directly (CLAUDE.md's nesting/LOC limits), but this is a recommendation, not
a locked decision.

### Pattern 1: The shared `ensureDeviceSubscribed()` routine (D-06's "one code path, two entry points")

**What:** A single async function performing permission-check → request →
SW-ready → subscribe → POST, returning a discriminated-union result so
callers can branch without string-sniffing errors.

**When to use:** Called from both the score-screen button's click handler
and the settings toggle's `onCheckedChange` handler (only when transitioning
`false → true` and `Notification.permission !== 'granted'`, per D-06).

**Example (shape, not final code — mechanics grounded in code read this session):**
```typescript
// lib/push.ts
export type DeviceSubscribeResult =
  | { status: 'subscribed'; subscription: PushSubscriptionJSON }
  | { status: 'denied' }          // browser-level deny — D-02/D-11 asymmetry
  | { status: 'unsupported' }     // D-10 feature-detect failure
  | { status: 'error'; error: unknown }; // D-13 — subscribe() threw or POST failed

export function isPushSupported(): boolean {
  // D-10: feature-detect exactly this — covers iOS Safari outside standalone
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

// Source: web.dev/articles/push-notifications-subscribing-a-user (pattern),
// exact byte-for-byte implementation from established convention — verify
// against MDN base64 decode semantics at implementation time.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export async function ensureDeviceSubscribed(
  vapidPublicKey: string,
): Promise<DeviceSubscribeResult> {
  if (!isPushSupported()) return { status: 'unsupported' };

  if (Notification.permission === 'denied') return { status: 'denied' };
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission(); // D-02: the ONLY call site
    if (result !== 'granted') return { status: 'denied' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true, // mandatory on Chrome/Edge
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));
    await pushApi.subscribe(subscription.toJSON() as PushSubscriptionJSON);
    return { status: 'subscribed', subscription: subscription.toJSON() as PushSubscriptionJSON };
  } catch (error) {
    return { status: 'error', error }; // D-13
  }
}
```
Source basis: `navigator.serviceWorker.ready` / `PushManager.subscribe` /
`toJSON()` mechanics [CITED: web.dev/articles/push-notifications-subscribing-a-user];
`userVisibleOnly: true` requirement [CITED: same source — "You must pass a
value of true"]; response shape match to backend
[VERIFIED: app/schemas/push.py:19-23] `class PushSubscribeRequest(BaseModel): endpoint: AnyHttpUrl; keys: PushSubscriptionKeys`.

### Pattern 2: D-05's per-device visibility derivation

**What:** The score-screen button's visibility is `isPushSupported() &&
Notification.permission !== 'denied' && !subscription` (no `useState`
caching needed — read live on render/effect).

**When to use:** `TrainScoreScreen` mount effect, re-derived each mount
(sessions are once-per-day, so staleness risk is low, but querying
`getSubscription()` is cheap and async — do it in a `useEffect` with a
loading gate, not `useQuery`, since it's not server data).

**Anti-pattern to avoid:** Do NOT persist "is this device subscribed" via
`localStorage` or a TanStack cache — D-01/D-05 explicitly ground visibility
in **live browser state**, not history. `useUserFlag.ts`'s pattern is
explicitly named "deliberately NOT used" in CONTEXT.md's code_context
section for this exact reason.

### Pattern 3: D-09's async-exception-to-the-debounce rule

**What:** `TrainScheduleSettings`'s existing debounced-draft save (weekday
mask, puzzles-per-session) is a *pure* draft-diff-and-PUT loop
[VERIFIED: frontend/src/components/train/TrainScheduleSettings.tsx:172-194]
`if (!hasEditedRef.current || debouncedDraft === null || data === undefined) return; ... save({...}, {onSuccess, onError})`.
Toggle-ON breaks this pattern deliberately (D-09): it must NOT write
`reminder_enabled: true` into `draft` state until `ensureDeviceSubscribed()`
resolves `'subscribed'`. Toggle-OFF and hour changes DO ride the existing
debounced draft unchanged.

**When to use:** In the toggle's `onCheckedChange` handler:
```typescript
onCheckedChange={(checked) => {
  if (!checked) {
    hasEditedRef.current = true;
    setDraft((prev) => (prev ? { ...prev, reminderEnabled: false } : prev));
    return; // rides the existing debounce — D-09
  }
  // Turning ON: async exception. Do NOT set draft.reminderEnabled yet.
  void ensureDeviceSubscribed(vapidKey).then((result) => {
    if (result.status === 'subscribed') {
      hasEditedRef.current = true;
      setDraft((prev) => (prev ? { ...prev, reminderEnabled: true } : prev));
      // falls through into the SAME debounced-save effect once draft updates
    } else {
      setToggleError(result.status); // D-06/D-13 spring-back — never sets draft true
    }
  });
}}
```

### Anti-Patterns to Avoid

- **Firing `PushManager.subscribe()` before checking `getSubscription()`
  first:** calling `subscribe()` on an already-subscribed registration is
  actually idempotent per spec (returns the existing subscription rather
  than erroring in most browsers), but checking `getSubscription()` first
  avoids an unnecessary browser round-trip and — more importantly — is how
  D-05's "is this device subscribed" visibility check itself works, so the
  logic must exist regardless; don't duplicate it.
- **Reading `Notification.permission` inside a `useState` initializer without
  re-checking on mount of a *new* component instance across devices/tabs:**
  `Notification.permission` can change between renders if the user visits
  the browser's own site-settings UI in another tab. Re-read it live rather
  than caching it in a ref that outlives the check.
- **Calling `requestPermission()` speculatively (e.g. on hover, on page
  load, or in an effect):** PERM-01/D-02 requires it to fire ONLY inside the
  explicit click handler for "Remind me" or the toggle-ON handler — never on
  mount, never prefetched. This is also required by the spec itself in most
  browsers: `requestPermission()` triggered outside a user gesture is
  auto-rejected/ignored by Chrome's "must be triggered by a user gesture"
  policy in many versions [ASSUMED — Chrome's user-activation requirement
  for notification prompts is a known browser policy from training
  knowledge; verify current exact enforcement at implementation/UAT time
  rather than relying on it silently].

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Detecting "is this device subscribed" | A new backend endpoint, a localStorage flag, or a client-side subscription cache | `registration.pushManager.getSubscription()`, called live | It is the only source of truth that can never drift from the actual browser-level state (a server row can go stale if the user revokes via browser settings; `getSubscription()` cannot) |
| Base64url → Uint8Array conversion | A third-party base64 library (e.g. `base64-js`) | The ~6-line `urlBase64ToUint8Array` helper (native `atob` + `Uint8Array.from`) | It's a well-known ~6-line function; pulling a dependency for it is unjustified given zero other base64 needs in the frontend |
| VAPID key fetching/caching | A custom fetch-and-memoize wrapper | `useQuery(['push','vapid-key'], ..., {staleTime: Infinity})` per D-12 | TanStack Query already provides exactly this caching semantic; a hand-rolled memo duplicates it |
| Permission-denied UX messaging | Per-browser unblock instructions (how to un-revoke a permission in Chrome vs Firefox vs Edge settings) | A single generic sentence: "Reminders are blocked in your browser settings" (D-11, explicit) | D-11 explicitly rejects this — browser-specific UI is out of the app's control and will rot |

**Key insight:** every "don't hand-roll" temptation in this phase is really
the same temptation restated — building a server-side or persisted proxy for
something the browser already exposes live and for free. Resist it; every
extra layer of caching here is a new place D-06's "never read on while
nothing can be delivered" invariant can break.

## Runtime State Inventory

Not applicable — this is not a rename/refactor/migration phase. No existing
column, key, or identifier is being renamed. (Two new response/request
fields are being *added* to an existing schema, which is additive, not a
rename.)

## Common Pitfalls

### Pitfall 1: Requesting permission without a user gesture

**What goes wrong:** Chrome (and other browsers) increasingly refuse or
silently auto-dismiss `Notification.requestPermission()` calls not made
inside a direct user-gesture handler (click), or apply an "abusive
notification permission" quality signal that quietly suppresses the
browser's own permission UI on domains that "over-ask." [ASSUMED — this is a
well-documented Chrome behavior from training knowledge; verify no material
change since cutoff]

**Why it happens:** Browsers actively fight the historical pattern of
sites spamming the permission prompt on page load.

**How to avoid:** Call `Notification.requestPermission()` synchronously
inside the onClick/onCheckedChange handler chain (an `await` before it in
the SAME handler invocation is fine — the gesture token survives one
microtask/short async hop in most browsers, but not a `setTimeout` or an
unrelated effect).

**Warning signs:** The permission dialog silently never appears; the
promise resolves to `'default'` (not `'denied'`) forever, which can be
mistaken for a user repeatedly dismissing it.

### Pitfall 2: `PushManager.subscribe()` throwing `AbortError` on Brave

**What goes wrong:** Brave's default privacy settings disable Google's push
service, so `pushManager.subscribe()` throws `AbortError` even with a valid
VAPID key and granted permission.

**Why it happens:** Chrome-family push delivery is routed through
`fcm.googleapis.com` by default; Brave blocks this unless "Use Google
services for push messaging" is explicitly enabled.

**How to avoid:** Per D-13 (locked, rejected the Brave-specific-copy
alternative), do NOT special-case `AbortError` in the UI. The generic
"Couldn't turn on reminders. Try again." error path already covers it. This
IS documented for the human running UAT: `.planning/STATE.md` line 33 flags
"Brave needs 'Use Google services for push messaging' enabled or
PushManager.subscribe() throws AbortError" [VERIFIED: .planning/STATE.md:33]
— the plan's UAT setup notes must carry this forward so the tester doesn't
misdiagnose a Brave-specific failure as a real bug.

**Warning signs:** `ensureDeviceSubscribed()` resolves to `{status:
'error'}` specifically and only on Brave, never on Chrome/Edge/Firefox with
the same code path.

### Pitfall 3: VAPID-key `useQuery` firing before the auth token is attached, or racing route mount

**What goes wrong:** If `GET /push/vapid-public-key` is queried
unconditionally at a high level (e.g. app shell) rather than scoped to where
it's needed, it either fires for logged-out/guest users unnecessarily
(D-10's premise is that guests are out of scope entirely — SEED-132 already
locked "guests out of scope") or fires before other Train data is ready,
producing an extra loading flicker on `TrainScoreScreen`.

**Why it happens:** `GET /push/vapid-public-key` is actually an
**unauthenticated** endpoint [VERIFIED: app/routers/push.py:95-104] `async
def vapid_public_key() -> VapidPublicKeyResponse:` has no
`Depends(current_active_user)` in its signature, unlike `subscribe`/
`unsubscribe`/`dev_trigger_reminder` which all take `user: Annotated[User,
Depends(current_active_user)]`. So it WILL succeed for a guest session too —
D-10's "guests out of scope" boundary must be enforced by where the query is
called (only inside `TrainScoreScreen`/`TrainScheduleSettings`, both of
which are already gated behind Train's import-gate/auth), not by the
endpoint itself.

**How to avoid:** Scope the `useQuery` call to exactly the two consuming
components (or a shared hook they both call), not a global app-level
provider, and rely on the existing Train-page auth/import gating to keep it
out of guest reach.

**Warning signs:** Sentry `tanstack-query` errors tagged with this query key
appearing for logged-out sessions.

### Pitfall 4: The debounce race D-09 already names

**What goes wrong:** If the permission request and the settings PUT fire in
parallel (rejected alternative in D-09), the PUT can land with
`reminder_enabled: true` before the permission/subscribe outcome is known,
leaving a server-side "enabled" account with zero live subscription — the
exact silent-lie state D-06 exists to prevent.

**Why it happens:** `TrainScheduleSettings`'s existing debounce fires on ANY
draft change 600ms after the last edit, independent of what triggered the
edit — if `reminderEnabled: true` were written into draft synchronously on
toggle click (matching the weekday-chip pattern), the debounce would fire
regardless of whether the async permission/subscribe flow has resolved.

**How to avoid:** Pattern 3 above — never write `reminderEnabled: true` into
`draft` until `ensureDeviceSubscribed()` resolves `'subscribed'`. This
means toggle-ON does NOT follow the exact same code path as the weekday
chips/puzzle-count (an intentional, documented exception per D-09, not a
bug to "fix into consistency").

### Pitfall 5: `noUncheckedIndexedAccess` and the `Notification.permission` union

**What goes wrong:** `Notification.permission` is typed
`NotificationPermission` (`'default' | 'denied' | 'granted'`), not indexed
access, so `noUncheckedIndexedAccess` doesn't directly bite here — but a
`Record<NotificationPermission, ...>` lookup table used for
D-11's per-state Settings row copy DOES trigger it (per CLAUDE.md's frontend
rule, every Record index returns `T | undefined`). Narrow before use, per
the existing project convention (`const val = arr[i]; if (val) {...}`).

**Warning signs:** `ty`/`tsc -b`... actually this is a **frontend** TS issue,
caught by `npm run build` (per CLAUDE.md's "run tsc -b before integrating
frontend" rule, not by `npm run lint`/`npm test` which don't type-check) —
run the full `npm run build` before considering this phase done, not just
lint+test.

## Code Examples

### Extending `TrainSettingsResponse`/`TrainSettingsUpdate` (frontend mirror)

```typescript
// Source: app/schemas/train.py:198-230 [VERIFIED]
// "response for GET/PUT /train/settings" + "reminder_enabled/reminder_hour
// (Phase 201, REMIND-01/D-18) are the user-owned reminder configuration"
export interface TrainSettingsResponse {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
  reminder_enabled: boolean; // NEW — matches backend `reminder_enabled: bool`
  reminder_hour: int;         // NEW — matches backend `reminder_hour: int` (0-23)
}

export interface TrainSettingsUpdate {
  timezone: string;
  weekday_mask: number;
  puzzles_per_session: number;
  reminder_enabled: boolean; // NEW
  reminder_hour: number;      // NEW — CHECK bound 0..23
}
```
Exact backend field names/types verified: [VERIFIED: app/schemas/train.py:208-230]
`timezone: str; weekday_mask: int; puzzles_per_session: int; reminder_enabled:
bool; reminder_hour: int` (Response) and
`reminder_hour: int = Field(ge=REMINDER_HOUR_MIN, le=REMINDER_HOUR_MAX)`
(Update), where `REMINDER_HOUR_MIN: int = 0` and `REMINDER_HOUR_MAX: int =
23` [VERIFIED: app/services/train_scheduler.py:99-100].

**Gotcha:** `TrainSettingsUpdate` is a **full-replace PUT body**
[VERIFIED: frontend/src/hooks/useTrainSettings.ts:39-46] — the current
`mutationFn` builds the body from exactly `{timezone, weekday_mask,
puzzles_per_session}`. Since it's full-replace (not a PATCH), **every** call
site of `trainApi.updateSettings` must now also send `reminder_enabled` and
`reminder_hour`, or the backend's required (non-Optional) Pydantic fields
will 422. There is currently exactly one call site
(`useTrainSettings.ts`'s `mutation`), so this is a single-point fix, but the
plan must explicitly task it — a naive additive-only patch of just the two
new pickers would break the existing weekday/puzzle-count save path with a
422 the moment this schema change lands, unless the draft state and PUT body
are extended together in the same commit.

### New `pushApi` client group (extends `frontend/src/api/client.ts`, mirrors `trainApi`)

```typescript
// Pattern source: frontend/src/api/client.ts:264-279 [VERIFIED] (trainApi group shape)
export const pushApi = {
  getVapidPublicKey: () =>
    apiClient.get<VapidPublicKeyResponse>('/push/vapid-public-key').then(r => r.data),
  subscribe: (data: PushSubscribeRequest) =>
    apiClient.post<PushSubscribeResponse>('/push/subscribe', data).then(r => r.data),
  unsubscribe: (endpoint: string) =>
    apiClient.post('/push/unsubscribe', { endpoint }),
};
```
Backend response shapes: [VERIFIED: app/schemas/push.py:40-49]
`class PushSubscribeResponse(BaseModel): subscription_id: int` and
`class VapidPublicKeyResponse(BaseModel): application_server_key: str`.
Backend status codes: [VERIFIED: app/routers/push.py:39,71,95]
subscribe → `status_code=201`, unsubscribe → `status_code=204`,
vapid-public-key → default 200 / `HTTPException(status_code=404, ...)` when
unconfigured, subscribe → `HTTPException(status_code=503, ...)` when
unconfigured.

### The existing debounce-save contract to extend (verbatim, current shape)

```typescript
// Source: frontend/src/components/train/TrainScheduleSettings.tsx:172-194 [VERIFIED]
useEffect(() => {
  if (!hasEditedRef.current || debouncedDraft === null || data === undefined) return;
  if (
    debouncedDraft.weekdayMask === data.weekday_mask &&
    debouncedDraft.puzzlesPerSession === data.puzzles_per_session
  ) {
    return;
  }
  save(
    { weekdayMask: debouncedDraft.weekdayMask, puzzlesPerSession: debouncedDraft.puzzlesPerSession },
    {
      onSuccess: () => { setIndicator('saved'); /* ...timeout reset... */ onSaved?.(); },
      onError: () => { setIndicator('error'); },
    },
  );
}, [debouncedDraft, data, save, onSaved]);
```
This is the exact "no-op re-save" guard and `Draft`/`hasEditedRef`/
`IndicatorState` machine D-09 says to extend with two more fields
(`reminderEnabled`, `reminderHour`) and two more no-op comparisons, with the
carve-out that toggle-ON does not write into `draft` synchronously (Pattern
3 above).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| A dismissible pre-prompt card with once-ever "seen" localStorage flag (the phase's original design premise, per SEED-132) | A persistent, always-visible-when-relevant "Remind me" button whose visibility is derived from live browser state (D-01) | This discussion (2026-08-02, CONTEXT.md D-01) | Eliminates an entire state machine (`useUserFlag`, dismissal bookkeeping, re-ask timers) — self-correcting by construction |

**Deprecated/outdated:** N/A — no external library or API version is being
deprecated in this phase; the Web Push API itself (Push API + Notifications
API + VAPID) has been broadly stable since Safari 16.4 added support in
2023, with no material breaking changes reported since.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Chrome enforces `requestPermission()` inside a direct user-gesture handler (and applies "abusive permission request" heuristics to sites that over-ask outside a gesture) | Common Pitfalls, Pitfall 1 | Low — D-02 already mandates gesture-triggered calling for other reasons (UX intent, not just browser enforcement), so the code shape is correct regardless; if the browser enforcement detail is stale, no plan change is needed, only the *explanation* would be imprecise |
| A2 | The exact byte-for-byte body of the `urlBase64ToUint8Array` helper (padding + `-`/`_` replace + `atob` + `Uint8Array.from`) matches the canonical web.dev/MDN implementation precisely as written in the Code Examples section | Architecture Patterns, Pattern 1 | Low-Medium — this is a pure, unit-testable function; a subtle bug (e.g. wrong padding modulus) fails loudly at `pushManager.subscribe()` time (throws `InvalidAccessError` on a malformed key), not silently. CONTEXT.md's Claude's Discretion list explicitly calls out unit-testing this conversion — doing so closes this gap before it reaches a human |
| A3 | `Notification.permission === 'denied'` cannot be programmatically reset by the site (only by the user via browser chrome), i.e. it is genuinely permanent from the app's perspective | Domain framing throughout (D-02, D-11, REQUIREMENTS.md "one-shot, non-renewable resource" premise) | Low — this is the entire premise the milestone's REQUIREMENTS.md states as already-settled ("Notification permission is a one-shot, non-renewable resource. Chrome and Safari both hard-block re-prompting after a browser-level deny, with no in-app recovery"); re-derived here only for completeness, not newly asserted |

**If this table is empty:** N/A — see above; risk on all three is low given
D-02/D-13/CONTEXT.md's Claude's-Discretion list already anticipate and
mitigate them.

## Open Questions

1. **Does `registration.pushManager.getSubscription()` require
   `navigator.serviceWorker.ready` to have resolved, or can it be called
   directly off a `getRegistration()` result (as `main.tsx` already does)?**
   - What we know: `main.tsx`'s existing pattern uses
     `getRegistration()` (returns `undefined` if no SW is yet registered/
     controlling, does not wait) [VERIFIED: frontend/src/main.tsx:38].
     `navigator.serviceWorker.ready` instead waits until a SW is active and
     controlling the page, which is what `web.dev`'s subscribe guide uses.
   - What's unclear: on first-ever page load with `VitePWA({registerType:
     'autoUpdate', devOptions: {enabled: true}})`, whether the SW is already
     "ready" by the time the user reaches `TrainScoreScreen` (several
     navigations deep into an existing session) — very likely yes in
     practice, but not verified this session.
   - Recommendation: use `navigator.serviceWorker.ready` (not
     `getRegistration()`) inside `ensureDeviceSubscribed()` — it's the
     purpose-built promise for exactly this "wait for an active SW" need,
     and by the time a user reaches the score screen they've already loaded
     the app shell, so the wait should resolve near-instantly. Confirm with
     a live-browser UAT step (already implied by CONTEXT.md's canonical
     refs pointing at real Chrome-on-Linux testing precedent from Phase
     201).

2. **Exact wording/UX for D-11's disabled Settings row when
   `Notification.permission === 'denied'`.**
   - What we know: D-11 mandates showing a disabled row with the cause
     stated as "Reminders are blocked in your browser settings" (verbatim
     example in CONTEXT.md), no per-browser instructions.
   - What's unclear: whether the master toggle itself renders `disabled`
     (Radix `Switch` `disabled` prop) with that string beside it, or the
     whole reminder block collapses to a single-line disabled state (the
     hour picker's visibility in this state is explicitly listed under
     Claude's Discretion).
   - Recommendation: render the `Switch` `disabled` (locked in the off
     position, cannot be toggled) with the cause string in the same visual
     slot the "Saved"/"Couldn't save" indicator uses, and hide the hour
     picker entirely in this state (an hour choice is meaningless when
     nothing can be delivered) — consistent with "the hour picker is hidden
     or disabled when the master toggle is off" being Claude's discretion,
     resolved here toward hidden for the stronger denied-state case.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| VAPID keypair in dev `.env` | `GET /push/vapid-public-key` returning 200 (not 404) | ✓ (verified this session: `curl localhost:8000/api/push/vapid-public-key` → `200 {"application_server_key":"BNPGz..."}`) | — | N/A — already configured on this machine. **Do not assume this for a fresh clone** — D-12 explicitly documents the fresh-machine default as 404-until-`scripts/gen_vapid_keys.py` is run; the plan's UAT setup notes must still state this for reproducibility on other machines |
| PostgreSQL dev DB | Backend for `/push/*`, `/train/settings` | ✓ (`docker compose ... ps` shows `flawchess-dev-db-1` healthy) | postgres:18-alpine | — |
| Live browser (Chrome/Edge/Firefox desktop or Android Chrome) for UAT | Real end-to-end permission/subscribe/delivery testing | Not verified in this session (CLI-only environment) | — | The `POST /push/dev/trigger-reminder` dev-only endpoint (already shipped, Phase 201 D-17) is the lever for triggering delivery without waiting for the scheduler's clock hour — usable once a real browser subscribes |
| Brave-specific push toggle ("Use Google services for push messaging") | UAT coverage of the D-13 error path in a non-Chrome/Firefox browser | Operator-dependent, documented in `.planning/STATE.md:33` [VERIFIED] | — | Not a blocker — the generic error path (D-13) already covers it without special-casing |

**Missing dependencies with no fallback:** none identified.

**Missing dependencies with fallback:** live-browser UAT tooling not
verifiable from this CLI research session — covered by the existing
`POST /push/dev/trigger-reminder` dev lever and the precedent Phase 201 UAT
already established (real Chrome-on-Linux delivery, per `.planning/STATE.md`
Phase 201 close note).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (`frontend/vite.config.ts` has no separate `test:` block visible, but `frontend/package.json`'s `"test": "vitest run"` confirms Vitest; existing suite uses `@vitest-environment jsdom` pragma per-file [VERIFIED: frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts:1]) |
| Config file | `frontend/vite.config.ts` (no dedicated `vitest.config.*` found this session) |
| Quick run command | `cd frontend && npx vitest run src/lib/__tests__/push.test.ts` (once created) |
| Full suite command | `cd frontend && npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PERM-01 | "Remind me" button click → `Notification.requestPermission()` called exactly once, only on click (never on mount) | unit (RTL + `vi.stubGlobal('Notification', ...)`) | `npx vitest run src/components/train/__tests__/TrainScoreScreen.test.tsx` | ❌ Wave 0 — component test exists (per D-04's variant swap, must extend or verify current `TrainScoreScreen.test.tsx` if present) |
| PERM-01 | `ensureDeviceSubscribed()` never calls `pushManager.subscribe()` unless permission is or becomes `'granted'` | unit | `npx vitest run src/lib/__tests__/push.test.ts` | ❌ Wave 0 — new module, new test file |
| PERM-02 | Declining (or `'denied'`) leaves the button re-showable on next mount / next score screen, no persisted "declined" flag written anywhere (grep-based negative assertion: no new `localStorage.setItem` call in the reminder code path) | unit + a repo-wide negative grep assertion in the test (`expect(localStorage.setItem).not.toHaveBeenCalled()` scoped to the button's handler) | `npx vitest run src/components/train/__tests__/TrainScoreScreen.test.tsx` | ❌ Wave 0 |
| PERM-03 | Toggle + hour `Select` render in `TrainScheduleSettings`, hour change debounces into one `PUT /train/settings` with `reminder_hour` set, matching the existing weekday-chip debounce test pattern | unit | `npx vitest run src/components/train/__tests__/TrainScheduleSettings.test.tsx` | ❌ Wave 0 — extend or verify the existing file (a `TrainScheduleSettings.test.tsx` was not directly read this session; confirm at plan/Wave-0 time whether one already exists to extend vs. create) |
| PERM-04 | Toggling OFF sends `PUT /train/settings {reminder_enabled: false, ...}` and does NOT call `pushApi.unsubscribe` / does NOT touch `PushSubscription.unsubscribe()` (negative assertion — mock `unsubscribe` as a spy, assert never called) | unit | `npx vitest run src/components/train/__tests__/TrainScheduleSettings.test.tsx` | ❌ Wave 0 |
| PERM-04 | Backend: `reminder_enabled=false` + existing subscription row → scheduler still gates correctly (already covered by Phase 201's REMIND-04/REMIND-05 tests — no NEW backend test needed since PUSH-04/REMIND coverage is untouched this phase) | integration (existing, backend) | `uv run pytest tests/test_train_reminder_service.py -x` (exact filename unverified this session — confirm at plan time) | ✅ (Phase 201, presumed complete — verify path exists) |

### Sampling Rate

- **Per task commit:** `cd frontend && npx vitest run <changed-test-file>`
  (targeted); backend has no changes this phase so no `pytest` re-run is
  needed per-commit unless a plan task unexpectedly touches
  `app/schemas/train.py` beyond the two new response fields (it will —
  see the Code Examples full-replace-PUT gotcha — so backend field-addition
  tests DO need a scoped `pytest` run: `uv run pytest tests/test_train_router.py -x`
  filename unverified, confirm path at plan time).
- **Per wave merge:** `cd frontend && npm run lint && npm test -- --run`
  plus `npm run build` (per CLAUDE.md's explicit "tsc -b" rule — `npm
  test`/`npm run lint` do not type-check since esbuild strips types).
- **Phase gate:** Full pre-merge gate per CLAUDE.md (`ruff format/check`,
  `ty check`, `pytest -n auto -x`, frontend lint+test+**build**) before
  squash-merging to `main`. This phase's backend touch is schema-only
  (`app/schemas/train.py` +2 fields, no migration since the columns already
  exist per Phase 201/REMIND-01) — `ty check` and a scoped `pytest` pass are
  still mandatory, not optional, because Pydantic field additions to a
  full-replace-body schema can break existing tests that construct
  `TrainSettingsUpdate`/`TrainSettingsResponse` without the two now-required
  fields.

### Wave 0 Gaps

- [ ] `frontend/src/lib/__tests__/push.test.ts` — new file, covers
  `urlBase64ToUint8Array` (pure unit test, Claude's Discretion item
  explicitly names this as worth its own test) and
  `ensureDeviceSubscribed()`'s branch matrix (unsupported / denied /
  default→granted / default→denied / already-subscribed / subscribe-throws
  / POST-fails) — covers PERM-01/PERM-02.
- [ ] Confirm whether `frontend/src/components/train/__tests__/
  TrainScheduleSettings.test.tsx` and a `TrainScoreScreen.test.tsx`
  already exist (both components have substantial existing behavior from
  Phases 190-193 — very likely already tested) — this research session did
  not enumerate the `__tests__/` directory contents; the plan's Wave 0 must
  do this check before deciding "extend" vs. "create."
- [ ] Backend: confirm the exact test file(s) covering
  `TrainSettingsResponse`/`TrainSettingsUpdate` construction
  (`tests/test_train_router.py` or similar — filename not verified this
  session) so the plan can task updating existing test fixtures that build
  these Pydantic models without the two reminder fields (they will now
  422/fail validation without `reminder_enabled`/`reminder_hour`, unless
  Phase 201 already added them there — check first, since REMIND-01 shipped
  the columns already, it's plausible Phase 201's own tests already build
  full 5-field objects).
- [ ] `vi.stubGlobal('Notification', {...})` and
  `Object.defineProperty(navigator, 'serviceWorker', {...})` mock
  scaffolding — no existing test in this repo mocks `Notification` or
  `PushManager` (grepped this session, zero hits outside `pushServiceWorker.
  test.ts` which tests the SW file itself via `node:vm`, a different
  mechanism entirely). This is new test infrastructure, not a reuse of an
  existing mock. The established `vi.stubGlobal('Worker', ...)` pattern
  in `useTrainGradingEngine.test.ts` [VERIFIED:
  frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts:71-76] is the
  closest precedent to follow (stub the constructor/object on the global,
  `vi.unstubAllGlobals()` in `afterEach`).

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No new surface | `pushApi.subscribe`/`unsubscribe` ride the existing `apiClient` Bearer-token interceptor [VERIFIED: frontend/src/api/client.ts:59-63], unchanged |
| V3 Session Management | No | Unchanged — no new session concept |
| V4 Access Control | Yes (backend, already shipped) | Every push endpoint scopes to `current_active_user.id`, never a client-supplied `user_id` [VERIFIED: app/routers/push.py:1-10 docstring] "Every handler scopes to `current_active_user.id` — never a client-supplied `user_id`" — this phase adds no new backend endpoints, so no new IDOR surface |
| V5 Input Validation | Yes | `reminder_hour` bounds (0-23) already enforced server-side via Pydantic `Field(ge=REMINDER_HOUR_MIN, le=REMINDER_HOUR_MAX)` [VERIFIED: app/schemas/train.py:230]; the frontend `Select` should still only offer 0-23 as options (defense in depth, not a security boundary since the server is authoritative) |
| V6 Cryptography | No new surface this phase | VAPID signing is entirely server-side (Phase 201, unchanged); the frontend only *receives* the public key string and passes it verbatim into `urlBase64ToUint8Array()` → `subscribe()` — no crypto operations happen in this phase's new code |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A malicious page in another tab triggering `PushManager.subscribe()` on behalf of the user via a leaked/guessable applicationServerKey | Spoofing | Not applicable here — `applicationServerKey` (the VAPID public key) is intentionally public (it's returned by an unauthenticated `GET /push/vapid-public-key` endpoint by design, per D-03/D-12); the actual authorization boundary is `POST /push/subscribe` requiring a valid Bearer token, which an attacker's page cannot forge without the user's token |
| Toggle-OFF client bug that accidentally calls `POST /push/unsubscribe` instead of just the settings PUT (violating D-07) | Tampering (of user's stated intent, not literally a security bug, but a functional-integrity regression named explicitly in CONTEXT.md D-07) | Covered by the PERM-04 negative-assertion test above (spy on `pushApi.unsubscribe`, assert never called from the toggle-off path) |
| SSRF via a forged non-https `endpoint` in the subscribe body | Tampering / SSRF | Already mitigated server-side (Phase 201): [VERIFIED: app/schemas/push.py:25-31] `@field_validator("endpoint") ... if value.scheme != "https": raise ValueError("endpoint must use https")` — this phase's frontend code always sends a real browser-generated `PushSubscription.endpoint`, which is always `https://` by construction of the Push API itself, so this validator is a defense-in-depth backstop, not something the frontend needs to duplicate |

## Sources

### Primary (HIGH confidence)
- Direct file reads this session (see inline `[VERIFIED: path:lines]` tags
  throughout): `frontend/src/components/train/TrainScheduleSettings.tsx`,
  `frontend/src/hooks/useTrainSettings.ts`, `frontend/src/types/train.ts`,
  `frontend/src/components/train/TrainScoreScreen.tsx`,
  `app/routers/push.py`, `app/schemas/push.py`, `app/schemas/train.py`,
  `app/services/train_scheduler.py`, `frontend/src/main.tsx`,
  `frontend/src/api/client.ts`, `frontend/public/push-sw.js`,
  `frontend/vite.config.ts`, `frontend/src/hooks/useInstallPrompt.ts`,
  `frontend/src/components/ui/select.tsx`, `frontend/src/components/ui/switch.tsx`,
  `frontend/src/lib/queryClient.ts`, `frontend/src/__tests__/pushServiceWorker.test.ts`,
  `frontend/src/hooks/__tests__/useTrainGradingEngine.test.ts`,
  `.planning/phases/202-reminder-permission-ux/202-CONTEXT.md`,
  `.planning/REQUIREMENTS.md`, `.planning/STATE.md`.
- [web.dev/articles/push-notifications-subscribing-a-user](https://web.dev/articles/push-notifications-subscribing-a-user) — `PushManager.subscribe()` call shape, `userVisibleOnly` requirement, `getSubscription()` resubscription-check pattern.

### Secondary (MEDIUM confidence)
- [MDN Web Docs: PushManager.subscribe()](https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe) — surfaced via WebSearch, not directly fetched this session; general Push API mechanics consistent with training knowledge and the web.dev fetch.

### Tertiary (LOW confidence)
- Chrome's user-gesture / "abusive notification permission" enforcement
  detail (Pitfall 1, Assumption A1) — training-knowledge claim, not
  re-verified against current Chrome documentation this session.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every capability is a native browser API already
  proven working end-to-end in this exact repo (Phase 201's real
  Chrome-on-Linux UAT delivered a push notification); zero new packages to
  vet.
- Architecture: HIGH — grounded directly in read source for both the
  existing components being extended and the already-shipped backend
  contract; the one genuinely new piece (`ensureDeviceSubscribed()`) is
  fully specified by CONTEXT.md's D-06/D-09/D-13.
- Pitfalls: MEDIUM-HIGH — most pitfalls are drawn from locked CONTEXT.md
  decisions (Brave AbortError, the full-replace-PUT 422 gotcha) which are
  HIGH confidence; the browser-gesture-enforcement pitfall is explicitly
  flagged LOW/ASSUMED.

**Research date:** 2026-08-02
**Valid until:** 30 days (stable native Web APIs + an internal codebase
that doesn't change out from under this research faster than a typical
phase turnaround; re-verify file line numbers if this research is consumed
significantly later than its date)
