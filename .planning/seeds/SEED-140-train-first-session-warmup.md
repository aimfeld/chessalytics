---
id: SEED-140
status: active
planted: 2026-08-07
planted_during: /gsd-explore — "new user imports, trains immediately, gets only red herrings.
  Do red herrings enter the SR rotation? Better idea?"
trigger_when: next milestone that touches Train onboarding or the Train session-composition
  path. Not urgent-blocking, but every new signup hits it once, so it front-loads the worst
  possible first impression of Train.
scope: small-to-medium (a static warm-up puzzle set + a serve path + a landing state; no new
  sampling infrastructure, no new pool generator, no schema for rating-matching)
---

# SEED-140: Train's first session is 100% red herrings, silently — give new users a labeled warm-up

## The Defect

A user signs up, imports games, and opens `/train` before analysis has produced any
qualifying blunders. What they get is a **full session of pure filler, presented as a normal
session.**

Two independent code paths combine to produce it:

1. **The cross-backfill fills every empty SR slot with herrings.**
   `app/repositories/train_repository.py:1609-1618` — "a short side never silently shrinks the
   session while the OTHER side has spare material." With zero analyzed blunders the SR side
   is empty, so all `n` slots become red herrings. The backfill is correct in its intended
   case (a *partially* short SR side) and pathological in this one.

2. **The "still analyzing" notice therefore never fires.**
   `frontend/src/components/train/TrainStartScreen.tsx:130` gates the short-session copy on
   `blob_pending_count > 0 && puzzle_count < requested_count`. The backfill guarantees
   `puzzle_count == requested_count`, so the second clause is always false. The user is told
   nothing.

Consequences, in order of severity:

- **It teaches the wrong reflex on first exposure.** Every `herring_pool` row is by
  construction a "several genuinely fine moves" position (`HERRING_MIN_QUALIFYING_MOVES`,
  `HERRING_DEGENERATE_MIN_GAP_ES` in `app/services/train_pool.py`). In an all-herring session
  the critical-vs-several guess is *always* "several." A user who works this out scores 100%
  and has learned an actively harmful prior about their own games.
- **It fakes progress.** A perfect score and a streak day, for zero learning.
- **It burns supply.** `herring_stmt(user_id, exclude_served=True)` (`train_pool.py:731-740`)
  permanently retires every served herring for that user. A cold-start session consumes `n`
  of them from a pool that is generated manually (D-14, `scripts/gen_red_herring_pool.py`)
  and never returns them.

## What Is NOT Broken (checked, do not "fix" it)

**Red herrings never enter the spaced-repetition rotation.** This was the original question
and the answer is clean:

| Claim | Evidence |
|---|---|
| `drill_items` rows are created only for SR-source picks | `train_repository.py:1701-1715` loops over `new_sr_items`, which only ever holds `pool_entry_stmt` picks |
| A herring solve records `drill_solves.herring_pool_id` and nothing else | `train_repository.py:1659-1672` sets `source=DrillSource.RED_HERRING` |
| Stated as a contract, not an accident | `train_repository.py:2178` — "A red-herring row touches no `drill_items` row (POOL-08)" |
| No SR bookkeeping downstream either | `TrainReveal.tsx:874-877` — "a herring carries no SR bookkeeping (POOL-08)" |

So the SR ladder is uncontaminated. The problem is purely session *composition* and what the
user is told about it.

## Two More Facts That Shape The Fix

- **Nothing enqueues a new user's games for analysis.** `enqueue_tier1_game` has exactly two
  call sites: `app/routers/imports.py:397` (an explicit per-game user request) and
  `app/routers/admin.py:111`. There is no automatic fast path on import, so a new user's first
  blunders arrive via the tier-3 idle-backlog lottery, which is global and
  recency-weighted-random rather than a queue with a position.
- **Train does no rating-matching anywhere.** `herring_pool` has no rating column and
  `herring_stmt` (`train_pool.py:723-745`) filters only on ladder qualification and
  served-status — no `games` join, no rating predicate (deliberately: D-01 lets the game link
  null out). A 1000-rated user already receives 25% of every real session from positions
  sampled across all users' games, including 2400s.

## The Design

A **one-shot labeled warm-up**, shown only for the very first session, while real material is
still being analyzed.

- **Deliberately easy.** The warm-up's job is teaching the mechanic (the critical/several
  guess, the board, the reveal), not benchmarking the user. Clarity beats calibration.
- **Sharp puzzles come from a small static lichess set.** The vendored CC0 fixtures at
  `fixtures/tagger/detector_fixture_{train,test}.csv` already carry
  `FEN,PreFlawFEN,FirstMove,PV,Themes,Rating` — literally Train's puzzle shape including the
  arriving move, plus a Glicko rating tuned on millions of real solves. Selecting a handful of
  low-rated, unambiguous positions is a data-selection job, not new infrastructure.
- **Mixed with several-fine-moves positions.** A lichess-only warm-up has the mirror-image
  degeneracy of a herring-only one: every lichess puzzle is critical, so the guess would always
  be "critical." The mix is what makes the guess real.
- **Labeled and uncounted.** Explicitly framed as a warm-up; no streak credit, no points that
  read as session performance.

### Locked constraints

- **Warm-up sharp puzzles must NOT enter the SR rotation.** With the lichess source this is
  *structurally* guaranteed rather than merely conventional: `drill_items` has PK
  `(user_id, game_id, ply)` with `game_id` a `ForeignKey("games.id")`
  (`app/models/drill_item.py:80-83`), and a lichess puzzle has no `games` row at all — the
  database refuses the row. No `drill_items` row also means no `streak` / `ever_correct` /
  `due_date` state, so there is nothing for `_advance_drill_item` to advance.
  This is a positive argument for the lichess source over the discarded "sample other users'
  analyzed blunders" alternative: those *do* have `games` rows, which would have made the
  no-rotation rule a convention someone could later break.
- **No rating-matching for red herrings.** Explicitly out of scope — a several-fine-moves
  position does not depend much on the solver's strength, and the existing production
  behavior stays as-is.
- **First session only.** Do not build a repeatable or deepening warm-up track.

### Open fork for the planner

Where the warm-up's several-fine-moves positions come from:

- **From `herring_pool`** — reuses the existing serve/reveal/solve machinery, but every serve
  writes a `drill_solves.herring_pool_id` row and therefore permanently retires that herring
  for the user (`train_pool.py:731-740`).
- **Fully static** (hand-picked, or lichess positions selected for a flat top of the ladder) —
  self-contained, burns nothing, but needs a serve path that does not go through
  `drill_solves`, and the reveal/progress surfaces read `drill_solves` today.

## Related, Independently Valuable

**Cap the herring cross-backfill** so a composed session can never exceed `HERRING_SHARE`
filler (`train_repository.py:1609-1618`). Worth doing on its own merits even before the
warm-up ships: it stops the silent all-filler session, and it makes the existing short-session
notice at `TrainStartScreen.tsx:130` start firing correctly, since `puzzle_count` would then
legitimately fall below `requested_count`.

## Assumption This Scope Rests On

The warm-up is one-shot because **real blunders are assumed available by the next day**.
User-confirmed during the exploration, deliberately not measured. If that turns out to be
false — plausible, given tier-3 is a global lottery rather than a per-user queue, and given
there is no automatic tier-1 enqueue on import — then a new user hits an empty Train screen on
day 2 and this seed's scope is wrong. The cheap way to buy down that risk is an automatic
tier-1 enqueue of the N most recent games on first import (tier-1 fans a single game across
the whole Stockfish pool in roughly 10s, per `eval_queue_service.py:45`), which would make
the wait bounded and countable instead of probabilistic.

Related: [[project_prod_log_retention_use_sentry]] is not involved here; the relevant prior
context is the Train pool/scheduler work in `.planning/milestones/v2.9-phases/189-*` and
`192-red-herring-position-pool/`.
