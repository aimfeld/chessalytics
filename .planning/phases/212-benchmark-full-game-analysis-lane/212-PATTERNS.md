# Phase 212: Benchmark Full-Game Analysis Lane - Pattern Map

**Mapped:** 2026-08-22
**Files analyzed:** 9 (new/modified)
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `app/models/benchmark_selection.py` (new) | model | CRUD (one-shot materialize) | `app/models/benchmark_selected_user.py` | exact |
| `app/models/benchmark_lichess_eval_snapshot.py` (new) | model | CRUD (one-shot materialize) | `app/models/benchmark_ingest_checkpoint.py` | exact (FK precedent) |
| `scripts/benchmark_lane.py` (new) | utility (script, subcommands) | batch / CRUD | `scripts/select_benchmark_users.py` (`persist_selection`) + `scripts/import_benchmark_users.py` | exact |
| `app/core/config.py` (+2 flags) | config | request-response (gate) | existing `EVAL_AUTO_DRAIN_ENABLED` / `BEST_MOVE_BACKFILL_ENABLED` block | exact |
| `app/services/eval_queue_service.py` (4 call sites) | service | CRUD / event-driven (lottery claim) | itself — `_es_weighted_user_pick` / `_es_weighted_game_pick` call sites | exact |
| `app/services/eval_apply.py` (:2344 override) | service | transform | itself — `is_lichess_eval_game` derivation | exact |
| `scripts/remote_eval_worker.py` (`_run_cycle`/`_run_loop`/`run_worker`) | utility (worker loop) | event-driven / request-response | itself — existing single-client ladder | exact |
| `alembic/env.py` (`_include_object`) | config | transform (filter) | itself — `_AUTOGEN_INDEX_IGNORELIST` | exact |
| `tests/test_benchmark_lane.py` (new) | test | CRUD / batch | `tests/test_benchmark_ingest.py` | exact |
| `tests/services/test_eval_queue.py` (extend) | test | request-response | itself — existing byte-identity tests | exact |
| `tests/test_remote_eval_worker.py` (extend) | test | event-driven | itself — existing ladder tests | exact |

## Pattern Assignments

### `app/models/benchmark_selection.py` (model, CRUD)

**Analog:** `app/models/benchmark_selected_user.py` (full file, 56 lines — copy structure verbatim)

**Docstring/provenance pattern** (lines 1-12):
```python
"""ORM for the benchmark_selected_users table (benchmark DB only).

Phase 69 INGEST-02. ... Created via Base.metadata.create_all()
against the benchmark engine -- NOT in the canonical Alembic chain (INFRA-02 isolates
the canonical schema; benchmark-only tables stay out of dev/prod/test).

The (lichess_username, tc_bucket) compound unique constraint makes re-running
selection idempotent ...
"""
```
Adapt to: `(game_id, tc_tranche)` compound `UniqueConstraint` for idempotent re-selection per D-16/CONTEXT.md discretion note. Mirror the class docstring style explaining each column's purpose.

**Imports + class shape** (lines 14-29):
```python
from __future__ import annotations
from datetime import datetime
from sqlalchemy import SmallInteger, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func
from app.models.base import Base

class BenchmarkSelectedUser(Base):
    __tablename__ = "benchmark_selected_users"
    __table_args__ = (
        UniqueConstraint("lichess_username", "tc_bucket", name="uq_benchmark_selected_users_username_tc"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    ...
    selected_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
```
**Gap vs analog:** this table stores a raw username (pre-import) so it has NO FK. `benchmark_selection` must FK `game_id` — pull the FK pattern from `benchmark_ingest_checkpoint.py` instead (see next section). CONTEXT.md D-07/RESEARCH.md explicitly warn not to copy `benchmark_selected_user.py` for the FK.

---

### `app/models/benchmark_lichess_eval_snapshot.py` (model, CRUD)

**Analog:** `app/models/benchmark_ingest_checkpoint.py` (full file, 70 lines)

**FK-with-ondelete pattern** (lines 66-69, the load-bearing precedent):
```python
# SET NULL (not CASCADE) -- deleting a stub user should not destroy the audit row
benchmark_user_id: Mapped[int | None] = mapped_column(
    ForeignKey("users.id", ondelete="SET NULL"), nullable=True
)
```
For the two new tables, `game_id` should FK `games.id` with `ondelete="CASCADE"` (per RESEARCH.md's own recommendation: "a snapshot/selection row for a deleted game is meaningless") — same shape, different policy constant:
```python
game_id: Mapped[int] = mapped_column(
    ForeignKey("games.id", ondelete="CASCADE"), nullable=False
)
```

**Compound unique constraint + status-lifecycle docstring pattern** (lines 1-28, 45-63) — same idempotency shape as above; for the snapshot table the natural key is `(game_id, ply)`.

---

### `scripts/benchmark_lane.py` (utility script, subcommands)

**Analog:** `scripts/select_benchmark_users.py::persist_selection` (lines 345-380+) and `scripts/import_benchmark_users.py:210-220`

**Targeted `create_all` + idempotent persist pattern** (`select_benchmark_users.py:359-380`):
```python
engine = create_async_engine(db_url, echo=False)

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

session_maker = async_sessionmaker(engine, expire_on_commit=False)
inserted = 0
skipped_dupes = 0
rng = random.Random(42)  # deterministic for reproducibility

async with session_maker() as session:
    # ... SELECT existing (natural key) rows first, skip dupes, session.add() new rows, commit
```
This is the exact shape to copy for `select`/`snapshot` subcommands: `create_all(tables=[...], checkfirst=True)` inside `engine.begin()`, then a session-scoped SELECT-existing → skip-dupe → add → commit loop keyed on the compound unique constraint.

**Subcommand CLI convention** — inspect `scripts/select_benchmark_users.py`'s `argparse`/`--help` top-level structure and `scripts/import_benchmark_users.py`'s `--db dev|benchmark|prod` resolution via `db_url_for_target()` (`app/core/config.py:155-178`) for the `status`/`record` subcommands' DB targeting.

**`record` report-writing precedent** — mirror `db-report`/`tactic-tagger-report` skills' `reports/{topic}/{topic}-YYYY-MM-DD.md` timestamped-file convention (locate via `Glob("reports/**/*.py")` or the corresponding skill scripts if a Python report-writer exists; otherwise follow the markdown shape documented in D-16).

---

### `app/core/config.py` (+2 new bool flags)

**Analog:** existing `EVAL_AUTO_DRAIN_ENABLED` / `BEST_MOVE_BACKFILL_ENABLED` block (lines ~77-98 per RESEARCH.md, confirmed shape below via `DATABASE_URL` block at lines 15-29):
```python
# Automatic background full-eval toggle (Phase 117). When False, the tier-3
# idle-backlog derived pick is suppressed ...
# Default False (safe for dev/CI ...). Prod opts in explicitly via its .env.
EVAL_AUTO_DRAIN_ENABLED: bool = False

# Best-move backfill toggle (Phase 176 BACK-01, D-05). When False (default),
# the tier-4b spare-capacity lottery is suppressed even when
# EVAL_AUTO_DRAIN_ENABLED is True (BOTH gates are checked ...).
BEST_MOVE_BACKFILL_ENABLED: bool = False
```
New flags (`BENCHMARK_SELECTION_GATE_ENABLED`, homogenization flag — naming at Claude's discretion) follow this exact shape: `bool = False` default, a comment explaining semantics, and an explicit "prod never sets this true" framing (unlike the two flags above, which prod DOES enable).

---

### `app/services/eval_queue_service.py` (4 narrowing call sites)

**Analog:** itself — the three existing call sites through `_es_weighted_user_pick`/`_es_weighted_game_pick`.

**Site 1 — `_claim_tier3_derived` Step 1** (lines 600-614, verbatim):
```python
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
**Site 2 — `_claim_tier4_blob` Stage 1** (lines 747-758, verbatim):
```python
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
**Site 3 — `_claim_tier4_bestmove` Stage 1** (lines 831-843, verbatim):
```python
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
**Narrowing pattern to attach at each site** (illustrative, per RESEARCH.md Pattern 2 — not yet in codebase):
```python
_selection_gate_clause = (
    "AND EXISTS (SELECT 1 FROM benchmark_selection bs WHERE bs.game_id = g.id)"
    if settings.BENCHMARK_SELECTION_GATE_ENABLED
    else ""
)
```
Insert `{_selection_gate_clause}` immediately after each `g.*_completed_at`/`g.lichess_evals_at` condition inside the `WHERE`/`EXISTS` block, at all 4 sites (Step 1 has 2 sub-clauses — both need the gate). **Byte-identity requirement (D-10):** when the flag is off, `_selection_gate_clause` must render `""` so the resulting SQL string is character-for-character identical to today's — write the test as a direct string comparison, not behavioral equivalence.

There is also a Step 2 inside `_claim_tier3_derived` (per-game pick after the user is chosen) built on `_es_weighted_game_pick` — apply the same clause there too (D-09 requires both steps).

**Security note (QUEUE-08 convention, docstring at `:333-337`):** these SQL fragments are trusted, hardcoded literals only — never f-string user input. The gate clause is a module-level constant string, which fits.

---

### `app/services/eval_apply.py` (D-03 override point)

**Analog:** itself — single derivation line.

**Exact target** (line 2344, verbatim):
```python
# Quick 260719-fsz: needed for the best_cp source decision below.
is_lichess_eval_game = game.lichess_evals_at is not None
```
**Override pattern:**
```python
is_lichess_eval_game = game.lichess_evals_at is not None
if settings.BENCHMARK_HOMOGENIZE_EVAL_SOURCE:
    is_lichess_eval_game = False
```
Do NOT add a second override at `eval_drain.py:836` (best-move identity-key), `:948` (`include_terminal`), or `:968` (dedup-hash exclusion) — those all read the same `is_lichess_eval_game` variable computed here, and D-03/Pitfall 2 require exactly one derivation point to avoid drift.

---

### `scripts/remote_eval_worker.py` (dual-URL fallback)

**Analog:** itself — `run_worker` (single-client construction) and `_run_cycle` (5-rung ladder returning `bool`).

**Current single-client construction** (lines 1184-1191, verbatim):
```python
async with httpx.AsyncClient(
    base_url=base_url,
    # D-10: X-Worker-Id set once alongside X-Operator-Token — no per-call change.
    headers={"X-Operator-Token": token, "X-Worker-Id": worker_id},
    timeout=HTTP_TIMEOUT_S,
) as client:
    await _run_loop(
        client=client, pool=pool, sf_version=sf_version,
        idle_sleep=idle_sleep, dry_run=dry_run, loop=loop, heartbeat=heartbeat,
    )
```
**Current `_run_cycle` signature** (lines 814-822, verbatim):
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
    """
```
**Pattern to build:** construct a SECOND `httpx.AsyncClient` inside `run_worker` (same shape, `base_url=fallback_base_url`, `headers={"X-Operator-Token": fallback_token, ...}`), change `_run_cycle`'s return to a `(did_work, should_stop)` tuple (or small dataclass) by threading a flag through every early-return point (lines ~875-908, ~951, 971, 1007, 1052, 1150), and wrap both ladder invocations in `_run_loop` per D-13/D-14: run primary's full ladder; if `did_work` is False OR primary was unreachable (httpx exception), run fallback's full ladder. Never interleave rungs across clients (see RESEARCH.md Anti-Patterns).

**Auth analog for the fallback token** — reuse `EVAL_OPERATOR_TOKEN` `Settings` field pattern; only the worker CLI needs a new `--fallback-token`/`BENCHMARK_OPERATOR_TOKEN`-style option (`remote_eval_worker.py:1289-1297` already supports `--token` overriding the env value — mirror that flag).

---

### `alembic/env.py` (`_include_object` table gap, D-08)

**Analog:** itself — `_AUTOGEN_INDEX_IGNORELIST` (lines ~87-109) and `_include_object` (lines 112-115).

Read the exact ignorelist shape and extend `_include_object` with a parallel table-name ignorelist (or `__table_args__.info` marker check) so `type_ == "table"` and `name in _AUTOGEN_TABLE_IGNORELIST` is also skipped — mirroring the existing `if type_ == "index" and name in _AUTOGEN_INDEX_IGNORELIST` branch structure exactly.

---

### `app/routers/eval_remote.py` (operator-token auth — shared pattern, not a new file but the auth analog for the fallback client)

**Fail-closed constant-time token check** (verbatim, lines ~169-196):
```python
x_operator_token: Annotated[str | None, Header(alias="X-Operator-Token")] = None,
...
# Fail-closed: if no token is configured on the server, return 403 so the
...
if not configured:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, ...)
...
# Missing header OR wrong token → 401. ...
if x_operator_token is None or not hmac.compare_digest(configured.encode("utf-8"), supplied):
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, ...)
```
No new router code is required for this phase (the local backend reuses this SAME router/endpoint code against a different DB) — but this is the auth contract the worker's second `httpx.AsyncClient` must satisfy: `X-Operator-Token` header, matched via `hmac.compare_digest`, against the local instance's own `EVAL_OPERATOR_TOKEN` value.

---

### `tests/test_benchmark_lane.py` (new)

**Analog:** `tests/test_benchmark_ingest.py::test_persist_selection_compound_dedup` (lines 333-380+)

**Idempotency test shape (mock session, compound-key dedup):**
```python
@pytest.mark.asyncio
async def test_persist_selection_compound_dedup() -> None:
    """persist_selection keys idempotency on (username, tc_bucket).
    ...
    """
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock, MagicMock, patch
    from scripts import select_benchmark_users

    existing_rows = [("alice", "blitz")]
    cell_to_users = {(1200, "blitz"): ["alice", "bob"], (2000, "classical"): ["alice"]}
    ...
    select_result = MagicMock()
    select_result.all = MagicMock(return_value=existing_rows)

    from app.models.benchmark_selected_user import BenchmarkSelectedUser
    added_rows: list[BenchmarkSelectedUser] = []

    mock_session = MagicMock()
    mock_session.execute = AsyncMock(return_value=select_result)
    mock_session.add = MagicMock(side_effect=lambda obj: added_rows.append(obj))
    mock_session.commit = AsyncMock()
    # ... patch async_sessionmaker context manager, call persist_selection, assert added_rows
```
Mirror this exact mock-session shape for `benchmark_lane.py`'s `select`/`snapshot` subcommands' idempotency tests (`test_persist_selection_idempotent`, `test_record_writes_report`), keyed on `(game_id, tc_tranche)` instead of `(username, tc_bucket)`.

---

### `tests/services/test_eval_queue.py` (extend for D-10 gate tests)

**Analog:** itself — module docstring states "tier-4 blob / bestmove byte-identity is pinned by tests/services/test_eval_queue.py" (52 existing tests). Follow the existing byte-identity test's structure: call the query-string-building path directly (or capture the SQL passed to `_es_weighted_user_pick`/`_es_weighted_game_pick` via a mock) with the flag off, assert exact string equality against today's baseline; repeat with the flag on and a `benchmark_selection` fixture row present, assert the narrowed row set actually changes.

---

### `tests/test_remote_eval_worker.py` (extend for fallback routing)

**Analog:** itself — existing ladder/ `_run_cycle` tests (file exists, not fully read this session per RESEARCH.md; read it before extending). New tests: `test_fallback_fires_only_after_all_204`, `test_unreachable_primary_falls_through` (D-14) — construct two mock `httpx.AsyncClient`-like objects (or `respx`/`httpx.MockTransport` if already used in this file) and assert the fallback client receives zero calls until the primary's ladder returns all-204, and that an `httpx.ConnectError` on the primary triggers the fallback exactly once per cycle.

## Shared Patterns

### Benchmark-only schema provenance (INFRA-02)
**Source:** `app/models/benchmark_selected_user.py:1-6` docstring (rule stated verbatim) + `scripts/select_benchmark_users.py:359-372` (`create_all(tables=[...], checkfirst=True)`)
**Apply to:** both new model files AND the script that provisions them. Never add either model to `alembic/env.py`'s import list.

### Config flag shape (bool default False, prod-opt-in-via-.env comment)
**Source:** `app/core/config.py` `EVAL_AUTO_DRAIN_ENABLED` / `BEST_MOVE_BACKFILL_ENABLED` block
**Apply to:** `BENCHMARK_SELECTION_GATE_ENABLED` and the homogenization flag — both should explicitly note in their comment that prod's `.env` must NEVER set them true (stronger than the existing flags, which prod DOES enable).

### Operator-token fail-closed auth
**Source:** `app/routers/eval_remote.py` (`hmac.compare_digest`, 403-when-unconfigured / 401-when-wrong)
**Apply to:** no code change needed here (reused as-is by the local backend instance), but the worker's second client construction (`scripts/remote_eval_worker.py:1184-1191`) must supply a distinct, correctly-configured token matching whatever the :8001 instance's own `EVAL_OPERATOR_TOKEN` is set to.

### Trusted hardcoded SQL fragments only (QUEUE-08)
**Source:** `app/services/eval_queue_service.py` module docstring (`:333-337`)
**Apply to:** the `_selection_gate_clause` constant — never build it from request/user input.

## No Analog Found

None — all 9+ files/edits have a direct, verified analog in the existing codebase (this phase is explicitly "reuse existing patterns," per RESEARCH.md's own framing).

## Metadata

**Analog search scope:** `app/models/`, `app/core/config.py`, `app/services/eval_queue_service.py`, `app/services/eval_apply.py`, `app/routers/eval_remote.py`, `scripts/select_benchmark_users.py`, `scripts/import_benchmark_users.py`, `scripts/remote_eval_worker.py`, `alembic/env.py`, `tests/test_benchmark_ingest.py`, `tests/services/test_eval_queue.py`
**Files scanned:** 11 (all read this session, several re-confirming RESEARCH.md's own citations)
**Pattern extraction date:** 2026-08-22
