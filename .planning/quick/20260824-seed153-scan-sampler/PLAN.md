---
task: SEED-153 step 2 — disagreement scan + sampler
branch: study/seed-153-disagreement-hunt
seed: SEED-153
date: 2026-08-24
---

# SEED-153 step 2: scan + sampler (D-02 .. D-07)

Emit an NDJSON manifest of positions where Stockfish and Maia favour opposite
sides by a real margin, one randomly chosen qualifying ply per game, over the
D-06 frame — carrying enough payload that the FlawChess sweep (step 3) and the
analysis (step 4) join on it without ever rescanning.

## Tasks

1. `seed153_scan_sample.py` — D-06 frame, deterministic sharding, PGN-replay
   FENs, E-10 payload, Stockfish white-POV expected score via the app's own
   sigmoid (E-09). D-04 drops mate plies but counts them.
2. `seed153_scan.mjs` — batched Maia value head (batch 32 x 12 workers, the
   step-1 measured optimum), D-02 selection rule, D-05 per-game random pick
   seeded per game so re-runs reproduce the manifest.
3. `seed153_run_shards.sh` — sequential, resumable shard driver.
4. **Stop condition**: report shard-0 incidence before scanning the full
   target; halt if outside 1-4%.

## Verification

Every emitted row must satisfy, independently recomputed:
- D-02: `sign(sf-0.5) != sign(maia-0.5)` and `|sf-maia| >= 0.20`
- E-09: `sf_score_white == 1/(1+exp(-K*eval_cp))`
- Trap 1: `maia_score_white` is the side-to-move flip of `maia_score_stm`
- D-04: no `eval_mate` row survives
- D-05: exactly one row per `game_id`
