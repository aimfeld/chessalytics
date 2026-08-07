---
id: SEED-140
status: promoted
promoted_to: Phase 206 (Train Warm-Up Sessions & Sharp Filler Pool), 2026-08-07
planted: 2026-08-07
planted_during: /gsd-explore — "new user imports, trains immediately, gets only red herrings.
  Do red herrings enter the SR rotation? Better idea?"
trigger_when: next milestone that touches Train onboarding or the Train session-composition
  path. Not urgent-blocking, but any signup that reaches Train before the ES lottery has
  delivered hits it, so it front-loads the worst possible first impression of Train.
scope: medium (a static sharp puzzle set + a serve path + a landing state, plus a third
  `DrillSource` value and the `puzzle_type`-to-`source` predicate fix it forces; no new
  sampling infrastructure, no pool generator, no rating-matching schema, no tier-1 fast path)
---

# SEED-140: a session with no analyzed blunders is 100% red herrings, silently — serve a labeled warm-up instead

> Trigger is material scarcity, not session ordinal — see "The Design". The new-user case is
> the common one, which is why the slug says "first-session", but the condition is never
> "is this their first session".

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

A **labeled warm-up**, shown whenever the user's own analyzed blunders are too scarce to fill
a session.

- **Triggered by material, NOT by session ordinal.** "First session" is the common case, not
  the condition. A user may well import, go play bots or browse Openings for a while, and
  arrive at Train with blunders already analyzed — that is an ordinary session with no warm-up
  label, even though it is their first. Conversely a returning user whose material has run dry
  gets the warm-up again. Derive the state from what composition actually produced, never from
  "is this their first session".
- **The discriminant is zero, not a threshold (DECIDED).** Show warm-up framing **only when the
  composed session contains no puzzle sourced from the user's own blunders at all**. One
  qualifying blunder is enough to make it an ordinary, unlabeled session, however much filler
  sits alongside it — calling a session that drills a real mistake of theirs a "warm-up" would
  undersell it. Concretely: warm-up ⟺ the composed session has zero `DrillSource.SR_ITEM`
  puzzles (`len(surviving_sr_keys) == 0` at `train_repository.py:1693-1697`).
  Two implementation notes that follow from it:
  - **Server-computed, like `pool_state`.** Surface a boolean on the session response rather
    than letting the client count sources. This mirrors the existing convention documented at
    `TrainStartScreen.tsx:157-162` (T-191-24): "The client performs no arithmetic over
    `mastered_count`/`waiting_count`/`blob_pending_count` to pick between them."
  - **It must survive resume.** `_resume_session` re-serves an existing session, so the flag
    has to be derived from the stored `drill_solves.source` rows (or persisted on
    `drill_sessions`), not recomputed from current pool state — otherwise a warm-up reloaded
    after the lottery lands would silently shed its label mid-session.
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
- **Labeled, but otherwise a normal session.** Explicitly framed as a warm-up in the UI, and
  that is the ONLY difference — it accrues streak and scores exactly like any other session
  (user decision, 2026-08-07). The earlier "fake streak day" objection applied specifically to
  the *degenerate* all-herring session, where always guessing "several" scored 100%; once the
  filler mix is honest, the streak measures what it is meant to measure — that the user showed
  up and trained. Treating it uniformly also removes special-casing from scoring and streak
  settling. **See the `pool_eligible_since` gotcha below — this constraint is a silent no-op
  without it.**

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
- **Repeats while there is no SR material, but never deepens.** Not strictly one-shot: if the
  ES lottery has still not analyzed anything by the next session, serve filler again rather
  than an empty screen (see "Analysis Timing" below). It stays the same easy warm-up every
  time — do not build a deepening or leveling filler track.

### Open fork for the planner

Where the warm-up's several-fine-moves positions come from:

- **From `herring_pool`** — reuses the existing serve/reveal/solve machinery, but every serve
  writes a `drill_solves.herring_pool_id` row and therefore permanently retires that herring
  for the user (`train_pool.py:731-740`).
- **Fully static** (hand-picked, or lichess positions selected for a flat top of the ladder) —
  self-contained, burns nothing, but needs a serve path that does not go through
  `drill_solves`, and the reveal/progress surfaces read `drill_solves` today.

## The sharp pool as a general SR-shortfall filler (load-bearing, not optional)

The static sharp set serves as filler in *any* session where the SR side comes up short, not
only the first one. Per "Analysis Timing" below this is the mechanism the no-material fallback
runs on, so it is part of the core scope rather than a follow-up. It also fixes a standing
skew on its own merits: today **every** SR shortfall is backfilled with herrings alone
(`train_repository.py:1609-1618`), which skews that session's critical/several base rate
toward "several." A sharp co-filler keeps the base rate honest wherever a shortfall occurs.

Cheap, but explicitly **not free** — three costs a planner must budget:

1. **The `puzzle_type !== 'herring'` proxy breaks.** Today that expression is used as the
   "this is one of the user's own games" predicate, documented as such at
   `frontend/src/components/train/TrainReveal.tsx:915-917` ("the SAME one the game footer
   below already uses, no extra field needed"), and reused at `:874`, `:925` and `:1266`.
   A foreign *sharp* puzzle satisfies `puzzle_type !== 'herring'`, so it would render the
   your-game guess prose and then hit the game footer and fail to load a game the user does
   not own. **The correct predicate becomes `source`, not `puzzle_type`** — fix all sites
   together or this ships as a bug.
2. **Schema.** `DrillSource` is a 2-value IntEnum (`app/models/drill_solve.py:79-83`) guarded
   by `CheckConstraint("source IN (0, 1)")` at `:114`. A third source value needs a migration,
   plus a nullable identity column for the static puzzle — `herring_pool_id` FKs `herring_pool`
   and cannot carry it.
3. **A product decision that must not be inherited silently.** The state where this would
   most often fire beyond day 1 is `pool_state == "exhausted"` (nothing due today), which
   currently renders the "Next review: {date}" empty state. Filling those days with generic
   tactics dilutes the your-own-mistakes thesis. Decide it deliberately; do not let it fall
   out of the backfill change.

## Related, Independently Valuable

**Cap the herring cross-backfill** so a composed session can never exceed `HERRING_SHARE`
filler (`train_repository.py:1609-1618`). Worth doing on its own merits even before the
warm-up ships: it stops the silent all-filler session, and it makes the existing short-session
notice at `TrainStartScreen.tsx:130` start firing correctly, since `puzzle_count` would then
legitimately fall below `requested_count`.

## Analysis Timing — DECIDED, do not re-open

**No tier-1 enqueue on import.** A new user's games are analyzed by the ES lottery like
everyone else's; the expectation is that material exists by the next session. An automatic
tier-1 fast path on first import was considered and **explicitly rejected** by the user
(2026-08-07). Do not reintroduce it as a "small optimization" — it is a deliberate call, not
an oversight.

**The fallback when the lottery hasn't delivered:** keep serving red herrings and sharp filler
puzzles. Never an empty Train screen, never a bare "come back later." This is why the warm-up
is not one-shot and why the sharp-pool-as-general-filler extension above is **load-bearing
rather than optional** — it is the mechanism the fallback runs on, so plan the two together.

Consequences to design for, all acceptable under this decision:

- **Filler must tolerate repetition.** For herrings this already works: `herring_stmt`'s
  documented exhaustion contract re-runs with `exclude_served=False` once every candidate has
  been served to that user (`app/services/train_pool.py:683-698`), so repeats are the existing
  behavior, not new work. The static sharp set needs the same shape — a stable no-repeat
  ordering first, then repeats.
- **Size the static set for a few days, not one session.** Mirroring the real 75/25 base rate,
  an all-filler session of 8 is roughly 6 sharp + 2 herrings, so a set of ~50 low-rated lichess
  positions covers about a week before any repeat. Cheap to seed, and it keeps the degenerate
  case (a user who genuinely waits) from looking threadbare.
- **`pool_eligible_since` must be stamped for filler sessions too, or the streak decision is
  a silent no-op.** `_stamp_pool_eligibility` (`train_repository.py:558-561`) returns early
  without stamping when `has_material` is false, and `has_material` is
  `has_drill_items or has_pool_candidates` — filler satisfies neither. That watermark is the
  D-06 floor handed to `tick_days` (`:584-585`), so with it NULL a warm-up user accrues no
  streak at all regardless of what the UI says. The fix is to widen the stamp condition to
  "has material OR was served a filler session". Nothing about this failure is visible in
  types or tests; it just quietly never ticks.

Related: [[project_prod_log_retention_use_sentry]] is not involved here; the relevant prior
context is the Train pool/scheduler work in `.planning/milestones/v2.9-phases/189-*` and
`192-red-herring-position-pool/`.
