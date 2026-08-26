---
id: SEED-154
status: dormant
planted: 2026-08-26
planted_during: v2.13 "Ways In & Honest Answers" / Phase 212
trigger_when: next Train/SR phase, or when a user reports the same puzzle resurfacing forever
scope: Small
---

# SEED-154: Train SR — park leech items after 6 lifetime lapses (`fail_count` must stop resetting on correct)

## Why This Matters

A drill item the user alternately solves and fails **never leaves the pool**. There is
no attempt cap, and neither exit condition can fire under that pattern:

- `MASTERED` needs `streak >= MASTERY_STREAK_THRESHOLD` (3 *consecutive* correct).
  Alternation oscillates between streak 0 and 1 forever, so the streak-2 (10-day)
  rung is never even reached.
- `PARKED` needs `fail_count >= PARK_FAIL_THRESHOLD` (3) **and** `ever_correct is
  False`. Door B is a never-solved counter: the first correct answer sets
  `ever_correct = True` and zeroes `fail_count`, after which the counter can never
  increment again. Parking is therefore impossible for any item ever solved once,
  no matter how many times it is later failed.

Effective cadence for such an item: ~1.5 days per attempt forever (`LADDER_DAYS[1]`
= 3 days after each success, back to the next scheduled day after each failure),
permanently occupying SR slots in every session. Anki's equivalent (leech
suspension after N lapses) has no counterpart here.

## The Fix

**The threshold is the second-order problem.** The first-order one is that
`fail_count` resets to 0 on every correct answer, so *no* threshold ever fires
under alternation. The counter must become a non-resetting lifetime lapse count.

Locked decision (2026-08-26, discussed with Adrian): **park at 6 lifetime lapses.**

Count lapses, **not total attempts**. A total-attempt cap parks items the user
actually knows — mastery needs 3-in-a-row, so expected attempts to master is
`(1 - p^3) / (p^3 * (1 - p))`:

| recall p | expected attempts to master | expected wrong answers |
|----------|-----------------------------|------------------------|
| 0.8      | 3.8                         | ~0.8                   |
| 0.7      | 6.4                         | ~1.9                   |
| 0.5      | 14                          | ~7                     |

The distribution is fat-tailed: at p=0.7 roughly 1 in 5 items exceeds 10 total
attempts, so a 10-attempt cap would retire material the SR system is successfully
teaching. A lapse counter is immune — p=0.7 expects ~2 lapses, p=0.5 expects ~7.
At 6, a genuine 50/50 leech parks while a 70%-recall item almost never does.
(Anki's default is 8; 6 is the tighter end, chosen deliberately because Train
sessions are far smaller than an Anki deck, so each wasted slot costs more.)

Under strict alternation, 6 lapses = 12 attempts ≈ 18 days at the current cadence.

## Implementation Sketch

All in `app/services/train_scheduler.py::apply_result`:

1. Add `LEECH_FAIL_THRESHOLD: int = 6` next to `PARK_FAIL_THRESHOLD`.
2. Drop the `if state.ever_correct` gate on the increment — `fail_count` becomes a
   lifetime lapse counter.
3. Drop `fail_count=0` from the correct-move branch (both the MASTERED and ACTIVE
   returns) so the counter never resets.
4. Park when `(not ever_correct and fail_count >= PARK_FAIL_THRESHOLD)` **or**
   `fail_count >= LEECH_FAIL_THRESHOLD`. Door A's behavior is unchanged.

No migration: `drill_items.fail_count` already exists. Existing rows start the
lapse count at 0 (no backfill), though `drill_solves` holds the history if a
backfill is ever wanted.

Update the docstring on `DrillItem` (`app/models/drill_item.py:6`, currently
"PARKED (3 never-correct fails, POOL-06)") and the "What parked means"
`InfoPopover` copy in `frontend/src/components/train/TrainStatsCard.tsx`.

## Open Question (decide at plan time)

**Parking is permanent.** `PARKED` is only ever written, never cleared — there is
no unpark path anywhere in `app/`, and the UI surfaces it as a bare count. Since
drill items are the user's own recurring blunders, a silent permanent retire is a
real loss. 6 is low enough that this deserves a second look: either accept it
(the underlying flaw stays visible in the Games/flaws surfaces regardless), or
pair the change with a manual un-park affordance on the Train stats card.

## Breadcrumbs

- `app/services/train_scheduler.py` — `apply_result`, `LADDER_DAYS`,
  `MASTERY_STREAK_THRESHOLD`, `PARK_FAIL_THRESHOLD`, `ItemState`
- `app/models/drill_item.py` — `DrillStatus` enum, `fail_count` / `ever_correct`
- `tests/services/test_train_scheduler.py` — pure unit tests, no DB needed
- `app/repositories/train_repository.py:730-733` — mastered/parked counts
- `frontend/src/components/train/TrainStatsCard.tsx` — parked count + popover copy
- Origin phases: 189 (interval ladder, POOL-04/05/06), 193 (tick + shield)

## Notes

Captured from a design conversation on 2026-08-26, outside any phase scope.
Claude recommended 8 lapses (Anki's default); Adrian chose 6.

## Resolution

**Closed 2026-08-26** by quick task `260826-pn3` (commits `92c62d4e5`, `4180adf2e`,
`c278c9cef`). Implemented as sketched: `LEECH_FAIL_THRESHOLD = 6`, `fail_count`
is now a lifetime lapse counter, and `apply_result` has two named park doors.

Two things the sketch did not anticipate:

- **The PARKED return hardcoded `ever_correct=False`.** That was safe only while
  Door A was the sole path in. Door B can fire with the flag True, so the literal
  would have silently rewritten a solved item's history to "never solved" at the
  moment it parked. Now propagates `state.ever_correct`; guarded by
  `test_leech_park_preserves_ever_correct_true`.
- **No mass-parking on deploy, provably.** Every live `ever_correct=True` row
  holds `fail_count = 0` and every unparked never-solved row holds <= 2, because
  the old code zeroed on each correct solve and capped never-solved items at 3.
  All six lapses below the new door, so the no-migration decision is safe rather
  than merely hopeful.

**Open Question resolved: park-only, no un-park.** Adrian's call, 2026-08-26.
`PARKED` remains write-only with no path back. Rationale: the underlying flaw
stays visible in the Games/flaws surfaces regardless, and an un-park affordance
can be added later on evidence, once parked counts are actually non-zero for
real users. If that evidence arrives, the cheap version is a single bulk
"un-park all" endpoint plus a button on `TrainStatsCard` (reset `fail_count` to
0 and re-snap `due_date`), not a per-item listing UI.
