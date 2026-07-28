---
id: SEED-125
status: open
planted: 2026-07-28
planted_during: Discussion of `reports/db-stats/db-report-prod-2026-07-26.md` recommendation #1. The report found the tier-4b blob-backfill user picker is 84.8% of all DB time (504.1h of 594.6h over a 33-day window, 2,495,703 calls x 727ms avg, ~0.64 of a core burned continuously) and recommended a per-user "pending work" counter table. Investigation showed the counter table is unnecessary — the cost is an index-shape problem with an existing in-repo solution.
trigger_when: Next time queue/eval-pipeline work is scoped, or if prod DB CPU becomes a binding constraint. Not urgent — this is idle-capacity work that does not currently hurt user-facing latency (real queries run at 0.5-0.8ms). Cheap enough to fold into any adjacent phase touching `app/services/eval_queue_service.py`.
scope: quick or small phase (1 plan) — one Alembic migration (nullable timestamp column + partial index + one-time backfill UPDATE), a stamp-on-write helper at 3 call sites, and a rewritten `_claim_tier4_blob` Stage 1 predicate.
depends_on: none
---

# SEED-125: `blobs_completed_at` column on `games` to fix the tier-4 blob picker

## The problem

`_claim_tier4_blob`'s Stage 1 user pick (`app/services/eval_queue_service.py`) asks
"which non-guest users have an analyzed game with a NULL-blob flaw?" via an `EXISTS`
correlated over the full `games`/`game_flaws` corpus:

```sql
EXISTS (SELECT 1 FROM games g JOIN game_flaws gf ON gf.game_id = g.id
        WHERE g.user_id = u.id
          AND g.full_evals_completed_at IS NOT NULL
          AND gf.allowed_pv_lines IS NULL)
```

Pending-ness lives on `game_flaws`, whose only supporting index is
`ix_game_flaws_blob_backfill` on `(game_id) WHERE allowed_pv_lines IS NULL`. There is no
user-side entry point, so the planner must materialize the whole semi-join and probe
`games` tens of thousands of times before it can sort ~73 eligible users by the ES
random-decay key to return **one** row.

Measured on prod 2026-07-28 (`EXPLAIN ANALYZE, BUFFERS`):

```
Limit (actual time=317.743..317.747 rows=1)
  Buffers: shared hit=252569 read=7875
  -> Sort (top-N heapsort)
     -> Hash Right Semi Join (actual time=14.721..301.128 rows=73)
        -> Nested Loop (actual rows=104654)
           -> Index Only Scan ix_game_flaws_blob_backfill (rows=208491, Heap Fetches: 23272)
           -> Memoize (Hits: 153268  Misses: 55223)
              -> Index Scan uq_games_id_user_id on games (loops=55223)
        -> Seq Scan on users (176 rows)
Execution Time: 340.182 ms
```

**Cost scales with backlog size and is re-paid on every call.** This also explains the 82
billion tuples the report attributes to sequential scans on `games`.

## Why NOT a counter table or materialized view

- **Materialized view**: Postgres has no incremental matview. `REFRESH MATERIALIZED VIEW`
  re-runs the same expensive query in full. There is no auto-update. Dead end.
- **Per-user counter table** (the report's recommendation): works, but it is new
  bookkeeping infrastructure with its own drift and reconciliation surface, for a problem
  the repo has already solved three times by other means.

## The fix: follow the existing idiom

The queue already uses `games(user_id) WHERE <pending predicate>` partial indexes for
every other tier:

- `ix_games_bestmove_backfill_pending` — `(user_id) WHERE full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL`
- `ix_games_lichess_pv_backfill_pending` — `(user_id) WHERE lichess_evals_at IS NOT NULL AND full_pv_completed_at IS NULL`
- `ix_games_needs_engine_full_evals` — `(user_id) WHERE full_evals_completed_at IS NULL AND lichess_evals_at IS NULL`

Tier-4 blob is the odd one out only because its pending state lives on `game_flaws`
instead of `games`. Adding `blobs_completed_at` to `games` makes it a fifth completion
column alongside `evals_completed_at` / `full_evals_completed_at` / `full_pv_completed_at`
/ `best_moves_completed_at` (see `.planning/notes/eval-completion-columns.md`).

### Measured payoff

Running the **identical query shape** against `ix_games_bestmove_backfill_pending` on prod:

| | current tier-4 picker | games-side index shape |
|---|---|---|
| execution time | 340 ms | **7.5 ms** |
| buffers | 260,444 | **1,838** |
| plan | Hash Right Semi Join over 208k rows | Nested Loop Semi Join, 176 index-only probes |

**45x time, 140x buffers.** The structural win matters more than the constant: the semi-join
short-circuits on each user's first matching row, so cost becomes **O(users), not
O(backlog)** — it stops growing with the corpus, which is the property the current query
fundamentally lacks.

## Implementation sketch

1. **Migration**: add `games.blobs_completed_at TIMESTAMPTZ NULL`; create
   `ix_games_blob_backfill_pending ON games (user_id) WHERE full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL`
   (`CONCURRENTLY`, following `20260630_220000_c3f5d1e8a092`'s non-transactional pattern).
2. **One-time backfill**: stamp `blobs_completed_at` for every analyzed game with no
   NULL-blob flaw remaining. Leave the rest NULL so the existing backlog stays claimable.
3. **Stamp on write**: after each blob write, probe
   `SELECT 1 FROM game_flaws WHERE game_id=:g AND allowed_pv_lines IS NULL LIMIT 1`
   (index-only via `ix_game_flaws_blob_backfill`, sub-ms) and stamp when empty. Three call
   sites, all already calling `_batch_update_flaw_pv_lines`:
   - `app/routers/eval_remote.py` `/flaw-blob-submit` (~line 971)
   - `app/routers/eval_remote.py` `/flaw-blob-lease` sentinel branches (~lines 824, 849)
   - `app/services/eval_apply.py` `apply_full_eval` (~line 1048)
4. **Rewrite** `_claim_tier4_blob` Stage 1's `candidate_exists_sql` to the `games`-only
   predicate. Stage 2 (game pick) can use the same column and drop its `EXISTS` subquery.

### The one wrinkle

Blobs are per-flaw-ply but the column is per-game, so unlike `best_moves_completed_at`
(one row per game) the stamp needs the "any NULL plies left?" probe in step 3. That is one
indexed lookup per **submit**, replacing a 340ms query per **pick** — strongly favourable,
but it is real bookkeeping and the plan should treat the stamp as an invariant to test
(a game with a remaining NULL-blob ply must never be stamped, or it silently drops out of
the backfill population forever).

## Notes

- `ix_game_flaws_blob_backfill` stays — step 3's probe and Stage 2 both use it.
- Backlog context (prod, 2026-07-28): 41,929 pending games / 104,641 pending flaw rows,
  ~96% analyzed within the last 5 days. The historical backlog has drained; this is
  steady-state flow with a ~5-7 day lag. Median pending game needs **1-2 plies** filled,
  and 67-76% of flaw plies are already blobbed inline by the atomic-submit path, so the
  tier-4 rung is a residue mop-up, not a bulk producer.
- **Not pursued**: the upstream "why is there a residue at all" question (server's
  authoritative `classify_game_flaws` finds flaws the worker's local `_hint_flaw_plies`
  missed, leaving them NULL for tier-4). A cache-omission mechanism was hypothesized and
  **rejected** — `opening_position_eval` is opening-only and cannot explain the uniform
  residue across middlegame (11.1%) and endgame (17.1%). Mechanism unknown; judged not
  worth fixing since this seed makes the picker cheap regardless. If ever revisited, the
  decisive test is logging, for one atomic submit, the set difference between
  server-classified flaw plies and worker-hinted plies.
- Related report items not covered here: missing index on `games.platform_url`, idle
  `ix_gp_full_hash_opening` (354 MB, 2 scans) and `ix_games_full_pv_pending` (30 MB, 0 scans).
