# FlawChess DB Report — 2026-07-26

- **DB**: prod
- **Snapshot taken**: 2026-07-26T18:59:12Z
- **Sections run**: users / storage / performance / sanity
- **pg_stat_statements window**: since `stats_reset` 2026-06-23T20:35:32Z (~32.9 days)

## 0. Users Overview

### User summary

| total users | registered | guests |
|---|---|---|
| 393 | 165 | 228 |

### 10 most recent users

| id | chess.com | lichess | guest? | registered | last login | games | positions |
|---|---|---|---|---|---|---|---|
| 434 | no | no | yes | 2026-07-26 | 2026-07-26 | 0 | 0 |
| 433 | yes | no | no | 2026-07-26 | 2026-07-26 | 4,384 | 292,073 |
| 432 | no | no | yes | 2026-07-26 | 2026-07-26 | 4 | 236 |
| 431 | yes | no | yes | 2026-07-26 | 2026-07-26 | 451 | 32,841 |
| 430 | no | no | yes | 2026-07-26 | 2026-07-26 | 0 | 0 |
| 429 | no | no | yes | 2026-07-26 | 2026-07-26 | 0 | 0 |
| 428 | no | no | yes | 2026-07-26 | 2026-07-26 | 0 | 0 |
| 427 | yes | no | no | 2026-07-26 | 2026-07-26 | 2,031 | 127,336 |
| 426 | no | no | yes | 2026-07-26 | 2026-07-26 | 0 | 0 |
| 425 | no | no | no | 2026-07-26 | 2026-07-26 | 0 | 0 |

### Platform breakdown

| platform | users | games |
|---|---|---|
| chess.com | 160 | 461,460 |
| lichess | 101 | 233,609 |
| flawchess (bot games) | 33 | 145 |

**Activity note.** All 10 most recent signups landed today (2026-07-26) — a busy day. Of those, 3 linked a platform and imported (two registered users with 4.4k and 2.0k games, one guest with 451), and 1 guest played 4 bot games; the remaining 6 never got past account creation. Guests outnumber registered users 228:165 (58%), which is expected for a try-before-signup funnel. Every recent user linked chess.com; none linked lichess.

## 1. Storage Report

### Overview

| metric | value |
|---|---|
| database size | **23 GB** |
| total games | 695,214 |
| total positions | 47,960,024 |
| avg positions / game | 69.0 |

### Per-table breakdown

| table | data | index | total |
|---|---|---|---|
| game_positions | 7,114 MB | 6,947 MB | **14 GB** |
| game_flaws | 4,980 MB | 471 MB | 5,450 MB |
| games | 2,705 MB | 1,161 MB | 3,866 MB |
| game_best_moves | 158 MB | 133 MB | 291 MB |
| opening_position_eval | 104 MB | 74 MB | 178 MB |
| benchmark_cohort_cdf | 8,184 kB | 4,784 kB | 13 MB |
| llm_logs | 64 kB | 1,832 kB | 1,896 kB |
| openings | 832 kB | 888 kB | 1,720 kB |
| worker_heartbeats | 936 kB | 56 kB | 992 kB |
| import_jobs | 216 kB | 440 kB | 656 kB |
| user_benchmark_percentiles | 336 kB | 168 kB | 504 kB |
| users | 88 kB | 104 kB | 192 kB |
| (all remaining tables) | < 200 kB each | | |

Three tables are 99.6% of the database.

### Per-index breakdown (top 20)

| index | table | size |
|---|---|---|
| game_positions_pkey | game_positions | 2,647 MB |
| ix_gp_user_endgame_game | game_positions | 1,262 MB |
| ix_gp_user_full_hash_move_san | game_positions | 976 MB |
| ix_game_positions_game_id | game_positions | 636 MB |
| ix_gp_user_black_hash | game_positions | 536 MB |
| ix_gp_user_white_hash | game_positions | 534 MB |
| ix_gp_full_hash_opening | game_positions | 354 MB |
| game_flaws_pkey | game_flaws | 242 MB |
| game_best_moves_pkey | game_best_moves | 133 MB |
| uq_games_user_platform_game_id | games | 120 MB |
| ix_game_flaws_user_severity | game_flaws | 92 MB |
| opening_position_eval_pkey | opening_position_eval | 74 MB |
| ix_games_user_played_at | games | 71 MB |
| ix_game_flaws_game_id | game_flaws | 71 MB |
| ix_game_flaws_blob_backfill | game_flaws | 64 MB |
| games_pkey | games | 57 MB |
| uq_games_id_user_id | games | 56 MB |
| ix_games_full_pv_pending | games | 30 MB |
| ix_games_full_evals_pending | games | 29 MB |
| ix_games_needs_engine_full_evals | games | 17 MB |

**Storage summary.** `game_positions` is half the database (14 GB) and its indexes (6.9 GB) nearly equal its heap (7.1 GB) — a ~0.98 index-to-data ratio, driven by seven indexes on a 48M-row table. `game_flaws` is the opposite shape: 5 GB of heap against only 471 MB of index, because the PV-blob JSONB columns dominate the rows. `games` carries a 0.43 index ratio across 10 indexes. Nothing here is pathological, but `game_positions` index bloat is where any future space savings live (see the index-usage findings below).

## 2. Performance Analysis

### Buffer cache hit ratio

**99.75%** — excellent. `shared_buffers=2GB` is comfortably serving the working set despite a 23 GB database.

### The headline: one query is 84.8% of all DB time

Across the ~33-day stats window, total execution time for all queries was **594.6 hours**. A single statement accounts for **504.1 hours (84.8%)** of it:

```sql
SELECT u.id FROM users u
WHERE u.is_guest = false   -- QUEUE-08
  AND EXISTS (SELECT 1 FROM games g
              JOIN game_flaws gf ON gf.game_id = g.id
              WHERE g.user_id = u.id
                AND g.full_evals_completed_at IS NOT NULL
                AND gf.allowed_pv_lines IS NULL)
ORDER BY -ln(random()) / (exp(-EXTRACT(epoch FROM (now() - COALESCE(u.last_activity, ...))) / $1) + $2)
LIMIT 1
```

This is the **tier-4b blob-backfill user picker**: 2,495,703 calls at 727 ms average. Sustained, that is ~0.64 of a CPU core burned continuously just choosing which user to backfill next.

`EXPLAIN (ANALYZE, BUFFERS)` on the current data (272 ms — faster than the historical average because the blob backlog has shrunk):

```
Limit (actual time=270.294..270.298 rows=1)
  Buffers: shared hit=187250 read=9521
  -> Sort (top-N heapsort)
     -> Hash Right Semi Join (actual time=20.296..254.580 rows=63)
        -> Nested Loop (actual rows=58601)
           -> Index Only Scan ix_game_flaws_blob_backfill (actual rows=187112, Heap Fetches: 46264)
           -> Memoize (Hits: 144847  Misses: 42265)
              -> Index Scan uq_games_id_user_id on games (loops=42265)
        -> Seq Scan on users (165 rows)
```

The plan is not badly chosen — it is doing exactly what it was asked. The problem is the **shape of the request**: to pick one of ~63 eligible users it fully materializes the semi-join over 187k pending-blob flaw rows and probes `games` 42k times, touching ~197k buffers. Cost scales with the *size of the backlog*, and it is re-paid on every single picker call.

### Slowest queries by average time

Everything above 5s average is a one-off ad-hoc/maintenance statement (my own past sanity-check queries, `VACUUM ANALYZE`, one-time backfill `UPDATE`s) with `calls` in the single digits — not production load. The exceptions that matter:

| avg_ms | max_ms | calls | total_ms | query |
|---|---|---|---|---|
| 13,529 | 19,620 | 24 | 324,700 | `SELECT DISTINCT game_positions.game_id … max(ply) …` (eval-hole detection) |
| 6,749 | 7,062 | 2 | 13,498 | `SELECT t.* FROM games t WHERE platform_url = $1 LIMIT $2` |
| 5,845 | 26,479 | 5 | 29,224 | benchmark `recent_capped` window query |

The 13.5s eval-hole scan runs rarely (24 calls) but is expensive each time. The `platform_url` lookup at 6.7s is a **full seq scan on a 461k-row table — there is no index on `games.platform_url`**; only 2 calls so far, but any code path that starts calling it per-game will hurt.

### Highest total time queries

| total (h) | calls | avg_ms | query |
|---|---|---|---|
| 504.1 | 2,495,703 | 727.21 | tier-4b blob-backfill **user** picker (above) |
| 51.1 | 371,316 | 495.81 | best-moves backfill **user** picker |
| 24.6 | 81,327 | 1,086.96 | full-evals/PV **user** picker |
| 5.6 | 322,929 | 62.94 | tier-4b **game** picker (per user) |
| 1.7 | 278,588 | 21.72 | best-moves **game** picker |
| 1.3 | 91,019 | 53.18 | tier-4b game picker (variant) |
| 0.4 | 150,461 | 10.71 | tier-1 user picker |
| 0.4 | 26,054 | 51.31 | `COPY game_positions` (import path, 29.8M rows) |

**The pattern is unmistakable.** The top three entries — 580 of 595 total hours, **97.5% of all database time** — are all *user-selection* queries in the eval/backfill queue. Every one of them uses the same anti-pattern: an `EXISTS` correlated over the full `games`/`game_flaws` corpus, evaluated for all 165 non-guest users, then sorted by an exponential-decay random key to pick **one** user. The corresponding *game* pickers (once a user is chosen) are 10-100x cheaper because they are user-scoped.

The actual user-facing query load (`game_positions` fetches at 0.5-0.8 ms, the `FOR KEY SHARE` FK checks at 0.01 ms) is negligible by comparison.

### Sequential scan analysis

| table | seq_scan | seq_tup_read | idx_scan | verdict |
|---|---|---|---|---|
| games | 151,445 | 82.3B | 36.7B | **Investigate** — 82 billion tuples read sequentially |
| users | 14,745,322 | 2.5B | 8.3M | OK — 393 rows, seq scan is correct |
| eval_jobs | 8,507,577 | 758M | 4.6M | OK — 333 rows |
| bot_game_settings | 401,968 | 43M | 0 | OK — 145 rows |
| oauth_account | 280,581 | 22M | 15 | OK — 129 rows |
| import_jobs | 138,922 | 39M | 3.5M | OK — 449 rows |
| game_positions | 140 | 3.8B | 54M | OK — scans are ad-hoc/maintenance |
| game_flaws | 197 | 278M | 698B | OK |

`games` is the one real flag: 151k sequential scans reading 82 **billion** tuples. At 688k live rows that is ~120k full-table passes. This is consistent with the picker queries above — and with the missing `platform_url` index.

### Index usage

**Unused or near-unused, worth acting on:**

| index | table | size | scans | verdict |
|---|---|---|---|---|
| ix_gp_full_hash_opening | game_positions | 354 MB | 2 | **Investigate** — largest genuinely idle index |
| ix_games_full_pv_pending | games | 30 MB | 0 | **Investigate** — likely superseded by `ix_games_lichess_pv_backfill_pending` (16.6M scans) |
| ix_gp_user_black_hash | game_positions | 536 MB | 333 | **Keep** — system-opening filter (white_hash/black_hash), a real but low-traffic feature |
| ix_gp_user_white_hash | game_positions | 534 MB | 192 | **Keep** — same |
| ix_game_flaws_user_severity | game_flaws | 92 MB | 561 | Keep — low traffic but small |
| ix_games_full_evals_pending | games | 29 MB | 37 | Monitor |
| llm_logs indexes (4) | llm_logs | 16-40 kB | 0 | Keep — trivial size |
| openings indexes (2) | openings | 96-488 kB | 0 | Keep — trivial size, FK/uniqueness |
| oauth/feedback/bookmark PKs | various | 16 kB | 0 | **Keep** — auth flows and FK integrity |

**Hardest-worked indexes:** `ix_game_flaws_blob_backfill` (698 **billion** scans) and `uq_games_id_user_id` (35.9 billion) — both are load-bearing for the backfill pickers. `ix_games_user_played_at` at 249M scans returning 1.09 trillion tuples read is the main user-facing workhorse.

### Dead tuples / autovacuum

| table | live | dead | dead % |
|---|---|---|---|
| worker_heartbeats | 179 | 56 | 23.8% |
| users | 393 | 109 | 21.7% |
| eval_jobs | 333 | 59 | 15.1% |
| import_jobs | 449 | 48 | 9.7% |
| game_flaws | 3,237,133 | 57,538 | 1.75% |
| game_positions | 47,991,191 | 2,754 | 0.01% |

The three tables above 15% are all tiny (hundreds of rows) and high-churn; autovacuum ran on `worker_heartbeats` 10 minutes before the snapshot and on `eval_jobs` today. `users` has never been autovacuumed but is auto-analyzed constantly and is 393 rows — irrelevant. **No action needed.** The big tables are all clean.

## 3. Sanity Checks

### Check A — Flaw counts: `games` oracle columns vs `game_flaws` — **PASS**

| metric | value |
|---|---|
| lichess games with flaw rows | 153,658 |
| lichess games with counts present | 156,151 |
| **flaws but all counts NULL** | **0** |
| exact match | 155,015 (99.27%) |
| mistake mismatch | 948 |
| blunder mismatch | 481 |

Mismatch direction: `game_flaws` over-counts in 840 games / under-counts in 108 for mistakes; over 364 / under 117 for blunders. Aggregate totals:

| | lichess columns | game_flaws | delta |
|---|---|---|---|
| mistakes | 457,968 | 459,012 | +0.23% |
| blunders | 710,281 | 710,647 | +0.05% |

The headline integrity number is **0**, per-game match rate is 99.3% (up from 98.4% at the 2026-06-12 reference), and aggregate totals agree to within a quarter of a percent. The residual per-game drift is expected disagreement between two independent classifiers (lichess win% vs our Option-B ES thresholds), with the known mate-ladder path contributing.

### Check B — Eval coverage vs oracle-column presence (Flaws Timeline gate) — **PASS**

| platform | games ≥90% coverage | ge90_but_oracle_null | ge90_oracle_present |
|---|---|---|---|
| chess.com | 271,226 | **0** | 271,226 |
| lichess | 154,572 | **0** | 154,572 |
| flawchess | 128 | **0** | 128 |

Zero games are lost to the Timeline's oracle-present gate on any platform.

### ⚠️ The skill's Check-B background prose is now stale

Both the `db-report` skill and this check's documented expectations say chess.com games have NULL oracle columns and zero `game_flaws` rows "by design," and that the ≥90%-coverage set is "effectively the fully-analyzed lichess games." **That is no longer true** — our own Stockfish analysis now populates both for chess.com:

| platform | games | oracle present | games with flaw rows |
|---|---|---|---|
| chess.com | 461,460 | 275,098 (60%) | 270,272 (59%) |
| lichess | 233,609 | 156,153 (67%) | 153,661 (66%) |
| flawchess | 145 | 131 | 130 |

chess.com is now the **larger** analyzed population (271k of the 426k ≥90%-coverage games). Two consequences:

1. Check B's "non-zero on chess.com = INVESTIGATE" rule is obsolete reasoning — chess.com clearing 0.90 with oracle present is now the normal, healthy state.
2. **Check A is scoped `platform = 'lichess'` only**, so it currently validates just 36% of the analyzed corpus. The 270k chess.com games with flaw rows have oracle columns from our own pipeline rather than lichess, so a same-source comparison there would be a tautology — but a cross-check of chess.com oracle columns against `game_flaws` would still catch pipeline drift between the two write paths.

## Summary

**Health: good. One large, specific inefficiency.**

- **23 GB**, 695k games, 48M positions, **99.75% cache hit ratio**, dead tuples negligible on every large table, both data-integrity checks **PASS** (Check A improved to 99.3% match from 98.4% in June).

- **The one thing worth acting on: queue user-selection is 97.5% of all database time.** Three near-identical "pick a user to backfill next" queries consumed **580 of 595 hours** of DB execution over the last 33 days — ~0.7 of a CPU core burned continuously. The worst offender alone (tier-4b blob backfill, 2.5M calls × 727 ms) is **84.8%** of total DB time. Each call materializes an `EXISTS` semi-join across the full `game_flaws`/`games` corpus for all 165 non-guest users, touches ~197k buffers, then sorts by a random decay key to return **one** row. Cost scales with backlog size and is re-paid every call. It also explains the 82 billion tuples read by sequential scans on `games`.

  Worth noting this is *idle-capacity* work by design, so it is not currently hurting user-facing latency (real queries run at 0.5-0.8 ms). But it is a large standing tax on an 8-vCPU box that also runs Stockfish, and it grows with the corpus.

- **`games.platform_url` has no index** — the lookup seq-scans 461k rows at 6.7s. Only 2 calls so far; fix before anything calls it in a loop.

- **Two idle indexes worth reviewing**: `ix_gp_full_hash_opening` (354 MB, 2 scans in 33 days) and `ix_games_full_pv_pending` (30 MB, 0 scans, apparently superseded by `ix_games_lichess_pv_backfill_pending`). The white_hash/black_hash indexes (1.07 GB combined, few hundred scans) are low-traffic but back the system-opening filter — keep them.

- **Documentation drift**: the `db-report` skill's Check-B background is out of date. chess.com now has oracle columns and `game_flaws` rows (270k games, more than lichess), so the "chess.com is NULL by design" framing and the "chess.com appearing = INVESTIGATE" rule should be rewritten, and Check A's lichess-only scope reconsidered.

### Recommendations

**Recommended**
1. Cut the cost of the queue user-pickers. The cheapest structural fix is to stop deriving the eligible-user set from a full-corpus `EXISTS` on every call — e.g. maintain a small "users with pending work" summary (a materialized counter per user per queue tier, updated as work completes) and run the random-decay pick against that. A 165-row candidate table would make these queries microseconds instead of ~700 ms. Given this is 85% of DB time, it is the single highest-leverage change available.
2. Add an index on `games.platform_url` (or confirm the lookup is genuinely one-off and leave it).

**Consider**
3. Drop `ix_games_full_pv_pending` (30 MB, 0 scans) after confirming no code path targets it.
4. Investigate `ix_gp_full_hash_opening` (354 MB, 2 scans) — if the global opening-stats path it serves has been superseded by `ix_gp_user_full_hash_move_san`, that is 354 MB back.

**Monitor**
5. `game_flaws` dead-tuple ratio (1.75%) — fine now, but the blob backfill rewrites rows constantly; re-check next report.
6. Re-check the picker cost after the blob backlog drains further; the EXPLAIN today (272 ms) is already well under the 727 ms window average, so part of the historical cost is backlog-driven and will decay on its own.

**No action needed**
7. Cache hit ratio, autovacuum coverage, dead tuples on large tables, the `users`/`eval_jobs`/`import_jobs` seq scans (all tiny tables where seq scan is optimal), and both sanity checks.
