# Phase 202: Reminder Permission UX - Context

**Gathered:** 2026-08-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Frontend-only. Phase 201 shipped the entire server surface this phase consumes:
`POST /push/subscribe`, `POST /push/unsubscribe`, `GET /push/vapid-public-key`,
`POST /push/dev/trigger-reminder`, and `reminder_enabled` / `reminder_hour`
already round-tripping through `GET`/`PUT /train/settings` (201 D-18). **No
backend work belongs in this phase.**

In scope:

1. The browser-side subscription path that does not exist today — service
   worker registration handle, `PushManager.subscribe()` with the server's
   VAPID application server key, and `POST /push/subscribe` with the resulting
   `PushSubscriptionJSON`. There is currently **zero** push code anywhere in
   `frontend/src` (verified: no `pushManager` reference outside `main.tsx`'s
   unrelated SW-update logic).
2. The opt-in surface on `TrainScoreScreen` (PERM-01, PERM-02).
3. The master toggle + hour picker in `TrainScheduleSettings` (PERM-03,
   PERM-04), including extending `TrainSettingsResponse` / `TrainSettingsUpdate`
   in `frontend/src/types/train.ts` and `useTrainSettings`'s full-replace PUT
   body, neither of which carries the reminder fields yet.

Out of scope: anything server-side; notification content and delivery (settled
in 201 D-10/D-11/D-14); SEED-132 Phase B (install promotion, desktop→phone QR
handoff, Android `beforeinstallprompt`, the iOS install-then-permission path),
deferred on a BrowserStack dependency the operator does not have.

Requirements: PERM-01..04 (see `.planning/REQUIREMENTS.md`).

</domain>

<decisions>
## Implementation Decisions

SEED-132 already locked: ask on the score screen after a completed session
(decision 11), `TrainScheduleSettings` as the permanent fallback surface
(decision 12), the master toggle outranking the hour picker (decision 9),
asking on Train landing or at import completion rejected (decision 13), and
guests out of scope. Those are NOT restated as decisions here — read the seed.
The decisions below are what this discussion resolved on top of it.

### The score-screen opt-in surface

- **D-01:** **A persistent secondary "Remind me" button beside Done — not a
  one-shot card and not a modal.** It renders on every score screen for as
  long as this device is not reachable, and disappears once it is. This
  replaces the pre-prompt-with-dismissal-state design the phase started from:
  the once-ever flag, the `useUserFlag` bookkeeping, and the "never re-ask
  after Not now" rule all collapse, because visibility is **derived from live
  state** (is this device subscribed?) rather than from persisted history.
  Self-correcting, and it cannot drift out of sync with reality.
  Rejected: an inline `Card` below the score badge (carries a value
  proposition the bare button loses, but needs the whole seen/declined state
  machine), and a `Dialog` modal (interrupts the confetti/score moment the
  screen was designed around; makes "Not now" feel like dismissing an
  obstacle rather than declining an offer).

- **D-02:** **Pressing "Remind me" goes straight to
  `Notification.requestPermission()`.** The deliberate button press *is* the
  pre-prompt — it is the in-app action that gates the one-shot browser API, so
  a second in-app confirmation would be a speed bump, not a safeguard.
  **This is a deliberate, recorded deviation from PERM-01 / ROADMAP SC1's
  literal "custom in-app pre-prompt with Yes / Not now" wording.** The
  requirement's *intent* — never let the browser prompt fire without explicit
  user intent — is satisfied at least as well by a button as by a card, and
  arguably better. The planner must not "restore" a Yes/Not-now step.
  Accepted cost: a bare button carries no pitch, so conversion is likely lower
  than a card with a sentence of copy. Mitigated by the label/icon only.
  Rejected: button → small explainer with Yes/Not now (preserves the literal
  wording, costs an extra tap and disclosure UI), and button + permanent
  caption under the row (adds standing text to a screen that currently ends
  cleanly on Done).

- **D-03:** **On a successful grant + subscribe, the button swaps in place to
  an inline confirmation naming the hour** — e.g. "Reminders on — 18:00 on
  your training days". The user just spent a non-renewable permission;
  silently vanishing the button acknowledges nothing, and naming the hour is
  the thread they pull if 18:00 is wrong. Reuse the `Check` icon + muted-text
  treatment `TrainScheduleSettings`'s "Saved" indicator already uses.
  Rejected: silent disappearance, and a sonner toast (easy to miss right after
  the confetti burst; the screen uses no toasts today).

- **D-04:** **Button hierarchy: Done is promoted to primary
  (`variant="default"`) and moves to the RIGHT of the row; "Remind me" is
  `brand-outline` on the left.** User's explicit call.
  **This overrides an existing documented decision**: `TrainScoreScreen.tsx`
  (props docstring, ~L81-87) records Done as deliberately `brand-outline` per
  SEED-122 — "it is an exit, not a call to action". That rationale held when
  Done was alone on the screen; it does not once it shares a row. The planner
  must apply this override, not restore the old variant.

- **D-05:** **Visibility is per-device, and the button appears on each new
  device.** A user who enabled reminders on their phone still sees the button
  on their desktop, because `push_subscriptions` rows are per-device-per-browser
  and 201 D-05 fans out to **all** live subscriptions — an unsubscribed desktop
  can never be reached, so offering it there is a genuine offer, not a repeat.
  Note the asymmetry this creates and that it is intended: `reminder_enabled`
  is account-wide, subscriptions are per-device.

### Settings: toggle semantics & subscription lifecycle

- **D-06:** **Toggling the master switch ON when `Notification.permission` is
  `'default'` fires the browser prompt, via the same shared "ensure this device
  is subscribed" routine the score-screen button calls.** One code path, two
  entry points. If the user then denies at the browser level, **the toggle
  springs back off** and the row states why — the toggle must never read on
  while nothing can be delivered.
  Rejected: a toggle that writes only `reminder_enabled` with a separate
  "Enable on this device" control (honest about the two-layer model, but two
  controls where users expect one), and a toggle disabled until the device is
  subscribed (dead-end UI, and PERM-03 wants Settings to be the recovery path).

- **D-07:** **Toggling OFF flips `reminder_enabled` to false and KEEPS the
  `push_subscriptions` row.** PERM-04 verbatim: silence reminders inside
  FlawChess without touching the browser grant, so turning it back on later is
  instant and the user stays reachable. The 201 scheduler already gates on
  `reminder_enabled` before fan-out, so nothing is sent regardless. Accepted
  cost: a dormant row lingers until it 410s, which PUSH-02's prune sweep
  already handles.
  Rejected: calling `POST /push/unsubscribe` on toggle-off (clean data, but
  re-enabling then needs a fresh `PushManager.subscribe()` and, on a reset
  browser, a second trip through the one-shot permission — exactly what
  PERM-04 exists to prevent), and calling `PushSubscription.unsubscribe()`
  browser-side while keeping the row (leaves a stored endpoint that is a lie).

- **D-08:** **The hour picker is a Radix `Select` (`ui/select.tsx`) with all 24
  hours**, local-time labels, mapping 1:1 to `reminder_hour` (backend CHECK
  0..23). One line of vertical space, works at 375px, and never forces a user
  into a wrong hour — which SEED-132 decision 7 names as the exact thing that
  makes someone revoke a permission that cannot be re-requested.
  Rejected: a preset chip set (e.g. 9/12/18/21 — visually consistent with the
  weekday chips above it, but reintroduces the fixed-hour-lands-wrong problem),
  and a native `<select>` (would be the app's only one).

- **D-09:** **Hour changes and toggle-OFF ride the existing 600ms debounced
  draft in `TrainScheduleSettings`** — one `PUT /train/settings`, the existing
  "Saved" / "Couldn't save. Try again." indicator, identical to the weekday
  chips (PERM-03's "same auto-saving behavior"). **Toggle-ON is the one
  asynchronous exception**: request permission → `POST /push/subscribe` → only
  on success set `reminder_enabled` in the draft. A denial or a failed
  subscribe never writes `true`, so server state stays honest.
  Rejected: an immediate non-debounced save for the toggle (two save paths and
  two drivers for one indicator), and firing the permission request in parallel
  with the debounced PUT (the PUT can land before the prompt resolves, leaving
  `reminder_enabled = true` with no subscription — the silent-lie state D-06
  rules out).

### Unsupported & blocked states

- **D-10:** **Push genuinely unsupported → hide BOTH surfaces entirely.** No
  score-screen button, no toggle row in `TrainScheduleSettings`. Feature-detect
  `'serviceWorker' in navigator && 'PushManager' in window`. This covers iOS
  Safari outside standalone, where the Push API simply is not exposed.
  Accepted, known gap: an iPhone user sees no hint the feature exists — which
  is precisely what SEED-132 Phase B is deferred to build, so it stays a clean
  gap rather than a half-answer promising a path that does not exist yet.
  Rejected: keeping an explanatory Settings row with per-platform copy (comes
  close to promising the unbuilt Phase B iOS flow).

- **D-11:** **`Notification.permission === 'denied'` → hide the score-screen
  button, but show a DISABLED row in `TrainScheduleSettings` naming the cause.**
  Asymmetric on purpose: the score screen must not carry a provably dead
  button, while Settings is where a user goes to ask "why don't I get
  reminders?" and is the only place that question can be answered. State the
  cause only ("Reminders are blocked in your browser settings") — do **not**
  ship per-browser un-block instructions; that path is browser-specific and
  outside our reach.
  Rejected: hiding both (one code path, but the user who denied months ago
  concludes the feature is broken), and showing both and explaining on press
  (teaches the user the button is a dead end, once per score screen, forever).

- **D-12:** **VAPID-unconfigured is detected by querying the key up front, and
  a 404 hides both surfaces exactly like D-10.** A TanStack `useQuery` on
  `GET /push/vapid-public-key` with `staleTime: Infinity`, resolved before
  either surface renders. The key is needed for `PushManager.subscribe()`
  anyway, so it is not a wasted request. **This is the default state on a fresh
  dev machine and in CI** (201 D-03: unset keys → key endpoint 404s, subscribe
  503s), so a developer sees no reminder UI until `scripts/gen_vapid_keys.py`
  output is in their `.env` — that is intended and must be stated in the plan's
  UAT setup, not discovered.
  Rejected: lazy fetch on press (a visible button on a machine where it cannot
  work; failure lands after the user commits), and a Vite build-time env flag
  (frontend and backend config can silently disagree, and the backend already
  holds the authoritative answer).

- **D-13:** **Grant succeeded but `PushManager.subscribe()` threw or
  `POST /push/subscribe` failed → inline error in place, permission spent,
  `reminder_enabled` never written true.** Score screen: the button becomes
  "Couldn't turn on reminders. Try again." and stays pressable. Settings: the
  toggle springs back off with the same message, mirroring the component's
  existing "Couldn't save. Try again." indicator. Sentry capture comes free via
  the global `MutationCache.onError` in `frontend/src/lib/queryClient.ts` if the
  call goes through TanStack — per CLAUDE.md, do **not** add a duplicate
  `Sentry.captureException` there.
  Rejected: special-casing Brave's `AbortError` with "enable Google push
  services" copy (helpful when it fires, but it is error-name sniffing, the
  guidance is Brave-specific and will rot, and `AbortError` has other causes),
  and a generic toast leaving the control unchanged.

### Claude's Discretion

- Whether the hour picker is hidden or disabled when the master toggle is off.
- Exact copy and icon for the "Remind me" button (a bell icon was floated, not
  locked) and for the D-03 confirmation line.
- Where the shared "ensure this device is subscribed" routine lives (a hook vs.
  a `lib/` module) and how it obtains the service worker registration — this
  was explicitly noted as unasked and left open.
- Whether the score-screen surface warrants its own component file or stays
  inline in `TrainScoreScreen.tsx`.
- Test strategy for `PushManager` / `Notification.permission` under jsdom, and
  whether the base64url → `Uint8Array` VAPID key conversion gets its own unit
  test.
- Placement of the toggle + hour picker within the existing "Train schedule"
  card, relative to the weekday chips and puzzles-per-session group.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/SEED-132-train-push-notifications-and-pwa-install-promotion.md` —
  the locked decisions this phase implements. Section D (Permission UX,
  decisions 11-13) and decision 9 (the toggle outranks the hour picker) are
  the directly load-bearing ones; section F explains why Phase B is absent.
  Read this first; the decisions above layer on top of it.
- `.planning/ROADMAP.md` § "Phase 202: Reminder Permission UX" — goal and the
  four success criteria. Note SC1's literal "Yes / Not now" wording, which
  **D-02 deliberately deviates from**.
- `.planning/REQUIREMENTS.md` — PERM-01..04 verbatim, plus the "Notification
  permission is a one-shot, non-renewable resource" framing note that motivates
  the entire design.

### Prior phase (the backend this phase consumes)
- `.planning/phases/201-push-infrastructure-train-reminders/201-CONTEXT.md` —
  in particular D-03 (unset VAPID keys = graceful disable; the state every dev
  machine is in), D-05 (fan-out to all live subscriptions, which is why D-05
  above asks per-device), D-13 (`notificationclick` focus-or-open), and D-18
  (`reminder_enabled` / `reminder_hour` already exposed through
  `GET`/`PUT /train/settings`, so no backend work belongs here).
- `app/routers/push.py` — the four endpoints and their exact status codes:
  subscribe 201 / 503-when-unconfigured, unsubscribe 204, vapid-public-key
  200 / 404-when-unconfigured, dev trigger (development-only).
- `app/schemas/push.py` — `PushSubscribeRequest` is the raw
  `PushSubscriptionJSON` shape (`endpoint` + `keys.p256dh` + `keys.auth`) and
  **rejects non-https endpoints**; `VapidPublicKeyResponse.application_server_key`.
- `app/schemas/train.py` (~L195-235) — the `reminder_enabled` / `reminder_hour`
  fields and their bounds on the settings request/response schemas.

### Project constraints
- `CLAUDE.md` § Frontend → Browser Automation Rules — `data-testid` on every
  interactive element (`btn-*`, `filter-*`), `aria-label` on icon-only buttons,
  semantic `<button>`.
- `CLAUDE.md` § Frontend → Code Style & Safety — `noUncheckedIndexedAccess`,
  minimum font size `text-sm`, theme constants in `lib/theme.ts`, knip in CI.
- `CLAUDE.md` § Frontend → UI & Components — primary = `variant="default"`,
  secondary = `variant="brand-outline"` (never `variant="secondary"`); apply
  every change to the mobile layout too.
- `CLAUDE.md` § Error Handling & Sentry → Frontend Rules — the global
  `MutationCache.onError` already captures TanStack errors exactly once; do not
  double-capture (D-13).
- `.planning/STATE.md` — the two operational notes recorded for this phase: the
  API is Bearer-token auth (`localStorage.auth_token`), not cookies; and Brave
  needs "Use Google services for push messaging" enabled or
  `PushManager.subscribe()` throws `AbortError` (relevant to D-13 and to UAT).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `frontend/src/components/ui/select.tsx` — the Radix Select D-08 uses for the
  hour picker. Already present; used elsewhere in the app.
- `frontend/src/components/ui/switch.tsx` — the master toggle primitive.
  Existing call sites: `pages/Analysis.tsx`, `components/analysis/MaiaHumanPanel.tsx`.
- `frontend/src/components/train/TrainScheduleSettings.tsx` — the whole
  auto-save machine D-09 extends: `Draft` state, `useDebounce` at
  `TRAIN_SETTINGS_SAVE_DEBOUNCE_MS` (600), the `hasEditedRef` mount guard that
  stops the seed effect from firing a save, `IndicatorState`
  (`idle`/`saved`/`error`), and the `Check`-icon "Saved" span in the card
  header — the exact treatment D-03 and D-13 mirror.
- `frontend/src/hooks/useTrainSettings.ts` — `TRAIN_SETTINGS_QUERY_KEY`, the
  `save` mutation, and its `queryClient.setQueryData` + progress invalidation.
  Note it captures the IANA timezone at call time; the reminder fields must
  join `TrainSettingsDraft` and the PUT body.
- `frontend/src/hooks/useInstallPrompt.ts` — precedent for browser/platform
  feature detection (`isIOS`, `isStandalone`, `matchMedia('(display-mode:
  standalone)')`) that D-10's unsupported check can follow.
- `frontend/src/components/ui/load-error.tsx` (`LoadError`) — the existing
  error-branch component the settings card already renders on a failed fetch.

**Deliberately NOT used:** `frontend/src/hooks/useUserFlag.ts` (per-email
one-shot localStorage flag). It was the natural fit for a
seen-the-pre-prompt marker, and D-01 removed the need for one. Do not
reintroduce it.

### Established Patterns
- `frontend/src/main.tsx:14-47` — the app's only service-worker code today
  (update-check loop). It uses `navigator.serviceWorker.getRegistration()`;
  the subscribe routine needs a registration handle and should not duplicate or
  disturb this block.
- `frontend/src/lib/queryClient.ts` — `QueryCache.onError` / `MutationCache.onError`
  capture to Sentry globally.
- `TrainScoreScreen.tsx` renders a single centered column
  (`flex flex-col items-center gap-4`) with `TRAIN_CTA_BUTTON_CLASS` on the CTA —
  the button row in D-04 lives here and must work at 375px.
- Every interactive element carries a `data-testid`; existing Train settings
  controls use `filter-weekday-*` / `filter-puzzles-*`.

### Integration Points
- `frontend/src/types/train.ts:129-141` — `TrainSettingsResponse` and
  `TrainSettingsUpdate` do **not** yet carry `reminder_enabled` /
  `reminder_hour`. Both need them, and `TrainSettingsUpdate` is a
  full-replace shape, so every existing `PUT` call site must send them.
- `frontend/src/api/client.ts` — `trainApi.getSettings` / `updateSettings` live
  here; a `pushApi` (subscribe / unsubscribe / vapid public key) does not exist
  and must be added.
- `frontend/public/push-sw.js` — shipped by Phase 201 and wired via
  `workbox.importScripts`. Nothing in this phase should touch it or
  `frontend/vite.config.ts`'s `generateSW` block (SEED-132 decisions 14/15).
- `POST /push/dev/trigger-reminder` (development-only, 201 D-17) — the UAT
  lever for verifying an end-to-end delivery from the device that just
  subscribed, without waiting for the real clock hour.

</code_context>

<specifics>
## Specific Ideas

- The design pivot came from the user mid-discussion: *"If it's non-blocking on
  the score screen after the train session, why not just always have a Reminder
  secondary button next to the Done button, in case Reminders are not active on
  the device?"* — that is D-01, and it is what collapsed the entire
  seen/declined state machine the phase was heading toward.
- The button row order is explicit: **"Remind me" on the left, "Done" on the
  right, Done primary.**
- The D-03 confirmation should name the hour, not just say "on" — it is the
  user's only prompt to fix a wrong default at the moment they care.

</specifics>

<deferred>
## Deferred Ideas

- **A value-proposition pitch for the opt-in** — the sentence of copy a card
  would have carried and a bare button cannot ("Want a nudge on your training
  days?"). If conversion turns out to be poor, revisit as a caption or a
  one-time inline explainer; do not revisit as a dismissible card, which brings
  the state machine back.
- **Re-asking after a long gap** — the "show once more after 30 days / 10
  sessions" option rejected in this discussion. Moot under D-01 (the button is
  always there), and it is the shape that turns into a nag if a threshold is
  ever tuned down.
- **Brave-specific `AbortError` guidance** — rejected in D-13. Revisit only if
  Sentry shows real users hitting it; the fix would be a documented note, not
  error-name sniffing in the UI.
- **A per-device management list** ("your devices", last-seen labels) — needs
  the `last_seen_at` / device-label columns 201 D-05 deferred. Would let a user
  turn reminders off for one device rather than all.
- **SEED-132 Phase B** — install promotion, desktop→phone QR handoff, Android
  `beforeinstallprompt`, the iOS install-then-permission path. Out of this
  milestone on a BrowserStack dependency; the seed stays open in
  `.planning/seeds/`. D-10's decision to hide everything on iOS is what leaves
  this gap clean.

### Reviewed Todos (not folded)
`gsd-tools query todo.match-phase 202` returned two matches
(`172-deferred-review-findings` scoring on the keyword "phase", and the
bitboard-storage note scoring on "app") out of three pending todos. Both are
generic keyword hits with no relation to push, notifications, or Train
settings — the same non-matches Phase 201 reviewed. None folded.

</deferred>

---

*Phase: 202-reminder-permission-ux*
*Context gathered: 2026-08-02*
