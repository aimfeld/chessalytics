---
phase: 212-benchmark-full-game-analysis-lane
plan: 10
subsystem: database
tags: [postgres, benchmark, stockfish, fleet, vacuum, operator-run]

requires:
  - phase: 212-09
    provides: "The materialized 50,737-row classical selection, its 1,924,579-row eval snapshot at zero coverage gap, and the frozen decision numbers for the blocking checkpoint."
  - phase: 212-08
    provides: "The end-to-end pipeline proof on the gated build (game 72320) and the leak baseline."
  - phase: 212-07
    provides: "The gated `/entry-lease` lane, without which the run would have leaked fleet capacity onto unselected games."
provides:
  - "A completed classical tranche in the benchmark DB: 50,682 of 50,682 analyzable games through the real FlawChess pipeline, both arms."
  - "`reports/benchmark-lane/benchmark-lane-classical-2026-08-29.md` — tranche counts, downstream row counts, completion status, three invariant proofs, and the post-run vacuum section."
  - "The filled-in `Record of what was actually done` section of the operator runbook, empty since 212-05 created it."
  - "Proof at full-fleet multi-day scale that the selection gate holds: stamped_but_unselected delta zero."
affects: [212-VERIFICATION, benchmark-lane-runbook, benchmarks-skill]

actuals:
  tasks: 3
  commits: 1
---

# 212-10 — Classical tranche run, record, vacuum

## What happened

**Task 1 (blocking decision checkpoint)** was presented twice. The first presentation
resolved `defer-tranche`: a live re-query found 212-08's one-ply stamping defect still
open, which would have produced a 27,020-game lichess arm marked complete while holding
a single analyzed ply each — the arm that is the entire point of the paired eval-source
comparison. The second presentation, 2026-08-23 08:01 UTC, resolved `start` after
`d7b40e30a` fixed the defect and nine real games proved 98.3% mean `best_move` coverage.
Both presentations are recorded in `212-10-CHECKPOINT-RECORD.md`.

**Task 2 (the run)** executed 2026-08-23 ~08:00 UTC → 2026-08-29 ~04:33 UTC on one
worker box (the local 8-worker `ai-slim` invocation, prod-first with :8001 as fallback).
Steady state ~535–560 games/hour. No deviation from the runbook procedure: pool size
unchanged, no unplanned restart, Maia loaded correctly throughout.

**Task 3 (record, vacuum, invariants)** ran 2026-08-29 04:35–04:38 UTC.

## The tranche completed — it was not stopped at the boundary

SC6 offers two branches; this is the completion branch. Final counts: lichess arm
**27,020 / 27,020** on every axis (full evals, PV, best moves, blobs); never-analyzed arm
**23,662 / 23,717**.

The 55-game difference is not undrained backlog. All 55 have **zero movetext** — PGN
headers only (~355 bytes), a decisive result, no moves played — so each produced zero
`game_positions` rows and no lane can evaluate them. They are forfeit/no-show tournament
games from lichess Swiss and team events, and the worker log shows `204 Queue fully
empty` continuously once the last real game finished. **Against the analyzable
denominator of 50,682, the tranche is 100% complete.**

## Invariants

| Invariant | Result |
|---|---|
| Gate held (`stamped_but_unselected`) | 1,805,063 vs 1,805,063 baseline — **delta zero** |
| Overwrite happened | 1,736,689 / 1,924,579 snapshot plies (90.2%) differ, across all 27,020 games |
| D-04 marker survived | **27,020 / 27,020** lichess-arm games still carry `lichess_evals_at` |
| TC ordering intact | `benchmark_selection` classical only; 0 rows rapid/blitz/bullet |

The leak criterion used is `stamped_but_unselected`, not the corpus-wide
`evals_completed_at = 1,846,458` predicate this plan's text still names. That predicate
was retired during the run because it fires on correct behavior. The substitution is
deliberate and documented in the runbook and the report.

## Post-run vacuum

`VACUUM (ANALYZE)` on `game_positions`, `game_flaws`, `game_best_moves`, `games`.
Database size 56,612,714,175 → 56,612,812,479 bytes (**+96 KB**). The on-disk delta is
not a reclaim and is the expected result: plain `VACUUM` returns dead rows to the free
space map, not to the filesystem. `VACUUM FULL` was deliberately not run — the runbook
specifies the plain form, and a full rewrite of a 38 GB table under an exclusive lock
buys nothing on a database due to receive three more tranches. The real reclaim shows in
the dead-tuple counts, now **0** on all four tables.

## Two things worth carrying forward

1. **Prod priority pauses look like failures and are not.** Two dips interrupted the
   run — a hard stop 2026-08-28 14:19–16:15 UTC when a user imported 1,468 chess.com
   games and prod's ladder reclaimed the fleet, and softer intermittent competition
   21:00–00:00 UTC. Both are the documented fallback contract working. Neither needed
   intervention.
2. **`pgrep stockfish` returns zero while the fleet is at full tilt.** The binary is
   `~/.local/stockfish/sf`. This cost a wrong "the fleet is idle" reading mid-run; use
   `ps --ppid <worker-pid>` instead. Now recorded in the runbook.

## Deviation from plan

Task 2's `<resume-signal>` expected a typed operator token. In practice the run was
monitored programmatically and its terminal state established from the queue returning
`204 empty` plus the zero-movetext analysis of the residue, which is stronger evidence
than the typed signal would have been.
