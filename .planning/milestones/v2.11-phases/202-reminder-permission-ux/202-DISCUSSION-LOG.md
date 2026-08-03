# Phase 202: Reminder Permission UX - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-02
**Phase:** 202-reminder-permission-ux
**Areas discussed:** Pre-prompt trigger & repeat rule, Pre-prompt shape & the Yes path, Toggle semantics & subscription lifecycle, Unsupported & blocked states

---

## Pre-prompt trigger & repeat rule

> **Largely superseded mid-discussion** by the persistent-button pivot in the
> next area. Recorded because the reasoning that survived (per-device
> visibility) came from here.

### Q1 — What exactly triggers the pre-prompt on TrainScoreScreen?

| Option | Description | Selected |
|--------|-------------|----------|
| First score screen this browser ever shows | Once-ever per-device flag (`useUserFlag`), no new server signal, survives a streak reset | ✓ |
| Literally the user's first-ever completed session | Truest to PERM-01, but nothing on the wire says this: `session_streak_count` resets on a break, `TrainProgressResponse` has no lifetime count. Needs backend work in a UI phase | |
| After the 2nd or 3rd completed session | More evidence the habit is real, but sessions are once-per-day → 2-3 calendar days before the retention loop can close | |

**User's choice:** First score screen this browser ever shows.
**Notes:** Superseded by D-01 — the persistent button needs no trigger flag at all.

### Q2 — After "Not now", is the pre-prompt shown again?

| Option | Description | Selected |
|--------|-------------|----------|
| Never again — Settings is the only path | Strictest reading of PERM-02; the toggle is always visible on the Train landing | ✓ |
| Once more after a long gap | 30 days / 10 sessions. Recovers reflexive dismissals, costs a threshold constant that is guesswork | |
| Never from the score screen, but nudge in Settings | A one-line hint next to the toggle so the fallback surface advertises itself once | |

**User's choice:** Never again — Settings is the only path.
**Notes:** Superseded by D-01. Kept in CONTEXT.md's deferred list so a future "re-ask after a gap" idea is not treated as new.

### Q3 — Second device: user enabled on phone, later finishes a session on desktop. Ask there?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, ask on each new device | `reminder_enabled` is account-wide but subscriptions are per-device; 201 D-05 fans out to all live subscriptions, so an unsubscribed desktop can never be reached | ✓ |
| No — `reminder_enabled = true` means already opted in | Avoids any sense of re-asking; cost is a permanently unreachable desktop | |

**User's choice:** Yes, ask on each new device.
**Notes:** This one **survived** the pivot and became D-05.

---

## Pre-prompt shape & the Yes path

### Q1 — How does the pre-prompt present itself? *(question withdrawn)*

Options offered: inline `Card` below the score badge / `Dialog` modal / inline
card delayed until the confetti settles.

**User's response:** rejected the question and asked instead —

> *"If it's non-blocking on the score screen after the train session, why not
> just always have a Reminder secondary button next to the Done button, in case
> Reminders are not active on the device?"*

**Assessment given:** taking it. It collapses the entire trigger/repeat state
machine (no once-ever flag, no `useUserFlag`, no re-ask rule) because
visibility becomes derived from live state rather than persisted history;
PERM-02 is satisfied trivially since a static button is not a nag; the
per-device rule falls out for free. **Cost flagged:** a bare button carries no
value proposition where a card could, so conversion likely drops.
**Tension flagged:** PERM-01 / ROADMAP SC1 literally say "pre-prompt with
Yes / Not now" — a button has no "Not now", so this needs recording as a
deliberate deviation rather than being discovered by the planner. Became D-01.

### Q2 — What happens when the user presses "Remind me"?

| Option | Description | Selected |
|--------|-------------|----------|
| Straight to the browser permission prompt | The press IS the pre-prompt; a second confirmation is a speed bump, not a safeguard. Deliberate deviation from PERM-01's literal wording | ✓ |
| Button opens a small explainer with Yes / Not now | Preserves PERM-01's literal shape and recovers the pitch, at one extra tap plus disclosure UI | |
| Button plus a one-line caption under it | Gets the pitch across without a two-step flow, but adds permanent text to a screen that ends cleanly on Done | |

**User's choice:** Straight to the browser permission prompt.

### Q3 — After a successful grant + subscribe, what does the score screen show?

| Option | Description | Selected |
|--------|-------------|----------|
| Button swaps to an inline confirmation | Names the hour ("Reminders on — 18:00 on your training days"); reuses the `Check`-icon "Saved" treatment. Acknowledges a spent one-shot permission and gives a thread to pull if 18:00 is wrong | ✓ |
| Button just disappears | Cleanest, but no acknowledgement at the moment the user is most likely to want to change the hour | |
| Toast notification | Non-permanent, no layout change; easy to miss right after the confetti, and the screen uses no toasts today | |

**User's choice:** Button swaps to an inline confirmation.

### Q4 — Visual weight of "Remind me" next to Done

| Option | Description | Selected |
|--------|-------------|----------|
| Quieter than Done — ghost/link with a bell icon | Done stays the prominent exit; reminders read as an offer | |
| Equal weight — both `brand-outline` | Symmetric, no new variant; but no signal which is the normal way out | |
| Leave it to the UI phase | Record the constraint, let `/gsd-ui-phase` settle the treatment | |

**User's choice:** *Other* — **"Make 'Done' a primary button, and 'Remind me' a
secondary (outline) button. The Done button should be on the right side."**
**Notes:** Flagged to the user that this reverses an existing documented
decision — `TrainScoreScreen.tsx`'s props docstring records Done as
deliberately `brand-outline` per SEED-122 ("it is an exit, not a call to
action"). That rationale held when Done was alone on the screen. Recorded as an
explicit override (D-04) so the planner does not restore the old variant.

---

## Toggle semantics & subscription lifecycle

### Q1 — Toggling ON with no permission granted

| Option | Description | Selected |
|--------|-------------|----------|
| Same path as the score-screen button — fire the browser prompt | One shared "ensure this device is subscribed" routine, two entry points; on denial the toggle springs back off with an explanation | ✓ |
| Toggle writes only `reminder_enabled`; a separate control subscribes | Honest about the two-layer model, but two controls where users expect one | |
| Toggle disabled until the device is subscribed | Unambiguous ordering, but a classic dead-end UI, and PERM-03 wants Settings to be the recovery path | |

**User's choice:** Same path as the score-screen button.

### Q2 — Toggling OFF: what happens to the `push_subscriptions` row?

| Option | Description | Selected |
|--------|-------------|----------|
| Keep the row; only flip `reminder_enabled` to false | PERM-04 verbatim — stay reachable; the 201 scheduler already gates on the flag; dormant rows are cleaned by PUSH-02's 410 prune | ✓ |
| Also DELETE the row via `POST /push/unsubscribe` | Cleaner data, but re-enabling needs a fresh subscribe and possibly a second trip through the one-shot permission | |
| Keep the row and call `PushSubscription.unsubscribe()` browser-side | Worst of both — the stored endpoint goes dead, so the row is a lie | |

**User's choice:** Keep the row; only flip `reminder_enabled`.

### Q3 — Hour picker control

| Option | Description | Selected |
|--------|-------------|----------|
| Radix `Select` with all 24 hours | `ui/select.tsx` exists; one line of vertical space, works at 375px, never forces a wrong hour (SEED-132 decision 7) | ✓ |
| Preset chips (9 / 12 / 18 / 21) | Visually consistent with the pickers above it, one tap; reintroduces the fixed-hour-lands-wrong problem | |
| Native `<select>` | Zero new surface, native mobile wheel; would be the app's only native select | |

**User's choice:** Radix Select with all 24 hours.

### Q4 — How the new fields ride the existing 600ms debounced draft

| Option | Description | Selected |
|--------|-------------|----------|
| Toggle ON awaits grant + subscribe, then joins the draft | Hour changes and toggle-OFF behave exactly like the weekday chips; the one async case never writes `true` on failure | ✓ |
| Toggle saves immediately, hour uses the debounce | Arguably right for a discrete action, but two save paths driving one indicator | |
| Everything through the debounce, permission in parallel | Simplest code, but the PUT can land before the prompt resolves → `reminder_enabled = true` with no subscription | |

**User's choice:** Toggle ON awaits grant + subscribe, then joins the draft.

---

## Unsupported & blocked states

### Q1 — No `PushManager` at all (iOS Safari outside standalone, old browsers)

| Option | Description | Selected |
|--------|-------------|----------|
| Hide both entirely | Nothing on the device can act on them; the iOS gap stays clean for SEED-132 Phase B rather than half-answered | ✓ |
| Hide the button, keep an explanatory Settings row | Surfaces the feature's existence, but the copy comes close to promising the unbuilt Phase B iOS flow | |
| Show both, let them fail | Rejected on its face | |

**User's choice:** Hide both entirely.

### Q2 — `Notification.permission === 'denied'`

| Option | Description | Selected |
|--------|-------------|----------|
| Hide the score-screen button; Settings shows a disabled row with the reason | The score screen must not carry a dead button; Settings is where "why don't I get reminders?" gets answered. Name the cause only, no un-block instructions | ✓ |
| Hide both, same as unsupported | One code path, but a user who denied months ago concludes the feature is broken | |
| Show both and explain on press | Teaches the user the button is a dead end, once per score screen, forever | |

**User's choice:** Hide the button; disabled Settings row naming the cause.

### Q3 — VAPID unconfigured (the default on a fresh dev machine and in CI)

| Option | Description | Selected |
|--------|-------------|----------|
| Query the VAPID key up front; 404 hides both surfaces | `useQuery` with `staleTime: Infinity`; the key is needed for `subscribe()` anyway. One path for "push unavailable here" | ✓ |
| Lazy — fetch only when the user presses | No request for users who never press, but the button is visible where it cannot work and fails after the user commits | |
| Build-time env flag | Zero runtime cost, but frontend/backend config can silently disagree and the backend already holds the answer | |

**User's choice:** Query the key up front; 404 hides both surfaces.
**Notes:** Consequence recorded in D-12 — a developer without keys in `.env` sees no reminder UI until `scripts/gen_vapid_keys.py` has been run. Must be stated in the plan's UAT setup.

### Q4 — Grant succeeded but `subscribe()` threw or the POST failed

| Option | Description | Selected |
|--------|-------------|----------|
| Inline error in place; permission spent, toggle stays off | Mirrors the component's existing "Couldn't save. Try again."; `reminder_enabled` never written true; Sentry via the global `MutationCache.onError` | ✓ |
| Distinguish Brave's `AbortError` with specific copy | Helpful when it fires, but error-name sniffing with Brave-specific guidance that will rot | |
| Generic toast, control unchanged | Least code; the toast competes with the confetti and leaves no lasting signal | |

**User's choice:** Inline error in place.

---

## Claude's Discretion

- Whether the hour picker is hidden or disabled when the master toggle is off.
- Exact copy and icon for the "Remind me" button and the D-03 confirmation line.
- Where the shared "ensure this device is subscribed" routine lives (hook vs. `lib/` module) and how it obtains the service worker registration.
- Whether the score-screen surface gets its own component file.
- Test strategy for `PushManager` / `Notification.permission` under jsdom; whether the base64url → `Uint8Array` conversion gets a unit test.
- Placement of the toggle + hour picker within the existing "Train schedule" card.

## Deferred Ideas

- A value-proposition pitch for the opt-in (the sentence a card would have carried) — revisit as a caption if conversion is poor, not as a dismissible card.
- Re-asking after a long gap (30 days / 10 sessions) — moot under D-01.
- Brave-specific `AbortError` guidance — revisit only if Sentry shows real users hitting it.
- A per-device management list ("your devices") — needs the `last_seen_at` / device-label columns 201 D-05 deferred.
- SEED-132 Phase B — install promotion, QR handoff, `beforeinstallprompt`, the iOS path. Deferred on a BrowserStack dependency.
