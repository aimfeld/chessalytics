---
phase: 260728-soo
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - alembic/versions/<new_revision>_seed_125_games_blobs_completed_at.py
  - app/models/game.py
  - app/services/eval_apply.py
  - app/routers/eval_remote.py
  - app/services/eval_queue_service.py
  - tests/services/test_eval_queue.py
  - tests/services/test_full_eval_drain.py
autonomous: true
requirements: [SEED-125]

must_haves:
  truths:
    - "The tier-4 blob picker's Stage 1 user pick reads only `games` columns (no `game_flaws` join), so its cost is O(users) not O(backlog)."
    - "A game with at least one `game_flaws` row where `allowed_pv_lines IS NULL` never carries a non-NULL `games.blobs_completed_at` after any write path touching that game completes."
    - "A previously-stamped game whose reclassification inserts a fresh NULL-blob flaw ply has `blobs_completed_at` set back to NULL (the clear direction)."
    - "A game the lottery picks but for which there is nothing to do (no walkable lines, no sentinels, or all blobs already written) ends up stamped, so the lottery cannot re-pick it forever."
    - "Existing pending blob work (NULL-blob flaws on analyzed games) stays claimable after the migration."
  artifacts:
    - "alembic/versions/*_seed_125_games_blobs_completed_at.py — column + partial index + one-time backfill UPDATE"
    - "app/models/game.py — `blobs_completed_at` mapped column + `ix_games_blob_backfill_pending` in `__table_args__`"
    - "app/services/eval_apply.py — `_refresh_blobs_completed(session, game_id)` helper"
  key_links:
    - "`_claim_tier4_blob` Stage 1/Stage 2 predicates ↔ `ix_games_blob_backfill_pending` predicate text (must match byte-for-byte or the index is not used)"
    - "`app/models/game.py` `postgresql_where` text ↔ the migration's `create_index(postgresql_where=...)` text (174-07 alembic drift lesson)"
    - "`_classify_and_fill_oracle` end-of-function refresh ↔ the tier-3 branch-(b) lichess-eval reclassification path that inserts new NULL-blob plies on already-stamped games"
---

<objective>
Implement SEED-125: add a `games.blobs_completed_at` completion column so the tier-4
flaw-blob backfill lottery's Stage 1 user pick stops semi-joining the whole
`games`/`game_flaws` corpus on every remote-worker idle poll.

Purpose: that picker is 84.8% of all prod DB time (504h over 33 days, 2.5M calls at
727ms avg). Prod `EXPLAIN ANALYZE` of the identical query shape against an existing
games-side partial index measures 340ms → 7.5ms and 260k → 1.8k buffers. The structural
win matters more than the constant: the semi-join short-circuits on each user's first
matching row, so cost becomes O(users) and stops growing with the corpus.

Output: one Alembic migration (column + partial index + one-time backfill), a
bidirectional `_refresh_blobs_completed` helper wired into every blob-write and
reclassification path, a rewritten `_claim_tier4_blob`, and tests proving BOTH
directions of the invariant.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/seeds/SEED-125-blob-pending-games-column.md
@.planning/notes/eval-completion-columns.md
@CLAUDE.md

Read as you go (do NOT pre-read all of these — they are large):
- `app/services/eval_queue_service.py` — `_claim_tier4_blob` at line 594, and the shared
  `_es_weighted_user_pick` / `_es_weighted_game_pick` building blocks above it.
- `app/routers/eval_remote.py` — `flaw_blob_lease` at line 774, `_apply_flaw_blob_submit`
  at line 863. Note it ALREADY imports private helpers from `eval_apply` (line 96-111),
  so adding `_refresh_blobs_completed` to that import list is the established pattern.
- `app/services/eval_apply.py` — `_classify_and_fill_oracle` at line 826 (ends at line
  1156), `_batch_update_flaw_pv_lines` at line 1496, `_stamp_best_moves_completed_directly`
  at line 2164 (the closest existing stamp-helper idiom).
- `app/models/game.py` — completion columns at lines 210-246; `ix_games_bestmove_backfill_pending`
  declaration at lines 91-107 is the exact index idiom to copy.
- `alembic/versions/20260724_192741_e872c9deb514_realign_ix_games_bestmove_backfill_.py` —
  the non-concurrent partial-index migration idiom (its docstring explains WHY not CONCURRENTLY).

Current Alembic head: `f2624e60292e`.
</context>

<tasks>

<task type="tracer">
  <name>Task 1: Schema — `blobs_completed_at` column, partial index, one-time backfill</name>
  <files>alembic/versions/&lt;new_revision&gt;_seed_125_games_blobs_completed_at.py, app/models/game.py</files>
  <precondition>The dev PostgreSQL is running (`docker compose -f docker-compose.dev.yml -p flawchess-dev up -d`) and `uv run alembic current` reports `f2624e60292e`.</precondition>
  <action>
Add a fifth completion column to `games` following the four documented in
`.planning/notes/eval-completion-columns.md`.

In `app/models/game.py`:
- Declare `blobs_completed_at: Mapped[datetime.datetime | None] = mapped_column(sa.DateTime(timezone=True), nullable=True)` immediately after `best_moves_completed_at` (line 244-246), with a docstring-style comment matching the density of its neighbours: state that it is a per-GAME rollup of a per-FLAW-PLY condition (unlike the other four, which are naturally per-game), that the authoritative predicate is "no `game_flaws` row for this game has `allowed_pv_lines IS NULL`", that it is maintained BIDIRECTIONALLY by `_refresh_blobs_completed` (set on completion, cleared on reclassification), and that NULL means "tier-4 blob lottery may claim this game". Cite SEED-125.
- Add an `Index("ix_games_blob_backfill_pending", "user_id", postgresql_where=sa.text("full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL"))` entry to `__table_args__`, directly after `ix_games_bestmove_backfill_pending`. Copy that neighbour's shape exactly (single `user_id` column, partial WHERE). Include the same warning its comment carries: the `postgresql_where` text MUST stay byte-identical to the migration's `create_index` call.

Create the migration with `uv run alembic revision -m "SEED-125 games.blobs_completed_at"`
(hand-write the body; do NOT rely on `--autogenerate` for the backfill UPDATE). Its
`upgrade()` does three things, in this order:
1. `op.add_column("games", sa.Column("blobs_completed_at", sa.DateTime(timezone=True), nullable=True))`
2. One-time backfill: stamp every analyzed game that has no NULL-blob flaw remaining, e.g.
   `UPDATE games g SET blobs_completed_at = now() WHERE g.full_evals_completed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM game_flaws gf WHERE gf.game_id = g.id AND gf.allowed_pv_lines IS NULL)`.
   Run this BEFORE creating the index so the index build sees the final row set. Games with
   remaining NULL-blob flaws stay NULL so the existing ~42k-game backlog remains claimable.
   Do NOT special-case guests — guest games stay NULL like everyone else (Stage 1 filters
   `is_guest = false`, the bloat is bounded, and the work becomes claimable if a guest ever
   converts). A comment must say so explicitly, so a future reader does not "fix" it.
3. `op.create_index("ix_games_blob_backfill_pending", "games", ["user_id"], unique=False, postgresql_where=sa.text(...))` with the predicate text byte-identical to the model declaration.

Plain in-transaction `CREATE INDEX` — NOT `CONCURRENTLY`. The migration docstring must
carry the same rationale as `e872c9deb514`'s (migrations run against a quiescent backend
at container startup via `deploy/entrypoint.sh` before uvicorn accepts traffic, and
`CONCURRENTLY` cannot run inside a transaction). `downgrade()` drops the index then the
column.

Do NOT add the index to `MIGRATION_ONLY_INDEXES` in `tests/test_migration_only_indexes_exist.py`
— that list is for indexes the ORM cannot declare, and this one IS ORM-declared.
  </action>
  <verify>
    <automated>uv run alembic upgrade head &amp;&amp; uv run alembic downgrade -1 &amp;&amp; uv run alembic upgrade head &amp;&amp; uv run ty check app/</automated>
    <automated>psql "$(grep -oP '(?&lt;=DATABASE_URL=).*' .env | sed 's|postgresql+asyncpg|postgresql|')" -c "SELECT indexname FROM pg_indexes WHERE indexname = 'ix_games_blob_backfill_pending'" | grep -q ix_games_blob_backfill_pending</automated>
  </verify>
  <done>
`games.blobs_completed_at` exists and is nullable; `ix_games_blob_backfill_pending` exists
in `pg_indexes` with the partial predicate; upgrade→downgrade→upgrade round-trips cleanly;
the model's `postgresql_where` string is character-for-character equal to the migration's.
On the dev DB, this query returns zero rows (backfill correctness — no stamped game may
still have a NULL-blob flaw):
`SELECT g.id FROM games g JOIN game_flaws gf ON gf.game_id = g.id WHERE g.blobs_completed_at IS NOT NULL AND gf.allowed_pv_lines IS NULL LIMIT 5;`
  </done>
  <reversibility rating="reversible">Additive nullable column plus an index; `downgrade()` removes both and no existing query reads the column until Task 3.</reversibility>
</task>

<task type="auto" tdd="true">
  <name>Task 2: `_refresh_blobs_completed` helper + wire into all five call sites</name>
  <files>app/services/eval_apply.py, app/routers/eval_remote.py, tests/services/test_full_eval_drain.py</files>
  <behavior>
    - Direction SET: a game whose flaw rows all have non-NULL `allowed_pv_lines` (including the zero-flaw case) gets `blobs_completed_at` set to a non-NULL timestamp.
    - Direction CLEAR: a game already carrying a `blobs_completed_at` stamp, whose flaw set then gains a row with `allowed_pv_lines IS NULL`, gets `blobs_completed_at` set back to NULL.
    - Idempotent: calling the helper twice in a row on an unchanged game leaves the column in the same NULL/non-NULL state.
    - `_classify_and_fill_oracle` clears the stamp even when it was called with no PV blobs to write (the `flaw_pv_blobs` empty / local-drain `blobs_pending=True` path).
  </behavior>
  <action>
Add `async def _refresh_blobs_completed(session: AsyncSession, game_id: int) -> None` to
`app/services/eval_apply.py`, placed near `_batch_update_flaw_pv_lines` (line 1496). It
probes `SELECT 1 FROM game_flaws WHERE game_id = :g AND allowed_pv_lines IS NULL LIMIT 1`
(index-only via the existing `ix_game_flaws_blob_backfill`, sub-ms) and then issues ONE
`UPDATE games SET blobs_completed_at = :value WHERE id = :g` — `now()` when the probe is
empty, `NULL` when it is not. Both values bound as parameters, never interpolated. The
helper does NOT commit — the caller owns the transaction (mirrors `_batch_update_flaw_pv_lines`,
not `_stamp_best_moves_completed_directly`).

Its docstring must state the load-bearing rule from SEED-125: the invariant runs in BOTH
directions, and a stamp-only-if-empty design would silently drop reclassified games out of
the backfill population forever.

Wire it into five call sites:

1. `app/services/eval_apply.py` `_classify_and_fill_oracle` — call it UNCONDITIONALLY as
   the last statement of the function body (after the `flaw_pv_by_ply` PV-write block that
   ends at line 1156). Do NOT hook it onto the `_batch_update_flaw_pv_lines` call at line
   1050: that call sits inside `if flaw_pv_blobs:`, so a submit carrying zero blobs (the
   local-drain `blobs_pending=True` path) inserts NULL-blob plies without ever reaching it.
   Add a comment naming that trap so nobody "optimizes" the call back inside the branch.
   This is the clear-direction site: tier-3 branch (b) picks lichess-eval games whose
   `full_evals_completed_at` is already stamped, and the delete-then-insert reclassification
   inserts new NULL-blob plies on games that may already carry a `blobs_completed_at` stamp
   from an earlier tier-4 pass.

2. `app/routers/eval_remote.py` `flaw_blob_lease` — restructure the `if not lease_positions:`
   block (lines 817-826) so the session is opened unconditionally and the sentinel write
   stays conditional:
   open `async_session_maker()`, write the sentinel blob map only `if sentinel_lines:`, then
   call `_refresh_blobs_completed`, then commit, then return 204. This single edit covers
   BOTH the sentinel branch and SEED-125's forward-progress backstop (the "no walkable
   lines, no sentinels" case that today returns 204 writing nothing).

3. Same file, the over-cap `elif len(lease_positions) > MAX_SUBMIT_EVALS:` branch (lines
   838-851) — call the helper inside the existing `write_session` after
   `_batch_update_flaw_pv_lines`, before the commit.

4. Same file, `_apply_flaw_blob_submit` write phase (line 970-983) — call the helper inside
   the existing `write_session` after `_batch_update_flaw_pv_lines`, before the commit.

5. Same file, `_apply_flaw_blob_submit`'s idempotency gate (`if not null_flaw_plies:` at
   line 909) — no session is open there (`read_session` is closed), so open a short session,
   call the helper, commit, then return `blobs_written=0` as today.

Add `_refresh_blobs_completed` to the existing `from app.services.eval_apply import (...)`
block at line 96 (alphabetical position).

Sites 2 and 5 are the forward-progress backstop and are NOT optional: with a stamp column,
a missed stamp (two concurrent blob writers, neither's probe seeing the other's uncommitted
rows) would otherwise make the lottery re-pick the game forever — the SEED-073
infinite-repick failure mode, silent and cheap. Stamping on the nothing-to-do paths makes a
missed stamp self-healing (one wasted pick, then stamped) and preserves the T-145-07
forward-progress guarantee. The same backstop is what covers analyzed games that never run
through `_classify_and_fill_oracle` at all. Add a comment at site 2 saying so.

Tests — add to `tests/services/test_full_eval_drain.py`, in the class that owns
`test_accuracy_acpl_null_on_interior_hole` (line 3042), reusing its direct-call harness for
`_classify_and_fill_oracle`:
- CLEAR direction: insert a `_SIX_PLY_PGN` game with `full_evals_completed_at` set and
  positions that classify to at least one flaw (the existing fixture's ply-3 `eval_cp=-480`
  drop already does this), then `UPDATE games SET blobs_completed_at = now()` directly (do
  not add a kwarg to that file's `_insert_game`), call
  `_classify_and_fill_oracle(session, game_id, engine_result_map={})`, commit, and assert
  `blobs_completed_at IS NULL` afterwards AND that at least one `game_flaws` row with
  `allowed_pv_lines IS NULL` now exists (so a vacuous pass cannot green the test).
- SET direction: same game, then write a non-NULL `allowed_pv_lines` blob onto every flaw
  row, call `_refresh_blobs_completed` + commit, and assert `blobs_completed_at IS NOT NULL`.
Both tests must delete their games in a `finally` (the tier-3/tier-4 lotteries are GLOBAL
and random — a leaked non-guest analyzed game flakes other tests).
  </action>
  <verify>
    <automated>uv run pytest tests/services/test_full_eval_drain.py -x -q &amp;&amp; uv run ty check app/ tests/</automated>
    <automated>test "$(grep -vE '^\s*#' app/routers/eval_remote.py | grep -c '_refresh_blobs_completed')" -ge 4</automated>
  </verify>
  <done>
`_refresh_blobs_completed` exists in `eval_apply.py`, is called from four distinct places in
`eval_remote.py` (lease all-sentinel/backstop, lease over-cap, submit write phase, submit
idempotency gate) and once unconditionally at the end of `_classify_and_fill_oracle`. The
CLEAR-direction test fails if the `_classify_and_fill_oracle` call is removed, and the
SET-direction test fails if the probe's polarity is inverted. `ty check` is clean.
  </done>
</task>

<task type="auto">
  <name>Task 3: Rewrite `_claim_tier4_blob` to the games-only predicate and realign its tests</name>
  <files>app/services/eval_queue_service.py, tests/services/test_eval_queue.py</files>
  <action>
In `app/services/eval_queue_service.py` `_claim_tier4_blob` (line 594):

- Stage 1: replace `candidate_exists_sql` (lines 658-664) with the games-only predicate —
  `SELECT 1 FROM games g WHERE g.user_id = u.id AND g.full_evals_completed_at IS NOT NULL
  AND g.blobs_completed_at IS NULL`. The `game_flaws` JOIN goes away entirely. Guest
  exclusion is unchanged (`_es_weighted_user_pick` supplies `u.is_guest = false AND`;
  `include_guests` stays at its default False).
- Stage 2: replace the `EXISTS (SELECT 1 FROM game_flaws ...)` subquery (lines 676-683) with
  `" AND g.blobs_completed_at IS NULL"` on the same `game_where_sql`.
- Both predicates must read `full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL`
  in exactly that clause form so `ix_games_blob_backfill_pending` matches.
- Update the docstring: Stage 1's candidate description ("analyzed game that has a NULL-blob
  flaw" → the column form), and add a short paragraph recording WHY (SEED-125: the old
  `game_flaws` semi-join materialized the whole corpus and probed `games` tens of thousands
  of times per call — 84.8% of prod DB time, 340ms vs 7.5ms measured; the column makes the
  cost O(users) rather than O(backlog)) plus the pointer that the column's correctness now
  depends on `_refresh_blobs_completed` running on every blob-write and reclassification path.
- Note in the docstring that the "never re-selected once complete" property is now carried by
  the stamp rather than read live off the flaw rows, and that the lease/submit backstops
  (Task 2 sites 2 and 5) are what keep a missed stamp from becoming an infinite re-pick.

Do NOT touch `_claim_tier4_bestmove`, `_claim_tier3_derived`, or any other tier.

Tests in `tests/services/test_eval_queue.py`:

- Add a `blobs_completed_at: datetime | None = None` keyword to the module-level
  `_insert_game` helper (line 109) and pass it through to the `Game(...)` constructor,
  alongside the other completion-column kwargs.
- `TestTier4BlobBackfill::test_tier4_returns_none_empty_queue` (line 1785) and
  `::test_tier4_blobbed_game_excluded` (line 1882) currently express "blob written ⇒ not
  picked" purely through the flaw rows. Under the new predicate a written blob alone no
  longer excludes the game — the STAMP does. Realign them to the real lifecycle rather than
  hardcoding a timestamp: after writing the non-NULL `allowed_pv_lines`, call
  `_refresh_blobs_completed` (+ commit) exactly as production does, then assert the game is
  not picked. This turns both into end-to-end proofs that helper and picker agree, and they
  will fail if either side drifts.
- Add `test_tier4_stamped_game_not_picked_even_with_null_blob_flaw`: an analyzed non-guest
  game with `blobs_completed_at` set AND a NULL-blob flaw row is never returned across ~10
  draws. This pins the predicate to the column (it fails if Stage 1 or Stage 2 still consults
  `game_flaws`).
- Add `test_tier4_zero_flaw_game_is_claimable_until_stamped`: an analyzed non-guest game with
  NO flaw rows at all is now a valid candidate (it was not under the old predicate) and stops
  being one once `_refresh_blobs_completed` stamps it. This documents the intended behaviour
  change and proves the backstop's target case is reachable.
- Update `TestTier4BlobBackfill`'s class docstring bullet list to cover the new tests.
- Every test that inserts a non-guest `Game` must delete it in a `finally` — the tier-3/tier-4
  lotteries are GLOBAL and random, so a leaked analyzed game flakes unrelated queue tests.
  Follow the existing `try/finally: await _delete_games(...)` shape in this class.
  </action>
  <verify>
    <automated>uv run pytest tests/services/test_eval_queue.py tests/test_eval_queue_service.py tests/test_migration_only_indexes_exist.py -x -q</automated>
    <automated>uv run pytest tests/test_eval_worker_endpoints.py tests/services/test_full_eval_drain.py tests/test_remote_eval_worker.py -q</automated>
  </verify>
  <done>
`_claim_tier4_blob` contains no reference to `game_flaws` in either stage. All tier-4 blob
tests pass, including the two realigned ones and the two new ones. The full blob/queue test
surface (`test_eval_queue.py`, `test_eval_queue_service.py`, `test_eval_worker_endpoints.py`,
`test_remote_eval_worker.py`, `test_full_eval_drain.py`) is green. Reverting the Stage 1
predicate to the old `game_flaws` semi-join makes
`test_tier4_stamped_game_not_picked_even_with_null_blob_flaw` fail.
  </done>
  <reversibility rating="reversible">Query-shape change behind an additive column; reverting the two predicate strings restores the old behaviour with the column left harmlessly in place.</reversibility>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| remote worker → `/flaw-blob-lease` and `/flaw-blob-submit` | operator-token-authenticated but otherwise untrusted worker input crosses here |
| application → PostgreSQL | SQL composed in `eval_queue_service` from in-code fragments |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-SEED125-01 | Tampering | `_claim_tier4_blob` / `_es_weighted_user_pick` SQL composition | medium | mitigate | New predicates are fixed in-code literals with no request/user input; the only bound values (`:tau_s`, `:floor`, `:picked_user`) stay in the `sa.text` params dict — no f-string interpolation of values (QUEUE-08). |
| T-SEED125-02 | Denial of Service | tier-4 lottery infinite re-pick | high | mitigate | Task 2 sites 2 and 5 stamp on the nothing-to-do paths, so a missed stamp costs one wasted pick instead of looping forever (preserves the T-145-07 forward-progress guarantee; SEED-073 is the prior incident). |
| T-SEED125-03 | Denial of Service | backfill UPDATE during startup migration | low | accept | ~414k-row single-pass UPDATE, seconds-scale with `max_wal_size=8GB`; runs against a quiescent backend before uvicorn accepts traffic. |
| T-SEED125-04 | Information disclosure | `blobs_completed_at` in API responses | low | accept | Internal completion column; no router serializes it and no schema change exposes it. |
| T-SEED125-SC | Tampering | npm/pip/cargo installs | high | accept | No new dependencies are added by this plan — nothing to audit. |
</threat_model>

<verification>
Full pre-merge gate (CLAUDE.md), run before integrating:

```bash
uv run ruff format app/ tests/
uv run ruff check app/ tests/ --fix
uv run ty check app/ tests/
uv run pytest -n auto -x
uv run alembic upgrade head
```

Frontend is untouched, so `npm` steps are not required for this change.

Dev-DB invariant spot-check after `alembic upgrade head` (must return zero rows):

```sql
SELECT g.id FROM games g
JOIN game_flaws gf ON gf.game_id = g.id
WHERE g.blobs_completed_at IS NOT NULL AND gf.allowed_pv_lines IS NULL
LIMIT 5;
```

And a pending-backlog sanity check (must be non-zero on a dev DB that has any pending blob
work — proves the backfill did not over-stamp):

```sql
SELECT count(*) FROM games
WHERE full_evals_completed_at IS NOT NULL AND blobs_completed_at IS NULL;
```
</verification>

<success_criteria>
- `games.blobs_completed_at` and `ix_games_blob_backfill_pending` exist; migration
  upgrade/downgrade round-trips.
- The one-time backfill leaves no stamped game holding a NULL-blob flaw, and leaves the
  existing pending backlog unstamped and claimable.
- `_refresh_blobs_completed` is called from five sites: `_classify_and_fill_oracle`
  (unconditional, end of function), `/flaw-blob-lease` all-sentinel + backstop branch,
  `/flaw-blob-lease` over-cap branch, `/flaw-blob-submit` write phase, `/flaw-blob-submit`
  idempotency gate.
- Tests prove BOTH directions of the invariant, and the CLEAR-direction test fails if the
  `_classify_and_fill_oracle` call is removed.
- `_claim_tier4_blob` references no `game_flaws` table in either stage.
- `uv run ty check app/ tests/` reports zero errors; `uv run pytest -n auto` is green.
- No frontend files changed; no other queue tier modified.
</success_criteria>

<output>
Create `.planning/quick/260728-soo-implement-seed-125-blobs-completed-at-co/260728-soo-SUMMARY.md` when done.

On completion, move the seed: `git mv .planning/seeds/SEED-125-blob-pending-games-column.md .planning/seeds/closed/`
(the ID stays reserved).
</output>
