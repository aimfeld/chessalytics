# Phase 192: Precomputed Red-Herring Position Pool - Research

**Researched:** 2026-07-27
**Domain:** SQLAlchemy async schema/query design, Stockfish MultiPV engine integration, FastAPI/React answer-key disclosure discipline
**Confidence:** HIGH (every code-level claim below is `[VERIFIED: codebase]` — read directly from the files cited; no external library research was needed since this phase reuses the project's own established patterns end to end)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Pool durability & guest filter**
- **D-01:** Nullable composite FK to `games(id, user_id)`, `ondelete=SET NULL` (NOT `CASCADE`). `ply` stays a plain column.
- **D-02:** `is_guest` exclusion enforced at generation time only (join `users`, require `is_guest = false`). No serve-time check.
- **D-03:** Pool row carries FEN + arriving-move UCI, always; composition reads both straight off the row, never touches source PGN for herrings.
- **D-04:** No-repeat exclusion keys on new nullable `drill_solves.herring_pool_id`, not `(game_id, ply)`.
- **D-05:** `drill_solves.game_id` becomes nullable with `ondelete=SET NULL` (today `NOT NULL` + `CASCADE`). **Planner must verify no SR-side code path depends on `game_id` being NOT NULL** — see this document's dedicated audit section below.

**Reveal UX for cross-user herrings**
- **D-06:** `reveal_for_puzzle`'s `GamePosition` lookup widens to the game owner (not the solving user).
- **D-07:** Herring reveal omits the game info line entirely (no reworded "vs").
- **D-08:** Herring reveal keeps the in-game move (line box + board arrow); degrades to nothing when the game link is null.
- **D-09:** Analyze deep-link stays unchanged (`GET /api/library/games/{game_id}` is already not owner-scoped). **Hidden (not disabled) when the source game link is null.**
- **D-10:** A user may be served a herring from their own game — no special case, no exclusion join.

**Generator placement & rollout**
- **D-11:** Generated with local Stockfish against prod DB over `bin/prod_db_tunnel.sh` (`--db prod`), never on the prod server, never as a background tier.
- **D-12:** Reuse the existing all-ply fixed-node budget (1,000,000 nodes / 5.0s timeout), MultiPV=5. No new magic number.
- **D-13:** Deploy the source swap first, then run the generator. Empty-pool window needs no new logic (cross-backfill + honest `waiting_count` already exist). **Record the window's start/end timestamps** — later anti-tell analysis must exclude it.
- **D-14:** One-shot with manual top-up on demand. No cron, no scheduler, no depletion monitoring.

**Qualifier gate & storage**
- **D-15:** Loose gate at generation (~0.10 ES anchor, ≥2 moves within band), tight filter at query time (real ≥2-within-`INACCURACY_DROP`=0.05 ES rule, preferring 3+).
- **D-16:** MultiPV-5 ladder stored as a JSONB array of 5 `{move_uci, cp, mate}` objects, one column, raw. **No denormalized expected-score/gap columns.** Pitfall: passing Python `None` to a JSONB column writes `null::jsonb`, not SQL NULL — omit the column for a true NULL.
- **D-17:** Degenerate "every legal move is fine" positions (PV[4] also within band) are stored and excluded at QUERY time via an upper bound, not filtered at generation.
- **D-18:** Positions with fewer than 5 legal moves are **rejected at generation time** (user overrode the recommended store-and-filter option; this one is baked in, not retunable).
- **D-19:** Phase-stratified thirds only (`game_positions.phase` 0/1/2). No second stratification axis for guess difficulty.

**Carried forward from SEED-120 (settled, do not re-litigate)**
- Global pool of 3000-5000 positions across all users; privacy is a non-issue (public games).
- Identity is a real `(user_id, game_id, ply)` triple, mirroring `game_positions`' own PK.
- Selection filters: `ply >= 12`; winnability floor = `WINNABILITY_FLOOR_ES` (0.20) from the mover's POV; stored `eval_cp` (`|eval_cp| <= 200`) is a cheap pre-filter only, never the authoritative gate.
- Authoritative eval = the script's own MultiPV PV[0] on the exact board it searched (Pitfall 1: ply-indexing ambiguity between `pool_entry_stmt`/`herring_stmt`'s `ply - 1` read and `game_positions.pv`'s `flaw_ply + 1` documented convention — the generator sidesteps this entirely by re-searching its own board).
- CLI: `--n-positions N` (required), `--phase {opening,middlegame,endgame}` (optional; omitted -> split N into three equal buckets), `--db dev|benchmark|prod`.
- Run per environment — game IDs are not portable across databases. Dev has **0** `game_best_moves` rows today (herrings are locally untestable until this phase ships). Frame sizes: prod 3.3M/5.3M/2.7M, dev 57k/223k/127k candidates per phase (opening/middlegame/endgame).
- Oversample the draw; qualifying rate unknown until first run (expect lower in endgames).
- `exclude_served` contract (exclude already-served pairs, repeat-allowing fallback on exhaustion) and recency ordering carry over unchanged, as do `compose_slots` and `HERRING_SHARE`.
- Empty-pool behavior: serve no herrings, no new logic. Add a regression test pinning the fully-empty source (sibling to, not a mutation of, `test_herring_shortfall_backfills_with_sr`).
- **Mandatory spec amendments:** `POOL-03` in REQUIREMENTS.md, Phase 189 success criterion #2 in ROADMAP.md, `PROJECT.md:28`, `herring_stmt`'s docstring.

### Claude's Discretion

- Exact table/column names, index choices, and migration ordering.
- The loose-band constant's precise value (~0.10 ES anchor) and the query-time degenerate upper bound.
- Sampling implementation (reservoir vs `TABLESAMPLE` vs ordered offset) and the oversample factor.
- Resumability mechanism for the generator.

### Deferred Ideas (OUT OF SCOPE)

- Anti-tell distribution matching (compare herring `correct_guess` rate vs sharp/soft over time; exclude the D-13 empty-pool window; candidate levers: constrain to SR items' ES band, and/or a python-chess tactical-cue computation during the same scan).
- Pool-depletion monitoring (unseen-herring supply as a progress signal or Sentry breadcrumb).
- Self-replenishing pool via the live eval drain (needs MultiPV-3+ in the pipeline, changes `game_best_moves` semantics, no backfill for existing games — revisit later).
- Cross-user Library / tactic-lines readability (`has_tactic_lines` is already `False` for herrings — nothing lost today, but a future "show tactic line on a herring" idea needs an authorization change beyond this phase).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POOL-03 (amended in place) | Red herrings sourced from a precomputed, MultiPV-5-confirmed, phase-balanced global pool (replaces "non-gem `game_best_moves`" wording) — winnability-floored, recency-weighted, no repeats until exhausted, no SR bookkeeping | `herring_stmt` (`app/services/train_pool.py:362-475`) is the exact seam to replace; its current `(GameBestMove, Game)` return shape and `exclude_served` `DrillSolve.game_id == GameBestMove.game_id` NOT EXISTS subquery (line 461-470) both change. Generator conventions from `scripts/backfill_flaws.py` / `scripts/validate_multipv_budget.py`. Engine plumbing in `app/services/engine.py` (see Code Examples). |
</phase_requirements>

## Summary

Phase 192 replaces a structurally-broken data source (`game_best_moves`, whose population gate at `app/services/eval_apply.py` only ever emits a row where the runner-up is *already* an inaccuracy — the opposite of "several fine moves") with a new precomputed, globally-shared `herring_pool` table. The swap touches exactly one query seam (`herring_stmt`), one composition consumer (`compose_and_materialize_session`'s herring branch), one reveal path (`reveal_for_puzzle`), two frontend components (`TrainReveal.tsx`, `TrainSolveScreen.tsx`), and two schema changes (`drill_solves.herring_pool_id` additive, `drill_solves.game_id` nullability — the second is genuinely risky and load-bearing across three separate query sites this document enumerates below).

The single biggest execution risk is NOT the new pool table or the generator script — those are close copies of well-established patterns (`GameBestMove`'s continuous-storage model, `scripts/backfill_flaws.py`'s `--db` CLI, `app/services/engine.py`'s `evaluate_nodes_multipv2` pattern). The biggest risk is that **three existing queries join `Game` with an INNER JOIN keyed on `DrillSolve.game_id`**, and once that column can be NULL (D-05), all three silently misbehave in ways that directly contradict this phase's own success criteria:

1. `load_session_puzzles` (`train_repository.py:790-800`) — a null-game_id herring row vanishes from a resumed session's puzzle list.
2. `_mark_session_complete_if_done` (`train_repository.py:1416-1437`) — a null-game_id, unsolved herring row is silently excluded from the "remaining" count, prematurely marking the session complete.
3. `reveal_for_puzzle` (`train_repository.py:1672-1685`) — a null-game_id herring's reveal query returns **zero rows**, mapping to `"not_found"` instead of the actual thin answer key. This is the exact failure Success Criterion 3 ("deleting a source game leaves the herring puzzle intact and servable") forbids.

All three need to change from `.join(Game, ...)` to `.outerjoin(Game, ...)`, and every downstream FEN/PGN-dependent branch inside them needs a fallback that reads FEN/arriving-move data off the pool row (via the new `herring_pool_id`) instead of `game.pgn` — which D-03 already mandates as the *general* rule for herrings, not just the null-link case.

**Primary recommendation:** Build the pool table + generator as a close structural copy of `GameBestMove`/`scripts/backfill_flaws.py`, but treat `drill_solves.game_id` nullability as the phase's actual hard problem: audit and fix all three INNER JOIN sites before writing a single line of new pool logic, and add the missing `evaluate_nodes_multipv5` (or generic `evaluate_nodes_multipv(n)`) method to `app/services/engine.py` rather than reusing `evaluate_nodes_multipv2`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Herring pool generation (offline MultiPV-5 scan) | Script (`scripts/gen_red_herring_pool.py`) | Database (Postgres UPSERT target) | Batch job, not request-serving code; mirrors `scripts/backfill_flaws.py` — a standalone async script with its own engine + DB session, never imported by the FastAPI app |
| Herring pool storage | Database / Repository | — | New table, position-scoped (no `user_id` in the PK, mirroring `GameBestMove`); read via `app/services/train_pool.py`'s query builders |
| Session composition (herring branch) | Backend Service/Repository | — | `herring_stmt` (service) + `compose_and_materialize_session` (repository) — same seam as today, source swapped |
| Session lifecycle (resume/complete/reveal) | Backend Repository | — | `train_repository.py` — three query sites need the NULL-game_id fix (see Common Pitfalls) |
| Reveal panel rendering | Frontend Component | Backend Schema | `TrainReveal.tsx`/`TrainSolveScreen.tsx` render; `PuzzleRevealResponse`/`TrainPuzzle` schemas carry the (now-nullable) `game_id` |
| Analyze deep-link authorization | Backend Router (existing, unchanged) | — | `GET /api/library/games/{game_id}` already cross-user (`app/routers/library.py:137`) — no new authorization code needed |

## Standard Stack

No new external packages. This phase is a pure reuse of already-pinned dependencies:

| Library | Version (verified in repo) | Purpose | Why Standard |
|---------|------|---------|--------------|
| `python-chess` | 1.11.x (per CLAUDE.md) | MultiPV UCI protocol, board replay for FEN reconstruction | Already the project's sole chess engine/board library |
| SQLAlchemy 2.x async | per CLAUDE.md | New `herring_pool` model, composite FK, JSONB column, LATERAL join reuse | Already the project's sole ORM/query layer |
| Alembic | per CLAUDE.md | New pool table migration + `drill_solves` additive/nullability migrations | Already the project's sole migration tool |
| Stockfish (vendored binary) | resolved via `app/services/engine.py::_resolve_stockfish_path` | MultiPV-5 authoritative search | Already the project's sole engine; dev copy confirmed present at `~/.local/stockfish/sf` |

**Installation:** none — no `uv add`/`pip install` needed. `[VERIFIED: codebase]` — every dependency above is already declared in `pyproject.toml`/used elsewhere in `app/`.

### Alternatives Considered

None — SEED-120 and the discuss-phase session already settled the stack (reuse the existing engine pool, existing sigmoid, existing `--db` CLI convention). No new library decision exists in this phase.

## Package Legitimacy Audit

Not applicable — this phase installs zero new external packages. The Package Legitimacy Gate protocol does not apply.

## Architecture Patterns

### System Architecture Diagram

```
                     OFFLINE (once, D-13/D-14)
┌──────────────────────────────────────────────────────────────────┐
│  scripts/gen_red_herring_pool.py  --db {dev|benchmark|prod}       │
│                                                                    │
│  1. Sample frame: game_positions JOIN games JOIN users            │
│     WHERE users.is_guest = false                                  │
│       AND game_positions.phase = {0,1,2}  (stratified thirds)      │
│       AND ply >= 12                                                │
│       AND |eval_cp| <= 200          (cheap PRE-filter, D-carried)  │
│     -> oversampled candidate positions per phase bucket            │
│              │                                                     │
│              ▼                                                     │
│  2. Per-candidate: reconstruct board, reject if < 5 legal moves    │
│     (D-18, generation-time hard reject)                            │
│              │                                                     │
│              ▼                                                     │
│  3. EnginePool.evaluate_nodes_multipv5(board)  [NEW METHOD]        │
│     -- 1,000,000 nodes / 5.0s timeout, MultiPV=5 (D-12: reuse      │
│        the existing all-ply node budget, no new magic number)      │
│              │                                                     │
│              ▼                                                     │
│  4. Loose gate (D-15): >= 2 of the 5 PV lines within ~0.10 ES       │
│     of PV[0] (own MultiPV eval, own board -- Pitfall 1 sidestep)   │
│              │  reject                                            │
│              ▼  accept                                            │
│  5. UPSERT herring_pool row: (user_id, game_id, ply) identity +    │
│     fen, arriving_move_uci (D-03, via fen_and_last_move_at_ply),   │
│     phase, JSONB ladder of 5 {move_uci, cp, mate} (D-16)           │
└──────────────────────────────────────────────────────────────────┘
              │
              │ (idempotent UPSERT -- resumable re-runs top up, D-14)
              ▼
┌──────────────────────────────────────────────────────────────────┐
│                     ONLINE (every session compose)                │
│                                                                     │
│  compose_and_materialize_session (train_repository.py)             │
│     │                                                               │
│     ├─ SR side: pool_entry_stmt / due drill_items  (UNCHANGED)     │
│     │                                                               │
│     └─ Herring side: herring_stmt(user_id) -- NEW SOURCE            │
│           │  SELECT herring_pool                                   │
│           │  WHERE query-time tight gate (D-15/D-17):              │
│           │    >= 2-within-INACCURACY_DROP (0.05 ES), prefer 3+,   │
│           │    AND degenerate-exclusion upper bound (PV[4] gate)   │
│           │  AND NOT EXISTS (drill_solves.herring_pool_id = ...)   │
│           │       (D-04 no-repeat key, exclude_served contract)    │
│           │                                                        │
│           ▼                                                        │
│     ComposedPuzzle.fen / .last_move_uci read DIRECTLY off the      │
│     herring_pool row (D-03) -- no game.pgn replay for herrings     │
│                                                                     │
│  ──────────────────────────────────────────────────────────────   │
│                                                                     │
│  reveal_for_puzzle (post-attempt)                                  │
│     │  LEFT OUTER JOIN Game (was INNER -- must change, see          │
│     │  Common Pitfalls) ON drill_solves.game_id                    │
│     │  GamePosition lookup widened to the GAME OWNER (D-06),        │
│     │  not the solving user                                        │
│     ▼                                                               │
│  PuzzleRevealResponse: game_id now nullable; omit game info line    │
│  entirely for herrings (D-07); keep in-game move (D-08); frontend   │
│  hides Analyze when game_id is null (D-09)                          │
└──────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

No new directories. New files follow existing conventions exactly:

```
app/models/herring_pool.py          # new ORM model (mirrors game_best_move.py's shape)
app/services/train_pool.py          # herring_stmt rewritten in place (existing file)
app/repositories/train_repository.py # compose/resume/reveal fixes (existing file)
alembic/versions/<ts>_phase_192_herring_pool_table.py
alembic/versions/<ts>_phase_192_drill_solves_herring_pool_id.py
alembic/versions/<ts>_phase_192_drill_solves_game_id_nullable.py
scripts/gen_red_herring_pool.py      # new generator script (mirrors backfill_flaws.py)
frontend/src/components/train/TrainReveal.tsx      # D-07 game-footer gate (existing file)
frontend/src/components/train/TrainSolveScreen.tsx # D-09 Analyze-hide gate (existing file)
frontend/src/types/train.ts          # game_id: number -> number | null (existing file)
app/schemas/train.py                 # game_id: int -> int | None (existing file)
```

### Pattern 1: Position-scoped candidate table (no `user_id` in the PK)

**What:** `GameBestMove` deliberately has no `user_id` column — "candidacy is a property of the *position*, not the user" (its model docstring). The new `herring_pool` table should follow the same shape: PK on its own identity (the seed specifies `(user_id, game_id, ply)` as "a real triple, mirroring `game_positions`' own PK" — but note this is the *source position's* identity for uniqueness/dedup purposes at generation time, not an access-control column; nothing in `herring_stmt` should ever filter `herring_pool.user_id == solving_user_id`, since D-10 explicitly allows serving a user their own game's herring).

**When to use:** Any table whose rows are "this position is interesting" facts, independent of who is being served the position.

**Example:**
```python
# Source: app/models/game_best_move.py (existing pattern to mirror)
class GameBestMove(Base):
    __tablename__ = "game_best_moves"
    game_id: Mapped[int] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), nullable=False, primary_key=True
    )
    ply: Mapped[int] = mapped_column(SmallInteger, nullable=False, primary_key=True)
    # ... continuous-only storage, no pre-converted expected-score column
```

### Pattern 2: LATERAL join for correlated per-ply eval lookups

**What:** `_prior_position_lateral` (`app/services/train_pool.py:262-311`) exists because a plain `outerjoin` self-alias of `GamePosition` correlated on `(user_id, game_id, ply [- N])` defeats Postgres's ability to use the `game_positions_pkey` composite index — confirmed via `EXPLAIN (ANALYZE, BUFFERS)` on the dev DB (108M rows filtered, ~21-27s, vs ~140ms as a LATERAL). Any new query correlating against `game_positions` (or the new pool table, if a serve-time correlated lookup is ever needed) MUST use this same LATERAL pattern.

**When to use:** Any correlated subquery joining on a composite-PK table inside a larger `SELECT`.

**Note for this phase:** Because D-16 stores the authoritative MultiPV-5 ladder directly on the pool row (own PV[0], not `game_positions.eval_cp`), the new `herring_stmt` likely needs LESS of this pattern than the old one — the winnability/gap computation reads the pool row's own JSONB column, not a correlated `game_positions` lookup. Confirm at plan time whether any correlation is still needed (e.g. if `is_guest` re-verification or phase cross-check requires touching `game_positions`/`games` again).

### Pattern 3: Deferred JSONB column + explicit `undefer()`

**What:** `GameFlaw.missed_pv_lines`/`allowed_pv_lines` are `deferred=True` (structural leak guard) and require `.options(undefer(GameFlaw.missed_pv_lines))` wherever read, else `MissingGreenlet`. The new pool table's 5-element ladder column should very likely follow the same `deferred=True` discipline, since it is exactly the kind of "answer key" data (`{move_uci, cp, mate}` for the top 5 moves) that must never leak into a pre-attempt payload — mirroring POOL-10's existing leak-prevention posture for `missed_pv_lines`.

**Example:**
```python
# Source: app/services/train_pool.py:324 (pool_entry_stmt)
.options(undefer(GameFlaw.missed_pv_lines))
```

### Anti-Patterns to Avoid

- **INNER JOIN on a nullable FK column that feeds a completion/resume/reveal count.** All three sites enumerated in Common Pitfalls below currently do exactly this against `Game`. Do not "fix" only the reveal path and leave resume/completion silently broken — a green reveal test can pass while a resumed session or the completion counter still misbehaves.
- **Storing a pre-converted expected-score or gap column on the pool row.** D-16 explicitly forbids this (mirrors `GameBestMove`'s D-05 continuous-storage rule) — it would freeze the `LICHESS_K` sigmoid conversion at generation time, making the D-15 query-time gate un-retunable, which defeats the entire point of the loose-gen/tight-query split.
- **Filtering `herring_pool` by the solving user's `user_id`.** D-10 explicitly forbids an exclusion join for "own-game" herrings — don't add one "for safety."
- **Passing Python `None` for the JSONB ladder column.** Writes `null::jsonb`, not SQL NULL (`project_asyncpg_jsonb_null_vs_sql_null`) — omit the column entirely if a row must not carry a ladder yet.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| cp -> expected-score conversion | A new sigmoid for the pool's query-time gate | `expected_score_sql` / `eval_cp_to_expected_score` (`app/services/train_pool.py`, `app/services/eval_utils.py`) | Single `LICHESS_K` sigmoid shared across the whole codebase (Train, gem/great, benchmarks) — a second implementation risks silent disagreement at a threshold boundary |
| Multi-PV Stockfish invocation | A hand-rolled subprocess/UCI wrapper in the generator script | `EnginePool` from `app/services/engine.py` (add `evaluate_nodes_multipv5`, following `evaluate_nodes_multipv2`'s exact shape at lines 584-620) | `EnginePool` already handles SCHED_IDLE spawning, crash-vs-timeout distinction (260725-da3), hash/threads config, and the single-legal-move `len(info_list) == 1` edge case |
| Ply-parity / mover-color derivation | `ply % 2` inline | `mover_color_for_ply` (`app/services/best_move_candidates.py:65-68`) and `player_only_gate` (`app/repositories/query_utils.py:74-91`) | `query_utils.py` documents a prior off-by-one bug in exactly this area; every existing Train query uses these helpers |
| FEN + arriving-move reconstruction | A new PGN-replay routine for the generator | `fen_and_last_move_at_ply` (`app/services/train_pool.py:545-589`) | Already handles the try/except PGN-parsing contract (CLAUDE.md), already returns exactly the `(fen, last_move_uci)` tuple D-03 wants stored on the pool row |
| `--db dev\|benchmark\|prod` resolution | A new env-var reader in the generator script | `db_url_for_target` (`app/core/config.py:142-158`) | Single source of DB-target resolution used by every existing `scripts/*.py` |

**Key insight:** Every "new" piece of this phase (engine call, sigmoid, PGN replay, DB target resolution, ply-parity) already has an established single implementation in this codebase. The only genuinely new code is the pool table itself, the generator's sampling/gating loop, and the three nullable-FK query fixes.

## Runtime State Inventory

This phase is not a rename/refactor, but it does touch **live user data** via a nullability change on `drill_solves.game_id` (D-05) and introduces a new FK policy (D-01) that differs from the codebase's dominant `CASCADE` convention. The canonical question applies: *after the migration lands, what runtime state still assumes the old NOT-NULL/CASCADE contract?*

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Existing `drill_solves` rows: `game_id` is currently `NOT NULL` for every row (both SR and herring sources alike, since today's `herring_stmt` sources from a user-scoped `game_best_moves` join). No existing row needs backfilling — the nullability change is additive-safe (no existing NULL values will ever be introduced retroactively; only NEW herring rows from the pool source can carry NULL). | Migration only: `ALTER COLUMN game_id DROP NOT NULL` + change the FK's `ondelete` from `CASCADE` to `SET NULL`. No data migration/backfill needed. |
| Live service config | None — no external service (n8n, Datadog, etc.) references `drill_solves.game_id`. | None. |
| OS-registered state | None. | None. |
| Secrets/env vars | None — no env var references this column. | None. |
| Build artifacts / installed packages | None. | None. |
| **Code paths assuming `game_id` NOT NULL** | **Three query sites use an INNER JOIN keyed on `DrillSolve.game_id` — see the dedicated audit table below.** This is the actual load-bearing risk of D-05, more so than the data itself. | Code edit: change `.join(Game, ...)` to `.outerjoin(Game, ...)` at all three sites, plus downstream null-handling for the FEN/PGN-dependent logic in each. |

### `drill_solves.game_id` NOT-NULL Assumption Audit (D-05 verification, by file:line)

Every read site of `DrillSolve.game_id` / `solve.game_id` / `solve_row.game_id` in `app/`, enumerated and classified:

| File:Line | Site | NOT-NULL assumption? | Fix needed |
|-----------|------|----------------------|------------|
| `app/services/train_pool.py:465` (`herring_stmt`'s `exclude_served` NOT EXISTS subquery) | `DrillSolve.game_id == GameBestMove.game_id` | N/A — this whole subquery is REPLACED by the D-04 `herring_pool_id`-keyed exclusion; not a nullability bug, a full rewrite | Rewrite as `DrillSolve.herring_pool_id == <pool_row_pk>` |
| `app/repositories/train_repository.py:792` (`load_session_puzzles`) | `.join(Game, Game.id == DrillSolve.game_id)` — **INNER JOIN** | **YES — silently drops any row with `game_id IS NULL` from the resumed puzzle list** | Change to `.outerjoin`; when `Game` is None AND `source == RED_HERRING`, read FEN/last-move from the pool row (via `herring_pool_id`) instead of `fen_and_last_move_at_ply(game.pgn, ...)` |
| `app/repositories/train_repository.py:804,818,828` (same function, downstream of the join) | `sr_game_ids = {solve.game_id for ... if solve.source == SR_ITEM}`; `(solve.game_id, solve.ply) not in existing_flaw_keys` (guarded by `source == SR_ITEM`); `game_id=solve.game_id` in `ComposedPuzzle` | Safe for the eviction-key checks (guarded by `source == SR_ITEM` first) — but `ComposedPuzzle.game_id` itself must become `int \| None`, and the `fen`/`last_move_uci` construction two lines above needs the D-03 pool-row fallback | Widen `ComposedPuzzle.game_id: int \| None`; branch FEN reconstruction on `source` |
| `app/repositories/train_repository.py:1026,1360,1380,1424` (`DrillItem.game_id`, not `DrillSolve.game_id`) | Unrelated table — `DrillItem.game_id` stays `NOT NULL` (SR items are always sourced from the user's own live/lazily-evicted game) | No — `DrillItem` is untouched by this phase | None |
| `app/repositories/train_repository.py:1298,1556,1592` (`_classify_solve_puzzle_type`, `_advance_drill_item`, `_read_drill_item_state`, all inside `record_solve`) | `GameFlaw.game_id == solve.game_id` / `game_id=solve_row.game_id` passed to per-SR-item helpers | Safe — every one of these three is reached only when `solve.source == SR_ITEM` (guarded earlier in `record_solve` / `_classify_solve_puzzle_type` returns `"herring"` before reaching the flaw lookup) | None |
| `app/repositories/train_repository.py:1419-1436` (`_mark_session_complete_if_done`) | `.join(Game, Game.id == DrillSolve.game_id)` — **INNER JOIN**, feeding a `remaining` count that gates session completion | **YES — an unsolved (`solved_at IS NULL`) null-game_id herring row is silently excluded from `remaining`, so the session can be marked `completed` while that puzzle is still outstanding** (the user would never see it, and the session's `puzzle_count` denominator would be wrong) | Change to `.outerjoin`; the existing `or_(DrillSolve.source != SR_ITEM, GameFlaw.game_id.isnot(None))` clause already treats herrings leniently for the `GameFlaw` join — verify the `Game` outer-join doesn't need a parallel `or_` since a NULL `Game.id` from an outer join naturally satisfies "still counts as remaining if unsolved" once the join type is fixed |
| `app/repositories/train_repository.py:1672-1745` (`reveal_for_puzzle`) | `.join(Game, Game.id == DrillSolve.game_id)` — **INNER JOIN** | **YES — the single most severe instance: a null-game_id herring's reveal query returns zero rows, so `reveal_for_puzzle` returns `"not_found"` (the frontend router maps this to 404) instead of the actual answer key.** Directly contradicts Success Criterion 3. | Change to `.outerjoin`; `full_fen_at_ply(game.pgn, solve.ply)` at line 1702 must fall back to the pool row's stored FEN when `game is None`; `played_in_game_san`/`played_in_game_move_uci` naturally degrade to `None` per D-08 when there is no game to look up (already the existing `.one_or_none()` pattern for `position_row`); `RevealedPuzzle.game_id: int` must become `int \| None` |

**Nothing found in "OS-registered state" / "Secrets" / "Build artifacts" categories** — verified by grep across `app/`, `bin/`, `.env*` references; `drill_solves.game_id` is purely an internal FK with no external system dependency.

## Common Pitfalls

### Pitfall 1: Three INNER JOINs silently misbehave once `game_id` can be NULL

**What goes wrong:** See the full audit table above — resume, completion-counting, and reveal all currently INNER JOIN `Game` on `DrillSolve.game_id`.
**Why it happens:** These three queries were written when `herring_stmt` sourced from a user-scoped `game_best_moves` join, where `Game.id == GameBestMove.game_id` was always guaranteed non-null by construction (every `GameBestMove` row implies a live, owned game at query time). D-05 breaks that invariant.
**How to avoid:** Fix all three sites in the same plan/task, not incrementally — a partial fix (e.g. reveal only) leaves the resume path silently dropping puzzles from a session, which is much harder to notice in manual UAT than a broken reveal.
**Warning signs:** A UAT session where deleting a herring's source game mid-session makes the puzzle count in "X of N" silently shrink, or where session completion fires one puzzle early.

### Pitfall 2: MultiPV=5 needs a new engine method — `evaluate_nodes_multipv2` cannot be reused as-is

**What goes wrong:** `app/services/engine.py` currently only exposes `multipv=2` via `evaluate_nodes_multipv2` (both at the module level and on `EnginePool`). There is no generic `multipv=N` public method — `_acquire_and_analyse` (the shared private implementation) already accepts an arbitrary `multipv: int | None` parameter, but no public wrapper exposes `multipv=5`.
**Why it happens:** Every existing MultiPV caller (gem/great candidate detection, forcing-line-gate blob building) only ever needed the top-2 lines.
**How to avoid:** Add a new public method (e.g. `evaluate_nodes_multipv5` on both the module level and `EnginePool`, mirroring `evaluate_nodes_multipv2`'s exact structure at `app/services/engine.py:584-620`), or a generic `evaluate_nodes_multipv(board, n)`. Reuse `_NODES_BUDGET` (1,000,000) and `_NODES_TIMEOUT_S` (5.0) per D-12 — do not introduce a new budget constant.
**Warning signs:** A generator script directly instantiating `EnginePool` and calling the private `_acquire_and_analyse(board, limit, timeout, multipv=5)` — this works (it's how the four existing public methods are implemented) but bypasses the module's own encapsulation convention; prefer adding the public method.

### Pitfall 3: `evaluate_nodes_multipv2`'s single-legal-move guard must generalize to MultiPV=5

**What goes wrong:** `evaluate_nodes_multipv2` explicitly guards `len(info_list) > 1` because Stockfish returns fewer InfoDicts than requested when there aren't enough legal moves (`app/services/engine.py:613-619`). A naive `info_list[4]` index for the MultiPV-5 ladder will raise `IndexError` on any position with fewer than 5 legal moves that slips past the D-18 legal-move-count pre-filter (e.g. if the pre-filter uses `board.legal_moves` count *before* the search but a transient board-state mismatch occurs), or more realistically, simply needs defensive handling regardless.
**Why it happens:** D-18 already requires rejecting <5-legal-move positions at generation time — but the rejection check must run BEFORE or independently of the search, using `board.legal_moves` count via python-chess (cheap, no engine call), not by inspecting the MultiPV result length after the fact.
**How to avoid:** Check `len(list(board.legal_moves)) >= 5` prior to invoking the engine at all (cheapest possible reject), and still defensively handle `len(info_list) < 5` in the parsing code in case Stockfish's own move generation ever disagrees at the margin (transposition/repetition edge cases).
**Warning signs:** `IndexError` or a truncated ladder (fewer than 5 entries) reaching the UPSERT — decide explicitly per D-18 whether a truncated-but-nonzero ladder should ever be stored (the locked decision says reject entirely at generation, not store-and-filter).

### Pitfall 4: The `game_positions` phase/ply-indexing subtlety does NOT need to be solved this time

**What goes wrong (avoided, not hit):** `herring_stmt`'s docstring and `pool_entry_stmt`'s docstring both wrestle at length with whether an eval belongs to `ply` or `ply - 1` (the post-move-shift convention, Pitfall 2 in the existing `train_pool.py` docstring). The generator does NOT need to reconcile this: it re-searches its OWN board (built via `fen_and_last_move_at_ply`/board replay) and uses its OWN MultiPV PV[0] as the authoritative eval — no correlated `game_positions.eval_cp` read is ever authoritative, only a pre-filter.
**Why it matters to flag:** A planner unfamiliar with the existing ply-indexing pitfalls might over-engineer a `game_positions`-correlated LATERAL join into the generator to "get the eval right," when the entire point of D-12/the seed's "own MultiPV, own board" design is to sidestep that ambiguity completely. The stored `eval_cp` pre-filter can be off-by-one-ply and it costs nothing but a slightly noisier candidate frame (explicitly accepted per the seed).
**How to avoid:** Keep the pre-filter query simple (a plain, uncorrelated `WHERE |eval_cp| <= 200` on the sampled row itself, no self-join), and let the MultiPV-5 search on the reconstructed board be the sole source of truth for what gets stored.

### Pitfall 5: `answer_key_present`-style total-operator JSONB predicates — the new ladder's presence check

**What goes wrong:** If the query-time gate needs a "does this row have a usable ladder" check (analogous to `answer_key_present`), a naive `col.isnot(None)` admits Postgres's `null::jsonb` scalar (the asyncpg None-binding gotcha) as well as an accidentally-empty array — and Postgres does NOT guarantee AND-clause evaluation order, so pairing a `jsonb_typeof` guard with an array-length function in the same WHERE clause can raise `cannot get array length of a scalar` at the wrong evaluation order (documented in `answer_key_present`'s docstring, `app/services/train_pool.py:191-230`).
**Why it happens:** This is a live, previously-hit crash in this exact codebase (189-06 gap closure), not a theoretical concern.
**How to avoid:** If the pool table's ladder column ever needs an existence check beyond simple `IS NOT NULL` (unlikely, since D-18's generation-time reject means every stored row has a complete 5-element ladder by construction — there is no analogous "pending" state the way `missed_pv_lines` has), do NOT re-derive a custom count-based predicate; reuse `answer_key_present`'s pattern (`jsonb_typeof(col) == "array"` combined via `and_()`, never nested inside a count function).

### Pitfall 6: Sampling frame size vs. dev's zero-`game_best_moves` reality

**What goes wrong:** Because dev currently has 0 `game_best_moves` rows, herrings have never been locally testable. The generator's dev candidate frame (57k/223k/127k `game_positions` per phase, per the seed's carried-forward numbers) is real but has never been exercised by this exact query shape.
**Why it happens:** Nobody has run a `phase`-stratified, `is_guest=false`-joined, `ply>=12`, `|eval_cp|<=200`-filtered scan against dev before.
**How to avoid:** Run the generator against dev FIRST (before prod, regardless of D-11's prod-focused framing) to validate the query executes and to get the D-15/D-17 measured qualifying-rate distribution the phase explicitly defers pinning the exact constants on ("pick them from the first run's measured qualifying-rate distribution rather than guessing at plan time").

## Code Examples

### Adding a MultiPV=5 method to `EnginePool` (mirrors `evaluate_nodes_multipv2` exactly)

```python
# Source: app/services/engine.py:584-620 (evaluate_nodes_multipv2), the pattern to mirror
# for a new evaluate_nodes_multipv5 (or a generic evaluate_nodes_multipv(n)) method.
async def evaluate_nodes_multipv5(
    self,
    board: chess.Board,
) -> list[chess.engine.InfoDict] | None:
    """Evaluate at 1M nodes with multipv=5 (Phase 192 D-12: reuse the existing
    all-ply node budget and timeout -- no new magic number).

    Returns the raw list[InfoDict] (up to 5 entries; fewer when the position
    has fewer legal moves -- see the D-18 generation-time legal-move-count
    reject, which should run BEFORE this call, not after). Returns None on
    engine failure (D-09 semantics, matching every other EnginePool method).
    """
    result = await self._acquire_and_analyse(
        board, chess.engine.Limit(nodes=_NODES_BUDGET), _NODES_TIMEOUT_S, multipv=5
    )
    if result is None or not isinstance(result, list):
        return None
    return result
```

### `--db dev|benchmark|prod` generator skeleton (mirrors `scripts/backfill_flaws.py`)

```python
# Source: scripts/backfill_flaws.py:1-80 (structure to mirror)
from app.core.config import db_url_for_target, settings
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Populate the red-herring position pool")
    parser.add_argument("--db", choices=["dev", "benchmark", "prod"], required=True)
    parser.add_argument("--n-positions", type=int, required=True)
    parser.add_argument("--phase", choices=["opening", "middlegame", "endgame"], default=None)
    return parser.parse_args()

# DB target host:port mapping (CLAUDE.md):
#   dev:       localhost:5432  (Docker compose flawchess-dev)
#   benchmark: localhost:5433  (Docker compose flawchess-benchmark)
#   prod:      localhost:15432 (via bin/prod_db_tunnel.sh)
```

### D-03: reading FEN + arriving move directly off the pool row (no PGN replay for herrings)

```python
# Source: app/services/train_pool.py:545-589 (fen_and_last_move_at_ply) -- the
# generator calls this ONCE at scan time to populate the pool row's fen/
# arriving_move_uci columns. Composition/resume/reveal then read those two
# columns directly (D-03) instead of re-calling this function per herring.
fen, last_move_uci = fen_and_last_move_at_ply(game.pgn, ply)
# -> stored on herring_pool.fen / herring_pool.arriving_move_uci at generation time
```

### JSONB `None` pitfall (D-16)

```python
# WRONG -- writes null::jsonb, not SQL NULL (project_asyncpg_jsonb_null_vs_sql_null)
HerringPool(ladder=None, ...)

# RIGHT -- omit the column entirely if a row has no ladder yet (in practice,
# D-18's generation-time reject means this should never happen for a stored
# row -- every row that reaches UPSERT already has a complete 5-element ladder)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Red herrings sourced from `game_best_moves` (user-scoped, gated by `INACCURACY_DROP` at population time, so best-vs-second is NEVER close) | Red herrings sourced from a precomputed global `herring_pool` (MultiPV-5 confirmed, phase-stratified, gate loose-at-gen/tight-at-query) | Phase 192 (this phase) | Fixes a correctness defect present in every red herring Train has ever served since Phase 189 shipped (measured: 0 of 3,286,059 prod `game_best_moves` rows have a best-vs-second ES gap < 0.05) |
| `drill_solves.game_id` NOT NULL + CASCADE | Nullable + SET NULL | Phase 192 (this phase) | First nullable FK in the Train schema; three existing INNER JOIN sites must be fixed in the same phase (see Common Pitfalls) |
| `herring_stmt` returns `(GameBestMove, Game)` | Returns pool-row shape (exact type TBD at plan time — likely `HerringPool` alone, since D-03 means the row itself carries everything composition needs, with no `Game` join required for the happy path) | Phase 192 (this phase) | `compose_and_materialize_session`'s herring-branch unpacking (`train_repository.py:1096-1099,1133-1140`) must change accordingly |

**Deprecated/outdated:** `game_best_moves` as a herring source is fully retired by this phase — the phase's own success criteria require "the herring source no longer reads `game_best_moves` anywhere." `GameBestMove` itself is NOT deleted (it remains the gem/great detection table, unrelated to Train).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The new pool query needs LESS `LATERAL`-correlated `game_positions` reading than the old `herring_stmt`, since the authoritative eval now lives directly on the pool row (D-16) | Architecture Patterns, Pattern 2 | Low — if a serve-time correlation IS still needed (e.g. re-verifying `is_guest` hasn't flipped, though D-02 says users never revert to guest so this shouldn't matter), the LATERAL pattern is documented and ready to reuse; worst case is an unnecessary simplification assumption that the planner corrects |
| A2 | `_mark_session_complete_if_done`'s existing `or_(DrillSolve.source != SR_ITEM, GameFlaw.game_id.isnot(None))` clause needs no PARALLEL clause for the `Game` outer join once fixed — a NULL `Game.id` from an outer join should naturally continue to count as "remaining" if unsolved | Runtime State Inventory / D-05 Audit | Medium — if wrong, the planner needs to add an explicit `or_(DrillSolve.source != SR_ITEM_or_whatever, ...)` guard around the `Game` join too; verify with a direct unit test (delete the source game mid-session, confirm the puzzle still counts as remaining) rather than trusting this assumption |
| A3 | The `herring_pool` identity triple `(user_id, game_id, ply)` from SEED-120 (carried forward, not re-litigated in CONTEXT.md) is a UNIQUENESS/dedup key at generation time only, not a serve-time access-control column — i.e., nothing in `herring_stmt` should filter on `herring_pool.user_id` | Architecture Patterns, Pattern 1 | Low — this is directly supported by D-10 ("no special case" for own-game herrings) and by `GameBestMove`'s explicit "position-scoped, not user-scoped" precedent; low risk of misreading |
| A4 | `EnginePool.evaluate_nodes_multipv5` should be added as a NEW public method (mirroring `evaluate_nodes_multipv2`) rather than the generator calling `EnginePool`'s private `_acquire_and_analyse` directly | Common Pitfalls, Pitfall 2 | Low — both work functionally; the public-method approach is a style/discretion call, not a correctness one |

**If this table is empty:** N/A — see entries above. All four assumptions are LOW-to-MEDIUM risk architectural-shape calls, not factual claims about external libraries; no user-facing decision needs re-confirmation (CONTEXT.md's decisions D-01 through D-19 already lock every user-facing choice).

## Open Questions

1. **Exact return shape of the rewritten `herring_stmt`**
   - What we know: it currently returns `Select[tuple[GameBestMove, Game]]`; D-03 means the new pool row alone (FEN + arriving move) is sufficient for composition, so a `Game` join may not be needed at all in the happy path.
   - What's unclear: whether `compose_and_materialize_session`'s herring branch still wants a `Game` object at all (e.g. for anything beyond FEN/move), or whether the pool row's own `game_id`/`ply` columns are enough to populate `ComposedPuzzle`.
   - Recommendation: at plan time, trace exactly which fields `compose_and_materialize_session`'s herring branch (`train_repository.py:1088-1099, 1133-1140`) currently reads from the `Game` object it joins — if it's ONLY `game.pgn` (for the now-obsolete PGN replay), the new `herring_stmt` likely needs no `Game` join at all for composition, only for `ComposedPuzzle.game_id` (which is just the pool row's stored `game_id` column, not a join).

2. **Whether `DrillItem`-side code needs any change**
   - What we know: `DrillItem` is SR-only (own blunders), its `game_id` FK stays `NOT NULL`/`CASCADE` per D-05's scope (only `drill_solves` changes).
   - What's unclear: nothing significant — confirmed by grep that every `DrillItem.game_id` reference in `train_repository.py` (lines 1026, 1360, 1380) is unrelated to the herring/pool changes.
   - Recommendation: no action needed; flagged here only to close the loop explicitly for the planner.

3. **Exact loose-band (D-15) and degenerate-upper-bound (D-17) constant values**
   - What we know: ~0.10 ES is the anchor for the loose band; both are Claude's Discretion but explicitly "retunable downward with zero re-analysis" and must be "pick[ed]... from the first run's measured qualifying-rate distribution."
   - What's unclear: the actual measured distribution — cannot be known until the generator runs once against dev or prod.
   - Recommendation: the plan should include a task to run the generator against dev FIRST with a wide loose band, inspect the resulting qualifying-rate histogram, THEN pin the query-time tight-gate constants — not guess both constants up front and never revisit them.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Local Stockfish binary | Generator script (D-11: local engine, never prod-server) | ✓ | resolved via `~/.local/stockfish/sf` (confirmed present, executable) | — |
| Dev PostgreSQL (Docker) | Local generator runs, dev testing (Pitfall 6) | ✓ | `flawchess-dev-db-1` container confirmed `Up`/`healthy` | — |
| `bin/prod_db_tunnel.sh` | Generator against prod (D-11) | ✓ | script present at `bin/prod_db_tunnel.sh` | — |
| python-chess / SQLAlchemy / Alembic | All new code | ✓ | already pinned per `pyproject.toml` (CLAUDE.md) | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | pytest + pytest-asyncio (backend); Vitest (frontend) |
| Config file | `pyproject.toml` / `pytest.ini`-equivalent (existing, no new config needed) |
| Quick run command | `uv run pytest tests/repositories/test_train_repository.py tests/services/test_train_pool.py tests/routers/test_train.py -x` |
| Full suite command | `uv run pytest -n auto` (backend) + `cd frontend && npm test -- --run` (frontend) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| POOL-03 (amended) | >=2 moves within `INACCURACY_DROP` (0.05 ES) of best, confirmed by stored MultiPV-5 ladder | unit | `pytest tests/services/test_train_pool.py::test_herring_includes_close_best_and_second -x` (existing test, likely needs rewrite against the new source — mirror its structure for the pool-backed version) | ✅ existing (Phase 189), needs adaptation |
| POOL-03 (amended) | Degenerate "every move is fine" excluded at query time, not baked into generation | unit | new test, e.g. `test_herring_excludes_degenerate_all-fine_position` | ❌ Wave 0 |
| SC2 (generator idempotent/resumable) | `scripts/gen_red_herring_pool.py` re-run tops up, never duplicates | integration | `uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 30` run twice, assert row count only grows by the shortfall, no UPSERT conflict errors | ❌ Wave 0 (manual + a script-level assertion, not necessarily a pytest test — mirrors how `scripts/backfill_flaws.py` has no dedicated pytest coverage, only manual/CI smoke) |
| SC3 (source-game deletion survivability) | Deleting a source game leaves the herring servable, FEN/move come off the pool row, game link nulls, Analyze hidden, foreign-user deletion never removes a stranger's in-flight session row | unit (backend) + component (frontend) | new: `test_reveal_survives_source_game_deletion` (backend, mirrors `tests/routers/test_train.py::test_reveal_herring_reports_herring_type` structure); new: a `TrainSolveScreen`/`TrainReveal` test asserting the Analyze button and game-footer are conditionally rendered | ❌ Wave 0 |
| SC4 (empty pool -> full N of SR items) | Fully-empty herring source still yields a full session via cross-backfill; `waiting_count` stays honest | unit | new: `test_fully_empty_herring_pool_backfills_with_sr` in `tests/repositories/test_train_repository.py`, as a **sibling** to (not a rewrite of) `test_herring_shortfall_backfills_with_sr` (line 335) — seed ZERO herring pool rows (vs. the existing test's ONE), assert `puzzle_count == n` with 100% SR | ❌ Wave 0 (explicitly requested as new, per CONTEXT.md) |
| SC5 (cross-user reveal correctness) | `GamePosition` lookup resolves the game owner, board arrow + in-game move show, no game info line, source no longer reads `game_best_moves` | unit | new: `test_reveal_cross_user_herring_shows_game_move_no_game_info`; grep-gate: `grep -rn "game_best_moves" app/services/train_pool.py` returns nothing in the herring path | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the quick-run command above (targeted Train test files).
- **Per wave merge:** full backend suite (`uv run pytest -n auto`) + frontend (`npm test -- --run`).
- **Phase gate:** full suite green before `/gsd-verify-work`; additionally, `uv run ty check app/ tests/` (schema nullability changes are exactly the kind of thing `ty` catches — e.g. a caller still assuming `TrainPuzzle.game_id: int` after the schema widens to `int | None`).

### Wave 0 Gaps
- [ ] New test file section (or new tests appended to `tests/repositories/test_train_repository.py`) covering the fully-empty herring pool (SC4).
- [ ] New tests in `tests/services/test_train_pool.py` for the pool-backed `herring_stmt` (the existing 8 herring tests at lines 530-681 will need substantial rewriting against the new source — treat as a full replacement of that test block, not an addition).
- [ ] New tests in `tests/routers/test_train.py` for the cross-user reveal + source-game-deletion survivability (SC3/SC5).
- [ ] Frontend component tests for `TrainReveal.tsx` (game-footer omission for herrings) and `TrainSolveScreen.tsx` (Analyze-hide on null `game_id`) — existing `TrainReveal.test.tsx`/`TrainSolveScreen.test.tsx` files exist and should gain cases, not new files.
- [ ] No test framework/fixture gaps — `db_session` (rollback-scoped async fixture) and `ensure_test_user` helpers already exist and cover everything this phase's backend tests need.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | unchanged — Train endpoints already require `current_active_user` |
| V3 Session Management | no | unchanged |
| V4 Access Control | **yes** | Every existing Train query pattern requires `user_id` as a keyword-only, server-sourced argument (never client-supplied) — the new pool table and its queries must follow the identical convention. Critically, D-06's widened `GamePosition` lookup (resolving the GAME OWNER, not the solving user) is a deliberate, narrow exception to "always scope by the current user" — verify it is scoped to read-only, non-sensitive display data (`move_san`) and nothing else, exactly as D-06 specifies. This mirrors the already-audited `library_repository.best_move_exists_from_table` cross-user-safe pattern the codebase already uses. |
| V5 Input Validation | yes | `--n-positions`/`--phase`/`--db` CLI args (script-only, not user-facing HTTP input — lower bar, but `argparse` `choices=` already enforces the enum); no new HTTP-facing input surface is introduced by this phase (no new endpoint, no new request schema field beyond the existing `SolveRequest`/nothing new) |
| V6 Cryptography | no | not applicable — no new secrets/crypto |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| IDOR via a client-supplied `session_id`/`position` resolving another user's puzzle | Elevation of Privilege | Already mitigated — every existing Train query scopes by `user_id` in the WHERE clause in addition to the client-supplied id (T-189-16 pattern); this phase adds no new client-facing id parameters, so no new IDOR surface is introduced |
| Cross-user data leak via the widened D-06 `GamePosition` lookup | Information Disclosure | D-06 explicitly scopes the widening to `move_san` only (a single non-sensitive display field), resolved via the game's owner (not client-supplied) — the "no IDOR seam" reasoning in CONTEXT.md is sound: the user never supplies the id, the server already authorized the puzzle before the reveal call. Verify at implementation time that the widened query does not accidentally select any OTHER `GamePosition` column that could leak game-owner-specific data beyond what D-07/D-08 already intend to show. |
| Answer-key leak via the pool table's JSONB ladder column | Information Disclosure | Mirror `GameFlaw.missed_pv_lines`'s `deferred=True` discipline (Pattern 3 above) — the ladder must never be selectable from the pre-attempt `TrainPuzzle` payload, only from the post-attempt reveal path (or nowhere at all, if the reveal stays as thin as `PuzzleRevealResponse` currently is, which carries no PV/eval data for ANY puzzle type today) |

## Sources

### Primary (HIGH confidence — direct codebase reads, this session)
- `app/services/train_pool.py` (full file) — `herring_stmt`, `pool_entry_stmt`, `_prior_position_lateral`, `answer_key_present`, `fen_and_last_move_at_ply`, `expected_score_sql`, all constants (`WINNABILITY_FLOOR_ES`, `SHARP_GAP_ES`, `HERRING_SHARE`)
- `app/repositories/train_repository.py` (full file, 1769 lines) — `compose_and_materialize_session`, `load_session_puzzles`, `_mark_session_complete_if_done`, `reveal_for_puzzle`, `record_solve`, and every `DrillSolve.game_id`/`solve.game_id` read site
- `app/models/drill_solve.py`, `app/models/game_best_move.py`, `app/models/game_position.py`, `app/models/drill_item.py`, `app/models/game_flaw.py` (partial), `app/models/game.py` (partial) — schema shapes, FK policies, deferred-column conventions
- `app/services/engine.py` (lines 1-130, 280-680) — `EnginePool`, `evaluate_nodes_multipv2`, `_acquire_and_analyse`, node/timeout constants, SCHED_IDLE/crash-vs-timeout handling
- `app/routers/library.py:100-180` — `GET /api/library/games/{game_id}` cross-user-by-design confirmation
- `scripts/backfill_flaws.py`, `scripts/validate_multipv_budget.py` — `--db dev|benchmark|prod` CLI conventions, `db_url_for_target` usage, batching/session discipline
- `scripts/remote_eval_worker.py` (partial) — direct `EnginePool(workers)` instantiation pattern outside the module-level singleton
- `frontend/src/components/train/TrainReveal.tsx` (full file), `TrainSolveScreen.tsx` (partial, Analyze button region) — exact game-footer and Analyze-link render sites for D-07/D-09
- `frontend/src/types/train.ts`, `app/schemas/train.py` — `TrainPuzzle.game_id`/`PuzzleRevealResponse.game_id` nullability change sites
- `frontend/src/hooks/useLibrary.ts:248-268` — `useLibraryGame(gameId: number | null)` already null-safe
- `tests/repositories/test_train_repository.py` (partial) — existing shortfall test structure and helper functions (`_seed_flaw_game`, `_seed_herring_game`)
- `.planning/phases/192-red-herring-position-pool/192-CONTEXT.md`, `192-DISCUSSION-LOG.md` — all locked decisions (D-01 through D-19)
- `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/PROJECT.md` — POOL-03's current (superseded) wording, confirmed by grep

### Secondary (MEDIUM confidence)
- None — every claim in this document traces to a direct file read in this session; no web search or external documentation lookup was performed (this phase is 100% internal-codebase reuse, no new library).

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new packages, every dependency already pinned and in active use elsewhere in the codebase.
- Architecture: HIGH — the current seam (`herring_stmt`, `compose_and_materialize_session`, `reveal_for_puzzle`) was read in full, not summarized from memory; the three INNER JOIN pitfalls are directly verified by reading the exact join clauses.
- Pitfalls: HIGH for the JOIN/nullability issues (directly observed in the code); MEDIUM for the exact MultiPV=5 edge-case behavior (Stockfish's `len(info_list) < requested` behavior is documented in the existing `evaluate_nodes_multipv2` comments but has not been empirically re-verified at multipv=5 in this session).

**Research date:** 2026-07-27
**Valid until:** 30 days (stable internal codebase; no external dependency to go stale) — but re-verify the exact `DrillSolve.game_id` read-site line numbers before implementation if this phase is picked up significantly later than planned, since `train_repository.py` is actively edited by adjacent Train phases.
