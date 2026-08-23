# 212-10 checkpoint record

Persisted by the execute-phase orchestrator so the Task 1 decision and its supporting
measurements survive a context clear. Folded into `212-10-SUMMARY.md` if and when the
plan resumes and completes.

## Task 1 — decision checkpoint (`gate="blocking-human"`)

**Operator choice: `defer-tranche`.**

Task 2's precondition ("Task 1's decision resolved to `start-now` or
`start-and-stop-at-boundary`") is therefore unmet, and Tasks 2 and 3 did not run. The
plan is halted at a designed stop, not failed. Nothing was overwritten; no backend was
launched on port 8001 and no worker was pointed at one.

### The five required numbers

All re-queried live against the benchmark Postgres on `localhost:5433` at decision time
on **2026-08-23**, per the plan's instruction that the readiness file exists so the
checkpoint is never *blocked* on assembling them, not so they can be quoted stale.

| # | Measure | Live value | 212-09 readiness file (08-22) |
|---|---------|-----------|-------------------------------|
| 1 | `benchmark_selection` classical rows | **50,737** — 27,020 lichess-arm (741 users) / 23,717 never-analyzed (696 users) | identical |
| 2 | Distinct classical lichess-arm games covered by the snapshot | **27,020** (1,924,579 snapshot rows) | identical |
| 3 | **Coverage gap (must be 0)** | **0** ✅ | 0 |
| 4 | Gate + homogenization flags in any environment dotfile | **absent** from `.env` and `.env.example` — both remain command-line-only for the :8001 instance | identical |
| 5 | Free disk on the benchmark volume | **655 GiB free** of 1.8 TiB (63% used); 702,851,993,600 bytes | 654.6 GiB |

Disk verdict re-confirmed: ~655 GiB against runbook §9's ~1.45 GiB transient figure for
50,737 games is roughly **450×** headroom. Disk was not a factor in the decision.

### The two numbers 212-06 did not have

| Measure | Live value | Source |
|---------|-----------|--------|
| Tranche-start leak baseline — `games` with `evals_completed_at` NOT NULL | **1,846,458** | live `count(*) FILTER (...)`; identical to 212-08's and to 212-09's frozen baseline |
| 212-08's end-to-end proof | **game 72320** — 33 `pv` cells, 130 `best_move` cells over 134 plies, all four pipeline outputs on the gated build | `212-08-SMOKE-RECORD.md` |

Corpus context, unchanged: 2,767,158 games total, 641,855 with `lichess_evals_at`,
920,700 with `evals_completed_at` NULL.

### BENCHLANE-05's written-down half — presented and accepted on the record

After a homogenized classical tranche, flaw rows in the benchmark database span two eval
sources, and `lichess_evals_at` no longer implies the stored eval came from lichess. The
split stays recoverable via `benchmark_selection.lichess_arm` per D-04, and the
disclosure already lives in the benchmarks skill alongside CONTEXT decisions D-03..D-06.
This consequence was stated before the decision, and it is why the decision is recorded
here rather than only in a summary.

## Why `defer-tranche` — 212-08's blocking finding is still open

The plan's own Task 1 context does not mention it, so it was checked live rather than
assumed resolved. It is not resolved.

Per-arm density over the classical selection's stamped games, measured at decision time:

```sql
SELECT bs.lichess_arm,
       count(*)                          AS games_stamped,
       avg(d.bm_cells)                   AS avg_best_move_cells,
       avg(d.plies)                      AS avg_plies
FROM benchmark_selection bs
JOIN games g ON g.id = bs.game_id
JOIN LATERAL (
  SELECT count(*) AS plies,
         count(*) FILTER (WHERE gp.best_move IS NOT NULL) AS bm_cells
  FROM game_positions gp WHERE gp.game_id = g.id
) d ON TRUE
WHERE bs.tc_tranche = 'classical' AND g.best_moves_completed_at IS NOT NULL
GROUP BY 1;
```

| Arm | games stamped | avg `best_move` cells | avg plies |
|-----|--------------:|----------------------:|----------:|
| never_analyzed | 10 | **35.2** | 37.3 |
| lichess | 8 | **1.0** | 45.9 |

Every stamped lichess-arm game carries exactly one analyzed ply, independent of game
length, and carries both `full_pv_completed_at` and `best_moves_completed_at` — so the
pipeline treats it as finished and will not revisit it, and `status` / `record` report
that state as success. This reproduces 212-08's finding 5 exactly.

No commit between `176fd7206` (212-08's NO-GO summary) and `46ec7efaf` (212-09's
completion) touches the stamping path. 212-09's own frontmatter records 212-08 as
providing "the go recommendation"; 212-08 in fact recommended **NO-GO for 212-09/212-10
as things stand**. The selection and snapshot 212-09 materialized are unaffected by this
and remain valid — the defect is downstream of them.

**Blast radius had the tranche started:** roughly 3.4 days of fleet time producing a
27,020-game lichess arm marked complete while holding one analyzed ply per game. That
arm is the entire point of the paired eval-source comparison the benchmark lane exists
to enable, and every count in `record` would have reported it as a pass.

## State left behind

- Nothing overwritten. The classical lichess arm's stored evals are untouched.
- `benchmark_selection` holds only the classical tranche (0 rows for rapid, blitz,
  bullet) — the locked TC ordering is intact and no later tranche was selected or
  snapshotted.
- `benchmark_lichess_eval_snapshot` holds all 1,924,579 rows at full coverage; D-05's
  recovery path stays real and was proven idempotent at full scale in 212-09.
- Nothing listening on port 8001; no `remote_eval_worker.py` running.
- Neither `bin/benchmark_db.sh reset` nor `bin/reset_db.sh` was run.
- All code from 212-01..09 is merged and inert behind command-line-only flags.

## What has to be true before this checkpoint is re-presented

1. The one-ply stamping path on the tier-3 branch (b) lane
   (`full_pv_completed_at IS NULL AND lichess_evals_at IS NOT NULL`, with
   `BENCHMARK_HOMOGENIZE_EVAL_SOURCE` forcing `is_lichess_eval_game` to False) is fixed,
   root cause established rather than worked around.
2. The 20-game smoke tranche from 212-08 is re-run and the lichess arm reaches
   engine-arm density (`best_move` cells on essentially every ply, not one).
3. The five decision numbers and the leak baseline are re-queried live again — the
   baseline in particular, since a smoke re-run touches the corpus.

Then `start-now` or `start-and-stop-at-boundary` becomes a decision about fleet days
rather than about whether the tranche is worth producing.

---

## Task 1 — second presentation, 2026-08-23 08:01 UTC

**Operator choice: start / continue.** The blocker that forced `defer-tranche` at
the first presentation is closed, and the drain is in fact already in flight.

All five decision numbers re-queried live and unchanged from the first
presentation: selection 50,737 (27,020 lichess-arm / 23,717 never-analyzed),
snapshot coverage 27,020 with a **gap of 0**, both flags absent from every
`.env*`, 655 GiB free (~450× the transient budget). Zero selection rows for any
tranche other than classical, so the locked TC ordering is intact.

### What changed between the two presentations

**The stamping defect is fixed and proven on a real drain.** `d7b40e30a` (see
the `tier3-branch-b-one-ply-stamp` debug session) corrected two SEED-076-era
read-path heuristics that misread homogenization's forced-False
`is_lichess_eval_game` as proof that import-populated evals were prior-round
engine work. Nine classical lichess-arm games analyzed on the fixed build from
07:40 onward average **98.3%** `best_move` coverage, worst case 96.4%, against
exactly 1 cell per game before the fix. D-04 held on all nine: the
`lichess_evals_at` marker survived.

**The leak abort criterion was replaced, not merely re-measured.** The frozen
1,846,458 predicate fired during the smoke drain (+9,342) with nothing leaking:
every one of those games was inside `benchmark_selection`, stamped by the
backend's own startup drain before the fleet's first lease. The criterion
predates 212-07's gating of the entry-ply lane and now trips on correct
behavior. Replaced with `stamped_but_unselected`, which reads **1,805,063
against a 1,805,063 baseline — delta zero**. Full reasoning in the runbook's
"Record of what was actually done", commit `7acc8d363`.

### The 8 reset games

Still undrawn at decision time — the tier-3 lottery is global and random over
27,020 arm games. Not a fault: they are back in the pool on equal footing. The
nine games above are stronger evidence anyway, never having been touched by the
defective path.

### Consequence accepted, again on the record

BENCHLANE-05's written-down half stands as recorded at the first presentation:
flaw rows now span two eval sources, `lichess_evals_at` no longer implies a
lichess-sourced eval, and `benchmark_selection.lichess_arm` remains the split
key.

### Carried into the run

- The `/dev/shm` fix added to `docker-compose.benchmark.yml` is **inert until the
  DB container is recreated**; a bare `restart` will not apply it. Until then
  prefix analytic queries with `SET max_parallel_workers_per_gather = 0`. Do the
  recreate at a boundary, never mid-tranche.
- Monitor the leak gate with the `stamped_but_unselected` query, **not** the
  retired corpus-wide count.
- Task 3 (record, vacuum, invariant proof) remains open until the tranche
  completes or is stopped at the classical boundary. This plan stays incomplete
  until then; the branch merge ships the code, not the phase.
