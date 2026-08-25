---
task: SEED-153 step 2 — disagreement scan + sampler
status: complete
branch: study/seed-153-disagreement-hunt
date: 2026-08-24
---

# SEED-153 step 2 — complete

## Deliverable

`scripts/engine_disagreement_study/data/seed153_manifest.ndjson.gz` — **18,265 rows**
(12,816 middlegame, 5,449 endgame), one per game, over the D-06 frame. Carries both arms'
scores, ratings, tc, phase, termination, clocks, `move_san`, result and `material_white`,
so step 3's FlawChess sweep and step 4's analysis join without rescanning. A `boundary`
alias of `phase` keeps `stage_b_sweep.mjs`'s `(game_id, boundary)` resume key working.

## Measured

| quantity | value |
|---|---|
| games scanned | 29,471 |
| positions scored | 1,436,938 |
| scan wall-clock | 2.94 h at 136 pos/s |
| incidence (evaled denominator) | **3.80%** (range 3.64-3.94, sd 0.085) |
| incidence (scannable denominator) | 3.99% |
| incidence MG / EG | 4.71% / 3.06% |
| games yielding >= 1 qualifier | 62.0% |
| qualifiers per selected game | mean 3.14, max 31 |
| SF picks winner (decisive) | 66.9% |

Stop condition cleared: first shard 3.86%, inside the pre-committed 1-4% band on the
denominator comparable to the seed's 2.13%.

Power targets (6,600 MG / 4,500 EG) cleared with 1.9x and 1.2x headroom. The binding
constraint is the ENDGAME arm, because D-05 takes one row per game and qualifiers cluster.

## Verification

`seed153_verify_manifest.py` recomputes every claim from raw fields: D-02 selection rule,
E-09 sigmoid (through the app's own helper), Trap-1 POV flip, D-04 mate exclusion, D-05
one-row-per-game across the union of shards. **Zero violations on all 18,265 rows.**

The gate was mutation-tested before being trusted — 7 seeded defects, 7 caught.

## Incident: rank-window sharding

The first 15-shard run failed the gate with 9 duplicate `game_id`s. Cause: the benchmark DB
is not static — the eval backfill grew the frame 324,546 -> 325,182 during the run, and
`ROW_NUMBER()` rank windows couple every game's shard to how many games sort before it.
Games near a boundary were scanned twice; a similar number were skipped outright. Both
silent.

Fixed to hash-residue sharding (`md5(id||seed) % num_shards`), which no later insert can
perturb, and the full scan was re-run clean. Verified over the live frame: 160 shards, all
populated, 1,907-2,134 games each.

## Open for the user

- The 4.04% scannable-denominator reading on shard 0 is marginally outside the 1-4% band.
  The evaled denominator (3.86%) was treated as the comparable one; recorded in the seed.
- Step 3 (FC tail sweep) must run INLINE in the orchestrator session, never as a subagent.
