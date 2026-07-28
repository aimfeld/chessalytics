# Phase 193: Session-Tick Streaks with a Depletable Shield - Context

**Gathered:** 2026-07-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace Phase 191's weekly streak model with a **per-scheduled-day tick + a 7-level
depletable shield** (SEED-121). One mechanism replaces the weekly-fulfillment check,
`required_sessions_per_week`, and the 3-rung flame ladder:

- **Tick = one scheduled day** (a day whose bit is set in `weekday_mask`).
- **Completed session** → shield +1 (cap 7), count +1.
- **Missed scheduled day** → shield −1.
- **Shield reaches 0** → count resets to 0.

In scope: the backend settle-machine rewrite in `app/services/train_scheduler.py`
(weekly settle → per-scheduled-day tick), the `train_settings` column changes, the
`GET /train/progress` payload, the frontend swap of the 3-state flame for a 7-segment
pip meter, and a nav-badge visibility fix (badge only on scheduled days).

**Explicitly OUT of scope** (user's call, this session): the pause/vacation toggle the
seed proposed. See `<deferred>`.

**Precondition verified against `origin/production` (2026-07-28):**
`app/services/train_scheduler.py` exists there but contains **no `FLAME_LADDER`** —
Phases 189/190/190.1 shipped (release #280) but Phase 191's streak surface did **not**.
This is a pre-production rewrite: there is zero live user-facing streak state to
migrate. SEED-121's trigger condition ("if Phase 191's streak surface is still
pre-production and the change is cheap") holds.

**Requirements:** amends **PROG-01** in place (the weekly-streak wording is what this
phase replaces) and **SCHD-02** (badge visibility narrows to scheduled days). No new
requirement IDs. `required_sessions_per_week`'s 1→6 cliff (SEED-121's second defect)
disappears by deletion — no separate fix needed.

</domain>

<decisions>
## Implementation Decisions

### Shield + count presentation

- **D-01: The shield renders as a 7-segment pip meter**, not a numeric "5/7" readout
  and not a flame variant. Seven small filled/empty segments in a row, replacing the
  single `lucide-react` `Flame` in `TrainProgressRow.tsx`. Rejected: shield icon +
  numeric count (Duolingo's freeze-count pattern, cheapest), and flame + shield
  sub-badge (conflates the grace buffer with intensity, which SEED-121 explicitly
  splits apart). Mobile density is easier at seven pips than at the ten this decision
  originally assumed, and seven reads as one-per-weekday — still solve any residual
  density in layout, not by shrinking below `text-sm` equivalents.

- **D-02: The count is labelled "N-session streak".** Keeps the streak framing (familiar,
  motivating) while making the unit honest — the count ticks per completed scheduled
  session, not per calendar day and not per week. Rejected: bare "N sessions" (drops
  the motivational framing) and "N-day streak" (actively wrong for anyone not training
  daily). SEED-121's gap #3 ("streak" is a slight misnomer once misses are absorbed) is
  knowingly accepted here, on the same grounds Duolingo accepts it for freezes.

- **D-03: A completed session's tick lands IMMEDIATELY on completion** — count and
  shield both increment at once, and the score screen can celebrate it. Misses still
  settle **lazily at day rollover** on the next progress read. The settle machine is
  therefore **deliberately asymmetric**: completions settle eagerly, misses settle
  lazily. This is the accepted cost of killing Phase 191's D-03 awkwardness (a lit
  flame sitting next to a literal "0-week streak") and of paying the user back the same
  day they earn it. Planner: the eager path and the lazy path must not be able to
  double-count the same day.

- **D-04: Streak death shows an empty meter, a 0 count, and a persistent notice** derived
  from state, not from "did this call settle the reset" — extending Phase 191's existing
  `streak_lost_last_week` plumbing (reworded for session ticks), which already survives a
  page reload by construction. No drain animation (would need a "has the user seen this"
  flag plus `prefers-reduced-motion` handling). Not silent (a user who loses a 40-session
  streak with no acknowledgement reads it as a bug, not as kindness).

### Miss-day fairness gate

- **D-05: A scheduled day on which the user had no trainable material is NEUTRAL** — no
  drain and no tick. It neither credits nor punishes. Rejected: crediting +1 (makes an
  empty pool a reward and cheapens the count) and draining normally (simplest, and
  defensible given SEED-121's supply measurement, but unfair to brand-new users
  mid-import).

- **D-06: The fairness gate buys exactly one cheap eligibility watermark** — a single
  nullable date on `train_settings`; **never judge a scheduled day earlier than the date
  the user first had qualifying material.** This covers SEED-121's stated remaining
  supply risk (brand-new users with a small backlog and no arrival history until their
  first import completes) at near-zero cost. It deliberately does **NOT** cover a later
  exhausted stretch: a user who masters everything and stops generating new blunders
  will drain and eventually lose the streak. **Accepted as rare and arguably correct.**
  Rejected: a per-day `train_day_log` judgement table (auditable, but a new table +
  migration for an edge case), and deriving "was anything due on day D" from
  `drill_items` alone (free, but blind to the fresh-flaw padding source because
  `game_flaws` has no arrival timestamp — it would under-report material and wrongly
  neutralise real training days).
  — **Reversibility:** costly — the watermark is an additive nullable column, but
  upgrading later to a per-day judgement log means the pre-log history can never be
  re-derived, only zeroed.

- **D-07 (AMENDS SEED-121): an ad-hoc off-day session credits +1 shield pip (cap 7) but does NOT advance the count.**
  SEED-121 states flatly that "unscheduled days never
  tick"; this splits that rule. Rationale: it follows the seed's own locked split more
  faithfully than the flat rule does — extra effort buys *forgiveness* (the shield is a
  pure grace buffer) without inflating *intensity* (the count). Costs one extra branch
  in the tick machine. SCHD-03's ad-hoc "train now" therefore has a real, bounded payoff.

- **D-08: A session started but not completed before its window closed is a MISS** and
  drains a pip. Only `status='completed'` sessions tick — unchanged from Phase 191's
  `settle_weeks(completed_session_dates=...)`, so zero new logic. Rejected: neutral
  (gameable in the laziest possible way — open a session, solve nothing, never lose a
  pip). Default session size is 6 puzzles, so "started and abandoned" is a real signal.

### Nav badge visibility (folded in during discussion)

- **D-09: The numeric Train nav badge shows only on scheduled session days.** Verified
  current behaviour: `frontend/src/App.tsx:162` / `:354` gate the badge on
  `waiting_count > 0` **alone** — there is no day-of-week check anywhere, so today it
  nags every single day regardless of `weekday_mask`. This narrows Phase 191's D-07.
  Note it is a no-op for the two day-agnostic masks (`0` and the `ALL_WEEKDAYS_MASK`
  default) since every day is scheduled under both — only users who deliberately narrow
  their mask get quiet off-days.

- **D-10: An already-open unfinished session keeps its badge on an off-day.** Phase 191
  D-07's second clause ("or an open session has unsolved puzzles left") survives D-09
  verbatim. Only reachable under a narrowed mask, where `session_window` can leave a
  session open across an unscheduled day. Rejected: a strict "no badge on unscheduled
  days, period" rule — the session expires at the next scheduled day, so hiding the
  badge would remove the one cue that could rescue a half-finished session.

### Claude's Discretion

The user explicitly declined to discuss the following; resolve at research/plan time:

- **Drain rate.** Use SEED-121's default: **symmetric ±1**, shield cap 7 (user's call,
  2026-07-28; the seed originally said 10), which puts the survival bar at roughly
  **50% attendance** (a bounded random walk; expected hitting time from a full shield at
  exactly 50% is ~49 ticks, down from ~100 at a cap of 10 — the 50% threshold itself is
  set by the ±1 symmetry and is unaffected by the cap). The seed names −2 per miss
  (→ ~67% bar) as the tuning lever if 50% proves too soft. **Do not tune by shrinking
  shield depth below 7** — past that the grace-collapse problem the model exists to fix
  returns.
- **Carry-over of Phase 191's three streak columns** (`streak_count`, `flame_state`,
  `streak_settled_through`): hard-reset to zero versus replaying `drill_sessions` history
  so existing completed sessions retroactively build the new count and shield. Weigh
  against Phase 191 **D-05**, which made retroactivity an *explicit user requirement*
  ("users who already completed sessions during Phase 190 must see that reflected
  retroactively") — that argues for replay, and the settle machine replays anyway. Prod
  holds only ~14 `drill_sessions` rows, so the blast radius either way is tiny.
  Interacts with D-06: the watermark bounds how far back a replay may judge.
- **Fate of the "This week: N of M sessions" line** in `TrainProgressRow.tsx`.
  `required_sessions_per_week` is deleted by this phase, so `current_week_required`
  becomes a plain `popcount(weekday_mask)` — which is finally honest ("how many
  scheduled days this week") rather than the special-cased value it is today. Keeping
  the line is where SEED-121's locked decision puts *intensity*.
- Pip colour banding and the `theme.ts` constants that replace
  `TRAIN_STREAK_FLAME_MINIMUM/MEDIUM/MAXIMUM`.
- The exact trigger that stamps the D-06 eligibility watermark (first `drill_items` row
  versus first qualifying flaw).
- Whether `streak_settled_through` stays a `Date` (it must now hold a *day*, not a
  Monday) or is renamed for clarity.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source seed and predecessor context
- `.planning/seeds/SEED-121-session-tick-streak-shield.md` — the full mechanism, the
  two models it was compared against and why it beat them, the four rejected designs
  (sliding requirement, split survival/promotion thresholds, "complete all planned
  sessions", user-set weekly goal), the ~50% attendance-bar analysis, the three known
  gaps, and the **prod SR-supply measurement (2026-07-27)** that cleared the one
  objection which could not be reasoned away. **Read in full — most of the design
  rationale lives here, not in this file.**
- `.planning/phases/191-schedule-progress-surface/191-CONTEXT.md` — the decisions this
  phase replaces or must respect. Especially **D-01** (count-based weekly fulfillment),
  **D-02** (the 3-state flame ladder), **D-03/D-04** (settled-only count + display
  overlay), **D-05** (retroactivity as an explicit user requirement), **D-18** (a settled
  week is frozen forever), **D-06/D-07** (badge is the entire attention mechanism),
  **D-09/D-10** (inline auto-saving schedule settings), **D-13** (stats row above the CTA).
- `.planning/phases/189-pool-scheduler-backend/189-CONTEXT.md` — D-06/D-07/D-08
  (timezone, weekday mask, session size) and the due-date snapping convention this
  phase's day boundary must stay consistent with.
- `.planning/seeds/SEED-037-*.md` — the source seed for Train overall.

### Code this phase rewrites
- `app/services/train_scheduler.py` — `FlameState`, `FLAME_LADDER`, `_flame_up` /
  `_flame_down`, `required_sessions_per_week`, `SettledStreak`, `StreakView`,
  `_settle_one_week`, `settle_weeks`, `week_start` all go. `local_today`,
  `next_scheduled_day`, `session_window`, `is_session_expired`, `apply_result`,
  `LADDER_DAYS`, `MASTERY_STREAK_THRESHOLD` all stay untouched.
- `app/models/train_settings.py` — `streak_count` / `flame_state` /
  `streak_settled_through` columns and the `ck_train_settings_flame_state` CHECK.
- `app/repositories/train_repository.py` — `settle_streak_snapshot` (the single
  settlement entry point, shared by `GET /train/progress` and `PUT /train/settings`),
  `get_waiting_puzzle_count`, and the `pool_state` discriminant.
- `app/schemas/train.py` — `TrainProgressResponse` (`settled_streak_weeks`,
  `flame_state`, `current_week_completed`, `current_week_required`,
  `streak_lost_last_week`).
- `frontend/src/components/train/TrainProgressRow.tsx` — the flame, `FLAME_COLOR`,
  `thisWeekHint`, the reset notice.
- `frontend/src/types/train.ts` — `TrainFlameState` and the progress payload type.
- `frontend/src/App.tsx:162` and `:354` — the two `trainWaitingCount` badge sites D-09
  changes.
- `frontend/src/lib/theme.ts` — `TRAIN_STREAK_FLAME_MINIMUM/MEDIUM/MAXIMUM`.

### Testing calendar behaviour without waiting
- `CLAUDE.md` § "Dev clock (testing Train's schedule without waiting days)" — the
  `X-Dev-Clock-Offset-Minutes` mechanism, honored only when `ENVIRONMENT ==
  "development"`.
- `app/core/dev_clock.py` — the `dev_now_utc` dependency every time-dependent endpoint
  must take `now_utc` from.
- `frontend/src/components/train/TrainDevClock.tsx` — the dev-only time-travel strip.
- `scripts/reset_train_state.py` — wipes one user's Train/drill state after
  time-travelling forward. Refuses `--db prod`.

### Project rules
- `CLAUDE.md` § Coding Guidelines, § Frontend, § Database Design Rules (enumerated
  columns: low-volume domain columns use TEXT + CHECK), § Browser Automation Rules
  (`data-testid` on every interactive element).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`settle_streak_snapshot` in `app/repositories/train_repository.py`** — already the
  *single* mutation entry point for the streak columns, already called
  settle-before-mutate from `PUT /train/settings` (so a snapshot can never advance
  against a schedule that was never persisted), already sequential on one
  `AsyncSession` (never `asyncio.gather`, per CLAUDE.md). The tick machine slots into
  this seam; do not add a second settlement path.
- **`next_scheduled_day(after, weekday_mask)`** — the forward-scan primitive the tick
  machine needs to walk "which days since `settled_through` were scheduled". Already
  handles the `weekday_mask == 0` identity case and raises on an impossible mask.
- **`streak_lost_last_week`** — already derived from resulting *state* rather than from
  "did this call settle the reset", so it survives a page reload. D-04 reuses that
  property directly; only the window and the wording change.
- **`pool_state` discriminant** (`"no_material"` / `"exhausted"` / `"available"`) and
  `blob_pending_count` — the existing vocabulary for "does this user have material",
  already on the progress payload for the PROG-05 empty states. It is a **now**-value,
  which is exactly why D-06 needs a stored watermark instead.
- **`LoadError` + the `isPending` / `isError` / data ternary chain** in
  `TrainProgressRow.tsx` — keep verbatim; CLAUDE.md requires the `isError` branch.

### Established Patterns
- **A settled unit is frozen forever (191 D-18).** The per-day machine must preserve
  this: only ever walk days strictly after `streak_settled_through`, so a later
  `weekday_mask` or timezone change can never re-judge a past day. `streak_settled_through`
  changes meaning from "Monday of the last settled week" to "the last judged day".
- **Naive-UTC codebase with one exception**: every Train day boundary goes through
  `local_today(timezone, now_utc)`. Never call `datetime.now()` inline — take `now_utc`
  from the `dev_now_utc` dependency (`app/core/dev_clock.py`) so the dev clock keeps
  working.
- **Low-volume domain columns use TEXT + CHECK** (`flame_state` follows the
  `drill_sessions.status` precedent, not the high-cardinality `drill_items.status` one).
  The shield level is a small integer 0–7, so `SmallInteger` + a CHECK is the fit —
  no enum.
- **Inline auto-saving settings, no Save button** (191 D-09/D-10) — relevant only if any
  new user-facing control appears, which after dropping pause it should not.
- **Theme constants live in `frontend/src/lib/theme.ts`** — never hard-code semantic
  colours in components.

### Integration Points
- `GET /train/progress` (`app/routers/train.py`) — the single read that lazily settles
  and returns the payload the stats row and nav badge both consume.
- `PUT /train/settings` — the second caller of `settle_streak_snapshot`; must keep the
  settle-before-mutate ordering.
- The **session-completion path** is a new settlement caller under D-03 (eager tick on
  completion) — it did not previously touch the streak columns.
- `frontend/src/App.tsx` desktop header + mobile bottom bar — **two** badge sites; per
  CLAUDE.md, apply D-09 to both.
- Frontend tests that pin current behaviour and will need rework:
  `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx`,
  `TrainStartScreen.test.tsx`, and the badge block in `frontend/src/App.test.tsx`
  (~lines 610–720).

</code_context>

<specifics>
## Specific Ideas

- **"We only want to 'nag' the user with the badge on scheduled session days."** — the
  user's own framing for D-09, and the reason it got folded into this phase rather than
  captured as a separate idea.
- SEED-121's Duolingo comparison is the reference point for the whole model: daily
  streaks *plus forgiveness* (Streak Freeze / Streak Repair / Weekend Amulet) is the
  dominant pattern; the products that ship daily streaks without forgiveness (Apple
  Fitness) are the ones users describe as stressful. The pip meter (D-01) is a
  deliberate departure from Duolingo's numeric freeze *count*, chosen so depletion is
  legible at a glance.

</specifics>

<deferred>
## Deferred Ideas

- **Pause / vacation toggle** — SEED-121's known gap #2: calendar grace runs *inversely*
  to commitment (a 1-day/week user survives a 7-week absence; a 7-day/week user's
  streak now dies after exactly one week away, so an ordinary two-week holiday kills
  it and the most committed users get the least tolerance for ordinary life). The
  cap cut from 10 to 7 sharpens this — a daily trainer's slack drops from ~10 days to
  7. The seed proposes an explicit pause toggle as the standard fix, and it was in the
  seed's stated phase scope. **The user's call this session: don't add it for now.**
  The gap is therefore knowingly accepted, not solved.
  Worth revisiting if Train retention data shows committed users losing streaks to
  holidays. If it returns, the discussion got as far as: scope it to the tick machine
  only (not due dates — SR intervals are calendar-based by design and shifting them
  needs a bulk date-shift on resume), and note that D-09 makes badge-silencing fall out
  for free (paused ⇒ no scheduled days ⇒ no badge) with no second read path.
- **Per-day judgement log (`train_day_log`)** — rejected under D-06 in favour of the
  cheap watermark. Would make every past day's verdict inspectable forever, which
  matters more for a running-balance model than it did for weekly settlement. The
  natural upgrade if the watermark proves too coarse.
- **Tuning the drain to −2 per miss (~67% attendance bar)** — SEED-121's named lever if
  the ~50% bar proves too soft in practice. Not a Phase 193 decision; a constant to
  revisit once Train has real traffic.

</deferred>

---

*Phase: 193-session-tick-streak-shield*
*Context gathered: 2026-07-28*
