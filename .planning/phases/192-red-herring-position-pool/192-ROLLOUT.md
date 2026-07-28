# Phase 192 — Production Rollout Record (D-13)

Operational record for the one-shot `herring_pool` generation against production.
Plan 05's SUMMARY closed with this as the phase's only remaining non-code step
(D-11: run locally over `bin/prod_db_tunnel.sh`, never on the prod server).

## Deploy

- Release PR #283 (`main` → `production`), squash-merged as `6b5bdf1d`.
- `bin/deploy.sh` verified the production server at `6b5bdf1d` on **2026-07-28 11:52:58 UTC**.
- D-13 ordering honoured: the `herring_stmt` source swap was deployed **before** the
  generator ran, so no window existed where the old `game_best_moves` source was live.

## D-13 empty-pool window

Guess-accuracy data collected inside this window is **unusable for anti-tell analysis** and
must be excluded from any later study: with an empty `herring_pool`, every composed session
was pure SR via `compose_and_materialize_session`'s cross-backfill, so "one critical move"
was always the correct read.

| Boundary | Timestamp (UTC) | Event |
|---|---|---|
| Window start | 2026-07-28 11:52:58 | Production reached `6b5bdf1d`; `herring_stmt` now reads an empty `herring_pool` |
| First rows committed | ~2026-07-28 12:04 | First `HERRING_COMMIT_EVERY`=50 batch landed (run started 12:03:36, first ACCEPT 12:03:40) |
| Window end | 2026-07-28 14:02:07 | Generation complete, all three phase buckets at target |

Effective duration: **~11 minutes** of a genuinely empty pool (11:52:58 → ~12:04), and
~2h09m total until the pool was fully stocked. Herrings began appearing in composed
sessions from the first committed batch onward, so the strict exclusion window is the
former; the latter is a period of a growing-but-thin pool.

## Generation run

`uv run python scripts/gen_red_herring_pool.py --db prod --n-positions 5000`
(12:03:36 → 14:02:07 UTC, 1h58m31s, single local Stockfish worker at 1M nodes MultiPV-5,
zero prod CPU consumed by the search).

| Phase | Target | Stored | Examined | Bucket finished |
|---|---|---|---|---|
| opening | 1668 | 1668 | 1808 | 12:44:57 |
| middlegame | 1666 | 1666 | 1927 | 13:29:32 |
| endgame | 1666 | 1666 | 2141 | 14:02:07 |

Every bucket hit its target; none exhausted the `HERRING_OVERSAMPLE_FACTOR`=20 budget
(worst case, endgame, used 2141 of a 33320 candidate allowance).

Tally:

```
Scanned: 5876
Rejected (fewer than 5 legal moves / engine failure): 244
Rejected (ply-mover mismatch): 0
Rejected (FEN unreconstructable): 0
Rejected (below loose qualifying-moves band): 632
Duplicate (already in pool, ON CONFLICT skipped): 0
Stored and written: 5000
```

Observations worth keeping:

- **Accept rate was 85%** (5000 / 5876), far above the ~1:1 the Plan 01 tracer assumed when
  `HERRING_OVERSAMPLE_FACTOR` was pinned at 20. The factor is now provably conservative for
  prod; there is no reason to raise it, and lowering it would only matter if a future top-up
  needs to bound cost more tightly.
- **Zero ply-mover mismatches and zero unreconstructable FENs** across 5876 candidates.
  SEED-120 Pitfall 1's ply-indexing drift did not materialise in prod data.
- **Zero duplicates**, as expected on a first run into an empty table. A top-up re-run will
  show a non-zero count here — that is the resumable path working, not a defect.
- The loose qualifying-moves band (`HERRING_LOOSE_BAND_ES`) rejected 632 (11%), which is the
  gate actually doing the work of keeping degenerate "everything is fine" positions out.

## Top-up

D-14 stands: one-shot with manual top-up on demand, no cron, no depletion monitoring. The
source-game link nulls rather than cascades (D-01), so nothing erodes the pool. To top up,
re-run the same command with a larger `--n-positions` — it counts existing rows per phase
and targets only the shortfall.
