# FlawChess DB Report — 2026-07-31

- **DB**: prod (via `bin/prod_db_tunnel.sh`, `localhost:15432`)
- **Snapshot taken**: 2026-07-31T05:30:35Z
- **Sections run**: users / storage / performance / sanity
- **`pg_stat_statements` reset**: 2026-06-23T20:35:32Z (≈37 days of accumulation)

---

## 0. Users Overview

### User summary

| total users | registered | guest |
|---|---|---|
| 495 | 203 | 292 |

### 10 most recent users

| id | chess.com | lichess | guest? | registered | last login | games | positions |
|---|---|---|---|---|---|---|---|
| 536 | – | – | yes | 2026-07-30 | 2026-07-30 | 4 | 200 |
| 535 | yes | – | yes | 2026-07-30 | 2026-07-30 | 300 | 20,346 |
| 534 | yes | – | no | 2026-07-30 | 2026-07-30 | 9,321 | 658,416 |
| 533 | – | – | yes | 2026-07-30 | 2026-07-30 | 0 | 0 |
| 532 | – | yes | yes | 2026-07-30 | 2026-07-30 | 952 | 79,736 |
| 531 | – | yes | yes | 2026-07-30 | 2026-07-30 | 180 | 13,008 |
| 530 | – | – | no | 2026-07-30 | 2026-07-30 | 0 | 0 |
| 529 | – | – | yes | 2026-07-30 | 2026-07-30 | 0 | 0 |
| 528 | yes | – | no | 2026-07-30 | 2026-07-30 | 1,127 | 77,729 |
| 527 | yes | – | yes | 2026-07-30 | 2026-07-30 | 1,127 | 77,729 |

### Platform breakdown

| platform | users | games |
|---|---|---|
| chess.com | 194 | 512,611 |
| lichess | 136 | 259,813 |
| flawchess (bot games) | 43 | 249 |

**Activity note.** All 10 most recent signups landed on a single day (2026-07-30) — a strong traffic day. 6 of 10 imported games; the 4 with zero games include 2 registered accounts that never linked a platform. Guests outnumber registered 292:203 (59%), and guests do import (535, 532, 531, 527 all have real game volume), so the guest path is carrying meaningful load. Users 527/528 share identical game and position counts, which looks like the same person converting a guest session into a registered account rather than a data duplication bug.

---

## 1. Storage Report

### Overview

| metric | value |
|---|---|
| Database size | **23 GB** |
| Total games | 772,673 |
| Total positions | 53,139,802 |
| Avg positions/game | 68.8 |
| Total flaw rows | 3,900,062 (1,540,302 mistakes / 2,359,760 blunders) |

### Per-table breakdown (top consumers)

| table | data | indexes | total |
|---|---|---|---|
| game_positions | 7,114 MB | 6,951 MB | **14 GB** |
| game_flaws | 5,119 MB | 471 MB | 5,590 MB |
| games | 2,705 MB | 1,168 MB | 3,874 MB |
| game_best_moves | 163 MB | 138 MB | 301 MB |
| opening_position_eval | 120 MB | 74 MB | 194 MB |
| benchmark_cohort_cdf | 8,184 kB | 4,784 kB | 13 MB |
| herring_pool | 2,320 kB | 944 kB | 3,264 kB |
| llm_logs | 72 kB | 2,048 kB | 2,120 kB |
| openings | 832 kB | 888 kB | 1,720 kB |

Everything below `openings` is under 1 MB and omitted.

### Per-index breakdown (top 20)

| index | table | size |
|---|---|---|
| game_positions_pkey | game_positions | 2,647 MB |
| ix_gp_user_endgame_game | game_positions | 1,262 MB |
| ix_gp_user_full_hash_move_san | game_positions | 976 MB |
| ix_game_positions_game_id | game_positions | 636 MB |
| ix_gp_user_black_hash | game_positions | 536 MB |
| ix_gp_user_white_hash | game_positions | 534 MB |
| ix_gp_full_hash_opening | game_positions | 358 MB |
| game_flaws_pkey | game_flaws | 242 MB |
| game_best_moves_pkey | game_best_moves | 138 MB |
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

### Storage summary

`game_positions` is 61% of the database (14 GB of 23 GB) and its indexes (6,951 MB) are almost as large as its data (7,114 MB) — a ~0.98 index-to-data ratio, driven by seven indexes on a 53M-row table. That's the structural cost of the Zobrist-hash matching design (three hash indexes plus the endgame and opening composites) and is expected, not accidental. `game_flaws` is the opposite shape: 5,119 MB of data against only 471 MB of indexes, because the flaw blob columns are wide.

Overall index-to-data across the DB is 8.8 GB / 15.2 GB. Nothing here looks like waste; the growth lever is row count, not index bloat.

---

## 2. Performance Analysis

### Buffer cache hit ratio

**99.59%** — excellent. With `shared_buffers=2GB` against a 23 GB database, this means the working set (recent users' games and positions) fits comfortably; the cold 21 GB is rarely touched.

### The top statement by total time is a DEAD statement — already fixed

> **Correction.** An earlier draft of this report presented the query below as its headline recommendation. That was wrong: **the fix already shipped on 2026-07-29** (Quick 260729-a86, release #288, present on `origin/production`). The `pg_stat_statements` row is a frozen historical artifact from before the fix. The analysis is retained because the measurement is real and useful, but there is **no action here**. See "How this was confirmed dead" below.

One query shows **47 minutes of cumulative server time** — 8.5x more than the next-heaviest statement. All of it was accrued between the 2026-06-23 stats reset and the 2026-07-29 fix.

| total_ms | calls | avg_ms | rows |
|---|---|---|---|
| **2,818,182** | 12,722 | 221.52 | 12,722 |

```sql
SELECT u.id FROM users u
WHERE EXISTS (
    SELECT 1 FROM games g
    WHERE g.user_id = u.id
      AND (   (u.is_guest = false
               AND g.full_evals_completed_at IS NULL
               AND g.lichess_evals_at IS NULL)
           OR (g.full_pv_completed_at IS NULL
               AND g.lichess_evals_at IS NOT NULL) ))
ORDER BY -ln(random()) / (exp(-EXTRACT(EPOCH FROM (now() - COALESCE(u.last_activity,'1970-01-01'))) / $1) + $2)
LIMIT 1
```

This is the eval-queue lottery picking one user with pending work. `EXPLAIN (ANALYZE, BUFFERS)` on prod:

```
Limit (actual time=841.221..841.228 rows=1)
  Buffers: shared hit=46419 read=26500 written=3439
  -> Sort (top-N heapsort)
     -> Hash Right Semi Join (actual time=120.198..825.073 rows=21)
          Join Filter: ((NOT u.is_guest AND ...) OR (...))
          Rows Removed by Join Filter: 167663
          -> Bitmap Heap Scan on games g (actual rows=256834)
                Heap Blocks: exact=71444
Execution Time: 844.048 ms
```

**Root cause.** The `u.is_guest` predicate sits *inside* the `OR`, so it cannot be pushed into the bitmap scan. Postgres must materialize all 256,834 pending-eval games (71,444 heap blocks, ~26,500 of them read from disk and 3,439 dirty pages written), apply the join filter, throw away 167,663 rows, and end up with **21 users**. It reads ~570 MB of heap to answer a question whose answer is 21 rows out of 495.

**Verified fix.** Splitting the `OR` into two independent `EXISTS` clauses lets each use its own partial index as an index-only scan:

```sql
SELECT u.id FROM users u
WHERE (u.is_guest = false AND EXISTS (
         SELECT 1 FROM games g WHERE g.user_id = u.id
           AND g.full_evals_completed_at IS NULL AND g.lichess_evals_at IS NULL))
   OR EXISTS (
         SELECT 1 FROM games g WHERE g.user_id = u.id
           AND g.full_pv_completed_at IS NULL AND g.lichess_evals_at IS NOT NULL)
ORDER BY ... LIMIT 1
```

```
Limit (actual time=2.604..2.606 rows=1)
  Buffers: shared hit=1666          <-- no disk reads, no dirty writes
  -> Seq Scan on users u (actual rows=21)
       SubPlan 1 -> Index Only Scan using ix_games_needs_engine_full_evals (loops=203)
       SubPlan 3 -> Index Only Scan using ix_games_lichess_pv_backfill_pending (loops=477)
Execution Time: 2.732 ms
```

**844 ms → 2.7 ms (≈310x), identical 21-row result set**, 72,919 buffers → 1,666, and the 3,439 dirty-page writes disappear entirely.

### How this was confirmed dead

This is exactly the rewrite that already shipped. `app/services/eval_queue_service.py` (`_claim_tier3_derived`, Step 1) already contains the split form, and its docstring records the same finding measured independently on 2026-07-29 (360 ms → 8.6 ms, "~42x faster, ~32x fewer buffers, turning the cost from O(backlog) into O(users)"), with equivalence verified by `EXCEPT` in both directions and an explicit warning:

> Do NOT "simplify" this back into one EXISTS with an OR — that reintroduces the regression, and it will not show up on the dev DB where `games` is small enough for the planner to seq-scan either shape at comparable cost.

`tests/services/test_eval_queue.py` pins the two-EXISTS shape against re-collapse. Three confirming signals:

| queryid | shape | sample 1 | sample 2 | sample 3 | verdict |
|---|---|---|---|---|---|
| -954824170158095255 | old, single EXISTS + OR | 12,722 | 12,722 | 12,722 | **frozen — dead** |
| -621834049101684171 | new, two correlated EXISTS | 68,178 | 68,407 | 68,415 | growing — live |
| -7158798570789030172 | Step 2 game pick | 80,900 | 81,129 | 81,137 | growing — live |

The live picker now runs at **1.15 ms mean**. `git branch --contains cfa6312f` confirms the release commit is on `origin/production`.

**Lesson for future runs of this report** (now written into the `db-report` skill): `pg_stat_statements` never forgets a retired query shape, and an EXPLAIN of a slow plan says nothing about whether the app still issues that SQL. Sample `calls` twice and grep the codebase before recommending any rewrite.

### Highest total execution time (top 10)

| total_ms | calls | avg_ms | query |
|---|---|---|---|
| 2,818,182 | 12,722 | 221.52 | ~~eval-lottery user scan~~ — **dead statement, already fixed** (above) |
| 325,998 | 80,900 | 4.03 | tier-3 Step 2 per-user pending-game pick — **live, now the true #1** |
| 259,931 | 3,773 | 68.89 | `COPY game_positions ... FROM STDIN (binary)` — import write path |
| 88,596 | 126 | 703.14 | achievable-score-gap cohort CTE (**below**) |
| 78,165 | 68,178 | 1.15 | eval-lottery, split-OR variant (healthy) |
| 77,918 | 134,721 | 0.58 | `opening_position_eval` cache lookup |
| 74,549 | 70,268 | 1.06 | per-game eval fetch by (game_id, user_id) |
| 58,425 | 33,427 | 1.75 | games ratings scan by user |
| 54,877 | 74,298 | 0.74 | `count(*) FROM games WHERE user_id = $1` |
| 54,260 | 250,892 | 0.22 | games row fetch by id |

Ranks 2 and 5–10 are all sub-5ms with high call counts — normal API traffic, nothing to fix. The `COPY` at rank 3 is the bulk import path writing 4.47M rows across 3,773 calls (≈1,184 rows/call at 69 ms); that is the correct tool for the job.

### Slowest by average (excluding one-off report queries)

| avg_ms | max_ms | calls | total_ms | query |
|---|---|---|---|---|
| 703.14 | **29,443** | 126 | 88,596 | achievable-score-gap cohort CTE |
| 437.32 | 3,913 | 42 | 18,368 | `game_flaws` bulk row fetch (85,484 rows) |
| 126.05 | – | 176 | 22,184 | `count(*)` over filtered `game_flaws` subquery |
| 34.42 | – | 664 | 22,852 | `game_flaws` × `games` × lateral `game_positions` count |

The top-by-average table is otherwise polluted by this report's own queries (the Section 0 recent-users query took 11.8 s, the size query 5.8 s) plus one-off admin/diagnostic statements — all `calls = 1`, safely ignorable.

The achievable-score-gap CTE is the one real concern: **703 ms average but a 29.4 s maximum**, a 42x spread. It chains `recent_capped` → `endgame_game_ids` → `entry_rows` → `scored` over `game_positions` for a single user, and the tail case is almost certainly a heavy user (user 534 has 658k positions). At 126 calls it is not currently a throughput problem, but a 29 s request will read as a hang or time out at the HTTP layer.

### Sequential scan analysis

| table | seq_scan | seq_tup_read | idx_scan | live rows | verdict |
|---|---|---|---|---|---|
| games | 209,937 | 123.9 B | 36.8 B | 772,149 | see below |
| game_positions | 161 | 4.26 B | 61.0 M | 53.1 M | fine — 161 scans is negligible |
| users | 14,885,509 | 2.57 B | 10.5 M | **495** | fine — 14 blocks, seq scan is correct |
| eval_jobs | 8,595,861 | 793 M | 4.85 M | **511** | fine — tiny table |
| game_flaws | 227 | 313 M | 698 B | 3.9 M | fine — index-driven |
| oauth_account | 485,687 | 53.5 M | 66 | 159 | fine — tiny table |
| bot_game_settings | 417,316 | 46.5 M | 0 | 249 | fine — tiny table |
| openings | 1,487 | 5.4 M | 0 | 3,641 | fine — small static table |

The high-`seq_scan` tables (`users`, `eval_jobs`, `oauth_account`, `bot_game_settings`) are all under 600 rows and fit in a handful of pages; PostgreSQL correctly prefers a seq scan and there is nothing to fix. `games` at 209,937 seq scans reading 123.9 B tuples is worth a note — a large share of that is the eval-lottery bitmap heap scan above, so fixing that query also reduces this number.

### Index usage

Genuinely unused (`idx_scan = 0`) and worth acting on:

| index | table | size | verdict |
|---|---|---|---|
| ix_games_full_pv_pending | games | **30 MB** | only sizable unused index. Partial index for a backfill lane; keep if the lane is still expected to run, otherwise drop. |
| ix_gp_full_hash_opening | game_positions | **358 MB** | **2 scans only** — but those 2 scans read 28.5 M tuples, so it *is* serving the opening-explorer aggregate path. Keep. |

Zero-scan but **keep** regardless (all trivially small, or required for correctness):
`ix_llm_logs_*` (3), `ix_oauth_account_oauth_name`, `feedback_pkey`, `ix_feedback_user_id`, `openings_pkey`, `ix_openings_eco_name`, `uq_openings_eco_name_pgn`, `bookmarks_pkey`, `bot_game_settings_pkey`, `ix_herring_pool_recency`, `alembic_version_pkc` — primary keys and unique constraints enforce integrity, OAuth indexes serve login flows that are rare but latency-sensitive, and every one of these is ≤488 kB.

No large index is genuinely droppable. The `ix_games_full_pv_pending` 30 MB is the only real candidate and only if that backfill lane is retired.

### Dead tuples / autovacuum

| table | live | dead | dead % |
|---|---|---|---|
| games | 772,149 | 148,669 | **16.1%** |
| game_flaws | 3,912,006 | 420,727 | 9.7% |
| game_positions | 53,101,886 | 2,392,475 | 4.3% |
| opening_position_eval | 2,205,795 | 6,289 | 0.3% |
| game_best_moves | 3,854,955 | 5,513 | 0.1% |

All below the 20% flag threshold and autovacuum is keeping up — `games` last autovacuumed 2026-07-30, autoanalyzed 2026-07-31T04:21. `games` at 16.1% is the highest and is explained by the write pattern: the eval pipeline repeatedly `UPDATE`s completion timestamp columns (`blobs_completed_at` 63,835 calls, `full_evals_completed_at` 57,475 calls), each creating a dead tuple. Worth watching but not actionable now.

---

## 3. Sanity Checks

### Check A — Flaw counts: `games` oracle columns vs `game_flaws`

> **Skill documentation is stale on a material point.** The `db-report` skill's Check A background states oracle columns "are **NULL for chess.com**" and that "chess.com games have **zero** `game_flaws` rows". Neither holds any more:
>
> | platform | games | oracle_present | games with flaw rows | lichess_evals |
> |---|---|---|---|---|
> | chess.com | 512,611 | **345,949** | **339,508** | 0 |
> | lichess | 259,813 | 179,285 | 176,417 | 71,997 |
> | flawchess | 249 | 216 | 211 | 211 |
>
> Our own Stockfish pipeline now populates the oracle count columns for all platforms, not just lichess. Because Check A is hard-scoped to `platform = 'lichess'`, it currently leaves the **largest** population (346k chess.com games) unchecked. I ran the equivalent check on chess.com below. **The skill's Check A section should be updated** — the lichess-only scoping and the "chess.com is NULL by design" rationale are both obsolete.

**Lichess (the skill's scoped check):**

| metric | value |
|---|---|
| lichess games with flaw rows | 176,416 |
| **`flaws_but_all_counts_null`** | **0** ✅ |
| games with counts present | 179,284 |
| both counts match | 178,335 (**99.47%**) |
| mistake mismatch | 800 |
| blunder mismatch | 433 |

Direction and aggregates:

| | oracle total | game_flaws total | delta |
|---|---|---|---|
| mistakes | 523,952 | 524,843 | **+0.17%** |
| blunders | 811,861 | 812,168 | **+0.04%** |

`game_flaws` over-counts more often than it under-counts (mistakes 698 over / 102 under; blunders 314 over / 119 under), consistent with the known mate-ladder drift in `flaws_service.py`. Aggregate agreement is well within the ~1% tolerance.

> Note on the skill's stated formula: `exact_match / lichess_games_with_flaws` yields 178,335 / 176,416 = **101.1%**, which is nonsense. The numerator counts games with oracle counts present that match (including games with zero flaws, where `0 = 0` matches and no `game_flaws` row exists), while the denominator counts only games that *have* flaw rows. The correct denominator is `games_with_counts_present` (179,284), giving 99.47%. Worth fixing in the skill.

**chess.com + flawchess (extension, not in the skill):**

| platform | games with counts | both match | match rate | oracle mistakes | gf mistakes | oracle blunders | gf blunders |
|---|---|---|---|---|---|---|---|
| chess.com | 345,953 | 345,187 | **99.78%** | 1,014,035 | 1,014,984 | 1,546,354 | 1,546,880 |
| flawchess | 216 | 216 | **100.00%** | 538 | 538 | 797 | 797 |

chess.com agrees *better* than lichess (99.78% vs 99.47%), which makes sense: on chess.com both sides derive from our own evals, whereas lichess compares our ES thresholds against lichess's independent win%-based classifier. Aggregate deltas are +0.09% (mistakes) and +0.03% (blunders).

**Verdict (Check A): PASS** — `flaws_but_all_counts_null = 0`, all aggregate totals within 0.2%, and the extension to chess.com is also clean.

### Check B — Eval coverage vs oracle-column presence (Flaws Timeline gate)

| platform | games ≥90% coverage | `ge90_but_oracle_null` | oracle present |
|---|---|---|---|
| chess.com | 340,832 | **0** ✅ | 340,832 |
| lichess | 177,498 | **0** ✅ | 177,498 |
| flawchess | 211 | **0** ✅ | 211 |

**Verdict (Check B): PASS** — zero games on any platform clear the 0.90 eval-coverage gate while missing oracle columns, so the Flaws Timeline's oracle-present gate loses nothing.

Also worth recording: the skill predicted chess.com would "usually **not** clear the 0.90 gate" and that any chess.com rows here would be the "interesting case". In fact **340,832 chess.com games do clear it** — full-game Stockfish coverage has landed broadly on chess.com. The reason it isn't a problem is that oracle backfill kept pace exactly. This is the specific scenario the skill flagged as INVESTIGATE-worthy, and it resolved benignly, but the prediction in the skill text is now wrong and should be updated alongside Check A.

### Pipeline backlog (context for the above)

| lane | pending |
|---|---|
| needs engine (`full_evals` NULL, no lichess evals) | 245,526 |
| lichess PV backfill | 11,308 |
| blob backfill (`blobs_completed_at` NULL, evals done) | 68,868 |

---

## Summary

**Healthy overall.** 23 GB, 772,673 games, 53.1 M positions, 495 users (203 registered / 292 guest). Cache hit ratio 99.59%, autovacuum keeping up, no table above the 20% dead-tuple threshold, both sanity checks PASS with aggregate flaw-count agreement inside 0.2% on every platform.

**No urgent action items.** The statement that dominates `pg_stat_statements` (47 minutes cumulative, 8.5x the runner-up) is the pre-fix tier-3 eval-queue picker, and **that fix already shipped 2026-07-29** (Quick 260729-a86, release #288, on `origin/production`). Its row is a frozen historical artifact — confirmed dead across three `calls` samples while the live split-EXISTS form (1.15 ms mean) grew. Once that row is discounted, nothing in the top 20 is both live and problematic.

**Recommended**
- ~~Rewrite the eval-lottery query~~ — **retracted, already done.** Kept visible rather than deleted so the retraction is on the record.
- **Discard the dead statement so it stops topping the charts** (needs superuser on the server; the prod MCP role is read-only):
  ```sql
  SELECT pg_stat_statements_reset(0, 0, -954824170158095255);
  ```
  Targeted discard preserves the other ~37 days of history. Do **not** use `pg_stat_reset()` for this — it clears table/index scan counters and would destroy the observation window the unused-index analysis depends on.

**Done in this session**
- **`db-report` skill Section 3 corrected.** Three claims were factually wrong: (a) chess.com oracle columns are populated (345,949 games), not NULL; (b) chess.com has 339,508 games with `game_flaws` rows, not zero; (c) 340,832 chess.com games clear the ≥90% coverage gate, contradicting the "usually will not clear it" prediction. Queries 9 and 10 are now grouped by platform instead of scoped to lichess (the old scoping silently skipped the largest population), and the match-rate denominator is fixed — it divided by `games_with_flaw_rows` and returned a nonsensical 101.1%.
- **`db-report` skill Section 2 hardened** with a mandatory pre-recommendation check (sample `calls` twice + grep the codebase), documenting this session's false positive so the next run cannot repeat it.

**Monitor**
- **Achievable-score-gap CTE**: 703 ms avg but **29.4 s max** across only 126 calls. This is now the most interesting *live* performance item in the report. Low volume today, but a 29 s request will surface as a hang or an HTTP timeout. Likely triggered by high-volume users (534 has 658k positions). Worth a look before that endpoint sees real traffic. Verified live (`calls` growing), unlike the retracted item above.
- **Tier-3 Step 2 game pick** (`325,998 ms / 80,900 calls / 4.03 ms`) is now the true #1 by total time among live statements. At 4 ms it is not a problem, but note it still carries an `OR` with an `EXISTS`-on-`users` inside one branch — the same family as the Step 1 issue that was just fixed. Not worth touching at 4 ms; worth remembering if its mean climbs.
- `games` dead-tuple ratio at 16.1%, driven by repeated completion-timestamp `UPDATE`s from the eval pipeline. Below threshold, autovacuum coping.
- `needs_engine` backlog at 245,526 games — now drained by the O(users) picker rather than the O(backlog) one.

**Consider**
- Drop `ix_games_full_pv_pending` (30 MB, 0 scans) if that backfill lane is retired. The only sizable genuinely-unused index; every other zero-scan index is ≤488 kB or enforces integrity.
- `game_positions` carries a ~0.98 index-to-data ratio (6,951 MB indexes / 7,114 MB data) across seven indexes. This is the inherent cost of Zobrist-hash position matching and is working as designed — noted for capacity planning, not as a defect.

**No action needed**
- High `seq_scan` counts on `users` (14.9 M), `eval_jobs` (8.6 M), `oauth_account`, `bot_game_settings`: all under 600 rows, seq scan is the correct plan.
- The `COPY game_positions` import path (260 s total, 4.47 M rows) is the right tool and performing well.
- Ranks 2 and 5–10 by total time are all sub-5 ms with high call counts — ordinary API traffic.

**Caveat**: `pg_stat_statements` was last reset 2026-06-23, so totals cover ≈37 days. Several `calls = 1` entries in the slowest-by-average table are this report's own queries and admin one-offs.
