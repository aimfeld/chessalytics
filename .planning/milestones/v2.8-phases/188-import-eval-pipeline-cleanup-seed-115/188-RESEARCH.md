# Phase 188: Import/Eval Pipeline Cleanup — Retire Completed Backfill Machinery - Research

**Researched:** 2026-07-24
**Domain:** Internal maintenance / dead-code removal in the FastAPI + SQLAlchemy eval pipeline (no external libraries, no user-facing behavior)
**Confidence:** HIGH — every claim below was verified against the current tree (not the seed's 2026-07-23 snapshot) via direct file reads and grep, not training knowledge.

## Summary

This phase is pure repo archaeology: confirm what SEED-115's inventory still matches the live tree, and do exactly the surgery CONTEXT.md locked. The single most important finding is that **the seed's characterization of "dead tier 2" is stale even relative to itself** — the `TIER_2` constant it implies still exists was already deleted in Phase 149-04 (see `app/models/eval_jobs.py:12-13`). What remains in `eval_queue_service.py` is not a removable code branch but ~10 lines of docstring/comment prose describing a tier that has no constant, no enqueue path, and no dedicated SQL branch (the claim SQL was always tier-agnostic `ORDER BY tier ASC`). D-03's "removal" is therefore a **documentation trim**, not a code deletion — there is no functional risk here, only a precision risk (see the "tier 2" homonym pitfall below).

The re-export audit (D-06) is the other place this research changes the plan's shape: of the 13 `# noqa: F401` backward-compat re-exports in `eval_drain.py:63-105`, only **3 are actually prunable** (`_batch_update_best_move_rows`, `_batch_update_pv_rows`, `_batch_update_flaw_pv_lines`) — all three are imported exclusively by the two scripts being archived (`backfill_best_move_pv.py`, `backfill_multipv.py`). The other 10 are imported directly by test files or by `scripts/remote_eval_worker.py` (the **active**, non-archived remote worker driver) and must stay untouched.

The index realignment (D-07) is a straightforward drop-clause fix with a well-established local precedent: this repo's convention for `games`-table partial-index migrations is **plain (non-concurrent) `op.drop_index`/`op.create_index` inside the transaction**, justified explicitly in a prior migration's docstring by the fact that Alembic runs at container startup before Uvicorn accepts traffic (`deploy/entrypoint.sh`), i.e., against a quiescent backend. There is no reason to introduce `CONCURRENTLY` for the first time here.

**Primary recommendation:** Execute the seven CONTEXT.md line items as scoped edits (mostly docstring/comment surgery, 7 `git mv`, 3 re-export deletions, 1 migration), verified by re-running the existing test suite unchanged (no test file needs new test cases — this phase adds zero behavior) plus one explicit index-predicate-text assertion.

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions

- **D-01: KEEP `resweep_holed_games`** (`app/services/eval_drain.py`) + `scripts/resweep_holed_games.py`. Docstring rewrite required: from "pre-Phase-119 legacy, population gone" to "permanent manual re-arm tool for Path-C mid-game holes (weak-worker failure mode)". Keep the SEED-045/SEED-049 hole-definition detail — still correct and load-bearing.
- **D-02: SEED-115 open decision resolved as OPTION 1** — tiers 4/4b stay as thin permanent safety nets. No strict-complete submit semantics, no worker retry-logic change, no endpoint removal, no column-drop migration.
- **D-03: Remove tier 2** from `app/services/eval_queue_service.py` — dead since Phase 118. Planner must verify no live references (tests may reference it).
- **D-04: Archive to `scripts/archive/`**: `backfill_eval.py`, `backfill_full_evals.py`, `backfill_best_move_pv.py`, `backfill_multipv.py`, `backfill_opening_eval_cache.py`, `snapshot_tactic_counts.py`, `backfill_accuracy_acpl.py`. Keep `OPENING_CACHE_BACKFILL_SQL` in `eval_drain.py` — gate-equivalence tests use it.
- **D-05: Fix stale docstrings** in `app/routers/eval_remote.py` (~:428, ~:1313 at seed plant time) claiming legacy `/lease`/`/submit` are "live and deprecated"; those endpoints are already removed. Docstring-only, no behavior.
- **D-06: Prune backward-compat re-exports** in `eval_drain.py` (~:63-105) — remove ONLY the subset whose sole importers were the scripts archived in D-04. Tests import some of these; grep `tests/` and kept scripts for each symbol BEFORE removing. Archived scripts keep working imports or get a header note that they reference historical module paths.
- **D-07: Realign `ix_games_bestmove_backfill_pending`** (`app/models/game.py:94-101`) with the actual `_claim_tier4_bestmove` predicate — quick 260719-fsz dropped `lichess_evals_at IS NULL` from the claim query but the partial index still carries it. Fix direction: change the INDEX to match the query (drop the clause from the index predicate), NOT the query to match the index. This is the phase's only Alembic migration; server-side only, invisible to workers.
- **D-08: No remote-worker upgrade required.** Worker-facing surface is untouched: eval_remote.py changes are docstring-only, submit semantics unchanged.
- **D-09: NOT-deletable list is a hard fence**: tier 3 + tier-3-residual, tier 4 (blob lottery), tier 4b (best-move lottery), Path-C hole tolerance, all five timestamp columns, `apply_game_filters`, and the three active scripts (`backfill_flaws.py`, `retag_flaws.py`, `reimport_games.py`).

### Claude's Discretion

None explicitly delegated beyond the specifics above — CONTEXT.md gives precise line-item scope for every deletion/edit. The one open call is **how** to keep the archived `backfill_best_move_pv.py` / `backfill_multipv.py` importable after their sole-use re-exports are pruned (D-06 explicitly offers a choice: "keep working imports or get a header note"). Research recommends fixing the two import lines (trivial, matches this repo's own precedent of archived scripts remaining nominally functional — see Package Legitimacy Audit section below for why this is not a package/dependency issue).

### Deferred Ideas (OUT OF SCOPE)

- **SEED-115 option 2 (strict-complete atomic submit)** — rejected, not deferred. If ever revisited, needs a new seed with honest retry-semantics risk analysis.

</user_constraints>

<phase_requirements>
## Phase Requirements

No formal REQUIREMENTS.md IDs — this is a maintenance phase. CONTEXT.md's D-01 through D-09 decisions ARE the requirements; the table below maps each to what this research verified.

| ID | Description | Research Support |
|----|-------------|------------------|
| D-01 | Keep + reframe `resweep_holed_games` docstring | Exact current line bounds confirmed (1151-1289, docstring 1156-1193); `apply_completion_decision` Path C cited at `eval_apply.py:739-743` verbatim match to CONTEXT.md's citation; new framing drafted below |
| D-02 | Tiers 4/4b stay, no protocol change | Confirmed `/flaw-blob-lease`, `/flaw-blob-submit`, `/bestmove-lease`, `/bestmove-submit` all present and live in `eval_remote.py` (grep of `@router.post`) |
| D-03 | Remove dead tier 2 from `eval_queue_service.py` | Confirmed TIER_2 constant already gone (Phase 149-04); scoped the real remaining work to docstring/comment trim; documented the "tier 2" homonym pitfall (5 unrelated subsystems use the same term) |
| D-04 | Archive 7 scripts | Confirmed all 7 exist, zero cross-imports among them, confirmed archive convention (plain `git mv`, zero content changes, per commit `1d74a8e8`) |
| D-05 | Fix stale `/lease`/`/submit` docstrings in `eval_remote.py` | Located exact current lines (428-429, 1313-1314) — near-zero drift from seed's `:428`/`:1313`; distinguished the `/submit` (stale, deleted) claim from the `/flaw-blob-submit` (accurate, still live) claim in the same sentence at line 1313 |
| D-06 | Prune re-exports (subset only) | Full 13-symbol audit completed; only 3 are prunable, all others have test or active-script importers — see table below |
| D-07 | Realign `ix_games_bestmove_backfill_pending` | Confirmed exact predicate drift, confirmed migration precedent (non-concurrent), confirmed byte-identical-text convention (`alembic-check drift lesson`) |
| D-08 | No worker upgrade | Confirmed by D-05/D-06 findings — no live endpoint or wire-format symbol touched |
| D-09 | NOT-deletable fence | Confirmed all fenced items present, undisturbed by every proposed edit |

</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Eval job tier scheduling (claim priority) | API / Backend (`eval_queue_service.py`) | Database (partial indexes) | Pure server-side scheduling logic; no client/browser involvement |
| Backward-compat symbol re-export | API / Backend (`eval_drain.py` module namespace) | — | Python import-graph hygiene, not a runtime architectural boundary |
| Worker protocol docstrings | API / Backend (`eval_remote.py` router) | — | Documentation only; the actual protocol (routes, schemas) is untouched — D-08 |
| Partial index predicate | Database / Storage | API / Backend (query that the index serves) | The fix is DB-schema-only; `_claim_tier4_bestmove`'s SQL is unchanged, only the index catalog entry moves to match it |
| One-shot backfill scripts | Ops / Scripts tier (outside the 5-tier web stack) | Database (they write directly via SQLAlchemy) | These are operator-run CLI tools, not part of any request path — archiving them has zero runtime-architecture impact |

This phase touches **zero** Browser/Client or CDN/Static tier code — it is entirely API/Backend + Database (migration) + Ops/Scripts. That absence of frontend surface is itself a useful planning signal: no `npm run lint`/`npm test` impact expected, only the backend pre-merge gate applies.

## Package Legitimacy Audit

**Not applicable — this phase installs no new packages.** All work is deletion/archival/documentation of existing first-party code; no `pip`/`npm`/`cargo` dependency changes. Skip the Package Legitimacy Gate protocol entirely.

## Verified Facts vs. Seed Drift

### 1. Tier 2 in `eval_queue_service.py` — SIGNIFICANT DRIFT from seed's implied framing

The seed lists "Tier 2" as a "safe-to-delete" item alongside real code (`resweep_holed_games`). In the current tree there is **no `TIER_2` constant to delete** — `app/models/eval_jobs.py:12-13` already documents: *"(tier 2 was an automatic recency window; its only enqueue path was removed in Phase 118, and Phase 149-04 removed the then-callerless tier-2 constant.)"* `_claim_queued_job` (the only function that would handle a tier-2 row) uses a **tier-agnostic** claim SQL (`ORDER BY ej.tier ASC ... FOR UPDATE OF ej SKIP LOCKED`, `eval_queue_service.py:247-280`) — it was never tier-2-specific, so there is no branch to delete.

**What D-03 actually resolves to — a docstring/comment trim, not a deletion:**

| Location | Current text | Fix |
|---|---|---|
| `eval_queue_service.py:1-14` (module docstring) | 12-line "Tier 2 — unused..." explanatory paragraph | Condense to 1-2 lines noting it's fully retired (Phase 118 enqueue removal + Phase 149-04 constant removal), or drop entirely — the claim SQL comment on line 14 ("tier-agnostic... would transparently pick up a future tier-2 row without changes") is the only part worth keeping, since it explains *why* the SQL doesn't need touching |
| `eval_queue_service.py:232` | `_claim_queued_job` docstring: *"Claim one pending tier-1 or tier-2 job..."* | *"Claim one pending tier-1 job..."* (or generalize: "the next queued tier" if you want to preserve forward-compat framing) |
| `eval_queue_service.py:790` | `claim_eval_job` docstring: *"tier-1 > tier-2 > tier-3 > tier-4 (derived)"* | *"tier-1 > tier-3 > tier-4 (derived)"* |
| `eval_queue_service.py:842` | `# Attempt tier-1 / tier-2 pick in a fresh short transaction.` | `# Attempt tier-1 pick in a fresh short transaction.` |
| `eval_queue_service.py:864` | `# Tier-1 explicit jobs above are never gated; tier-2 has no enqueue source` | Fine as-is (accurate) or fold into the trimmed module docstring |
| `eval_queue_service.py:957` | `release_job` docstring: *"...tier-2 job it cannot hand a real lease payload to..."* | *"...tier-1 job it cannot hand..."* |
| `app/models/eval_jobs.py:10-15,32` | Class/column comment already correctly describes tier 2 as removed | Optional light trim for consistency; not stale, lower priority than the `eval_queue_service.py` items D-03 explicitly names |

**Related but out of D-03's named scope (planner's discretion whether to bundle):** `app/routers/eval_remote.py:17,430` and `app/services/eval_drain.py:861` also say "tier-1 > tier-2 > tier-3" in docstrings. D-03 names only `eval_queue_service.py`; D-05 names only the `/lease`/`/submit` claim in `eval_remote.py`. These three lines are the same kind of staleness but weren't explicitly called out — flag for the planner to decide whether "no live references" verification extends to them or is scoped strictly to the named file.

### 2. CRITICAL PITFALL: "tier 2" / "Tier-2" is a five-way homonym in this codebase

A blind `grep -ri "tier.2"` returns **5 unrelated subsystems**, not one. Do NOT touch these while doing D-03 — they have nothing to do with `eval_jobs.tier`:

| File | "Tier 2" means |
|---|---|
| `app/schemas/imports.py:85`, `app/routers/imports.py:227`, `app/repositories/user_benchmark_percentiles_repository.py:134`, `app/services/percentile_compute_registry.py:3`, `app/services/user_benchmark_percentiles_service.py:555` | **Import readiness tier** (`GET /imports/readiness` tier1/tier2 signal) — a totally different concept gating when the frontend shows percentile data |
| `app/services/endgame_service.py:3369,3448`, `app/schemas/endgames.py:735` | **D-10 endgame combo tier** — a data-completeness bucket for endgame WDL combos |
| `app/services/tactic_detector.py:116,2337,2445,2500,2516,2522,2576-2580` | **Tactic-motif detector priority tier** (Tier 2 = "geometric material-winners") — an entirely separate severity-ranking system |
| `app/services/import_service.py:693`, `app/services/eval_drain.py:389` | Same import-readiness Tier 2 as row 1 (the "3s readiness poll... unlock Tier 2" comments) |
| `app/services/import_service.py:710`, `app/middleware/last_activity.py:119` | **This IS the real eval_jobs tier-2** (accurate historical notes: "the tier-2 auto-enqueue that used to fire here was removed in Phase 118") — correct as-is, optional cleanup only |

The planner's verification step for D-03 ("no live references") must grep scoped to `eval_queue_service.py`, `eval_jobs.py`, `eval_drain.py`, `eval_remote.py`, and `tests/` — a repo-wide grep for "tier 2" will produce false positives across 3 unrelated subsystems.

### 3. `eval_drain.py:63-105` re-export audit — full symbol-by-symbol verdict (D-06)

All 13 symbols carry a `# noqa: F401 — backward-compat re-export (...)` tag. Verified importer set per symbol (both `from ... import X` AND `module.X` attribute-access patterns — some tests do `import app.services.eval_drain as eval_drain` then call `eval_drain._apply_full_eval_results(...)`, which a naive `from ... import` grep misses):

| Symbol | Source module | Noqa comment says | Actual importers found | Verdict |
|---|---|---|---|---|
| `MAX_EVAL_ATTEMPTS` | eval_apply | tests | `tests/services/test_full_eval_drain.py`, `tests/test_eval_worker_endpoints.py` | **STAYS** |
| `_apply_full_eval_results` | eval_apply | tests/scripts | `tests/services/test_full_eval_drain.py` (attribute access `eval_drain._apply_full_eval_results`, 4 call sites), `scripts/backfill_best_move_pv.py` (comment only, not imported) | **STAYS** |
| `_assemble_flaw_blobs_from_submit` | eval_apply | tests | `tests/test_eval_worker_endpoints.py` (4 import sites), `scripts/backfill_multipv.py` (also imports it) | **STAYS** |
| `_assemble_one_line_blob` | eval_apply | tests | `tests/services/test_eval_drain.py` (6 import sites) | **STAYS** |
| `_batch_update_best_move_rows` | eval_apply | scripts | `scripts/backfill_best_move_pv.py` ONLY | **PRUNABLE** |
| `_batch_update_flaw_pv_lines` | eval_apply | scripts | `scripts/backfill_multipv.py` ONLY (eval_remote.py's identically-named-sounding usage is actually a *different* direct import from `eval_apply`, not this re-export — see below) | **PRUNABLE** |
| `_batch_update_pv_rows` | eval_apply | scripts | `scripts/backfill_best_move_pv.py` ONLY | **PRUNABLE** |
| `_build_flaw_blob_lease_positions` | eval_apply | tests/scripts | `tests/services/test_eval_drain.py` (3x), `tests/test_eval_worker_endpoints.py` (1x), `scripts/backfill_multipv.py` | **STAYS** |
| `_build_line_blobs` | eval_apply | tests | `tests/services/test_eval_drain.py` (4x) | **STAYS** |
| `_walk_pv_boards` | eval_apply | scripts | `scripts/remote_eval_worker.py` — **the ACTIVE, non-archived remote worker driver, not one of the 7 archive candidates** | **STAYS** |
| `_EvalTarget` | eval_entry | tests/eval_remote.py | `tests/services/test_eval_drain.py:881` — `eval_remote.py` imports its OWN copy directly from `eval_entry` (line 114), not via this re-export | **STAYS** (test-only now, comment slightly inaccurate but harmless) |
| `_collect_endgame_span_eval_targets` | eval_entry | import_service.py/tests | `tests/services/test_eval_drain.py` (5x) — `import_service.py` imports its own copy directly from `eval_entry` (line 41), not via this re-export | **STAYS** (test-only now) |
| `_collect_midgame_eval_targets` | eval_entry | import_service.py/tests | Same pattern as above | **STAYS** (test-only now) |

**Net result: only 3 of 13 are prunable** (`_batch_update_best_move_rows`, `_batch_update_pv_rows`, `_batch_update_flaw_pv_lines`) — all three exist solely to serve the two scripts being archived in this same phase (`backfill_best_move_pv.py` needs the first two, `backfill_multipv.py` needs the third). This is meaningfully narrower than a naive reading of "prune re-exports whose importers were archived" might suggest, since 10 of the 13 noqa comments claim script-only usage but are actually also test-imported (their comments are stale metadata, not code bugs — leave the noqa comments on the 10 that stay, since F401 still legitimately applies: nothing in `eval_drain.py` itself calls them).

**eval_remote.py does NOT depend on the re-export block at all** for these symbols — it imports `_apply_bestmove_submit`, `_assemble_flaw_blobs_from_submit`, `_batch_update_flaw_pv_lines`, `_build_flaw_blob_lease_positions`, etc. directly `from app.services.eval_apply import (...)` (lines 95-110) and `_EvalTarget` etc. directly `from app.services.eval_entry import (...)` (lines 113-120). It only imports `ENTRY_LEASE_BACKLOG_THRESHOLD`, `ENTRY_LEASE_BATCH_SIZE`, `ENTRY_LEASE_TTL_SECONDS`, `_load_pgns_for_games` from `eval_drain.py` (line 128) — none of which are re-export candidates (they're genuinely defined/owned by `eval_drain.py`, not pass-throughs). This confirms D-08 (no worker-facing change): the re-export prune touches zero symbols the live router depends on.

**Action for the 2 archived scripts losing their imports:** `scripts/backfill_best_move_pv.py:122-125` imports `_batch_update_best_move_rows, _batch_update_pv_rows` from `eval_drain`; `scripts/backfill_multipv.py:62-65` imports `_assemble_flaw_blobs_from_submit, _batch_update_flaw_pv_lines, _build_flaw_blob_lease_positions` from `eval_drain` (only `_batch_update_flaw_pv_lines` of these three is pruned — the other two stay in `eval_drain.py`, so 2 of the 3 lines in that import block need no change). Recommended: repoint the pruned symbols to import directly `from app.services.eval_apply import _batch_update_best_move_rows, _batch_update_pv_rows` / `_batch_update_flaw_pv_lines` — a 1-line edit per script, keeps them syntactically importable (mirrors this repo's own precedent: the 3 already-archived scripts in `scripts/archive/` were moved byte-identical via plain `git mv`, implying archived scripts are still expected to at least import cleanly, not left deliberately broken).

### 4. `eval_remote.py` stale `/lease`/`/submit` docstrings (D-05)

Exact current locations (near-zero drift from the seed's `~:428`/`~:1313`):

- **Module docstring, lines 1-8**: already CORRECTLY states the Gen-1 pair was deleted in Phase 149-03: *"the original Gen-1 POST /lease + POST /submit pair (and `_apply_submit`) has been deleted..."* This part is accurate and should NOT change.
- **Line 428-429** (`atomic_lease_eval_game` docstring): *"NEW endpoint pair (Phase 147 SEED-074 Part B, D-02) — does NOT modify /lease or /submit; both stay live and deprecated for a mixed-fleet deploy."* — **STALE**: contradicts the module docstring 20 lines above it. Both `/lease` and `/submit` are gone, not "live and deprecated." Fix: delete this sentence, or replace with a note that the Gen-1 pair was already removed pre-this-phase and this endpoint's "additive, non-modifying" framing is now moot / historical context only.
- **Line 1313-1314** (`atomic_submit_eval` docstring): *"NEW endpoint pair (paired with /atomic-lease, 147-04) — does NOT modify /submit or /flaw-blob-submit; both stay live for a mixed-fleet deploy."* — **PARTIALLY STALE**: `/submit` is gone (same error as above); `/flaw-blob-submit` is genuinely still live (confirmed via `@router.post("/flaw-blob-submit", ...)` at line 985 — this is the tier-4/4b endpoint D-09 fences as NOT-deletable). Fix must be surgical: remove only the `/submit` half of the claim, keep the `/flaw-blob-submit` half accurate.
- **Line 1315-1316** (same docstring, next sentence): *"Unlike the old /submit (which always defers blobs to a separate tier-4 round-trip)..."* — this is retrospective/historical framing ("the old /submit"), already correctly past-tense. No fix needed.

**Full current endpoint inventory** (confirmed via `grep -n '@router.post' eval_remote.py`), all 8 live and NONE of them the deleted Gen-1 pair: `/atomic-lease`, `/entry-lease`, `/entry-submit`, `/flaw-blob-lease`, `/flaw-blob-submit`, `/atomic-submit`, `/bestmove-lease`, `/bestmove-submit`. This confirms D-09's fence (`flaw-blob-lease/submit`, `bestmove-lease/submit` all present) and D-08 (nothing here changes shape).

### 5. Index realignment (D-07)

**Current index** (`app/models/game.py:97-104`):
```python
Index(
    "ix_games_bestmove_backfill_pending",
    "user_id",
    postgresql_where=sa.text(
        "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        " AND lichess_evals_at IS NULL"
    ),
),
```

**Current query predicate** (`app/services/eval_queue_service.py`, both `_claim_tier4_bestmove`'s Stage-1 EXISTS subquery and Stage-2 WHERE, verbatim identical in both places):
```sql
g.full_pv_completed_at IS NOT NULL AND g.best_moves_completed_at IS NULL
```
No `lichess_evals_at` clause — confirmed dropped by quick 260719-fsz (the module docstring at `eval_queue_service.py:38-44` and the function's own docstring both document this deliberately: guest + lichess-eval orphans must self-heal through this lane now).

**Target fix** — drop the trailing clause so predicates match exactly:
```python
Index(
    "ix_games_bestmove_backfill_pending",
    "user_id",
    postgresql_where=sa.text("full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"),
),
```

**Migration precedent** — this repo has an explicit, documented convention for `games`-table partial-index migrations, spelled out in the migration this one directly follows (`alembic/versions/20260716_171823_..._phase_174_07_lichess_best_move_backfill_.py`):

> *"Created non-concurrently (inside transaction), following the project's other partial-index migrations (`ix_games_user_evals_pending`, `ix_games_full_pv_pending`, `ix_games_needs_engine_full_evals`, `ix_games_pv_backfill_pending`): migrations run against a quiescent backend at container startup, and CONCURRENTLY cannot run in a transaction."*

Confirmed independently: `deploy/entrypoint.sh` runs `alembic upgrade head` **before** `exec uvicorn ...` — the new container never serves traffic until migrations finish, so there is no live-query contention to protect against with `CONCURRENTLY`. **Do not introduce `CONCURRENTLY` for the first time in this migration** — it would be inconsistent with 5+ prior migrations on the same table and adds complexity (can't run in a transaction, needs `autocommit_block()`) for zero benefit in this deployment model. Follow the exact shape of the 174-07 migration: `op.drop_index(...)` then `op.create_index(...)`, both with an explicit `postgresql_where=sa.text(...)` matching argument for `downgrade()` symmetry.

**Migration mechanics:**
- Current alembic head: `f09f8dee4aee` (`20260724_043548_..._add_user_import_settings.py`) — this migration's `down_revision` must be `f09f8dee4aee`.
- Generate via `uv run alembic revision -m "realign ix_games_bestmove_backfill_pending predicate"` (hand-write the body — this is a predicate-only index change, `--autogenerate` may or may not detect a `postgresql_where` text diff reliably; verify by diffing the generated file against the target below).
- **Byte-identical-text requirement** (explicitly flagged in `game.py:95-96`'s own comment: *"postgresql_where text MUST stay byte-identical to the migration's create_index call (174-07 alembic-check drift lesson)"*): the model's `sa.text(...)` string and the migration's `op.create_index(..., postgresql_where=sa.text(...))` string must be character-for-character identical, or a future `alembic revision --autogenerate` will detect a phantom diff and emit a spurious no-op migration.
- `downgrade()` must restore the 3-clause predicate exactly as it exists today (for rollback symmetry) — copy verbatim from the current `game.py` text before editing it.
- Cost/urgency: per the seed's 2026-07-23 verification, tier-4b's backlog is essentially drained (~415k lottery finished), so the predicate mismatch currently only means "the query does a less-optimal scan against a stale-shaped partial index catalog entry" on a near-empty matching set — there is no active incident, low urgency, safe to do as a plain migration.

### 6. `resweep_holed_games` docstring rewrite (D-01)

Current function: `app/services/eval_drain.py:1151-1289` (no drift from seed's cited range). Docstring body: lines 1156-1193.

**Keep unchanged** (SEED-045/SEED-049 hole-definition logic, still correct and load-bearing):
- Lines 1163-1174: the "hole" definition (`eval_cp IS NULL AND eval_mate IS NULL AND ply < MAX(ply) - 1`), the terminal-ply exclusion rationale, and the SEED-049 game-ending-move exclusion (`_GAME_ENDING_PLY_OFFSET`).
- Lines 1176-1193: scope note (engine games only), Args, Returns, prod usage examples.

**Rewrite** (lines 1156-1162 — the motivating "why" paragraph):

Current:
> *"Before Phase 119, the drain stamped full_evals_completed_at unconditionally (D-116-07), so games with transient mid-game engine holes were permanently marked 'fully analyzed' with gaps. This sweep finds those games and clears their completion markers so the bounded-retry drain re-picks them with a fresh MAX_EVAL_ATTEMPTS budget."*

Verified replacement framing (per D-01, citing the actual current mechanism at `app/services/eval_apply.py:714` / Path C at lines 739-743 — **exact line-number match to CONTEXT.md's citation, zero drift**):
> *"Permanent manual re-arm tool for Path-C mid-game holes — NOT pre-Phase-119 legacy. `apply_completion_decision` (`eval_apply.py`, Path C) deliberately stamps a game's completion markers WHEN `current_attempts + 1 >= MAX_EVAL_ATTEMPTS`, even though `failed_ply_count > 0` — this is the EXPECTED terminal state of the bounded-retry drain, not a bug (see that function's own docstring). A weak or slow remote worker that repeatedly fails the same plies recreates this holed-stamped population go-forward — there is no population-exhaustion date. This sweep clears the completion markers for such games so the drain re-picks them with a fresh MAX_EVAL_ATTEMPTS budget. (Historical note: before Phase 119 introduced the bounded-retry Path A/B/C decision tree, the drain stamped unconditionally with no retry budget at all — D-116-07 — so this tool's original 2026 motivation was cleaning up that one-time backlog. The tool has remained load-bearing ever since as the only way to re-arm Path-C-stamped holes.)"*

`scripts/resweep_holed_games.py`'s own docstring (lines 1-16) is already neutral/mechanically accurate (no "legacy"/"population gone" framing) — it does not require the same correction, though the planner may optionally add a one-line "still load-bearing, not legacy" note for consistency with the rewritten function docstring, since the seed itself listed the *script* for deletion.

### 7. Test-suite impact map

No test file needs new test cases — this phase changes zero runtime behavior (docstrings, dead-comment trims, a byte-identical-predicate index swap, and file moves that preserve import paths for everything except the 3 pruned re-exports). The impact is entirely "does the existing suite still pass unchanged":

| Test file | What it exercises | Impact |
|---|---|---|
| `tests/services/test_eval_queue.py` (42 tests, confirmed green baseline: `42 passed in 7.76s`) | Tier-1/3/4/4b claim logic via literal `tier=2` inserts (round-robin, TC-ordering, lease-expiry tests use `tier=2` as an arbitrary non-explicit tier value — NOT testing a "tier 2 feature") | **No change required.** `eval_jobs.tier` has no CHECK constraint restricting values (confirmed — plain `SmallInteger`), so `tier=2` remains valid to insert; the claim SQL is unaffected by the docstring trim. Optional: rename these literals to a different arbitrary value (e.g. keep 2, or use `TIER_IDLE_BACKLOG`-adjacent) purely for readability — functionally inert either way. |
| `tests/services/test_eval_drain.py` | Imports `_assemble_one_line_blob`, `_build_line_blobs`, `_build_flaw_blob_lease_positions`, `_EvalTarget`, `_collect_endgame_span_eval_targets`, `_collect_midgame_eval_targets` from `eval_drain` | **Must still pass unchanged** — none of these are in the 3-symbol prune list |
| `tests/services/test_full_eval_drain.py` | Imports/attribute-accesses `MAX_EVAL_ATTEMPTS`, `_apply_full_eval_results`, `OPENING_CACHE_BACKFILL_SQL`, `resweep_holed_games` (4 call sites, lines ~3652/3726/3781/4148) from `eval_drain` | `resweep_holed_games` tests exercise its **behavior**, not its docstring — must still pass after the D-01 docstring rewrite (docstring-only edit). Confirms `resweep_holed_games` is actively tested, reinforcing D-01's "load-bearing" framing. |
| `tests/test_eval_worker_endpoints.py` | Imports `_assemble_flaw_blobs_from_submit`, `_build_flaw_blob_lease_positions`, `MAX_EVAL_ATTEMPTS`, `_FullPlyEvalTarget`, `_upsert_opening_cache`, `ENTRY_LEASE_*` from `eval_drain` | **Must still pass unchanged** — none pruned |
| `tests/test_remote_eval_worker.py` | References `_walk_pv_boards` (comment only, no import) | No import-path risk; this file tests `scripts/remote_eval_worker.py` behavior, which itself imports `_walk_pv_boards` from `eval_drain` (stays) |
| `tests/services/test_import_service.py` | Comments mention `_collect_midgame_eval_targets`/`_collect_endgame_span_eval_targets` but does NOT import them (import_service.py imports its own copy from `eval_entry` directly) | No impact |
| No test file imports `_batch_update_best_move_rows`, `_batch_update_pv_rows`, or `_batch_update_flaw_pv_lines` from `eval_drain`, from `eval_apply`, or via attribute access anywhere in `tests/` (confirmed via repo-wide grep) | — | **Safe to prune all 3** |

**Scripts to smoke-check after archival + re-export prune** (import-only check, no DB needed — `python -c "import ast; ast.parse(open('scripts/X.py').read())"` won't catch import errors; use `uv run python -c "import scripts.backfill_best_move_pv"` style or just run `--help`/`--dry-run` guard, since these scripts do `sys.path.insert` + module-level imports that fail loudly if unresolved):
- `scripts/backfill_best_move_pv.py` — needs its `eval_drain` import repointed to `eval_apply` for `_batch_update_best_move_rows`, `_batch_update_pv_rows`
- `scripts/backfill_multipv.py` — needs its `eval_drain` import repointed to `eval_apply` for `_batch_update_flaw_pv_lines` only (its other two imports, `_assemble_flaw_blobs_from_submit` and `_build_flaw_blob_lease_positions`, stay in `eval_drain` — no change needed there)

## Standard Stack

Not applicable — no new libraries or frameworks introduced. All work uses the existing FastAPI/SQLAlchemy/Alembic/pytest stack already in place.

## Architecture Patterns

No new patterns introduced. This phase follows two existing, already-precedented patterns:

### Pattern 1: Script archival via plain `git mv`
**What:** Move a completed one-shot script from `scripts/` to `scripts/archive/` with zero content changes — a pure rename, confirmed via `git show --stat` on the precedent commit (`1d74a8e8`, 3 files, "3 files changed, 0 insertions(+), 0 deletions(-)").
**When to use:** A script has no ongoing reuse value and is not imported by tests, CI, skills, `bin/`, or live app docstrings.
**Example:**
```
git mv scripts/backfill_eval.py scripts/archive/backfill_eval.py
git mv scripts/backfill_full_evals.py scripts/archive/backfill_full_evals.py
git mv scripts/backfill_best_move_pv.py scripts/archive/backfill_best_move_pv.py
git mv scripts/backfill_multipv.py scripts/archive/backfill_multipv.py
git mv scripts/backfill_opening_eval_cache.py scripts/archive/backfill_opening_eval_cache.py
git mv scripts/snapshot_tactic_counts.py scripts/archive/snapshot_tactic_counts.py
git mv scripts/backfill_accuracy_acpl.py scripts/archive/backfill_accuracy_acpl.py
```
Two of these (`backfill_best_move_pv.py`, `backfill_multipv.py`) additionally need a 1-line import fix (see item 3 above) as part of the same commit, since this phase simultaneously prunes 3 symbols they depend on — this is new territory relative to the 3-script precedent, which needed zero content changes because nothing in that batch had a re-export dependency being pruned in the same commit.

### Pattern 2: Non-concurrent partial-index migration on `games`
**What:** `op.drop_index(...)` + `op.create_index(..., postgresql_where=sa.text(...))`, both plain (no `postgresql_concurrently=True`), run inside the transactional migration.
**When to use:** Any `games`-table partial-index predicate change, given this repo's deploy-time-migration-before-traffic model.
**Example:**
```python
# Source: alembic/versions/20260716_171823_1eda5daba951_phase_174_07_lichess_best_move_backfill_.py (precedent)
def upgrade() -> None:
    op.drop_index(
        "ix_games_bestmove_backfill_pending",
        table_name="games",
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
            " AND lichess_evals_at IS NULL"
        ),
    )
    op.create_index(
        "ix_games_bestmove_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        ),
    )

def downgrade() -> None:
    op.drop_index(
        "ix_games_bestmove_backfill_pending",
        table_name="games",
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
        ),
    )
    op.create_index(
        "ix_games_bestmove_backfill_pending",
        "games",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text(
            "full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL"
            " AND lichess_evals_at IS NULL"
        ),
    )
```
Remember to update `app/models/game.py:97-104`'s `Index(...)` call with the byte-identical new predicate text in the SAME commit as the migration (both must agree, per the drift-lesson comment already in that file).

### Anti-Patterns to Avoid
- **Repo-wide "tier 2" grep-and-replace:** would corrupt 3 unrelated subsystems (import readiness, endgame combos, tactic detector). Scope every grep to the eval-pipeline file cluster.
- **Introducing `CONCURRENTLY` "to be safe":** inconsistent with 5+ prior migrations on this exact table, adds transaction-block complexity for a deployment model where it provides zero benefit (migrations always run pre-traffic).
- **Deleting a re-export because its noqa comment says "scripts" without checking test imports too:** 10 of 13 noqa comments in `eval_drain.py:63-105` under-claim their actual importer set (they say "scripts" or "tests" but several are imported by tests despite an eval_apply/eval_entry-sourced sibling being used elsewhere) — always verify with both `from ... import` AND `module.symbol` attribute-access grep patterns before pruning.

## Don't Hand-Roll

Not applicable — no reusable-problem territory here (no auth, no validation, no serialization). This is bespoke internal scheduling/migration code specific to this codebase's eval pipeline; there is no library that would replace it.

## Common Pitfalls

### Pitfall 1: Treating "tier 2" as a single grep target
**What goes wrong:** A repo-wide search for tier-2 references pulls in `imports.py`, `endgame_service.py`, `tactic_detector.py` — unrelated systems that happen to use the word "tier."
**Why it happens:** "Tier" is a generic English word reused across 5 independent priority/completeness concepts in this codebase.
**How to avoid:** Scope every D-03 verification grep to `app/services/eval_queue_service.py`, `app/models/eval_jobs.py`, `app/services/eval_drain.py`, `app/routers/eval_remote.py`, and `tests/` — never repo-wide.
**Warning signs:** A grep result touching `endgame_service.py`, `tactic_detector.py`, or `imports.py`/`user_benchmark_percentiles_*.py` is a false positive.

### Pitfall 2: Pruning a re-export based on its noqa comment alone
**What goes wrong:** `_batch_update_best_move_rows`'s noqa comment says "scripts" — correct, prunable. But several siblings with similarly narrow-sounding comments (`_EvalTarget`: "tests/eval_remote.py", `_collect_midgame_eval_targets`: "import_service.py/tests") turn out to be test-only NOW because the "other" importer (`eval_remote.py`, `import_service.py`) actually imports its own copy directly from the real source module (`eval_apply`/`eval_entry`), not through this re-export at all. The comment describes history, not current reality.
**Why it happens:** These comments were accurate when written but the "other" caller was refactored to import directly at some point, and the noqa comment was never updated.
**How to avoid:** For every candidate symbol, grep BOTH `from app.services.eval_drain import <symbol>` AND `eval_drain\.<symbol>`/`drain_module\.<symbol>`/`eval_drain_module\.<symbol>` (module-alias attribute access) across `tests/`, `scripts/`, and `app/` before deciding.
**Warning signs:** `ruff check` would catch an accidental prune of a still-used symbol as an `ImportError` at test collection time, not at lint time — so a mid-prune mistake surfaces as a hard pytest failure, not a soft warning. Run the affected test files (`test_eval_drain.py`, `test_full_eval_drain.py`, `test_eval_worker_endpoints.py`) immediately after each individual symbol removal, not just once at the end.

### Pitfall 3: Assuming the seed's line numbers are still accurate without re-checking
**What goes wrong:** SEED-115 is dated 2026-07-23; Phase 187 (guest cleanup) and various quicks landed in the interim. Trusting cited line numbers verbatim risks editing the wrong code.
**Why it happens:** Files drift even over a single day in an actively-developed repo.
**How to avoid:** This research re-verified every cited location against the live tree (2026-07-24) — drift was minimal (all locations matched within a few lines, `resweep_holed_games` matched exactly), but the planner's task-level `Read` calls should still re-confirm line numbers immediately before each `Edit`, since execution may run hours or days after this research.
**Warning signs:** An `Edit` tool `old_string` mismatch is the direct signal — treat it as "re-read the file," never as "force the edit anyway."

## Code Examples

### The tier-agnostic claim SQL that makes D-03 a documentation-only change
```sql
-- Source: app/services/eval_queue_service.py:247-280 (_claim_queued_job)
WITH candidate AS (
    SELECT ej.id, ej.game_id, ej.user_id, ej.tier
    FROM eval_jobs ej
    JOIN games g ON g.id = ej.game_id
    JOIN users u ON u.id = ej.user_id
    WHERE ej.status = 'pending'
      AND (u.is_guest = false OR ej.tier = 1)
    ORDER BY
        ej.tier ASC,   -- <-- tier-agnostic: works for any integer tier value, no tier-2-specific branch exists
        ...
    LIMIT 1
    FOR UPDATE OF ej SKIP LOCKED
)
UPDATE eval_jobs ej SET status = 'leased', ... FROM candidate WHERE ej.id = candidate.id
RETURNING ej.id, ej.game_id, ej.user_id, candidate.tier
```

### `apply_completion_decision` Path C — the mechanism D-01's rewritten docstring must cite
```python
# Source: app/services/eval_apply.py:714,739-743 (verbatim, current tree)
async def apply_completion_decision(...) -> bool:
    """...
    C. failed_ply_count > 0 AND current_attempts + 1 >= MAX_EVAL_ATTEMPTS ->
       cap reached: stamp anyway (D-116-07 no-infinite-loop invariant),
       including best_moves_completed_at IFF maia_available, and invoke the
       caller-supplied on_path_c_capacity_reached callback exactly once. This
       is the EXPECTED terminal state of the bounded-retry drain, not an error.
    ...
    """
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Tier-2 automatic recency-window enqueue | Tier-3 idle-backlog derived pick (no eval_jobs row) covers the same "active users first" intent | Phase 118 | Tier 2's enqueue path removed; the `TIER_2` constant followed in Phase 149-04 |
| `resweep_holed_games` framed as "pre-Phase-119 cleanup, population gone" | Reframed (this phase, D-01) as "permanent Path-C re-arm tool" | Phase 119 introduced Path A/B/C; this phase (188) corrects the docstring to match | The tool never actually became obsolete — its documentation just never caught up to Phase 119's bounded-retry design |
| Gen-1 `/lease` + `/submit` worker protocol | Atomic `/atomic-lease` + `/atomic-submit` (Phase 147) | Deleted in Phase 149-03 (PRUNE-01) | `eval_remote.py`'s docstrings at 2 call sites still describe the deleted pair as "live and deprecated" — this phase's D-05 fixes that |
| `ix_games_bestmove_backfill_pending` predicate included `lichess_evals_at IS NULL` | `_claim_tier4_bestmove` dropped that clause (quick 260719-fsz, to admit lichess-eval orphan self-healing) | 2026-07-19 | Index predicate has been mismatched to its serving query for ~5 days at research time; D-07 realigns it |

**Deprecated/outdated:** The Gen-1 `/lease`+`/submit` endpoints and their `_apply_submit` implementation — fully deleted, only stale prose references remain (this phase's scope).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommending "fix the 2 archived scripts' imports" over "leave broken with a header note" (both options are explicitly sanctioned by CONTEXT.md D-06) | Verified Facts §3, Pattern 1 | Low — this is a discretionary style choice CONTEXT.md itself leaves open; either option satisfies D-06's letter. If the planner prefers the header-note route instead, no other part of this research changes. |
| A2 | `alembic revision --autogenerate` may not reliably detect a `postgresql_where` text-only diff, so the migration should be hand-written rather than autogenerated | Verified Facts §5 | Low — even if autogenerate does detect it correctly, hand-verifying the generated file against the target text is the same amount of work either way; this is a process note, not a technical risk |

**All other claims in this research were verified directly against the current tree via `Read`/`Bash grep` in this session** — no training-data guesses were used for line numbers, symbol names, or migration precedent (this is a pure internal-code-archaeology phase with no external library/API surface to look up).

## Open Questions (RESOLVED)

1. **RESOLVED (per recommendation — Task 1 bundles the optional tier-ordering docstring fix):** Should the D-03 "no live references" verification extend to the 3 out-of-scope-but-related "tier-1 > tier-2 > tier-3" docstring mentions in `eval_remote.py:17,430` and `eval_drain.py:861`?
   - What we know: CONTEXT.md's D-03 names only `eval_queue_service.py`; D-05 names only the `/lease`/`/submit` claim in `eval_remote.py`, not its tier-ordering mentions.
   - What's unclear: whether leaving these 3 mentions as-is (technically accurate about historical tier-2 existence, but describing dead code as if still relevant) counts as a gap in the "cognitive-load reduction" goal, or whether it's explicitly out of the locked scope.
   - Recommendation: bundle a 1-line fix into whichever task touches that docstring block anyway (D-05 already opens `eval_remote.py`'s docstrings), but do not treat it as blocking — CONTEXT.md's scope is precise enough that skipping these is a legitimate execution choice.

2. **RESOLVED (per recommendation — leave `tier=2` test literals as-is, zero-churn):** Should the literal `tier=2` values in `test_eval_queue.py` (round-robin/TC-ordering/lease-expiry tests) be renamed for clarity, now that "tier 2" carries zero semantic meaning?
   - What we know: functionally inert either way — no CHECK constraint, the claim SQL is tier-value-agnostic.
   - What's unclear: whether renaming (e.g., to a comment-only "arbitrary non-explicit tier" framing, still using the integer 2) improves or just churns the diff for a maintenance phase whose whole point is minimizing footprint.
   - Recommendation: leave as-is unless the planner wants a one-line comment added at each `tier=2` insert clarifying "arbitrary non-tier-1 value, not testing a real tier-2 feature" — purely cosmetic, zero functional risk either way.

## Environment Availability

Skipped — this phase has no new external dependencies. It uses only the already-verified local stack: Docker Postgres 18 (dev DB confirmed running and healthy at research time), `uv`/pytest (confirmed: `tests/services/test_eval_queue.py` — 42 passed in 7.76s baseline), and Alembic (confirmed current head `f09f8dee4aee`).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (async, `pytest-asyncio`), confirmed via `uv run pytest` |
| Config file | `pyproject.toml` / `pytest.ini` (existing, unmodified) |
| Quick run command | `uv run pytest tests/services/test_eval_queue.py tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py tests/test_remote_eval_worker.py -x` |
| Full suite command | `uv run pytest -n auto` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| D-01 | `resweep_holed_games` behavior unchanged after docstring rewrite | unit/integration | `uv run pytest tests/services/test_full_eval_drain.py -k resweep -x` | ✅ (4 existing call sites) |
| D-02 | Tiers 4/4b claim behavior unchanged (no code touched) | unit | `uv run pytest tests/services/test_eval_queue.py -k "Tier4 or bestmove" -x` | ✅ |
| D-03 | `eval_queue_service.py` claim logic unchanged after docstring trim | unit | `uv run pytest tests/services/test_eval_queue.py -x` | ✅ (42 tests, confirmed green baseline) |
| D-04 | 7 archived scripts still import cleanly; 2 repointed-import scripts still parse/import | smoke | `uv run python -c "import ast; ast.parse(open('scripts/archive/backfill_best_move_pv.py').read())"` per file, plus a real `import` smoke test for the 2 repointed ones (`uv run python -c "import scripts.archive.backfill_best_move_pv"` — will fail loudly on any unresolved import) | ❌ — no existing test imports these scripts directly; add a smoke check as a task action, not a pytest test (these are operator CLI tools, not app modules) |
| D-05 | `eval_remote.py` endpoints unchanged (docstring-only edit) | integration | `uv run pytest tests/test_eval_worker_endpoints.py -x` | ✅ |
| D-06 | Re-export prune doesn't break any importer | unit + collection | `uv run pytest tests/services/test_eval_drain.py tests/services/test_full_eval_drain.py tests/test_eval_worker_endpoints.py --collect-only` (a collection-time `ImportError` is the fastest signal a prune broke something — run this BEFORE the full run) then `-x` for real execution | ✅ |
| D-07 | Index predicate text matches `_claim_tier4_bestmove` query verbatim | structural (not a pytest behavior test — Postgres answers the query correctly regardless of index match, so functional tests can't catch drift) | Manual/scripted string-equality check: extract the `postgresql_where` text from `app/models/game.py`'s `Index(...)` call and from the migration's `op.create_index(...)` call, assert identical; additionally `uv run alembic upgrade head` on a scratch DB + `\d+ games` / `SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_games_bestmove_backfill_pending'` to confirm the live predicate matches `_claim_tier4_bestmove`'s WHERE clause (`full_pv_completed_at IS NOT NULL AND best_moves_completed_at IS NULL`) | ❌ — no existing test asserts index-predicate text; this is the one genuinely new verification artifact this phase needs (a small script or manual psql check, not necessarily a permanent pytest test) |
| D-08/D-09 | No worker protocol change, no fenced item touched | integration | Full `uv run pytest tests/test_eval_worker_endpoints.py tests/test_remote_eval_worker.py -x` plus a diff review confirming zero non-docstring lines changed in `eval_remote.py` | ✅ |

### Sampling Rate
- **Per task commit:** the quick run command above (targeted to the eval-pipeline test cluster, ~5 files)
- **Per wave merge:** `uv run pytest -n auto` (full suite) — cheap here since D-01 through D-09 touch a narrow, well-isolated file set; no reason to skip the full suite given this repo's `-n auto` parallel speed
- **Phase gate:** Full suite green + `uv run ty check app/ tests/` (zero errors, mandatory per CLAUDE.md) + `uv run ruff check app/ tests/` before `/gsd-verify-work`

### Wave 0 Gaps
- **D-07's index-predicate-text equality check has no existing home.** Recommend a throwaway verification step in the plan's own verification loop (not a permanent `tests/` file, since this is a one-time structural fact about a single migration, not an ongoing behavioral contract) — e.g. a shell one-liner comparing the two `sa.text(...)` strings, or a `psql -c "\d+ games"` against the dev DB post-migration.
- **D-04's "scripts still import cleanly" check has no existing home** for the same reason — these are operator CLI tools outside the `app/` package that pytest's collection never touches. A plan task action (not a persisted test file) covering all 7 archived scripts + explicit re-import verification for the 2 repointed ones is sufficient; no `tests/scripts/` directory exists in this repo and creating one for a one-time archival phase would be scope creep.
- No framework install needed — pytest/Alembic/uv are all already configured and confirmed working.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | Unchanged — `require_operator_token` (`eval_remote.py:163-193`, HMAC constant-time compare) is untouched by this phase; no auth code is edited |
| V3 Session Management | no | Not applicable to this maintenance phase |
| V4 Access Control | no | Not applicable — no endpoint added/removed/modified in behavior, only docstrings |
| V5 Input Validation | no | Not applicable — no new input surface; the index migration takes no request-supplied parameters |
| V6 Cryptography | no | Not applicable |

### Known Threat Patterns for this stack
Not applicable — this phase introduces zero new attack surface (no new endpoint, no new input parsing, no new SQL string composition beyond the already-reviewed `sa.text(...)` partial-index predicate, which is a fixed hardcoded literal with no bound parameters and no request-derived content, identical in shape to 5+ prior partial-index migrations in this repo). The one file with genuine security-sensitive content in scope (`eval_remote.py`'s `require_operator_token` dependency and the atomic-submit SF-version gate) is touched only at the docstring level — confirmed via the exact line ranges identified in Verified Facts §4, none of which overlap the auth dependency function (lines 163-193) or any `@router.post` handler body logic.

## Sources

### Primary (HIGH confidence — verified this session via direct file reads / grep / bash against the live repo)
- `app/services/eval_queue_service.py` (full file read) — tier scheduler, claim SQL, docstrings
- `app/models/eval_jobs.py` (full file read) — TIER_* constants, column/class comments
- `app/services/eval_drain.py` (targeted reads: 1-120, 380-395, 1140-1289) — re-export block, resweep function, homonym-check line
- `app/routers/eval_remote.py` (targeted reads: 1-30, 90-233, 415-460, 1300-1335) — stale docstrings, endpoint inventory, import sources
- `app/models/game.py` (lines 1-140) — index definitions, byte-identical-text convention comment
- `app/services/eval_apply.py` (lines 700-790) — `apply_completion_decision` Path A/B/C, exact D-01 citation match
- `app/services/import_service.py` (lines 680-712) — Tier-2-homonym disambiguation
- `app/middleware/last_activity.py` (lines 110-124) — Tier-2-homonym disambiguation
- `alembic/versions/20260716_171823_1eda5daba951_...py` and `alembic/versions/20260717_035706_939c3d99868d_...py` (full reads) — migration precedent, non-concurrent-index rationale, exact current index-creation code
- `deploy/entrypoint.sh` (full read) — confirms migrate-before-serve ordering
- `scripts/archive/backfill_user_percentiles.py` + `git show 1d74a8e8` — archival convention precedent
- `scripts/backfill_best_move_pv.py`, `scripts/backfill_multipv.py`, `scripts/remote_eval_worker.py`, `scripts/resweep_holed_games.py` (targeted reads) — script import verification
- `tests/services/test_eval_queue.py`, `tests/services/test_eval_drain.py`, `tests/services/test_full_eval_drain.py`, `tests/test_eval_worker_endpoints.py` (targeted reads + full-repo grep) — importer verification for D-06
- Baseline test run: `uv run pytest tests/services/test_eval_queue.py -q` → `42 passed in 7.76s`
- `.planning/config.json` — `nyquist_validation: true`, no `security_enforcement` key (treated as enabled)

### Secondary (MEDIUM confidence)
None — every claim in this document was verified against the live tree, not inferred from documentation or web search (this is an internal-code-only research phase with no external library surface).

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- Tier-2 removal scope (D-03): HIGH — verified the constant is already gone and the SQL is tier-agnostic by direct code read
- Re-export prune list (D-06): HIGH — every one of 13 symbols individually verified via both import-statement and attribute-access grep patterns
- Index realignment (D-07): HIGH — predicate mismatch confirmed by diffing live model code against live query code; migration precedent confirmed by reading the actual prior migration's own documented rationale
- Docstring staleness (D-05): HIGH — exact current line numbers read directly, near-zero drift from seed
- `resweep_holed_games` reframing (D-01): HIGH — `apply_completion_decision` Path C citation verified line-for-line against CONTEXT.md's own citation

**Research date:** 2026-07-24
**Valid until:** Short shelf life for exact line numbers (this is an actively-developed repo — re-verify line numbers immediately before each `Edit` at execution time) but the structural findings (which re-exports are prunable, which docstrings are stale, the migration precedent) are stable until another quick/phase touches these same files. Recommend re-verifying line numbers only, not re-doing the full importer audit, if execution happens within ~1 week of this research.
