---
id: SEED-125
status: open
planted: 2026-07-28
planted_during: Discussion of `reports/db-stats/db-report-prod-2026-07-26.md` recommendation #1. The report found the tier-4 blob-backfill user picker is 84.8% of all DB time (504.1h of 594.6h over a 33-day window, 2,495,703 calls x 727ms avg, ~0.64 of a core burned continuously) and recommended a per-user "pending work" counter table. Investigation showed the counter table is unnecessary — the cost is an index-shape problem with an existing in-repo solution.
trigger_when: Next time queue/eval-pipeline work is scoped, or if prod DB CPU becomes a binding constraint. Not urgent — this is idle-capacity work that does not currently hurt user-facing latency (real queries run at 0.5-0.8ms). Cheap enough to fold into any adjacent phase touching `app/services/eval_queue_service.py`.
scope: quick or small phase (1 plan) — one Alembic migration (nullable timestamp column + partial index + one-time backfill UPDATE), a bidirectional stamp-refresh helper wired into the blob-write and reclassification paths, and a rewritten `_claim_tier4_blob` Stage 1 predicate.
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

(Re-verified 2026-07-28 during seed review: 365 ms / 262k buffers vs 1.2 ms / 906 buffers —
the comparison shape's backlog had drained to zero by then, demonstrating the O(users)
floor: 176 index-only probes regardless of backlog size.)

**45x time, 140x buffers.** The structural win matters more than the constant: the semi-join
short-circuits on each user's first matching row, so cost becomes **O(users), not
O(backlog)** — it stops growing with the corpus, which is the property the current query
fundamentally lacks.

## Implementation sketch

1. **Migration**: add `games.blobs_completed_at TIMESTAMPTZ NULL`; create
   `ix_games_blob_backfill_pending ON games (user_id) WHERE full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL`.
   Plain in-transaction `CREATE INDEX`, NOT `CONCURRENTLY` — every partial-index migration
   in this repo (`c3f5d1e8a092`, `e872c9deb514`, …) is deliberately non-concurrent because
   migrations run against a quiescent backend at container startup, and `CONCURRENTLY`
   cannot run inside a transaction. (An earlier draft of this seed cited `c3f5d1e8a092` as
   a CONCURRENTLY precedent; it is explicitly the opposite.)
2. **One-time backfill**: stamp `blobs_completed_at` for every analyzed game with no
   NULL-blob flaw remaining (~414k of 456k analyzed games as of 2026-07-28 — seconds-scale
   UPDATE, fine in the startup-migration window with `max_wal_size=8GB`). Leave the rest
   NULL so the existing backlog stays claimable.
3. **Bidirectional stamp refresh** (the load-bearing piece — see wrinkle below): one helper
   `_refresh_blobs_completed(session, game_id)` that probes
   `SELECT 1 FROM game_flaws WHERE game_id=:g AND allowed_pv_lines IS NULL LIMIT 1`
   (index-only via `ix_game_flaws_blob_backfill`, sub-ms) and sets the column **both ways**:
   probe empty → stamp `now()`, probe non-empty → set NULL. Call sites:
   - `app/routers/eval_remote.py` `/flaw-blob-submit` (~line 971, after the blob write)
   - `app/routers/eval_remote.py` `/flaw-blob-lease` sentinel branches (~lines 824, 849)
   - `app/services/eval_apply.py` `_classify_and_fill_oracle` — **unconditionally at the
     end of the flaw diff/upsert**, NOT hooked on its `_batch_update_flaw_pv_lines` call
     (~line 1050): that call sits inside `if flaw_pv_blobs:`, so a submit with zero blobs
     (local-drain `blobs_pending=True` path) inserts NULL plies without reaching it.
4. **Forward-progress backstop**: also stamp in `/flaw-blob-lease`'s "no walkable lines,
   no sentinels" branch (~line 817, currently returns 204 writing nothing) and in
   `/flaw-blob-submit`'s idempotency gate (D-03, "no NULL-blob flaws remain"). Today the
   nothing-pending state self-clears because the predicate reads the flaw rows directly;
   with a stamp column, a missed stamp (e.g. two concurrent blob writers, neither's probe
   seeing the other's uncommitted rows, so neither stamps) would make the lottery re-pick
   the game forever — the SEED-073 infinite-repick failure mode, silent and cheap. Stamping
   on the nothing-to-do paths makes missed stamps self-healing (one wasted pick, then
   stamped) and preserves the T-145-07 forward-progress guarantee.
5. **Rewrite** `_claim_tier4_blob` Stage 1's `candidate_exists_sql` to the `games`-only
   predicate. Stage 2 (game pick) can use the same column and drop its `EXISTS` subquery.

### The one wrinkle: the stamp must be cleared on reclassification, not just set

Blobs are per-flaw-ply but the column is per-game, so unlike `best_moves_completed_at`
(one row per game) the stamp needs the "any NULL plies left?" probe — one indexed lookup
per **submit**, replacing a 340ms query per **pick**. Strongly favourable, but the
invariant runs in BOTH directions and the "clear" direction is on a live path:

- **Set-guard**: a game with a remaining NULL-blob ply must never be stamped.
- **Clear-on-reclassify**: tier-3 branch (b) picks lichess-eval games whose
  `full_evals_completed_at` is ALREADY stamped (lichess freebies) for the full-PV pass;
  the atomic submit then runs `apply_full_eval` → `_classify_and_fill_oracle`, whose
  delete-then-insert reclassification inserts new NULL-blob plies whenever
  server-authoritative classify finds plies the worker's hints missed (exactly the residue
  mechanism in the Notes). Such a game may already carry `blobs_completed_at` from an
  earlier tier-4 pass. A stamp-only-if-empty design never clears it, and the new pending
  plies silently drop out of the backfill population forever.

The plan must test the clear direction explicitly (stamped game → reclassify creates a
NULL-blob ply → column is NULL again), not just the set-guard.

## Notes

- `ix_game_flaws_blob_backfill` stays — step 3's probe uses it.
- **Guest games**: ~17k analyzed games belong to guests; their pending subset stays in the
  new partial index forever (guest flaws are never processed by this lane — Stage 1 filters
  `is_guest = false`). Leaving them NULL is correct (work becomes claimable if a guest ever
  converts) and the bloat is bounded; just don't "fix" it by stamping them in the backfill.
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
