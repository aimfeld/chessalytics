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
  SEED-120 Pitfall 1's ply-indexing drift did not materialise in prod data. (Superseded by
  the regeneration below, which DID hit 34 mismatches once it sampled 116 users instead of
  4 — the drift is real but rare, and confined to games this run never reached.)
- **Zero duplicates**, as expected on a first run into an empty table. A top-up re-run will
  show a non-zero count here — that is the resumable path working, not a defect.
- The loose qualifying-moves band (`HERRING_LOOSE_BAND_ES`) rejected 632 (11%), which is the
  gate actually doing the work of keeping degenerate "everything is fine" positions out.

## Regeneration, same day (SEED-124)

Inspecting the pool immediately after the run above showed it was drawn from **4 users out
of 175**, across 444 games, with single games contributing up to 59 near-duplicate
consecutive plies. Cause: the keyset scan walks the PK in order from a random start, and at
the 85% accept rate it actually achieved (vs the ~1:1 the tracer assumed) a bucket hit
target long before leaving the first user it landed on. The sampler's fairness argument
rested on an assumed REJECTION rate, so it silently stopped sampling fairly the moment the
rejection rate improved.

Fixed in `858c656d` (per-user + per-game caps checked before the Stockfish call, cursor
seeks past a capped user, cap counters seeded from existing rows, `--reset` added), then
regenerated: `--db prod --n-positions 5000 --reset`, 14:56:01 → 17:07:32 UTC (2h11m).

`--reset` deletes per phase immediately before that phase is generated, so the pool was
never fully empty — each bucket's old rows stayed servable until its replacement run began.
**No new D-13 exclusion window applies**: herrings were continuously available.

| Phase | Rows | Users | Games | Rows/game | Searched | Walked | Finished |
|---|---|---|---|---|---|---|---|
| opening | 1668 | 51 | 881 | 1.89 | 1878 | 6430 | 15:43:54 |
| middlegame | 1666 | 51 | 969 | 1.72 | 2072 | 8468 | 16:28:59 |
| endgame | 1666 | 51 | 906 | 1.84 | 2215 | 14288 | 17:07:32 |

Pool-wide: **5000 rows, 116 distinct users, 2562 distinct games** (was 4 users / 444 games).
Both caps bind exactly — max 34 rows per user per phase, max 2 per game, no exceptions.

```
Rejected (fewer than 5 legal moves / engine failure): 240
Rejected (ply-mover mismatch): 34
Rejected (FEN unreconstructable): 0
Rejected (below loose qualifying-moves band): 891
Skipped before search (per-user cap): 143
Skipped before search (per-game cap): 22878
Stored and written: 5000
```

Observations:

- **22,878 cap skips cost zero engine time.** That is the whole point of checking caps before
  the search: walked 29,186 rows to search 6,165. Had the caps been applied after the search,
  this run would have taken roughly five times as long.
- **The walk budget was the necessary companion to the caps.** Endgame walked 14,288 rows
  (2.3x opening's) because endgame positions are sparser per game; against the old shared
  budget that alone would have read as "gave up: oversample budget exhausted".
- **34 ply-mover mismatches appeared** where the first run saw none — SEED-120's ply-indexing
  drift is real, rare, and confined to users the concentrated run never sampled. Log-and-skip
  handled them; no Sentry event, no crash.
- **Band rejects rose to 891 (14%, from 11%)**, consistent with sampling a broader population
  rather than one user's game profile.

## Top-up

D-14 stands: one-shot with manual top-up on demand, no cron, no depletion monitoring. The
source-game link nulls rather than cascades (D-01), so nothing erodes the pool. To top up,
re-run the same command with a larger `--n-positions` — it counts existing rows per phase
and targets only the shortfall. Since SEED-124 the cap counters are seeded from the rows
already stored, so a top-up spreads across NEW users rather than topping up whoever the
previous run drew from. Use `--reset` only when existing rows are known-bad; it discards
real MultiPV-5 search work.
