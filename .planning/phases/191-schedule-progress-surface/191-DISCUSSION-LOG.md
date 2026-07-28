# Phase 191: Schedule + Progress Surface - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-27
**Phase:** 191-schedule-progress-surface
**Areas discussed:** Streak semantics, Badge & surfacing, Settings UI, Progress & celebrations

---

## Streak semantics

| Option | Description | Selected |
|--------|-------------|----------|
| ≥1 session/week (Recommended) | With no schedule, any week with ≥1 completed session extends the streak; a configured schedule tightens it | ✓ |
| Schedule required | No streak without a configured schedule | |
| Sessions-count based | Streak ignores weekday matching entirely | |

**User's choice:** ≥1 session/week

| Option | Description | Selected |
|--------|-------------|----------|
| Count-based week (Recommended) | Week counts if completed sessions ≥ scheduled days, any days; ad-hoc substitutes | ✓ |
| Strict scheduled-day match | Each scheduled session must itself be completed in its window | |
| Ad-hoc never counts | Only scheduled-day sessions count toward the streak | |

**User's choice:** Count-based week

| Option | Description | Selected |
|--------|-------------|----------|
| Streak + this-week hint (Recommended) | Settled streak number plus "This week: 1 of 2 sessions" line | ✓ |
| Optimistic include | Current week counts as soon as fulfilled | |
| Streak number only | No current-week detail | |

**User's choice:** Streak + this-week hint

| Option | Description | Selected |
|--------|-------------|----------|
| Compute from history (Recommended) | New GET /train/progress computes streak/counts on the fly from drill_sessions/drill_items; retroactive for free | ✓ |
| Stored streak counter | Column updated on completion/expiry; needs backfill | |
| You decide | Planner weighs query cost | |

**User's choice:** Compute from history
**Notes:** User requirement raised at area selection: "Some users have already started train sessions. We need to make sure those are shown as progress." Drove the compute-from-history choice.

### Flame-state amendment (user-proposed at wrap-up)

The user proposed unprompted: three streak states with different flame size/color (minimum, medium, maximum); each missed week reduces the state; the streak is only lost if the state was minimum and the week was missed — "This allows for some breaks without losing the streak."

| Option | Description | Selected |
|--------|-------------|----------|
| That model, start minimum (Recommended) | Fulfilled week: streak +1, state up (capped); missed week: state down, number frozen; missed at minimum: reset | ✓ |
| State from streak length | Flame derived from streak number with misses as a separate buffer | |
| Other mapping | Free-form | |

**User's choice:** That model, start minimum

| Option | Description | Selected |
|--------|-------------|----------|
| Frozen number, derived state (Recommended) | Absorbed missed week freezes the number; flame state derived by replaying weekly history (no stored column) | ✓ |
| Frozen number, stored state | Persisted flame column with rollover updates | |
| Absorbed weeks count | Absorbed weeks still increment the number | |

**User's choice:** Frozen number, derived state

| Option | Description | Selected |
|--------|-------------|----------|
| Flame, count from week 1 (Recommended) | Minimum flame lights after the first session; count appears from the first settled week (no literal "0" next to a lit flame) | ✓ |
| Literal '0' shown | Display "0" explicitly next to the minimum flame | |
| Count immediately at 1 | First session → streak 1 right away | |

**User's choice:** Flame, count from week 1
**Notes:** User asked: "the user should see a minimum streak with streak count 0 after completing their very first session" — resolved an ambiguity in the earlier this-week-hint decision toward settled-weeks-only counting.

---

## Badge & surfacing

| Option | Description | Selected |
|--------|-------------|----------|
| Count badge (Recommended) | Numeric badge ("12") on the Train nav item, desktop and mobile | ✓ |
| Dot only | Reuse the notification dot styling | |
| Dot on mobile, count on desktop | Two variants | |

**User's choice:** Count badge

**Surfacing beyond the badge:** the question (nav badge only vs Library-stats card vs you-decide) was interrupted; the user clarified in free text: "I don't think we need a train nav attention signal besides the waiting puzzles count on the train nav item." → badge-only, no dashboard card anywhere.

| Option | Description | Selected |
|--------|-------------|----------|
| Waiting or unfinished (Recommended) | Badge shows when a session is due-and-uncompleted or an open session has unsolved puzzles | ✓ |
| Scheduled days only | Only on configured weekday-picker days | |
| Any due material | Whenever any SR item is due, even off-schedule | |

**User's choice:** Waiting or unfinished

---

## Settings UI

| Option | Description | Selected |
|--------|-------------|----------|
| Gear icon + panel (Recommended) | Gear button on the start screen opening a settings panel | |
| Inline on start screen | Settings always visible on the start screen, no modal | ✓ |
| First-run setup + gear | Inline prompt on first visit, gear afterwards | |

**User's choice:** Inline on start screen (against the recommendation)

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-save on change (Recommended) | Debounced PUT per change, subtle saved indicator | ✓ |
| Explicit Save button | Staged changes with a Save commit | |
| You decide | Planner matches existing surfaces | |

**User's choice:** Auto-save on change

| Option | Description | Selected |
|--------|-------------|----------|
| Silent capture (Recommended) | Browser tz rides along invisibly on every save | ✓ |
| Show, not editable | Muted "Times in Europe/Zurich" transparency line | |
| Editable dropdown | Full IANA picker | |

**User's choice:** Silent capture

| Option | Description | Selected |
|--------|-------------|----------|
| Presets 6/12/18/24 (Recommended) | Segmented control, default 12 | ✓ |
| Stepper 4–30 | +/- stepper over a bounded range | |
| Full 1–50 input | Expose the whole backend range | |

**User's choice:** Presets 6/12/18/24

---

## Progress & celebrations

| Option | Description | Selected |
|--------|-------------|----------|
| Stats row above CTA (Recommended) | Horizontal stat row + this-week line above Start/Resume; settings below | ✓ |
| Cards grid below CTA | Start button stays the hero at top | |
| You decide | UI-spec arranges the three blocks | |

**User's choice:** Stats row above CTA

| Option | Description | Selected |
|--------|-------------|----------|
| Inline reveal upgrade (Recommended) | Comeback-hint slot becomes a celebratory banner with mini-board thumbnail | ✓ |
| Modal overlay | Dedicated celebration modal | |
| Defer to score screen | Ceremony batched at session end | |

**User's choice:** Inline reveal upgrade

| Option | Description | Selected |
|--------|-------------|----------|
| Score screen mount (Recommended) | Confetti bursts once as the score screen appears with a green rating | ✓ |
| After score count-up | Confetti a beat after the score settles | |
| You decide | Match the bot-win timing | |

**User's choice:** Score screen mount

| Option | Description | Selected |
|--------|-------------|----------|
| Two tailored states (Recommended) | Import CTA state + "All caught up!" celebratory state | ✓ |
| Tailored + shared frame | One empty-state component with slots | |
| You decide | Planner designs both | |

**User's choice:** Two tailored states

| Option | Description | Selected |
|--------|-------------|----------|
| Count only (Recommended) | Number + honest label; no list (un-park is a deferred v2 lever) | ✓ |
| Count + tooltip detail | Info popover explaining parked | |
| Browsable list | Scope creep into the deferred browse/un-park feature | |

**User's choice:** Count only

---

## Claude's Discretion

- Badge count source (lightweight, never composes a session) and refresh cadence
- Flame visuals (theme.ts constants), streak-lost/broken messaging, celebration and empty-state copy
- Progress endpoint response shape; streak-week replay as a pure `train_scheduler.py`-style function
- Open-session behavior when settings change mid-week (changes apply from next composition)
- Mini-board thumbnail rendering reuse for the "Flaw fixed!" banner

## Deferred Ideas

- Browsable parked/mastered lists + un-parking (SEED-037 v2 lever)
- Back-nav restoring the reveal from the analysis board (carried from 190.1, candidate seed)
- Reviewed-not-folded todos: WR-01 Tailwind axis label, 172 review findings, bitboard storage (all unrelated, third consecutive review)
