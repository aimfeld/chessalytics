# Phase 212: Benchmark Full-Game Analysis Lane - Context

**Gathered:** 2026-08-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Put a capped, randomly-selected, equal-footing slice of the benchmark DB through the real
FlawChess pipeline — `best_move` + `pv` on `game_positions`, `game_flaws` rows (with blobs
and tactic tags), `game_best_moves` rows — produced by the existing worker fleet against a
**local backend on port 8001 pointed at the benchmark Postgres on 5433**.

No prod-side changes, no product surface, no prod disk impact. The analysis itself is
unattended fleet time; the buildable work is a selection script + tables, a config-gated
candidate-query narrowing, a dual-URL fallback in `scripts/remote_eval_worker.py`, and the
local backend instance.

**Locked upstream in SEED-152 / ROADMAP — do NOT re-open:** ±100 equal-footing population;
cap 100 games/user/TC bucket; random (not recency-ordered) selection within a user; TC
order classical → rapid → blitz → bullet with each completing before the next; the
local-backend + dual-URL-worker topology (the sibling-DB-on-prod design is rejected and
recorded); `benchmark_selection` as a materialized table that IS the reproducibility record.

</domain>

<decisions>
## Implementation Decisions

### Tranche composition (Success Criterion 5, and the ROADMAP's carried open question)

- **D-01:** **Both arms run in the classical tranche** — the lichess-eval arm is NOT
  deferred. ~54,390 capped classical games, ~3.4 days at budgeted throughput. Rationale:
  the §6 analyzed-vs-unanalyzed selection-bias check running *in-population* is the stated
  reason this phase exists, and it requires both arms present. Deferring saves 1.7 days and
  removes the headline use case. — **Reversibility:** costly — undoing means a second pass
  over classical later, which re-runs the selection tranche and re-touches rows already
  written.

- **D-02:** **One random draw per user across the whole eq-footing set**, so the
  analyzed/unanalyzed split falls out at that user's *natural* ratio. No stratification, no
  minimum-per-arm floor. Rationale: stratifying would distort the exact quantity §6
  measures. Users with zero games in one arm simply drop out of the paired analysis (per
  `[[feedback_paired_not_pooled_cohort_splits]]` — paired per-user Δ, never pooled).

### Eval-source homogeneity (Success Criterion 5)

Grounding fact, measured against the benchmark DB on 2026-08-22: **all 641,855 analyzed
games carry `lichess_evals_at`** — "eval source" and "was analyzed" are the *same*
partition. A §6 comparison is therefore not merely at risk of confounding, it is fully
confounded unless the arms are homogenized. That settles the "is it worth it" question.

- **D-03:** Homogenize via a **benchmark-only config flag that overrides
  `is_lichess_eval_game` to `False` in the drain WRITE path only**. The boolean is derived
  at `app/services/eval_apply.py:2344` from `lichess_evals_at IS NOT NULL`; forcing it
  false there makes our `eval_cp` the stored value, restores the terminal donor
  (`eval_drain.py:948` passes `include_terminal=not is_lichess_eval_game`), and makes
  `game_flaws` classify from *our* Stockfish. **No schema change on `game_positions`, no
  forked read path, prod inert because the flag is off.** — **Reversibility:** costly — the
  written `eval_cp` values for touched games are overwritten in place; recovery depends on
  D-05's snapshot existing.

  Known knock-on, accepted: forcing the flag off also drops the `eval_drain.py:836`
  substitution that keeps lichess's `best_move` as the best-move-candidate identity key.
  The engine's own best move is used instead — which is what we want, and more correct.

- **D-04:** `lichess_evals_at` is **left untouched** and remains the §6 selection marker.
  Verified: the column is written in exactly one place in the codebase
  (`app/services/import_service.py:1581`, at import time); the eval pipeline only ever
  *reads* it (`eval_queue_service.py:288, 653, 1005`). Overriding the derived boolean does
  not disturb the column.

- **D-05:** **Preserve the original lichess evals in a benchmark-only side table** (e.g.
  `benchmark_lichess_eval_snapshot(game_id, ply, eval_cp)`), populated **at tranche start,
  before the fleet touches anything**, for the selected lichess-arm games only (~27k
  classical games × ~67 plies ≈ 1.8M rows). Ordering is natural because
  `benchmark_selection` is materialized first.

  Note the deliberate inversion vs. the seed's "add `engine_eval_cp`" sketch: the *new*
  storage holds the value nobody reads by default, rather than the value every consumer
  must be re-pointed at. This is what keeps `eval_cp` homogeneous with no forked read path,
  while still enabling a paired same-position lichess-vs-ours sanity check.

- **D-06:** **Mixed flaw provenance is handled by documentation, not schema or exclusion.**
  After classical, ~175k of the benchmark DB's 4,153,067 `game_flaws` rows will derive from
  our Stockfish rather than lichess's (eq-footing classical lichess-arm games currently
  hold 397,310 flaw rows; the cap-100 selection touches roughly half). `benchmark_selection`
  IS the marker — any consumer joins `games` to it to split the sources. The `benchmarks`
  skill's `SKILL.md` gains a note that §5 flaw-delta zones now span two eval sources and
  how to split them. No anti-join, no frozen basis. (Guards
  `[[feedback_benchmark_source_of_truth]]` by disclosure rather than by exclusion.)

### Schema provenance and the selection gate (Success Criteria 1, 2)

- **D-07:** Both new tables (`benchmark_selection`, `benchmark_lichess_eval_snapshot`)
  follow the **Phase 69 INFRA-02 precedent, already established and documented**: an ORM
  model on the shared `Base`, created by a targeted
  `Base.metadata.create_all(tables=[...])` from its own script, **deliberately NOT in the
  canonical Alembic chain**. Live examples to mirror: `app/models/benchmark_selected_user.py`
  (created at `scripts/select_benchmark_users.py:369`) and
  `app/models/benchmark_ingest_checkpoint.py` (created at
  `scripts/import_benchmark_users.py:216`). — **Reversibility:** reversible.

- **D-08:** **Close the latent autogenerate table gap in the same phase.**
  `alembic/env.py:112` `_include_object` filters **indexes only**
  (`if type_ == "index" and name in _AUTOGEN_INDEX_IGNORELIST`); tables are never filtered.
  So a benchmark-only model on the shared `Base` is invisible to prod today only because
  nobody has run `--autogenerate` since — the next unrelated autogenerate would silently
  emit `op.create_table('benchmark_selection')` against prod. Extend `_include_object` to
  tables (an ignorelist mirroring `_AUTOGEN_INDEX_IGNORELIST`, or a marker in
  `__table_args__.info`). This retroactively protects the two existing benchmark-only
  tables too. Same class of time-bomb as the 2026-07-02 code-review fix documented at
  `alembic/env.py:100-104`. — **Reversibility:** reversible, but it touches a shared file
  every future migration depends on; keep the change narrow and tested.

- **D-09:** **The selection gate applies to ALL lottery lanes, not just tier-3.** This
  deliberately widens Success Criterion 2's wording. Measured leak: **477,829 benchmark
  games are tier-4-blob eligible right now** (`full_evals_completed_at IS NOT NULL AND
  blobs_completed_at IS NULL`), and that lane sheds to the fleet via `/flaw-blob-lease`
  exactly like the eval work. With `EVAL_AUTO_DRAIN_ENABLED=true` (mandatory, see D-11) a
  tier-3-only gate would spend the tranche's capacity on 477k games nobody selected, and
  "stoppable at a TC boundary" would stop meaning what it says. Apply the narrowing to
  tier-3 Step 1 **and** Step 2, tier-4 blob, and tier-4b alike. Semantics of the flag:
  *this backend only ever works on selected games*, full stop.

  (tier-4b is safe today only incidentally — `full_pv_completed_at` is 0 across the whole
  benchmark DB. It becomes live as our own tranche completes, at which point it only ever
  sees selected games.)

  > **addendum (2026-08-22, 212-07):** D-09's "ALL lottery lanes" claim above was scoped
  > to the four lottery predicates the fleet's rungs 3-5 reach (tier-3 Step 1/2, tier-4
  > blob, tier-4b) and missed the entry-ply lane (`/entry-lease`, rung 1's sibling —
  > `_claim_entry_eval_games`, also the in-process server-pool drain's picker). The miss
  > was not caught by review; it was demonstrated empirically when 212-06's smoke-tranche
  > launch found `/entry-lease` had zero references to `benchmark_selection` and advanced
  > `evals_completed_at` on 76,040 unselected games in ~80 seconds before the run was
  > aborted. 212-07 extends the gate to the entry-ply lane's probe and canonical claim,
  > closing that gap in the same one-edit-covers-both-consumers shape D-09 already
  > established. The explicit tier-1/2 queue (`eval_jobs`) remains deliberately ungated,
  > for the reason stated above — it stays out of reach on the benchmark instance for a
  > structural reason (no enqueue surface), not because the gate covers it. See
  > `docs/benchmark-lane-runbook.md`'s per-rung table and 2026-08-22 incident record for
  > the full account.

- **D-10:** **Gate inertness (SC2) is proven by three things**, not one:
  1. A test asserting the generated predicate is **byte-identical to today's** when the
     flag is off — the only proof that survives a future refactor, and the failure SC2 is
     actually worried about.
  2. A test with the flag **on** and the table created in the test DB, asserting the
     narrowing actually bites.
  3. A **boot assertion** that refuses to start with the gate on when `benchmark_selection`
     is missing — so a misconfigured instance fails loudly at startup instead of raising
     `UndefinedTable` on every claim for hours.

### Fleet and local backend operating shape (Success Criteria 3, 4, 6)

- **D-11:** **`EVAL_AUTO_DRAIN_ENABLED=true` and `BEST_MOVE_BACKFILL_ENABLED=true` are both
  mandatory on the local instance, not tuning choices.** `app/core/config.py:83-98` — the
  best-move flag gates both the in-process tier-4b drain **and** the worker-facing
  `/bestmove-lease` endpoint (single switch, D-04 of Phase 177). Without it the fleet's
  rung 5 returns 204 forever and no gem tiers land.

- **D-12:** **Maia must load in the local backend process.** `app/services/eval_apply.py:810`
  — `maia_available` is *the* guardrail: a Maia-absent backend must never stamp
  `best_moves_completed_at`, so a Maia load failure yields PV-but-no-best-moves and does so
  **silently**. This is also the whole reason a *local* backend is needed at all (the fleet
  computes the runner-up Stockfish evals via `scripts/remote_eval_worker.py:1058-1150`;
  only Maia inference is backend-side). Treat "Maia loaded" as an explicit precondition the
  operator surface checks, not an assumption.

- **D-13:** **Dual-URL fallback fires at the whole-ladder level.** `_run_cycle`
  (`scripts/remote_eval_worker.py:814`) is a self-contained 5-rung ladder
  (`/atomic-lease?scope=explicit` → `/entry-lease` → `/atomic-lease?scope=idle` →
  `/flaw-blob-lease` → `/bestmove-lease`) running against a single `httpx.AsyncClient`
  built once in `run_worker` (`:1187`). So: run the full ladder against prod, and only when
  **all five rungs return 204** re-run the ladder against the benchmark backend. This gives
  strict per-claim prod priority *and* preserves lease→eval→submit affinity for free, since
  each `_run_cycle` invocation is self-contained with one client. `_run_cycle` needs to
  return "did work" rather than only "should stop".

- **D-14:** **An unreachable primary is treated as no-work and falls through** to the
  benchmark backend, same as a 204. Rationale: the fleet keeps working through a prod
  outage instead of idling; a leased benchmark game is ~60s and the very next cycle retries
  prod at full priority. `_handle_transient_failure`'s existing streak alert
  (`TRANSIENT_FAILURE_ALERT_S`) still escalates a sustained outage once, so this stays
  visible rather than silent. Accepted risk, recorded: if the *worker box* loses its route
  to prod while the LAN backend stays reachable, that worker grinds benchmark work until
  the streak alert is noticed.

- **D-15:** **The local backend is a submit/Maia service, not a Stockfish contributor.**
  `STOCKFISH_POOL_SIZE=1` (the default, `app/services/engine.py:148`), so the in-process
  `_full_drain_tick` barely competes; the Stockfish throughput comes from the fleet where
  it is already proven. Keeps throughput attribution clean while judging whether the
  program is on schedule, and leaves Adrian's cores for the workers already on that box.
  (With D-09 the in-process drain only touches selected games anyway, so it is a competing
  consumer, not a wrong one; tier-3 takes no locks and D-4 already accepts residual
  duplicates.)

- **D-16:** **One `scripts/` entry point with subcommands** is the operator surface —
  select per TC, snapshot lichess evals, status, record — following the established
  `scripts/` convention of self-describing `--help` tools. `status` prints tranche progress
  from `benchmark_selection` joined to the completion columns. `record` (satisfying SC6's
  "row counts recorded") writes a timestamped markdown file under `reports/`, the way
  `db-report` and `tactic-tagger-report` already do. One thing to remember weeks later, and
  the phase's tests can exercise it.

### Claude's Discretion

- **Operator token for port 8001.** The worker sets `X-Operator-Token` once at client
  construction (`remote_eval_worker.py:1187`), so two clients naturally carry two tokens. A
  separate `EVAL_OPERATOR_TOKEN` for the benchmark instance (with the fallback token
  defaulting to the primary's if a flag is omitted) is the obvious shape; not discussed
  explicitly.
- **`benchmark_selection` column set** beyond `(game_id, tc_tranche)` — whatever the
  selection script and `status`/`record` need, plus whatever makes re-running selection
  idempotent per tranche (mirror the `UniqueConstraint` idempotency pattern from
  `benchmark_selected_users`).
- **Naming** of the homogenization flag, the gate flag, and the two tables.
- **Disk headroom and vacuum specifics** — the seed's ~15 KB/game net, ~2× during the run
  from MVCC dead rows, and a post-run vacuum pass (SC6) stand as written; exact vacuum
  strategy is an implementation choice.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source and locked design
- `.planning/seeds/SEED-152-benchmark-full-game-analysis-lane.md` — the locked
  population/cap/selection decisions, the measured cost table, the storage/MVCC figures,
  and the rejected sibling-DB topology. **Two "code facts that change the cost model" in it
  are load-bearing for sizing.**
- `.planning/ROADMAP.md` § "Phase 212: Benchmark Full-Game Analysis Lane" — goal, the six
  Success Criteria, and the planning notes that correct the seed's half-stale Maia claim.
- `.planning/notes/benchmark-equal-footing-framing.md` — where the ±100 opponent-gap rule
  comes from and what it is meant to mean.

### The consumer this phase exists to serve
- `stories/two-pawns-up/two-pawns-up-report-latest.md` §6 — the selection-bias check that
  currently has to borrow ~98 prod accounts and concede "the sign of the side tilt need not
  transfer". D-01/D-03/D-04 exist to let this run in-population.
- `stories/CLAUDE.md` — story-specific rules, if any downstream work touches `stories/`.

### Pipeline internals the decisions depend on
- `app/services/eval_apply.py:2344` — where `is_lichess_eval_game` is derived (D-03's
  single override point); `:641` the lichess write branch; `:810` the `maia_available`
  guardrail (D-12); `:817` the note that the lichess exclusion lives only in the tier-4b
  lottery predicate.
- `app/services/eval_drain.py:836` — the best-move identity-key substitution D-03 drops;
  `:948` the `include_terminal` asymmetry; `:951-968` the Phase 174-06 full-ply MultiPV-2
  pass and empty `dedup_hashes` for lichess games (why that arm costs 100%+ of an engine
  game).
- `app/services/eval_queue_service.py:458` `_claim_tier3_derived`, `:659`
  `_claim_tier4_blob`, `:784` `_claim_tier4_bestmove` — the three lanes D-09 gates, all
  built on the shared `_es_weighted_user_pick(candidate_where_sql=...)` / 
  `_es_weighted_game_pick(game_where_sql=...)` builders at `:298` / `:400`, which are the
  clean seam for the narrowing.
- `scripts/remote_eval_worker.py:814` `_run_cycle` (the 5-rung ladder), `:718` `_run_loop`
  (exception boundary + transient streak), `:1157` `run_worker` (single client construction).
- `app/core/config.py:83-98` — `EVAL_AUTO_DRAIN_ENABLED` / `BEST_MOVE_BACKFILL_ENABLED`
  and the both-gates-checked contract.

### Schema provenance precedent
- `app/models/benchmark_selected_user.py:1-6` — the INFRA-02 rule stated verbatim
  ("Created via `Base.metadata.create_all()` … NOT in the canonical Alembic chain").
- `scripts/select_benchmark_users.py:363-369` and `scripts/import_benchmark_users.py:210-216`
  — the targeted `create_all(tables=[...])` pattern to copy.
- `alembic/env.py:88-115` — `_AUTOGEN_INDEX_IGNORELIST` and `_include_object`, the file
  D-08 extends; the 2026-07-02 code-review note at `:100-104` is the precedent for why.
- `bin/benchmark_db.sh:29` — the benchmark DB runs the *same* `alembic upgrade head`, which
  is what makes D-07/D-08 a real fork rather than a formality.

### Reporting consumers to keep honest
- `.claude/skills/benchmarks/SKILL.md` (and `reports/benchmarks-latest.md`) — §5 flaw-delta
  zones are computed from `game_flaws`; D-06 adds the disclosure note here.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`_es_weighted_user_pick` / `_es_weighted_game_pick`** (`eval_queue_service.py:298`,
  `:400`) — both take a caller-supplied predicate string
  (`candidate_where_sql` / `candidate_exists_sql` / `game_where_sql`). All three lottery
  lanes route through them, so D-09's gate is one predicate applied at each call site
  rather than three hand-written query edits. Note the docstring's warning that these SQL
  fragments are *trusted* (never user input) — the gate predicate is a constant, which fits.
- **`benchmark_selected_users` / `benchmark_ingest_checkpoint`** — a complete, working
  template for a benchmark-only table: ORM model, targeted `create_all`, idempotency via a
  compound `UniqueConstraint`, out of the Alembic chain.
- **`db-report` and `tactic-tagger-report` skills** — the established shape for a
  timestamped markdown report under `reports/`, which D-16's `record` subcommand mirrors.
- **`bin/benchmark_db.sh`** — already does `start` / `stop` / `reset` plus `alembic upgrade
  head` against 5433 and the read-only grants. SC4's "Alembic head verified to match" has a
  home here.

### Established Patterns
- **Benchmark-only schema stays out of the canonical chain** (INFRA-02). Confirmed live:
  the dev DB contains only `benchmark_cohort_cdf` among `benchmark%` tables — and that one
  *is* canonical (imported at `alembic/env.py:19`).
- **Fail-closed contracts** throughout the eval write path (WR-01) — errors propagate to
  abort the caller's transaction rather than being swallowed. D-10's boot assertion is in
  the same spirit.
- **Config flags default False and prod opts in explicitly** via `.env`
  (`EVAL_AUTO_DRAIN_ENABLED`, `BEST_MOVE_BACKFILL_ENABLED`, `EVAL_OPERATOR_TOKEN`). The two
  new flags follow suit.
- **Worker ladder ordering mirrors server tier priority** (`_run_cycle`'s Pitfall-6 note).
  D-13's fallback must not disturb the within-ladder ordering — it wraps the ladder, it
  does not interleave rungs across backends.

### Integration Points
- `_claim_tier3_derived` Step 1 + Step 2, `_claim_tier4_blob`, `_claim_tier4_bestmove` —
  the four predicate sites the gate narrows.
- `eval_apply.py:2344` — the single derivation point the homogenization flag overrides.
- `_run_cycle` / `_run_loop` / `run_worker` — where the second client and the
  ladder-level fallback thread through.
- `alembic/env.py:_include_object` — extended to tables.
- A new `scripts/` entry point + two new `app/models/` modules.

### Measured baseline (benchmark DB, 2026-08-22)

| Metric | Value |
|---|---|
| Games with `lichess_evals_at` | 641,855 |
| Games marked analyzed | 641,855 (identical set) |
| `full_evals_completed_at` set | 491,979 |
| `full_pv_completed_at` set | 0 |
| `game_best_moves` rows | 0 |
| `game_flaws` rows | 4,153,067 |
| tier-4-blob eligible now | 477,829 |
| eq-footing classical: lichess arm / engine arm | 63,411 / 64,175 |
| eq-footing rapid / blitz / bullet totals | 584,400 / 685,049 / 713,266 |
| Existing flaw rows on eq-footing classical lichess-arm games | 397,310 (61,316 games) |

These reproduce the ROADMAP/seed cost table exactly, so the sizing there can be trusted.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly asked for the lichess-vs-our-Stockfish comparison to remain possible
  as a **sanity check** — that is the whole motivation for D-05's snapshot, and the check
  should be a paired same-position comparison (which is the version with power), not a
  distributional comparison across disjoint game sets.
- The user explicitly wanted confirmation that "was this game analyzed on lichess" survives
  homogenization. It does (D-04) — and that property is load-bearing for §6, so any
  implementation that would clear or repurpose `lichess_evals_at` is out of bounds.

</specifics>

<deferred>
## Deferred Ideas

- **Re-run the benchmarks and diff §5** after the classical tranche, to measure whether
  lichess-vs-our Stockfish actually moves the flaw-delta zones. Considered as a guard for
  D-06 and not chosen — disclosure was preferred over measurement for *this* phase — but it
  is a genuine question and the D-05 snapshot makes it answerable later.
- **Recovering the ~4,690 never-imported benchmark cohort users.** `benchmark_selected_users`
  holds 9,450 distinct users but only 4,760 exist in `users`. Recovering them costs an
  *import*, not Stockfish, and cluster-bootstrap CI width scales with account count — it may
  be the cheaper statistical-power purchase. Recorded in the seed and the ROADMAP as
  explicitly **not part of this phase**.
- **A second backend container on the prod host serving a sliced sibling DB**, for the case
  where some future worker is genuinely off-LAN. The dual-URL worker patch (D-13) is shared
  between both designs, so this stays cheap to reach for later.
- **Arm-level stop boundaries inside a TC tranche** (beyond the locked TC boundaries).
  Raised as a possible follow-up question and not pursued.

### Reviewed Todos (not folded)
`todo.match-phase` returned three candidates, all keyword-noise with no substantive
relation to this phase; none folded:
- `172-deferred-review-findings.md` — matched on generic words ("pending", "source", "phase").
- `2026-03-11-bitboard-storage-for-partial-position-queries.md` — a `game_positions` storage
  idea unrelated to eval provenance.
- `2026-05-18-wr01-pt33-invalid-tailwind-score-axis-label.md` — a frontend class-name bug.

</deferred>

---

*Phase: 212-benchmark-full-game-analysis-lane*
*Context gathered: 2026-08-22*
