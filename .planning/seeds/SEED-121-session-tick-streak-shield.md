---
id: SEED-121
status: open
planted: 2026-07-27
planted_during: /gsd-explore session during Phase 192 (v2.9 Train milestone), 2026-07-27. User asked whether the weekly streak model shipped in Phase 191 should switch to a daily model for stronger short-term motivation. Six exchanges converged on a third design that is neither: a per-session tick with a 10-level depletable shield.
trigger_when: Before v2.9 closes, if Phase 191's streak surface is still pre-production and the change is cheap; otherwise at the next Train-focused milestone. Also surface if Train retention data shows users losing streaks faster than expected, or if UAT feedback on 191 flags the weekly cadence as unmotivating. The SR-supply prerequisite is CLEARED (measured against prod 2026-07-27, see below) — nothing external now blocks this.
scope: phase (1-2 plans) — backend rewrite of the settle machine in `app/services/train_scheduler.py` (weekly settle -> per-scheduled-day tick), migration for the widened shield column, frontend swap of the 3-state flame for a 10-state meter, plus a pause/vacation toggle.
depends_on: Phase 191 (the streak machinery this replaces). No open blockers.
---

# SEED-121: Session-tick streaks with a 10-level depletable shield

Replaces Phase 191's weekly streak model with a per-session tick and a
10-level grace buffer. Not a parameter change: the tick size, the ladder
depth, the reset rule, and the meaning of the count all move together.

## The mechanism

- **Tick = one scheduled day** (a day whose bit is set in `weekday_mask`),
  not a calendar week and not a calendar day. Unscheduled days never tick.
- **Completed session**: shield +1 (capped at 10), streak count +1.
- **Missed scheduled day**: shield −1.
- **Shield reaches 0**: streak count resets to 0.

That is the whole rule. One mechanism replaces the weekly-fulfillment check,
the `required_sessions_per_week` popcount function, and the 3-rung flame
ladder.

## Why this beat the two models it was compared against

### vs. the shipped weekly model (Phase 191)

The weekly model's grace is denominated in weeks, which sounds generous but
hides two defects found by reading `app/services/train_scheduler.py` during
the session:

1. **The flame measures presence, not intensity.** With the
   `ALL_WEEKDAYS_MASK` default, `required_sessions_per_week` returns 1, so a
   user training 7x/week and one training 1x/week are indistinguishable —
   both sit at `maximum`. The level discriminates nothing for the default
   user, which is the user almost everyone is.
2. **A 1 -> 6 requirement cliff.** `required_sessions_per_week` special-cases
   both `0` and `ALL_WEEKDAYS_MASK` to 1, but a 6-bit mask falls through to
   `popcount` = 6. So unchecking a single day from the default multiplies the
   weekly requirement sixfold. The docstring justifies the `127` special case
   as *avoiding* a cliff; it is what *creates* this one (without it the
   sequence 7,6,5...1 would be smooth). This is a live wart in shipped code
   regardless of whether this seed is adopted — see the todo.

### vs. a plain daily streak

Daily is by far the more common pattern in the wild (Duolingo, Snapchat,
Apple Fitness, Headspace, BeReal, Wordle, chess.com's own daily-puzzle
streak); weekly streaks are rare and are usually framed as *goals* rather
than streaks. So daily wins on familiarity. But a bare daily counter
collapses the grace budget 7x, and the products that ship daily streaks
*without* forgiveness (Apple Fitness) are the ones users describe as
stressful. The dominant pattern is daily-plus-forgiveness: Duolingo's Streak
Freeze, Streak Repair, and Weekend Amulet.

The session-tick model is that pattern, generalized: it *is* a daily streak
for a user who trains every day, and it automatically stretches for users who
don't — a 1-day/week user gets 10 weeks of grace from the same 10-level
shield, with no second dial and no special-casing.

## Properties worth knowing before implementing

**Grace scales with stakes early, then flattens.** For the first 10 sessions
the shield and the count increment together, so a user with a count of 3 has
a buffer of 3 — proportional to what they'd lose. Past 10 the buffer caps
while the count keeps climbing, matching Duolingo's fixed 2 freezes
regardless of streak length. Traced explicitly during the session; the
"grace is back-loaded and punishes beginners" objection is wrong.

**It solves the intensity problem for free.** Because ticks are scheduled
days, the count accrues per *session* rather than per week. A 7-day/week
user's count races; a 1-day/week user's crawls. Count therefore measures
intensity while the shield stays a pure grace buffer — the exact split the
user asked for, without the extra settings control an earlier proposal in
the session needed.

**The effective bar is ~50% attendance.** Symmetric ±1 with a cap at 10 is a
bounded random walk: above 50% attendance it drifts up and the streak
essentially never dies; below 50% it drifts down and dies on a predictable
schedule; at exactly 50% it is recurrent but slow (expected hitting time from
10 is ~100 ticks). Unusually explainable as a rule, but far more forgiving
than anything else considered — confirm it is the intended bar.

**Tuning lever if 50% is too soft:** drain 2 per miss (threshold moves to
~67%), or refill 1 per 2 completed sessions. Do not tune by shrinking the
shield depth; that reintroduces the grace-collapse problem.

## Known gaps to resolve at planning time

1. **10 levels is not a flame.** The shipped UI has three discrete states
   (`FlameState` / `FLAME_LADDER` in `train_scheduler.py`, rendered in
   `TrainProgressRow.tsx`). Ten tiers wants a meter or a plain number
   ("Streak shield 7/10"), following Duolingo's freeze *count* rather than
   ten pieces of flame art. This is the main UI cost of the change.
2. **Calendar grace runs inversely to commitment.** A 1-day/week user
   survives a 10-week absence; a 7-day/week user's streak dies during a
   two-week holiday. The most committed users get the least tolerance for
   ordinary life. Standard fix is an explicit pause/vacation toggle, not
   buffer tuning — see the todo.
3. **"Streak" becomes a slight misnomer**, since misses are absorbed rather
   than breaking the count. Duolingo has the same fudge with freezes, so it
   is survivable, but the label should be sessions-based rather than
   claiming consecutiveness.

## SR supply — RESOLVED against prod, 2026-07-27

The one objection that could not be reasoned away during the session was
whether a per-scheduled-day cadence has real SR material most days:
`LADDER_DAYS` pushes correct items 3 and 10 days out and parks mastered ones,
so a daily obligation seemed likely to land on days with thin or no due
material and degrade into red-herring padding. **Measured against the
production DB, this is a non-issue.** The concern was wrong.

Measured with the exact `pool_entry_stmt` predicates (severity=2, ply-parity
player gate, `answer_key_present`, prior-ply `expected_score >=
WINNABILITY_FLOOR_ES`), 156 non-guest users with any pool material:

| Metric | Value |
|---|---|
| Qualifying backlog per user | p10 132, p25 580, **median 2,638**, p75 6,581 |
| Users below 100 puzzles | 13 of 156 |
| Users below one session (6) | **2 of 156** |
| `WINNABILITY_FLOOR_ES` pass rate | 95.1% (sample of 25 users, 300,790 rows) |
| New qualifying blunders per active week (90d) | p25 22.9, **median 59.4**, p75 114.1 |
| Active users generating >= 35/week (daily cadence) | 84 of 127 (66%) |
| Active users generating >= 15/week (3x/week) | 102 of 127 (80%) |

At the default `puzzles_per_session = 6`, `compose_slots` yields 5 SR slots
and 1 herring, so a daily cadence consumes 35 SR items/week. Two independent
sources cover it:

- **Backlog**: the median user holds ~527 days (~1.4 years) of daily sessions
  before the fresh pool is touched at all. Even the p25 user holds ~116 days.
- **Steady state**: median arrival is 59.4/week against 35/week consumption —
  the median active user is net-positive even at a full daily cadence, and
  80% clear the 3x/week bar comfortably.

The structural reason thin sessions do not occur: `compose_and_materialize_
session` step 4 pads `sr_slots` from `pool_entry_stmt` (the fresh pool)
whenever due `drill_items` come up short, and cross-backfills between the SR
and herring sides. A herring-dominated session therefore requires the fresh
pool to be *exhausted* while nothing is due — which describes 2 users out of
156.

**Caveats on the measurement.** Train is barely used in production (13
`train_settings` rows, 120 `drill_items`, 14 `drill_sessions`), so these
numbers measure *available supply*, not observed session composition — the
real thing cannot be measured until Train has traffic. The arrival rate is
measured net of the answer-key filter, so it already accounts for incomplete
tier-4 blob backfill coverage (see `project_tier4_blob_backfill_measurement`)
rather than overstating usable material.

**Remaining supply-side risk is confined to brand-new users**, who have a
small backlog and no arrival history until their first import completes.
That is an onboarding concern (do not light a streak before the user has
material), not a reason to reject the model.

## Decisions locked during the session

- **Flame/shield stays a pure grace buffer.** Intensity is expressed in the
  weekly progress surface (day dots, "N sessions this week"), never folded
  into the shield level. User's explicit call, on simplicity grounds.
- **Rejected: a sliding requirement that rises with flame level**
  (minimum=1, medium=2, maximum=3). Broken — a steady 2-sessions/week user
  ping-pongs medium <-> maximum forever, registering half their weeks as
  missed despite perfectly consistent training.
- **Rejected: splitting the requirement into separate survival and promotion
  thresholds.** Fixes the oscillation but makes the flame do double duty as
  both intensity tier and grace buffer, so a returning heavy user briefly
  reads as a lighter user.
- **Rejected: "complete all planned sessions" as the weekly requirement.**
  Structurally unachievable: `session_window` gives each session a window
  ending on the next scheduled day, and `compose_and_materialize_session`
  step 3b returns the completed session rather than composing a replacement,
  so max supply is exactly one session per scheduled day. Requirement would
  equal max supply for *every* mask — zero slack, a single missed planned day
  fails the week, and the 3-rung buffer degrades into a three-week countdown.
  Also strictly harsher than the daily model it was meant to avoid.
- **Rejected: user-set weekly session goal as a second settings dial.**
  Superseded — the session-tick model gets the same effect from one
  mechanism.

## Cross-references

- Replaces: Phase 191 streak machinery — `app/services/train_scheduler.py`
  (`FlameState`, `FLAME_LADDER`, `_flame_up`/`_flame_down`,
  `required_sessions_per_week`, `SettledStreak`, `StreakView`,
  `_settle_one_week`, `settle_weeks`, `week_start`), `train_settings`
  columns `streak_count` / `flame_state` / `streak_settled_through`,
  and `frontend/src/components/train/TrainProgressRow.tsx`.
- Constrained by: `session_window` and `is_session_expired` in the same
  module (one session per scheduled day), and
  `compose_and_materialize_session` step 3b in
  `app/repositories/train_repository.py`.
- SR ladder interaction: `LADDER_DAYS` / `MASTERY_STREAK_THRESHOLD` in
  `app/services/train_scheduler.py`.
- Source seed for the Train feature overall: SEED-037.
- Testing the calendar behavior without waiting: `app/core/dev_clock.py`
  plus `scripts/reset_train_state.py` (see CLAUDE.md "Dev clock").
