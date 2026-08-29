# FlawChess Benchmark Lane Report — classical — 2026-08-29

- **Tranche**: classical
- **Snapshot taken**: 2026-08-29T04:35:49Z

## Tranche progress

Exact `COUNT(*)` aggregates, `benchmark_selection` joined to the `games` completion columns, split by `lichess_arm`.

| Arm | Selected | full_evals_done | full_pv_done | best_moves_done | blobs_done |
|---|---|---|---|---|---|
| lichess_arm | 27,020 | 27,020 | 27,020 | 27,020 | 27,020 |
| never_analyzed_arm | 23,717 | 23,662 | 23,662 | 23,662 | 23,662 |

- **benchmark_lichess_eval_snapshot rows (lichess arm only)**: 1,924,579
- **Percent complete (best_moves_done / selected)**: 99.9%

## Downstream row counts (SC6)

Each row is an exact `COUNT(*)` scoped to this tranche via a join through `benchmark_selection` -- never a `pg_class.reltuples` estimate.

| Metric | Count |
|---|---|
| `game_positions` rows with non-NULL `best_move` | 3,266,036 |
| `game_positions` rows with non-NULL `pv` | 520,613 |
| `game_flaws` rows | 309,213 |
| `game_best_moves` rows | 384,885 |

## Provenance

Every row above is scoped to this tranche via `benchmark_selection`. `benchmark_selection.lichess_arm` is the split key for eval provenance: rows with `lichess_arm IS TRUE` were re-evaluated by our Stockfish despite having lichess evals at import time (`BENCHMARK_HOMOGENIZE_EVAL_SOURCE`, D-03); a game with no `benchmark_selection` row at all remains untouched, lichess-classified data. See `.claude/skills/benchmarks/SKILL.md` § 5 "Mixed eval provenance in `game_flaws`" for the full disclosure (D-06).

## Completion status — the tranche is complete, not stopped

The classical tranche ran from 2026-08-23 ~08:00 UTC to 2026-08-29 ~04:33 UTC and
reached its terminal state; it was **not** stopped early at the TC boundary, and this
is not a partial result.

The 55-game gap between 23,717 selected and 23,662 completed in the never-analyzed arm
is **not undrained backlog**. All 55 games have zero movetext — PGN headers only (~355
bytes), a decisive result, and no moves played — so they produced zero `game_positions`
rows and there is nothing for any lane to evaluate. They are forfeit/no-show tournament
games from lichess Swiss and team events. The worker log shows the queue answering
`204 Queue fully empty` continuously once the last real game finished.

**The analyzable denominator is 50,682, and 50,682 of 50,682 completed (100%).** The
99.9% headline above divides by the selected count including these 55. A later tranche
should not expect them to resolve.

The lichess arm is complete on every axis with no residue at all: 27,020 / 27,020 full
evals, PV, best moves and blobs.

## Invariants

### 1. The gate held across the whole multi-day, full-fleet run

| Measure | Baseline | Now | Delta |
|---|---|---|---|
| `stamped_but_unselected` | 1,805,063 | **1,805,063** | **0** |

No game outside `benchmark_selection` was stamped at any point during the run. This is
the multi-day, full-fleet version of the check 212-08 ran over minutes with one worker,
and it is the real proof that 212-07 closed the ungated entry-ply lane.

**On the criterion itself**: 212-10's plan text still names the *retired* corpus-wide
predicate (`evals_completed_at` must equal 1,846,458). That predicate was superseded
during the run because it fires on correct behavior — it moved +9,342 during the smoke
drain with every one of those games inside `benchmark_selection`. `stamped_but_unselected`
is the replacement and is what is reported here. This is a deliberate substitution, not
a missed acceptance criterion.

### 2. The homogenized overwrite happened, and D-04 held

| Measure | Value |
|---|---|
| Snapshot plies compared | 1,924,579 |
| Plies whose stored eval now differs from the preserved lichess value | **1,736,689 (90.2%)** |
| Distinct lichess-arm games with at least one overwritten ply | **27,020 (all of them)** |
| Lichess-arm games still carrying `lichess_evals_at` (D-04) | **27,020 / 27,020 (100%)** |

Concrete instance, game 72283:

| ply | lichess snapshot cp | our engine cp | `lichess_evals_at` intact |
|---|---|---|---|
| 0 | 18 | 34 | yes |
| 1 | 22 | 32 | yes |
| 5 | 54 | 66 | yes |

So the paired same-position comparison stays possible: the snapshot preserves what
lichess said, `game_positions` now holds what our engine says, and
`benchmark_selection.lichess_arm` remains the split key.

### 3. TC ordering intact

`benchmark_selection` holds classical only — 0 rows for rapid, blitz and bullet. No
later tranche was selected or snapshotted while this one was in flight, so the program
remains stoppable at a clean boundary.

## Post-run vacuum

`VACUUM (ANALYZE) game_positions, game_flaws, game_best_moves, games;` run 2026-08-29
04:37 UTC with the write-capable `flawchess_benchmark` role.

| Measure | Value |
|---|---|
| Database size before | 56,612,714,175 bytes (53 GB) |
| Database size after | 56,612,812,479 bytes (53 GB) |
| Delta | **+98,304 bytes (+96 KB)** |

**The on-disk delta is not a reclaim, and that is the expected outcome.** Plain `VACUUM`
returns dead row versions to each table's free space map for reuse by subsequent writes;
it does not return extents to the filesystem. Only `VACUUM FULL` shrinks the files, and
it is deliberately not run here — the runbook (§7) specifies the plain form as
sufficient, and a full rewrite would need a second copy of a 38 GB table plus an
exclusive lock for no benefit on a database that will receive three more tranches.

The reclaim that actually matters is visible in the dead-tuple counts, all now at or
near zero after the churn of ~50.7k UPDATE-heavy game analyses:

| Table | Live tuples | Dead tuples | Total size |
|---|---|---|---|
| `game_positions` | 190,965,068 | **0** | 38 GB |
| `games` | 2,755,825 | **0** | 13 GB |
| `game_flaws` | 4,306,792 | **0** | 1,338 MB |
| `game_best_moves` | 384,885 | 76 | 30 MB |

That space is now available for the rapid tranche without growing the volume.
