---
title: Benchmark full-game-analysis lane runbook
date: 2026-08-22
context: operator procedure for running the Phase 212 benchmark full-game-analysis
  lane -- a second FlawChess backend on port 8001, pointed at the benchmark
  Postgres on 5433, that puts a capped/random/equal-footing slice of the benchmark
  DB through the real analysis pipeline (best_move + pv, game_flaws, game_best_moves)
  via the existing worker fleet's dual-URL fallback. Written as part of Phase 212
  (Benchmark Full-Game Analysis Lane), plan 05, so the whole operating procedure
  survives a multi-week gap between the classical/rapid/blitz/bullet tranches
  without re-reading the phase's planning artifacts.
source: scripts/benchmark_lane.py, scripts/remote_eval_worker.py, bin/benchmark_db.sh,
  app/core/config.py, .planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md
---

# Benchmark full-game-analysis lane runbook

This is the procedure for running the Phase 212 benchmark lane: a second local
FastAPI backend on port 8001, talking to the benchmark Postgres on port 5433, that
puts one TC tranche's capped/random/equal-footing games through the real analysis
pipeline via the same worker fleet that already drains prod.

> **Never run these while a tranche is in flight:** `bin/benchmark_db.sh reset` and
> `bin/reset_db.sh`. Both are destructive. `bin/benchmark_db.sh reset` destroys the
> **entire 641,855-game benchmark corpus**, not just the tranche currently running --
> there is no scoped undo. `bin/reset_db.sh` targets the *dev* database, but running
> it while the local :8001 backend is up risks confusing which database a given
> terminal session is pointed at; treat both as off-limits mid-run.

## 1. Bring up the benchmark DB

```bash
bin/benchmark_db.sh start
```

This brings up the `flawchess-benchmark` Postgres container on `localhost:5433`,
waits for it to report healthy, runs `alembic upgrade head` against it, and
re-applies the `flawchess_benchmark_ro` read-only grants (idempotent, safe to
re-run on every start).

Confirm the benchmark DB's Alembic head matches dev's before doing anything else --
a head mismatch means a migration landed on one side and not the other, and the
tranche should not start until they agree:

```bash
DATABASE_URL="postgresql+asyncpg://flawchess_benchmark:<password>@localhost:5433/flawchess_benchmark" \
  uv run alembic current
uv run alembic current   # dev, via the default DATABASE_URL
```

Both must print the same revision hash.

**Preflight: re-confirm the explicit-job queue is empty.** The worker fleet's
rung 1 (`/atomic-lease?scope=explicit`) claims from `eval_jobs`, which the
selection gate does NOT scope (see §3's per-rung table below) -- it is fed only
by explicit user-requested enqueue, and on the benchmark instance there is no
enqueue surface, so this was confirmed empty by direct query on 2026-08-22.
Re-run that query before each tranche rather than trusting this note: a
non-zero count would mean a genuine unscoped lane, not a theoretical one.

```bash
DATABASE_URL="postgresql+asyncpg://flawchess_benchmark:<password>@localhost:5433/flawchess_benchmark" \
  uv run python -c "
import asyncio
from sqlalchemy import func, select
from app.core.database import async_session_maker
from app.models.eval_jobs import EvalJob

async def main():
    async with async_session_maker() as session:
        n = await session.scalar(select(func.count()).select_from(EvalJob))
        print(f'eval_jobs rows: {n}')

asyncio.run(main())
"
```

## 2. Materialize the tranche

```bash
uv run python scripts/benchmark_lane.py select --tranche classical --db benchmark
uv run python scripts/benchmark_lane.py snapshot --tranche classical --db benchmark
```

`select` materializes `benchmark_selection` for the tranche: a capped
(100 games/user/TC), randomly-selected, equal-footing (±100 opponent rating)
slice of the benchmark DB's eligible games. Idempotent -- re-running it is a
no-op except for genuinely new eligible games.

`snapshot` **must complete before the fleet starts working on a tranche
containing lichess-arm games.** Homogenization (`BENCHMARK_HOMOGENIZE_EVAL_SOURCE`,
step 3 below) overwrites the lichess-arm games' stored `eval_cp` in place with our
own engine's values, and `snapshot` -- which captures the original lichess
`eval_cp`/`eval_mate` per ply into `benchmark_lichess_eval_snapshot` -- is the
**only** recovery path for those original values. Run it, and confirm it completes,
before pointing any worker at the local backend.

**TC order is locked: classical, then rapid, then blitz, then bullet, each
completing before the next.** This is what makes the program stoppable at a clean
boundary -- do not select/snapshot a later tranche while an earlier one is still
in flight.

## 3. Launch the second backend

The exact environment, all on the launch command line -- **never write these
values into `.env`**, and **never commit the benchmark DB password**:

```bash
DATABASE_URL="postgresql+asyncpg://flawchess_benchmark:<password>@localhost:5433/flawchess_benchmark" \
EVAL_AUTO_DRAIN_ENABLED=true \
BEST_MOVE_BACKFILL_ENABLED=true \
BENCHMARK_SELECTION_GATE_ENABLED=true \
BENCHMARK_HOMOGENIZE_EVAL_SOURCE=true \
STOCKFISH_POOL_SIZE=1 \
EVAL_OPERATOR_TOKEN="<a token generated for this instance, distinct from prod's>" \
uv run uvicorn app.main:app --port 8001 --host 0.0.0.0
```

Two traps, both silent if missed:

- **Plain `DATABASE_URL`, never `DATABASE_URL_BENCHMARK`.** The running app (and
  Alembic) only ever reads `DATABASE_URL` -- `DATABASE_URL_BENCHMARK` exists solely
  for `scripts/*.py --db benchmark` to resolve through, and the app itself never
  looks at it. Setting only `DATABASE_URL_BENCHMARK` and leaving `DATABASE_URL` at
  its default silently points the backend at the dev database instead.
- **The write-capable `flawchess_benchmark` role, never `flawchess_benchmark_ro`.**
  The `_ro` suffix role is what the `flawchess-benchmark-db` MCP tool connects as
  (`GRANT SELECT` only) -- it is unrelated to what this backend needs. Using it
  fails on the very first write with `asyncpg.InsufficientPrivilegeError`.

All five environment flags above are mandatory, not tuning choices:

- `EVAL_AUTO_DRAIN_ENABLED=true` and `BEST_MOVE_BACKFILL_ENABLED=true` are BOTH
  required -- the best-move flag gates both the in-process tier-4b drain and the
  worker-facing `/bestmove-lease` endpoint, so without it the fleet's rung 5
  returns 204 forever and no gem tiers land.
- `BENCHMARK_SELECTION_GATE_ENABLED=true` scopes the lanes named in the table
  below to only the games in `benchmark_selection` -- it does NOT cover every
  lane the worker fleet can reach. Read the table before trusting this flag to
  mean "the fleet can only ever touch selected games": one rung is structurally
  out of reach on this instance for an unrelated reason, not because the gate
  covers it.
- `BENCHMARK_HOMOGENIZE_EVAL_SOURCE=true` overrides `is_lichess_eval_game` to
  `False` in the write path, so the lichess-eval arm gets analyzed by our own
  engine too (this is why step 2's `snapshot` must run first).
- `STOCKFISH_POOL_SIZE=1` (D-15): this backend is a submit/Maia service, not a
  Stockfish contributor. The Stockfish throughput comes from the fleet, already
  proven at prod scale; keeping this instance's pool at 1 keeps throughput
  attribution clean when judging whether the program is on schedule, and leaves
  the box's other cores for the worker processes already running there.

### Per-rung scoping (D-13's five-rung worker ladder)

`_run_cycle` (`scripts/remote_eval_worker.py`) tries five rungs in order, each
against a single `httpx.AsyncClient`. Every rung reaches exactly one claim
function server-side; this table names each and states how `benchmark_selection`
scopes it. "Gate-scoped" means the row is invisible to this backend's claims
unless it appears in `benchmark_selection` for the tranche in flight.

| Rung | Endpoint | Claim function | Scoping |
|---|---|---|---|
| 1 | `/atomic-lease?scope=explicit` | `_claim_queued_job` (tier-1/2, reads `eval_jobs`) | **Not gate-scoped.** Fed only by explicit user-requested enqueue, never a lottery -- narrowing it would change the meaning of an explicit request. Out of reach on the benchmark instance for a structural reason: there is no enqueue surface here, confirmed by direct query (`eval_jobs` rows = 0, 2026-08-22). Re-check this count in §1's preflight before each tranche. |
| 2 | `/entry-lease` | `_claim_entry_eval_games` (entry-ply cold drain) | **Gate-scoped since 212-07.** The fifth lane, found ungated during 212-06's aborted smoke drain (see the incident record below) -- both its backlog-existence probe and this claim now carry the same `selection_gate_clause("games")` fragment. |
| 3 | `/atomic-lease?scope=idle` | `_claim_tier3_derived` (needs-engine / lichess-eval-pv-incomplete union) | Gate-scoped since 212-01. |
| 4 | `/flaw-blob-lease` | `_claim_tier4_blob` | Gate-scoped since 212-02. |
| 5 | `/bestmove-lease` | `_claim_tier4_bestmove` | Gate-scoped since 212-02. |

**The in-process server-pool drain reaches the same gated claims.** With
`EVAL_AUTO_DRAIN_ENABLED=true` mandatory (D-11), this backend also claims work
without going through the worker fleet at all: `_eval_drain_tick` ->
`_pick_pending_game_ids` calls the identical `_claim_entry_eval_games` rung-2
reaches, and `_full_drain_tick`'s bundled `claim_eval_job()` fallthrough reaches
the same `_claim_tier3_derived` / `_claim_tier4_blob` / `_claim_tier4_bestmove`
functions rungs 3-5 reach. There is no separate gate to remember for the
in-process path -- gating the shared claim function covers both consumers in
one edit.

## 4. Confirm Maia loaded

Before pointing any worker at this backend, confirm the startup log contains a
line reporting Maia loaded successfully. This is a hard precondition, not a
nice-to-have: a Maia-absent backend still produces PV normally but **silently**
never stamps `best_moves_completed_at` (`maia_available` in
`app/services/eval_apply.py`). `_build_best_move_candidates` returns an empty
list for both "Maia ran, zero candidates" and "Maia absent" -- row counts alone
cannot tell the two apart after the fact, which is exactly why this is a
startup-time check, not something to infer later from `status`.

## 5. Point the fleet at both backends

```bash
uv run python scripts/remote_eval_worker.py \
  --base-url https://flawchess.com \
  --token <prod EVAL_OPERATOR_TOKEN> \
  --fallback-url http://<lan-ip>:8001 \
  --fallback-token <this instance's EVAL_OPERATOR_TOKEN>
```

`--base-url`/`--token` are prod's existing pair (defaults to prod's URL if
omitted). `--fallback-url` points at this box's :8001 instance over the LAN;
`--fallback-token` is this instance's own `EVAL_OPERATOR_TOKEN` from step 3 (if
omitted, the fallback would default to reusing the *primary* token, which will
not authenticate against this instance's own token check).

**The fallback is only ever reached on a cycle where prod's whole five-rung
lease ladder returns no work in the same cycle** -- strict per-claim prod
priority, never interleaved with the fallback's own ladder. Repeat this
`remote_eval_worker.py` invocation across every worker box on the fleet that
should also help drain the benchmark lane; each worker independently falls
through to the benchmark backend whenever prod is idle for it.

## 6. Monitor

```bash
uv run python scripts/benchmark_lane.py status --tranche classical --db benchmark
uv run python scripts/benchmark_lane.py status --all-tranches --db benchmark
```

Prints, split by `lichess_arm`: `selected`, `full_evals_done`, `full_pv_done`,
`best_moves_done`, `blobs_done`, the `benchmark_lichess_eval_snapshot` row count
for the lichess arm, and percent complete (`best_moves_done / selected`).

If the output includes a **Maia-absent signature** warning line
(`full_pv_done > 0` but `best_moves_done == 0` across both arms), it means PV
is landing but no best-move rows are ever being stamped -- go check the :8001
startup log for "Maia loaded" (step 4) rather than waiting for it to resolve on
its own; it will not.

## 7. Stop and record

Stop at a TC boundary (do not select/snapshot the next tranche mid-run, per step
2). Then:

```bash
uv run python scripts/benchmark_lane.py record --tranche classical --db benchmark
```

Writes `reports/benchmark-lane/benchmark-lane-classical-YYYY-MM-DD.md`: the same
`status` counts as a markdown table, a downstream row-count table
(`game_positions` rows with non-NULL `best_move`/`pv`, `game_flaws` rows,
`game_best_moves` rows), and a provenance note pointing at the `benchmark_selection`
split key. Re-running `record` for the same tranche on the same day overwrites
that day's file rather than appending a second one.

After recording, vacuum the touched tables (see Disk headroom, below) --
`VACUUM (VERBOSE, ANALYZE) game_positions, game_flaws, game_best_moves;` against
the benchmark DB is sufficient; a full-database `VACUUM` is not required.

## 8. Troubleshooting

- **Startup aborts mentioning `benchmark_selection`** -- the gate
  (`BENCHMARK_SELECTION_GATE_ENABLED=true`) is on but the table doesn't exist yet,
  or `DATABASE_URL` is pointing at the wrong database. Run step 2's `select`
  first, and double-check `DATABASE_URL` against step 3's traps.
- **`asyncpg.InsufficientPrivilegeError` on the very first write** -- the
  `flawchess_benchmark_ro` role's credentials were used by mistake. Use the
  write-capable `flawchess_benchmark` role (step 3).
- **The fleet appears to do nothing on :8001** -- check whether prod still has a
  backlog first; this is correct behavior, not a bug. The fallback (step 5) is
  strictly gated on prod's whole ladder returning no work in the same cycle.
- **`full_pv_completed_at` advances but `game_best_moves` stays empty** -- Maia
  did not load in this backend process (step 4). Restart the backend and confirm
  the startup log this time; do not wait for it to self-heal.
- **The entry-ply lane (`/entry-lease`, rung 2) reports nothing to do, forever**
  -- **this is expected behavior on a gated benchmark instance, not a fault.**
  Cause: with the gate on, no game in `benchmark_selection` has a NULL
  `evals_completed_at` (either the tranche was never in the entry-ply cold-drain
  state, or it already cleared before the gate existed -- see the 2026-08-22
  incident record below). `status` will show 0 entry-ply activity indefinitely;
  that is correct, since none of the tranche's deliverables (full evals, PV,
  blobs, best moves) come from the entry-ply lane. **The different symptom that
  WOULD be a real fault:** the tier-3 lane (rung 3, `full_evals_done` /
  `full_pv_done` in `status`) staying at zero -- that is the lane the tranche
  actually depends on, and it should be advancing whenever the fleet has spare
  capacity for this backend.

## 9. Disk headroom

Budget roughly **15 KB per game net** for the tranche's writes. Because this
workload is UPDATE-heavy (evals/PV/flaws written onto existing rows, not fresh
inserts), each touched position leaves a dead row version under Postgres's MVCC
model until vacuumed -- budget **roughly twice the net figure** (~30 KB/game)
as headroom during an active run, and vacuum afterward (step 7) to reclaim it.

## Record of what was actually done

_Fill this in during/after each tranche run: TC tranche, date range, worker box
count, any deviation from the procedure above (a different `STOCKFISH_POOL_SIZE`,
an unplanned restart, a Maia load failure and its resolution), and the final
`status`/`record` output._

### 2026-08-22: aborted smoke drain and the entry-ply lane gap

A 20-game classical smoke tranche (212-06 Task 1, operator choice `start-now`)
was launched against the local :8001 backend and aborted after ~80 seconds when
`app/routers/eval_remote.py`'s `/entry-lease` endpoint was found to have zero
references to `benchmark_selection` -- the fifth lottery/claim lane the worker
fleet (and the mandatory in-process drain, D-11) can reach, ungated while the
other four (tier-3, tier-4 blob, tier-4b) were already scoped by 212-01/212-02.
212-07 closed this gap: see the per-rung table in §3 above.

**Disposition of the 76,040 games stamped during the abort.** During the ~80s
window (16:10:05-16:13:28 UTC), the ungated entry-ply lane advanced
`evals_completed_at` on 76,040 games in the benchmark DB that were never part
of any selected tranche. **Decision: no remediating action.**

The affected set is exactly identifiable -- the stamps fall inside that
3m23s window, so a single predicate on `evals_completed_at` isolates them, and
reverting is therefore technically available rather than impossible. It is not
taken because reverting has a cost and no benefit:

- Clearing the column would return those 76,040 games to the entry-ply
  backlog, where on a gated benchmark instance nothing will ever process them
  again, and on any future ungated use (a bug, or a deliberate non-benchmark
  run against this DB) they would consume fleet capacity on games nobody
  selected -- reintroducing exactly the problem 212-07 fixed.
- Nothing downstream reads the column: `evals_completed_at` is a queue marker
  only, the `benchmarks` skill does not consult it, and no eval value,
  completion column, or snapshot row was altered by the abort -- all 397
  `benchmark_lichess_eval_snapshot` rows still matched `game_positions`
  afterward.
- The stamps are consistent with the system's own documented invariant
  (`_mark_evals_completed` in `app/services/eval_entry.py`: "All *limit* games
  are marked regardless of whether they had any eval targets"), which is also
  why they were produced at a rate (~374 games/second) no Stockfish evaluation
  path could achieve -- these were zero-eval-target no-ops, not 76,040 unpriced
  engine calls.

**Residual, stated honestly:** for those 76,040 games, `evals_completed_at`
now means "was claimed by the entry-ply drain" rather than "was claimed AND
had its entry-ply positions evaluated" -- a looser meaning than the column
carries everywhere else. That is acceptable on this research database, where
the entry-ply lane's output was never this tranche's deliverable. It would NOT
be acceptable on production, where `BENCHMARK_SELECTION_GATE_ENABLED` is off
and this code path (an ungated backend reachable by the fleet) does not exist.

### 2026-08-23: reset of 8 mis-stamped classical lichess-arm games

A defect in two SEED-076-era read-path heuristics (fixed in `d7b40e30a`, see the
`tier3-branch-b-one-ply-stamp` debug session under `.planning/debug/resolved/`)
caused every lichess-arm game drained under `BENCHMARK_HOMOGENIZE_EVAL_SOURCE`
to receive exactly one analyzed ply and then be stamped complete on both
`full_pv_completed_at` and `best_moves_completed_at`. The 212-08 smoke run
produced 8 such games before the defect was found.

**Decision: reset, in contrast to the 76,040 stamps above.** The two cases look
identical in symptom and get opposite dispositions on purpose. The 76,040 were
**outside** `benchmark_selection`, so leaving them stamped costs the tranche
nothing. These 8 are **inside** the classical selection: a stamped game is one
the pipeline never revisits, so leaving them would have had the classical
tranche silently skip 8 of its own selected games while `record` counted them
as complete.

Executed 2026-08-23 with the write-capable `flawchess_benchmark` role, scoped by
the `benchmark_selection` join rather than a literal id list so it could not
reach a game outside the classical lichess arm:

```sql
UPDATE games g
SET full_pv_completed_at = NULL,
    best_moves_completed_at = NULL
FROM benchmark_selection bs
WHERE bs.game_id = g.id
  AND bs.tc_tranche = 'classical'
  AND bs.lichess_arm IS TRUE
  AND g.best_moves_completed_at IS NOT NULL;
-- UPDATE 8
```

Affected ids: 72283, 72312, 72313, 72325, 72352, 72365, 72367, 72384.

**Deliberately left alone.** `full_evals_completed_at` was NOT cleared: for the
lichess arm that is pre-existing import coverage (20,279 games carry it), not
something the defect wrote, and clearing it would misrepresent the arm's state.
The 65 `game_flaws` rows were kept, since `_classify_and_fill_oracle` is
delete-then-insert and re-analysis regenerates them; deleting them by hand would
be redundant and would risk a partial state if the re-run were interrupted. The
356 `benchmark_lichess_eval_snapshot` rows were not touched -- that is D-05's
recovery path. Only 3 plies across the 8 games had an `eval_cp` diverging from
their snapshot value; they were not restored, because the tranche runs with
homogenization on and overwrites them by design.

**Invariants confirmed unchanged across the reset:** corpus-wide
`evals_completed_at` count 1,846,458 (the leak baseline); snapshot rows
1,924,579; classical selection 50,737 with zero rows for any other tranche;
classical lichess-arm snapshot coverage 27,020 with a gap of 0. All 8 games now
satisfy the tier-3 branch (b) predicate again, with their `lichess_evals_at`
marker intact (D-04 held).

**Still outstanding:** the fix is proven by two regression tests (each confirmed
to fail with `app/` reverted) but has not yet been observed end to end on a real
drain. Re-run the 20-game smoke tranche and confirm the lichess arm reaches
engine-arm `best_move` density before committing fleet days to the full
classical tranche.

### 2026-08-23: smoke re-run passed, and the abort criterion is corrected

The 20-game smoke re-run required by 212-10's checkpoint was run against the
fixed build (`d7b40e30a`). **Result: pass.** Seven classical lichess-arm games
were analyzed between 07:45 and 07:55 UTC, each reaching 96–99% `best_move`
coverage (n-1 cells; the final ply has no successor to evaluate), with PV on a
meaningful subset — indistinguishable in shape from the engine arm. Before the
fix the same lane produced exactly 1 cell per game regardless of length.

Sample: game 2467960 (82 plies / 81 cells), 85077 (94/93), 2173648 (85/84),
214831 (28/27), 2450259 (88/87), 525731 (70/69), 668508 (40/39).

#### The leak abort criterion as written is wrong post-212-07 — do not use it

212-08 and 212-09 both froze the abort signal as: *"if the corpus-wide count of
games with a non-NULL `evals_completed_at` climbs above 1,846,458 during the
run, fleet capacity is leaking onto unselected games — stop."*

During this drain that count climbed to **1,855,800 (+9,342)** — and nothing was
leaking. Every one of the 9,342 newly stamped games is **inside**
`benchmark_selection` (9,304 never-analyzed arm, 38 lichess arm, all classical),
stamped between 07:38:35 and 07:45:27, which ends *before* the fleet worker's
first lease at 07:45:11. This was the backend's own in-process entry-ply drain
(`EVAL_AUTO_DRAIN_ENABLED=true`) at startup, at ~22 games/second, and 9,304 of
them carry no `full_evals_completed_at` — the zero-eval-target no-ops documented
in the 76,040 incident above, not engine work.

That predicate was written when the entry-ply lane was ungated, so **any** climb
did imply a leak. 212-07 gated that lane. A climb confined to selected games is
now expected, correct behavior, and the criterion as written fires on it —
meaning it would abort the real classical tranche within minutes of launch, or
be waved through by hand until it means nothing.

**Use this instead.** It expresses the actual intent — "fleet capacity is being
spent on games nobody selected" — and is invariant to how much legitimate work
the gated lanes do:

```sql
SET max_parallel_workers_per_gather = 0;  -- see the /dev/shm note below
SELECT count(*) AS stamped_but_unselected
FROM games g
WHERE g.evals_completed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM benchmark_selection bs WHERE bs.game_id = g.id);
```

**Baseline to hold flat: 1,805,063** (measured 2026-08-23 07:56 UTC, after the
smoke drain). This number is large because it counts the whole pre-existing
corpus, including the 76,040 from the 212-06 incident; its *absolute* value is
meaningless and only its *delta* matters. It provably did not move across this
drain: total stamped rose by exactly 9,342 and all 9,342 were selected, so the
unselected count is unchanged by construction.

A useful corollary reading: all 50,737 classical selected games now carry
`evals_completed_at`, so that column is fully saturated for this tranche and
will not move again during the run. Any future climb in the total is therefore
itself a leak signal — but verify with the query above rather than assuming.

#### /dev/shm exhaustion on the benchmark DB

The `stamped_but_unselected` query above first failed with
`could not resize shared memory segment ... No space left on device` while the
volume had 655 GiB free. Docker's 64 MB `/dev/shm` default is exhausted by
parallel-query DSM segments; prod already carries `shm_size: "256m"` for exactly
this reason and the benchmark compose file did not. Now added to
`docker-compose.benchmark.yml`.

It is **inert until the container is recreated** (`docker compose -f
docker-compose.benchmark.yml -p flawchess-benchmark up -d db`) — a bare
`restart` does not apply a changed `shm_size`. Do that at a boundary, not
mid-tranche. Until then, prefix analytic queries with
`SET max_parallel_workers_per_gather = 0`, which is what made the query above
succeed.
