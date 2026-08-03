# Phase 203: PWA Install Re-prompting & Train-Anchored Install Offer - Research

**Researched:** 2026-08-02
**Domain:** PWA install lifecycle (`beforeinstallprompt`), iOS Add-to-Home-Screen, browser storage partitioning, QR code generation, React state-machine UI on an existing Train reminder surface
**Confidence:** MEDIUM — codebase inventory is HIGH (every claim below is read-verified with line numbers); the two platform-behavior questions the phase explicitly declines to gate on (`beforeinstallprompt` re-fire semantics, iOS storage partitioning) are MEDIUM/LOW by design, per CONTEXT.md D-01 and the "ship iOS unverified, fail safe" amendment

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

SEED-134 already locked the shape: re-prompting replaces permanent dismissal (A.1), push before install where both exist (A.3), the confirmed reminder state is the upsell surface (B.5), the QR carries no credential (C.8/C.9), and the five-state machine is the real complexity (D.12). Those are NOT restated as decisions in CONTEXT.md — read the seed (`.planning/seeds/SEED-134-pwa-install-reprompting-and-train-anchored-offer.md`). The decisions below are what the `/gsd-discuss-phase` session resolved on top of it, including two places where it **overrides** the seed.

**Artifact conflicts resolved (read first):**
- **D-01**: The "blocking pre-planning research gate" on iOS `localStorage` survival is **LIFTED**. Amendment E (seed decisions 13-16) reverses ROADMAP.md/STATE.md's still-stale gate language: ship the iOS branch on the unverified assumption, fail safe, ask an iPhone owner to test after deploy. **This researcher must not stall on this gate and must not attempt to resolve it** — the operator has no iPhone/iPad, and a desktop-Chromium test answers a different question. The answer arrives passively: if iOS standalone devices never appear in `push_subscriptions` a few weeks post-deploy, the branch does not work.
- **D-02**: The `reminder_intent_at` migration is **unconditional**, not contingent on the storage finding. Goes on `train_settings` regardless. Do not substitute a `localStorage` flag for it. Reversibility: one-way — adds a column and extends `TrainSettingsResponse`/`TrainSettingsUpdate`, which every existing full-replace `PUT` call site sends.

**The global install drawer (INSTALL-01..06):**
- **D-03**: The drawer **keeps firing on first mobile visit** — the demonstrated-value retiming (INSTALL-02) is **dropped, deliberately, as a recorded deviation**. Only the permanent-dismissal bug is fixed. The planner must not restore a value gate. Flag INSTALL-02 in REQUIREMENTS.md as superseded rather than silently Pending.
- **D-04**: Cooldown = **14 days**, cap = **3 attempts**, then stop for good. Named constants, never literals.
- **D-05**: The cooldown + attempt state **stays in `localStorage`** (per-device cadence is correct here; only the reminder *intent* needs to bridge tab→standalone, which is why only that goes server-side). Do not "consistency-fix" the cooldown onto the server.
- **D-06**: **Keep the `isMobile` UA gate** — desktop never sees the install drawer. Not a defect; the QR is the desktop path. Do not drop the gate to give desktop its own install offer.
- **D-07**: The drawer is **suppressed on all Train routes** — this is how INSTALL-03 (push before install) is satisfied structurally, not via a cross-component ordering machine. One route check at the mount site.
- **D-08**: The cooldown/attempt cap governs **ONLY the interrupting drawer**. The Train confirmed-state install offer is independent and never gated by them — user-summoned, inline, zero cost to ignore.

**Desktop → phone QR handoff (HANDOFF-01..04):**
- **D-09**: The QR renders **only in the confirmed state on the score screen**, plus its permanent home in `TrainScheduleSettings` (HANDOFF-04). Peak intent, reads as a reward. Accepted cost: a one-session window.
- **D-10**: **`qrcode.react`** — SVG output, ~10KB gzipped (verified: 6.05KB gzip, zero dependencies — see Package Legitimacy Audit), two call sites so knip is satisfied. Lazy-load it — desktop Train routes only, must stay off the mobile critical path.
- **D-11**: **`?src=handoff` overrides the D-07 Train-route suppression AND bypasses the D-04 cooldown.** Without this the handoff is a no-op (the QR lands on `/train`, exactly where D-07 suppresses the drawer). One extra branch in the drawer's visibility logic; the suppression rule gains one documented exception.
- **D-12**: The marker **survives Google SSO via `sessionStorage`.** Capture `src=handoff` on first load, write to `sessionStorage`, consume after the OAuth round-trip. Purely frontend, no auth change. (Codebase precedent confirmed: `pending_toast` and `promote_intent` already use this exact one-shot-sessionStorage-across-OAuth-redirect pattern — see Code Examples.)
- **D-13**: The QR **carries no dismiss control at all.** Inline, non-blocking, vanishes with the score screen. This is a **deliberate deviation from HANDOFF-03's literal "dismissible" wording** — the planner must not add an X and a persisted flag to "fix" it.

**The iOS slice (OFFER-03, OFFER-05, amendment E):**
- **D-14**: The iOS-tabbed slot gets a **button in the same shape as "Remind me"** (`brand-outline`, same slot, same row) that surfaces the existing Share → Add to Home Screen instructions (`InstallPromptBanner.tsx:47-69`) instead of calling `requestPermission()`. Copy must carry the honest two-step ("Add FlawChess to your home screen, then open it and turn on reminders") that survives a forced re-login.
- **D-15**: **`reminder_intent_at` is written on the iOS button tap**, via `PUT /train/settings`, before the instructions render — while still authenticated in the tab.
- **D-16**: OFFER-05's re-surface = **auto-route to `/train` plus a prominent reminder prompt** on a standalone launch where `reminder_intent_at` is set and the device has no push subscription. Must clear itself once the device subscribes or the user dismisses.
- **D-17**: The **iOS slice is its own plan, sequenced LAST** in the phase — a bad storage answer costs one plan, not the phase. Everything before it ships and is verifiable without an iPhone.

**Still-locked seed items the planner must implement verbatim:**
- **INSTALL-04** — on dismiss, KEEP the captured `BeforeInstallPromptEvent`, move only the cooldown state; null it solely after a successful install (`useInstallPrompt.ts:41` is the bug).
- **INSTALL-05** — `isStandalone` must OR `navigator.standalone` with `display-mode: standalone` (`useInstallPrompt.ts:50`).
- **INSTALL-06** — no install copy promises notifications on any platform except iOS.

**Risk the researcher should size (not a gate):** Whether Chrome re-fires `beforeinstallprompt` on a later visit after our `preventDefault()`ed custom UI is dismissed is undocumented in both directions, and D-04's cooldown design rests on it. **It fails safe as currently coded** — drawer visibility already requires a live `promptEvent` (`useInstallPrompt.ts:54`), so if Chrome does not re-fire, the re-offer simply never appears; there is no dead button. See "`beforeinstallprompt` Re-fire Semantics" below.

### Claude's Discretion

- Drawer copy (subject to INSTALL-06 — no notification promise off iOS).
- Whether the Android-tabbed confirmed-state install offer differs in wording from the drawer, and whether it is a button or an inline line.
- The `TrainReminderButton` five-state refactor shape — per-state child components vs. inline branches (CLAUDE.md nesting hard-4, logic-LOC limits; the current single-state component is already at five early-return conditions).
- Where the QR component lives, its pixel size, and error-correction level.
- Placement of the QR home within the existing "Train schedule" card, relative to the toggle, hour picker, and weekday chips.
- Test strategy for UA sniffing, `navigator.standalone`, and `beforeinstallprompt` under jsdom.
- Whether the `?src=handoff` consumption lives in a hook, a route loader, or the drawer itself.

### Deferred Ideas (OUT OF SCOPE)

- Demonstrated-value retiming of the install offer (seed A.2, INSTALL-02) — dropped by D-03; first lever to revisit if drawer conversion is poor (gate on import-complete before a completed Train session).
- A signed one-time handoff token in the QR (seed C.9) — explicitly rejected for v1; an auth change, not a UX detail.
- Desktop PWA install offer (dropping the `isMobile` gate) — rejected in D-06.
- Whether the Train solve loop holds up on a mid-range phone (seed open question 5) — a measurement, its own slot.
- A per-device management list ("your devices") — still needs 201 D-05's deferred columns.
- Persisted QR dismissal — rejected in D-13.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INSTALL-01 | Timestamped cooldown + attempt cap replaces the permanent dismissal boolean | Codebase Inventory §1 (`useInstallPrompt.ts:8-9,38-47`); Common Pitfalls §1; Code Examples §1 |
| INSTALL-02 | First offer fires behind demonstrated value | **Superseded by CONTEXT D-03** — do not implement; drawer keeps arrival-timing. REQUIREMENTS.md should record this as a recorded deviation, not silently Pending. |
| INSTALL-03 | Push-before-install ordering on Android tabbed | Satisfied structurally by D-07 Train-route suppression, not a state machine — Architecture Patterns §2 |
| INSTALL-04 | Keep captured event on dismiss; null only after install | `beforeinstallprompt` Re-fire Semantics §3 (event single-use, must survive SPA route changes); Common Pitfalls §2 |
| INSTALL-05 | `isStandalone` ORs `navigator.standalone` with the media query | iOS Standalone Detection & Storage §1; Code Examples §2 |
| INSTALL-06 | No install copy promises notifications off iOS | Architectural Responsibility Map; `usePushCapability`/`isPushSupported` codebase citations confirm `PushManager` absence on iOS-in-tab |
| OFFER-01 | `TrainReminderButton` resolves five explicit states | Codebase Inventory §3 (`TrainReminderButton.tsx:23,51-78`); Architecture Patterns §3 |
| OFFER-02 | Confirmed state is the upsell surface (QR desktop / install Android) | Codebase Inventory §3 (confirmed span at lines 51-61); Architecture Patterns §3 |
| OFFER-03 | iOS-tabbed slot gets install affordance instead of `null` | Codebase Inventory §3 (capability guard at 67-78); `usePushCapability` gate confirmed |
| OFFER-04 | Standalone unsubscribed grants with no install offer | Architecture Patterns §3 (state table) |
| OFFER-05 | Proactive re-surface on next standalone launch | Codebase Inventory §6 (`start_url: '/'` in `vite.config.ts:66` — confirms routing must be explicit, not incidental) |
| HANDOFF-01 | QR encodes plain URL + `?src=handoff`, no credential | QR Library Research; Package Legitimacy Audit |
| HANDOFF-02 | Phone logs in via Google SSO, lands on `/train`, marker drives flow | Codebase Inventory §5 (OAuth redirect chain, `sessionStorage` precedent) |
| HANDOFF-03 | QR dismissible, never blocking | Satisfied structurally per D-13 (no dismiss control; deviation recorded) |
| HANDOFF-04 | Permanent QR home in `TrainScheduleSettings` | Codebase Inventory §4 (`TrainScheduleSettings.tsx` card structure) |
</phase_requirements>

## Summary

This phase is almost entirely a rewrite/extension of code that already exists and already ships. `useInstallPrompt.ts` (60 lines), `InstallPromptBanner.tsx`, `TrainReminderButton.tsx`, `TrainScheduleSettings.tsx`, and `push.ts`/`usePushCapability.ts` are all read-verified in this session at the exact line numbers CONTEXT.md cites — the seed's anchors are accurate. The three defects (permanent dismissal boolean, event nulled on dismiss, `isStandalone` missing iOS) are real and independently confirmed. The `TrainSettingsResponse`/`TrainSettingsUpdate`/`TrainSettingsRow` round-trip pattern for `reminder_intent_at` has a direct precedent to copy verbatim: `reminder_enabled`/`reminder_hour` were added the identical way in Phase 201 (migration `ca8c8fbc2080`), and the "full-replace PUT" hazard CONTEXT.md flags is already self-documented in `useTrainSettings.ts:28-30`.

Two things this research adds beyond the seed: first, a stronger evidentiary basis for the iOS storage-partition risk (multiple corroborating sources, still not an authoritative Apple platform doc, so still MEDIUM not HIGH — this is exactly the risk profile that justifies D-17's "own plan, last" isolation, not a reason to relitigate it). Second, `qrcode.react` is now registry-verified (OK verdict, 7.6M weekly downloads, zero dependencies, React 19-compatible, 6.05KB gzip) rather than merely named in discussion.

**Primary recommendation:** Treat this as a codebase-refactor phase, not a greenfield build — every state transition table, every constant, and every file boundary is already decided in CONTEXT.md/SEED-134. The plan's job is sequencing (D-17: iOS last) and mechanical correctness (the full-replace PUT contract, the five-state early-return shape staying under CLAUDE.md's nesting/LOC limits), not design.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Install prompt cooldown/attempt state | Browser / Client | — | Per-device cadence; `localStorage`, no server round-trip (D-05) |
| Reminder intent flag (`reminder_intent_at`) | API / Backend | Database | Must survive the iOS tab→standalone storage boundary that `localStorage` cannot (D-02); round-trips through `GET`/`PUT /train/settings` |
| Push permission grant | Browser / Client | — | `Notification.requestPermission()` — one-shot, browser-enforced, no server involvement (`lib/push.ts`, the ONLY call site) |
| Five-state resolution (`TrainReminderButton`) | Browser / Client | API / Backend (subscription state via `getDeviceSubscription()`, settings via `useTrainSettings`) | Pure function of live capability signals + one settings fetch — never persisted decision history (202 D-01, extended here) |
| QR code rendering | Browser / Client | — | `qrcode.react`, offline SVG generation, no server round-trip, no third-party image service (HANDOFF-01's "no credential" constraint extends to "no external QR API leaking the URL") |
| `?src=handoff` marker survival across OAuth | Browser / Client | — | `sessionStorage`, one redirect inside one tab (D-12) — NOT the iOS tab→standalone boundary, which is a different, harder problem this marker does not need to solve |
| Drawer suppression on Train routes | Browser / Client | — | `useLocation()` route check at the mount site (`App.tsx:613,638`), structural not stateful (D-07) |

## Codebase Inventory (all citations read-verified this session)

### 1. `frontend/src/hooks/useInstallPrompt.ts` (60 lines total)

Read in full. Confirms every CONTEXT.md anchor exactly:

- `ANDROID_DISMISS_KEY = 'install-prompt-dismissed'` / `IOS_DISMISS_KEY = 'ios-install-banner-dismissed'` — `[VERIFIED: frontend/src/hooks/useInstallPrompt.ts:8-9]` — bare string constants, no timestamp, no counter.
- `dismissAndroid` (lines 38-42) writes `localStorage.setItem(ANDROID_DISMISS_KEY, 'true')` **and calls `setPromptEvent(null)`** on the same dismissal — `[VERIFIED: frontend/src/hooks/useInstallPrompt.ts:38-42]`:
  ```ts
  const dismissAndroid = () => {
    setIsAndroidDismissed(true);
    localStorage.setItem(ANDROID_DISMISS_KEY, 'true');
    setPromptEvent(null);
  };
  ```
  This is the exact INSTALL-04 defect: the captured `BeforeInstallPromptEvent` dies with the dismissal, and since FlawChess is an SPA, no route change re-triggers `beforeinstallprompt` (only a real page load does — see `beforeinstallprompt` Re-fire Semantics below), so any later install affordance in the same session is a dead no-op until the drawer's own `promptEvent` state clears.
- `dismissIOS` (lines 44-47) writes the bare boolean, no `setPromptEvent` call (iOS has no `beforeinstallprompt` at all — Safari doesn't fire it).
- `isStandalone` (line 50): `window.matchMedia('(display-mode: standalone)').matches` **only** — `[VERIFIED: frontend/src/hooks/useInstallPrompt.ts:50]`. No `navigator.standalone` check anywhere in the file. INSTALL-05's defect confirmed exactly as described.
- `isMobile` (line 51): `/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)` — UA-sniffed device class, **not** a viewport-width check. This is a different mechanism from `useIsDesktop.ts` (viewport `matchMedia`, 1024px breakpoint) elsewhere in the codebase — see Common Pitfalls §4 for why these must not be conflated.
- Return shape (lines 53-59): `showAndroidPrompt`, `showIOSBanner`, `triggerInstall`, `dismissAndroid`, `dismissIOS`. No `promptEvent` itself is exposed — only derived booleans. A rewrite that needs to expose cooldown/attempt state to `TrainReminderButton`'s Android-tabbed branch will need to widen this return shape.
- `triggerInstall` (lines 29-36) already nulls `promptEvent` correctly — **only** on `outcome === 'accepted'` (successful install). This is the ONE place in the current file that already matches INSTALL-04's target behavior; the bug is purely in the two dismiss functions.

### 2. `frontend/src/components/install/InstallPromptBanner.tsx` (72 lines)

Read in full. Android drawer (`Drawer`/`DrawerContent`, `data-testid="install-prompt-android"`, lines 15-44) + iOS fixed bottom banner (`data-testid="banner-ios-install"`, lines 47-69). Existing `data-testid`s confirmed: `btn-install` (30), `btn-install-dismiss` (38), `btn-ios-install-dismiss` (65). Drawer copy: "Add to your home screen for the best experience — faster load, full screen, offline assets" (line 22) — generic, untied to Train value, exactly as the seed describes; free to rewrite per Claude's Discretion (subject to INSTALL-06). iOS banner copy (line 55): "Install: tap **Share** then **Add to Home Screen**" — this is the exact copy D-14 says the iOS-tabbed `TrainReminderButton` slot should route into, not duplicate.

### 3. `frontend/src/components/train/TrainReminderButton.tsx` (133 lines)

Read in full. `type ReminderButtonState = 'idle' | 'pending' | 'confirmed' | 'error'` (line 23) — the ONE state this phase must grow to five (OFFER-01), per the D.12 table (desktop-unsub / android-tabbed-unsub / iOS-tabbed / any-standalone-unsub / subscribed).

- **Confirmed span** (lines 51-61) — `data-testid="train-reminder-confirmed"`, renders `Check` + "Reminders on — {hour}:00 on your training days". This is D-09's exact QR-attachment point and OFFER-02's install-offer attachment point for Android tabbed.
- **Capability guard** (lines 67-78): returns `null` when any of `!capability.isResolved`, `!capability.available`, `capability.permission === 'denied'`, `deniedNow`, `deviceSubscribed === null`, `deviceSubscribed`, `data === undefined`, `vapidPublicKey === null`. On iOS in a tab, `capability.available` is false because `isPushSupported()` (see §3a below) requires `'PushManager' in window`, which iOS Safari lacks outside standalone mode — so this exact guard is what currently renders `null` for iOS-tabbed users, confirming D-14's premise precisely.
- `handleClick` (lines 80-119) already calls `save(...)` with the full `TrainSettingsDraft` shape (weekdayMask, puzzlesPerSession, reminderEnabled: true, reminderHour) — this is the pattern D-15's iOS-tap `reminder_intent_at` write must extend, not a new mutation.

### 3a. `frontend/src/lib/push.ts` and `frontend/src/hooks/usePushCapability.ts`

Both read in full.

- `isPushSupported()` (push.ts:42-44): `'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window` — the WebKit-recommended feature-detection triad, already exactly matching the seed's Research Finding 4 citation.
- `push.ts` is confirmed as the **single call site** of `Notification.requestPermission()` (line 137, inside `ensureDeviceSubscribed`) and `PushManager.subscribe()` (line 145) — module docstring (lines 1-13) states this is deliberate. INSTALL-03's "push before install" ordering, if it needed a code-level enforcement point beyond D-07's route suppression, would have exactly one place to hook: this file's `ensureDeviceSubscribed`.
- `usePushCapability` (usePushCapability.ts, 61 lines) resolves `{ isResolved, available, vapidPublicKey, permission }` via a `staleTime: Infinity` TanStack Query against `GET /push/vapid-public-key`, treating a 404 as "unconfigured" not an error (line 41, D-12 of Phase 202's own context). `permission` is read live every render (line 59), never memoized — this is the pattern any new five-state logic should reuse rather than re-deriving.

### 4. `frontend/src/components/train/TrainScheduleSettings.tsx` (465 lines)

Read in full. Already has a `ReminderControls` sub-component (lines 201-251) extracted specifically to keep the parent under CLAUDE.md's nesting/LOC limits — the exact pattern HANDOFF-04's QR home and, per Claude's Discretion, the `TrainReminderButton` five-state refactor should follow. `ScheduleCardShell` (lines 141-181) is the shared `Card`/`CardHeader`/`CardBody` wrapper with an `indicator` slot for save-state feedback — the QR's permanent home renders inside this same card body per D-9/HANDOFF-04, likely as a sibling block to `ReminderControls` (lines 452-461 show the composition point). `TRAIN_SETTINGS_SAVE_DEBOUNCE_MS = 600` (line 59) and the `hasEditedRef` mount guard (line 261) are the debounced-draft pattern the module docstring (lines 27-41) explicitly documents as NOT to be used for the toggle-ON async path — the reminder toggle instead calls `ensureDeviceSubscribed()` synchronously before writing the draft (lines 335-364). This asymmetry is directly relevant background for D-15: the iOS `reminder_intent_at` write, similarly, cannot ride the debounce (it must land synchronously on tap, before the instructions render, "while still authenticated in the tab").

### 5. Auth token storage & OAuth redirect chain

- `localStorage.getItem('auth_token')` — `[VERIFIED: frontend/src/api/client.ts:66]`, the Bearer token read on every API request.
- `localStorage.setItem('auth_token', ...)` — `[VERIFIED: frontend/src/hooks/useAuth.ts:64,76,90,101]` — this is the token STATE.md's blocking-gate language refers to; if iOS storage partitioning is real (see below), this specific key is what dies on the tab→standalone transition.
- The Google SSO flow does **not** pass query params through: `getGoogleAuthorizationUrl()` (`frontend/src/api/googleAuth.ts:31-59`) hits `GET /auth/google/authorize`, which redirects to Google, which redirects to the **backend's** `GET /auth/google/callback` (`app/routers/auth.py:174`), which then redirects the browser to the frontend at `/auth/callback#token=<JWT>` (fragment, not query string — `[VERIFIED: frontend/src/pages/OAuthCallbackPage.tsx:8-11]`). A `?src=handoff` query param on the original landing page is **lost** across this chain unless captured before the redirect to Google — exactly what D-12 specifies.
- **Established precedent for D-12's mechanism already exists in this codebase, twice:**
  1. `sessionStorage.setItem('pending_toast', ...)` — `[VERIFIED: frontend/src/pages/OAuthCallbackPage.tsx:40-43]`, written after a guest-promotion Google login, consumed at `[VERIFIED: frontend/src/App.tsx:557-562]` inside `ProtectedLayout`'s mount effect: `sessionStorage.getItem('pending_toast')` → `removeItem` → `toast.success(msg)`. Comment at App.tsx:556 explains why: "ProtectedLayout is the stable destination after the redirect chain (callback → / → /openings)."
  2. `PROMOTE_INTENT_KEY = 'promote_intent'` — `[VERIFIED: frontend/src/api/googleAuth.ts:4,36-42]`, a one-shot `sessionStorage` flag consumed and cleared at the START of `getGoogleAuthorizationUrl()` (i.e., before the redirect to Google, not after — a slightly different point in the flow, but the same "one-shot sessionStorage flag bridging an OAuth redirect" idea).
  The `?src=handoff` consumption for D-12 should follow pattern (1)'s shape most closely: capture on arrival at the marked URL, write to `sessionStorage`, consume at the same stable post-redirect mount point (`ProtectedLayout`, `App.tsx:528-562` area) that already reads `pending_toast`.

### 6. `App.tsx` mount points, routing, and PWA manifest

- `<InstallPromptBanner />` mounts at two sites: `[VERIFIED: frontend/src/App.tsx:613]` (analysis-takeover layout) and `[VERIFIED: frontend/src/App.tsx:638]` (default layout). Both are inside the same parent component that has `useLocation()` in scope (multiple `const location = useLocation()` calls at lines 140, 287, 355, 453, 528) — a route check for D-07's Train-route suppression can be added at either the mount call sites or inside `InstallPromptBanner`/`useInstallPrompt` itself without new plumbing.
- `/train` route: `[VERIFIED: frontend/src/App.tsx]` nav item at line 74/82, `pathname.startsWith('/train')` route-matching helper at line 127 — this is the existing pattern to reuse for detecting "on a Train route" rather than an exact-match check (Train has sub-views but no sub-routes currently, per `frontend/src/pages/Train.tsx`'s single default export with no nested `<Route>`).
- PWA manifest `start_url: '/'` — `[VERIFIED: frontend/vite.config.ts:66]`. This directly confirms OFFER-05/D-16's requirement that the standalone re-surface must be an **active** `useNavigate()` call to `/train`, not a passive consequence of how the PWA launches — a standalone launch lands on `/`, never `/train`, regardless of what the user was last doing.
- `useSearchParams` is already imported and used in a scoped wrapper (`AppRoutes`, referenced at `App.tsx:701-708`) — confirms the mechanism for reading `?src=handoff` on initial mount is already idiomatic in this codebase, just not yet wired to any handoff-specific logic.

### 7. Backend: `train_settings`, schemas, repository, router (the `reminder_intent_at` round-trip)

Confirmed this is a **mechanical repeat** of exactly how `reminder_enabled`/`reminder_hour` were added in Phase 201 — five files, same shape each time:

- **Model** — `[VERIFIED: app/models/train_settings.py:44-113]`. Table `train_settings`, PK `user_id` (CASCADE FK to `users.id`, line 61-63). Existing reminder columns:
  ```python
  reminder_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
  reminder_hour: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="18")
  reminder_last_sent_on: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
  ```
  `reminder_intent_at` should follow the `reminder_last_sent_on` shape (nullable, no server_default, NULL = never) but as a timestamp, not a date — codebase convention for nullable timestamps elsewhere is `DateTime(timezone=True), nullable=True`, confirmed at `[VERIFIED: app/models/drill_session.py:87]`, `[VERIFIED: app/models/eval_jobs.py:94,102]`, `[VERIFIED: app/models/herring_pool.py:136]` (all read this session as grep hits with consistent `DateTime(timezone=True)` — the codebase never uses a naive `DateTime` for a persisted instant).
  **Important distinction vs. `reminder_last_sent_on`**: that column is documented as "written ONLY by the reminder job's claim UPDATE... never client-writable... never appears in TrainSettingsUpdate/TrainSettingsResponse" (`[VERIFIED: app/models/train_settings.py:100-105]`). `reminder_intent_at` is the OPPOSITE — D-15 requires it be **client-writable** (written on the iOS button tap via `PUT /train/settings`), so it must appear in **both** `TrainSettingsResponse` and `TrainSettingsUpdate`, unlike its structural sibling.
- **Migration precedent** — `[VERIFIED: alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py, full file read]`. Exact anchor for the new migration's shape:
  ```python
  def upgrade() -> None:
      op.add_column(
          "train_settings",
          sa.Column("reminder_enabled", sa.Boolean(), server_default="false", nullable=False),
      )
      # ... reminder_hour + CHECK constraint ...
      op.add_column("train_settings", sa.Column("reminder_last_sent_on", sa.Date(), nullable=True))
  ```
  Docstring explicitly notes: "No backfill, no data migration: every existing row lands on the server defaults." `reminder_intent_at` needs exactly one `op.add_column(..., sa.DateTime(timezone=True), nullable=True)` — no CHECK constraint needed (unbounded timestamp), no backfill.
- **Schemas** — `[VERIFIED: app/schemas/train.py:198-246]`. `TrainSettingsResponse` (198-212) and `TrainSettingsUpdate` (215-246) are separate classes "so a PUT body can never smuggle a server-owned field" (line 219 docstring) — confirming the client-writable/server-owned split above is a documented, deliberate design axis in this file, not an oversight to work around.
- **Repository** — `[VERIFIED: app/repositories/train_repository.py:125-145 (TrainSettingsRow dataclass), 248-296 (get_or_create_settings), 303+ (upsert_settings signature)]`. `TrainSettingsRow` is a frozen dataclass (line 128 docstring: "Frozen (immutable) per CLAUDE.md internal-structured-data rule"). `get_or_create_settings` inserts via `pg_insert(...).on_conflict_do_nothing(index_elements=["user_id"])` (concurrency-safe create-on-first-touch). Both functions take fully-named keyword arguments for every settings field — `reminder_intent_at` joins the same parameter lists, dataclass fields, and `ORDER BY` of assembly as `reminder_enabled`/`reminder_hour` did in Phase 201.
- **Router** — `[VERIFIED: app/routers/train.py:237-298]`. `GET /settings` (237-251) calls `get_or_create_settings` then maps every field explicitly onto `TrainSettingsResponse(...)`. `PUT /settings` (255-298) does the analogous explicit mapping through `upsert_settings`. No dynamic/generic field iteration anywhere — every new field requires touching this file's two explicit constructor calls.
- **Frontend types + hook** — `[VERIFIED: frontend/src/types/train.ts:129-141, frontend/src/hooks/useTrainSettings.ts, full file read]`. `TrainSettingsDraft` (useTrainSettings.ts:25-33) already carries a **self-documenting warning** directly relevant to D-02's stated risk: *"Phase 202 (PERM-01..04). This is a full-replace PUT body, so both new fields must be threaded through the mutation together or every existing weekday/puzzle-count save 422s."* This is the exact hazard CONTEXT.md's "Artifact conflicts resolved" section describes for `reminder_intent_at` — the existing code already names the pattern to follow.
- **Two existing PUT call sites that must both carry the new field** — `[VERIFIED: frontend/src/components/train/TrainReminderButton.tsx:93-99]` and `[VERIFIED: frontend/src/components/train/TrainScheduleSettings.tsx:298-304]`. Any plan adding `reminder_intent_at` to `TrainSettingsUpdate` must update both mutation payloads (or the field becomes effectively unset from those paths) — plus the new third write path this phase adds for the iOS tap (D-15).

## `beforeinstallprompt` Re-fire Semantics

This directly gates INSTALL-01/INSTALL-04's design. Distinguishing spec-guaranteed vs. observed vs. unknown, per the researcher's mandate:

**Spec-guaranteed / documented (MDN, web.dev — `[CITED: developer.mozilla.org, web.dev]`):**
1. `prompt()` may be called **at most once** per `BeforeInstallPromptEvent` instance — `[CITED: MDN BeforeInstallPromptEvent/prompt()]`.
2. If the user dismisses the resulting native dialog, "you need to wait until the `beforeinstallprompt` event fires again" — and per MDN's "Trigger installation from your PWA" guide, that happens **on the next page navigation**, not automatically within the same document lifetime — `[CITED: developer.mozilla.org/.../How_to/Trigger_install_prompt]`. This directly confirms INSTALL-04's premise: FlawChess is an SPA, so a route change (e.g., Home → Train) is NOT a "page navigation" in this sense, and no replacement event will arrive without a full reload.
3. Chrome removed the old engagement-heuristic gate on `beforeinstallprompt` firing; the only documented reasons it will not fire are: already installed, installability criteria unmet, or an unsupported browser — `[CITED: developer.chrome.com/blog/update-install-criteria, web.dev/articles/customize-install]`.
4. The mini-infobar (Chrome's own native install nudge) fires "regardless of whether you `preventDefault()`" — `[CITED: developer.chrome.com/blog/a2hs-updates]` — but this is a **separate UI surface** from the custom drawer; it is not what FlawChess renders.

**Observed / reported, not formally specified (`[ASSUMED — no authoritative source confirms this exact scenario]`):**
- A GitHub-tracked Chromium behavior note (surfaced in this session's search) describes "cancelling the dialog causes `beforeinstallprompt` to be fired again immediately" in at least one reported case, framed as a bug/gotcha around consuming the user gesture — this is anecdotal, not a spec citation, and describes native-dialog dismissal, not `preventDefault()`ed custom-UI dismissal specifically.
- **No authoritative source in either this session's search or SEED-134's own prior research documents a cooldown mechanism triggered by dismissing a `preventDefault()`ed custom UI**, in either direction (i.e., neither "Chrome imposes a ~90-day cooldown on your custom dismissal" nor "Chrome always re-fires on next visit" is confirmed for the custom-UI case specifically). SEED-134's own finding 1 (`[ASSUMED]`, cited in the seed) reaches the same conclusion independently.

**What this means for the plan:** the cooldown/attempt-cap logic (D-04) must be entirely self-contained in FlawChess's own `localStorage` state — it cannot and must not assume anything about when Chrome will next deliver a fresh `beforeinstallprompt` event. This is exactly what D-04/D-05 already specify, so no design change is implied. The fail-safe property CONTEXT.md notes (drawer visibility already requires a live `promptEvent`, so a non-re-firing browser just means the re-offer silently never appears rather than showing a dead button) is confirmed correct by reading `useInstallPrompt.ts:54`: `showAndroidPrompt: !!promptEvent && !isAndroidDismissed && !isStandalone && isMobile` — the `!!promptEvent` term is load-bearing and already present.

## iOS Standalone Detection & Storage

### 1. `navigator.standalone` + `matchMedia` combination (INSTALL-05)

`navigator.standalone` is Apple's non-standard, iOS-only boolean (`true` when running as an installed home-screen web app in Safari). It is not part of the DOM/TS lib and is absent from `frontend/tsconfig.app.json`'s `"lib": ["ES2022", "DOM", "DOM.Iterable"]` — `[VERIFIED: frontend/tsconfig.app.json:6]`. No existing `.d.ts` augmentation for it was found anywhere in `frontend/src` (`[VERIFIED: no matches for "standalone" in any *.d.ts file]`). The plan must add a type augmentation (a `declare global { interface Navigator { standalone?: boolean } }` block, or an inline cast) before referencing `navigator.standalone` under `strict: true` + `noUncheckedIndexedAccess`.

Correct detection combines both signals (INSTALL-05's literal requirement):
```ts
const isStandalone =
  (typeof navigator !== 'undefined' && navigator.standalone === true) ||
  (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches);
```
`display-mode: standalone` is the cross-platform (Android/desktop Chromium) signal; `navigator.standalone` is the iOS-specific one. Neither subsumes the other — Safari has historically not reflected `display-mode: standalone` reliably for home-screen apps in some iOS versions, which is precisely why the OR is required rather than relying on the media query alone. `[ASSUMED — the seed's own framing, "finding 4 could not confirm the media query works [on iOS]," is carried forward here; this session found no authoritative source stating iOS Safari's `matchMedia('(display-mode: standalone)')` support status for a specific iOS version range, so the OR is a safe-by-construction fix regardless of whether the media query already works there.]`

### 2. iOS tab → standalone storage partitioning (the risk CONTEXT.md explicitly says NOT to gate on, but must be sized)

Multiple corroborating web sources agree that Safari-tab and home-screen-standalone contexts on iOS do **not** share `localStorage`, `sessionStorage`, cookies, or even the Service Worker instance, on the same origin:
- `[CITED: netguru.com/blog/how-to-share-session-cookie-or-state-between-pwa-in-standalone-mode-and-safari-on-ios]` — explicit statement: "Session, cookies, local storage, and even Service Worker instance is not shared between safari and standalone mode." (Verified by direct fetch this session; article dated 2021, still the cited authority in multiple newer secondary sources found in this search.)
- `[CITED: magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide]` — a 2026-dated guide independently repeating the same isolation claim.
- `[CITED: webkit.org/blog/14403/updates-to-storage-policy]` — WebKit's own storage-policy blog, confirming home-screen web apps get materially different storage-persistence treatment than ordinary Safari tabs (framed around script-writable-storage eviction rules, not explicitly a same-origin-different-container claim, but consistent with the isolation framing).

**Confidence: MEDIUM, not HIGH.** None of these is Apple's own platform documentation stating "localStorage is partitioned between Safari and Home Screen web apps" as a normative API contract — they are third-party technical blogs and one WebKit engineering blog on an adjacent topic (storage eviction policy, not partitioning per se). No official Apple/WebKit source found in this session directly and unambiguously confirms storage partitioning for the **current** iOS/WebKit version as of this research date. This corroborates, but does not upgrade, SEED-134's own `[ASSUMED — unverified]` framing from the `/gsd-explore` session. **This is consistent evidence that the auth-token-loss risk is real, not merely theoretical** — which validates D-02 (server-side `reminder_intent_at`) and D-15's "written while still authenticated in the tab" urgency as sound engineering against a plausible, not merely paranoid, failure mode. It does **not** change D-01's instruction: do not attempt to resolve this further, and do not gate planning on it.

## QR Library Research (HANDOFF-01, D-10)

`qrcode.react` is locked by CONTEXT D-10; this section verifies it rather than re-litigating alternatives.

| Property | `qrcode.react` (chosen) | `react-qr-code` (considered, rejected in discussion) |
|---|---|---|
| Latest version | 4.2.0 | 2.2.0 |
| Weekly downloads | 7,663,368 `[VERIFIED: npm registry via package-legitimacy check]` | 2,346,702 (WebSearch, not independently registry-verified this session) |
| Dependencies | **0** `[VERIFIED: bundlephobia.com/api/size]` | not verified this session |
| Gzip size | **6.05 KB** `[VERIFIED: bundlephobia.com/api/size, package qrcode.react@4.2.0]` — beats CONTEXT's own "~10KB" estimate | not verified this session |
| Output | SVG (also supports Canvas) | SVG |
| React peer range | `^16.8.0 \|\| ^17.0.0 \|\| ^18.0.0 \|\| ^19.0.0` `[VERIFIED: npm view qrcode.react peerDependencies]` — compatible with this project's React `^19.2.6` | not verified this session |
| ESM/CJS dual package | Yes, proper `exports` map with `.d.ts`/`.d.mts` types `[VERIFIED: npm view qrcode.react exports]` | not verified this session |
| Repo | `github.com/zpao/qrcode.react` `[VERIFIED: npm registry]` | not verified this session |
| Package age | Created 2014, latest release 2024-12-11 `[VERIFIED: npm registry `time` field]` | last publish 2026-06-09 (more recent) |

**Verdict: `OK`** via `gsd-tools query package-legitimacy check --ecosystem npm qrcode.react` — no red flags (no postinstall script, not deprecated, established repo, very high download count). Zero dependencies means no supply-chain surface beyond the package itself. Tree-shakeable via its `exports` map; two call sites (score screen + Settings) both importing the same named export satisfies knip.

**Rendering constraint (HANDOFF-01):** the QR must render fully offline/client-side — `qrcode.react` generates the SVG in-browser from the URL string with no network call, satisfying "no external QR image service... would leak the URL to a third party." A `<QRCodeSVG value={handoffUrl} />`-style API (exact prop name TBD at implementation time, not verified against the library's actual API surface in this session — the planner/executor should confirm the current export name via the package's own TypeScript types rather than assuming) is the shape to expect.

**Naming trap to flag for the plan/executor:** an unrelated, long-abandoned package literally named `qrcode-react` (hyphen, not dot — v0.1.16, ~1,144 weekly downloads, last meaningfully maintained years ago) exists on the npm registry and is easy to typo into. The locked dependency is **`qrcode.react`** (dot). Verify the exact string in `package.json` after `npm install` before committing.

## Package Legitimacy Audit

One new external package is added in this phase: `qrcode.react` (D-10, locked). Verified via `gsd-tools query package-legitimacy check --ecosystem npm qrcode.react` plus a direct `npm view` / bundlephobia cross-check this session.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|--------------|---------|-------------|
| `qrcode.react` | npm | Package created 2014 (11+ yrs); latest release (4.2.0) published 2024-12-11 | 7,663,368/week | `github.com/zpao/qrcode.react` | **OK** | Approved — install as a direct dependency, lazy-loaded per D-10 |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** none.

**Naming-collision note (not a legitimacy flag, a typo trap):** `qrcode-react` (hyphenated, unrelated, abandoned, ~1,144 weekly downloads) is a different, much lower-quality package that is easy to install by typo instead of the intended `qrcode.react` (dotted). Verify the exact package name in `frontend/package.json` after `npm install qrcode.react`.

The package's name was located via this session's direct `npm view`/registry queries (an authoritative source — the npm registry itself, cross-checked against CONTEXT.md's D-10 discussion which named it from the operator's own prior research), and its registry existence AND legitimacy signals (age, downloads, zero postinstall, zero dependencies) were independently confirmed via the `package-legitimacy check` seam this session — this clears the bar for `[VERIFIED: npm registry]` rather than `[ASSUMED]`, since the package name did not originate from an unverified WebSearch/training-data guess in this session (CONTEXT.md's D-10 already locked the choice before this research pass began; this research independently re-confirmed it against the live registry rather than merely trusting the locked decision).

## Architecture Patterns

### Recommended file/state ownership (no new files mandated beyond what CONTEXT.md's canonical_refs already lists)

```
frontend/src/hooks/useInstallPrompt.ts        # cooldown/attempt-cap rewrite (D-01,04,05); event-retention fix (D-04/INSTALL-04); isStandalone OR (INSTALL-05)
frontend/src/components/install/InstallPromptBanner.tsx   # Train-route suppression consumer (D-07); ?src=handoff override (D-11)
frontend/src/components/train/TrainReminderButton.tsx     # five-state resolution (OFFER-01..04); QR/install offer attachment (D-09); iOS button (D-14/D-15)
frontend/src/components/train/TrainScheduleSettings.tsx   # permanent QR home (HANDOFF-04), sibling to ReminderControls
app/models/train_settings.py                  # + reminder_intent_at column
alembic/versions/<new>_phase_203_reminder_intent.py
app/schemas/train.py                          # TrainSettingsResponse + TrainSettingsUpdate + reminder_intent_at
app/repositories/train_repository.py          # TrainSettingsRow + get_or_create_settings + upsert_settings
app/routers/train.py                          # GET/PUT /train/settings field mapping
```

### Pattern 1: Cooldown + attempt-cap as a pure function over injected state (Nyquist-testable seam)

**What:** Separate the *decision* ("should the drawer show right now, given this dismissal history and this clock") from the *storage read* (`localStorage.getItem`) and the *live capability* (`!!promptEvent`). A pure function taking `{ dismissedAt: number | null, attemptCount: number, now: number }` and returning `{ shouldShow: boolean, shouldStop: boolean }` is unit-testable without mocking `localStorage` or `Date.now()` inconsistently across tests.

**When to use:** Any time-windowed re-offer logic — this is the seam the Validation Architecture section below relies on to make INSTALL-01 mostly vitest-testable rather than HUMAN-UAT-only.

**Example (illustrative shape, not a copy-paste implementation — constant values TBD by the plan per D-04):**
```typescript
// Illustrative — NOT verified against an actual project file (this function does not exist yet).
const COOLDOWN_DAYS = 14; // D-04
const MAX_ATTEMPTS = 3;   // D-04

export function resolveCooldownState(
  dismissedAt: number | null,
  attemptCount: number,
  now: number,
): { shouldOffer: boolean; capped: boolean } {
  if (attemptCount >= MAX_ATTEMPTS) return { shouldOffer: false, capped: true };
  if (dismissedAt === null) return { shouldOffer: true, capped: false };
  const elapsedDays = (now - dismissedAt) / (1000 * 60 * 60 * 24);
  return { shouldOffer: elapsedDays >= COOLDOWN_DAYS, capped: false };
}
```

### Pattern 2: Structural suppression over cross-component ordering (INSTALL-03, D-07)

**What:** Rather than building a shared "who gets to interrupt right now" arbiter between the install drawer and `TrainReminderButton`, D-07 makes the collision impossible by route: the drawer checks `useLocation().pathname.startsWith('/train')` (reusing the exact predicate already at `[VERIFIED: frontend/src/App.tsx:127]`) and renders nothing on any Train route. `TrainReminderButton` never has to know the drawer exists.

**When to use:** Whenever two independent UI surfaces could theoretically compete for the same user attention and a shared coordination mechanism would be more complex than making the collision geometrically impossible.

### Pattern 3: Five-state resolution as a discriminated union, computed once

**What:** `TrainReminderButton` currently branches on a `ReminderButtonState` local-UI-state union (`'idle' | 'pending' | 'confirmed' | 'error'`) PLUS a separate cascade of early-return `null` conditions (lines 67-78) that implicitly encode "not eligible to show at all." OFFER-01 asks for five **named, explicit** states derived from `available` / `isStandalone` / `isIOS` / subscription state. The cleanest CLAUDE.md-compliant shape (nesting hard-4, logic-LOC soft-100/hard-200) is likely a small pure resolver function — `resolveReminderSlotState({ available, isStandalone, isIOS, subscribed }): 'desktop-unsubscribed' | 'android-unsubscribed' | 'ios-tabbed' | 'standalone-unsubscribed' | 'subscribed' | 'hidden'` — called once near the top of the component, with the render body switching on its output rather than re-deriving the same boolean cascade inline. This mirrors `TrainScheduleSettings.tsx`'s existing extraction of `ReminderControls` as a separate function to keep the parent's logic-LOC down (`[VERIFIED: frontend/src/components/train/TrainScheduleSettings.tsx:183-251]`).

### Anti-Patterns to Avoid

- **Do not conflate `isMobile` (UA-sniffed device class) with `useIsDesktop` (viewport-width `matchMedia`, 1024px breakpoint).** They answer different questions and D-06 explicitly wants the UA-based gate kept for the install drawer. See Common Pitfalls §4.
- **Do not read `navigator.standalone` without a type augmentation.** It will fail `tsc -b` under `strict: true` (not in `lib.dom.d.ts`).
- **Do not add a shared cooldown budget across the drawer and the Train-anchored offer.** D-08 is explicit and rejected this in discussion (Q4) — a swat on the Openings page must never burn the score-screen offer.
- **Do not add a persisted dismiss flag to the QR.** D-13 is an explicit, recorded deviation from HANDOFF-03's literal wording; "fixing" it by adding an X + flag reintroduces exactly the pattern the discussion rejected.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| QR code generation (Reed-Solomon encoding, masking, version selection) | A custom QR encoder | `qrcode.react` | D-10; explicitly rejected in discussion as "days of work and a permanent liability to avoid 10KB" |
| Feature-detecting push support | Ad-hoc `'PushManager' in window` checks scattered across new code | `isPushSupported()` from `frontend/src/lib/push.ts:42-44` | Already the single source of truth; reuse, don't duplicate |
| Requesting notification permission | Any new call site to `Notification.requestPermission()` | `ensureDeviceSubscribed()` in `frontend/src/lib/push.ts` (the ONLY call site, per its own module docstring) | One-shot, non-renewable browser resource; a second call site risks spending it in the wrong context |
| Debounced auto-save for a new draft field | A parallel debounce mechanism for `reminder_intent_at` | The existing `useDebounce`/`hasEditedRef` pattern in `TrainScheduleSettings.tsx`, OR the synchronous-write exception pattern already used for toggle-ON (lines 335-364) if `reminder_intent_at`'s write must be synchronous like D-15 requires | Two competing save mechanisms on the same settings object is exactly the "silent-lie state" the module docstring (lines 27-41) already warns against for the toggle |

**Key insight:** Every mechanism this phase needs a "don't hand-roll" answer for already has a single, documented implementation in this codebase. The risk here is not missing a library — it's building a second, slightly different version of something that already exists one file away.

## Common Pitfalls

### Pitfall 1: Forgetting the full-replace `PUT /train/settings` contract when adding `reminder_intent_at`

**What goes wrong:** Adding `reminder_intent_at` to `TrainSettingsUpdate` without updating both existing call sites (`TrainReminderButton.tsx:93-99`, `TrainScheduleSettings.tsx:298-304`) means every existing weekday/puzzle-count save either 422s (if the field is required) or silently clears the flag (if the payload omits it and the backend treats a missing full-replace field as "unset").
**Why it happens:** `TrainSettingsUpdate` is a full-replace shape by design (`app/schemas/train.py:219` docstring) — there is no PATCH semantics anywhere in this API.
**How to avoid:** Treat the field addition as touching exactly 5 backend files + 2 existing frontend call sites + however many new call sites the iOS button adds — the pattern is fully precedented by the Phase 201 `reminder_enabled`/`reminder_hour` addition (see Codebase Inventory §7).
**Warning signs:** A `422 Unprocessable Entity` on the weekday-chip or puzzle-count auto-save after this phase ships, or `reminder_intent_at` silently reverting to `NULL` on any unrelated settings save.

### Pitfall 2: Assuming `beforeinstallprompt` behaves identically to a native browser dialog dismissal

**What goes wrong:** The MDN-documented "event re-fires on next page navigation" behavior applies to a **page navigation** (full reload), not an SPA route change. A plan that assumes tapping "Not now" on the drawer and then navigating (client-side) to `/train` will yield a fresh `promptEvent` for a later install affordance is wrong — this is precisely INSTALL-04's bug.
**Why it happens:** "Navigation" is overloaded — in an SPA it colloquially means a route change, but the browser API's actual re-fire trigger is a real document reload.
**How to avoid:** Fix at the source: never null `promptEvent` on dismissal (only on successful install), per INSTALL-04. Do not attempt to "refresh" the event via any other mechanism — there isn't one.
**Warning signs:** A "confirmed"-state install offer button on `TrainReminderButton` that does nothing when clicked, after the user dismissed the drawer earlier in the same session.

### Pitfall 3: Missing the `navigator.standalone` TypeScript augmentation

**What goes wrong:** `navigator.standalone` is not in `lib.dom.d.ts` (confirmed absent from this project's configured `"lib": ["ES2022", "DOM", "DOM.Iterable"]`). Referencing it directly fails `tsc -b` (the project's `npm run build` step, per CLAUDE.md's "run tsc -b before integrating frontend" project-memory rule).
**Why it happens:** It's a long-standing Apple-only non-standard API that TypeScript's bundled DOM lib has never adopted.
**How to avoid:** Add a `declare global { interface Navigator { readonly standalone?: boolean } }` block (module augmentation file, or inline in `useInstallPrompt.ts`) before the first read.
**Warning signs:** `Property 'standalone' does not exist on type 'Navigator'` at build time — `npm run lint`/`npm test` (esbuild-based, type-stripping) will NOT catch this; only `tsc -b` will, per the project's own documented gotcha (CLAUDE.md / MEMORY.md `feedback_frontend_run_tsc_build`).

### Pitfall 4: Conflating `isMobile` (UA sniff) with viewport-based desktop detection

**What goes wrong:** The codebase already has a **different**, viewport-`matchMedia`-based `useIsDesktop()` hook (1024px breakpoint, `frontend/src/hooks/useIsDesktop.ts`) used elsewhere (e.g., `TrainReveal.tsx`'s spotlight interaction mode). `useInstallPrompt.ts`'s `isMobile` is a UA-string device-class check with no relationship to window width. D-06 explicitly wants the UA-based gate kept for install-drawer suppression on desktop. Swapping one for the other (e.g., "simplify by reusing `useIsDesktop`") would change behavior: a desktop browser window resized narrow would start showing the install drawer, which D-06 does not want (a resized-narrow desktop Chrome window still cannot install a phone-usable PWA in any way that helps Train reminders).
**Why it happens:** Both hooks superficially answer "is this a small/mobile context?" but for different purposes (UA = device install/notification capability; viewport = responsive layout).
**How to avoid:** Keep `isMobile` in `useInstallPrompt.ts` as its own UA-sniffed constant; do not import or reuse `useIsDesktop`.
**Warning signs:** The install drawer appearing on a resized desktop browser window, or NOT appearing on an actual phone in landscape orientation at a width that happens to clear 1024px (unlikely on real phones, but the point stands architecturally).

### Pitfall 5: Writing `reminder_intent_at` through the debounced draft path

**What goes wrong:** If the iOS tap's `reminder_intent_at` write rides `TrainScheduleSettings`'s existing 600ms-debounced draft mechanism (used for weekday mask, puzzle count, toggle-OFF, hour changes), the write could be lost if the user navigates away (e.g., to Safari's Share sheet for Add-to-Home-Screen) before the debounce fires — precisely the failure mode D-15 exists to prevent ("the tap IS the intent... guarantees it lands while the user is still authenticated").
**Why it happens:** The debounced-draft pattern is the path of least resistance since it's already wired for every other settings field.
**How to avoid:** Follow the toggle-ON precedent (`TrainScheduleSettings.tsx:335-364`) instead — an explicit, synchronous (awaited) `save()` call that fires immediately on tap, before rendering the Add-to-Home-Screen instructions, not folded into the debounced draft.
**Warning signs:** `reminder_intent_at` remaining `NULL` server-side for a user who tapped the iOS install button and then immediately backgrounded the tab to open the Share sheet.

## Code Examples

### 1. Cooldown constants as named exports (INSTALL-01, D-04 — values locked, shape illustrative)

```typescript
// Illustrative shape — file/location TBD by the plan (likely useInstallPrompt.ts).
// Values are LOCKED (D-04): do not default to different numbers.
const INSTALL_COOLDOWN_DAYS = 14;
const INSTALL_MAX_ATTEMPTS = 3;
```

### 2. `isStandalone` OR fix (INSTALL-05) — the literal current bug and its fix

```typescript
// CURRENT (frontend/src/hooks/useInstallPrompt.ts:50) — [VERIFIED, the actual bug]:
const isStandalone = typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches;

// FIX (illustrative — requires a Navigator.standalone type augmentation, see Pitfall 3):
const isStandalone =
  (typeof navigator !== 'undefined' && navigator.standalone === true) ||
  (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches);
```

### 3. Established `sessionStorage`-across-OAuth-redirect pattern (D-12) — copy this shape, not a new one

```typescript
// Source: frontend/src/pages/OAuthCallbackPage.tsx:34-43 (VERIFIED, read this session)
// This is the EXISTING pattern for a one-shot flag that must survive the OAuth round-trip.
if (promoted === '1') {
  localStorage.removeItem('guest_token');
  sessionStorage.setItem(
    'pending_toast',
    'Account created with Google. Your data is saved.',
  );
}
navigate('/', { replace: true });

// Source: frontend/src/App.tsx:557-562 (VERIFIED, read this session) — the consumption side,
// inside ProtectedLayout's mount effect ("the stable destination after the redirect chain").
useEffect(() => {
  const msg = sessionStorage.getItem('pending_toast');
  if (msg) {
    sessionStorage.removeItem('pending_toast');
    toast.success(msg);
  }
}, []);
```
D-12's `?src=handoff` marker should be captured on initial mount (before any redirect to Google is initiated) and consumed at this same `ProtectedLayout` mount point, following this exact shape rather than inventing a new sessionStorage convention.

### 4. Migration precedent to copy verbatim in shape (Codebase Inventory §7)

```python
# Source: alembic/versions/20260801_225358_ca8c8fbc2080_phase_201_train_reminder_columns.py
# (VERIFIED, full file read this session) — the exact shape for a new nullable
# train_settings column with no backfill.
def upgrade() -> None:
    op.add_column("train_settings", sa.Column("reminder_last_sent_on", sa.Date(), nullable=True))

def downgrade() -> None:
    op.drop_column("train_settings", "reminder_last_sent_on")
```
`reminder_intent_at` needs the same two lines with `sa.DateTime(timezone=True)` in place of `sa.Date()`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Engagement-heuristic gate on `beforeinstallprompt` firing (a minimum-visits/time threshold before Chrome fires the event) | Removed entirely — the only gates left are "already installed," "criteria unmet," "unsupported browser" | Documented by Chrome, exact version not pinned in sources found this session | A plan that assumes Chrome will withhold `beforeinstallprompt` from a first-time visitor is wrong; it fires immediately once install criteria (valid manifest, HTTPS, service worker) are met — consistent with D-03's observation that first-time mobile visitors DO see the drawer today |
| Apple Web Push requiring the paid Developer Program (legacy macOS proprietary APNs flow) | Standard VAPID-based Web Push on Safari 16.4+/iOS home-screen PWAs, no paid program | Safari 16.4 (2023) | Already fully absorbed by Phase 201/202 (REQUIREMENTS.md "Premises already settled"); not new to this phase, but load-bearing context for why the iOS install slice is worth building at all |

**Deprecated/outdated:** None specific to this phase beyond what Phases 201/202 already settled (no email channel, no Firebase dependency needed for push).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `beforeinstallprompt` does not re-fire specifically because a `preventDefault()`ed CUSTOM UI (as opposed to the native mini-infobar) was dismissed — no cooldown period is imposed by Chrome for this specific case | `beforeinstallprompt` Re-fire Semantics | Low — the design (D-04/D-05) already treats all cadence as owned by FlawChess's own `localStorage` state regardless of this answer; the fail-safe property (`!!promptEvent` gate) means a wrong assumption here just means the re-offer silently never appears, not a broken UI |
| A2 | iOS Safari-tab and standalone-PWA contexts do not share `localStorage`/`sessionStorage`/cookies on the same origin (multiple corroborating third-party sources, no single authoritative first-party Apple/WebKit confirmation found) | iOS Standalone Detection & Storage §2 | Already priced in by D-02 (server-side `reminder_intent_at`) and D-15 (synchronous authenticated write) — if storage turns out to be shared after all, the server-side flag is harmless redundancy per the seed's own framing; if isolated, the mitigation already exists |
| A3 | `navigator.standalone === true` combined with the `display-mode: standalone` media query correctly identifies an iOS home-screen-installed PWA across current iOS versions — no authoritative source found this session pinning exact iOS/WebKit version support for the media query on iOS specifically | iOS Standalone Detection & Storage §1 | Medium if wrong in one direction: an already-installed iOS user could still see the Add-to-Home-Screen banner (the exact bug INSTALL-05 exists to fix) if BOTH signals fail; low risk of a false positive (both signals are narrowly scoped) |
| A4 | The exact React component export name/prop API for the current `qrcode.react` 4.2.0 version (e.g., `QRCodeSVG`, `value` prop) was not independently verified against the package's own shipped TypeScript types in this session — only version, size, dependency count, and peer-range were registry-verified | QR Library Research | Low — a one-line API-surface check at implementation time (reading the installed package's `.d.ts` or its README) resolves this trivially; flagged so the plan does not hard-code an unverified prop name as if load-bearing |

**Risk-weighted note:** A1-A3 are all pre-declared as "not a gate" by CONTEXT.md D-01 and the amendment E "ship unverified, fail safe" instruction — they are recorded here for completeness and to satisfy the researcher's mandate to size the risk, not because the plan should attempt to resolve them further.

## Open Questions

1. **Exact `qrcode.react` v4.2.0 component API surface (export name, required props)**
   - What we know: package is registry-verified, React-19-compatible, zero-dependency, 6.05KB gzip.
   - What's unclear: the precise TypeScript export name and prop shape at implementation time (not independently confirmed against shipped types this session — see Assumption A4).
   - Recommendation: a trivial one-line check (`grep` the installed package's `.d.ts`, or the package README) at plan/implementation time; not worth a research round-trip.

2. **Whether the iOS re-surface prompt (D-16/OFFER-05) should live as a new dedicated component or fold into an existing Train landing state**
   - What we know: `TrainStartScreen` already has multiple named landing states (per `Train.tsx`'s module docstring referencing a 'completed' landing state); the re-surface must be "visible outside the score-screen context" and "clear itself once the device subscribes or the user dismisses."
   - What's unclear: whether this is best implemented as a new landing-state branch inside `TrainStartScreen`, a standalone banner mounted above it, or a route-level redirect-plus-toast — CONTEXT.md leaves the exact UI shape to the plan (it specifies behavior, not component boundaries).
   - Recommendation: plan-time decision; the existing `TrainStartScreen` multi-state pattern (referenced but not fully read in this research pass — a full read of `TrainStartScreen.tsx` is recommended at plan time) is the natural extension point given the "own plan, last" isolation (D-17) already separates this from the rest of the phase.

## Environment Availability

No new external tools, services, or CLIs are required. This phase adds one npm dependency (`qrcode.react`, verified above) installed via the project's existing `npm install` flow — no new infrastructure, no new environment variable, no Docker service. The only real external dependency this phase carries (an iPhone/iPad for manual iOS verification) is explicitly NOT a blocker per CONTEXT.md D-01/D-17 — the iOS slice ships unverified by design, with the answer arriving passively from `push_subscriptions` post-deploy.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `qrcode.react` (npm) | HANDOFF-01 QR rendering | Not yet installed — will be added by this phase | 4.2.0 (verified current) | none needed, package is uncontested |
| Physical iPhone/iPad | Manual verification of the iOS install→standalone→auth branch | ✗ (operator has none, confirmed 2026-08-01/02) | — | Ship unverified per D-01/D-17; passive post-deploy signal via `push_subscriptions` iOS-standalone rows |

**Missing dependencies with no fallback:** none that block this phase's implementation or its own test suite.
**Missing dependencies with fallback:** iPhone/iPad — fallback is explicit, operator-approved, and already the phase's design (D-17: iOS slice isolated to its own last plan).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `^4.1.7` + `@testing-library/react` `^16.3.2` (frontend); `pytest` (backend, for the `reminder_intent_at` round-trip) |
| Config file | `frontend/vite.config.ts` (Vitest config colocated with Vite config, standard for this project); `pytest.ini`/`pyproject.toml` (backend, existing) |
| Quick run command | `cd frontend && npm test -- --run <path-to-test-file>` (frontend); `uv run pytest tests/test_train_router.py -x` or similar existing train test module (backend — exact file TBD, see below) |
| Full suite command | `cd frontend && npm test -- --run` (frontend); `uv run pytest -n auto` (backend) |

No dedicated `useInstallPrompt.test.ts` or `InstallPromptBanner.test.tsx` exists yet (`[VERIFIED: no matches for "install" in any frontend/src/**/__tests__ directory this session]`) — this phase is greenfield for install-prompt test coverage specifically, though the matchMedia-mocking convention (`Object.defineProperty(window, 'matchMedia', {...})`) is extremely well-established across ~30 existing test files in this codebase (`[VERIFIED: grep across frontend/src for "matchMedia" in __tests__ files]`) and should be reused verbatim rather than reinvented.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INSTALL-01 | Cooldown/attempt-cap arithmetic given injected `{dismissedAt, attemptCount, now}` | unit | `npm test -- --run useInstallPrompt` | ❌ Wave 0 |
| INSTALL-04 | Event retained on dismiss, nulled only on install-accepted | unit (mock `BeforeInstallPromptEvent`, assert `promptEvent` state across a simulated dismiss→later-render sequence) | `npm test -- --run useInstallPrompt` | ❌ Wave 0 |
| INSTALL-05 | `isStandalone` OR logic given mocked `navigator.standalone` / `matchMedia` combinations (4 truth-table cases) | unit | `npm test -- --run useInstallPrompt` | ❌ Wave 0 |
| INSTALL-06 | No install copy contains "notification"/"remind" on Android-tabbed drawer/offer text | unit (string assertion on rendered copy) | `npm test -- --run InstallPromptBanner` or `TrainReminderButton` | ❌ Wave 0 |
| INSTALL-03 / D-07 | Drawer renders `null` on any `/train/*` route | unit (render with a mocked `useLocation` returning a Train pathname) | `npm test -- --run InstallPromptBanner` | ❌ Wave 0 |
| OFFER-01 | Five-state resolver returns the correct named state for each of the 5×N input combinations | unit (pure function, no DOM) | `npm test -- --run TrainReminderButton` (or a dedicated resolver test file if extracted per Architecture Pattern 3) | ❌ Wave 0 |
| OFFER-02/03/04 | Correct offer (QR / install / none) attached per resolved state | unit (component test, mocked capability hook) | `npm test -- --run TrainReminderButton` | ❌ Wave 0 (extends existing `TrainReminderButton` test coverage — check for an existing test file before assuming greenfield) |
| HANDOFF-01/02 | `?src=handoff` marker construction in the QR URL; `sessionStorage` capture/consume round-trip | unit | `npm test -- --run` (marker-handling module, wherever D-12 places it) | ❌ Wave 0 |
| HANDOFF-04 | QR renders in `TrainScheduleSettings` card body | unit (component render + snapshot of the mount point) | `npm test -- --run TrainScheduleSettings` | ✅ (extend existing `TrainScheduleSettings.test.tsx` if present — not independently confirmed this session; check before assuming) |
| `reminder_intent_at` round-trip (D-02/D-15, backend) | `GET`/`PUT /train/settings` returns and persists the new field | integration (existing per-run-DB test pattern) | `uv run pytest tests/test_train_router.py -x` (exact filename not confirmed this session — locate the existing `TrainSettingsResponse` test coverage and extend it) | ✅ likely (backend test coverage for `TrainSettingsResponse`/`TrainSettingsUpdate` almost certainly already exists given REMIND-01/PERM-03 shipped in Phases 201/202 with passing verification; not independently opened this session) |

### Sampling Rate

- **Per task commit:** the relevant single test file (`npm test -- --run <file>` or a single `pytest` nodeid), per CLAUDE.md's own guidance on incremental commits.
- **Per wave merge:** full frontend suite (`npm test -- --run`) + full backend suite (`uv run pytest -n auto`).
- **Phase gate:** full pre-merge gate per CLAUDE.md (`ruff format`, `ruff check --fix`, `ty check`, `pytest -n auto -x`, frontend lint + test) before squash-merging to `main`.

### What is genuinely HUMAN-UAT-only

Per this phase's own explicit framing (browser-behavior heavy, much not unit-testable), the seam that separates automatable from HUMAN-UAT-only is: **anything requiring a real browser's `beforeinstallprompt` event, a real iOS device, or a real camera scanning a real screen is HUMAN-UAT; anything that is a pure function over injected capability flags, mocked `matchMedia`/`navigator`, or a mocked `BeforeInstallPromptEvent` object is vitest-testable.**

- **Vitest-testable (large surface, per Architecture Pattern 1/3):** cooldown/attempt-cap arithmetic, the five-state resolver function, `isStandalone` OR logic (mocked `navigator.standalone` + mocked `matchMedia`), `?src=handoff` marker construction and `sessionStorage` round-trip logic, Train-route suppression (mocked `useLocation`), copy-string assertions for INSTALL-06, the backend `reminder_intent_at` round-trip (real per-run-DB integration test, fully automatable).
- **HUMAN-UAT-only (small, isolated per D-17):**
  1. Real Chrome desktop/Android: does `beforeinstallprompt` actually re-fire on a later visit after our custom drawer is dismissed? (The risk sized in `beforeinstallprompt` Re-fire Semantics above — fails safe either way, per `useInstallPrompt.ts:54`'s existing `!!promptEvent` gate, so this is a nice-to-confirm, not a blocker.)
  2. Real iPhone: does the Add-to-Home-Screen → open standalone → grant permission flow actually work end to end? Does the user land logged in or logged out? (D-17's isolated last plan; explicitly deferred to post-deploy per D-01/amendment E.)
  3. Real phone camera: does the QR actually scan to a working URL, and does the Google SSO round-trip on a phone correctly preserve the `?src=handoff` marker through to `/train`? (`sessionStorage` mechanics are unit-testable per-step, but the end-to-end phone-scan-to-login flow is not.)
  4. Real standalone launch: does OFFER-05's auto-route-to-`/train`-plus-prompt actually fire correctly on a real installed PWA's cold launch (as opposed to a simulated `isStandalone` flag in jsdom)?

### Wave 0 Gaps

- [ ] `frontend/src/hooks/__tests__/useInstallPrompt.test.ts` — does not exist yet; covers INSTALL-01/04/05
- [ ] `frontend/src/components/install/__tests__/InstallPromptBanner.test.tsx` — does not exist yet; covers INSTALL-03/06, D-07/D-11
- [ ] Confirm whether `frontend/src/components/train/__tests__/TrainReminderButton.test.tsx` already exists (not checked in this research pass — Phase 202 shipped this component with presumably some coverage; locate and extend rather than assume greenfield) — covers OFFER-01..04
- [ ] Confirm whether `frontend/src/components/train/__tests__/TrainScheduleSettings.test.tsx` already exists — covers HANDOFF-04
- [ ] Locate the existing backend test file covering `GET`/`PUT /train/settings` (likely `tests/test_train_router.py` or similar, not independently opened this session) — extend for `reminder_intent_at`

*(Framework install: none needed — Vitest/pytest already configured project-wide.)*

## Security Domain

`security_enforcement` is not set in `.planning/config.json` — treated as enabled per default.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No new mechanism | This phase adds no new login path — the QR handoff explicitly routes through the EXISTING Google SSO flow (HANDOFF-02), never a new one |
| V3 Session Management | Marginal | The `?src=handoff` marker is not a session credential — it is a UX routing hint, explicitly NOT a token (HANDOFF-01 rejects a signed credential for exactly this reason). `sessionStorage` for the one-shot marker (D-12) is tab-scoped and expires with the tab, matching the existing `pending_toast`/`promote_intent` precedent |
| V4 Access Control | N/A | `reminder_intent_at` writes go through the existing authenticated `PUT /train/settings` endpoint (Bearer JWT), no new authorization surface |
| V5 Input Validation | Yes | The `?src=handoff` query param value should be validated as an exact string match (`=== 'handoff'`), not passed through as free-form data anywhere; `reminder_intent_at`'s Pydantic schema addition follows the existing `TrainSettingsUpdate` validation pattern (no new custom validator needed — a timestamp field written server-side or client-side-echoed has no injection surface) |
| V6 Cryptography | Explicitly rejected for v1 | HANDOFF-01/D-10's core security decision: NO signed token, NO credential in the QR — deliberately avoiding any crypto surface for v1 (a scannable credential on a monitor is the threat model named in the requirement itself: screen-share/shoulder-surf/photo account takeover) |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| QR code social-engineering (a malicious actor swaps a legitimate FlawChess QR image for one pointing elsewhere, e.g., in a screen-share or a printed handout) | Spoofing | Out of scope for v1 per the same reasoning as HANDOFF-01's own no-credential decision — the QR carries no credential, so a spoofed QR at worst phishes a login on a fake page, which is a general phishing risk not unique to this feature. Not a new attack surface this phase introduces beyond what "share a URL" always carries. |
| `?src=handoff` marker used as an unauthenticated trigger for unwanted behavior (e.g., an attacker crafts `flawchess.com/train?src=handoff` and sends it to a victim to force-suppress their install drawer or bypass their cooldown) | Tampering (of client-side UX state, not data) | Low severity — worst case is a UX nuisance (an unwanted install offer appears), not a data or auth compromise. `?src=handoff` never authorizes anything server-side; it only affects local drawer-visibility logic (D-11). No mitigation beyond noting this is intentionally low-stakes by design. |
| Auth-token loss on iOS storage-partition boundary leading to silent logout | Information Disclosure risk is LOW (no token leaks — it simply becomes inaccessible), but Denial-of-Service-to-the-user risk is real | D-02's `reminder_intent_at` server-side flag + D-15's synchronous authenticated write are the mitigation already designed into this phase; honest copy (D-14/decision-15 from the seed: "survives a forced re-login") is the user-facing mitigation for the case where this does occur |

## Sources

### Primary (HIGH confidence)
- Direct file reads this session: `useInstallPrompt.ts`, `InstallPromptBanner.tsx`, `TrainReminderButton.tsx`, `TrainScheduleSettings.tsx`, `push.ts`, `usePushCapability.ts`, `App.tsx` (relevant ranges), `OAuthCallbackPage.tsx`, `googleAuth.ts`, `train_settings.py`, the Phase 201 reminder-columns migration, `app/schemas/train.py` (relevant ranges), `app/repositories/train_repository.py` (relevant ranges), `app/routers/train.py` (relevant ranges), `useTrainSettings.ts`, `types/train.ts` (relevant ranges), `useIsDesktop.ts`, `TrainScoreScreen.tsx` (relevant ranges), `vite.config.ts` (relevant ranges), `tsconfig.app.json`.
- npm registry (`npm view`, `npm registry` JSON API) — `qrcode.react` version, peer deps, exports map, publish dates, downloads.
- `gsd-tools query package-legitimacy check` — `qrcode.react` OK verdict.
- bundlephobia.com API — `qrcode.react` gzip size and dependency count.

### Secondary (MEDIUM confidence)
- MDN: `BeforeInstallPromptEvent.prompt()`, "Trigger installation from your PWA" — single-use event, next-page-navigation re-fire semantics.
- Chrome for Developers blog: `update-install-criteria`, `a2hs-updates` — engagement-heuristic removal, mini-infobar behavior.
- web.dev: `articles/customize-install` — install criteria.
- netguru.com, magicbell.com, webkit.org/blog/14403 — iOS storage-partitioning corroboration (three independent sources, none an authoritative first-party Apple API contract).

### Tertiary (LOW confidence)
- A GitHub-issue-adjacent WebSearch snippet describing `beforeinstallprompt` re-firing "immediately" after a native dialog cancel — anecdotal, not the custom-UI-dismissal case this phase's design actually depends on; marked `[ASSUMED]` and not load-bearing (D-04/D-05's design does not depend on this being true or false).

## Metadata

**Confidence breakdown:**
- Standard stack (QR library): HIGH — registry-verified, package-legitimacy-checked, bundle-size-confirmed via an independent tool (bundlephobia), zero dependencies.
- Codebase inventory (existing hooks/components/backend files, exact line citations): HIGH — every citation in this document was read directly this session, not inferred from the seed or CONTEXT.md.
- `beforeinstallprompt` re-fire semantics: MEDIUM — spec-documented single-use + next-navigation re-fire is solid (MDN); the specific "does OUR custom-UI dismissal impose any additional cooldown" question remains genuinely undocumented, matching the seed's own prior finding.
- iOS storage partitioning: MEDIUM — multiple corroborating secondary sources, no single authoritative first-party confirmation found; explicitly not a gate per CONTEXT.md D-01, sized here for completeness only.
- Architecture patterns / don't-hand-roll / pitfalls: HIGH — derived directly from the read codebase, not speculative.

**Research date:** 2026-08-02
**Valid until:** ~30 days for the codebase-inventory content (stable until the next phase touches these files); ~7 days for the QR-library download/registry snapshot (fast-moving npm metrics, though the OK verdict itself is unlikely to flip); the two MEDIUM-confidence platform-behavior findings (`beforeinstallprompt` re-fire, iOS storage) have no natural expiry — they remain open until either an authoritative source is found or the passive post-deploy signal (D-16's `push_subscriptions` check) resolves them empirically.
