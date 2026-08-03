# Phase 203: PWA Install Re-prompting & Train-Anchored Install Offer - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-02
**Phase:** 203-pwa-install-re-prompting-train-anchored-install-offer
**Areas discussed:** Install trigger + cooldown, Surface consolidation, QR handoff shape, iOS slice

---

## Install trigger + cooldown

### Q1 — Demonstrated value before the first install offer (INSTALL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| 1 completed Train session | Tightest link between offer and reason to install; signal is Train-scoped | ✓ (later reversed) |
| Has imported games | App-wide, already fetched, but weaker value signal | |
| N completed sessions (N=3) | Strongest signal, smallest eligible population | |

**User's choice:** 1 completed Train session.
**Notes:** Reversed during the Surface consolidation area — see that section. Ended as CONTEXT D-03 (no value gate at all).

### Q2 — Cooldown constants (INSTALL-01)

| Option | Description | Selected |
|--------|-------------|----------|
| 14 days, 3 attempts | ~2 quiet weeks per dismissal, campaign closes in ~6 weeks | ✓ |
| 7 days, 3 attempts | Faster learning, but a week reads as pushy | |
| 30 days, 2 attempts | Maximum restraint; most users churn before attempt 2 | |

**User's choice:** 14 days, 3 attempts.
**Notes:** Both must ship as named constants (ROADMAP names this as a plan-time decision that must not be defaulted). → CONTEXT D-04.

### Q3 — How the globally-mounted banner learns the value signal

| Option | Description | Selected |
|--------|-------------|----------|
| Move mount to Train routes | No new requests; narrows reach | |
| Keep global, read server flag | Works everywhere; extra plumbing | |
| Keep global, localStorage marker | Cheapest; per-device and losable | ✓ (later moot) |

**User's choice:** Keep global, localStorage marker.
**Notes:** Made moot by the Q5 reversal — with no value gate there is no signal to read. The global mount at `App.tsx:613/638` stays unchanged. → CONTEXT D-05 area.

### Q4 — Shared or independent cooldown budget across surfaces

| Option | Description | Selected |
|--------|-------------|----------|
| Independent — offer not gated | Cooldown governs only the interrupting drawer | ✓ |
| Shared budget | One counter across both; simplest to reason about | |
| Independent, but capped too | Separate cap for the inline offer | |

**User's choice:** Independent — the Train confirmed-state offer is never gated.
**Notes:** → CONTEXT D-08.

---

## Surface consolidation

### Q5 — Does the global install drawer survive?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep both, retimed | Drawer behind the value gate + cadence; inline offer ungated | |
| Train-anchored only | Delete the global drawer; guts INSTALL-01/02 | |
| Keep both, drawer → inline | Drawer becomes a dismissible inline banner | |

**User's choice:** Free text — *"I feel like this is getting more complicated than it should be. Why not just show a QR code on the session complete screen (if the user is on desktop) to install the PWA on a phone?"*
**Notes:** Claude pushed back that the QR is desktop-only and does not address the Android-tabbed user, and raised two follow-ups (does the mobile drawer survive; is the QR standing or confirmed-state-only). User replied: *"When a user first accesses FlawChess on mobile, I'd still want the install drawer."* → drawer survives (CONTEXT D-03).

### Q6 — When the drawer fires, given first-time mobile visitors should see it

| Option | Description | Selected |
|--------|-------------|----------|
| On first mobile visit, keep cooldown | Reverts INSTALL-02; only the permanent dismissal is fixed | ✓ |
| Gate on import complete | Never lands on the Import progress screen; milder gate | |
| Keep completed-session gate | Strongest per-prompt value; excludes first-time visitors | |

**User's choice:** On first mobile visit, keep cooldown.
**Notes:** Claude flagged that this contradicts the Q1 answer and that a first-time mobile visitor is locked to the Import page by the route guard, so any session gate means days of silence. Recorded as a deliberate deviation from INSTALL-02 / ROADMAP SC1. → CONTEXT D-03.

### Q7 — Desktop `isMobile` gate (seed "defect 3")

| Option | Description | Selected |
|--------|-------------|----------|
| Keep suppressed — QR is the desktop path | Desktop PWA install does nothing for reminder timing | ✓ |
| Also offer desktop install | Marginal desktop push benefit; fourth surface, own copy | |

**User's choice:** Keep suppressed.
**Notes:** Reclassifies the seed's "defect 3" as correct behavior. → CONTEXT D-06.

### Q8 — INSTALL-03 ordering collision

| Option | Description | Selected |
|--------|-------------|----------|
| Suppress drawer on Train routes | One route check; makes the collision structurally impossible | ✓ |
| Suppress only on the score screen | Narrower; Settings toggle collision survives | |
| No suppression — accept overlap | Simplest; drawer can eat the "Remind me" tap | |

**User's choice:** Suppress drawer on Train routes.
**Notes:** → CONTEXT D-07. Later gains one documented exception (`?src=handoff`, D-11).

---

## QR handoff shape

### Q9 — Where the desktop QR renders

| Option | Description | Selected |
|--------|-------------|----------|
| Confirmed state only (seed B.5) | Peak intent, reads as a reward, one-session window | ✓ |
| Every desktop score screen | Maximum reach; permanent fixture competing with "Remind me" | |
| Standing, but collapsed | Reach without weight; third dismissal state | |

**User's choice:** Confirmed state only.
**Notes:** Pulled back from the user's own earlier "just show a QR on the session complete screen" instinct. → CONTEXT D-09.

### Q10 — QR library

| Option | Description | Selected |
|--------|-------------|----------|
| qrcode.react | SVG, ~10KB gzipped, zero-config, two call sites | ✓ |
| qrcode (generator) | More control; hand-written wrapper, canvas output | |
| Hand-rolled encoder | No dependency; days of work, permanent liability | |

**User's choice:** qrcode.react.
**Notes:** Lazy-load — desktop Train routes only, must stay off the mobile critical path. → CONTEXT D-10.

### Q11 — What `?src=handoff` actually does on arrival

| Option | Description | Selected |
|--------|-------------|----------|
| Marker overrides the suppression | Fires the drawer on `/train` and bypasses the cooldown | ✓ |
| Land on home, not /train | No special-casing; contradicts HANDOFF-02's literal wording | |
| Dedicated inline affordance on /train | Handoff-specific copy; a fourth install surface | |

**User's choice:** Marker overrides the suppression.
**Notes:** Without this the handoff is a no-op, since D-07 suppresses the drawer on exactly the route the QR lands on. → CONTEXT D-11.

### Q12 — Preserving the marker across Google SSO

| Option | Description | Selected |
|--------|-------------|----------|
| sessionStorage before redirect | Frontend-only, survives one redirect in one tab | ✓ |
| OAuth `state` / redirect-URI | Most robust; backend + FastAPI-Users change | |
| Accept the loss | Zero work; handoff silently does nothing in the common case | |

**User's choice:** sessionStorage before redirect.
**Notes:** Not in tension with the phase's distrust of browser storage — this must survive one redirect, not a tab→standalone transition. → CONTEXT D-12.

### Q13 — What HANDOFF-03 "dismissible" means concretely

| Option | Description | Selected |
|--------|-------------|----------|
| Score screen only, no persistence | An X that hides it for that render | |
| Persisted — never show again | Literal reading; another stored flag | |
| No dismiss control at all | Ignoring it is pressing Done; satisfied structurally | ✓ |

**User's choice:** No dismiss control at all.
**Notes:** Recorded as a deliberate deviation from HANDOFF-03's literal wording — the planner must not "fix" it by adding an X and a flag. → CONTEXT D-13.

---

## iOS slice

### Q14 — What fills the currently-`null` iOS-tabbed slot

| Option | Description | Selected |
|--------|-------------|----------|
| Button routing to the existing iOS banner | Visual parity, one branch, reuses shipped copy | ✓ |
| Inline instructions, no button | One fewer tap; standing unignorable text | |
| Keep rendering null | Drops OFFER-03; preserves the dead end | |

**User's choice:** Button routing to the existing Share → Add to Home Screen instructions.
**Notes:** Copy must carry seed decision 15's honest two-step, which survives a forced re-login. → CONTEXT D-14.

### Q15 — When `reminder_intent_at` is written

| Option | Description | Selected |
|--------|-------------|----------|
| On the iOS button tap | Lands while still authenticated in the tab | ✓ |
| Only after confirmed install | No reliable in-tab signal that A2HS happened | |
| On tap, with an explicit confirm | Users skip it; skipping loses the flag | |

**User's choice:** On the iOS button tap.
**Notes:** → CONTEXT D-15.

### Q16 — What OFFER-05's "proactively re-surfaced" means

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-route to /train + prominent prompt | Closes the two-session cliff properly | ✓ |
| Prompt only, no routing | Appears without its motivating context | |
| Wait for the next score screen | That is the cliff with a flag attached | |

**User's choice:** Auto-route to `/train` plus a prominent prompt.
**Notes:** Must clear itself once the device subscribes or the user dismisses. → CONTEXT D-16.

### Q17 — How the iOS slice is isolated (amendment E decision 13)

| Option | Description | Selected |
|--------|-------------|----------|
| Own plan, last in the phase | Everything before it ships without an iPhone | ✓ |
| Own plan, but earlier | Unverifiable slice ahead of verifiable value | |
| Spread across plans by file | Exactly what decision 13 rules out | |

**User's choice:** Own plan, last in the phase.
**Notes:** → CONTEXT D-17.

---

## Claude's Discretion

- Drawer copy (subject to INSTALL-06 — no notification promise off iOS).
- Whether the Android-tabbed confirmed-state offer differs in wording from the drawer.
- The `TrainReminderButton` five-state refactor shape.
- QR component location, pixel size, error-correction level.
- Placement of the QR home within the "Train schedule" card.
- Test strategy for UA sniffing / `navigator.standalone` / `beforeinstallprompt` under jsdom.
- Where `?src=handoff` consumption lives (hook, route loader, or the drawer).

## Deferred Ideas

- Demonstrated-value retiming of the install offer (INSTALL-02) — dropped by D-03; import-complete is the milder lever if drawer conversion disappoints.
- A signed one-time handoff token in the QR (seed C.9) — rejected for v1; an auth change, not a UX detail.
- Desktop PWA install offer (dropping the `isMobile` gate) — rejected in D-06.
- Whether the Train solve loop holds up on a mid-range phone (seed open question 5) — a measurement, its own slot.
- A per-device management list ("your devices") — still needs 201 D-05's deferred columns.
- Persisted QR dismissal — rejected in D-13.
