---
name: db-report
description: Generate a database storage and performance report for FlawChess. Use this skill when the user asks about database size, storage usage, table sizes, index sizes, game counts, position counts, slow queries, query performance, cache hit ratio, sequential scans, index usage, dead tuples, data integrity / sanity checks (e.g. do the games blunder/mistake count columns match game_flaws), or wants a DB health/status overview. Trigger on phrases like "db report", "database report", "how big is the database", "storage usage", "index sizes", "table sizes", "slow queries", "query performance", "db performance", "db health", "data integrity", "sanity check", or any question about DB metrics. Supports both production and local dev databases. Writes a timestamped markdown report to reports/db-stats/db-report-{env}-YYYY-MM-DD.md.
---

# DB Report

Generate a database storage and performance report by querying the FlawChess PostgreSQL database.

## Target selection

- If the user says "local", "dev", or "local db" → use the **local** connection
- If the user says "prod", "production", or "server" → use the **production** connection
- If ambiguous → ask which environment they mean

## Connections

Use the PostgreSQL MCP servers for direct database queries (no SSH or psql needed):

- **Local dev**: `mcp__flawchess-db__query` — requires dev DB running: `docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`
- **Production**: `mcp__flawchess-prod-db__query` — requires SSH tunnel: `bin/prod_db_tunnel.sh`

Both accept a single `sql` parameter. Run one SQL statement per call (no semicolon-separated multi-statements).

## Report scope

The report has four sections (Users, Storage, Performance, Sanity Checks). By default, run **all** sections and write the output to `reports/db-stats/db-report-{env}-YYYY-MM-DD.md` (UTC date, where `{env}` is `prod` or `local`). If the user only asks for storage/sizes, run Section 1 only. If the user only asks for performance/slow queries, run Section 2 only. If the user only asks for data integrity / sanity checks, run Section 3 only. When running a subset, append to today's report rather than overwriting prior sections.

When writing the report, always include at the top:
- Target DB (prod/local) and snapshot timestamp (ISO UTC)
- Which sections were run

---

## Section 0: Users Overview

Run all three queries in parallel (separate MCP tool calls in a single message) since they are independent.

### Query 0a — User summary
```sql
SELECT count(*) AS total_users, count(*) FILTER (WHERE NOT is_guest) AS registered_users, count(*) FILTER (WHERE is_guest) AS guest_users FROM users
```

### Query 0b — 10 most recent users with game and position counts

PII (email, chess.com username, lichess username) is intentionally excluded — boolean flags below preserve the signal (does the user have a linked platform account?) without leaking identifiers into the report file.

```sql
SELECT u.id, (u.chess_com_username IS NOT NULL) AS has_chess_com, (u.lichess_username IS NOT NULL) AS has_lichess, u.is_guest, u.created_at, u.last_login, COALESCE(g.game_count, 0) AS games, COALESCE(gp.position_count, 0) AS positions FROM users u LEFT JOIN (SELECT user_id, count(*) AS game_count FROM games GROUP BY user_id) g ON g.user_id = u.id LEFT JOIN (SELECT user_id, count(*) AS position_count FROM game_positions GROUP BY user_id) gp ON gp.user_id = u.id ORDER BY u.created_at DESC LIMIT 10
```

### Query 0c — Platform breakdown across all users
```sql
SELECT platform, count(DISTINCT user_id) AS users, count(*) AS games FROM games GROUP BY platform ORDER BY games DESC
```

### Users output format

Present results as:

1. **User summary** — single-row table: total users, registered users, guest users
2. **10 most recent users** — table with columns: user id, has_chess_com, has_lichess, guest?, registered, last login, games, positions. Format dates as YYYY-MM-DD. Do NOT include email, chess.com username, or lichess username — these are PII and must not appear in the report file. The boolean flags are sufficient to spot signups that never linked a platform account or never imported games.
3. **Platform breakdown** — table: platform, users, games

End with a brief note on user activity (e.g., how many recent signups have actually imported games, guest vs registered ratio).

---

## Section 1: Storage Report

Run all queries in parallel (separate MCP tool calls in a single message) since they are independent.

### Query 1a — Database size
```sql
SELECT pg_size_pretty(pg_database_size('flawchess')) AS db_size
```

### Query 1b — Game count
```sql
SELECT count(*) AS total_games FROM games
```

### Query 1c — Position count
```sql
SELECT count(*) AS total_positions FROM game_positions
```

### Query 2 — Per-table sizes
```sql
SELECT relname AS table, pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS index_size, pg_size_pretty(pg_relation_size(c.oid)) AS table_size, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC;
```

### Query 3 — Per-index sizes
```sql
SELECT i.relname AS index_name, t.relname AS table_name, pg_size_pretty(pg_relation_size(i.oid)) AS index_size FROM pg_class i JOIN pg_index ix ON ix.indexrelid = i.oid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' ORDER BY pg_relation_size(i.oid) DESC;
```

### Storage output format

Present results as three markdown tables:

1. **Overview** — database size, total games, total positions, and average positions per game
2. **Per-table breakdown** — table name, data size, index size, total size (sorted by total descending)
3. **Per-index breakdown** — index name, table, size (sorted by size descending)

End with a brief summary highlighting notable findings (e.g., index-to-data ratio, largest consumers).

---

## Section 2: Performance Analysis

Run all five queries in parallel (separate MCP tool calls in a single message) since they are independent.

### Query 4 — Top 20 queries by average execution time (requires pg_stat_statements)
```sql
SELECT round(mean_exec_time::numeric, 2) AS avg_ms, round(max_exec_time::numeric, 2) AS max_ms, calls, round(total_exec_time::numeric, 0) AS total_ms, rows, left(query, 300) AS query FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'flawchess') ORDER BY mean_exec_time DESC LIMIT 20;
```

### Query 5 — Top 20 queries by total execution time
```sql
SELECT round(total_exec_time::numeric, 0) AS total_ms, calls, round(mean_exec_time::numeric, 2) AS avg_ms, rows, left(query, 300) AS query FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'flawchess') ORDER BY total_exec_time DESC LIMIT 20;
```

### Query 6 — Table scan statistics (seq scans vs index scans, dead tuples, autovacuum)
```sql
SELECT schemaname, relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables ORDER BY seq_tup_read DESC;
```

### Query 7 — Index usage statistics
```sql
SELECT relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch FROM pg_stat_user_indexes ORDER BY idx_scan DESC;
```

### Query 8 — Buffer cache hit ratio
```sql
SELECT round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct FROM pg_stat_database WHERE datname = 'flawchess';
```

If Query 4 or 5 fails because `pg_stat_statements` is not installed, note this in the output and skip those queries. The remaining queries (6-8) use built-in pg_stat views and will always work.

### Performance output format

Present results as:

1. **Buffer cache hit ratio** — single value with assessment (>99% = excellent, 95-99% = good, <95% = investigate)
2. **Slowest queries by avg time** — markdown table: avg_ms, max_ms, calls, total_ms, truncated query. Focus on the top 5-10 that actually matter (skip queries under 10ms avg unless they have very high call counts).
3. **Highest total time queries** — markdown table: total_ms, calls, avg_ms, truncated query. Highlight queries that dominate server time (high total_ms) even if per-call time is low — these are optimization targets.
4. **Sequential scan analysis** — markdown table: table, seq_scans, idx_scans, verdict. Flag tables with high seq_scan counts relative to idx_scan — but note that tiny tables (under ~100 rows) legitimately use seq scans because PostgreSQL's optimizer correctly determines they're faster than index lookups.
5. **Index usage** — identify unused indexes (0 scans) and note whether they can be dropped. Indexes required for FK integrity, PKs, or OAuth/auth flows should be marked "keep" even if unused. Only recommend dropping indexes that are both large and genuinely unused.
6. **Dead tuples / autovacuum** — flag tables with dead tuple ratios above 20% or where autovacuum hasn't run recently.

### EXPLAIN ANALYZE for slow queries

If any query from Query 4/5 averages over 500ms, run `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` on a representative version of that query to check the actual execution plan. The pg_stat_statements averages may be skewed by historical runs before index changes — EXPLAIN ANALYZE shows current reality. Note: you'll need to substitute realistic parameter values (e.g., `user_id = 1`).

### MANDATORY before recommending any query rewrite

`pg_stat_statements` accumulates since `stats_reset` and **never forgets a query shape that no longer runs**. A query fixed last week still shows its full historical cost forever, and will look like the top offender. Confirming the plan is slow with EXPLAIN proves nothing about whether the code still issues that SQL — you can reproduce an 800ms plan for a statement the app stopped emitting days ago.

Before writing up *any* rewrite recommendation, do both of these:

1. **Check whether the statement is still executing.** Sample its `calls` twice, a minute or two apart (`SELECT queryid, calls FROM pg_stat_statements WHERE queryid = ...`). Growing = live. **Frozen = dead statement, historical artifact, not a finding.** Prefer this over guessing from `stats_reset` alone, since a shape can die at any point inside the window.
2. **Find the SQL in the codebase and read the surrounding code.** `grep` a distinctive fragment (a function name, an unusual column pair, an `ORDER BY` expression) across `app/`. Check whether the current source still produces that shape, and read nearby comments/docstrings — this project documents past query-plan fixes *at the fix site*, often with the measured before/after EXPLAIN and an explicit "do NOT simplify this back" warning. If such a note exists, the work is done; report it as already-fixed, not as a recommendation.

Then cross-check `git log`/`git branch --contains` for the fix commit to confirm it reached `production`.

> **This trap has been hit for real.** On the 2026-07-31 prod snapshot, the top statement by total time (2,818,182 ms, 12,722 calls, 221 ms mean — 8.5x the runner-up) was the tier-3 eval-queue user picker in its pre-fix single-EXISTS-with-OR form. It was written up as the report's headline recommendation, with a verified 844 ms → 2.7 ms rewrite. The rewrite had **already shipped two days earlier** (Quick 260729-a86, release #288) — `app/services/eval_queue_service.py` already contained the split-EXISTS form, the same measurement in its docstring, a "Do NOT simplify this back into one EXISTS with an OR" warning, and a test pinning the shape. The row was a frozen historical artifact: across three samples the old queryid held at exactly 12,722 calls while the live split form grew 68,178 → 68,415. Both checks above would have caught it in under a minute.

### Keeping the statement stats clean

If dead statement shapes are cluttering the top-N, prefer a **targeted** discard over a blanket reset (PG 12+):

```sql
SELECT pg_stat_statements_reset(0, 0, <queryid>);   -- userid=0, dbid=0 mean "all"
```

This drops one stale shape and preserves the rest of the accumulated history. Reserve the blanket `pg_stat_statements_reset()` for when you genuinely want a fresh measurement window, and note the new `stats_reset` in the next report. Both require elevated privileges — the prod MCP role is read-only, so these must be run as superuser on the server, not through `mcp__flawchess-prod-db__query`.

Do **not** reach for `pg_stat_reset()` as part of this. It resets a different, unrelated set of counters (table/index scan counts, cache hit ratio, autovacuum timestamps) and destroys the long observation window that the unused-index analysis in item 5 depends on — right after it, every index reads `idx_scan = 0`.

### Performance recommendations

End with actionable recommendations, categorized as:
- **No action needed** — things that look fine, with brief explanation why
- **Monitor** — things to watch but not urgent (e.g., "reset stats and re-check in a week")
- **Recommended** — changes that would improve performance
- **Consider** — optional optimizations with trade-offs noted

If pg_stat_statements has never been reset (check `stats_reset` from `pg_stat_database`), mention that cumulative stats may not reflect current performance and offer to reset them.

---

## Section 3: Sanity Checks

Data-integrity checks. Run both unless the user asks for one.

- **Check A — Flaw counts: `games` oracle columns vs `game_flaws`.** Are the per-color move-quality count columns on `games` (`white/black_mistakes`, `white/black_blunders`) consistent with the derived `game_flaws` table?
- **Check B — Eval coverage vs oracle-column presence.** Are there games with ≥90% per-ply eval coverage (`game_positions`) whose `games` oracle columns are NULL? This guards the **Flaws Timeline** feature, which reads the precomputed `games` oracle columns directly (`fetch_flaw_trend_rows`, no `game_positions` join) and gates on "oracle present". A game that is "analyzed" by eval coverage but has NULL oracle columns is silently dropped from the Timeline.

---

### Check A — Flaw counts: `games` oracle columns vs `game_flaws`

#### Background (read before interpreting results)

- `games.{white,black}_{mistakes,blunders}` are per-color move-quality counts for the whole game. They arrive from **two different sources**, and this matters for interpretation:
  - **lichess games lichess analyzed** — populated from the lichess analysis API (an *independent* classifier).
  - **every other analyzed game (chess.com, flawchess bot games, and lichess games we analyzed ourselves)** — populated by **our own Stockfish pipeline**, from the same evals `game_flaws` is derived from.
- `game_flaws` is a derived materialization (one row per mistake/blunder, both players, severity 1=mistake / 2=blunder), classified from move evals using lila-mirrored ES thresholds (see `app/services/flaws_service.py`). It is populated for **all platforms**, not lichess-only.
- **Expected agreement differs by source**, and this is the key interpretive point:
  - **lichess-annotated games**: two genuinely independent classifiers (lichess win% vs our Option-B ES thresholds), so small per-game disagreement is **expected, not a bug**. The mate-ladder path is known to drift (see `MATE_LADDER_*` in `flaws_service.py`).
  - **our-pipeline games (chess.com etc.)**: both sides derive from *our own* evals, so agreement should be **tighter**. A chess.com match rate materially below the lichess rate is suspicious rather than reassuring, because there is no independent-classifier excuse for it.
- Aggregate totals should agree within ~1% on every platform.

> **History note (do not re-derive this the hard way):** this section previously asserted that oracle columns were "NULL for chess.com" and that chess.com had "zero `game_flaws` rows". Both were true once and are **false as of 2026-07-31** (chess.com: 345,949 games with oracle columns, 339,508 with flaw rows). Because Check A used to be hard-scoped to lichess, it silently skipped the largest population. If you find the scoping narrowed again, widen it rather than trusting the prose.

Two things we want to know:
1. **Do the counts match?** For games with counts present, does `white_mistakes + black_mistakes` equal the `game_flaws` mistake count (severity 1), and likewise for blunders (severity 2)?
2. **Are the count columns NULL when they should have a value?** I.e. a game that has `game_flaws` rows (so it *was* analyzed) but whose count columns are all NULL — that is a genuine data gap.

Both checks run **across all platforms, grouped by platform**. Do not scope to lichess — chess.com is now the largest analyzed population and scoping it out hides most of the data.

### Query 9 — Flaw count integrity summary, by platform

Note the two denominators — they are **not** interchangeable (see output format below):
- `games_with_flaw_rows` — games that have at least one `game_flaws` row. Denominator for the NULL-count gap.
- `games_with_counts_present` — games whose oracle columns are populated. **Denominator for the match rate.**

```sql
WITH gf AS (
  SELECT game_id,
         count(*) FILTER (WHERE severity = 1) AS gf_mistakes,
         count(*) FILTER (WHERE severity = 2) AS gf_blunders
  FROM game_flaws GROUP BY game_id
)
SELECT
  g.platform,
  count(*) FILTER (WHERE gf.game_id IS NOT NULL) AS games_with_flaw_rows,
  count(*) FILTER (WHERE gf.game_id IS NOT NULL
                     AND g.white_mistakes IS NULL AND g.black_mistakes IS NULL
                     AND g.white_blunders IS NULL AND g.black_blunders IS NULL) AS flaws_but_all_counts_null,
  count(*) FILTER (WHERE g.white_mistakes IS NOT NULL OR g.white_blunders IS NOT NULL) AS games_with_counts_present,
  count(*) FILTER (WHERE (g.white_mistakes IS NOT NULL OR g.white_blunders IS NOT NULL)
                     AND coalesce(g.white_mistakes,0)+coalesce(g.black_mistakes,0) = coalesce(gf.gf_mistakes,0)
                     AND coalesce(g.white_blunders,0)+coalesce(g.black_blunders,0) = coalesce(gf.gf_blunders,0)) AS both_match,
  count(*) FILTER (WHERE (g.white_mistakes IS NOT NULL OR g.white_blunders IS NOT NULL)
                     AND coalesce(g.white_mistakes,0)+coalesce(g.black_mistakes,0) <> coalesce(gf.gf_mistakes,0)) AS mistake_mismatch,
  count(*) FILTER (WHERE (g.white_mistakes IS NOT NULL OR g.white_blunders IS NOT NULL)
                     AND coalesce(g.white_blunders,0)+coalesce(g.black_blunders,0) <> coalesce(gf.gf_blunders,0)) AS blunder_mismatch
FROM games g
LEFT JOIN gf ON gf.game_id = g.id
GROUP BY g.platform
ORDER BY games_with_counts_present DESC;
```

### Query 10 — Mismatch direction & aggregate totals, by platform (diagnostic; run only if Query 9 shows mismatches)
```sql
WITH gf AS (
  SELECT game_id,
         count(*) FILTER (WHERE severity = 1) AS gf_mistakes,
         count(*) FILTER (WHERE severity = 2) AS gf_blunders
  FROM game_flaws GROUP BY game_id
)
SELECT
  g.platform,
  count(*) FILTER (WHERE coalesce(g.white_mistakes,0)+coalesce(g.black_mistakes,0) > coalesce(gf.gf_mistakes,0)) AS mistakes_gf_under,
  count(*) FILTER (WHERE coalesce(g.white_mistakes,0)+coalesce(g.black_mistakes,0) < coalesce(gf.gf_mistakes,0)) AS mistakes_gf_over,
  count(*) FILTER (WHERE coalesce(g.white_blunders,0)+coalesce(g.black_blunders,0) > coalesce(gf.gf_blunders,0)) AS blunders_gf_under,
  count(*) FILTER (WHERE coalesce(g.white_blunders,0)+coalesce(g.black_blunders,0) < coalesce(gf.gf_blunders,0)) AS blunders_gf_over,
  sum(coalesce(g.white_mistakes,0)+coalesce(g.black_mistakes,0)) AS total_oracle_mistakes,
  sum(coalesce(gf.gf_mistakes,0)) AS total_gf_mistakes,
  sum(coalesce(g.white_blunders,0)+coalesce(g.black_blunders,0)) AS total_oracle_blunders,
  sum(coalesce(gf.gf_blunders,0)) AS total_gf_blunders
FROM games g
LEFT JOIN gf ON gf.game_id = g.id
WHERE (g.white_mistakes IS NOT NULL OR g.white_blunders IS NOT NULL)
GROUP BY g.platform
ORDER BY total_gf_blunders DESC;
```

#### Check A output format

1. **NULL-count gap** — report `flaws_but_all_counts_null` per platform. This is the headline integrity number: it **should be 0** everywhere. Any non-zero value means games have derived flaws but the source count columns were never populated — a real bug to investigate.
2. **Count match rate** — `both_match / games_with_counts_present` as a percentage, per platform, plus the raw `mistake_mismatch` / `blunder_mismatch` counts.
   > **Use `games_with_counts_present` as the denominator, never `games_with_flaw_rows`.** `both_match` counts games with oracle counts present that agree, which *includes* clean games with zero flaws (`0 = 0` matches, and those games have no `game_flaws` row at all). Dividing by `games_with_flaw_rows` therefore mixes two different populations and can exceed 100% — it returned a nonsensical 101.1% on the 2026-07-31 prod snapshot.
   
   Healthy: **above ~97% for lichess** (independent classifiers) and **above ~99% for our-pipeline platforms** like chess.com (same eval source, so tighter agreement is expected). chess.com scoring *below* lichess is the signal worth chasing.
3. **Mismatch diagnosis** (only if mismatches exist) — from Query 10, report whether `game_flaws` over- or under-counts relative to the oracle columns, and the aggregate totals (these should agree within ~1%). Frame per-game drift on lichess as expected classifier disagreement unless the **aggregate** totals diverge by more than a few percent or the NULL-count gap is non-zero. On our-pipeline platforms, treat the same drift with more suspicion.

Verdict line (Check A): **PASS** if `flaws_but_all_counts_null = 0` on every platform and aggregate totals agree within ~1%; **INVESTIGATE** otherwise.

> Reference (prod snapshot 2026-07-31), all platforms, `flaws_but_all_counts_null = 0` everywhere:
>
> | platform | counts present | both match | match rate | mistakes oracle/gf | blunders oracle/gf |
> |---|---|---|---|---|---|
> | chess.com | 345,953 | 345,187 | 99.78% | 1,014,035 / 1,014,984 | 1,546,354 / 1,546,880 |
> | lichess | 179,284 | 178,335 | 99.47% | 523,952 / 524,843 | 811,861 / 812,168 |
> | flawchess | 216 | 216 | 100.00% | 538 / 538 | 797 / 797 |
>
> Verdict: PASS. Note chess.com agrees *better* than lichess, as the source model predicts.
>
> The absolute counts drift upward between runs (the eval pipeline analyzes games continuously — chess.com moved 345,953 → 346,108 within one session). Compare **match rates**, not raw counts; a higher count is normal progress, not a regression.
>
> Older reference (prod 2026-06-12, lichess-only scoping): match rate 98.4% (38,355 / 38,964). Kept only to show the trend; that scoping is obsolete.

---

### Check B — Eval coverage vs oracle-column presence (Flaws Timeline gate)

#### Background (read before interpreting results)

- The **Flaws Timeline** chart (`fetch_flaw_trend_rows` → `_compute_flaw_trend`) is built **only** from the precomputed `games` oracle columns (`white/black_blunders/mistakes/inaccuracies`, picked by `user_color`) plus `ply_count`/`played_at`. It does **not** join `game_positions`. Its "analyzed" gate is **oracle-present** (the user's-color `*_blunders IS NOT NULL`).
- A different, older notion of "analyzed" is **eval coverage**: ≥`EVAL_COVERAGE_MIN` (0.90, `flaws_service.py`) of a game's plies carry an `eval_cp`/`eval_mate` in `game_positions`. The two can diverge in principle because oracle columns and per-ply evals are written by different steps.
- **Gotcha:** `games.evals_completed_at` being non-NULL does **not** imply ≥90% full-ply coverage — it tracks **endgame-span entry-ply** evaluation only. Use the coverage computation in Query 11, not that column.
- **chess.com clears the 0.90 gate at scale.** As of 2026-07-31, 340,832 chess.com games have ≥90% coverage (vs 177,498 lichess), because full-game Stockfish backfill has run broadly. Oracle backfill has kept exact pace, so `ge90_but_oracle_null` is 0 there. Expect chess.com to be the *largest* group in this check's output, and treat that as normal.

This check answers: **are there games with ≥90% eval coverage whose oracle columns are NULL** (i.e. analyzed-by-coverage but dropped from the Timeline)?

#### Query 11 — Eval-coverage ≥90% vs oracle-null, by platform
> Heavier query: aggregates all of `game_positions` (tens of millions of rows). Expect a few seconds. Run it last.
```sql
WITH cov AS (
  SELECT game_id, user_id,
         sum(CASE WHEN eval_cp IS NOT NULL OR eval_mate IS NOT NULL THEN 1 ELSE 0 END)::float
           / count(*) AS coverage
  FROM game_positions
  GROUP BY game_id, user_id
)
SELECT
  g.platform,
  count(*) AS games_ge90_coverage,
  count(*) FILTER (
    WHERE (g.user_color = 'white'
             AND (g.white_blunders IS NULL OR g.white_mistakes IS NULL OR g.white_inaccuracies IS NULL))
       OR (g.user_color = 'black'
             AND (g.black_blunders IS NULL OR g.black_mistakes IS NULL OR g.black_inaccuracies IS NULL))
  ) AS ge90_but_oracle_null,
  count(*) FILTER (
    WHERE (g.user_color = 'white' AND g.white_blunders IS NOT NULL)
       OR (g.user_color = 'black' AND g.black_blunders IS NOT NULL)
  ) AS ge90_oracle_present
FROM cov
JOIN games g ON g.id = cov.game_id AND g.user_id = cov.user_id
WHERE cov.coverage >= 0.90
GROUP BY g.platform
ORDER BY games_ge90_coverage DESC;
```

#### Check B output format

Report `ge90_but_oracle_null` per platform (the headline number for this check), alongside `games_ge90_coverage`.

- **0 rows / `ge90_but_oracle_null = 0`** — PASS. The Timeline's oracle-present gate loses no eval-covered games.
- **Non-zero, lichess only** — usually benign edge cases (lichess game with %eval present but judgment annotations missing). Note the count; investigate only if large.
- **Non-zero on chess.com** — INVESTIGATE. It means full-game Stockfish coverage landed while oracle backfill fell behind, so those games are analyzed yet silently excluded from the Flaws Timeline. Note the distinction from the background above: chess.com *appearing in this check at all* is normal and expected (it is the largest ≥90%-coverage group); only a non-zero `ge90_but_oracle_null` is the problem. The fix would be to backfill chess.com oracle columns or revisit the Timeline's gate.

Verdict line (Check B): **PASS** if `ge90_but_oracle_null = 0` on every platform (or only a small lichess remainder); **INVESTIGATE** if any platform shows a material count.

> Reference (prod snapshot 2026-07-31): `ge90_but_oracle_null = 0` on all three platforms — chess.com 340,832 covered / 0 null, lichess 177,498 / 0, flawchess 211 / 0. Verdict: PASS.

---

## Report file layout

Write to `reports/db-stats/db-report-{env}-YYYY-MM-DD.md` using today's UTC date, where `{env}` is `prod` or `local`. Separate files per environment so a local snapshot never clobbers a prod snapshot taken the same day. Layout:

```markdown
# FlawChess DB Report — <DATE>

- **DB**: prod / local
- **Snapshot taken**: <ISO UTC timestamp>
- **Sections run**: users / storage / performance / sanity

## 0. Users Overview
...

## 1. Storage Report
...

## 2. Performance Analysis
...

## 3. Sanity Checks
...

## Summary
<brief top-line findings: DB size, largest tables, cache hit ratio, notable slow queries, anything that warrants action>
```

The `Summary` section at the bottom is the main deliverable — a short paragraph or bulleted list of the top findings and any recommended actions. Don't just restate the tables; call out what's surprising or actionable.

After writing the file, output a one-line summary in chat with the absolute path to the report (e.g. `Wrote reports/db-stats/db-report-prod-2026-04-16.md`) so the user knows where to find it.

## Re-running & append mode

If `reports/db-stats/db-report-{env}-YYYY-MM-DD.md` already exists for today, check which sections are present. If the user asked for a subset (e.g. "just rerun section 2" or "refresh the perf numbers"), replace only that section — do not clobber the others. Always preserve the header and rebuild the bottom Summary from whichever sections are present in the file.

If the user explicitly asks for a fresh snapshot, overwrite the file. Never mutate older-dated reports.
