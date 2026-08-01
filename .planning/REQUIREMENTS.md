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

- [ ] **LEGEND-01**: Each reveal line box (Your move / Best move / Played in game) carries a small arrow glyph in that move's exact board-arrow color before the box title; a coincidence-merged box ("Your move / Best move") shows one glyph matching the single arrow actually drawn
- [ ] **LEGEND-02**: Hovering or tapping a sidebar arrow glyph hides every other arrow and quality badge on the board, leaving only that box's move visible, and restores the full overlay on release/tap-away — tap-driven on touch, not hover-only
- [ ] **LEGEND-03**: `inaccuracy`-tier alternatives render in the same green as `good`-tier ones, so yellow disappears from the reveal board; the line eval still discloses the eval drop for anyone who digs in
- [ ] **LEGEND-04**: Alternatives get a compact "Also fine: Nc4, Rd8" sidebar row with the green arrow glyph that participates in the spotlight — SAN tokens only, no steppable lines and no full line boxes
- [ ] **LEGEND-05**: The spotlight filter and the green recolor live in the pure `trainArrows.ts` overlay builder and are unit-tested, so a regression in either fails CI rather than only showing up on a board
- [ ] **LEGEND-06**: The legend glyphs and the tap spotlight work in the mobile below-board sidebar layout at 375px

### Inline Sideline Exploration (SEED-131 B)

- [ ] **EXPLORE-01**: Post-solve, moving a piece on the shared board starts exploration immediately — no mode toggle to discover, no second board
- [ ] **EXPLORE-02**: Exploration can start from a stepped-into line-box position, and the stepped prefix moves seed the exploration move list (the "why didn't my move work" flow)
- [ ] **EXPLORE-03**: The moment exploration starts, the reveal boxes give way to a Stockfish engine-lines card plus a move list of the explored line, and the solution arrows clear — no Maia card and no FlawChess engine card
- [ ] **EXPLORE-04**: The existing Solution button exits exploration and restores the full reveal state (boxes + arrows) alongside its current `solutionNonce` stepper reset
- [ ] **EXPLORE-05**: Exploration state and any running engine search tear down cleanly on puzzle transition, Next, and unmount — no search outlives its position, and no exploration search disturbs grading of the next puzzle
- [ ] **EXPLORE-06**: The Analyze button still deep-links to the full Analysis page unchanged, keeping Maia, the FlawChess engine, and whole-game context available there
- [ ] **EXPLORE-07**: The swap-to-analysis view renders correctly in the mobile below-board layout at 375px

### Push Infrastructure (SEED-132 A)

- [ ] **PUSH-01**: A `push_subscriptions` table stores one row per device-per-browser, 1-to-many on `user_id` with a CASCADE FK, so a desktop subscription and a phone subscription expire independently
- [ ] **PUSH-02**: A subscription returning `410 Gone` (or `404`) from the push service is pruned, so dead endpoints cannot accumulate and silently degrade fan-out
- [ ] **PUSH-03**: A locally-generated VAPID keypair signs every send; the public key reaches the client at subscribe time, the private key lives only in `/opt/flawchess/.env` and is never committed, and rotation's effect on existing subscriptions is decided and documented rather than discovered
- [ ] **PUSH-04**: The send path makes no blocking HTTP call from the event loop — CLAUDE.md's async-only constraint holds, and `requests` never enters the request or scheduler path
- [ ] **PUSH-05**: No push vendor, Firebase SDK, or paid developer-program dependency is added — standard Web Push with VAPID only
- [ ] **PUSH-06**: `push-sw.js` supplies the `push` and `notificationclick` handlers via `workbox.importScripts`, with the existing `generateSW` workbox config (navigateFallback, globIgnores, wasm/onnx exclusions, `/api/*` NetworkOnly ordering) unchanged

### Train Reminders (SEED-132 A)

- [ ] **REMIND-01**: `train_settings` gains `reminder_enabled` and `reminder_hour` (default 18 local), defaulted through `get_or_create_settings` the same way the existing `weekday_mask` and `puzzles_per_session` fields are
- [ ] **REMIND-02**: The scheduler ticks at least every 15 minutes, so half- and quarter-hour IANA offsets (India +5:30, Nepal +5:45, Chatham +12:45) still land on the user's chosen local hour
- [ ] **REMIND-03**: A reminder fires only on a day the user's `weekday_mask` schedules, reusing `train_scheduler`'s existing day predicates rather than re-deriving weekday math
- [ ] **REMIND-04**: A **send-time** check suppresses the reminder if the user already completed a session that day — someone who trains at 17:00 does not get the 18:00 reminder
- [ ] **REMIND-05**: An "already sent today" guard makes the job idempotent, so a backend restart inside the tick window cannot double-send
- [ ] **REMIND-06**: A user with several subscribed devices is handled by one explicit, documented fan-out rule (all devices vs. most-recently-active), not by accident
- [ ] **REMIND-07**: Guests never receive reminders — guest games are never bulk-analysed, so guests have no puzzle pool and no Train feature to be reminded about
- [ ] **REMIND-08**: A reminder can be triggered on demand in development without waiting for the real clock hour, since the background job has no request context and cannot read the `X-Dev-Clock-Offset-Minutes` header

### Reminder Permission UX (SEED-132 A)

- [ ] **PERM-01**: After the user's first completed session, `TrainScoreScreen` shows a custom in-app pre-prompt with Yes / Not now; only the Yes path calls the real browser permission API
- [ ] **PERM-02**: "Not now" stays recoverable and does not become a nag — the user is never pushed toward the one browser prompt that can permanently deny them
- [ ] **PERM-03**: `TrainScheduleSettings` is the permanent fallback surface, hosting the master toggle and hour picker with the same auto-saving behavior as the existing pickers, so a user who declined can subscribe later
- [ ] **PERM-04**: Turning the master toggle off silences reminders inside FlawChess without touching the browser permission grant, keeping the user reachable

## Future Requirements (deferred)

**SEED-132 Phase B — install promotion + iOS push** (stays in `.planning/seeds/SEED-132-*.md`, gated on BrowserStack):

- Desktop→phone QR handoff (a desktop page cannot install anything on a phone, and there is no SMS channel, so QR is the only option)
- Android `beforeinstallprompt` install nudge, framed as "train on the go" — **not** "so we can notify you", which would bait a permission desktop users have already granted
- The iOS path: Safari has no `beforeinstallprompt`, so installation can only be explained ("tap Share → Add to Home Screen") and the permission prompt is unavailable until the user is in standalone mode — install → later visit → permission, two sessions minimum with a drop-off cliff between them
- A dismissal-persistence rule so the install nudge cannot become a nag

**Do not invert the order** — promotion-first would ship an install nag promising a notification feature that does not exist yet.

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
| LEGEND-01 | Phase 200 | Pending |
| LEGEND-02 | Phase 200 | Pending |
| LEGEND-03 | Phase 200 | Pending |
| LEGEND-04 | Phase 200 | Pending |
| LEGEND-05 | Phase 200 | Pending |
| LEGEND-06 | Phase 200 | Pending |
| EXPLORE-01 | Phase 200 | Pending |
| EXPLORE-02 | Phase 200 | Pending |
| EXPLORE-03 | Phase 200 | Pending |
| EXPLORE-04 | Phase 200 | Pending |
| EXPLORE-05 | Phase 200 | Pending |
| EXPLORE-06 | Phase 200 | Pending |
| EXPLORE-07 | Phase 200 | Pending |
| PUSH-01 | Phase 201 | Pending |
| PUSH-02 | Phase 201 | Pending |
| PUSH-03 | Phase 201 | Pending |
| PUSH-04 | Phase 201 | Pending |
| PUSH-05 | Phase 201 | Pending |
| PUSH-06 | Phase 201 | Pending |
| REMIND-01 | Phase 201 | Pending |
| REMIND-02 | Phase 201 | Pending |
| REMIND-03 | Phase 201 | Pending |
| REMIND-04 | Phase 201 | Pending |
| REMIND-05 | Phase 201 | Pending |
| REMIND-06 | Phase 201 | Pending |
| REMIND-07 | Phase 201 | Pending |
| REMIND-08 | Phase 201 | Pending |
| PERM-01 | Phase 202 | Pending |
| PERM-02 | Phase 202 | Pending |
| PERM-03 | Phase 202 | Pending |
| PERM-04 | Phase 202 | Pending |

**Coverage:**

- v1 requirements: 31 total
- Mapped to phases: 31/31
- Unmapped: 0

---
*Requirements defined: 2026-08-01*
