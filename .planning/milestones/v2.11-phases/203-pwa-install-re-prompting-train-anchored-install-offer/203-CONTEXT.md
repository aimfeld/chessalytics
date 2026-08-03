# Phase 203: PWA Install Re-prompting & Train-Anchored Install Offer - Context

**Gathered:** 2026-08-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Two tracks, one phase:

1. **Fix the install prompt we burn ourselves.** `useInstallPrompt.ts` writes a
   bare, no-expiry `'true'` to `localStorage` on dismissal and reads it as an
   absolute veto; it nulls the captured `BeforeInstallPromptEvent` on dismiss
   (which, in an SPA, cannot be replaced until a real page load); and
   `isStandalone` misses iOS entirely. INSTALL-01, INSTALL-04, INSTALL-05,
   INSTALL-06.
2. **Make the Train reminder opt-in the surface that routes users onto a
   phone.** `TrainReminderButton` grows from one state to five, the confirmed
   state carries the install/QR upsell, the currently-`null` iOS-tabbed slot
   gets an install affordance, and a dismissible desktop→phone QR handoff
   lands on the score screen and in `TrainScheduleSettings`. OFFER-01..05,
   HANDOFF-01..04.

**Mostly frontend, but NOT frontend-only.** Seed decision 14 (amendment E)
puts `reminder_intent_at` on `train_settings` unconditionally, so this phase
carries a migration plus the model/schema/router changes to round-trip it
through `GET`/`PUT /train/settings`. See "Artifact conflicts resolved" below —
the ROADMAP goal's "no backend change unless the iOS finding forces it" hedge
is superseded.

Out of scope: any signed/credentialed handoff token (seed C.9); switching the
service worker to `injectManifest` (SEED-132 decision 15); any notification
type beyond the Train reminder; weakening desktop push (SEED-132 A.1).

Requirements: INSTALL-01..06, OFFER-01..05, HANDOFF-01..04 (see
`.planning/REQUIREMENTS.md`).

</domain>

<decisions>
## Implementation Decisions

SEED-134 already locked the shape: re-prompting replaces permanent dismissal
(A.1), push before install where both exist (A.3), the confirmed reminder state
is the upsell surface (B.5), the QR carries no credential (C.8/C.9), and the
five-state machine is the real complexity (D.12). Those are NOT restated as
decisions — read the seed. The decisions below are what this discussion
resolved on top of it, including two places where it **overrides** the seed.

### Artifact conflicts resolved (read these first — they change what "done" means)

- **D-01: The "blocking pre-planning research gate" is LIFTED.** `ROADMAP.md`
  (Phase 203 § "Blocking research gate") and `STATE.md` still say planning is
  gated on verifying whether `localStorage` survives the iOS Safari-tab →
  standalone transition. SEED-134 **amendment E (decisions 13-16), committed
  later, reverses that**: ship the iOS branch on the unverified assumption,
  fail safe, and ask an iPhone owner to test after deploy. The researcher must
  **not** stall on this gate, and must not attempt to resolve it — the operator
  has no iPhone or iPad, and a desktop-Chromium test answers a different
  question (amendment E is explicit on this). The answer arrives passively:
  if iOS standalone devices never appear in `push_subscriptions` a few weeks
  post-deploy, the branch does not work.

- **D-02: The `reminder_intent_at` migration is unconditional, not contingent.**
  ROADMAP's goal line hedges it ("unless the iOS storage finding
  forces the reminder-intent flag server-side"); seed decision 14 does not.
  It goes on `train_settings` regardless of how the storage question resolves —
  harmless redundancy if storage is shared, and the thing that lets the flow
  resume after a forced re-login if it is not. **Do not substitute a
  `localStorage` flag for it.**
  — **Reversibility:** one-way — adds a column to `train_settings` and extends
  the `TrainSettingsResponse` / `TrainSettingsUpdate` contract that every
  existing full-replace `PUT` call site sends.

### The global install drawer (INSTALL-01..06)

- **D-03: The drawer keeps firing on first mobile visit; the retiming is dropped.**
  User's explicit call: *"When a user first accesses
  FlawChess on mobile, I'd still want the install drawer."* The drawer fires as
  soon as `beforeinstallprompt` arrives, exactly as today; only the permanent
  dismissal is fixed.
  **This is a deliberate, recorded deviation from INSTALL-02 and from ROADMAP
  SC1's "fires behind a demonstrated-value signal" clause.** The planner must
  not restore a value gate. The seed's A.2 argument (fewer prompts, each worth
  more) is knowingly traded for reach. Two supporting facts surfaced during
  discussion: a first-time mobile visitor has zero completed Train sessions and
  is locked to the Import page by the import-required route guard, so any
  session-based gate means they see nothing for days; and both candidate signals
  were rejected in turn (one completed session → too late; imported games →
  weaker than the pitch).
  Rejected: gate on import-complete (never lands on the Import progress screen,
  still "first visit" for most users) and gate on one completed Train session
  (strongest per-prompt value, but the population it excludes is the one the
  phase is trying to convert).
  **Action for the planner:** INSTALL-02 cannot be marked satisfied. Flag it in
  `REQUIREMENTS.md` as superseded by this decision rather than silently leaving
  it Pending.

- **D-04: Cooldown = 14 days, cap = 3 attempts, then stop for good.** Both named
  constants, never literals (INSTALL-01, and ROADMAP names this as a plan-time
  decision that must not be defaulted). Rationale: a dismissal costs ~2 quiet
  weeks and the whole campaign closes in ~6 weeks, which is long enough not to
  nag and short enough that re-prompting actually gets exercised.
  Rejected: 7d/3 (faster learning, but a week reads as pushy after a deliberate
  dismissal) and 30d/2 (most users churn before attempt 2 ever fires, so
  re-prompting is never tested).

- **D-05: The cooldown + attempt state stays in `localStorage`.** This does not
  contradict D-02. An install is inherently per-device and per-origin, so
  per-device cadence state is correct; the *reminder intent* is the only flag
  that must bridge the tab→standalone boundary, which is why it alone goes
  server-side. Do not "consistency-fix" the cooldown onto the server.

- **D-06: Keep the `isMobile` UA gate — desktop never sees an install drawer.**
  SEED-134 lists the desktop suppression as "defect 3". It is not a defect. The
  phase exists to get FlawChess onto a *phone*; a desktop PWA install does
  nothing for reminder timing. The real gap defect 3 named — no desktop→phone
  bridge — is what the QR fills.
  Rejected: dropping the gate so desktop gets its own install offer (marginally
  helps desktop push delivery, but it is orthogonal to the goal, adds a fourth
  surface, and needs its own copy).

- **D-07: The drawer is suppressed on all Train routes.** This is how INSTALL-03
  ("grant push first, offer install second") is satisfied — not with a
  cross-component ordering machine, but by making it structurally impossible for
  the drawer to sit on top of, or steal a tap from, the "Remind me" button, the
  score screen, or the Settings toggle. One route check at the mount site.
  Rejected: suppressing only on the score screen (the Settings toggle is also a
  permission entry point per 202 D-06, so the collision survives) and accepting
  the overlap (a drawer over the confetti/score moment is exactly the
  interruption 202 D-01 was designed to avoid).

- **D-08: The cooldown and attempt cap govern ONLY the interrupting drawer.**
  The Train confirmed-state install offer is independent and never gated by
  them. It is user-summoned (they just tapped "Remind me"), inline, and costs
  nothing to ignore — seed B.5's framing — so suppressing it on the strength of
  an unrelated drawer dismissal would kill the highest-intent surface in the
  phase. Accepted: a user who capped out at 3 drawer dismissals still sees the
  inline offer.
  Rejected: a shared budget (a swat on the Openings page would silently burn the
  score-screen offer that is the point of the phase) and a second independent cap
  for the inline offer (a second cadence machine for a surface that never
  interrupts).

### Desktop → phone QR handoff (HANDOFF-01..04)

- **D-09: The QR renders only in the confirmed state on the score screen**, plus
  its permanent home in `TrainScheduleSettings` (HANDOFF-04). It appears beneath
  / in place of the "Reminders on — 18:00 on your training days" span, i.e. only
  in the session where the user just granted push. Peak intent, reads as a
  reward, and the score screen keeps ending cleanly for everyone else.
  Accepted cost: a one-session window — a desktop user who granted reminders on
  an earlier visit only ever meets the QR in Settings.
  Rejected: a standing QR on every desktop score screen (the user's own first
  instinct — maximum reach, but a permanent fixture competing with "Remind me"
  for the same moment, shown after every session to a desktop-only user) and a
  collapsed "use FlawChess on your phone" line that expands (reach without
  weight, but adds a third dismissal state).

- **D-10: `qrcode.react`** — SVG output, ~10KB gzipped, two call sites so knip is
  satisfied. Lazy-load it: it only ever mounts on desktop Train routes, so it
  must stay off the mobile critical path.
  Rejected: the lower-level `qrcode` generator (hand-written wrapper, canvas
  output is worse for a light/dark-themed page) and a hand-rolled encoder
  (Reed-Solomon + masking + version selection is days of work and a permanent
  liability to avoid 10KB).

- **D-11: `?src=handoff` overrides D-07 suppression AND bypasses the D-04 cooldown.**
  Without this the handoff is a no-op: the QR lands the
  phone on `/train`, which is precisely where D-07 suppresses the drawer. The
  marker is an explicit "I came here to install" signal, so a prior dismissal on
  that phone is irrelevant. One extra branch in the drawer's visibility logic;
  the suppression rule gains one documented exception.
  Rejected: encoding `/?src=handoff` so the phone lands outside Train and the
  normal drawer fires (simplest, but contradicts HANDOFF-02's literal "lands on
  `/train`" and drops the user somewhere disconnected from what they were doing)
  and a dedicated inline affordance on `/train` (a fourth install surface with
  its own copy and dismissal).

- **D-12: The marker survives Google SSO via `sessionStorage`.** The scanning
  phone is almost certainly logged out, and the OAuth redirect drops the query
  param. Capture `src=handoff` on first load, write it to `sessionStorage`,
  consume it after the login round-trip. Purely frontend; **no auth change**.
  Note this is not in tension with the phase's distrust of browser storage: it
  must survive one redirect inside one tab, not a tab→standalone transition.
  Rejected: threading it through the OAuth `state` / redirect-URI (most robust,
  but backend + FastAPI-Users territory, and the seed kept auth out of scope)
  and accepting the loss (the phone lands on `/train` post-login where the
  drawer is suppressed, so the handoff silently does nothing in the common case).

- **D-13: The QR carries no dismiss control at all.** It is inline, non-blocking,
  and vanishes with the score screen — ignoring it is pressing Done. HANDOFF-03's
  "permanently ignorable" is satisfied *structurally* (the confirmed state is
  already one-session-only, and the Settings home is a row the user navigated to,
  not an offer) rather than by a stored flag.
  **This is a deliberate deviation from HANDOFF-03's literal "dismissible"
  wording** — the planner must not add an X and a persisted flag to "fix" it.
  Rejected: an X with a persisted never-show-again flag (another stored dismissal
  for a surface that already self-limits, and per-device storage does not mean
  "never again" anyway).

### The iOS slice (OFFER-03, OFFER-05, amendment E)

- **D-14: The iOS-tabbed slot gets a button in the same shape as "Remind me"** —
  `brand-outline`, same slot, same row — but tapping it surfaces the existing
  Share → Add to Home Screen instructions (`InstallPromptBanner.tsx:47-69`)
  instead of calling `requestPermission()`, which does not exist on iOS in a tab.
  Visual parity across platforms, one new branch, reuses shipped copy.
  **The label and body must carry the honest two-step** (seed decision 15):
  "Add FlawChess to your home screen, then open it and turn on reminders" —
  which survives a forced re-login. "Add to home screen and you'll get
  reminders" does not, and must not be written.
  Rejected: inline instructions with no button (standing instructional text on
  every iOS user's score screen, unignorable, asymmetric with every other
  platform) and keeping `null` (drops OFFER-03 and preserves the exact dead end
  the seed set out to fix).

- **D-15: `reminder_intent_at` is written on the iOS button tap**, via
  `PUT /train/settings`, before the instructions render. The tap *is* the
  intent, and writing it there guarantees it lands while the user is still
  authenticated in the tab — the whole point, since it may have to survive a
  forced re-login in standalone. Accepted: curiosity taps that never install
  also record intent; harmless, the only consequence is an ignorable prompt.
  Rejected: writing only after a confirmed install (there is no reliable in-tab
  signal that an iOS Add-to-Home-Screen happened — the only place you learn it
  is the standalone launch, which is exactly where the flag needed to already
  exist) and a "Done, I added it" confirmation step (users skip it, and skipping
  silently loses the flag — the failure mode decision 14 exists to prevent).

- **D-16: OFFER-05's re-surface = auto-route to `/train` plus a reminder prompt.**
  On a standalone launch where `reminder_intent_at` is set
  and this device has no push subscription, route the user to `/train` and show
  a visible reminder prompt outside the score-screen context — do not make them
  finish a session first. That is the two-session cliff the requirement exists
  to close. The prompt must clear itself once the device subscribes or the user
  dismisses it.
  Rejected: prompting without routing (the standalone `start_url` may not be
  Train, so the prompt appears without its motivating context) and waiting for
  the next score screen (that is the cliff with a flag attached).

- **D-17: The iOS slice is its own plan, sequenced LAST in the phase.** Amendment
  E decision 13 requires a bad storage answer to cost one plan, not the phase.
  Everything before it — the cooldown fix, the event-nulling fix, the
  `isStandalone` OR, drawer suppression, the QR handoff, the Android
  confirmed-state offer — ships and is verifiable without an iPhone.
  Rejected: the same isolation sequenced earlier (puts the unverifiable slice in
  front of the verifiable value, and a revert then churns everything built on
  top) and grouping by file (exactly what decision 13 rules out).

### Still-locked seed items the planner must implement verbatim

Not re-litigated here, listed so they are not lost between the seed and the plan:

- **INSTALL-04** — on dismiss, KEEP the captured `BeforeInstallPromptEvent` and
  move only the cooldown state; null it solely after a successful install. The
  event is single-use per instance and is re-captured only on real page loads,
  which SPA route changes are not (`useInstallPrompt.ts:41` is the bug).
- **INSTALL-05** — `isStandalone` must OR `navigator.standalone` with the
  `display-mode: standalone` media query (`useInstallPrompt.ts:50`), or every
  already-installed iOS user keeps seeing the Add-to-Home-Screen banner forever.
- **INSTALL-06** — no install copy promises notifications on any platform except
  iOS. On Android, Chrome delivers push to an ordinary tabbed site (SEED-132
  A.2), so "install to get reminders" is false everywhere but iOS.

### Risk the researcher should size (not a gate)

Seed open question 2 — whether Chrome re-fires `beforeinstallprompt` on a later
visit after the user dismissed our `preventDefault()`ed custom UI — is
undocumented in both directions and the D-04 cooldown design rests on it.
**It fails safe as currently coded**: drawer visibility already requires a live
`promptEvent` (`useInstallPrompt.ts:54`), so if Chrome does not re-fire, the
re-offer simply never appears — there is no dead button. Worth a real-Chrome-
profile check if cheap, but it is not a blocker and must not become one.

### Claude's Discretion

- Drawer copy. Today's "faster load, full screen, offline assets" is generic and
  untied to Train value. Free to rewrite, subject to INSTALL-06 (no notification
  promise off iOS).
- Whether the Android-tabbed confirmed-state install offer differs in wording
  from the drawer, and whether it is a button or an inline line.
- The `TrainReminderButton` five-state refactor shape — per-state child
  components vs. inline branches. Note CLAUDE.md's nesting-depth (hard 4) and
  logic-LOC limits; the current single-state component is already at five
  early-return conditions.
- Where the QR component lives, its pixel size, and error-correction level.
- Placement of the QR home within the existing "Train schedule" card, relative
  to the toggle, hour picker, and weekday chips.
- Test strategy for UA sniffing, `navigator.standalone`, and
  `beforeinstallprompt` under jsdom.
- Whether the `?src=handoff` consumption lives in a hook, a route loader, or the
  drawer itself.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/SEED-134-pwa-install-reprompting-and-train-anchored-offer.md` —
  the locked decisions this phase implements. **Amendment E (decisions 13-16) is
  load-bearing and post-dates the ROADMAP entry** — read it before the roadmap's
  research-gate paragraph. Section A (re-prompting), B (Train-anchored offer),
  C (handoff), D.12 (the five-state table), the "Known defects in existing code"
  list, and "Implementation anchors" are all directly used above.
- `.planning/ROADMAP.md` § "Phase 203" — goal and the eight success criteria.
  **Two clauses are superseded**: the "Blocking research gate" paragraph (D-01)
  and the goal line's conditional-migration hedge (D-02). SC1's
  demonstrated-value clause is deviated from by D-03.
- `.planning/REQUIREMENTS.md` — INSTALL-01..06, OFFER-01..05, HANDOFF-01..04
  verbatim. INSTALL-02 (D-03) and HANDOFF-03's literal "dismissible" (D-13) both
  carry recorded deviations.
- `.planning/seeds/SEED-132-train-push-notifications-and-pwa-install-promotion.md` —
  decision A.1 (desktop push stays first-class), A.2 (install buys nothing for
  push on Android), 15 (`generateSW`, not `injectManifest`), and section F
  (why Phase B was originally deferred).

### Prior phase (what this phase anchors to)
- `.planning/phases/202-reminder-permission-ux/202-CONTEXT.md` — D-01 (visibility
  derived from live state, never from persisted decline history — the rule D-08
  extends), D-03 (the confirmed span this phase turns into the upsell surface),
  D-10 (why iOS tabbed renders nothing today), D-11 (denied → hide the button,
  disabled Settings row), D-12 (the `usePushCapability` VAPID gate), D-13 (inline
  error, permission spent).
- `.planning/phases/201-push-infrastructure-train-reminders/201-CONTEXT.md` —
  D-03 (unset VAPID keys = graceful disable, the default state on a fresh dev
  machine and in CI), D-05 (fan-out to all live subscriptions, which is why
  offers are per-device), D-18 (`reminder_enabled` / `reminder_hour` already on
  `GET`/`PUT /train/settings` — `reminder_intent_at` joins them).

### Project constraints
- `CLAUDE.md` § Frontend → Browser Automation Rules — `data-testid` on every new
  interactive element (`btn-*`), `aria-label` on icon-only buttons, semantic
  `<button>`.
- `CLAUDE.md` § Frontend → Code Style & Safety — `noUncheckedIndexedAccess`,
  `text-sm` floor, theme constants in `lib/theme.ts`, **knip in CI** (relevant to
  the new `qrcode.react` dependency and to any export removed by the refactor).
- `CLAUDE.md` § Frontend → UI & Components — primary = `variant="default"`,
  secondary = `variant="brand-outline"` (never `variant="secondary"`); apply
  every change to the mobile layout too.
- `CLAUDE.md` § Coding Guidelines — no magic numbers (D-04's constants),
  nesting hard limit 4, split before continuing past the LOC limits.
- `CLAUDE.md` § Database Design Rules — `reminder_intent_at` is a nullable
  timestamp on an existing table; follow the `train_settings` create-on-first-touch
  shape (no migration-time backfill).
- `.planning/STATE.md` — the API is Bearer-token auth (`localStorage.auth_token`),
  not cookies. This is *why* the iOS storage question was a design blocker at all,
  and why D-12's honest copy matters.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `frontend/src/hooks/useInstallPrompt.ts` — the whole re-prompting rewrite lands
  here. Current state: `ANDROID_DISMISS_KEY` / `IOS_DISMISS_KEY` bare booleans
  (8-9, 38-47), `setPromptEvent(null)` on dismiss (41), `isStandalone`
  media-query-only (50), `isMobile` UA gate (51, 54). 60 lines total — small
  enough to restructure cleanly rather than patch.
- `frontend/src/components/install/InstallPromptBanner.tsx` — the Android drawer
  (15-44) and the iOS instructional banner (47-69). D-14 routes the iOS-tabbed
  Train slot into that same iOS banner content; do not duplicate the copy.
- `frontend/src/components/train/TrainReminderButton.tsx` — the D.12 five-state
  machine. Confirmed span at 51-61 (D-09 attaches the QR here), capability guard
  at 67-78 (D-14 fills the iOS branch that currently returns `null`),
  `handleClick` at 80-119.
- `frontend/src/lib/push.ts` — the ONLY module allowed to call
  `Notification.requestPermission()` / `PushManager.subscribe()`; exports
  `isPushSupported`, `readPermission`, `ensureDeviceSubscribed`,
  `getDeviceSubscription`, `formatReminderHour`. Keep that single-call-site
  property intact.
- `frontend/src/hooks/usePushCapability.ts` — `isResolved` / `available` /
  `vapidPublicKey` / `permission`. The five-state resolution reads from here
  plus `isStandalone` / `isIOS` from `useInstallPrompt`.
- `frontend/src/components/train/TrainScheduleSettings.tsx` — the 600ms debounced
  draft, `hasEditedRef` mount guard, and `IndicatorState`. HANDOFF-04's permanent
  QR home goes in this card; D-15's `reminder_intent_at` write should reuse the
  existing `save` path rather than introduce a second writer.
- `frontend/src/components/ui/drawer.tsx`, `tooltip.tsx`, `button.tsx` — already
  used by the install surfaces.

### Established Patterns
- `frontend/src/App.tsx:613` and `:638` — the two `<InstallPromptBanner />` mount
  points (analysis-takeover layout and the default layout). D-03 keeps both;
  D-07's Train-route suppression is cheapest applied at these two sites or
  inside the component, not scattered.
- Phase 202's governing rule: **visibility derived from live state, never from
  persisted decline history** (202 D-01). This phase deliberately breaks it in
  exactly one place — the drawer's D-04 cooldown, which is cadence, not
  visibility-of-a-live-capability. The Train-anchored surfaces stay live-derived.
- `frontend/src/lib/queryClient.ts` — global `QueryCache.onError` /
  `MutationCache.onError` Sentry capture. Do not double-capture in new code.
- Existing Train test IDs: `btn-train-remind-me`, `train-reminder-confirmed`,
  `install-prompt-android`, `banner-ios-install`, `btn-install`,
  `btn-install-dismiss`, `btn-ios-install-dismiss`.

### Integration Points
- `app/models/train_settings.py` — `reminder_intent_at` column + Alembic
  migration; the table already carries `reminder_enabled` / `reminder_hour` with
  a `reminder_hour` CHECK.
- `app/schemas/train.py` (~L195-235) and `frontend/src/types/train.ts:129-141` —
  `TrainSettingsResponse` / `TrainSettingsUpdate` both need the new field, and
  `TrainSettingsUpdate` is a **full-replace** shape, so every existing `PUT` call
  site must send it (`TrainReminderButton.handleClick` at 93-99 and
  `TrainScheduleSettings`'s draft are the two today).
- `frontend/package.json` — `qrcode.react` is a NEW dependency; knip runs in CI.
- The Google SSO redirect path (D-12 reads/writes `sessionStorage` around it) —
  frontend only, no backend auth change.

</code_context>

<specifics>
## Specific Ideas

- The user's pushback mid-discussion reframed the phase: *"I feel like this is
  getting more complicated than it should be. Why not just show a QR code on the
  session complete screen (if the user is on desktop) to install the PWA on a
  phone?"* — and then, when told the QR only covers desktop: *"When a user first
  accesses FlawChess on mobile, I'd still want the install drawer."* Together
  those two lines are D-03 and D-06: the drawer stays, arrival-timed, for mobile
  only; the QR is the desktop path; the demonstrated-value machinery goes away.
  **The general instruction to the planner is to prefer the smaller mechanism.**
- The desktop QR was nearly made standing on every score screen (the user's first
  instinct) and was pulled back to the confirmed state only — keep it a reward,
  not a fixture.

</specifics>

<deferred>
## Deferred Ideas

- **Demonstrated-value retiming of the install offer** (seed A.2, INSTALL-02) —
  dropped by D-03, not lost. If drawer conversion turns out poor, or dismissal
  rates are high on first visit, this is the first lever to revisit: gate on
  import-complete (the milder of the two options discussed) before gating on a
  completed Train session.
- **A signed one-time handoff token in the QR** (seed C.9) — explicitly rejected
  for v1. Would convert far better by logging the phone straight in, but renders
  a scannable credential on a monitor. If revisited it needs short TTL,
  single-use, and rate limiting, and it is an auth change, not a UX detail.
- **Desktop PWA install offer** (dropping the `isMobile` gate) — rejected in D-06
  as orthogonal to the phase goal. Revisit only if desktop push delivery timing
  becomes a tracked problem.
- **Whether the Train solve loop holds up on a mid-range phone** (seed open
  question 5) — the grading step runs Stockfish WASM client-side, and driving
  users to mobile only pays if the session is pleasant there. This is a
  measurement, not an implementation task; it belongs in its own slot.
- **A per-device management list** ("your devices", last-seen labels) — carried
  over from 202's deferred list; still needs the `last_seen_at` / device-label
  columns 201 D-05 deferred.
- **Persisted QR dismissal** — rejected in D-13. Only revisit if the confirmed
  state stops being one-session-only.

### Reviewed Todos (not folded)
`gsd-tools query todo.match-phase 203` returned all three pending todos as
matches: the WR-01 Tailwind score-axis label (scored on `area: frontend`),
`172-deferred-review-findings` (generic "phase" keyword), and the
bitboard-storage note (generic "storage"/"games" keywords). None relate to
install prompts, push, or Train — same non-matches Phases 201 and 202 reviewed.
None folded.

</deferred>

---

*Phase: 203-pwa-install-re-prompting-train-anchored-install-offer*
*Context gathered: 2026-08-02*
