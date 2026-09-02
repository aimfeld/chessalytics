# FlawChess DB Report — 2026-09-02

- **DB**: prod
- **Snapshot taken**: 2026-09-02T16:17:20Z
- **Sections run**: users / storage / performance / sanity

## 0. Users Overview

### User summary

| total users | registered | guests |
|---|---|---|
| 656 | 276 | 380 |

### 10 most recent users

| user id | has_chess_com | has_lichess | guest? | registered | last login | games | positions |
|---|---|---|---|---|---|---|---|
| 698 | no | no | yes | 2026-09-02 | 2026-09-02 | 0 | 0 |
| 697 | yes | no | no | 2026-09-02 | 2026-09-02 | 552 | 24,821 |
| 696 | no | no | yes | 2026-09-02 | 2026-09-02 | 24 | 1,323 |
| 695 | no | no | yes | 2026-09-02 | 2026-09-02 | 0 | 0 |
| 694 | no | no | yes | 2026-09-02 | 2026-09-02 | 0 | 0 |
| 693 | yes | no | no | 2026-09-01 | 2026-09-01 | 117 | 5,758 |
| 692 | no | no | yes | 2026-09-01 | 2026-09-01 | 0 | 0 |
| 691 | no | no | no | 2026-09-01 | 2026-09-01 | 0 | 0 |
| 690 | no | yes | no | 2026-08-31 | 2026-08-31 | 382 | 21,802 |
| 689 | yes | yes | no | 2026-08-31 | 2026-08-31 | 1,452 | 100,966 |

### Platform breakdown

| platform | users | games |
|---|---|---|
| chess.com | 209 | 438,751 |
| lichess | 145 | 224,125 |
| flawchess | 55 | 519 |
| pgn | 2 | 7 |

Activity note: of the 10 newest users (Aug 31–Sep 2), 5 imported games (including one 1,452-game dual-platform import). Guests outnumber registered users 380 to 276; most guests never import. One registered signup (id 691) linked nothing and imported nothing.

## 1. Storage Report

### Overview

| db size | total games | total positions | avg positions/game |
|---|---|---|---|
| 25 GB | 663,402 | 45,612,403 | 68.8 |

### Per-table breakdown (top consumers)

| table | data | indexes | total |
|---|---|---|---|
| game_positions | 7,114 MB | 6,954 MB | 14 GB |
| game_flaws | 6,521 MB | 569 MB | 7,090 MB |
| games | 2,705 MB | 1,201 MB | 3,906 MB |
| game_best_moves | 213 MB | 177 MB | 391 MB |
| opening_position_eval | 148 MB | 84 MB | 233 MB |
| benchmark_cohort_cdf | 8 MB | 5 MB | 13 MB |
| (all others) | — | — | < 4 MB each |

### Per-index breakdown (≥ 50 MB)

| index | table | size |
|---|---|---|
| game_positions_pkey | game_positions | 2,647 MB |
| ix_gp_user_endgame_game | game_positions | 1,262 MB |
| ix_gp_user_full_hash_move_san | game_positions | 976 MB |
| ix_game_positions_game_id | game_positions | 636 MB |
| ix_gp_user_black_hash | game_positions | 536 MB |
| ix_gp_user_white_hash | game_positions | 534 MB |
| ix_gp_full_hash_opening | game_positions | 361 MB |
| game_flaws_pkey | game_flaws | 309 MB |
| game_best_moves_pkey | game_best_moves | 177 MB |
| uq_games_user_platform_game_id | games | 120 MB |
| ix_game_flaws_user_severity | game_flaws | 104 MB |
| ix_game_flaws_game_id | game_flaws | 90 MB |
| opening_position_eval_pkey | opening_position_eval | 84 MB |
| ix_games_user_played_at | games | 71 MB |
| ix_game_flaws_blob_backfill | game_flaws | 64 MB |
| games_pkey | games | 57 MB |
| uq_games_id_user_id | games | 56 MB |

Summary: game_positions carries a ~1:1 index-to-data ratio (6.9 GB of indexes on 7.1 GB of data) across seven indexes; game_flaws is data-heavy (6.5 GB data, only 0.6 GB indexes) because of the pv/blob columns. The three tables game_positions + game_flaws + games account for ~24.9 of the 25 GB. Growth since 2026-07-31 snapshot territory: games 663K (was ~525K counts-present era), positions 45.6M.

## 2. Performance Analysis

### Buffer cache hit ratio

**99.59%** — excellent. (`stats_reset`: 2026-06-23, so this covers ~10 weeks including heavy backfill traffic.)

### Slowest queries by avg time

Everything at the top of the by-avg list is one-off ad-hoc or maintenance work, not app traffic:

| avg_ms | calls | what it is |
|---|---|---|
| 251,660 | 1 | `COPY game_positions TO stdout` (pg_dump backup) |
| 155,786 / 134,003 | 1 each | ad-hoc analysis CTEs (`with base as …`) |
| 79,817 / 64,483 | 1 each | `COPY games` / `COPY game_flaws` TO stdout (pg_dump) |
| 75,142 | 15 | `resweep_holed_games` hole-scan (see below) |
| 27,576–61,004 | 1 each | ad-hoc backfill/analysis one-offs |

The only repeated entry, the 75s `SELECT DISTINCT game_positions.game_id … max_ply_per_game` scan (15 calls, 0 rows), is the eval-hole resweep from `app/services/eval_drain.py:1256`, run manually via `scripts/resweep_holed_games.py`. Liveness check: calls frozen at 15 across two samples this session — it only runs when invoked by hand. It aggregates all of `game_positions` by design; no rewrite warranted for a manual maintenance sweep, and no EXPLAIN was run (reproducing it costs 75s of prod I/O for a shape that is not app traffic).

### Highest total time queries

| total_ms | calls | avg_ms | what it is |
|---|---|---|---|
| 6,284,613 | 8,722,142 | 0.72 | tier-3 eval-queue user picker (guest branch, split-EXISTS form) |
| 3,418,960 | 8,437,871 | 0.41 | blob-backfill user picker |
| 2,762,984 | 8,329,861 | 0.33 | best-moves backfill user picker |
| 1,648,062 | 299,560 | 5.50 | per-user game picker (eval lottery) |
| 1,127,131 | 15 | 75,142 | resweep_holed_games (manual, see above) |
| 742,831 | 9,988 | 74.37 | `COPY game_positions FROM STDIN` (position ingest) |
| 706,462 | 611 | 1,156 | benchmark-percentile canonical-slice CTE (see below) |

The top three are the worker-fleet polling loops at sub-millisecond per call; their totals are pure call volume (~8.7M polls each since June 23) and are the already-optimized split-EXISTS forms. No action.

The `WITH selected_users … recent_capped` family (~30 queryid variants, one per percentile metric) is the per-user benchmark-percentile computation from `app/services/canonical_slice_sql.py` / `user_benchmark_percentiles_service.py`, run at import/refresh time. Two heavy metrics average 1,156 ms and 966 ms; the rest are 0–120 ms. Liveness: frozen at 611/458 calls across two samples — episodic, import-triggered. Total cost of the whole family is roughly 20 minutes of server time over 10 weeks, in a background flow. Not worth a rewrite; no EXPLAIN escalation.

### Sequential scan analysis

| table | seq_scans | idx_scans | verdict |
|---|---|---|---|
| users | 40.3M | 14.6M | OK — 656 rows, seq scan is optimal |
| eval_jobs | 9.2M | 21.9M | OK — ~1K rows, poller table |
| oauth_account | 690K | 343 | OK — 217 rows |
| drill_items / drill_solves / bot_game_settings | 100K–500K | — | OK — tiny tables |
| games | 210K | 49.0B | OK — seq_tup_read is dominated by the ad-hoc COPY/analysis one-offs |
| game_positions | 253 | 125M | excellent |
| game_flaws | 278 | 698B | excellent |

No problematic sequential scanning; every high seq_scan count is a sub-1K-row table where the planner is correct.

### Index usage

- `ix_gp_full_hash_opening` (361 MB, game_positions): **2 scans in 10 weeks**. Largest near-unused index in the DB. It presumably serves the opening-explorer position aggregation; 2 scans suggests that path either hits a different index now or is rarely exercised. Worth verifying which query it was created for before touching it — flagged as *consider*, not *drop*.
- `ix_gp_user_black_hash` (536 MB) / `ix_gp_user_white_hash` (534 MB): only 695 / 480 scans, but those scans are the openings WDL analysis (core feature) and read millions of tuples. Keep.
- `ix_games_full_pv_pending` (30 MB): 0 scans. Partial pending-index; its sibling `ix_games_full_evals_pending` shows only 37 scans. These back backfill phases that may be complete. Cheap to keep; revisit if the backfill era ends.
- Zero-scan small indexes (`openings*`, `ix_llm_logs_findings_hash`, `ix_llm_logs_endpoint_created_at`, `ix_herring_pool_recency`, `ix_oauth_account_oauth_name`, `feedback_pkey`): all < 1 MB, several are PK/unique/auth — keep.

### Dead tuples / autovacuum

| table | live | dead | dead % | last autovacuum |
|---|---|---|---|---|
| games | 658,490 | 114,542 | 17.4% | 2026-08-27 |
| game_flaws | 4,696,279 | 460,846 | 9.8% | 2026-08-23 |
| game_best_moves | 4,652,483 | 340,676 | 7.3% | 2026-08-03 |
| game_positions | 50,800,482 | 661,006 | 1.3% | 2026-08-30 |
| train_settings | 136 | 76 | 55.9% | 2026-08-01 (trivial size) |

`games` at 17.4% dead is approaching the 20% watch threshold — expected churn from continuous backfill UPDATEs; autovacuum is keeping up (ran Aug 27). Monitor.

### Performance recommendations

- **No action needed**: cache hit 99.59%; polling-loop totals are call volume on optimized sub-ms queries; all high-seq-scan tables are tiny; the two >500ms repeated shapes are manual maintenance (resweep) and episodic import-time percentile computation, both verified frozen between samples.
- **Monitor**: `games` dead-tuple ratio (17.4%); benchmark-percentile heavy metrics (1.1s per user per refresh — fine at current user volume, revisit if refresh frequency or user count grows 10x).
- **Consider**: identify the intended consumer of `ix_gp_full_hash_opening` (361 MB, 2 scans since June 23). If its query path now uses `ix_gp_user_full_hash_move_san` or the aggregation was removed, dropping it frees 361 MB and speeds position ingest slightly. Requires a codebase check of the opening-explorer query shape first.
- Cumulative stats span since 2026-06-23 including several heavy backfill eras; a targeted `pg_stat_statements_reset(0,0,<queryid>)` on the dead ad-hoc COPY/analysis shapes would declutter future top-N lists (needs superuser on the server, not the RO MCP role).

## 3. Sanity Checks

### Check A — Flaw counts: `games` oracle columns vs `game_flaws`

**NULL-count gap: 0 on every platform** (no game has flaw rows while all oracle count columns are NULL).

| platform | counts present | both match | match rate | mistake mism. | blunder mism. | mistakes oracle/gf | blunders oracle/gf |
|---|---|---|---|---|---|---|---|
| chess.com | 420,722 | 419,956 | 99.82% | 659 | 510 | 1,240,080 / 1,241,029 | 1,900,366 / 1,900,892 |
| lichess | 207,183 | 206,652 | 99.74% | 464 | 346 | 612,779 / 613,332 | 930,598 / 930,804 |
| flawchess | 480 | 480 | 100.00% | 0 | 0 | 1,332 / 1,332 | 1,884 / 1,884 |
| pgn | 7 | 7 | 100.00% | 0 | 0 | 28 / 28 | 13 / 13 |

Mismatch direction (Query 10): `game_flaws` slightly over-counts on both large platforms (chess.com 576 over vs 83 under on mistakes; lichess 380 vs 84), consistent with known classifier drift (mate-ladder path). Aggregate totals agree within 0.08% everywhere — far inside the ~1% tolerance. chess.com agrees better than lichess, as the source model predicts (same-eval-source vs independent classifiers).

**Verdict: PASS.** Match rates improved slightly vs the 2026-07-31 reference (chess.com 99.78% → 99.82%, lichess 99.47% → 99.74%).

### Check B — Eval coverage vs oracle-column presence (Flaws Timeline gate)

| platform | games ≥90% coverage | ge90_but_oracle_null | ge90_oracle_present |
|---|---|---|---|
| chess.com | 414,459 | 0 | 414,459 |
| lichess | 204,899 | 0 | 204,899 |
| flawchess | 464 | 0 | 464 |
| pgn | 7 | 0 | 7 |

**Verdict: PASS.** No eval-covered game is missing oracle columns; the Flaws Timeline gate loses nothing. Coverage grew ~74K chess.com / ~27K lichess games since 2026-07-31.

## Summary

- **25 GB** database, 663K games, 45.6M positions, 656 users (276 registered). Both sanity checks **PASS** with zero integrity gaps and match rates improving since July.
- Performance is healthy: 99.59% cache hit, no pathological seq scans, no live slow app queries. Everything slow in `pg_stat_statements` is either pg_dump, ad-hoc analysis, the manual `resweep_holed_games` sweep, or the episodic per-user percentile computation — all verified frozen (not currently executing) via double-sampled call counts.
- One actionable lead: `ix_gp_full_hash_opening` (361 MB) has had **2 scans in 10 weeks**. Verify what query it was built for; if that path is gone, dropping it recovers 361 MB and trims ingest overhead.
- Watch items: `games` dead tuples at 17.4% (backfill churn, autovacuum coping) and the growing pile of dead one-off shapes in pg_stat_statements (targeted reset would declutter, needs superuser).
