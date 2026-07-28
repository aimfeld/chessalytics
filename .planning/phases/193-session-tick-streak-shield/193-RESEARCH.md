# Phase 193: Session-Tick Streaks with a Depletable Shield - Research

**Researched:** 2026-07-28
**Domain:** Backend calendar-shaped state machine (Python/SQLAlchemy/Alembic) + a small React presentation swap
**Confidence:** HIGH — this is a rewrite of code already read in full (`train_scheduler.py`, `train_repository.py`, `train_settings.py`, `train.py` schema/router, `TrainProgressRow.tsx`, `App.tsx`), not a new-library integration. No external package research was needed; all findings are `[VERIFIED: codebase]` unless marked otherwise.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Shield + count presentation**
- **D-01: The shield renders as a 7-segment pip meter**, not a numeric "5/7" readout and not a flame variant. Seven small filled/empty segments in a row, replacing the single `lucide-react` `Flame` in `TrainProgressRow.tsx`.
- **D-02: The count is labelled "N-session streak."**
- **D-03: A completed session's tick lands IMMEDIATELY on completion** — count and shield both increment at once, and the score screen can celebrate it. Misses still settle **lazily at day rollover** on the next progress read. The settle machine is therefore **deliberately asymmetric**: completions settle eagerly, misses settle lazily. Planner: the eager path and the lazy path must not be able to double-count the same day.
- **D-04: Streak death shows an empty meter, a 0 count, and a persistent notice** derived from state, not from "did this call settle the reset" — extending Phase 191's existing `streak_lost_last_week` plumbing (reworded for session ticks), which already survives a page reload by construction.

**Miss-day fairness gate**
- **D-05: A scheduled day on which the user had no trainable material is NEUTRAL** — no drain and no tick.
- **D-06: The fairness gate buys exactly one cheap eligibility watermark** — a single nullable date on `train_settings`; never judge a scheduled day earlier than the date the user first had qualifying material. Does NOT cover a later exhausted stretch (accepted as rare/correct). — **Reversibility:** costly — upgrading later to a per-day judgement log means the pre-log history can never be re-derived, only zeroed.
- **D-07 (AMENDS SEED-121): an ad-hoc off-day session credits +1 shield pip (cap 7) but does NOT advance the count.**
- **D-08: A session started but not completed before its window closed is a MISS** and drains a pip. Only `status='completed'` sessions tick.

**Nav badge visibility**
- **D-09: The numeric Train nav badge shows only on scheduled session days.** No day-of-week check exists today (`App.tsx:162`/`:354` gate on `waiting_count > 0` alone).
- **D-10: An already-open unfinished session keeps its badge on an off-day.**

### Claude's Discretion

The user explicitly declined to discuss the following; resolved at research time (recommendations below, not final locks — planner may adjust):
- **Drain rate.** Symmetric ±1, shield cap 7 (locked value, not a discretion item — repeated here since it drives the algorithm). ~50% attendance survival bar. Do not tune by shrinking shield depth below 7.
- **Carry-over of Phase 191's three streak columns**: hard-reset vs. replaying `drill_sessions` history — see `## Carry-Over Strategy` below.
- **Fate of the "This week: N of M sessions" line** — see `## Current-Week Hint` below.
- Pip colour banding / `theme.ts` constants — see `## Pip Colour Banding` below.
- The exact trigger that stamps the D-06 eligibility watermark — see `## D-06 Watermark Trigger` below.
- Whether `streak_settled_through` stays a `Date` (it must now hold a *day*, not a Monday) or is renamed — see `## Migration Shape` below.

### Deferred Ideas (OUT OF SCOPE)

- **Pause / vacation toggle** — SEED-121's known gap #2 (calendar grace runs inversely to commitment). Explicitly deferred this session; do not build it.
- **Per-day judgement log (`train_day_log`)** — rejected under D-06 in favour of the cheap watermark.
- **Tuning the drain to −2 per miss** — not a Phase 193 decision.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROG-01 | A streak counts training consistency with forgiveness (amended in place — was "weekly streak counts consecutive weeks with every scheduled session completed"; the weekly-streak wording is the defect this phase fixes) | `## Tick Machine Design` replaces `settle_weeks`/`FLAME_LADDER` with `tick_days`/`shield_level`; `## Carry-Over Strategy` handles the migration from the old semantics |
| SCHD-02 | Nav badge visibility narrows to scheduled days (amended in place — badge was "on session days" without a day-of-week check; D-09 closes the gap) | `## Badge Visibility Signal` specifies the new server-computed field and the `App.tsx` consumption change |

</phase_requirements>

## Summary

This phase replaces a **weekly, calendar-bucketed** settlement machine with a **per-scheduled-day, running-balance** one. The old machine (`settle_weeks` in `app/services/train_scheduler.py`) buckets `drill_sessions.session_date` values into Mon–Sun weeks with `Counter`, walks fully-elapsed weeks, and steps a 3-rung `FlameState` enum up/down. The new machine must walk **individual scheduled days** (per `weekday_mask`), maintain a **0–7 integer shield** and a **session count**, and — critically — support **two different settlement cadences for the same state**: an eager write on session completion (D-03) and a lazy write on the next read (the existing `GET /train/progress` pattern). Both paths mutate the same three columns on `train_settings` and must never double-judge the same calendar day.

The core reusable machinery survives unchanged: `local_today`, `next_scheduled_day`, `session_window`, `is_session_expired`, `apply_result`, `LADDER_DAYS`, `MASTERY_STREAK_THRESHOLD`. Everything week-shaped goes: `FlameState`, `FLAME_LADDER`, `_flame_up`/`_flame_down`, `required_sessions_per_week`, `SettledStreak`, `StreakView`, `_settle_one_week`, `settle_weeks`, `week_start` (the last one only insofar as it fed the deleted machinery — the plain Mon–Sun bucketing for the "This week" *display* line can stay, decoupled from settlement).

**The single highest-risk correctness finding of this research**: the boundary for "has this scheduled day fully elapsed" is **not** `day < today`. Under a sparse `weekday_mask` (e.g. Mon/Wed/Fri), a day is only judgeable once its **session window has closed** — i.e. `is_session_expired(session_window(day, weekday_mask), today)`, the exact same primitive `drill_sessions.expires_on` already uses. Using naive date comparison would judge Monday as a miss on Tuesday morning, while the user still legitimately has until Wednesday to play it. This generalizes the old machine's "week must be fully elapsed" rule correctly to the new per-day cadence and collapses to the old naive check for dense masks (daily/`ALL_WEEKDAYS_MASK`), so it is a strict superset of the previous correctness, not a behavior change for the default user.

**Primary recommendation:** Model state as a `TickSnapshot(streak_count: int, shield_level: int, settled_through: date | None)`, replace `settle_weeks` with a `tick_days` pure function that walks scheduled days one at a time using `is_session_expired(session_window(...))` as the stop condition, add a shared `_judge_one_day` primitive that both the eager (session-completion) and lazy (read-time) callers invoke, and gate the eager caller with `if session_date is scheduled AND (settled_through is None OR session_date > settled_through)` so a late completion of an already-lazily-judged day degrades gracefully to a D-07-style bonus pip rather than double-crediting the count.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-day tick state machine (shield/count math) | API / Backend (`app/services/train_scheduler.py`) | — | Pure calendar logic, no I/O; must stay unit-testable in isolation like its predecessor |
| Settled-snapshot persistence + read/write orchestration | API / Backend (`app/repositories/train_repository.py`) | Database | `train_settings` row is the single source of truth; repository is the only writer |
| Eager tick on session completion | API / Backend (`record_solve` → `_mark_session_complete_if_done` path) | — | Must run in the SAME transaction as the solve claim, so a rollback never leaves a half-applied tick |
| Lazy tick on read | API / Backend (`get_progress` → `settle_streak_snapshot`-equivalent) | — | Unchanged entry point, new internal algorithm |
| Badge visibility (scheduled-day + open-session gating) | API / Backend (new response field) | Browser / Client | Frontend has zero knowledge of `weekday_mask` today; computing "is today scheduled" client-side would duplicate the mask parsing logic server already owns — keep it server-side and ship a boolean |
| 7-segment pip meter rendering | Browser / Client (`TrainProgressRow.tsx`) | — | Pure presentation, consumes `shield_level` (0–7) directly, no client-side math beyond loop-render |
| Reset notice display | Browser / Client | API / Backend (state-derived boolean) | Server computes the discriminant (D-04); client only renders it |

## Standard Stack

No new external packages. This phase is a rewrite of existing first-party modules using the project's established stack: FastAPI/Pydantic v2/SQLAlchemy 2.x async/Alembic on the backend, React 19/TypeScript/TanStack Query on the frontend. `[VERIFIED: codebase]` — confirmed by reading `app/services/train_scheduler.py`, `app/repositories/train_repository.py`, `app/models/train_settings.py`, `app/schemas/train.py`, `app/routers/train.py`, `frontend/src/components/train/TrainProgressRow.tsx`, `frontend/src/App.tsx`, `frontend/src/types/train.ts`, `frontend/src/lib/theme.ts` in full during this research session.

### Alternatives Considered

Not applicable — no library selection decision exists in this phase.

## Package Legitimacy Audit

**Not applicable.** This phase introduces zero new dependencies (backend or frontend). No `npm view`/`pip index versions` verification was needed.

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────────────────────┐
                         │      train_settings row      │
                         │  streak_count   (int)        │
                         │  shield_level   (0..7)        │
                         │  settled_through (date|null)  │
                         │  pool_eligible_since (date|null) ← NEW (D-06)
                         └───────────────┬───────────────┘
                                         │ read + guarded write
                 ┌───────────────────────┼───────────────────────┐
                 │                       │                       │
   EAGER PATH    │                       │      LAZY PATH        │
 (D-03, immediate)│                      │  (day-rollover, on read)│
                 │                       │                       │
  POST /train/sessions/{id}/solve        │        GET /train/progress
  record_solve()                         │        get_progress()
     │                                   │              │
     ▼                                   │              ▼
  _mark_session_complete_if_done()       │      settle_streak_snapshot()
     │ session just flipped to           │              │
     │ status='completed'?               │      tick_days(snapshot, weekday_mask,
     ▼                                   │        today, pool_eligible_since,
  is session_date a SCHEDULED day        │        completed_scheduled_dates)
  (weekday_mask bit set, or mask==0)?    │              │
     │ yes         │ no (D-07 off-day)   │      walk scheduled days D from
     ▼             ▼                     │      settled_through+1 while
  is session_date  shield=min(shield+1,7)│      is_session_expired(
  > settled_through?  (count unchanged,  │        session_window(D, mask), today)
     │ yes         settled_through       │      for each such D:
     │             unchanged)            │        D < pool_eligible_since?
     ▼                                   │          → NEUTRAL (no-op, but D counts
  shield=min(shield+1,7)                 │             as settled/frozen)
  streak_count += 1                      │        else → MISS: shield=max(0,shield-1);
  settled_through = session_date         │             shield==0 → streak_count=0
     │ no (already lazily judged —       │      settled_through advances to the
     │      "late completion" edge case) │      last day whose window closed
     ▼                                   │              │
  shield=min(shield+1,7) only            │              ▼
  (treat like an off-day bonus pip;      │      persist snapshot IF changed
  count/settled_through untouched —      │      (compare-and-set guard on
  that day is already frozen, D-04)      │       settled_through strictly advancing)
                 │                       │              │
                 └───────────┬───────────┘              │
                             ▼                           ▼
                    ┌─────────────────────────────────────────┐
                    │  TrainProgressResponse (GET /train/progress) │
                    │  shield_level, streak_count,                 │
                    │  streak_reset_notice, badge_visible (NEW),   │
                    │  current_week_completed/required (unchanged  │
                    │  Mon–Sun display bucketing, decoupled from   │
                    │  settlement)                                 │
                    └───────────────┬───────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                                ▼
         TrainProgressRow.tsx                 App.tsx (desktop header +
         7-segment pip meter,                 mobile bottom bar) — badge
         "N-session streak", reset notice     visible iff badge_visible
```

### Recommended Project Structure

No new files/directories — every symbol changes in place:

```
app/services/train_scheduler.py     # tick_days() replaces settle_weeks(); TickSnapshot/TickView
                                     # replace SettledStreak/StreakView; new is_scheduled_day() helper
app/models/train_settings.py        # flame_state (TEXT+CHECK) → shield_level (SmallInteger+CHECK);
                                     # + pool_eligible_since (Date, nullable)
app/repositories/train_repository.py # settle_streak_snapshot() → tick machine orchestration;
                                     # record_solve()'s completion branch gains the eager-tick call;
                                     # get_progress() stamps pool_eligible_since before ticking
app/schemas/train.py                # TrainProgressResponse: flame_state→shield_level (int),
                                     # settled_streak_weeks→streak_count, streak_lost_last_week→
                                     # streak_reset_notice, + badge_visible (new)
app/routers/train.py                # field renames only, same shape
frontend/src/components/train/TrainProgressRow.tsx  # Flame icon → 7-pip meter
frontend/src/types/train.ts         # TrainFlameState type deleted; field renames mirrored
frontend/src/lib/theme.ts           # TRAIN_STREAK_FLAME_* → TRAIN_SHIELD_PIP_* (3-tier banding)
frontend/src/App.tsx:162,354        # trainWaitingCount>0 check → badge_visible field
scripts/reset_train_state.py        # column names in the reset UPDATE
tests/scripts/test_reset_train_state.py  # fixture field names
```

### Pattern 1: Shared day-judgement primitive (prevents the D-03 double-count)

**What:** One pure function, `_judge_one_day`, that both the eager and lazy callers invoke to transition `TickSnapshot` by exactly one scheduled day. The ONLY difference between the two callers is *when* they call it and *how many* days they walk (lazy walks a range; eager calls it once, for exactly the day that was just completed).

**When to use:** Any time either path needs to record a tick for a specific scheduled day, so the two paths structurally cannot diverge in their arithmetic (a copy-pasted second implementation is exactly how the "double-count" bug CONTEXT.md warns about would slip in).

**Example (sketch, not literal code — planner writes the real implementation and tests):**
```python
# Source: derived from app/services/train_scheduler.py's existing _settle_one_week pattern
def _judge_one_day(
    snapshot: TickSnapshot, *, day: date, fulfilled: bool, eligible: bool
) -> TickSnapshot:
    """Advance the snapshot by exactly one scheduled day. Called by BOTH the
    eager (fulfilled=True, always eligible since it just happened) and lazy
    (fulfilled=False, eligible from the D-06 watermark check) paths — this
    function is the ONLY place shield/count arithmetic happens."""
    if not eligible:
        # D-05/D-06: neutral day, before the user ever had material.
        return TickSnapshot(
            streak_count=snapshot.streak_count,
            shield_level=snapshot.shield_level,
            settled_through=day,
        )
    if fulfilled:
        new_shield = min(snapshot.shield_level + 1, SHIELD_CAP)
        return TickSnapshot(
            streak_count=snapshot.streak_count + 1,
            shield_level=new_shield,
            settled_through=day,
        )
    new_shield = max(snapshot.shield_level - 1, 0)
    new_count = 0 if new_shield == 0 else snapshot.streak_count
    return TickSnapshot(streak_count=new_count, shield_level=new_shield, settled_through=day)
```

Note how much simpler this is than `_settle_one_week`'s `FLAME_LADDER.index()` gymnastics — an integer with floor/cap arithmetic replaces a 3-state enum ladder walk.

### Pattern 2: The elapsed-day boundary MUST reuse `session_window`/`is_session_expired`

**What:** The lazy walk's stop condition is `is_session_expired(session_window(day, weekday_mask), today)`, not `day < today`.

**When to use:** Every place that decides "has this scheduled day's window closed" — the lazy settle walk, and (defensively) the eager-tick guard.

**Example:**
```python
# Source: app/services/train_scheduler.py (existing primitives, reused not reimplemented)
def tick_days(
    snapshot: TickSnapshot,
    completed_scheduled_dates: Sequence[date],
    *,
    weekday_mask: int,
    today: date,
    pool_eligible_since: date | None,
) -> TickView:
    start = (
        next_scheduled_day(snapshot.settled_through + timedelta(days=1), weekday_mask)
        if snapshot.settled_through is not None
        else next_scheduled_day(pool_eligible_since or today, weekday_mask)
    )
    completed_set = set(completed_scheduled_dates)
    settled = snapshot
    day = start
    while is_session_expired(session_window(day, weekday_mask), today):
        eligible = pool_eligible_since is not None and day >= pool_eligible_since
        fulfilled = eligible and day in completed_set
        settled = _judge_one_day(settled, day=day, fulfilled=fulfilled, eligible=eligible)
        day = next_scheduled_day(day + timedelta(days=1), weekday_mask)
    ...
```
For a dense mask (`ALL_WEEKDAYS_MASK` or `0`), `session_window(day, mask) == day + 1`, so `is_session_expired(day+1, today) == today >= day+1 == day < today` — this collapses exactly to the naive boundary for the default user, so it is a pure correctness generalization, not a behavior change for the common case.

### Anti-Patterns to Avoid

- **Re-deriving "has this day elapsed" as `day < today`:** correct only for dense masks; silently wrong (judges too early) for any narrowed schedule. This is the phase's single highest-risk mistake — see Pitfall 1.
- **Two separate arithmetic implementations for the eager and lazy paths:** even subtly different rounding/capping between them is how D-03's double-count warning becomes real. One shared `_judge_one_day`, two callers.
- **Reintroducing Phase 191's `display_flame` overlay mechanism:** it existed to make the flame "light immediately" before the first WEEKLY settlement landed, because the old model had no eager-write path. Under D-03, the eager write on session completion means the persisted `shield_level`/`streak_count` update the SAME moment the user sees them — there is no longer a gap between "the user should see progress" and "the state is settled." Carrying the overlay forward mechanically adds a second, now-redundant code path. Recommend deleting it, not porting it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Deciding whether a scheduled day's window has closed | A new date-comparison helper | `is_session_expired(session_window(day, weekday_mask), today)` | Already exists, already tested, already the authority `drill_sessions.expires_on` itself uses — a second implementation of "has this day's window closed" is the exact kind of divergence Pattern 2 above warns against |
| Snapping a day forward to the next scheduled one | A new forward-scan loop | `next_scheduled_day(after, weekday_mask)` | Identical semantics needed for the tick walk as for due-date snapping; already handles the `weekday_mask == 0` identity case and the impossible-mask edge |
| Converting a UTC instant to the user's local calendar day | `datetime.now()` / `.date()` inline | `local_today(tz_name, now_utc)` | THE ONE conversion site, per the module's own D-06 convention docstring; every new function in this rewrite must take an already-resolved `today: date`, never re-derive one |

**Key insight:** Every primitive the new per-day tick machine needs already exists in `train_scheduler.py` from Phase 189/191 — this phase is compositional (new state shape + new walk direction) over already-verified day-boundary math, not new date-arithmetic surface area.

## Carry-Over Strategy

**Recommendation: hard-reset the three snapshot columns to their "never settled" state AND let the existing replay-on-first-settlement mechanism recompute everything under the new per-day rules — do not attempt to translate old week-counts into new session-counts.**

Rationale:
1. **Blast radius is trivial.** Production holds only 13 `train_settings` rows, 120 `drill_items`, 14 `drill_sessions` (measured 2026-07-27, cited in `191-CONTEXT.md`/SEED-121). There is no meaningful "3-week streak" a user would notice losing.
2. **A week-count has no valid translation to a session-count.** The old `streak_count` measured *settled weeks*; the new one measures *completed scheduled-day sessions*. There is no formula that converts one into the other without re-deriving from `drill_sessions` history anyway — so don't invent one.
3. **This reuses the ALREADY-EXISTING replay mechanism, not a new one.** `settle_weeks`'s `snapshot.settled_through is None` branch already triggers "replay the entire pre-existing history" (this is exactly how Phase 191 D-05's retroactivity requirement was satisfied for brand-new rows). Resetting `settled_through = NULL` again for existing rows makes every existing user look like a "brand-new settler" to the new `tick_days` function, which then naturally walks their REAL `drill_sessions.session_date` history from the watermark forward — satisfying Phase 191 D-05's retroactivity intent under the NEW rules, for free.

**Concrete migration steps** (one Alembic revision):
```sql
UPDATE train_settings SET streak_count = 0, streak_settled_through = NULL;
-- shield_level (new column, see Migration Shape below) defaults to 0 already.
```

**Load-bearing interaction with D-06 (flag for planner as a `checkpoint:decision`):** if `pool_eligible_since` is left NULL for existing users and only gets lazily stamped to "today" on their next API call (see next section), the replay window collapses to `[today, today)` — **empty** — which silently discards the very history this hard-reset was designed to replay. The migration MUST also backfill `pool_eligible_since` for existing users from real historical data, not leave it to the lazy stamp. Recommended backfill, in the same migration (cheap at this row count):
```sql
UPDATE train_settings ts
SET pool_eligible_since = (
    SELECT MIN((di.created_at AT TIME ZONE ts.timezone)::date)
    FROM drill_items di
    WHERE di.user_id = ts.user_id
)
WHERE EXISTS (SELECT 1 FROM drill_items di WHERE di.user_id = ts.user_id);
```
Users with zero `drill_items` rows keep `pool_eligible_since = NULL`, which is correct — they get the same lazy first-stamp as a genuinely brand-new user (see below).

## D-06 Watermark Trigger

**Recommendation: stamp `pool_eligible_since` from the SAME existence checks `_pool_state` already computes (`has_drill_items OR has_pool_candidates`), NOT from blob-pending-only material.**

`app/repositories/train_repository.py`'s `_pool_state` already runs two EXISTS queries per request:
```python
has_drill_items = (await session.execute(select(select(DrillItem.user_id)...exists()))).scalar_one()
has_pool_candidates = (await session.execute(select(pool_entry_stmt(user_id).exists()))).scalar_one()
```
`[VERIFIED: codebase, app/repositories/train_repository.py:757-764]` — these are the cheapest possible signal for "does qualifying material exist right now," and they already run on every `GET /train/progress` call. `blob_pending_count > 0` alone is deliberately EXCLUDED from the watermark trigger: a blunder still waiting on tier-4 analysis has no answer key yet (`answer_key_present` gates `pool_entry_stmt`), so it is not yet "qualifying material" under D-06's own wording ("the date the user first had qualifying material") — stamping the watermark on blob-pending-only would start the clock before the user has anything actually drillable.

**Ordering requirement:** in `get_progress`, compute `has_drill_items`/`has_pool_candidates` (or refactor `_pool_state` to also return them) BEFORE calling the tick machine, and if `pool_eligible_since IS NULL AND (has_drill_items OR has_pool_candidates)`, stamp it to `today` in the SAME transaction, before `tick_days` runs — so the very call that discovers material also gives `tick_days` a correct, immediately-usable floor. Stamping it after would mean the day the user actually crossed the threshold gets missed by one read cycle (usually harmless, but avoidable at zero extra cost since the existence checks already ran).

**Also stamp from `compose_and_materialize_session`:** a session can be composed (and thus a `drill_items` row created) without a preceding `GET /train/progress` call in some client flows — the same stamp-if-null logic belongs there too, reusing the existing `pool_state`-adjacent computation rather than adding a third query site.

## Current-Week Hint

**Recommendation: keep the "This week: N of M sessions" line, decouple it fully from settlement, and delete the day-agnostic special-casing.**

The 191-era `required_sessions_per_week` function special-cased `weekday_mask in (0, ALL_WEEKDAYS_MASK)` to return `1` specifically to avoid a 1→6 requirement cliff on the WEEKLY fulfillment gate (SEED-121's stated defect #2). That gate is deleted this phase — the "This week" line becomes purely informational, never gates anything — so the special-casing has no remaining purpose and should be deleted along with it. Replace the single call site (`get_progress`'s `current_week_required` computation) with a direct popcount:
```python
current_week_required = None if weekday_mask == 0 else bin(weekday_mask).count("1")
```
The `week_start`/`Counter`-bucketing mechanism that computes `current_week_completed` (how many sessions landed in the current Mon–Sun week) can stay as a small standalone helper — it's independent of the tick machine and never touches `settled_through`/`shield_level`/`streak_count`.

## Migration Shape

**`streak_settled_through`:** recommend KEEPING the name and the `Date` type — the value's Python type doesn't change (still "the last calendar day this machine has finished judging"), and every call site in this rewrite is being touched anyway (per `canonical_refs`' "Code this phase rewrites" list), so a rename buys clarity at zero *additional* migration cost but is not load-bearing. If the planner prefers `tick_settled_through` for clarity given the semantic shift from "Monday of a week" to "a specific day," that is equally cheap (`ALTER TABLE ... RENAME COLUMN` is instant in Postgres, no table rewrite) — a discretionary call, not a correctness one.

**`flame_state` → `shield_level`:** this DOES need a real schema change, not a rename — the type changes from `TEXT` + 3-value CHECK to `SmallInteger` + range CHECK:
```python
# app/models/train_settings.py
shield_level: Mapped[int] = mapped_column(SmallInteger, nullable=False, server_default="0")
# __table_args__:
CheckConstraint("shield_level BETWEEN 0 AND 7", name="ck_train_settings_shield_level"),
```
`SmallInteger` + CHECK matches CLAUDE.md's enumerated-column rule for a LOW-cardinality, non-categorical bounded integer (this mirrors `drill_items.streak`'s own pattern, not `drill_sessions.status`'s TEXT+CHECK pattern — `shield_level` is a count, not a named state, so it should NOT become an `IntEnum` the way `flame_state` was a `StrEnum`).

**New: `pool_eligible_since`:**
```python
pool_eligible_since: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
```

**Alembic revision (additive + one drop + data backfill), following the exact shape of the two Phase 191 migrations already in `alembic/versions/`:**
```python
def upgrade() -> None:
    op.drop_constraint("ck_train_settings_flame_state", "train_settings", type_="check")
    op.drop_column("train_settings", "flame_state")
    op.add_column(
        "train_settings",
        sa.Column("shield_level", sa.SmallInteger(), server_default="0", nullable=False),
    )
    op.create_check_constraint(
        "ck_train_settings_shield_level", "train_settings", "shield_level BETWEEN 0 AND 7"
    )
    op.add_column("train_settings", sa.Column("pool_eligible_since", sa.Date(), nullable=True))
    # Hard-reset the carry-over columns (see ## Carry-Over Strategy).
    op.execute("UPDATE train_settings SET streak_count = 0, streak_settled_through = NULL")
    # Backfill the D-06 watermark from real drill_items history (see ## Carry-Over Strategy
    # for the exact correlated-subquery SQL and its rationale).
    op.execute(<backfill SQL from Carry-Over Strategy>)
```

## Pip Colour Banding

**Recommendation: reuse the same 3 existing brand colors as banding thresholds over the 7 pips, rather than inventing 7 distinct hues.**

`frontend/src/lib/theme.ts` currently exports `TRAIN_STREAK_FLAME_MINIMUM` (barely-lit ember), `TRAIN_STREAK_FLAME_MEDIUM` (`TRAIN_RATING_YELLOW`), `TRAIN_STREAK_FLAME_MAXIMUM` (hot orange-red). Rename and repurpose as fill-color bands rather than discrete states:
```typescript
export const TRAIN_SHIELD_PIP_LOW = 'oklch(0.55 0.03 85)';    // 1-2 filled pips: ember, danger zone
export const TRAIN_SHIELD_PIP_MEDIUM = TRAIN_RATING_YELLOW;    // 3-5 filled pips: steady
export const TRAIN_SHIELD_PIP_HIGH = 'oklch(0.62 0.20 40)';    // 6-7 filled pips: strong/near cap
```
Empty pips use a neutral/muted tone (existing `text-muted-foreground`/border-only style, not a new hard-coded hex) — never a 4th named color. This minimizes new design surface: the same 3 colors already approved for the flame ladder carry over as a fill gradient across the pip row, banded by `shield_level` thresholds (e.g. `<=2`, `3..5`, `>=6`) rather than by discrete enum membership. This is Claude's Discretion territory — the planner/UI-spec step may adjust exact thresholds, but reusing the existing 3-color palette avoids a fresh color-approval round.

## Badge Visibility Signal

**Finding: the frontend has ZERO knowledge of `weekday_mask` today** — `App.tsx`'s `trainWaitingCount > 0` check (lines 162/223/354/408, `[VERIFIED: codebase]`) is the entire gating logic, with no day-of-week awareness anywhere in the client. D-09 ("badge shows only on scheduled session days") and D-10 ("an already-open unfinished session keeps its badge on an off-day") cannot be implemented by adding client-side date math without duplicating the server's mask-parsing/weekday logic — the correct fix is a new server-computed boolean field on `TrainProgressResponse`.

**Recommendation:** add `badge_visible: bool` to `ProgressSnapshot`/`TrainProgressResponse`, computed in `get_progress` as:
```python
is_scheduled_today = is_scheduled_day(today, settings_row.weekday_mask)  # new helper, see below
has_open_unfinished = (
    open_session is not None and not is_session_expired(open_session.expires_on, today)
    and open_session.puzzle_count > solved_count  # D-10
)
badge_visible = waiting_count > 0 and (is_scheduled_today or has_open_unfinished)
```
Add a small new pure helper to `train_scheduler.py`:
```python
def is_scheduled_day(day: date, weekday_mask: int) -> bool:
    """True when `day`'s weekday bit is set, or weekday_mask == 0 (D-07 'train
    anytime' — every day is scheduled). Shared by the eager-tick off-day check
    (D-07) and the badge-visibility computation (D-09) — one bit-test, two callers."""
    return weekday_mask == 0 or bool(weekday_mask & (1 << day.weekday()))
```
This is the SAME predicate the eager-tick path needs to distinguish a scheduled-day completion from an off-day one (D-07) — one helper, two call sites, no duplicated bit-mask logic.

**Frontend change:** `App.tsx` swaps `trainWaitingCount > 0` for `trainProgressQuery.data?.badge_visible ?? false` at all four render sites (desktop `/train` link, mobile `/train` link) — the badge's displayed NUMBER still comes from `waiting_count` (unchanged formatting/cap logic), only the show/hide condition changes.

## Runtime State Inventory

> Included because this phase performs a data migration against existing production rows (hard-reset + backfill), not merely a schema-additive change.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `train_settings`: 13 prod rows carry the OLD `streak_count`/`flame_state`/`streak_settled_through` snapshot (week-shaped). `drill_sessions` (14 rows) and `drill_items` (120 rows) are untouched by this phase — they are the SOURCE the tick machine replays from, not migrated themselves. | Data migration: hard-reset the 3 snapshot columns + backfill `pool_eligible_since` from `drill_items.created_at` (SQL in `## Carry-Over Strategy`) |
| Live service config | None — Train has no external service integration (no n8n, no Datadog, no Tailscale ACLs touch this table). | None |
| OS-registered state | None — no scheduled tasks, no pm2/systemd units reference `train_settings`. | None |
| Secrets/env vars | None — no secret or env-var name encodes `flame_state`/`streak_settled_through`. | None |
| Build artifacts / installed packages | None — pure schema + application-code rewrite, no package rename, no installed-artifact drift. | None |

## Common Pitfalls

### Pitfall 1: Using `day < today` as the elapsed-day boundary (THE highest-risk item)

**What goes wrong:** Under a narrowed `weekday_mask` (e.g. Mon/Wed/Fri), the lazy walk judges Monday as a miss on Tuesday, before the user's actual window (open until Wednesday, per `session_window`) has closed.
**Why it happens:** The old weekly model's boundary (`week < current_start`) was correct for Mon–Sun buckets because a week's real end date and the calendar week boundary are the same thing. Per-day, under a sparse mask, "the next calendar day" and "the day this scheduled day's window actually closes" diverge.
**How to avoid:** Always gate elapsed-day judgement on `is_session_expired(session_window(day, weekday_mask), today)`, never on a bare date comparison. See `## Architecture Patterns` Pattern 2 for the exact primitive and why it collapses correctly for the default dense mask.
**Warning signs:** A unit test with a narrowed mask (e.g. `0b0010101` for Mon/Wed/Fri) and a `today` that falls strictly between two scheduled days should NOT show a miss for the most recent scheduled day yet — if it does, the boundary is wrong.

### Pitfall 2: Late completion of an already-lazily-settled day (the literal D-03 double-count warning)

**What goes wrong:** `record_solve` has no expiry check today (`[VERIFIED: codebase]` — no `is_session_expired` call anywhere in `record_solve`'s claim/completion path; only `compose_and_materialize_session` calls `expire_stale_sessions`, and only at composition time). So an open `drill_sessions` row whose window has ALREADY closed can still be solved and completed via `POST /train/sessions/{id}/solve` — if a `GET /train/progress` call in between already lazily judged that scheduled day as a MISS (shield−1), the subsequent late completion's eager-tick call would try to credit the SAME day as a HIT (shield+1, count+1) unless explicitly guarded.
**Why it happens:** The eager and lazy paths are triggered by different events (a client action vs. a read), and nothing currently prevents both from firing for the same calendar day in either order.
**How to avoid:** Gate the eager-tick call with `session_date > (settled_through or date.min)`. If the day is already frozen (`settled_through >= session_date`), do NOT re-open it — instead treat the late completion like a D-07 off-day bonus: `shield_level = min(shield_level + 1, SHIELD_CAP)` only, leaving `streak_count`/`settled_through` untouched (D-04: "a settled day is frozen forever"). This is a genuinely defensible default (reward the effort with a grace pip, but never un-freeze history) — flag it to the user as a `checkpoint:decision` at plan time, since CONTEXT.md does not specify this exact tie-break and it is easy to get subtly wrong.
**Warning signs:** A test that (a) advances the dev clock past a scheduled day's window without completing its session, (b) calls `GET /train/progress` (lazy miss fires), then (c) completes that stale session via `solve` — the shield/count after step (c) must show at most +1 shield pip, never a reverted miss plus a fresh hit.

### Pitfall 3: Watermark stamped too late collapses the replay window to empty

**What goes wrong:** If `pool_eligible_since` is left NULL for existing rows and only gets lazily stamped to "today" on the FIRST post-migration API call, the replay window for that user's pre-existing `drill_sessions` history becomes `[today, today)` — empty. Every prior completed session is silently excluded from the new tick machine's count/shield, defeating the hard-reset-then-replay strategy this research recommends.
**Why it happens:** The watermark and the "replay from NULL settled_through" mechanism are two independently-reasonable features that interact badly if implemented naively together (see `## Carry-Over Strategy`'s explicit callout).
**How to avoid:** Backfill `pool_eligible_since` in the SAME Alembic migration that resets `streak_settled_through`, using real historical data (`MIN(drill_items.created_at)`), not a lazy runtime stamp, for any user who already has `drill_items` rows.
**Warning signs:** Post-migration, a user with real completed `drill_sessions` history shows `streak_count == 0` and an empty shield on their very first post-deploy `GET /train/progress` call, with no reset notice explaining why (because nothing was ever judged — it was silently walked-over as "before eligibility").

### Pitfall 4: Forgetting the frontend has no `weekday_mask` awareness

**What goes wrong:** Implementing D-09/D-10 by trying to infer "is today scheduled" from data already on the client (there isn't any — `TrainProgressResponse` never shipped `weekday_mask` or "today," and `TrainSettingsResponse` is a separate query the nav bar doesn't currently fetch).
**Why it happens:** It's tempting to reach for `useTrainSettings()` in `App.tsx` and do the bit-test client-side, duplicating server logic and requiring a second query + client-side timezone conversion (which the client has no clean way to do without re-implementing `local_today`).
**How to avoid:** Ship the pre-computed `badge_visible: bool` on `TrainProgressResponse` (already the single query `App.tsx` uses for the badge count) — see `## Badge Visibility Signal`.

### Pitfall 5: Reintroducing the D-03 (Phase 191) display-overlay pattern unnecessarily

**What goes wrong:** Porting `StreakView.display_flame`/the "show minimum flame before the first settlement" overlay mechanism into the new tick machine "for safety," even though the new eager-write path makes it redundant.
**Why it happens:** It's the existing pattern in the file being edited, and copying an existing pattern feels safer than removing it.
**How to avoid:** Under D-03 (this phase), a completed scheduled-day session writes the REAL `shield_level`/`streak_count` immediately — there is no window where the UI needs to show progress that hasn't actually been persisted yet, the way Phase 191's UI needed a "flame lit but count still 0" overlay for a merely-in-progress week. Delete the overlay concept; `TrainProgressResponse` can return the persisted snapshot values directly.

## Code Examples

### Solve-completion eager tick (sketch — planner writes the real signature/tests)

```python
# Source: extends app/repositories/train_repository.py's existing
# _mark_session_complete_if_done / record_solve flow (read in full this session)
async def _apply_eager_tick_if_completed(
    session: AsyncSession, *, user_id: int, drill_session: DrillSession, now_utc: datetime.datetime
) -> None:
    """Called from record_solve() immediately after _mark_session_complete_if_done()
    returns True. Must run inside the SAME transaction as the solve claim so a
    rollback (e.g. a later step raising) never leaves a half-applied tick — the
    existing session.commit()/rollback() wrapping in the router already covers this,
    no new transaction boundary needed."""
    settings_row = await get_or_create_settings(session, user_id=user_id)
    scheduled = is_scheduled_day(drill_session.session_date, settings_row.weekday_mask)
    already_settled = (
        settings_row.streak_settled_through is not None
        and drill_session.session_date <= settings_row.streak_settled_through
    )
    if scheduled and not already_settled:
        new_shield = min(settings_row.shield_level + 1, SHIELD_CAP)
        new_count = settings_row.streak_count + 1
        new_settled_through = drill_session.session_date
    else:
        # D-07 off-day, OR a late completion of an already-frozen day (Pitfall 2).
        new_shield = min(settings_row.shield_level + 1, SHIELD_CAP)
        new_count = settings_row.streak_count
        new_settled_through = settings_row.streak_settled_through
    await session.execute(
        update(TrainSettings)
        .where(TrainSettings.user_id == user_id)
        .values(shield_level=new_shield, streak_count=new_count, streak_settled_through=new_settled_through)
    )
```

### Frontend pip meter (sketch)

```tsx
// Source: replaces the single lucide-react Flame in TrainProgressRow.tsx
const SHIELD_PIP_COUNT = 7;

function ShieldMeter({ level }: { level: number }): ReactElement {
  return (
    <div data-testid="train-shield-meter" className="flex items-center gap-0.5" role="img"
         aria-label={`Shield: ${level} of ${SHIELD_PIP_COUNT}`}>
      {Array.from({ length: SHIELD_PIP_COUNT }, (_, i) => (
        <span
          key={i}
          className="size-2.5 rounded-full"
          style={{ backgroundColor: i < level ? pipColor(level) : undefined }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
```

## State of the Art

| Old Approach (Phase 191) | New Approach (Phase 193) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Weekly `Counter`-bucketed settlement (`week_start`, Mon–Sun) | Per-scheduled-day walk (`next_scheduled_day` + `is_session_expired(session_window(...))`) | This phase | The elapsed-boundary logic must generalize correctly for sparse masks — see Pitfall 1 |
| 3-state `FlameState` enum + notch-index arithmetic (`_flame_up`/`_flame_down`, `FLAME_LADDER.index()`) | Plain `int` shield 0–7 with floor/cap arithmetic | This phase | Strictly simpler code — no enum-index lookups, no `None`-vs-`FLAME_LADDER[0]` special cases |
| Lazy-only settlement + a presentation-only `display_flame` overlay to fake immediacy | Eager write on completion (real persisted state) + lazy write on read for misses only | This phase | The overlay mechanism becomes dead weight — delete rather than port (Pitfall 5) |
| `required_sessions_per_week` special-cases `0`/`127` to avoid a WEEKLY gating cliff | Plain `popcount(weekday_mask)` for the informational "This week" line (nothing gates on it anymore) | This phase | Special-casing has no remaining purpose once the weekly requirement itself is deleted |
| No eligibility watermark — weeks before a user had material could still register as "missed" in principle (never observed since the weekly bar was forgiving) | `pool_eligible_since` explicit watermark (D-06) | This phase | New brand-new-user fairness guarantee; must be backfilled correctly for existing rows (Pitfall 3) |
| Nav badge = `waiting_count > 0`, no day-of-week awareness | Nav badge = server-computed `badge_visible` (scheduled day OR open unfinished session) | This phase | Closes a real live bug — the badge currently nags every day regardless of `weekday_mask` (confirmed: no day-of-week check anywhere in `App.tsx` today) |

**Deprecated/outdated:**
- `FlameState`, `FLAME_LADDER`, `_flame_up`, `_flame_down`, `required_sessions_per_week`, `SettledStreak`, `StreakView`, `_settle_one_week`, `settle_weeks` in `app/services/train_scheduler.py` — all replaced per SEED-121's own cross-reference list. `week_start` may survive in a decoupled role for the display-only "This week" bucketing (see `## Current-Week Hint`).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Hard-reset + full replay (rather than attempting to translate old week-counts) is the right carry-over strategy | `## Carry-Over Strategy` | Low — only 13 prod rows affected either way; if the user wants a different carry-over treatment (e.g., preserve the raw `streak_count` number as a "legacy" display value), this is a cheap plan-time reversal since nothing external depends on the old semantics |
| A2 | `pool_eligible_since` should trigger from `has_drill_items OR has_pool_candidates` (real material), excluding blob-pending-only | `## D-06 Watermark Trigger` | Medium — if the intended reading of "qualifying material" is looser (e.g. includes blob-pending), brand-new users during their first import would get a slightly earlier watermark than this research recommends; easy to adjust, the mechanism (stamp-once, reuse existing EXISTS queries) doesn't change either way |
| A3 | A late completion of an already-settled (frozen) day should award a bonus shield pip rather than being rejected outright or silently ignored | `## Pitfall 2` / `## Code Examples` | Medium — this is an edge case CONTEXT.md explicitly flags as unresolved ("the two paths must not double-count a day") without specifying the exact tie-break; flagged for a `checkpoint:decision` at plan time rather than locked here |
| A4 | The Phase-191 `display_flame` overlay mechanism should be deleted, not ported, under the new eager-write model | `## Pitfall 5` | Low — reversible; if the planner finds a real gap needing an overlay (e.g. some client race not yet identified), it can be re-added, but no evidence for that need was found in this research |
| A5 | `streak_settled_through` can keep its name (Date type unchanged) without correctness impact | `## Migration Shape` | Very low — purely a naming/readability call, explicitly framed as discretionary |

**If this table is empty:** N/A — see entries above; all are genuine judgment calls made in the absence of an explicit CONTEXT.md lock, not unverified factual claims about the codebase (which were all confirmed by direct file reads this session).

## Open Questions (RESOLVED)

Both questions below were resolved at plan time; each recommendation was adopted as written. The
`RESOLVED:` line on each names where the resolution now lives.

1. **Should `record_solve` gain an explicit expiry check (reject solving an already-window-closed session) as a structural fix, or is the Pitfall-2 guard in the tick machine sufficient?**
   - What we know: today `record_solve` has no `is_session_expired` check at all — an expired-but-still-`open` session can still be solved. This is a PRE-EXISTING gap, not introduced by this phase.
   - What's unclear: whether fixing it is in-scope. CONTEXT.md's canonical_refs list `is_session_expired`/`apply_result` as code that "stays untouched," suggesting the phase boundary intends `record_solve` itself to be left alone.
   - Recommendation: leave `record_solve` unchanged; rely on the settled-through comparison guard (Pitfall 2) in the NEW eager-tick call only. This is strictly additive (a new check gating a new code path) and does not touch the existing solve-claim logic CONTEXT.md marks as unchanged.
   - **RESOLVED (2026-07-28, recommendation adopted): `record_solve` gains no expiry check.** `193-02-PLAN.md` Task 1's `<action>` states the prohibition explicitly ("Do not modify `_mark_session_complete_if_done`, the `remaining_stmt` SR-orphan/herring leniency clauses, the `solved_at IS NULL` claim UPDATE, or `apply_result`"), and adds only the new `_apply_completion_tick` call site. The Pitfall-2 tie-break is handled entirely inside that new function, via the frozen-day guard (`session_date > streak_settled_through`) plus the `"credit_only"` `DayOutcome`. The pre-existing solve-after-expiry gap stays out of scope for Phase 193; its exploit ceiling is bounded to +1 shield pip by threat `T-193-06` in the same plan.

2. **Exact pip-count color-band thresholds (1-2/3-5/6-7 vs. some other split).**
   - What we know: 3 existing colors are available to reuse (see `## Pip Colour Banding`).
   - What's unclear: the exact numeric thresholds are a UI-spec-level call, not resolved by this research.
   - Recommendation: defer to the UI-SPEC step (this phase has a "UI hint: yes") or plan-time discretion; the 3-tier structure itself (not the exact cut points) is the load-bearing recommendation.
   - **RESOLVED (2026-07-28, recommendation adopted — deferred to the UI spec, which then locked it): the bands are `193-UI-SPEC.md` `## Color`** — `TRAIN_SHIELD_PIP_LOW` at `shield_level <= 2`, `TRAIN_SHIELD_PIP_MEDIUM` at 3–5, `TRAIN_SHIELD_PIP_HIGH` at `>= 6`, carrying the identical oklch literals the flame constants used, with empty pips on `border-muted-foreground/50` and never a fourth named colour. Restated in `193-01-PLAN.md` `<open_decisions_resolved>` item 5 and implemented by its Task 3.

## Environment Availability

Not applicable — no new external tool/service/runtime dependency. The dev clock (`X-Dev-Clock-Offset-Minutes`, `app/core/dev_clock.py`) and `scripts/reset_train_state.py` already exist and are verified present and functional (read in full this session).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (backend), Vitest (frontend) — both already configured, no new setup |
| Config file | `pyproject.toml` (pytest), `frontend/vite.config.ts` (Vitest) |
| Quick run command | `uv run pytest tests/services/test_train_scheduler.py tests/repositories/test_train_repository.py -x` |
| Full suite command | `uv run pytest -n auto -x` (backend); `cd frontend && npm test -- --run` (frontend) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROG-01 | Completed scheduled-day session ticks shield+count immediately | unit | `pytest tests/repositories/test_train_repository.py::TestRecordSolve -x` | ✅ existing file, needs new test class for the eager-tick assertions |
| PROG-01 | Missed scheduled day drains one shield pip lazily on next read | unit | `pytest tests/services/test_train_scheduler.py::TestTickDays -x` | ❌ new class — `TestSettleWeeksFlameLadderAndEdges` is the class this replaces |
| PROG-01 | Shield reaches 0 → count resets, reset notice persists | unit | same file, `TestTickDays` | ❌ new |
| PROG-01 | Neutral day before `pool_eligible_since` never drains/ticks | unit | same file | ❌ new |
| PROG-01 | Off-day ad-hoc completion credits shield only (D-07) | unit | `test_train_repository.py` | ❌ new (extends existing solve tests) |
| PROG-01 | Sparse-mask window-close boundary (Pitfall 1) | unit | `test_train_scheduler.py::TestTickDays` — dedicated Mon/Wed/Fri fixture | ❌ new, HIGH PRIORITY given the risk level identified |
| PROG-01 | Eager + lazy double-count guard (Pitfall 2) | integration | `test_train_repository.py` — dev-clock-shifted scenario: advance past window, GET /progress (lazy miss), THEN solve the stale open session | ❌ new, HIGH PRIORITY |
| SCHD-02 | Badge visible only on scheduled days | unit | `test_train_repository.py::TestGetProgress` (new `badge_visible` assertions) | ❌ new field, extends existing class |
| SCHD-02 | Badge stays visible for an open unfinished session on an off-day (D-10) | unit | same | ❌ new |
| SCHD-02 | Nav badge consumes `badge_visible`, not `waiting_count > 0` | frontend unit | `npm test -- App.test.tsx` | ✅ existing `describe('191-05: Train waiting badge ...')` block (`App.test.tsx:578`) needs rework — currently asserts purely on `waiting_count` |
| PROG-01 | Pip meter renders 0–7 filled segments, reset notice shown/hidden correctly | frontend unit | `npm test -- TrainProgressRow.test.tsx` | ✅ existing file (176 lines) — currently asserts `flame_state`/`settled_streak_weeks`; needs full rework for the new field names and pip rendering |

### Sampling Rate
- **Per task commit:** `uv run pytest tests/services/test_train_scheduler.py tests/repositories/test_train_repository.py -x` + `cd frontend && npx vitest run src/components/train src/App.test.tsx`
- **Per wave merge:** `uv run pytest -n auto -x` (full backend) + `cd frontend && npm test -- --run` (full frontend)
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus the pre-merge gate in CLAUDE.md before squash-merge.

### Wave 0 Gaps
- `tests/services/test_train_scheduler.py` — the existing 500-line file has 11 test classes covering `settle_weeks`/`FlameState`/`required_sessions_per_week`; all of these need REPLACING (not merely extending) with `TestTickDays`, `TestJudgeOneDay`, `TestIsScheduledDay` classes. This is a large rewrite, not a gap-fill — flag for the planner's task sizing.
- `tests/repositories/test_train_repository.py` (2212 lines) — contains extensive `settle_streak_snapshot`/`get_progress` coverage keyed to the old field names; needs systematic renaming plus new eager-tick test classes.
- `tests/routers/test_train.py` — asserts `flame_state`/`settled_streak_weeks` in the `/train/progress` response body (confirmed via grep, line ~2055-2087); needs field-name updates.
- `tests/scripts/test_reset_train_state.py` — constructs fixtures with `flame_state="medium"`/`streak_settled_through=...` (confirmed via grep, lines 44-66); needs updating alongside `scripts/reset_train_state.py`'s own column references.
- `frontend/src/components/train/__tests__/TrainProgressRow.test.tsx` (176 lines) and the `App.test.tsx` badge `describe` block (lines 578-707) both pin CURRENT behavior against the old field names and old badge condition — both need reworking, not just extending, per CONTEXT.md's own "Integration Points" note.
- No net-new test infrastructure needed (dev clock + `reset_train_state.py` already exist and are sufficient) — this is entirely a rewrite of existing coverage, not a coverage gap.

**Dev-clock usage pattern for the sparse-mask/window-close tests (Pitfall 1/2):** set `weekday_mask` to a narrowed pattern (e.g. Mon/Wed/Fri = `0b0010101`), use `X-Dev-Clock-Offset-Minutes` to land "now" on the Tuesday between two scheduled days, and assert the Monday session is NOT yet judged as a miss; then advance to Wednesday and assert it IS. `scripts/reset_train_state.py --user-id N` resets `drill_solves`/`drill_sessions`/`drill_items`/the streak snapshot columns between dev-clock scenarios (keeping `weekday_mask`/`timezone`/`puzzles_per_session` by default, per its documented behavior) — the natural tool for iterating through these scenarios by hand during implementation, in addition to the automated pytest coverage above.

## Security Domain

`security_enforcement` is absent from `.planning/config.json` (treated as enabled per the standard convention), but this phase introduces no new authentication, session, or cryptographic surface — it rewrites internal state-machine logic behind already-existing, already-audited endpoints.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Unchanged — `current_active_user` dependency, not touched by this phase |
| V3 Session Management | No | Unchanged |
| V4 Access Control | Yes (pre-existing pattern, must be preserved) | Every new query/update must keep scoping by `user_id` from `current_active_user.id` (V4/IDOR guard) exactly as `record_solve`/`get_progress` already do — no new endpoint, no new client-supplied identifier is introduced by this phase |
| V5 Input Validation | No | No new request body fields (the only schema changes are response-shape renames plus one new boolean/int field) |
| V6 Cryptography | No | Not applicable |

### Known Threat Patterns for this phase

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| A malicious client repeatedly hitting `POST /train/sessions/{id}/solve` on a stale session to inflate the streak | Tampering | The Pitfall-2 guard (settled-through comparison) caps the exploit's value at one bonus shield pip per already-frozen day, never a count increment — the existing `solved_at IS NULL` claim-once guard in `record_solve` already prevents re-solving the SAME puzzle twice |
| Client-side badge-visibility spoofing (irrelevant since it's a UI nicety, not an access control) | N/A | `badge_visible` is a display hint only; it gates no server-side authorization, so a client that ignores it changes nothing about what the server allows |

## Sources

### Primary (HIGH confidence)
- `app/services/train_scheduler.py` (full read) — the module being rewritten; every primitive (`local_today`, `next_scheduled_day`, `session_window`, `is_session_expired`, `apply_result`, `settle_weeks`, `FlameState`, `required_sessions_per_week`) confirmed by direct source read this session.
- `app/repositories/train_repository.py` (full read, both halves) — `settle_streak_snapshot`, `get_progress`, `get_waiting_puzzle_count`, `_pool_state`, `record_solve`, `_mark_session_complete_if_done`, `compose_and_materialize_session` all confirmed by direct source read.
- `app/models/train_settings.py`, `app/models/drill_item.py`, `app/models/drill_session.py`, `app/models/game_flaw.py` (confirmed no `created_at` column, ruling out one D-06 trigger option) — full reads.
- `app/schemas/train.py`, `app/routers/train.py` — full reads, confirmed current API contract.
- `frontend/src/components/train/TrainProgressRow.tsx`, `frontend/src/App.tsx` (badge render sites), `frontend/src/types/train.ts`, `frontend/src/lib/theme.ts` (flame color constants) — full/targeted reads.
- `alembic/versions/20260727_121129_63cc8bcc472e_phase_191_train_streak_snapshot.py` — the migration shape template this phase's migration follows.
- `.planning/seeds/SEED-121-session-tick-streak-shield.md` (full read) — the design rationale, the SR-supply measurement, the rejected alternatives, the locked shield-cap-7 decision.
- `.planning/phases/191-schedule-progress-surface/191-CONTEXT.md` (full read) — the decisions this phase replaces/carries forward (D-01 through D-18).
- `.planning/phases/193-session-tick-streak-shield/193-CONTEXT.md` (full read) — this phase's locked decisions and discretion areas.
- `CLAUDE.md` (project instructions) — dev-clock section, enumerated-column rules, coding guidelines.

### Secondary (MEDIUM confidence)
- None — no external documentation was consulted; this phase required zero library lookups.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries, pure rewrite of already-read first-party code.
- Architecture (tick machine design, double-count guard, elapsed-boundary correction): HIGH — derived directly from tracing the actual `session_window`/`is_session_expired`/`record_solve` code paths, not assumed; the sparse-mask boundary bug (Pitfall 1) was found by simulation-tracing the existing primitives against a narrowed mask, not by inference.
- Carry-over/watermark strategy: MEDIUM — the mechanism (hard-reset + replay, watermark-from-existing-EXISTS-queries) is HIGH confidence given the code read, but the exact tie-break choices (A1-A3 in the Assumptions Log) are genuine judgment calls flagged for plan-time confirmation, not settled facts.
- Pitfalls: HIGH for Pitfalls 1/3/4/5 (directly traceable from code); MEDIUM for Pitfall 2's exact recommended resolution (the double-count RISK is HIGH confidence — confirmed by reading `record_solve` and finding no expiry check — but the specific tie-break behavior is a recommendation, not a locked fact).

**Research date:** 2026-07-28
**Valid until:** No external time pressure (no library versions pinned) — valid until the phase is planned/executed; re-verify against the codebase if execution is delayed past other Train-related phases landing first (none currently planned ahead of this one).
