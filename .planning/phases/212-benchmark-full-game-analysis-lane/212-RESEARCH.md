# Phase 212: Benchmark Full-Game Analysis Lane - Research

**Researched:** 2026-08-22
**Domain:** Internal pipeline engineering (SQLAlchemy async queue service, headless HTTP worker fleet, dual-Postgres benchmark harness) — no new external libraries
**Confidence:** HIGH (every file:line citation below was opened and read this session; no library/API research was needed)

## Summary

Phase 212 is not a "learn a new framework" phase — it is a "read four existing files closely and reuse their shape" phase. `212-CONTEXT.md` (from `/gsd-discuss-phase`) already locked every architectural decision (D-01 through D-16) with file:line precision. This document independently re-opened every cited file this session and confirms **all citations in CONTEXT.md are exact** — function names, line numbers, and quoted code all match byte-for-byte what is on disk today. Nothing in CONTEXT.md needs correcting.

The buildable work is four small, independently testable pieces, none of them prod-side:

1. A **selection script + two ORM models** (`benchmark_selection`, `benchmark_lichess_eval_snapshot`) that follow the **already-proven Phase 69 INFRA-02 pattern** — `Base.metadata.create_all(tables=[...])` from a script, deliberately outside the canonical Alembic chain. Two live examples already exist to copy verbatim: `app/models/benchmark_selected_user.py` + `scripts/select_benchmark_users.py:363-369`, and `app/models/benchmark_ingest_checkpoint.py` + `scripts/import_benchmark_users.py:210-216`.
2. A **config-gated `WHERE EXISTS` narrowing** on all four lottery predicate sites in `app/services/eval_queue_service.py` (`_claim_tier3_derived` Step 1 + Step 2, `_claim_tier4_blob`, `_claim_tier4_bestmove`), all built on the shared `_es_weighted_user_pick`/`_es_weighted_game_pick` helpers — one predicate change point per caller, not four independent rewrites.
3. A **dual-URL fallback patch** to `scripts/remote_eval_worker.py` — the tricky part is that `_run_cycle` (the 5-rung ladder) currently returns only a "should stop" bool, and `run_worker` builds exactly **one** `httpx.AsyncClient` with a fixed `base_url` and headers at construction time (`:1186-1191`). Strict per-claim prod priority means running the whole 5-rung ladder against a **second, independently-constructed client** only after the first client's ladder returns "all 204."
4. A **local backend instance** (`uvicorn app.main:app --port 8001 --host 0.0.0.0`, `DATABASE_URL` repointed at `postgresql+asyncpg://flawchess_benchmark:...@localhost:5433/flawchess_benchmark`) with `EVAL_AUTO_DRAIN_ENABLED=true` and `BEST_MOVE_BACKFILL_ENABLED=true` both set (config.py's existing AND-gate, `:83-98`), and the selection gate on.

**Primary recommendation:** Plan this phase as four independently-verifiable tasks/waves matching the four pieces above, each anchored on the exact file:line citations verified in this document — not as one monolithic "build the pipeline" task.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Candidate selection (`benchmark_selection` table) | Database / Storage | Script (one-shot, not a service) | Materialized table is the reproducibility record per CONTEXT.md — not a query that must replay |
| Lottery narrowing (`WHERE EXISTS`) | API / Backend (`app/services/eval_queue_service.py`) | — | Shared with prod's live lottery service; the narrowing is a config-gated SQL predicate inside the existing service, not a new service |
| Eval-source homogenization (`is_lichess_eval_game` override) | API / Backend (`app/services/eval_apply.py`) | — | Single derivation point (`:2344`); flag lives in `app/core/config.py` alongside the two existing eval-drain flags |
| Worker fan-out / fallback routing | External fleet process (`scripts/remote_eval_worker.py`) | — | Runs off-box (or on Adrian's LAN box), talks HTTP to whichever backend has work; not part of the FastAPI app tier |
| Full pipeline execution (Stockfish eval, PV, flaw classification) | API / Backend (existing `eval_apply.py`/`eval_drain.py`/`flaws_service.py`) | — | No new pipeline code — the local backend instance is the SAME app code as prod, pointed at a different DB |
| Maia best-move/gem inference | API / Backend (local backend process only) | — | `maia_engine` runs in-process on submit (`eval_apply.py:810`); cannot run on the remote worker fleet — this is the whole reason a local backend exists |
| Reporting / row-count snapshot | Script (`scripts/` entry point, `record` subcommand) | — | Mirrors `db-report`/`tactic-tagger-report`'s `reports/{topic}/{topic}-YYYY-MM-DD.md` precedent |

<phase_requirements>
## Phase Requirements

`REQUIREMENTS.md` does not yet exist for this milestone (Phase 212 predates it, same convention as Phases 206–211). Requirement IDs BENCHLANE-01..06 are minted at planning time, one per ROADMAP Success Criterion. The traceability table belongs in `212-01-PLAN.md`; this table maps each criterion to the research that supports it.

| ID (to mint) | ROADMAP Success Criterion | Research Support |
|----|-------------|------------------|
| BENCHLANE-01 | `benchmark_selection` table materializes the capped/random/eq-footing set as `(game_id, tc_tranche)`, per-TC | §"Schema provenance" below; `benchmark_selected_user.py` / `select_benchmark_users.py:363-369` precedent verified |
| BENCHLANE-02 | Config-gated `WHERE EXISTS` narrows the tier-3 candidate query, off by default, verifiably inert | §"Lottery narrowing" below; all four claim sites verified in `eval_queue_service.py`; D-09/D-10 gate-inertness test shape |
| BENCHLANE-03 | `remote_eval_worker.py` accepts ordered primary+fallback URLs, strict per-claim prod priority | §"Dual-URL worker fallback" below; `_run_cycle`/`_run_loop`/`run_worker` fully read and cited |
| BENCHLANE-04 | Second backend on 5433, Alembic head verified, full pipeline output on a small tranche | §"Dual backend / DB mechanics" below; `bin/benchmark_db.sh` and `DATABASE_URL_*` settings verified |
| BENCHLANE-05 | Eval-source homogeneity decided and implemented before classical starts | §"Eval-source homogeneity" below — **already decided in CONTEXT.md D-03/D-04/D-05**, not open |
| BENCHLANE-06 | Classical tranche completes (or stops at TC boundary), row counts recorded, post-run vacuum | §"Vacuum / row-count recording" below |

</phase_requirements>

<user_constraints>
## User Constraints (from CONTEXT.md)

**212-CONTEXT.md is unusually complete for this phase** — it already carries file:line-cited decisions D-01 through D-16, all independently re-verified in this document (see inline confirmations throughout). The planner's job is largely to sequence these into tasks/waves, not to make new architectural choices. Full CONTEXT.md is at `.planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md` — read it directly; do not rely on a paraphrase. Highlights:

### Locked Decisions (do not re-open)
- **D-01:** Both arms (lichess-eval + never-analyzed) run in the classical tranche — not deferred.
- **D-02:** One random draw per user across the whole eq-footing set (no stratification).
- **D-03:** Homogenize eval source via a benchmark-only config flag overriding `is_lichess_eval_game` to `False` in the drain WRITE path only, at the single derivation point `app/services/eval_apply.py:2344`.
- **D-04:** `lichess_evals_at` stays untouched — it remains the §6 selection marker; written in exactly one place (`app/services/import_service.py:1581`, confirmed this session — verbatim text `.values(lichess_evals_at=datetime.now(timezone.utc))`).
- **D-05:** Preserve original lichess evals in a benchmark-only side table (`benchmark_lichess_eval_snapshot(game_id, ply, eval_cp)`), populated at tranche start before the fleet touches anything.
- **D-06:** Mixed flaw provenance handled by documentation (a `benchmarks` SKILL.md note), not schema or exclusion.
- **D-07:** Both new tables follow the Phase 69 INFRA-02 precedent — ORM model on shared `Base`, created by targeted `Base.metadata.create_all(tables=[...])`, deliberately NOT in the canonical Alembic chain.
- **D-08:** Close the latent autogenerate table gap in `alembic/env.py:_include_object` (confirmed this session: `_include_object` at `:112-115` filters ONLY `type_ == "index"` — tables are never filtered, exactly as CONTEXT.md states).
- **D-09:** The selection gate applies to ALL lottery lanes — tier-3 Step 1 AND Step 2, tier-4 blob, tier-4b — not just tier-3.
- **D-10:** Gate inertness proven by three things: a byte-identical-predicate-when-off test, a bites-when-on test, and a boot assertion refusing to start with the gate on and the table missing.
- **D-11:** `EVAL_AUTO_DRAIN_ENABLED=true` AND `BEST_MOVE_BACKFILL_ENABLED=true` both mandatory on the local instance (confirmed AND-gate, `app/core/config.py:83-98`).
- **D-12:** Maia must load in the local backend process — `maia_available` (confirmed derivation point, `eval_apply.py:810` docstring, `:2457`/`:2583` `maia_engine.is_maia_available()` call sites) is the guardrail against silently stamping `best_moves_completed_at` with zero rows.
- **D-13:** Dual-URL fallback fires at the whole-ladder level — run the full 5-rung ladder against prod, only re-run the whole ladder against the benchmark backend when all five rungs return 204. `_run_cycle` needs to return "did work" not just "should stop" (confirmed: current signature returns only `bool` "should-stop", see §"Dual-URL worker fallback" below).
- **D-14:** An unreachable primary is treated as no-work and falls through to the benchmark backend, same as 204.
- **D-15:** The local backend is a submit/Maia service, not a Stockfish contributor — `STOCKFISH_POOL_SIZE=1` (confirmed default, `app/services/engine.py:148`), leaving Stockfish throughput to the fleet.
- **D-16:** One `scripts/` entry point with subcommands (select/snapshot/status/record) is the operator surface, following the established `scripts/` self-describing `--help` convention.

### Claude's Discretion
- Operator token naming for port 8001 (`EVAL_OPERATOR_TOKEN`-style second flag; fallback defaults to primary's).
- `benchmark_selection` column set beyond `(game_id, tc_tranche)`.
- Naming of the homogenization flag, the gate flag, and the two tables.
- Disk headroom / vacuum specifics (the seed's ~15 KB/game net, ~2× during-run figure, post-run vacuum stand as written).

### Deferred Ideas (OUT OF SCOPE)
- Re-running the benchmarks and diffing §5 after the classical tranche (measurement, not implementation, for this phase).
- Recovering the ~4,690 never-imported benchmark cohort users (a separate import effort).
- A second backend container on the prod host serving a sliced sibling DB (only relevant if a worker is genuinely off-LAN).
- Arm-level stop boundaries inside a TC tranche (beyond the locked TC boundaries).

</user_constraints>

## Standard Stack

No new external packages. Every piece of this phase is either (a) existing project code reused as-is (SQLAlchemy async, httpx, FastAPI/Uvicorn, pytest), or (b) a small amount of new code written in the same stack. **Package Legitimacy Audit is N/A — no packages to vet.**

### Core (existing, reused)
| Library | Version (verified) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| SQLAlchemy | 2.x async (already in `pyproject.toml`) | `Base.metadata.create_all(tables=[...])` for the two new benchmark-only tables | Existing project convention (INFRA-02) |
| httpx | already in `pyproject.toml`, used by `remote_eval_worker.py` | Two independently-constructed `AsyncClient`s (primary + fallback) for the dual-URL worker | `[VERIFIED: scripts/remote_eval_worker.py:1186-1191]` — the existing single-client pattern this phase extends |
| Uvicorn | already in `pyproject.toml` | Second `uvicorn app.main:app --port 8001` instance | Same binary, no config file, just `DATABASE_URL` env override |
| pytest / pytest-asyncio | already in `pyproject.toml`, `asyncio_mode = "auto"` (`[VERIFIED: pyproject.toml:65]`) | Gate-inertness tests (D-10), dual-URL fallback tests, `create_all` idempotency tests | Existing project test framework |

No version-bump or new-install work belongs in this phase's RESEARCH.md Standard Stack section — the recommendation is "write more code in the existing stack," not "adopt a new tool."

## Package Legitimacy Audit

Not applicable — this phase installs no external packages. Skipped per the protocol's own trigger condition (no installs).

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────┐
                    │  scripts/benchmark_lane.py (new, D-16)   │
                    │  subcommands: select | snapshot |        │
                    │  status | record                         │
                    └───────────────┬───────────────────────────┘
                                    │ writes (one-shot, per TC tranche)
                                    ▼
                    ┌─────────────────────────────────────────┐
                    │  Benchmark Postgres :5433                │
                    │  + benchmark_selection(game_id,          │
                    │      tc_tranche, ...)            [new]   │
                    │  + benchmark_lichess_eval_snapshot(      │
                    │      game_id, ply, eval_cp)      [new]   │
                    │  (created via create_all, NOT Alembic —  │
                    │   D-07/INFRA-02 precedent)                │
                    └───────────────┬───────────────────────────┘
                                    │ read by (config-gated WHERE EXISTS, D-09)
                                    ▼
        ┌───────────────────────────────────────────────────────────┐
        │  Local backend: uvicorn app.main:app --port 8001 :8000     │
        │  DATABASE_URL → :5433 benchmark DB                         │
        │  EVAL_AUTO_DRAIN_ENABLED=true                               │
        │  BEST_MOVE_BACKFILL_ENABLED=true  (both mandatory, D-11)   │
        │  BENCHMARK_SELECTION_GATE_ENABLED=true  (new flag)         │
        │  STOCKFISH_POOL_SIZE=1  (D-15: submit/Maia only)            │
        │                                                              │
        │  app/services/eval_queue_service.py                        │
        │    _claim_tier3_derived   (Step1 :458, Step2 same fn)      │
        │    _claim_tier4_blob      (:659)                           │
        │    _claim_tier4_bestmove  (:784)                           │
        │      all built on _es_weighted_user_pick (:295) /          │
        │      _es_weighted_game_pick (:388) — gate predicate         │
        │      attaches at these 2 shared builders' call sites       │
        │                                                              │
        │  app/services/eval_apply.py:2344                            │
        │    is_lichess_eval_game = game.lichess_evals_at is not None │
        │    ── D-03 override point (benchmark-only flag forces False)│
        │                                                              │
        │  app/services/eval_apply.py:810/2457/2583                   │
        │    maia_available = maia_engine.is_maia_available()  (D-12) │
        └───────────────────────┬─────────────────────────────────────┘
                                  │ HTTP (leases + submits)
                                  │ /atomic-lease /entry-lease /flaw-blob-lease
                                  │ /bestmove-lease  ... (existing 5-rung ladder)
                                  ▼
        ┌───────────────────────────────────────────────────────────┐
        │  scripts/remote_eval_worker.py  (patched, D-13/D-14)        │
        │                                                              │
        │  run_worker(base_url, token, ...)   ← TODAY: ONE client     │
        │    httpx.AsyncClient(base_url=..., headers={X-Operator-     │
        │      Token, X-Worker-Id})           (:1186-1191)            │
        │                                                              │
        │  NEW: two clients — primary (prod) + fallback (benchmark)   │
        │  _run_cycle(client, ...) → today returns bool "should-stop" │
        │    NEEDS: also signal "did work" so the wrapper knows       │
        │    all 5 rungs returned 204 before falling through          │
        │                                                              │
        │  Fallback wrapper:                                          │
        │    run primary._run_cycle() (full 5-rung ladder)            │
        │    if not did_work and not unreachable: continue idle loop  │
        │    if not did_work OR primary unreachable (D-14):           │
        │        run fallback._run_cycle() (full 5-rung ladder)       │
        └───────────────────────┬─────────────────────────┬───────────┘
                                  │ prod priority               │ fallback only
                                  ▼                              ▼
                    ┌─────────────────────┐         ┌─────────────────────────┐
                    │  Prod backend        │         │  Local backend :8001     │
                    │  flawchess.com       │         │  (same box as above)     │
                    └─────────────────────┘         └─────────────────────────┘
```

### Recommended Project Structure

No new top-level directories. New files land in existing conventional locations:

```
app/
├── models/
│   ├── benchmark_selection.py               # NEW (D-07 pattern)
│   └── benchmark_lichess_eval_snapshot.py    # NEW (D-07 pattern)
├── core/
│   └── config.py                             # +2 flags (gate + homogenization), mirrors :83-98
├── services/
│   └── eval_queue_service.py                 # narrowing predicate at 4 call sites
scripts/
└── benchmark_lane.py                          # NEW — select/snapshot/status/record (D-16)
scripts/remote_eval_worker.py                  # patched: --fallback-url, dual client, _run_cycle return shape
tests/
├── services/test_eval_queue.py                # extend: gate on/off byte-identity + bites tests (D-10)
├── test_remote_eval_worker.py                  # extend: fallback routing tests
└── test_benchmark_lane.py                      # NEW — mirrors test_benchmark_ingest.py's shape
```

### Pattern 1: Benchmark-only table via targeted `create_all` (INFRA-02, D-07)
**What:** ORM model on the shared `Base`, created by `Base.metadata.create_all(tables=[specific_table], checkfirst=True)` from a script — never added to `alembic/env.py`'s import list, never touched by `alembic revision --autogenerate`.
**When to use:** Any table that exists only in the benchmark DB and must never appear in dev/prod.
**Example (verified, `scripts/select_benchmark_users.py:363-372`):**
```python
# Create the benchmark_selected_users table on first invocation (INFRA-02:
# benchmark-only tables are not in the canonical Alembic chain). We pass the
# specific Table object via metadata.create_all(tables=[...]) so unrelated
# canonical tables (already created by Alembic) are not touched.
bench_table = cast(Table, BenchmarkSelectedUser.__table__)
async with engine.begin() as conn:
    await conn.run_sync(
        lambda sync_conn: BenchmarkSelectedUser.metadata.create_all(
            sync_conn, tables=[bench_table], checkfirst=True
        )
    )
```
Note the model file's own docstring states the rule verbatim (`app/models/benchmark_selected_user.py:1-6`): *"Created via Base.metadata.create_all() against the benchmark engine -- NOT in the canonical Alembic chain (INFRA-02 isolates the canonical schema; benchmark-only tables stay out of dev/prod/test)."*

**FK precedent to mirror for the new tables:** `benchmark_ingest_checkpoint.py:66-69` uses `ForeignKey("users.id", ondelete="SET NULL")` even on a benchmark-only table — CLAUDE.md's "FK constraints are mandatory" rule is respected here despite the table being outside Alembic. The two new tables should FK `game_id` to `games.id` with an explicit `ondelete` policy (likely `CASCADE`, since a snapshot/selection row for a deleted game is meaningless) — `benchmark_selected_user.py` itself does NOT FK (it stores a raw `lichess_username`, pre-import), so do not copy that file as the FK precedent; copy `benchmark_ingest_checkpoint.py` instead.

### Pattern 2: Config-gated predicate narrowing on shared ES-lottery builders
**What:** `_es_weighted_user_pick` (`app/services/eval_queue_service.py:295`) and `_es_weighted_game_pick` (`:388`) are the two building blocks all three lottery lanes (`_claim_tier3_derived` `:458`, `_claim_tier4_blob` `:659`, `_claim_tier4_bestmove` `:784`) call through, each supplying its own `candidate_where_sql`/`candidate_exists_sql`/`game_where_sql` fragment. **The narrowing is one predicate string, appended (as a bound, hardcoded SQL fragment — never f-string user input, per the module's own QUEUE-08 security convention) at each of the four call sites**, gated behind `if settings.BENCHMARK_SELECTION_GATE_ENABLED`.
**When to use:** This is the ONLY seam that reaches all four lanes — do not write a new query.
**Example shape (not yet in the codebase — illustrative composition matching the existing style):**
```python
# app/services/eval_queue_service.py — inside _claim_tier3_derived, Step 1
_selection_gate_clause = (
    "AND EXISTS (SELECT 1 FROM benchmark_selection bs WHERE bs.game_id = g.id)"
    if settings.BENCHMARK_SELECTION_GATE_ENABLED
    else ""
)
picked_user_id = await _es_weighted_user_pick(
    session,
    candidate_where_sql=f"""
        (u.is_guest = false AND EXISTS (
            SELECT 1 FROM games g
            WHERE g.user_id = u.id
              AND g.full_evals_completed_at IS NULL
              AND g.lichess_evals_at IS NULL
              {_selection_gate_clause}
        ))
        OR
        EXISTS (
            SELECT 1 FROM games g
            WHERE g.user_id = u.id
              AND g.full_pv_completed_at IS NULL
              AND g.lichess_evals_at IS NOT NULL
              {_selection_gate_clause}
        )
    """,
    ...
)
```
**D-10's byte-identity test requirement is load-bearing here**: when `BENCHMARK_SELECTION_GATE_ENABLED=False`, `_selection_gate_clause` must render to the empty string so the generated SQL text is byte-identical to today's — the planner should assert this with a direct string comparison test, not just behavioral equivalence, per D-10 point 1.

### Pattern 3: Whole-ladder dual-URL fallback (extends `_run_cycle`/`_run_loop`/`run_worker`)
**What:** Today, `run_worker` (`scripts/remote_eval_worker.py:1156-1205`) builds exactly one `httpx.AsyncClient` (`:1186-1191`) with `base_url` and auth headers fixed at construction, then hands it to `_run_loop` (`:718`) which repeatedly calls `_run_cycle` (`:814`). `_run_cycle` runs the full 5-rung ladder (`/atomic-lease?scope=explicit` → `/entry-lease` → `/atomic-lease?scope=idle` → `/flaw-blob-lease` → `/bestmove-lease`) sequentially against that ONE client, returning `bool` — but the boolean means **"should the outer loop stop"** (`return not loop` on any successful rung, `return not loop` after all-204 too), not "did work happen." Both cases currently look identical at the call site.
**When to use:** D-13 requires strict per-claim prod priority: run the WHOLE ladder against prod first, and only run the WHOLE ladder against the fallback URL when prod's ladder returns all-204 (or prod is unreachable, D-14). This means `_run_cycle`'s return type must change to distinguish "did work" from "loop should stop," and `run_worker`/`_run_loop` need a second, independently-constructed `httpx.AsyncClient` for the fallback URL (client construction is NOT swappable mid-session — `base_url` is set once at `httpx.AsyncClient(...)` construction, `:1186`).
**Example (current signature to extend, verbatim from `scripts/remote_eval_worker.py:814-822`):**
```python
async def _run_cycle(
    client: httpx.AsyncClient,
    pool: EnginePool,
    sf_version: str,
    idle_sleep: float,
    dry_run: bool,
    loop: bool,
) -> bool:
    """Run one D-06 ladder cycle. Returns True when the loop should stop.
    ...
    Returns True only in non-loop mode after a completed cycle (or an idle 204);
    in loop mode it always returns False so _run_loop keeps draining.
    """
```
The planner should design the new return shape (e.g. a small dataclass or `tuple[bool, bool]` — `(did_work, should_stop)`) so `_run_loop`'s dual-URL wrapper can decide "prod did nothing this cycle → try fallback now" without re-deriving that from HTTP status codes a second time. **Gotcha:** every rung's 200-path already `return`s immediately inside `_run_cycle` (`:875-908`), so "did work" is knowable at each early-return point — the refactor is mechanical (thread a flag through) but touches every rung's return statement, so treat it as one task, not a one-line change.

**Auth for the second client:** `X-Operator-Token` + `X-Worker-Id` headers are set once per client (`:1188-1189`); Claude's Discretion in CONTEXT.md leaves the exact env var name for the second token open, but the natural shape is a distinct `EVAL_OPERATOR_TOKEN`-analog (e.g. `BENCHMARK_OPERATOR_TOKEN`, falling back to the primary token if unset) passed to the second client's construction.

### Anti-Patterns to Avoid
- **Reusing one `httpx.AsyncClient` for both URLs by mutating `.base_url` per-call:** not how httpx's `AsyncClient` is designed to be used mid-session inside this codebase's existing pattern; construct two clients instead, matching D-13's "each `_run_cycle` invocation is self-contained with one client" framing.
- **Interleaving rungs across the two backends** (e.g. try rung 1 on prod, rung 2 on benchmark if rung 1 was 204): explicitly rejected by D-13 — "it wraps the ladder, it does not interleave rungs across backends."
- **Narrowing only the tier-3 candidate query:** explicitly rejected by D-09 — the tier-4-blob and tier-4b lanes are separately reachable via `/flaw-blob-lease` and `/bestmove-lease` and must be gated too, or the tranche's capacity leaks onto the 477,829 tier-4-blob-eligible games already in the benchmark DB (measured in CONTEXT.md's discuss-phase session, 2026-08-22 — not independently re-verified this session; a `SELECT COUNT(*)` against the live benchmark DB would confirm it directly if desired before planning finalizes on it).
- **Adding the two new benchmark-only models to `alembic/env.py`'s import list:** would put them in the canonical chain, defeating D-07/INFRA-02.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Weighted random candidate selection | A new selection algorithm for `benchmark_selection` | Simple `ORDER BY random() LIMIT :cap` per (user, tc) is sufficient — CONTEXT.md D-02 explicitly rejects stratification/floors, so no ES-lottery machinery is needed here (that machinery is for the *live* claim-time lottery, not the one-shot selection script) | The existing `_es_weighted_user_pick`/`_es_weighted_game_pick` recency-weighted lottery solves a different problem (live fairness across returning users); the selection script is a one-shot materialization and needs only uniform random sampling within the cap |
| Benchmark-only schema lifecycle | A new migration-tooling variant | `Base.metadata.create_all(tables=[...])` (INFRA-02, Pattern 1 above) | Already proven twice in this exact codebase; a third bespoke mechanism would fragment the "how do benchmark tables get created" story |
| Cross-backend leased-game bookkeeping | A "which backend has this game leased" ledger | None needed — a leased benchmark game simply finishes (~60s, per the seed's cost table); D-13 explicitly notes "no requeue logic exists or is needed" because leases are per-backend-DB and independent | Two separate Postgres databases mean two separate `eval_jobs`/lease-expiry state spaces; there is no cross-DB game_id collision risk as long as a `_run_cycle` invocation never mixes clients mid-cycle (see Pattern 3 anti-pattern) |

**Key insight:** this phase's "don't hand-roll" risk is inverted from most phases — the danger is building NEW machinery (a second lottery algorithm, a new migration system, a cross-backend lease tracker) when the existing codebase already has a working, tested pattern for each piece. Every one of the four buildable pieces has a direct precedent already in the repo.

## Common Pitfalls

### Pitfall 1: `_run_cycle`'s current return value conflates "no work" with "loop should stop"
**What goes wrong:** A naive dual-URL patch that just calls `_run_cycle(primary_client, ...)` and, if it returns `False` (meaning "keep looping" in loop mode — which is what a successful lease-and-submit ALSO returns), assumes "no work happened" and immediately tries the fallback — even though prod DID have work and the cycle just finished normally.
**Why it happens:** `_run_cycle` returns `not loop` at every single return point (`:951`, `:971`, `:1007`, `:1052`, `:902`, `:1150`) — in continuous-loop mode (`loop=True`, the default), it ALWAYS returns `False`, whether a rung succeeded or all five hit 204.
**How to avoid:** Change `_run_cycle`'s return shape to separately carry "did any rung return non-204" (see Pattern 3 above) before wiring the fallback wrapper.
**Warning signs:** Fallback backend receiving claims even while prod clearly has a backlog (visible via prod's `eval_jobs`/tier-3 activity).

### Pitfall 2: `is_lichess_eval_game` is a two-consumer flag — overriding it changes MORE than eval storage
**What goes wrong:** D-03's homogenization flag forces `is_lichess_eval_game = False` at the single derivation point (`eval_apply.py:2344`). This is correct for the write path, but the SAME flag also gates the `include_terminal=not is_lichess_eval_game` terminal-donor logic (`eval_drain.py:948`) and the dedup-hash exclusion (`eval_drain.py:968`) — CONTEXT.md's own "Known knock-on, accepted" note flags that this also drops the `eval_drain.py:836` best-move identity-key substitution (verified verbatim this session, lines 836-842), meaning the engine's own best move becomes the identity key instead of lichess's stored one.
**Why it happens:** `is_lichess_eval_game` is read at 3+ separate call sites across `eval_apply.py` and `eval_drain.py`, not just the one write branch a naive implementation might target.
**How to avoid:** Implement the override at the SINGLE derivation point (`:2344`) as CONTEXT.md specifies — do NOT add a second override deeper in the call stack, or the two overrides can drift and re-introduce the exact confound this decision exists to remove.
**Warning signs:** A lichess-arm game in the tranche that still shows lichess's best_move as the identity key after the flag is on — a sign the override missed one of the downstream read sites.

### Pitfall 3: `maia_available` is a silent-failure guardrail, not a loud error
**What goes wrong:** If Maia fails to load in the local backend process, `apply_completion_decision`'s `maia_available` guardrail (confirmed derivation, `eval_apply.py:810` docstring + `:2457`/`:2583` call sites) means the game gets PV but NEVER `best_moves_completed_at` — and this happens **silently**, with `_build_best_move_candidates` returning `[]` for both "Maia ran, zero candidates" and "Maia absent" (row count alone cannot distinguish the two, per the same docstring).
**Why it happens:** The guardrail is deliberately conservative (never stamp completion with a possibly-absent Maia), but conservatism here means the operator gets no error, just silently missing `game_best_moves` rows.
**How to avoid:** D-16's `status` subcommand should explicitly surface "Maia loaded: yes/no" as a startup-time check on the local backend, not just poll DB completion columns after the fact.
**Warning signs:** Tranche completes with `full_pv_completed_at` fully stamped but `best_moves_completed_at` and `game_best_moves` rows unexpectedly sparse or zero.

### Pitfall 4: Alembic autogenerate table gap is a real, currently-latent time bomb (D-08)
**What goes wrong:** `alembic/env.py:_include_object` (`:112-115`, confirmed this session) filters ONLY `type_ == "index"` — it never filters tables. Today the two existing benchmark-only tables are invisible to prod purely because nobody has run `alembic revision --autogenerate` since they were added. The next unrelated autogenerate run (for ANY future phase, not this one) would emit `op.create_table('benchmark_selected_users')` (and, after this phase, `benchmark_selection` and `benchmark_lichess_eval_snapshot`) against prod's migration chain.
**Why it happens:** `_include_object`'s existing ignorelist (`_AUTOGEN_INDEX_IGNORELIST`, `:87-109`) was scoped to indexes only when it was written (2026-07-02 code-review fix, per its own comment).
**How to avoid:** D-08 requires extending `_include_object` to also filter tables (a parallel ignorelist, or a `__table_args__.info` marker) — this closes the gap retroactively for the two existing tables too, not just the two new ones.
**Warning signs:** Any future `alembic revision --autogenerate -m "..."` diff that includes an unexpected `op.create_table('benchmark_*')` — this is the exact failure mode D-08 prevents.

### Pitfall 5: `DATABASE_URL` vs `DATABASE_URL_BENCHMARK` — the app reads only the former
**What goes wrong:** Assuming setting `DATABASE_URL_BENCHMARK` (or running `scripts/*.py --db benchmark`) is enough to point a `uvicorn app.main:app` process at the benchmark DB.
**Why it happens:** `app/core/config.py:19-29` (confirmed this session) defines FOUR `DATABASE_URL_*` settings, but only `DATABASE_URL` (no suffix) is what the running FastAPI app and Alembic actually connect through (confirmed via `alembic/env.py:36`: `config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)`). `DATABASE_URL_BENCHMARK` exists solely as one of four values a `scripts/` `--db` flag resolves through (`config.py:157-173`) for one-off maintenance scripts — it is never read by the app itself.
**How to avoid:** The local backend instance must be launched with `DATABASE_URL` (not `DATABASE_URL_BENCHMARK`) set to the benchmark connection string: `DATABASE_URL=postgresql+asyncpg://flawchess_benchmark:flawchess_benchmark@localhost:5433/flawchess_benchmark uv run uvicorn app.main:app --port 8001 --host 0.0.0.0`.
**Warning signs:** The local backend on :8001 silently serving/writing to the DEV database on :5432 instead of the benchmark DB on :5433 — a very costly and hard-to-detect misconfiguration since both are locally reachable Postgres instances with the app's own default credentials pattern.

### Pitfall 6: The benchmark DB's `flawchess_benchmark` role IS write-capable — the `_ro` suffix role is a DIFFERENT, read-only role
**What goes wrong:** Assuming the benchmark DB is read-only end to end because the project's MCP tooling (`flawchess-benchmark-db`) connects through a read-only role.
**Why it happens:** `bin/benchmark_db.sh:18-19` (confirmed this session) resolves `BENCHMARK_DB_URL` from `DATABASE_URL_BENCHMARK` in `.env`, which uses the `flawchess_benchmark` app role (read-write — it's the role Alembic migrations run under, per `:30`). The SEPARATE `flawchess_benchmark_ro` role (`:41-45`) only gets `GRANT SELECT` — that's the MCP read-only role, used by `mcp__flawchess-benchmark-db__query`, and it is unrelated to what the local backend process connects as.
**How to avoid:** The local backend's `DATABASE_URL` must use the `flawchess_benchmark` (write) role's credentials, matching what `bin/benchmark_db.sh` itself uses for migrations — not the `_ro` role.
**Warning signs:** `asyncpg.InsufficientPrivilegeError` on the very first write attempt if the `_ro` role's credentials are used by mistake.

## Code Examples

### The four narrowing call sites (existing predicates the gate attaches beside)
```python
# app/services/eval_queue_service.py:600-614 — _claim_tier3_derived Step 1
# (verbatim, confirmed this session)
picked_user_id = await _es_weighted_user_pick(
    session,
    candidate_where_sql="""
        (u.is_guest = false AND EXISTS (
            SELECT 1 FROM games g
            WHERE g.user_id = u.id
              AND g.full_evals_completed_at IS NULL
              AND g.lichess_evals_at IS NULL
        ))
        OR
        EXISTS (
            SELECT 1 FROM games g
            WHERE g.user_id = u.id
              AND g.full_pv_completed_at IS NULL
              AND g.lichess_evals_at IS NOT NULL
        )
    """,
    recency_col_sql="u.last_activity",
    tau_seconds=tau_seconds,
    floor=floor_val,
)
```
```python
# app/services/eval_queue_service.py:747-758 — _claim_tier4_blob Stage 1
# (verbatim, confirmed this session)
picked_user_id = await _es_weighted_user_pick(
    session,
    candidate_exists_sql="""
            SELECT 1 FROM games g
            WHERE g.user_id = u.id
              AND g.full_evals_completed_at IS NOT NULL
              AND g.blobs_completed_at IS NULL
    """,
    recency_col_sql="u.last_activity",
    tau_seconds=tau_u_seconds,
    floor=floor_u,
)
```
```python
# app/services/eval_queue_service.py:831-843 — _claim_tier4_bestmove Stage 1
# (verbatim, confirmed this session)
picked_user_id = await _es_weighted_user_pick(
    session,
    candidate_exists_sql="""
            SELECT 1 FROM games g
            WHERE g.user_id = u.id
              AND g.full_pv_completed_at IS NOT NULL
              AND g.best_moves_completed_at IS NULL
    """,
    recency_col_sql="u.last_activity",
    tau_seconds=tau_u_seconds,
    floor=floor_u,
    include_guests=True,
)
```

### The existing config-flag pattern to mirror for the two new flags
```python
# app/core/config.py:77-98 — verbatim, confirmed this session
# Automatic background full-eval toggle (Phase 117). When False, the tier-3
# idle-backlog derived pick is suppressed — the only automatic eval source as of
# Phase 118, which removed the tier-2 auto-window enqueue. Tier-1 (explicit,
# on-demand single-game request) is UNAFFECTED — on-demand analysis still works.
# Default False (safe for dev/CI so a local backend doesn't pin every core on the
# hundreds-of-thousands-game backlog). Prod opts in explicitly via its .env.
EVAL_AUTO_DRAIN_ENABLED: bool = False

# Best-move backfill toggle (Phase 176 BACK-01, D-05). When False (default),
# the tier-4b spare-capacity lottery is suppressed even when
# EVAL_AUTO_DRAIN_ENABLED is True (BOTH gates are checked — see
# claim_eval_job's bundled scope=None path). ...
BEST_MOVE_BACKFILL_ENABLED: bool = False
```
The two new flags (`BENCHMARK_SELECTION_GATE_ENABLED`, and the homogenization flag — naming is Claude's discretion per CONTEXT.md) should follow this EXACT shape: `bool = False` default, a comment explaining the AND/override semantics, and prod-never-opts-in framing (these two flags should never be `true` in prod's `.env` at all — they are benchmark-instance-only, unlike `EVAL_AUTO_DRAIN_ENABLED` which prod does enable).

### `is_lichess_eval_game` derivation point (D-03's override target)
```python
# app/services/eval_apply.py:2344 — verbatim, confirmed this session
# Quick 260719-fsz: needed for the best_cp source decision below.
is_lichess_eval_game = game.lichess_evals_at is not None
```

### Operator-token auth gate (existing pattern for the second backend's token)
```python
# app/routers/eval_remote.py — fail-closed operator token check
# 403 when the token is not configured on the server (fail-closed); 401 when it does
# not match. Missing header also returns 403 (server not configured — do not
# distinguish "wrong token" from "no token configured", both look like 403).
configured = settings.EVAL_OPERATOR_TOKEN
if not configured:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, ...)
```
The local backend's own `EVAL_OPERATOR_TOKEN` (set in its own environment, independent of prod's `.env`) is what the fallback worker client authenticates against — the same header (`X-Operator-Token`), a different configured value.

### Launching the local backend (derived from verified settings, not yet a script)
```bash
# DATABASE_URL (not DATABASE_URL_BENCHMARK — Pitfall 5) must point at :5433's
# WRITE-capable role (flawchess_benchmark — Pitfall 6), matching bin/benchmark_db.sh's
# own migration credentials.
DATABASE_URL="postgresql+asyncpg://flawchess_benchmark:flawchess_benchmark@localhost:5433/flawchess_benchmark" \
EVAL_AUTO_DRAIN_ENABLED=true \
BEST_MOVE_BACKFILL_ENABLED=true \
BENCHMARK_SELECTION_GATE_ENABLED=true \
STOCKFISH_POOL_SIZE=1 \
EVAL_OPERATOR_TOKEN="<local-instance-token>" \
uv run uvicorn app.main:app --port 8001 --host 0.0.0.0
```

## State of the Art

Not applicable in the usual sense — this is not a "check whether the ecosystem moved" phase. The one relevant "what changed since the seed was planted" correction is already captured and locked in CONTEXT.md/ROADMAP:

| Old (seed's initial claim) | Current (corrected, verified) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| "Maia inference cannot run on the remote worker fleet" (`eval_queue_service.py:34` docstring) read as "the whole tier-4b rung is backend work" | Phase 177 BACK-02/03 added `/bestmove-lease` + `/bestmove-submit` (confirmed: `_handle_bestmove_response` at `remote_eval_worker.py:1108`, `_eval_bestmove_positions` at `:1058`) — the fleet computes the runner-up **Stockfish** evals; only the Maia forward-pass itself stays backend-side (`eval_apply.py:2457`/`:2583`, `maia_engine.is_maia_available()`) | Phase 177 | Local backend sizing is cheaper than the seed implied — only Maia inference, not Stockfish, runs locally |

**Deprecated/outdated:** the old `/lease` + `/submit` Gen-1 pair (referenced in `claim_eval_job`'s docstring, `eval_queue_service.py:893-901`) was deleted server-side and in the worker script by Phase 149-03 PRUNE-01 — not relevant to plan around, mentioned only because a stale reading of an old docstring is exactly the kind of error the seed's own "Maia claim" correction guards against; verify current behavior against code, not comments, when in doubt.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The measured DB figures carried from CONTEXT.md (641,855 analyzed games, 50,338,518 positions, 477,829 tier-4-blob-eligible games, ~2.1M eq-footing games, per-TC eq-footing counts) were NOT independently re-queried this session — no live-DB query tool was available to this researcher. They were measured during the prior `/gsd-discuss-phase` session on 2026-08-22 (same day) and are treated as authoritative per CONTEXT.md's locked-decision status. | Summary, Anti-Patterns (D-09 leak figure) | Low — these are cardinality/sizing facts that inform urgency and don't change the architecture; if materially stale, only the cost/scheduling estimate shifts, not the design. Re-running the same `SELECT COUNT(*)` queries CONTEXT.md used (visible in its own text) would re-verify in under a minute before planning finalizes. |
| A2 | The illustrative "gate predicate" code snippet in Pattern 2 (`_selection_gate_clause` composition) is proposed shape, not existing code — it does not exist in the codebase today and is offered as a starting point matching the existing style, not a verified quote. | Architecture Patterns, Pattern 2 | Low — clearly marked "not yet in the codebase" in the text; the planner should treat it as a sketch, not a spec. |
| A3 | The exact column set for `benchmark_selection` beyond `(game_id, tc_tranche)`, and both new tables' exact naming, are Claude's Discretion per CONTEXT.md — not resolved here. | User Constraints, Recommended Project Structure | Low — explicitly flagged as open in CONTEXT.md; planner should decide during planning, informed by `status`/`record` subcommand needs (D-16) and the `UniqueConstraint`-idempotency precedent from `benchmark_selected_users`. |

**If this table is empty:** N/A — see above. All other claims in this document were verified this session by opening the cited file and reading the cited line range (per the mandatory verification protocol); none rely on training-data recall of this specific codebase.

## Open Questions

1. **Exact naming for the two new config flags and two new tables.**
   - What we know: CONTEXT.md leaves this as Claude's Discretion; the existing flags (`EVAL_AUTO_DRAIN_ENABLED`, `BEST_MOVE_BACKFILL_ENABLED`) establish a `SCREAMING_SNAKE_CASE` + `_ENABLED` suffix convention for booleans.
   - What's unclear: whether the gate flag should be named for its mechanism (`BENCHMARK_SELECTION_GATE_ENABLED`, matching the seed's own suggested name) or its effect; similarly for the homogenization flag.
   - Recommendation: planner picks names during planning; low-stakes, purely cosmetic, does not block task sequencing.

2. **Whether to re-verify the measured DB figures (A1 above) before finalizing task sizing.**
   - What we know: CONTEXT.md's figures were measured same-day during discuss-phase.
   - What's unclear: whether they've drifted (unlikely within hours, but the tranche will run over weeks so tracking drift matters operationally, not just at plan time).
   - Recommendation: the D-16 `status` subcommand should be the mechanism for ongoing drift-tracking, not a one-time pre-plan re-check.

3. **Whether the second `EVAL_OPERATOR_TOKEN`-analog needs to be a distinct project-wide setting or can be a worker-CLI-only `--fallback-token` flag.**
   - What we know: the primary worker CLI already supports `--token` overriding the env value (`remote_eval_worker.py:1289-1297`).
   - What's unclear: whether the local backend's token should live in `app/core/config.py` as a named setting (so it's visible alongside `EVAL_OPERATOR_TOKEN`) or purely as an ad-hoc env var the operator sets when launching uvicorn on :8001.
   - Recommendation: given `EVAL_OPERATOR_TOKEN` is already a `Settings` field (`config.py:100-103`), the local backend just reuses THAT same field name in its own process's environment (it's a different `uvicorn` process, so it gets its own `.env`/env-var value) — no new `Settings` field is needed on the backend side; only the WORKER script needs a new `--fallback-token`/`BENCHMARK_OPERATOR_TOKEN`-style CLI/env option to know what to send.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | benchmark DB container | ✓ | 29.7.2 (`[VERIFIED: docker --version]`) | — |
| uv | backend/worker processes | ✓ | 0.10.9 (`[VERIFIED: uv --version]`) | — |
| Dev Postgres :5432 | app dev DB (must NOT be confused with benchmark DB, Pitfall 5) | ✓ running (`flawchess-dev-db-1`, confirmed via `docker ps` + `pg_isready`) | — | — |
| Benchmark Postgres :5433 | this phase's entire pipeline | ✓ running (`flawchess-benchmark-db-1`, confirmed via `docker ps` + `pg_isready`) | — | — |
| `bin/benchmark_db.sh` | DB lifecycle + Alembic head check | ✓ present, read and verified this session | — | — |
| LAN reachability from worker boxes to Adrian's box:8001 | dual-URL fallback | Not independently verifiable from this session's environment (no network topology probe available) | — | CONTEXT.md/seed state the worker machines are confirmed on the same LAN — treat as given per the locked topology decision |

**Missing dependencies with no fallback:** none identified — both databases are already running locally and no new external service or package is required.

**Missing dependencies with fallback:** LAN reachability is asserted by the locked design (not independently probed this session); if a worker box turns out to be off-LAN after all, CONTEXT.md's Deferred Ideas already names the fallback (a second backend container on the prod host serving a sliced sibling DB, sharing the same dual-URL worker patch).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest + pytest-asyncio, `asyncio_mode = "auto"` (`[VERIFIED: pyproject.toml:64-67]`) |
| Config file | `pyproject.toml` `[tool.pytest.ini_options]` (`:64-74`) |
| Quick run command | `uv run pytest tests/services/test_eval_queue.py tests/test_remote_eval_worker.py -x` |
| Full suite command | `uv run pytest -n auto` (per-run-DB isolation, CLAUDE.md) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BENCHLANE-01 | `benchmark_selection` created via `create_all`, idempotent on re-run | unit/integration | `uv run pytest tests/test_benchmark_lane.py::test_persist_selection_idempotent -x` | ❌ Wave 0 (mirror `tests/test_benchmark_ingest.py::test_persist_selection_compound_dedup`, `[VERIFIED: tests/test_benchmark_ingest.py:334]`) |
| BENCHLANE-02 | Gate predicate byte-identical when off; bites when on | unit | `uv run pytest tests/services/test_eval_queue.py -k benchmark_selection_gate -x` | ❌ Wave 0 — `tests/services/test_eval_queue.py` exists (52 existing tests, `[VERIFIED]`) and already has a byte-identity precedent worth mirroring (module docstring: "tier-4 blob / bestmove byte-identity is pinned by tests/services/test_eval_queue.py") |
| BENCHLANE-02 | Boot assertion refuses start with gate on + table missing | unit | `uv run pytest tests/test_config_boot_assertions.py -k benchmark_selection -x` | ❌ Wave 0 (new file, or add to an existing app-startup test module) |
| BENCHLANE-03 | Fallback fires only when primary's whole ladder is 204; strict per-claim prod priority | unit | `uv run pytest tests/test_remote_eval_worker.py -k fallback -x` | ❌ Wave 0 — `tests/test_remote_eval_worker.py` exists (`[VERIFIED: file found]`) |
| BENCHLANE-03 | Unreachable primary falls through (D-14) | unit | `uv run pytest tests/test_remote_eval_worker.py -k unreachable_primary -x` | ❌ Wave 0 |
| BENCHLANE-04 | Alembic head on :5433 matches `main`'s head | manual/script | `bin/benchmark_db.sh start` (runs `alembic upgrade head` against 5433, `[VERIFIED: bin/benchmark_db.sh:28-31]`) then diff against `alembic current` on dev | N/A — existing script covers this; no new test needed |
| BENCHLANE-05 | Homogenization flag forces engine eval_cp/flaws for the lichess arm | integration | `uv run pytest tests/services/test_eval_apply.py -k homogenization -x` | ❌ Wave 0 |
| BENCHLANE-06 | `record` subcommand writes a timestamped report with row counts | unit | `uv run pytest tests/test_benchmark_lane.py::test_record_writes_report -x` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted file(s) above, `-x`.
- **Per wave merge:** `uv run pytest tests/services/test_eval_queue.py tests/test_remote_eval_worker.py tests/test_benchmark_lane.py tests/services/test_eval_apply.py -n auto`.
- **Phase gate:** full suite green (`uv run pytest -n auto`) before `/gsd-verify-work`; note that `tests/scripts/benchmarks` stays excluded by default (`addopts` in `pyproject.toml:74`) and is NOT the right place for this phase's tests even though it touches the benchmark DB — those are numeric-regression tests against `benchmarks-latest.md`, a different concern.

### Wave 0 Gaps
- [ ] `tests/test_benchmark_lane.py` — new file, covers BENCHLANE-01/06, mirrors `tests/test_benchmark_ingest.py`'s pure-unit + `create_all`-idempotency shape (`[VERIFIED: tests/test_benchmark_ingest.py]`, 10 existing test functions read this session).
- [ ] Gate byte-identity + bites-when-on tests added to `tests/services/test_eval_queue.py` (existing file, 52 tests already present, `[VERIFIED]`).
- [ ] Boot-assertion test for D-10 point 3 (new, no existing file identified for "app fails to start" checks — the planner should confirm whether one exists under a name not grepped this session, e.g. `tests/test_main.py` or `tests/test_startup.py`).
- [ ] Fallback-routing tests added to `tests/test_remote_eval_worker.py` (existing file, `[VERIFIED: file found]`, not read in full this session — planner/executor should read it before extending).
- [ ] Framework install: none — pytest/pytest-asyncio already present.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | `X-Operator-Token` header, fail-closed 403-when-unconfigured pattern already established (`app/routers/eval_remote.py`, confirmed this session) — the second backend's token is a SEPARATE value in its own process env, not shared with prod's `.env` |
| V3 Session Management | no | No user sessions involved — this is machine-to-machine worker auth, not a user-facing session |
| V4 Access Control | yes | The gate flag itself (`BENCHMARK_SELECTION_GATE_ENABLED`) is an access-control mechanism in the loose sense (D-10's boot assertion IS an access-control fail-closed check: refuse to start rather than silently serve unscoped work) |
| V5 Input Validation | n/a for this phase | No new user-facing input surfaces; all new SQL fragments are hardcoded literals per the existing QUEUE-08 convention (never derived from request/user input) — confirmed this session in `_es_weighted_user_pick`'s own docstring at `:333-337` |
| V6 Cryptography | no | No new crypto — operator tokens are opaque bearer strings compared server-side, matching the existing `EVAL_OPERATOR_TOKEN` pattern |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Local backend's LAN bind (`0.0.0.0:8001`) exposed to more than the intended worker boxes | Spoofing / Elevation of Privilege | `X-Operator-Token` fail-closed auth (already the standard pattern for `/atomic-lease` etc.) — no new mitigation needed as long as the second instance sets its own `EVAL_OPERATOR_TOKEN` and the LAN is trusted per the locked topology decision |
| A misconfigured `BENCHMARK_SELECTION_GATE_ENABLED=true` instance with the table missing, silently falling through to the UNGATED (all-2.1M-games) lottery instead of erroring | Denial of Service (of the tranche's controlled scope, not of the app) | D-10 point 3's boot assertion — refuse to start rather than degrade silently; this is the security-relevant reason D-10 exists, not just correctness |
| SQL injection via the gate predicate | Tampering | N/A — the predicate is a hardcoded hardcoded hardcoded literal, never built from request/user input, matching the QUEUE-08 convention already enforced across every existing call site in this module |

## Sources

### Primary (HIGH confidence — all files opened and read this session, line numbers confirmed via `grep -n` cross-check)
- `app/services/eval_queue_service.py` (full lottery service, 1134 lines — read lines 1-100, 280-920)
- `scripts/remote_eval_worker.py` (headless worker, 1466 lines — read lines 1-90, 700-1400)
- `app/services/eval_apply.py` (2664 lines — read lines 790-825, 2290-2360)
- `app/services/eval_drain.py` (1381 lines — read lines 810-970)
- `app/core/config.py` (178 lines — read lines 1-30, 60-110, 155-178)
- `alembic/env.py` (156 lines — read in full)
- `bin/benchmark_db.sh` (75 lines — read in full)
- `app/models/benchmark_selected_user.py`, `app/models/benchmark_ingest_checkpoint.py`, `app/models/game_best_move.py`, `app/models/game.py`, `app/models/game_flaw.py`, `app/models/game_position.py` (all read, relevant portions)
- `scripts/select_benchmark_users.py:355-375`, `scripts/import_benchmark_users.py:205-220`
- `app/services/import_service.py:1548-1584`
- `.claude/skills/benchmarks/SKILL.md` (equal-footing filter sections, lines 85-95, 505-525)
- `tests/test_benchmark_ingest.py`, `tests/services/test_eval_queue.py` (existence + shape confirmed, spot-read)
- `pyproject.toml` (pytest config, lines 64-84)
- `.planning/phases/212-benchmark-full-game-analysis-lane/212-CONTEXT.md` (full document — the primary decision source for this phase)
- `.planning/seeds/SEED-152-benchmark-full-game-analysis-lane.md` (full document)
- `.planning/ROADMAP.md` § "Phase 212" (full section, ~9KB)
- `.planning/notes/benchmark-equal-footing-framing.md` (read, confirms the ±100 rule's provenance)
- Live environment: `docker ps`, `pg_isready -h localhost -p 5432/5433`, `uv --version`, `docker --version` (all run this session)

### Secondary (MEDIUM confidence)
- None — no web/docs research was needed for this phase; it is entirely internal-codebase engineering.

### Tertiary (LOW confidence)
- A1 in the Assumptions Log — the measured DB cardinality figures carried from CONTEXT.md's prior discuss-phase session, not re-queried live this session (no DB query tool was available to this researcher in this session's toolset).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; every reused pattern verified against live source this session.
- Architecture: HIGH — all four buildable pieces map to file:line-verified existing code; the dual-URL fallback's exact gap (`_run_cycle`'s return-value ambiguity) was independently confirmed, not just taken from CONTEXT.md's assertion.
- Pitfalls: HIGH — all six pitfalls above are grounded in code read this session, not inferred.

**Research date:** 2026-08-22
**Valid until:** 30 days (stable internal codebase; the one thing that could go stale fastest is the measured DB cardinality figures in A1, which the D-16 `status` subcommand is designed to keep current operationally)
