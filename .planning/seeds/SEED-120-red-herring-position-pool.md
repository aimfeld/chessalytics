---
id: SEED-120
status: open
planted: 2026-07-27
planted_during: gsd-explore session 2026-07-27 (red-herring sourcing defect)
trigger_when: Phase 191 ships — kick this off as the next v2.9 phase, before the milestone closes
scope: phase (single, backend-only)
depends_on: none open
supersedes: POOL-03's "non-gem `game_best_moves` rows" sourcing, and Phase 189 success criterion #2's wording
---

# SEED-120: Precomputed red-herring position pool

> **This is a correctness defect in shipped v2.9 behavior, not a new feature.** Every red
> herring Train has ever served is structurally wrong. The fix is a precomputed global
> pool; the design below is *settled* (gsd-explore 2026-07-27), not provisional.

## The Defect

Red herrings are supposed to be "several fine moves" positions — they vaccinate the user
against "there's always a killer move here" pattern-gaming (SEED-037). The current source
is `game_best_moves` via `herring_stmt` (`app/services/train_pool.py:362`), filtered on
`best_move_tier_sql(...) IS NULL AND gap_expr < SHARP_GAP_ES` (0.10 ES).

That table cannot contain a "several fine moves" position. Its population gate
(`app/services/eval_apply.py:1870`, GEMS-02) emits a row only where the played move ==
Stockfish's best move **AND** it beats the runner-up by `>= INACCURACY_DROP` (0.05 ES).
The runner-up being at least an inaccuracy is the entry condition.

Measured on prod (3,286,059 rows):

| population | count |
|---|---|
| best↔second ES gap < 0.05 (two genuinely fine moves) | **0** |
| best↔second raw cp diff ≤ 50cp | **0** |
| ES gap < 0.10 (what `herring_stmt` accepts) | 1,216,150 |
| …of those, with \|best_cp\| < 300 | 764,706 |

So `herring_stmt` returns rows, but every one has a runner-up that is by construction an
inaccuracy. Worse: with zero rows under a 50cp raw gap, the surviving `< 0.10 ES` slice is
dominated by positions where a *large* cp gap is compressed by the LICHESS_K sigmoid —
i.e. already-winning positions where everything wins. That is the degenerate herring: a
giveaway, not a test.

Second structural limit: `game_best_moves` stores MultiPV-**2** only, so even a correctly
gated version of that table could never certify a *third* good move.

Third: **dev has 0 `game_best_moves` rows**, so red herrings are untestable locally today.
A per-environment pool fixes that as a side effect.

## Settled Design

### 1. A precomputed global pool, computed once per environment

3000–5000 positions, drawn from `game_positions` across **all** users' games. Privacy is a
non-issue — chess.com and lichess games are public data, and usernames/ELO may be shown in
the reveal.

### 2. Identity: real `(user_id, game_id, ply)`

Keep the reveal's game context (`played_in_game_san`, tactic-lines pointer, game card).
`drill_solves.game_id` already FKs `games.id` alone — **not** the composite — and carries
its own separate `user_id` FK to `users`, so a solving user referencing another user's
game needs **no migration to `drill_solves`**. Verified in `app/models/drill_solve.py:93`.

The composite `(user_id, game_id, ply)` mirrors `game_positions`' own PK and lets the pool
table FK `games(id, user_id)` for a clean CASCADE, exactly like
`game_positions_game_user_fkey`.

### 3. Selection filters

- `ply >= 12` (excludes book-y openings without needing a book lookup)
- Winnability floor: mover is not already lost — the **same** `WINNABILITY_FLOOR_ES` (0.20)
  gate the SR pool uses, from the mover's POV
- Phase-balanced: roughly equal thirds across `game_positions.phase` 0/1/2
  (opening/middlegame/endgame). `phase` is already stored and indexed; PHASE-INV-01 holds
  (`phase=2 ⟺ endgame_class IS NOT NULL`)
- Stored `eval_cp` used as a **cheap pre-filter only** (e.g. `|eval_cp| <= 200`), never as
  the authoritative gate — see Pitfall 1

Frame size is not a constraint at either environment:

| phase | prod candidates | dev candidates |
|---|---|---|
| 0 opening | 3,289,951 | 57,219 |
| 1 middlegame | 5,339,842 | 222,732 |
| 2 endgame | 2,704,928 | 127,086 |

(filter: `ply >= 12 AND eval_cp IS NOT NULL AND |eval_cp| <= 200`)

### 4. MultiPV-5, store the whole ladder

Confirm each sampled position with a **MultiPV-5** Stockfish search and store all five
`(move_uci, cp, mate)` triples raw.

At fixed nodes MultiPV-5 costs barely more than MultiPV-3, and storing the ladder makes
both "how many moves count as fine" and "what threshold is fine" **query-time** decisions,
retunable with zero re-analysis. This is the same D-05 continuous-storage pattern
`game_best_moves` already follows (`app/models/game_best_move.py` docstring: "never a
pre-converted expected-score value").

It also buys a discriminator the boolean-count design cannot: comparing PV[3]/PV[4] against
PV[0] tells you whether the position is "exactly 3 good moves" or "every legal move is
fine" — the latter being a degenerate herring worth excluding later.

Target definition of a herring (query-time, tunable): **at least 2 moves within
`INACCURACY_DROP` (0.05 ES) of the best**, preferring 3 or more.

### 5. The generator script

`scripts/gen_red_herring_pool.py`, following the `scripts/backfill_*.py` conventions.

```
--n-positions N     required. Total positions to add to the pool.
--phase {opening,middlegame,endgame}
                    optional. Generate only for that phase.
                    When OMITTED, split N into three equally sized phase buckets.
--db dev|benchmark|prod
                    per project convention; --db prod requires bin/prod_db_tunnel.sh
```

Run per environment (prod pool from prod games, dev pool from dev games) — game IDs are not
portable across databases, and both frames are large enough (table above). This is what
makes red herrings locally testable for the first time.

Shape: stratified-sample the frame → pre-filter on stored `eval_cp` → MultiPV-5 confirm on
the sample → keep the qualifiers → UPSERT. Oversample the draw, since the qualifying rate
is unknown until first run (expect lower in endgames). Idempotent and resumable — it should
be safe to re-run to top the pool up.

### 6. Consumption change

`herring_stmt` swaps its source from `game_best_moves` to the new pool table. The
`exclude_served` contract (exclude `(game_id, ply)` pairs already served to this user as
`DrillSource.RED_HERRING`, with a repeat-allowing fallback on exhaustion) carries over
unchanged, as does the recency ordering. `compose_slots` / `HERRING_SHARE` are untouched.

### 7. Empty-pool behavior: serve no herrings (already works, needs a test)

Between deploying the source swap and running the generator script, the prod pool is empty.
Decided behavior: **serve no red herrings** — sessions become 100% SR at full N.

**No new logic is required.** `compose_session`'s cross-backfill (`train_repository.py:1102`,
"Pitfall 4") already does this: an empty source yields `herring_candidates == []`, the
`elif len(herring_candidates) < herring_slots` branch fires, and the shortfall is filled
from `sr_pool`. `waiting_count` (`train_repository.py:689`) degrades honestly too — the
`herring_count` term is simply 0 in its `min(...)`.

Two follow-ups anyway:

- **Pin the zero case with a regression test.** The existing
  `test_herring_shortfall_backfills_with_sr` seeds *one* herring game — a partial
  shortfall. It hits the same branch, but this phase swaps the source out from under that
  code path, so the fully-empty source deserves its own test rather than inheriting
  confidence from the partial one.
- **Guess-accuracy data from the empty window is unusable.** With no herrings, "one
  critical move" is always the correct guess. Harmless over a short deploy window, but
  exclude that period from any later anti-tell analysis (see Deliberately Deferred).

## Pitfalls

1. **Ply-indexing ambiguity — the one that will silently corrupt the pool.**
   `pool_entry_stmt` and `herring_stmt` both read the winnability eval from `ply - 1`
   ("Pitfall-2 prior-ply eval source"), but `game_positions.pv` is documented as stored at
   `flaw_ply + 1`, and `game_positions.best_move`'s comment calls its row "the pre-move
   position". These conventions do not obviously reconcile, and a plan that guesses will
   gate on the wrong position's eval. **Design around it:** take the authoritative eval
   from the script's own MultiPV PV[0] on the exact board it searched. Then an off-by-one
   in the stored-`eval_cp` pre-filter costs a slightly noisier sample, never a wrong pool.

2. **CASCADE durability.** A pool FK'd to `games(id, user_id)` with `ondelete=CASCADE`
   silently loses rows when a source user re-imports or deletes their account — which
   quietly erodes a "compute once" pool. Store the **FEN on the pool row** so the puzzle
   survives independently, and treat the game link as a nullable garnish for the reveal.
   The reveal must then degrade gracefully when the game link is gone (no
   `played_in_game_san`, no tactic-lines pointer).

3. **Spec amendments — do these or a future audit marks a broken definition green.**
   - `POOL-03` in `.planning/REQUIREMENTS.md` (red herrings from non-gem
     `game_best_moves`)
   - Phase 189 success criterion #2 in `.planning/ROADMAP.md` (same wording)
   - `.planning/PROJECT.md:28` ("red herrings from non-gem `game_best_moves`")
   - `herring_stmt`'s docstring, which reasons at length about a tier-NULL + gap
     combination that the population gate makes moot

## Deliberately Deferred

**Anti-tell distribution matching.** The 75% SR items are the user's own blunder positions
— systematically tense and tactical. A phase-stratified random herring pool will be
systematically calmer, so users could learn "board looks quiet → several fine moves" and
raise their herring accuracy without improving at chess. Considered and **explicitly
deferred** (2026-07-27): the pool is cheap to regenerate, so this gets revisited with real
data rather than designed away up front.

The check, when it happens: compare herring `correct_guess` rate against sharp/soft over
time in `drill_solves`. Herring accuracy climbing disproportionately is the tell.

Candidate levers if it does: constrain the pool to the SR items' ES band, and/or require a
tactical cue (capture available, check available, piece en prise) computed with
python-chess during the same scan.

## Rejected Alternatives

- **Standalone FEN-only pool (no game link).** Rejected: loses `played_in_game_san`, the
  tactic-lines pointer and the game card in the reveal, for no privacy benefit that
  matters on public game data.
- **Keep herrings user-scoped to the solver's own games.** Rejected: pool size would be
  bounded by each user's own history, and it forfeits compute-once-share-globally.
- **Harvest herrings from the live eval drain instead of an offline script.** The local
  lane already computes whole-game MultiPV-2 (`second_best_map`, `eval_drain.py:1009`), so
  gap < 0.05 candidates pass through it for free. Rejected for now: it needs MultiPV-3+ in
  the pipeline, changes `game_best_moves`' semantics, and produces nothing for existing
  games without a backfill anyway. Worth revisiting if the pool ever needs to be
  self-replenishing.
- **MultiPV-3 storing only a boolean + count.** Rejected: every future threshold change
  would mean re-running the whole scan, and it can never distinguish "exactly 3 good moves"
  from "every legal move is fine".
- **Lichess evals database dump as the source.** Not pursued: Stockfish compute was never
  the binding constraint (~5000 positions at MultiPV-5 fixed-nodes is well under an hour on
  the existing pool), and the dump's FEN-only positions would forfeit the game link.
