# Requirements: FlawChess v2.11 Train Solve Surface & Push Reminders

**Defined:** 2026-08-01
**Core Value:** Position-precise WDL analysis on the user's own games. Train is the surface that turns that analysis into practice — this milestone makes its solve screen readable enough to learn from, and makes the habit loop reach the user on the days the scheduler picked.
**Source:** SEED-131 (solve-screen legend + inline sideline exploration, `/gsd-explore` 2026-07-31), SEED-132 Phase A (push notifications, `/gsd-explore` 2026-08-01). No project-level research pass — both seeds carry locked decisions, named rejected alternatives, and per-file implementation anchors.

## Scope decisions taken at milestone start (2026-08-01)

- **SEED-132 Phase B is deferred**, not descoped-by-omission. Install promotion (desktop→phone QR handoff, Android `beforeinstallprompt`, the iOS install→revisit→permission path, and its dismissal-persistence rule) needs BrowserStack — the operator has no iPhone (confirmed 2026-08-01). Phase A is independently shippable and delivers the reminder to everyone who can already receive push without installing anything. The seed stays open in `.planning/seeds/`.
- **Order is 131 before 132.** SEED-131 is frontend-only with no migration and no external dependency; SEED-132 Phase A then runs without competing for the same files. The two are otherwise independent — no shared source files.
- **Nothing else joins the milestone.** The 999.x backlog (Password Reset) and SEED-133 (full 24-persona recalibration, deferred from v2.10) stay out.

## Premises already settled — do not re-derive

- **Installing the PWA is NOT a prerequisite for push** on desktop Chrome/Edge/Firefox or Android Chrome; the Push API is available to an ordinary tabbed site. The install-gates-push framing holds on **iOS only** (Safari 16.4+, home-screen PWA), which is exactly why iOS lives in the deferred Phase B.
- **Web Push has no vendor and no per-message cost.** Chrome's `fcm.googleapis.com` endpoint does *not* imply Firebase (no project, no server key, no GCP billing). Apple Web Push on Safari 16.4+ does *not* require the $99 Developer Program — that applied to the legacy macOS proprietary-APNs flow. VAPID is a self-signed JWT from a locally generated keypair.
- **Email was evaluated and rejected as a channel.** There is zero email infrastructure in the project (no SMTP, no Resend/SendGrid/Mailgun/`aiosmtplib`), so it would be built from scratch and would carry deliverability, domain-reputation, and unsubscribe-compliance surface that push does not. At ~1,500 messages/month it is also the channel that costs money.
- **Notification permission is a one-shot, non-renewable resource.** Chrome and Safari both hard-block re-prompting after a browser-level deny, with no in-app recovery. This is the entire justification for the custom pre-prompt indirection (PERM-01) and for the in-app master toggle outranking the hour picker (PERM-04).
- **The yellow-arrow problem is a display-language problem** and gets a display fix. Upstream puzzle curation was considered and rejected — no backend or puzzle-pool side effects for a rendering concern.

## Hard constraints (load-bearing)

- **Do NOT switch the service worker to `strategies: 'injectManifest'`.** `frontend/vite.config.ts:56` runs VitePWA in `generateSW` mode with a `workbox` block hand-tuned against four real production bugs: `navigateFallback: null` (so the SW never serves `index.html` for the OAuth callback, commit `b953abad`), `globIgnores` excluding all HTML (precaching `index.html` made installed Android PWAs launch a many-deploys-old shell), `*.wasm` and the ~44 MB Maia `*.onnx` excluded for the iOS Cache API ~50 MB limit, and a two-rule `runtimeCaching` order where `/api/*` NetworkOnly is registered first. `importScripts` keeps all of it untouched.
- **`pywebpush` is built on `requests`, which CLAUDE.md prohibits** ("always use `httpx.AsyncClient` — `requests` blocks the event loop"). This is a blocker to resolve in phase research, not an implementation detail: the three candidates (a maintained async web-push library, `pywebpush` in a threadpool executor, or hand-rolled VAPID JWT + `aes128gcm` payload encryption on `cryptography` over `httpx`) differ by an order of magnitude in size.
- **Both tracks carry mobile parity as a requirement, not a follow-up.** The solve screen has one shared board with the sidebar rendering below it on mobile.

## Open questions for phase research (deliberately not decided here)

1. **Which Stockfish instance powers inline exploration** — reuse the session-scoped, already-warm `useTrainGradingEngine` vs. mounting the Analysis page's Stockfish hook alongside it. Two concurrent WASM engines on one page runs into the mobile OOM history. The grading engine's API is search-task-shaped (`gradeMove`, `startGameMoveSearch`) while live exploration wants continuous MultiPV eval of an arbitrary FEN with cancel-on-position-change; check whether it can serve that without disturbing in-flight grading of the *next* puzzle, or whether a shared single engine with a priority queue is needed.
2. **The web-push library decision** behind PUSH-04 (see hard constraints).
3. **VAPID rotation policy** — rotation invalidates every existing subscription. Decide whether that is acceptable or needs a migration path (PUSH-03).
4. **Scheduler placement** — slots in beside `run_periodic_guest_cleanup` as another `asyncio.create_task` in `app/main.py:120`, but needs the REMIND-05 idempotency guard.

## v1 Requirements

### Reveal Board Legend (SEED-131 A)

- [x] **LEGEND-01**: Each reveal line box (Your move / Best move / Played in game) carries a small arrow glyph in that move's exact board-arrow color before the box title; a coincidence-merged box ("Your move / Best move") shows one glyph matching the single arrow actually drawn
- [x] **LEGEND-02**: Hovering or tapping a sidebar arrow glyph hides every other arrow and quality badge on the board, leaving only that box's move visible, and restores the full overlay on release/tap-away — tap-driven on touch, not hover-only
- [x] **LEGEND-03**: `inaccuracy`-tier alternatives render in the same green as `good`-tier ones, so yellow disappears from the reveal board; the line eval still discloses the eval drop for anyone who digs in
- [x] **LEGEND-04**: Alternatives get a compact "Also fine: Nc4, Rd8" sidebar row with the green arrow glyph that participates in the spotlight — SAN tokens only, no steppable lines and no full line boxes
- [x] **LEGEND-05**: The spotlight filter and the green recolor live in the pure `trainArrows.ts` overlay builder and are unit-tested, so a regression in either fails CI rather than only showing up on a board
- [ ] **LEGEND-06**: The legend glyphs and the tap spotlight work in the mobile below-board sidebar layout at 375px

### Inline Sideline Exploration (SEED-131 B)

- [x] **EXPLORE-01**: Post-solve, moving a piece on the shared board starts exploration immediately — no mode toggle to discover, no second board
- [x] **EXPLORE-02**: Exploration can start from a stepped-into line-box position, and the stepped prefix moves seed the exploration move list (the "why didn't my move work" flow)
- [x] **EXPLORE-03**: The moment exploration starts, the reveal boxes give way to a Stockfish engine-lines card plus a move list of the explored line, and the solution arrows clear — no Maia card and no FlawChess engine card
- [x] **EXPLORE-04**: The existing Solution button exits exploration and restores the full reveal state (boxes + arrows) alongside its current `solutionNonce` stepper reset
- [x] **EXPLORE-05**: Exploration state and any running engine search tear down cleanly on puzzle transition, Next, and unmount — no search outlives its position, and no exploration search disturbs grading of the next puzzle
- [x] **EXPLORE-06**: The Analyze button still deep-links to the full Analysis page unchanged, keeping Maia, the FlawChess engine, and whole-game context available there
- [ ] **EXPLORE-07**: The swap-to-analysis view renders correctly in the mobile below-board layout at 375px

### Push Infrastructure (SEED-132 A)

- [x] **PUSH-01**: A `push_subscriptions` table stores one row per device-per-browser, 1-to-many on `user_id` with a CASCADE FK, so a desktop subscription and a phone subscription expire independently
- [x] **PUSH-02**: A subscription returning `410 Gone` (or `404`) from the push service is pruned, so dead endpoints cannot accumulate and silently degrade fan-out
- [x] **PUSH-03**: A locally-generated VAPID keypair signs every send; the public key reaches the client at subscribe time, the private key lives only in `/opt/flawchess/.env` and is never committed, and rotation's effect on existing subscriptions is decided and documented rather than discovered
- [x] **PUSH-04**: The send path makes no blocking HTTP call from the event loop — CLAUDE.md's async-only constraint holds, and `requests` never enters the request or scheduler path
- [x] **PUSH-05**: No push vendor, Firebase SDK, or paid developer-program dependency is added — standard Web Push with VAPID only
- [x] **PUSH-06**: `push-sw.js` supplies the `push` and `notificationclick` handlers via `workbox.importScripts`, with the existing `generateSW` workbox config (navigateFallback, globIgnores, wasm/onnx exclusions, `/api/*` NetworkOnly ordering) unchanged

### Train Reminders (SEED-132 A)

- [x] **REMIND-01**: `train_settings` gains `reminder_enabled` and `reminder_hour` (default 18 local), defaulted through `get_or_create_settings` the same way the existing `weekday_mask` and `puzzles_per_session` fields are
- [x] **REMIND-02**: The scheduler ticks at least every 15 minutes, so half- and quarter-hour IANA offsets (India +5:30, Nepal +5:45, Chatham +12:45) still land on the user's chosen local hour
- [x] **REMIND-03**: A reminder fires only on a day the user's `weekday_mask` schedules, reusing `train_scheduler`'s existing day predicates rather than re-deriving weekday math
- [x] **REMIND-04**: A **send-time** check suppresses the reminder if the user already completed a session that day — someone who trains at 17:00 does not get the 18:00 reminder
- [x] **REMIND-05**: An "already sent today" guard makes the job idempotent, so a backend restart inside the tick window cannot double-send
- [x] **REMIND-06**: A user with several subscribed devices is handled by one explicit, documented fan-out rule (all devices vs. most-recently-active), not by accident
- [x] **REMIND-07**: Guests never receive reminders — guest games are never bulk-analysed, so guests have no puzzle pool and no Train feature to be reminded about
- [x] **REMIND-08**: A reminder can be triggered on demand in development without waiting for the real clock hour, since the background job has no request context and cannot read the `X-Dev-Clock-Offset-Minutes` header

### Reminder Permission UX (SEED-132 A)

- [x] **PERM-01**: After the user's first completed session, `TrainScoreScreen` shows a custom in-app pre-prompt with Yes / Not now; only the Yes path calls the real browser permission API
- [x] **PERM-02**: "Not now" stays recoverable and does not become a nag — the user is never pushed toward the one browser prompt that can permanently deny them
- [x] **PERM-03**: `TrainScheduleSettings` is the permanent fallback surface, hosting the master toggle and hour picker with the same auto-saving behavior as the existing pickers, so a user who declined can subscribe later
- [x] **PERM-04**: Turning the master toggle off silences reminders inside FlawChess without touching the browser permission grant, keeping the user reachable

### Install Re-prompting (SEED-134 A)

- [x] **INSTALL-01**: The permanent dismissal boolean in `useInstallPrompt` is replaced by a timestamped cooldown plus an attempt cap — re-offer after N days, at most M times, then stop for good — with N and M as named constants, not literals
- [x] **INSTALL-02**: The first install offer fires behind a demonstrated-value signal rather than the instant `beforeinstallprompt` arrives, so each prompt is worth more and each dismissal costs less [Superseded by Phase 203 CONTEXT.md D-03: the drawer keeps firing on first mobile arrival — arrival-timing is kept for reach; the demonstrated-value retiming is deferred and is the first lever to revisit if drawer conversion turns out poor.]
- [x] **INSTALL-03**: Where push and install are both available on the same device (Android tabbed), the permission grant comes first and the install offer second — the non-renewable ask is never spent on the re-offerable one
- [x] **INSTALL-04**: Dismissal keeps the captured `BeforeInstallPromptEvent` and moves only the cooldown state; the event is nulled solely after a successful install, so a later install affordance in the same SPA session is a live prompt rather than a dead no-op
- [x] **INSTALL-05**: `isStandalone` ORs `navigator.standalone` with the `display-mode: standalone` media query, so an already-installed iOS user stops being shown the Add-to-Home-Screen banner permanently
- [x] **INSTALL-06**: No install copy promises notifications on any platform except iOS — install gates push on iOS only; on Android, Chrome delivers push to an ordinary tabbed site

### Train-Anchored Install Offer (SEED-134 B, D)

- [x] **OFFER-01**: `TrainReminderButton` resolves five explicit, named states from `available` / `isStandalone` / `isIOS` plus subscription state, rather than the single state it has today
- [x] **OFFER-02**: The confirmed reminder state is the upsell surface — QR offer on desktop, install offer on Android tabbed — placed at peak receptiveness and at zero cost to ignore
- [x] **OFFER-03**: On iOS tabbed, where the capability guard renders `null` today and the user sees no button at all, the slot carries an install affordance routing into the existing Share → Add-to-Home-Screen instructions (203-01 landed the `reminder_intent_at` backend substrate this depends on; the actual iOS install affordance UI is Plan 04, per ROADMAP.md's per-plan breakdown)
- [x] **OFFER-04**: Any standalone unsubscribed user grants and reaches the confirmed state with no install offer attached
- [x] **OFFER-05**: After an iOS install, the reminder prompt is proactively re-surfaced on the next standalone launch, closing SEED-132's install → later visit → permission two-session cliff instead of hoping the user hunts for the button (203-01 landed the `reminder_intent_at` backend substrate this depends on; the re-surface banner itself is Plan 04, per ROADMAP.md's per-plan breakdown)

### Desktop→Phone Handoff (SEED-134 C)

- [x] **HANDOFF-01**: The QR encodes a plain URL carrying a `?src=handoff` marker and no credential of any kind — a signed one-time handoff token is rejected for v1, because a scannable credential rendered on a monitor is account takeover by screen-share, shoulder-surf, or photograph
- [x] **HANDOFF-02**: The scanning phone logs in through the existing Google SSO path, lands on `/train`, and the `?src=handoff` marker drives the install and reminder flow immediately
- [x] **HANDOFF-03**: The QR is dismissible and never blocking — a desktop-only user without a smartphone, or without the wish to use one, can ignore it permanently [Per Phase 203 CONTEXT.md D-13: satisfied structurally, not via a dismiss control or a persisted flag — the QR only ever appears in the one-session confirmed state (score screen) or as a row the user navigated to (Settings), so ignoring it costs nothing and no state needs to be stored.]
- [x] **HANDOFF-04**: `TrainScheduleSettings` carries a permanent, non-nagging home for the QR offer alongside the toggle and hour picker

## Future Requirements (deferred)

**SEED-132 Phase B — install promotion + iOS push**: superseded on 2026-08-02 by SEED-134 and promoted into **Phase 203** (INSTALL-01..06, OFFER-01..05, HANDOFF-01..04 above). The BrowserStack dependency that originally justified deferring it is now carried as Phase 203's blocking pre-planning research gate rather than as a reason to defer the work: whether `localStorage` survives the iOS Safari-tab → standalone transition is a design blocker, not a verification detail, because the auth token lives there and a PWA that launches logged out changes the iOS design entirely.

**Do not invert the order** — promotion-first would have shipped an install nag promising a notification feature that did not exist yet. Phase 201/202 shipped that feature first, which is what makes Phase 203 orderly.

Still deferred out of Phase 203:

- A signed one-time handoff credential in the QR URL (SEED-134 decision C.9) — would convert far better, but needs short TTL, single-use, and rate limiting, and should be scoped as an auth change rather than a UX detail
- Whether the Train solve loop (client-side Stockfish WASM grading) holds up on a mid-range phone — worth a measurement before promoting mobile hard, but not a gate on this phase

## Out of Scope

- **Email as a channel** — no infrastructure exists; push is strictly cheaper to build and operate, and does not cost money at this volume
- **Reminders for guests** — no puzzle pool exists for them
- **Any notification other than the Train session reminder** — no import-complete, no analysis-finished, no marketing pushes. Each additional notification type raises the revocation risk on a permission that cannot be re-requested
- **Switching the service worker to `injectManifest`** — see hard constraints
- **Backend or puzzle-pool changes for the legend work** — SEED-131 decision 3 rejected upstream curation
- **Maia or FlawChess engine cards in the inline exploration view** — SEED-131 decision 7; that is what the Analyze deep-link is for
- **Changes to the full Analysis page or the Analyze deep-link target** — SEED-131 decision 9
- **Deadline / loss-aversion reminder timing** ("your shield drops at midnight") — makes the notification about punishment rather than practice, and the shield already delivers the consequence
- **Adaptive or learned reminder timing** — more failure modes, and too little per-user history at current scale

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| LEGEND-01 | Phase 200 | Complete |
| LEGEND-02 | Phase 200 | Complete |
| LEGEND-03 | Phase 200 | Complete |
| LEGEND-04 | Phase 200 | Complete |
| LEGEND-05 | Phase 200 | Complete |
| LEGEND-06 | Phase 200 | Pending (375px browser pass unrun) |
| EXPLORE-01 | Phase 200 | Complete |
| EXPLORE-02 | Phase 200 | Complete |
| EXPLORE-03 | Phase 200 | Complete |
| EXPLORE-04 | Phase 200 | Complete |
| EXPLORE-05 | Phase 200 | Complete |
| EXPLORE-06 | Phase 200 | Complete |
| EXPLORE-07 | Phase 200 | Pending (375px browser pass unrun) |
| PUSH-01 | Phase 201 | Complete |
| PUSH-02 | Phase 201 | Complete |
| PUSH-03 | Phase 201 | Complete |
| PUSH-04 | Phase 201 | Complete |
| PUSH-05 | Phase 201 | Complete |
| PUSH-06 | Phase 201 | Complete |
| REMIND-01 | Phase 201 | Complete |
| REMIND-02 | Phase 201 | Complete |
| REMIND-03 | Phase 201 | Complete |
| REMIND-04 | Phase 201 | Complete |
| REMIND-05 | Phase 201 | Complete |
| REMIND-06 | Phase 201 | Complete |
| REMIND-07 | Phase 201 | Complete |
| REMIND-08 | Phase 201 | Complete |
| PERM-01 | Phase 202 | Complete |
| PERM-02 | Phase 202 | Complete |
| PERM-03 | Phase 202 | Complete |
| PERM-04 | Phase 202 | Complete |
| INSTALL-01 | Phase 203 | Complete |
| INSTALL-02 | Phase 203 | Complete |
| INSTALL-03 | Phase 203 | Complete |
| INSTALL-04 | Phase 203 | Complete |
| INSTALL-05 | Phase 203 | Complete |
| INSTALL-06 | Phase 203 | Complete |
| OFFER-01 | Phase 203 | Complete |
| OFFER-02 | Phase 203 | Complete |
| OFFER-03 | Phase 203 | Complete |
| OFFER-04 | Phase 203 | Complete |
| OFFER-05 | Phase 203 | Complete |
| HANDOFF-01 | Phase 203 | Complete |
| HANDOFF-02 | Phase 203 | Complete |
| HANDOFF-03 | Phase 203 | Complete |
| HANDOFF-04 | Phase 203 | Complete |

**Coverage:**

- v1 requirements: 46 total (31 from the milestone-start pass, +15 added 2026-08-02 with Phase 203)
- Mapped to phases: 46/46
- Unmapped: 0

---
*Requirements defined: 2026-08-01; extended 2026-08-02 (Phase 203, SEED-134)*
