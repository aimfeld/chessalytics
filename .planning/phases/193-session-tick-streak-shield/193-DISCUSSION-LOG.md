# Phase 193: Session-Tick Streaks with a Depletable Shield - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-28
**Phase:** 193-session-tick-streak-shield
**Areas offered:** Shield + count presentation, Miss-day fairness gate, Pause / vacation control, Drain rate + carry-over
**Areas discussed:** Shield + count presentation, Miss-day fairness gate, Pause / vacation control

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Shield + count presentation | Ten levels isn't a flame — what replaces it, and what the count is called | ✓ |
| Miss-day fairness gate | Does a scheduled day with no material drain? Do off-day sessions credit? | ✓ |
| Pause / vacation control | What pause suspends, and its shape | ✓ |
| Drain rate + carry-over | Confirm the ~50% bar; hard-reset vs. replay of Phase 191's streak columns | |

---

## Shield + count presentation

### Q1 — How should the 10-level shield be rendered?

| Option | Description | Selected |
|--------|-------------|----------|
| Shield icon + "7/10" | Duolingo's freeze-count pattern, cited by the seed. Cheapest: one icon + label swap in `TrainProgressRow.tsx`, no new component | |
| 10-segment pip meter | Ten filled/empty segments. Buffer readable at a glance, depletion visually obvious. New small component; dense on mobile | ✓ |
| Flame + shield sub-badge | Keeps the 191 visual language; two symbols doing related jobs, conflates grace buffer with intensity | |

**User's choice:** 10-segment pip meter
**Notes:** Chosen over the cheaper numeric readout. Mobile density at ten pips is a known cost to solve in layout.

### Q2 — What should the streak number be labelled?

| Option | Description | Selected |
|--------|-------------|----------|
| "12 sessions" | Drops "streak" entirely — most honest under the absorb-a-miss mechanic | |
| "12-session streak" | Keeps streak framing, makes the unit honest. Same fudge Duolingo accepts for freezes | ✓ |
| "12-day streak" | Maximum familiarity, but wrong for anyone not training daily | |

**User's choice:** "12-session streak"
**Notes:** Seed gap #3 (the "streak" misnomer) knowingly accepted.

### Q3 — When does a completed session's tick land?

| Option | Description | Selected |
|--------|-------------|----------|
| Immediately on completion | Count + shield increment at once; score screen can celebrate. Kills 191's D-03 lit-flame-next-to-"0-week-streak" awkwardness. Makes the machine asymmetric (completions eager, misses lazy) | ✓ |
| At day rollover only | One uniform settle path, symmetric with 191. But delays the payoff a full day and reintroduces the display-overlay complexity | |

**User's choice:** Immediately on completion
**Notes:** Asymmetric settle accepted deliberately. Planner must ensure the eager and lazy paths cannot double-count a day.

### Q4 — How should the meter behave when the streak dies?

| Option | Description | Selected |
|--------|-------------|----------|
| Persistent notice, next read | Extends 191's existing `streak_lost_last_week` plumbing (already state-derived, already reload-safe). Empty meter + 0 count, no animation | ✓ |
| One-time drain animation | More emotionally legible, but needs a "seen it" flag plus `prefers-reduced-motion` handling | |
| Silent reset | Least punitive, fits the "never framed as failure" stance — but losing a 40-session streak silently reads as a bug | |

**User's choice:** Persistent notice, next read

---

## Miss-day fairness gate

### Q1 — Does a scheduled day with no trainable material drain the shield?

| Option | Description | Selected |
|--------|-------------|----------|
| No drain, no tick | The day is neutral. Needs a retrospective "was there material on day D" answer the current read-model can't give | ✓ |
| No drain, and it credits +1 | Most generous; risks making an empty pool a reward and cheapening the count | |
| Drain normally | Simplest — the machine never asks why a day was missed. Defensible given the seed's supply measurement, unfair to brand-new users | |

**User's choice:** No drain, no tick

### Q2 — How much bookkeeping should the fairness rule buy?

| Option | Description | Selected |
|--------|-------------|----------|
| Per-day judgement row (`train_day_log`) | Auditable forever, every past day's reason inspectable. New table + migration | |
| Cheap watermark only | One nullable date: never judge days before the user's first qualifying material. Covers the brand-new-user case at ~zero cost; does NOT cover a later exhausted stretch | ✓ |
| Derive from `drill_items` | Free, but blind to the fresh-flaw padding source (`game_flaws` has no arrival timestamp) — would under-report material | |

**User's choice:** Cheap watermark only
**Notes:** A user who masters everything and stops generating new blunders will drain and eventually lose the streak. Accepted as rare and arguably correct.

### Q3 — Does an ad-hoc off-day session tick?

| Option | Description | Selected |
|--------|-------------|----------|
| Never ticks (seed's stated rule) | One rule, count stays a clean measure of schedule adherence. No credit for genuine extra effort | |
| Credits shield, not count | Extra effort buys forgiveness, not inflated intensity — follows the seed's own locked shield/count split more faithfully than its flat rule does | ✓ |
| Credits both | Simplest to explain, but makes `weekday_mask` irrelevant to the streak | |

**User's choice:** Credits shield, not count
**Notes:** This **amends SEED-121**, which states flatly that unscheduled days never tick.

### Q4 — Started-but-unfinished session on a scheduled day?

| Option | Description | Selected |
|--------|-------------|----------|
| Miss — drains a pip | Only `status='completed'` ticks; unchanged from Phase 191, zero new logic | ✓ |
| Neutral — no drain, no tick | Softer, but gameable: open a session, solve nothing, never lose a pip | |

**User's choice:** Miss — drains a pip

---

## Pause / vacation control

### Q1 — What should pause suspend?

| Option | Description | Selected |
|--------|-------------|----------|
| Tick machine only | Narrowest blast radius; paused days never judged, everything else keeps running | ✓ (partial) |
| Tick machine + nav badge | Also silences the badge — more coherent "away" mode, but the badge is the entire attention mechanism (191 D-06) | |
| Everything incl. due dates | SR intervals are calendar-based by design; freezing them needs a bulk date-shift on resume | |

**User's choice:** "Tick machine only. And don't show the nav waiting puzzle count badge on off-days. We only want to 'nag' the user with the badge on scheduled session days."
**Notes:** The second half is a distinct request, not a pause-scope choice. Verified against the code: `frontend/src/App.tsx:162` / `:354` gate the badge on `waiting_count > 0` alone, with no day-of-week check anywhere — so today it nags every day. Folded into the phase as CONTEXT D-09.

### Q2 — What shape should the pause control take?

| Option | Description | Selected |
|--------|-------------|----------|
| Open-ended toggle | Simplest; risk of a user pausing, forgetting, and quietly stopping | |
| Pause until a date | Auto-resumes, matches how a holiday works; costs a date column + input | |
| Toggle + a nudge on return | Simple build, forcing function via copy | |

**User's choice:** "Don't add a pause training feature for now."
**Notes:** Pause dropped from Phase 193 scope entirely. SEED-121's gap #2 (calendar grace runs inversely to commitment) is knowingly accepted, not solved. Captured as a deferred idea with the partial design that had already emerged.

### Q3 — Badge gated to scheduled days: what about an open session on an off-day?

| Option | Description | Selected |
|--------|-------------|----------|
| Badge persists while open | Preserves 191 D-07's second clause verbatim; avoids stranding a half-done session with no cue | ✓ |
| Strict — hidden on off-days | One rule, simplest to test; but hides the one cue that could rescue an expiring session | |

**User's choice:** Badge persists while open

---

## Claude's Discretion

User explicitly declined the "Drain rate + carry-over" area and closed the discussion with "I'm ready for context". Left to research/planning:

- **Drain rate** — use SEED-121's symmetric ±1 (~50% attendance survival bar), cap 10. Do not tune by shrinking shield depth.
- **Carry-over of Phase 191's three streak columns** — hard-reset vs. replaying `drill_sessions` history, weighed against Phase 191 D-05 (retroactivity was an explicit user requirement) and bounded by the eligibility watermark.
- Fate of the "This week: N of M sessions" line once `required_sessions_per_week` is deleted.
- Pip colour banding / `theme.ts` constants replacing `TRAIN_STREAK_FLAME_*`.
- Exact trigger that stamps the eligibility watermark.
- Whether `streak_settled_through` stays a `Date` or is renamed now that it holds a day rather than a Monday.

## Deferred Ideas

- **Pause / vacation toggle** — dropped from this phase by the user. Seed gap #2 accepted as an open gap.
- **Per-day judgement log (`train_day_log`)** — rejected in favour of the cheap watermark; the natural upgrade if the watermark proves too coarse.
- **Drain −2 per miss (~67% bar)** — the seed's named tuning lever, to revisit once Train has real traffic.
