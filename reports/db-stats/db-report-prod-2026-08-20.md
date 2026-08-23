# FlawChess DB Report — 2026-08-20

- **DB**: prod (PostgreSQL 18.3, via `bin/prod_db_tunnel.sh`)
- **Snapshot taken**: 2026-08-20T21:42:33Z
- **Sections run**: users / storage / performance / sanity
- **Stats windows**: `pg_stat_statements` reset 2026-07-28T20:56Z (**23.0 days**); `pg_stat_database` / table+index counters reset 2026-06-23T20:35Z (**58.0 days**). The two windows differ — index-usage claims cover 58 days, query claims cover 23.

---

## 0. Users Overview

### User summary

| total users | registered | guests |
|---|---|---|
| 566 | 234 | 332 |

### 10 most recent users

| id | chess.com linked | lichess linked | guest? | registered | last login | games | positions |
|---|---|---|---|---|---|---|---|
| 608 | yes | no  | yes | 2026-08-19 | 2026-08-19 | 292 | 17,501 |
| 607 | no  | no  | yes | 2026-08-19 | 2026-08-19 | 0 | 0 |
| 606 | no  | yes | no  | 2026-08-19 | 2026-08-19 | 1,605 | 106,382 |
| 605 | yes | no  | no  | 2026-08-19 | 2026-08-19 | 619 | 46,518 |
| 604 | no  | no  | yes | 2026-08-19 | 2026-08-19 | 1 | 88 |
| 603 | yes | no  | no  | 2026-08-19 | 2026-08-19 | 1,389 | 100,165 |
| 602 | no  | yes | no  | 2026-08-19 | 2026-08-19 | 5,543 | 439,991 |
| 601 | yes | yes | no  | 2026-08-19 | 2026-08-20 | 3,432 | 247,814 |
| 600 | yes | yes | yes | 2026-08-19 | 2026-08-19 | 3,412 | 246,176 |
| 599 | no  | yes | yes | 2026-08-19 | 2026-08-19 | 1,005 | 62,670 |

### Platform breakdown

| platform | users | games |
|---|---|---|
| chess.com | 207 | 511,694 |
| lichess | 160 | 291,062 |
| flawchess (bot games) | 56 | 397 |
| pgn | 2 | 2 |

**Activity note.** All ten most recent signups arrived on a single day (2026-08-19) — an unusually concentrated burst. 8 of 10 imported real game histories (median ~1,500 games); only user 607 linked nothing at all, and 604 imported a single game. Guests are 58.7% of all accounts (332/566) but convert to real imports at a decent rate — 4 of the 5 recent guests imported. Only one of the ten (601) returned for a second session.

---

## 1. Storage Report

### Overview

| metric | value |
|---|---|
| database size | **25 GB** |
| total games | 803,155 |
| total positions | 55,222,905 |
| avg positions/game | 68.8 |

### Per-table breakdown (top consumers)

| table | data | indexes | total |
|---|---|---|---|
| `game_positions` | 7,114 MB | 6,953 MB | **14 GB** |
| `game_flaws` | 6,405 MB | 551 MB | 6,956 MB |
| `games` | 2,705 MB | 1,194 MB | 3,899 MB |
| `game_best_moves` | 205 MB | 172 MB | 377 MB |
| `opening_position_eval` | 142 MB | 83 MB | 225 MB |
| `benchmark_cohort_cdf` | 8,184 kB | 4,784 kB | 13 MB |
| `herring_pool` | 2,320 kB | 944 kB | 3,264 kB |
| `llm_logs` | 80 kB | 2,312 kB | 2,392 kB |
| `openings` | 832 kB | 888 kB | 1,720 kB |
| `worker_heartbeats` | 936 kB | 72 kB | 1,008 kB |

Everything else is under 1 MB total. The top three tables are 99% of the database.

### Per-index breakdown (top 20)

| index | table | size |
|---|---|---|
| `game_positions_pkey` | game_positions | 2,647 MB |
| `ix_gp_user_endgame_game` | game_positions | 1,262 MB |
| `ix_gp_user_full_hash_move_san` | game_positions | 976 MB |
| `ix_game_positions_game_id` | game_positions | 636 MB |
| `ix_gp_user_black_hash` | game_positions | 536 MB |
| `ix_gp_user_white_hash` | game_positions | 534 MB |
| `ix_gp_full_hash_opening` | game_positions | 361 MB |
| `game_flaws_pkey` | game_flaws | 297 MB |
| `game_best_moves_pkey` | game_best_moves | 172 MB |
| `uq_games_user_platform_game_id` | games | 120 MB |
| `ix_game_flaws_user_severity` | game_flaws | 101 MB |
| `ix_game_flaws_game_id` | game_flaws | 86 MB |
| `opening_position_eval_pkey` | opening_position_eval | 83 MB |
| `ix_games_user_played_at` | games | 71 MB |
| `ix_game_flaws_blob_backfill` | game_flaws | 64 MB |
| `games_pkey` | games | 57 MB |
| `uq_games_id_user_id` | games | 56 MB |
| `ix_games_full_pv_pending` | games | 30 MB |
| `ix_games_full_evals_pending` | games | 29 MB |
| `ix_games_needs_engine_full_evals` | games | 17 MB |

### Storage summary

- **`game_positions` carries a 0.98:1 index-to-data ratio** (6,953 MB of indexes on 7,114 MB of data) — indexes cost as much as the rows. That is the price of Zobrist-hash position matching (three hash indexes at 534/536/361 MB plus the composite `full_hash + move_san` at 976 MB) and it is a deliberate architectural trade. Across the whole DB, indexes are ~8.8 GB of the 25 GB (35%).
- **`game_flaws` is the opposite shape**: 6,405 MB of data behind only 551 MB of index, at 4.75M rows — that is **~1.35 KB per row**, which is the blob payload (FEN, PV, tactic-motif columns), not the classification itself. It is now the second-largest table and grew faster than anything else.
- `game_positions_pkey` alone (2,647 MB) is 10% of the database.

---

## 2. Performance Analysis

### Buffer cache hit ratio

**99.59%** (3.12e12 hits / 1.29e10 reads) — **excellent**, comfortably above the 99% bar with `shared_buffers=2GB` against a 25 GB database. No action.

> Side note: `xact_rollback` (106.5M) is 3.7× `xact_commit` (28.8M). This is **not** an error signal — SQLAlchemy issues `ROLLBACK` when returning a read-only connection to the pool, so every read request books a rollback. Benign.

### Total workload context

Across the 23-day window, all statements combined used **21,959 s** of execution time over **208.6M calls** — roughly **1.1% of one CPU core**. The database is not close to CPU-bound; everything below is about proportions, not pressure.

### Slowest queries by average time

| avg_ms | max_ms | calls | total_ms | what it is |
|---|---|---|---|---|
| 69,149 | 138,256 | 10 | 691,488 | `SELECT DISTINCT gp.game_id … max(ply) …` — `eval_drain.py:1254`, the holed-game resweep (`scripts/resweep_holed_games.py --db prod`) |
| 16,271 | 22,197 | 9 | 146,438 | same sweep, second parameterization |
| 3,495 | 7,297 | 18 | 62,902 | `cohort_games` CTE — benchmark cohort aggregation |
| 1,396 | 23,693 | 153 | 213,637 | `canonical_slice_sql.py` percentile slice (variant) |
| 966 | 29,443 | 458 | 442,542 | `canonical_slice_sql.py` percentile slice (main) |
| 770 | 9,457 | 30 | 23,094 | `game_flaws` bulk row fetch |
| 733 | 12,862 | 81 | 59,335 | `game_flaws` bulk row fetch |
| 508 | 1,947 | 35 | 17,766 | `game_flaws` bulk row fetch |

**Verified, not guessed:**

- The 69 s and 16 s statements are **manual maintenance sweeps**, not an app path. They map to `app/services/eval_drain.py:1254` (`resweep_holed_games`), whose docstring documents the intended prod invocation. `calls` held at exactly **10** and **9** across three samples taken minutes apart — frozen, hand-run, and inherently a full aggregate over 55M `game_positions` rows. Not a finding.
- The 966 ms / 1,396 ms statements are `app/services/canonical_slice_sql.py`, reached only via `user_benchmark_percentiles_service` from `import_service.py` and `eval_drain.py` — i.e. **background percentile refresh, never the request path**. 458 calls in 23 days (~20/day). The 29 s max is a tail on a background job, not user-visible latency. Each call touches ~1.17 GB of buffers, which is why it dominates its own row; at 20/day that is affordable.

### Highest total time queries

| total_ms | calls | avg_ms | what it is |
|---|---|---|---|
| 4,279,986 | 5,645,916 | 0.76 | tier-3 eval-queue **user** lottery (unified needs-engine ∪ lichess-eval-PV) |
| 2,261,845 | 5,395,280 | 0.42 | tier-4 blob-backfill user lottery |
| 1,664,378 | 5,296,393 | 0.31 | tier-4b best-move-backfill user lottery |
| 1,588,603 | 265,094 | 5.99 | tier-3 **game** pick (Step 2) for the drawn user |
| 691,488 | 10 | 69,149 | resweep (above — historical, hand-run) |
| 550,020 | 7,566 | 72.70 | `COPY game_positions … FROM STDIN (binary)` — import write path |
| 449,309 | 5,388,641 | 0.08 | entry-eval lease scan |
| 442,542 | 458 | 966 | percentile slice (background) |
| 351,404 | 107,875 | 3.26 | tier-4 blob game pick |
| 272,696 | 433,735 | 0.63 | `opening_position_eval` hash batch lookup |

**The headline is call volume, not query cost.** The eval-drain polling family (six statements: three user lotteries, the two game picks, the lease scan) accounts for **~10,700 s of the 21,959 s total — 49% of all database execution time** — spread across **~27M calls in 23 days (~13.5 polls/sec)**. Every individual call is sub-millisecond to 6 ms; nothing is slow.

**Checked before writing this up, per the skill's mandatory rule:**

1. **Still live?** Yes. `queryid -621834049101684171` grew 5,645,916 → 5,646,017 → 5,646,505 across three samples. Same for the other lottery shapes. These are not frozen artifacts.
2. **Still in the source?** Yes, and **already optimized**. `app/services/eval_queue_service.py:602-616` contains the exact split-EXISTS form (guest guard distributed onto branch (a) as an outer conjunct), with an inline comment crediting the 260729-a86 rewrite and "the measured prod query-plan rationale." At 0.76 ms mean this is the *post-fix* shape performing as designed.

**Conclusion: no query rewrite is warranted.** The prior report's trap (recommending a rewrite that had already shipped) does not recur here — the top statement is the fixed version, and it is cheap per call.

### Sequential scan analysis

| table | seq_scan | seq_tup_read | idx_scan | live rows | verdict |
|---|---|---|---|---|---|
| `users` | 31,154,967 | 11.1e9 | 13,783,175 | 566 | **Expected** — 566 rows fit in a handful of pages; the planner is right |
| `eval_jobs` | 8,976,834 | 1.04e9 | 15,702,320 | 1,007 | **Expected** — tiny table |
| `oauth_account` | 601,107 | 73.4M | 242 | 182 | **Expected** — tiny |
| `bot_game_settings` | 435,340 | 51.6M | 17,284 | 397 | **Expected** — tiny |
| `drill_items` | 319,090 | 98.6M | 1,679,556 | 601 | **Expected** — tiny |
| `games` | **210,032** | **123.9e9** | 44.9e9 | 791,136 | **Unexplained — see below** |
| `game_positions` | 230 | 6.49e9 | 97.9M | 55.2M | Fine — 230 scans in 58 days, from the resweep/benchmark jobs |
| `game_flaws` | 272 | 384.6M | 698.5e9 | 4.75M | Fine — overwhelmingly index-driven |
| `openings` | 2,447 | 8.9M | 0 | 3,641 | **Expected** — small lookup table, never worth an index |

**`games` is the one row worth a second look.** 123.9e9 tuples read across 210,032 sequential scans works out to ~590k rows per scan — i.e. these are *full* table scans, ~3,600/day over the 58-day counter window. I could not pin them to any statement in the current `pg_stat_statements` window: the highest-volume `games` reader (`-621834049101684171`) touches only ~1,483 blocks/call against a 346k-page table, nowhere near a full scan. The most likely explanation is that the scans **predate the 2026-07-28 statement-stats reset** (the table counters go back 5 weeks further, covering the July backfill sweeps) rather than being ongoing. Cache hit stays at 99.59% and the DB is at ~1% of a core, so there is no user-visible symptom either way — but this is worth re-checking on the next report, when both windows will overlap more cleanly.

### Index usage

**Genuinely unused (0 scans in 58 days), ranked by size:**

| index | table | size | recommendation |
|---|---|---|---|
| `ix_games_full_pv_pending` | games | **30 MB** | **Consider dropping** — see caveat below |
| `uq_openings_eco_name_pgn` | openings | 488 kB | **Keep** — unique constraint |
| `ix_herring_pool_recency` | herring_pool | 376 kB | Consider — trivial size, low value either way |
| `ix_openings_eco_name` | openings | 264 kB | Consider — the table is always seq-scanned |
| `openings_pkey` | openings | 96 kB | **Keep** — PK |
| `ix_llm_logs_findings_hash` | llm_logs | 56 kB | **Keep** — dedup lookup, low traffic |
| `ix_llm_logs_endpoint_created_at` | llm_logs | 40 kB | Keep — negligible |
| `ix_oauth_account_oauth_name` | oauth_account | 16 kB | **Keep** — auth flow |
| `feedback_pkey`, `bookmarks_pkey`, `alembic_version_pkc` | — | 16 kB each | **Keep** — PKs |

> **Caveat on `ix_games_full_pv_pending`:** its predicate (`lichess_evals_at IS NOT NULL AND full_pv_completed_at IS NULL`, `app/models/game.py:88`) is a live drain lane — that lane's user lottery is one of the three top-volume statements. Zero scans most likely means the planner prefers the narrower `ix_games_lichess_pv_backfill_pending` (752 kB) for the same predicate, in which case the 30 MB index is pure write amplification on every `games` insert. **Confirm which index the lane's plan actually picks before dropping.** 30 MB is not urgent.

**Near-unused but keep:**

- `ix_gp_full_hash_opening` (361 MB, **2 scans**, 28.5M tuples read) — used twice in 58 days, but each use reads 14M index tuples. This serves the opening-explorer aggregate. Two scans on a 361 MB index is a fair question to raise, but the tuple counts say it is doing real work when it fires. **Do not drop without identifying the caller.**
- `ix_gp_user_white_hash` (534 MB, 442 scans) and `ix_gp_user_black_hash` (536 MB, 667 scans) — these back the System Opening Filter ("my pieces only"). ~1.07 GB of index for ~1,100 queries in 58 days is a lopsided ratio worth being aware of, but the feature is unusable without them.
- `ix_games_full_evals_pending` (29 MB, 37 scans) — low, but non-zero. Keep.

### Dead tuples / autovacuum

| table | live | dead | dead % | last autovacuum |
|---|---|---|---|---|
| `user_import_settings` | 532 | 140 | 20.8% | 2026-08-06 |
| `eval_jobs` | 1,007 | 236 | 19.0% | 2026-08-19 |
| `drill_sessions` | 199 | 36 | 15.3% | 2026-08-14 |
| `drill_items` | 601 | 110 | 15.5% | 2026-08-15 |
| `users` | 566 | 96 | 14.5% | 2026-07-30 |
| `game_flaws` | 4,747,099 | **769,290** | 13.9% | 2026-08-04 |
| `user_rating_anchors` | 509 | 81 | 13.7% | 2026-07-26 |
| `games` | 791,136 | 113,463 | 12.5% | 2026-08-19 |
| `game_positions` | 55,229,244 | 1,541,897 | 2.7% | 2026-08-19 |

Every table is **below** the default `autovacuum_vacuum_scale_factor = 0.2` trigger, so autovacuum correctly has not fired — the ratios above are normal steady state, not neglect. The only one with real mass is **`game_flaws` at 769k dead tuples**, 16 days since its last autovacuum; it will trip the threshold at ~950k dead on its own. `last_autoanalyze` is current (today) on every hot table, so planner statistics are fresh.

### Performance recommendations

**No action needed**
- Cache hit ratio (99.59%), total DB load (~1.1% of a core), and autovacuum behaviour are all healthy.
- The top statement by total time is the *already-fixed* split-EXISTS eval-queue lottery at 0.76 ms mean. Verified live and verified against source. No rewrite.
- The 69 s and 16 s "slowest" statements are hand-run maintenance sweeps (frozen at 10 and 9 calls). Ignore them in the ranking.
- The 966 ms percentile slice is background-only (import + drain callers), ~20 calls/day. Fine.
- Seq scans on `users`, `eval_jobs`, `openings`, `oauth_account`, `bot_game_settings`, `drill_items` are the planner making the right call on tiny tables.

**Monitor**
- **`games` sequential scans** — 210k full scans / 123.9e9 tuples read, not attributable to any current statement. Likely pre-reset backfill activity. Re-check next report when the two stats windows overlap; if the count is still climbing at ~3,600/day with no matching statement, dig further.
- **`game_flaws` growth** — 6.4 GB of data at 1.35 KB/row and now the fastest-growing table. At the current trajectory it will pass `games` in total size well before `game_positions` is a concern. Worth knowing what the blob columns cost per game before the next capacity decision.
- **`game_flaws` dead tuples** (769k, 13.9%) — self-correcting, but watch it if the blob backfill accelerates.

**Recommended**
- Nothing rises to this level. The database is in good shape.

**Consider**
- **`ix_games_full_pv_pending` (30 MB, 0 scans in 58 days)** — check whether the lichess-PV drain lane's plan uses `ix_games_lichess_pv_backfill_pending` instead; if so, drop the 30 MB index and save the write amplification on `games` inserts.
- **`ix_gp_full_hash_opening` (361 MB, 2 scans)** — identify its caller. If the opening aggregate it serves has been superseded, that is the single largest reclaimable index in the database.
- **Poll cadence.** The drain polling family is 49% of all DB execution time at ~13.5 queries/sec. The absolute cost is small (~3 hours of CPU over 23 days), so this is not urgent — but backing off the poll interval when the queue comes up empty would halve the database's measured workload for free.

---

## 3. Sanity Checks

### Check A — `games` oracle columns vs `game_flaws`

| platform | counts present | both match | **match rate** | mistake mismatch | blunder mismatch | flaws but all counts NULL |
|---|---|---|---|---|---|---|
| chess.com | 403,829 | 403,063 | **99.81%** | 659 | 510 | **0** |
| lichess | 231,506 | 230,972 | **99.77%** | 464 | 349 | **0** |
| flawchess | 364 | 364 | **100.00%** | 0 | 0 | **0** |
| pgn | 2 | 2 | **100.00%** | 0 | 0 | **0** |

**NULL-count gap: 0 on every platform.** No game has derived flaws with unpopulated source columns.

**Aggregate totals** (oracle vs `game_flaws`):

| platform | mistakes oracle / gf | Δ | blunders oracle / gf | Δ |
|---|---|---|---|---|
| chess.com | 1,191,369 / 1,192,318 | +0.08% | 1,825,020 / 1,825,546 | +0.03% |
| lichess | 685,176 / 685,721 | +0.08% | 1,046,125 / 1,046,308 | +0.02% |
| flawchess | 936 / 936 | 0 | 1,345 / 1,345 | 0 |
| pgn | 10 / 10 | 0 | 4 / 4 | 0 |

All four platforms agree within **0.08%** — far inside the ~1% tolerance. Mismatch direction is consistently `game_flaws` over-counting slightly (chess.com 576 over vs 83 under on mistakes; lichess 380 over vs 84 under), which is the expected mate-ladder drift.

Both platforms clear their respective health bars (chess.com >99%, lichess >97%), and **chess.com again agrees marginally better than lichess** (99.81% vs 99.77%) — exactly what the source model predicts, since chess.com counts come from our own Stockfish pipeline while lichess's come from an independent classifier.

Movement since 2026-07-31: chess.com 99.78% → 99.81%, lichess **99.47% → 99.77%**. The lichess jump is consistent with a growing share of lichess games now being analyzed by our own pipeline rather than annotated by lichess.

**Verdict (Check A): PASS.**

### Check B — Eval coverage ≥90% vs oracle-column presence (Flaws Timeline gate)

| platform | games ≥90% coverage | **≥90% but oracle NULL** | ≥90% with oracle present |
|---|---|---|---|
| chess.com | 397,940 | **0** | 397,940 |
| lichess | 229,287 | **0** | 229,287 |
| flawchess | 355 | **0** | 355 |
| pgn | 2 | **0** | 2 |

Perfect alignment on all four platforms: every game with ≥90% per-ply eval coverage also has its user's-color oracle columns populated. The Flaws Timeline's oracle-present gate silently drops **nothing**. chess.com remains the largest covered population (397,940, up from 340,832 on 2026-07-31), and oracle backfill has kept exact pace with it.

**Verdict (Check B): PASS.**

---

## Summary

**The database is healthy. Nothing requires action.**

- **25 GB**, 803,155 games, 55.2M positions (68.8 positions/game), 566 users (234 registered / 332 guest). `game_positions` (14 GB) + `game_flaws` (7 GB) + `games` (3.9 GB) are 99% of it.
- **Cache hit 99.59%**; total measured execution time is **~1.1% of one CPU core** across 23 days. There is no performance pressure of any kind right now.
- **The top statement by total time is the *already-fixed* eval-queue lottery**, verified live (calls growing across three samples) and verified against `eval_queue_service.py:602-616` where the 260729-a86 split-EXISTS rewrite sits with its rationale comment. At 0.76 ms mean it is fine; its 4.3M ms total is pure call volume. **No rewrite recommended** — the report's historical trap does not recur.
- **The two "slowest" queries (69 s, 16 s) are hand-run maintenance sweeps** (`resweep_holed_games.py`), frozen at 10 and 9 calls. Not app-path, not a finding.
- **Both sanity checks PASS.** Zero NULL-count gaps on all four platforms; match rates 99.81% (chess.com) / 99.77% (lichess) with aggregate totals inside 0.08%; and zero games with ≥90% eval coverage missing oracle columns, so the Flaws Timeline drops nothing. lichess agreement improved notably since 2026-07-31 (99.47% → 99.77%).

**Two things to keep an eye on, neither urgent:**

1. **`games` shows 210k full sequential scans / 123.9e9 tuples read** that I could not attribute to any statement in the current 23-day query window. Most plausibly they predate the 2026-07-28 stats reset (the table counters reach 5 weeks further back, into the July backfills). No symptom today; re-check next report when the windows align.
2. **`game_flaws` is the fastest-growing table** — 6.4 GB of data for 4.75M rows (~1.35 KB/row, driven by the FEN/PV/motif blob columns), now second only to `game_positions`. Worth understanding the per-game blob cost before the next capacity decision.

**Two optional cleanups:** `ix_games_full_pv_pending` (30 MB, 0 scans in 58 days — but confirm the drain lane isn't just preferring the narrower `ix_games_lichess_pv_backfill_pending` first) and `ix_gp_full_hash_opening` (361 MB, 2 scans — identify its caller before touching it; it is the largest reclaimable index in the DB if its aggregate has been superseded).

**One free win if you ever want it:** the eval-drain polling family is 49% of all DB execution time across ~27M calls (~13.5/sec). Backing off the poll interval when the queue returns empty would roughly halve the database's measured workload. The absolute cost is only ~3 hours of CPU over 23 days, so this is a tidiness argument, not a performance one.
