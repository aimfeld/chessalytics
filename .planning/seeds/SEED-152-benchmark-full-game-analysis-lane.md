---
id: SEED-152
status: active
planted: 2026-08-22
planted_during: /gsd-explore — "should we run our full game analysis on benchmark games
  that have no lichess analysis, to support a series of chess data stories?"
trigger_when: the Chess Data Stories series needs FlawChess-pipeline data (best moves,
  gem/great tiers, flaw blobs, tactic tags) on benchmark-DB games — i.e. any story whose
  question cannot be answered from lichess `%eval` alone
scope: medium — one slice-export script, one sibling DB on the prod host, one new
  lowest-priority claim lane in eval_queue_service.py, one slice-import script. No
  product surface, no user-facing change. The analysis itself is unattended fleet time.
---

# SEED-152: Run FlawChess full-game analysis on benchmark-DB games (sibling-DB lane on prod)

## Why This Matters

The benchmark DB has **zero** FlawChess analysis. All 641,855 games marked analyzed carry
lichess `%eval` values only: 50,338,518 positions have `eval_cp` while `best_move` and `pv`
are NULL for every single one, and `game_best_moves` is empty. Everything the FlawChess
pipeline adds on top of raw evals — best moves, gem/great tiers, flaw blobs, tactic tags —
is unavailable on the entire benchmark population.

Two consequences for the data-story series:

1. **Whole classes of story are impossible.** Gem/great questions ("how often does a 1200
   find a move only 8% of players would find") need Maia probabilities against our own
   best-move and second-best data. Lichess evals cannot answer them at any sample size.

2. **Robustness checks have to leave the population.** `stories/two-pawns-up/two-pawns-up-report-latest.md`
   §6 could only test analysis-request selection bias by borrowing ~98 prod accounts
   clustered at 1400–2200, and its own Limits paragraph concedes "the sign of the side tilt
   need not transfer." A benchmark DB with its own evals on never-analyzed games would let
   that check run in-population.

The blocker was assumed to be compute. Measured, it isn't — see the cost table below.

## Locked Design

Decided in the planting session. These are settled, not options:

- **Population:** equal-footing games only, `abs(white_rating - black_rating) <= 100`.
  Consistent with the benchmark zone-calibration framing already in force (see
  `.planning/notes/benchmark-equal-footing-framing.md`).
- **Cap:** 100 games per user per time-control bucket.
- **Selection within a user:** **random**, not `ORDER BY played_at DESC`. A recency-biased
  cap concentrates each user's sample at the end of their history, where their rating has
  drifted furthest from the `median_elo` their cell was selected on. Every benchmark metric
  buckets on rating-at-game-time, so recency selection would systematically shift users
  toward their peak rating. Random within user preserves the distribution the cells were
  built on.
- **Time-control order:** classical → rapid → blitz → bullet. Each TC completes before the
  next begins, so the program yields usable results early and can be stopped at any TC
  boundary.
- **Scope both arms:** run the pipeline on games with *and* without lichess evals. Stored
  lichess `%eval` values are preserved unchanged; the pass exists to add best_move, PV,
  flaws, and best-move tiers.

## Cost (measured 2026-08-22, not estimated)

Fleet rate is the observed peak of **~16,000 games/day** (prod did 17,326 on 2026-08-19 and
15,685 on 2026-08-20; ~85% of that throughput is Adrian's local 4-worker box — see
[[project_worker_fleet_topology]]).

| TC | Eq-footing games | Uncapped days | **Cap 100/user/TC** | **Days** | **Cumulative** |
|---|---:|---:|---:|---:|---:|
| classical | 127,586 | 8.0 | 54,390 | 3.4 | 3.4 |
| rapid | 584,400 | 36.5 | 140,647 | 8.8 | 12.2 |
| blitz | 685,049 | 42.8 | 102,617 | 6.4 | 18.6 |
| bullet | 713,266 | 44.6 | 99,529 | 6.2 | **24.8** |
| **total** | **2,110,301** | **131.9** | **397,183** | | |

Other cap values: cap 50 → 215,269 games / 13.5 days. Cap 200 → 711,748 / 44.5 days.

**The cap is the plan, not a fallback.** Uncapped, bullet alone (44.6 days) costs more than
the entire capped four-TC program, and bullet is the cell the benchmarks care least about.
Cap 100 buys all four time controls for 19% of the games.

### Storage

Measured from prod, per analyzed game:

- `pv` + `best_move` on `game_positions`: **48 bytes/position** (`pg_column_size`, sampled),
  ~67 plies/game → ~3.2 KB/game
- `game_flaws`: 7,002 MB / 641,123 analyzed games → **11.2 KB/game**
- `game_best_moves`: 379 MB / 641,123 → **0.6 KB/game**

**~15 KB/game net.** Cap-100 scope ≈ **6 GB**. Full uncapped scope ≈ 32 GB net.

**MVCC caveat:** these are `UPDATE`s on `game_positions`, so each touched position leaves a
dead row version (~194 B in the benchmark DB's layout, ~13 KB/game). Expect the table to
grow by roughly double the net figure before autovacuum reclaims the space, and it will not
shrink without a `VACUUM FULL`. On the prod host (150 GB disk, 102 GB free as of
2026-08-22) cap 100 is comfortable; full uncapped scope on top of a 51 GB base is not.

## Two Code Facts That Change the Cost Model

Both were assumed the other way during planting and are load-bearing for sizing:

1. **Lichess-eval games are NOT cheaper to process — they are slightly more expensive.**
   Lichess never supplies PV or best move; `eval_queue_service.py:16` enqueues lichess-eval
   games precisely because `full_pv_completed_at IS NULL`, and we compute those ourselves.
   Phase 174-06 retired the old targets filter: `eval_drain.py:951` now gives lichess-eval
   games the **same full-ply MultiPV-2 pass** as any engine game, and `eval_drain.py:968`
   sets `dedup_hashes = []` for them, so they are the only games that cannot use the opening
   dedup cache. Only the *stored eval values* are preserved (`eval_drain.py:836`). Budget
   them at 100%+ of an engine game.

   Consequence for the ladder: **half of classical (63,411 / 127,586) already has lichess
   evals**, and re-running them buys best_move/PV/flaws at full Stockfish price.

2. **Maia inference cannot run on the remote worker fleet** (`eval_queue_service.py:34`).
   Best-move / gem tiering is backend-only and gated behind `BEST_MOVE_BACKFILL_ENABLED`.
   Not a bottleneck in practice: on 2026-08-19/20 the prod backend kept `best_moves_completed_at`
   in exact lockstep with `full_evals_completed_at` at 17,326/day. But it means the prod
   backend, not the fleet, is the serial resource for the gem-tier half of the work.

## Build Shape

The analysis is unattended fleet time; the actual work is plumbing.

1. **Slice out.** Export the capped, randomly-selected eq-footing game set (~397k games plus
   their `game_positions` rows) from the local benchmark DB. ~2–3 GB over the wire, not the
   51 GB full DB.
2. **Sibling DB on prod.** Host the slice as a *separate database* on the prod Postgres
   instance, not merged into the prod schema. This is the key isolation property: prod's
   `games` / `game_positions` never bloat, so hash-lookup performance, index size, and the
   2 GB `shared_buffers` cache-hit ratio are untouched. (Merging would take prod from
   808k games / 55.5M positions to ~3.4x that.)
3. **New claim lane.** `eval_queue_service.py` needs a lane below `TIER_BESTMOVE_BACKFILL`
   (tier 5) that draws from the sibling DB **only when the prod backlog is empty**. Note the
   existing tier-3 lottery is a *global* Efraimidis–Spirakis draw over users with pending
   work, so this is a genuinely new path, not a parameter. Workers already accept
   `--base-url` (`scripts/remote_eval_worker.py`), so no worker change is expected.
4. **Slice back.** Return only the produced columns and rows (`game_positions.eval_cp`/
   `best_move`/`pv`, `game_flaws`, `game_best_moves`, and the `games` completion stamps) to
   the local benchmark DB, then drop the sibling DB from prod to reclaim the space.

Rationale for the sibling-DB topology over the two alternatives considered: pointing the
fleet at a locally-hosted API against the benchmark DB fails because remote workers cannot
reach Adrian's box without joining the tailscale network, and the prod backlog is now
usually empty anyway — the fleet's idle capacity is the resource being harvested.

## Open Questions

- **Lane trigger definition.** "Prod backlog empty" needs a precise predicate. Strictly
  zero pending work, or a low-water mark with hysteresis so a single arriving prod job
  doesn't thrash the lane?
- **Interruptibility.** A TC tranche runs for days. What happens to leased benchmark games
  when a prod import arrives — finish the lease, or requeue immediately?
- **Randomness reproducibility.** The random within-user cap needs a fixed seed recorded
  with the slice, so the selected set is reconstructible when a story cites it.
- **Whether to re-analyze the lichess arm at all in the first tranche.** It is half of
  classical and the most expensive per game. Deferring it would halve classical to ~27k
  games / 1.7 days, at the cost of leaving gem tiers unavailable on the games that already
  have evals.

## Related

- `.planning/notes/benchmark-equal-footing-framing.md` — where the ±100 rule comes from
- `stories/two-pawns-up/two-pawns-up-report-latest.md` §6 — the selection-bias check this
  would let run in-population
- `.planning/notes/distributed-user-compute-rejected.md` — why the answer is server-side
  fleet capacity, not crowd compute
- [[project_worker_fleet_topology]], [[project_eval_completion_columns]],
  [[project_bestmove_backfill_two_populations]], [[project_atomic_eval_submit_incremental_lease]]

## Adjacent Finding (not part of this seed)

`benchmark_selected_users` holds **9,450 distinct users** selected from the 2026-03 dump,
but only **4,760 exist in the `users` table** — roughly half the selected cohort was never
imported. Recovering them costs an *import*, not Stockfish, and cluster-bootstrap CI width
scales with the number of accounts. Worth checking before spending fleet weeks: it may be
the cheaper statistical-power purchase.
