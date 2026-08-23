---
id: SEED-152
status: active
planted: 2026-08-22
planted_during: /gsd-explore — "should we run our full game analysis on benchmark games
  that have no lichess analysis, to support a series of chess data stories?"
trigger_when: the Chess Data Stories series needs FlawChess-pipeline data (best moves,
  gem/great tiers, flaw blobs, tactic tags) on benchmark-DB games — i.e. any story whose
  question cannot be answered from lichess `%eval` alone
scope: medium — one selection script + table, one config-gated candidate filter, a
  dual-URL fallback in remote_eval_worker.py, and a local backend instance pointed at
  the benchmark DB. No prod-side changes, no product surface, no user-facing change.
  The analysis itself is unattended fleet time.
---

# SEED-152: Run FlawChess full-game analysis on benchmark-DB games (local backend + dual-URL workers)

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
shrink without a `VACUUM FULL`. With the local-backend design all writes (and the bloat)
land directly in the local benchmark DB — budget roughly 2× the net figure of local disk
headroom during the run, and plan a vacuum pass afterwards. Prod disk is untouched.

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
   in exact lockstep with `full_evals_completed_at` at 17,326/day. In the local-backend
   design this means the local backend instance (Adrian's machine) carries the Maia
   inference for the gem-tier half of the work; prod's lockstep numbers say that's cheap
   relative to the Stockfish evals.

## Build Shape (revised 2026-08-22: local backend + dual-URL workers)

The original sibling-DB-on-prod design is superseded — see "Rejected topology" below.
The analysis is unattended fleet time; the actual work is four small pieces, none of
them prod-side:

1. **Selection script → `benchmark_selection` table.** Materialize the capped,
   randomly-selected eq-footing set (~397k games) as a table `(game_id, tc_tranche)`
   in the benchmark DB, populated per-TC tranche (classical first, then rapid, blitz,
   bullet). The materialized table IS the reproducibility record — a story cites the
   table, not a seed+query that must replay identically.
2. **Config-gated candidate filter.** One `WHERE EXISTS (SELECT 1 FROM
   benchmark_selection ...)` added to the tier-3 candidate query behind a config flag
   (e.g. `BENCHMARK_SELECTION_GATE_ENABLED`), off everywhere except the local
   benchmark backend. Without it, tier-3's global lottery would see all 2.1M
   eq-footing games (plus everything else) as pending.
3. **Dual-URL worker fallback.** Patch `scripts/remote_eval_worker.py` to accept an
   ordered URL list (`--base-url https://flawchess.com --fallback-url
   http://<lan-ip>:8001`): each claim cycle polls prod first and only claims from the
   benchmark backend when prod returns no work. This is strict per-claim prod
   priority — the moment prod work appears, the next claim goes there at full core
   count. It replaces the old open questions about a "backlog empty" predicate and
   interruptibility: a leased benchmark game (1 game, ~60s) simply finishes; no
   requeue logic.
4. **Local backend instance.** Run a second `uvicorn app.main:app --port 8001` on
   Adrian's machine with `DATABASE_URL` pointed at the local benchmark DB (port 5433),
   `BEST_MOVE_BACKFILL_ENABLED=true` (this instance carries the Maia/gem-tier work,
   which is backend-only), and the selection gate on. Verify the benchmark DB's
   Alembic head matches the backend before starting; run migrations against 5433 if
   not. Results land directly in the benchmark DB as they are produced — no slice-out,
   no slice-back, no merge script, no prod disk impact.

**Topology.** Adrian's machine hosts the benchmark DB and the local backend (and can
optionally run a dual-URL worker itself; the backend's Stockfish workers run under
SCHED_IDLE, so co-residency is safe for API latency, though a local worker competes
with the two other boxes for claims, which is fine). The two gaming machines on the
LAN run the dual-URL worker and reach the local backend via its LAN IP (`0.0.0.0`
bind + worker token auth) — no tailscale needed. What the fleet-topology memory
records as "one 4-worker box at 194.191.211.24" is in fact these several machines
NAT'd behind one IP.

**Rejected topology (recorded for the record):** the originally-planned sibling DB on
the prod host with a new lowest-priority claim lane in `eval_queue_service.py`.
Killed for two reasons: (a) the queue service is bound to the single app DB via
`async_session_maker`, so a sibling-DB lane means dual-DB routing through *every*
worker-facing path (claim, atomic submit, flaw classify, best-move write, lease
expiry) — the riskiest place in the codebase to add it (see
[[project_atomic_eval_submit_incremental_lease]]); (b) it needs slice-out and
slice-back scripts whose cross-DB row merge is the most error-prone piece, plus prod
disk/MVCC exposure. The "remote workers can't reach Adrian's box" objection that
motivated it evaporated once the worker machines turned out to be on the same LAN.
If some future worker is genuinely off-LAN, the fallback is a second backend
container on the prod host serving a sliced sibling DB with the same dual-URL worker
(no queue-service changes) — the worker patch is shared between both designs.

## Open Questions

- **Eval-source homogeneity for the lichess arm.** As designed, the analyzed arm keeps
  lichess `%eval` (preserved per `eval_drain.py:836`) and flaws are classified from
  stored `eval_cp` — so analyzed-arm flaws derive from *lichess's* Stockfish while the
  never-analyzed arm gets *ours*. Any analyzed-vs-unanalyzed comparison (the §6
  selection-bias check this seed exists to enable) then confounds selection bias with
  eval source. The MultiPV-2 pass computes our evals for lichess-arm games anyway and
  discards them; since this is a research DB (not user data), the fix is cheap: store
  our engine evals for the lichess arm too (overwrite `eval_cp`, or add a column and
  keep both). Decide before the classical tranche runs.
- **Whether to re-analyze the lichess arm at all in the first tranche.** It is half of
  classical and the most expensive per game. Deferring it would halve classical to ~27k
  games / 1.7 days, at the cost of leaving gem tiers unavailable on the games that already
  have evals. If it does run, run it *with* the eval-source homogenization above, or the
  Stockfish price buys a confounded comparison.
- **Local backend config details.** Confirm the local instance runs cleanly with a
  minimal Stockfish pool (default `STOCKFISH_POOL_SIZE=1`; the fleet does the evals) and
  with import/auth surfaces effectively unused; check what `EVAL_AUTO_DRAIN_ENABLED`
  should be so the local drain doesn't bypass the worker claim path unintentionally.
- **Sustained throughput.** 16k/day is a two-day observed peak with all machines up;
  budget ~60–70% sustained over a multi-week run. The TC-ordered tranches make the
  program stoppable at any boundary, so this only stretches the calendar, not the risk.

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
