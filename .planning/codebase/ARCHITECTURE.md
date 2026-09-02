<!-- refreshed: 2026-09-02 -->
# Architecture

**Analysis Date:** 2026-09-02

## System Overview

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                     React 19 + TypeScript SPA (Vite 8)                     │
│  `frontend/src/pages/*` → `frontend/src/components/*` → `frontend/src/hooks│
│  /*` (TanStack Query) → `frontend/src/api/client.ts`                       │
│  Client-side chess engine: Stockfish WASM + Maia-3 ONNX (bot play)         │
│  `frontend/src/lib/engine/*`                                                │
└───────────────────────────────────────┬────────────────────────────────────┘
                                          │ HTTPS /api/*
                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       FastAPI app  `app/main.py`                            │
│  Routers (HTTP layer only)        `app/routers/*`                          │
└───────────────────────────────────────┬────────────────────────────────────┘
                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    Services (business logic)   `app/services/*`             │
│  import pipeline · eval/flaw pipeline · engine wrappers · stats/percentile  │
│  · insights LLM narration · training/spaced-repetition                     │
└───────────────────────────────────────┬────────────────────────────────────┘
                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                   Repositories (DB access)     `app/repositories/*`         │
│  All raw SQL / SQLAlchemy `select()` lives here — services never embed SQL  │
└───────────────────────────────────────┬────────────────────────────────────┘
                                          ▼
┌───────────────────────────────────────────────────────────────────────────┐
│           PostgreSQL (asyncpg)  `app/models/*` (SQLAlchemy 2.x async)      │
└───────────────────────────────────────────────────────────────────────────┘

  Side channel — remote eval worker fleet (Stockfish depth-15 + MultiPV backfill):
  ┌────────────────────┐   X-Operator-Token   ┌───────────────────────────────┐
  │ Remote worker procs│◄────────────────────►│ `app/routers/eval_remote.py`   │
  │ (external hosts)   │  lease/submit HTTP    │ → `app/services/eval_apply.py`│
  └────────────────────┘                       │   `eval_queue_service.py`     │
                                                └───────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| FastAPI app / lifespan | Wires routers, starts/stops Stockfish pool, Maia session, background loops, Sentry | `app/main.py` |
| Routers | HTTP layer only — request/response schemas, auth deps, delegate to services | `app/routers/*.py` |
| Services | Business logic: import orchestration, eval/flaw classification, stats, LLM insights | `app/services/*.py` |
| Repositories | All DB queries (SQLAlchemy `select()`), no business logic | `app/repositories/*.py` |
| Models | SQLAlchemy 2.x async ORM table definitions | `app/models/*.py` |
| Schemas | Pydantic v2 request/response contracts | `app/schemas/*.py` |
| Core | Cross-cutting config, DB session factory, rate limiters, dev clock | `app/core/*.py` |
| Alembic migrations | Schema evolution | `alembic/versions/*.py` |
| Stockfish engine wrapper | UCI subprocess pool, depth-15 / node-budget evaluation | `app/services/engine.py` |
| Maia-3 ONNX wrapper | Human-move-probability policy inference (server-side) | `app/services/maia_engine.py` |
| Import clients | chess.com / lichess API clients, normalize to unified schema | `app/services/chesscom_client.py`, `app/services/lichess_client.py`, `app/services/normalization.py` |
| Import orchestrator | In-memory job registry, background async import task, incremental sync | `app/services/import_service.py` |
| Eval/flaw pipeline | Cold-lane background drain, flaw classification, remote worker lease/submit apply | `app/services/eval_drain.py`, `app/services/eval_entry.py`, `app/services/eval_apply.py`, `app/services/flaws_service.py` |
| Zobrist hashing | Position-exact hashing used for opening/game-position matching | `app/services/zobrist.py` |
| LLM insights | pydantic-ai narrated insights (Anthropic + Google providers) | `app/services/insights_llm.py`, `app/services/insights_service.py` |
| Frontend pages | Route-level screens | `frontend/src/pages/*.tsx` |
| Frontend hooks | TanStack Query data-fetching + local state hooks | `frontend/src/hooks/*.ts` |
| Frontend API client | Typed HTTP client to backend | `frontend/src/api/client.ts` |
| Frontend chess engine | Client-side Stockfish WASM + Maia ONNX worker orchestration for bot play | `frontend/src/lib/engine/*.ts` |
| `analysis/` | Standalone research scripts/notebooks (own uv venv), reads prod/benchmark DB read-only | `analysis/*` |
| `stories/` | Static public data-story pages (stories.flawchess.com), independent build | `stories/*` |

## Pattern Overview

**Overall:** Layered backend (router → service → repository → model) behind a decoupled SPA frontend, plus an out-of-process distributed worker fleet for CPU-heavy Stockfish evaluation.

**Key Characteristics:**
- Strict one-directional dependency: routers depend on services, services depend on repositories, repositories depend on models. No SQL outside `app/repositories/`.
- Background async work runs as long-lived asyncio tasks inside the FastAPI process lifespan (import jobs, eval drain, guest cleanup, train reminders), not a separate task queue/broker.
- CPU-bound Stockfish evaluation is horizontally scaled via an external "remote worker" fleet that polls HTTP lease/submit endpoints — the server remains the sole writer and owner of all storage conventions (workers are "dumb FEN→eval functions", see `app/routers/eval_remote.py`).
- Position matching uses exact Zobrist hashes (`app/services/zobrist.py`) rather than named-opening heuristics, which is the product's core differentiator.
- Frontend chess engines (Stockfish WASM, Maia ONNX) run entirely client-side inside Web Workers for the bot-play/training feature — this is architecturally separate from the server-side Stockfish/Maia used for game analysis.

## Layers

**Routers (`app/routers/`):**
- Purpose: parse/validate HTTP requests, enforce auth, call exactly one service function, shape the response schema.
- Location: `app/routers/*.py` (e.g. `openings.py`, `imports.py`, `eval_remote.py`, `endgames.py`, `train.py`, `stats.py`, `library.py`, `insights.py`, `bots.py`, `push.py`, `admin.py`, `admin_activity.py`, `users.py`, `auth.py`, `feedback.py`, `position_bookmarks.py`).
- Contains: FastAPI `APIRouter` instances with `prefix=`/`tags=` set once (never in individual paths).
- Depends on: `app/services/*`, `app/schemas/*`, FastAPI-Users auth dependencies.
- Used by: the ASGI app (`app/main.py`).

**Services (`app/services/`):**
- Purpose: business logic — import orchestration, eval/flaw pipeline, stats/percentile computation, LLM narration, training scheduling.
- Location: `app/services/*.py`.
- Contains: async functions/classes, no raw SQL (delegates to repositories), no FastAPI/HTTP concerns.
- Depends on: `app/repositories/*`, `app/core/*`, external HTTP clients (httpx), engine wrappers.
- Used by: routers, background lifespan tasks, other services (documented cross-module use, e.g. `import_service.py` calling into `eval_entry.py` internals).

**Repositories (`app/repositories/`):**
- Purpose: sole location for DB queries.
- Location: `app/repositories/*.py`.
- Contains: SQLAlchemy 2.x `select()`/`update()`/`insert()` statements, mapped to/from ORM models.
- Depends on: `app/models/*`, `app/core/database.py`.
- Used by: services only (never routers directly).
- Shared filter logic: `app/repositories/query_utils.py` (`apply_game_filters()`) is the single implementation for time control/platform/rated/opponent-type/recency/color filters — all repositories import from here rather than duplicating.

**Models (`app/models/`):**
- Purpose: SQLAlchemy 2.x async ORM table definitions with explicit `ForeignKey(..., ondelete=...)` and `UniqueConstraint`s for natural keys.
- Location: `app/models/*.py`.
- Depends on: `app/models/base.py` (declarative base).
- Used by: repositories, Alembic migrations.

**Frontend layers (`frontend/src/`):**
- `pages/` — route-level screens, composed from components + hooks.
- `components/` — presentational + feature components, organized by domain (`analysis/`, `board/`, `bots/`, `charts/`, `filters/`, `insights/`, `library/`, `stats/`, `train/`, `ui/` primitives, etc.).
- `hooks/` — TanStack Query hooks (`useXyz.ts`) wrapping `api/client.ts` calls, plus local state hooks (Zustand-style filter stores).
- `lib/engine/` — client-side chess engine orchestration (Stockfish WASM worker pool, Maia ONNX worker, MCTS/expectimax search, opening book, bot personas).
- `api/client.ts` — single typed HTTP client to the FastAPI backend.
- `generated/` — files regenerated by `scripts/gen_*.py`; CI fails on drift.

## Data Flow

### Primary Request Path (authenticated stats/openings query)

1. React page (`frontend/src/pages/Openings.tsx`) mounts, invokes a TanStack Query hook (`frontend/src/hooks/useEndgames.ts` or similar).
2. Hook calls `frontend/src/api/client.ts`, issuing an authenticated fetch to `/api/openings/...` or `/api/endgames/...`.
3. Router (`app/routers/openings.py` / `app/routers/endgames.py`) validates request via `app/schemas/*`, resolves the current user via FastAPI-Users dependency, calls a service function.
4. Service (`app/services/openings_service.py`, `app/services/endgame_service.py`, `app/services/stats_service.py`) applies business rules, calls one or more repository functions, may call `app/services/user_benchmark_percentiles_service.py` for percentile context.
5. Repository (`app/repositories/openings_repository.py`, `app/repositories/stats_repository.py`) issues `select()` queries via `AsyncSession` against PostgreSQL.
6. Service shapes the result into a Pydantic response schema; router returns it; frontend hook caches it via TanStack Query.

### Import Pipeline (chess.com / lichess)

1. `POST /api/imports/...` (`app/routers/imports.py`) creates a job via `app/services/import_service.py` and returns a job id immediately.
2. `import_service.py` spawns an `asyncio.create_task` background coroutine (in-process, not a separate queue) that fetches games via `app/services/chesscom_client.py` (sequential monthly archives, 100-300ms delay, `User-Agent` required) or `app/services/lichess_client.py` (NDJSON stream, millisecond `since`/`until`).
3. Raw platform payloads normalize to a unified schema in `app/services/normalization.py` (`NormalizedGame`), filtering to `Standard` variant only.
4. `app/services/zobrist.py` (`process_game_pgn`) computes per-ply Zobrist hashes and position data during PGN parsing (per-game try/except, `UnicodeDecodeError` handled, looped `read_game()`).
5. Games/positions are bulk-persisted via `app/repositories/game_repository.py` inside short-lived `AsyncSession` transactions.
6. Newly imported games are queued for the eval/flaw pipeline (entry-ply targets picked up by `eval_entry.py` / `eval_drain.py`).
7. Frontend polls import job status (`frontend/src/hooks/useImport.ts`) to show progress.

### Eval/Flaw Pipeline (server-side Stockfish + distributed worker fleet)

1. **Entry-lane (import-time, cheap):** `app/services/eval_entry.py` computes depth-15 evals for entry plies immediately after import, using the module-level Stockfish pool (`app/services/engine.py`).
2. **Cold-lane drain (background):** `app/services/eval_drain.py` runs a periodic in-process coroutine (`run_eval_drain`, `run_full_eval_drain`, `run_periodic_holed_game_resweep`) that picks games with `evals_completed_at IS NULL` via short read transactions, evaluates via `asyncio.gather` over `engine.evaluate()` OUTSIDE any open `AsyncSession` (hard rule — see `app/services/engine.py` docstring), then opens a late write session to persist + commit.
3. **Remote worker fleet (external processes):** workers poll `POST /api/eval/remote/atomic-lease` (`app/routers/eval_remote.py`) with `X-Operator-Token` auth, run Stockfish locally (full-ply eval + MultiPV-2 continuation blobs), and submit results via `POST /api/eval/remote/atomic-submit`. The server applies results through `app/services/eval_apply.py` in one write session: evals → server-authoritative flaw classification → blob write → best-move stamping → commit. A separate `bestmove-lease`/`bestmove-submit` pair (Phase 177) handles isolated best-move backfill without touching the flaw path.
4. Flaw classification (`app/services/flaws_service.py`, `app/services/tactic_detector.py`) derives `game_flaw` rows from eval deltas and tactic-motif detection.
5. `app/models/worker_heartbeat.py` records fleet liveness/version on every live submit (advisory telemetry, never used for authz).

**State Management:**
- Import jobs: in-memory registry inside `import_service.py` (not persisted beyond `import_job` DB rows for status/history).
- Frontend: TanStack Query cache (server state) + local Zustand-style stores for filters (`frontend/src/hooks/useFilterStore.ts`, `useFlawFilterStore.ts`).
- Dev-only virtual clock: `app/core/dev_clock.py` (`dev_now_utc` dependency) — time-dependent endpoints must use it instead of `datetime.now()`.

## Key Abstractions

**Zobrist position hash:**
- Purpose: exact board-position identity independent of move order, used to match user positions against opening/benchmark data without named-opening heuristics.
- Examples: `app/services/zobrist.py`.
- Pattern: `board.board_fen()` (piece placement only) is used for comparison, never `board.fen()` (which includes castling/en passant state).

**Normalized game schema:**
- Purpose: single internal representation for games regardless of source platform (chess.com vs lichess).
- Examples: `app/schemas/normalization.py` (`NormalizedGame`, `TimeControlBucket`), `app/services/normalization.py`.
- Pattern: Pydantic models at the platform-API boundary; TypedDicts for internal structured accumulators (see `app/services/stats_service.py`).

**Engine pool:**
- Purpose: reusable async wrapper around one-or-many Stockfish UCI subprocesses, sized via `STOCKFISH_POOL_SIZE`.
- Examples: `app/services/engine.py` (`EnginePool`, module-level `start_engine`/`stop_engine`/`evaluate*` API).
- Pattern: singleton pool for live FastAPI traffic; a separately-constructed `EnginePool(size=N)` for batch/backfill scripts.

**Remote worker lease/submit protocol:**
- Purpose: horizontally scale Stockfish evaluation across external machines while keeping the server as sole storage authority.
- Examples: `app/routers/eval_remote.py`, `app/services/eval_apply.py`, `app/services/eval_queue_service.py`, `app/models/worker_heartbeat.py`.
- Pattern: versioned "atomic" lease/submit pair (claims via `claim_eval_job`, applies via one write session with server-side flaw reclassification); a Gen-1 non-atomic pair was fully deprecated and deleted (Phase 149).

**Client-side chess engine (bot play/training):**
- Purpose: run Stockfish WASM + Maia-3 ONNX policy inference entirely in-browser for bot opponents and training features, independent of the server-side analysis engine.
- Examples: `frontend/src/lib/engine/stockfishWorkerSource.ts`, `maiaWorkerHost.ts`, `mctsSearch.ts`, `selectBotMove.ts`, `workerPool.ts`.
- Pattern: Web Worker pool, asset caching (`engineAssetCache.ts`), style/persona-driven move selection blending Maia policy with expectimax search (`fallbackExpectimax.ts`, `botStyleBundles.ts`).

## Entry Points

**Backend ASGI app:**
- Location: `app/main.py`.
- Triggers: `uv run uvicorn app.main:app --reload` (dev), Docker/Uvicorn in prod.
- Responsibilities: mounts all routers, configures CORS/Sentry, and via `lifespan()` starts/stops the Stockfish pool, Maia session, and background periodic tasks (eval drain, guest cleanup, orphaned-import-job reaper, train reminders).

**Frontend SPA:**
- Location: `frontend/src/main.tsx` → `frontend/src/App.tsx` (React Router route table).
- Triggers: `npm run dev` (Vite dev server) / static build served in prod, PWA service worker.
- Responsibilities: route table (`/`, `/library/*`, `/openings/*`, `/endgames/*`, `/admin`, `/analysis`, `/train`, etc.), auth-gated route wrappers (`SuperuserRoute`, `ImportRequiredRoute`).

**Alembic migrations:**
- Location: `alembic/versions/*.py`, driven by `alembic.ini` + `alembic/env.py`.
- Triggers: `uv run alembic revision --autogenerate` / `uv run alembic upgrade head`.

**Analysis research scripts:**
- Location: `analysis/engine_disagreement_study/*.py`, `analysis/game_review_study/*.py`.
- Triggers: run manually inside the isolated `analysis/` uv venv (`analysis/pyproject.toml`, own lockfile); reads prod/benchmark Postgres read-only via `analysis/db.py`.

**Public data stories:**
- Location: `stories/` (e.g. `stories/two-pawns-up/index.html`), built independently of the main SPA.
- Triggers: static site deploy to stories.flawchess.com; content sourced from markdown reports (`stories/two-pawns-up/two-pawns-up-report-latest.md`).

## Architectural Constraints

- **Threading/concurrency:** Backend is a single-process asyncio event loop (Uvicorn). CPU-heavy Stockfish work runs in subprocesses spawned under `SCHED_IDLE` on Linux (`app/services/engine.py`), not Python threads.
- **Global state:** Module-level singletons: Stockfish `EnginePool` (`app/services/engine.py`), Maia ONNX session (`app/services/maia_engine.py`), in-memory import job registry (`app/services/import_service.py`). All started/stopped via the FastAPI lifespan in `app/main.py`.
- **AsyncSession concurrency:** hard rule — `AsyncSession` is never shared across concurrent coroutines (no `asyncio.gather` on the same session); Stockfish fan-out via `gather` must happen with no session open, confirmed by the eval-drain session discipline in `app/services/eval_drain.py`.
- **Worker trust boundary:** remote eval workers are treated as untrusted computation only — the server (`eval_apply.py`) is the sole writer of flaw/eval state; worker-submitted continuation blobs are gate input only, never trusted for flaw membership.
- **Time determinism:** time-dependent endpoints must source "now" from the `dev_now_utc` dependency (`app/core/dev_clock.py`), never call `datetime.now()` inline, to keep dev/test scenarios reproducible.

## Anti-Patterns

### Embedding SQL outside repositories

**What happens:** a service or router writes a raw `select()`/SQL string directly instead of calling a repository function.
**Why it's wrong:** breaks the layering contract this codebase enforces (`routers/` = HTTP only, `services/` = logic, `repositories/` = DB access) and duplicates filter logic that must live in `app/repositories/query_utils.py`.
**Do this instead:** add or reuse a function in the relevant `app/repositories/*.py` module; use `apply_game_filters()` for any time control/platform/rated/opponent/recency/color filtering.

### Concurrent use of a single AsyncSession

**What happens:** calling `asyncio.gather()` on coroutines that all read/write through the same `AsyncSession` instance (e.g. fanning out engine evaluation calls while a session is open).
**Why it's wrong:** SQLAlchemy's `AsyncSession` wraps one DB connection and is not safe for concurrent access; it also provides no real concurrency benefit since the connection serializes anyway. This was the structural cause of an OOM-kill failure mode (SEED-022/023).
**Do this instead:** close/short-scope the session for reads, run `asyncio.gather` over engine calls with no session open, then open a late write session to persist results — see the three-step session discipline documented in `app/services/eval_drain.py`.

### Blocking HTTP calls to external APIs

**What happens:** using the synchronous `requests` library (or `berserk`) for chess.com/lichess calls.
**Why it's wrong:** blocks the single asyncio event loop, stalling all concurrent request handling.
**Do this instead:** always use `httpx.AsyncClient`, as done in `app/services/chesscom_client.py` and `app/services/lichess_client.py`.

## Error Handling

**Strategy:** exceptions propagate to top-level handlers / Sentry; expected/benign conditions (parse `ValueError`s, `UserAlreadyExists`, known HTTP status codes on the remote-worker protocol) are explicitly excluded from Sentry capture.

**Patterns:**
- `sentry_sdk.capture_exception()` called in every non-trivial `except` block within `app/services/` and `app/routers/`.
- Retry loops (chess.com/lichess fetch, DB outage retry in `import_service.py`) capture only on the final failed attempt, not every transient one.
- Errors never interpolate variable data into the exception message (fragments Sentry grouping); variable context goes through `sentry_sdk.set_context()`/`set_tag()` instead — see `app/main.py`'s `_sentry_before_send` for the transient-DB-error grouping pattern.

## Cross-Cutting Concerns

**Logging:** Python stdlib `logging` per-module (`logger = logging.getLogger(__name__)`); WARNING+ reaches prod docker logs, INFO does not (use Sentry for INFO-level visibility in prod investigations).
**Validation:** Pydantic v2 schemas at all API boundaries (`app/schemas/*.py`); `Literal[...]` types used instead of bare `str` for fixed value sets.
**Authentication:** FastAPI-Users (cookie/OAuth), plus a separate constant-time `X-Operator-Token` scheme (`hmac.compare_digest`) for the machine-to-machine remote-worker protocol in `app/routers/eval_remote.py`.

---

*Architecture analysis: 2026-09-02*
